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
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { captionRegion, checkCamera, checkCaptions, checkCursor, checkDurations, checkEnvironment, checkLongScenes, checkRender, checkTextSlots, checkOverlayCover, checkTransitionsOnClicks, checkTutorial, planFontFiles, reviewEnvironment, segmentDurations } from './checks.js';
import type { CheckContext } from './checks.js';
import { diffFindings, diffRecords, framePairs } from './diff.js';
import { extractFrames, probeVideo } from './ffmpeg.js';
import { fontFileMeasurer } from './fonts.js';
import { ReviewError, findPrevious, findRender, openProject, renderTimeline, reviewsDir } from './load.js';
import { checkPixels, sourceFramesAtStarts, sourceKey, stillPair, stillSourceFrames } from './pixel-checks.js';
import type { FrameAnalysis } from './pixel-checks.js';
import type { RegionStats, RgbImage } from './pixels.js';
import { compareSignatures, regionStats, signature, uniformity } from './pixels.js';
import { reportMarkdown } from './report.js';
import { makeTile, thumbnailOf, writeSheet } from './sheets.js';
import type { Tile } from './sheets.js';
import { isClip, round, segmentLabel, segmentSpans, spanAt, stepAt, timecode, transitionAt, transitionSpans } from './spans.js';
import type { SegmentSpan } from './spans.js';
import { buildOutputTimeline, outputClicks } from './timeline.js';
import { DEFAULT_RULES, DEFAULT_SHEET } from './types.js';
import type { DiffFrame, Finding, ReviewDiff, ReviewFiles, ReviewOptions, ReviewResult, ReviewThumbnail, Severity } from './types.js';
import { ReviewCancelledError } from './types.js';
import { summaryLine } from './report.js';

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const MAX_DIFF_PAIRS = 30;

/** File-system-safe key frame name. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'frame';
}

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

/**
 * The images of a review an agent looks at, as [name, file]: the contact sheet pages and the marker key frames
 * (`sheets`), or also every key frame, the per-scene sheets and the diff sheet (`all`).
 */
export function reviewImages(files: ReviewFiles, o: { fps: 1 | 2; markers: Iterable<string>; mode: 'sheets' | 'all' }): Array<[string, string]> {
  const all = o.mode === 'all';
  const list: Array<[string, string]> = files.sheets.map((f, i) => [`sheet_${o.fps}fps${i ? `_p${i + 1}` : ''}`, f]);
  const markerNames = new Set([...o.markers].map(safeName));
  for (const [name, f] of Object.entries(files.keyframes)) if (all || markerNames.has(name)) list.push([`keyframe:${name}`, f]);
  if (all) {
    for (const [id, fl] of Object.entries(files.scene_sheets)) fl.forEach((f, i) => list.push([`sheet_scene_${id}${i ? `_p${i + 1}` : ''}`, f]));
    if (files.diff_sheet) list.push(['diff', files.diff_sheet]);
  }
  return list;
}

/** The pid a review's temporary folder (`<id>.tmp-<pid>-<hex>`, `<id>.old-<pid>-<hex>`) belongs to. */
function aside(name: string, id: string): { kind: 'tmp' | 'old'; pid: number } | undefined {
  if (!name.startsWith(`${id}.`)) return undefined;
  const m = /^(tmp|old)-(\d+)-[0-9a-f]+$/.exec(name.slice(id.length + 1));
  return m ? { kind: m[1] as 'tmp' | 'old', pid: Number(m[2]) } : undefined;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    if (!a || pidAlive(a.pid)) continue;
    const dir = join(parent, name);
    if (a.kind === 'old' && !existsSync(finalDir)) await rename(dir, finalDir).catch(() => undefined);
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

export async function reviewRender(opts: ReviewOptions): Promise<ReviewResult> {
  try {
    return await reviewRenderOnce(opts);
  } catch (e) {
    if (opts.signal?.aborted && !(e instanceof ReviewCancelledError)) throw new ReviewCancelledError();
    throw e;
  }
}

async function reviewRenderOnce(opts: ReviewOptions): Promise<ReviewResult> {
  const started = performance.now();
  const progress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  /** Stop between stages (and ffmpeg at once: it gets the signal) when cancelled. */
  const check = () => {
    if (signal?.aborted) throw new ReviewCancelledError();
  };
  check();
  progress({ stage: 'loading' });
  const project = await openProject(opts.project, opts.root);
  const record = await findRender(project, opts.render, opts.scenario);
  const plan = record.plan;
  if (!existsSync(record.file)) throw new ReviewError(`the video of render ${record.id} is missing: ${record.file}`);
  const fps = opts.fps ?? 1;
  if (fps !== 1 && fps !== 2) throw new ReviewError(`fps ${String(fps)}: the contact sheet takes 1 or 2 frames per second`);
  const rules = { ...DEFAULT_RULES, ...opts.rules };
  const layout = { ...DEFAULT_SHEET, ...opts.sheet };
  const thumbPx = Math.max(64, Math.min(1280, Math.round(opts.thumbnail_px ?? 1280)));
  const notes: Finding[] = [];

  let registry: ComponentRegistry | undefined = opts.registry;
  if (!registry) {
    try {
      registry = await loadComponentRegistry({ root: project.root });
    } catch (e) {
      notes.push({ severity: 'info', code: 'registry-unavailable', message: `component registry not loaded (${(e as Error).message}): text slot limits not checked` });
    }
  }
  const { timeline } = await renderTimeline(project, record);
  if (!timeline) notes.push({ severity: 'info', code: 'timeline-missing', message: `the run ${record.run_id} (timeline.json) is not available: clicks, cursor and capture captions not checked` });
  const previous = await findPrevious(project, record, opts.previous);
  const probed = await probeVideo(record.file);

  const F = plan.fps;
  const D = plan.durationInFrames;
  const spans = segmentSpans(plan);
  const transitions = transitionSpans(plan);
  const clicks = outputClicks(plan, timeline);
  const ctx: CheckContext = { record, plan, timeline, rules, spans, transitions, clicks, registry, measure: fontFileMeasurer(planFontFiles(plan)) };

  // ── Frames to look at ──
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

  // ── Output directory (written aside, swapped in at the end) ──
  const finalDir = opts.out ?? join(reviewsDir(project), record.id);
  // Leftovers of a review that died are put back in order first (the previous review set aside comes back).
  await recoverReviewDir(finalDir);
  const tmpDir = `${finalDir}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(join(tmpDir, 'keyframes'), { recursive: true });
  const fin = (p: string) => join(finalDir, relative(tmpDir, p));

  try {
    // ── Pass 1: the render ──
    check();
    progress({ stage: 'frames', progress: 0 });
    const tiles = new Map<number, { data: Buffer; width: number; height: number }>();
    const analyses = new Map<number, FrameAnalysis>();
    const keyFiles: Record<string, string> = {};
    const fullStep = Math.max(2, Math.round(Math.min(plan.width, plan.height) / 180));
    let done = 0;
    const delivered = await extractFrames(record.file, [...wanted], { width: plan.width, height: plan.height, videoWidth: probed.width, videoHeight: probed.height, ...(signal ? { signal } : {}) }, async (f, img) => {
      const span = spanAt(spans, f);
      if (mainSet.has(f) || sceneSet.has(f)) tiles.set(f, await makeTile(img, layout.tile));
      for (const name of keyByFrame.get(f) ?? []) {
        const file = join(tmpDir, 'keyframes', `${name}.png`);
        await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).png({ compressionLevel: 6 }).toFile(file);
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
      if (previous && mainSet.has(f)) a.sig = signature(img, { x: 0, y: 0, w: img.width, h: img.height });
      analyses.set(f, a);
      done++;
      if (done % 10 === 0) progress({ stage: 'frames', progress: done / wanted.size });
    });
    const missingFrames = [...wanted].filter((f) => !delivered.includes(f));
    if (missingFrames.length) {
      notes.push({ severity: 'warning', code: 'frames-missing', message: `${missingFrames.length} of the ${wanted.size} frames sampled could not be decoded (the video ends at ${probed.duration_s.toFixed(2)} s?)` });
    }

    // ── Pass 2: the capture behind the clips (scene starts, blank suspects) — the main capture and the pages' tracks ──
    let sources: Map<string, RegionStats> | undefined;
    let sourceSigs: Map<string, Float32Array> | undefined;
    const captureFile = plan.source.file;
    check();
    if (captureFile && existsSync(captureFile)) {
      progress({ stage: 'capture' });
      const want = new Set(sourceFramesAtStarts(spans));
      const sigWanted = new Set(stillSourceFrames(plan, spans, F, timeline));
      for (const k of sigWanted) want.add(k);
      for (const [f, a] of analyses) {
        const span = spanAt(spans, f);
        if (!span || !isClip(span.segment) || !a.screen || !uniformity(a.screen, rules)) continue;
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
          const info = await probeVideo(src.file);
          await extractFrames(src.file, frames, { width: cw, height: ch, videoWidth: info.width, videoHeight: info.height, ...(signal ? { signal } : {}) }, (f, img: RgbImage) => {
            const key = `${track}:${f}`;
            sources!.set(key, regionStats(img, { x: 0, y: 0, w: img.width, h: img.height }, { step: 2 }));
            if (sigWanted.has(key)) sourceSigs!.set(key, signature(img, { x: 0, y: 0, w: img.width, h: img.height }, 64, 36));
          });
        }
      } catch (e) {
        check();
        sources = undefined;
        sourceSigs = undefined;
        notes.push({ severity: 'info', code: 'capture-unreadable', message: `the capture ${captureFile} could not be read (${(e as Error).message}): scene starts checked on the rendered frames only` });
      }
    } else {
      notes.push({ severity: 'info', code: 'capture-missing', message: `the capture of run ${record.run_id} is not available: scene starts checked on the rendered frames only` });
    }

    // ── Pass 3: the previous render (same segment, same offset) ──
    let diff: ReviewDiff | undefined;
    const diffTiles: Tile[] = [];
    check();
    if (previous) {
      progress({ stage: 'previous' });
      const base = diffRecords(previous, record);
      const pairs = framePairs(previous.plan, plan, mainFrames);
      const prevSigs = new Map<number, Float32Array>();
      const prevTiles = new Map<number, { data: Buffer; width: number; height: number }>();
      try {
        const info = await probeVideo(previous.file);
        await extractFrames(previous.file, pairs.map((p) => p.previous_frame), { width: previous.plan.width, height: previous.plan.height, videoWidth: info.width, videoHeight: info.height, ...(signal ? { signal } : {}) }, async (f, img) => {
          prevSigs.set(f, signature(img, { x: 0, y: 0, w: img.width, h: img.height }));
          prevTiles.set(f, await makeTile(img, layout.tile));
        });
        const changed: DiffFrame[] = [];
        let compared = 0;
        for (const p of pairs) {
          const a = analyses.get(p.frame)?.sig;
          const b = prevSigs.get(p.previous_frame);
          if (!a || !b) continue;
          compared++;
          const d = compareSignatures(b, a);
          if (d.changed > rules.diff_change_share) changed.push({ frame: p.frame, time: round(p.frame / F, 2), segment: p.segment, previous_frame: p.previous_frame, changed: round(d.changed, 4) });
        }
        diff = { ...base, compared, changed_frames: changed };
        // The most changed frames, in time order.
        const shown = [...changed].sort((x, y) => y.changed - x.changed).slice(0, MAX_DIFF_PAIRS).sort((x, y) => x.frame - y.frame);
        for (const c of shown) {
          const pt = prevTiles.get(c.previous_frame);
          const ct = tiles.get(c.frame);
          if (!pt || !ct) continue;
          diffTiles.push({ frame: c.previous_frame, ...pt, label: `${previous.id} · ${timecode(c.previous_frame / previous.plan.fps)}`, sub: `before · ${c.segment}` });
          diffTiles.push({ frame: c.frame, ...ct, label: `${record.id} · ${timecode(c.time)}`, sub: `now · ${Math.round(c.changed * 100)} % changed`, mark: 'info' });
        }
      } catch (e) {
        check();
        diff = { ...base, compared: 0, changed_frames: [] };
        notes.push({ severity: 'info', code: 'previous-unreadable', message: `the previous render ${previous.id} could not be read (${(e as Error).message}): plan diff only` });
      }
    }

    // The diff sheet (before the checks: the diff findings point at it).
    let diffSheet: string | undefined;
    if (diff && previous && diffTiles.length) {
      const files = await writeSheet(diffTiles, {
        file: join(tmpDir, `diff_${safeName(previous.id)}.jpg`),
        title: `${record.id} vs ${previous.id} — changed frames (before | now)`,
        subtitle: `${diff.changed_frames.length} of ${diff.compared} sample frames changed · duration ${diff.duration_s.previous.toFixed(2)} → ${diff.duration_s.current.toFixed(2)} s`,
        layout: { ...layout, columns: Math.max(2, layout.columns - (layout.columns % 2)) },
      });
      diffSheet = files[0];
      if (diffSheet) diff.sheet = fin(diffSheet);
    }

    // ── Checks ──
    check();
    progress({ stage: 'checks' });
    const durations = segmentDurations(ctx);
    const findings = sortFindings([
      ...checkRender(ctx, probed),
      ...notes,
      ...checkDurations(ctx, durations),
      ...checkLongScenes(ctx, durations),
      ...checkCaptions(ctx),
      ...checkTextSlots(ctx),
      ...checkCursor(ctx),
      ...checkCamera(ctx),
      ...checkTransitionsOnClicks(ctx),
      ...checkTutorial(ctx),
      ...checkOverlayCover(ctx),
      ...checkEnvironment(ctx),
      ...checkPixels(ctx, { analyses, sources, sourceSigs, sceneSamples, sampleSpacing_s: 0.5 }),
      ...(diff ? diffFindings(diff) : []),
    ]);
    const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;
    const clean = counts.error === 0 && counts.warning === 0;

    // ── Sheets ──
    check();
    progress({ stage: 'sheets' });
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
    const summary = summaryLine({ clean, counts });
    const sheets = await writeSheet(
      mainFrames.map((f) => tileOf(f, F / fps)).filter((t): t is Tile => t !== undefined),
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
        (sceneSamples.get(seg.id) ?? []).map((f) => tileOf(f, F / 2)).filter((t): t is Tile => t !== undefined),
        {
          file: join(tmpDir, `sheet_scene_${safeName(seg.id)}.jpg`),
          title: `${record.id} — ${segmentLabel(seg)} (${seg.kind})`,
          subtitle: `${timecode(s.from / F)}–${timecode(s.to / F)} · ${((s.to - s.from) / F).toFixed(2)} s · 2 fps · ${seg.component.id}${cue ? ` · “${cue.text}”` : ''}`,
          layout,
        },
      );
      if (files.length) sceneSheets[seg.id] = files;
    }
    // ── Timeline, report ──
    progress({ stage: 'writing' });
    const outputTimeline = buildOutputTimeline(record, timeline);
    const files: ReviewFiles = {
      dir: finalDir,
      sheets: sheets.map(fin),
      scene_sheets: Object.fromEntries(Object.entries(sceneSheets).map(([k, v]) => [k, v.map(fin)])),
      keyframes: Object.fromEntries(Object.entries(keyFiles).map(([k, v]) => [k, fin(v)])),
      timeline: join(finalDir, 'timeline.json'),
      report_json: join(finalDir, 'report.json'),
      report_md: join(finalDir, 'report.md'),
    };
    if (diffSheet) files.diff_sheet = fin(diffSheet);
    const environment = reviewEnvironment(timeline, plan);
    const result: Omit<ReviewResult, 'thumbnails'> = {
      version: 1,
      render: {
        id: record.id,
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
      review: { created_at: new Date().toISOString(), fps, ms: 0, rules },
      clean,
      counts,
      findings,
      durations: { total_s: round(D / F, 3), segments: durations },
      ...(environment ? { environment } : {}),
      ...(diff ? { diff } : {}),
      files,
    };
    await writeFile(join(tmpDir, 'timeline.json'), `${JSON.stringify(outputTimeline, null, 2)}\n`);
    result.review.ms = Math.round(performance.now() - started);
    await writeFile(join(tmpDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(tmpDir, 'report.md'), reportMarkdown(result, outputTimeline));

    // Swap the new review in: the previous one is set aside first (a crash between the two renames leaves it there,
    // and recoverReviewDir brings it back), then removed. Cancelled before this point: the previous review is intact.
    check();
    await mkdir(dirname(finalDir), { recursive: true });
    const old = `${finalDir}.old-${process.pid}-${randomBytes(3).toString('hex')}`;
    const hadOld = existsSync(finalDir);
    if (hadOld) await rename(finalDir, old);
    try {
      await rename(tmpDir, finalDir);
    } catch (e) {
      if (hadOld) await rename(old, finalDir).catch(() => undefined);
      throw e;
    }
    if (hadOld) await rm(old, { recursive: true, force: true });

    // ── Thumbnails for the MCP ──
    const thumbnails: ReviewThumbnail[] = [];
    if (opts.thumbnails !== false) {
      const list = reviewImages(files, { fps, markers: plan.markers.map((m) => m.name), mode: opts.thumbnails === 'all' ? 'all' : 'sheets' });
      for (const [name, file] of list) {
        const t = await thumbnailOf(file, thumbPx);
        thumbnails.push({ name, file, mime: 'image/jpeg', ...t });
      }
    }
    progress({ stage: 'done', progress: 1 });
    return { ...result, thumbnails };
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    throw e;
  }
}
