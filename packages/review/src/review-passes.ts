/**
 * The review's decoding passes, one ffmpeg pass per video: the render (tiles, key frames, each frame's analysis), the
 * capture behind the clips, and the previous render (the diff).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { errorMessage } from '@retake/core/base';
import { captionRegion } from './checks.js';
import { diffRecords, framePairs } from './diff.js';
import { extractFrames, probeVideo } from './ffmpeg.js';
import { sourceFramesAtStarts, sourceKey, stillSourceFrames } from './pixel-checks.js';
import type { FrameAnalysis } from './pixel-checks.js';
import type { RegionStats, RgbImage } from './pixels.js';
import { compareSignatures, regionStats, signature, uniformity } from './pixels.js';
import { makeTile } from './sheets.js';
import type { Tile } from './sheets.js';
import { isClip, round, spanAt, timecode } from './spans.js';
import type { DiffFrame, ReviewDiff } from './types.js';
import { decodeOptions } from './review-inputs.js';
import type { FrameTile, RenderFrames, ReviewRun } from './review-inputs.js';

const MAX_DIFF_PAIRS = 30;

function inset(r: { x: number; y: number; w: number; h: number }, d: number) {
  return { x: r.x + d, y: r.y + d, w: Math.max(1, r.w - 2 * d), h: Math.max(1, r.h - 2 * d) };
}

/** Pass 1, the render: tiles, key frames and each frame's analysis (the screen, the caption area, the signature). */
export async function renderPass(r: ReviewRun): Promise<RenderFrames> {
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
export async function capturePass(r: ReviewRun, analyses: Map<number, FrameAnalysis>): Promise<{ sources?: Map<string, RegionStats>; sourceSigs?: Map<string, Float32Array> }> {
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
export async function previousPass(r: ReviewRun, frames: RenderFrames): Promise<{ diff?: ReviewDiff; diffTiles: Tile[] }> {
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
