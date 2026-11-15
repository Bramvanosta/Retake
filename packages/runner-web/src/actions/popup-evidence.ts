/** The evidence that a click opened its popup, and the fallback strategies of an `auto` click that showed none. */
import { poll } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { StepContext } from '../runtime.js';

/** Poll (every 40 ms, up to `ms`) for evidence that a popup opened: aria-expanded="true" on the trigger or a new visible popup. */
export async function popupOpened(ctx: StepContext, ref: string, before: Set<number>, expandedBefore: string | null, ms: number): Promise<boolean> {
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
 * The fallbacks of an `auto` click whose expected popup showed no evidence: el.click(), then a synthetic pointer
 * sequence — each given popup_fallback_ms, the last popup_timeout_ms. Late evidence of the previous strategy wins.
 */
export async function fallbackClicks(
  ctx: StepContext,
  r: Resolved,
  nav: { started(): boolean },
  before: Set<number>,
  expandedBefore: string | null,
): Promise<{ opened: boolean; strategy?: 'dom' | 'pointer' }> {
  const { pacing, kit } = ctx.rt;
  let opened = false;
  let strategy: 'dom' | 'pointer' | undefined;
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
  return strategy ? { opened, strategy } : { opened };
}
