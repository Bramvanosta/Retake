import type { ScrollArgs } from '@retake/core';
import { StepError } from '../errors.js';
import { resolveTarget } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { clamp } from '../util.js';
import type { ActionResult } from './types.js';

/** Default distance between a scroll target and the top of its container (pacing.scroll_offset: 140 px below the top). */
export const DEFAULT_SCROLL_OFFSET = -140;

/** Animated in-page scroll of a container (rAF raced with setTimeout, easeInOutCubic). */
export async function scroll(ctx: StepContext, args: ScrollArgs): Promise<ActionResult> {
  const { kit, pacing } = ctx.rt;
  let container: string | undefined;
  if (args.in !== undefined) {
    const c = await resolveTarget(ctx, args.in, { scroll: false, promote: false });
    container = await kit.scrollContainerFor(c.ref);
  }
  const to = args.to;
  let target: Resolved | null = null;
  let top: number;
  let info;
  if (to !== undefined && typeof to !== 'number' && to !== 'top' && to !== 'bottom') {
    target = await resolveTarget(ctx, to, { scroll: false, promote: false });
    container ??= await kit.scrollContainerFor(target.ref, true);
    info = await kit.scrollInfo(container, target.ref);
    top = (info.target_top ?? 0) + (args.offset ?? pacing.scroll_offset ?? DEFAULT_SCROLL_OFFSET);
  } else {
    container ??= await kit.scrollContainerFor(null);
    info = await kit.scrollInfo(container);
    if (to === 'top') top = 0;
    else if (to === 'bottom') top = info.max_top;
    else if (typeof to === 'number') top = to;
    else if (args.by !== undefined) top = info.top + args.by;
    else throw new StepError('scroll: give `to` (px, target, top, bottom) or `by` (px)');
  }
  top = clamp(Math.round(top), 0, Math.max(0, info.max_top));
  if (top !== Math.round(info.top)) {
    const ms = (args.duration ?? pacing.scroll_duration) * 1000;
    await kit.scrollAnimate(container, top, info.left, ms);
    await ctx.rt.awaitFreshFrame();
  }
  const data = { container: container || 'document', from: Math.round(info.top), to: top };
  if (target) {
    const pt = await kit.point(target.ref);
    return { ref: target.ref, target: { desc: target.desc, bbox: pt?.bbox ?? target.bbox }, data };
  }
  return { target: { desc: `scrollTop ${top}` }, data };
}
