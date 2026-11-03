/**
 * The Studio timeline's model (L4.5, R-UI-23 / R-UI-24): the tracks of an EditPlan as absolute output frames — the
 * segments (with their component, transition and same-page joins), the captions, the steps, the camera zooms, the
 * speed spans, the cuts (the planner's trims, and any other jump of the time map, each with its reason: idle, a held
 * page load, a frozen screen, a busy wait, a hook step), the markers —
 * and the comment pins placed on them. Pure: the plan (and, for the cuts' reasons, the run's timeline) in, a small model
 * out (no per-frame arrays: a 4-minute plan's model stays a few kilobytes).
 *
 * Text the scenario or the filmed product wrote (caption text, marker names, step labels, page labels) is only under
 * `untrusted`, by index or key; everything else is numbers, ids (slugs) and component ids.
 */
import type { Timeline } from '@retake/core';
import type { EditPlan, PlanSegment, ResolvedComponent } from './plan-types.js';

/** A component use as the timeline shows it (where it came from: the theme, the scenario, an override). */
export interface TimelineComponent {
  id: string;
  kind: ResolvedComponent['kind'];
  source: ResolvedComponent['source'];
  missing?: true;
}

export interface TimelineSegment {
  index: number;
  /** Plan segment id: "intro", a scene id, "card-2"… */
  id: string;
  kind: PlanSegment['kind'];
  /** Output frames [from, to) (a crossfade's overlap with the next segment included). */
  from: number;
  to: number;
  /** Clips: the scene id. */
  scene?: string;
  component: TimelineComponent;
  /** The transition into it (absent: the first segment, or a same-page join). */
  transition?: { kind: string; frames: number; component: string | null };
  /** A clip that continues the previous one on the same page (no transition, the camera continues). */
  joined?: true;
  /** Clips: the caption component (null: captions off for this clip). */
  caption?: TimelineComponent | null;
  /** Multi-page clips (L2.11): the page ids in the layout's order (labels under untrusted.pages). */
  pages?: string[];
  /** Cards and interstitials: the words of their text and the seconds they need (R-FLD-03). */
  reading?: { words: number; seconds: number };
}

export interface TimelineStep {
  from: number;
  to: number;
  scene: string;
  /** 0-based index in its scene. */
  step: number;
  step_id?: string;
  action: string;
  /** "<scene>.<step>": its label is untrusted.steps[key]. */
  key: string;
}

export interface TimelineZoom {
  /** Zoom-in starts, eased in until `in_to`; eases out from `out_from` to `to`. */
  from: number;
  in_to: number;
  out_from: number;
  to: number;
  zoom: number;
  requested_zoom?: number;
  source: 'hint' | 'theme';
  scene: string;
  step: number;
  key: string;
  /** Multi-page clips: the page's pane index. */
  pane?: number;
}

export interface TimelineSpeed {
  from: number;
  to: number;
  speed: number;
  to_speed: number;
  protected?: true;
  scene: string;
}

/** Why capture time jumps at a cut (from the run's timeline; `gap` when it cannot be told). */
export type CutReason = 'idle' | 'loading' | 'frozen' | 'busy' | 'hook' | 'gap';

export interface TimelineCut {
  /** Output frame where capture time jumps over [src_from_s, src_to_s). */
  at: number;
  src_from_s: number;
  src_to_s: number;
  scene: string;
  reason: CutReason;
}

export interface TimelineMarker {
  frame: number;
  done?: number;
  scene: string;
  step?: number;
  /** Its name is untrusted.markers[i]. */
  i: number;
}

export interface TimelineCaption {
  from: number;
  to: number;
  scene: string;
  /** Its text is untrusted.captions[i]. */
  i: number;
}

export interface TimelineModel {
  fps: number;
  frames: number;
  width: number;
  height: number;
  variant: EditPlan['variant'];
  segments: TimelineSegment[];
  captions: TimelineCaption[];
  steps: TimelineStep[];
  camera: TimelineZoom[];
  speed: TimelineSpeed[];
  cuts: TimelineCut[];
  markers: TimelineMarker[];
  untrusted: {
    captions: Array<{ kicker?: string; text: string }>;
    markers: string[];
    /** Step labels by "<scene>.<step>" (given by the caller: today's file or the run's snapshot). */
    steps: Record<string, string>;
    /** Page labels of multi-page clips by "<scene>.<page>". */
    pages: Record<string, string>;
  };
}

export interface TimelineOptions {
  /** Step labels by "<scene>.<step>" (core scenarioBlocks of the file matching the plan). */
  labels?: Record<string, string>;
  /** The run's timeline: the reason of each cut (page load, frozen screen, busy wait, hook). */
  timeline?: Pick<Timeline, 'idle' | 'loading' | 'stalls' | 'busy' | 'events'>;
}

const componentOf = (rc: ResolvedComponent): TimelineComponent => ({ id: rc.id, kind: rc.kind, source: rc.source, ...(rc.missing ? { missing: true as const } : {}) });

/** A jump of more than half a frame of source time between two pieces of the time map. */
const JUMP_EPS_S = 1e-3;

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * What the run's timeline says the skipped capture time was, for a jump the planner did not record a reason for: a
 * page load, a frozen screen, a busy wait or a hook covering any of it (the one covering most), else idle time, else
 * `gap`. Idle spans overlap page loads (a load is idle input time), so idle never wins over a more specific reason.
 */
export function reasonOf(src0: number, src1: number, t: TimelineOptions['timeline']): CutReason {
  if (!t) return 'gap';
  const spans: Array<[CutReason, Array<{ t_start: number; t_end: number }>]> = [
    ['loading', [...(t.loading ?? []), ...t.events.filter((e) => e.action === 'scene_open')]],
    ['frozen', t.stalls ?? []],
    ['busy', t.busy ?? []],
    ['hook', t.events.filter((e) => e.action === 'hook')],
  ];
  let best: CutReason = 'gap';
  let most = 0;
  for (const [reason, list] of spans) {
    const covered = list.reduce((n, s) => n + overlap(src0, src1, s.t_start, s.t_end), 0);
    if (covered > most + 1e-6) {
      most = covered;
      best = reason;
    }
  }
  if (best !== 'gap') return best;
  return (t.idle ?? []).some((s) => overlap(src0, src1, s.t_start, s.t_end) > 1e-6) ? 'idle' : 'gap';
}

/** The timeline model of a plan (see the module comment). */
export function timelineOf(plan: EditPlan, opts: TimelineOptions = {}): TimelineModel {
  const segments: TimelineSegment[] = [];
  const steps: TimelineStep[] = [];
  const camera: TimelineZoom[] = [];
  const speed: TimelineSpeed[] = [];
  const cuts: TimelineCut[] = [];
  const pages: Record<string, string> = {};
  const sorted = [...plan.segments].sort((a, b) => a.from - b.from);
  sorted.forEach((s, index) => {
    const prev = sorted[index - 1];
    const seg: TimelineSegment = {
      index,
      id: s.id,
      kind: s.kind,
      from: s.from,
      to: s.from + s.durationInFrames,
      component: componentOf(s.component),
      ...(s.transition ? { transition: { kind: s.transition.kind, frames: s.transition.frames, component: s.transition.component?.id ?? null } } : {}),
    };
    if (s.kind === 'card' || s.kind === 'interstitial') {
      if (s.reading) seg.reading = { ...s.reading };
    }
    if (s.kind === 'clip') {
      seg.scene = s.scene;
      seg.caption = s.caption ? componentOf(s.caption) : null;
      if (!s.transition && prev?.kind === 'clip') seg.joined = true;
      if (s.panes?.length) {
        seg.pages = s.panes.map((p) => p.page);
        for (const p of s.panes) if (p.label) pages[`${s.scene}.${p.page}`] = p.label;
      }
      const end = seg.to;
      for (const st of s.steps) {
        steps.push({ from: s.from + st.from, to: s.from + st.to, scene: st.scene, step: st.step, ...(st.step_id ? { step_id: st.step_id } : {}), action: st.action, key: `${st.scene}.${st.step}` });
      }
      const zooms = [...s.zooms.map((z) => ({ z, pane: undefined as number | undefined })), ...(s.panes ?? []).flatMap((p, pane) => p.zooms.map((z) => ({ z, pane })))];
      for (const { z, pane } of zooms) {
        const from = s.from + z.from;
        const outFrom = s.from + z.out_at;
        camera.push({
          from,
          in_to: Math.min(end, from + z.in_frames),
          out_from: Math.min(end, outFrom),
          to: Math.min(end, outFrom + z.out_frames),
          zoom: z.zoom,
          ...(z.requested_zoom !== undefined ? { requested_zoom: z.requested_zoom } : {}),
          source: z.source ?? 'hint',
          scene: z.scene,
          step: z.step,
          key: `${z.scene}.${z.step}`,
          ...(pane !== undefined ? { pane } : {}),
        });
      }
      for (const sp of s.speeds) {
        speed.push({ from: s.from + sp.from, to: s.from + sp.to, speed: sp.speed, to_speed: sp.to_speed, ...(sp.protected ? { protected: true as const } : {}), scene: s.scene });
      }
      // Every cut of the planner (idle, a held page load, a freeze, a busy wait, a hook step) is a trim with the reason
      // the planner cut it for (a plan made before it recorded one: what the run's timeline says of the time skipped).
      for (const tr of s.trims) cuts.push({ at: s.from + tr.at, src_from_s: tr.src_from_s, src_to_s: tr.src_to_s, scene: s.scene, reason: tr.reason ?? reasonOf(tr.src_from_s, tr.src_to_s, opts.timeline) });
    }
    segments.push(seg);
  });
  // The time map's other jumps (page loads, frozen and busy waits, hooks cut by the planner): consecutive pieces of the
  // same scene whose source time does not continue, not already a trim at that frame.
  const tm = [...plan.timemap].sort((a, b) => a.out_from - b.out_from);
  for (let i = 1; i < tm.length; i++) {
    const a = tm[i - 1];
    const b = tm[i];
    if (a.scene !== b.scene || b.out_from !== a.out_to) continue;
    if (b.src_from_s - a.src_to_s <= JUMP_EPS_S) continue;
    if (cuts.some((c) => c.scene === b.scene && Math.abs(c.at - b.out_from) <= 1)) continue;
    cuts.push({ at: b.out_from, src_from_s: a.src_to_s, src_to_s: b.src_from_s, scene: b.scene, reason: reasonOf(a.src_to_s, b.src_from_s, opts.timeline) });
  }
  cuts.sort((x, y) => x.at - y.at);
  const captions = plan.captions.map((c, i) => ({ from: c.from, to: c.to, scene: c.scene, i }));
  const markers = plan.markers.map((m, i) => ({ frame: m.frame, ...(m.done !== undefined ? { done: m.done } : {}), scene: m.scene, ...(m.step !== undefined ? { step: m.step } : {}), i }));
  const labels: Record<string, string> = {};
  for (const st of steps) if (opts.labels?.[st.key] !== undefined) labels[st.key] = opts.labels[st.key];
  return {
    fps: plan.fps,
    frames: plan.durationInFrames,
    width: plan.width,
    height: plan.height,
    variant: plan.variant,
    segments,
    captions,
    steps,
    camera,
    speed,
    cuts,
    markers,
    untrusted: {
      captions: plan.captions.map((c) => ({ ...(c.kicker !== undefined ? { kicker: c.kicker } : {}), text: c.text })),
      markers: plan.markers.map((m) => m.name),
      steps: labels,
      pages,
    },
  };
}

// ── Comment pins (read-only; the comments UI is L4.6) ───────────────────────

/** A thread as the pins need it (engine comments `CommentView`, reduced). */
export interface PinThread {
  id: string;
  status: 'open' | 'resolved';
  /** The run of the render it was made on. */
  run_id: string;
  anchor: { segment: string; scene?: string; step?: number };
  marker?: string;
  /** The anchored step in today's file ("<scene>.<index>"), null when it has none, absent when the frame shows no step. */
  step_now?: string | null;
  /**
   * The output frame it was made at — given only when the render it was made on shows the version on screen (the same
   * plan and theme files: engine timeline-view): its frames are this plan's.
   */
  frame?: number;
}

export interface PlacedPin {
  id: string;
  status: 'open' | 'resolved';
  frame: number;
  /**
   * How it was placed: at its own frame (its render shows this version), the anchored step, its marker or segment on
   * the shown take, or today's step on this edit.
   */
  by: 'frame' | 'step' | 'marker' | 'segment' | 'step_now';
}

/**
 * Where each thread's pin goes on the shown plan (plan D8): at its own frame when its render shows this version (the
 * caller says so by giving `frame`); else a thread of the shown run at its anchored step's first frame (else its marker,
 * else its segment's start) — a frame of another version of the edit, so only the step or segment it pointed at; else,
 * when the view shows today's edit, at today's step (`step_now`); else it is listed beside the track ("made on another
 * take": no position invented).
 */
export function placePins(model: Pick<TimelineModel, 'steps' | 'segments' | 'markers' | 'untrusted'> & { frames?: number }, threads: readonly PinThread[], view: { run_id: string; edit: 'scenario' | 'run' }): { placed: PlacedPin[]; elsewhere: string[] } {
  const firstOf = (key: string) => {
    let f: number | undefined;
    for (const s of model.steps) if (s.key === key && (f === undefined || s.from < f)) f = s.from;
    return f;
  };
  const placed: PlacedPin[] = [];
  const elsewhere: string[] = [];
  for (const t of threads) {
    const pin = (frame: number | undefined, by: PlacedPin['by']) => (frame === undefined ? false : (placed.push({ id: t.id, status: t.status, frame, by }), true));
    if (t.run_id === view.run_id) {
      if (t.frame !== undefined && Number.isInteger(t.frame) && t.frame >= 0 && (model.frames === undefined || t.frame < model.frames) && pin(t.frame, 'frame')) continue;
      const a = t.anchor;
      if (a.scene !== undefined && a.step !== undefined && pin(firstOf(`${a.scene}.${a.step}`), 'step')) continue;
      const mi = t.marker !== undefined ? model.untrusted.markers.indexOf(t.marker) : -1;
      if (mi >= 0 && pin(model.markers.find((m) => m.i === mi)?.frame, 'marker')) continue;
      if (pin(model.segments.find((s) => s.id === a.segment)?.from, 'segment')) continue;
    } else if (view.edit === 'scenario' && typeof t.step_now === 'string' && pin(firstOf(t.step_now), 'step_now')) continue;
    elsewhere.push(t.id);
  }
  placed.sort((a, b) => a.frame - b.frame);
  return { placed, elsewhere };
}
