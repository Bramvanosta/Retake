/**
 * Moments and boxes of a capture's steps that the planner and its callers share: when a marked step is done, when a
 * step overlay starts, and what the reframe of a vertical / square clip keeps in view.
 */
import type { Timeline, TimelineEvent } from '@retake/core/model';
import type { ReframeTarget } from '../camera.js';
import { stepEnd } from '../util.js';
import { REFRAME_CLICK_WINDOW_S } from './rules.js';

type ClickData = { bbox?: { x: number; y: number; w: number; h: number }; t_click?: number };

/** The centre of a box. */
export function centre(b: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * Capture time of "the screen once the marked step is done": within its hold (0.8 s in, or half a shorter hold), else
 * 0.25 s after the step's end — still inside its scene. A timeline marker sits at the step's start (DESIGN §timeline);
 * for a marked wait this is the awaited state, which story-card frames (`frame: mark:<name>`) and the review's key
 * frame of the marker show.
 */
export function markDoneAt(timeline: Pick<Timeline, 'events' | 'scenes' | 'capture'>, mk: { scene: string; step: number; t: number }): number {
  const ev = timeline.events.find((e) => e.scene === mk.scene && e.step === mk.step);
  const sc = timeline.scenes.find((x) => x.id === mk.scene && x.kind === 'scene');
  const end = sc ? sc.t_end - 1 / timeline.capture.fps : timeline.capture.duration;
  if (!ev) return mk.t;
  if (ev.hold && ev.hold.t_end > ev.hold.t_start) return Math.min(ev.hold.t_start + Math.min(0.8, (ev.hold.t_end - ev.hold.t_start) / 2), end);
  return Math.min(ev.t_end + 0.25, end);
}

/**
 * When a step overlay starts (capture s; L2.12 `at`): the end of the step (default), its start, its click, a mark of
 * the run, or seconds after the step starts. `fallback` says why a requested start was not used (the end of the step
 * then): the step recorded no click, no such mark, or the mark (at `markT`) lies outside `clip`. Shared by the planner
 * (where the overlay shows) and the reframe (what it keeps in view meanwhile).
 */
export function overlayStartAt(
  ev: TimelineEvent,
  markers: ReadonlyArray<{ name: string; t: number }>,
  clip?: { s0: number; s1: number },
): { t: number; fallback?: 'no-click' | 'no-mark' | 'outside-clip'; markT?: number } {
  const at = ev.overlay?.at;
  if (at === 'start') return { t: ev.t_start };
  if (at === 'click') {
    const clicks = (ev.data as { clicks?: Array<{ t_click?: number }> } | undefined)?.clicks;
    const tc = ev.t_click ?? clicks?.find((c) => typeof c.t_click === 'number')?.t_click;
    return tc === undefined ? { t: ev.t_end, fallback: 'no-click' } : { t: tc };
  }
  if (typeof at === 'number') return { t: ev.t_start + at };
  if (typeof at === 'string' && at.startsWith('mark:')) {
    const mk = markers.find((m) => m.name === at.slice(5));
    if (!mk) return { t: ev.t_end, fallback: 'no-mark' };
    if (clip && (mk.t < clip.s0 || mk.t >= clip.s1)) return { t: ev.t_end, fallback: 'outside-clip', markT: mk.t };
    return { t: mk.t };
  }
  return { t: ev.t_end };
}

/** What the reframe keeps in view for a step overlay: a box of the page (CSS px) over capture seconds [t0, t1]. */
export interface OverlayKeep {
  t0: number;
  t1: number;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * The overlay keep of a step without the planner's knowledge (its resolved component, the file's length, the time
 * map): from its start (`overlayStartAt`, marks unknown) for its `duration` (default 2.5 s) of capture time; its `rect`,
 * the box around the cursor (`anchor: cursor`), or its target — nothing for a file placed on the screen (a corner, a
 * side, the centre, the whole screen: it follows the view).
 */
export function defaultOverlayKeep(ev: TimelineEvent): OverlayKeep | null {
  const o = ev.overlay;
  if (!o) return null;
  const t0 = overlayStartAt(ev, []).t;
  const t1 = t0 + (o.duration ?? 2.5);
  const anchor = o.box?.anchor;
  if (o.box?.rect) return { t0, t1, box: { ...o.box.rect } };
  if (anchor === 'cursor') {
    const p = o.point ?? (o.bbox ? centre(o.bbox) : undefined);
    return p ? { t0, t1, box: { x: p.x - 1, y: p.y - 1, w: 2, h: 2 } } : null;
  }
  if (anchor !== undefined && anchor !== 'target') return null;
  return o.bbox ? { t0, t1, box: { ...o.bbox } } : null;
}

/**
 * What the reframe of a vertical / square clip keeps in view (camera.ts `reframeTrack`): each step's target over the
 * step (soft), each click's target around the click (hard: never cut — widgets list every click of a select / date
 * pick in `data.clicks`), camera targets (soft) and step overlays while they show (hard; `overlayKeep` — the planner
 * passes what it planned: the overlay's real start, length and box; default `defaultOverlayKeep`).
 */
export function reframeTargets(events: readonly TimelineEvent[], overlayKeep: (ev: TimelineEvent) => OverlayKeep | null = defaultOverlayKeep): ReframeTarget[] {
  const out: ReframeTarget[] = [];
  const W = REFRAME_CLICK_WINDOW_S;
  for (const ev of events) {
    if (ev.step < 0) continue;
    const label = `${ev.scene} step ${ev.step}`;
    const end = stepEnd(ev);
    const box = ev.target?.bbox;
    if (box && box.w > 0 && box.h > 0) out.push({ t0: ev.t_start, t1: end, box: { ...box }, label });
    const data = ev.data as { clicks?: ClickData[] } | undefined;
    const clicks = Array.isArray(data?.clicks) ? data!.clicks.filter((c) => c.bbox && typeof c.t_click === 'number') : [];
    let prev = ev.t_start;
    for (const c of clicks) {
      out.push({ t0: prev, t1: Math.min(end, c.t_click! + W.after), box: { ...c.bbox! }, label: `${label} click` });
      out.push({ t0: c.t_click! - W.before, t1: c.t_click! + W.after, box: { ...c.bbox! }, hard: true, label: `${label} click` });
      prev = c.t_click!;
    }
    if (clicks.length === 0 && box && ev.t_click !== undefined) out.push({ t0: ev.t_click - W.before, t1: ev.t_click + W.after, box: { ...box }, hard: true, label: `${label} click` });
    if (ev.camera?.bbox) out.push({ t0: ev.t_start, t1: end, box: { ...ev.camera.bbox }, label: `${label} camera` });
    const keep = ev.overlay ? overlayKeep(ev) : null;
    if (keep) out.push({ t0: keep.t0, t1: keep.t1, box: { ...keep.box }, hard: true, label: `${label} overlay` });
  }
  return out;
}
