/**
 * `reviewRender`: everything an agent (or a person) needs to verify a render before showing it — contact sheets,
 * per-scene sheets, key frames, the output-time timeline, report.json + report.md with the findings of every check, a
 * diff with the previous render — written to `<project>/review/<render-id>/`, plus small JPEG thumbnails (base64) for
 * the MCP. Frames are decoded with ffmpeg in one pass per video (render, capture, previous render); sharp makes the
 * thumbnails, sheets and key frames.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { ComponentRegistry } from '@retake/components/geometry';
import { printableText, bestEffort, errorMessage } from '@retake/core/base';
import type { EditPlan } from '@retake/editor/plan';
import type { Timeline } from '@retake/core/run';
import {
  captionRegion,
  checkArtefactOrder,
  checkCamera,
  checkCaptions,
  checkCursor,
  checkDurations,
  checkEnvironment,
  checkLongScenes,
  checkRender,
  checkSlowTransitions,
  checkTextSlots,
  checkButtonContrast,
  checkOverlayCover,
  checkLoadingFilmed,
  checkZoomScroll,
  checkCaptionContradictions,
  checkOverlaysKept,
  checkTransitionsOnClicks,
  checkTutorial,
  planFontFiles,
  reviewEnvironment,
  segmentDurations,
} from './checks.js';
import type { CheckContext } from './checks.js';
import { diffFindings, diffRecords, framePairs } from './diff.js';
import { extractFrames, probeVideo } from './ffmpeg.js';
import type { VideoInfo } from './ffmpeg.js';
import { fontFileMeasurer } from './fonts.js';
import { ReviewError, findPrevious, handedProject, handedRegistry, locateRender, renderRun, renderTimeline, reviewsDir } from './load.js';
import { checkPixels, sourceFramesAtStarts, sourceKey, stillPair, stillSourceFrames } from './pixel-checks.js';
import type { FrameAnalysis, PixelCheckInput } from './pixel-checks.js';
import type { RegionStats, RgbImage } from './pixels.js';
import { compareSignatures, regionStats, signature, uniformity } from './pixels.js';
import { reportMarkdown } from './report.js';
import { makeTile, thumbnailOf, writeSheet } from './sheets.js';
import type { Tile } from './sheets.js';
import { isClip, round, segmentLabel, segmentSpans, spanAt, stepAt, timecode, transitionAt, transitionSpans } from './spans.js';
import type { SegmentSpan } from './spans.js';
import { buildOutputTimeline, outputClicks } from './timeline.js';
import { DEFAULT_RULES, DEFAULT_SHEET } from './types.js';
import type { DiffFrame, Finding, ReviewDiff, ReviewFiles, ReviewOptions, ReviewProgress, ReviewResult, ReviewRules, ReviewThumbnail, SegmentDuration, Severity } from './types.js';
import { ReviewCancelledError } from './types.js';
import { summaryLine } from './report-lines.js';
import { reviewImages, safeName } from './images.js';
import { pidExists } from '@retake/core/io';

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const MAX_DIFF_PAIRS = 30;

/** Sample frames at `rate` per second over output frames [from, to): the middle of each interval. */
export function sampleFrames(from: number, to: number, fps: number, rate: number): number[] {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const f = Math.floor(from + ((k + 0.5) * fps) / rate);
    if (f >= to) break;
    out.push(f);
  }
  if (out.length === 0 && to > from) out.push(Math.floor((from + to - 1) / 2));
  return out;
}

/**
 * Key frames: markers (the screen once the marked step is done — `done`, a marked wait's awaited state — else the
 * marker), each scene's first and last fully visible frame, and a "hold" frame of the other segments.
 */
export function keyframePlan(spans: SegmentSpan[], markers: Array<{ name: string; frame: number; done?: number }>, durationInFrames: number): Map<string, number> {
  const out = new Map<string, number>();
  const add = (name: string, frame: number) => {
    let n = safeName(name);
    for (let i = 2; out.has(n); i++) n = `${safeName(name)}-${i}`;
    out.set(n, Math.max(0, Math.min(durationInFrames - 1, Math.round(frame))));
  };
  for (const m of markers) add(m.name, m.done ?? m.frame);
  for (const s of spans) {
    const a = s.clearFrom;
    const b = Math.max(a, s.clearTo - 1);
    if (s.segment.kind === 'intro' || s.segment.kind === 'outro') add(`${s.segment.id}-hold`, a + Math.round(0.8 * (b - a)));
    else {
      add(`${s.segment.id}-first`, a);
      add(`${s.segment.id}-last`, b);
    }
  }
  return out;
}

/** The pid a review's temporary folder (`<id>.tmp-<pid>-<hex>`, `<id>.old-<pid>-<hex>`) belongs to. */
function aside(name: string, id: string): { kind: 'tmp' | 'old'; pid: number } | undefined {
  if (!name.startsWith(`${id}.`)) return undefined;
  const m = /^(tmp|old)-(\d+)-[0-9a-f]+$/.exec(name.slice(id.length + 1));
  return m ? { kind: m[1] as 'tmp' | 'old', pid: Number(m[2]) } : undefined;
}

/**
 * Put a review folder back in order after a review that died (a killed process): the previous review set aside for the
 * swap comes back when no review took its place, and the temporary folders of dead processes are removed. A review
 * still running (its process alive) is left alone. Best effort.
 */
export async function recoverReviewDir(finalDir: string): Promise<void> {
  const parent = dirname(finalDir);
  const id = basename(finalDir);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  for (const name of names.sort().reverse()) {
    const a = aside(name, id);
    if (!a || pidExists(a.pid)) continue;
    const dir = join(parent, name);
    if (a.kind === 'old' && !existsSync(finalDir)) await bestEffort(rename(dir, finalDir), 'the previous review stays where it was: the new one is written beside it');
    else await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sortFindings(list: Finding[]): Finding[] {
  // By severity, the comparison with the previous render last, then by frame (video-level findings first).
  const diff = (f: Finding) => (f.code.startsWith('diff-') ? 1 : 0);
  return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || diff(a) - diff(b) || (a.at?.frame ?? -1) - (b.at?.frame ?? -1) || a.code.localeCompare(b.code));
}

function inset(r: { x: number; y: number; w: number; h: number }, d: number) {
  return { x: r.x + d, y: r.y + d, w: Math.max(1, r.w - 2 * d), h: Math.max(1, r.h - 2 * d) };
}

/** The rules of a review: the defaults, the scenario's target length (R-FLD-05), then the caller's. */
export function reviewRules(plan: Pick<EditPlan, 'target_length'>, given: Partial<ReviewRules> = {}): ReviewRules {
  const rules: ReviewRules = { ...DEFAULT_RULES, ...given };
  if (plan.target_length && given.video_min_s === undefined && given.video_max_s === undefined) {
    rules.video_min_s = plan.target_length.min_s;
    rules.video_max_s = plan.target_length.max_s;
    rules.video_target = 'scenario';
  }
  return rules;
}

export async function reviewRender(opts: ReviewOptions): Promise<ReviewResult> {
  try {
    return await reviewRenderOnce(opts);
  } catch (e) {
    if (opts.signal?.aborted && !(e instanceof ReviewCancelledError)) throw new ReviewCancelledError();
    throw e;
  }
}

/** A review under way: what was loaded, the frames it samples, where it writes, and how it reports and stops. */
type ReviewRun = LoadedReview & {
  opts: ReviewOptions;
  started: number;
  progress: (p: ReviewProgress) => void;
  signal?: AbortSignal;
  /** Stop between stages (and ffmpeg at once: it gets the signal) when cancelled. */
  check: () => void;
  samples: ReviewSamples;
  finalDir: string;
  tmpDir: string;
};

type LoadedReview = Awaited<ReturnType<typeof loadReview>>;

/** The output frames a review looks at. */
interface ReviewSamples {
  mainFrames: number[];
  sceneSamples: Map<string, number[]>;
  mainSet: Set<number>;
  sceneSet: Set<number>;
  keyByFrame: Map<number, string[]>;
  wanted: Set<number>;
}

type FrameTile = { data: Buffer; width: number; height: number };

/** What the decoding of the render gave: contact sheet tiles, frame analyses, key frame files. */
interface RenderFrames {
  tiles: Map<number, FrameTile>;
  analyses: Map<number, FrameAnalysis>;
  keyFiles: Record<string, string>;
}

async function reviewRenderOnce(opts: ReviewOptions): Promise<ReviewResult> {
  const started = performance.now();
  const progress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const check = () => {
    if (signal?.aborted) throw new ReviewCancelledError();
  };
  check();
  progress({ stage: 'loading' });
  const loaded = await loadReview(opts);
  const samples = planSamples(loaded.plan, loaded.spans, loaded.fps, loaded.timeline);

  // ── Output directory (written aside, swapped in at the end) ──
  const finalDir = opts.out ?? join(reviewsDir(loaded.project), loaded.name);
  // Leftovers of a review that died are put back in order first (the previous review set aside comes back).
  await recoverReviewDir(finalDir);
  const tmpDir = `${finalDir}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(join(tmpDir, 'keyframes'), { recursive: true });
  const r: ReviewRun = { ...loaded, opts, started, progress, ...(signal ? { signal } : {}), check, samples, finalDir, tmpDir };

  try {
    const frames = await renderPass(r);
    const { sources, sourceSigs } = await capturePass(r, frames.analyses);
    const { diff, diffTiles } = await previousPass(r, frames);
    const diffSheet = await writeDiffSheet(r, diff, diffTiles);
    const checked = runChecks(r, { analyses: frames.analyses, sources, sourceSigs, sceneSamples: samples.sceneSamples, sampleSpacing_s: 0.5 }, diff);
    const sheets = await writeContactSheets(r, frames.tiles, checked.findings, checked.summary);
    const result = await writeReport(r, { frames, sheets, diffSheet, diff, checked });
    await swapIn(r);
    const thumbnails = await reviewThumbnails(r, result.files);
    progress({ stage: 'done', progress: 1 });
    return { ...result, thumbnails };
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

/** Load what a review reads: the render, its plan, registry, timeline, run, the previous render and the video's probe. */
async function loadReview(opts: ReviewOptions) {
  const project = handedProject(opts.project);
  const source = handedRegistry(opts.registry);
  const found = await locateRender(project, opts.render, opts.scenario);
  const record = found.record;
  // The name of its folder of review/ (never an empty name or a path: an id written by hand is any text).
  const name = found.output;
  const plan = record.plan;
  if (!existsSync(record.file)) throw new ReviewError(`the video of render ${printableText(name)} is missing: ${record.file ? printableText(record.file) : 'no "file" in its record'}`);
  const fps = opts.fps ?? 1;
  if (fps !== 1 && fps !== 2) throw new ReviewError(`fps ${String(fps)}: the contact sheet takes 1 or 2 frames per second`);
  const rules = reviewRules(plan, opts.rules);
  const layout = { ...DEFAULT_SHEET, ...opts.sheet };
  const thumbPx = Math.max(64, Math.min(1280, Math.round(opts.thumbnail_px ?? 1280)));
  // Findings about the review itself (what could not be loaded or read), in the order they were met.
  const notes: Finding[] = [];

  let registry: ComponentRegistry | undefined = typeof source === 'function' ? undefined : source;
  if (typeof source === 'function') {
    try {
      registry = await source(project.root);
    } catch (e) {
      notes.push({ severity: 'info', code: 'registry-unavailable', message: `component registry not loaded (${errorMessage(e)}): text slot limits not checked` });
    }
  }
  const { timeline } = await renderTimeline(project, record);
  if (!timeline) notes.push({ severity: 'info', code: 'timeline-missing', message: `the run ${record.run_id} (timeline.json) is not available: clicks, cursor and capture captions not checked` });
  const previous = await findPrevious(project, record, opts.previous);
  const probed = await probeVideo(record.file, opts.policy);

  const spans = segmentSpans(plan);
  const transitions = transitionSpans(plan);
  const clicks = outputClicks(plan, timeline);
  const run = await renderRun(project, record);
  const ctx: CheckContext = { record, plan, timeline, rules, spans, transitions, clicks, registry, measure: fontFileMeasurer(planFontFiles(plan)), ...(run ? { run } : {}) };
  return {
    project,
    record,
    name,
    plan,
    fps,
    rules,
    layout,
    thumbPx,
    notes,
    ...(timeline ? { timeline } : {}),
    ...(previous ? { previous } : {}),
    probed,
    spans,
    transitions,
    ctx,
  };
}

/** The frames to look at: the contact sheet's, each scene's (2 fps), the key frames and the still pairs. */
function planSamples(plan: EditPlan, spans: SegmentSpan[], fps: number, timeline: Timeline | undefined): ReviewSamples {
  const F = plan.fps;
  const D = plan.durationInFrames;
  const mainFrames = sampleFrames(0, D, F, fps);
  const sceneSamples = new Map<string, number[]>();
  for (const s of spans) sceneSamples.set(s.segment.id, sampleFrames(s.from, s.to, F, 2));
  const keyframes = keyframePlan(spans, plan.markers, D);
  const stills = spans.map((s) => stillPair(s, F, timeline)).filter((p): p is [number, number] => p !== undefined);
  const mainSet = new Set(mainFrames);
  const sceneSet = new Set([...sceneSamples.values()].flat());
  const keyByFrame = new Map<number, string[]>();
  for (const [name, f] of keyframes) keyByFrame.set(f, [...(keyByFrame.get(f) ?? []), name]);
  const wanted = new Set<number>([...mainFrames, ...sceneSet, ...keyframes.values(), ...stills.flat()]);
  return { mainFrames, sceneSamples, mainSet, sceneSet, keyByFrame, wanted };
}

/** The decoding options of a video, at the size a pass reads it. */
function decodeOptions(r: ReviewRun, width: number, height: number, info: VideoInfo) {
  return { width, height, videoWidth: info.width, videoHeight: info.height, policy: r.opts.policy, ...(r.signal ? { signal: r.signal } : {}) };
}

/** Pass 1, the render: tiles, key frames and each frame's analysis (the screen, the caption area, the signature). */
async function renderPass(r: ReviewRun): Promise<RenderFrames> {
  const { plan, spans, samples, previous } = r;
  r.check();
  r.progress({ stage: 'frames', progress: 0 });
  const tiles = new Map<number, FrameTile>();
  const analyses = new Map<number, FrameAnalysis>();
  const keyFiles: Record<string, string> = {};
  const fullStep = Math.max(2, Math.round(Math.min(plan.width, plan.height) / 180));
  let done = 0;
  const delivered = await extractFrames(r.record.file, [...samples.wanted], decodeOptions(r, plan.width, plan.height, r.probed), async (f, img) => {
    const span = spanAt(spans, f);
    if (samples.mainSet.has(f) || samples.sceneSet.has(f)) tiles.set(f, await makeTile(img, r.layout.tile));
    for (const name of samples.keyByFrame.get(f) ?? []) {
      const file = join(r.tmpDir, 'keyframes', `${name}.png`);
      await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
        .png({ compressionLevel: 6 })
        .toFile(file);
      keyFiles[name] = file;
    }
    const a: FrameAnalysis = { frame: f, full: regionStats(img, { x: 0, y: 0, w: img.width, h: img.height }, { step: fullStep }) };
    if (span && isClip(span.segment)) {
      const cap = span.segment.layout.capture;
      const screen = inset(cap, span.segment.layout.radius + 2 * plan.unit);
      a.screen = regionStats(img, screen);
      a.screenSig = signature(img, screen, 64, 36);
      const region = captionRegion(plan, span.segment);
      if (region) a.captionSd = regionStats(img, region.rect, { step: Math.max(1, Math.round(plan.unit * 2)) }).sd;
    }
    if (previous && samples.mainSet.has(f)) a.sig = signature(img, { x: 0, y: 0, w: img.width, h: img.height });
    analyses.set(f, a);
    done++;
    if (done % 10 === 0) r.progress({ stage: 'frames', progress: done / samples.wanted.size });
  });
  const missingFrames = [...samples.wanted].filter((f) => !delivered.includes(f));
  if (missingFrames.length) {
    r.notes.push({
      severity: 'warning',
      code: 'frames-missing',
      message: `${missingFrames.length} of the ${samples.wanted.size} frames sampled could not be decoded (the video ends at ${r.probed.duration_s.toFixed(2)} s?)`,
    });
  }
  return { tiles, analyses, keyFiles };
}

/** Pass 2, the capture behind the clips (scene starts, blank suspects): the main capture and the pages' tracks. */
async function capturePass(r: ReviewRun, analyses: Map<number, FrameAnalysis>): Promise<{ sources?: Map<string, RegionStats>; sourceSigs?: Map<string, Float32Array> }> {
  const { plan, spans } = r;
  let sources: Map<string, RegionStats> | undefined;
  let sourceSigs: Map<string, Float32Array> | undefined;
  const captureFile = plan.source.file;
  r.check();
  if (!captureFile || !existsSync(captureFile)) {
    r.notes.push({ severity: 'info', code: 'capture-missing', message: `the capture of run ${r.record.run_id} is not available: scene starts checked on the rendered frames only` });
    return { sources, sourceSigs };
  }
  r.progress({ stage: 'capture' });
  const want = new Set(sourceFramesAtStarts(spans));
  const sigWanted = new Set(stillSourceFrames(plan, spans, plan.fps, r.timeline));
  for (const k of sigWanted) want.add(k);
  for (const [f, a] of analyses) {
    const span = spanAt(spans, f);
    if (!span || !isClip(span.segment) || !a.screen || !uniformity(a.screen, r.rules)) continue;
    want.add(sourceKey(span.segment, span.segment.srcFrames[Math.min(span.segment.srcFrames.length - 1, f - span.segment.from)] ?? 0));
  }
  // Group the wanted frames by video: `main` (plan.source) or a page's track.
  const byTrack = new Map<string, number[]>();
  for (const k of want) {
    const i = k.lastIndexOf(':');
    const track = k.slice(0, i);
    if (!byTrack.has(track)) byTrack.set(track, []);
    byTrack.get(track)!.push(Number(k.slice(i + 1)));
  }
  sources = new Map();
  sourceSigs = new Map();
  try {
    for (const [track, frames] of byTrack) {
      const src = track === 'main' ? plan.source : plan.tracks?.[track];
      if (!src || !existsSync(src.file)) continue;
      const cw = Math.min(640, src.width);
      const ch = Math.max(2, Math.round((cw * src.height) / src.width / 2) * 2);
      const info = await probeVideo(src.file, r.opts.policy);
      await extractFrames(src.file, frames, decodeOptions(r, cw, ch, info), (f, img: RgbImage) => {
        const key = `${track}:${f}`;
        sources!.set(key, regionStats(img, { x: 0, y: 0, w: img.width, h: img.height }, { step: 2 }));
        if (sigWanted.has(key)) sourceSigs!.set(key, signature(img, { x: 0, y: 0, w: img.width, h: img.height }, 64, 36));
      });
    }
  } catch (e) {
    r.check();
    sources = undefined;
    sourceSigs = undefined;
    r.notes.push({
      severity: 'info',
      code: 'capture-unreadable',
      message: `the capture ${captureFile} could not be read (${errorMessage(e)}): scene starts checked on the rendered frames only`,
    });
  }
  return { sources, sourceSigs };
}

/** Pass 3, the previous render (same segment, same offset): the diff and the tiles of its most changed frames. */
async function previousPass(r: ReviewRun, frames: RenderFrames): Promise<{ diff?: ReviewDiff; diffTiles: Tile[] }> {
  const { plan, record, previous, rules } = r;
  let diff: ReviewDiff | undefined;
  const diffTiles: Tile[] = [];
  r.check();
  if (!previous) return { diff, diffTiles };
  r.progress({ stage: 'previous' });
  const base = diffRecords(previous, record);
  const pairs = framePairs(previous.plan, plan, r.samples.mainFrames);
  const prevSigs = new Map<number, Float32Array>();
  const prevTiles = new Map<number, FrameTile>();
  try {
    const info = await probeVideo(previous.file, r.opts.policy);
    await extractFrames(
      previous.file,
      pairs.map((p) => p.previous_frame),
      decodeOptions(r, previous.plan.width, previous.plan.height, info),
      async (f, img) => {
        prevSigs.set(f, signature(img, { x: 0, y: 0, w: img.width, h: img.height }));
        prevTiles.set(f, await makeTile(img, r.layout.tile));
      },
    );
    const changed: DiffFrame[] = [];
    let compared = 0;
    for (const p of pairs) {
      const a = frames.analyses.get(p.frame)?.sig;
      const b = prevSigs.get(p.previous_frame);
      if (!a || !b) continue;
      compared++;
      const d = compareSignatures(b, a);
      if (d.changed > rules.diff_change_share) changed.push({ frame: p.frame, time: round(p.frame / plan.fps, 2), segment: p.segment, previous_frame: p.previous_frame, changed: round(d.changed, 4) });
    }
    diff = { ...base, compared, changed_frames: changed };
    // The most changed frames, in time order.
    const shown = [...changed]
      .sort((x, y) => y.changed - x.changed)
      .slice(0, MAX_DIFF_PAIRS)
      .sort((x, y) => x.frame - y.frame);
    for (const c of shown) {
      const pt = prevTiles.get(c.previous_frame);
      const ct = frames.tiles.get(c.frame);
      if (!pt || !ct) continue;
      diffTiles.push({ frame: c.previous_frame, ...pt, label: `${previous.id} · ${timecode(c.previous_frame / previous.plan.fps)}`, sub: `before · ${c.segment}` });
      diffTiles.push({ frame: c.frame, ...ct, label: `${record.id} · ${timecode(c.time)}`, sub: `now · ${Math.round(c.changed * 100)} % changed`, mark: 'info' });
    }
  } catch (e) {
    r.check();
    diff = { ...base, compared: 0, changed_frames: [] };
    r.notes.push({ severity: 'info', code: 'previous-unreadable', message: `the previous render ${previous.id} could not be read (${errorMessage(e)}): plan diff only` });
  }
  return { diff, diffTiles };
}

/** A file of the review's temporary folder, at its place in the final one. */
function finalPath(r: Pick<ReviewRun, 'finalDir' | 'tmpDir'>, p: string): string {
  return join(r.finalDir, relative(r.tmpDir, p));
}

/** The diff sheet (before the checks: the diff findings point at it). */
async function writeDiffSheet(r: ReviewRun, diff: ReviewDiff | undefined, diffTiles: Tile[]): Promise<string | undefined> {
  const { previous, record, layout } = r;
  if (!diff || !previous || !diffTiles.length) return undefined;
  const files = await writeSheet(diffTiles, {
    file: join(r.tmpDir, `diff_${safeName(previous.id)}.jpg`),
    title: `${record.id} vs ${previous.id} — changed frames (before | now)`,
    subtitle: `${diff.changed_frames.length} of ${diff.compared} sample frames changed · duration ${diff.duration_s.previous.toFixed(2)} → ${diff.duration_s.current.toFixed(2)} s`,
    layout: { ...layout, columns: Math.max(2, layout.columns - (layout.columns % 2)) },
  });
  const diffSheet = files[0];
  if (diffSheet) diff.sheet = finalPath(r, diffSheet);
  return diffSheet;
}

/** What the checks found: the sorted findings, their counts, the verdict and the segment durations. */
interface CheckedReview {
  findings: Finding[];
  counts: Record<Severity, number>;
  clean: boolean;
  durations: SegmentDuration[];
  summary: string;
}

/** Every check, in report order (then sorted by severity, the diff last, by frame). */
function runChecks(r: ReviewRun, pixels: PixelCheckInput, diff: ReviewDiff | undefined): CheckedReview {
  const { ctx } = r;
  r.check();
  r.progress({ stage: 'checks' });
  const durations = segmentDurations(ctx);
  const findings = sortFindings([
    ...checkRender(ctx, r.probed),
    ...r.notes,
    ...checkDurations(ctx, durations),
    ...checkLongScenes(ctx, durations),
    ...checkCaptions(ctx),
    ...checkTextSlots(ctx),
    ...checkLoadingFilmed(ctx),
    ...checkZoomScroll(ctx),
    ...checkCaptionContradictions(ctx),
    ...checkOverlaysKept(ctx),
    ...checkButtonContrast(ctx),
    ...checkCursor(ctx),
    ...checkCamera(ctx),
    ...checkTransitionsOnClicks(ctx),
    ...checkTutorial(ctx),
    ...checkOverlayCover(ctx),
    ...checkEnvironment(ctx),
    ...checkArtefactOrder(ctx),
    ...checkSlowTransitions(ctx),
    ...checkPixels(ctx, pixels),
    ...(diff ? diffFindings(diff) : []),
  ]);
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const clean = counts.error === 0 && counts.warning === 0;
  return { findings, counts, clean, durations, summary: summaryLine({ clean, counts }) };
}

/** The contact sheet and the per-scene sheets, each tile marked with the worst finding near its frame. */
async function writeContactSheets(r: ReviewRun, tiles: Map<number, FrameTile>, findings: Finding[], summary: string): Promise<{ sheets: string[]; sceneSheets: Record<string, string[]> }> {
  const { plan, record, spans, transitions, fps, layout, tmpDir } = r;
  const F = plan.fps;
  const D = plan.durationInFrames;
  r.check();
  r.progress({ stage: 'sheets' });
  const markOf = (f: number, half: number): Severity | undefined => {
    let worst: Severity | undefined;
    for (const x of findings) {
      if (x.severity === 'info' || x.at?.frame === undefined) continue;
      if (x.at.frame >= f - half && x.at.frame < f + half && (!worst || SEVERITY_ORDER[x.severity] < SEVERITY_ORDER[worst])) worst = x.severity;
    }
    return worst;
  };
  const tileOf = (f: number, interval: number): Tile | undefined => {
    const t = tiles.get(f);
    if (!t) return undefined;
    const span = spanAt(spans, f);
    const parts: string[] = [];
    if (span) {
      parts.push(segmentLabel(span.segment));
      if (isClip(span.segment)) {
        const st = stepAt(span.segment, f - span.segment.from);
        if (st) parts.push(st.step < 0 ? 'still' : `${st.step_id ?? `#${st.step}`} ${st.action}`);
      }
    }
    const marker = plan.markers.find((m) => m.frame >= f - interval / 2 && m.frame < f + interval / 2);
    if (marker) parts.push(`◆ ${marker.name}`);
    const tr = transitionAt(transitions, f);
    if (tr) parts.push(`⇄ ${tr.kind}`);
    return { frame: f, ...t, label: `${timecode(f / F)} · f${f}`, sub: parts.join(' · '), mark: markOf(f, interval / 2) };
  };
  const sheets = await writeSheet(
    r.samples.mainFrames.map((f) => tileOf(f, F / fps)).filter((t): t is Tile => t !== undefined),
    {
      file: join(tmpDir, `sheet_${fps}fps.jpg`),
      title: `${record.id} — contact sheet, ${fps} frame${fps > 1 ? 's' : ''} per second`,
      subtitle: `${record.scenario} · ${(D / F).toFixed(2)} s · ${plan.segments.length} segments · theme ${record.template} · ${summary}`,
      layout,
    },
  );
  const sceneSheets: Record<string, string[]> = {};
  for (const s of spans) {
    if (s.segment.kind === 'intro' || s.segment.kind === 'outro') continue;
    const seg = s.segment;
    const cue = isClip(seg) ? seg.cues[0] : undefined;
    const files = await writeSheet(
      (r.samples.sceneSamples.get(seg.id) ?? []).map((f) => tileOf(f, F / 2)).filter((t): t is Tile => t !== undefined),
      {
        file: join(tmpDir, `sheet_scene_${safeName(seg.id)}.jpg`),
        title: `${record.id} — ${segmentLabel(seg)} (${seg.kind})`,
        subtitle: `${timecode(s.from / F)}–${timecode(s.to / F)} · ${((s.to - s.from) / F).toFixed(2)} s · 2 fps · ${seg.component.id}${cue ? ` · “${cue.text}”` : ''}`,
        layout,
      },
    );
    if (files.length) sceneSheets[seg.id] = files;
  }
  return { sheets, sceneSheets };
}

/** What the report is made of. */
interface ReportParts {
  frames: RenderFrames;
  sheets: { sheets: string[]; sceneSheets: Record<string, string[]> };
  diffSheet?: string;
  diff?: ReviewDiff;
  checked: CheckedReview;
}

/** The output-time timeline, report.json and report.md, written to the temporary folder; the result without thumbnails. */
async function writeReport(r: ReviewRun, parts: ReportParts): Promise<Omit<ReviewResult, 'thumbnails'>> {
  const { plan, record, finalDir, tmpDir, timeline } = r;
  const diff = parts.diff;
  const fin = (p: string) => finalPath(r, p);
  const F = plan.fps;
  const D = plan.durationInFrames;
  const { findings, counts, clean, durations } = parts.checked;
  r.progress({ stage: 'writing' });
  const outputTimeline = buildOutputTimeline(record, timeline);
  const files: ReviewFiles = {
    dir: finalDir,
    sheets: parts.sheets.sheets.map(fin),
    scene_sheets: Object.fromEntries(Object.entries(parts.sheets.sceneSheets).map(([k, v]) => [k, v.map(fin)])),
    keyframes: Object.fromEntries(Object.entries(parts.frames.keyFiles).map(([k, v]) => [k, fin(v)])),
    timeline: join(finalDir, 'timeline.json'),
    report_json: join(finalDir, 'report.json'),
    report_md: join(finalDir, 'report.md'),
  };
  if (parts.diffSheet) files.diff_sheet = fin(parts.diffSheet);
  const environment = reviewEnvironment(timeline, plan);
  const result: Omit<ReviewResult, 'thumbnails'> = {
    version: 1,
    render: {
      id: r.name,
      file: record.file,
      record: record.record,
      scenario: record.scenario,
      run_id: record.run_id,
      template: record.template,
      duration_s: round(D / F, 3),
      frames: D,
      fps: F,
      width: plan.width,
      height: plan.height,
      variant: record.variant,
    },
    review: { created_at: new Date().toISOString(), fps: r.fps, ms: 0, rules: r.rules },
    clean,
    counts,
    findings,
    durations: { total_s: round(D / F, 3), segments: durations },
    ...(environment ? { environment } : {}),
    ...(diff ? { diff } : {}),
    files,
  };
  await writeFile(join(tmpDir, 'timeline.json'), `${JSON.stringify(outputTimeline, null, 2)}\n`);
  result.review.ms = Math.round(performance.now() - r.started);
  await writeFile(join(tmpDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(tmpDir, 'report.md'), reportMarkdown(result, outputTimeline));
  return result;
}

/**
 * Swap the new review in: the previous one is set aside first (a crash between the two renames leaves it there, and
 * recoverReviewDir brings it back), then removed. Cancelled before this point: the previous review is intact.
 */
async function swapIn(r: Pick<ReviewRun, 'check' | 'finalDir' | 'tmpDir'>): Promise<void> {
  const { finalDir, tmpDir } = r;
  r.check();
  await mkdir(dirname(finalDir), { recursive: true });
  const old = `${finalDir}.old-${process.pid}-${randomBytes(3).toString('hex')}`;
  const hadOld = existsSync(finalDir);
  if (hadOld) await rename(finalDir, old);
  try {
    await rename(tmpDir, finalDir);
  } catch (e) {
    if (hadOld)
      await bestEffort(rename(old, finalDir), "the rename's own error is thrown; when putting the old review back fails too, it stays aside under its .old- name (recoverReviewDir brings it back)");
    throw e;
  }
  if (hadOld) await rm(old, { recursive: true, force: true });
}

/** Thumbnails for the MCP. */
async function reviewThumbnails(r: ReviewRun, files: ReviewFiles): Promise<ReviewThumbnail[]> {
  const thumbnails: ReviewThumbnail[] = [];
  if (r.opts.thumbnails === false) return thumbnails;
  const list = reviewImages(files, { fps: r.fps, markers: r.plan.markers.map((m) => m.name), mode: r.opts.thumbnails === 'all' ? 'all' : 'sheets' });
  for (const [name, file] of list) {
    const t = await thumbnailOf(file, r.thumbPx);
    thumbnails.push({ name, file, mime: 'image/jpeg', ...t });
  }
  return thumbnails;
}
