/** The checks of where the viewer looks: the cursor at clicks, camera zooms, joins, reframes, camera jumps and zooms during a scroll. */
import { paneSource, paneViewOf, viewOf } from '@retake/editor/plan';
import type { CameraFrame, ClipSegment, EditPlan } from '@retake/editor/plan';
import { cursorAt } from './timeline.js';
import type { CheckContext } from './checks-base.js';
import { finding, inside, locate } from './checks-base.js';
import type { Finding } from './types.js';
import { isClip, timecode } from './spans.js';

// ── Cursor at clicks ──────────────────────────────────────────────────────────

export function checkCursor(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const ripple = Math.round(0.4 * plan.fps);
  for (const c of ctx.clicks) {
    const clip = plan.segments.find((s): s is ClipSegment => s.id === c.segment && isClip(s));
    if (!clip || !c.point) continue;
    // Multi-page clips: the page's own size, view and reframe.
    const pane = c.pane !== undefined && clip.panes?.[c.pane] ? c.pane : undefined;
    const src = pane !== undefined ? paneSource(plan, clip.panes![pane]) : plan.source;
    const W = src.cssWidth;
    const H = src.cssHeight;
    const viewAt = (f: number) => (pane !== undefined ? paneViewOf(plan, clip, pane, f) : viewOf(plan, clip, f));
    const crop = pane !== undefined ? clip.panes![pane].layout.crop : clip.layout.crop;
    const rel = c.frame - clip.from;
    const at = locate(ctx, c.frame, { scene: c.scene, step: c.step });
    const what = `the ${c.action} of step ${c.step_id ?? c.step} in "${c.scene}"`;
    if (c.point.x < 0 || c.point.y < 0 || c.point.x > W || c.point.y > H) {
      out.push(finding('error', 'cursor-offscreen', `${what} happens with the cursor off screen (${Math.round(c.point.x)}, ${Math.round(c.point.y)} in a ${W}×${H} capture)`, at));
      continue;
    }
    const ev = ctx.timeline?.events.find((e) => e.scene === c.scene && e.step === c.step && e.t_click !== undefined);
    if (ctx.timeline && ev?.t_click !== undefined) {
      const cur = cursorAt(ctx.timeline, ev.t_click, c.page);
      if (cur && !cur.visible) out.push(finding('warning', 'cursor-hidden', `${what} happens while the cursor is hidden`, at));
    }
    const reframed = plan.variant !== 'landscape' && !!crop && (crop.w < W - 0.5 || crop.h < H - 0.5);
    for (const f of [rel, Math.min(clip.durationInFrames - 1, rel + ripple)]) {
      const view = viewAt(f);
      const zoomed = view.w < W - 0.5 || view.h < H - 0.5;
      const viewName = reframed ? `${plan.variant} reframe` : `zoomed view (${(W / view.w).toFixed(2)}×)`;
      if (!inside(c.point, view, Math.min(view.w, view.h) * 0.01)) {
        out.push(
          finding(
            'error',
            'cursor-outside-view',
            `${what} is outside the ${zoomed ? viewName : 'visible area'}: cursor at (${Math.round(c.point.x)}, ${Math.round(c.point.y)}), view x ${Math.round(view.cx - view.w / 2)}–${Math.round(view.cx + view.w / 2)}, y ${Math.round(view.cy - view.h / 2)}–${Math.round(view.cy + view.h / 2)}${f === rel ? '' : ` ${(ripple / plan.fps).toFixed(1)} s after the click`}`,
            at,
          ),
        );
        break;
      }
      const bb = c.bbox ?? ev?.target?.bbox;
      if (bb && zoomed && f === rel) {
        // Only the part of the target inside the capture can be shown.
        const x0 = Math.max(0, bb.x);
        const y0 = Math.max(0, bb.y);
        const x1 = Math.min(W, bb.x + bb.w);
        const y1 = Math.min(H, bb.y + bb.h);
        const corners = [
          { x: x0, y: y0 },
          { x: x1, y: y1 },
        ];
        const fits = x1 - x0 <= view.w && y1 - y0 <= view.h;
        if (!corners.every((p) => inside(p, view, -0.5))) {
          if (reframed && fits) {
            out.push(finding('error', 'target-cut', `${what}: the ${plan.variant} reframe cuts its target (${c.target ?? ev?.target?.desc ?? 'element'})`, at));
          } else if (reframed && inside(corners[0], view, -0.5)) {
            // Wider (taller) than the view: its leading part — where its text starts — and the click are what can be shown.
            out.push(
              finding('info', 'target-outside-view', `${what}: its target (${c.target ?? ev?.target?.desc ?? 'element'}) is larger than the ${viewName}: its leading part and the click are shown`, at),
            );
          } else {
            out.push(finding('warning', 'target-outside-view', `${what}: its target (${c.target ?? ev?.target?.desc ?? 'element'}) is partly outside the ${viewName}`, at));
          }
        }
      }
    }
  }
  return out;
}

// ── Camera ────────────────────────────────────────────────────────────────────

const camAt = (plan: EditPlan, clip: ClipSegment, f: number): CameraFrame =>
  clip.camera?.[Math.max(0, Math.min(clip.durationInFrames - 1, f))] ?? [1, plan.source.cssWidth / 2, plan.source.cssHeight / 2];

export function checkCamera(ctx: CheckContext): Finding[] {
  const clips = ctx.plan.segments.filter(isClip);
  return [...zoomFindings(ctx, clips), ...joinFindings(ctx), ...reframeFindings(ctx, clips), ...cameraJumpFindings(ctx, clips)];
}

/** The camera zooms: theme zooms (style, count per scene, back out before the cut), the per-video budget, slow zooms. */
function zoomFindings(ctx: CheckContext, clips: ClipSegment[]): Finding[] {
  const out: Finding[] = [];
  const { plan, rules } = ctx;
  const zooms = new Map<string, { clip: ClipSegment; zoom: ClipSegment['zooms'][number] }>();
  for (const clip of clips) for (const z of clip.zooms) zooms.set(`${z.scene}|${z.step}`, { clip, zoom: z });
  const list = [...zooms.values()].sort((a, b) => a.clip.from + a.zoom.from - (b.clip.from + b.zoom.from));
  // Step hints count against the per-video budget; the theme's default zoom (style_bias balanced / motion) has its own
  // rule: at most one per scene, back to the full view before the scene ends (never across a cut or a join).
  const hinted = list.filter((z) => z.zoom.source !== 'theme');
  const themed = list.filter((z) => z.zoom.source === 'theme');
  if (themed.length > 0 && plan.brand.style_bias === 'real') {
    out.push(
      finding('warning', 'theme-zoom-real', `${themed.length} theme zoom(s) with style_bias "real": a real-style theme keeps a static camera`, locate(ctx, themed[0].clip.from + themed[0].zoom.from)),
    );
  }
  const perScene = new Map<string, number>();
  for (const { clip, zoom } of themed) {
    perScene.set(zoom.scene, (perScene.get(zoom.scene) ?? 0) + 1);
    const at = locate(ctx, clip.from + zoom.from, { scene: zoom.scene, step: zoom.step });
    if (perScene.get(zoom.scene) === 2) out.push(finding('warning', 'theme-zoom-count', `more than one theme zoom in "${zoom.scene}": the theme default zoom is at most one per scene`, at));
    const end = clip.durationInFrames - clip.heldFrames;
    const last = camAt(plan, clip, end - 1);
    if (zoom.out_at + zoom.out_frames > end + 0.5 || last[0] > 1.001) {
      out.push(
        finding(
          'warning',
          'theme-zoom-cut',
          `the theme zoom of "${zoom.scene}" is still ${last[0].toFixed(2)}× when the scene ends: it must ease back out before the cut`,
          locate(ctx, clip.from + end - 1, { scene: zoom.scene }),
        ),
      );
    }
  }
  if (hinted.length > rules.max_zooms) {
    const extra = hinted[rules.max_zooms];
    out.push(
      finding(
        'warning',
        'zoom-count',
        `${hinted.length} camera zooms (${hinted.map((z) => `${z.zoom.zoom}× at ${timecode((z.clip.from + z.zoom.from) / plan.fps)}`).join(', ')}): the reference look keeps the camera static with at most ${rules.max_zooms === 1 ? 'one very slow zoom' : `${rules.max_zooms} zooms`} per video`,
        locate(ctx, extra.clip.from + extra.zoom.from, { scene: extra.zoom.scene, step: extra.zoom.step }),
      ),
    );
  }
  for (const { clip, zoom } of list) {
    const at = locate(ctx, clip.from + zoom.from, { scene: zoom.scene, step: zoom.step });
    const inS = zoom.in_frames / plan.fps;
    if (inS < rules.slow_zoom_min_s || zoom.zoom > rules.slow_zoom_max) {
      out.push(
        finding(
          'info',
          'zoom-not-slow',
          `zoom ${zoom.zoom}× in ${inS.toFixed(1)} s (step ${zoom.step} of "${zoom.scene}"): the reference zoom is very slow (≈ 1.12× over ≈ 6 s, ≤ ${rules.slow_zoom_max}× over ≥ ${rules.slow_zoom_min_s} s)`,
          at,
        ),
      );
    }
    if (zoom.requested_zoom !== undefined) {
      out.push(finding('info', 'zoom-clamped', `zoom ${zoom.requested_zoom}× was limited to ${zoom.zoom}× by the theme's max_zoom`, at));
    }
  }
  return out;
}

/** Same-page joins (no transition) must continue the camera; inside a clip the camera never jumps. */
function joinFindings(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const W = plan.source.cssWidth;
  const H = plan.source.cssHeight;
  for (let i = 0; i < plan.segments.length - 1; i++) {
    const a = plan.segments[i];
    const b = plan.segments[i + 1];
    if (!isClip(a) || !isClip(b) || b.transition) continue;
    const ca = camAt(plan, a, a.durationInFrames - 1 - a.heldFrames);
    const cb = camAt(plan, b, 0);
    if (Math.abs(ca[0] - cb[0]) > 0.01 || Math.abs(ca[1] - cb[1]) > 0.01 * W || Math.abs(ca[2] - cb[2]) > 0.01 * H) {
      out.push(
        finding(
          'warning',
          'zoom-reset',
          `the camera jumps at the same-page join "${a.scene}" → "${b.scene}" (${ca[0].toFixed(2)}× → ${cb[0].toFixed(2)}×): a zoom must continue across a join without a transition`,
          locate(ctx, b.from),
        ),
      );
    }
  }
  return out;
}

/** A reframed clip, or a page of a multi-page clip, with its crop track and its view. */
type Reframed = {
  clip: ClipSegment;
  rf: Array<[number, number]>;
  crop: { w: number; h: number };
  page?: string;
  view: (f: number) => { cx: number; cy: number; w: number; h: number };
  name: string;
};

/** Reframed variants: the crop glides (no jump, no jolt) and the cursor never leaves it (each page of a multi-page clip). */
function reframeFindings(ctx: CheckContext, clips: ClipSegment[]): Finding[] {
  const out: Finding[] = [];
  const { plan, rules } = ctx;
  const reframes: Reframed[] = [];
  for (const clip of clips) {
    if (clip.panes) {
      clip.panes.forEach((p, i) => {
        if (p.reframe && p.layout.crop) reframes.push({ clip, rf: p.reframe, crop: p.layout.crop, page: p.page, view: (f) => paneViewOf(plan, clip, i, f), name: `"${clip.scene}" (page ${p.page})` });
      });
    } else if (clip.reframe && clip.layout.crop) reframes.push({ clip, rf: clip.reframe, crop: clip.layout.crop, view: (f) => viewOf(plan, clip, f), name: `"${clip.scene}"` });
  }
  for (const r of reframes) {
    const { clip, rf, crop } = r;
    if (plan.variant === 'landscape') continue;
    const n = rf.length - clip.heldFrames;
    let jumped = false;
    for (let f = 1; f < n && !jumped; f++) {
      const step = Math.hypot(rf[f][0] - rf[f - 1][0], rf[f][1] - rf[f - 1][1]);
      const accel = f >= 2 ? Math.hypot(rf[f][0] - 2 * rf[f - 1][0] + rf[f - 2][0], rf[f][1] - 2 * rf[f - 1][1] + rf[f - 2][1]) : 0;
      if (step > rules.reframe_max_step * crop.w || accel > rules.reframe_max_accel * crop.w) {
        jumped = true;
        out.push(
          finding(
            'warning',
            'reframe-jump',
            `the ${plan.variant} reframe of ${r.name} ${step > rules.reframe_max_step * crop.w ? `moves ${Math.round(step)} px in one frame` : `jolts (${accel.toFixed(1)} px/frame²)`} (crop ${Math.round(crop.w)} px wide)`,
            locate(ctx, clip.from + f),
          ),
        );
      }
    }
    if (!ctx.timeline) continue;
    for (let f = 0; f < n; f++) {
      const t = (clip.srcFrames[f] ?? 0) / plan.source.fps;
      const cur = cursorAt(ctx.timeline, t, r.page);
      if (!cur?.visible) continue;
      // A page's resting cursor may leave its reframe (the other page acts): only the acting page's counts.
      if (r.page !== undefined && clip.acting && clip.panes) {
        let acting = clip.acting[0].pane;
        for (const a of clip.acting) if (a.frame <= f) acting = a.pane;
        if (clip.panes[acting]?.page !== r.page) continue;
      }
      const view = r.view(f);
      if (!inside(cur, view, 0)) {
        out.push(finding('warning', 'cursor-outside-reframe', `the cursor (${Math.round(cur.x)}, ${Math.round(cur.y)}) leaves the ${plan.variant} reframe of ${r.name}`, locate(ctx, clip.from + f)));
        break;
      }
    }
  }
  return out;
}

/** Inside a clip the camera never jumps between two frames. */
function cameraJumpFindings(ctx: CheckContext, clips: ClipSegment[]): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const W = plan.source.cssWidth;
  const H = plan.source.cssHeight;
  for (const clip of clips) {
    if (!clip.camera) continue;
    for (let f = 1; f < clip.camera.length - clip.heldFrames; f++) {
      const p = clip.camera[f - 1];
      const c = clip.camera[f];
      if (Math.abs(c[0] - p[0]) > 0.04 || Math.abs(c[1] - p[1]) > (0.03 * W) / c[0] || Math.abs(c[2] - p[2]) > (0.03 * H) / c[0]) {
        out.push(finding('warning', 'camera-jump', `the camera jumps between two frames in "${clip.scene}" (${p[0].toFixed(2)}× → ${c[0].toFixed(2)}×)`, locate(ctx, clip.from + f)));
        break;
      }
    }
  }
  return out;
}

/**
 * `zoom-during-scroll`: a camera zoom whose span (in, hold, out) overlaps another `scroll` step of its clip — the page
 * moves under a magnified view (the zoom's own scroll step, which brings its target in, is one move). One zoom, centred on a point, done before the page scrolls.
 */
export function checkZoomScroll(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const clip of ctx.plan.segments.filter(isClip)) {
    for (const z of clip.zooms) {
      const end = z.out_at + z.out_frames;
      // The zoom's own scroll step brings its target in while the camera eases to it (one move): another scroll is not.
      const scroll = clip.steps.find((st) => st.action === 'scroll' && !(st.scene === z.scene && st.step === z.step) && st.from < end && st.to > z.from);
      if (!scroll) continue;
      out.push(
        finding(
          'warning',
          'zoom-during-scroll',
          `the ${z.zoom}× zoom of ${z.scene}.${z.step} is still on while step ${scroll.scene}.${scroll.step} scrolls the page: end the zoom before any scroll (or zoom after it)`,
          locate(ctx, clip.from + Math.max(z.from, scroll.from), { scene: z.scene, step: z.step }),
        ),
      );
    }
  }
  return out;
}
