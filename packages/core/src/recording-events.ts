/**
 * The recorder's event model (`retake record` / `scenario_record`): what a recording session streams to
 * `events.jsonl` while a person performs a flow in a headed window — intent, never coordinates and never a secret.
 *
 * Every event is checked against this schema before it is kept. Guarantees the schema itself enforces:
 * - a `type` event of a secret-class field (or of a value the in-page secret memory redacted) carries no `text`;
 * - paths never carry a query or a fragment; only a navigation typed in the address bar keeps its query (filtered);
 * - no field's initial value on its own: text added at a field's end is sent alone; after an edit inside the field its
 *   whole final value is sent with `clear` (it holds the parts of the initial value that were kept);
 * - page-controlled strings are bounded (the generator and every client treat them as untrusted page text).
 */
import { z } from 'zod';
import { TargetObjectSchema } from './schemas/language.js';

export const RECORDING_VERSION = 1;

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
  /**
   * Up to three other targets verified at the time of the action: each resolved once, to this element. Never
   * position-dependent (no `nth`, no `last_visible`); none for a secret field. The person may pick one in the Studio.
   */
  alternatives: z
    .array(
      z.strictObject({
        target: TargetObjectSchema.refine((t) => t.nth === undefined && t.last_visible === undefined, 'an alternative never depends on position'),
        fragile: z.array(z.enum(['broader', 'dynamic_text', 'css'])).max(3),
      }),
    )
    .max(3)
    .optional(),
  /** The alternatives' time budget ran out: there may be more. */
  alternatives_partial: z.boolean().optional(),
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
  path: z
    .string()
    .max(2048)
    .refine((p) => !/[?#]/.test(p), 'a path without a query or a fragment'),
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
const KeyEventSchema = z
  .strictObject({
    ...base,
    kind: z.literal('key'),
    key: z.union([z.enum(RECORDED_KEYS), z.string().regex(RECORDED_SHORTCUT_KEY_RE)]),
    modifiers: z.array(z.enum(['Control', 'Meta', 'Alt', 'Shift'])).max(4),
    el: RecordedElementSchema.nullable(),
  })
  .refine((e) => (RECORDED_KEYS as readonly string[]).includes(e.key) || e.modifiers.includes('Control') || e.modifiers.includes('Meta'), 'a letter or digit only with Control or Meta');

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
