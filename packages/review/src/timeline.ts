/**
 * The output-time timeline of a render (review/<id>/timeline.json): every segment with its components, captions,
 * markers, step spans, transitions, zooms, overlays and the clicks of the capture placed on the output — all in
 * output frames and seconds, so an agent or the Studio can say "at 00:23.4 the second click of scene X".
 */
import type { Timeline } from '@retake/core';
import type { EditPlan, RenderRecord, ResolvedComponent } from '@retake/editor';
import { mapPaneRect, mapSourceRect, paneIndexOf } from '@retake/editor';
import { isClip, meanSpeed, outputFrameOf, round, segmentSpans, transitionSpans } from './spans.js';

export interface OutputComponent {
  id: string;
  version: string;
  kind: string;
  source: ResolvedComponent['source'];
  params: Record<string, unknown>;
  slots: Record<string, string | undefined>;
  missing?: boolean;
}

export interface OutputClick {
  scene: string;
  step: number;
  step_id?: string;
  action: string;
  segment: string;
  frame: number;
  time: number;
  /** Cursor position at the click, source CSS px, and where it lands on the output (px). */
  point?: { x: number; y: number };
  screen?: { x: number; y: number };
  target?: string;
  /** The clicked element's box (source CSS px), when the timeline recorded it (widgets: each of their clicks). */
  bbox?: { x: number; y: number; w: number; h: number };
  /** Index of the click within its step (widgets click more than once: trigger, option…). */
  click?: number;
  /** Multi-page clips (L2.11): the page the step acted on and its pane in the clip (the point is in that page's px). */
  page?: string;
  pane?: number;
}

export interface OutputTimeline {
  version: 1;
  render: string;
  scenario: string;
  run_id: string;
  template: string;
  fps: number;
  frames: number;
  duration_s: number;
  width: number;
  height: number;
  segments: Array<{
    id: string;
    kind: string;
    scene?: string;
    from: number;
    to: number;
    from_s: number;
    to_s: number;
    duration_s: number;
    /** Frames rendered for the segment (includes the overlap of the next crossfade). */
    rendered_frames: number;
    component: OutputComponent;
    caption?: OutputComponent | null;
    transition_in?: { kind: string; frames: number; component: OutputComponent | null };
    layout?: EditPlan['layout'];
    /** Clips: source seconds shown, mean speed, held frames, zooms and overlays (output frames). */
    src?: { from_s: number; to_s: number };
    speed?: number;
    zooms?: Array<{ scene: string; step: number; from: number; to: number; zoom: number; in_s: number }>;
    overlays?: Array<{ component: OutputComponent; from: number; to: number; scene: string; step: number }>;
  }>;
  transitions: Array<{ from: number; to: number; from_s: number; to_s: number; kind: string; before?: string; after?: string }>;
  captions: Array<{ from: number; to: number; from_s: number; to_s: number; scene: string; kicker?: string; text: string }>;
  /** `frame` / `time`: the marked step's start (the marker); `done_frame` / `done_time`: the screen once it is done. */
  markers: Array<{ name: string; frame: number; time: number; scene: string; done_frame?: number; done_time?: number }>;
  steps: Array<{ segment: string; scene: string; step: number; step_id?: string; action: string; from: number; to: number; from_s: number; to_s: number }>;
  clicks: OutputClick[];
}

function component(c: ResolvedComponent): OutputComponent {
  const out: OutputComponent = { id: c.id, version: c.version, kind: c.kind, source: c.source, params: c.params, slots: c.slots };
  if (c.missing) out.missing = true;
  return out;
}

/**
 * Cursor position at capture time `t` (linear between samples less than 0.15 s apart, else the last sample) — of the
 * main capture, or of page `page`'s own track (multi-page scenes, L2.11).
 */
export function cursorAt(timeline: Pick<Timeline, 'cursor' | 'tracks'>, t: number, page?: string): { x: number; y: number; visible: boolean } | undefined {
  const c = page !== undefined ? (timeline.tracks?.find((tr) => tr.id === page)?.cursor ?? timeline.cursor) : timeline.cursor;
  if (!c.length) return undefined;
  let i = -1;
  for (let k = 0; k < c.length && c[k].t <= t; k++) i = k;
  if (i < 0) return { x: c[0].x, y: c[0].y, visible: c[0].visible };
  const a = c[i];
  const b = c[i + 1];
  if (b && b.t - a.t < 0.15 && b.t > a.t) {
    const p = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, visible: a.visible };
  }
  return { x: a.x, y: a.y, visible: a.visible };
}

/** Clicks (events with a click moment) of the capture placed on the output (only the ones the edit shows). */
export function outputClicks(plan: EditPlan, timeline: Timeline | undefined): OutputClick[] {
  if (!timeline) return [];
  const out: OutputClick[] = [];
  const fps = plan.source.fps;
  type Moment = { t: number; point?: { x: number; y: number }; bbox?: OutputClick['bbox']; desc?: string };
  for (const ev of timeline.events) {
    if (ev.t_click === undefined || ev.status === 'skipped') continue;
    // A widget (select, date pick…) records every click it made in `data.clicks`; other actions click once.
    const data = ev.data as { clicks?: Array<{ t_click?: number; point?: { x: number; y: number }; bbox?: OutputClick['bbox']; desc?: string }> } | undefined;
    const widget = Array.isArray(data?.clicks) ? data!.clicks.filter((c) => typeof c.t_click === 'number') : [];
    const moments: Moment[] = widget.length > 0
      ? widget.map((c) => ({ t: c.t_click!, point: c.point, bbox: c.bbox, desc: c.desc }))
      : [{ t: ev.t_click, point: ev.point, bbox: ev.target?.bbox, desc: ev.target?.desc }];
    moments.forEach((m, i) => {
      for (const clip of plan.segments.filter(isClip)) {
        if (clip.scene !== ev.scene) continue;
        const rel = outputFrameOf(clip, Math.round(m.t * fps));
        if (rel === undefined || rel >= clip.durationInFrames - clip.heldFrames) continue;
        const frame = clip.from + rel;
        // Multi-page clips: the page the step acted on, its own cursor and its pane.
        const pane = paneIndexOf(clip, ev.page);
        const page = pane >= 0 ? ev.page : undefined;
        const cur = m.point ?? cursorAt(timeline, m.t, page);
        const click: OutputClick = { scene: ev.scene, step: ev.step, action: ev.action, segment: clip.id, frame, time: round(frame / plan.fps, 3) };
        if (ev.id) click.step_id = ev.id;
        if (moments.length > 1) click.click = i;
        if (page !== undefined) {
          click.page = page;
          click.pane = pane;
        }
        if (cur) {
          click.point = { x: round(cur.x), y: round(cur.y) };
          const r = pane >= 0 ? mapPaneRect(plan, clip, pane, rel, { x: cur.x, y: cur.y }) : mapSourceRect(plan, clip, rel, { x: cur.x, y: cur.y });
          click.screen = { x: r.x, y: r.y };
        }
        if (m.desc) click.target = m.desc;
        if (m.bbox && m.bbox.w > 0 && m.bbox.h > 0) click.bbox = { x: m.bbox.x, y: m.bbox.y, w: m.bbox.w, h: m.bbox.h };
        out.push(click);
        break;
      }
    });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

export function buildOutputTimeline(record: RenderRecord, timeline?: Timeline): OutputTimeline {
  const plan = record.plan;
  const fps = plan.fps;
  const s = (f: number) => round(f / fps, 3);
  const spans = segmentSpans(plan);
  const out: OutputTimeline = {
    version: 1,
    render: record.id,
    scenario: record.scenario,
    run_id: record.run_id,
    template: record.template,
    fps,
    frames: plan.durationInFrames,
    duration_s: s(plan.durationInFrames),
    width: plan.width,
    height: plan.height,
    segments: [],
    transitions: transitionSpans(plan).map((t) => ({ ...t, from_s: s(t.from), to_s: s(t.to) })),
    captions: plan.captions.map((c) => ({ from: c.from, to: c.to, from_s: s(c.from), to_s: s(c.to), scene: c.scene, ...(c.kicker ? { kicker: c.kicker } : {}), text: c.text })),
    markers: plan.markers.map((m) => ({ name: m.name, frame: m.frame, time: s(m.frame), scene: m.scene, ...(m.done !== undefined ? { done_frame: m.done, done_time: s(m.done) } : {}) })),
    steps: [],
    clicks: outputClicks(plan, timeline),
  };
  for (const span of spans) {
    const seg = span.segment;
    const entry: OutputTimeline['segments'][number] = {
      id: seg.id,
      kind: seg.kind,
      from: span.from,
      to: span.to,
      from_s: s(span.from),
      to_s: s(span.to),
      duration_s: s(span.to - span.from),
      rendered_frames: seg.durationInFrames,
      component: component(seg.component),
    };
    if (seg.transition) entry.transition_in = { kind: seg.transition.kind, frames: seg.transition.frames, component: seg.transition.component ? component(seg.transition.component) : null };
    if (isClip(seg)) {
      entry.scene = seg.scene;
      entry.caption = seg.caption ? component(seg.caption) : null;
      entry.layout = seg.layout;
      entry.src = { from_s: seg.src.from_s, to_s: seg.src.to_s };
      entry.speed = round(meanSpeed(seg), 3);
      entry.zooms = seg.zooms.map((z) => ({ scene: z.scene, step: z.step, from: seg.from + z.from, to: seg.from + z.out_at + z.out_frames, zoom: z.zoom, in_s: s(z.in_frames) }));
      entry.overlays = seg.overlays.map((o) => ({ component: component(o.component), from: seg.from + o.from, to: seg.from + o.from + o.durationInFrames, scene: o.scene, step: o.step }));
      for (const st of seg.steps) {
        out.steps.push({
          segment: seg.id,
          scene: st.scene,
          step: st.step,
          ...(st.step_id ? { step_id: st.step_id } : {}),
          action: st.action,
          from: seg.from + st.from,
          to: seg.from + st.to,
          from_s: s(seg.from + st.from),
          to_s: s(seg.from + st.to),
        });
      }
    }
    out.segments.push(entry);
  }
  return out;
}
