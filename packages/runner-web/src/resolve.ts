import { describeScope, describeTarget, normalizeTarget } from '@demo-studio/core';
import type { BBox, PointSpec, TargetObject, TargetSpec } from '@demo-studio/core';
import { StepError, formatNear } from './errors.js';
import type { ResolveMissing, ResolveResult } from './kit/types.js';
import type { StepContext } from './runtime.js';
import { clamp, wallNow } from './util.js';

export interface Resolved {
  ref: string;
  /** Description of the element found (`button "Save"`). */
  desc: string;
  /** Description of the target spec (`text="Save" in dialog`). */
  spec: string;
  bbox: BBox;
  /** Where to point: centre of the visible part, or `offset` from the top-left. */
  point: PointSpec;
  /** elementFromPoint at `point` is the element (not covered by something else). */
  hit: boolean;
  count: number;
  href: string | null;
  popupExpected: boolean;
  tag: string;
  role: string | null;
  text: string;
}

export interface ResolveOptions {
  timeoutMs?: number;
  /** Scroll the element's containers so it is fully visible (default true). */
  scroll?: boolean;
  promote?: boolean;
  offset?: PointSpec;
  includeHidden?: boolean;
}

const POLL_MS = 100;
/** Margin kept between an element and the container edges when scrolling it into view. */
const VIEW_MARGIN = 80;

/** Poll `fn` until it returns a truthy value or the timeout elapses (then null). */
export async function poll<T>(
  ctx: StepContext,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = POLL_MS,
): Promise<T | null> {
  const deadline = wallNow() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (wallNow() >= deadline) return null;
    await ctx.rt.sleep(Math.min(intervalMs, Math.max(0, deadline - wallNow())));
  }
}

export function notFoundError(target: TargetObject, last: ResolveMissing | null, timeoutMs: number): StepError {
  const desc = describeTarget(target);
  const parts = [`no visible element matches ${desc} after ${(timeoutMs / 1000).toFixed(1)} s`];
  if (last && !last.scope_found && target.in !== undefined) parts.push(`scope ${describeScope(target.in)} not found`);
  if (last?.desc) parts.push(last.desc);
  if (last?.hidden) parts.push(`${last.hidden} hidden match${last.hidden > 1 ? 'es' : ''} ignored`);
  parts.push(formatNear(last?.near));
  return new StepError(parts.join('; '), {
    target: desc,
    candidates: 0,
    hidden: last?.hidden ?? 0,
    near: last?.near ?? [],
    scope_found: last?.scope_found ?? true,
  });
}

/** Scroll every container of `ref` (innermost first) with eased in-page animations until it is in view. */
export async function ensureInView(ctx: StepContext, ref: string): Promise<boolean> {
  const { kit, pacing } = ctx.rt;
  let scrolled = false;
  for (let i = 0; i < 4; i++) {
    const op = await kit.scrollPlan(ref, VIEW_MARGIN);
    if (!op) break;
    const dist = Math.hypot(op.top - op.from_top, op.left - op.from_left);
    const ms = ctx.jitter.ms(clamp(350 + dist * 0.6, 450, pacing.scroll_duration * 1000));
    await kit.scrollAnimate(op.container, op.top, op.left, ms);
    scrolled = true;
  }
  if (scrolled) await ctx.rt.awaitFreshFrame();
  return scrolled;
}

async function finish(ctx: StepContext, found: Exclude<ResolveResult, ResolveMissing>, spec: string, opts: ResolveOptions, deadline: number): Promise<Resolved | null> {
  const { kit } = ctx.rt;
  if (opts.scroll !== false && !found.in_view) await ensureInView(ctx, found.ref);
  let pt = await kit.point(found.ref, opts.offset ?? null);
  if (!pt) return null;
  if (!pt.hit && opts.scroll !== false && !opts.includeHidden) {
    // Covered (closing popover, toast, transition): give it a moment to clear.
    const cleared = await poll(ctx, async () => {
      const p = await kit.point(found.ref, opts.offset ?? null);
      return p && p.hit ? p : null;
    }, clamp(deadline - wallNow(), 0, 1500));
    if (cleared) pt = cleared;
    else ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: ${spec} is covered by another element at (${pt.x}, ${pt.y})`);
  }
  return {
    ref: found.ref,
    desc: found.desc,
    spec,
    bbox: pt.bbox,
    point: { x: pt.x, y: pt.y },
    hit: pt.hit,
    count: found.count,
    href: found.href,
    popupExpected: found.popup_expected,
    tag: found.tag,
    role: found.role,
    text: found.text,
  };
}

/** Resolve a target with polling until the step timeout; scrolls it into view; throws a rich StepError. */
export async function resolveTarget(ctx: StepContext, spec: TargetSpec, opts: ResolveOptions = {}): Promise<Resolved> {
  const target = normalizeTarget(spec);
  const timeoutMs = opts.timeoutMs ?? ctx.timeoutMs;
  const deadline = wallNow() + timeoutMs;
  const desc = describeTarget(target);
  let last: ResolveMissing | null = null;
  for (;;) {
    const r = await ctx.rt.kit.find(target, { promote: opts.promote, include_hidden: opts.includeHidden });
    if (r.count > 0 && 'ref' in r) {
      const done = await finish(ctx, r, desc, opts, deadline);
      if (done) return done;
    } else {
      last = r as ResolveMissing;
    }
    if (wallNow() >= deadline) throw notFoundError(target, last, timeoutMs);
    await ctx.rt.sleep(Math.min(POLL_MS, Math.max(0, deadline - wallNow())));
  }
}

/** Non-throwing single lookup (count of visible matches). */
export async function countMatches(ctx: StepContext, spec: TargetSpec): Promise<number> {
  const r = await ctx.rt.kit.find(normalizeTarget(spec));
  return r.count;
}

/** Resolved info for an element the kit already designated (row trigger, confirm button…). */
export async function resolveRef(ctx: StepContext, ref: string, spec: string): Promise<Resolved> {
  const info = await ctx.rt.kit.info(ref);
  if (!info) throw new StepError(`${ctx.step.action}: ${spec} disappeared before it could be used`);
  const found = {
    count: 1,
    index: 0,
    desc: info.desc,
    ref,
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    tag: info.tag,
    role: info.role,
    text: info.text,
    href: info.href,
    popup_expected: info.popup_expected,
    in_view: false,
  };
  const done = await finish(ctx, found, spec, {}, wallNow() + ctx.timeoutMs);
  if (!done) throw new StepError(`${ctx.step.action}: ${spec} disappeared before it could be used`);
  return done;
}
