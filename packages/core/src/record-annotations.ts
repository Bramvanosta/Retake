/**
 * A Studio recording's annotations (L4.8, `<record folder>/studio.json`): the targets the person picked among the
 * recorder's verified alternatives, and the quick inserts placed at the draft cursor (hold, wait_for, caption, mark,
 * camera zoom). Positions are event sequence numbers (stable: `seq` has no gaps and is never renumbered), so a choice or
 * an insert survives every regeneration of the draft (core recording.ts `draftFromRecording`, which applies them).
 *
 * The file is written only by the engine (one change at a time, under its revision); everything in it came from a
 * Studio page, so it is validated here before any use: no `{{` (a scenario would resolve it as a template — a var, an
 * environment variable), no control or hidden character, bounded sizes. Error messages never quote the text.
 */
import { z } from 'zod';
import { SLUG_RE } from './schemas/primitives.js';
import { firstHiddenChar, hiddenCharName } from './scenario-edit.js';
import { recordedAlternatives } from './recording.js';
import type { RecordedEvent } from './recording.js';

export const RECORD_ANNOTATIONS_VERSION = 1;
/** Most inserts one recording keeps. */
export const RECORD_INSERTS_MAX = 200;
/** Most target choices one recording keeps. */
export const RECORD_CHOICES_MAX = 2000;
/** The largest studio.json read or written (bytes). */
export const RECORD_ANNOTATIONS_MAX_BYTES = 64 * 1024;
export const RECORD_CAPTION_MAX = 200;
export const RECORD_KICKER_MAX = 60;
export const RECORD_WAIT_TEXT_MAX = 120;
export const RECORD_MARK_MAX = 40;
/** A hold insert's seconds (min, max, the form's default). */
export const RECORD_HOLD_S = { min: 0.5, max: 10, default: 2 } as const;
/** The zoom factors a camera insert offers, each at most the project theme's max_zoom (the default: 1.5, idem). */
export const RECORD_ZOOMS = [1.25, 1.5, 2] as const;
export const RECORD_ZOOM_DEFAULT = 1.5;

/**
 * The zoom factors a camera insert offers under a theme's `motion.max_zoom` (L4.8 review: a factor above it is clamped
 * by the editor and warned by the validator), and the default — min(1.5, max_zoom); null when the theme allows none.
 */
export function recordZoomOptions(maxZoom: number): { options: number[]; default: number } | null {
  const max = Math.floor(Math.min(3, maxZoom) * 100 + 1e-6) / 100;
  if (!(max > 1)) return null;
  const options = [...new Set(RECORD_ZOOMS.map((z) => Math.min(z, max)))].sort((a, b) => a - b);
  return { options, default: Math.min(RECORD_ZOOM_DEFAULT, max) };
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** An insert id: "i" and the revision that added it. */
const INSERT_ID_RE = /^i[1-9]\d{0,6}$/;

/** Text typed in the Studio for a scenario field: one line, no template, no control or hidden character, not blank. */
const studioText = (max: number, what: string) =>
  z
    .string()
    .max(max, { error: `${what} is longer than ${max} characters` })
    .superRefine((s, ctx) => {
      if (!s.trim()) ctx.addIssue({ code: 'custom', message: `${what} is empty` });
      if (s.includes('{{')) ctx.addIssue({ code: 'custom', message: `${what} may not hold "{{" (a scenario would resolve it as a template)` });
      // One line: hiddenChars leaves line breaks, tabs and a leading BOM to file rules — not here.
      const h = /[\t\n\r\ufeff]/.exec(s)?.[0] ?? firstHiddenChar(s);
      if (h !== undefined) ctx.addIssue({ code: 'custom', message: `${what} holds ${hiddenCharName(h)}: one line of visible text only` });
    });

const markName = z
  .string()
  .max(RECORD_MARK_MAX, { error: `a mark name is longer than ${RECORD_MARK_MAX} characters` })
  .regex(SLUG_RE, { error: 'a mark name must be slug-like: letters, digits, "-" or "_", starting with a letter or digit' });

const holdValues = { kind: z.literal('hold'), seconds: z.number().min(RECORD_HOLD_S.min).max(RECORD_HOLD_S.max) };
const waitValues = {
  kind: z.literal('wait_for'),
  /** next_target: the target of the action that comes next (page idle when it has none); idle: the network; text: a text shows. */
  until: z.enum(['next_target', 'idle', 'text']),
  text: studioText(RECORD_WAIT_TEXT_MAX, 'the text to wait for').optional(),
};
const waitRule = (w: { until: string; text?: string }) => (w.until === 'text') === (w.text !== undefined);
const waitRuleMessage = { error: 'a wait for a text needs its text, and only it does' };
const captionValues = { kind: z.literal('caption'), text: studioText(RECORD_CAPTION_MAX, 'a caption'), kicker: studioText(RECORD_KICKER_MAX, 'a kicker').optional() };
const cameraValues = {
  kind: z.literal('camera'),
  /** A factor recordZoomOptions offers (the engine refuses one above the project theme's max_zoom). */
  zoom: z
    .number()
    .gt(1)
    .max(3)
    .refine((n) => Number(n.toFixed(2)) === n, { error: 'a zoom factor with at most two decimals' }),
  until: z.enum(['scene_end', 'step_end']),
};

/** What the Studio sends for an insert (a mark's name is optional: m1, m2… by default). */
export const RecordInsertValuesSchema = z.discriminatedUnion('kind', [
  z.strictObject(holdValues),
  z.strictObject(waitValues).refine(waitRule, waitRuleMessage),
  z.strictObject(captionValues),
  z.strictObject({ kind: z.literal('mark'), name: markName.optional() }),
  z.strictObject(cameraValues),
]);
export type RecordInsertValues = z.infer<typeof RecordInsertValuesSchema>;

const placed = {
  id: z.string().regex(INSERT_ID_RE),
  /** The insert goes at the action that comes after this event (-1: before every event). */
  after_seq: z.number().int().min(-1).max(10_000_000),
  /** Placed right after the recorder's wait before the action at `after_seq` (the row it was made on). */
  row: z.literal('wait').optional(),
  /** Placed right after this insert (the row it was made on; `after_seq` / `row` are that insert's, once it is gone). */
  after_insert: z.string().regex(INSERT_ID_RE).optional(),
};

/** A stored insert. hold and wait_for become steps; caption, mark and camera go on the next action step. */
export const RecordInsertSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...placed, ...holdValues }),
  z.strictObject({ ...placed, ...waitValues }).refine(waitRule, waitRuleMessage),
  z.strictObject({ ...placed, ...captionValues }),
  z.strictObject({ ...placed, kind: z.literal('mark'), name: markName }),
  z.strictObject({ ...placed, ...cameraValues }),
]);
export type RecordInsert = z.infer<typeof RecordInsertSchema>;
export type RecordInsertKind = RecordInsert['kind'];
/** Kinds that become a step of their own (the others modify the next action step). */
export const RECORD_STEP_INSERTS: readonly RecordInsertKind[] = ['hold', 'wait_for'];

export const RecordAnnotationsSchema = z
  .strictObject({
    v: z.literal(RECORD_ANNOTATIONS_VERSION),
    /** Bumped by every change (the engine writes under it: a stale revision is refused). */
    rev: z.number().int().min(0).max(1_000_000),
    /** Event seq → the target picked: 0 = the recorder's suggestion, n = its n-th alternative. */
    choices: z
      .record(z.string().regex(/^(0|[1-9]\d{0,6})$/), z.number().int().min(0).max(3))
      .refine((c) => Object.keys(c).length <= RECORD_CHOICES_MAX, { error: `at most ${RECORD_CHOICES_MAX} target choices` }),
    inserts: z.array(RecordInsertSchema).max(RECORD_INSERTS_MAX),
    /** Set by the engine's Save (the scenario it created): nothing changes after it. */
    saved: z
      .strictObject({ name: z.string().min(1).max(100).regex(SLUG_RE), file: z.string().max(140), hash: z.string().regex(/^[0-9a-f]{64}$/), at: z.string().max(40) })
      .refine((v) => v.file === `scenarios/${v.name}.yaml`, { error: 'a saved file is scenarios/<name>.yaml' })
      .optional(),
    /** Set by the engine's Discard while the job still ran (a draft or check phase): the folder goes once the job is over. */
    discard: z.strictObject({ at: z.string().max(40) }).optional(),
  })
  .superRefine((a, ctx) => {
    const ids = new Set<string>();
    const marks = new Set<string>();
    for (const [i, x] of a.inserts.entries()) {
      if (ids.has(x.id)) ctx.addIssue({ code: 'custom', path: ['inserts', i, 'id'], message: 'an insert id is used twice' });
      ids.add(x.id);
      if (x.kind === 'mark') {
        if (marks.has(x.name)) ctx.addIssue({ code: 'custom', path: ['inserts', i, 'name'], message: 'a mark name is used twice' });
        marks.add(x.name);
      }
    }
  });
export type RecordAnnotations = z.infer<typeof RecordAnnotationsSchema>;

export function emptyRecordAnnotations(): RecordAnnotations {
  return { v: RECORD_ANNOTATIONS_VERSION, rev: 0, choices: {}, inserts: [] };
}

/** Nothing picked and nothing inserted: the draft is exactly the recorder's. */
export function isEmptyRecordAnnotations(a: RecordAnnotations | null | undefined): boolean {
  return !a || (a.inserts.length === 0 && Object.keys(a.choices).length === 0);
}

/**
 * studio.json's text → annotations, or why not (a fixed message: never the file's text). Over the byte cap, not JSON
 * or not the schema: refused.
 */
export function parseRecordAnnotations(text: string): { annotations: RecordAnnotations } | { error: string } {
  if (utf8Bytes(text) > RECORD_ANNOTATIONS_MAX_BYTES) return { error: `the annotations file is larger than ${RECORD_ANNOTATIONS_MAX_BYTES / 1024} KiB` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'the annotations file is not JSON' };
  }
  const r = RecordAnnotationsSchema.safeParse(raw);
  return r.success ? { annotations: r.data } : { error: 'the annotations file does not match its format' };
}

/**
 * Where an insert goes — the row the Record screen's cursor is on, by its identity, never its index: after the newest
 * event ("end": resolved by the engine under its lock); after a step's last event (an action or the recorder's scroll
 * row); right after the recorder's wait before the action at that event (`row: 'wait'`); right after an insert.
 */
export const RecordInsertAtSchema = z.union([
  z.literal('end'),
  z.strictObject({ after_step_seq: z.number().int().min(-1).max(10_000_000), row: z.literal('wait').optional() }),
  z.strictObject({ after_insert: z.string().regex(INSERT_ID_RE) }),
]);
export type RecordInsertAt = z.infer<typeof RecordInsertAtSchema>;

/** One change the Studio asks for. */
export const RecordAnnotationChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('choose'), seq: z.number().int().min(0).max(10_000_000), index: z.number().int().min(0).max(3) }),
  z.strictObject({ op: z.literal('insert'), at: RecordInsertAtSchema, insert: RecordInsertValuesSchema }),
  z.strictObject({ op: z.literal('remove'), id: z.string().regex(INSERT_ID_RE) }),
]);
export type RecordAnnotationChange = z.infer<typeof RecordAnnotationChangeSchema>;

export type RecordChangeError = { code: 'not_found' | 'invalid' | 'too_many' | 'taken'; message: string };

/**
 * Apply one change to annotations against the recording's events (read by the caller under the annotate lock): the
 * result has `rev + 1`. Pure. A choice must name an event whose element has that alternative (an offered one: not
 * masked, not templated); an insert "at the end" goes after the newest event; a mark without a name gets the first free
 * `m<n>`. Errors are fixed messages (no page or typed text).
 */
export function applyRecordChange(
  a: RecordAnnotations,
  change: RecordAnnotationChange,
  events: readonly RecordedEvent[],
): { annotations: RecordAnnotations; id?: string } | { error: RecordChangeError } {
  const rev = a.rev + 1;
  let lastSeq = -1;
  for (const e of events) if (e.seq > lastSeq) lastSeq = e.seq;
  let out: RecordAnnotations;
  let id: string | undefined;
  if (change.op === 'choose') {
    const ev = events.find((e) => e.seq === change.seq);
    const el = ev && 'el' in ev ? ev.el : null;
    if (!el) return { error: { code: 'not_found', message: 'no recorded action with targets at that position' } };
    if (change.index > 0 && !recordedAlternatives(el).some((x) => x.index === change.index)) {
      return { error: { code: 'invalid', message: 'that alternative target does not exist for this action' } };
    }
    const choices = { ...a.choices, [String(change.seq)]: change.index };
    if (Object.keys(choices).length > RECORD_CHOICES_MAX) return { error: { code: 'too_many', message: `at most ${RECORD_CHOICES_MAX} target choices` } };
    out = { ...a, rev, choices };
  } else if (change.op === 'insert') {
    if (a.inserts.length >= RECORD_INSERTS_MAX) return { error: { code: 'too_many', message: `at most ${RECORD_INSERTS_MAX} inserts` } };
    const at = change.at;
    let anchor: Pick<RecordInsert, 'after_seq' | 'row' | 'after_insert'>;
    if (at === 'end') anchor = { after_seq: lastSeq };
    else if ('after_insert' in at) {
      const ref = a.inserts.find((x) => x.id === at.after_insert);
      if (!ref) return { error: { code: 'not_found', message: 'no such insert' } };
      anchor = { after_seq: ref.after_seq, ...(ref.row ? { row: ref.row } : {}), after_insert: ref.id };
    } else anchor = { after_seq: at.after_step_seq, ...(at.row ? { row: at.row } : {}) };
    const after = anchor.after_seq;
    if (after > lastSeq) return { error: { code: 'invalid', message: 'that position is past the end of the recording' } };
    id = `i${rev}`;
    const v = change.insert;
    let insert: RecordInsert;
    if (v.kind === 'mark') {
      const used = new Set(a.inserts.flatMap((x) => (x.kind === 'mark' ? [x.name] : [])));
      let name = v.name;
      if (name === undefined) {
        let n = 1;
        while (used.has(`m${n}`)) n++;
        name = `m${n}`;
      } else if (used.has(name)) return { error: { code: 'taken', message: 'that mark name is already used in this recording' } };
      insert = { id, ...anchor, kind: 'mark', name };
    } else insert = { id, ...anchor, ...v } as RecordInsert;
    out = { ...a, rev, inserts: [...a.inserts, insert] };
  } else {
    if (!a.inserts.some((x) => x.id === change.id)) return { error: { code: 'not_found', message: 'no such insert' } };
    out = { ...a, rev, inserts: a.inserts.filter((x) => x.id !== change.id) };
  }
  const checked = RecordAnnotationsSchema.safeParse(out);
  if (!checked.success) return { error: { code: 'invalid', message: 'the change does not fit the annotations format' } };
  if (utf8Bytes(JSON.stringify(checked.data)) > RECORD_ANNOTATIONS_MAX_BYTES) {
    return { error: { code: 'too_many', message: `the annotations would pass ${RECORD_ANNOTATIONS_MAX_BYTES / 1024} KiB` } };
  }
  return { annotations: checked.data, ...(id !== undefined ? { id } : {}) };
}
