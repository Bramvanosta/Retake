/**
 * Where a frame of a render points in the edit (L3.6, R-CMT-04): the anchor a frame comment keeps, computed from the
 * render's edit plan (pure). The segment shown at the frame (the incoming one during a crossfade — the review's
 * convention), its kind and component; for a clip: the scene, the step (index, id, `<scene>.<step>` ref, fingerprint in
 * the run's scenario snapshot), its action, the acting page, the capture time, the overlays on screen; the marker whose
 * window holds the frame; the transition covering it; with a region, the area its centre lies on (the caption's box —
 * the band over the screen for a caption drawn over it —, the brand mark, else the screen).
 *
 * Rule: a frame belongs to the last step that started at or before its capture frame. A step shorter than one capture
 * frame (a satisfied wait) owns none. A marker window — from the marked step's start to its `done` frame — names its
 * marked step, which may own no frame at all (a `mark:` on a `wait_for` that was already satisfied: the fixture's).
 */
import { scenarioStepFingerprint } from '@retake/core/comments';
import type { FrameCommentAnchor, Timeline } from '@retake/core/model';
import type { CommentRegion } from '@retake/core/comments';
import { brandmarkRect } from '@retake/editor/plan';
import type { ClipSegment, EditPlan, Rect } from '@retake/editor/plan';
import { captionRegion } from './checks.js';
import { segmentSpans, spanAt, stepAt, transitionAt, transitionSpans } from './spans.js';

export interface FrameAnchorOptions {
  /** Commented region, 0..1 of the output frame: the area its centre lies on picks `area` and `component`. */
  region?: CommentRegion;
  /** The run's scenario snapshot (runs/<run_id>/scenario.yaml, raw text): the step fingerprint is taken from it. */
  scenarioText?: string;
  /**
   * The run's timeline: names the marked step of a marker in a plan made before L3.6 (its markers carry no `step`)
   * from the timeline marker of the same name.
   */
  timeline?: Pick<Timeline, 'markers' | 'events'>;
}

const inside = (r: Rect | undefined, x: number, y: number): boolean => !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** The marker of `clip` whose window [frame, max(done, frame)] holds output frame `frame` (the latest to start). */
function markerAt(plan: Pick<EditPlan, 'markers'>, clip: ClipSegment, frame: number): EditPlan['markers'][number] | undefined {
  let found: EditPlan['markers'][number] | undefined;
  for (const m of plan.markers) {
    if (m.scene !== clip.scene || m.frame < clip.from || m.frame >= clip.from + clip.durationInFrames) continue;
    if (frame >= m.frame && frame <= Math.max(m.done ?? m.frame, m.frame) && (!found || m.frame >= found.frame)) found = m;
  }
  return found;
}

/**
 * The anchor of output frame `frame` of `plan`. Throws a RangeError when the frame is not one of the render
 * (0 ≤ frame < durationInFrames, an integer).
 */
export function frameAnchor(plan: EditPlan, frame: number, opts: FrameAnchorOptions = {}): FrameCommentAnchor {
  if (!Number.isInteger(frame) || frame < 0 || frame >= plan.durationInFrames) {
    throw new RangeError(`frame ${frame} is not a frame of the render (0..${plan.durationInFrames - 1})`);
  }
  const span = spanAt(segmentSpans(plan), frame);
  if (!span) throw new RangeError(`the render has no segment at frame ${frame}`);
  const seg = span.segment;
  const a: FrameCommentAnchor = { segment: seg.id, kind: seg.kind, component: seg.component.id };
  const centre = opts.region ? { x: (opts.region.x + opts.region.w / 2) * plan.width, y: (opts.region.y + opts.region.h / 2) * plan.height } : undefined;

  if (seg.kind === 'clip') {
    const rel = Math.min(frame - seg.from, seg.durationInFrames - 1);
    a.scene = seg.scene;
    const marker = markerAt(plan, seg, frame);
    let step: number | undefined;
    let stepId: string | undefined;
    let action: string | undefined;
    const marked = marker ? markedStep(marker, opts.timeline) : undefined;
    if (marked) ({ step, step_id: stepId, action } = marked);
    else {
      const st = stepAt(seg, rel);
      if (st && st.step >= 0) ({ step, step_id: stepId, action } = st);
      else if (st) action = st.action; // the opening of the scene (scene_still / scene_open): no step
    }
    if (step !== undefined) {
      a.step = step;
      if (stepId) a.step_id = stepId;
      a.step_ref = `${seg.scene}.${stepId ?? step}`;
      const fp = opts.scenarioText !== undefined ? scenarioStepFingerprint(opts.scenarioText, seg.scene, step) : undefined;
      if (fp) {
        a.step_fp = fp.fp;
        a.step_fp_n = fp.n;
      }
    }
    if (action) a.action = action;
    if (seg.panes?.length && seg.acting?.length) {
      let pane = seg.acting[0].pane;
      for (const x of seg.acting) if (x.frame <= rel) pane = x.pane;
      const page = seg.panes[pane]?.page;
      if (page) a.page = page;
    }
    const src = seg.srcFrames[rel];
    if (src !== undefined) a.src_time_s = Math.round((src / plan.source.fps) * 1000) / 1000;
    if (marker) a.marker = marker.name;
    const overlays = [...new Set(seg.overlays.filter((o) => rel >= o.from && rel < o.from + o.durationInFrames).map((o) => o.component.id))];
    if (overlays.length) a.overlays = overlays;
    if (centre) {
      const cueOn = seg.cues.some((c) => rel >= c.from && rel < c.to);
      // The caption's own box: the layout's caption area, or the band drawn over the screen (studio/caption-overlay).
      if (seg.caption && cueOn && inside(captionRegion(plan, seg)?.rect, centre.x, centre.y)) {
        a.area = 'caption';
        a.component = seg.caption.id;
      } else if (inside(brandmarkRect(plan, seg.layout.brandmark, plan.brand.brandmark?.position)?.rect, centre.x, centre.y)) {
        // The brand mark is drawn by the composition, not by a component: the clip's layout component stays.
        a.area = 'brandmark';
      } else a.area = 'screen';
    }
  } else if (centre) a.area = 'card';

  const t = transitionAt(transitionSpans(plan), frame);
  if (t) a.transition = { kind: t.kind, ...(t.before !== undefined ? { from: t.before } : {}), ...(t.after !== undefined ? { to: t.after } : {}) };
  return a;
}

/** The marked step of a plan marker (L3.6 plans), else of the timeline marker of that name (older plans). */
function markedStep(
  m: EditPlan['markers'][number],
  timeline: FrameAnchorOptions['timeline'],
): { step: number; step_id?: string; action?: string } | undefined {
  if (m.step !== undefined) return { step: m.step, step_id: m.step_id, action: m.action };
  const tm = timeline?.markers.find((x) => x.name === m.name && x.scene === m.scene);
  if (!tm) return undefined;
  const ev = timeline!.events.find((e) => e.scene === tm.scene && e.step === tm.step);
  return { step: tm.step, step_id: ev?.id, action: ev?.action };
}
