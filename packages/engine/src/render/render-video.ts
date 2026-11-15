/**
 * The render use case: a run planned (the editor's planRun), its version reserved in the project's renders folder, the
 * plan drawn by the renderer the caller hands (the port of renderer.ts), and the render record written beside the
 * video — renders/<scenario>-v<N>.mp4 (+ "-vertical" / "-square" for those variants) and renders/<scenario>-v<N>.json.
 * N is the next free version (versions.ts). The folder, the lock and the record go through the renders member of the
 * Outputs port; the renderer writes the video at the path it is handed. Nothing is written under the final names when
 * the render fails or is cancelled: the attempt rides on the error (the editor's RenderError / RenderCancelledError,
 * what a shell and a client have always been told).
 */
import { basename, extname, join, resolve } from 'node:path';
import { errorKindOf, errorMessage } from '@retake/core/base';
import { formatRenderId } from '@retake/core/ids';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedTemplate } from '@retake/core/theme';
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import { finishedRender, renderAttempt } from '@retake/core/render';
import type { RenderFields } from '@retake/core/render';
import type { ComponentRegistry } from '@retake/components/geometry';
import { RENDER_ENCODING, audioOf, sceneCaptions, themeContentHash } from '@retake/editor/plan';
import type { EditOverrides, EditPlan, PlanTrust, PlanVariant, RenderAttempt, RenderProgress, RenderRecord } from '@retake/editor/plan';
import type { Clock } from '../clock.js';
import { stampOf } from '../clock.js';
import type { RenderOutputs } from '../outputs/outputs.js';
import type { WorkspaceReads } from '../workspace-reads/reads.js';
import { NODE_THEME_FILES } from '../theme-files.js';
import { planWork, plannedConcurrency, renderErrors } from './editor-calls.js';
import type { PlannedRun } from './editor-calls.js';
import type { RenderProcess, Renderer } from './renderer.js';
import { reserveVersion, versionLockFile } from './versions.js';

export interface RenderVideoOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
  /** The project, loaded by the caller (the engine's workspace reads). */
  project: LoadedProject;
  /** Run id, run directory, or "latest" (of `scenario` when given). */
  run: string;
  /** Scenario name: required to match the run's; picks the run with "latest". */
  scenario?: string;
  /** Theme to use instead of the one the run was captured with (name, ./path or a loaded template). */
  template?: string | LoadedTemplate;
  overrides?: EditOverrides;
  /** Explicit output .mp4 (default renders/<scenario>-v<N>[-vertical|-square].mp4 with the next free N). */
  out?: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
  concurrency?: number;
  /** Workspace root (default: the project's). */
  root?: string;
  registry?: ComponentRegistry;
  /** `mcp`: the plan passes planRun's trust gates first (work submitted through the MCP server). Default `author`. */
  trust?: PlanTrust;
  /** The render's network (default `open`; renders of the jobs worker: `guard`). */
  network?: 'open' | 'guard';
  /** Called once the render process runs. */
  onBrowser?: (b: RenderProcess) => void;
  /**
   * A version reserved before (a render job: `.<scenario>-v<N>.lock` taken at submit): the render writes
   * `<scenario>-v<N><suffix>` and removes the lock at the end, whatever happens. The plan must still be of that
   * scenario and variant (the id's suffix), else the render is refused.
   */
  reserved?: { scenario: string; version: number; variant: PlanVariant };
  /** Where the edit comes from (planRun `edit`): default `auto`. */
  edit?: 'auto' | 'run';
  /**
   * The sha256 of the scenario file the edit must come from (null: the run as captured), as planned before (a render
   * job at submit, an export of a master): a plan of another edit is refused. Undefined: no check.
   */
  editSha256?: string | null;
  /** The scenario text to plan the edit from instead of today's file (a render job's snapshot: planRun `editText`). */
  editText?: string;
  /** Render settings over the process's. */
  settings?: RenderSettings;
  /** What draws the plan (a composition root chose it). */
  renderer: Renderer;
  /**
   * Where the render goes and what it reads of the workspace: the renders of its outputs (the Outputs port: the versions,
   * the lock and the record) and its reads (a theme folder's identity, the record's `template_folder`).
   */
  ws: RenderPlace;
  /** What the record is stamped with (created_at, finished_at). */
  clock: Clock;
}

/** The workspace a render is placed in (an OpenedWorkspace is one). */
export interface RenderPlace {
  outputs: { renders: RenderOutputs };
  reads: Pick<WorkspaceReads, 'templateFolderId'>;
}

/** Options of the editor's own driver: they say how a driver is made, so they mean nothing beside one already made. */
const OWN_DRIVER_OPTIONS = ['cacheDir', 'seams', 'backend'] as const;

/** The loaded project a render was handed: nothing loads a project here (a slug or a folder is refused). */
async function handedProject(project: unknown): Promise<LoadedProject> {
  if (typeof project !== 'object' || project === null || typeof (project as LoadedProject).dir !== 'string') {
    throw await renderErrors.render('no loaded project was handed (the caller loads the project; a slug or a folder is not read here)');
  }
  return project as LoadedProject;
}

/** The record's fields that are known before the renderer answers (every member but its status, error, policy and probe). */
interface RecordBase {
  id: string;
  project: LoadedProject;
  planned: PlannedRun;
  file: string;
  recordFile: string;
  version: number | undefined;
  templateSha256: string;
  concurrency: number;
  createdAt: string;
  planMs: number;
  templateFolder: string;
  clock: Clock;
}

function baseFields(b: RecordBase): RenderFields<EditPlan, EditOverrides> {
  const { run, timeline, template, overrides, plan, edit } = b.planned;
  return {
    version: 1,
    id: b.id,
    project: b.project.slug,
    scenario: timeline.scenario,
    run_id: timeline.run_id,
    run_dir: run.dir,
    template: template.name,
    template_sha256: b.templateSha256,
    template_folder: b.templateFolder,
    overrides,
    edit: {
      from: edit.from,
      ...(edit.sha256 ? { sha256: edit.sha256 } : {}),
      ...(edit.changes?.length ? { changes: edit.changes } : {}),
      ...(edit.from === 'scenario' ? { captions: sceneCaptions(timeline) } : {}),
    },
    variant: plan.variant,
    file: b.file,
    record: b.recordFile,
    ...(b.version !== undefined ? { render_version: b.version } : {}),
    created_at: b.createdAt,
    finished_at: stampOf(b.clock),
    duration_s: Math.round((plan.durationInFrames / plan.fps) * 1000) / 1000,
    frames: plan.durationInFrames,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    size_bytes: 0,
    encoding: { ...RENDER_ENCODING, faststart: true, audio: audioOf(plan) },
    concurrency: b.concurrency,
    bundle: { hash: '', cached: false, ms: 0 },
    browser: { path: null, source: 'none' },
    timings: { plan_ms: b.planMs, bundle_ms: 0, render_ms: 0, total_ms: 0 },
    warnings: [...plan.warnings],
    plan,
  };
}

/**
 * Plan and render a run on `o.renderer`: the record written (renders/<id>.json, two-space JSON and a final newline)
 * and returned. The renderer was checked by the caller (work.ts renderWork); a reserved version's lock is released at
 * the end whatever happens, and before that when the render is refused before it starts.
 */
export async function renderVideoWork(o: RenderVideoOptions): Promise<RenderRecord> {
  const t0 = performance.now();
  const createdAt = stampOf(o.clock);
  const emit = o.onProgress ?? (() => undefined);
  emit({ stage: 'planning', progress: 0, overall: 0 });
  const project = await handedProject(o.project);
  const renders = o.ws.outputs.renders;
  const dir = renders.dirOf(project.dir);
  // A version reserved by someone else (a render job: its lock was taken at submit) is released here, whatever happens.
  // A version no reservation hands out (core renderLockName) has no lock: nothing is planned or rendered under it.
  let reservedLock: string | undefined;
  if (o.reserved) {
    try {
      reservedLock = versionLockFile(dir, o.reserved.scenario, o.reserved.version);
    } catch (e) {
      throw await renderErrors.render(`the reserved render version of ${o.reserved.scenario} cannot be used: ${errorMessage(e)}`);
    }
  }
  const lock = reservedLock;
  const reservedRelease = () => (lock ? renders.remove(lock) : Promise.resolve());
  let planned: PlannedRun;
  try {
    // Before any work: the options of the editor's own driver are refused beside the renderer (they would be ignored).
    const own = OWN_DRIVER_OPTIONS.filter((k) => (o as unknown as Record<string, unknown>)[k] !== undefined);
    if (own.length > 0) {
      throw await renderErrors.render(`render: ${own.join(', ')} ${own.length > 1 ? 'are options' : 'is an option'} of the editor's own renderer and cannot go with a renderer that is handed`);
    }
    planned = await planWork({
      workPolicy: o.workPolicy,
      project,
      run: o.run,
      ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
      ...(o.template !== undefined ? { template: o.template } : {}),
      ...(o.overrides ? { overrides: o.overrides } : {}),
      ...(o.root !== undefined ? { root: o.root } : {}),
      ...(o.registry ? { registry: o.registry } : {}),
      ...(o.trust ? { trust: o.trust } : {}),
      ...(o.edit ? { edit: o.edit } : {}),
      ...(o.editText !== undefined ? { editText: o.editText } : {}),
    });
    if (o.editSha256 !== undefined && (planned.edit.sha256 ?? null) !== o.editSha256) {
      throw await renderErrors.render(
        `the scenario ${planned.timeline.scenario} changed since this render was planned (its edit ${planned.edit.from === 'scenario' ? 'is now re-planned from another version of the file' : 'now comes from the run as captured'}): plan or submit the render again`,
      );
    }
    if (o.reserved && (planned.timeline.scenario !== o.reserved.scenario || planned.plan.variant !== o.reserved.variant)) {
      throw await renderErrors.render(
        `the plan changed since the render was submitted (now ${planned.timeline.scenario}, ${planned.plan.variant}; reserved ${o.reserved.scenario}, ${o.reserved.variant}): submit the render again`,
      );
    }
  } catch (e) {
    await reservedRelease();
    throw e;
  }
  const { root, timeline, template, registry, plan } = planned;
  const planMs = Math.round(performance.now() - t0);
  emit({ stage: 'planning', progress: 1, overall: 0 });

  // Where the files go: the reserved version, the caller's --out, or the next free version of renders/.
  const scenario = timeline.scenario;
  let file: string;
  let version: number | undefined;
  // What the record says of the theme and the work, read before a version is reserved: nothing between the reserve and
  // the try below may throw and leave that version locked.
  const templateSha256 = themeContentHash(template.dir, NODE_THEME_FILES);
  const concurrency = await plannedConcurrency(o.workPolicy, o.settings, o.concurrency);
  const templateFolder = o.ws.reads.templateFolderId(template.dir, project.root);
  let release: () => Promise<void> = async () => undefined;
  if (o.reserved) {
    version = o.reserved.version;
    release = reservedRelease;
    file = join(dir, `${formatRenderId(scenario, version, plan.variant)}.mp4`);
  } else if (o.out) {
    file = resolve(o.out);
    if (extname(file).toLowerCase() !== '.mp4') throw await renderErrors.render(`--out must name an .mp4 file: ${file}`);
  } else {
    const r = await reserveVersion(renders, dir, scenario);
    version = r.version;
    release = r.release;
    file = join(dir, `${formatRenderId(scenario, version, plan.variant)}.mp4`);
  }
  const recordFile = file.replace(/\.mp4$/i, '.json');
  const base: RecordBase = {
    id: basename(file, extname(file)),
    project,
    planned,
    file,
    recordFile,
    version,
    templateSha256,
    concurrency,
    createdAt,
    planMs,
    templateFolder,
    clock: o.clock,
  };
  try {
    const res = await o.renderer.video({
      workPolicy: o.workPolicy,
      plan,
      out: file,
      root,
      registry,
      concurrency: o.concurrency,
      signal: o.signal,
      onProgress: emit,
      ...(o.network ? { network: o.network } : {}),
      ...(o.onBrowser ? { onProcess: o.onBrowser } : {}),
      ...(o.settings ? { settings: o.settings } : {}),
    });
    const fields = baseFields(base);
    fields.size_bytes = res.size_bytes;
    fields.concurrency = res.concurrency;
    fields.encoding = { ...fields.encoding, ...res.encoding };
    fields.bundle = { hash: res.bundle.hash, cached: res.bundle.cached, ms: res.bundle.ms };
    fields.browser = { path: res.browser.path, source: res.browser.source };
    fields.warnings.push(...res.warnings);
    // The renderer's probe of the file it wrote (ffprobe for the editor's; a renderer that has none says nothing).
    const probe = res.probe;
    if (probe) {
      const expected = plan.durationInFrames / plan.fps;
      if (Math.abs(probe.duration_s - expected) > 1.5 / plan.fps) fields.warnings.push(`the file lasts ${probe.duration_s.toFixed(3)} s, the plan ${expected.toFixed(3)} s`);
    }
    fields.finished_at = stampOf(o.clock);
    fields.timings = { plan_ms: planMs, bundle_ms: res.bundle_ms, render_ms: res.render_ms, total_ms: Math.round(performance.now() - t0) };
    const record: RenderRecord = finishedRender(fields, { ...(res.renderPath ? { policy: res.renderPath } : {}), ...(probe ? { probe } : {}) });
    await renders.writeJson(recordFile, record);
    emit({ stage: 'done', progress: 1, overall: 1, totalFrames: plan.durationInFrames });
    return record;
  } catch (e) {
    // The renderer's failure, read by what it says (its kind, its fields), never by its class: another renderer's counts too.
    const cancelled = errorKindOf(e) === 'cancelled';
    const said = (e ?? {}) as { renderPath?: RenderRecord['policy']; renderWarnings?: unknown };
    const fields = baseFields(base);
    // The warnings so far.
    if (Array.isArray(said.renderWarnings)) fields.warnings.push(...said.renderWarnings.filter((w): w is string => typeof w === 'string'));
    fields.finished_at = stampOf(o.clock);
    fields.timings.total_ms = Math.round(performance.now() - t0);
    // What was tried (the GPU path, its fallback and why). Never written to a disk: it rides on the error.
    const record: RenderAttempt = renderAttempt(fields, {
      status: cancelled ? 'cancelled' : 'failed',
      error: errorMessage(e),
      ...(said.renderPath && typeof said.renderPath === 'object' ? { policy: said.renderPath } : {}),
    });
    if (cancelled) throw await renderErrors.cancelled(record);
    throw await renderErrors.render(errorMessage(e), record);
  } finally {
    await release();
  }
}
