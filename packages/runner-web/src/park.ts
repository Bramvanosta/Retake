import type { BBox, NormalizedStep, Pacing, PointSpec, ScrollArgs } from '@retake/core';
import type { Page } from 'playwright-core';
import { distance } from './motion.js';
import type { StepContext } from './runtime.js';
import { KEEP_NEAR_PX, cursorCovers } from './scene-cursor.js';

/**
 * Parking (R-CHO-18, R-CHO-21), opt-in per step with `park`: after a scroll to a target the cursor rests next to it,
 * clear of its text; after any other step it moves away from what changed on the page since the last action started
 * (and from the element that action used), then holds still on the result.
 */

/** Steps that act on the page: each restarts the record of what changes (when the scenario parks somewhere). */
export const ACTING_ACTIONS: ReadonlySet<string> = new Set([
  'click', 'double_click', 'hover', 'type', 'press', 'select', 'pick', 'menu', 'date', 'scroll', 'drag', 'drop_file', 'download',
]);

/** Popup kinds a park must not move away from (they may close when the pointer leaves them). */
const FLOATING_KINDS = new Set(['menu', 'listbox', 'popover', 'popper']);

export interface ParkPlan {
  /** Next to a scroll target, or away from a result. */
  kind: 'scroll' | 'result';
  /** After the action (then hold), or before it (a `hold` step: the hold step holds). */
  when: 'after' | 'before';
  /** Seconds held still after the park (0: none). */
  hold_s: number;
}

/** What the step's `park` asks for (null: no parking). Pure. */
export function parkPlan(step: NormalizedStep, pacing: Pacing): ParkPlan | null {
  const p = step.park;
  if (p === undefined || p === false) return null;
  if (step.action === 'hold') return { kind: 'result', when: 'before', hold_s: 0 };
  const to = step.action === 'scroll' ? (step.args as ScrollArgs).to : undefined;
  const kind = to !== undefined && typeof to !== 'number' && to !== 'top' && to !== 'bottom' ? 'scroll' : 'result';
  const hold_s = typeof p === 'number' ? p : (step.hold ?? (kind === 'scroll' ? pacing.park_scroll_hold : pacing.park_hold));
  return { kind, when: 'after', hold_s };
}

/** The element the last acting step used (its box, its kit ref) and whether it opened a popup. */
export interface Acted {
  bbox?: BBox;
  ref?: string;
  popup_opened: boolean;
  /** The popups open when the step started (a popup not among them opened during the step: a hover's menu). */
  popups_before?: number[];
  page: Page;
}

/** What a park did (recorded as `data.park` of the step). */
export interface ParkRecord {
  kind: ParkPlan['kind'];
  /** glide = an eased move; keep = the cursor was already clear; skip = a popup it opened is open. */
  how: 'glide' | 'keep' | 'skip';
  from: PointSpec;
  to: PointSpec;
  /** restNear's side, or 'side' (the right-centre spot). */
  side?: string;
  /** Boxes it stayed clear of (what changed + the element acted on; the target's text after a scroll). */
  avoided: number;
  move_ms?: number;
  hold_s: number;
}

const centre = (b: BBox): PointSpec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Move the cursor to its parking spot (no hold: the caller holds). Never throws: a failure keeps the cursor. */
export async function parkCursor(ctx: StepContext, plan: ParkPlan, acted: Acted | null): Promise<ParkRecord> {
  const { rt } = ctx;
  const { kit, pointer } = rt;
  const from = pointer.pos();
  const rec: ParkRecord = { kind: plan.kind, how: 'keep', from, to: from, avoided: 0, hold_s: plan.hold_s };
  if (!pointer.known || !pointer.visible) return rec;
  const mine = acted && acted.page === rt.page ? acted : null;
  let to: (PointSpec & { side?: string }) | null = null;
  try {
    if (plan.kind === 'scroll') {
      const text = mine?.ref ? await kit.textBox(mine.ref).catch(() => null) : null;
      const anchor = text ?? mine?.bbox;
      if (!anchor) return rec;
      rec.avoided = 1;
      // Already resting clear of it and close by: stay.
      if (!cursorCovers(from, anchor) && distance(from, centre(anchor)) <= KEEP_NEAR_PX) return rec;
      to = await kit.restNear(anchor, mine?.ref ? { ref: mine.ref } : {});
    } else {
      // A menu or listbox the step opened (a click's popup, a menu shown on hover) closes when the pointer leaves it.
      const before = mine?.popups_before;
      const opened = (await kit.popupState()).filter((p) => FLOATING_KINDS.has(p.kind) && (mine?.popup_opened || (before !== undefined && !before.includes(p.id))));
      if (mine && opened.length) {
        rec.how = 'skip';
        return rec;
      }
      const changed = await kit.changedBoxes().catch(() => ({ watching: false, boxes: [] as BBox[] }));
      const avoid = [...changed.boxes, ...(mine?.bbox ? [mine.bbox] : [])];
      rec.avoided = avoid.length;
      if (!changed.watching) {
        // A new document since the action: the field notes' neutral spot.
        to = { ...(await kit.restPoint('side')), side: 'side' };
      } else {
        if (!avoid.some((b) => cursorCovers(from, b))) return rec;
        to = await kit.restNear(mine?.bbox ?? avoid[0], { point: from, ...(mine?.ref ? { ref: mine.ref } : {}), avoid });
        if (avoid.some((b) => cursorCovers(to!, b))) to = { ...(await kit.restPoint('side', avoid)), side: 'side' };
      }
    }
  } catch (e) {
    rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: park failed (${e instanceof Error ? e.message : String(e)}); keeping the cursor`);
    return rec;
  }
  if (!to || distance(from, to) < 1) return rec;
  rec.move_ms = await pointer.moveTo(to, { jitter: ctx.jitter });
  rec.how = 'glide';
  rec.to = pointer.pos();
  if (to.side) rec.side = to.side;
  return rec;
}
