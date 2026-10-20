/**
 * `render` jobs (L3.2, R-MCP-29): a render submitted by a client outside the CLI (the MCP server) and executed by the
 * jobs worker with the editor's `renderVideo`, guarded (trust `mcp`, network guard).
 *
 * Submit plans the run in the client's process (editor `planRun` with trust `mcp`: its two gates refuse files outside
 * the project, a theme named by folder, remote slot values — no browser is opened), hashes the run's timeline, reserves
 * the render id (an O_EXCL `.<scenario>-v<N>.lock` of renders/, the variant's suffix from the plan) and queues the input;
 * a lock whose job cannot be queued is released. The worker plans again (the same gates), refuses a timeline or a
 * variant that changed, records the render browser's process (job folder, browser.json) and renders. A failed or
 * cancelled render writes nothing under its id and releases the lock: the next render of the scenario reuses the id
 * (render_status looks the job up first).
 *
 * The editor is imported lazily: a capture-only worker, and an MCP process that never plans, do not load Remotion.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EditOverridesInputSchema, JOB_INPUT_VERSION, TEMPLATE_NAME_RE, scenarioChangedSinceRun } from '@demo-studio/core';
import type { EditOverridesInput, LoadedProject, RenderJobInput, WorkspaceConfig } from '@demo-studio/core';
import type { BrowserProcessInfo, EditOverrides, PlannedRun, RenderProgress } from '@demo-studio/editor';
import { EngineError, toEngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { RUN_ID_RE, checkProjectSlug, checkRunId, checkScenarioName } from '../refs.js';
import { sha256Hex } from '../storage.js';
import { isAlive } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import type { SubmitContext } from './run-job.js';
import type { FileJobQueue } from './queue.js';
import type { JobEventBody, JobProgress, JobRecord, RenderJobResult } from './types.js';

/** Lazy: @demo-studio/editor pulls in Remotion's renderer and bundler. */
export const editor = () => import('@demo-studio/editor');

export interface RenderRequest {
  project: string;
  scenario: string;
  /** A capture run of the scenario (default: its latest capture). */
  run_id?: string;
  /** A theme name (template_list): never a folder. */
  template?: string;
  overrides?: EditOverridesInput;
}

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `studio render` command a human runs for (about) the same render (overrides other than the theme are not carried). */
export function renderCommandLine(cli: string, r: { project: string; scenario: string; run_id?: string; template?: string }): string {
  return [cli, 'render', r.project, r.scenario, ...(r.run_id ? ['--run', q(r.run_id)] : []), ...(r.template ? ['--theme', q(r.template)] : [])].join(' ');
}

/** Check the names of a render request and parse its overrides (strict, bounded): EngineError `invalid`. */
export function checkRenderRequest(req: RenderRequest): EditOverridesInput {
  checkProjectSlug(req.project);
  checkScenarioName(req.scenario);
  if (req.run_id !== undefined) checkRunId(req.run_id);
  if (req.template !== undefined && (typeof req.template !== 'string' || !TEMPLATE_NAME_RE.test(req.template) || req.template.length > 100)) {
    throw new EngineError('invalid', `invalid theme "${String(req.template)}": a theme name (template_list names them), never a path`);
  }
  const parsed = EditOverridesInputSchema.safeParse(req.overrides ?? {});
  if (!parsed.success) {
    throw new EngineError('invalid', `invalid overrides: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(overrides)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/**
 * Plan a render request in this process (no browser), through the trust gates of work submitted through MCP. A
 * refusal is EngineError `refused` with the `studio render` command a human runs. `scenario_changed` (L3.8): the
 * project's scenario file differs from the run's snapshot — the render shows the run as captured, a re-capture films
 * the change (core scenarioChangedSinceRun; undefined when either file is missing).
 */
export async function planRenderRequest(
  ws: WorkspaceConfig,
  cli: string,
  req: RenderRequest,
): Promise<{ project: LoadedProject; planned: PlannedRun; overrides: EditOverridesInput; scenario_changed?: boolean }> {
  const overrides = checkRenderRequest(req);
  const project = await openProjectBySlug(ws, req.project);
  const ed = await editor();
  try {
    const planned = await ed.planRun({
      project,
      run: req.run_id ?? 'latest',
      scenario: req.scenario,
      ...(req.template !== undefined ? { template: req.template } : {}),
      overrides: overrides as EditOverrides,
      root: ws.root,
      trust: 'mcp',
    });
    // The run id reaches trusted summaries: `latest` picks only run ids (editor findRun); never one of another shape.
    if (!RUN_ID_RE.test(planned.run.id) || planned.run.id.length > 200) {
      throw new EngineError('invalid', 'the run picked is not a run id of runs/ (letters, digits, ".", "_", "-"): pass run_id (run_list names the runs)');
    }
    const changed = scenarioChangedSinceRun(project, planned.run.dir, planned.timeline.scenario);
    return { project, planned, overrides, ...(changed !== undefined ? { scenario_changed: changed } : {}) };
  } catch (e) {
    if (e instanceof ed.PlanTrustError) {
      throw new EngineError('refused', e.message, { fix: renderCommandLine(cli, req), details: { problems: e.problems } });
    }
    throw toEngineError(e);
  }
}

/** The version and variant a render id names ("quote-v3-vertical" → 3, vertical). */
export function parseRenderId(renderId: string, scenario: string): { version: number; variant: 'landscape' | 'vertical' | 'square' } {
  const m = /-v(\d+)(-vertical|-square)?$/.exec(renderId);
  if (!m || renderId.slice(0, m.index) !== scenario) throw new EngineError('invalid', `render id ${renderId} is not a render of scenario ${scenario}`);
  return { version: Number(m[1]), variant: m[2] === '-vertical' ? 'vertical' : m[2] === '-square' ? 'square' : 'landscape' };
}

/** Check, plan, reserve the render id and queue a `render` job. */
export async function submitRenderJob(
  ctx: SubmitContext,
  req: RenderRequest,
): Promise<{ job: JobRecord; render_id: string; run_id: string; variant: string; duration_s: number; warnings: string[]; scenario_changed?: boolean }> {
  const { project, planned, overrides, scenario_changed } = await planRenderRequest(ctx.ws, ctx.cli, req);
  const ed = await editor();
  const timelineSha = sha256Hex(await readFile(join(planned.run.dir, 'timeline.json')));
  const scenario = planned.timeline.scenario;
  const dir = ed.rendersDir(project);
  await mkdir(dir, { recursive: true });
  const { version, release } = await ed.reserveVersion(dir, scenario, `submitted by ${ctx.client} (pid ${process.pid})`);
  const renderId = `${scenario}-v${version}${ed.VARIANT_SUFFIX[planned.plan.variant]}`;
  const input: RenderJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'render',
    project: project.slug,
    scenario,
    run_id: planned.run.id,
    timeline_sha256: timelineSha,
    render_id: renderId,
    ...(req.template !== undefined ? { template: req.template } : {}),
    overrides,
    submitted_by: ctx.client,
  };
  let job: JobRecord;
  try {
    job = await ctx.queue.enqueue(input);
  } catch (e) {
    // Nothing will render it: the id is free again.
    await release();
    throw e;
  }
  const plan = planned.plan;
  return {
    job,
    render_id: renderId,
    run_id: planned.run.id,
    variant: plan.variant,
    duration_s: Math.round((plan.durationInFrames / plan.fps) * 1000) / 1000,
    warnings: plan.warnings,
    ...(scenario_changed !== undefined ? { scenario_changed } : {}),
  };
}

/** Remove the version lock a render job reserved (a cancel before it started, an early failure). */
export async function releaseRenderLock(ws: WorkspaceConfig, input: Pick<RenderJobInput, 'project' | 'scenario' | 'render_id'>): Promise<void> {
  const project = await openProjectBySlug(ws, input.project);
  const ed = await editor();
  const { version } = parseRenderId(input.render_id, input.scenario);
  await rm(ed.versionLockFile(ed.rendersDir(project), input.scenario, version), { force: true });
}

/** A render browser recorded by a job: its process identity and its temporary profile folder. */
export interface RecordedBrowser extends ProcessIdentity {
  user_data_dir?: string;
}

/** A temporary Chromium profile Remotion created (the only folder this cleanup removes). */
function isTempProfile(dir: string): boolean {
  return dirname(dir) === tmpdir().replace(/\/$/, '') && /^puppeteer_dev_chrome_profile-[A-Za-z0-9]+$/.test(basename(dir));
}

/**
 * After a render job was interrupted (its worker killed): kill the render browser it recorded when it still runs (same
 * pid AND start time: Remotion starts it detached, so it outlives its parent), remove its temporary profile, the
 * version lock and the partial video files. Best effort: what fails is logged.
 */
export async function cleanupInterruptedRender(ws: WorkspaceConfig, queue: FileJobQueue, job: JobRecord, log: (m: string) => void): Promise<void> {
  if (job.input.kind !== 'render') return;
  const input = job.input;
  await killRecordedBrowser(queue, job, log);
  try {
    await releaseRenderLock(ws, input);
    const project = await openProjectBySlug(ws, input.project);
    await removePartials(join(project.dir, 'renders'), `.${input.render_id}.partial-`);
  } catch (e) {
    log(`job ${job.id}: render leftovers not removed (${(e as Error).message})`);
  }
}

/** Remove the files of `dir` whose name starts with `prefix` (partial videos of a killed render). */
export async function removePartials(dir: string, prefix: string): Promise<void> {
  for (const f of await readdir(dir).catch(() => [] as string[])) if (f.startsWith(prefix)) await rm(join(dir, f), { force: true });
}

/**
 * The render browser a job recorded (job folder, browser.json) and left running when its worker was killed: killed when
 * it still runs as the same process (pid AND start time), and its temporary profile removed. Best effort.
 */
export async function killRecordedBrowser(queue: FileJobQueue, job: JobRecord, log: (m: string) => void): Promise<void> {
  let browser: RecordedBrowser | undefined;
  try {
    browser = JSON.parse(await readFile(queue.browserFile(job.id), 'utf8')) as RecordedBrowser;
  } catch {
    browser = undefined;
  }
  if (browser && Number.isInteger(browser.pid) && browser.pid > 1 && browser.started_at && (await isAlive(browser))) {
    for (const target of [-browser.pid, browser.pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* gone, or not a group */
      }
    }
    log(`job ${job.id}: killed the render browser it left (pid ${browser.pid})`);
  }
  if (browser?.user_data_dir && isTempProfile(browser.user_data_dir)) await rm(browser.user_data_dir, { recursive: true, force: true }).catch(() => undefined);
}

export interface RenderJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: RenderJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  /** The render browser runs: the worker records it (job folder, browser.json). */
  browser(b: BrowserProcessInfo): void;
}

/** Execute a `render` job: the timeline check, then `renderVideo` (trust `mcp`, network guard) with the reserved id. */
export async function executeRenderJob(ctx: RenderJobContext): Promise<RenderJobResult> {
  const { input } = ctx;
  const ed = await editor();
  const project = await openProjectBySlug(ctx.ws, input.project);
  const { version, variant } = parseRenderId(input.render_id, input.scenario);
  try {
    const sha = sha256Hex(await readFile(join(project.dir, 'runs', input.run_id, 'timeline.json')));
    if (sha !== input.timeline_sha256) {
      throw new EngineError('conflict', `the timeline of run ${input.run_id} changed since the render was submitted: submit it again`, { details: { submitted: input.timeline_sha256, current: sha } });
    }
  } catch (e) {
    await releaseRenderLock(ctx.ws, input).catch(() => undefined);
    throw e;
  }
  let last = '';
  const record = await ed.renderVideo({
    project,
    run: input.run_id,
    scenario: input.scenario,
    ...(input.template !== undefined ? { template: input.template } : {}),
    overrides: input.overrides as EditOverrides,
    root: ctx.ws.root,
    trust: 'mcp',
    network: 'guard',
    signal: ctx.signal,
    reserved: { scenario: input.scenario, version, variant },
    onBrowser: (b) => ctx.browser(b),
    onProgress: (p: RenderProgress) => {
      const key = `${p.stage}:${p.renderedFrames ?? ''}:${Math.round(p.overall * 100)}`;
      if (key === last) return;
      last = key;
      ctx.progress({
        steps_done: p.renderedFrames ?? 0,
        steps_total: p.totalFrames ?? 0,
        phase: p.stage,
        fraction: Math.round(p.overall * 1000) / 1000,
        ...(p.eta_s !== undefined ? { eta_s: p.eta_s } : {}),
        updated_at: new Date().toISOString(),
      });
    },
  });
  return {
    kind: 'render',
    render_id: record.id,
    scenario: record.scenario,
    run_id: record.run_id,
    file: record.file,
    record: record.record,
    template: record.template,
    variant: record.variant,
    duration_s: record.duration_s,
    frames: record.frames,
    width: record.width,
    height: record.height,
    size_bytes: record.size_bytes,
    bundle_cached: record.bundle.cached,
    untrusted: { warnings: record.warnings },
  };
}
