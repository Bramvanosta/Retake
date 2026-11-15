/**
 * `inspect` jobs (L3.3, R-MCP-23 / R-MCP-36): page_inspect through the worker. A dry replay — of a one-scene scenario
 * opening a path on an environment page, or of a saved scenario up to `until` — with the runner's `inspect` option: the
 * page it shows is inventoried for an author (runner-web inspect.ts) into <project>/.retake/inspect/<id>/
 * (inspect.json, screenshot.png and, drawn here through the review package, marked.jpg). The newest 20 are kept.
 *
 * Trust: run_dry's semantics — the environment's own access (production read-only), hooks never run, agent trust of
 * the replayed scenario (`hookTrust` ENGINE_TRUST: `mcp`), the workspace's protected hosts — checked at submit and again by the
 * worker (project.yaml or the scenario may change in between: the scenario's bytes are pinned by their sha256). A URL is
 * accepted only on the exact origin of one of the environment's pages and becomes a page key + path; the runner checks
 * the final URL again before anything of the page is taken. No `{{…}}` template in anything given. Inspections never
 * enter runs/ (run_list, `latest`, reviews do not see them).
 *
 * When the replay ends before the page could be inspected (a preflight or sign-in failure, a refused scenario), the job
 * still succeeds and reports the run's error under `untrusted` (and which persona must sign in); a cancel cancels it.
 */
import { OUTPUT_DIRS } from '../outputs/outputs.js';
import type { OutputFolder } from '../outputs/outputs.js';
import type { RunOutputs } from '../outputs/outputs.js';
import type { Secrets } from '../secrets/secrets.js';
import { join } from 'node:path';
import { INSPECT_ID_RE, newUlidId } from '@retake/core/ids';
import { resolveEnvironment } from '@retake/core/environment';
import { projectRef } from '@retake/core/project';
import { inspectPathProblem, inspectScenario, isPageOrigin } from '@retake/core/run';
import { pageOfUrl } from '../page-url.js';
export { pageOfUrl } from '../page-url.js';
import { JOB_INPUT_VERSION } from './job-input.js';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedScenario } from '@retake/core/scenario';
import type { TargetSpec } from '@retake/core/language';
import type { WorkPolicy } from '@retake/core/policy';
import type { RunProgress, RunRecord } from '@retake/core/run';
import type { InspectJobInput } from './job-input.js';
import type { InspectReport } from '@retake/runner-web/types';
import { stampOf } from '../clock.js';
import { ENGINE_TRUST } from '../caller.js';
import { agentChannel, checkAgentTrust } from '../approvals.js';
import { EngineError, scenarioChangedConflict, toEngineError } from '../errors.js';
import { checkSandboxEnv, prepareRun } from '../execute-run.js';
import { openProjectBySlug } from '../projects.js';
import { checkWorkspaceProtection } from '../protected-hosts.js';
import { checkProjectSlug, checkScenarioName } from '../refs.js';
import { sha256Hex } from '../storage.js';
import type { JobQueueView } from './job-queue.js';
import type { SubmitContext } from './run-job.js';
import type { InspectJobResult, JobEventBody, JobProgress, JobRecord } from './types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';
import type { FrameTools } from '../review/reviewer.js';
import type { CaptureRunner } from '../capture/runner.js';
import type { HookRunner } from '../hook-run/runner.js';
import { bestEffort, errorMessage } from '@retake/core/base';
import { storedJson } from '../stored-json.js';
import { z } from 'zod';

/** Inspections kept per project (the newest). */
export const INSPECT_KEEP = 20;

/** What a client asks to inspect: exactly one of `page` (+ `path`), `url`, or `scenario` (+ `until`). */
export interface InspectSubmitRequest {
  project: string;
  env?: string;
  page?: string;
  path?: string;
  /** An http(s) URL on the exact origin of one of the environment's pages (resolved to a page key + path). */
  url?: string;
  /** A page inspection's persona (`none`: signed out); default the persona whose `pages` list the page. */
  persona?: string;
  scenario?: string;
  until?: string;
  within?: TargetSpec;
  targets?: TargetSpec[];
  limit?: number;
  images?: 'marked' | 'none';
}

/** <project>/.retake/inspect */
export function inspectRoot(project: LoadedProject): string {
  return OUTPUT_DIRS.inspections(project.dir);
}

/** <project>/.retake/inspect/<id> (the id checked: never a path). */
export function inspectDir(project: LoadedProject, id: string): string {
  if (!INSPECT_ID_RE.test(id)) throw new EngineError('invalid', `invalid inspection id "${id}": i_ followed by 26 characters (page_inspect returns it), never a path`);
  return join(inspectRoot(project), id);
}

export function newInspectId(): string {
  return newUlidId('inspect');
}

/** The inspections of a project whose job is queued or running (their folders are in use). */
export async function activeInspections(queue: JobQueueView, slug: string): Promise<string[]> {
  const jobs = await queue.list({ project: slug, kinds: ['inspect'], states: ['queued', 'running'], limit: 10_000 });
  return jobs.flatMap((j) => (j.input.kind === 'inspect' ? [j.input.inspect_id] : []));
}

/**
 * Keep the newest `keep` inspection folders of a project (ids sort by creation); `except` is never removed, nor —
 * given the workspace's job queue — the folder of an inspection whose job is still queued or running.
 */
export async function pruneInspections(inspections: OutputFolder, project: LoadedProject, keep = INSPECT_KEEP, except: readonly string[] = [], queue?: JobQueueView): Promise<string[]> {
  const active = queue !== undefined ? await bestEffort(activeInspections(queue, project.slug), 'jobs that cannot be read: null, and nothing is pruned on a guess', null) : [];
  // The jobs could not be read: nothing is pruned (a folder in use is never removed on a guess).
  if (active === null) return [];
  except = [...except, ...active];
  const root = inspectRoot(project);
  // A .retake/inspect that leads out of the project is not the project's: nothing in it is removed.
  if (!(await inspections.within(project.dir, root))) return [];
  const names: string[] = [];
  for (const name of await inspections.names(root)) if (INSPECT_ID_RE.test(name) && (await inspections.kind(join(root, name))) === 'folder') names.push(name);
  const old = names
    .sort()
    .reverse()
    .slice(keep)
    .filter((n) => !except.includes(n));
  for (const n of old) await inspections.remove(join(root, n)).catch(() => undefined);
  return old;
}

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `retake inspect` command a human runs for (about) the same inspection. */
export function inspectCommandLine(cli: string, project: string, source: InspectJobInput['source'], env: string | undefined): string {
  const parts = [cli, 'inspect', project];
  if (source.kind === 'page') {
    parts.push(source.page);
    if (source.path !== '/') parts.push('--path', q(source.path));
    if (source.persona !== undefined) parts.push('--persona', source.persona);
  } else {
    parts.push(source.scenario);
    if (source.until !== undefined) parts.push('--until', q(source.until));
  }
  if (env !== undefined) parts.push('--env', q(env));
  return parts.join(' ');
}

type InspectSource = InspectJobInput['source'];
/** A source before its scenario's sha256 is known (submit). */
export type InspectSourceDraft = Extract<InspectSource, { kind: 'page' }> | (Omit<Extract<InspectSource, { kind: 'scenario' }>, 'scenario_sha256'> & { scenario_sha256?: string });

const hasTemplate = (v: unknown) => v !== undefined && JSON.stringify(v).includes('{{');

/** A submitted request → the job's `source` (sha of a scenario added by prepare). Shape checks only. */
function sourceOf(req: InspectSubmitRequest, pages: Record<string, string>, envName: string): InspectSourceDraft {
  const given = [req.page !== undefined, req.url !== undefined, req.scenario !== undefined].filter(Boolean).length;
  if (given !== 1) throw new EngineError('invalid', 'give exactly one of page (with an optional path), url, or scenario (with an optional until)');
  for (const [k, v] of Object.entries({ page: req.page, path: req.path, url: req.url, persona: req.persona, scenario: req.scenario, until: req.until, within: req.within, targets: req.targets })) {
    if (hasTemplate(v)) throw new EngineError('refused', `${k}: no {{…}} template in an inspection (no environment variable or keychain value reaches a page through it)`);
  }
  if (req.scenario !== undefined) {
    if (req.path !== undefined || req.persona !== undefined) throw new EngineError('invalid', 'path and persona go with page (a scenario names its own pages and personas)');
    checkScenarioName(req.scenario);
    return { kind: 'scenario', scenario: req.scenario, ...(req.until !== undefined ? { until: req.until } : {}) };
  }
  if (req.until !== undefined) throw new EngineError('invalid', 'until goes with scenario (a step of the scenario replayed)');
  let page: string;
  let path: string;
  if (req.url !== undefined) {
    if (req.path !== undefined) throw new EngineError('invalid', 'path goes with page (a url carries its own path)');
    ({ page, path } = pageOfUrl(req.url, pages, envName));
  } else {
    page = req.page!;
    path = req.path ?? '/';
  }
  if (!Object.hasOwn(pages, page)) throw new EngineError('not_found', `environment ${envName} has no page "${page}" (pages: ${Object.keys(pages).join(', ') || 'none'})`);
  const problem = inspectPathProblem(path);
  if (problem) throw new EngineError('invalid', `path: ${problem}`);
  return { kind: 'page', page, path, ...(req.persona !== undefined ? { persona: req.persona } : {}) };
}

export interface PreparedInspect {
  project: LoadedProject;
  scenario: LoadedScenario;
  /** The environment the replay runs on. */
  env: string;
  source: InspectJobInput['source'];
}

/**
 * Build the replayed scenario of a source and check it (submit, the worker, the CLI): the page key and persona against
 * the environment, or the saved scenario (its `until`, its sha256 when one was pinned); the page key's origin again.
 */
export async function prepareInspect(ws: OpenedWorkspace, project: LoadedProject, source: InspectSourceDraft, envArg: string | undefined): Promise<PreparedInspect> {
  try {
    if (source.kind === 'page') {
      const env = resolveEnvironment(project, envArg);
      if (!Object.hasOwn(env.pages, source.page)) throw new EngineError('not_found', `environment ${env.name} has no page "${source.page}" (pages: ${Object.keys(env.pages).join(', ') || 'none'})`);
      // The page's own URL must be an http(s) origin (a page of project.yaml could name anything).
      if (!isPageOrigin(env.pages[source.page], env.pages)) throw new EngineError('refused', `page ${source.page} of environment ${env.name} is not an http(s) URL: nothing to inspect`);
      let scenario: LoadedScenario;
      try {
        scenario = inspectScenario(source.page, source.path, {
          ...(source.persona !== undefined ? { persona: source.persona } : {}),
          check: { project, env: env.name, files: ws.reads.fileFacts(ws.policy) },
        });
      } catch (e) {
        throw new EngineError('invalid', errorMessage(e));
      }
      return { project, scenario, env: env.name, source };
    }
    // One read of the file: a pinned sha256 is checked on the bytes that are parsed (core loadScenario's expectSha256).
    const prepared = await prepareRun(ws, project, source.scenario, {
      dry: true,
      ...(source.until !== undefined ? { until: source.until } : {}),
      ...(envArg !== undefined ? { env: envArg } : {}),
      ...(source.scenario_sha256 !== undefined ? { expectSha256: source.scenario_sha256 } : {}),
    }).catch((e: unknown) => {
      throw scenarioChangedConflict(e, `${projectRef('scenarios', source.scenario)} changed since the inspection was submitted: submit it again (what was checked is what runs)`);
    });
    const env = resolveEnvironment(project, envArg ?? prepared.scenario.scenario.env);
    const sha = prepared.scenario.sha256 ?? sha256Hex(Buffer.from(prepared.scenario.text, 'utf8'));
    return { project, scenario: prepared.scenario, env: env.name, source: { ...source, scenario_sha256: sha } };
  } catch (e) {
    throw toEngineError(e);
  }
}

/** Check, reserve the inspection's folder and queue an `inspect` job. */
export async function submitInspectJob(
  ctx: SubmitContext,
  req: InspectSubmitRequest,
): Promise<{ job: JobRecord; inspect_id: string; dir: string; env: string; source: InspectJobInput['source']; warnings: string[] }> {
  checkProjectSlug(req.project);
  const project = await openProjectBySlug(ctx.ws, req.project);
  let env: ReturnType<typeof resolveEnvironment>;
  try {
    env = resolveEnvironment(project, req.env);
  } catch (e) {
    throw toEngineError(e);
  }
  const shape = sourceOf(req, env.pages, env.name);
  const p = await prepareInspect(ctx.ws, project, shape, req.env);
  const fix = inspectCommandLine(ctx.cli, project.slug, p.source, req.env);
  // What an agent may run (agent-trust) and where (the workspace's protected hosts), as for run_dry.
  checkAgentTrust(project, p.scenario.scenario, fix, ctx.client, p.env === env.name ? env : resolveEnvironment(project, p.env));
  await checkWorkspaceProtection(ctx.ws, ctx.hosts, project, p.env, fix, agentChannel(ctx.client));
  const id = newInspectId();
  const dir = inspectDir(project, id);
  // Made inside the project only (the port refuses a .retake/inspect, or a folder of it, that leads out): before
  // anything is pruned or queued.
  await ctx.ws.outputs.inspections.makeFolder(dir, project.dir);
  await pruneInspections(ctx.ws.outputs.inspections, project, INSPECT_KEEP, [id], ctx.queue);
  const input: InspectJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'inspect',
    project: project.slug,
    inspect_id: id,
    ...(req.env !== undefined ? { env: req.env } : {}),
    source: p.source,
    ...(req.within !== undefined ? { within: req.within } : {}),
    ...(req.targets?.length ? { targets: req.targets } : {}),
    ...(req.limit !== undefined ? { limit: req.limit } : {}),
    images: req.images ?? 'marked',
    submitted_by: ctx.client,
  };
  let job: JobRecord;
  try {
    job = await ctx.queue.enqueue(input);
  } catch (e) {
    await ctx.ws.outputs.inspections.remove(dir).catch(() => undefined);
    throw e;
  }
  const sc = p.scenario.scenario;
  const warnings = p.source.kind === 'scenario' ? p.scenario.issues.map((i) => i.message) : [];
  if (p.source.kind === 'scenario' && (sc.setup?.length ?? 0) > 0) warnings.push('the scenario has setup hooks: an inspection never runs them, so data they prepare is missing from the replay');
  return { job, inspect_id: id, dir, env: p.env, source: p.source, warnings };
}

export interface InspectionRun {
  record: RunRecord;
  /** The report (also in inspect.json); null when the replay ended before the page could be inspected. */
  report: InspectReport | null;
  /** marked.jpg, when drawn. */
  marked: string | null;
  /** A persona whose session the run needed and did not have (the message names the sign-in): from the runner's messages. */
  signIn: { env: string; persona?: string } | null;
}

export interface InspectionOptions {
  /** What the work runs under (core WorkPolicy). */
  policy: WorkPolicy;
  prepared: PreparedInspect;
  /** The folder holding inspection folders, and this one's id (its folder: <runsDir>/<id>). */
  runsDir: string;
  id: string;
  within?: TargetSpec;
  targets?: TargetSpec[];
  limit?: number;
  images: 'marked' | 'none';
  /** What draws the marks on the screenshot (its composition root's reviewer, review/reviewer.ts). */
  frames: Pick<FrameTools, 'marks'>;
  /** What replays the scenario (its composition root's capture runner, capture/runner.ts). */
  capture: CaptureRunner;
  /** What its secret references are resolved with (its composition root's Secrets port). */
  secrets: Secrets;
  /** Where an in-memory runner writes the replay's run (its workspace's Outputs port). */
  runs: RunOutputs;
  /** Its hook runner, handed to every run (an inspection skips the scenario's hooks: nothing runs through it). */
  hooks: HookRunner;
  /** Who stands behind the replayed scenario (`mcp`: agent trust in the runner). */
  hookTrust?: 'author' | 'mcp';
  signal?: AbortSignal;
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
  onProgress?: (e: RunProgress) => void;
}

/**
 * Run one inspection (the worker's job and `retake inspect`): the dry replay with the runner's `inspect` option, then
 * the marks drawn on the screenshot (boxes of the listed elements in view, × the capture scale).
 */
export async function runInspection(o: InspectionOptions): Promise<InspectionRun> {
  const { prepared } = o;
  let report: InspectReport | null = null;
  let signIn: InspectionRun['signIn'] = null;
  const record = await o.capture.run({
    resolveSecret: (ref) => o.secrets.resolve(ref),
    runs: o.runs,
    policy: o.policy,
    project: prepared.project,
    scenario: prepared.scenario,
    mode: 'dry',
    env: prepared.env,
    ...(prepared.source.kind === 'scenario' && prepared.source.until !== undefined ? { until: prepared.source.until } : {}),
    runsDir: o.runsDir,
    runId: o.id,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.hookTrust ? { hookTrust: o.hookTrust } : {}),
    loginCommand: (p) => {
      // The runner names the sign-in a persona needs only in a message about it.
      signIn = { env: p.env, ...(p.persona !== undefined ? { persona: p.persona } : {}) };
      return o.loginCommand ? o.loginCommand(p) : `retake login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`;
    },
    inspect: {
      ...(o.within !== undefined ? { within: o.within } : {}),
      ...(o.targets?.length ? { targets: o.targets } : {}),
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
      onResult: (r) => void (report = r),
    },
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    hookRunner: o.hooks,
  });
  const r = report as InspectReport | null;
  let marked: string | null = null;
  if (r && r.status === 'ok' && r.screenshot && o.images === 'marked') {
    const out = join(o.runsDir, o.id, 'marked.jpg');
    await o.frames.marks(r.screenshot, markBoxes(r), out, { scale: r.scale });
    marked = out;
  }
  return { record, report: r, marked, signIn: r ? null : signIn };
}

/**
 * The boxes marked on the screenshot (device px): the listed elements in view, except those something else is drawn
 * over (a modal over the page) — their number would sit on the cover, on what a click there would really hit.
 */
export function markBoxes(r: Pick<InspectReport, 'elements' | 'scale'>): Array<{ mark: number; x: number; y: number; w: number; h: number }> {
  return r.elements.filter((e) => e.in_view && !e.state.covered).map((e) => ({ mark: e.mark, x: e.bbox.x * r.scale, y: e.bbox.y * r.scale, w: e.bbox.w * r.scale, h: e.bbox.h * r.scale }));
}

/** The job's result from an inspection (counts and booleans; page text only under `untrusted`). */
export function inspectResult(id: string, dir: string, run: InspectionRun): InspectJobResult {
  const r = run.report;
  return {
    kind: 'inspect',
    inspect_id: id,
    dir,
    file: r ? r.file : null,
    reported: r !== null,
    status: r ? r.status : 'failed',
    at: r ? r.at : null,
    page: r ? r.page : null,
    persona: r ? r.persona : null,
    run_status: run.record.status,
    screenshot: r?.screenshot ?? null,
    marked: run.marked,
    counts: r ? r.counts : null,
    replay: r ? r.replay : null,
    ...(run.signIn ? { sign_in: run.signIn } : {}),
    untrusted: {
      ...(r?.untrusted.error !== undefined ? { error: r.untrusted.error } : !r && run.record.error ? { error: run.record.error.message } : {}),
      warnings: r ? r.untrusted.warnings : [],
    },
  };
}

/** What the job runs with; its ports (ports.ts EnginePorts) are its composition root's, handed on by the job runner. */
export interface InspectJobContext extends EnginePorts {
  ws: OpenedWorkspace;
  cli: string;
  input: InspectJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
}

/** Execute an `inspect` job: every check again, then the inspection into its reserved folder. */
export async function executeInspectJob(ctx: InspectJobContext): Promise<InspectJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const dir = inspectDir(project, input.inspect_id);
  const prepared = await prepareInspect(ctx.ws, project, input.source, input.env);
  await checkWorkspaceProtection(ctx.ws, ctx.hosts, project, prepared.env);
  await checkSandboxEnv(project, prepared.env, (level, message) => ctx.event({ type: 'log', level, message }), ctx.ws.policy, ctx.sandboxes);
  const progress: JobProgress = { steps_done: 0, steps_total: 0, phase: 'replay', updated_at: stampOf(ctx.clock) };
  const update = (patch: Partial<JobProgress>) => {
    Object.assign(progress, patch, { updated_at: stampOf(ctx.clock) });
    ctx.progress({ ...progress });
  };
  const run = await runInspection({
    policy: ctx.ws.policy,
    prepared,
    runsDir: inspectRoot(project),
    id: input.inspect_id,
    ...(input.within !== undefined ? { within: input.within } : {}),
    ...(input.targets ? { targets: input.targets } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    images: input.images,
    frames: ctx.reviewer.frames,
    capture: ctx.capture,
    secrets: ctx.secrets,
    runs: ctx.ws.outputs.runs,
    hooks: ctx.hooks,
    hookTrust: ENGINE_TRUST,
    signal: ctx.signal,
    loginCommand: (p) => `${ctx.cli} login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`,
    onProgress: (e) => {
      if (e.type === 'run_start') update({ steps_total: e.run.steps_total });
      else if (e.type === 'step_start') update({ current: { scene: e.scene, step: e.step, action: e.action } });
      else if (e.type === 'step_end') update({ steps_done: progress.steps_done + 1 });
      else if (e.type === 'run_end') update({ steps_done: e.run.steps_done, phase: 'inspect' });
    },
  });
  if (!run.report && (run.record.status === 'cancelled' || ctx.signal.aborted)) throw new EngineError('cancelled', run.record.error?.message ?? 'inspection cancelled');
  return inspectResult(input.inspect_id, dir, run);
}

/**
 * What an inspect.json must hold for its readers (inspect_get, the Studio): this version, its status, its screenshot
 * (its path is set from the folder below), its elements, counts and untrusted block. A file that is not one reads as no
 * report (the folder's other files still answer).
 */
const InspectReportSchema = z.object({
  version: z.literal(1),
  status: z.enum(['ok', 'landed_elsewhere', 'failed']),
  screenshot: z.string().nullable(),
  elements: z.array(z.unknown()),
  counts: z.record(z.string(), z.unknown()),
  untrusted: z.record(z.string(), z.unknown()),
});

/** inspect.json (a file of `inspections`) as a report, or null when there is none or it is not one. */
export async function readInspectReport(inspections: Pick<OutputFolder, 'readText'>, file: string): Promise<InspectReport | null> {
  return inspectReportOf(await inspections.readText(file).catch(() => undefined));
}

/** An inspection's report from its file's text (undefined: no file), through its schema; null when it is none. */
function inspectReportOf(text: string | undefined): InspectReport | null {
  return text === undefined ? null : ((storedJson(InspectReportSchema, text) as InspectReport | undefined) ?? null);
}

/** An inspection's report, read back from its folder (page text stays under `untrusted`). */
export async function readInspection(ws: OpenedWorkspace, slug: string, id: string): Promise<{ dir: string; report: InspectReport | null; marked: string | null }> {
  checkProjectSlug(slug);
  const project = await openProjectBySlug(ws, slug);
  const dir = inspectDir(project, id);
  const inspections = ws.outputs.inspections;
  const report = inspectReportOf(await inspections.readText(join(dir, 'inspect.json')));
  const marked = (await inspections.kind(join(dir, 'marked.jpg'))) === 'file' ? join(dir, 'marked.jpg') : null;
  // Paths as this folder has them (inspect.json is a file of the project: never trusted to point elsewhere).
  if (report) {
    report.file = join(dir, 'inspect.json');
    if (report.screenshot !== null) report.screenshot = join(dir, 'screenshot.png');
  }
  return { dir, report, marked };
}
