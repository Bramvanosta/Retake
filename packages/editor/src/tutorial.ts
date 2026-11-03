/**
 * Tutorial overlays (L2.10, R-TUT-01…05): the planner part. Pure. From the timeline's events and the switches the
 * runner recorded (scenario → scene → step, `resolveTutorial`), each clip gets its key-cap overlays (press steps,
 * timed on the real key press), its spotlight (the step targets, one overlay per run of steps gliding from target to
 * target), its numbered badges (clicked targets) and its typing loupe (the field of a type step, a live capture
 * region); the whole video gets a chapter progress bar. Everything is anchored in source CSS px and mapped per frame by
 * the composition through layout, camera and reframe.
 */
import { BADGE_ACTIONS, SPOTLIGHT_ACTIONS, TUTORIAL_COMPONENTS, applyTutorial, resolveTutorial, tutorialOff } from '@retake/core';
import type { BBox, ResolvedTutorial, Timeline, TimelineEvent, TimelineScene, TutorialFeatureName, TutorialFeatureState, TutorialSwitch } from '@retake/core';
import type { ReframeTarget } from './camera.js';
import type { OverlayUse, PlanTutorial, ResolvedComponent } from './plan-types.js';
import { round, stepEnd } from './util.js';
import { TRACK_GLIDE_S } from './remotion/frames.js';

/** Timings of the tutorial overlays (seconds). */
export const TUTORIAL_TIMING = {
  /** Key caps appear this long before the key press (the cap goes down on the press). */
  shortcut_lead_s: 0.3,
  /** Key caps stay at least this long when the next press comes sooner. */
  shortcut_min_s: 0.45,
  /** Gap between repeated presses of one step (`press: {times}`), as the runner paces them. */
  shortcut_repeat_s: 0.16,
  /**
   * Spotlight `steps`: from just before the step to just after it (with its hold); a step that clicks ends soon after
   * its (last) click — the click often changes the page, the cut-out must not stay on a target that is gone.
   */
  spotlight_before_s: 0.15,
  spotlight_after_s: 0.25,
  spotlight_after_click_s: 0.45,
  /** Spotlight `clicks`: around each click. */
  spotlight_click_before_s: 0.8,
  spotlight_click_after_s: 0.7,
  /** Two spotlight windows closer than this are one overlay (the hole glides instead of fading out and in). */
  spotlight_join_s: 1,
  /** A spotlight overlay shorter than this is not drawn. */
  spotlight_min_s: 0.6,
  /** The loupe opens this long before the first keystroke and closes this long after the last. */
  loupe_before_s: 0.25,
  loupe_after_s: 0.7,
  /** Widest region a loupe magnifies (source CSS px): a wider field shows its left part (where text starts). */
  loupe_max_css_w: 560,
  /** Two loupes closer than this are one overlay: the lens glides from field to field (type, Tab, type…). */
  loupe_join_s: 0.9,
  /** A step badge pops this long before its click (when the cursor arrives) … */
  badge_before_s: 0.45,
  /** … and stays this long after it (a click often changes the page; the component fades it out at its end). */
  badge_after_s: 1.1,
} as const;

/** Glide between two boxes of an overlay track (output seconds): see remotion/frames.ts `trackBoxAt`. */
export { TRACK_GLIDE_S };

export type ClipTutorialFeature = Exclude<TutorialFeatureName, 'progress'>;

/** Resolves a tutorial overlay use (the planner's ComponentResolver behind it). */
export type TutorialResolve = (feature: TutorialFeatureName, state: TutorialFeatureState, slots: Record<string, string>, where: string) => ResolvedComponent | null;

export interface ClipTutorialInput {
  scene: TimelineScene;
  events: readonly TimelineEvent[];
  /** Capture seconds → output frame relative to the clip (clamped to [0, n]). */
  rel: (t: number) => number;
  /** Content frames of the clip (before any held frames) and its whole length. */
  n: number;
  duration: number;
  fps: number;
  /** Capture size in CSS px (loupe regions stay inside it). */
  css: { w: number; h: number };
  stateOf: (ev: TimelineEvent) => ResolvedTutorial;
  resolve: TutorialResolve;
  /** Running badge number (numbering: video) — the caller keeps it across clips. */
  counter: { video: number };
  /**
   * The badge numbers given beforehand (`planBadgeNumbers`): a multi-page scene plans each page on its own, but its
   * badges are numbered once, in time order over every page. Absent: numbered here, in this call's step order.
   */
  badgeNumbers?: ReadonlyMap<TimelineEvent, BadgeNumber>;
  /** Manifest default duration of a resolved component, seconds. */
  durationOf: (rc: ResolvedComponent) => number | undefined;
  out: PlanTutorial;
  /** Output frame of the clip's first frame in the video (for skipped entries). */
  segmentFrom: number;
}

const fr = (s: number, fps: number) => Math.max(1, Math.round(s * fps));

type Click = { t: number; bbox?: BBox };

/** The clicks of an event: widgets list theirs in `data.clicks` (bbox + t_click); otherwise its target at `t_click`. */
export function eventClicks(ev: TimelineEvent): Click[] {
  const data = ev.data as { clicks?: Array<{ bbox?: BBox; t_click?: number }> } | undefined;
  const list = Array.isArray(data?.clicks) ? data!.clicks.filter((c) => typeof c.t_click === 'number') : [];
  if (list.length > 0) return list.map((c) => ({ t: c.t_click!, ...(c.bbox ? { bbox: c.bbox } : {}) }));
  // A key press, or typing into the focused field, is not a click (a type step clicks only with `into`: `point`).
  if (ev.action === 'press' || (ev.action === 'type' && ev.point === undefined)) return [];
  if (ev.t_click !== undefined) return [{ t: ev.t_click, ...(ev.target?.bbox ? { bbox: ev.target.bbox } : {}) }];
  return [];
}

/** Does a step click its target (a badge)? A type step only when it clicked into a field (`point` recorded). */
function clicksTarget(ev: TimelineEvent): boolean {
  if (!BADGE_ACTIONS.includes(ev.action)) return false;
  if (ev.action === 'type') return ev.point !== undefined && ev.target?.bbox !== undefined;
  return true;
}

const goodBox = (b: BBox | undefined): b is BBox => !!b && b.w > 0 && b.h > 0;

/** A step badge's numbers: in its scene and in the video. */
export interface BadgeNumber {
  scene: number;
  video: number;
}

/** The target box a step's badge sits beside (its target, else its first click's), with that click; null: no badge. */
function badgeTarget(ev: TimelineEvent): { box: BBox; click: Click } | null {
  if (!clicksTarget(ev)) return null;
  const click = eventClicks(ev)[0];
  const box = goodBox(ev.target?.bbox) ? ev.target!.bbox! : click?.bbox;
  return goodBox(box) && click ? { box, click } : null;
}

/**
 * The numbers of a clip's step badges, given in time order over all its events (a multi-page scene: every page's
 * steps — the runner runs them one after the other), the video counter carried on. Same rules as `planClipTutorial`.
 */
export function planBadgeNumbers(events: readonly TimelineEvent[], stateOf: (ev: TimelineEvent) => ResolvedTutorial, counter: { video: number }): Map<TimelineEvent, BadgeNumber> {
  const out = new Map<TimelineEvent, BadgeNumber>();
  const steps = events.filter((e) => e.step >= 0 && e.status !== 'skipped').sort((a, b) => (badgeTarget(a)?.click.t ?? a.t_start) - (badgeTarget(b)?.click.t ?? b.t_start) || a.t_start - b.t_start);
  let n = 0;
  for (const ev of steps) {
    if (!stateOf(ev).steps.on || !badgeTarget(ev)) continue;
    n++;
    counter.video++;
    out.set(ev, { scene: n, video: counter.video });
  }
  return out;
}

/** The effective switches of each event of a run: scenario (or the render override) → scene → step. */
export function tutorialStateOf(video: TutorialSwitch | undefined, override: TutorialSwitch | undefined): (scene: TimelineScene, ev?: TimelineEvent) => ResolvedTutorial {
  if (override === false) return () => tutorialOff();
  const base = applyTutorial(applyTutorial(tutorialOff(), video, 'scenario'), override, 'scenario');
  return (scene, ev) => applyTutorial(applyTutorial(base, scene.tutorial, 'scene'), ev?.tutorial, 'step');
}

/** True when any switch of the timeline (or the override) turns a tutorial overlay on somewhere. */
export function tutorialRequested(timeline: Timeline, override: TutorialSwitch | undefined): boolean {
  if (override === false) return false;
  const on = (sw: TutorialSwitch | undefined) => sw !== undefined && sw !== false && Object.values(resolveTutorial(sw)).some((f) => f.on);
  return on(timeline.video?.tutorial) || on(override) || timeline.scenes.some((s) => on(s.tutorial)) || timeline.events.some((e) => on(e.tutorial));
}

function skip(input: ClipTutorialInput, feature: TutorialFeatureName, ev: TimelineEvent, reason: string): void {
  const k = input.rel(ev.t_start);
  input.out.skipped.push({ feature, scene: input.scene.id, step: ev.step, ...(k < input.n ? { frame: input.segmentFrom + k } : {}), reason });
}

function count(input: ClipTutorialInput, f: TutorialFeatureName): void {
  input.out.uses[f] = (input.out.uses[f] ?? 0) + 1;
}

/** The loupe's region around a field: padded, at most `loupe_max_css_w` wide (its left part), inside the capture. */
export function loupeRegion(field: BBox, css: { w: number; h: number }): BBox {
  const padY = Math.max(6, field.h * 0.22);
  const padX = Math.max(12, Math.min(28, field.h * 0.5));
  let w = Math.min(field.w + 2 * padX, TUTORIAL_TIMING.loupe_max_css_w);
  let h = field.h + 2 * padY;
  w = Math.min(w, css.w);
  h = Math.min(h, css.h);
  const x = Math.min(Math.max(0, field.x - padX), css.w - w);
  const y = Math.min(Math.max(0, field.y - padY), css.h - h);
  return { x: round(x, 2), y: round(y, 2), w: round(w, 2), h: round(h, 2) };
}

/**
 * Whether a step changed its page's URL (a click that navigates): its URL at the end differs from the one the events
 * before it on the same page last recorded. What it pointed at is then gone.
 */
export function stepNavigates(ev: TimelineEvent, events: readonly TimelineEvent[]): boolean {
  if (ev.url === undefined) return false;
  let before: string | undefined;
  for (const e of events) {
    if (e === ev) break;
    if (e.url !== undefined && (e.page === undefined || ev.page === undefined || e.page === ev.page)) before = e.url;
  }
  return before !== undefined && before !== ev.url;
}

/** A step whose click took its page to another URL: what it clicked is gone. */
function clicksAway(ev: TimelineEvent, events: readonly TimelineEvent[]): boolean {
  return ev.action !== 'type' && ev.action !== 'hover' && eventClicks(ev).length > 0 && stepNavigates(ev, events);
}

/** The tutorial overlays of one clip (spotlight first: it is drawn under the others). */
export function planClipTutorial(input: ClipTutorialInput): OverlayUse[] {
  const { events, rel, n, fps } = input;
  const T = TUTORIAL_TIMING;
  const steps = events.filter((e) => e.step >= 0 && e.status !== 'skipped');
  const scene = input.scene.id;
  const out: { spotlight: OverlayUse[]; steps: OverlayUse[]; loupe: OverlayUse[]; shortcuts: OverlayUse[] } = { spotlight: [], steps: [], loupe: [], shortcuts: [] };
  const where = (ev: TimelineEvent, what: string) => `scene "${scene}" step ${ev.step} ${what}`;

  // ── Spotlight: windows per step (or per click), joined into runs whose hole glides from box to box ───────────
  type Win = { t0: number; t1: number; keys: Array<{ t: number; bbox: BBox }>; state: TutorialFeatureState; ev: TimelineEvent };
  const wins: Win[] = [];
  for (const ev of steps) {
    const st = input.stateOf(ev).spotlight;
    if (!st.on) continue;
    if (!SPOTLIGHT_ACTIONS.includes(ev.action)) {
      if (ev.tutorial !== undefined && typeof ev.tutorial === 'object' && ev.tutorial.spotlight) skip(input, 'spotlight', ev, `a ${ev.action} step has no target to spotlight`);
      continue;
    }
    const clicks = eventClicks(ev).filter((c) => goodBox(c.bbox));
    if (st.mode === 'clicks') {
      if (clicks.length === 0) {
        if (ev.action !== 'hover' && ev.action !== 'type') skip(input, 'spotlight', ev, 'no click target box was recorded');
        continue;
      }
      for (const c of clicks) wins.push({ t0: c.t - T.spotlight_click_before_s, t1: c.t + T.spotlight_click_after_s, keys: [{ t: c.t - T.spotlight_click_before_s, bbox: c.bbox! }], state: st, ev });
      continue;
    }
    const box = ev.target?.bbox;
    if (!goodBox(box) && clicks.length === 0) {
      skip(input, 'spotlight', ev, 'no target box was recorded');
      continue;
    }
    const keys: Win['keys'] = [];
    if (clicks.length > 1) clicks.forEach((c, i) => keys.push({ t: i === 0 ? ev.t_start : c.t - TRACK_GLIDE_S, bbox: c.bbox! }));
    else keys.push({ t: ev.t_start, bbox: goodBox(box) ? box : clicks[0].bbox! });
    const typed = (ev.data as { t_typed?: number } | undefined)?.t_typed;
    const lastClick = clicks.length > 0 && ev.action !== 'type' && ev.action !== 'hover' ? clicks[clicks.length - 1].t : undefined;
    const t1 = lastClick !== undefined ? Math.min(stepEnd(ev), lastClick + T.spotlight_after_click_s) : typed !== undefined ? typed + T.spotlight_after_s : stepEnd(ev) + T.spotlight_after_s;
    wins.push({ t0: ev.t_start - T.spotlight_before_s, t1, keys, state: st, ev });
  }
  wins.sort((a, b) => a.t0 - b.t0);
  const runs: Win[][] = [];
  for (const w of wins) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    // A click that navigated ends its run: the hole must not stay on a target of the page that is gone (it fades out
    // after the click; the next step's spotlight fades in on the new page). Typing + Enter keeps it (a search field
    // usually stays where it was).
    const gone = prev !== undefined && prev.ev !== w.ev && clicksAway(prev.ev, events);
    if (prev && !gone && w.t0 - prev.t1 <= T.spotlight_join_s && JSON.stringify(prev.state) === JSON.stringify(w.state)) last.push(w);
    else runs.push([w]);
  }
  for (const run of runs) {
    const first = run[0];
    const from = rel(first.t0);
    const to = Math.min(n, rel(Math.max(...run.map((w) => w.t1))));
    if (to - from < T.spotlight_min_s * fps) continue;
    const rc = input.resolve('spotlight', first.state, {}, where(first.ev, 'spotlight'));
    if (!rc) continue;
    const track = run
      .flatMap((w) => w.keys)
      .map((k) => ({ at: Math.max(0, rel(k.t) - from), bbox: { ...k.bbox } }))
      .filter((k, i, all) => i === 0 || JSON.stringify(k.bbox) !== JSON.stringify(all[i - 1].bbox));
    track[0].at = 0;
    out.spotlight.push({ component: rc, from, durationInFrames: to - from, scene, step: first.ev.step, anchor: { bbox: { ...track[0].bbox } }, tutorial: 'spotlight', layer: 'screen', ...(track.length > 1 ? { track } : {}) });
    count(input, 'spotlight');
  }

  // ── Numbered badges next to clicked targets ──────────────────────────────────────────────────────────────────
  const numbers = input.badgeNumbers ?? planBadgeNumbers(steps, input.stateOf, input.counter);
  for (const ev of steps) {
    const st = input.stateOf(ev).steps;
    if (!st.on) continue;
    if (!clicksTarget(ev)) {
      if (ev.tutorial !== undefined && typeof ev.tutorial === 'object' && ev.tutorial.steps) skip(input, 'steps', ev, `a ${ev.action} step clicks no target`);
      continue;
    }
    const bt = badgeTarget(ev);
    const num = numbers.get(ev);
    if (!bt || !num) {
      skip(input, 'steps', ev, 'no clicked target box was recorded');
      continue;
    }
    const { box, click } = bt;
    const numbering = st.params.numbering === 'video' ? 'video' : 'scene';
    const number = numbering === 'video' ? num.video : num.scene;
    const at = rel(click.t);
    if (at >= n) continue;
    // From when the cursor arrives (never before the step starts) to a little after the click.
    const from = Math.min(at, Math.max(rel(ev.t_start), rel(click.t - T.badge_before_s)));
    const rc = input.resolve('steps', st, { number: String(number) }, where(ev, 'badge'));
    if (!rc) continue;
    // The resolved component may number by video even when the scenario did not say so (its own default).
    if (rc.params.numbering === 'video' && numbering !== 'video') rc.slots.number = String(num.video);
    // After a click that navigates, the badge leaves with the page (as the spotlight does).
    const after = clicksAway(ev, events) ? T.spotlight_after_click_s : T.badge_after_s;
    const frames = Math.min(at - from + fr(after, fps), input.duration - from);
    out.steps.push({ component: rc, from, durationInFrames: Math.max(1, frames), scene, step: ev.step, anchor: { bbox: { ...box } }, tutorial: 'steps', moment: at - from });
    count(input, 'steps');
  }

  // ── Typing loupe: the field of a type step, from the first keystroke to just after the last; consecutive ones
  // (type, Tab, type…) are one overlay whose lens glides from field to field ──────────────────────────────────────
  type Lw = { t0: number; t1: number; region: BBox; ev: TimelineEvent; state: TutorialFeatureState; typeAt: number };
  const lws: Lw[] = [];
  for (const ev of steps) {
    const st = input.stateOf(ev).loupe;
    if (!st.on) continue;
    if (ev.action !== 'type') {
      if (ev.tutorial !== undefined && typeof ev.tutorial === 'object' && ev.tutorial.loupe) skip(input, 'loupe', ev, `a ${ev.action} step types nothing`);
      continue;
    }
    const field = ev.target?.bbox;
    if (!goodBox(field)) {
      skip(input, 'loupe', ev, 'the focused field was not recorded');
      continue;
    }
    const d = (ev.data ?? {}) as { t_type?: number; t_typed?: number };
    const typeAt = d.t_type ?? ev.t_click ?? ev.t_start;
    // Closes after the last keystroke, before the next step that is not a key press starts (its cursor may go under the lens).
    const next = steps.find((x) => x.t_start >= ev.t_end - 1e-3 && x !== ev && x.action !== 'press');
    const t1 = Math.min((d.t_typed ?? ev.t_end) + T.loupe_after_s, next ? Math.max(d.t_typed ?? ev.t_end, next.t_start) + 0.15 : Infinity);
    lws.push({ t0: typeAt - T.loupe_before_s, t1, region: loupeRegion(field, input.css), ev, state: st, typeAt });
  }
  const lruns: Lw[][] = [];
  for (const w of lws) {
    const last = lruns[lruns.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && w.typeAt - prev.typeAt > 0 && w.t0 - prev.t1 <= T.loupe_join_s && JSON.stringify(prev.state) === JSON.stringify(w.state)) last.push(w);
    else lruns.push([w]);
  }
  for (const run of lruns) {
    const first = run[0];
    const from = rel(first.t0);
    const to = Math.min(n, rel(run[run.length - 1].t1));
    if (to - from < fr(0.5, fps)) continue;
    const rc = input.resolve('loupe', first.state, {}, where(first.ev, 'loupe'));
    if (!rc) continue;
    const track = run.map((w, i) => ({ at: i === 0 ? 0 : Math.max(0, rel(w.typeAt - TRACK_GLIDE_S) - from), bbox: { ...w.region } }));
    out.loupe.push({
      component: rc,
      from,
      durationInFrames: to - from,
      scene,
      step: first.ev.step,
      anchor: { bbox: { ...first.region } },
      region: { ...first.region },
      ...(track.length > 1 ? { track } : {}),
      tutorial: 'loupe',
      moment: Math.max(0, rel(first.typeAt) - from),
    });
    count(input, 'loupe');
  }

  // ── Key caps of press steps (and the Enter of a type step), timed on the key press ──────────────────────────
  type Press = { ev: TimelineEvent; t: number; keys: string; times: number; state: TutorialFeatureState };
  const presses: Press[] = [];
  for (const ev of steps) {
    const st = input.stateOf(ev).shortcuts;
    if (!st.on) continue;
    const data = (ev.data ?? {}) as { key?: string; times?: number; t_enter?: number };
    if (ev.action === 'press') {
      if (!data.key) {
        skip(input, 'shortcuts', ev, 'the key was not recorded');
        continue;
      }
      presses.push({ ev, t: ev.t_click ?? ev.t_start, keys: data.key, times: Math.max(1, data.times ?? 1), state: st });
    } else if (ev.action === 'type' && typeof data.t_enter === 'number') {
      presses.push({ ev, t: data.t_enter, keys: 'Enter', times: 1, state: st });
    } else if (ev.tutorial !== undefined && typeof ev.tutorial === 'object' && ev.tutorial.shortcuts) {
      skip(input, 'shortcuts', ev, `a ${ev.action} step presses no key`);
    }
  }
  presses.sort((a, b) => a.t - b.t);
  presses.forEach((p) => {
    const lead = fr(T.shortcut_lead_s, fps);
    const pressAt = rel(p.t);
    if (pressAt >= n) return;
    const from = Math.max(0, pressAt - lead);
    const slots: Record<string, string> = { keys: p.keys };
    if (p.times > 1) slots.times = String(p.times);
    const rc = input.resolve('shortcuts', p.state, slots, where(p.ev, 'shortcut'));
    if (!rc) return;
    const seconds = (input.durationOf(rc) ?? 1.8) + (p.times - 1) * T.shortcut_repeat_s;
    const frames = Math.min(fr(seconds, fps) + (pressAt - from), input.duration - from);
    out.shortcuts.push({ component: rc, from, durationInFrames: Math.max(1, frames), scene, step: p.ev.step, tutorial: 'shortcuts', moment: pressAt - from });
    count(input, 'shortcuts');
  });
  // A press that comes before the previous caps left: the previous ones leave as the next ones come.
  for (let i = 0; i + 1 < out.shortcuts.length; i++) {
    const a = out.shortcuts[i];
    const b = out.shortcuts[i + 1];
    if (a.from + a.durationInFrames > b.from) a.durationInFrames = Math.max(fr(T.shortcut_min_s, fps), b.from - a.from + fr(0.15, fps));
  }
  return [...out.spotlight, ...out.steps, ...out.loupe, ...out.shortcuts];
}

/**
 * What the reframe of a vertical / square clip must keep in view for the tutorial overlays: the loupe's field while it
 * shows, each badge's target while it shows, the spotlight's targets (soft: step targets already guide the reframe).
 */
export function tutorialReframeTargets(events: readonly TimelineEvent[], stateOf: (ev: TimelineEvent) => ResolvedTutorial): ReframeTarget[] {
  const T = TUTORIAL_TIMING;
  const out: ReframeTarget[] = [];
  for (const ev of events) {
    if (ev.step < 0) continue;
    const st = stateOf(ev);
    const label = `${ev.scene} step ${ev.step}`;
    if (st.loupe.on && ev.action === 'type' && goodBox(ev.target?.bbox)) {
      const d = (ev.data ?? {}) as { t_type?: number; t_typed?: number };
      out.push({ t0: (d.t_type ?? ev.t_start) - T.loupe_before_s, t1: (d.t_typed ?? ev.t_end) + T.loupe_after_s, box: { ...ev.target!.bbox! }, hard: true, label: `${label} loupe` });
    }
    if (st.steps.on && clicksTarget(ev)) {
      const c = eventClicks(ev)[0];
      const box = goodBox(ev.target?.bbox) ? ev.target!.bbox! : c?.bbox;
      if (c && goodBox(box)) out.push({ t0: c.t, t1: c.t + 1, box: { ...box }, hard: true, label: `${label} badge` });
    }
    if (st.spotlight.on && SPOTLIGHT_ACTIONS.includes(ev.action) && goodBox(ev.target?.bbox)) {
      out.push({ t0: ev.t_start, t1: stepEnd(ev), box: { ...ev.target!.bbox! }, label: `${label} spotlight` });
    }
  }
  return out;
}

/** The built-in component of a feature (re-exported for messages and tests). */
export const tutorialComponent = (f: TutorialFeatureName): string => TUTORIAL_COMPONENTS[f];

/**
 * The chapter progress bar (R-TUT-05): over every segment between the intro and the outro; chapters = each captured
 * scene and card (`scenes`; an interstitial belongs to the chapter before it), or each card and what follows it
 * (`cards`; what comes before the first card is a chapter too). Labels: the scene caption's kicker (else its text, else
 * the id), the card's kicker / title.
 */
export function planProgress(opts: {
  segments: readonly import('./plan-types.js').PlanSegment[];
  timeline: Timeline;
  state: TutorialFeatureState;
  resolve: TutorialResolve;
}): import('./plan-types.js').PlanProgress | null {
  const segs = opts.segments.filter((s) => s.kind !== 'intro' && s.kind !== 'outro');
  if (segs.length === 0) return null;
  const outro = opts.segments.find((s) => s.kind === 'outro');
  const from = segs[0].from;
  const last = segs[segs.length - 1];
  const end = outro ? outro.from + (outro.transition?.kind === 'crossfade' ? outro.transition.frames : 0) : last.from + last.durationInFrames;
  const durationInFrames = Math.max(1, end - from);
  const mode = opts.state.mode === 'cards' ? 'cards' : 'scenes';
  const label = (s: (typeof segs)[number]): string | undefined => {
    const ts = opts.timeline.scenes.find((x) => x.id === s.id);
    if (s.kind === 'card') return s.component.slots.kicker ?? s.component.slots.title ?? ts?.card?.slots?.kicker ?? s.id;
    if (s.kind === 'clip') return ts?.caption?.kicker ?? ts?.caption?.text ?? s.id;
    return undefined;
  };
  const starts = segs.filter((s, i) => (mode === 'cards' ? i === 0 || s.kind === 'card' : s.kind === 'clip' || s.kind === 'card' || i === 0));
  const chapters = starts.map((s, i) => {
    const next = starts[i + 1];
    const a = Math.max(0, s.from - from);
    const b = next ? next.from - from : durationInFrames;
    const l = label(s);
    return { id: s.id, ...(l ? { label: l } : {}), from: a, to: Math.max(a + 1, b) };
  });
  const rc = opts.resolve('progress', opts.state, {}, 'the progress bar');
  if (!rc) return null;
  return { component: rc, from, durationInFrames, mode, chapters };
}
