import { describeTarget } from '@demo-studio/core';
import type { MenuArgs, PickArgs, SelectArgs, TargetObject, TargetSpec } from '@demo-studio/core';
import { StepError, formatNear } from '../errors.js';
import type { ResolveMissing } from '../kit/types.js';
import { ensureInView, poll, resolveRef, resolveTarget } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { wallNow } from '../util.js';
import { approach, clickData, clickOutside, clickResolved, waitPopupsGone } from './click.js';
import type { ClickRun } from './click.js';
import { SEARCH_MAX_CPS, typeText } from './keyboard.js';
import type { ActionResult } from './types.js';

/** Wait for an expected option/item before re-clicking its trigger once (field-tested value). */
export const RETRY_TRIGGER_AFTER_MS = 3000;
/** Base UI may re-open the row menu shortly after its confirmation dialog closes. */
const MENU_REOPEN_GRACE_MS = 300;

/** First visible match among several target formulations (most specific first). */
async function findFirst(ctx: StepContext, targets: TargetObject[], timeoutMs: number): Promise<Resolved | null> {
  const hit = await poll(
    ctx,
    async () => {
      for (const t of targets) {
        const r = await ctx.rt.kit.find(t);
        if (r.count > 0) return t;
      }
      return null;
    },
    timeoutMs,
  );
  if (!hit) return null;
  return resolveTarget(ctx, hit, { timeoutMs: 1000 });
}

async function missing(ctx: StepContext, what: string, scope: TargetObject['in'], timeoutMs: number): Promise<StepError> {
  const r = await ctx.rt.kit.find({ text: what, in: scope });
  const near = r.count === 0 ? (r as ResolveMissing).near : [];
  const scopeNote = r.count === 0 && !(r as ResolveMissing).scope_found ? ' (no popover is open)' : '';
  return new StepError(
    `${ctx.step.action}: "${what}" not found in the open ${scope}${scopeNote} after ${(timeoutMs / 1000).toFixed(1)} s; ${formatNear(near)}`,
    { target: describeTarget({ text: what, in: scope }), candidates: 0, near },
  );
}

function optionTargets(option: string): TargetObject[] {
  return [
    { role: 'option', name: option, in: 'listbox' },
    { role: 'option', name: option, in: 'popover' },
    { role: 'menuitem', name: option, in: 'popover' },
    { role: 'checkbox', name: option, in: 'popover' },
    { text: option, in: 'popover' },
  ];
}

function menuItemTargets(item: string): TargetObject[] {
  return [
    { role: 'menuitem', name: item, in: 'menu' },
    { text: item, in: 'menu' },
    { role: 'menuitem', name: item, in: 'popover' },
    { text: item, in: 'popover' },
  ];
}

const SEARCH_FIELD: TargetObject = {
  css: 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[role=searchbox],[role=combobox][contenteditable]',
  in: 'popover',
};

/** Type into the popover's search field (the focused input, else the first input of the popover). */
async function typeSearch(ctx: StepContext, text: string): Promise<void> {
  const { rt } = ctx;
  if (!(await rt.kit.isTextInput(null))) {
    const input = await resolveTarget(ctx, SEARCH_FIELD, { timeoutMs: 2000 }).catch(() => null);
    if (!input) throw new StepError(`${ctx.step.action}: no search field in the open popover to type "${text}"`);
    await clickResolved(ctx, input, { expect_popup: false, after_ms: 200, click_role: 'search' });
  }
  await typeText(ctx, text, Math.min(ctx.rt.pacing.type_cps, SEARCH_MAX_CPS));
  await rt.sleep(ctx.jitter.ms(300));
}

/** A search can be typed now: the focus is in a text field, or the open popover has a search field. */
async function searchReady(ctx: StepContext): Promise<boolean> {
  return (await ctx.rt.kit.isTextInput(null)) || (await ctx.rt.kit.find(SEARCH_FIELD)).count > 0;
}

export async function popupIds(ctx: StepContext): Promise<Set<number>> {
  return new Set((await ctx.rt.kit.popupState()).map((p) => p.id));
}

/**
 * Nothing opened since `before` (the popups taken before the trigger click): no new popup, and the trigger does not
 * say it is expanded (R-CHO-10). Another popup already open (the dialog holding the field) does not count.
 */
export async function nothingOpened(ctx: StepContext, trigger: Resolved, before: Set<number>): Promise<boolean> {
  if ((await ctx.rt.kit.popupState()).some((p) => !before.has(p.id))) return false;
  return (await ctx.rt.kit.expanded(trigger.ref).catch(() => null)) !== 'true';
}

/** Click the trigger once more when nothing opened (R-CHO-10); the re-click is the trigger click that counts. */
export async function reclick(ctx: StepContext, trigger: Resolved, expectPopup: boolean): Promise<ClickRun | null> {
  if (!(await ctx.rt.kit.visible(trigger.ref))) return null;
  ctx.rt.log('info', `${ctx.scene.id}.${ctx.step.index}: nothing opened, clicking ${trigger.desc} once more`);
  return clickResolved(ctx, trigger, { expect_popup: expectPopup, click_role: 'trigger' });
}

/** Composite result: the top-level fields describe the trigger click; `data.clicks` keeps every click. */
export function composite(trigger: ClickRun, ctx: StepContext, data: Record<string, unknown>): ActionResult {
  return {
    ref: trigger.resolved.ref,
    target: { desc: trigger.resolved.desc, bbox: trigger.resolved.bbox },
    point: trigger.point,
    t_click: trigger.t_click,
    strategy: trigger.strategy,
    popup_opened: trigger.popup_opened,
    data: { ...data, clicks: clickData(ctx) },
  };
}

/**
 * Open a trigger and find an option/item (R-CHO-10). When the item is still missing RETRY_TRIGGER_AFTER_MS after the
 * click and nothing opened (no new popup, the trigger not expanded), the trigger is clicked once more. A popup that
 * opened but is still filling is never re-clicked (a second click would close it). With `search`: the search is typed
 * at once when it can be (the focus is in a text field — an editable combobox opens its listbox on input —, or the
 * popover shows its search field); otherwise the runner waits for something to open, re-clicks if nothing did, then
 * types. The search is typed once.
 */
async function openAndFind(
  ctx: StepContext,
  trigger: Resolved,
  targets: TargetObject[],
  search: string | undefined,
): Promise<{ open: ClickRun; found: Resolved | null; retried: boolean }> {
  const { rt } = ctx;
  const deadline = wallNow() + ctx.timeoutMs;
  const before = await popupIds(ctx);
  // An editable combobox searched by typing opens on input, not on the click: no popup is expected from the click.
  const expectPopup = !(search && (await rt.kit.isTextInput(trigger.ref)));
  let open = await clickResolved(ctx, trigger, { expect_popup: expectPopup, click_role: 'trigger' });
  let retried = false;
  const firstWait = Math.min(RETRY_TRIGGER_AFTER_MS, ctx.timeoutMs);
  if (search) {
    const ready = await poll(ctx, async () => (await searchReady(ctx)) || !(await nothingOpened(ctx, trigger, before)), firstWait);
    if (!ready) {
      const again = await reclick(ctx, trigger, expectPopup);
      if (again) [open, retried] = [again, true];
    }
    await typeSearch(ctx, search);
    return { open, found: await findFirst(ctx, targets, Math.max(500, deadline - wallNow())), retried };
  }
  let found = await findFirst(ctx, targets, firstWait);
  if (!found && (await nothingOpened(ctx, trigger, before))) {
    const again = await reclick(ctx, trigger, expectPopup);
    if (again) [open, retried] = [again, true];
    found = await findFirst(ctx, targets, Math.max(500, deadline - wallNow()));
  } else if (!found) {
    found = await findFirst(ctx, targets, Math.max(0, deadline - wallNow()));
  }
  return { open, found, retried };
}

export async function select(ctx: StepContext, args: SelectArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const spec: TargetSpec | null = args.combobox ?? (args.field !== undefined ? { label: args.field } : null);
  if (spec === null) throw new StepError('select: give `combobox` (the trigger) or `field` (its label)');
  const trigger = await resolveTarget(ctx, spec);

  if (trigger.tag === 'select') {
    // Native <select>: its dropdown is drawn by the OS (never captured), so pick the value in place.
    await approach(ctx, trigger);
    await rt.sleep(ctx.jitter.ms(rt.pacing.hover_ms));
    const t_click = rt.now();
    await rt.kit.ripple(trigger.point.x, trigger.point.y);
    const res = await rt.kit.selectNative(trigger.ref, args.option);
    if (!res.ok) {
      throw new StepError(
        `select: option "${args.option}" not found in ${trigger.desc}; options: ${res.options.map((o) => JSON.stringify(o)).join(', ')}`,
      );
    }
    await rt.sleep(ctx.jitter.ms(rt.pacing.after_click_ms));
    ctx.clicks.push({ role: 'trigger', t: t_click, point: trigger.point, desc: trigger.desc, bbox: trigger.bbox, strategy: 'native', popup_opened: false });
    return {
      target: { desc: trigger.desc, bbox: trigger.bbox },
      point: trigger.point,
      t_click,
      strategy: 'native',
      popup_opened: false,
      data: { option: res.label, clicks: clickData(ctx) },
    };
  }

  const initial = await popupIds(ctx);
  const { open, found, retried } = await openAndFind(ctx, trigger, optionTargets(args.option), args.search);
  if (!found) throw await missing(ctx, args.option, 'popover', ctx.timeoutMs);
  const opened = [...(await popupIds(ctx))].filter((id) => !initial.has(id));
  await clickResolved(ctx, found, { expect_popup: false, hover_ms: rt.pacing.nudge_hover_ms + 60, click_role: 'option' });
  if (!(await waitPopupsGone(ctx, opened, 1500))) {
    rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: the listbox stayed open after choosing "${args.option}"`);
  }
  return composite(open, ctx, { option: args.option, ...(retried ? { retried } : {}) });
}

export async function pick(ctx: StepContext, args: PickArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const options = Array.isArray(args.option) ? args.option : [args.option];
  if (!options.length) throw new StepError('pick: `option` is empty');
  const spec: TargetSpec = typeof args.field === 'string' ? { label: args.field } : args.field;
  const initial = await popupIds(ctx);
  const trigger = await resolveTarget(ctx, spec);
  const { open, found: first, retried } = await openAndFind(ctx, trigger, optionTargets(options[0]), args.search);
  if (!first) throw await missing(ctx, options[0], 'popover', ctx.timeoutMs);
  await clickResolved(ctx, first, { expect_popup: false, click_role: 'option' });
  for (const opt of options.slice(1)) {
    const r = await findFirst(ctx, optionTargets(opt), ctx.timeoutMs);
    if (!r) throw await missing(ctx, opt, 'popover', ctx.timeoutMs);
    await clickResolved(ctx, r, { expect_popup: false, click_role: 'option' });
  }
  const close = args.close ?? 'outside';
  await closeOpened(ctx, initial, close);
  return composite(open, ctx, { options, close, ...(retried ? { retried } : {}) });
}

/**
 * Close the popups a composite step opened (those not in `initial`): `outside` clicks a neutral spot, `escape` presses
 * Escape, `auto` first waits up to `autoMs` for them to close by themselves, `none` leaves them.
 */
export async function closeOpened(ctx: StepContext, initial: Set<number>, close: 'auto' | 'outside' | 'escape' | 'none', autoMs = 1500): Promise<void> {
  const { rt } = ctx;
  const mine = async () => (await rt.kit.popupState()).filter((p) => !initial.has(p.id));
  const opened = await mine();
  if (!opened.length || close === 'none') return;
  // Only what the step opened is closed: a popover that was open before (the one holding the field) stays open.
  if (close === 'auto') {
    if (await waitPopupsGone(ctx, opened.map((p) => p.id), autoMs)) return;
    const left = await mine();
    if (left.length) await clickOutside(ctx, left);
  } else if (close === 'outside') {
    await clickOutside(ctx, opened);
  } else {
    await rt.page.keyboard.press('Escape');
    if (!(await waitPopupsGone(ctx, opened.map((p) => p.id)))) rt.warn(`${ctx.scene.id}.${ctx.step.index}: the popover did not close on Escape`);
    await rt.sleep(ctx.jitter.ms(rt.pacing.after_click_ms));
  }
}

/** After a menu action: wait for the confirmation to close, then close a menu that stayed or re-opened (once). */
async function settleMenus(ctx: StepContext): Promise<void> {
  const { rt } = ctx;
  const layers = async (kind: string) => (await rt.kit.popupState()).filter((p) => p.kind === kind);
  await poll(ctx, async () => (await layers('alertdialog')).length === 0, 3000, 50);
  await rt.sleep(MENU_REOPEN_GRACE_MS);
  const menus = await layers('menu');
  if (!menus.length) return;
  await clickOutside(ctx, menus);
  const still = await layers('menu');
  if (still.length) {
    await rt.page.keyboard.press('Escape');
    if (!(await waitPopupsGone(ctx, still.map((p) => p.id), 1000))) rt.warn(`${ctx.scene.id}.${ctx.step.index}: a menu stayed open`);
  }
}

/** The element that opens a row's action menu (explicit `trigger`, else discovered inside the row). */
export async function menuTriggerFor(ctx: StepContext, args: MenuArgs): Promise<{ trigger: Resolved; rowDesc: string | null }> {
  const { rt } = ctx;
  if (args.trigger !== undefined) return { trigger: await resolveTarget(ctx, args.trigger), rowDesc: null };
  if (args.row === undefined) throw new StepError('menu: give `row` (text in the row) or `trigger`');
  const row = args.row;
  let rowRef: string | null;
  let rowDesc: string;
  if (typeof row === 'string') {
    rowDesc = `row "${row}"`;
    rowRef = await poll(ctx, () => rt.kit.rowFor(row), ctx.timeoutMs);
    if (!rowRef) {
      const r = await rt.kit.find({ text: row });
      const near = r.count === 0 ? (r as ResolveMissing).near : [];
      throw new StepError(`menu: no row ([role=row], tr, li, card) contains "${row}"; ${formatNear(near)}`, {
        target: rowDesc,
        candidates: 0,
        near,
      });
    }
  } else {
    rowDesc = describeTarget(row);
    rowRef = (await resolveTarget(ctx, row, { promote: false, scroll: false })).ref;
  }
  let found = await rt.kit.menuTrigger(rowRef);
  if (found.ref && !found.hover) return { trigger: await resolveRef(ctx, found.ref, `menu trigger of ${rowDesc}`), rowDesc };
  // Actions shown on hover (R-CHO-13): hover the row's right end, then look again.
  await ensureInView(ctx, rowRef);
  const box = (await rt.kit.point(rowRef))?.bbox;
  if (box) {
    const x = Math.min(Math.round(box.x + Math.max(box.w / 2, box.w - 24)), rt.viewport.width - 4);
    const y = Math.min(Math.round(box.y + box.h / 2), rt.viewport.height - 4);
    await rt.pointer.moveTo({ x, y }, { jitter: ctx.jitter });
    await rt.sleep(ctx.jitter.ms(rt.pacing.hover_ms));
  }
  found = await rt.kit.menuTrigger(rowRef, true);
  if (found.ref) return { trigger: await resolveRef(ctx, found.ref, `menu trigger of ${rowDesc}`), rowDesc };
  const pos = await rt.kit.positionalTrigger(rowRef);
  if (pos) {
    rt.warn(`${ctx.scene.id}.${ctx.step.index}: menu: no button in ${rowDesc}; clicking the element at its ${pos.where} (position, last resort)`);
    return { trigger: await resolveRef(ctx, pos.ref, `element at the ${pos.where} of ${rowDesc}`), rowDesc };
  }
  throw new StepError(
    `menu: ${rowDesc} has no menu trigger (no [aria-haspopup] element, button or clickable element at its right end, even on hover); give \`trigger:\``,
    {},
    rowRef,
  );
}

export async function menu(ctx: StepContext, args: MenuArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const { trigger, rowDesc } = await menuTriggerFor(ctx, args);
  const { open, found, retried } = await openAndFind(ctx, trigger, menuItemTargets(args.item), undefined);
  if (!found) throw await missing(ctx, args.item, 'menu', ctx.timeoutMs);
  await clickResolved(ctx, found, { expect_popup: false, click_role: 'item' });

  if (args.confirm !== undefined && args.confirm !== false) {
    const text = typeof args.confirm === 'string' ? args.confirm : null;
    const ref = await poll(ctx, () => rt.kit.confirmButton(text), ctx.timeoutMs);
    if (!ref) {
      throw new StepError(
        `menu: no ${text ? `"${text}" button` : 'confirmation button'} in a dialog after choosing "${args.item}"`,
      );
    }
    const btn = await resolveRef(ctx, ref, text ? `confirm button "${text}"` : 'confirm button');
    await clickResolved(ctx, btn, { expect_popup: false, click_role: 'confirm' });
  }
  await settleMenus(ctx);
  return composite(open, ctx, { row: rowDesc, item: args.item, confirm: args.confirm ?? null, ...(retried ? { retried } : {}) });
}
