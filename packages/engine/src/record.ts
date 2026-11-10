/**
 * Recording a scenario (L3.4, `retake record`; the `record` job and scenario_record build on it): a HEADED window where
 * a person performs a flow once (runner-web recordSession), then a draft scenario from what they did (core
 * draftFromRecording), saved as scenarios/<name>.yaml when the name is free, then a headless check replay of the draft.
 * Claude may start a recording through MCP, never drive it.
 *
 * Files: <project>/.retake/records/<rec_id>/ (0700) — meta.json (L4.8: written once when the folder is made: the
 * draft's context, who started it, its job and process; record-files.ts), events.jsonl (streamed by the runner while
 * recording), draft.yaml and record.json (0600; record.json holds the events file's sha256, `events_sha256`, so a
 * later Save can tell an edited events file), check/ (the check replay's run folder, without its per-step
 * screenshots), studio.json (the Studio's annotations, engine record-studio.ts). The newest RECORD_KEEP are kept,
 * and an unsaved Studio recording for RECORD_UNSAVED_KEEP_MS; a folder whose lock is held is never pruned. Typed text lives only there and in the saved scenario: progress, logs and the outcome's
 * messages carry counts and enums, never page text or a typed value.
 *
 * Rules:
 * - preflight as a run: the persona's saved session is checked (checkSavedSession); when it is not valid and the
 *   persona has `login:` steps it signs in automatically (headless, off camera), else the recording is refused with the
 *   `retake login` command;
 * - access as `retake run`: the environment's own (a read-only environment's writes are stopped or answered by a mock
 *   while recording), `allowWrites` with the same rules as `--allow-writes`; hooks never run;
 * - `stop` = stop and keep (Ctrl-C, a worker signal — the job then skips the check replay: `skipCheck`); `signal` = cancel while recording (the folder removed; after the
 *   recording it only cancels the check replay); the maximum duration (RETAKE_RECORD_MAX_MIN, default 30 min)
 *   stops and keeps;
 * - check replay: a dry run at the capture viewport, up to the step before the first one a write that went through
 *   followed (any host; on a read-only environment the guard's stopped or mocked writes do not count, so it usually
 *   replays the whole draft): nothing is written twice. It starts from the state the recording left the product in.
 * - the draft is validated with the project (its vars, pages, personas) before it is saved or checked; an error is an
 *   `invalid` issue with its scene and step, never the validator's text;
 * - a recording the Studio started (`submittedBy: 'ui'`, L4.8) is never saved here (`not_saved: 'studio'`): the person
 *   arranges the draft and saves it from the Record screen (record-studio.ts).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PERSONA_NONE,
  RECORD_ID_RE,
  draftFromRecording,
  draftInvalidIssue,
  inspectPathProblem,
  isPageOrigin,
  newUlidId,
  parseScenario,
  parseYaml,
  resolveEnvironment,
  resolvePersonas,
  resolveRunAccess,
  projectPath,
  statePath,
} from '@retake/core';
import type { DraftIssue, JobClient, LoadedProject, LoadedScenario, RecordedEvent, ResolvedEnvironment, ResolvedPersona, RunProgress, RunRecord, WorkPolicy } from '@retake/core';
import type { RecordSessionOptions, RecordSessionResult } from '@retake/runner-web';
import { retakeHome, fileFacts } from '@retake/core/io';
import { callerOf, submittedInStudio } from './caller.js';
import { EngineError, toEngineError } from './errors.js';
import { appendHistory } from './history.js';
import { pageOfUrl } from './jobs/inspect-job.js';
import type { JobQueueView } from './jobs/job-queue.js';
import { selfIdentity } from './jobs/proc.js';
import { lockAlive, readLock } from '@retake/sandbox';
import { RECORD_UNSAVED_KEEP_MS, readRecordAnnotations, readRecordMeta, recordLockFile, writeRecordMeta } from './record-files.js';
import { refuseBesideOldHolder } from './legacy.js';
import { checkScenarioName } from './refs.js';
import { saveScenarioText } from './scenarios.js';
import type { OpenedWorkspace } from './workspace.js';

/** Recordings kept per project (the newest). */
export const RECORD_KEEP = 20;
/** The environment variable that changes the longest recording (minutes). */
export const RECORD_MAX_ENV = 'RETAKE_RECORD_MAX_MIN';

/** <project>/.retake/records */
export function recordsRoot(project: LoadedProject): string {
  return statePath(project.dir, 'records');
}

/** <project>/.retake/records/<id> (the id checked: never a path). */
export function recordDir(project: LoadedProject, id: string): string {
  if (!RECORD_ID_RE.test(id)) throw new EngineError('invalid', `invalid recording id "${id}": rec_ followed by 26 characters, never a path`);
  return join(recordsRoot(project), id);
}

export function newRecordId(): string {
  return newUlidId('record');
}

/** The recordings of a project whose `record` job is queued or running (their folders are in use or reserved). */
export async function activeRecords(queue: JobQueueView, slug: string): Promise<string[]> {
  const jobs = await queue.list({ project: slug, kinds: ['record'], states: ['queued', 'running'], limit: 10_000 });
  return jobs.flatMap((j) => (j.input.kind === 'record' ? [j.input.rec_id] : []));
}

/**
 * Keep the newest `keep` recording folders of a project; `except` is never removed, nor — given the workspace's job
 * queue — the folder of a recording whose job is still queued or running. L4.8 (critique B12): nor a folder whose lock is held
 * (an annotate, a Save or a Discard in progress), nor an unsaved, undiscarded Studio recording younger than
 * RECORD_UNSAVED_KEEP_MS.
 */
export async function pruneRecords(project: LoadedProject, keep = RECORD_KEEP, except: readonly string[] = [], queue?: JobQueueView): Promise<string[]> {
  const active = queue !== undefined ? await activeRecords(queue, project.slug).catch(() => null) : [];
  // The jobs could not be read: nothing is pruned (a folder in use is never removed on a guess).
  if (active === null) return [];
  except = [...except, ...active];
  let names: string[];
  try {
    names = (await readdir(recordsRoot(project), { withFileTypes: true })).filter((e) => e.isDirectory() && RECORD_ID_RE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const now = Date.now();
  const old = names
    .sort()
    .reverse()
    .slice(keep)
    .filter((n) => !except.includes(n) && !recordInUse(project, n, now));
  for (const n of old) await rm(join(recordsRoot(project), n), { recursive: true, force: true }).catch(() => undefined);
  return old;
}

/** A folder prune leaves: its lock held by a live process, or an unsaved Studio recording younger than 7 days. */
function recordInUse(project: LoadedProject, id: string, now: number): boolean {
  const held = readLock(recordLockFile(project.dir, id));
  if (held && lockAlive(held)) return true;
  const meta = readRecordMeta(join(recordsRoot(project), id), id);
  if (!meta || !submittedInStudio(meta)) return false;
  const ann = readRecordAnnotations(join(recordsRoot(project), id));
  if ('annotations' in ann && (ann.annotations?.saved || ann.annotations?.discard)) return false;
  const started = Date.parse(meta.started_at);
  return Number.isFinite(started) && now - started < RECORD_UNSAVED_KEEP_MS;
}

/** sha256 (hex) of a file's bytes, streamed. */
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** The longest recording (ms): RETAKE_RECORD_MAX_MIN when set (minutes), else undefined (the runner's 30 min). */
export function recordMaxMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[RECORD_MAX_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) throw new EngineError('invalid', `${RECORD_MAX_ENV} must be a number of minutes from more than 0 to 1440, got "${raw}"`);
  return Math.round(n * 60_000);
}

/** The default name of a recorded scenario: recorded-YYYYMMDD-HHMM (local time), "-2"… when taken. */
export function defaultRecordName(project: LoadedProject, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `recorded-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  let name = base;
  for (let k = 2; scenarioTaken(project, name); k++) name = `${base}-${k}`;
  return name;
}

function scenarioTaken(project: LoadedProject, name: string): boolean {
  return project.scenarios.includes(name) || existsSync(projectPath(project.dir, 'scenarios', `${name}.yaml`)) || existsSync(projectPath(project.dir, 'scenarios', `${name}.yml`));
}

export interface RecordRequest {
  env?: string;
  /** The persona the window is signed in as (`none`: signed out); default the persona whose `pages` list the page. */
  persona?: string;
  /** The environment page the window opens (default: the persona's first page, else the environment's first). */
  page?: string;
  /** A path under the page (default `/`). */
  path?: string;
  /** Instead of page + path: an http(s) URL on the exact origin of one of the environment's pages. */
  url?: string;
  /** The scenario's name (default recorded-YYYYMMDD-HHMM). Saved only when it is free. */
  name?: string;
  /** `--allow-writes` (a production environment whose project.yaml allows writes), as `retake run`. */
  allowWrites?: boolean;
  /** The check replay after the recording (default true). */
  check?: boolean;
  /** The draft is saved under agent trust (an MCP submission: agent-trust issues refuse it). */
  agent?: boolean;
  submittedBy?: JobClient;
  /** The recording's id, reserved by a `record` job at submit (default: a new one). */
  id?: string;
  /** The `record` job that runs it (meta.json's job_id; none for `retake record`). */
  jobId?: string;
}

export interface RecordPorts {
  /** The workspace's job queue: a recording whose job is queued or running is never pruned. */
  queue: JobQueueView;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** What the recording does now. */
  onPhase?: (phase: 'preflight' | 'recording' | 'draft' | 'check') => void;
  /** The window shows its first page: the person can start. */
  onOpen?: (url: string) => void;
  /** Each event kept while recording (count it; never print its page text). */
  onEvent?: (e: RecordedEvent) => void;
  /** The check replay's progress. */
  onCheckProgress?: (e: RunProgress) => void;
  /** Stop and keep (Ctrl-C, a worker signal). */
  stop?: AbortSignal;
  /** Asked once the recording ended: true skips the check replay (a worker stopped by a signal keeps the draft only). */
  skipCheck?: () => boolean;
  /** Append the recording's history line (default true; a job's line is the worker's). */
  history?: boolean;
  /** Cancel: while recording, nothing is kept; after it, the check replay stops. */
  signal?: AbortSignal;
  /** Who stands behind the check replay (`mcp`: agent trust in the runner). */
  hookTrust?: 'author' | 'mcp';
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
  /** Test hooks (runner-web recordSession): Playwright plays the person; the window runs headless; its size. */
  drive?: RecordSessionOptions['drive'];
  headless?: boolean;
  windowSize?: { width: number; height: number };
}

/** What the check replay found (the error's text is page-derived: `untrusted`). */
export interface RecordCheck {
  status: 'passed' | 'failed' | 'skipped' | 'cancelled';
  /** all: the whole draft (a read-only environment); until_write: up to the step before the first write. */
  scope: 'all' | 'until_write' | null;
  /** The last step replayed (`scene.step`) when the replay stopped before the first write. */
  until?: string;
  /** Why it was skipped. */
  reason?: 'disabled' | 'stopped' | 'nothing_recorded' | 'invalid_draft' | 'first_step_writes';
  steps_passed: number;
  steps_total: number;
  failed_at?: { scene: string; step: number; action: string };
  /** The check's run folder (run.json; the error screenshot when it failed). */
  dir?: string;
  untrusted?: { error: string };
}

export interface RecordOutcome {
  rec_id: string;
  /** The recording's folder (null when nothing was recorded: it was removed). */
  dir: string | null;
  /** draft.yaml (null when nothing was recorded). */
  draft: string | null;
  name: string;
  saved: { file: string; path: string; hash: string } | null;
  /** studio: a recording the Studio started — the person saves it from the Record screen. */
  not_saved?: 'name_taken' | 'invalid' | 'nothing_recorded' | 'refused' | 'studio';
  env: string;
  persona: string | null;
  access: 'read-only' | 'read-write';
  stop: RecordSessionResult['stop'];
  ms: number;
  window: { width: number; height: number } | null;
  capture: { width: number; height: number };
  counts: RecordSessionResult['counts'];
  stats: { scenes: number; steps: number; actions: number; noise: number; secrets: number; fallbacks: number };
  /** The draft's scenes (ids are slugs made from paths) and their step counts. */
  scenes: Array<{ id: string; steps: number; opens: boolean }>;
  /** The draft's issues (never page text; scene / step say where). */
  issues: DraftIssue[];
  /** The recording's warnings (never page text). */
  warnings: string[];
  /** Writes to the environment's hosts while recording (their labels are in record.json). */
  writes: { total: number; by_steps: number; ambient: number; first: { scene: string; step: number } | null };
  check: RecordCheck;
}

/** The start of a recording: environment, persona, page URL (checked before any window opens). */
export interface RecordStart {
  env: ResolvedEnvironment;
  persona: ResolvedPersona | null;
  page: string;
  path: string;
  url: string;
  /** Default persona of each page (null: none); undefined when the environment has no personas. */
  defaultPersonas?: Record<string, string | null>;
}

/** Resolve where a recording starts (EngineError when it cannot). */
export function recordStart(project: LoadedProject, req: Pick<RecordRequest, 'env' | 'persona' | 'page' | 'path' | 'url'>): RecordStart {
  let env: ResolvedEnvironment;
  try {
    env = resolveEnvironment(project, req.env);
  } catch (e) {
    throw toEngineError(e);
  }
  const personas = resolvePersonas(project, env.name, { home: retakeHome() });
  const legacy = personas.find((p) => p.legacy) ?? null;
  const defaultOf = (key: string): ResolvedPersona | null => personas.find((p) => !p.legacy && p.pages.includes(key)) ?? legacy;
  let persona: ResolvedPersona | null | undefined;
  if (req.persona === PERSONA_NONE) persona = null;
  else if (req.persona !== undefined) {
    persona = personas.find((p) => p.name === req.persona);
    if (!persona) {
      throw new EngineError('not_found', `environment ${env.name} has no persona "${req.persona}" (personas: ${personas.map((p) => p.name).join(', ') || 'none'}; or ${PERSONA_NONE})`);
    }
  }
  let page: string;
  let path: string;
  if (req.url !== undefined) {
    if (req.page !== undefined || req.path !== undefined) throw new EngineError('invalid', 'give a url, or a page with an optional path — not both');
    ({ page, path } = pageOfUrl(req.url, env.pages, env.name));
  } else {
    page = req.page ?? persona?.pages.find((k) => Object.hasOwn(env.pages, k)) ?? Object.keys(env.pages)[0];
    path = req.path ?? '/';
  }
  if (page === undefined || !Object.hasOwn(env.pages, page)) {
    throw new EngineError('not_found', `environment ${env.name} has no page "${String(page)}" (pages: ${Object.keys(env.pages).join(', ') || 'none'})`);
  }
  const problem = inspectPathProblem(path);
  if (problem) throw new EngineError('invalid', `path: ${problem}`);
  if (persona === undefined) persona = defaultOf(page);
  let base: URL;
  try {
    base = new URL(env.pages[page]);
  } catch {
    throw new EngineError('invalid', `page ${page} of environment ${env.name} is not a URL`);
  }
  const url = `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
  if (!isPageOrigin(url, env.pages)) throw new EngineError('refused', `page ${page} of environment ${env.name} is not an http(s) URL: nothing to record`);
  const defaultPersonas = personas.length ? Object.fromEntries(Object.keys(env.pages).map((k) => [k, defaultOf(k)?.name ?? null])) : undefined;
  return { env, persona, page, path, url, ...(defaultPersonas ? { defaultPersonas } : {}) };
}

async function writePrivate(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}

const isCancel = (e: unknown) => e instanceof Error && (e.name === 'CancelledError' || (e instanceof EngineError && e.code === 'cancelled'));

/**
 * The persona's session as a run would see it: valid, else signed in by its login steps (headless), else refused with
 * the command that signs it in.
 */
async function preflight(project: LoadedProject, env: ResolvedEnvironment, persona: ResolvedPersona, ports: RecordPorts, policy: WorkPolicy): Promise<void> {
  const { checkSavedSession, signIn } = await import('@retake/runner-web');
  const log = ports.log ?? (() => undefined);
  const command = (ports.loginCommand ?? ((p) => `retake login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`))({ project: project.slug, env: env.name, persona: persona.name });
  let status: string;
  let detail = '';
  try {
    const r = await checkSavedSession({ project, policy, env, persona, log, ...(ports.signal ? { signal: ports.signal } : {}) });
    status = r.status;
    detail = r.detail;
  } catch (e) {
    if (isCancel(e) || ports.signal?.aborted) throw new EngineError('cancelled', 'recording cancelled before the window opened');
    status = 'missing';
    detail = (e as Error).message;
  }
  if (status === 'valid' || status === 'unchecked') return;
  if (!persona.login?.length) {
    throw new EngineError('refused', `persona ${persona.name} is not signed in on ${env.name} (${detail || status}): sign it in first — ${command}`, { fix: command });
  }
  log('info', `persona ${persona.name}: session ${status} — signing in with its login steps (headless)`);
  try {
    const r = await signIn({ project, policy, env, persona, mode: 'auto', log, ...(ports.signal ? { signal: ports.signal } : {}) });
    if (r.check.status !== 'valid' && r.check.status !== 'unchecked') {
      throw new EngineError('refused', `persona ${persona.name} could not be signed in by its login steps (${r.check.detail}): sign it in by hand — ${command}`, { fix: command });
    }
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if (isCancel(e) || ports.signal?.aborted) throw new EngineError('cancelled', 'recording cancelled before the window opened');
    throw new EngineError('refused', `persona ${persona.name} could not be signed in by its login steps: ${(e as Error).message} — or sign it in by hand: ${command}`, { fix: command });
  }
}

/** Record a scenario (see the module comment). EngineError on a refusal before the window opens, or on a cancel. */
export async function recordScenario(ws: OpenedWorkspace, project: LoadedProject, req: RecordRequest, ports: RecordPorts): Promise<RecordOutcome> {
  const started = Date.now();
  // L5.13: never beside an old Studio or worker (engine legacy.ts).
  await refuseBesideOldHolder(project.root, 'this recording');
  const log = ports.log ?? (() => undefined);
  const start = recordStart(project, req);
  const { env, persona } = start;
  if (req.name !== undefined) checkScenarioName(req.name);
  let access: ReturnType<typeof resolveRunAccess>;
  try {
    access = resolveRunAccess(env, { allowWrites: req.allowWrites === true, project });
  } catch (e) {
    throw toEngineError(e);
  }
  const maxMs = recordMaxMs();
  const name = req.name ?? defaultRecordName(project);
  const warnings: string[] = [];
  if (scenarioTaken(project, name)) warnings.push(`scenario ${name} exists: the draft is kept in the recording's folder only (not saved)`);

  if (!ports.drive && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new EngineError('unavailable', 'a recording opens a browser window and no display is available (DISPLAY / WAYLAND_DISPLAY are not set): record on a machine with a screen');
  }
  ports.onPhase?.('preflight');
  if (persona) await preflight(project, env, persona, ports, ws.policy);

  const id = req.id ?? newRecordId();
  const dir = recordDir(project, id);
  if (existsSync(dir)) throw new EngineError('conflict', `recording ${id} exists already: submit the recording again`);
  await mkdir(recordsRoot(project), { recursive: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // What the Studio's view and Save rebuild the draft's context from, and who may change it (critique B4).
  await writeRecordMeta(dir, {
    v: 1,
    rec_id: id,
    job_id: req.jobId ?? null,
    submitted_by: req.submittedBy ?? 'cli',
    name,
    env: env.name,
    persona: persona?.name ?? null,
    access: access.mode,
    page: start.page,
    path: start.path,
    started_at: new Date(started).toISOString(),
    max_ms: maxMs ?? null,
    owner: await selfIdentity(),
  });
  await pruneRecords(project, RECORD_KEEP, [id], ports.queue);
  const eventsFile = join(dir, 'events.jsonl');

  ports.onPhase?.('recording');
  const { recordSession, INSPECT_PACING, runScenario } = await import('@retake/runner-web');
  let session: RecordSessionResult;
  try {
    session = await recordSession({
      policy: ws.policy,
      project,
      env,
      persona,
      url: start.url,
      allowWrites: req.allowWrites === true,
      eventsFile,
      ...(maxMs !== undefined ? { maxMs } : {}),
      log,
      ...(ports.onOpen ? { onOpen: ports.onOpen } : {}),
      ...(ports.onEvent ? { onEvent: ports.onEvent } : {}),
      ...(ports.stop ? { stop: ports.stop } : {}),
      ...(ports.signal ? { signal: ports.signal } : {}),
      ...(ports.drive ? { drive: ports.drive } : {}),
      ...(ports.headless !== undefined ? { headless: ports.headless } : {}),
      ...(ports.windowSize ? { windowSize: ports.windowSize } : {}),
    });
  } catch (e) {
    if (isCancel(e) || ports.signal?.aborted) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await history(ws, project, req, 'cancelled', started, id, 0, false, ports.history !== false);
      throw new EngineError('cancelled', 'recording cancelled: nothing was kept');
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw toEngineError(e);
  }
  warnings.push(...session.warnings);

  ports.onPhase?.('draft');
  const draft = draftFromRecording(session.events, {
    name,
    env: env.name,
    envIsDefault: env.name === (project.config.default_env ?? Object.keys(project.config.environments ?? {})[0]),
    pages: env.pages,
    persona: session.persona,
    ...(start.defaultPersonas ? { defaultPersonas: start.defaultPersonas } : {}),
    ...(project.config.vars ? { projectVars: project.config.vars } : {}),
    access: session.access,
  });
  const base = {
    rec_id: id,
    name,
    env: env.name,
    persona: session.persona,
    access: session.access,
    stop: session.stop,
    ms: session.ms,
    window: session.window,
    capture: session.capture,
    counts: session.counts,
    stats: draft.stats,
    scenes: (draft.scenario.scenes as Array<{ id: string; steps: unknown[]; open?: string }>).map((x) => ({ id: x.id, steps: x.steps.length, opens: x.open !== undefined })),
    issues: draft.issues,
    warnings,
    writes: {
      total: draft.writes.length,
      by_steps: draft.writes.filter((w) => w.step !== null).length,
      ambient: draft.writes.filter((w) => w.step === null).length,
      first: draft.firstWrite,
    },
  };

  if (session.counts.actions === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await history(ws, project, req, 'succeeded', started, id, 0, false, ports.history !== false);
    return { ...base, dir: null, draft: null, saved: null, not_saved: 'nothing_recorded', check: { status: 'skipped', scope: null, reason: 'nothing_recorded', steps_passed: 0, steps_total: 0 } };
  }

  const draftFile = join(dir, 'draft.yaml');
  await writePrivate(draftFile, draft.yaml);
  // The events file as drafted and checked (the stream has ended): a Save from the Studio refuses another one (B8).
  const eventsSha256 = await fileSha256(eventsFile).catch(() => null);
  // Valid in the project (its vars, pages, personas), not only as a scenario: else it is neither saved nor checked.
  if (!draft.issues.some((i) => i.severity === 'error')) {
    const ids = base.scenes.map((x) => x.id);
    for (const x of parseScenario(draft.yaml, { files: fileFacts(ws.policy), project, file: draftFile, env: env.name }).issues) {
      if (x.severity === 'error') draft.issues.push(draftInvalidIssue(x, ids, 'the draft does not validate in the project'));
    }
  }
  const valid = !draft.issues.some((i) => i.severity === 'error');
  const recordJson = (extra: Record<string, unknown>) =>
    writePrivate(
      join(dir, 'record.json'),
      `${JSON.stringify({ version: 1, ...base, started_at: new Date(started).toISOString(), page: start.page, path: start.path, max_ms: maxMs ?? null, writes: draft.writes, first_write: draft.firstWrite, events_sha256: eventsSha256, ...extra }, null, 1)}\n`,
    );
  await recordJson({ saved: null, check: null });

  // Save when the name is (still) free.
  let saved: RecordOutcome['saved'] = null;
  let notSaved: RecordOutcome['not_saved'];
  if (req.submittedBy === 'ui') notSaved = 'studio';
  else if (!valid) notSaved = 'invalid';
  else if (scenarioTaken(project, name)) notSaved = 'name_taken';
  else {
    try {
      const r = await saveScenarioText(project, name, draft.yaml, { files: fileFacts(ws.policy), ifMatch: null, agent: req.agent === true, scope: { workspace: ws.root, caller: callerOf(req.submittedBy ?? 'cli') } });
      saved = { file: r.file, path: r.path, hash: r.hash };
    } catch (e) {
      const err = toEngineError(e);
      notSaved = err.code === 'conflict' ? 'name_taken' : err.code === 'invalid' ? 'invalid' : 'refused';
      // The error's text may quote the draft (page text): a fixed message, in the log and the issues.
      const why = notSaved === 'name_taken' ? 'its name was taken meanwhile' : notSaved === 'invalid' ? 'it does not validate' : 'saving it was refused (agent trust or a file error)';
      log('warn', `the draft was not saved: ${why} — it is kept in the recording's folder`);
      draft.issues.push({ severity: 'error', code: 'not_saved', message: `the draft was not saved: ${why} — it is kept in the recording's folder (draft.yaml); run validate on it` });
    }
  }

  // The check replay.
  let check: RecordCheck;
  if (req.check === false) check = { status: 'skipped', scope: null, reason: 'disabled', steps_passed: 0, steps_total: 0 };
  else if (ports.skipCheck?.()) check = { status: 'skipped', scope: null, reason: 'stopped', steps_passed: 0, steps_total: 0 };
  else if (!valid) check = { status: 'skipped', scope: null, reason: 'invalid_draft', steps_passed: 0, steps_total: 0 };
  else {
    ports.onPhase?.('check');
    check = await checkReplay({ project, policy: ws.policy, envName: env.name, dir, draftFile, yaml: draft.yaml, firstWrite: draft.firstWrite, pacing: INSPECT_PACING, runScenario, ports });
  }
  await recordJson({ saved: saved ? saved.file : null, not_saved: notSaved ?? null, check });
  await history(ws, project, req, 'succeeded', started, id, draft.stats.steps, saved !== null, ports.history !== false);
  return { ...base, dir, draft: draftFile, saved, ...(notSaved ? { not_saved: notSaved } : {}), check };
}

async function history(ws: OpenedWorkspace, project: LoadedProject, req: RecordRequest, state: string, started: number, id: string, steps: number, saved: boolean, on = true): Promise<void> {
  if (!on) return;
  await appendHistory(ws.root, {
    kind: 'record',
    project: project.slug,
    submitted_by: req.submittedBy ?? 'cli',
    state,
    ms: Date.now() - started,
    record: { id, steps, saved },
    counted: { captures: 0, dry_runs: 0, renders: 0 },
  }).catch(() => undefined);
}

/** The dry replay of a fresh draft (see the module comment). Never throws: a failure is the check's result. */
async function checkReplay(o: {
  project: LoadedProject;
  policy: WorkPolicy;
  envName: string;
  dir: string;
  draftFile: string;
  yaml: string;
  firstWrite: { scene: string; step: number } | null;
  pacing: Record<string, unknown>;
  runScenario: typeof import('@retake/runner-web').runScenario;
  ports: RecordPorts;
}): Promise<RecordCheck> {
  const { project, ports } = o;
  const value = parseYaml(o.yaml).value as { scenes: Array<{ id: string; steps: unknown[] }> };
  const flat = value.scenes.flatMap((s) => s.steps.map((_, i) => ({ scene: s.id, step: i })));
  // The check never writes twice: it stops before the first step a write that went through followed (a read-only
  // environment's guard stops the others again, in the replay too).
  let until: string | undefined;
  if (o.firstWrite) {
    const k = flat.findIndex((x) => x.scene === o.firstWrite!.scene && x.step === o.firstWrite!.step);
    if (k <= 0) return { status: 'skipped', scope: 'until_write', reason: 'first_step_writes', steps_passed: 0, steps_total: 0 };
    until = `${flat[k - 1].scene}.${flat[k - 1].step}`;
  }
  const total = until ? flat.findIndex((x) => `${x.scene}.${x.step}` === until) + 1 : flat.length;
  const scope = until ? 'until_write' : 'all';
  // Replayed at inspection pacing (a check, not a take); the saved draft is unchanged.
  const text = `${o.yaml.endsWith('\n') ? o.yaml : `${o.yaml}\n`}pacing: ${JSON.stringify(o.pacing)}\n`;
  const { scenario, issues } = parseScenario(text, { files: fileFacts(o.policy), project, file: o.draftFile, env: o.envName, ...(until ? { until } : {}) });
  if (!scenario) return { status: 'skipped', scope: null, reason: 'invalid_draft', steps_passed: 0, steps_total: total };
  const loaded: LoadedScenario = { name: 'record-check', file: o.draftFile, text, scenario, issues };
  let record: RunRecord;
  try {
    record = await o.runScenario({
      policy: o.policy,
      project,
      scenario: loaded,
      mode: 'dry',
      env: o.envName,
      ...(until ? { until } : {}),
      runsDir: o.dir,
      runId: 'check',
      ...(ports.hookTrust ? { hookTrust: ports.hookTrust } : {}),
      ...(ports.loginCommand ? { loginCommand: ports.loginCommand } : {}),
      ...(ports.signal ? { signal: ports.signal } : {}),
      ...(ports.onCheckProgress ? { onProgress: ports.onCheckProgress } : {}),
    });
  } catch (e) {
    return { status: isCancel(e) ? 'cancelled' : 'failed', scope, ...(until ? { until } : {}), steps_passed: 0, steps_total: total, untrusted: { error: (e as Error).message } };
  }
  const checkDir = join(o.dir, 'check');
  await rm(join(checkDir, 'screenshots'), { recursive: true, force: true }).catch(() => undefined);
  const status = record.status === 'succeeded' ? 'passed' : record.status === 'cancelled' ? 'cancelled' : 'failed';
  const err = record.error;
  return {
    status,
    scope,
    ...(until ? { until } : {}),
    steps_passed: status === 'passed' ? total : Math.max(0, record.steps_done - (err?.step !== undefined ? 1 : 0)),
    steps_total: total,
    ...(err?.scene !== undefined && err.step !== undefined ? { failed_at: { scene: err.scene, step: err.step, action: err.action ?? '?' } } : {}),
    dir: checkDir,
    ...(err && status !== 'passed' ? { untrusted: { error: err.message } } : {}),
  };
}
