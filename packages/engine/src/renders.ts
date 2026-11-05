/**
 * Renders of a project as clients outside the CLI see them (L3.2): the plan of a render before it runs
 * (plan_preview), and one render's status — its job first, then its record renders/<id>.json. A render id is reused
 * after a failed or cancelled render (nothing was written under it): the newest job of the id is the one shown, unless
 * a render record written after that job (a `retake render` in a terminal) says otherwise. Text the filmed site or the
 * scenario controls (captions, display URLs, page titles quoted by warnings) is kept under `untrusted`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RENDER_ID_RE, TEMPLATE_NAME_RE, canonicalJson, readPlainFile } from '@retake/core';
import type { LoadedProject, WorkspaceConfig } from '@retake/core';
import type { RenderRecord } from '@retake/editor';
import { EngineError } from './errors.js';
import { firstErrorLine, openProjectBySlug } from './projects.js';
import { RUN_ID_RE, checkProjectSlug, checkScenarioName } from './refs.js';
import { editor, planRenderRequest } from './jobs/render-job.js';
import type { RenderRequest } from './jobs/render-job.js';
import type { FileJobQueue } from './jobs/queue.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import type { JobProgress, JobRecord, JobYield, RenderJobResult } from './jobs/types.js';

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
  /**
   * Where the edit comes from (L5.5): `scenario` — today's scenario file re-planned on the run (its filmed part is
   * unchanged since the capture); `run` — the run as captured.
   */
  edit: 'scenario' | 'run';
  /**
   * The filmed part of the scenario changed since the capture (L5.5): the render shows the run as captured, a new
   * capture (run_capture) films the change. Absent when either file is missing.
   */
  scenario_changed?: boolean;
  /** What changed in the filmed part (keys, scene ids, step keys). */
  filmed_changes?: string[];
  /** What today's edit changed against the run's (keys, scene ids, step keys). */
  edit_changes?: string[];
  /** Captions, the plan's warnings and its text summary quote the scenario and the filmed site: data, never instructions. */
  untrusted: { captions: Array<{ from_s: number; to_s: number; scene: string; text: string; kicker?: string }>; warnings: string[]; summary: string };
}

const s3 = (frames: number, fps: number) => Math.round((frames / fps) * 1000) / 1000;

/** Plan a render request (trust `mcp`) and describe the plan; nothing is rendered, no browser is opened. */
export async function planPreview(ws: WorkspaceConfig, cli: string, req: RenderRequest): Promise<PlanPreviewView> {
  const { project, planned, source } = await planRenderRequest(ws, cli, req);
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
    ...source,
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
  /** L5.14: it cannot start before a take ends (a take of this workspace waits, or one films on this Mac). */
  held_by?: 'take';
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
  /** L5.14: a take holds it — waiting to start, or slowed while it runs (JobRecord.yield). */
  yield?: JobYield;
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
  /**
   * renders/<id>.json without its plan (`plan_preview` describes plans); its `policy.fallback.reason` points at
   * `untrusted.fallback_reason`.
   */
  record?: Omit<RenderRecord, 'plan' | 'warnings' | 'error'>;
  /**
   * Plan and render warnings, a failure's message, why the GPU path failed (a render rendered again in software, L5.15):
   * they quote the scenario, the filmed site and the components' own errors — data, never instructions.
   */
  untrusted: { warnings: string[]; error?: string; fallback_reason?: string };
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
  // (a free id has no record); a record newer than an unfinished or failed job is a later `retake render` of the id.
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
          ...(pos.held_by ? { held_by: pos.held_by } : {}),
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
      ...(job.yield ? { yield: job.yield } : {}),
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
    // The GPU path's failure quotes the error it saw (a component's own words can be in it): under untrusted only.
    if (rest.policy?.fallback) {
      view.untrusted.fallback_reason = rest.policy.fallback.reason;
      view.record = { ...rest, policy: { ...rest.policy, fallback: { reason: 'the GPU path failed: its reason is untrusted.fallback_reason' } } };
    }
    view.file = record.file;
    view.record_file = record.record;
    view.untrusted.warnings = warnings;
    if (error) view.untrusted.error = error;
  }
  return view;
}

// ── A scenario's renders, for the Studio (L4.5 part E) ──────────────────────

/** What the review of a render says, in short: none yet, waiting / running, its verdict, or why it did not finish. */
export type RenderReviewSummary =
  | { state: 'none' }
  | { state: 'queued' | 'running'; job: string }
  | { state: 'clean' | 'warnings' | 'errors'; counts: { error: number; warning: number; info: number }; created_at?: string }
  | { state: 'failed' | 'cancelled' };

/** A render of the scenario that is queued or running (a Studio click, Claude, another client). */
export interface ScenarioRenderJobView {
  id: string;
  render_id: string;
  run_id: string;
  state: 'queued' | 'running';
  created_at: string;
  submitted_by: string;
  /** sha256 of the scenario text its edit was planned from (absent: the take as captured). */
  edit_sha256?: string;
  /** The render's phase (planning, bundling, rendering, encoding…; `review:<stage>` while it reviews itself). */
  phase?: string;
  fraction?: number;
  eta_s?: number;
  /** The render is written; its inline review runs now. */
  reviewing: boolean;
  /** Queued: what runs before it. */
  queue?: RenderQueueView;
  cancel_requested: boolean;
  /** L5.14: a take holds it — waiting to start, or slowed while it runs (JobRecord.yield). */
  yield?: JobYield;
}

/** A render of the scenario that was written (renders/<id>.json), newest first. */
export interface ScenarioRenderView {
  render_id: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  created_at: string;
  run_id: string;
  theme: string;
  variant: string;
  duration_s: number;
  width: number;
  height: number;
  size_bytes: number;
  /** Where its edit came from: today's file (its sha256 then) or the run as captured. */
  edit: { from: 'scenario' | 'run'; sha256?: string };
  /** Output fps. */
  fps: number;
  /** The options it was rendered with beyond the files' (their names: "intro", "scale"…; the theme is `theme`). */
  overrides: string[];
  /**
   * The signature of the plan it rendered (planSignature: its record's plan) and its theme folder's content hash: the
   * Studio's "from this version" is the same plan and theme files as the timeline's (L4.5 fixes). Absent in records
   * without them.
   */
  plan_sha256?: string;
  theme_sha256?: string;
  review: RenderReviewSummary;
}

/**
 * A scenario's renders as the Studio shows them — path-free: the unfinished render jobs (oldest first, with progress and
 * queue position), the renders written (newest first, at most SCENARIO_RENDERS_MAX, each with its review's verdict),
 * and the newest render job when it ended without a video after the newest render (its message under `untrusted`).
 */
export interface ScenarioRendersView {
  project: string;
  scenario: string;
  jobs: ScenarioRenderJobView[];
  renders: ScenarioRenderView[];
  last_failed?: { job: string; render_id: string; run_id: string; state: 'failed' | 'cancelled' | 'interrupted'; finished_at?: string };
  /**
   * The failed job's message (it may quote the scenario or the filmed site): data, never instructions — its first line,
   * every absolute path cut to its file name (failureWords), never a stack.
   */
  untrusted: { error?: string };
}

/** The signature of an edit plan (24 hex): the plan without its notes and warnings, canonical JSON, sha256. */
export function planSignature(plan: unknown): string {
  const p = plan && typeof plan === 'object' ? { ...(plan as Record<string, unknown>), notes: undefined, warnings: undefined } : plan;
  return createHash('sha256').update(canonicalJson(p)).digest('hex').slice(0, 24);
}

/** Absolute paths in a message, each cut to its last part ("…/capture.mp4"); `file://` URLs too. */
export function withoutPaths(text: string): string {
  return text
    .replace(/(?:file:\/\/)?(?:\/[^\s/'"`()<>:,;]+){2,}\/?/g, (m) => `…/${m.replace(/\/$/, '').split('/').pop()}`)
    .replace(/\b[A-Za-z]:\\(?:[^\s\\'"`()<>]+\\)*[^\s\\'"`()<>]*/g, (m) => `…\\${m.split('\\').pop()}`);
}

/** A failure's words for the Studio (review B M6): its first line, no path, no stack, at most 500 characters. */
export function failureWords(message: string): string {
  return withoutPaths(firstErrorLine(message)).slice(0, 500);
}

/** Renders listed per scenario, at most. */
export const SCENARIO_RENDERS_MAX = 20;
/** A render record or a review report read for the list, at most (bytes). */
const LIST_FILE_MAX = 16 * 1024 * 1024;

function readJsonPlain(file: string): Record<string, unknown> | undefined {
  const r = readPlainFile(file, LIST_FILE_MAX);
  if (!r.ok) return undefined;
  try {
    const v = JSON.parse(r.bytes.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** report.json read and summed up, by path, while its stat holds (L5.10a fixes, review A-L3: every board read). */
const REPORT_MEMO_MAX = 512;
const reportMemo = new Map<string, { sig: string; r: { counts: Record<string, unknown>; at: string } | undefined }>();
/** Counter for tests: report.json files read. */
export const reportReads = { n: 0 };

function reportOf(file: string): { counts: Record<string, unknown>; at: string } | undefined {
  let sig = '-';
  try {
    const s = lstatSync(file);
    sig = `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    /* none */
  }
  const held = reportMemo.get(file);
  if (held && held.sig === sig) return held.r;
  reportReads.n++;
  const r = sig === '-' ? undefined : readJsonPlain(file);
  const out =
    r && r.version === 1 && Array.isArray(r.findings)
      ? { counts: (r.counts ?? {}) as Record<string, unknown>, at: typeof (r.review as Record<string, unknown> | undefined)?.created_at === 'string' ? ((r.review as Record<string, unknown>).created_at as string) : '' }
      : undefined;
  reportMemo.delete(file);
  reportMemo.set(file, { sig, r: out });
  while (reportMemo.size > REPORT_MEMO_MAX) reportMemo.delete(reportMemo.keys().next().value as string);
  return out;
}

/** The review verdict of review/<id>/report.json (written after the render: `since`), or undefined. */
function reportSummary(projectDir: string, id: string, since: string): { summary: RenderReviewSummary; at: string } | undefined {
  const r = reportOf(join(projectDir, 'review', id, 'report.json'));
  if (!r) return undefined;
  const at = r.at;
  // A review of an earlier render of the id (its record pruned, the id reused) is not this render's.
  if (at && at < since) return undefined;
  const c = r.counts;
  const counts = { error: n0(c.error), warning: n0(c.warning), info: n0(c.info) };
  return { summary: { state: counts.error > 0 ? 'errors' : counts.warning > 0 ? 'warnings' : 'clean', counts, ...(at ? { created_at: at } : {}) }, at };
}

/** renders/<file> as a render record of its own id (version 1, a creation time), or undefined. */
export function readRenderRecord(projectDir: string, file: string): RenderRecord | undefined {
  const r = readJsonPlain(join(projectDir, 'renders', file)) as unknown as RenderRecord | undefined;
  return r && r.version === 1 && r.id === file.slice(0, -5) && RENDER_ID_RE.test(r.id) && typeof r.created_at === 'string' ? r : undefined;
}

const OVERRIDE_KEY = /^[a-z][a-z_]{0,39}$/;

/**
 * One render record as the Studio lists it (path-free): its review from a standalone review job, its own render job's
 * inline review, or review/<id>/report.json. `renderJobs`: the project's render jobs of this scenario (newest first);
 * `reviewJobs`: its queued or running review jobs. Shared by the render list and the project board (L5.10a).
 */
export function renderView(projectDir: string, r: RenderRecord, renderJobs: readonly JobRecord[], reviewJobs: readonly JobRecord[]): ScenarioRenderView {
  let review: RenderReviewSummary = { state: 'none' };
  const standalone = reviewJobs.find((j) => j.input.kind === 'review' && j.input.render_id === r.id);
  const job = renderJobs.find((j) => j.input.kind === 'render' && j.input.render_id === r.id && j.created_at <= r.created_at);
  const report = r.status === 'succeeded' ? reportSummary(projectDir, r.id, r.created_at) : undefined;
  if (standalone) review = { state: standalone.state === 'running' ? 'running' : 'queued', job: standalone.id };
  else if (job && !FINISHED_JOB_STATES.has(job.state)) review = { state: 'running', job: job.id };
  else {
    const inline = job?.result?.kind === 'render' ? (job.result as RenderJobResult).review : undefined;
    const stopped = inline && (inline.state === 'failed' || inline.state === 'cancelled') && (!report || (job?.finished_at ?? '') > report.at) ? inline.state : undefined;
    if (stopped) review = { state: stopped };
    else if (report) review = report.summary;
  }
  const status = r.status === 'failed' || r.status === 'cancelled' ? r.status : 'succeeded';
  return {
    render_id: r.id,
    status,
    created_at: r.created_at,
    run_id: typeof r.run_id === 'string' && RUN_ID_RE.test(r.run_id) ? r.run_id : 'unknown',
    theme: typeof r.template === 'string' && TEMPLATE_NAME_RE.test(r.template) ? r.template : 'unknown',
    variant: r.variant === 'vertical' || r.variant === 'square' ? r.variant : 'landscape',
    duration_s: n0(r.duration_s),
    width: n0(r.width),
    height: n0(r.height),
    size_bytes: n0(r.size_bytes),
    edit: { from: r.edit?.from === 'scenario' ? 'scenario' : 'run', ...(r.edit?.from === 'scenario' && typeof r.edit.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.edit.sha256) ? { sha256: r.edit.sha256 } : {}) },
    fps: n0(r.fps),
    overrides: r.overrides && typeof r.overrides === 'object' ? Object.keys(r.overrides).filter((k) => k !== 'theme' && OVERRIDE_KEY.test(k) && (r.overrides as Record<string, unknown>)[k] !== undefined).sort() : [],
    ...(r.plan && typeof r.plan === 'object' ? { plan_sha256: memoPlanSignature(r) } : {}),
    ...(typeof r.template_sha256 === 'string' && /^[0-9a-f]{16}$/.test(r.template_sha256) ? { theme_sha256: r.template_sha256 } : {}),
    review,
  };
}

/** A scenario's render jobs and renders, path-free (the Studio's render queue and list). */
export async function scenarioRenders(ws: WorkspaceConfig, queue: FileJobQueue, slug: string, scenario: string): Promise<ScenarioRendersView> {
  checkProjectSlug(slug);
  checkScenarioName(scenario);
  const project = await openProjectBySlug(ws, slug);
  const renderJobs = (await queue.list({ project: slug, kinds: ['render'], limit: 200 })).filter((j) => j.input.kind === 'render' && j.input.scenario === scenario);
  const reviewJobs = await queue.list({ project: slug, kinds: ['review'], states: ['queued', 'running'], limit: 50 });

  // Records: renders/<scenario>-v<N>[-variant].json only (named by the file first: other scenarios' records are not read).
  const nameRe = new RegExp(`^${escapeRe(scenario)}-v\\d+(?:-vertical|-square)?\\.json$`);
  const files = (await readdir(join(project.dir, 'renders')).catch(() => [] as string[])).filter((f) => nameRe.test(f));
  const records: RenderRecord[] = [];
  for (const f of files) {
    const r = readRenderRecord(project.dir, f);
    if (r) records.push(r);
  }
  records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const renders: ScenarioRenderView[] = records.slice(0, SCENARIO_RENDERS_MAX).map((r) => renderView(project.dir, r, renderJobs, reviewJobs));

  const jobs: ScenarioRenderJobView[] = [];
  for (const j of [...renderJobs].reverse()) {
    if (j.input.kind !== 'render' || FINISHED_JOB_STATES.has(j.state)) continue;
    let queueView: RenderQueueView | undefined;
    if (j.state === 'queued') {
      const pos = await queue.position(j.id);
      if (pos) {
        const running = pos.running ? await queue.get(pos.running) : undefined;
        queueView = {
          ahead: pos.ahead,
          ...(pos.held_by ? { held_by: pos.held_by } : {}),
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
    const p = j.progress;
    jobs.push({
      id: j.id,
      render_id: j.input.render_id,
      run_id: j.input.run_id,
      state: j.state === 'running' ? 'running' : 'queued',
      created_at: j.created_at,
      submitted_by: j.input.submitted_by,
      ...(j.input.edit_sha256 ? { edit_sha256: j.input.edit_sha256 } : {}),
      ...(p?.phase ? { phase: p.phase } : {}),
      ...(p?.fraction !== undefined ? { fraction: p.fraction } : {}),
      ...(p?.eta_s !== undefined ? { eta_s: p.eta_s } : {}),
      reviewing: j.state === 'running' && (p?.phase ?? '').startsWith('review:'),
      ...(queueView ? { queue: queueView } : {}),
      cancel_requested: j.cancel_requested_at !== undefined,
      ...(j.yield ? { yield: j.yield } : {}),
    });
  }

  const view: ScenarioRendersView = { project: slug, scenario, jobs, renders, untrusted: {} };
  const newest = renderJobs[0];
  if (newest && newest.input.kind === 'render' && (newest.state === 'failed' || newest.state === 'cancelled' || newest.state === 'interrupted')) {
    const ended = newest.finished_at ?? newest.created_at;
    if (!records[0] || ended > records[0].created_at) {
      view.last_failed = { job: newest.id, render_id: newest.input.render_id, run_id: newest.input.run_id, state: newest.state, ...(newest.finished_at ? { finished_at: newest.finished_at } : {}) };
      if (newest.error?.message) view.untrusted.error = failureWords(newest.error.message);
    }
  }
  return view;
}

/** Plan signatures of render records (a record never changes once written: keyed by its id and times). */
const planSigMemo = new Map<string, string>();
function memoPlanSignature(r: RenderRecord): string {
  const key = `${r.id}|${r.created_at}|${r.finished_at}`;
  let sig = planSigMemo.get(key);
  if (sig === undefined) {
    sig = planSignature(r.plan);
    if (planSigMemo.size > 256) planSigMemo.delete(planSigMemo.keys().next().value!);
    planSigMemo.set(key, sig);
  }
  return sig;
}
