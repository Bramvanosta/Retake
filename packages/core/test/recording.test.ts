/**
 * The recorder's event model (L3.4, core recording.ts): what the schema itself refuses — a secret typing event with
 * its text, a path with a query, a printable key without a modifier, an unknown field — and the record id.
 */
import { describe, expect, it } from 'vitest';
import { RECORD_ID_RE, RecordedEventSchema, draftFromRecording, draftInvalidIssue, parseScenario } from '../src/index.js';
import type { DraftContext, RecordedElement, RecordedEvent } from '../src/index.js';

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

function draft(events: RecordedEvent[], ctx: Partial<DraftContext> = {}) {
  const d = draftFromRecording(events, { ...CTX, ...ctx });
  const { scenario, issues } = parseScenario(d.yaml);
  expect(issues.filter((i) => i.severity === 'error'), d.yaml).toEqual([]);
  expect(scenario).toBeDefined();
  expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
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
