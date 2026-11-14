import type { PressArgs, TypeArgs } from '@retake/core/model';
import type { FieldKind } from '../kit/types.js';
import type { StepContext } from '../runtime.js';
import { sleepUntil, wallNow } from '../util.js';
import { StepError } from '../errors.js';
import { ensureInView, poll, resolveTarget, settledPoint } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import { clickResolved, watchNavigation } from './click.js';
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
export type TypingRate = 'set' | 'search' | 'default' | 'long' | 'fill';

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

/**
 * Bring a field into view inside its own scrolling containers (a scrolling dialog included) and take its click point
 * once its box stopped moving (R-FLD-11). A field still covered at its point (a sticky footer of the dialog) is scrolled
 * towards the middle of its container, up to twice.
 */
async function fieldIntoView(ctx: StepContext, r: Resolved): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureInView(ctx, r.ref, attempt > 0);
    const pt = await settledPoint(ctx, r.ref);
    if (!pt) throw new StepError(`type: ${r.spec} disappeared before it could be clicked`, { target: r.spec });
    r.point = { x: pt.x, y: pt.y };
    r.bbox = pt.bbox;
    r.hit = pt.hit;
    if (pt.hit) return;
  }
  ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: ${r.spec} is covered by another element at (${r.point.x}, ${r.point.y})`);
}

/** How long the focus may take to land in the field after the click (a widget that focuses its input itself). */
const FOCUS_GRACE_MS = 500;

/**
 * After the click of `type {into}` (R-FLD-11): the focused element must be the field (or inside it): else the step
 * fails before typing anything, naming what got the focus — never text typed into another field. Returns the ref of
 * the focused element (the field whose value is checked after typing).
 */
async function checkFocus(ctx: StepContext, r: Resolved): Promise<string | null> {
  const { kit } = ctx.rt;
  let last: { ok: boolean; desc: string | null; field: string | null } | null = null;
  const ok = await poll(
    ctx,
    async () => {
      last = await kit.focusCheck(r.ref).catch(() => null);
      return last === null || last.ok;
    },
    FOCUS_GRACE_MS,
    50,
  );
  const got = last as { ok: boolean; desc: string | null; field: string | null } | null;
  if (ok || got === null) return got?.field ?? null;
  throw new StepError(
    `type: clicking ${r.desc} at (${r.point.x}, ${r.point.y}) put the focus on ${got.desc ?? 'nothing (the page itself)'} instead: nothing was typed — ` +
      'the field may be covered, below the fold of a container the runner could not scroll, or behind a dialog',
    { target: r.spec },
    r.ref,
  );
}

/** Input types whose value the browser keeps in its own format (a typed "10/01/2027" reads "2027-01-10"). */
const NATIVE_FORMAT_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'file', 'checkbox', 'radio']);
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * After typing (R-FLD-11): the field's value holds the text typed — equal to it after a clear (or into an empty
 * field), containing it otherwise. A value that only differs by its formatting (thousands separators, a phone mask,
 * spaces) passes; any other difference — a field that lost the focus turned "300" into "3" — is a warning. Fields the
 * kit cannot read (a frame of another origin, a custom widget, a native date input) are not checked. A password
 * field's value is never shown: only lengths are.
 */
async function checkValue(ctx: StepContext, field: string | null, text: string, wasEmpty: boolean, desc: string): Promise<void> {
  const { rt } = ctx;
  if (text.includes('\n')) return;
  const info = field ? await rt.kit.info(field).catch(() => null) : null;
  if (info?.input_type && NATIVE_FORMAT_TYPES.has(info.input_type)) return;
  const raw = await rt.kit.fieldValue(field).catch(() => null);
  if (raw === null) return;
  const value = info?.input_type ? raw : raw.replace(/\s+/g, ' ').trim();
  const want = info?.input_type ? text : text.replace(/\s+/g, ' ').trim();
  const exact = wasEmpty ? value === want : value.includes(want);
  if (exact) return;
  const formatted = wasEmpty ? loose(value) === loose(want) : loose(value).includes(loose(want));
  if (formatted && loose(want) !== '') {
    rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: ${desc} shows the typed text formatted by the page`);
    return;
  }
  const where = `${ctx.scene.id}.${ctx.step.index}`;
  if (info?.input_type === 'password' || rt.secrets.contains(text)) {
    rt.warn(`${where}: after typing ${[...text].length} characters into ${desc}, the field holds ${[...raw].length}: some keys went elsewhere (focus lost?)`);
    return;
  }
  const show = (v: string) => JSON.stringify(rt.secrets.redactText(v.length > 80 ? `${v.slice(0, 77)}…` : v));
  rt.warn(`${where}: after typing ${show(text)} into ${desc}, the field holds ${show(raw)}: some keys went elsewhere (focus lost?) or the page changed the value`);
}

export async function type(ctx: StepContext, args: TypeArgs): Promise<ActionResult> {
  const { rt } = ctx;
  let run: ClickRun | null = null;
  let field: string | null = null;
  if (args.into !== undefined) {
    // Found without scrolling, then brought into view and clicked once it stopped moving (R-FLD-11).
    const r = await resolveTarget(ctx, args.into, { scroll: false });
    await fieldIntoView(ctx, r);
    run = await clickResolved(ctx, r, { expect_popup: false, after_ms: FOCUS_PAUSE_MS });
    field = await checkFocus(ctx, run.resolved);
  } else if (!(await rt.kit.isTextInput(null))) {
    rt.warn(`${ctx.scene.id}.${ctx.step.index}: type without \`into\` and the focused element is not a text field`);
  }
  const kb = rt.page.keyboard;
  const cleared = args.clear ? await clearField(ctx) : undefined;
  const wasEmpty = cleared !== undefined ? cleared !== 'failed' && cleared !== 'none' : ((await rt.kit.fieldState(field).catch(() => null))?.empty ?? false);
  // Without `into`: the focused field, measured before typing (the tutorial loupe and spotlight follow it).
  const focused = run ? null : await rt.kit.focused().catch(() => null);
  if (rt.secrets.contains(args.text)) {
    // A secret value ({{env:…}}, {{keychain:…}}) shows as bullets in a password field only: anywhere else it is filmed.
    const field = run ? await rt.kit.focused().catch(() => null) : focused;
    if (field && field.input_type !== 'password') {
      rt.warn(
        `${ctx.scene.id}.${ctx.step.index}: types the value of a secret reference into a visible field (${field.desc}): the capture shows it — ` +
          'type it into a password field, sign in beforehand (retake login, auth.storage_state), or use {{vars.…}} for a value that may show',
      );
    }
  }
  const chars = [...args.text];
  // Without `cps` the rate adapts to the field (R-CHO-14): search fields slower, long free text faster.
  const adapted = args.fill ? null : args.cps === undefined ? typingRate((await rt.kit.fieldState(null).catch(() => null))?.kind ?? null, chars.length, rt.pacing.type_cps) : null;
  const cps = args.fill ? 0 : (args.cps ?? adapted!.cps);
  const rate: TypingRate = args.fill ? 'fill' : (adapted?.rate ?? 'set');
  const t_type = rt.now();
  if (args.fill) await fillText(ctx, args.text);
  else await typeText(ctx, args.text, cps);
  const t_typed = rt.now();
  // Before Enter (a search box or a chat field empties when it sends).
  await checkValue(ctx, field, args.text, wasEmpty, run?.resolved.desc ?? focused?.desc ?? 'the focused field');
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
/**
 * Hotfix v0.2.6 (field point 25): the whole value at once, as a browser autofill — one insertText into the focused field
 * (the framework's input event), then its change event — so the field fills in one frame instead of key by key.
 */
export async function fillText(ctx: StepContext, text: string): Promise<void> {
  await ctx.rt.page.keyboard.insertText(text);
  await ctx.rt.page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ctx.rt.sleep(ctx.jitter.ms(150));
}

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
