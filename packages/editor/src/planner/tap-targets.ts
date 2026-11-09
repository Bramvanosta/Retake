/** A step of `planEdit`: the tap targets of transitions (L2.9), from the manifest anchors of the outgoing segments. */
import { ANCHOR_KEYS, evalAnchor, paramEnums } from '@retake/components/geometry';
import type { AnchorSpec } from '@retake/components/geometry';
import type { EditPlan, PlanLayout, ResolvedComponent } from '../plan-types.js';
import { round } from '../util.js';
import { ANCHOR_OVERLAY_WINDOW_S } from './rules.js';
import type { Draft, PlanScope } from './scope.js';

/** Tap targets of transitions (L2.9): the outgoing segment's (or its last overlay's) manifest anchor. */
export function planTapTargets(s: PlanScope, drafts: Draft[]): void {
  const { variant, resolver, design, unit, cssW, cssH, warnings, outFps } = s;
  const anchorKey = ANCHOR_KEYS[variant];
  const anchorOf = (rc: ResolvedComponent, where: string, layout?: PlanLayout): EditPlan['layout']['capture'] | undefined => {
    const m = resolver.manifest(rc);
    // A variant without its own anchor uses the landscape one (expressions over frame_w / frame_h follow the format).
    const spec = (m?.[anchorKey] ?? m?.anchor) as AnchorSpec | undefined;
    if (!m || !spec) return undefined;
    const c = layout?.capture;
    try {
      const r = evalAnchor(spec, rc.params, {
        enums: paramEnums(m.params),
        frame: { w: design.width, h: design.height },
        ...(c ? { screen: { x: c.x / unit, y: c.y / unit, w: c.w / unit, h: c.h / unit } } : {}),
        aspect: cssW / cssH,
      });
      return { x: round(r.x * unit, 2), y: round(r.y * unit, 2), w: round(r.w * unit, 2), h: round(r.h * unit, 2) };
    } catch (e) {
      warnings.add(`${where}: the ${anchorKey} of ${rc.id} cannot be evaluated: ${(e as Error).message}`);
      return undefined;
    }
  };
  drafts.forEach((d, i) => {
    const tr = d.seg.transition;
    const prev = drafts[i - 1];
    if (!tr?.component || !prev) return;
    let anchor: EditPlan['layout']['capture'] | undefined;
    if (prev.seg.kind === 'clip') {
      const end = prev.content;
      const showing = prev.seg.overlays.filter((o) => o.from + o.durationInFrames >= end - ANCHOR_OVERLAY_WINDOW_S * outFps && o.from < end);
      for (let k = showing.length - 1; k >= 0 && !anchor; k--) anchor = anchorOf(showing[k].component, `overlay of "${prev.seg.id}"`, prev.seg.layout);
    }
    anchor ??= anchorOf(prev.seg.component, `"${prev.seg.id}"`);
    if (anchor) tr.anchor = anchor;
  });
}
