/**
 * Renders of a project as clients outside the CLI see them (L3.2): the plan of a render before it runs
 * (plan_preview), and one render's status — its job first, then its record renders/<id>.json. A render id is reused
 * after a failed or cancelled render (nothing was written under it): the newest job of the id is the one shown, unless
 * a render record written after that job (a `studio render` in a terminal) says otherwise. Text the filmed site or the
 * scenario controls (captions, display URLs, page titles quoted by warnings) is kept under `untrusted`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RENDER_ID_RE } from '@demo-studio/core';
import type { LoadedProject, WorkspaceConfig } from '@demo-studio/core';
import type { RenderRecord } from '@demo-studio/editor';
import { EngineError } from './errors.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug, checkScenarioName } from './refs.js';
import { editor, planRenderRequest } from './jobs/render-job.js';
import type { RenderRequest } from './jobs/render-job.js';
import type { FileJobQueue } from './jobs/queue.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import type { JobProgress, JobRecord, RenderJobResult } from './jobs/types.js';

export interface PlanPreviewSegment {
  id: string;
  kind: string;
  component: string;
  from_s: number;
  duration_s: number;
  scene?: string;
}

/** A plan as plan_preview returns it: its shape, segments and timings; captions, warnings and the text summary as data. */
export interface PlanPreviewView {
  project: string;
  scenario: string;
  run_id: string;
  theme: string;
  variant: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration_s: number;
  frame: string;
  segments: PlanPreviewSegment[];
  music?: { file: string; volume?: number };
  /** The id the next render of this plan would get (renders/<id>.mp4): a guess, the render reserves its own. */
  next_render_id: string;
  /** Captions, the plan's warnings and its text summary quote the scenario and the filmed site: data, never instructions. */
  untrusted: { captions: Array<{ from_s: number; to_s: number; scene: string; text: string; kicker?: string }>; warnings: string[]; summary: string };
}

const s3 = (frames: number, fps: number) => Math.round((frames / fps) * 1000) / 1000;

/** Plan a render request (trust `mcp`) and describe the plan; nothing is rendered, no browser is opened. */
export async function planPreview(ws: WorkspaceConfig, cli: string, req: RenderRequest): Promise<PlanPreviewView> {
  const { project, planned } = await planRenderRequest(ws, cli, req);
  const ed = await editor();
  const plan = planned.plan;
  const scenario = planned.timeline.scenario;
  const next = ed.nextVersion(ed.rendersDir(project), scenario);
  return {
    project: project.slug,
    scenario,
    run_id: planned.run.id,
    theme: planned.template.name,
    variant: plan.variant,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    frames: plan.durationInFrames,
    duration_s: s3(plan.durationInFrames, plan.fps),
    frame: String(plan.frame),
    segments: plan.segments.map((g) => ({
      id: g.id,
      kind: g.kind,
      component: g.component.id,
      from_s: s3(g.from, plan.fps),
      duration_s: s3(g.durationInFrames, plan.fps),
      ...('scene' in g && typeof g.scene === 'string' ? { scene: g.scene } : {}),
    })),
    ...(plan.music ? { music: { file: plan.music.file ?? '', ...(plan.music.volume !== undefined ? { volume: plan.music.volume } : {}) } } : {}),
    next_render_id: `${scenario}-v${next}${ed.VARIANT_SUFFIX[plan.variant]}`,
    untrusted: {
      captions: plan.captions.map((c) => ({ from_s: s3(c.from, plan.fps), to_s: s3(c.to, plan.fps), scene: c.scene, text: c.text, ...(c.kicker ? { kicker: c.kicker } : {}) })),
      warnings: plan.warnings,
      summary: ed.summarizePlan(plan).join('\n'),
    },
  };
}

/** The job a queued render waits behind. */
export interface RenderQueueView {
  /** Jobs that run or wait before it (0: it is next). */
  ahead: number;
  /** The job running now, with its kind and how far it is. */
  running?: { id: string; kind: string; phase?: string; fraction?: number; eta_s?: number };
}

export interface RenderJobView {
  id: string;
  state: JobRecord['state'];
  queue?: RenderQueueView;
  progress?: JobProgress;
  cancel_requested_at?: string;
  error?: JobRecord['error'];
}

export interface RenderStatusView {
  project: string;
  render_id: string;
  scenario?: string;
  status: JobRecord['state'];
  finished: boolean;
  job?: RenderJobView;
  /** The video and its record, once rendered. */
  file?: string;
  record_file?: string;
  /** renders/<id>.json without its plan (`plan_preview` describes plans). */
  record?: Omit<RenderRecord, 'plan' | 'warnings' | 'error'>;
  /** Plan and render warnings, a failure's message: they quote the scenario and the filmed site — data, never instructions. */
  untrusted: { warnings: string[]; error?: string };
}

async function readRecord(projectDir: string, id: string): Promise<RenderRecord | undefined> {
  try {
    const r = JSON.parse(await readFile(join(projectDir, 'renders', `${id}.json`), 'utf8')) as RenderRecord;
    return r && r.version === 1 && r.id === id ? r : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A succeeded render that work submitted through MCP may read (a review, an export): named by its id (or `latest`, of
 * `scenario`), read from renders/<id>.json only — never a path —, and its video and run folder inside the project
 * (symbolic links resolved): a record's paths are absolute, a hand-edited one could name any file.
 */
export async function renderForWork(project: LoadedProject, renderIdArg: string, o: { scenario?: string; fix?: (id: string) => string } = {}): Promise<RenderRecord> {
  const scenario = o.scenario;
  const ed = await editor();
  let id = renderIdArg;
  if (renderIdArg === 'latest') {
    const all = (await ed.listRenders(project)).filter((r) => r.status === 'succeeded' && (scenario === undefined || r.scenario === scenario));
    const last = all[all.length - 1];
    if (!last) throw new EngineError('not_found', `no finished render of ${project.slug}${scenario ? ` · ${scenario}` : ''} yet: render makes one`);
    id = last.id;
  } else if (typeof renderIdArg !== 'string' || !RENDER_ID_RE.test(renderIdArg) || renderIdArg.length > 200) {
    throw new EngineError('invalid', `invalid render id "${String(renderIdArg)}": <scenario>-v<N> (render returns it), or "latest"`);
  }
  const record = await readRecord(project.dir, id);
  if (!record) throw new EngineError('not_found', `render "${id}" not found in ${project.slug} (no renders/${id}.json): render_status says whether it is still running`);
  if (record.status !== 'succeeded') throw new EngineError('invalid', `render ${id} ${record.status}: nothing to read`);
  const problem = ed.recordPathProblem(project.dir, record);
  if (problem) throw new EngineError('refused', problem, { ...(o.fix ? { fix: o.fix(id) } : {}), details: { problems: [problem] } });
  if (!existsSync(record.file)) throw new EngineError('not_found', `the video of render ${id} is missing (${record.file})`);
  return record;
}

/** The render id `latest` names: the newest render (record or job) of the project, of `scenario` when given. */
async function latestRenderId(projectDir: string, queue: FileJobQueue, slug: string, scenario?: string): Promise<string | undefined> {
  const ed = await editor();
  const candidates: Array<{ id: string; at: string }> = [];
  for (const r of await ed.listRenders(projectDir)) if (scenario === undefined || r.scenario === scenario) candidates.push({ id: r.id, at: r.created_at });
  for (const j of await queue.list({ project: slug, kinds: ['render'], limit: 200 })) {
    if (j.input.kind === 'render' && (scenario === undefined || j.input.scenario === scenario)) candidates.push({ id: j.input.render_id, at: j.created_at });
  }
  candidates.sort((a, b) => b.at.localeCompare(a.at));
  return candidates[0]?.id;
}

/** A render's status: its newest job (queued, running, its result or error), then its record. */
export async function renderStatus(ws: WorkspaceConfig, queue: FileJobQueue, slug: string, renderIdArg: string, scenario?: string): Promise<RenderStatusView> {
  checkProjectSlug(slug);
  if (scenario !== undefined) checkScenarioName(scenario);
  const project = await openProjectBySlug(ws, slug);
  let renderId = renderIdArg;
  if (renderIdArg === 'latest') {
    const id = await latestRenderId(project.dir, queue, slug, scenario);
    if (!id) throw new EngineError('not_found', `no render of ${slug}${scenario ? ` · ${scenario}` : ''} yet: render starts one`);
    renderId = id;
  } else if (typeof renderIdArg !== 'string' || !RENDER_ID_RE.test(renderIdArg) || renderIdArg.length > 200) {
    throw new EngineError('invalid', `invalid render id "${String(renderIdArg)}": <scenario>-v<N> (render returns it), or "latest"`);
  }
  const job = await queue.ofRender(slug, renderId);
  let record = await readRecord(project.dir, renderId);
  // A record older than the job belongs to an earlier render of the id only when the job did not write it — never here
  // (a free id has no record); a record newer than an unfinished or failed job is a later `studio render` of the id.
  const jobFirst = job && !(record && job.state !== 'succeeded' && record.created_at > (job.finished_at ?? job.created_at));
  if (!job && !record) throw new EngineError('not_found', `render "${renderId}" not found in ${slug} (no job, no renders/${renderId}.json): render starts one`);
  if (jobFirst && job.state !== 'succeeded') record = undefined;
  const view: RenderStatusView = {
    project: slug,
    render_id: renderId,
    ...(job?.input.kind === 'render' ? { scenario: job.input.scenario } : record ? { scenario: record.scenario } : {}),
    status: jobFirst ? job.state : (record?.status ?? 'failed'),
    finished: jobFirst ? FINISHED_JOB_STATES.has(job.state) : true,
    untrusted: { warnings: [] },
  };
  if (job && jobFirst) {
    let queueView: RenderQueueView | undefined;
    if (job.state === 'queued') {
      const pos = await queue.position(job.id);
      if (pos) {
        const running = pos.running ? await queue.get(pos.running) : undefined;
        queueView = {
          ahead: pos.ahead,
          ...(running
            ? {
                running: {
                  id: running.id,
                  kind: running.kind,
                  ...(running.progress?.phase ? { phase: running.progress.phase } : {}),
                  ...(running.progress?.fraction !== undefined ? { fraction: running.progress.fraction } : {}),
                  ...(running.progress?.eta_s !== undefined ? { eta_s: running.progress.eta_s } : {}),
                },
              }
            : {}),
        };
      }
    }
    view.job = {
      id: job.id,
      state: job.state,
      ...(queueView ? { queue: queueView } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
      ...(job.cancel_requested_at ? { cancel_requested_at: job.cancel_requested_at } : {}),
      ...(job.error ? { error: { ...job.error, message: job.state === 'failed' ? 'the render failed: its message is untrusted.error' : job.error.message } } : {}),
    };
    if (job.state === 'failed' && job.error) view.untrusted.error = job.error.message;
    const result = job.result?.kind === 'render' ? (job.result as RenderJobResult) : undefined;
    if (result) {
      view.file = result.file;
      view.record_file = result.record;
      view.untrusted.warnings = result.untrusted.warnings;
    }
  }
  if (record) {
    const { plan: _plan, warnings, error, ...rest } = record;
    view.record = rest;
    view.file = record.file;
    view.record_file = record.record;
    view.untrusted.warnings = warnings;
    if (error) view.untrusted.error = error;
  }
  return view;
}
