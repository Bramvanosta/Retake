/**
 * Output-time geometry of a plan (pure): the visible span of every segment, the transition windows, the segment /
 * step at a frame, the output frame where a capture frame is shown, mean clip speeds.
 */
import { transitionWindows } from '@demo-studio/editor';
import type { ClipSegment, EditPlan, PlanSegment, StepSpan } from '@demo-studio/editor';

export interface SegmentSpan {
  index: number;
  segment: PlanSegment;
  /** Output frames [from, to): to = the next segment's start (the end of the video for the last one). */
  from: number;
  to: number;
  /** First frame no longer covered by the entering transition / fade, and the frame where the exiting one starts. */
  clearFrom: number;
  clearTo: number;
}

export interface TransitionSpan {
  /** Output frames [from, to). */
  from: number;
  to: number;
  kind: 'crossfade' | 'fade-black' | 'fade';
  /** Segment ids on each side (`before` absent for a fade-in of the first segment). */
  before?: string;
  after?: string;
}

export function isClip(s: PlanSegment): s is ClipSegment {
  return s.kind === 'clip';
}

export function segmentLabel(s: PlanSegment): string {
  if (s.kind === 'clip') return s.scene;
  if (s.kind === 'card') return `card ${s.id}`;
  return s.id;
}

/** The transitions and plain fades of a plan, in output frames. */
export function transitionSpans(plan: Pick<EditPlan, 'segments'>): TransitionSpan[] {
  const out: TransitionSpan[] = [];
  plan.segments.forEach((seg, i) => {
    const w = transitionWindows(plan, i);
    if (w.entering) {
      const prev = plan.segments[i - 1];
      if (w.entering.kind === 'crossfade') out.push({ from: seg.from + w.entering.from, to: seg.from + w.entering.to, kind: 'crossfade', before: prev?.id, after: seg.id });
      else {
        // A dip: the outgoing half lives in the previous segment, the incoming half here.
        const half = Math.floor(w.entering.frames / 2);
        out.push({ from: seg.from - half, to: seg.from + w.entering.to, kind: 'fade-black', before: prev?.id, after: seg.id });
      }
    } else if (seg.fadeIn.frames > 0 && !seg.transition?.component) {
      out.push({ from: seg.from, to: seg.from + seg.fadeIn.frames, kind: 'fade', before: plan.segments[i - 1]?.id, after: seg.id });
    }
    const next = plan.segments[i + 1];
    if (!w.exiting && seg.fadeOut.frames > 0 && !(next?.transition?.component)) {
      const end = seg.from + seg.durationInFrames;
      out.push({ from: end - seg.fadeOut.frames, to: end, kind: 'fade', before: seg.id, after: next?.id });
    }
  });
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Visible span of every segment: [from, next.from) — with a crossfade the overlap is counted with the incoming one. */
export function segmentSpans(plan: Pick<EditPlan, 'segments' | 'durationInFrames'>): SegmentSpan[] {
  const spans = transitionSpans(plan);
  return plan.segments.map((segment, index) => {
    const next = plan.segments[index + 1];
    const from = segment.from;
    const to = Math.max(from, Math.min(next ? next.from : segment.from + segment.durationInFrames, plan.durationInFrames));
    let clearFrom = from;
    let clearTo = to;
    for (const t of spans) {
      if (t.after === segment.id && t.from <= from + 1 && t.to > clearFrom) clearFrom = Math.min(to, t.to);
      if (t.before === segment.id && t.to >= to - 1 && t.from < clearTo) clearTo = Math.max(clearFrom, t.from);
    }
    return { index, segment, from, to, clearFrom, clearTo };
  });
}

/** The span of the segment shown at `frame` (the incoming one during a crossfade). */
export function spanAt(spans: SegmentSpan[], frame: number): SegmentSpan | undefined {
  let found: SegmentSpan | undefined;
  for (const s of spans) if (s.from <= frame) found = s;
  return found && frame < Math.max(found.to, found.from + 1) ? found : spans[spans.length - 1];
}

/** The transition covering `frame`, if any. */
export function transitionAt(spans: TransitionSpan[], frame: number): TransitionSpan | undefined {
  return spans.find((t) => frame >= t.from && frame < t.to);
}

/** The step span of a clip at relative frame `rel` (the last one that starts at or before it). */
export function stepAt(clip: Pick<ClipSegment, 'steps'>, rel: number): StepSpan | undefined {
  let found: StepSpan | undefined;
  for (const s of clip.steps) if (s.from <= rel && rel < s.to) found = s;
  return found;
}

/**
 * The relative output frame of a clip where capture frame `src` is first shown (within `tolerance` frames), or
 * undefined when the clip never shows it (trimmed, or outside the clip's source range).
 */
export function outputFrameOf(clip: Pick<ClipSegment, 'srcFrames'>, src: number, tolerance = 2): number | undefined {
  const f = clip.srcFrames;
  // srcFrames is non-decreasing: binary search for the first frame ≥ src.
  let lo = 0;
  let hi = f.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid] < src) lo = mid + 1;
    else hi = mid;
  }
  if (lo < f.length && f[lo] - src <= tolerance) return lo;
  if (lo > 0 && src - f[lo - 1] <= tolerance && lo - 1 < f.length) return lo - 1;
  return undefined;
}

/** Mean playback speed of a clip over [from, to) relative frames (held frames and speed-0 spans excluded). */
export function meanSpeed(clip: Pick<ClipSegment, 'speeds' | 'durationInFrames' | 'heldFrames'>, from = 0, to = clip.durationInFrames - clip.heldFrames): number {
  let frames = 0;
  let src = 0;
  for (const s of clip.speeds) {
    const a = Math.max(from, s.from);
    const b = Math.min(to, s.to);
    if (b <= a || (s.speed === 0 && s.to_speed === 0)) continue;
    const len = s.to - s.from;
    const at = (x: number) => (len > 0 ? s.speed + ((s.to_speed - s.speed) * (x - s.from)) / len : s.speed);
    frames += b - a;
    src += ((at(a) + at(b)) / 2) * (b - a);
  }
  return frames > 0 ? src / frames : 1;
}

export const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** "01:05.3" */
export function timecode(seconds: number, digits = 1): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = rest.toFixed(digits).padStart(digits > 0 ? 3 + digits : 2, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}
