/**
 * Recording a scenario (`retake record`; the `record` job and scenario_record build on it): a HEADED window where
 * a person performs a flow once (runner-web recordSession), then a draft scenario from what they did (core
 * draftFromRecording), saved as scenarios/<name>.yaml when the name is free, then a headless check replay of the draft.
 * Claude may start a recording through MCP, never drive it.
 *
 * Files: <project>/.retake/records/<rec_id>/ (0700) — meta.json (written once when the folder is made: the
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
 * - a recording the Studio started (`submittedBy: 'ui'`) is never saved here (`not_saved: 'studio'`): the person
 *   arranges the draft and saves it from the Record screen (record-studio.ts).
 */
import { noDisplay } from './env.js';
import type { EngineEnv } from './env.js';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bestEffort } from '@retake/core/base';
import { RECORD_ID_RE, newUlidId } from '@retake/core/ids';
import { PERSONA_NONE, resolveEnvironment, resolvePersonas, resolveRunAccess } from '@retake/core/environment';
import { projectPath, statePath } from '@retake/core/project';
import { parseScenario } from '@retake/core/scenario';
import { INSPECT_PACING, draftFromRecording, draftInvalidIssue, inspectPathProblem, isPageOrigin } from '@retake/core/run';
import type { RecordingDraft } from '@retake/core/run';
import type { LoadedProject } from '@retake/core/project';
import type { ResolvedEnvironment } from '@retake/core/environment';
import type { ResolvedPersona } from '@retake/core/environment';
import type { RecordSessionResult } from '@retake/runner-web/types';
import { lockAlive, readLock, retakeHome } from '@retake/core/io';
import { callerOf, submittedInStudio } from './caller.js';
import { EngineError, toEngineError } from './errors.js';
import { appendHistory } from './history.js';
import { pageOfUrl } from './page-url.js';
import type { JobQueueView } from './jobs/job-queue.js';
import { dateOf, stampOf } from './clock.js';
import type { Clock } from './clock.js';
import { selfIdentity } from './jobs/proc.js';
import { RECORD_UNSAVED_KEEP_MS, readRecordAnnotations, readRecordMeta, recordLockFile, writeRecordMeta } from './record-files.js';
import { checkScenarioName } from './refs.js';
import { saveScenarioText } from './scenarios.js';
import type { OpenedWorkspace } from './workspace.js';
import { checkReplay, isCancel } from './record-check.js';
import { preflight } from './record-preflight.js';
import type { RecordCheck, RecordOutcome, RecordPorts, RecordRequest, RecordStart } from './record-types.js';

export type { RecordCheck, RecordOutcome, RecordPorts, RecordRequest, RecordStart } from './record-types.js';

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
 * queue — the folder of a recording whose job is still queued or running, nor a folder whose lock is held
 * (an annotate, a Save or a Discard in progress), nor an unsaved, undiscarded Studio recording younger than
 * RECORD_UNSAVED_KEEP_MS.
 */
export async function pruneRecords(project: LoadedProject, clock: Clock, keep = RECORD_KEEP, except: readonly string[] = [], queue?: JobQueueView): Promise<string[]> {
  const active = queue !== undefined ? await bestEffort(activeRecords(queue, project.slug), 'jobs that cannot be read: null, and nothing is pruned on a guess', null) : [];
  // The jobs could not be read: nothing is pruned (a folder in use is never removed on a guess).
  if (active === null) return [];
  except = [...except, ...active];
  let names: string[];
  try {
    names = (await readdir(recordsRoot(project), { withFileTypes: true })).filter((e) => e.isDirectory() && RECORD_ID_RE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const now = clock.now();
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
export function recordMaxMs(env: EngineEnv): number | undefined {
  const raw = env[RECORD_MAX_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) throw new EngineError('invalid', `${RECORD_MAX_ENV} must be a number of minutes from more than 0 to 1440, got "${raw}"`);
  return Math.round(n * 60_000);
}

/** The default name of a recorded scenario: recorded-YYYYMMDD-HHMM (local time), "-2"… when taken. */
export function defaultRecordName(project: LoadedProject, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `recorded-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  let name = base;
  for (let k = 2; scenarioTaken(project, name); k++) name = `${base}-${k}`;
  return name;
}

function scenarioTaken(project: LoadedProject, name: string): boolean {
  return project.scenarios.includes(name) || existsSync(projectPath(project.dir, 'scenarios', `${name}.yaml`)) || existsSync(projectPath(project.dir, 'scenarios', `${name}.yml`));
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

/** Record a scenario (see the module comment). EngineError on a refusal before the window opens, or on a cancel. */
export async function recordScenario(ws: OpenedWorkspace, project: LoadedProject, req: RecordRequest, ports: RecordPorts): Promise<RecordOutcome> {
  // The history line's `ms` is elapsed time (the ports' clock's monotonic side); the record's `started_at` is a stamp of its wall side.
  const started = ports.clock.monotonic();
  const startedAt = stampOf(ports.clock);
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
  const maxMs = recordMaxMs(ports.env);
  const name = req.name ?? defaultRecordName(project, dateOf(ports.clock));
  const warnings: string[] = [];
  if (scenarioTaken(project, name)) warnings.push(`scenario ${name} exists: the draft is kept in the recording's folder only (not saved)`);

  if (!ports.drive && noDisplay(ports.env)) {
    throw new EngineError('unavailable', 'a recording opens a browser window and no display is available (DISPLAY / WAYLAND_DISPLAY are not set): record on a machine with a screen');
  }
  ports.onPhase?.('preflight');
  if (persona) await preflight(project, env, persona, ports, ws.policy);

  const id = req.id ?? newRecordId();
  const dir = await makeRecordFolder(project, { req, ports, id, name, start, access: access.mode, startedAt, maxMs });
  const eventsFile = join(dir, 'events.jsonl');

  const session = await recordWindow(ws, project, { req, ports, start, id, dir, eventsFile, maxMs, started, log });
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
  const base = outcomeBase({ id, name, env: env.name, session, draft, warnings });

  if (session.counts.actions === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await history(ws, { clock: ports.clock, project, req, state: 'succeeded', started, id, steps: 0, saved: false, on: ports.history !== false });
    return { ...base, dir: null, draft: null, saved: null, not_saved: 'nothing_recorded', check: { status: 'skipped', scope: null, reason: 'nothing_recorded', steps_passed: 0, steps_total: 0 } };
  }

  const draftFile = join(dir, 'draft.yaml');
  await writePrivate(draftFile, draft.yaml);
  // The events file as drafted and checked (the stream has ended): a Save from the Studio refuses another one.
  const eventsSha256 = await fileSha256(eventsFile).catch(() => null);
  // Valid in the project (its vars, pages, personas), not only as a scenario: else it is neither saved nor checked.
  if (!draft.issues.some((i) => i.severity === 'error')) {
    const ids = base.scenes.map((x) => x.id);
    for (const x of parseScenario(draft.yaml, { files: ws.reads.fileFacts(ws.policy), project, file: draftFile, env: env.name }).issues) {
      if (x.severity === 'error') draft.issues.push(draftInvalidIssue(x, ids, 'the draft does not validate in the project'));
    }
  }
  const valid = !draft.issues.some((i) => i.severity === 'error');
  const recordJson = (extra: Record<string, unknown>) =>
    writePrivate(
      join(dir, 'record.json'),
      `${JSON.stringify({ version: 1, ...base, started_at: startedAt, page: start.page, path: start.path, max_ms: maxMs ?? null, writes: draft.writes, first_write: draft.firstWrite, events_sha256: eventsSha256, ...extra }, null, 1)}\n`,
    );
  await recordJson({ saved: null, check: null });

  // Save when the name is (still) free.
  const { saved, notSaved } = await saveDraft(ws, project, { req, ports, name, draft, valid, log });

  // The check replay.
  const check = await checkOrSkip(ws, project, { req, ports, valid, envName: env.name, dir, draftFile, draft });
  await recordJson({ saved: saved ? saved.file : null, not_saved: notSaved ?? null, check });
  await history(ws, { clock: ports.clock, project, req, state: 'succeeded', started, id, steps: draft.stats.steps, saved: saved !== null, on: ports.history !== false });
  return { ...base, dir, draft: draftFile, saved, ...(notSaved ? { not_saved: notSaved } : {}), check };
}

/** The recording's folder (0700) with its meta.json, then the older folders pruned. */
async function makeRecordFolder(
  project: LoadedProject,
  o: { req: RecordRequest; ports: RecordPorts; id: string; name: string; start: RecordStart; access: 'read-only' | 'read-write'; startedAt: string; maxMs: number | undefined },
): Promise<string> {
  const { req, ports, id, name, start, access, startedAt, maxMs } = o;
  const dir = recordDir(project, id);
  if (existsSync(dir)) throw new EngineError('conflict', `recording ${id} exists already: submit the recording again`);
  await mkdir(recordsRoot(project), { recursive: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // What the Studio's view and Save rebuild the draft's context from, and who may change it.
  await writeRecordMeta(dir, {
    v: 1,
    rec_id: id,
    job_id: req.jobId ?? null,
    submitted_by: req.submittedBy ?? 'cli',
    name,
    env: start.env.name,
    persona: start.persona?.name ?? null,
    access,
    page: start.page,
    path: start.path,
    started_at: startedAt,
    max_ms: maxMs ?? null,
    owner: await selfIdentity(),
  });
  await pruneRecords(project, ports.clock, RECORD_KEEP, [id], ports.queue);
  return dir;
}

/** The headed window (runner-web recordSession); a cancel keeps nothing (the folder removed, the history line written). */
async function recordWindow(
  ws: OpenedWorkspace,
  project: LoadedProject,
  o: { req: RecordRequest; ports: RecordPorts; start: RecordStart; id: string; dir: string; eventsFile: string; maxMs: number | undefined; started: number; log: NonNullable<RecordPorts['log']> },
): Promise<RecordSessionResult> {
  const { req, ports, start, id, dir, eventsFile, maxMs, started, log } = o;
  const { env, persona } = start;
  ports.onPhase?.('recording');
  await ports.capture.load();
  let session: RecordSessionResult;
  try {
    session = await ports.capture.record({
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
      await history(ws, { clock: ports.clock, project, req, state: 'cancelled', started, id, steps: 0, saved: false, on: ports.history !== false });
      throw new EngineError('cancelled', 'recording cancelled: nothing was kept');
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw toEngineError(e);
  }
  return session;
}

/** What every outcome of a recorded session says: its context, counts, draft stats, issues and writes. */
function outcomeBase(o: { id: string; name: string; env: string; session: RecordSessionResult; draft: RecordingDraft; warnings: string[] }) {
  const { id, name, env, session, draft, warnings } = o;
  return {
    rec_id: id,
    name,
    env,
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
}

/** Save the draft when its name is (still) free; never a Studio recording's (the person saves it from the Record screen). */
async function saveDraft(
  ws: OpenedWorkspace,
  project: LoadedProject,
  o: { req: RecordRequest; ports: RecordPorts; name: string; draft: RecordingDraft; valid: boolean; log: NonNullable<RecordPorts['log']> },
): Promise<{ saved: RecordOutcome['saved']; notSaved: RecordOutcome['not_saved'] }> {
  const { req, ports, name, draft, valid, log } = o;
  let saved: RecordOutcome['saved'] = null;
  let notSaved: RecordOutcome['not_saved'];
  if (req.submittedBy === 'ui') notSaved = 'studio';
  else if (!valid) notSaved = 'invalid';
  else if (scenarioTaken(project, name)) notSaved = 'name_taken';
  else {
    try {
      const r = await saveScenarioText(project, name, draft.yaml, {
        files: ws.reads.fileFacts(ws.policy),
        reads: ws.reads,
        ifMatch: null,
        agent: req.agent === true,
        // A recording's own save (the CLI's, a job's): no engine shows it.
        seen: undefined,
        scope: { workspace: ws.root, caller: callerOf(req.submittedBy ?? 'cli'), clock: ports.clock, stores: ports.stores },
      });
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
  return { saved, notSaved };
}

/** The check replay, or why it is skipped (disabled, stopped, an invalid draft). */
async function checkOrSkip(
  ws: OpenedWorkspace,
  project: LoadedProject,
  o: { req: RecordRequest; ports: RecordPorts; valid: boolean; envName: string; dir: string; draftFile: string; draft: RecordingDraft },
): Promise<RecordCheck> {
  const { req, ports, valid, dir, draftFile, draft } = o;
  let check: RecordCheck;
  if (req.check === false) check = { status: 'skipped', scope: null, reason: 'disabled', steps_passed: 0, steps_total: 0 };
  else if (ports.skipCheck?.()) check = { status: 'skipped', scope: null, reason: 'stopped', steps_passed: 0, steps_total: 0 };
  else if (!valid) check = { status: 'skipped', scope: null, reason: 'invalid_draft', steps_passed: 0, steps_total: 0 };
  else {
    ports.onPhase?.('check');
    check = await checkReplay({ project, runs: ws.outputs.runs, policy: ws.policy, envName: o.envName, dir, draftFile, yaml: draft.yaml, firstWrite: draft.firstWrite, pacing: INSPECT_PACING, ports });
  }
  return check;
}

/** The history line of one recording. */
async function history(
  ws: OpenedWorkspace,
  o: { clock: Clock; project: LoadedProject; req: RecordRequest; state: string; started: number; id: string; steps: number; saved: boolean; on?: boolean },
): Promise<void> {
  const { clock, project, req, state, started, id, steps, saved, on = true } = o;
  if (!on) return;
  await bestEffort(
    appendHistory(
      ws.root,
      {
        kind: 'record',
        project: project.slug,
        submitted_by: req.submittedBy ?? 'cli',
        state,
        ms: Math.round(clock.monotonic() - started),
        record: { id, steps, saved },
        counted: { captures: 0, dry_runs: 0, renders: 0 },
      },
      clock,
    ),
    'the history line only feeds the activity list and its counts: the recording itself is saved',
  );
}
