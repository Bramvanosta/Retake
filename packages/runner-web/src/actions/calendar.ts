import type { DateArgs, TargetSpec } from '@retake/core/model';
import { isoDay, parseDay } from '@retake/core/base';
import { normalizeTarget } from '@retake/core/language';
import { StepError } from '../errors.js';
import type { CalendarDay, CalendarInfo } from '../kit/types.js';
import { distance } from '../motion.js';
import { poll, resolveRef, resolveTarget } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { sleepUntil, wallNow } from '../util.js';
import { approach, clickData, clickOutside, clickResolved } from './click.js';
import type { ClickRun } from './click.js';
import type { ActionResult } from './types.js';
import { RETRY_TRIGGER_AFTER_MS, closeOpened, composite, nothingOpened, popupIds, reclick } from './widgets.js';

/** Quick month runs (R-CHO-24, field notes): presses ~110 ms apart, each with its ripple. */
export const QUICK_GAP_MS = 110;
export const QUICK_PRESS_MS = 40;
/** Runs of at least this many month clicks are recorded (`data.quick_runs`): the edit plays them faster. */
export const QUICK_RUN_MIN_CLICKS = 5;
/** Month clicks one day may take before the step fails. */
export const MAX_MONTH_STEPS = 36;
/** A month click must change the calendar within this time before the next press (a sliding calendar ignores presses). */
const MONTH_CHANGE_WAIT_MS = 400;
/** Month clicks in a row that change nothing before the step fails. */
const MAX_STALLS = 3;
/** How long a previous date popover (closing by itself, fading out) gets to go before it is clicked away. */
const CALENDAR_CLOSE_WAIT_MS = 2000;
/** The field's own popover, open at the step start, may be closing by itself: how long it gets before it is used. */
const OWN_CLOSE_WAIT_MS = 1000;

function dayOf(d: CalendarDay): number | null {
  return d.iso ? parseDay(d.iso) : parseDay(d.label);
}

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[   ]/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The day cell `query` names (R-CHO-24). A query that is a date is compared as a date with each cell's (its date
 * attribute, else the date in its label): "1 January 2027" never picks "11 January 2027". Other queries match a label
 * whole, else as whole words inside it. Enabled days of the shown month(s) first; a disabled copy from an adjacent
 * month is not the day (its own month shows it: the calendar is paged to it). Pure.
 */
export function matchDay(days: readonly CalendarDay[], query: string): CalendarDay | null {
  days = days.filter((d) => !(d.outside && d.disabled));
  const q = parseDay(query);
  let hits: CalendarDay[];
  if (q !== null) {
    hits = days.filter((d) => dayOf(d) === q);
  } else {
    const p = plain(query);
    hits = days.filter((d) => plain(d.label) === p);
    if (!hits.length) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`);
      hits = days.filter((d) => re.test(plain(d.label)));
    }
  }
  const rank = (d: CalendarDay) => (d.outside ? 2 : 0) + (d.disabled ? 1 : 0);
  return [...hits].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Which way to page for a day not shown: before the first shown day → previous, after the last → next. Pure. */
export function monthDirection(days: readonly CalendarDay[], query: string): 'next' | 'previous' | 'inside' {
  const q = parseDay(query);
  if (q === null) return 'next';
  const inMonth = days
    .filter((d) => !d.outside)
    .map(dayOf)
    .filter((n): n is number => n !== null);
  const shown = inMonth.length ? inMonth : days.map(dayOf).filter((n): n is number => n !== null);
  if (!shown.length) return 'next';
  if (q < Math.min(...shown)) return 'previous';
  if (q > Math.max(...shown)) return 'next';
  return 'inside';
}

/** What the calendar shows (a month change changes it). */
function signature(cal: CalendarInfo): string {
  return cal.days.map((d) => d.iso ?? d.label).join('|');
}

async function readCalendar(ctx: StepContext, ms = 1000): Promise<CalendarInfo> {
  const cal = await poll(ctx, () => ctx.rt.kit.calendar(), ms, 50);
  if (!cal) throw new StepError('date: no calendar on screen (no day cells with a dated aria-label or a date attribute); give `field`');
  return cal;
}

function shownDays(cal: CalendarInfo): string {
  const inMonth = cal.days.filter((d) => !d.outside);
  const list = inMonth.length ? inMonth : cal.days;
  if (!list.length) return 'no days';
  return `shown: "${list[0].label}" … "${list[list.length - 1].label}"`;
}

/** The month button: the author's (last visible match unless they chose one), else the calendar's last visible one. */
async function navButton(ctx: StepContext, cal: CalendarInfo, dir: 'next' | 'previous', args: DateArgs): Promise<Resolved> {
  const spec: TargetSpec | undefined = dir === 'next' ? args.next : args.previous;
  if (spec !== undefined) {
    const t = normalizeTarget(spec);
    const chosen = t.nth !== undefined || t.last_visible !== undefined;
    return resolveTarget(ctx, chosen ? t : { ...t, last_visible: true }, { timeoutMs: 2000 });
  }
  const ref = dir === 'next' ? cal.next : cal.prev;
  if (!ref) throw new StepError(`date: the calendar has no ${dir === 'next' ? 'next' : 'previous'}-month button; give \`${dir}\``);
  return resolveRef(ctx, ref, `${dir === 'next' ? 'next' : 'previous'}-month button`);
}

interface QuickRun {
  t_start: number;
  t_end: number;
  clicks: number;
}

/** Page to `day` (quick runs of month clicks) and click it. Returns the ISO date (else the label) of the day clicked. */
async function pickDay(ctx: StepContext, day: string, args: DateArgs, runs: QuickRun[]): Promise<string> {
  const { rt } = ctx;
  let dir: 'next' | 'previous' | null = null;
  let run: QuickRun | null = null;
  let lastPress = 0;
  let stalls = 0;
  const flush = () => {
    if (run && run.clicks >= QUICK_RUN_MIN_CLICKS) runs.push(run);
    run = null;
  };
  for (let steps = 0; ; steps++) {
    const cal = await readCalendar(ctx);
    const hit = matchDay(cal.days, day);
    if (hit) {
      flush();
      if (hit.disabled) throw new StepError(`date: "${day}" is disabled in the calendar ("${hit.label}")`);
      if (steps > 0) await rt.sleep(ctx.jitter.ms(rt.pacing.after_click_ms));
      const r = await resolveRef(ctx, hit.ref, `day "${hit.label}"`);
      await clickResolved(ctx, r, { expect_popup: false, click_role: 'day' });
      const n = dayOf(hit);
      return n !== null ? isoDay(n) : hit.label;
    }
    const way = monthDirection(cal.days, day);
    if (way === 'inside') throw new StepError(`date: "${day}" is not one of the calendar's days (hidden, or not a day it shows); ${shownDays(cal)}`);
    if (steps >= MAX_MONTH_STEPS) throw new StepError(`date: "${day}" not found after ${MAX_MONTH_STEPS} month clicks; ${shownDays(cal)}`);
    const nav = await navButton(ctx, cal, way, args);
    const before = signature(cal);
    if (way !== dir || !run) {
      // The first click of a run: an ordinary click (travel, hover, press).
      flush();
      const c = await clickResolved(ctx, nav, { expect_popup: false, after_ms: 0, click_role: 'nav' });
      run = { t_start: c.t_click, t_end: c.t_click, clicks: 1 };
      lastPress = c.t_click;
      dir = way;
    } else {
      // A quick press on the same button, QUICK_GAP_MS after the previous one (a nudge if the button moved).
      await sleepUntil(wallNow() + (lastPress + QUICK_GAP_MS / 1000 - rt.now()) * 1000, rt.signal);
      if (distance(rt.pointer.pos(), nav.point) > 2) await rt.pointer.moveTo(nav.point, { ms: 90 });
      const t = await rt.pointer.click({ pressMs: QUICK_PRESS_MS });
      ctx.clicks.push({ role: 'nav', t, point: rt.pointer.pos(), desc: nav.desc, bbox: nav.bbox, strategy: 'real', popup_opened: false });
      (run as QuickRun).t_end = t;
      (run as QuickRun).clicks++;
      lastPress = t;
    }
    // The month must change before the next press: a calendar that slides ignores presses meanwhile.
    const moved = await poll(
      ctx,
      async () => {
        const c = await rt.kit.calendar();
        return c !== null && signature(c) !== before;
      },
      MONTH_CHANGE_WAIT_MS,
      20,
    );
    if (moved) stalls = 0;
    else if (++stalls >= MAX_STALLS) throw new StepError(`date: the calendar did not change after ${MAX_STALLS} clicks on ${nav.desc}; ${shownDays(cal)}`);
  }
}

/**
 * The date-picker helper (R-CHO-24): waits for a previous date popover to close, opens the field (re-clicked once
 * when nothing opened, R-CHO-10), pages months with the LAST visible month button — the first click an ordinary one,
 * the next ones quick presses ~110 ms apart (runs of QUICK_RUN_MIN_CLICKS or more go to `data.quick_runs`, played
 * faster by the edit) —, clicks each day by its label or date attribute, then closes what it opened. A native
 * <input type=date> is filled in place.
 */
export async function date(ctx: StepContext, args: DateArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const where = `${ctx.scene.id}.${ctx.step.index}`;
  const days = Array.isArray(args.day) ? args.day : [args.day];
  if (!days.length) throw new StepError('date: `day` is empty');
  const initial = await popupIds(ctx);
  const spec: TargetSpec | null = args.field === undefined ? null : typeof args.field === 'string' ? { label: args.field } : args.field;
  let trigger = spec ? await resolveTarget(ctx, spec) : null;

  if (trigger && (await rt.kit.info(trigger.ref))?.input_type === 'date') {
    // A native date input: its picker is drawn by the browser (never captured), so the day is set in place.
    if (days.length > 1) throw new StepError('date: a native date input holds one day: give one `day`');
    const n = parseDay(days[0]);
    if (n === null) throw new StepError(`date: "${days[0]}" is not a date a native date input takes (2027-01-10, 10 January 2027)`);
    await approach(ctx, trigger);
    await rt.sleep(ctx.jitter.ms(rt.pacing.hover_ms));
    const t_click = rt.now();
    await rt.kit.ripple(trigger.point.x, trigger.point.y);
    if (!(await rt.kit.setNativeValue(trigger.ref, isoDay(n)))) throw new StepError(`date: ${trigger.desc} refused ${isoDay(n)} (min / max?)`);
    await rt.sleep(ctx.jitter.ms(rt.pacing.after_click_ms));
    ctx.clicks.push({ role: 'trigger', t: t_click, point: trigger.point, desc: trigger.desc, bbox: trigger.bbox, strategy: 'native', popup_opened: false });
    return {
      target: { desc: trigger.desc, bbox: trigger.bbox },
      point: trigger.point,
      t_click,
      strategy: 'native',
      popup_opened: false,
      data: { days: [isoDay(n)], clicks: clickData(ctx) },
    };
  }

  let open: ClickRun | null = null;
  let retried = false;
  let waited: number | undefined;
  if (trigger && spec) {
    const shown = await rt.kit.calendar();
    let own = shown !== null && (await rt.kit.expanded(trigger.ref)) === 'true';
    if (shown?.popup != null) {
      // A date popover still open — a range picker closing by itself after its last day, a fading one: wait for it to
      // go (field notes). This field's own popover, still open after OWN_CLOSE_WAIT_MS, is used as it is.
      const t0 = wallNow();
      const gone = await poll(ctx, async () => (await rt.kit.calendar())?.popup == null, own ? OWN_CLOSE_WAIT_MS : CALENDAR_CLOSE_WAIT_MS, 50);
      waited = Math.round(wallNow() - t0);
      if (gone) {
        own = false;
      } else if (!own) {
        rt.warn(`${where}: a date popover was still open after ${CALENDAR_CLOSE_WAIT_MS / 1000} s: closing it with a click outside`);
        // That popover only: a popover holding the field stays open.
        const left = (await rt.kit.popupState()).filter((p) => p.id === shown.popup);
        if (left.length) await clickOutside(ctx, left);
      }
      trigger = await resolveTarget(ctx, spec);
    }
    if (!own) {
      const before = await popupIds(ctx);
      open = await clickResolved(ctx, trigger, { expect_popup: true, click_role: 'trigger' });
      let ready = await poll(ctx, () => rt.kit.calendar(), Math.min(RETRY_TRIGGER_AFTER_MS, ctx.timeoutMs), 50);
      if (!ready && (await nothingOpened(ctx, trigger, before))) {
        const again = await reclick(ctx, trigger, true);
        if (again) [open, retried] = [again, true];
        ready = await poll(ctx, () => rt.kit.calendar(), RETRY_TRIGGER_AFTER_MS, 50);
      }
      if (!ready) throw new StepError(`date: no calendar opened after clicking ${trigger.desc}`);
    }
  }

  const runs: QuickRun[] = [];
  const picked: string[] = [];
  for (const day of days) picked.push(await pickDay(ctx, day, args, runs));
  const close = args.close ?? 'auto';
  await closeOpened(ctx, initial, close);

  const data: Record<string, unknown> = { days: picked, close };
  if (runs.length) data.quick_runs = runs;
  if (waited !== undefined) data.waited_close_ms = waited;
  if (retried) data.retried = true;
  if (open) return composite(open, ctx, data);
  // A calendar already on screen: the first click (a month button or a day) stands for the step.
  const first = ctx.clicks[0];
  return {
    ...(first ? { target: { desc: first.desc, ...(first.bbox ? { bbox: first.bbox } : {}) }, point: first.point, t_click: first.t, strategy: first.strategy } : {}),
    data: { ...data, clicks: clickData(ctx) },
  };
}
