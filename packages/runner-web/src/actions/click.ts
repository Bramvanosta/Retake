import type { Page, Request } from 'playwright-core';
import { hasLocator, pickTarget } from '@demo-studio/core';
import type { ClickOptions, ClickStrategy, PointSpec, TargetObject, TargetSpec } from '@demo-studio/core';
import { StepError } from '../errors.js';
import { NUDGE_HOVER_MS, NUDGE_PX, distance } from '../motion.js';
import type { PopupEntry } from '../kit/types.js';
import { poll, resolveTarget } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { wallNow } from '../util.js';
import type { ActionResult } from './types.js';

export type UsedStrategy = Exclude<ClickStrategy, 'auto'>;

export interface ClickRun {
  resolved: Resolved;
  t_click: number;
  point: PointSpec;
  strategy: UsedStrategy;
  /** A popup was expected (aria-haspopup, aria-expanded=false, combobox, expect_popup). */
  expected: boolean;
  popup_opened: boolean;
  /** The click started a document navigation (waited for load). */
  navigated: boolean;
}

export interface ClickRunOptions extends ClickOptions {
  count?: 1 | 2;
}

/** Watches a page for a main-frame document navigation started by an action. */
export function watchNavigation(page: Page) {
  let started = false;
  let committed = false;
  const onRequest = (req: Request) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) started = true;
  };
  const onNav = (f: unknown) => {
    if (started && f === page.mainFrame()) committed = true;
  };
  page.on('request', onRequest);
  page.on('framenavigated', onNav);
  return {
    started: () => started,
    async settle(ctx: StepContext): Promise<void> {
      if (!started) return;
      if (!committed) {
        await page
          .waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 15_000 })
          .catch(() => ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: a navigation started but did not commit within 15 s`));
      }
      await ctx.rt.settle(page);
      await ctx.rt.pointer.syncPage();
    },
    stop(): void {
      page.off('request', onRequest);
      page.off('framenavigated', onNav);
    },
  };
}

async function popupOpened(ctx: StepContext, ref: string, before: Set<number>, expandedBefore: string | null, ms: number): Promise<boolean> {
  const { kit } = ctx.rt;
  const hit = await poll(
    ctx,
    async () => {
      const now = await kit.popupState();
      if (now.some((p) => !before.has(p.id))) return true;
      if (expandedBefore !== 'true' && (await kit.expanded(ref)) === 'true') return true;
      return false;
    },
    ms,
    40,
  );
  return hit === true;
}

/**
 * Move to the element (eased), re-check that it did not move meanwhile (correct with a short move), and return
 * the travelled distance.
 */
export async function approach(ctx: StepContext, r: Resolved, opts: { move_ms?: number; offset?: PointSpec } = {}): Promise<number> {
  const { pointer, kit } = ctx.rt;
  const dist = distance(pointer.pos(), r.point);
  await pointer.moveTo(r.point, { ms: opts.move_ms, jitter: ctx.jitter });
  const pt = await kit.point(r.ref, opts.offset ?? null);
  if (pt && (Math.abs(pt.x - r.point.x) > 2 || Math.abs(pt.y - r.point.y) > 2)) {
    r.point = { x: pt.x, y: pt.y };
    r.bbox = pt.bbox;
    r.hit = pt.hit;
    await pointer.moveTo(r.point, { ms: 160, jitter: ctx.jitter });
  } else if (pt) {
    r.bbox = pt.bbox;
  }
  return pointer.known ? dist : 0;
}

/**
 * The click engine. Real CDP input first; when a popup was expected and nothing new showed up within
 * popup_timeout_ms, fall back to el.click(), then to a synthetic pointer/mouse sequence.
 */
export async function clickResolved(ctx: StepContext, r: Resolved, opts: ClickRunOptions = {}): Promise<ClickRun> {
  const { rt } = ctx;
  const { pacing, pointer, kit } = rt;
  const dist = await approach(ctx, r, opts);
  const hoverMs = opts.hover_ms ?? (dist < NUDGE_PX ? NUDGE_HOVER_MS : pacing.hover_ms);
  await rt.sleep(ctx.jitter.ms(hoverMs));

  const expected = opts.expect_popup ?? r.popupExpected;
  const before = new Set((await kit.popupState()).map((p) => p.id));
  const expandedBefore = expected ? await kit.expanded(r.ref) : null;
  const page = rt.page;
  const nav = watchNavigation(page);
  const requested = opts.strategy ?? 'auto';
  let strategy: UsedStrategy;
  let t_click: number;
  let opened = false;
  try {
    if (requested === 'dom' || requested === 'pointer') {
      t_click = rt.now();
      if (requested === 'dom') await kit.domClick(r.ref, r.point.x, r.point.y);
      else await kit.pointerSequence(r.ref, r.point.x, r.point.y);
      strategy = requested;
    } else {
      t_click = await pointer.click({ button: opts.button, count: opts.count, modifiers: opts.modifiers });
      strategy = 'real';
    }
    const afterStart = wallNow();
    if (expected && !nav.started()) {
      opened = await popupOpened(ctx, r.ref, before, expandedBefore, pacing.popup_timeout_ms);
      if (!opened && requested === 'auto') {
        for (const fallback of ['dom', 'pointer'] as const) {
          if (nav.started() || !(await kit.visible(r.ref))) break;
          if ((await kit.expanded(r.ref)) === 'true') break;
          if (fallback === 'dom') await kit.domClick(r.ref, r.point.x, r.point.y);
          else await kit.pointerSequence(r.ref, r.point.x, r.point.y);
          strategy = fallback;
          opened = await popupOpened(ctx, r.ref, before, expandedBefore, pacing.popup_timeout_ms);
          if (opened) break;
        }
      }
      if (!opened) rt.warn(`${ctx.scene.id}.${ctx.step.index}: clicking ${r.spec} was expected to open a popup but none appeared`);
      await rt.sleep(ctx.jitter.ms(opts.after_ms ?? (opened ? pacing.after_popup_ms : pacing.after_click_ms)));
    } else {
      // Popups nobody announced (a button opening a dialog) still get the longer post-open pause.
      const afterMs = ctx.jitter.ms(opts.after_ms ?? pacing.after_click_ms);
      opened =
        (await poll(ctx, async () => !nav.started() && (await kit.popupState()).some((p) => !before.has(p.id)), afterMs, 50)) === true;
      const total = opened && opts.after_ms === undefined ? ctx.jitter.ms(pacing.after_popup_ms) : afterMs;
      await rt.sleep(afterStart + total - wallNow());
    }
    await nav.settle(ctx);
  } finally {
    nav.stop();
  }
  const run: ClickRun = { resolved: r, t_click, point: { ...pointer.pos() }, strategy, expected, popup_opened: opened, navigated: nav.started() };
  ctx.clicks.push({ t: t_click, point: run.point, desc: r.desc, bbox: r.bbox, strategy, popup_opened: opened });
  return run;
}

export async function clickTarget(ctx: StepContext, spec: TargetSpec, opts: ClickRunOptions = {}): Promise<ClickRun> {
  const r = await resolveTarget(ctx, spec, { offset: opts.offset });
  return clickResolved(ctx, r, opts);
}

/** Poll until none of the popups `ids` is visible any more. */
export async function waitPopupsGone(ctx: StepContext, ids: number[], timeoutMs = 3000): Promise<boolean> {
  if (!ids.length) return true;
  const gone = await poll(ctx, async () => !(await ctx.rt.kit.popupState()).some((p) => ids.includes(p.id)), timeoutMs, 50);
  return gone === true;
}

export interface OutsideRun {
  t_click: number;
  point: PointSpec;
  desc: string;
  closed: boolean;
}

/**
 * Close the open popover by clicking somewhere neutral: the topmost dialog's title when a dialog is open
 * (never Escape: it would close the whole dialog), else a blank point near the top of the page.
 */
export async function clickOutside(ctx: StepContext, open?: PopupEntry[]): Promise<OutsideRun> {
  const { rt } = ctx;
  const { kit, pointer, pacing } = rt;
  const before = open ?? (await kit.popupState());
  const plan = await kit.outsidePlan(pointer.pos(), before.map((p) => p.id));
  if (!plan) throw new StepError(`${ctx.step.action}: click outside found neither a dialog title nor a blank area to click`);
  const closing = before.map((p) => p.id).filter((id) => !plan.keep.includes(id));
  const target = { x: plan.x, y: plan.y };
  const dist = distance(pointer.pos(), target);
  await pointer.moveTo(target, { jitter: ctx.jitter });
  await rt.sleep(ctx.jitter.ms(dist < NUDGE_PX ? NUDGE_HOVER_MS : pacing.hover_ms * 0.7));
  const t_click = await pointer.click();
  const closed = await waitPopupsGone(ctx, closing, Math.max(1500, pacing.popup_timeout_ms * 3));
  if (!closed) rt.warn(`${ctx.scene.id}.${ctx.step.index}: the popover did not close after clicking outside`);
  await rt.sleep(ctx.jitter.ms(pacing.after_click_ms));
  const desc = plan.kind === 'dialog-title' ? 'dialog title (click outside)' : 'blank area (click outside)';
  ctx.clicks.push({ t: t_click, point: target, desc, strategy: 'real' });
  return { t_click, point: target, desc, closed };
}

function clickResult(run: ClickRun): ActionResult {
  const out: ActionResult = {
    target: { desc: run.resolved.desc, bbox: run.resolved.bbox },
    point: run.point,
    t_click: run.t_click,
    strategy: run.strategy,
  };
  if (run.expected || run.popup_opened) out.popup_opened = run.popup_opened;
  return out;
}

export async function click(ctx: StepContext, args: TargetObject & ClickOptions): Promise<ActionResult> {
  const target = pickTarget(args);
  if (args.outside !== undefined && args.outside !== false) {
    const closer: TargetSpec | null = args.outside === true ? (hasLocator(target) ? target : null) : args.outside;
    if (closer === null) {
      const before = await ctx.rt.kit.popupState();
      if (!before.length) ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: click outside: no popover is open`);
      const run = await clickOutside(ctx, before);
      return { target: { desc: run.desc }, point: run.point, t_click: run.t_click, strategy: 'real', data: { closed: run.closed } };
    }
    const before = await ctx.rt.kit.popupState();
    const run = await clickTarget(ctx, closer, { ...args, expect_popup: false });
    // Layers containing the clicked point (the dialog around a title) stay open; the others must close.
    const inside = (b: { x: number; y: number; w: number; h: number }) =>
      run.point.x >= b.x && run.point.x <= b.x + b.w && run.point.y >= b.y && run.point.y <= b.y + b.h;
    const closed = await waitPopupsGone(ctx, before.filter((p) => !inside(p.bbox)).map((p) => p.id));
    if (!closed) ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: the popover did not close after clicking ${run.resolved.desc}`);
    return { ...clickResult(run), data: { closed } };
  }
  if (!hasLocator(target)) throw new StepError('click: no target given (use text, role, label, css… or outside: true)');
  const run = await clickTarget(ctx, target, args);
  if (run.navigated) ctx.rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: click navigated to ${ctx.rt.page.url()}`);
  return clickResult(run);
}

export async function doubleClick(ctx: StepContext, args: TargetObject & ClickOptions): Promise<ActionResult> {
  if (args.strategy && args.strategy !== 'real' && args.strategy !== 'auto') {
    ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: double_click always uses real input (strategy ${args.strategy} ignored)`);
  }
  const run = await clickTarget(ctx, pickTarget(args), { ...args, strategy: 'real', count: 2 });
  return clickResult(run);
}

export async function hover(ctx: StepContext, args: TargetObject & { ms?: number; move_ms?: number }): Promise<ActionResult> {
  const r = await resolveTarget(ctx, pickTarget(args));
  await approach(ctx, r, { move_ms: args.move_ms });
  await ctx.rt.sleep(ctx.jitter.ms(args.ms ?? HOVER_ATTENTION_MS));
  return { target: { desc: r.desc, bbox: r.bbox }, point: ctx.rt.pointer.pos() };
}

/** Default pause of a `hover` step: long enough to draw attention without clicking. */
export const HOVER_ATTENTION_MS = 900;
