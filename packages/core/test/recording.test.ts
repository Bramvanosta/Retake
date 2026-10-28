/**
 * The recorder's event model (L3.4, core recording.ts): what the schema itself refuses — a secret typing event with
 * its text, a path with a query, a printable key without a modifier, an unknown field — and the record id.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RECORD_ID_RE,
  RecordedEventSchema,
  applyStepEdit,
  draftFromRecording,
  draftInvalidIssue,
  emptyRecordAnnotations,
  firstHiddenChar,
  parseScenario,
  recordedAlternatives,
  shownStep,
  stepGuard,
} from '../src/index.js';
import type { DraftContext, RecordAnnotations, RecordInsert, RecordedElement, RecordedEvent } from '../src/index.js';

const base = { seq: 0, t: 10, page: 'p1', path: '/quotes' };
const el = {
  target: { text: 'Save' },
  matches: 1,
  fragile: [],
  in: 'page',
  action: { kind: 'click', verified: true },
  role: 'button',
  tag: 'button',
  input_type: null,
  name: 'Save',
  text: 'Save',
  label: null,
  placeholder: null,
  testid: null,
  href_path: null,
  in_view: true,
  state: { disabled: false, expanded: false, checked: false, selected: false, popup_expected: false, covered: false },
  appeared: false,
  secret: false,
};
const ok = (e: unknown) => RecordedEventSchema.safeParse(e).success;

describe('RecordedEventSchema', () => {
  it('accepts the events a recording streams', () => {
    expect(ok({ ...base, kind: 'pointer', button: 'left', via: 'pointer', el, quiet_ms: 300, ms: 2 })).toBe(true);
    expect(ok({ ...base, kind: 'type', el, secret: false, field_kind: 'text', text: 'Two bags', clear: false, enter: true, pasted: false, autofill: false })).toBe(true);
    expect(ok({ ...base, kind: 'type', el, secret: true, field_kind: 'password', clear: false, enter: false, pasted: false, autofill: false })).toBe(true);
    expect(ok({ ...base, kind: 'key', key: 'Escape', modifiers: [], el: null })).toBe(true);
    expect(ok({ ...base, kind: 'key', key: 'k', modifiers: ['Meta'], el: null })).toBe(true);
    expect(ok({ ...base, kind: 'navigation', cause: 'typed', same_document: false, where: 'environment', page_key: 'shop', query: '?tab=lots' })).toBe(true);
    expect(ok({ ...base, kind: 'write', method: 'POST', label: 'POST shop:/api/quotes', outcome: 'passed' })).toBe(true);
    expect(ok({ ...base, kind: 'stop', reason: 'closed' })).toBe(true);
  });

  it('refuses a secret with its text, text missing from a plain typing, a query in a path, a printable key alone, unknown keys', () => {
    expect(ok({ ...base, kind: 'type', el, secret: true, field_kind: 'password', text: 'hunter22', clear: false, enter: false, pasted: false, autofill: false })).toBe(false);
    expect(ok({ ...base, kind: 'type', el, secret: false, field_kind: 'text', clear: false, enter: false, pasted: false, autofill: false })).toBe(false);
    expect(ok({ ...base, path: '/quotes?token=x', kind: 'stop', reason: 'closed' })).toBe(false);
    expect(ok({ ...base, kind: 'key', key: 'a', modifiers: [], el: null })).toBe(false);
    expect(ok({ ...base, kind: 'key', key: '7', modifiers: ['Shift'], el: null })).toBe(false);
    expect(ok({ ...base, kind: 'pointer', button: 'left', via: 'pointer', el, quiet_ms: 1, ms: 1, value: 'x' })).toBe(false);
    expect(ok({ ...base, kind: 'pointer', button: 'left', via: 'pointer', el: { ...el, value: 'secret' }, quiet_ms: 1, ms: 1 })).toBe(false);
    expect(ok({ ...base, kind: 'forged' })).toBe(false);
  });

  it('record ids', () => {
    expect(RECORD_ID_RE.test('rec_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe(true);
    expect(RECORD_ID_RE.test('rec_../../etc')).toBe(false);
    expect(RECORD_ID_RE.test('i_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe(false);
  });
});

// ── The draft generator (part 2): rules from synthetic events; every draft must validate ──────────────────────────────

type Over = Partial<Omit<RecordedElement, 'action' | 'state'>> & { action?: Partial<RecordedElement['action']> };
/** An element as the recorder reports it (verified target `{text}` by default). */
function elOf(o: Over = {}): RecordedElement {
  const { action, ...rest } = o;
  return {
    ...(el as unknown as RecordedElement),
    ...rest,
    action: { kind: 'click', verified: true, ...(action ?? {}) },
  } as RecordedElement;
}

/** A recording from compact event bodies: seq and page filled in, `t` given (ms), the path defaults to the last one. */
function rec(...bodies: Array<Record<string, unknown> & { kind: string; t: number }>): RecordedEvent[] {
  let path = '/';
  return bodies.map((b, seq) => {
    if (typeof b.path === 'string') path = b.path;
    const e = { page: 'p1', path, ...b, seq };
    if (b.kind === 'write' && b.path === undefined) (e as { path: string }).path = '';
    const parsed = RecordedEventSchema.safeParse(e);
    if (!parsed.success) throw new Error(`bad test event ${JSON.stringify(e)}: ${parsed.error.message}`);
    return parsed.data;
  });
}
const start = (path = '/', page_key = 'shop', t = 10) => ({ kind: 'navigation', t, path, cause: 'start', same_document: false, where: 'environment', page_key });
const nav = (t: number, path: string, cause: string, o: Record<string, unknown> = {}) => ({ kind: 'navigation', t, path, cause, same_document: cause === 'spa', where: 'environment', page_key: 'shop', ...o });
const press = (t: number, o: Over | null, extra: Record<string, unknown> = {}) => ({ kind: 'pointer', t, button: 'left', via: 'pointer', el: o === null ? null : elOf(o), quiet_ms: 500, ms: 2, ...extra });
const typing = (t: number, o: Over, extra: Record<string, unknown>) => ({ kind: 'type', t, el: elOf(o), secret: false, field_kind: 'text', clear: false, enter: false, pasted: false, autofill: false, ...extra });
const stop = (t: number) => ({ kind: 'stop', t, reason: 'closed' });

const CTX: DraftContext = { name: 'recorded', env: 'local', envIsDefault: true, pages: { shop: 'http://127.0.0.1:4402', console: 'http://127.0.0.1:4401/admin' }, persona: null, access: 'read-write' };

/** The same recording with three alternatives on every element: one usable, one masked, one templated (L4.8). */
function withAlternatives(events: RecordedEvent[]): RecordedEvent[] {
  return events.map((e) => {
    if (!('el' in e) || e.el === null) return e;
    const el = {
      ...e.el,
      alternatives: [
        { target: { testid: `alt-${e.seq}` }, fragile: [] },
        { target: { text: 'pw ••• shown' }, fragile: ['dynamic_text'] },
        { target: { label: '{{vars.x}}' }, fragile: ['broader'] },
      ],
      alternatives_partial: true,
    };
    return RecordedEventSchema.parse({ ...e, el });
  });
}
const outputOf = (d: ReturnType<typeof draftFromRecording>) => ({ yaml: d.yaml, scenario: d.scenario, issues: d.issues, writes: d.writes, firstWrite: d.firstWrite, stats: d.stats, placeholders: d.placeholders });

function draft(events: RecordedEvent[], ctx: Partial<DraftContext> = {}, annotations?: RecordAnnotations) {
  const d = draftFromRecording(events, { ...CTX, ...ctx }, annotations);
  const { scenario, issues } = parseScenario(d.yaml);
  expect(issues.filter((i) => i.severity === 'error'), d.yaml).toEqual([]);
  expect(scenario).toBeDefined();
  expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
  if (annotations === undefined) {
    // Three ways, one draft (L4.8): alternatives on every element (masked and templated ones included) and empty
    // annotations change nothing in the recorder's draft — its YAML, issues (codes included), writes and stats.
    expect(outputOf(draftFromRecording(withAlternatives(events), { ...CTX, ...ctx }))).toEqual(outputOf(d));
    expect(outputOf(draftFromRecording(events, { ...CTX, ...ctx }, emptyRecordAnnotations()))).toEqual(outputOf(d));
    expect(d.pending).toEqual([]);
    expect(d.sources.every((x) => x.role !== 'insert' && x.chosen === undefined && x.modifiers === undefined)).toBe(true);
  }
  const scenes = d.scenario.scenes as Array<{ id: string; page?: string; open?: string; persona?: string; steps: Array<Record<string, unknown>> }>;
  return { ...d, scenes, steps: scenes.flatMap((s) => s.steps) };
}

describe('draftFromRecording: steps', () => {
  it('clicks on verified targets; two separate presses on one control are both kept; a press on nothing is dropped', () => {
    const d = draft(rec(start(), press(500, { target: { role: 'button', name: 'Increase' }, in: 'dialog' }), press(700, { target: { role: 'button', name: 'Increase' }, in: 'dialog' }), press(900, null), press(1100, { target: { text: 'Save' } }), stop(1500)));
    expect(d.steps).toEqual([{ click: { role: 'button', name: 'Increase' } }, { click: { role: 'button', name: 'Increase' } }, { click: 'Save' }]);
    expect(d.stats.noise).toBe(1);
    expect(d.yaml).toContain('version: 1');
    expect(d.yaml).toContain('- click: {role: button, name: Increase}');
  });

  it('typing: the press that focused the field becomes `into` (always written), clear and enter kept', () => {
    const f = { target: { label: 'Message' }, action: { kind: 'type' as const } };
    const d = draft(rec(start(), press(500, f), typing(900, f, { text: 'Two bags', clear: true, enter: true }), typing(1500, { target: { label: 'Note' } }, { text: 'Hi' }), stop(2000)));
    expect(d.steps).toEqual([{ type: { into: { label: 'Message' }, text: 'Two bags', clear: true, enter: true } }, { type: { into: { label: 'Note' }, text: 'Hi' } }]);
  });

  it('a secret field becomes {{vars.<kind>_N}} with a placeholder and a warning; its value never appears; a project var is never shadowed', () => {
    const pw = { target: { label: 'Password' }, secret: true, action: { kind: 'type' as const } };
    const events = rec(
      start(),
      typing(500, pw, { secret: true, field_kind: 'password', text: undefined }),
      typing(900, { target: { label: 'Card number' }, secret: true }, { secret: true, field_kind: 'card_number', text: undefined }),
      typing(1300, { target: { label: 'Password again' }, secret: true }, { secret: true, field_kind: 'password', text: undefined }),
      stop(2000),
    );
    const d = draft(events);
    expect(d.steps.map((s) => (s.type as { text: string }).text)).toEqual(['{{vars.password_1}}', '{{vars.card_number_1}}', '{{vars.password_2}}']);
    expect(d.scenario.vars).toEqual({ password_1: 'CHANGE-ME', card_number_1: 'CHANGE-ME', password_2: 'CHANGE-ME' });
    expect(d.issues.filter((i) => i.code === 'secret_field')).toHaveLength(3);
    expect(d.issues[0].message).toMatch(/showable demo value/);
    expect(d.stats.secrets).toBe(3);
    const shared = draft(events, { projectVars: { password_1: 'demo-pass' } });
    expect(shared.scenario.vars).toEqual({ card_number_1: 'CHANGE-ME', password_2: 'CHANGE-ME' });
    expect(shared.issues.find((i) => i.code === 'secret_field' && i.step === 0)?.message).toMatch(/project\.yaml's vars\.password_1/);
  });

  it('one-time-code boxes typed one by one: one typing step on the first box, with a warning', () => {
    const box = (n: number) => ({ target: { label: `Digit ${n}` }, secret: true });
    const d = draft(rec(start(), ...[1, 2, 3, 4].map((n) => typing(400 + n * 100, box(n), { secret: true, field_kind: 'one_time_code', text: undefined })), press(1500, { target: { text: 'Verify' } }), stop(2000)));
    expect(d.steps).toEqual([{ type: { into: { label: 'Digit 1' }, text: '{{vars.one_time_code_1}}' } }, { click: 'Verify' }]);
    expect(d.issues.map((i) => i.code)).toContain('one_time_code');
  });

  it('keys: Escape, Enter on a field, a shortcut, Space', () => {
    const d = draft(rec(start(), { kind: 'key', t: 400, key: 'Escape', modifiers: [], el: null }, { kind: 'key', t: 500, key: 'k', modifiers: ['Meta'], el: null }, { kind: 'key', t: 600, key: ' ', modifiers: [], el: null }, stop(900)));
    expect(d.steps).toEqual([{ press: 'Escape' }, { press: 'Meta+k' }, { press: 'Space' }]);
  });

  it('a double click: two presses on one element and dblclick', () => {
    const t = { target: { text: 'Lot 7' } };
    const d = draft(rec(start(), press(400, t), press(480, t), { kind: 'dblclick', t: 485 }, stop(900)));
    expect(d.steps).toEqual([{ double_click: 'Lot 7' }]);
  });

  it('a right click keeps its button; a middle click is not recorded', () => {
    const d = draft(rec(start(), press(400, { target: { text: 'Lot 7' } }, { button: 'right' }), press(600, { target: { text: 'Lot 8' } }, { button: 'middle' }), stop(900)));
    expect(d.steps).toEqual([{ click: { text: 'Lot 7', button: 'right' } }]);
    expect(d.issues.map((i) => i.code)).toContain('middle_click');
  });
});

describe('draftFromRecording: lists, menus, files', () => {
  const opt = (t: number, name: string, extra: Over = {}) => press(t, { target: { text: name }, in: 'listbox', role: 'option', name, ...extra });

  it('a select trigger and one option → select {field}; a search typed in the list → search', () => {
    const trigger = { target: { label: 'Bag size' }, role: 'combobox', label: 'Bag size', in: 'dialog' as const, action: { kind: 'select' as const, field: 'Bag size' } };
    const d = draft(rec(start(), press(400, trigger), opt(800, '5 kg', { text: '5 kg€36.40 / kg' }), press(1200, trigger), typing(1500, { target: { role: 'searchbox' }, in: 'listbox' }, { text: 'Who' }), opt(1900, 'Whole bean'), stop(2500)));
    expect(d.steps).toEqual([{ select: { field: 'Bag size', option: '5 kg' } }, { select: { field: 'Bag size', option: 'Whole bean', search: 'Who' } }]);
  });

  it('a list trigger and several options → pick, closed by a press outside (absorbed), by Escape, or not at all', () => {
    const trigger = { target: { role: 'button', name: 'Bag sizes' }, label: 'Bag sizes', role: 'button', in: 'dialog' as const };
    const outside = press(1500, { target: null, matches: 0, role: 'dialog', in: 'dialog', desc: 'dialog "Edit"', action: { verified: false } });
    const d = draft(rec(start(), press(400, trigger), opt(800, '1 kg'), opt(1100, '5 kg'), outside, press(2000, { target: { text: 'Save' }, in: 'dialog' }), stop(2500)));
    expect(d.steps).toEqual([{ pick: { field: 'Bag sizes', option: ['1 kg', '5 kg'], close: 'outside' } }, { click: 'Save' }]);
    const esc = draft(rec(start(), press(400, trigger), opt(800, '1 kg'), { kind: 'key', t: 1000, key: 'Escape', modifiers: [], el: null }, stop(2500)));
    expect(esc.steps).toEqual([{ pick: { field: 'Bag sizes', option: '1 kg', close: 'escape' } }]);
    const none = draft(rec(start(), press(400, trigger), opt(800, '1 kg'), opt(900, '20 kg'), stop(2500)));
    expect(none.steps).toEqual([{ pick: { field: 'Bag sizes', option: ['1 kg', '20 kg'], close: 'none' } }]);
    // One option, the list closed by itself: a select on the trigger.
    const one = draft(rec(start(), press(400, { ...trigger, label: null }), opt(800, 'Espresso'), press(1500, { target: { text: 'Save' } }), stop(2500)));
    expect(one.steps).toEqual([{ select: { combobox: { role: 'button', name: 'Bag sizes' }, option: 'Espresso' } }, { click: 'Save' }]);
  });

  it('a row menu → menu {row, item}, with the confirmation dialog\'s button as confirm; another dialog is not a confirm', () => {
    const trigger = (row: string) => ({ target: { role: 'button', name: 'Row actions', in: { row } }, in: 'row' as const, action: { kind: 'menu' as const, row } });
    const item = (t: number, name: string) => press(t, { target: { text: name }, in: 'menu', role: 'menuitem', name, appeared: true });
    const dialogButton = (t: number, name: string) => press(t, { target: { text: name }, in: 'dialog', role: 'button', name, appeared: true });
    const d = draft(rec(start(), press(400, trigger('Iceland')), item(800, 'Pause'), dialogButton(1200, 'Pause'), press(1600, trigger('Sweden')), item(2000, 'Edit'), press(2500, { target: { role: 'button', name: 'Bag sizes' }, in: 'dialog', role: 'button', name: 'Bag sizes', appeared: true }), stop(3000)));
    expect(d.steps).toEqual([{ menu: { row: 'Iceland', item: 'Pause', confirm: 'Pause' } }, { menu: { row: 'Sweden', item: 'Edit' } }, { click: { role: 'button', name: 'Bag sizes' } }]);
  });

  it('a file zone and the file chosen → drop_file (a placeholder named like it); a zone pressed without a file is dropped', () => {
    const zone = { target: { text: 'Drop your price list here' }, action: { kind: 'drop_file' as const } };
    const d = draft(rec(start(), press(400, zone), { kind: 'file', t: 600, el: elOf(zone), via: 'input', names: ['prices.csv'] }, press(900, zone), press(1400, { target: { text: 'Start import' } }), stop(2000)));
    expect(d.steps).toEqual([{ drop_file: { zone: 'Drop your price list here', name: 'prices.csv', fake: true } }, { click: 'Start import' }]);
    expect(d.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['fake_file', 'file_cancelled']));
  });

  it('a native select → select {combobox}; the press that opened it is folded in', () => {
    const s = { target: { label: 'Roast level' }, tag: 'select' };
    const d = draft(rec(start(), press(400, s), { kind: 'select_native', t: 900, el: elOf(s), option: 'Dark' }, stop(1500)));
    expect(d.steps).toEqual([{ select: { combobox: { label: 'Roast level' }, option: 'Dark' } }]);
  });
});

describe('draftFromRecording: scrolls, waits, noise', () => {
  it('a scroll before a press → scroll to its target; jitter dropped; a trailing scroll → scroll by', () => {
    const scroll = (t: number, dy: number) => ({ kind: 'scroll', t, container: 'document', el: null, dx: 0, dy });
    const d = draft(rec(start(), scroll(300, 400), scroll(700, 260), press(1000, { target: { text: 'Fresh arrivals' } }), scroll(1200, 60), press(1400, { target: { text: 'Next' } }), scroll(1700, -300), stop(2500)));
    expect(d.steps).toEqual([{ scroll: { to: 'Fresh arrivals' } }, { click: 'Fresh arrivals' }, { click: 'Next' }, { scroll: { by: -300 } }]);
  });

  it('wait_for the next target when it appeared after a pause of 1.5 s or more — never for the first action after a load', () => {
    const d = draft(
      rec(
        start(),
        press(3000, { target: { text: 'Coffees' }, appeared: true }),
        nav(3050, '/products', 'spa'),
        press(6000, { target: { role: 'button', name: 'Request a quote' }, appeared: true }),
        press(6400, { target: { text: 'Increase' }, appeared: true }),
        press(7000, { target: { text: 'Later' }, appeared: false }),
        nav(7100, '/x', 'link'),
        press(9900, { target: { text: 'First after load' }, appeared: true }),
        stop(10_500),
      ),
    );
    expect(d.steps).toEqual([
      { click: 'Coffees' },
      { wait_for: { target: { role: 'button', name: 'Request a quote' }, timeout: 15 } },
      { click: { role: 'button', name: 'Request a quote' } },
      { click: 'Increase' },
      { click: 'Later' },
      { click: 'First after load' },
    ]);
    expect(d.yaml).not.toMatch(/^\s*- (wait|hold):/m);
  });

  it('no verified target: a fallback from the element\'s own text (warned); a container or a masked text is dropped', () => {
    const d = draft(
      rec(
        start(),
        press(400, { target: null, matches: 0, name: 'Selowa Ridge', in: 'listbox', desc: 'option "Selowa Ridge"', action: { verified: false } }),
        press(800, { target: null, matches: 0, role: 'dialog', name: 'A long dialog', desc: 'dialog', action: { verified: false } }),
        press(1200, { target: { text: 'pw ••• shown' }, name: 'pw ••• shown' }, { redacted: 1 }),
        stop(2000),
      ),
    );
    expect(d.steps).toEqual([{ click: { text: 'Selowa Ridge', in: 'listbox' } }]);
    expect(d.stats.fallbacks).toBe(1);
    expect(d.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['fallback_target', 'unresolved_press', 'secret_target']));
    for (const i of d.issues) expect(i.message).not.toContain('Selowa');
  });
});

describe('draftFromRecording: scenes, pages, writes', () => {
  it('scenes split where the page changed: an action → no open; the address bar → open (relative to the page, its typed query kept); ids unique', () => {
    const d = draft(
      rec(
        start('/'),
        press(400, { target: { text: 'Selowa Ridge' } }),
        nav(450, '/products/selowa-ridge', 'spa'),
        press(900, { target: { text: 'Request a quote' } }),
        nav(5000, '/products/kiambu', 'typed', { query: '?tab=lots' }),
        press(5600, { target: { text: 'Request a quote' } }),
        nav(5700, '/products/other', 'link'),
        press(6400, { target: { text: 'Back' } }),
        stop(7000),
      ),
    );
    expect(d.scenes.map((s) => [s.id, s.page, s.open])).toEqual([
      ['home', 'shop', '/'],
      ['products', undefined, undefined],
      ['products-2', undefined, '/products/kiambu?tab=lots'],
      ['products-3', undefined, undefined],
    ]);
    expect(d.issues.map((i) => i.code)).toContain('opened_by_address');
  });

  it('open paths are relative to the page\'s base path; a navigation right after an action is caused by it; env and persona written when not the defaults', () => {
    const d = draft(
      rec(
        { ...start('/admin/imports', 'console') },
        press(400, { target: { text: 'Import' } }),
        nav(900, '/admin/imports/1', 'typed', { page_key: 'console' }),
        press(1500, { target: { text: 'Done' } }),
        stop(2000),
      ),
      { env: 'signed-in', envIsDefault: false, defaultPersonas: { console: 'supplier', shop: 'buyer' }, persona: null },
    );
    expect(d.scenario.env).toBe('signed-in');
    expect(d.scenes.map((s) => [s.id, s.page, s.open, s.persona])).toEqual([
      ['imports', 'console', '/imports', 'none'],
      ['imports-2', undefined, undefined, undefined],
    ]);
  });

  it('a sign-in page or another site: nothing there is recorded, the issue says so, the way back opens its page', () => {
    const d = draft(
      rec(
        start('/'),
        press(400, { target: { text: 'Orders' } }),
        { kind: 'navigation', t: 500, path: '/sign-in', cause: 'link', same_document: false, where: 'sign_in', page_key: null },
        { kind: 'dropped', t: 900, reason: 'sign_in', count: 3 },
        { kind: 'navigation', t: 1500, path: '/orders', cause: 'form', same_document: false, where: 'environment', page_key: 'shop' },
        press(2000, { target: { text: 'Order 12' } }),
        stop(2500),
      ),
      { persona: 'buyer' },
    );
    expect(d.scenes.map((s) => [s.open, s.steps])).toEqual([
      ['/', [{ click: 'Orders' }]],
      ['/orders', [{ click: 'Order 12' }]],
    ]);
    expect(d.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['signed_out', 'dropped']));
  });

  it('writes: to the step that caused them (within 2 s) as a note, any host; the first step one followed bounds the check; ambient ones are not attributed', () => {
    const d = draft(
      rec(
        start('/'),
        { kind: 'write', t: 300, method: 'POST', label: 'POST shop:/api/notifications/read', outcome: 'passed' },
        press(4000, { target: { text: 'Next' } }),
        press(5000, { target: { text: 'Send request' } }),
        { kind: 'write', t: 5020, method: 'POST', label: 'POST shop:/api/quotes', outcome: 'passed' },
        { kind: 'write', t: 5030, method: 'POST', label: 'POST telemetry.example/collect', outcome: 'passed' },
        stop(6000),
      ),
    );
    expect(d.steps[1]).toEqual({ click: 'Send request', note: 'sends POST shop:/api/quotes; sends POST telemetry.example/collect' });
    expect(d.firstWrite).toEqual({ scene: 'home', step: 1 });
    expect(d.writes.map((w) => [w.label, w.step])).toEqual([
      ['POST shop:/api/notifications/read', null],
      ['POST shop:/api/quotes', 1],
      ['POST telemetry.example/collect', 1],
    ]);
    const guarded = draft(rec(start('/'), press(400, { target: { text: 'Send' } }), { kind: 'write', t: 420, method: 'POST', label: 'POST shop:/api/quotes', outcome: 'blocked' }, stop(900)), { access: 'read-only' });
    expect(guarded.steps[0].note).toBe('sends POST shop:/api/quotes (stopped: read-only)');
  });

  it('an app whose API is on another host: its write bounds the check (the step before it is the last replayed); so does a slow one; a stopped or mocked one does not', () => {
    const order = (t: number, outcome = 'passed', label = 'POST api.example.test/orders') => ({ kind: 'write', t, method: 'POST', label, outcome });
    const api = draft(rec(start('/'), press(400, { target: { text: 'Cart' } }), press(900, { target: { text: 'Place order' } }), order(950), press(1500, { target: { text: 'Done' } }), stop(2000)));
    expect(api.firstWrite).toEqual({ scene: 'home', step: 1 });
    expect(api.steps[1]).toEqual({ click: 'Place order', note: 'sends POST api.example.test/orders' });
    // An answer that came 3 s after the press: not its note (ambient), but the check still stops before the press.
    const slow = draft(rec(start('/'), press(400, { target: { text: 'Cart' } }), press(900, { target: { text: 'Place order' } }), order(3900), press(4500, { target: { text: 'Done' } }), stop(5000)));
    expect(slow.firstWrite).toEqual({ scene: 'home', step: 1 });
    expect(slow.issues.find((i) => i.code === 'ambient_write')).toMatchObject({ scene: 'home', step: 2 });
    // Before the first step (the page's own load): nothing to stop before.
    expect(draft(rec(start('/'), order(100), press(400, { target: { text: 'Cart' } }), stop(900))).firstWrite).toBeNull();
    // Stopped or answered by a mock (read-only): never sent, so the whole draft replays.
    const ro = draft(rec(start('/'), press(400, { target: { text: 'Place order' } }), order(420, 'blocked'), order(430, 'mocked'), stop(900)), { access: 'read-only' });
    expect(ro.firstWrite).toBeNull();
    const through = draft(rec(start('/'), press(400, { target: { text: 'Cart' } }), press(800, { target: { text: 'Place order' } }), order(820, 'passed'), stop(900)), { access: 'read-only' });
    expect(through.firstWrite).toEqual({ scene: 'home', step: 1 });
  });

  it('a page address with a token or an e-mail masked: `open:` keeps the mask and a warning asks for a demo value', () => {
    const d = draft(rec(start('/'), press(400, { target: { text: 'Next' } }), nav(5000, '/reset/•••', 'typed'), press(5600, { target: { text: 'Set password' } }), stop(6000)));
    expect(d.scenes[1].open).toBe('/reset/•••');
    expect(d.issues.find((i) => i.code === 'secret_path')).toMatchObject({ severity: 'warning', scene: d.scenes[1].id, step: 0 });
  });

  it('no secret ever reaches the draft: a sentinel in every string of secret events is absent', () => {
    const sentinel = 'S3ntinel-QX9';
    const events = rec(start(), typing(500, { target: { label: 'Password' }, secret: true }, { secret: true, field_kind: 'password', text: undefined }), stop(900));
    // The schema refuses a secret event with its text: the generator never sees one.
    expect(RecordedEventSchema.safeParse({ ...events[1], text: sentinel }).success).toBe(false);
    const d = draft(events);
    expect(JSON.stringify(d)).not.toContain(sentinel);
  });
});

describe('draftFromRecording: recorded templates, issue positions', () => {
  it('a recorded string holding {{…}} never reaches the draft: typed text, a button\'s name, an option, a field — left out, each with an issue at its place', () => {
    const msg = { target: { label: 'Message' }, action: { kind: 'type' as const } };
    const d = draft(
      rec(
        start('/'),
        press(400, msg),
        typing(800, msg, { text: 'Hi {{first_name}}, see {{env:HOME}}' }),
        press(1200, { target: { text: '{{vars.x}}' }, name: '{{vars.x}}', text: '{{vars.x}}' }),
        press(1600, { target: { text: 'Roast' }, tag: 'select' }),
        { kind: 'select_native', t: 1700, el: elOf({ target: { text: 'Roast' }, tag: 'select' }), option: '{{env:SECRET}}' },
        typing(2000, { target: { label: '{{vars.field}}' }, label: '{{vars.field}}' }, { text: 'plain' }),
        press(2400, { target: { text: 'Save' } }),
        // A search typed in a list: the whole choice goes.
        press(2600, { target: { label: 'Bag size' }, role: 'combobox', label: 'Bag size', action: { kind: 'select', field: 'Bag size' } }),
        typing(2700, { target: { role: 'searchbox' }, in: 'listbox' }, { text: '{{vars.size}}' }),
        press(2800, { target: { text: '5 kg' }, in: 'listbox', role: 'option', name: '5 kg' }),
        stop(3000),
      ),
    );
    expect(d.yaml.replace(/\{\{vars\.\w+_\d+\}\}/g, '')).not.toContain('{{');
    // The click that focused the field stays (only the typing goes); the plain text typed into a templated field has no `into`.
    expect(d.steps).toEqual([{ click: { label: 'Message' } }, { click: 'Roast' }, { type: { text: 'plain' } }, { click: 'Save' }]);
    const t = d.issues.filter((i) => i.code === 'template_text');
    expect(t.map((i) => [i.scene, i.step])).toEqual([
      ['home', 1],
      ['home', 1],
      ['home', 2],
      ['home', 4],
    ]);
    for (const i of d.issues) expect(i.message).not.toMatch(/first_name|env:HOME|vars\.x|SECRET/);
  });

  it('every issue says where (scene and step, the next step for what happened between steps), in the order it was raised; a press folded into its typing keeps its issue', () => {
    const f = { target: { label: 'Note' }, fragile: ['nth' as const], action: { kind: 'type' as const } };
    const d = draft(
      rec(
        start('/'),
        press(400, { target: { text: 'Save' } }),
        press(800, { target: null, matches: 0, role: 'region', name: '', text: '', desc: 'region', action: { verified: false } }),
        { kind: 'new_page', t: 900 },
        { kind: 'dropped', t: 950, reason: 'sign_in', count: 2 },
        press(1200, f),
        typing(1500, f, { text: 'Two bags' }),
        press(1800, { target: { text: 'Next' } }, { button: 'middle' }),
        { kind: 'write', t: 4500, method: 'POST', label: 'POST shop:/api/poll', outcome: 'passed' },
        nav(5000, '/orders', 'typed'),
        press(5500, { target: { text: 'Order 12' } }),
        { kind: 'stop', t: 6000, reason: 'max_duration' },
      ),
    );
    expect(d.steps).toEqual([{ click: 'Save' }, { type: { into: { label: 'Note' }, text: 'Two bags' } }, { click: 'Order 12' }]);
    expect(d.issues.map((i) => [i.code, i.scene, i.step])).toEqual([
      ['unresolved_press', 'home', 1],
      ['new_page', 'home', 1],
      ['dropped', 'home', 1],
      ['fragile_target', 'home', 1],
      ['middle_click', 'home', 2],
      ['ambient_write', 'home', 2],
      ['opened_by_address', 'orders', 0],
      ['max_duration', 'orders', 1],
    ]);
  });

  it('a validation error of a draft: a fixed message with its line, scene and step from its path — never the validator\'s text', () => {
    const x = { severity: 'error' as const, path: ['scenes', 1, 'steps', 3, 'click'], message: 'unknown target "Secret Lot"', line: 12 };
    expect(draftInvalidIssue(x, ['home', 'products'], 'the draft does not validate in the project')).toEqual({
      severity: 'error',
      code: 'invalid',
      message: 'the draft does not validate in the project (line 12): run validate on the draft to see why',
      scene: 'products',
      step: 3,
    });
    expect(draftInvalidIssue({ path: ['vars'], message: 'x' }, ['home'], 'w')).toEqual({ severity: 'error', code: 'invalid', message: 'w: run validate on the draft to see why' });
  });
});

// ── Studio annotations (L4.8): target picks and quick inserts, applied by the generator ─────────────────────────────

/** Annotations from choices and inserts (ids i1, i2… in order). */
function ann(choices: Record<number, number>, ...inserts: Array<Record<string, unknown> & { after_seq: number; kind: string }>): RecordAnnotations {
  return {
    v: 1,
    rev: inserts.length + Object.keys(choices).length,
    choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, v])),
    inserts: inserts.map((x, k) => ({ id: `i${k + 1}`, ...x }) as RecordInsert),
  };
}
const alts = (...targets: Array<Record<string, unknown>>) => targets.map((target) => ({ target, fragile: [] as Array<'broader'> }));

describe('draftFromRecording: target picks (L4.8)', () => {
  const field = { target: { label: 'Customer' }, label: 'Customer', role: 'textbox', action: { kind: 'type' as const }, alternatives: alts({ placeholder: 'Acme Ltd' }, { testid: 'customer' }) };
  const events = rec(start(), press(500, field), typing(900, field, { text: 'Acme' }), press(1300, { target: { text: 'Save' } }), stop(2000));

  it('the offered alternatives: masked, templated, position-dependent or the same as the suggestion never; none for a secret field', () => {
    const el = elOf({ target: { label: 'Customer' }, alternatives: alts({ placeholder: 'Acme Ltd' }, { text: 'pw •••' }, { label: 'Customer' }) });
    expect(recordedAlternatives(el)).toEqual([{ index: 1, target: { placeholder: 'Acme Ltd' }, fragile: [] }]);
    expect(recordedAlternatives({ ...el, alternatives: alts({ text: '{{vars.x}}' }) })).toEqual([]);
    expect(recordedAlternatives({ ...el, secret: true })).toEqual([]);
    expect(recordedAlternatives({ ...el, target: null })).toEqual([]);
    // The schema itself: at most three, never `nth` / `last_visible`, never the `nth` flag.
    const ev = (x: unknown) => RecordedEventSchema.safeParse({ seq: 1, t: 1, page: 'p1', path: '/', kind: 'pointer', button: 'left', via: 'pointer', el: { ...el, alternatives: x }, quiet_ms: 1, ms: 1 }).success;
    expect(ev(alts({ text: 'A' }, { text: 'B' }, { text: 'C' }))).toBe(true);
    expect(ev(alts({ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }))).toBe(false);
    expect(ev(alts({ text: 'A', nth: 1 }))).toBe(false);
    expect(ev(alts({ text: 'A', last_visible: true }))).toBe(false);
    expect(ev([{ target: { text: 'A' }, fragile: ['nth'] }])).toBe(false);
  });

  it('a pick on the press before the typing arrives, then the typing: still one step, the pick follows into `type {into}`', () => {
    // While recording: only the press so far (seq 1) — a click step, and the person picks its first alternative.
    const live = draft(events.slice(0, 2), {}, ann({ 1: 1 }));
    expect(live.steps).toEqual([{ click: { placeholder: 'Acme Ltd' } }]);
    expect(live.sources).toEqual([{ scene: 'home', step: 0, seqs: [1, 1], role: 'action', row: 'a1', target_seqs: [1], target_seq: 1, chosen: { seq: 1, index: 1 } }]);
    // The typing arrives (seq 2): the fold compared the recorded targets, so the click is still the type's `into`.
    const d = draft(events, {}, ann({ 1: 1 }));
    expect(d.steps).toEqual([{ type: { into: { placeholder: 'Acme Ltd' }, text: 'Acme' } }, { click: 'Save' }]);
    expect(d.sources[0]).toEqual({ scene: 'home', step: 0, seqs: [1, 2], role: 'action', row: 'a1', target_seqs: [1, 2], target_seq: 2, chosen: { seq: 1, index: 1 } });
    // A pick on the typing; then on both (the latest event wins); an explicit 0 on the latest gives the suggestion back.
    expect(draft(events, {}, ann({ 2: 2 })).steps[0]).toEqual({ type: { into: { testid: 'customer' }, text: 'Acme' } });
    expect(draft(events, {}, ann({ 1: 1, 2: 2 })).steps[0]).toEqual({ type: { into: { testid: 'customer' }, text: 'Acme' } });
    const back = draft(events, {}, ann({ 1: 1, 2: 0 }));
    expect(back.steps[0]).toEqual({ type: { into: { label: 'Customer' }, text: 'Acme' } });
    expect(back.sources[0].chosen).toEqual({ seq: 2, index: 0 });
    // A choice that names no offered alternative is ignored (the recorder's target stays).
    expect(draft(events, {}, ann({ 2: 3 })).steps[0]).toEqual({ type: { into: { label: 'Customer' }, text: 'Acme' } });
  });

  it('the recorder\'s own wait_for and scroll before the action follow the pick; a right click keeps its button; a select combobox and a file zone take one', () => {
    const late = { ...field, appeared: true };
    const scroll = { kind: 'scroll', t: 2600, container: 'document', el: null, dx: 0, dy: 600 };
    const ev = rec(start(), press(400, { target: { text: 'New quote' } }), scroll, press(3000, late), typing(3400, late, { text: 'Acme' }), stop(4000));
    const plain = draft(ev);
    expect(plain.steps.slice(1, 3)).toEqual([{ wait_for: { target: { label: 'Customer' }, timeout: 15 } }, { scroll: { to: { label: 'Customer' } } }]);
    const d = draft(ev, {}, ann({ 3: 2 }));
    expect(d.steps.slice(1)).toEqual([{ wait_for: { target: { testid: 'customer' }, timeout: 15 } }, { scroll: { to: { testid: 'customer' } } }, { type: { into: { testid: 'customer' }, text: 'Acme' } }]);
    expect(d.sources.slice(1).map((x) => x.role)).toEqual(['helper', 'helper', 'action']);
    expect(d.sources[1]).toEqual({ scene: 'home', step: 1, seqs: [3, 3], role: 'helper', helper: 'wait', row: 'w3' });
    expect(d.sources[2].seqs).toEqual([2, 2]);

    const right = draft(rec(start(), press(400, { target: { text: 'Lot 7' }, alternatives: alts({ testid: 'lot-7' }) }, { button: 'right' }), stop(900)), {}, ann({ 1: 1 }));
    expect(right.steps).toEqual([{ click: { testid: 'lot-7', button: 'right' } }]);
    const sel = { target: { label: 'Roast level' }, tag: 'select', alternatives: alts({ testid: 'roast' }) };
    expect(draft(rec(start(), press(400, sel), { kind: 'select_native', t: 900, el: elOf(sel), option: 'Dark' }, stop(1500)), {}, ann({ 2: 1 })).steps).toEqual([{ select: { combobox: { testid: 'roast' }, option: 'Dark' } }]);
    const zone = { target: { text: 'Drop your price list here' }, action: { kind: 'drop_file' as const }, alternatives: alts({ testid: 'drop' }) };
    expect(draft(rec(start(), press(400, zone), { kind: 'file', t: 600, el: elOf(zone), via: 'input', names: ['prices.csv'] }, stop(1000)), {}, ann({ 1: 1 })).steps).toEqual([{ drop_file: { zone: { testid: 'drop' }, name: 'prices.csv', fake: true } }]);
  });

  it('no pick where the step\'s target is not the element\'s target: a list pick (its label), a select by field, a row menu, a guessed target', () => {
    const trigger = { target: { role: 'button', name: 'Bag sizes' }, label: 'Bag sizes', role: 'button', in: 'dialog' as const, alternatives: alts({ testid: 'bags' }) };
    const opt = (t: number, name: string) => press(t, { target: { text: name }, in: 'listbox', role: 'option', name });
    const d = draft(rec(start(), press(400, trigger), opt(800, '1 kg'), opt(1100, '5 kg'), stop(2500)), {}, ann({ 1: 1 }));
    expect(d.steps).toEqual([{ pick: { field: 'Bag sizes', option: ['1 kg', '5 kg'], close: 'none' } }]);
    expect(d.sources[0]).toEqual({ scene: 'home', step: 0, seqs: [1, 3], role: 'action', row: 'a1' });
    const guessed = draft(rec(start(), press(400, { target: null, matches: 0, name: 'Selowa Ridge', in: 'listbox', desc: 'option', action: { verified: false }, alternatives: alts({ testid: 'x' }) }), stop(900)), {}, ann({ 1: 1 }));
    expect(guessed.steps).toEqual([{ click: { text: 'Selowa Ridge', in: 'listbox' } }]);
    expect(guessed.sources[0].target_seqs).toBeUndefined();
  });
});

describe('draftFromRecording: quick inserts (L4.8)', () => {
  const field = { target: { label: 'Note' }, label: 'Note', action: { kind: 'type' as const } };
  // 1 press A · 2 press the field · 3 typing · 4 press Save
  const events = rec(start(), press(400, { target: { text: 'New quote' } }), press(800, field), typing(1200, field, { text: 'Two bags' }), press(1600, { target: { text: 'Save' } }), stop(2000));

  it('each kind: hold and wait_for become steps before the next action, caption / mark / camera go on it', () => {
    const d = draft(
      events,
      {},
      ann(
        {},
        { after_seq: 1, kind: 'hold', seconds: 2 },
        { after_seq: 1, kind: 'wait_for', until: 'idle' },
        { after_seq: 1, kind: 'wait_for', until: 'text', text: 'Quote 12' },
        { after_seq: 3, kind: 'caption', text: 'Save the quote', kicker: 'Step 2' },
        { after_seq: 3, kind: 'mark', name: 'm1' },
        { after_seq: 3, kind: 'camera', zoom: 1.5, until: 'scene_end' },
        { after_seq: 3, kind: 'wait_for', until: 'next_target' },
      ),
    );
    expect(d.steps).toEqual([
      { click: 'New quote' },
      { hold: 2 },
      { wait_for: { network_idle: true } },
      { wait_for: { text: 'Quote 12' } },
      { type: { into: { label: 'Note' }, text: 'Two bags' } },
      { wait_for: { target: 'Save' } },
      { click: 'Save', caption: { kicker: 'Step 2', text: 'Save the quote' }, mark: 'm1', camera: { zoom: 1.5, until: 'scene_end' } },
    ]);
    expect(d.sources.map((x) => [x.role, x.insert ?? null, x.modifiers ?? null])).toEqual([
      ['action', null, null],
      ['insert', 'i1', null],
      ['insert', 'i2', null],
      ['insert', 'i3', null],
      ['action', null, null],
      ['insert', 'i7', null],
      ['action', null, ['i4', 'i5', 'i6']],
    ]);
    expect(d.yaml).toContain('arranged in the Studio');
    expect(d.yaml).toContain('- hold: 2');
  });

  it('the next action is the first whose LATEST event is after the position: an insert made between the press on a field and its typing goes on the typing', () => {
    const d = draft(events, {}, ann({}, { after_seq: 2, kind: 'caption', text: 'Type a note' }, { after_seq: 2, kind: 'hold', seconds: 1 }));
    expect(d.steps).toEqual([{ click: 'New quote' }, { hold: 1 }, { type: { into: { label: 'Note' }, text: 'Two bags' }, caption: 'Type a note' }, { click: 'Save' }]);
  });

  it('a step insert goes before the action\'s helpers, a modifier on the action — never on its wait_for or scroll', () => {
    const late = { ...field, appeared: true };
    const ev = rec(start(), press(400, { target: { text: 'New quote' } }), { kind: 'scroll', t: 2500, container: 'document', el: null, dx: 0, dy: 500 }, press(3000, late), typing(3400, late, { text: 'Hi' }), stop(4000));
    const d = draft(ev, {}, ann({}, { after_seq: 1, kind: 'hold', seconds: 2 }, { after_seq: 1, kind: 'caption', text: 'Now the note' }));
    expect(d.steps).toEqual([
      { click: 'New quote' },
      { hold: 2 },
      { wait_for: { target: { label: 'Note' }, timeout: 15 } },
      { scroll: { to: { label: 'Note' } } },
      { type: { into: { label: 'Note' }, text: 'Hi' }, caption: 'Now the note' },
    ]);
    // A wait for the next target replaces the recorder's own wait on that target (its timeout kept), and follows a pick.
    const w = draft(ev, {}, ann({}, { after_seq: 1, kind: 'wait_for', until: 'next_target' }));
    expect(w.steps.slice(1, 3)).toEqual([{ wait_for: { target: { label: 'Note' }, timeout: 15 } }, { scroll: { to: { label: 'Note' } } }]);
    expect(w.sources[1]).toMatchObject({ role: 'insert', insert: 'i1' });
    expect(w.issues.find((i) => i.code === 'insert_replaced')).toMatchObject({ severity: 'info', scene: 'home', step: 1 });
    const picked = rec(start(), press(400, { target: { text: 'New quote' } }), press(3000, { ...late, alternatives: alts({ testid: 'note' }) }), stop(4000));
    expect(draft(picked, {}, ann({ 2: 1 }, { after_seq: 1, kind: 'wait_for', until: 'next_target' })).steps.slice(1)).toEqual([{ wait_for: { target: { testid: 'note' }, timeout: 15 } }, { click: { testid: 'note' } }]);
  });

  it('after the last action: a step insert ends the scene current at its position — a new page\'s scene when made after a page change', () => {
    const ev = rec(start(), press(400, { target: { text: 'Coffees' } }), nav(500, '/products', 'link'), stop(3000));
    const d = draft(ev, {}, ann({}, { after_seq: 2, kind: 'hold', seconds: 3 }));
    expect(d.scenes.map((s) => [s.id, s.steps])).toEqual([
      ['home', [{ click: 'Coffees' }]],
      ['products', [{ hold: 3 }]],
    ]);
    const before = draft(ev, {}, ann({}, { after_seq: 1, kind: 'hold', seconds: 3 }));
    expect(before.scenes.map((s) => [s.id, s.steps])).toEqual([['home', [{ click: 'Coffees' }, { hold: 3 }]]]);
    // wait_for the next target with no next action: page idle, said so.
    const idle = draft(ev, {}, ann({}, { after_seq: 2, kind: 'wait_for', until: 'next_target' }));
    expect(idle.steps.at(-1)).toEqual({ wait_for: { network_idle: true } });
    expect(idle.issues.map((i) => i.code)).toContain('insert_wait_idle');
  });

  it('a caption with no action after it: pending while the recording goes on; on the last action once it is over (said so); nothing recorded → left out', () => {
    const open = events.slice(0, -1); // no stop yet
    const live = draft(open, {}, ann({}, { after_seq: 4, kind: 'caption', text: 'Done' }));
    expect(live.pending).toEqual(['i1']);
    expect(live.steps.at(-1)).toEqual({ click: 'Save' });
    const over = draft(events, {}, ann({}, { after_seq: 4, kind: 'caption', text: 'Done' }));
    expect(over.pending).toEqual([]);
    expect(over.steps.at(-1)).toEqual({ click: 'Save', caption: 'Done' });
    expect(over.issues.find((i) => i.code === 'insert_moved')).toMatchObject({ severity: 'info', scene: 'home', step: 2 });
    // `final` says so for a recording that ended without its stop event (the worker stopped).
    expect(draft(open, {}, ann({}, { after_seq: 4, kind: 'caption', text: 'Done' }), ).pending).toEqual(['i1']);
    expect(draftFromRecording(open, CTX, ann({}, { after_seq: 4, kind: 'caption', text: 'Done' }), { final: true }).pending).toEqual([]);
    const none = draftFromRecording(rec(start(), stop(500)), CTX, ann({}, { after_seq: 0, kind: 'mark', name: 'm1' }));
    expect(none.issues.find((i) => i.code === 'insert_unplaced')).toMatchObject({ severity: 'warning' });
    expect(none.yaml).not.toContain('mark');
  });

  it('two inserts of one kind on one step: the later wins, said so', () => {
    const d = draft(events, {}, ann({}, { after_seq: 3, kind: 'caption', text: 'First' }, { after_seq: 3, kind: 'caption', text: 'Second' }));
    expect(d.steps.at(-1)).toEqual({ click: 'Save', caption: 'Second' });
    expect(d.sources.at(-1)?.modifiers).toEqual(['i2']);
    expect(d.issues.find((i) => i.code === 'insert_replaced')).toMatchObject({ scene: 'home', step: 2 });
  });

  it('issue positions and the check bound count the inserted steps; writes are never attributed to an inserted step', () => {
    const ev = rec(start(), press(400, { target: { text: 'Cart' } }), press(900, { target: { text: 'Place order' } }), { kind: 'write', t: 950, method: 'POST', label: 'POST shop:/api/orders', outcome: 'passed' }, stop(2000));
    const d = draft(ev, {}, ann({}, { after_seq: 1, kind: 'hold', seconds: 2 }));
    expect(d.steps).toEqual([{ click: 'Cart' }, { hold: 2 }, { click: 'Place order', note: 'sends POST shop:/api/orders' }]);
    expect(d.firstWrite).toEqual({ scene: 'home', step: 2 });
    expect(d.writes[0]).toMatchObject({ scene: 'home', step: 2 });
  });
});

describe('draftFromRecording: typing split by a visit to the Studio (L4.8)', () => {
  const field = { target: { label: 'Message' }, action: { kind: 'type' as const } };
  const split = (second: Record<string, unknown>) => rec(start(), press(400, field), typing(900, field, { text: 'Two b' }), typing(5000, field, second), press(5600, { target: { text: 'Send' } }), stop(6000));

  it('two typing events on one field with nothing between them are one typing step', () => {
    const d = draft(split({ text: 'ags', enter: true }));
    expect(d.steps).toEqual([{ type: { into: { label: 'Message' }, text: 'Two bags', enter: true } }, { click: 'Send' }]);
    expect(d.sources[0]).toMatchObject({ seqs: [1, 3], target_seqs: [1, 2, 3] });
    expect(d.stats.actions).toBe(4);
  });

  it('not merged: an insert placed between them, an edit inside the field (clear), a first part committed by Enter, a template across the split, another action between', () => {
    const withInsert = draft(split({ text: 'ags' }), {}, ann({}, { after_seq: 2, kind: 'caption', text: 'Keep typing' }));
    expect(withInsert.steps).toEqual([{ type: { into: { label: 'Message' }, text: 'Two b' } }, { type: { into: { label: 'Message' }, text: 'ags' }, caption: 'Keep typing' }, { click: 'Send' }]);
    expect(draft(split({ text: 'Two bags', clear: true })).steps).toHaveLength(3);
    expect(draft(rec(start(), press(400, field), typing(900, field, { text: 'Two b', enter: true }), typing(5000, field, { text: 'ags' }), stop(6000))).steps).toHaveLength(2);
    const templ = draft(rec(start(), press(400, field), typing(900, field, { text: 'Hi {' }), typing(5000, field, { text: '{vars.x}}' }), stop(6000)));
    expect(templ.steps).toEqual([{ type: { into: { label: 'Message' }, text: 'Hi {' } }, { type: { into: { label: 'Message' }, text: '{vars.x}}' } }]);
    expect(draft(rec(start(), press(400, field), typing(900, field, { text: 'a' }), { kind: 'key', t: 950, key: 'Escape', modifiers: [], el: null }, typing(5000, field, { text: 'b' }), stop(6000))).steps).toHaveLength(3);
  });
});

describe('draftFromRecording: placeholders (L4.8)', () => {
  it('each secret placeholder with its kind and step, never a value; a project var of that name is said so', () => {
    const pw = { target: { label: 'Password' }, secret: true };
    const d = draft(rec(start(), press(300, { target: { text: 'Sign up' } }), typing(500, pw, { secret: true, field_kind: 'password', text: undefined }), typing(900, { target: { label: 'API token' }, secret: true }, { secret: true, field_kind: 'api_key', text: undefined }), stop(2000)), { projectVars: { api_key_1: 'demo-token' } });
    expect(d.placeholders).toEqual([
      { name: 'password_1', kind: 'password', project_var: false, scene: 'home', step: 1 },
      { name: 'api_key_1', kind: 'api_key', project_var: true, scene: 'home', step: 2 },
    ]);
  });
});

// ── After the reviews of L4.8 ──────────────────────────────────────────────────────────────────────────────────────────

/** Hidden characters, made at run time (never typed raw into this file). */
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LSEP = String.fromCharCode(0x2028);

describe('draftFromRecording: hidden characters never reach a draft (review A-M3)', () => {
  it('a press on a name holding a direction control, typed text with a zero-width or line-separator character, a choice with one: left out, said so, never quoted', () => {
    const cancel = `Cancel${RLO}lecnac`;
    const field = { target: { label: 'Note' }, label: 'Note', action: { kind: 'type' as const } };
    const roast = { target: { label: 'Roast level' }, tag: 'select' };
    const d = draft(
      rec(
        start(),
        press(300, { target: { text: cancel }, name: cancel, text: cancel }),
        press(600, field),
        typing(900, field, { text: `a${ZWSP}b` }),
        press(1200, { target: { text: 'Save' } }),
        typing(1500, { target: { label: 'Other' } }, { text: `one${LSEP}two` }),
        { kind: 'select_native', t: 1800, el: elOf(roast), option: `Dark${RLO}` },
        stop(2500),
      ),
    );
    expect(firstHiddenChar(d.yaml)).toBeUndefined();
    expect(d.steps).toEqual([{ click: { label: 'Note' } }, { click: 'Save' }]);
    const hidden = d.issues.filter((i) => i.code === 'hidden_text');
    expect(hidden).toHaveLength(4);
    for (const i of hidden) {
      expect(i.severity).toBe('warning');
      expect(firstHiddenChar(i.message)).toBeUndefined();
      expect(i.message).not.toMatch(/Cancel|lecnac|Dark/);
    }
    // A target that is guessed from a hidden name is never one either; an alternative holding one is never offered.
    const guessed = draft(rec(start(), press(300, { target: null, matches: 0, name: cancel, text: cancel, action: { verified: false } }), press(600, { target: { text: 'Save' } }), stop(900)));
    expect(guessed.steps).toEqual([{ click: 'Save' }]);
    expect(guessed.issues.map((i) => i.code)).toContain('hidden_text');
    const el = elOf({ target: { label: 'Customer' }, alternatives: alts({ testid: `ok${ZWSP}` }, { placeholder: 'Acme Ltd' }) });
    expect(recordedAlternatives(el)).toEqual([{ index: 2, target: { placeholder: 'Acme Ltd' }, fragile: [] }]);
    // Wherever a step would hold one — here a list's field name — the step is left out.
    const trigger = { target: { label: 'Bag size' }, role: 'combobox', label: 'Bag size', in: 'dialog' as const, action: { kind: 'select' as const, field: `Bag${RLO} size` } };
    const option = press(800, { target: { text: '5 kg' }, in: 'listbox', role: 'option', name: '5 kg' });
    const listed = draft(rec(start(), press(400, trigger), option, press(1200, { target: { text: 'Save' } }), stop(2000)));
    expect(listed.steps).toEqual([{ click: 'Save' }]);
    expect(listed.issues.map((i) => i.code)).toContain('hidden_text');
    // A text without one is unchanged (a line break in a multi-line field stays).
    expect(draft(rec(start(), press(600, field), typing(900, field, { text: 'line one\nline two', field_kind: 'multiline' }), stop(1500))).steps).toEqual([{ type: { into: { label: 'Note' }, text: 'line one\nline two' } }]);
  });
});

describe('draftFromRecording: inserts placed after the row they were made on (review B-H1)', () => {
  const far = { target: { text: 'Far away' } };
  // 1 press A · 2 scroll · 3 press B (the scroll leads to it)
  const scrolled = rec(start(), press(400, { target: { text: 'Coffees' } }), { kind: 'scroll', t: 1500, container: 'document', el: null, dx: 0, dy: 900 }, press(2500, far), stop(3000));
  const late = { target: { text: 'Delayed control' }, appeared: true };
  // 1 press A · 2 press the late button after a pause (the recorder's wait before it)
  const waited = rec(start(), press(400, { target: { text: 'Unlock the last step' } }), press(3000, late), stop(3500));
  const hold = (after_seq: number, extra: Record<string, unknown> = {}) => ({ after_seq, kind: 'hold', seconds: 2, ...extra });

  it('rows have stable identities: a<first seq> an action, s<first seq> the recorder\'s scroll, w<seq> its wait, i:<id> an insert', () => {
    expect(draft(scrolled).sources.map((x) => [x.row, x.role, x.helper ?? null])).toEqual([
      ['a1', 'action', null],
      ['s2', 'helper', 'scroll'],
      ['a3', 'action', null],
    ]);
    expect(draft(waited, {}, ann({}, hold(1))).sources.map((x) => [x.row, x.role, x.helper ?? null])).toEqual([
      ['a1', 'action', null],
      ['i:i1', 'insert', null],
      ['w2', 'helper', 'wait'],
      ['a2', 'action', null],
    ]);
  });

  it('after the recorder\'s scroll row (or "at the end" right after scrolling): between the scroll and its action; after an action: before the next one\'s scroll', () => {
    const afterScroll = [{ click: 'Coffees' }, { scroll: { to: 'Far away' } }, { hold: 2 }, { click: 'Far away' }];
    expect(draft(scrolled, {}, ann({}, hold(2))).steps).toEqual(afterScroll);
    // The same insert made live, before the press that followed the scroll: the draft keeps it after the scroll.
    expect(draft(scrolled.slice(0, 3), {}, ann({}, hold(2))).steps).toEqual([{ click: 'Coffees' }, { scroll: { by: 900 } }, { hold: 2 }]);
    expect(draftFromRecording(scrolled, CTX, ann({}, hold(2))).sources.map((x) => x.row)).toEqual(['a1', 's2', 'i:i1', 'a3']);
    expect(draft(scrolled, {}, ann({}, hold(1))).steps).toEqual([{ click: 'Coffees' }, { hold: 2 }, { scroll: { to: 'Far away' } }, { click: 'Far away' }]);
  });

  it('after the recorder\'s wait row (`row: wait`): between the wait and its action — a caption made there goes on that action', () => {
    const d = draft(waited, {}, ann({}, hold(2, { row: 'wait' }), { after_seq: 2, row: 'wait', kind: 'caption', text: 'Here it is' }));
    expect(d.steps).toEqual([{ click: 'Unlock the last step' }, { wait_for: { target: 'Delayed control', timeout: 15 } }, { hold: 2 }, { click: 'Delayed control', caption: 'Here it is' }]);
    // Right after the wait, also when the recorder's scroll follows it (wait, scroll, action).
    const both = rec(start(), press(400, { target: { text: 'Unlock the last step' } }), { kind: 'scroll', t: 2000, container: 'document', el: null, dx: 0, dy: 700 }, press(3000, late), stop(3500));
    expect(draft(both, {}, ann({}, hold(3, { row: 'wait' }))).steps).toEqual([
      { click: 'Unlock the last step' },
      { wait_for: { target: 'Delayed control', timeout: 15 } },
      { hold: 2 },
      { scroll: { to: 'Delayed control' } },
      { click: 'Delayed control' },
    ]);
    // Without the row (the old placement by position alone) the hold would follow the action.
    expect(draft(waited, {}, ann({}, hold(2))).steps.at(-1)).toEqual({ hold: 2 });
    // The wait gone (an insert replaced it): before the action still.
    const replaced = draft(waited, {}, ann({}, { after_seq: 1, kind: 'wait_for', until: 'next_target' }, hold(2, { row: 'wait' })));
    expect(replaced.steps).toEqual([{ click: 'Unlock the last step' }, { wait_for: { target: 'Delayed control', timeout: 15 } }, { hold: 2 }, { click: 'Delayed control' }]);
  });

  it('after an insert row (`after_insert`): right after it, even between two inserts; once it is removed, where it was', () => {
    const d = draft(scrolled, {}, ann({}, { ...hold(1), seconds: 1 }, { ...hold(1), seconds: 2 }, { ...hold(1, { after_insert: 'i1' }), seconds: 3 }));
    expect(d.steps.slice(0, 4)).toEqual([{ click: 'Coffees' }, { hold: 1 }, { hold: 3 }, { hold: 2 }]);
    const gone: RecordAnnotations = { v: 1, rev: 4, choices: {}, inserts: [{ id: 'i2', after_seq: 1, kind: 'hold', seconds: 2 }, { id: 'i3', after_seq: 1, after_insert: 'i1', kind: 'hold', seconds: 3 }] };
    expect(draft(scrolled, {}, gone).steps.slice(0, 3)).toEqual([{ click: 'Coffees' }, { hold: 2 }, { hold: 3 }]);
  });
});

describe('draftFromRecording: a wait for the next target before a select by field (review B-L3)', () => {
  it('waits for the field by its label (never the page idle)', () => {
    const trigger = { target: { label: 'Bag size' }, role: 'combobox', label: 'Bag size', in: 'dialog' as const, action: { kind: 'select' as const, field: 'Bag size' } };
    const ev = rec(start(), press(300, { target: { text: 'Order' } }), press(400, trigger), press(800, { target: { text: '5 kg' }, in: 'listbox', role: 'option', name: '5 kg' }), stop(2500));
    const d = draft(ev, {}, ann({}, { after_seq: 1, kind: 'wait_for', until: 'next_target' }));
    expect(d.steps).toEqual([{ click: 'Order' }, { wait_for: { target: { label: 'Bag size' } } }, { select: { field: 'Bag size', option: '5 kg' } }]);
    expect(d.issues.map((i) => i.code)).not.toContain('insert_wait_idle');
  });
});

describe('draftFromRecording: a Studio draft has no YAML alias (review B-M2)', () => {
  it('`aliases: false`: a target shared by the recorder\'s wait, its scroll and its action is written each time; the block editor can delete or duplicate the helper', () => {
    const late = { target: { label: 'Customer' }, label: 'Customer', role: 'textbox', appeared: true, action: { kind: 'type' as const } };
    const ev = rec(start(), press(400, { target: { text: 'New quote' } }), { kind: 'scroll', t: 2600, container: 'document', el: null, dx: 0, dy: 600 }, press(3000, late), typing(3400, late, { text: 'Acme' }), stop(4000));
    // The recorder's own draft (CLI / MCP) is unchanged: L3.4 wrote the shared target once, with an alias.
    expect(draft(ev).yaml).toMatch(/&a1/);
    const studio = draftFromRecording(ev, CTX, null, { aliases: false });
    expect(studio.yaml).not.toMatch(/[&*]a\d/);
    expect(parseScenario(studio.yaml).scenario).toEqual(parseScenario(draft(ev).yaml).scenario);
    const { scenario } = parseScenario(studio.yaml);
    const steps = (scenario as unknown as { scenes: Array<{ steps: unknown[] }> }).scenes[0].steps;
    for (const [kind, index] of [
      ['delete_step', 1],
      ['delete_step', 2],
      ['duplicate_step', 2],
    ] as const) {
      const r = applyStepEdit(studio.yaml, { kind, at: { scene: 'home', index, guard: stepGuard(steps[index] as never) } } as never);
      expect(parseScenario(r.text).issues.filter((i) => i.severity === 'error'), `${kind} ${index}`).toEqual([]);
    }
  });
});

describe('draftFromRecording: more of the typing merge (review A-L2, A-N6, B-L6)', () => {
  const field = { target: { label: 'Message' }, action: { kind: 'type' as const } };
  const pw = { target: { label: 'Password' }, secret: true, action: { kind: 'type' as const } };
  const secretPart = (t: number) => typing(t, pw, { secret: true, field_kind: 'password', text: undefined });

  it('a secret typing split by a blur stays one placeholder (never a second one that appends)', () => {
    const d = draft(rec(start(), press(400, pw), secretPart(900), secretPart(5000), press(5600, { target: { text: 'Sign in' } }), stop(6000)));
    expect(d.steps).toEqual([{ type: { into: { label: 'Password' }, text: '{{vars.password_1}}' } }, { click: 'Sign in' }]);
    expect(d.placeholders.map((x) => x.name)).toEqual(['password_1']);
    expect(d.scenario.vars).toEqual({ password_1: 'CHANGE-ME' });
    // A secret part and a plain part on one field are never one step.
    expect(draft(rec(start(), press(400, field), typing(900, field, { text: 'abc' }), typing(5000, { ...field, secret: true }, { secret: true, field_kind: 'secret', text: undefined }), stop(6000))).steps).toHaveLength(2);
  });

  it('a merged typing longer than the longest recorded text stays two steps', () => {
    const a = 'a'.repeat(1500);
    expect(draft(rec(start(), press(400, field), typing(900, field, { text: a }), typing(5000, field, { text: a }), stop(6000))).steps).toHaveLength(2);
  });

  it('a write that follows either part of a merged typing is the typing step\'s', () => {
    const write = (t: number) => ({ kind: 'write', t, method: 'POST', label: 'POST shop:/api/draft', outcome: 'passed' });
    const d = draft(rec(start(), press(400, field), typing(900, field, { text: 'Two b' }), write(1200), typing(5000, field, { text: 'ags' }), write(5300), press(9000, { target: { text: 'Send' } }), stop(9500)));
    expect(d.steps[0]).toEqual({ type: { into: { label: 'Message' }, text: 'Two bags' }, note: 'sends POST shop:/api/draft; sends POST shop:/api/draft' });
    expect(d.writes.map((w) => w.step)).toEqual([0, 0]);
    expect(d.firstWrite).toEqual({ scene: 'home', step: 0 });
  });
});

describe('shownStep: the check\'s failing step on screen (review B-M4)', () => {
  it('the row of the recorded draft\'s step in the arranged draft: an insert before it moves it; a step that is gone is null', () => {
    const late = { target: { text: 'Delayed control' }, appeared: true };
    const ev = rec(start(), press(400, { target: { text: 'Unlock the last step' } }), press(3000, late), press(3500, { target: { text: 'Save' } }), stop(4000));
    const bare = draftFromRecording(ev, CTX);
    const shown = draftFromRecording(ev, CTX, ann({}, { after_seq: 0, kind: 'hold', seconds: 2 }, { after_seq: 1, kind: 'wait_for', until: 'next_target' }));
    expect(shownStep(bare.sources, shown.sources, { scene: 'home', step: 3 })).toEqual({ scene: 'home', step: 4 });
    expect(shownStep(bare.sources, shown.sources, { scene: 'home', step: 0 })).toEqual({ scene: 'home', step: 1 });
    // The recorder's wait (step 1 of the recorded draft) was replaced by the inserted one: not on screen.
    expect(shownStep(bare.sources, shown.sources, { scene: 'home', step: 1 })).toBeNull();
    expect(shownStep(bare.sources, shown.sources, { scene: 'nowhere', step: 0 })).toBeNull();
  });
});

describe('L3.4\'s drafts, byte for byte (review B-N1)', () => {
  // Real recordings of the fixture product (headless, trusted input; alternatives on) and the drafts L3.4's generator
  // made of them (core at the L4.7 commit, compiled apart): the L4.8 generator, without annotations or with empty ones,
  // gives the same YAML, issues, writes, check bound and stats.
  const dir = new URL('./fixtures/recordings/', import.meta.url);
  const names = readdirSync(dir).filter((f) => f.endsWith('.events.jsonl')).map((f) => f.replace(/\.events\.jsonl$/, ''));

  it('has the golden recordings', () => {
    expect(names.sort()).toEqual(['imports', 'lab', 'products', 'signup']);
  });

  for (const name of names) {
    it(`${name}: the same draft as L3.4`, () => {
      const events = readFileSync(new URL(`${name}.events.jsonl`, dir), 'utf8')
        .trim()
        .split('\n')
        .map((l) => RecordedEventSchema.parse(JSON.parse(l)));
      expect(events.some((e) => 'el' in e && e.el?.alternatives?.length)).toBe(true);
      const golden = JSON.parse(readFileSync(new URL(`${name}.l34.json`, dir), 'utf8')) as { ctx: DraftContext; yaml: string; issues: unknown; writes: unknown; firstWrite: unknown; stats: unknown };
      for (const d of [draftFromRecording(events, golden.ctx), draftFromRecording(events, golden.ctx, emptyRecordAnnotations())]) {
        expect(d.yaml).toBe(golden.yaml);
        expect({ issues: d.issues, writes: d.writes, firstWrite: d.firstWrite, stats: d.stats }).toEqual({ issues: golden.issues, writes: golden.writes, firstWrite: golden.firstWrite, stats: golden.stats });
      }
    });
  }
});
