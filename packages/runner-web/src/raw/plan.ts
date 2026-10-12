/**
 * Raw capture export for editors (L2.13, R-RAW-01): which frames of a run make each clip — pure and deterministic.
 *
 * One clip per captured scene (one per page of a multi-page scene, all of a scene's pages on the same frames), from
 * the scene's still — the page load before it is never in a clip — to the scene's end, at real time (1×: speeds and
 * waits are the editor's job). Inside a scene, the LOADING is cut (`loadingCuts`): a run of wait steps that really
 * waited, from just after the action that started it (its press and ripple kept) to just after the awaited state was
 * seen — never a step's visible result, a hold, a mark or the opening still. Frames sit on the export grid: frame n
 * shows capture time n / fps, the screencast frame on screen then (never interpolated).
 */
import { fileSlug } from '../util.js';
import type { Timeline, TimelineEvent, TimelineScene, TimelinePageSegment } from '@demo-studio/core';

/** Steps that wait for the product (their waiting is a loading state). */
export const RAW_WAIT_ACTIONS: ReadonlySet<string> = new Set(['wait_for', 'wait_for_email']);

/** Rules of the loading cuts inside a scene. */
export const RAW_CUT = {
  /** A run of wait steps that waited less than this in all shows no loading worth a cut (seconds). */
  min_wait_s: 0.3,
  /**
   * Kept after the step's LAST press (its last click — a widget's option, a menu's item or confirm —, its Enter, the
   * end of its typing) that started the loading: the press and its ripple. A step whose action runs past its recorded
   * presses (a drag's travel and release, repeated keys) is kept whole.
   */
  action_keep_s: 0.3,
  /**
   * The clip resumes once the awaited state is painted: this long after the wait saw it in the page at least — new
   * content reaches the screen up to ≈ 0.2 s after its DOM (the catalogue import: 0.16 s, measured in L1.3 with
   * frames every few ms) —, and `paint_frames` screencast intervals there, at most `paint_max_s` — then on the next
   * screencast frame when one arrived within that margin again (the page was still painting: the frame on screen may
   * be half drawn), so the first frame after the cut is a frame painted after it.
   */
  result_margin_s: 0.2,
  paint_frames: 1.5,
  paint_max_s: 0.3,
  /** A cut shorter than this is not made. */
  min_cut_s: 0.4,
  /**
   * The scene must go on at least this long after a cut (the awaited state on screen): a scene that ends on its
   * awaited state keeps its loading — a cut there would leave the result out of the clip.
   */
  min_tail_s: 0.2,
  /** Steps closer than this follow each other without a pause. */
  contiguous_s: 0.1,
} as const;

/** Why frames were cut inside a scene. */
export type RawCutReason = 'navigation' | 'loading' | 'mail';

/** A loading interval of a scene (capture seconds). */
export interface RawLoading {
  from: number;
  to: number;
  reason: RawCutReason;
  /** The step whose press started the loading (index in its scene), when it is the step right before the waits. */
  after_step?: number;
  /** The wait step whose end is the awaited state. */
  wait_step: number;
  page?: string;
}

/** A cut of a clip: capture time removed and where the clip resumes. */
export interface RawCut extends RawLoading {
  /** Export-grid frames removed [n0, n1). */
  n0: number;
  n1: number;
  /** Clip frame of the first frame after the cut. */
  at: number;
}

/** Where a clip's pictures come from: the main capture or a page's track (multi-page scenes). */
export interface RawSource {
  /** `main` (capture.mp4) or the page id of a track. */
  track: string;
  /** CFR video, relative to the run directory. */
  video: string;
  /** Screencast frame index (one {file, t} per line) and folder, relative to the run directory. */
  frames_index: string;
  frames_dir: string;
  /** Pixels (CSS px × scale). */
  width: number;
  height: number;
  /** CSS px and device scale factor. */
  css_width: number;
  css_height: number;
  scale: number;
}

export interface RawClipPlan {
  /** Position in the clip list (0-based). */
  index: number;
  /** Scene number of the export (1-based, in scenario order) — clips of one scene share it. */
  number: number;
  /** File base name (no extension): `01-request`, `01-request-buyer`. */
  name: string;
  scene: string;
  scene_index: number;
  /** Multi-page scene: the page id (and its label). */
  page?: string;
  label?: string;
  /** The clip on the sequence for its scene (single-page scenes; the first acting page of a multi-page scene). */
  primary: boolean;
  source: RawSource;
  /** Capture seconds [t0, t1) the clip covers (cuts inside). */
  t0: number;
  t1: number;
  /** Kept export-grid frame spans [n0, n1), in order. */
  spans: Array<{ n0: number; n1: number }>;
  /** Total frames (sum of the spans). */
  frames: number;
  cuts: RawCut[];
  caption?: { kicker?: string; text: string };
  status: TimelineScene['status'];
  /** The scene's step and still events (notifications left out). */
  events: TimelineEvent[];
}

export interface RawPlan {
  fps: number;
  clips: RawClipPlan[];
  /** The primary clips in order with their first frame on the sequence (contiguous, from 0). */
  sequence: Array<{ clip: number; start: number }>;
  /** Sequence length in frames. */
  frames: number;
  notes: string[];
  warnings: string[];
}

export interface PlanRawOptions {
  fps: number;
  /** Cut the loading inside scenes (default true). */
  cuts?: boolean;
  /** Screencast frame times of a source (`main` or a track id), sorted — paces the resume after a cut. */
  frameTimes?: (track: string) => readonly number[] | undefined;
}

/** Median interval between the screencast frames within ±0.5 s of t (undefined with fewer than 2 frames there). */
export function localFrameInterval(times: readonly number[] | undefined, t: number): number | undefined {
  if (!times || times.length < 2) return undefined;
  const near = times.filter((x) => x >= t - 0.5 && x <= t + 0.5);
  if (near.length < 2) return undefined;
  const gaps = near.slice(1).map((x, i) => x - near[i]).filter((g) => g > 0).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : undefined;
}

const EPS = 1e-6;
/** First export frame showing capture time t or later. */
export const frameAtOrAfter = (t: number, fps: number): number => Math.max(0, Math.ceil(t * fps - EPS));

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const stepEnd = (e: TimelineEvent) => (e.hold && e.hold.t_end > e.hold.t_start ? Math.max(e.t_end, e.hold.t_end) : e.t_end);
const hasHold = (e: TimelineEvent) => (!!e.hold && e.hold.t_end > e.hold.t_start) || e.action === 'hold';

type PressData = { t_enter?: unknown; t_typed?: unknown; times?: unknown; clicks?: unknown };

/** The press moments a step recorded: its click, each widget click (`data.clicks`), the end of its typing, its Enter. */
export function pressMoments(e: TimelineEvent): number[] {
  const d = (e.data ?? {}) as PressData;
  const out: number[] = [];
  if (typeof e.t_click === 'number') out.push(e.t_click);
  if (Array.isArray(d.clicks)) for (const c of d.clicks as Array<{ t_click?: unknown } | null>) if (c && typeof c.t_click === 'number') out.push(c.t_click);
  if (typeof d.t_typed === 'number') out.push(d.t_typed);
  if (typeof d.t_enter === 'number') out.push(d.t_enter);
  return out.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

/**
 * The moment a step's visible action is over: its LAST press (a select's option click, a menu's confirm, a type's
 * Enter or end of typing — never the click into the field that comes first), else its end. A step whose action runs
 * past what it recorded — a drag (travel, release), repeated key presses, typing whose end was not recorded — ends at
 * its end.
 */
export function actionMoment(e: TimelineEvent): number {
  const d = (e.data ?? {}) as PressData;
  if (e.action === 'drag') return e.t_end;
  if (e.action === 'press' && typeof d.times === 'number' && d.times > 1) return e.t_end;
  if (e.action === 'type' && typeof d.t_typed !== 'number') return e.t_end;
  const m = pressMoments(e);
  return m.length ? Math.min(e.t_end, m[m.length - 1]) : e.t_end;
}

/** First of the sorted times at or after t (undefined when none). */
export function firstAtOrAfter(times: readonly number[] | undefined, t: number): number | undefined {
  if (!times || times.length === 0) return undefined;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (times[m] < t - EPS) lo = m + 1;
    else hi = m;
  }
  return lo < times.length ? times[lo] : undefined;
}

/**
 * The loading intervals of a scene: each run of consecutive wait steps (`wait_for`, `wait_for_email`) on one page that
 * waited ≥ `min_wait_s` in all — a run stops at a marked wait or one with a hold (the moment it waited for is kept). The
 * interval starts `action_keep_s` after the LAST press of the step right before the waits (`actionMoment`: its option
 * click, its Enter, the end of its typing; when that step is contiguous, on the same page, neither marked nor holding)
 * — or at its URL change when that press navigated earlier —, else at the first wait; it ends once the last wait's
 * awaited state is painted (`result_margin_s`, `paint_frames` of the capture's local frame interval, then the next
 * screencast frame when the page was still painting). Never before the opening still's end; never when the scene
 * ends less than `min_tail_s` after it (the result would not be in the clip: `kept` is told). Pure.
 */
export function loadingCuts(
  events: readonly TimelineEvent[],
  opts: {
    stillEnd: number;
    sceneEnd: number;
    pageChanges?: (page: string | undefined) => readonly number[];
    /** Seconds between screencast frames around capture time t on a page (the capture's local frame interval). */
    frameInterval?: (page: string | undefined, t: number) => number | undefined;
    /** Arrival time of the first screencast frame of a page at or after capture time t (undefined: none, or unknown). */
    nextFrame?: (page: string | undefined, t: number) => number | undefined;
    /** A loading that was not cut because the scene ends on its awaited state. */
    kept?: (loading: RawLoading) => void;
  },
): RawLoading[] {
  const steps = events.filter((e) => e.step >= 0 && e.action !== 'notification' && e.status !== 'skipped').sort((a, b) => a.t_start - b.t_start || a.step - b.step);
  const isWait = (e: TimelineEvent) => RAW_WAIT_ACTIONS.has(e.action) && e.status === 'ok' && e.t_end > e.t_start - EPS;
  const out: RawLoading[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!isWait(steps[i])) continue;
    let j = i;
    while (
      j + 1 < steps.length &&
      !steps[j].mark &&
      !hasHold(steps[j]) &&
      isWait(steps[j + 1]) &&
      steps[j + 1].page === steps[i].page &&
      steps[j + 1].t_start - steps[j].t_end <= RAW_CUT.contiguous_s
    ) {
      j++;
    }
    const group = steps.slice(i, j + 1);
    i = j;
    const waited = group.reduce((n, w) => n + Math.max(0, w.t_end - w.t_start), 0);
    if (waited < RAW_CUT.min_wait_s) continue;
    const last = group[group.length - 1];
    let from = group[0].t_start;
    let reason: RawCutReason = group.some((w) => w.action === 'wait_for_email') ? 'mail' : 'loading';
    const prev = steps.indexOf(group[0]) > 0 ? steps[steps.indexOf(group[0]) - 1] : undefined;
    let after: number | undefined;
    if (
      prev &&
      !RAW_WAIT_ACTIONS.has(prev.action) &&
      prev.page === group[0].page &&
      group[0].t_start - stepEnd(prev) <= RAW_CUT.contiguous_s &&
      !hasHold(prev) &&
      !prev.mark
    ) {
      after = prev.step;
      from = Math.min(from, Math.max(prev.t_start, actionMoment(prev) + RAW_CUT.action_keep_s));
      const changes = opts.pageChanges?.(prev.page) ?? [];
      // A URL change after the step's last press (a click into a field or a widget's trigger never navigates it).
      const presses = pressMoments(prev);
      const pressed = presses.length ? presses[presses.length - 1] : prev.t_start;
      const change = changes.find((t) => t >= pressed - EPS && t <= prev.t_end + EPS);
      if (change !== undefined) {
        // A navigation: nothing of the new page (still loading) is kept before the cut.
        reason = 'navigation';
        from = Math.min(from, Math.max(prev.t_start, change));
      }
    }
    from = Math.max(from, opts.stillEnd);
    const interval = opts.frameInterval?.(last.page, last.t_end);
    const margin = Math.max(RAW_CUT.result_margin_s, Math.min(RAW_CUT.paint_max_s, (interval ?? 0) * RAW_CUT.paint_frames));
    let to = last.t_end + margin;
    // Resume on a frame painted after the margin: when the page was still painting (a frame arrived within another
    // margin), the frame on screen at `to` may be half drawn — the next one is not. An idle page sends no frame: its
    // last frame is its final picture, `to` stays.
    const next = opts.nextFrame?.(last.page, to);
    if (next !== undefined && next - to <= margin + EPS) to = next;
    const loading: RawLoading = {
      from: round3(from),
      to: Math.ceil(to * 1000 - EPS) / 1000,
      reason,
      ...(after !== undefined ? { after_step: after } : {}),
      wait_step: last.step,
      ...(last.page !== undefined ? { page: last.page } : {}),
    };
    if (to - from < RAW_CUT.min_cut_s) continue;
    if (opts.sceneEnd - to < RAW_CUT.min_tail_s - EPS) {
      // The scene ends on its awaited state: a cut would end the clip before the result is on screen.
      opts.kept?.(loading);
      continue;
    }
    out.push(loading);
  }
  return out;
}

/** URL changes (segment starts) of a page: the main capture's for single-page scenes, else that page's track. */
function pageChangesOf(timeline: Timeline, scene: TimelineScene): (page: string | undefined) => number[] {
  return (page) => {
    const track = scene.pages && page ? timeline.tracks?.find((t) => t.id === (scene.pages!.find((p) => p.id === page)?.track ?? page)) : undefined;
    const segs: TimelinePageSegment[] = track ? track.pages : timeline.pages;
    // The first segment of a page is where it started being filmed, not a change.
    return segs.slice(1).map((s) => s.t_start);
  };
}

/** The main capture's source (capture.mp4, frames.jsonl, frames/). */
export function mainSource(timeline: Timeline): RawSource {
  const c = timeline.capture;
  return {
    track: 'main',
    video: c.file || 'capture.mp4',
    frames_index: 'frames.jsonl',
    frames_dir: 'frames',
    width: Math.round(c.width * c.scale),
    height: Math.round(c.height * c.scale),
    css_width: c.width,
    css_height: c.height,
    scale: c.scale,
  };
}

/** A page track's source (capture-<id>.mp4, frames-<id>.jsonl, frames-<id>/). */
export function trackSource(timeline: Timeline, id: string): RawSource | undefined {
  const t = timeline.tracks?.find((x) => x.id === id);
  if (!t) return undefined;
  return {
    track: t.id,
    video: t.file,
    frames_index: t.frames_file,
    frames_dir: t.frames_file.replace(/\.jsonl$/, ''),
    width: Math.round(t.width * t.scale),
    height: Math.round(t.height * t.scale),
    css_width: t.width,
    css_height: t.height,
    scale: t.scale,
  };
}

/** Kept spans of [n0, n1) without the removed frame ranges. */
function keptSpans(n0: number, n1: number, removed: ReadonlyArray<{ n0: number; n1: number }>): Array<{ n0: number; n1: number }> {
  const out: Array<{ n0: number; n1: number }> = [];
  let a = n0;
  for (const r of [...removed].sort((x, y) => x.n0 - y.n0)) {
    const b0 = Math.max(n0, r.n0);
    const b1 = Math.min(n1, r.n1);
    if (b1 <= b0) continue;
    if (b0 > a) out.push({ n0: a, n1: b0 });
    a = Math.max(a, b1);
  }
  if (n1 > a) out.push({ n0: a, n1 });
  return out;
}

/** Clip frame showing export-grid frame n (a frame inside a cut maps to the first frame after it); null outside. */
export function clipFrameOfGrid(clip: Pick<RawClipPlan, 'spans' | 'frames'>, n: number): number | null {
  let k = 0;
  for (const s of clip.spans) {
    if (n < s.n0) return k < clip.frames ? k : null;
    if (n < s.n1) return k + (n - s.n0);
    k += s.n1 - s.n0;
  }
  return null;
}

/** Clip frame of capture time t: the first frame showing t or later (inside a cut: the frame after it). */
export function clipFrameAt(clip: Pick<RawClipPlan, 'spans' | 'frames'>, t: number, fps: number): number | null {
  return clipFrameOfGrid(clip, frameAtOrAfter(t, fps));
}

/** Export-grid frame (capture time × fps) of clip frame k. */
export function gridFrameOf(clip: Pick<RawClipPlan, 'spans'>, k: number): number {
  let rest = k;
  for (const s of clip.spans) {
    const len = s.n1 - s.n0;
    if (rest < len) return s.n0 + rest;
    rest -= len;
  }
  const last = clip.spans[clip.spans.length - 1];
  return last ? last.n1 - 1 : 0;
}

/** Two-digit (three past 99) scene number. */
function numberLabel(n: number, total: number): string {
  return String(n).padStart(total > 99 ? 3 : 2, '0');
}

/**
 * Plan the clips of a raw export from a capture timeline: one clip per captured scene (per page of a multi-page
 * scene), its export-grid frames without the page load before its still and, with `cuts`, without its loading. Pure.
 */
export function planRawExport(timeline: Timeline, opts: PlanRawOptions): RawPlan {
  const fps = opts.fps;
  if (!(fps > 0)) throw new Error(`invalid frame rate ${fps}`);
  const cutsOn = opts.cuts !== false;
  const notes: string[] = [];
  const warnings: string[] = [];
  const cap = timeline.capture;
  const end = cap.duration;
  const lastGrid = Math.max(1, Math.round(end * fps));
  const scenes = timeline.scenes.filter((s) => s.kind === 'scene');
  const captured = scenes.filter((s) => s.status !== 'skipped');
  for (const s of scenes) if (s.status === 'skipped') notes.push(`scene "${s.id}" was skipped by the run: no clip`);
  const clips: RawClipPlan[] = [];
  const total = captured.length;
  let number = 0;
  for (const scene of captured) {
    const events = timeline.events
      .filter((e) => e.scene === scene.id && e.scene_index === scene.index && e.action !== 'notification')
      .sort((a, b) => a.t_start - b.t_start || a.step - b.step);
    const open = events.filter((e) => e.action === 'scene_open');
    const still = events.find((e) => e.action === 'scene_still');
    const s0 = still ? still.t_start : open.length ? Math.max(...open.map((e) => e.t_end)) : scene.t_start;
    const s1 = Math.min(scene.t_end, end);
    const n0 = frameAtOrAfter(s0, fps);
    const n1 = Math.min(lastGrid, frameAtOrAfter(s1, fps));
    if (n1 <= n0) {
      warnings.push(`scene "${scene.id}" has nothing to show (capture ${s0.toFixed(2)}–${s1.toFixed(2)} s): no clip`);
      continue;
    }
    if (scene.status === 'failed' || scene.status === 'partial') warnings.push(`scene "${scene.id}" ${scene.status === 'failed' ? 'failed' : 'is partial'} in the run: its clip shows what was captured`);
    if (open.length) notes.push(`"${scene.id}": page load ${Math.min(...open.map((e) => e.t_start)).toFixed(2)}–${s0.toFixed(2)} s of the capture is not in the clip`);
    const stillEnd = still ? still.t_end : s0;
    const trackOf = (page: string | undefined) => (scene.pages ? (scene.pages.find((p) => p.id === page)?.track ?? scene.pages[0]?.track ?? 'main') : 'main');
    const frameInterval = (page: string | undefined, t: number) => localFrameInterval(opts.frameTimes?.(trackOf(page)), t) ?? 1 / cap.fps;
    const nextFrame = (page: string | undefined, t: number) => firstAtOrAfter(opts.frameTimes?.(trackOf(page)), t);
    const kept = (l: RawLoading) =>
      notes.push(
        `"${scene.id}": ${(l.to - l.from).toFixed(2)} s of ${l.reason === 'navigation' ? 'page loading' : l.reason === 'mail' ? 'waiting for the email' : 'loading'} kept (${l.from.toFixed(2)}–${l.to.toFixed(2)} s of the capture): the scene ends on the awaited state of step ${scene.id}.${l.wait_step}, a cut would leave it out of the clip — give that step a \`hold\` to show the result and cut the loading`,
      );
    const loading = cutsOn ? loadingCuts(events, { stillEnd, sceneEnd: s1, pageChanges: pageChangesOf(timeline, scene), frameInterval, nextFrame, kept }) : [];
    const removed = loading.map((l) => ({ n0: frameAtOrAfter(l.from, fps), n1: frameAtOrAfter(l.to, fps) }));
    const spans = keptSpans(n0, n1, removed);
    const frames = spans.reduce((n, s) => n + (s.n1 - s.n0), 0);
    if (frames === 0) {
      warnings.push(`scene "${scene.id}": everything was cut: no clip`);
      continue;
    }
    number++;
    const base = `${numberLabel(number, total)}-${fileSlug(scene.id)}`;
    const pages = scene.pages && scene.pages.length > 0 ? scene.pages : undefined;
    const sources: Array<{ page?: string; label?: string; source: RawSource }> = [];
    if (pages) {
      for (const pg of pages) {
        const src = trackSource(timeline, pg.track);
        if (src) sources.push({ page: pg.id, ...(pg.label !== undefined ? { label: pg.label } : {}), source: src });
        else warnings.push(`scene "${scene.id}": no track for page "${pg.id}" in the run: no clip for it`);
      }
    } else sources.push({ source: mainSource(timeline) });
    if (sources.length === 0) continue;
    // The sequence shows the page of the scene's opening still (the first acting page), the others ride along.
    const actingPage = still?.page ?? pages?.[0]?.id;
    const primaryIdx = pages ? Math.max(0, sources.findIndex((s) => s.page === actingPage)) : 0;
    sources.forEach((s, k) => {
      const cuts: RawCut[] = [];
      let kept = 0;
      let si = 0;
      for (let li = 0; li < loading.length; li++) {
        const r = removed[li];
        const a = Math.max(n0, r.n0);
        const b = Math.min(n1, r.n1);
        if (b <= a) continue;
        while (si < spans.length && spans[si].n1 <= a) {
          kept += spans[si].n1 - spans[si].n0;
          si++;
        }
        cuts.push({ ...loading[li], n0: a, n1: b, at: kept });
      }
      clips.push({
        index: clips.length,
        number,
        name: s.page !== undefined ? `${base}-${fileSlug(s.page)}` : base,
        scene: scene.id,
        scene_index: scene.index,
        ...(s.page !== undefined ? { page: s.page } : {}),
        ...(s.label !== undefined ? { label: s.label } : {}),
        primary: k === primaryIdx,
        source: s.source,
        t0: round3(s0),
        t1: round3(s1),
        spans,
        frames,
        cuts,
        ...(scene.caption ? { caption: scene.caption } : {}),
        status: scene.status,
        events,
      });
    });
    for (const l of loading) {
      notes.push(`"${scene.id}": ${(l.to - l.from).toFixed(2)} s of ${l.reason === 'navigation' ? 'page loading' : l.reason === 'mail' ? 'waiting for the email' : 'loading'} cut (${l.from.toFixed(2)}–${l.to.toFixed(2)} s of the capture, until step ${l.wait_step}'s awaited state)`);
    }
  }
  const sequence: RawPlan['sequence'] = [];
  let at = 0;
  for (const c of clips) {
    if (!c.primary) continue;
    sequence.push({ clip: c.index, start: at });
    at += c.frames;
  }
  if (clips.length === 0) warnings.push('no captured scene: nothing to export');
  return { fps, clips, sequence, frames: at, notes, warnings };
}

/** Sequence start frame of a clip (its scene's primary clip's position; every page of a scene starts together). */
export function sequenceStartOf(plan: RawPlan, clip: RawClipPlan): number {
  const primary = plan.clips.find((c) => c.number === clip.number && c.primary) ?? clip;
  return plan.sequence.find((s) => s.clip === primary.index)?.start ?? 0;
}
