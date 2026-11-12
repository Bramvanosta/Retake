import type { Page, Request, Response } from 'playwright-core';
import { hasLocator, normalizeTarget, pickTarget } from '@retake/core/language';
import type { ClickOptions, ClickStrategy, PointSpec, TargetObject, TargetSpec } from '@retake/core/model';
import { StepError } from '../errors.js';
import { distance, isNudge } from '../motion.js';
import type { PopupEntry } from '../kit/types.js';
import { poll, resolveTarget } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { ClickRole, PendingPopup, StepContext } from '../runtime.js';
import { wallNow } from '../util.js';
import { DEAD_CLICK_MS, awaitEffect, checkInBackground, watchEffects } from './effects.js';
import type { EffectWatch } from './effects.js';
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
  /** ms from the first press to the evidence that the popup opened (aria-expanded / new popup). */
  popup_ms?: number;
  /** The click started a document navigation (waited for load). */
  navigated: boolean;
  /** The click changed the page: a document navigation, or a new URL (SPA route, ignoring the hash). */
  page_changed: boolean;
  /** No popup was announced nor seen: the popups open at the press, for a late popup check (settleLatePopup). */
  pending_popup?: { before: number[]; wall: number };
  /** What the click caused, watched from its press (ClickRunOptions.watch_effects; the caller stops it). */
  effects?: EffectWatch;
}

export interface ClickRunOptions extends ClickOptions {
  count?: 1 | 2;
  /** Role of the click inside a composite step (recorded in data.clicks). Default 'trigger'. */
  click_role?: ClickRole;
  /** Watch what the click causes from its press (dead clicks, R-FLD-12): ClickRun.effects. */
  watch_effects?: boolean;
}

/** URL without its hash: a hash change is an in-page jump, not a new page. */
function pageUrl(page: Page): string {
  try {
    return page.url().replace(/#.*$/, '');
  } catch {
    return '';
  }
}

/**
 * Watches a page for a main-frame document navigation started by an action. A navigation that turns into a download
 * (Content-Disposition: attachment, a file the browser does not display) never commits: it is not a page change. Nor is
 * one answered 204 / 205 or aborted — a form POST the read-only guard stopped (L1.7) is answered 204: the page stays
 * where it is, at once (never a 15 s wait for a commit that cannot come).
 */
export function watchNavigation(page: Page) {
  let started = false;
  let committed = false;
  let downloaded = false;
  /** The main-frame navigation request (each redirect hop replaces it). */
  let request: Request | null = null;
  let wake: () => void = () => undefined;
  const dropped = () => {
    if (committed) return;
    started = false;
    request = null;
    wake();
  };
  const onRequest = (req: Request) => {
    let main = false;
    try {
      main = req.isNavigationRequest() && req.frame() === page.mainFrame();
    } catch {
      main = false; // no frame (a request of another window)
    }
    if (main && !downloaded) {
      started = true;
      request = req;
    }
  };
  const onResponse = (res: Response) => {
    if (res.request() === request && (res.status() === 204 || res.status() === 205)) dropped();
  };
  const onFailed = (req: Request) => {
    // An aborted navigation commits nothing (a refused one commits an error page: that one is waited for).
    if (req === request && /ERR_ABORTED/.test(req.failure()?.errorText ?? '')) dropped();
  };
  const onNav = (f: unknown) => {
    if (started && f === page.mainFrame()) committed = true;
  };
  const onDownload = () => {
    downloaded = true;
    if (!committed) started = false;
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNav);
  page.on('download', onDownload);
  return {
    started: () => started,
    downloaded: () => downloaded,
    async settle(ctx: StepContext): Promise<void> {
      if (!started) return;
      if (!committed) {
        // At least 15 s; a longer step timeout (`timeout`, defaults.timeout_s) gives a slow page longer (R-FLD-14).
        const commitMs = Math.max(15_000, ctx.timeoutMs);
        const nav = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: commitMs }).then(() => 'nav' as const);
        const dl = page.waitForEvent('download', { timeout: commitMs }).then(() => 'download' as const);
        const gone = new Promise<'dropped'>((resolve) => (wake = () => resolve('dropped')));
        const first = await Promise.race([nav, dl, gone]).catch(() => 'timeout' as const);
        wake = () => undefined;
        nav.catch(() => undefined);
        dl.catch(() => undefined);
        if (first === 'download' || downloaded) {
          started = false;
          return;
        }
        if (first === 'dropped' || (!started && !committed)) return;
        if (first === 'timeout') ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: a navigation started but did not commit within ${Math.round(commitMs / 1000)} s`);
      }
      await ctx.rt.settle(page);
      await ctx.rt.pointer.syncPage();
    },
    stop(): void {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      page.off('framenavigated', onNav);
      page.off('download', onDownload);
    },
  };
}

/** Poll (every 40 ms, up to `ms`) for evidence that a popup opened: aria-expanded="true" on the trigger or a new visible popup. */
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
 * The click engine. Real CDP input first; when a popup was expected and no evidence of it (aria-expanded="true" or a
 * new visible popup, polled every 40 ms) showed up within popup_fallback_ms, fall back to el.click(), then to a
 * synthetic pointer/mouse sequence (which waits up to popup_timeout_ms). A click that changed the page (navigation or
 * new URL) is followed by at least after_navigation_ms of stillness so the new page can be seen.
 */
export async function clickResolved(ctx: StepContext, r: Resolved, opts: ClickRunOptions = {}): Promise<ClickRun> {
  const { rt } = ctx;
  const { pacing, pointer, kit } = rt;
  const dist = await approach(ctx, r, opts);
  const hoverMs = opts.hover_ms ?? (isNudge(dist, pacing) ? pacing.nudge_hover_ms : pacing.hover_ms);
  await rt.sleep(ctx.jitter.ms(hoverMs));

  const expected = opts.expect_popup ?? r.popupExpected;
  const before = new Set((await kit.popupState()).map((p) => p.id));
  const expandedBefore = expected ? await kit.expanded(r.ref) : null;
  const page = rt.page;
  const urlBefore = pageUrl(page);
  const nav = watchNavigation(page);
  const requested = opts.strategy ?? 'auto';
  let strategy: UsedStrategy;
  let t_click: number;
  let opened = false;
  let popupMs: number | undefined;
  let clickWall = 0;
  const effects = opts.watch_effects ? await watchEffects(ctx) : undefined;
  try {
    clickWall = wallNow();
    if (requested === 'dom' || requested === 'pointer') {
      t_click = rt.now();
      if (requested === 'dom') await kit.domClick(r.ref, r.point.x, r.point.y);
      else await kit.pointerSequence(r.ref, r.point.x, r.point.y);
      strategy = requested;
    } else {
      t_click = await pointer.click({ button: opts.button, count: opts.count, modifiers: opts.modifiers });
      // The press may have waited for the capture to catch up (Pointer beforePress, L1.3): time the click from it.
      clickWall = wallNow() - (rt.now() - t_click) * 1000;
      strategy = 'real';
    }
    if (effects) effects.wall = clickWall;
    const afterStart = wallNow();
    if (expected && !nav.started()) {
      const auto = requested === 'auto';
      // With fallbacks left, a click gets popup_fallback_ms to show evidence; the last strategy gets popup_timeout_ms.
      opened = await popupOpened(ctx, r.ref, before, expandedBefore, auto ? pacing.popup_fallback_ms : pacing.popup_timeout_ms);
      if (!opened && auto) {
        const fallbacks = ['dom', 'pointer'] as const;
        for (let i = 0; i < fallbacks.length; i++) {
          const fallback = fallbacks[i];
          if (nav.started() || !(await kit.visible(r.ref))) break;
          if ((await kit.expanded(r.ref)) === 'true' || (await kit.popupState()).some((p) => !before.has(p.id))) {
            opened = true; // late evidence: the previous strategy worked after all
            break;
          }
          if (fallback === 'dom') await kit.domClick(r.ref, r.point.x, r.point.y);
          else await kit.pointerSequence(r.ref, r.point.x, r.point.y);
          strategy = fallback;
          const last = i === fallbacks.length - 1;
          opened = await popupOpened(ctx, r.ref, before, expandedBefore, last ? pacing.popup_timeout_ms : pacing.popup_fallback_ms);
          if (opened) break;
        }
      }
      if (opened) popupMs = Math.round(wallNow() - clickWall);
      if (!opened) rt.warn(`${ctx.scene.id}.${ctx.step.index}: clicking ${r.spec} was expected to open a popup but none appeared`);
      await rt.sleep(ctx.jitter.ms(opts.after_ms ?? (opened ? pacing.after_popup_ms : pacing.after_click_ms)));
    } else {
      // Popups nobody announced (a button opening a dialog) still get the longer post-open pause.
      const afterMs = ctx.jitter.ms(opts.after_ms ?? pacing.after_click_ms);
      opened = (await poll(ctx, async () => !nav.started() && (await kit.popupState()).some((p) => !before.has(p.id)), afterMs, 50)) === true;
      if (opened) popupMs = Math.round(wallNow() - clickWall);
      const total = opened && opts.after_ms === undefined ? ctx.jitter.ms(pacing.after_popup_ms) : afterMs;
      await rt.sleep(afterStart + total - wallNow());
    }
    await nav.settle(ctx);
    // The new document painted (R-ISS-08): until then the capture holds the previous frame.
    if (nav.started()) await rt.awaitLoaded(page);
  } catch (e) {
    effects?.stop();
    throw e;
  } finally {
    nav.stop();
  }
  const pageChanged = nav.started() || (urlBefore !== '' && pageUrl(page) !== urlBefore);
  if (pageChanged && opts.after_ms === undefined) {
    // Field notes: hold 1.5–2.8 s after an action that changes the page, so the viewer sees the new page. A load the
    // capture held (R-ISS-08) is cut by the edit: it must not eat the new page's screen time.
    const left = clickWall + pacing.after_navigation_ms + rt.heldMs(page, clickWall) - wallNow();
    if (left > 0) await rt.sleep(left);
  }
  const run: ClickRun = {
    resolved: r,
    t_click,
    point: { ...pointer.pos() },
    strategy,
    expected,
    popup_opened: opened,
    navigated: nav.started(),
    page_changed: pageChanged,
  };
  if (popupMs !== undefined) run.popup_ms = popupMs;
  if (effects) run.effects = effects;
  if (!expected && !opened && !pageChanged) run.pending_popup = { before: [...before], wall: clickWall };
  ctx.clicks.push({
    role: opts.click_role ?? 'trigger',
    t: t_click,
    point: run.point,
    desc: r.desc,
    bbox: r.bbox,
    strategy,
    popup_opened: opened,
    ...(popupMs !== undefined ? { popup_ms: popupMs } : {}),
  });
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
  const plan = await kit.outsidePlan(
    pointer.pos(),
    before.map((p) => p.id),
  );
  if (!plan) throw new StepError(`${ctx.step.action}: click outside found neither a dialog title nor a blank area to click`);
  const closing = before.map((p) => p.id).filter((id) => !plan.keep.includes(id));
  const target = { x: plan.x, y: plan.y };
  const dist = distance(pointer.pos(), target);
  await pointer.moveTo(target, { jitter: ctx.jitter });
  await rt.sleep(ctx.jitter.ms(isNudge(dist, pacing) ? pacing.nudge_hover_ms : pacing.hover_ms * 0.7));
  const t_click = await pointer.click();
  const closed = await waitPopupsGone(ctx, closing, Math.max(1500, pacing.popup_timeout_ms * 3));
  if (!closed) rt.warn(`${ctx.scene.id}.${ctx.step.index}: the popover did not close after clicking outside`);
  await rt.sleep(ctx.jitter.ms(pacing.after_click_ms));
  const desc = plan.kind === 'dialog-title' ? 'dialog title (click outside)' : 'blank area (click outside)';
  ctx.clicks.push({ role: 'outside', t: t_click, point: target, desc, strategy: 'real', popup_opened: false });
  return { t_click, point: target, desc, closed };
}

/**
 * A plain click (no popup announced) that showed nothing within after_click_ms can still open a popup on a slow or
 * loaded machine. When the next step's target `t` is not on screen yet, wait — up to popup_timeout_ms after the press,
 * and no longer than until the target shows up without a popup — for a new popup; when one opens, the click is recorded as having opened it, its step lasts until the post-popup
 * pause ends (the viewer sees the popup before the cursor moves on) and true is returned.
 */
export async function settleLatePopup(ctx: StepContext, pending: PendingPopup, t: TargetSpec | null): Promise<boolean> {
  const { rt } = ctx;
  const { kit, pacing } = rt;
  if (pending.page !== rt.page || !t) return false;
  const target = normalizeTarget(t);
  const found = await kit.find(target).catch(() => null);
  if (!found || found.count > 0) return false;
  const left = pending.wall + pacing.popup_timeout_ms - wallNow();
  if (left <= 0) return false;
  const before = new Set(pending.before);
  // Popups first in each tick (a late dialog holding the target is still a popup), then stop as soon as the target
  // shows up without one: content that renders late is not a popup, and waiting on would only add dead time.
  const popped = async () => (await kit.popupState()).some((p) => !before.has(p.id));
  const seen = await poll(
    ctx,
    async () => {
      if (await popped()) return 'popup' as const;
      const f = await kit.find(target).catch(() => null);
      if (!f || f.count === 0) return null;
      // The popup may have opened between the two looks (it holds the target): look again before calling it content.
      return (await popped()) ? ('popup' as const) : ('target' as const);
    },
    left,
    40,
  );
  if (seen !== 'popup') return false;
  pending.ev.popup_opened = true;
  rt.log('debug', `${pending.ev.scene}.${pending.ev.step}: the click opened a popup ${Math.round(wallNow() - pending.wall)} ms after the press`);
  await rt.sleep(ctx.jitter.ms(pacing.after_popup_ms));
  pending.ev.t_end = rt.now();
  return true;
}

/** Every pointer interaction of a composite step, as recorded in the timeline (`data.clicks`). */
export function clickData(ctx: StepContext): Array<Record<string, unknown>> {
  return ctx.clicks.map((c) => {
    const out: Record<string, unknown> = {
      role: c.role,
      strategy: c.strategy ?? 'real',
      popup_opened: c.popup_opened ?? false,
      point: { x: c.point.x, y: c.point.y },
      t_click: c.t,
      desc: c.desc,
    };
    if (c.bbox) out.bbox = { ...c.bbox };
    if (c.popup_ms !== undefined) out.popup_ms = c.popup_ms;
    return out;
  });
}

function clickResult(run: ClickRun & { retried?: true }, ctx: StepContext): ActionResult {
  const out: ActionResult = {
    ref: run.resolved.ref,
    target: { desc: run.resolved.desc, bbox: run.resolved.bbox },
    point: run.point,
    t_click: run.t_click,
    strategy: run.strategy,
  };
  if (run.expected || run.popup_opened) out.popup_opened = run.popup_opened;
  if (run.pending_popup) out.pending_popup = run.pending_popup;
  if (run.page_changed) out.data = { navigation: { kind: run.navigated ? 'document' : 'url', url: ctx.rt.page.url() } };
  if (run.retried) out.data = { ...((out.data as Record<string, unknown> | undefined) ?? {}), retried: true };
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
    const inside = (b: { x: number; y: number; w: number; h: number }) => run.point.x >= b.x && run.point.x <= b.x + b.w && run.point.y >= b.y && run.point.y <= b.y + b.h;
    const closed = await waitPopupsGone(
      ctx,
      before.filter((p) => !inside(p.bbox)).map((p) => p.id),
    );
    if (!closed) ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: the popover did not close after clicking ${run.resolved.desc}`);
    return { ...clickResult(run, ctx), data: { closed } };
  }
  if (!hasLocator(target)) throw new StepError('click: no target given (use text, role, label, css… or outside: true)');
  const run = await liveClick(ctx, target, args);
  if (run.page_changed) ctx.rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: click changed the page to ${ctx.rt.page.url()}`);
  return clickResult(run, ctx);
}

/**
 * A plain click watched for its effect (R-FLD-12). A click that showed none by the time it returns (a popup opened, the
 * page changed, or anything else seen ends the watch) is checked until DEAD_CLICK_MS after its press: in the background
 * (a dead click warns with a screenshot), or — `retry_click: true` — right here, clicking once more when it did nothing,
 * and failing the step when the second click did nothing either.
 */
async function liveClick(ctx: StepContext, target: TargetSpec, opts: ClickRunOptions): Promise<ClickRun & { retried?: true }> {
  const r = await resolveTarget(ctx, target, { offset: opts.offset });
  const run = await clickResolved(ctx, r, { ...opts, watch_effects: true });
  const fx = run.effects;
  if (!fx) return run;
  const first = run.popup_opened || run.page_changed ? 'page' : await fx.seen();
  if (first !== null) {
    fx.stop();
    ctx.rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: the click's first effect: ${first}`);
    return run;
  }
  if (ctx.step.retry_click !== true) {
    checkInBackground(ctx, fx, run.resolved.desc);
    return run;
  }
  const seen = await awaitEffect(ctx, fx);
  fx.stop();
  if (seen !== null) return run;
  ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: clicking ${run.resolved.desc} produced nothing within ${DEAD_CLICK_MS / 1000} s: clicking once more (retry_click)`);
  const again = await clickResolved(ctx, r, { ...opts, watch_effects: true });
  const fx2 = again.effects!;
  const seen2 = again.popup_opened || again.page_changed ? 'page' : await awaitEffect(ctx, fx2);
  fx2.stop();
  if (seen2 === null) {
    throw new StepError(
      `clicking ${again.resolved.desc} twice produced nothing within ${DEAD_CLICK_MS / 1000} s each time (no request, DOM change, navigation, dialog or new tab): the control looks disabled or dead`,
      { target: again.resolved.spec },
      again.resolved.ref,
    );
  }
  return { ...again, retried: true };
}

export async function doubleClick(ctx: StepContext, args: TargetObject & ClickOptions): Promise<ActionResult> {
  if (args.strategy && args.strategy !== 'real' && args.strategy !== 'auto') {
    ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: double_click always uses real input (strategy ${args.strategy} ignored)`);
  }
  const run = await liveClick(ctx, pickTarget(args), { ...args, strategy: 'real', count: 2 });
  return clickResult(run, ctx);
}

export async function hover(ctx: StepContext, args: TargetObject & { ms?: number; move_ms?: number }): Promise<ActionResult> {
  const r = await resolveTarget(ctx, pickTarget(args));
  await approach(ctx, r, { move_ms: args.move_ms });
  await ctx.rt.sleep(ctx.jitter.ms(args.ms ?? HOVER_ATTENTION_MS));
  return { target: { desc: r.desc, bbox: r.bbox }, point: ctx.rt.pointer.pos() };
}

/** Default pause of a `hover` step: long enough to draw attention without clicking. */
export const HOVER_ATTENTION_MS = 900;
