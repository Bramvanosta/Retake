/**
 * The engine's admission rules: what it checks before it queues a run, a render or an export for the Studio and MCP
 * (caller.ts `admits`), named by the operation catalogue (`admission`, ADMISSION_RULES; SUBMIT_RULES is the table
 * both are held to). Each check and the submit that follows it run one at a time per key in this engine (two tabs, a
 * double click, two calls of a client at once), and — L7.26 — under the job queue's lock of that key (JobQueue
 * `exclusive`: a lock file of the workspace for the file queue), so the second finds the first one's job also when it
 * comes from another process (the Studio, an MCP server, another engine of the workspace):
 *
 * - `one_run_per_scenario`: no run of the scenario is queued or running (two dry runs queued, or a capture's hooks
 *   run twice) — `conflict` naming the run and its job. Checked before the submit and again inside it, under the
 *   queue's lock with the run id's reserve and the enqueue (RunAdmit `reserve`): a human's approval of hooks may take
 *   minutes — never under the lock —, during which another process may queue one.
 * - `sessions_ack`: a capture whose scenario uses a persona whose saved session is not valid (expired, error, never)
 *   and that no run signs in by itself needs `sessions_ack` naming it — `conflict` with `details.sessions`. Checked
 *   inside the submit on the scenario it parsed and the environment the take uses (a sandbox's accounts sign in by
 *   themselves), after the submit's own refusals of the request (RunAdmit `prepared`). A confirmation against a wasted
 *   take, not a person's presence (a page script or an agent can send it); the run's own preflight stays the authority
 *   and stops before anything is filmed. Dry runs need none.
 * - `one_render_per_scenario`: no render of the scenario is queued or running — `conflict` naming it. The check and the
 *   whole submit (its plan, its version, the enqueue) under the queue's lock of the scenario's key.
 * - `export_cap`: no export of the render is queued or running, and fewer than EXPORTS_OPEN_MAX exports of the
 *   workspace are (the worker runs one heavy job at a time anyway: the cap keeps a client from queueing an export,
 *   possibly a re-render, of every render) — `conflict`. The checks and the whole submit under the queue's lock of
 *   the workspace's exports.
 *
 * The refusals are worded per channel (`AdmissionDeps.channel`): the Studio's as its screens say them, MCP's in the
 * glossary's words with the tools that follow up. A queue lock another process holds past its wait: `busy`.
 */
import type { AgentChannel, LoadedProject, LoadedScenario } from '@retake/core';
import type { AdmissionRule } from './catalogue.js';
import { EngineError } from './errors.js';
import type { JobQueue } from './jobs/job-queue.js';

/** The exports of the workspace queued or running at once that an admitted export still adds to (any client's count). */
export const EXPORTS_OPEN_MAX = 2;

/**
 * The admission rules of each submit the engine admits (a dry run meets `one_run_per_scenario` only): the checks below
 * apply a rule only when its submit lists it here, and the catalogue's `admission` facets name these rules
 * (packages/engine/test/operation-catalogue.test.ts holds each operation to its submit's).
 */
export const SUBMIT_RULES = {
  run: ['one_run_per_scenario', 'sessions_ack'],
  render: ['one_render_per_scenario'],
  export: ['export_cap'],
} as const satisfies Record<string, readonly AdmissionRule[]>;

/** A persona a capture's `sessions_ack` must name: its stored session is invalid and no run signs it in by itself. */
export interface SessionToConfirm {
  persona: string;
  status: 'expired' | 'error' | 'never';
  /**
   * The run's preflight checks it before anything is filmed (it has a `check`, or it never signed in: no session to
   * start from) and stops there if it is not valid. False: a saved session without a `check` is used as it is — the run
   * fails only when a page lands on the sign-in page, after its setup hooks ran.
   */
  checked_first: boolean;
}

/** The personas of a scenario's sessions, as engine auth.forScenario reads them (what the rule needs). */
export interface SessionsView {
  personas: ReadonlyArray<{ persona: string; status: string; auto: boolean; has_check: boolean; sandbox?: boolean; legacy?: boolean }>;
}

/**
 * The personas of a scenario's sessions whose stored state is expired, error or never, that no run signs in by itself:
 * no usable `login:` steps (`auto`), not a sandbox account (every take signs it in), not the legacy single-account file
 * (a run starts signed out there).
 */
export function sessionsToConfirm(s: SessionsView): SessionToConfirm[] {
  const out: SessionToConfirm[] = [];
  for (const p of s.personas) {
    if ((p.status === 'expired' || p.status === 'error' || p.status === 'never') && !p.auto && !p.sandbox && !p.legacy) {
      out.push({ persona: p.persona, status: p.status, checked_first: p.has_check || p.status === 'never' });
    }
  }
  return out;
}

/** What a capture does with these sessions, truthfully (the refusal's text; the Studio's dialog says the same). */
export function confirmWhy(list: SessionToConfirm[]): string {
  const checked = list.filter((p) => p.checked_first).map((p) => p.persona);
  const not = list.filter((p) => !p.checked_first).map((p) => p.persona);
  const parts: string[] = [];
  if (checked.length) parts.push(`The run checks ${not.length ? checked.join(', ') : checked.length === 1 ? 'it' : 'each'} first and stops before filming if still not valid`);
  if (not.length) {
    parts.push(
      `${not.length === 1 ? 'Persona' : 'Personas'} ${not.join(', ')} cannot be checked first (no \`check\`): the run uses ${not.length === 1 ? 'its saved session' : 'their saved sessions'} as ${not.length === 1 ? 'it is' : 'they are'} and fails only when a page lands on the sign-in page — after its setup hooks ran`,
    );
  }
  return parts.join('. ');
}

/** Runs `fn` after every earlier call of the same key has settled (its outcome ignored): one at a time per key. */
export type OpChain = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** A chain of calls per key (two tabs, a double click, two calls of a client at once): the second finds the first's result. */
export function opChain(): OpChain {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  };
}

/** The scenario a run submit parsed, on the environment its take uses (what `sessions_ack` is checked on). */
export interface PreparedTake {
  project: LoadedProject;
  scenario: LoadedScenario;
  /** The environment the take is filmed on: the sandbox one picked for `sandbox: true`, else the one asked (else the scenario's). */
  env: string | undefined;
}

/**
 * The checks a run submit makes from inside (engine jobs/run-job.ts submitRunJob), once it knows what a check needs:
 * `prepared` after the scenario is parsed and its environment picked (`sessions_ack` of a capture, on them), `reserve`
 * after any approval wait: `one_run_per_scenario` again — another process's run of the scenario may have been queued
 * meanwhile — then `queue` (the run id's reserve and the enqueue), both under the job queue's lock of the scenario.
 */
export interface RunAdmit {
  prepared(take: PreparedTake): Promise<void>;
  reserve<T>(queue: () => Promise<T>): Promise<T>;
}

export interface AdmissionDeps {
  /** The job queue: the open jobs a rule reads, and its lock (`exclusive`) each check and its submit hold. */
  queue: Pick<JobQueue, 'list' | 'exclusive'>;
  /** The personas a capture of the parsed scenario signs in on that environment, and their state (as engine auth.forScenario reads them). */
  sessions: (take: PreparedTake) => Promise<SessionsView>;
  /** The channel the refusals are worded for (caller.ts refusalChannel): the Studio's words, else MCP's. */
  channel: AgentChannel;
}

/** The checks of the rules, each with the submit it admits (`admit*`: check, then submit, under the rule's key). */
export interface Admission {
  /** `submit` gets the checks it makes from inside (RunAdmit): the sessions of the parsed scenario, the run rule again. */
  run<T>(req: { project: string; scenario: string; mode: 'dry' | 'capture'; sessions_ack?: readonly string[] }, submit: (admit: RunAdmit) => Promise<T>): Promise<T>;
  render<T>(req: { project: string; scenario: string }, submit: () => Promise<T>): Promise<T>;
  /** `recheck` (from inside the submit, once a `latest` is resolved): the per-render rule again on the resolved id. */
  export<T>(req: { project: string; render_id: string }, submit: (recheck: (renderId: string) => Promise<void>) => Promise<T>): Promise<T>;
}

/** Whether a submit is held to a rule (SUBMIT_RULES: the catalogue's `admission` facets are held to the same table). */
const holds = (submit: keyof typeof SUBMIT_RULES, rule: AdmissionRule): boolean => (SUBMIT_RULES[submit] as readonly AdmissionRule[]).includes(rule);

export function admission(d: AdmissionDeps): Admission {
  const inProcess = opChain();
  /** One at a time per key: in this engine (its chain), then across processes (the queue's lock of the key). */
  const chain = <T>(key: string, fn: () => Promise<T>): Promise<T> => inProcess(key, () => d.queue.exclusive(key, fn));
  const mcp = d.channel === 'mcp';
  const oneRun = async (project: string, scenario: string) => {
    if (!holds('run', 'one_run_per_scenario')) return;
    const open = await d.queue.list({ project, kinds: ['run'], states: ['queued', 'running'] });
    const busy = open.find((j) => j.input.kind === 'run' && j.input.scenario === scenario);
    if (busy && busy.input.kind === 'run') {
      // The Studio's words are its own (its Rehearse button); MCP's are the glossary's, with the tools that follow or stop it.
      const what = busy.input.mode === 'dry' ? (mcp ? 'dry run' : 'rehearsal') : 'capture';
      throw new EngineError('conflict', `a ${what} of ${scenario} is ${busy.state} (${busy.input.run_id}): ${mcp ? 'wait for it to end (run_status), or stop it (run_cancel)' : 'wait for it to end, or stop it'}`, {
        details: { run_id: busy.input.run_id, job: busy.id },
      });
    }
  };
  const sessionsAck = async (take: PreparedTake, ack: readonly string[]) => {
    if (!holds('run', 'sessions_ack')) return;
    const missing = sessionsToConfirm(await d.sessions(take)).filter((p) => !ack.includes(p.persona));
    if (missing.length) {
      const one = missing.length === 1;
      const what = mcp ? `sign in first (auth_login), or confirm the capture (sessions_ack naming ${one ? 'it' : 'them'})` : 'sign in first, or confirm the capture';
      throw new EngineError(
        'conflict',
        `${missing.map((p) => `${p.persona} (${p.status === 'never' ? 'never signed in' : p.status})`).join(', ')}: ${one ? 'its session is' : 'their sessions are'} not valid and no run signs ${one ? 'it' : 'them'} in by itself. ${confirmWhy(missing)}: ${what}`,
        { details: { sessions: missing } },
      );
    }
  };
  const oneRender = async (project: string, scenario: string) => {
    if (!holds('render', 'one_render_per_scenario')) return;
    const open = await d.queue.list({ project, kinds: ['render'], states: ['queued', 'running'] });
    const busy = open.find((j) => j.input.kind === 'render' && j.input.scenario === scenario);
    if (busy && busy.input.kind === 'render') {
      throw new EngineError('conflict', `render ${busy.input.render_id} of ${scenario} is ${busy.state}: ${mcp ? 'wait for it to end (render_status), or cancel it (job_cancel)' : 'wait for it to end, or cancel it'}`, {
        details: { render_id: busy.input.render_id, job: busy.id },
      });
    }
  };
  const exportOfRender = async (project: string, renderId: string) => {
    const open = await d.queue.list({ kinds: ['export'], states: ['queued', 'running'] });
    const busy = open.find((j) => j.input.kind === 'export' && j.input.project === project && j.input.render_id === renderId);
    if (busy) throw new EngineError('conflict', `an export of ${renderId} is ${busy.state} (job ${busy.id}): wait for it to end${mcp ? ' (job_status)' : ''}`, { details: { job: busy.id } });
    return open.length;
  };
  return {
    run: (req, submit) => {
      // The whole submit in this engine's chain; only its reserve under the queue's lock (an approval may take minutes).
      const key = `run\0${req.project}\0${req.scenario}`;
      return inProcess(key, async () => {
        await oneRun(req.project, req.scenario);
        return submit({
          prepared: async (take) => {
            if (req.mode === 'capture') await sessionsAck(take, req.sessions_ack ?? []);
          },
          reserve: (queue) =>
            d.queue.exclusive(key, async () => {
              await oneRun(req.project, req.scenario);
              return queue();
            }),
        });
      });
    },
    render: (req, submit) =>
      chain(`render\0${req.project}\0${req.scenario}`, async () => {
        await oneRender(req.project, req.scenario);
        return submit();
      }),
    export: (req, submit) => {
      if (!holds('export', 'export_cap')) return submit(async () => undefined);
      return chain('export', async () => {
        const open = await exportOfRender(req.project, req.render_id);
        if (open >= EXPORTS_OPEN_MAX) throw new EngineError('conflict', `${open} exports are already queued or running: wait for one to end`, { details: { open } });
        return submit(async (renderId) => {
          if (renderId !== req.render_id) await exportOfRender(req.project, renderId);
        });
      });
    },
  };
}
