/**
 * A Studio recording's annotations (L4.8, core record-annotations.ts): what the schema refuses in text typed in the
 * Studio (a template, a hidden or control character, a blank or over-long value), the caps, the file parse, and one
 * change applied against the recording's events (the end resolved from the events, default mark names, choices only
 * of offered alternatives). Messages never quote the text.
 */
import { describe, expect, it } from 'vitest';
import {
  RECORD_ANNOTATIONS_MAX_BYTES,
  RECORD_CHOICES_MAX,
  RECORD_INSERTS_MAX,
  RecordAnnotationChangeSchema,
  RecordAnnotationsSchema,
  RecordInsertValuesSchema,
  RecordedEventSchema,
  applyRecordChange,
  emptyRecordAnnotations,
  isEmptyRecordAnnotations,
  parseRecordAnnotations,
  recordZoomOptions,
} from '../src/index.js';
import type { RecordAnnotations, RecordedEvent } from '../src/index.js';

const okValues = (v: unknown) => RecordInsertValuesSchema.safeParse(v).success;
const messages = (v: unknown) => {
  const r = RecordInsertValuesSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('insert values', () => {
  it('accepts each kind within its bounds', () => {
    expect(okValues({ kind: 'hold', seconds: 2 })).toBe(true);
    expect(okValues({ kind: 'wait_for', until: 'next_target' })).toBe(true);
    expect(okValues({ kind: 'wait_for', until: 'idle' })).toBe(true);
    expect(okValues({ kind: 'wait_for', until: 'text', text: 'Quote sent' })).toBe(true);
    expect(okValues({ kind: 'caption', text: 'Save the quote', kicker: 'Step 2' })).toBe(true);
    expect(okValues({ kind: 'mark', name: 'sent-1' })).toBe(true);
    expect(okValues({ kind: 'mark' })).toBe(true);
    expect(okValues({ kind: 'camera', zoom: 1.5, until: 'scene_end' })).toBe(true);
  });

  it('refuses a template, a control or hidden character, a blank or over-long text, out-of-range numbers, unknown keys', () => {
    const sentinel = 'Hi {{env:HOME}}';
    expect(okValues({ kind: 'caption', text: sentinel })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'ok', kicker: '{{vars.x}}' })).toBe(false);
    expect(okValues({ kind: 'wait_for', until: 'text', text: 'a {{b}}' })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'two\nlines' })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'Quillon\u200bmarsh' })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'bidi\u202eorder' })).toBe(false);
    expect(okValues({ kind: 'caption', text: '   ' })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'x'.repeat(201) })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'x', kicker: 'k'.repeat(61) })).toBe(false);
    expect(okValues({ kind: 'wait_for', until: 'text', text: 'x'.repeat(121) })).toBe(false);
    expect(okValues({ kind: 'wait_for', until: 'text' })).toBe(false);
    expect(okValues({ kind: 'wait_for', until: 'idle', text: 'x' })).toBe(false);
    expect(okValues({ kind: 'hold', seconds: 0.2 })).toBe(false);
    expect(okValues({ kind: 'hold', seconds: 11 })).toBe(false);
    // A factor (the engine checks it against the theme's max_zoom): above 1, at most 3, two decimals.
    for (const zoom of [1, 3.5, 1.333]) expect(okValues({ kind: 'camera', zoom, until: 'scene_end' }), String(zoom)).toBe(false);
    expect(okValues({ kind: 'mark', name: 'has space' })).toBe(false);
    expect(okValues({ kind: 'mark', name: 'm'.repeat(41) })).toBe(false);
    expect(okValues({ kind: 'caption', text: 'x', step: { click: 'Delete' } })).toBe(false);
    // Messages name the rule, never the text.
    for (const m of [...messages({ kind: 'caption', text: sentinel }), ...messages({ kind: 'caption', text: 'Quillon\u200bmarsh' })]) {
      expect(m).not.toContain('HOME');
      expect(m).not.toContain('Quillon');
    }
    expect(messages({ kind: 'caption', text: 'Quillon\u200bmarsh' }).join(' ')).toContain('U+200B');
  });
});

describe('annotations file', () => {
  const insert = (n: number) => ({ id: `i${n}`, after_seq: n, kind: 'hold' as const, seconds: 1 });

  it('caps: inserts, choices, unique ids and mark names; a stored insert has its id and position', () => {
    const ok = (a: unknown) => RecordAnnotationsSchema.safeParse(a).success;
    expect(ok(emptyRecordAnnotations())).toBe(true);
    expect(ok({ ...emptyRecordAnnotations(), inserts: Array.from({ length: RECORD_INSERTS_MAX }, (_, k) => insert(k + 1)) })).toBe(true);
    expect(ok({ ...emptyRecordAnnotations(), inserts: Array.from({ length: RECORD_INSERTS_MAX + 1 }, (_, k) => insert(k + 1)) })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), choices: Object.fromEntries(Array.from({ length: RECORD_CHOICES_MAX + 1 }, (_, k) => [String(k), 1])) })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), choices: { '01': 1 } })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), choices: { '3': 4 } })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), inserts: [insert(1), insert(1)] })).toBe(false);
    expect(
      ok({
        ...emptyRecordAnnotations(),
        inserts: [
          { id: 'i1', after_seq: 1, kind: 'mark', name: 'm1' },
          { id: 'i2', after_seq: 2, kind: 'mark', name: 'm1' },
        ],
      }),
    ).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), inserts: [{ id: 'i1', after_seq: 1, kind: 'mark' }] })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), inserts: [{ id: 'x/../1', after_seq: 1, kind: 'hold', seconds: 1 }] })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), inserts: [{ id: 'i1', after_seq: 1, kind: 'caption', text: '{{env:SECRET}}' }] })).toBe(false);
    expect(ok({ ...emptyRecordAnnotations(), extra: true })).toBe(false);
    expect(isEmptyRecordAnnotations(emptyRecordAnnotations())).toBe(true);
    expect(isEmptyRecordAnnotations({ ...emptyRecordAnnotations(), choices: { '1': 0 } })).toBe(false);
  });

  it('parse: over the byte cap, not JSON, or not the format → a fixed message', () => {
    expect(parseRecordAnnotations(JSON.stringify(emptyRecordAnnotations()))).toEqual({ annotations: emptyRecordAnnotations() });
    expect(parseRecordAnnotations(`{"v":1,"rev":0,"choices":{},"inserts":[],"pad":"${'x'.repeat(RECORD_ANNOTATIONS_MAX_BYTES)}"}`)).toEqual({ error: 'the annotations file is larger than 64 KiB' });
    expect(parseRecordAnnotations('{not json')).toEqual({ error: 'the annotations file is not JSON' });
    expect(parseRecordAnnotations(JSON.stringify({ v: 1, rev: 0, choices: {}, inserts: [{ id: 'i1', after_seq: 1, kind: 'caption', text: 'Hi {{env:HOME}}' }] }))).toEqual({
      error: 'the annotations file does not match its format',
    });
  });
});

describe('applyRecordChange', () => {
  const el = (alternatives?: unknown) => ({
    target: { label: 'Customer' },
    matches: 1,
    fragile: [],
    in: 'page',
    action: { kind: 'type', verified: true },
    role: 'textbox',
    tag: 'input',
    input_type: 'text',
    name: 'Customer',
    text: '',
    label: 'Customer',
    placeholder: null,
    testid: null,
    href_path: null,
    in_view: true,
    state: { disabled: false, expanded: false, checked: false, selected: false, popup_expected: false, covered: false },
    appeared: false,
    secret: false,
    ...(alternatives ? { alternatives } : {}),
  });
  const events: RecordedEvent[] = [
    { seq: 0, t: 10, page: 'p1', path: '/', kind: 'navigation', cause: 'start', same_document: false, where: 'environment', page_key: 'shop' },
    {
      seq: 1,
      t: 400,
      page: 'p1',
      path: '/',
      kind: 'pointer',
      button: 'left',
      via: 'pointer',
      el: el([
        { target: { placeholder: 'Acme' }, fragile: [] },
        { target: { text: 'pw •••' }, fragile: [] },
      ]),
      quiet_ms: 1,
      ms: 1,
    },
    { seq: 2, t: 900, page: 'p1', path: '/', kind: 'pointer', button: 'left', via: 'pointer', el: el(), quiet_ms: 1, ms: 1 },
  ].map((e) => RecordedEventSchema.parse(e));
  const apply = (a: RecordAnnotations, change: unknown) => applyRecordChange(a, RecordAnnotationChangeSchema.parse(change), events);

  it('an insert "at the end" goes after the newest event; after a step only up to it; ids from the revision; marks m1, m2… by default', () => {
    let a = emptyRecordAnnotations();
    const r1 = apply(a, { op: 'insert', at: 'end', insert: { kind: 'caption', text: 'Save it' } });
    expect(r1).toEqual({ annotations: { v: 1, rev: 1, choices: {}, inserts: [{ id: 'i1', after_seq: 2, kind: 'caption', text: 'Save it' }] }, id: 'i1' });
    a = (r1 as { annotations: RecordAnnotations }).annotations;
    const r2 = apply(a, { op: 'insert', at: { after_step_seq: 1 }, insert: { kind: 'mark' } });
    a = (r2 as { annotations: RecordAnnotations }).annotations;
    expect(a.inserts[1]).toEqual({ id: 'i2', after_seq: 1, kind: 'mark', name: 'm1' });
    a = (apply(a, { op: 'insert', at: 'end', insert: { kind: 'mark' } }) as { annotations: RecordAnnotations }).annotations;
    expect(a.inserts[2]).toMatchObject({ id: 'i3', name: 'm2' });
    expect(apply(a, { op: 'insert', at: 'end', insert: { kind: 'mark', name: 'm1' } })).toEqual({ error: { code: 'taken', message: 'that mark name is already used in this recording' } });
    expect(apply(a, { op: 'insert', at: { after_step_seq: 3 }, insert: { kind: 'hold', seconds: 2 } })).toMatchObject({ error: { code: 'invalid' } });
    // Remove.
    const r4 = apply(a, { op: 'remove', id: 'i2' });
    expect((r4 as { annotations: RecordAnnotations }).annotations.inserts.map((x) => x.id)).toEqual(['i1', 'i3']);
    expect((r4 as { annotations: RecordAnnotations }).annotations.rev).toBe(4);
    expect(apply(a, { op: 'remove', id: 'i9' })).toMatchObject({ error: { code: 'not_found' } });
    // With no event yet, "the end" is before everything.
    expect(applyRecordChange(emptyRecordAnnotations(), { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 2 } }, [])).toMatchObject({ annotations: { inserts: [{ after_seq: -1 }] } });
  });

  it('a choice only of an offered alternative (never a masked one), 0 for the suggestion; the caps hold', () => {
    const a = emptyRecordAnnotations();
    expect(apply(a, { op: 'choose', seq: 1, index: 1 })).toMatchObject({ annotations: { rev: 1, choices: { '1': 1 } } });
    expect(apply(a, { op: 'choose', seq: 1, index: 0 })).toMatchObject({ annotations: { choices: { '1': 0 } } });
    expect(apply(a, { op: 'choose', seq: 1, index: 2 })).toMatchObject({ error: { code: 'invalid' } });
    expect(apply(a, { op: 'choose', seq: 2, index: 1 })).toMatchObject({ error: { code: 'invalid' } });
    expect(apply(a, { op: 'choose', seq: 0, index: 0 })).toMatchObject({ error: { code: 'not_found' } });
    expect(apply(a, { op: 'choose', seq: 7, index: 0 })).toMatchObject({ error: { code: 'not_found' } });
    const full = { ...a, inserts: Array.from({ length: RECORD_INSERTS_MAX }, (_, k) => ({ id: `i${k + 1}`, after_seq: 1, kind: 'hold' as const, seconds: 1 })) };
    expect(apply(full, { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 1 } })).toMatchObject({ error: { code: 'too_many' } });
    // A change carrying a template never parses.
    expect(RecordAnnotationChangeSchema.safeParse({ op: 'insert', at: 'end', insert: { kind: 'caption', text: '{{env:HOME}}' } }).success).toBe(false);
    expect(RecordAnnotationChangeSchema.safeParse({ op: 'insert', at: 'end', after_seq: 1, insert: { kind: 'hold', seconds: 1 } }).success).toBe(false);
  });
});

describe('after the reviews of L4.8', () => {
  const el = (alternatives?: unknown) => ({
    target: { label: 'Customer' },
    matches: 1,
    fragile: [],
    in: 'page',
    action: { kind: 'type', verified: true },
    role: 'textbox',
    tag: 'input',
    input_type: 'text',
    name: 'Customer',
    text: '',
    label: 'Customer',
    placeholder: null,
    testid: null,
    href_path: null,
    in_view: true,
    state: { disabled: false, expanded: false, checked: false, selected: false, popup_expected: false, covered: false },
    appeared: false,
    secret: false,
    ...(alternatives ? { alternatives } : {}),
  });
  const ZWSP = String.fromCharCode(0x200b);
  const events: RecordedEvent[] = [
    { seq: 0, t: 10, page: 'p1', path: '/', kind: 'navigation', cause: 'start', same_document: false, where: 'environment', page_key: 'shop' },
    {
      seq: 1,
      t: 400,
      page: 'p1',
      path: '/',
      kind: 'pointer',
      button: 'left',
      via: 'pointer',
      el: el([
        { target: { testid: `ok${ZWSP}` }, fragile: [] },
        { target: { placeholder: 'Acme' }, fragile: [] },
      ]),
      quiet_ms: 1,
      ms: 1,
    },
    { seq: 2, t: 900, page: 'p1', path: '/', kind: 'pointer', button: 'left', via: 'pointer', el: el(), quiet_ms: 1, ms: 1 },
  ].map((e) => RecordedEventSchema.parse(e));
  const apply = (a: RecordAnnotations, change: unknown) => applyRecordChange(a, RecordAnnotationChangeSchema.parse(change), events);

  it('A-M3: an alternative holding a hidden character is never offered, so never chosen', () => {
    expect(apply(emptyRecordAnnotations(), { op: 'choose', seq: 1, index: 1 })).toMatchObject({ error: { code: 'invalid' } });
    expect(apply(emptyRecordAnnotations(), { op: 'choose', seq: 1, index: 2 })).toMatchObject({ annotations: { choices: { '1': 2 } } });
  });

  it("B-H1: an insert after the recorder's wait row keeps `row: wait`; after an insert row, that insert's anchor and `after_insert`", () => {
    let a = emptyRecordAnnotations();
    const r1 = apply(a, { op: 'insert', at: { after_step_seq: 2, row: 'wait' }, insert: { kind: 'hold', seconds: 2 } });
    a = (r1 as { annotations: RecordAnnotations }).annotations;
    expect(a.inserts[0]).toEqual({ id: 'i1', after_seq: 2, row: 'wait', kind: 'hold', seconds: 2 });
    const r2 = apply(a, { op: 'insert', at: { after_insert: 'i1' }, insert: { kind: 'wait_for', until: 'idle' } });
    a = (r2 as { annotations: RecordAnnotations }).annotations;
    expect(a.inserts[1]).toEqual({ id: 'i2', after_seq: 2, row: 'wait', after_insert: 'i1', kind: 'wait_for', until: 'idle' });
    expect(apply(a, { op: 'insert', at: { after_insert: 'i9' }, insert: { kind: 'mark' } })).toEqual({ error: { code: 'not_found', message: 'no such insert' } });
    // Only these anchors: no other row kind, no index.
    expect(RecordAnnotationChangeSchema.safeParse({ op: 'insert', at: { after_step_seq: 2, row: 'scroll' }, insert: { kind: 'hold', seconds: 2 } }).success).toBe(false);
    expect(RecordAnnotationChangeSchema.safeParse({ op: 'insert', at: { after_step: 3 }, insert: { kind: 'hold', seconds: 2 } }).success).toBe(false);
  });

  it("B-M3: the zoom factors and default under a theme's max_zoom", () => {
    expect(recordZoomOptions(1.4)).toEqual({ options: [1.25, 1.4], default: 1.4 });
    expect(recordZoomOptions(1.6)).toEqual({ options: [1.25, 1.5, 1.6], default: 1.5 });
    expect(recordZoomOptions(3)).toEqual({ options: [1.25, 1.5, 2], default: 1.5 });
    expect(recordZoomOptions(1.2)).toEqual({ options: [1.2], default: 1.2 });
    expect(recordZoomOptions(1.333)).toEqual({ options: [1.25, 1.33], default: 1.33 });
    expect(recordZoomOptions(1)).toBeNull();
    for (const zoom of recordZoomOptions(1.333)!.options) expect(okValues({ kind: 'camera', zoom, until: 'step_end' }), String(zoom)).toBe(true);
  });

  it('A-N2: a saved scenario in studio.json is a slug and its own scenarios/<name>.yaml', () => {
    const saved = (name: string, file: string) =>
      RecordAnnotationsSchema.safeParse({ v: 1, rev: 1, choices: {}, inserts: [], saved: { name, file, hash: 'a'.repeat(64), at: '2026-10-28T10:00:00.000Z' } }).success;
    expect(saved('quote', 'scenarios/quote.yaml')).toBe(true);
    expect(saved('quote', 'scenarios/other.yaml')).toBe(false);
    expect(saved('../x', 'scenarios/../x.yaml')).toBe(false);
  });
});
