/**
 * Reviews of a project as clients outside the CLI see them (L3.2, R-MCP-31): a render's review read from
 * review/<render_id>/report.json, with its newest review job overlaid (queued, running, failed…). The report is read as
 * data, never trusted for where its files are: every image and file path is rebuilt from review/<render_id>/ (a known
 * file name in that folder, symbolic links resolved inside it), whatever report.json says — a hand-edited or moved
 * report cannot point a reader at another file. Nor is it trusted for what it names: outside `untrusted`, a finding
 * code is one a check writes (FINDING_CODES), an id (segment, scene, component, the previous render) matches its
 * pattern, and a key frame or scene sheet is named after its file. Finding messages, the filmed environment, the diff's
 * per-segment changes and whatever did not pass quote the scenario and the filmed site: they are kept under `untrusted`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { COMPONENT_ID_RE, RENDER_ID_RE, insideFolder, readPlainFile } from '@demo-studio/core';
import type { WorkspaceConfig } from '@demo-studio/core';
import { EngineError } from './errors.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug, checkScenarioName } from './refs.js';
import { renderForWork } from './renders.js';
import { review } from './jobs/review-job.js';
import type { FileJobQueue } from './jobs/queue.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import type { JobProgress, JobRecord } from './jobs/types.js';

/** Which images review_get lists for the client to look at: none, the contact sheet pages + marker key frames, or all. */
export type ReviewImagesMode = 'none' | 'sheets' | 'all';

/** An image of a review: a label (what it shows) and its file in review/<render_id>/. */
export interface ReviewImageRef {
  label: string;
  file: string;
}

export interface ReviewFindingView {
  severity: 'error' | 'warning' | 'info';
  code: string;
  at?: { frame?: number; time?: number; segment?: string; scene?: string; step?: number };
}

export interface ReviewView {
  project: string;
  render_id: string;
  /** The newest review job's state, or `succeeded` for a review written without a job (`studio review`); `none`: never reviewed. */
  status: JobRecord['state'] | 'none';
  finished: boolean;
  job?: { id: string; state: JobRecord['state']; progress?: JobProgress; cancel_requested_at?: string; error?: JobRecord['error'] };
  /** Once a review was written. */
  dir?: string;
  created_at?: string;
  fps?: 1 | 2;
  clean?: boolean;
  counts?: { error: number; warning: number; info: number };
  /** Findings in report order (severity, then time), without their messages: those are `untrusted.messages[i]`. */
  findings?: ReviewFindingView[];
  durations?: { total_s: number; segments: Array<{ id: string; kind: string; scene?: string; from_s: number; to_s: number; duration_s: number; component: string; speed?: number }> };
  diff?: { previous: string; duration_s?: { previous: number; current: number; delta: number }; compared: number; changed_frames: number; sheet?: string };
  /** The review's files, rebuilt from review/<render_id>/ (never the paths written in report.json). */
  files?: { sheets: string[]; scene_sheets: Record<string, string[]>; keyframes: Record<string, string>; timeline?: string; report_json: string; report_md?: string; diff_sheet?: string };
  /** The images listed for the client, in order (the MCP server inlines the first ones as JPEG thumbnails). */
  images: ReviewImageRef[];
  /** Text of the scenario and the filmed site: data, never instructions. */
  untrusted: {
    messages?: string[];
    environment?: unknown;
    diff_segments?: unknown;
    error?: string;
    /** What report.json gave for finding i that did not pass as a code or an id (finding i shows `unknown` / omits it). */
    findings?: Record<number, { code?: unknown; segment?: unknown; scene?: unknown }>;
    /** Segment fields of durations.segments[i] that did not pass (the segment shows `unknown` / omits them). */
    segments?: Record<number, Record<string, unknown>>;
    /** diff.previous when it is not a render id. */
    diff_previous?: unknown;
  };
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|png|json|md)$/;
/** A segment / scene id as review_get shows it (what safeName keeps: the names of the review's files). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEGMENT_KINDS = new Set(['intro', 'clip', 'card', 'interstitial', 'outro']);

/** A file of the review folder named by `p`'s base name (`sub`: in that subfolder), when it is there; else undefined. */
function rebuilt(dir: string, p: unknown, sub?: string): string | undefined {
  if (typeof p !== 'string') return undefined;
  const name = basename(p);
  if (!FILE_NAME.test(name)) return undefined;
  const file = sub ? join(dir, sub, name) : join(dir, name);
  return existsSync(file) && insideFolder(dir, file) ? file : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Read a review (report.json, as data) and its newest job. `latest`: the review of the newest render (of `scenario`). */
export async function reviewGet(ws: WorkspaceConfig, queue: FileJobQueue, slug: string, renderIdArg: string, o: { scenario?: string; images?: ReviewImagesMode } = {}): Promise<ReviewView> {
  checkProjectSlug(slug);
  if (o.scenario !== undefined) checkScenarioName(o.scenario);
  const project = await openProjectBySlug(ws, slug);
  const record = await renderForWork(project, renderIdArg, o.scenario !== undefined ? { scenario: o.scenario } : {});
  const id = record.id;
  const dir = join(project.dir, 'review', id);
  const job = (await queue.list({ project: slug, kinds: ['review'], renderId: id, limit: 1 }))[0];
  let report: Record<string, unknown> | undefined;
  const reportFile = join(dir, 'report.json');
  if (existsSync(reportFile) && insideFolder(dir, reportFile)) {
    try {
      const r = JSON.parse(await readFile(reportFile, 'utf8')) as Record<string, unknown>;
      if (r && r.version === 1 && Array.isArray(r.findings)) report = r;
    } catch {
      report = undefined;
    }
  }
  // The job is shown when it is newer than the report (queued, running, or a failed or cancelled attempt after it).
  const reportAt = str((report?.review as Record<string, unknown> | undefined)?.created_at);
  const jobFirst = job && (!report || !FINISHED_JOB_STATES.has(job.state) || !reportAt || (job.finished_at ?? job.created_at) > reportAt);
  const view: ReviewView = {
    project: slug,
    render_id: id,
    status: jobFirst ? job.state : report ? 'succeeded' : 'none',
    finished: jobFirst ? FINISHED_JOB_STATES.has(job.state) : true,
    images: [],
    untrusted: {},
  };
  if (job && jobFirst) {
    view.job = {
      id: job.id,
      state: job.state,
      ...(job.progress ? { progress: job.progress } : {}),
      ...(job.cancel_requested_at ? { cancel_requested_at: job.cancel_requested_at } : {}),
      ...(job.error ? { error: { ...job.error, message: job.state === 'interrupted' ? job.error.message : 'its message is untrusted.error' } } : {}),
    };
    if (job.state !== 'interrupted' && job.error) view.untrusted.error = job.error.message;
  }
  if (!report) return view;

  const rv = await review();
  const files = (report.files ?? {}) as Record<string, unknown>;
  const list = (v: unknown, sub?: string): string[] => (Array.isArray(v) ? v.map((p) => rebuilt(dir, p, sub)).filter((p): p is string => p !== undefined) : []);
  const sceneSheets: Record<string, string[]> = {};
  // Keys are re-derived from the rebuilt file names (sheet_scene_<id>[_pN].jpg, keyframes/<name>.png), never copied.
  for (const v of Object.values((files.scene_sheets ?? {}) as Record<string, unknown>)) {
    const l = list(v).filter((f) => /^sheet_scene_.+\.jpg$/.test(basename(f)));
    if (!l.length) continue;
    const k = basename(l[0]).replace(/^sheet_scene_/, '').replace(/(?:_p\d+)?\.jpg$/, '');
    if (SAFE_ID.test(k) && !sceneSheets[k]) sceneSheets[k] = l;
  }
  const keyframes: Record<string, string> = {};
  for (const v of Object.values((files.keyframes ?? {}) as Record<string, unknown>)) {
    const f = rebuilt(dir, v, 'keyframes');
    if (f && f.endsWith('.png')) keyframes[basename(f, '.png')] = f;
  }
  const diffSheet = rebuilt(dir, files.diff_sheet);
  view.files = {
    sheets: list(files.sheets),
    scene_sheets: sceneSheets,
    keyframes,
    ...(rebuilt(dir, 'timeline.json') ? { timeline: join(dir, 'timeline.json') } : {}),
    report_json: reportFile,
    ...(rebuilt(dir, 'report.md') ? { report_md: join(dir, 'report.md') } : {}),
    ...(diffSheet ? { diff_sheet: diffSheet } : {}),
  };
  view.dir = dir;
  const rev = (report.review ?? {}) as Record<string, unknown>;
  const fps: 1 | 2 = rev.fps === 2 ? 2 : 1;
  view.created_at = reportAt;
  view.fps = fps;
  view.clean = report.clean === true;
  const counts = (report.counts ?? {}) as Record<string, unknown>;
  view.counts = { error: num(counts.error), warning: num(counts.warning), info: num(counts.info) };
  const findings = report.findings as Array<Record<string, unknown>>;
  const held: NonNullable<ReviewView['untrusted']['findings']> = {};
  view.findings = findings.map((f, i) => {
    const code = typeof f.code === 'string' && rv.FINDING_CODES.has(f.code) ? f.code : 'unknown';
    const at = (f.at && typeof f.at === 'object' ? f.at : {}) as Record<string, unknown>;
    const out: ReviewFindingView['at'] = {};
    for (const k of ['frame', 'time', 'step'] as const) if (typeof at[k] === 'number' && Number.isFinite(at[k])) out[k] = at[k];
    for (const k of ['segment', 'scene'] as const) {
      if (typeof at[k] === 'string' && SAFE_ID.test(at[k])) out[k] = at[k];
      else if (at[k] !== undefined) (held[i] ??= {})[k] = at[k];
    }
    if (code === 'unknown' && f.code !== undefined) (held[i] ??= {}).code = f.code;
    return { severity: f.severity === 'error' || f.severity === 'warning' ? f.severity : 'info', code, ...(Object.keys(out).length ? { at: out } : {}) };
  });
  if (Object.keys(held).length) view.untrusted.findings = held;
  view.untrusted.messages = findings.map((f) => str(f.message) ?? '');
  const durations = report.durations as { total_s?: unknown; segments?: unknown } | undefined;
  if (durations && Array.isArray(durations.segments)) {
    const heldSegments: NonNullable<ReviewView['untrusted']['segments']> = {};
    const segments: NonNullable<ReviewView['durations']>['segments'] = [];
    (durations.segments as Array<Record<string, unknown>>).forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const bad: Record<string, unknown> = {};
      const id = typeof s.id === 'string' && SAFE_ID.test(s.id) ? s.id : undefined;
      if (!id) bad.id = s.id;
      const kind = typeof s.kind === 'string' && SEGMENT_KINDS.has(s.kind) ? s.kind : 'unknown';
      if (kind === 'unknown') bad.kind = s.kind;
      const component = typeof s.component === 'string' && COMPONENT_ID_RE.test(s.component) ? s.component : 'unknown';
      if (component === 'unknown') bad.component = s.component;
      const scene = typeof s.scene === 'string' && SAFE_ID.test(s.scene) ? s.scene : undefined;
      if (s.scene !== undefined && !scene) bad.scene = s.scene;
      if (Object.keys(bad).length) heldSegments[i] = bad;
      if (!id) return;
      segments.push({ id, kind, ...(scene ? { scene } : {}), from_s: num(s.from_s), to_s: num(s.to_s), duration_s: num(s.duration_s), component, ...(typeof s.speed === 'number' && Number.isFinite(s.speed) ? { speed: s.speed } : {}) });
    });
    view.durations = { total_s: num(durations.total_s), segments };
    if (Object.keys(heldSegments).length) view.untrusted.segments = heldSegments;
  }
  if (report.environment) view.untrusted.environment = report.environment;
  const diff = report.diff as Record<string, unknown> | undefined;
  if (diff) {
    const previous = typeof diff.previous === 'string' && RENDER_ID_RE.test(diff.previous) ? diff.previous : 'unknown';
    if (previous === 'unknown') view.untrusted.diff_previous = diff.previous;
    const d = diff.duration_s as Record<string, unknown> | undefined;
    view.diff = {
      previous,
      ...(d && typeof d === 'object' ? { duration_s: { previous: num(d.previous), current: num(d.current), delta: num(d.delta) } } : {}),
      compared: num(diff.compared),
      changed_frames: Array.isArray(diff.changed_frames) ? diff.changed_frames.length : 0,
      ...(diffSheet ? { sheet: diffSheet } : {}),
    };
    if (diff.segments) view.untrusted.diff_segments = diff.segments;
  }
  // The images: the review package's own choice (contact sheet pages, marker key frames; or everything).
  const mode = o.images ?? 'sheets';
  if (mode !== 'none') {
    const segmentNames = new Set((view.durations?.segments ?? []).flatMap((s) => [`${s.id}-first`, `${s.id}-last`, `${s.id}-hold`].map(rv.safeName)));
    const markers = Object.keys(keyframes).filter((k) => !segmentNames.has(k));
    const pairs = rv.reviewImages(
      { dir, sheets: view.files.sheets, scene_sheets: sceneSheets, keyframes, timeline: '', report_json: reportFile, report_md: '', ...(diffSheet ? { diff_sheet: diffSheet } : {}) },
      { fps, markers, mode },
    );
    view.images = pairs.map(([name, file]) => ({ label: imageLabel(name, fps), file }));
  }
  return view;
}

/** "contact sheet (1 fps), page 2", "key frame quote-sent", "scene sheet s2", "diff with the previous render". */
function imageLabel(name: string, fps: number): string {
  const sheet = /^sheet_(\d)fps(?:_p(\d+))?$/.exec(name);
  if (sheet) return `contact sheet (${fps} fps)${sheet[2] ? `, page ${sheet[2]}` : ''}`;
  if (name.startsWith('keyframe:')) return `key frame ${name.slice('keyframe:'.length)}`;
  const scene = /^sheet_scene_(.+?)(?:_p(\d+))?$/.exec(name);
  if (scene) return `scene sheet ${scene[1]}${scene[2] ? `, page ${scene[2]}` : ''}`;
  return name === 'diff' ? 'diff with the previous render' : name;
}

/**
 * A JPEG thumbnail (base64, ≤ `maxPx` on its long side) of an image of the workspace, made on read (sharp, from the
 * review package): never stored. Refused outside the workspace and its projects folder.
 */
export async function thumbnail(ws: WorkspaceConfig, file: string, maxPx = 1280): Promise<{ base64: string; width: number; height: number; bytes: number }> {
  if (!(insideFolder(ws.root, file) || insideFolder(ws.projectsDir, file))) throw new EngineError('refused', `${file} is outside the workspace: no thumbnail`);
  const rv = await review();
  return rv.thumbnailOf(file, Math.max(64, Math.min(1280, Math.round(maxPx))));
}

// ── One review image for the Studio (L4.5 part E, critique B16) ─────────────

/**
 * The images the Studio shows from a review folder, by their name in it: contact sheet pages, scene sheets and the diff
 * sheet (JPEG), and the key frames (PNG, in keyframes/) — review B: not the 1 fps sheets only.
 */
export const REVIEW_IMAGE_RE = /^(?:(?:sheet|diff)_[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.jpg|keyframes\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.png)$/;
/** A sheet read from the folder, at most (bytes): a 1 fps sheet page is ≈ 0.3–2 MB. */
export const REVIEW_IMAGE_SOURCE_MAX = 8 * 1024 * 1024;
/** The long side of the JPEG answered, at most (px), and its base64, at most (the page's SHEET_DATA_MAX). */
export const REVIEW_IMAGE_MAX_PX = 1600;
export const REVIEW_IMAGE_BASE64_MAX = 2_000_000;

export interface ReviewImageView {
  project: string;
  render_id: string;
  image: string;
  mime: 'image/jpeg';
  base64: string;
  width: number;
  height: number;
}

const thumbs = () => import('@demo-studio/review/thumbs');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * One image of a render's review as a base64 JPEG (≤ REVIEW_IMAGE_MAX_PX, ≤ REVIEW_IMAGE_BASE64_MAX characters), made in
 * memory: `image` is a file NAME of review/<render_id>/ (REVIEW_IMAGE_RE: a contact sheet page, a scene sheet, the diff
 * sheet, or `keyframes/<name>.png`, as render_review lists them) — never a path. The folder (and the key frames'
 * folder) must lie in the project once links are resolved; the file is opened without following a link (O_NOFOLLOW),
 * must be a regular file with one name (no hard link: review A N4) within REVIEW_IMAGE_SOURCE_MAX and start like its
 * kind (JPEG FF D8 FF, PNG's signature): a link planted in the folder, a renamed file or a huge file is refused.
 */
export async function reviewImage(ws: WorkspaceConfig, slug: string, renderId: string, image: string): Promise<ReviewImageView> {
  checkProjectSlug(slug);
  if (typeof renderId !== 'string' || !RENDER_ID_RE.test(renderId) || renderId.length > 200) throw new EngineError('invalid', `invalid render id "${String(renderId)}": <scenario>-v<N>`);
  if (typeof image !== 'string' || !REVIEW_IMAGE_RE.test(image)) throw new EngineError('invalid', `invalid image "${String(image).slice(0, 100)}": a contact sheet of the review (render_review lists them), never a path`);
  const project = await openProjectBySlug(ws, slug);
  const dir = join(project.dir, 'review', renderId);
  if (!existsSync(dir)) throw new EngineError('not_found', `render ${renderId} has no review yet`);
  if (!insideFolder(project.dir, dir)) throw new EngineError('refused', `the review folder of ${renderId} lies outside the project: not shown`);
  const file = join(dir, image);
  // A key frame's folder too stays in the review folder once links are resolved (the file itself: O_NOFOLLOW below).
  if (!insideFolder(dir, dirname(file))) throw new EngineError('refused', `${image} of the review of ${renderId} lies outside its folder: not shown`);
  const read = readPlainFile(file, REVIEW_IMAGE_SOURCE_MAX, { verify: (st) => st.nlink === 1 });
  if (!read.ok) {
    if (read.reason === 'missing') throw new EngineError('not_found', `the review of ${renderId} has no ${image}`);
    if (read.reason === 'link') throw new EngineError('refused', `${image} of the review of ${renderId} is a link (symbolic or hard): not followed`);
    if (read.reason === 'too_large') throw new EngineError('refused', `${image} of the review of ${renderId} is larger than ${REVIEW_IMAGE_SOURCE_MAX / 1024 / 1024} MB: not shown`);
    throw new EngineError('refused', `${image} of the review of ${renderId} cannot be read (${read.reason})`);
  }
  const b = read.bytes;
  const png = image.endsWith('.png');
  const ok = png ? b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC) : b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (!ok) throw new EngineError('refused', `${image} of the review of ${renderId} is not a ${png ? 'PNG' : 'JPEG'}: not shown`);
  const t = await thumbs();
  let out = await t.thumbJpeg(b, { maxPx: REVIEW_IMAGE_MAX_PX, quality: 80 }).catch(() => undefined);
  if (out && out.data.toString('base64').length > REVIEW_IMAGE_BASE64_MAX) out = await t.thumbJpeg(b, { maxPx: 1100, quality: 70 }).catch(() => undefined);
  if (!out) throw new EngineError('refused', `${image} of the review of ${renderId} cannot be decoded`);
  const base64 = out.data.toString('base64');
  if (base64.length > REVIEW_IMAGE_BASE64_MAX) throw new EngineError('refused', `${image} of the review of ${renderId} stays too large once scaled: not shown`);
  return { project: slug, render_id: renderId, image, mime: 'image/jpeg', base64, width: out.width, height: out.height };
}
