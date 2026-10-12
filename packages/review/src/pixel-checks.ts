/**
 * Checks on the frames themselves: blank / near-uniform (loading) screens inside the layout's capture rect and at
 * scene starts (rendered frames, and the capture frames behind them), a screen still changing during the scene's
 * opening still (the page was loading), captions that do not show in their area, segments that render nothing.
 */
import type { Timeline } from '@demo-studio/core';
import { viewOf } from '@demo-studio/editor';
import type { ClipSegment, EditPlan } from '@demo-studio/editor';
import type { CheckContext } from './checks.js';
import { captionRegion, locate } from './checks.js';
import type { RegionStats } from './pixels.js';
import { compareSignatures, uniformity } from './pixels.js';
import type { SegmentSpan } from './spans.js';
import { isClip, timecode } from './spans.js';
import type { Finding } from './types.js';

/** What the review measured on one rendered frame. */
export interface FrameAnalysis {
  frame: number;
  /** Whole frame. */
  full: RegionStats;
  /** Clips: the capture rect (inset from the rounded corners) and the caption rect (luminance sd = ink). */
  screen?: RegionStats;
  screenSig?: Float32Array;
  captionSd?: number;
  /** Whole-frame signature (diff with the previous render). */
  sig?: Float32Array;
}

export interface PixelCheckInput {
  analyses: Map<number, FrameAnalysis>;
  /**
   * Capture frames analysed (`sourceKey` → whole-frame stats): of the main capture, or of a page's own track (multi-page
   * clips, L2.11); undefined when the capture is not available.
   */
  sources?: Map<string, RegionStats>;
  /** Signatures of capture frames (whole frame): the opening-still check of a clip whose view moves (a reframe, a zoom). */
  sourceSigs?: Map<string, Float32Array>;
  /** Frames sampled per segment for its sheet (2 fps). */
  sceneSamples: Map<string, number[]>;
  /** Seconds between two scene samples. */
  sampleSpacing_s: number;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** The video a capture frame of a clip comes from: `main` (plan.source), or a page's track (its first page by default). */
export function sourceTrack(clip: Pick<ClipSegment, 'panes'>, pane = 0): string {
  return clip.panes?.[pane]?.track ?? 'main';
}

/** Key of a capture frame in `PixelCheckInput.sources`: `<track>:<frame>`. */
export function sourceKey(clip: Pick<ClipSegment, 'panes'>, frame: number, pane = 0): string {
  return `${sourceTrack(clip, pane)}:${frame}`;
}

/** The capture frames the pixel checks want to look at (clip starts), before any rendered frame is analysed. */
export function sourceFramesAtStarts(spans: SegmentSpan[]): string[] {
  const out: string[] = [];
  for (const s of spans) {
    if (!isClip(s.segment)) continue;
    const clip = s.segment;
    for (let p = 0; p < Math.max(1, clip.panes?.length ?? 0); p++) {
      out.push(sourceKey(clip, clip.srcFrames[0] ?? 0, p));
      out.push(sourceKey(clip, clip.srcFrames[Math.min(clip.srcFrames.length - 1, s.clearFrom - s.from)] ?? 0, p));
    }
  }
  return out;
}

/**
 * True when the visible region of the capture differs between two frames of a clip (a reframe pan or a camera move):
 * the rendered screens then differ even on a still page, and the capture frames are compared instead.
 */
export function viewMoves(plan: Pick<EditPlan, 'source' | 'variant'>, clip: ClipSegment, a: number, b: number): boolean {
  const va = viewOf(plan, clip, a - clip.from);
  const vb = viewOf(plan, clip, b - clip.from);
  // Even a sub-pixel glide of the crop changes every edge of a detailed page: any move counts.
  const tol = 0.25;
  return Math.abs(va.cx - vb.cx) > tol || Math.abs(va.cy - vb.cy) > tol || Math.abs(va.w - vb.w) > tol;
}

/**
 * An overlay of the clip (a step overlay, a tutorial overlay: a spotlight dims the whole screen) is on screen at some
 * point between output frames `a` and `b`.
 */
export function overlayDuring(clip: ClipSegment, a: number, b: number): boolean {
  return clip.overlays.some((o) => clip.from + o.from <= b && clip.from + o.from + o.durationInFrames > a);
}

/** A caption drawn over the screen (`position: over`) is on between output frames `a` and `b`. */
export function captionOverDuring(clip: ClipSegment, a: number, b: number): boolean {
  if (clip.caption?.params?.position !== 'over') return false;
  return clip.cues.some((c) => clip.from + c.from <= b && clip.from + c.to > a);
}

/**
 * The opening still of a clip is compared on its capture frames rather than on the rendered ones: the view moves (a
 * reframe, a zoom), an overlay comes in during it (L2.10: the spotlight of the first step fades in before it starts) or
 * a caption over the screen does (its entrance animation).
 */
export function stillFromSource(plan: Pick<EditPlan, 'source' | 'variant'>, clip: ClipSegment, a: number, b: number): boolean {
  // A multi-page clip (L2.11) compares each page on its own track (the acting emphasis may change the rendered frames).
  if (clip.panes) return true;
  return viewMoves(plan, clip, a, b) || overlayDuring(clip, a, b) || captionOverDuring(clip, a, b);
}

/** The capture frames shown at the still pair of a clip compared on its capture frames (`stillFromSource`), keyed. */
export function stillSourceFrames(plan: Pick<EditPlan, 'source' | 'variant'>, spans: SegmentSpan[], fps: number, timeline?: Timeline): string[] {
  const out: string[] = [];
  for (const s of spans) {
    const pair = stillPair(s, fps, timeline);
    if (!pair || !isClip(s.segment) || !stillFromSource(plan, s.segment, pair[0], pair[1])) continue;
    const clip = s.segment;
    for (let p = 0; p < Math.max(1, clip.panes?.length ?? 0); p++) out.push(sourceKey(clip, clip.srcFrames[pair[0] - s.from], p), sourceKey(clip, clip.srcFrames[pair[1] - s.from], p));
  }
  return out;
}

/** The rendered frames of a clip whose opening still is compared (first and last fully visible still frames). */
export function stillPair(span: SegmentSpan, fps: number, timeline?: Timeline): [number, number] | undefined {
  if (!isClip(span.segment)) return undefined;
  const clip = span.segment;
  const still = clip.steps.find((s) => s.step === -1 && s.action === 'scene_still');
  if (!still) return undefined;
  let a = Math.max(still.from, span.clearFrom - clip.from);
  // A continuing scene may glide its cursor during the still (next to its first target): compare from its end on.
  const settled = stillGlideEnd(timeline, clip.scene);
  if (settled !== undefined && timeline) a = Math.max(a, frameAtOrAfter(clip, Math.round(settled * timeline.capture.fps)));
  const b = Math.min(still.to, span.clearTo - clip.from, clip.durationInFrames - clip.heldFrames) - 1;
  if ((b - a) / fps < 0.3) return undefined;
  return [clip.from + a, clip.from + b];
}

/** Capture seconds the hover states a scene-start glide passes over get to settle once it ended. */
const GLIDE_SETTLE_S = 0.3;

/**
 * Capture time from which the opening still of `scene` holds still: the end of its scene-start glide (`t_settled`,
 * estimated from `move_ms` for runs before L5.1) plus GLIDE_SETTLE_S; undefined when no cursor glided. A multi-page
 * scene records one cursor per page: the last glide counts.
 */
export function stillGlideEnd(timeline: Timeline | undefined, scene: string): number | undefined {
  const ev = timeline?.events.find((e) => e.scene === scene && e.action === 'scene_still');
  const c = (ev?.data as { cursor?: unknown } | undefined)?.cursor;
  if (!ev || !c || typeof c !== 'object') return undefined;
  const recs = ('how' in c ? [c] : Object.values(c)) as Array<{ how?: string; move_ms?: number; t_settled?: number } | null>;
  const lead = Math.min(0.3, 0.2 * (ev.t_end - ev.t_start)); // the runner's glide lead (placeSceneCursor)
  const ends = recs.filter((r) => r?.how === 'glide').map((r) => r!.t_settled ?? ev.t_start + lead + (r!.move_ms ?? 0) / 1000);
  return ends.length ? Math.max(...ends) + GLIDE_SETTLE_S : undefined;
}

/** First output frame of a clip showing capture frame `n` or a later one (clamped to the clip). */
function frameAtOrAfter(clip: ClipSegment, n: number): number {
  const f = clip.srcFrames;
  let lo = 0;
  let hi = f.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid] < n) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where the scenario waits in a clip (absolute output frames): `wait` / `wait_for` steps and the time after an action
 * (its click and ripple, or its end) until the next step starts — holds, the opening still and the page load are
 * deliberate and not counted. Without the capture timeline, the wait steps' spans.
 */
export function waitingStretches(ctx: Pick<CheckContext, 'plan' | 'timeline'>, span: SegmentSpan): Array<{ from: number; to: number; label: string }> {
  const clip = span.segment as ClipSegment;
  const fps = ctx.plan.source.fps;
  const raw: Array<{ from: number; to: number; steps: number[]; after: boolean }> = [];
  const tl = ctx.timeline;
  if (tl) {
    const evs = tl.events.filter((e) => e.scene === clip.scene && e.step >= 0 && e.status !== 'skipped').sort((a, b) => a.t_start - b.t_start);
    const sceneEnd = tl.scenes.find((x) => x.id === clip.scene)?.t_end ?? clip.src.to_s;
    evs.forEach((e, i) => {
      if (e.action === 'hold') return;
      const push = (a: number, b: number, after: boolean) => {
        if (b - a > 0.05) raw.push({ from: clip.from + frameAtOrAfter(clip, Math.round(a * fps)), to: clip.from + frameAtOrAfter(clip, Math.round(b * fps)), steps: [e.step], after });
      };
      // The wait itself; after a click, the settle once its ripple is over (a click's t_end may include a navigation);
      // then, after the action (and its deliberate hold), the time until the next step.
      if (e.action === 'wait' || e.action === 'wait_for') push(e.t_start, e.t_end, false);
      else if (e.action === 'click' && e.t_click !== undefined) push(Math.min(e.t_end, e.t_click + 0.4), e.t_end, true);
      const next = Math.min(evs[i + 1]?.t_start ?? sceneEnd, sceneEnd);
      push(e.hold ? Math.max(e.hold.t_end, e.t_end) : e.t_end, next, e.action !== 'wait' && e.action !== 'wait_for');
    });
  } else {
    for (const st of clip.steps) if (st.action === 'wait' || st.action === 'wait_for') raw.push({ from: clip.from + st.from, to: clip.from + st.to, steps: [st.step], after: false });
  }
  const merged: typeof raw = [];
  for (const r of raw.sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && r.from - last.to <= 2) {
      last.to = Math.max(last.to, r.to);
      for (const st of r.steps) if (!last.steps.includes(st)) last.steps.push(st);
    } else merged.push({ ...r, steps: [...r.steps] });
  }
  return merged
    .map((m) => ({
      from: Math.max(m.from, span.clearFrom),
      to: Math.min(m.to, span.clearTo, clip.from + clip.durationInFrames - clip.heldFrames),
      label: m.steps.length > 1 ? `steps ${m.steps[0]}–${m.steps[m.steps.length - 1]}` : `${m.after ? 'after ' : ''}step ${m.steps[0]}`,
    }))
    .filter((m) => m.to > m.from);
}

function describeSource(input: PixelCheckInput, clip: ClipSegment, frame: number, rules: CheckContext['rules']): string {
  if (!input.sources) return '';
  const src = clip.srcFrames[Math.max(0, Math.min(clip.srcFrames.length - 1, frame - clip.from))];
  const st = input.sources.get(sourceKey(clip, src));
  if (!st) return '';
  return uniformity(st, rules) ? ` — capture frame ${src} is ${uniformity(st, rules) === 'blank' ? 'blank' : 'almost empty'} too (an empty or loading page was captured)` : ` — capture frame ${src} is not: the screen was not drawn, or the camera shows an empty area`;
}

export function checkPixels(ctx: CheckContext, input: PixelCheckInput): Finding[] {
  const out: Finding[] = [];
  const { plan, rules } = ctx;
  const fps = plan.fps;
  for (const span of ctx.spans) {
    const seg = span.segment;
    const samples = (input.sceneSamples.get(seg.id) ?? []).filter((f) => f >= span.clearFrom && f < span.clearTo).sort((a, b) => a - b);
    if (isClip(seg)) {
      // Scene start: the first capture frame shown, and the first fully visible rendered frame.
      const src0 = seg.srcFrames[0];
      const srcStats = input.sources?.get(sourceKey(seg, src0));
      const kindSrc = srcStats ? uniformity(srcStats, rules) : undefined;
      const first = input.analyses.get(span.clearFrom);
      const kindOut = first?.screen ? uniformity(first.screen, rules) : undefined;
      if (kindSrc === 'blank' || kindOut === 'blank') {
        out.push({
          severity: 'error',
          code: 'blank-scene-start',
          message: `scene "${seg.scene}" starts on a blank screen (${kindSrc === 'blank' ? `capture frame ${src0}` : `rendered frame ${span.clearFrom}`}): its page was not ready — wait for it in the scenario or start the scene later`,
          at: locate(ctx, span.clearFrom),
        });
      } else if (kindSrc === 'near-uniform' || kindOut === 'near-uniform') {
        out.push({
          severity: 'warning',
          code: 'loading-scene-start',
          message: `scene "${seg.scene}" starts on an almost empty screen (${pct((kindSrc ? srcStats : first?.screen)?.share ?? 0)} one colour): a loading page?`,
          at: locate(ctx, span.clearFrom),
        });
      }
      // Opening still: nothing should change on screen (the page is loaded and the cursor rests).
      const pair = stillPair(span, fps, ctx.timeline);
      if (pair) {
        // When the view moves during the still (a reframe, a zoom) or something is drawn over the page (an overlay, a
        // caption over the screen), the page itself is compared: its capture frames.
        const moving = stillFromSource(plan, seg, pair[0], pair[1]);
        const srcA = seg.srcFrames[pair[0] - seg.from];
        const srcB = seg.srcFrames[pair[1] - seg.from];
        // Each page of a multi-page clip on its own track: the largest change counts.
        let changed: number | undefined;
        for (let p = 0; p < Math.max(1, seg.panes?.length ?? 0); p++) {
          const a = moving ? input.sourceSigs?.get(sourceKey(seg, srcA, p)) : input.analyses.get(pair[0])?.screenSig;
          const b = moving ? input.sourceSigs?.get(sourceKey(seg, srcB, p)) : input.analyses.get(pair[1])?.screenSig;
          if (a && b) changed = Math.max(changed ?? 0, compareSignatures(a, b).changed);
        }
        if (changed !== undefined) {
          const d = { changed };
          if (d.changed > rules.still_change_share) {
            out.push({
              severity: 'warning',
              code: 'loading-scene-start',
              message: `the screen changes during the opening still of "${seg.scene}" (${pct(d.changed)} of it between ${timecode(pair[0] / fps)} and ${timecode(pair[1] / fps)}): the page was still loading or animating when the scene started`,
              at: locate(ctx, pair[0]),
            });
          }
        }
      }
      // Blank / near-uniform runs inside the clip (2 fps samples, transitions excluded).
      let run: { kind: 'blank' | 'near-uniform'; frames: number[] } | undefined;
      const flush = () => {
        if (!run) return;
        const len = (run.frames[run.frames.length - 1] - run.frames[0]) / fps + input.sampleSpacing_s;
        const from = run.frames[0];
        const where = `${timecode(from / fps)}–${timecode(run.frames[run.frames.length - 1] / fps + input.sampleSpacing_s / 2)}`;
        if (run.kind === 'blank') {
          out.push({
            severity: len >= rules.blank_error_s ? 'error' : 'warning',
            code: 'blank-screen',
            message: `the screen of "${seg.scene}" is blank for ≈ ${len.toFixed(1)} s (${where})${describeSource(input, seg, from, rules)}`,
            at: locate(ctx, from),
          });
        } else {
          out.push({
            severity: 'warning',
            code: 'near-uniform-screen',
            message: `the screen of "${seg.scene}" is almost empty for ≈ ${len.toFixed(1)} s (${where}, ≥ ${pct(rules.near_uniform_share)} one colour): a loading page or a spinner?${describeSource(input, seg, from, rules)}`,
            at: locate(ctx, from),
          });
        }
        run = undefined;
      };
      for (const f of samples) {
        const a = input.analyses.get(f);
        const kind = a?.screen ? uniformity(a.screen, rules) : undefined;
        if (kind && run && run.kind === kind) run.frames.push(f);
        else {
          flush();
          if (kind) run = { kind, frames: [f] };
        }
      }
      flush();
      // Waiting on an unchanging screen (a loading state, a skeleton) for long.
      for (const w of waitingStretches(ctx, span)) {
        const inside = samples.filter((f) => f >= w.from && f < w.to);
        let best: [number, number] | undefined;
        let runStart = 0;
        for (let k = 1; k <= inside.length; k++) {
          const a = input.analyses.get(inside[k - 1])?.screenSig;
          const b = k < inside.length ? input.analyses.get(inside[k])?.screenSig : undefined;
          const still = a && b ? compareSignatures(a, b).mad < 3 : false;
          if (!still) {
            if (k - 1 > runStart && (!best || inside[k - 1] - inside[runStart] > best[1] - best[0])) best = [inside[runStart], inside[k - 1]];
            runStart = k;
          }
        }
        if (!best) continue;
        const half = Math.round((input.sampleSpacing_s * fps) / 2);
        const from = Math.max(w.from, best[0] - half);
        const to = Math.min(w.to, best[1] + half);
        const len = (to - from) / fps;
        if (len < rules.long_wait_s) continue;
        const protectedSpan = seg.speeds.some((x) => x.protected && x.from <= from - seg.from + 1 && x.to >= to - seg.from - 1);
        out.push({
          severity: 'warning',
          code: 'long-wait',
          message: `the screen of "${seg.scene}" barely changes for ${len.toFixed(1)} s while the scenario waits (${w.label}, ${timecode(from / fps)}–${timecode(to / fps)}): a loading state on screen — speed it up or shorten the wait${protectedSpan ? ' (kept at 1× by a marked step: mark a later step)' : ''}`,
          at: locate(ctx, from),
        });
      }
      // Captions drawn in the caption area (or in their band over the capture): some ink there while a cue is on.
      const region = captionRegion(ctx.plan, seg);
      if (seg.caption && region && seg.caption.params.position !== 'above') {
        const margin = Math.round(0.6 * fps);
        for (const cue of seg.cues) {
          const lo = seg.from + cue.from + margin;
          const hi = Math.min(seg.from + cue.to, span.clearTo) - margin;
          const cands = samples.filter((f) => f >= lo && f < hi).map((f) => input.analyses.get(f)?.captionSd).filter((v): v is number => v !== undefined);
          if (cands.length > 0 && cands.every((sd) => sd < 6)) {
            out.push({ severity: 'warning', code: 'caption-not-visible', message: `the caption "${cue.text}" does not show in the caption area of "${seg.scene}"`, at: locate(ctx, lo) });
          }
        }
      }
    } else {
      // Cards, intro, outro, interstitials: something must be drawn.
      const stats = samples.map((f) => input.analyses.get(f)?.full).filter((s): s is RegionStats => s !== undefined);
      if (stats.length >= 2 && stats.every((s) => s.share >= rules.empty_share || s.sd < rules.uniform_sd)) {
        const file = seg.component.media?.file;
        const message = file
          ? `${seg.kind} "${seg.id}" shows a uniform frame: your file ${'name' in file ? file.name : ''} looks empty (or did not load)`
          : `${seg.kind} "${seg.id}" shows a uniform frame: its component (${seg.component.id}) draws nothing`;
        out.push({ severity: 'warning', code: 'empty-segment', message, at: locate(ctx, span.clearFrom) });
      }
    }
  }
  return out;
}
