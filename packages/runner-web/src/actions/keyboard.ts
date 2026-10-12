import type { PressArgs, TypeArgs } from '@demo-studio/core';
import type { StepContext } from '../runtime.js';
import { sleepUntil, wallNow } from '../util.js';
import { clickTarget, watchNavigation } from './click.js';
import type { ClickRun } from './click.js';
import type { ActionResult } from './types.js';

/** Pause between focusing a field and the first keystroke. */
const FOCUS_PAUSE_MS = 250;
/** Per-character jitter of the typing rhythm (±30 %). */
const TYPE_JITTER = 0.3;
const KEY_REPEAT_MS = 140;

export async function type(ctx: StepContext, args: TypeArgs): Promise<ActionResult> {
  const { rt } = ctx;
  let run: ClickRun | null = null;
  if (args.into !== undefined) {
    run = await clickTarget(ctx, args.into, { expect_popup: false, after_ms: FOCUS_PAUSE_MS });
  } else if (!(await rt.kit.isTextInput(null))) {
    rt.warn(`${ctx.scene.id}.${ctx.step.index}: type without \`into\` and the focused element is not a text field`);
  }
  const kb = rt.page.keyboard;
  if (args.clear) {
    await kb.press('ControlOrMeta+a');
    await rt.sleep(80);
    await kb.press('Backspace');
    await rt.sleep(ctx.jitter.ms(160));
  }
  // Without `into`: the focused field, measured before typing (the tutorial loupe and spotlight follow it).
  const focused = run ? null : await rt.kit.focused().catch(() => null);
  const cps = args.cps ?? rt.pacing.type_cps;
  const t_type = rt.now();
  const chars = [...args.text];
  await typeText(ctx, args.text, cps);
  const t_typed = rt.now();
  let t_enter: number | undefined;
  if (args.enter) {
    await rt.sleep(ctx.jitter.ms(250));
    const nav = watchNavigation(rt.page);
    try {
      t_enter = rt.now();
      await kb.press('Enter');
      await rt.sleep(ctx.jitter.ms(rt.pacing.after_click_ms));
      await nav.settle(ctx);
    } finally {
      nav.stop();
    }
  }
  // Typing span (capture s): the loupe of tutorial videos shows the field from t_type to t_typed; t_enter = the Enter key.
  const out: ActionResult = { data: { chars: chars.length, cps, t_type, t_typed, ...(t_enter !== undefined ? { t_enter } : {}) } };
  if (run) {
    out.target = { desc: run.resolved.desc, bbox: run.resolved.bbox };
    out.point = run.point;
    out.t_click = run.t_click;
  } else {
    out.t_click = t_type;
    if (focused) out.target = { desc: focused.desc, bbox: focused.bbox };
  }
  return out;
}

export async function press(ctx: StepContext, args: PressArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const times = Math.max(1, args.times ?? 1);
  const nav = watchNavigation(rt.page);
  const t_click = rt.now();
  try {
    for (let i = 0; i < times; i++) {
      await rt.page.keyboard.press(args.key);
      if (i < times - 1) await rt.sleep(ctx.jitter.ms(KEY_REPEAT_MS));
    }
    await rt.sleep(ctx.jitter.ms(rt.pacing.after_click_ms));
    await nav.settle(ctx);
  } finally {
    nav.stop();
  }
  return { t_click, data: { key: args.key, times } };
}

/** Type `text` into the focused element at `cps` characters per second (deterministic ±30 % rhythm). */
export async function typeText(ctx: StepContext, text: string, cps: number): Promise<void> {
  const kb = ctx.rt.page.keyboard;
  const base = 1000 / Math.max(1, cps);
  let due = wallNow();
  for (const ch of text) {
    if (ch === '\n') await kb.press('Enter');
    else await kb.type(ch);
    due += ctx.jitter.ms(base, TYPE_JITTER);
    await sleepUntil(due, ctx.rt.signal);
  }
}
