/**
 * A step overlay's component use: the overlay as written, or a user file turned into studio/media or
 * studio/lottie (media.ts), with its box.
 */
import { mediaSegmentUse } from './media.js';
import type { OverlayAnchor, OverlaySpec } from './types/language.js';
import type { BBox } from './types/model.js';

/** A step overlay as the runner records it: the component use, and the box of a box-filling overlay. */
export interface OverlayUseSpec {
  component: string;
  slots: Record<string, string>;
  params: Record<string, unknown>;
  box?: { anchor?: OverlayAnchor; rect?: BBox; scale?: number };
}

/**
 * The component use of a step `overlay`: its component as written, or — for a user file (`video`, `image`, `lottie`) —
 * studio/media or studio/lottie with the file in its `file` slot. A file, or any overlay with `anchor` / `rect` /
 * `scale`, gets a box (default anchor decided by the planner: the target when the step has one, else the centre).
 */
export function overlayUseOf(spec: OverlaySpec): OverlayUseSpec {
  const file = mediaSegmentUse(spec, { overlay: true, ...(spec.loop !== undefined ? { loop: spec.loop } : {}) });
  const out: OverlayUseSpec = file
    ? { component: file.id, slots: { ...(spec.slots ?? {}), ...file.slots }, params: file.params }
    : { component: spec.component ?? '', slots: { ...(spec.slots ?? {}) }, params: structuredClone(spec.params ?? {}) };
  if (file || spec.anchor !== undefined || spec.rect !== undefined || spec.scale !== undefined) {
    const box: NonNullable<OverlayUseSpec['box']> = {};
    if (spec.anchor !== undefined) box.anchor = spec.anchor;
    if (spec.rect !== undefined) box.rect = { ...spec.rect };
    if (spec.scale !== undefined) box.scale = spec.scale;
    out.box = box;
  }
  return out;
}
