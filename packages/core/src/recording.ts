/**
 * The recorder's event model (L3.4, `studio record` / `scenario_record`): what a recording session streams to
 * `events.jsonl` while a person performs a flow in a headed window — intent, never coordinates and never a secret.
 *
 * Every event is checked against this schema before it is kept. Guarantees the schema itself enforces:
 * - a `type` event of a secret-class field (or of a value the in-page secret memory redacted) carries no `text`;
 * - paths never carry a query or a fragment; only a navigation typed in the address bar keeps its query (filtered);
 * - no field's initial value on its own: text added at a field's end is sent alone; after an edit inside the field its
 *   whole final value is sent with `clear` (it holds the parts of the initial value that were kept);
 * - page-controlled strings are bounded (the generator and every client treat them as untrusted page text).
 */
import { Document, isMap, isPair, isScalar, isSeq, visit } from 'yaml';
import { z } from 'zod';
import { sameTarget, targetValue } from './inspect.js';
import { parseScenario } from './scenario.js';
import { TargetObjectSchema } from './schemas/primitives.js';
import { normalizeTarget } from './targets.js';
import type { TargetSpec } from './types.js';

export const RECORDING_VERSION = 1;

/** "rec_" + 26 Crockford base32 characters (10 of time, 16 random): the folder of one recording. */
export const RECORD_ID_RE = /^rec_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The kinds of secret-class fields: a draft names its placeholder after the kind (`{{vars.password_1}}`). */
export const SECRET_FIELD_KINDS = ['password', 'one_time_code', 'card_number', 'card_code', 'card_expiry', 'iban', 'national_id', 'pin', 'api_key', 'secret'] as const;
export type SecretFieldKind = (typeof SECRET_FIELD_KINDS)[number];

/** Keys a recording keeps (everything else typed outside a text field — a PIN pad, a canvas — is never sent). */
export const RECORDED_KEYS = ['Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete'] as const;
/** Modifier combinations: a letter or digit with Control or Meta (a shortcut). */
export const RECORDED_SHORTCUT_KEY_RE = /^[a-z0-9]$/;

/** Longest page text kept in an event field (names, texts, labels, typed text). */
export const RECORD_TEXT_MAX = 2000;
const short = z.string().max(500);
const text = z.string().max(RECORD_TEXT_MAX);

/** Where an element sits (kit InventoryContext). */
const RecordContextSchema = z.enum(['page', 'dialog', 'menu', 'listbox', 'popover', 'row']);

/** The element an event acted on: the kit's inventory entry for it (page text: untrusted), plus the recorder's facts. */
export const RecordedElementSchema = z.strictObject({
  /** A target verified at the time of the action (resolves to this element), or null (see `desc`). */
  target: TargetObjectSchema.nullable(),
  /** Visible matches of the target without its `nth`. */
  matches: z.number().int().min(0),
  fragile: z.array(z.enum(['nth', 'broader', 'dynamic_text', 'css'])).max(4),
  in: RecordContextSchema,
  action: z.strictObject({
    kind: z.enum(['click', 'type', 'select', 'menu', 'drop_file']),
    field: short.optional(),
    row: short.optional(),
    verified: z.boolean(),
  }),
  role: short.nullable(),
  tag: short,
  input_type: short.nullable(),
  name: short,
  text: short,
  label: short.nullable(),
  placeholder: short.nullable(),
  testid: short.nullable(),
  href_path: short.nullable(),
  in_view: z.boolean(),
  state: z.strictObject({
    disabled: z.boolean(),
    expanded: z.boolean(),
    checked: z.boolean(),
    selected: z.boolean(),
    popup_expected: z.boolean(),
    covered: z.boolean(),
  }),
  /** The element (or an ancestor) was added to the page since the previous action. */
  appeared: z.boolean(),
  /** A secret-class field (its value is never part of any event). */
  secret: z.boolean(),
  /** The kit's description when no target was verified (`button "Save"`). */
  desc: short.optional(),
});
export type RecordedElement = z.infer<typeof RecordedElementSchema>;

const base = {
  /** Order of arrival (0-based, no gaps in a kept recording). */
  seq: z.number().int().min(0),
  /** Milliseconds since the recording started. */
  t: z.number().int().min(0),
  /** The recorder's page id ("p1": the window's page). */
  page: z.string().regex(/^p\d+$/),
  /** The path of the page the event happened on (never a query or a fragment; empty when not known). */
  path: z.string().max(2048).refine((p) => !/[?#]/.test(p), 'a path without a query or a fragment'),
  /** How many strings of the event the secret memory masked. */
  redacted: z.number().int().min(1).optional(),
};

/** A press of the pointer (at pointerdown, before the app reacts) or a keyboard activation (Enter / Space → click). */
const PointerEventSchema = z.strictObject({
  ...base,
  kind: z.literal('pointer'),
  button: z.enum(['left', 'middle', 'right']),
  via: z.enum(['pointer', 'keyboard']),
  el: RecordedElementSchema.nullable(),
  /** Milliseconds since the page's DOM last changed (a settled page: large). */
  quiet_ms: z.number().int().min(0),
  /** In-page time the suggestion took (ms). */
  ms: z.number().int().min(0),
});

/** The second press of a double click (follows its two `pointer` events). */
const DoubleClickEventSchema = z.strictObject({ ...base, kind: z.literal('dblclick') });

/** Text typed into one field, committed at blur, Enter, the next action elsewhere or the end. */
const TypeEventSchema = z
  .strictObject({
    ...base,
    kind: z.literal('type'),
    el: RecordedElementSchema.nullable(),
    /** A secret-class field, a value the secret memory knew, a high-entropy paste or an autofill: no `text`. */
    secret: z.boolean(),
    /** The secret kind (for the draft's placeholder), else what the field is. */
    field_kind: z.enum([...SECRET_FIELD_KINDS, 'text', 'search', 'multiline', 'contenteditable']),
    /** What the field shows at the end, past what it held before (its whole final value with `clear`). */
    text: text.optional(),
    /** The field held text that the person edited inside (not only added to its end): `text` is its whole final value. */
    clear: z.boolean(),
    /** Enter committed it. */
    enter: z.boolean(),
    pasted: z.boolean(),
    /** The value changed with no key or paste before it (the browser's autofill): treated as a secret. */
    autofill: z.boolean(),
  })
  .refine((e) => !e.secret || e.text === undefined, 'a secret typing event carries no text')
  .refine((e) => e.secret || e.text !== undefined, 'a typing event that is not secret carries its text');

/** A native <select> changed (the option's label). */
const SelectNativeEventSchema = z.strictObject({ ...base, kind: z.literal('select_native'), el: RecordedElementSchema.nullable(), option: short });

/** Files chosen in a file input or dropped on a zone: their names only (never a path or the content). */
const FileEventSchema = z.strictObject({ ...base, kind: z.literal('file'), el: RecordedElementSchema.nullable(), via: z.enum(['input', 'drop']), names: z.array(short).max(20) });

/** A whitelisted key (or a Control / Meta shortcut) pressed outside typing, with the focused element. */
const KeyEventSchema = z.strictObject({
  ...base,
  kind: z.literal('key'),
  key: z.union([z.enum(RECORDED_KEYS), z.string().regex(RECORDED_SHORTCUT_KEY_RE)]),
  modifiers: z.array(z.enum(['Control', 'Meta', 'Alt', 'Shift'])).max(4),
  el: RecordedElementSchema.nullable(),
}).refine((e) => (RECORDED_KEYS as readonly string[]).includes(e.key) || e.modifiers.includes('Control') || e.modifiers.includes('Meta'), 'a letter or digit only with Control or Meta');

/** A scroll the person made (wheel, keys, scrollbar), net per container after a pause. */
const ScrollEventSchema = z.strictObject({
  ...base,
  kind: z.literal('scroll'),
  container: z.enum(['document', 'element']),
  /** The scrolled element when it is interactive (else null: `container: element` alone). */
  el: RecordedElementSchema.nullable(),
  dx: z.number().int(),
  dy: z.number().int(),
});

/** A navigation of the window's main frame (seen by the runner, not the page). */
const NavigationEventSchema = z.strictObject({
  ...base,
  kind: z.literal('navigation'),
  /**
   * start: the window's first page; typed: the address bar (or a bookmark); link / form: a click or a submit;
   * reload; spa: a same-document route change (history API); other.
   */
  cause: z.enum(['start', 'typed', 'link', 'form', 'reload', 'spa', 'other']),
  same_document: z.boolean(),
  /** environment: an environment page's origin; sign_in: a sign-in page (nothing recorded there); foreign: elsewhere. */
  where: z.enum(['environment', 'sign_in', 'foreign']),
  /** The environment page whose URL is the longest prefix of this one (environment only). */
  page_key: short.nullable(),
  /** A typed navigation's query, keys that may hold a token removed, values through the secret memory. */
  query: z.string().max(2048).optional(),
  /** The host of a foreign page (its path is not kept). */
  host: short.optional(),
});

/** A tab or popup the page opened: not recorded (its actions are not part of the recording). */
const NewPageEventSchema = z.strictObject({ ...base, kind: z.literal('new_page') });

/**
 * A write request the window sent (or the write guard stopped / mocked), by its label (never the query): on a
 * read-write environment every write request, whatever its host.
 */
const WriteEventSchema = z.strictObject({
  ...base,
  kind: z.literal('write'),
  method: z.string().max(20),
  /** `POST shop:/api/quotes` or `POST api.example.com/orders` (core describeWriteRequest; token-like segments masked), through the secret memory. */
  label: z.string().max(2048),
  outcome: z.enum(['blocked', 'mocked', 'allowed', 'passed', 'exempt']),
});

/** Actions not recorded, counted where they happened. */
const DroppedEventSchema = z.strictObject({
  ...base,
  kind: z.literal('dropped'),
  /** sign_in: on a sign-in page; frame: inside a frame; invalid: an event the schema refused. */
  reason: z.enum(['sign_in', 'frame', 'invalid']),
  count: z.number().int().min(1),
});

/** The end of the recording. */
const StopEventSchema = z.strictObject({ ...base, kind: z.literal('stop'), reason: z.enum(['closed', 'stopped', 'max_duration']) });

export const RecordedEventSchema = z.union([
  PointerEventSchema,
  DoubleClickEventSchema,
  TypeEventSchema,
  SelectNativeEventSchema,
  FileEventSchema,
  KeyEventSchema,
  ScrollEventSchema,
  NavigationEventSchema,
  NewPageEventSchema,
  WriteEventSchema,
  DroppedEventSchema,
  StopEventSchema,
]);
export type RecordedEvent = z.infer<typeof RecordedEventSchema>;
export type RecordedEventKind = RecordedEvent['kind'];

// ---------------------------------------------------------------------------------------------------------------------
// The draft generator (L3.4 part 2): a recording's events → a draft scenario. Pure (no I/O, no clock): the CLI, the
// `record` job and any later source of events (BL-25) share it.
// ---------------------------------------------------------------------------------------------------------------------

/** The value a secret placeholder gets in the draft's `vars` (the warning asks for a showable demo value). */
export const RECORD_SECRET_PLACEHOLDER = 'CHANGE-ME';
/** A pointer target that appeared after a pause at least this long gets a `wait_for` first (ms). */
export const RECORD_WAIT_GAP_MS = 1500;
/** Net scroll (CSS px) below which a scroll is jitter. */
export const RECORD_SCROLL_MIN_PX = 120;
/** A write is attributed to the last action (its note) when it follows it within this time (ms); later ones are ambient. */
export const RECORD_WRITE_WINDOW_MS = 2000;
/** A navigation that follows an action within this time (ms) was caused by it (a redirect, a history move by script). */
export const RECORD_NAV_WINDOW_MS = 1000;

export interface DraftContext {
  /** The scenario's `video` name (its file name). */
  name: string;
  /** The environment recorded; `env:` is written unless it is the project's default. */
  env: string;
  envIsDefault: boolean;
  /** The environment's pages (key → base URL): `open:` paths are made relative to the page's base path. */
  pages: Record<string, string>;
  /** The persona the window was signed in as (null: signed out). */
  persona: string | null;
  /** The persona each page key is signed in as by default (null: none). A first scene names `persona:` only when it differs. */
  defaultPersonas?: Record<string, string | null>;
  /** project.yaml `vars`: a secret placeholder never shadows one of them (the draft uses it instead). */
  projectVars?: Record<string, string>;
  /** The environment's access while recording (read-only: writes were stopped or answered by a mock). */
  access: 'read-only' | 'read-write';
}

/** Something to look at in the draft. Messages never quote page text or a typed value (safe for job.json and logs). */
export interface DraftIssue {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'fallback_target'
    | 'unresolved_press'
    | 'secret_field'
    | 'secret_target'
    | 'one_time_code'
    | 'autofill'
    | 'contenteditable'
    | 'fragile_target'
    | 'fake_file'
    | 'file_cancelled'
    | 'signed_out'
    | 'foreign_page'
    | 'dropped'
    | 'new_page'
    | 'opened_by_address'
    | 'page_changed'
    | 'max_duration'
    | 'middle_click'
    | 'ambient_write'
    | 'template_text'
    | 'secret_path'
    | 'not_saved'
    | 'invalid';
  message: string;
  /**
   * Where it applies: the scene id and the 0-based index of the step it is about — or, for something that happened
   * between steps (a dropped action, a page change, a write no step caused), of the step that came next (the scene's
   * step count at its end). Absent only for the draft as a whole.
   */
  scene?: string;
  step?: number;
}

/** A write the window sent while recording, and the step that caused it (null: ambient, not caused by an action). */
export interface DraftWrite {
  /** `POST shop:/api/quotes`, `POST api.example.com/orders` (page text through the secret memory: untrusted). */
  label: string;
  outcome: 'blocked' | 'mocked' | 'allowed' | 'passed' | 'exempt';
  scene: string | null;
  step: number | null;
}

export interface RecordingDraft {
  /** The scenario value (what `yaml` holds). */
  scenario: Record<string, unknown>;
  yaml: string;
  issues: DraftIssue[];
  /** Every write the window sent (any host), in order. */
  writes: DraftWrite[];
  /**
   * The first step followed by a write that went through (any host; not one the guard stopped or mocked) — however
   * long after it: the check replay stops before it, so nothing is written twice.
   */
  firstWrite: { scene: string; step: number } | null;
  stats: {
    scenes: number;
    steps: number;
    /** Presses, typing, keys, selects and files that became (part of) a step. */
    actions: number;
    /** Presses on nothing interactive, dropped. */
    noise: number;
    /** Typing in secret fields (placeholders). */
    secrets: number;
    /** Steps on a target the recorder could not verify. */
    fallbacks: number;
  };
}

type Step = Record<string, unknown>;
type El = RecordedElement;
type Ev = RecordedEvent;
type EvOf<K extends Ev['kind']> = Extract<Ev, { kind: K }>;

interface DraftScene {
  page: string;
  open?: string;
  /** The path the scene starts on (its id). */
  path: string;
  steps: Array<{ step: Step; t0: number; t1: number }>;
}

const ACTION_KINDS = new Set(['pointer', 'dblclick', 'type', 'select_native', 'file', 'key']);
/** Elements whose text is a whole region, never a press target. */
const CONTAINER_ROLES = new Set(['dialog', 'alertdialog', 'document', 'main', 'region', 'navigation', 'banner', 'contentinfo', 'form', 'list', 'grid', 'table', 'rowgroup', 'tabpanel', 'group']);
const CONFIRM_WORD = /^(yes|ok|confirm|continue)\b/i;
const MASK = '•••';
/** The opening of a template (`{{vars.x}}`, `{{env:X}}`): a recorded string holding one is never put in a draft. */
const TEMPLATE = '{{';
/** The draft's own secret placeholders (the only templates it writes). */
const PLACEHOLDER_RE = new RegExp(`\\{\\{vars\\.(?:${SECRET_FIELD_KINDS.join('|')})_\\d+\\}\\}`, 'g');

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const hasMask = (v: unknown): boolean => JSON.stringify(v ?? null).includes(MASK);
const hasTemplate = (v: unknown): boolean => JSON.stringify(v ?? null).includes(TEMPLATE);
/** A recorded string that cannot go into a draft as it is: masked (a secret) or holding a template. */
const unsafe = (s: string): boolean => s.includes(MASK) || s.includes(TEMPLATE);

/** A scenario target from a verified one (the bare string for a lone text), or null when it is missing, masked or templated. */
function targetOf(el: El | null): TargetSpec | null {
  if (!el?.target || hasMask(el.target) || hasTemplate(el.target)) return null;
  return targetValue(el.target);
}

/** The accessible name a list option / menu item is chosen by. */
function itemName(el: El): string {
  return clean(el.name) || clean(el.label) || clean(el.text);
}

const sameEl = (a: El | null, b: El | null): boolean => !!a?.target && !!b?.target && sameTarget(a.target, b.target);

/** A `click` step on `t` (no options): the press that focused a field, folded into its `type` / `select`. */
function isClickOn(s: Step | undefined, t: TargetSpec): boolean {
  if (!s || !('click' in s)) return false;
  const c = s.click;
  if (typeof c !== 'string' && (c === null || typeof c !== 'object')) return false;
  return sameTarget(normalizeTarget(c as TargetSpec), normalizeTarget(t));
}

/** The path of `path` under the base path of environment page `key` ("/" when it is the base itself). */
export function pathUnderPage(path: string, key: string, pages: Record<string, string>): string {
  let base = '';
  try {
    base = new URL(pages[key] ?? '').pathname.replace(/\/+$/, '');
  } catch {
    base = '';
  }
  if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length);
  return path.startsWith('/') ? path : `/${path}`;
}

/** A scene id from a path's first meaningful segment (`/products/x` → products; `/` → home). */
function sceneIdOf(path: string): string {
  const seg = path
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .find((s) => s && !/^\d+$/.test(s) && !/^[0-9a-f-]{16,}$/i.test(s));
  const slug = (seg ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || (seg === undefined ? 'home' : 'scene');
}

const TEMPLATE_MESSAGE = 'a recorded text held a {{…}} template, which a scenario would resolve (a var, an environment variable): left out — add the step by hand';

/**
 * Turn a recording's events (core RecordedEvent, in `seq` order) into a draft scenario: click, type (always with
 * `into`; clear / enter), press, select, pick (closed by escape / outside / none), menu (with its confirm), drop_file
 * (a placeholder file), scroll (to the next target when it moved at least RECORD_SCROLL_MIN_PX), a `wait_for` on the
 * next target when it appeared after a pause; scenes split where the page changed (`open:` only when the address bar
 * or nothing the person did changed it); presses on nothing dropped; captions empty; no holds; secret fields typed as
 * `{{vars.<kind>_N}}`. A recorded string holding `{{` (typed text, a name, an option) never reaches the draft: its step
 * is left out (`template_text`). Every event's page text is untrusted; issue messages never quote it. Issues come in
 * the order they were raised, each with its scene and step.
 */
export function draftFromRecording(events: readonly RecordedEvent[], ctx: DraftContext): RecordingDraft {
  const evs = [...events].sort((a, b) => a.seq - b.seq);
  const issues: DraftIssue[] = [];
  const scenes: DraftScene[] = [];
  const stats = { scenes: 0, steps: 0, actions: 0, noise: 0, secrets: 0, fallbacks: 0 };
  const vars: Record<string, string> = {};
  const secretCount = new Map<string, number>();
  const projectVars = ctx.projectVars ?? {};
  type Raw = Omit<DraftIssue, 'scene' | 'step'>;
  /**
   * Issues in the order raised (`t`), located once scene ids and step indexes are known: about a step (`step`), or
   * between steps — after `after` in `scene` (null: at its start; no scene yet: the draft's start) — or already
   * located (`at`), or about the whole draft.
   */
  const raised: Array<{ issue: Raw; t: number; step?: Step; scene?: DraftScene | null; after?: Step | null; at?: { scene: string; step: number } }> = [];
  let now = 0;
  const note = (step: Step, issue: Raw) => raised.push({ issue, t: now, step });
  /** Something that happened here, between steps. */
  const raise = (issue: Raw) => raised.push({ issue, t: now, scene, after: scene?.steps.at(-1)?.step ?? null });
  /** A step replaced by another (a click folded into the typing that followed it): its issues follow. */
  const moved = (from: Step, to: Step) => {
    for (const r of raised) {
      if (r.step === from) r.step = to;
      if (r.after === from) r.after = to;
    }
  };

  let scene: DraftScene | null = null;
  let lastActionT = -Infinity;
  /** The next action is the first after a document load (everything on the page counts as appeared there). */
  let afterLoad = true;
  /** Actions are not recorded until the window is back on an environment page. */
  let away: 'sign_in' | 'foreign' | null = null;
  let scroll: { dy: number; dx: number; container: 'document' | 'element'; el: El | null } | null = null;
  let otpMerged = false;

  const writes = evs.filter((e): e is EvOf<'write'> => e.kind === 'write');
  const stream = evs.filter((e) => e.kind !== 'write');

  const newScene = (page: string, path: string, open?: string): DraftScene => {
    const s: DraftScene = { page, path, ...(open !== undefined ? { open } : {}), steps: [] };
    scenes.push(s);
    scene = s;
    return s;
  };
  const current = (e: Ev): DraftScene => scene ?? newScene(Object.keys(ctx.pages)[0] ?? 'page', e.path || '/', e.path ? pathUnderPage(e.path, Object.keys(ctx.pages)[0] ?? '', ctx.pages) : '/');
  /** Add a step — never one holding a recorded template (left out, `template_text`). False when left out. */
  const push = (e: Ev, step: Step, t0: number, t1 = t0): boolean => {
    current(e);
    if (JSON.stringify(step).replace(PLACEHOLDER_RE, '').includes(TEMPLATE)) {
      raise({ severity: 'warning', code: 'template_text', message: TEMPLATE_MESSAGE });
      return false;
    }
    current(e).steps.push({ step, t0, t1 });
    stats.steps++;
    return true;
  };
  /** A scene's `open:` (a URL path and query: a `{{` is written percent-encoded, as the browser reads it). */
  const openOf = (rel: string): string => rel.replaceAll(TEMPLATE, '%7B%7B');
  const checkOpen = (open: string) => {
    if (open.includes(MASK)) raise({ severity: 'warning', code: 'secret_path', message: 'a page address held a value that looks like a token or an e-mail address: it is masked (•••) in `open:` — put a demo value back by hand' });
  };
  const lastStep = (): Step | undefined => scene?.steps.at(-1)?.step;

  /** A pending scroll before the action on `target` (or by its amount when there is no target). */
  const flushScroll = (e: Ev, target: TargetSpec | null) => {
    const s = scroll;
    scroll = null;
    if (!s || Math.abs(s.dy) < RECORD_SCROLL_MIN_PX) return;
    const container = s.container === 'element' ? targetOf(s.el) : null;
    if (target !== null) push(e, { scroll: { to: target, ...(container !== null ? { in: container } : {}) } }, e.t);
    else push(e, { scroll: { by: s.dy, ...(container !== null ? { in: container } : {}) } }, e.t);
  };

  /** Before an action on `el`: the scroll that led to it, and a wait when it appeared after a pause. */
  const before = (e: Ev, el: El | null, target: TargetSpec | null) => {
    const gap = e.t - lastActionT;
    if (target !== null && el?.appeared && !afterLoad && Number.isFinite(gap) && gap >= RECORD_WAIT_GAP_MS) {
      push(e, { wait_for: { target, timeout: Math.max(15, Math.ceil((2 * gap) / 1000)) } }, e.t);
    }
    flushScroll(e, target);
  };
  const acted = (t: number, n = 1) => {
    lastActionT = t;
    afterLoad = false;
    stats.actions += n;
  };

  /** The target a press is replayed on: the verified one, else a fallback from its own text (warned), else null. */
  const pressTarget = (el: El, step: () => Step): TargetSpec | null => {
    const t = targetOf(el);
    if (t !== null) {
      if (el.fragile.includes('nth') || el.fragile.includes('css')) {
        const s = step();
        note(s, { severity: 'info', code: 'fragile_target', message: `the recorded target depends on ${el.fragile.includes('nth') ? 'its position among look-alikes' : 'a CSS selector'}: check it with page_inspect` });
      }
      return t;
    }
    const text = clean(el.name) || clean(el.text);
    if (hasMask(el.target) || hasTemplate(el.target) || unsafe(text)) return null;
    if (!text || text.length > 80 || (el.role !== null && CONTAINER_ROLES.has(el.role))) return null;
    return { text, ...(el.in !== 'page' && el.in !== 'row' ? { in: el.in } : {}) };
  };

  const nextAction = (from: number): number => {
    for (let j = from; j < stream.length; j++) {
      const k = stream[j].kind;
      if (ACTION_KINDS.has(k) || k === 'navigation' || k === 'stop') return j;
    }
    return stream.length;
  };

  /** A press that closes an open list or popover without choosing anything (outside it, on nothing interactive). */
  const isClosingPress = (e: Ev | undefined): boolean =>
    e?.kind === 'pointer' && (e.el === null || e.el.target === null || (e.el.role !== null && CONTAINER_ROLES.has(e.el.role)));

  for (let i = 0; i < stream.length; i++) {
    const e = stream[i];
    now = e.t;
    switch (e.kind) {
      case 'navigation': {
        if (e.where !== 'environment' || e.page_key === null) {
          if (away !== e.where) {
            away = e.where === 'environment' ? 'foreign' : e.where;
            raise(
              away === 'sign_in'
                ? { severity: 'warning', code: 'signed_out', message: `the window reached a sign-in page${ctx.persona ? ` (persona ${ctx.persona} signed out)` : ''}: nothing done there was recorded — sign the persona in (studio login / auth_login) and record that part again` }
                : { severity: 'warning', code: 'foreign_page', message: 'the window left the environment\'s pages (another site): nothing done there was recorded' },
            );
          }
          if (scroll) scroll = null;
          continue;
        }
        const wasAway = away !== null;
        away = null;
        const path = e.path || '/';
        const rel = pathUnderPage(path, e.page_key, ctx.pages);
        if (e.cause === 'start') {
          newScene(e.page_key, path, openOf(rel));
          checkOpen(rel);
          afterLoad = true;
          continue;
        }
        if (!scene) {
          const open = openOf(rel + (e.cause === 'typed' && e.query ? e.query : ''));
          newScene(e.page_key, path, open);
          checkOpen(open);
          afterLoad = true;
          continue;
        }
        const cur: DraftScene = scene;
        if (path === cur.path && e.same_document) continue;
        if (scroll && Math.abs(scroll.dy) >= RECORD_SCROLL_MIN_PX) flushScroll(e, null);
        scroll = null;
        const caused = e.t - lastActionT <= RECORD_NAV_WINDOW_MS;
        const byAddress = wasAway || (!e.same_document && !caused && ['typed', 'reload', 'other'].includes(e.cause));
        if (byAddress) {
          const open = openOf(rel + (e.cause === 'typed' && e.query ? e.query : ''));
          if (cur.steps.length === 0) {
            cur.page = e.page_key;
            cur.path = path;
            cur.open = open;
          } else newScene(e.page_key, path, open);
          checkOpen(open);
          if (!wasAway) raise({ severity: 'info', code: 'opened_by_address', message: 'a scene opens its page by address: the address bar, a reload or a script changed the page with no action before it' });
        } else if (cur.steps.length > 0) {
          if (e.page_key !== cur.page) raise({ severity: 'warning', code: 'page_changed', message: `an action led to another environment page (${e.page_key}) in the same window: the scene continues on page ${cur.page} — check the replay` });
          newScene(cur.page, path);
        } else cur.path = path;
        if (!e.same_document) afterLoad = true;
        continue;
      }
      case 'stop':
        if (e.reason === 'max_duration') raise({ severity: 'warning', code: 'max_duration', message: 'the recording reached its maximum duration and stopped: what came after is missing' });
        continue;
      case 'dropped':
        raise({
          severity: e.reason === 'invalid' ? 'info' : 'warning',
          code: 'dropped',
          message:
            e.reason === 'sign_in'
              ? `${e.count} action(s) on a sign-in page were not recorded`
              : e.reason === 'frame'
                ? `${e.count} action(s) inside a frame were not recorded (frames are not recorded)`
                : `${e.count} event(s) the recorder could not read were dropped`,
        });
        continue;
      case 'new_page':
        raise({ severity: 'warning', code: 'new_page', message: 'the page opened a tab or a popup: tabs and popups are not recorded — what was done there is missing' });
        continue;
      default:
        break;
    }
    if (away !== null) continue;

    if (e.kind === 'scroll') {
      if (!scroll || scroll.container !== e.container || (e.container === 'element' && !sameEl(scroll.el, e.el))) {
        scroll = { dy: 0, dx: 0, container: e.container, el: e.el };
      }
      scroll.dy += e.dy;
      scroll.dx += e.dx;
      continue;
    }

    if (e.kind === 'pointer') {
      const el = e.el;
      if (el === null) {
        stats.noise++;
        continue;
      }
      if (e.button === 'middle') {
        raise({ severity: 'info', code: 'middle_click', message: 'a middle click (a new tab) was not recorded' });
        continue;
      }
      // A double click: this press, a second one on the same element, then `dblclick`.
      const j1 = nextAction(i + 1);
      const n1 = stream[j1];
      const n2 = stream[nextAction(j1 + 1)];
      if (n1?.kind === 'pointer' && n1.el && sameEl(n1.el, el) && n2?.kind === 'dblclick') {
        let step: Step = {};
        const t = pressTarget(el, () => step);
        if (t === null) {
          i = nextAction(j1 + 1);
          continue;
        }
        before(e, el, t);
        step = { double_click: t };
        push(e, step, e.t, n2.t);
        acted(n2.t, 2);
        i = nextAction(j1 + 1);
        continue;
      }

      // A list (Radix / Base UI select, a multi-select popover): options chosen in the listbox it opened.
      const inList = (x: Ev | undefined) => !!x && (x.kind === 'pointer' || x.kind === 'type') && (x.el?.in === 'listbox' || x.el?.in === 'popover');
      if (inList(n1)) {
        let j = j1;
        let search: string | undefined;
        const options: string[] = [];
        let tEnd = e.t;
        while (j < stream.length) {
          const x = stream[j];
          if (x.kind === 'type' && options.length === 0 && !x.secret && x.text !== undefined && (x.el?.in === 'listbox' || x.el?.in === 'popover')) {
            search = x.text;
            tEnd = x.t;
          } else if (x.kind === 'pointer' && x.el?.in === 'listbox' && x.el.role === 'option' && itemName(x.el) && !unsafe(itemName(x.el))) {
            options.push(itemName(x.el));
            tEnd = x.t;
          } else if (x.kind === 'pointer' && (x.el?.in === 'listbox' || x.el?.in === 'popover') && x.el.role !== 'option' && options.length === 0) {
            // a press in the list that is not an option (a search box): part of the choice
            tEnd = x.t;
          } else break;
          j = nextAction(j + 1);
        }
        if (options.length > 0) {
          const after = stream[j];
          let close: 'escape' | 'outside' | 'none' | null = null;
          if (after?.kind === 'key' && after.key === 'Escape' && after.modifiers.length === 0) close = 'escape';
          else if (isClosingPress(after)) close = 'outside';
          const hint = el.action.kind === 'select' && el.action.field ? el.action.field : null;
          const trigger = targetOf(el);
          if (hint !== null || trigger !== null) {
            const label = hint ?? (clean(el.label) && !unsafe(clean(el.label)) ? clean(el.label) : null);
            before(e, el, trigger);
            let step: Step;
            if (options.length === 1 && (hint !== null || close === null)) {
              step = { select: { ...(hint !== null ? { field: hint } : { combobox: trigger }), option: options[0], ...(search !== undefined ? { search } : {}) } };
            } else {
              const field: unknown = label ?? (el.target ? { ...el.target } : null);
              step = { pick: { field, option: options.length === 1 ? options[0] : options, ...(search !== undefined ? { search } : {}), close: close ?? (after && ACTION_KINDS.has(after.kind) ? 'outside' : 'none') } };
            }
            if (!push(e, step, e.t, close !== null ? after!.t : tEnd)) stats.noise++;
            acted(close !== null ? after!.t : tEnd, options.length + 1);
            i = close !== null ? j : j - 1;
            continue;
          }
        }
      }

      // A row's action menu: trigger → item (→ the confirmation dialog's button).
      if (el.action.kind === 'menu' && n1?.kind === 'pointer' && n1.el?.in === 'menu' && itemName(n1.el) && !unsafe(itemName(n1.el))) {
        const item = itemName(n1.el);
        const j2 = nextAction(j1 + 1);
        const c = stream[j2];
        let confirm: string | undefined;
        if (c?.kind === 'pointer' && c.el && c.el.in === 'dialog' && c.el.appeared && c.el.role === 'button' && c.t - n1.t <= 10_000) {
          const name = itemName(c.el);
          const a = name.toLowerCase();
          const b = item.toLowerCase();
          if (name && !unsafe(name) && (a === b || a.startsWith(`${b} `) || CONFIRM_WORD.test(name))) confirm = name;
        }
        const trigger = targetOf(el);
        const row = el.action.row && !unsafe(el.action.row) ? el.action.row : null;
        if (row !== null || trigger !== null) {
          before(e, el, trigger);
          const end = confirm !== undefined ? c!.t : n1.t;
          push(e, { menu: { ...(row !== null ? { row } : { trigger }), item, ...(confirm !== undefined ? { confirm } : {}) } }, e.t, end);
          acted(end, confirm !== undefined ? 3 : 2);
          i = confirm !== undefined ? j2 : j1;
          continue;
        }
      }

      // A file zone: the file chosen in the chooser it opened (or dropped on it).
      if (el.action.kind === 'drop_file') {
        if (n1?.kind === 'file') {
          const zone = targetOf(el) ?? targetOf(n1.el);
          if (zone !== null && n1.names.length > 0) {
            before(e, el, zone);
            push(e, dropFile(zone, n1.names), e.t, n1.t);
            acted(n1.t, 2);
            i = j1;
            continue;
          }
        } else {
          raise({ severity: 'info', code: 'file_cancelled', message: 'a file zone was pressed and no file was chosen: not recorded' });
          continue;
        }
      }

      let step: Step = {};
      const t = pressTarget(el, () => step);
      if (t === null) {
        stats.noise++;
        const own = clean(el.name) || clean(el.text);
        const secret = hasMask(el);
        const templated = !secret && (hasTemplate(el.target) || own.includes(TEMPLATE));
        raise({
          severity: 'warning',
          code: secret ? 'secret_target' : templated ? 'template_text' : 'unresolved_press',
          message: secret
            ? 'a press on an element whose text holds a secret value was not recorded'
            : templated
              ? TEMPLATE_MESSAGE
              : 'a press the recorder could not name was dropped: add it by hand if it mattered (page_inspect)',
        });
        continue;
      }
      before(e, el, t);
      const opts = e.button === 'right' ? { button: 'right' } : {};
      const obj = typeof t === 'string' ? { text: t } : t;
      step.click = Object.keys(opts).length ? { ...obj, ...opts } : t;
      if (!push(e, step, e.t)) {
        stats.noise++;
        continue;
      }
      acted(e.t);
      if (!el.target) {
        stats.fallbacks++;
        note(step, { severity: 'warning', code: 'fallback_target', message: 'no verified target for this press (it was still appearing, or the page was too large): the target is guessed from its text — check it with page_inspect' });
      }
      continue;
    }

    if (e.kind === 'dblclick') continue; // after its two presses (handled above), or alone: nothing to add

    if (e.kind === 'type') {
      if (!e.secret && (e.text ?? '').includes(TEMPLATE)) {
        // Typed text a scenario would resolve as a template: left out (the click that focused the field stays).
        current(e);
        raise({ severity: 'warning', code: 'template_text', message: TEMPLATE_MESSAGE });
        continue;
      }
      const into = targetOf(e.el);
      // The press that focused the field is the type's `into` (its issues follow it).
      let folded: Step | null = null;
      if (into !== null && isClickOn(lastStep(), into)) {
        folded = scene!.steps.pop()!.step;
        stats.steps--;
      }
      let text: string;
      if (e.secret) {
        const kind = (SECRET_FIELD_KINDS as readonly string[]).includes(e.field_kind) ? e.field_kind : 'secret';
        const prev = lastStep();
        if (kind === 'one_time_code' && prev && typeof prev.type === 'object' && String((prev.type as { text?: string }).text ?? '').startsWith('{{vars.one_time_code_')) {
          // One-time-code boxes: one typing step on the first box (the app must move to the next box by itself).
          if (!otpMerged) {
            note(prev, { severity: 'warning', code: 'one_time_code', message: 'one-time-code boxes were typed one by one: merged into one typing step on the first box — it replays only if the app moves to the next box by itself' });
            otpMerged = true;
          }
          const last2 = scene!.steps.at(-1)!;
          last2.t1 = e.t;
          if (folded) moved(folded, last2.step);
          acted(e.t);
          continue;
        }
        const n = (secretCount.get(kind) ?? 0) + 1;
        secretCount.set(kind, n);
        const name = `${kind}_${n}`;
        text = `{{vars.${name}}}`;
        if (!Object.hasOwn(projectVars, name)) vars[name] = RECORD_SECRET_PLACEHOLDER;
        stats.secrets++;
        const step: Step = { type: { ...(into !== null ? { into } : {}), text, ...(e.clear ? { clear: true } : {}), ...(e.enter ? { enter: true } : {}) } };
        before(e, e.el, into);
        push(e, step, e.t);
        if (folded) moved(folded, step);
        acted(e.t);
        note(step, {
          severity: 'warning',
          code: e.autofill ? 'autofill' : 'secret_field',
          message: Object.hasOwn(projectVars, name)
            ? `a secret field (${kind}) was typed: its value was never recorded — the draft types project.yaml's vars.${name}`
            : `a secret field (${kind})${e.autofill ? ' was filled by the browser' : ' was typed'}: its value was never recorded — set vars.${name} to a showable demo value (a real secret only as {{env:…}}, by hand, which makes the scenario CLI-only)`,
        });
        continue;
      }
      text = e.text ?? '';
      const step: Step = { type: { ...(into !== null ? { into } : {}), text, ...(e.clear ? { clear: true } : {}), ...(e.enter ? { enter: true } : {}) } };
      before(e, e.el, into);
      push(e, step, e.t);
      if (folded) moved(folded, step);
      acted(e.t);
      if (into === null) note(step, { severity: 'warning', code: 'fallback_target', message: 'the field typed into has no verified target: the step types into the focused element — add `into` (page_inspect)' });
      if (e.field_kind === 'contenteditable') note(step, { severity: 'info', code: 'contenteditable', message: 'typed into a rich text editor: its text is recorded as it shows, formatting aside — check the replay' });
      continue;
    }

    if (e.kind === 'select_native') {
      const t = targetOf(e.el);
      const field = e.el ? clean(e.el.label) : '';
      if (t === null && (!field || unsafe(field))) {
        raise({ severity: 'warning', code: 'unresolved_press', message: 'a choice in a list the recorder could not name was dropped: add it by hand (page_inspect)' });
        continue;
      }
      if (unsafe(e.option)) {
        raise(e.option.includes(MASK) ? { severity: 'warning', code: 'secret_target', message: 'a choice whose text holds a secret value was not recorded' } : { severity: 'warning', code: 'template_text', message: TEMPLATE_MESSAGE });
        continue;
      }
      let folded: Step | null = null;
      if (t !== null && isClickOn(lastStep(), t)) {
        folded = scene!.steps.pop()!.step;
        stats.steps--;
      }
      before(e, e.el, t);
      const step: Step = { select: { ...(t !== null ? { combobox: t } : { field }), option: e.option } };
      push(e, step, e.t);
      if (folded) moved(folded, step);
      acted(e.t);
      continue;
    }

    if (e.kind === 'file') {
      const zone = targetOf(e.el);
      if (zone === null || e.names.length === 0) {
        raise({ severity: 'warning', code: 'unresolved_press', message: 'a file was chosen in a field the recorder could not name: add a drop_file step by hand' });
        continue;
      }
      before(e, e.el, zone);
      push(e, dropFile(zone, e.names), e.t);
      acted(e.t);
      continue;
    }

    if (e.kind === 'key') {
      const key = e.key === ' ' ? 'Space' : e.key;
      const combo = [...e.modifiers.filter((m) => m !== 'Shift' || key.length > 1), key].join('+');
      flushScroll(e, null);
      push(e, { press: combo }, e.t);
      acted(e.t);
    }
  }
  if (scene !== null) flushScroll(stream.at(-1) ?? evs[0], null);

  function dropFile(zone: TargetSpec, names: readonly string[]): Step {
    const name = unsafe(names[0]) ? 'file.csv' : names[0];
    const step: Step = { drop_file: { zone, name, fake: true } };
    note(step, {
      severity: 'info',
      code: 'fake_file',
      message: `drop_file uses a placeholder file with the chosen file's name${names.length > 1 ? ` (the first of ${names.length})` : ''}: give it a real file under the project (path:) if the product reads its content`,
    });
    return step;
  }

  // Empty scenes go (a page opened and left without an action), except a lone one.
  let kept = scenes.filter((s) => s.steps.length > 0);
  if (kept.length === 0 && scenes.length > 0) kept = [scenes[0]];
  // Scene ids, unique.
  const used = new Map<string, number>();
  const ids = kept.map((s) => {
    const base = sceneIdOf(s.open?.split(/[?#]/)[0] ?? pathUnderPage(s.path, s.page, ctx.pages));
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
  const where = new Map<Step, { scene: string; step: number }>();
  kept.forEach((s, si) => s.steps.forEach((x, k) => where.set(x.step, { scene: ids[si], step: k })));

  // Every write (any host), to the step that caused it (the last one that ended within the window: its note); the
  // first step followed by a write that went through — however long after — bounds the check replay.
  const flat = kept.flatMap((s, si) => s.steps.map((x, k) => ({ ...x, scene: ids[si], index: k })));
  const outWrites: DraftWrite[] = [];
  let firstWrite: RecordingDraft['firstWrite'] = null;
  for (const w of writes) {
    let prev: (typeof flat)[number] | undefined;
    for (const s of flat) if (s.t1 <= w.t) prev = s;
    const by = prev && w.t - prev.t1 <= RECORD_WRITE_WINDOW_MS ? prev : undefined;
    const through = w.outcome !== 'blocked' && w.outcome !== 'mocked';
    if (through && prev && !firstWrite) firstWrite = { scene: prev.scene, step: prev.index };
    outWrites.push({ label: w.label, outcome: w.outcome, scene: by?.scene ?? null, step: by?.index ?? null });
    if (!by) {
      raised.push({
        issue: { severity: 'info', code: 'ambient_write', message: 'the page sent a write no action caused within 2 s (a poll, telemetry, a slow answer): not attributed to a step' },
        t: w.t,
        ...(prev ? { at: { scene: prev.scene, step: prev.index + 1 } } : { scene: null, after: null }),
      });
      continue;
    }
    const label = w.label.replaceAll(TEMPLATE, '%7B%7B');
    const what = w.outcome === 'blocked' ? `${label} (stopped: read-only)` : w.outcome === 'mocked' ? `${label} (answered by a mock: read-only)` : label;
    const before = typeof by.step.note === 'string' ? `${by.step.note}; ` : '';
    by.step.note = `${before}sends ${what}`;
  }

  // Issues, in the order they were raised, each located.
  const keptIndex = (s: DraftScene | null | undefined): number => (s ? kept.indexOf(s) : -1);
  const locate = (r: (typeof raised)[number]): { scene: string; step: number } | null => {
    if (r.at) return r.at;
    if (r.step) return where.get(r.step) ?? null;
    if (kept.length === 0) return null;
    if (!r.scene) return { scene: ids[0], step: 0 };
    let si = keptIndex(r.scene);
    if (si >= 0) {
      const k = r.after ? kept[si].steps.findIndex((x) => x.step === r.after) : -1;
      return { scene: ids[si], step: r.after ? (k >= 0 ? k + 1 : kept[si].steps.length) : 0 };
    }
    // An empty scene (dropped): the next kept one's start, else the end of the last one before it.
    const from = scenes.indexOf(r.scene);
    si = kept.findIndex((s) => scenes.indexOf(s) > from);
    if (si >= 0) return { scene: ids[si], step: 0 };
    return { scene: ids[kept.length - 1], step: kept[kept.length - 1].steps.length };
  };
  raised.sort((a, b) => a.t - b.t);
  for (const r of raised) {
    // A step's issue whose step is not in the draft (it was left out) goes with it.
    if (r.step && !where.has(r.step)) continue;
    const at = locate(r);
    issues.push({ ...r.issue, ...(at ?? {}) });
  }

  // The scenario.
  const value: Record<string, unknown> = { version: RECORDING_VERSION, video: ctx.name };
  if (!ctx.envIsDefault) value.env = ctx.env;
  if (Object.keys(vars).length) value.vars = vars;
  value.scenes = kept.map((s, si) => {
    const out: Record<string, unknown> = { id: ids[si] };
    if (si === 0 || s.open !== undefined) {
      if (si === 0 || s.page !== kept[si - 1].page) out.page = s.page;
      if (s.open !== undefined) out.open = s.open;
    }
    if (si === 0) {
      const def = ctx.defaultPersonas?.[s.page];
      if (def !== undefined && (ctx.persona ?? null) !== def) out.persona = ctx.persona ?? 'none';
    }
    out.steps = s.steps.map((x) => x.step);
    return out;
  });
  stats.scenes = kept.length;
  stats.steps = flat.length;

  const doc = new Document(value);
  doc.commentBefore = [
    ' Recorded with studio record: a draft. Captions are empty and nothing is held — add them, check the steps flagged',
    ' in the recording\'s report (page_inspect), then run_dry.',
  ].join('\n');
  visit(doc, {
    Pair(_, pair) {
      if (!isPair(pair) || !isScalar(pair.key) || pair.key.value !== 'steps' || !isSeq(pair.value)) return;
      for (const item of pair.value.items) {
        if (!isMap(item)) continue;
        for (const p of item.items) if (isPair(p) && (isMap(p.value) || isSeq(p.value))) p.value.flow = true;
      }
    },
  });
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const { issues: checked } = parseScenario(yaml);
  for (const x of checked) {
    if (x.severity === 'error') issues.push(draftInvalidIssue(x, ids, 'the draft does not validate (a recorder bug)'));
  }
  return { scenario: value, yaml, issues, writes: outWrites, firstWrite, stats };
}

/**
 * An `invalid` issue from a validation error of a draft: a fixed message with its line and, from its path, its scene
 * and step — never the validator's own message (it may quote the draft's page text).
 */
export function draftInvalidIssue(x: { path: Array<string | number>; line?: number }, sceneIds: readonly string[], what: string): DraftIssue {
  const si = x.path[0] === 'scenes' && typeof x.path[1] === 'number' ? x.path[1] : -1;
  const k = si >= 0 && x.path[2] === 'steps' && typeof x.path[3] === 'number' ? x.path[3] : -1;
  const scene = si >= 0 ? sceneIds[si] : undefined;
  return {
    severity: 'error',
    code: 'invalid',
    message: `${what}${x.line !== undefined ? ` (line ${x.line})` : ''}: run validate on the draft to see why`,
    ...(scene !== undefined ? { scene, ...(k >= 0 ? { step: k } : {}) } : {}),
  };
}
