/**
 * The engine's admission rules: what it checks before it queues a run, a render or an export for the Studio and MCP
 * (caller.ts `admits`), named by the operation catalogue (`admission`, ADMISSION_RULES). Each check and the submit
 * that follows it run one at a time per key in this engine (two tabs, a double click, two calls of a client at once),
 * so the second finds the first one's job:
 *
 * - `one_run_per_scenario`: no run of the scenario is queued or running (two dry runs queued, or a capture's hooks
 *   run twice) — `conflict` naming the run and its job.
 * - `sessions_ack`: a capture whose scenario uses a persona whose saved session is not valid (expired, error, never)
 *   and that no run signs in by itself needs `sessions_ack` naming it — `conflict` with `details.sessions`. A
 *   confirmation against a wasted take, not a person's presence (a page script or an agent can send it); the run's own
 *   preflight stays the authority and stops before anything is filmed. Dry runs need none.
 * - `one_render_per_scenario`: no render of the scenario is queued or running — `conflict` naming it.
 * - `export_cap`: no export of the render is queued or running, and fewer than EXPORTS_OPEN_MAX exports of the
 *   workspace are (the worker runs one heavy job at a time anyway: the cap keeps a client from queueing an export,
 *   possibly a re-render, of every render) — `conflict`.
 *
 * The keys are this process's: two processes (an MCP server and the Studio) each check, then submit.
 */
import type { AdmissionRule } from './catalogue.js';
import { EngineError } from './errors.js';
import type { JobQueueView } from './jobs/job-queue.js';

/** The exports of the workspace queued or running at once that an admitted export still adds to (any client's count). */
export const EXPORTS_OPEN_MAX = 2;

/** The admission rules of each submit the engine admits (a dry run meets `one_run_per_scenario` only). */
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
export type KeyChain = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function keyChain(): KeyChain {
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

export interface AdmissionDeps {
  queue: Pick<JobQueueView, 'list'>;
  /** The personas a capture of the scenario signs in, and their state (engine auth.forScenario, mode capture). */
  sessions: (project: string, scenario: string, env: string | undefined) => Promise<SessionsView>;
}

/** The checks of the rules, each with the submit it admits (`admit*`: check, then submit, under the rule's key). */
export interface Admission {
  run<T>(req: { project: string; scenario: string; mode: 'dry' | 'capture'; env?: string; sessions_ack?: readonly string[] }, submit: () => Promise<T>): Promise<T>;
  render<T>(req: { project: string; scenario: string }, submit: () => Promise<T>): Promise<T>;
  /** `recheck` (from inside the submit, once a `latest` is resolved): the per-render rule again on the resolved id. */
  export<T>(req: { project: string; render_id: string }, submit: (recheck: (renderId: string) => Promise<void>) => Promise<T>): Promise<T>;
}

export function admission(d: AdmissionDeps): Admission {
  const chain = keyChain();
  const oneRun = async (project: string, scenario: string) => {
    const open = await d.queue.list({ project, kinds: ['run'], states: ['queued', 'running'] });
    const busy = open.find((j) => j.input.kind === 'run' && j.input.scenario === scenario);
    if (busy && busy.input.kind === 'run') {
      throw new EngineError('conflict', `a ${busy.input.mode === 'dry' ? 'rehearsal' : 'capture'} of ${scenario} is ${busy.state} (${busy.input.run_id}): wait for it to end, or stop it`, {
        details: { run_id: busy.input.run_id, job: busy.id },
      });
    }
  };
  const sessionsAck = async (project: string, scenario: string, env: string | undefined, ack: readonly string[]) => {
    const missing = sessionsToConfirm(await d.sessions(project, scenario, env)).filter((p) => !ack.includes(p.persona));
    if (missing.length) {
      throw new EngineError(
        'conflict',
        `${missing.map((p) => `${p.persona} (${p.status === 'never' ? 'never signed in' : p.status})`).join(', ')}: ${missing.length === 1 ? 'its session is' : 'their sessions are'} not valid and no run signs ${missing.length === 1 ? 'it' : 'them'} in by itself. ${confirmWhy(missing)}: sign in first, or confirm the capture`,
        { details: { sessions: missing } },
      );
    }
  };
  const oneRender = async (project: string, scenario: string) => {
    const open = await d.queue.list({ project, kinds: ['render'], states: ['queued', 'running'] });
    const busy = open.find((j) => j.input.kind === 'render' && j.input.scenario === scenario);
    if (busy && busy.input.kind === 'render') {
      throw new EngineError('conflict', `render ${busy.input.render_id} of ${scenario} is ${busy.state}: wait for it to end, or cancel it`, {
        details: { render_id: busy.input.render_id, job: busy.id },
      });
    }
  };
  const exportOfRender = async (project: string, renderId: string) => {
    const open = await d.queue.list({ kinds: ['export'], states: ['queued', 'running'] });
    const busy = open.find((j) => j.input.kind === 'export' && j.input.project === project && j.input.render_id === renderId);
    if (busy) throw new EngineError('conflict', `an export of ${renderId} is ${busy.state} (job ${busy.id}): wait for it to end`, { details: { job: busy.id } });
    return open.length;
  };
  return {
    run: (req, submit) =>
      chain(`run\0${req.project}\0${req.scenario}`, async () => {
        await oneRun(req.project, req.scenario);
        if (req.mode === 'capture') await sessionsAck(req.project, req.scenario, req.env, req.sessions_ack ?? []);
        return submit();
      }),
    render: (req, submit) =>
      chain(`render\0${req.project}\0${req.scenario}`, async () => {
        await oneRender(req.project, req.scenario);
        return submit();
      }),
    export: (req, submit) =>
      chain('export', async () => {
        const open = await exportOfRender(req.project, req.render_id);
        if (open >= EXPORTS_OPEN_MAX) throw new EngineError('conflict', `${open} exports are already queued or running: wait for one to end`, { details: { open } });
        return submit(async (renderId) => {
          if (renderId !== req.render_id) await exportOfRender(req.project, renderId);
        });
      }),
  };
}
