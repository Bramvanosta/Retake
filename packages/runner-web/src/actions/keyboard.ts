import type { PressArgs, TypeArgs } from '@demo-studio/core';
import type { FieldKind } from '../kit/types.js';
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

/** Search fields are typed slower than free text (field notes: 8–11 characters/s). */
export const SEARCH_MAX_CPS = 10;
/** Long free text speeds up from LONG_TEXT_FROM characters to LONG_TEXT_MAX_CPS at LONG_TEXT_FULL (field notes: up to 24). */
export const LONG_TEXT_MAX_CPS = 24;
export const LONG_TEXT_FROM = 40;
export const LONG_TEXT_FULL = 120;

/** Why a `type` step typed at its rate: given (`cps`), a search field, the default rate, or long free text. */
export type TypingRate = 'set' | 'search' | 'default' | 'long';

/**
 * Typing rate of a `type` step without `cps` (R-CHO-14): a search field at most SEARCH_MAX_CPS; other text at `base`
 * (pacing.type_cps), ramping linearly from LONG_TEXT_FROM characters up to LONG_TEXT_MAX_CPS at LONG_TEXT_FULL. Pure.
 */
export function typingRate(kind: FieldKind | null, chars: number, base: number): { cps: number; rate: Exclude<TypingRate, 'set'> } {
  if (kind === 'search') return { cps: Math.min(base, SEARCH_MAX_CPS), rate: 'search' };
  if (chars > LONG_TEXT_FROM && base < LONG_TEXT_MAX_CPS) {
    const u = Math.min(1, (chars - LONG_TEXT_FROM) / (LONG_TEXT_FULL - LONG_TEXT_FROM));
    return { cps: Math.round((base + (LONG_TEXT_MAX_CPS - base) * u) * 10) / 10, rate: 'long' };
  }
  return { cps: base, rate: 'default' };
}

/**
 * How `clear` emptied the field: it was empty, select-all + delete, the native value setter, editing commands; or not
 * (`failed`: still text; `none`: an input that takes no text). `keys` also stands for a field the kit cannot read.
 */
export type ClearHow = 'empty' | 'keys' | 'setter' | 'editor' | 'failed' | 'none';

/**
 * Empty the focused field before typing (R-CHO-15): select-all + Backspace as a person would; when the field still
 * holds text (a page that blocks select-all, a controlled input that restored its value), the native value setter +
 * an `input` event (contenteditable: editing commands). A field the kit cannot read — a frame from another origin, an
 * editor's hidden input (CodeMirror, Monaco), a custom widget — gets the keys only, unchecked. Never reads the value.
 */
async function clearField(ctx: StepContext): Promise<ClearHow> {
  const { rt } = ctx;
  const where = `${ctx.scene.id}.${ctx.step.index}`;
  const st = await rt.kit.fieldState(null);
  if (st?.known && !st.editable) {
    rt.warn(`${where}: clear: the focused element is not an editable field`);
    return 'none';
  }
  if (st?.known && st.empty) return 'empty';
  const kb = rt.page.keyboard;
  await kb.press('ControlOrMeta+a');
  await rt.sleep(80);
  await kb.press('Backspace');
  await rt.sleep(ctx.jitter.ms(160));
  if (!st?.known) return 'keys';
  if ((await rt.kit.fieldState(null))?.empty) return 'keys';
  const how = await rt.kit.clearField(null);
  if (how && (await rt.kit.fieldState(null))?.empty) {
    rt.log('debug', `${where}: select-all + delete left text in the field; cleared with the ${how === 'setter' ? 'native value setter' : 'editing commands'}`);
    await rt.sleep(ctx.jitter.ms(120));
    return how;
  }
  rt.warn(`${where}: clear: the field still holds text after select-all + delete${how ? ' and the native value setter' : ''}`);
  return 'failed';
}

export async function type(ctx: StepContext, args: TypeArgs): Promise<ActionResult> {
  const { rt } = ctx;
  let run: ClickRun | null = null;
  if (args.into !== undefined) {
    run = await clickTarget(ctx, args.into, { expect_popup: false, after_ms: FOCUS_PAUSE_MS });
  } else if (!(await rt.kit.isTextInput(null))) {
    rt.warn(`${ctx.scene.id}.${ctx.step.index}: type without \`into\` and the focused element is not a text field`);
  }
  const kb = rt.page.keyboard;
  const cleared = args.clear ? await clearField(ctx) : undefined;
  // Without `into`: the focused field, measured before typing (the tutorial loupe and spotlight follow it).
  const focused = run ? null : await rt.kit.focused().catch(() => null);
  if (rt.secrets.contains(args.text)) {
    // A secret value ({{env:…}}, {{keychain:…}}) shows as bullets in a password field only: anywhere else it is filmed.
    const field = run ? await rt.kit.focused().catch(() => null) : focused;
    if (field && field.input_type !== 'password') {
      rt.warn(
        `${ctx.scene.id}.${ctx.step.index}: types the value of a secret reference into a visible field (${field.desc}): the capture shows it — ` +
          'type it into a password field, sign in beforehand (studio login, auth.storage_state), or use {{vars.…}} for a value that may show',
      );
    }
  }
  const chars = [...args.text];
  // Without `cps` the rate adapts to the field (R-CHO-14): search fields slower, long free text faster.
  const adapted = args.cps === undefined ? typingRate((await rt.kit.fieldState(null).catch(() => null))?.kind ?? null, chars.length, rt.pacing.type_cps) : null;
  const cps = args.cps ?? adapted!.cps;
  const rate: TypingRate = adapted?.rate ?? 'set';
  const t_type = rt.now();
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
  const out: ActionResult = {
    data: { chars: chars.length, cps, rate, t_type, t_typed, ...(t_enter !== undefined ? { t_enter } : {}), ...(cleared ? { clear: cleared } : {}) },
  };
  if (run) {
    out.ref = run.resolved.ref;
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
