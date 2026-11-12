/**
 * The Studio's Record screen ops (L4.8, R-UI-20 / 21 / 22; critique D4). Not MCP tools: Claude has scenario_record and
 * job_status. The screen is the control panel of the headed window the worker opens on this machine — a PERSON clicks
 * in that window; nothing here reaches it (no input is forwarded from a page: BL-25). Every op reads or writes the
 * recording's folder or its job through the engine (record-studio.ts), which gates them to the `ui` client.
 *
 * - `record_options {project}`: what the start form shows — the environments (access, production, sandbox flags, page
 *   keys), each one's personas with their stored session state (engine auth.status: no browser) and whether their
 *   `login:` steps sign them in by themselves, the defaults (page, path, persona; the default name as of now), the
 *   warnings and notes in words, the recording already open in the workspace (one window at a time), and the project's
 *   recent recordings (engine record.list: counts, enums and names).
 * - `record_start {project, env?, page?, path?, persona?, name?}`: engine record.submit with PINNED arguments — a page
 *   and a path only (never a URL), never `--allow-writes`, the check replay always on (`check: true`); who started it is
 *   the engine's client (`ui`), never a field of the page. The engine refuses a second recording queued or running in
 *   the workspace (409), protected hosts and templates as for MCP.
 * - `record_view {project, rec_id, job?, since?}`: the recording's state and live draft (engine record.view). `job` is
 *   record_start's job id (before the folder exists); `since` the previous answer's `version`. The draft's YAML comes as
 *   `untrusted.yaml_lines` (one string per line: the untrusted cap is per string).
 * - `record_annotate {project, rec_id, rev, change}`: one change (choose / insert / remove: core
 *   RecordAnnotationChangeSchema) at the revision the view returned; an insert `at: 'end'` is placed by the engine
 *   under the recording's lock (critique B3).
 * - `record_stop`, `record_discard {project, rec_id, job?}`: Stop and keep (any recording whose job runs); Discard (a
 *   Studio recording only; during the draft or the check the folder goes once the job is over).
 * - `record_save {project, rec_id, name, rev, draft}`: a NEW scenarios/<name>.yaml only (a taken name is a 409), under
 *   agent trust, and only the draft the person saw (`draft`: the view's `draft_sha256` — any other is a 409); in the
 *   scenario chain shared with scenario_edit / scenario_render / thread_apply.
 *
 * Answers are path-free (recordPathFree: withoutPathsDeep's rule — pathFree on every string — over every trusted field,
 * `view.job.error.fix` included; the URL paths of the view, the start answer and the recent list and the recorded draft
 * keep their text, only the workspace's own path cut);
 * page and typed text (target names, typed text, scene ids made from page paths, write labels, the check's failure)
 * stays under `untrusted`, which the HTTP layer caps and the app renders as text only.
 */
import { z } from 'zod';
import { JOB_ID_RE, PROJECT_SLUG_RE, RECORD_ID_RE, RecordAnnotationChangeSchema, SLUG_RE, resolveRunAccess } from '@retake/core';
import { RECORD_LIST_MAX, defaultRecordName, openProjectBySlug, recordMaxMs, recordStart } from '@retake/engine';
import type { AuthStatusItem, Engine, RecordListItem, RecordState, RecordView } from '@retake/engine';
import { defineTool } from '@retake/engine/contract';
import { pathFree } from './comment-ops.js';
import { scenarioKey } from './op-chain.js';
import type { OpChain } from './op-chain.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');
const recId = z.string().regex(RECORD_ID_RE, 'a recording id (rec_ and 26 characters: record_start or record_options gives it), never a path');
const job = z.string().regex(JOB_ID_RE, 'the job record_start answered (j_…)');
const env = z.string().max(100).regex(SLUG_RE, 'an environment name of the project');
const page = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\s/\\{}]+$/, 'a page key of the environment (record_options lists them): no space, slash or {{…}}');
const path = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\/[^\s]*$/, 'a path under the page, starting with "/" (no host, no space)')
  .refine((p) => !p.includes('{{'), 'no {{…}} template in a recording path');
const persona = z.string().min(1).max(100).regex(SLUG_RE, 'a persona name of project.yaml, or "none" (signed out)');
const scenarioName = z.string().min(1).max(100).regex(SLUG_RE, 'a scenario name (scenarios/<name>.yaml), never a path');
const rev = z.number().int().min(0).max(1_000_000).describe('The revision record_view returned (`rev`): a stale one is a 409.');

const OptionsInput = z.strictObject({ project });
/** Strict: no url, no allow_writes, no check, no submitted_by — what a page may ask is pinned here (critique D4). */
const StartInput = z.strictObject({
  project,
  env: env.optional().describe("The environment (default: the project's default_env)."),
  page: page.optional().describe("The page the window opens (default: the persona's first page, else the environment's first)."),
  path: path.optional().describe('A path under the page (default "/").'),
  persona: persona.optional().describe('Sign the window in as this persona ("none": signed out; default: the persona whose pages list the page).'),
  name: scenarioName.optional().describe('The name the draft is made for (default recorded-YYYYMMDD-HHMM); Save may choose another.'),
});
const ViewInput = z.strictObject({
  project,
  rec_id: recId,
  job: job.optional().describe("record_start's job: the recording before its folder exists."),
  since: z
    .string()
    .regex(/^[0-9a-f]{16}$/, "the previous answer's version")
    .optional()
    .describe("The previous answer's `version`: when nothing changed, a short answer with `unchanged: true`."),
});
const AnnotateInput = z.strictObject({ project, rec_id: recId, rev, change: RecordAnnotationChangeSchema });
const StopInput = z.strictObject({ project, rec_id: recId, job: job.optional().describe("record_start's job (before the folder exists).") });
const SaveInput = z.strictObject({
  project,
  rec_id: recId,
  name: scenarioName.describe('The new scenario: scenarios/<name>.yaml must not exist.'),
  rev,
  draft: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "the view's draft_sha256")
    .describe("The view's `draft_sha256`: only the draft the person saw is saved (another one is a 409)."),
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Where a string is a URL path (the page path the window opened) — kept as written, only the workspace's path cut: the
 * `path` of an answer's top level (a view, the start answer), of an annotate or stop answer's `view`, of a recent list
 * item and of an environment's default start. Any other `path` key gets pathFree like every trusted string (N1: an
 * absolute file path never passes).
 */
const URL_PATH_AT: ReadonlySet<string> = new Set(['path', 'view.path', 'recent.path', 'environments.default.path']);
/** Under `untrusted`, the subtree that is an error's text (the check replay's failure): pathFree as a trusted string. */
const ERROR_KEYS: ReadonlySet<string> = new Set(['check']);

/** The workspace's own path cut from a text (`<root>/x` → `x`, `<root>` → `.`), nothing else changed. */
function cutRoot(text: string, root: string): string {
  return text.split(`${root}/`).join('').split(root).join('.');
}

/**
 * An answer made path-free: withoutPathsDeep's rule (pathFree: the workspace's part cut, any other absolute path
 * shortened) on every string of the trusted fields — `job.error.fix` and `job.error.message` included (a refused
 * preflight's `retake -C <workspace> …`) — and on the check replay's failure text under `untrusted.check`. Elsewhere
 * under `untrusted` (the draft: typed text, page paths) and in a URL `path`, only the workspace's own path is cut: a
 * page path such as /orders/new is the recording's content, never shortened. No depth cap below 64 levels (a draft's
 * blocks are deeper than withoutPathsDeep's 8, which would drop them).
 */
export function recordPathFree(v: unknown, root: string, mode: 'trusted' | 'page' | 'error' = 'trusted', at = '', depth = 0): unknown {
  if (typeof v === 'string') return mode === 'page' || (mode === 'trusted' && URL_PATH_AT.has(at)) ? cutRoot(v, root) : pathFree(v, root);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 64) return undefined;
  // `at`: the keys from the answer's top level to here, array indexes left out ("recent.path").
  if (Array.isArray(v)) return v.map((x) => recordPathFree(x, root, mode, at, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const next = mode === 'trusted' && k === 'untrusted' ? 'page' : mode === 'page' && ERROR_KEYS.has(k) ? 'error' : mode;
      return [k, recordPathFree(x, root, next, at ? `${at}.${k}` : k, depth + 1)];
    }),
  );
}

/** The view as the Record screen gets it: the draft's YAML as lines (each line one untrusted string). */
export type RecordViewAnswer = Omit<RecordView, 'untrusted'> & {
  untrusted: (Omit<NonNullable<RecordView['untrusted']>, 'yaml'> & { yaml_lines: string[] }) | null;
};

export function recordViewAnswer(v: RecordView): RecordViewAnswer {
  if (!v.untrusted) return v as RecordViewAnswer;
  const { yaml, ...rest } = v.untrusted;
  return { ...v, untrusted: { ...rest, yaml_lines: yaml.replace(/\n$/, '').split('\n') } };
}

const stateWords: Record<RecordState, string> = {
  queued: 'waiting for the worker',
  preflight: 'opening the window',
  recording: 'recording (the window is open)',
  draft: 'making the draft',
  check: 'checking the draft (headless replay)',
  done: 'recorded',
  interrupted: 'interrupted (the worker stopped; what was recorded is kept, unchecked)',
  tampered: 'cannot be verified (its files were changed after its job wrote them): read-only',
  nothing_recorded: 'ended with nothing recorded',
  failed: 'failed',
  cancelled: 'cancelled',
  discarded: 'discarded',
  missing: 'not found (discarded, pruned or never started)',
};

function viewSummary(v: RecordViewAnswer): string {
  if (v.unchanged) return `${v.rec_id}: unchanged (${stateWords[v.state]})`;
  const steps = v.stats ? `, ${plural(v.stats.steps, 'step')}` : '';
  return `${v.rec_id}: ${stateWords[v.state]}, ${plural(v.counts.actions, 'action')}${steps}${v.saved ? `, saved as ${v.saved.file}` : ''}`;
}

/** A persona the start form offers, with its stored session (no browser) — `untrusted`: the last check's words. */
export interface RecordPersonaOption {
  name: string;
  /** Page keys it is signed into by default. */
  pages: string[];
  /** It has `login:` steps: the recording's preflight signs it in with them (headless) when its session is not valid. */
  login_steps: boolean;
  sandbox: boolean;
  status: AuthStatusItem['status'] | null;
  checked_at?: string;
  in_use: boolean;
  /** The command that signs it in (path-free; the Sessions panel's Sign in opens the headed window instead). */
  command?: string;
  untrusted?: AuthStatusItem['untrusted'];
}

export interface RecordEnvironmentOption {
  name: string;
  production: boolean;
  /** The access a recording from the Studio gets (never --allow-writes). */
  access: 'read-only' | 'read-write';
  sandbox: boolean;
  /** Page keys (record_start's `page`). */
  pages: string[];
  personas: RecordPersonaOption[];
  /** Where a recording starts with no page, path or persona given; null with `problem`. */
  default: { page: string; path: string; persona: string | null } | null;
  problem?: string;
  /** Before Start, in words. */
  warnings: string[];
}

export interface RecordOptionsAnswer {
  project: string;
  default_env: string | null;
  environments: RecordEnvironmentOption[];
  /** The name a draft gets when none is given, as of now (the worker computes it when the window opens). */
  default_name: string;
  /** The longest recording (minutes): it stops by itself then. */
  max_minutes: number;
  /** False: a Linux machine without a display — no window can open (record on a machine with a screen). */
  display: boolean;
  /** Before Start, for every environment, in words. */
  notes: string[];
  /** The recording queued or running in the workspace (one window at a time), any project. */
  open: { job: string; project: string; rec_id: string; state: 'queued' | 'running' } | null;
  /** This project's recordings, newest first. */
  recent: RecordListItem[];
}

const RECORD_NOTES = [
  'Your clicks really happen in the product: what you create or change there stays (a reset hook makes every take start from the same data).',
  'The window opens full size, as the video is filmed: switch to the Studio with Cmd-Tab (Alt-Tab), or keep it on a second screen; come back to the window by its title bar — a click in the page is recorded.',
  'Coming to the Studio ends the typing in progress: it is recorded as it is, and what you type next is added to it.',
  'Closing the window is Stop: what was recorded is kept, then checked by a headless replay.',
];

function envWarnings(o: { production: boolean; access: 'read-only' | 'read-write'; sandbox: boolean; maxMinutes: number }): string[] {
  const w: string[] = [];
  if (o.production) w.push('A production environment: the Studio never allows writes there — what the window writes is stopped or answered by a mock.');
  else if (o.access === 'read-only') w.push('A read-only environment: what the window writes is stopped or answered by a mock, as in a rehearsal.');
  if (o.sandbox) w.push('A sandbox environment: it must be up (retake sandbox up) — the recording uses it as it is, without a reset.');
  w.push(`The window holds the worker: captures, renders and previews wait until you stop (at most ${o.maxMinutes} min).`);
  return w;
}

async function recordOptions(engine: Engine, slug: string): Promise<RecordOptionsAnswer> {
  const [view, loaded, auth, recent, open] = await Promise.all([
    engine.projects.get(slug),
    openProjectBySlug(engine.workspace, slug),
    engine.auth.status({ project: slug }),
    engine.record.list(slug, { limit: RECORD_LIST_MAX }),
    engine.jobs.list({ kinds: ['record'], states: ['queued', 'running'], limit: 1 }),
  ]);
  let maxMs: number;
  try {
    maxMs = recordMaxMs() ?? 30 * 60_000;
  } catch {
    maxMs = 30 * 60_000;
  }
  const maxMinutes = Math.round(maxMs / 60_000);
  const environments = view.environments.map((e): RecordEnvironmentOption => {
    let def: RecordEnvironmentOption['default'] = null;
    let problem: string | undefined;
    let access: 'read-only' | 'read-write' = e.access;
    try {
      const start = recordStart(loaded, { env: e.name });
      def = { page: start.page, path: start.path, persona: start.persona?.name ?? null };
      access = resolveRunAccess(start.env, { allowWrites: false, project: loaded }).mode;
    } catch (x) {
      problem = x instanceof Error ? x.message : String(x);
    }
    const states = new Map(auth.personas.filter((p) => p.env === e.name).map((p) => [p.persona, p]));
    return {
      name: e.name,
      production: e.production,
      access,
      sandbox: e.sandbox,
      pages: Object.keys(e.pages),
      personas: e.personas.map((p): RecordPersonaOption => {
        const st = states.get(p.name);
        return {
          name: p.name,
          pages: p.pages,
          login_steps: p.login_steps,
          sandbox: p.sandbox === true,
          status: st?.status ?? null,
          ...(st?.checked_at ? { checked_at: st.checked_at } : {}),
          in_use: !!st?.in_use,
          ...(st?.command ?? st?.fix ? { command: (st.command ?? st.fix) as string } : {}),
          ...(st?.untrusted ? { untrusted: st.untrusted } : {}),
        };
      }),
      default: def,
      ...(problem ? { problem } : {}),
      warnings: envWarnings({ production: e.production, access, sandbox: e.sandbox, maxMinutes }),
    };
  });
  const busy = open[0];
  return {
    project: slug,
    default_env: view.default_env ?? view.environments[0]?.name ?? null,
    environments,
    // The Studio server's own time: the name it offers is a suggestion the person can change (no engine stamp).
    default_name: defaultRecordName(loaded, new Date()),
    max_minutes: maxMinutes,
    display: !(process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY),
    notes: RECORD_NOTES,
    open: busy && busy.input.kind === 'record' ? { job: busy.id, project: busy.input.project, rec_id: busy.input.rec_id, state: busy.state === 'queued' ? 'queued' : 'running' } : null,
    recent,
  };
}

/** What record_start answers: the job and the reserved recording id (the screen follows them with record_view). */
export interface RecordStartAnswer {
  job: string;
  rec_id: string;
  state: string;
  env: string;
  page: string;
  path: string;
  persona: string | null;
  warnings: string[];
  worker?: { pid?: number; spawned: boolean };
}

/** The Record screen's ops (see the module comment). `chain`: the server's scenario chain (record_save writes a scenario). */
export function recordOps(o: { chain: OpChain }) {
  const { chain } = o;
  const root = (engine: Engine) => engine.workspace.root;
  // recordPathFree keeps an answer's shape (each string path-free, each other value as it was): the answer's own type.
  const out = <T>(engine: Engine, data: T) => recordPathFree(data, root(engine)) as T;

  const options = defineTool({
    name: 'record_options',
    title: 'Recording: start form',
    description: "What the Record screen's start form shows: environments, pages, personas with their stored sessions, defaults, warnings, the recording open in the workspace and the project's recent recordings.",
    input: OptionsInput,
    annotations: READ,
    async run(a, { engine }) {
      const r = await recordOptions(engine, a.project);
      return {
        summary: `${a.project}: ${plural(r.environments.length, 'environment')}, ${plural(r.recent.length, 'recent recording')}${r.open ? `, a recording is ${r.open.state === 'queued' ? 'waiting' : 'open'} (${r.open.rec_id})` : ''}`,
        data: out(engine, r),
      };
    },
  });

  const start = defineTool({
    name: 'record_start',
    title: 'Recording: open the window',
    description: 'Queue a recording: a headed window opens on this machine at a page of the environment, for the person to click in. Page and path only, the environment\'s own access, the check replay always on; refused while another recording is open in the workspace.',
    input: StartInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a, { engine }) {
      // Pinned (critique D4): never a URL, never --allow-writes, the check replay on; `submitted_by` is the engine's client.
      const sub = await engine.record.submit({
        project: a.project,
        ...(a.env !== undefined ? { env: a.env } : {}),
        ...(a.page !== undefined ? { page: a.page } : {}),
        ...(a.path !== undefined ? { path: a.path } : {}),
        ...(a.persona !== undefined ? { persona: a.persona } : {}),
        ...(a.name !== undefined ? { scenario: a.name } : {}),
        check: true,
      });
      const data: RecordStartAnswer = {
        job: sub.job.id,
        rec_id: sub.rec_id,
        state: sub.job.state,
        env: sub.env,
        page: sub.page,
        path: sub.path,
        persona: sub.persona,
        warnings: sub.warnings,
        ...(sub.worker ? { worker: sub.worker } : {}),
      };
      return { summary: `recording ${sub.rec_id} queued (job ${sub.job.id}): a window opens at ${sub.page} ${sub.path} (env ${sub.env}${sub.persona ? `, as ${sub.persona}` : ', signed out'})`, data: out(engine, data) };
    },
  });

  const view = defineTool({
    name: 'record_view',
    title: 'Recording: live view',
    description: "A recording's state and live draft (rows, target alternatives, inserts, issues, writes, the check), the actions the screen may offer, and `version` for a cheap re-read.",
    input: ViewInput,
    annotations: READ,
    async run(a, { engine }) {
      const v = recordViewAnswer(await engine.record.view(a.project, a.rec_id, { ...(a.job ? { job: a.job } : {}), ...(a.since ? { since: a.since } : {}) }));
      return { summary: viewSummary(v), data: out(engine, v) };
    },
  });

  const annotate = defineTool({
    name: 'record_annotate',
    title: 'Recording: arrange the draft',
    description: 'One change to a Studio recording\'s draft at the revision the view returned: choose a target alternative, insert (hold, wait, caption, mark, camera) after a step or at the end, or remove an insert.',
    input: AnnotateInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await engine.record.annotate(a.project, a.rec_id, { rev: a.rev, change: a.change });
      const v = recordViewAnswer(r.view);
      return {
        summary: `${a.rec_id}: ${a.change.op === 'insert' ? `${a.change.insert.kind} inserted${r.insert_id ? ` (${r.insert_id})` : ''}` : a.change.op === 'choose' ? 'target chosen' : 'insert removed'} — revision ${r.rev}`,
        data: out(engine, { rev: r.rev, ...(r.insert_id !== undefined ? { insert_id: r.insert_id } : {}), view: v }),
      };
    },
  });

  const stop = defineTool({
    name: 'record_stop',
    title: 'Recording: stop and keep',
    description: 'Stop a recording and keep it: before the window opened it is cancelled; while it is open the window closes as if the person closed it, then the draft is made and checked.',
    input: StopInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a, { engine }) {
      const r = await engine.record.stop(a.project, a.rec_id, a.job ? { job: a.job } : {});
      const v = recordViewAnswer(r.view);
      return { summary: `${a.rec_id}: ${r.action === 'stopping' ? 'stopping (the window closes, then the draft and the check)' : r.action === 'cancelled' ? 'cancelled before the window opened' : 'nothing to stop'}`, data: out(engine, { action: r.action, view: v }) };
    },
  });

  const discard = defineTool({
    name: 'record_discard',
    title: 'Recording: discard',
    description: 'Discard a recording started from the Studio: its folder is removed (an open window is cancelled first; during the draft or the check, once its job is over). A scenario saved from it is never touched.',
    input: StopInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(a, { engine }) {
      const r = await engine.record.discard(a.project, a.rec_id, a.job ? { job: a.job } : {});
      return { summary: `${a.rec_id}: ${r.state === 'discarded' ? 'discarded' : 'being discarded (its job is cancelled; the folder goes once it is over)'}`, data: out(engine, r) };
    },
  });

  const save = defineTool({
    name: 'record_save',
    title: 'Recording: save as a scenario',
    description: 'Save a finished Studio recording\'s draft as a NEW scenarios/<name>.yaml (a taken name is refused, never overwritten) — only the draft the person saw (`draft`) — under the rules a scenario saved from the Studio follows.',
    input: SaveInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await chain(scenarioKey(a.project, a.name), () => engine.record.save(a.project, a.rec_id, { name: a.name, rev: a.rev, draft: a.draft }));
      return { summary: `${a.rec_id}: saved as ${r.file} (hash ${r.hash})${r.warnings ? ` with ${plural(r.warnings, 'warning')}` : ''}`, data: out(engine, r) };
    },
  });

  return [options, start, view, annotate, stop, discard, save] as const;
}

export const RECORD_OPS = ['record_options', 'record_start', 'record_view', 'record_annotate', 'record_stop', 'record_discard', 'record_save'] as const;
