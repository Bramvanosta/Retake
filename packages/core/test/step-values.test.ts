/**
 * L4.3 part 3, core value edits (step-edits.ts `set_step` / `insert_step`, step-forms.ts): a form's field changes and the
 * palette's new steps as text edits — yaml's CST.setScalarValue with a double-quote fallback, a key added or removed,
 * a shorthand turned into a flow map, a new step rendered by yaml — checked with facts independent of the edit code:
 * the re-parsed value against the change applied to the parsed value (verifyEditText), the one line it may touch
 * (located from the original document's node positions), every other byte. Goldens on every step of the fixture's 13
 * scenarios; injection (values that are YAML syntax stay values); shorthands kept; critique B2 (a field changed
 * meanwhile is never reverted), B9 (hidden characters, line breaks), layouts (CR LF without a final line break, block
 * maps, comments); the forms derived from the schemas (required agrees with zod, the palette's defaults).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ARG_SCHEMAS,
  ACTION_NAMES,
  PALETTE_ACTIONS,
  StepEditError,
  applyStepEdit,
  canonicalJson,
  newStepValue,
  normalizeStep,
  parseYaml,
  stepFields,
  stepFormValues,
  stepForms,
  stepGuard,
  verifyEditText,
} from '../src/index.js';
import type { ActionName, FieldChange, FormField, FormValue, StepEdit } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCENARIOS = join(ROOT, 'projects', 'northfield-fixture', 'scenarios');

type Doc = { scenes: Array<{ id?: string; steps?: unknown[] }> };
const valueOf = (t: string) => parseYaml(t).value as Doc;
const stepsOf = (t: string, scene: string) => valueOf(t).scenes.find((s) => s.id === scene && Array.isArray(s.steps))!.steps!;
const at = (t: string, scene: string, index: number) => ({ scene, index, guard: stepGuard(stepsOf(t, scene)[index]) });
const set = (t: string, scene: string, index: number, changes: FieldChange[]) => applyStepEdit(t, { kind: 'set_step', at: at(t, scene, index), changes });
const change = (key: string, from: FormValue | undefined, to: FormValue | undefined): FieldChange => ({ path: key.split('.'), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
const lines = (t: string) => t.split('\n');

/** The edit applied and verified: the text re-parses to exactly the intended value. */
function applied(t: string, edit: StepEdit) {
  const r = applyStepEdit(t, edit);
  expect(verifyEditText(r.text, r.intended)).toBeNull();
  return r;
}

/** Line indexes (0-based) where two texts of the same line count differ. */
function changedLines(a: string, b: string): number[] {
  const x = lines(a);
  const y = lines(b);
  expect(y.length).toBe(x.length);
  return x.flatMap((l, i) => (l === y[i] ? [] : [i]));
}

/** The 0-based line of the deepest node that exists along `path` under step `index` of scene entry `entry`. */
function nodeLine(t: string, entry: number, index: number, path: string[]): { line: number; endLine: number } {
  const p = parseYaml(t);
  const base = ['scenes', entry, 'steps', index];
  let k = path.length;
  let node: { range?: [number, number, number] } | undefined;
  while (k >= 0) {
    node = p.source.doc.getIn([...base, ...path.slice(0, k)], true) as typeof node;
    if (node && node.range) break;
    k--;
  }
  const lineOf = (off: number) => t.slice(0, off).split('\n').length - 1;
  let end = node!.range![1];
  while (end > node!.range![0] && /\s/.test(t[end - 1])) end--;
  return { line: lineOf(node!.range![0]), endLine: lineOf(end) };
}

/** A new value for a field (different from `cur`), or undefined when the field takes none here. */
function newValue(f: FormField, cur: FormValue | undefined, n: number): FormValue | undefined {
  switch (f.kind) {
    case 'text': {
      const pool = ['Pier & Co', 'a: b, c', 'yes', '123', '# not a comment', "it's \"quoted\"", '{{vars.customer}}', '] }', '*alias', 'plain words'];
      let v = cur === undefined ? 'New value' : pool[n % pool.length];
      if (f.pattern) v = cur === undefined ? 'new-value' : `${String(cur)}-2`;
      return v === cur ? `${v} 2` : v;
    }
    case 'number':
      return typeof cur === 'number' ? cur + 1 : 1.5;
    case 'integer':
      return typeof cur === 'number' ? cur + 1 : 2;
    case 'boolean':
      return cur === undefined ? true : !cur;
    case 'enum':
      return f.options!.find((o) => o !== cur);
  }
}

describe('forms derived from the schemas', () => {
  const forms = stepForms();
  it('every action has a form (eval, emit and cursor: none — the YAML tab); the palette holds 16 actions (hook since L5.8)', () => {
    expect(forms.actions.map((a) => a.action)).toEqual([...ACTION_NAMES]);
    for (const a of ['eval', 'emit', 'cursor'] as const) expect(forms.actions.find((f) => f.action === a)!.fields).toEqual([]);
    expect(forms.palette).toEqual([...PALETTE_ACTIONS]);
    expect(forms.palette).toHaveLength(16);
    expect(forms.modifiers.map((m) => m.key)).toEqual(['caption.text', 'caption.kicker', 'hold', 'speed', 'mark']);
    // A flat target: its keys only, a target inside a target and lists stay in the YAML tab.
    const type = forms.actions.find((a) => a.action === 'type')!;
    expect(type.fields.filter((f) => f.group === 'type.into').map((f) => f.key.split('.').pop())).toEqual(['text', 'role', 'name', 'label', 'aria', 'placeholder', 'css', 'testid', 'in', 'nth', 'exact']);
    expect(type.fields.find((f) => f.key === 'type.into.in')!.options).toEqual(['dialog', 'menu', 'listbox', 'popover', 'page']);
    expect(type.yaml_only).toEqual(['type.into.contains', 'type.into.last_visible']);
    expect(type.fields.find((f) => f.key === 'type.cps')).toMatchObject({ kind: 'number', exclusive_min: 0 });
  });

  it("each palette action's defaults with its required texts filled are valid arguments (zod agrees with `required`), and an empty required one is not", () => {
    for (const a of PALETTE_ACTIONS) {
      const form = forms.actions.find((f) => f.action === a)!;
      const values: Record<string, FormValue> = { ...form.defaults };
      for (const f of form.fields) if (f.required && f.kind === 'text') values[f.key] = 'x';
      if (Object.keys(values).length === 0) values[form.fields[0].key] = form.fields[0].kind === 'number' ? 1 : 'x';
      const step = newStepValue(a, values);
      expect(ACTION_ARG_SCHEMAS[a].safeParse(step[a]).success, a).toBe(true);
      for (const f of form.fields.filter((x) => x.required && x.group === undefined && x.key !== a)) {
        const without = { ...values };
        delete without[f.key];
        expect(() => newStepValue(a, without), `${a} without ${f.key}`).toThrow(/needs a value/);
      }
    }
    expect(() => newStepValue('eval', { 'eval.js': 'x' } as never)).toThrow(/YAML view/);
  });
});

describe('value edits on every step of the fixture scenarios (goldens)', () => {
  const names = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
  it('the fixture has its 15 scenarios', () => expect(names).toHaveLength(15));

  it.each(names)('%s: every field holding a value takes a new one (exactly its own line changes); on each step an optional value is removed and an absent modifier added (one line, or the same line); each re-parses to the intended value', (name) => {
    const text = readFileSync(join(SCENARIOS, name), 'utf8');
    const v = valueOf(text);
    let n = 0;
    let k = 0;
    v.scenes.forEach((sc, entry) => {
      if (typeof sc.id !== 'string' || !Array.isArray(sc.steps)) return;
      const sceneId = sc.id;
      sc.steps.forEach((raw, index) => {
        const form = stepFormValues(raw);
        if (!form) return;
        const fields = stepFields(form.action).filter((f) => !form.locked[f.key]);
        // Every value: a new one changes exactly the line of its value.
        for (const f of fields) {
          const cur = form.values[f.key];
          if (cur === undefined) continue;
          const to = newValue(f, cur, n);
          if (to === undefined) continue;
          const r = applied(text, { kind: 'set_step', at: at(text, sceneId, index), changes: [change(f.key, cur, to)] });
          const where = nodeLine(text, entry, index, f.key.split('.'));
          expect(changedLines(text, r.text), `${sc.id}.${index} ${f.key}`).toEqual([where.line]);
          expect(stepFormValues((r.intended as Doc).scenes[entry].steps![index])!.values[f.key]).toEqual(to);
          n++;
        }
        // One optional value removed (in turn): its own line goes, or its line changes (a flow map, the dash line).
        const optional = fields.filter((f) => form.values[f.key] !== undefined && (!f.required || f.group !== undefined));
        if (optional.length) {
          const f = optional[k++ % optional.length];
          try {
            const r = applied(text, { kind: 'set_step', at: at(text, sceneId, index), changes: [change(f.key, form.values[f.key], undefined)] });
            const d = lines(text).length - lines(r.text).length;
            expect([0, 1], `${sc.id}.${index} remove ${f.key}`).toContain(d);
            if (d === 0) expect(changedLines(text, r.text)).toHaveLength(1);
            expect(stepFormValues((r.intended as Doc).scenes[entry].steps![index])!.values[f.key]).toBeUndefined();
            n++;
          } catch (e) {
            // The last value of the action (`click: Save` without its text) is refused, never written.
            expect((e as StepEditError).message).toMatch(/needs (at least one value|a value)/);
          }
        }
        // One absent modifier added (in turn): a line after the step's last line, the rest of the file unchanged.
        const absent = ['caption.text', 'hold', 'mark', 'speed'].filter((key) => form.values[key] === undefined && !form.locked[key] && !(key === 'hold' && form.action === 'hold'));
        if (absent.length) {
          const key = absent[k++ % absent.length];
          const f = stepFields(form.action).find((x) => x.key === key)!;
          const to = newValue(f, undefined, n)!;
          const r = applied(text, { kind: 'set_step', at: at(text, sceneId, index), changes: [change(key, undefined, to)] });
          const a = lines(text);
          const b = lines(r.text);
          expect(b.length - a.length, `${sc.id}.${index} add ${key}`).toBe(1);
          const i = a.findIndex((l, x) => l !== b[x]);
          expect(i === -1 ? a.length : i, `${sc.id}.${index} add ${key} lands after the step`).toBe(nodeLine(text, entry, index, []).endLine + 1);
          expect(a).toEqual([...b.slice(0, i), ...b.slice(i + 1)]);
          n++;
        }
      });
    });
    expect(n).toBeGreaterThan(10);
  });

  it.each(names)('%s: a new step from the palette at the start, the middle and the end of every scene adds exactly one line there and re-parses to the intended value', (name) => {
    const text = readFileSync(join(SCENARIOS, name), 'utf8');
    const v = valueOf(text);
    const samples: Array<[string, Record<string, FormValue>]> = [
      ['click', { 'click.text': 'Save', 'click.in': 'dialog' }],
      ['type', { 'type.into.label': 'Message', 'type.text': 'Hello, world: "hi"', 'type.cps': 12 }],
      ['hold', { hold: 1 }],
      ['wait_for', { 'wait_for.text': '# not a comment' }],
    ];
    for (const sc of v.scenes) {
      if (typeof sc.id !== 'string' || !Array.isArray(sc.steps)) continue;
      const len = sc.steps.length;
      [...new Set([0, Math.floor(len / 2), len])].forEach((j, k) => {
        const [action, values] = samples[k % samples.length];
        const after = j > 0 ? stepGuard(sc.steps![j - 1]) : null;
        const r = applied(text, { kind: 'insert_step', to: { scene: sc.id!, index: j }, after, action: action as never, values });
        const a = lines(text);
        const b = lines(r.text);
        expect(b.length - a.length).toBe(1);
        const i = a.findIndex((l, x) => l !== b[x]);
        expect([...a.slice(0, i), ...a.slice(i)]).toEqual([...b.slice(0, i), ...b.slice(i + 1)]);
        expect(stepsOf(r.text, sc.id!)[j]).toEqual(newStepValue(action as never, values));
      });
    }
  });

  it('every fixture step of a palette action reads as form values that write back as the same step (raw → fields → raw: the same arguments; a one-value target as its shorthand)', () => {
    let total = 0;
    for (const name of readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'))) {
      for (const sc of valueOf(readFileSync(join(SCENARIOS, name), 'utf8')).scenes) {
        for (const raw of sc.steps ?? []) {
          const form = stepFormValues(raw);
          if (!form || !(PALETTE_ACTIONS as readonly ActionName[]).includes(form.action) || form.yaml_only.length || Object.keys(form.locked).length) continue;
          if (Object.keys(raw as object).some((k) => k !== form.action)) continue;
          total++;
          const own = Object.fromEntries(Object.entries(form.values).filter(([k]) => k === form.action || k.startsWith(`${form.action}.`)));
          const back = newStepValue(form.action, own);
          expect(stepFormValues(back)!.values).toEqual(form.values);
          expect(canonicalJson(normalizeStep(back as never, 0).args)).toBe(canonicalJson(normalizeStep(raw as never, 0).args));
        }
      }
    }
    expect(total).toBeGreaterThan(80);
  });
});

const FILE = `video: v
scenes:
  - id: a
    page: shop
    open: /
    steps:
      - click: Selowa Ridge
      - click: "#save-button"
      - click: {aria: Increase, in: dialog}   # spaced comment
      - type: {into: {label: Message}, text: "Light roast", cps: 18}
      - type:
          into: Name
          text: 'Ada'
        caption: {kicker: K, text: "Caption text"}
      - hold: 1.2
        mark: here
      - scroll: 300
`;

describe('values written in place, shorthands kept (critique B4)', () => {
  it('a shorthand stays a shorthand when only its own value changes; another value turns it into a flow map with the same meaning', () => {
    const r1 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 0), changes: [change('click.text', 'Selowa Ridge', 'Mountfern AA')] });
    expect(changedLines(FILE, r1.text).map((i) => lines(r1.text)[i])).toEqual(['      - click: Mountfern AA']);
    const r2 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 0), changes: [change('click.in', undefined, 'dialog')] });
    expect(changedLines(FILE, r2.text).map((i) => lines(r2.text)[i])).toEqual(['      - click: {text: Selowa Ridge, in: dialog}']);
    // A CSS shorthand reads as css; a text that looks like CSS is never written as a shorthand (it would read as css).
    expect(stepFormValues(stepsOf(FILE, 'a')[1])!.values).toEqual({ 'click.css': '#save-button' });
    const r3 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 0), changes: [change('click.text', 'Selowa Ridge', '#hash tag')] });
    expect(changedLines(FILE, r3.text).map((i) => lines(r3.text)[i])).toEqual(['      - click: {text: "#hash tag"}']);
    const r4 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 1), changes: [change('click.css', '#save-button', '#ok')] });
    expect(changedLines(FILE, r4.text).map((i) => lines(r4.text)[i])).toEqual(['      - click: "#ok"']);
    // A target written as a string (`into: Name`) and a number shorthand (`scroll: 300`).
    const r5 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 4), changes: [change('type.into.text', 'Name', 'Full name')] });
    expect(changedLines(FILE, r5.text).map((i) => lines(r5.text)[i])).toEqual(['          into: Full name']);
    const r6 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 6), changes: [change('scroll.to', 300, 450)] });
    expect(changedLines(FILE, r6.text).map((i) => lines(r6.text)[i])).toEqual(['      - scroll: 450']);
    const r7 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 6), changes: [change('scroll.duration', undefined, 1.5)] });
    expect(changedLines(FILE, r7.text).map((i) => lines(r7.text)[i])).toEqual(['      - scroll: {to: 300, duration: 1.5}']);
  });

  it('quoting, inline comments and the spacing before them are kept; a number stays a number; keys are added in a flow map and as a block line at the map indentation', () => {
    const r1 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 2), changes: [change('click.aria', 'Increase', 'Decrease')] });
    expect(lines(r1.text)[8]).toBe('      - click: {aria: Decrease, in: dialog}   # spaced comment');
    const r2 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 3), changes: [change('type.text', 'Light roast', 'Dark roast'), change('type.cps', 18, 24), change('type.clear', undefined, true)] });
    expect(changedLines(FILE, r2.text).map((i) => lines(r2.text)[i])).toEqual(['      - type: {into: {label: Message}, text: "Dark roast", cps: 24, clear: true}']);
    const r3 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 4), changes: [change('type.text', 'Ada', "Ada O'Neil"), change('type.enter', undefined, true)] });
    expect(lines(r3.text).slice(10, 15)).toEqual(['      - type:', '          into: Name', "          text: 'Ada O''Neil'", '          enter: true', '        caption: {kicker: K, text: "Caption text"}']);
    // A modifier removed from a block map takes its own line; the caption's kicker from a flow map, its comma.
    const r4 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 5), changes: [change('mark', 'here', undefined)] });
    expect(lines(FILE).length - lines(r4.text).length).toBe(1);
    expect(r4.text).not.toContain('mark: here');
    const r5 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 4), changes: [change('caption.kicker', 'K', undefined)] });
    expect(changedLines(FILE, r5.text).map((i) => lines(r5.text)[i])).toEqual(['        caption: {text: "Caption text"}']);
    // The last value of a target removes the target; the last value of the action is refused.
    const r6 = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 3), changes: [change('type.into.label', 'Message', undefined)] });
    expect(changedLines(FILE, r6.text).map((i) => lines(r6.text)[i])).toEqual(['      - type: {text: "Light roast", cps: 18}']);
    expect(() => set(FILE, 'a', 2, [change('click.aria', 'Increase', undefined), change('click.in', 'dialog', undefined)])).toThrow(/click needs at least one value/);
  });

  it('values that are YAML syntax stay values (injection: the file gains no step, no anchor, no tag); each changes one line', () => {
    const hostile = ['a\tb', '&a b', '*a', '!!js/function f', '# c', '{a: 1}', ']', '- dash', 'yes', '123', '1e3', 'null', '~', 'a, b', '"q"', "it's", '{{vars.customer}}', 'key: value', '|', '>-', '@at', '`tick`', '%YAML', '---', '...', ' lead', 'trail ', '? q', 'x #y'];
    const targets: Array<[number, string, FormValue]> = [
      [0, 'click.text', 'Selowa Ridge'], // a plain shorthand
      [2, 'click.aria', 'Increase'], // a scalar in a flow map
      [3, 'type.text', 'Light roast'], // a double-quoted one
      [4, 'type.text', 'Ada'], // a single-quoted one in a block map
    ];
    for (const [i, key, from] of targets) {
      for (const h of hostile) {
        const r = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', i), changes: [change(key, from, h)] });
        expect(stepFormValues(stepsOf(r.text, 'a')[i])!.values[key], `${key} ← ${JSON.stringify(h)}`).toBe(h);
        expect(stepsOf(r.text, 'a')).toHaveLength(7);
        expect(changedLines(FILE, r.text)).toHaveLength(1);
      }
    }
    // Added keys and new steps take hostile values as values too.
    for (const h of hostile) {
      const r = applied(FILE, { kind: 'set_step', at: at(FILE, 'a', 4), changes: [change('caption.kicker', 'K', h), change('mark', undefined, 'm-1')] });
      expect((stepsOf(r.text, 'a')[4] as { caption: { kicker: string } }).caption.kicker).toBe(h);
      const n = applied(FILE, { kind: 'insert_step', to: { scene: 'a', index: 7 }, after: stepGuard(stepsOf(FILE, 'a')[6]), action: 'type', values: { 'type.text': h, 'type.into.label': h } });
      expect(stepsOf(n.text, 'a')[7]).toEqual({ type: { into: { label: h }, text: h } });
      expect(lines(n.text).length).toBe(lines(FILE).length + 1);
    }
  });

  it('a line break, a hidden character (critique B9) and a value of the wrong kind are refused, naming the field; nothing else is written', () => {
    const refusals: Array<[FormValue, RegExp]> = [
      ['a\nb', /one line only/],
      ['a\r\n  - eval: x', /one line only/],
      [`x${String.fromCodePoint(0x2028)}y`, /line separator/],
      [`x${String.fromCodePoint(0x85)}y`, /NEL/],
      [`x${String.fromCodePoint(0x200b)}y`, /zero-width space/],
      [`x${String.fromCodePoint(0xfeff)}y`, /byte-order mark/],
      [`x${String.fromCodePoint(0x202e)}y`, /direction control/],
      ['x'.repeat(10_001), /at most 10,000/],
      [12, /a text/],
    ];
    for (const [to, msg] of refusals) {
      let err: StepEditError | undefined;
      try {
        set(FILE, 'a', 3, [change('type.text', 'Light roast', to)]);
      } catch (e) {
        err = e as StepEditError;
      }
      expect(err, String(to).slice(0, 20)).toBeInstanceOf(StepEditError);
      expect(err!.code).toBe('invalid');
      expect(err!.field).toBe('type.text');
      expect(err!.message).toMatch(msg);
    }
    // The palette's values: the same rules, naming the field.
    for (const [to, msg] of refusals.slice(0, 7)) {
      let err: StepEditError | undefined;
      try {
        applyStepEdit(FILE, { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'type', values: { 'type.text': to } });
      } catch (e) {
        err = e as StepEditError;
      }
      expect(err?.field).toBe('type.text');
      expect(err?.message).toMatch(msg);
    }
    expect(() => set(FILE, 'a', 3, [change('type.cps', 18, 'fast')])).toThrow(/type\.cps: a number/);
    expect(() => set(FILE, 'a', 3, [change('type.into.in', undefined, 'sidebar')])).toThrow(/one of dialog, menu/);
    expect(() => set(FILE, 'a', 3, [change('type.speed', undefined, 2)])).toThrow(/not a value the Studio edits/);
    expect(() => set(FILE, 'a', 3, [change('overlay.duration', undefined, 2)])).toThrow(/not a value the Studio edits/);
    expect(() => set(FILE, 'a', 3, [change('type.text', 'Light roast', undefined)])).toThrow(/type\.text needs a value/);
    expect(() => set(FILE, 'a', 3, [change('type.text', 'Light roast', 'A'), change('type.text', 'Light roast', 'B')])).toThrow(/changed twice/);
    expect(() => set(FILE, 'a', 3, [change('type.text', 'Light roast', 'Light roast')])).toThrow(/nothing to change/);
  });
});

describe('field patches (critique B2): a field changed meanwhile is never reverted', () => {
  it('a change whose `from` is not what the step holds is stale (naming the field); others still apply on top of a concurrent change', () => {
    // Claude changed the caption meanwhile: the person's change of the typed text still applies, the caption stays.
    const theirs = FILE.replace('caption: {kicker: K, text: "Caption text"}', 'caption: {kicker: K, text: "Claude\'s caption"}');
    const r = applied(theirs, { kind: 'set_step', at: at(theirs, 'a', 4), changes: [change('type.text', 'Ada', 'Grace')] });
    expect(stepsOf(r.text, 'a')[4]).toEqual({ type: { into: 'Name', text: 'Grace' }, caption: { kicker: 'K', text: "Claude's caption" } });
    // The person's caption change on that version: refused as stale, the caption Claude wrote kept.
    let err: StepEditError | undefined;
    try {
      set(theirs, 'a', 4, [change('caption.text', 'Caption text', 'Mine')]);
    } catch (e) {
      err = e as StepEditError;
    }
    expect(err?.code).toBe('stale');
    expect(err?.field).toBe('caption.text');
    expect(err?.message).toMatch(/caption\.text of step 5 of a changed meanwhile \(it is now "Claude's caption"\)/);
    // A value removed meanwhile, or set meanwhile when the form showed none: stale too.
    expect(() => set(FILE, 'a', 3, [change('type.clear', false, true)])).toThrow(/changed meanwhile \(it is now not set\)/);
    expect(() => set(FILE, 'a', 3, [change('type.cps', undefined, 20)])).toThrow(/changed meanwhile \(it is now 18\)/);
    // The step's guard still names the step (the client relocates it after a 409, then sends its new guard).
    expect(() => applyStepEdit(theirs, { kind: 'set_step', at: at(FILE, 'a', 4), changes: [change('type.text', 'Ada', 'Grace')] })).toThrow(/not the step the edit was made on/);
  });

  it('insert_step: the step it goes after must still be there (stale otherwise); positions outside the scene are stale', () => {
    const after = stepGuard(stepsOf(FILE, 'a')[0]);
    expect(() => applyStepEdit(FILE, { kind: 'insert_step', to: { scene: 'a', index: 2 }, after, action: 'hold', values: { hold: 1 } })).toThrow(/changed around position 3/);
    expect(() => applyStepEdit(FILE, { kind: 'insert_step', to: { scene: 'a', index: 0 }, after, action: 'hold', values: { hold: 1 } })).toThrow(/changed around position 1/);
    expect(() => applyStepEdit(FILE, { kind: 'insert_step', to: { scene: 'a', index: 9 }, after: null, action: 'hold', values: { hold: 1 } })).toThrow(/no position 10/);
    const r = applied(FILE, { kind: 'insert_step', to: { scene: 'a', index: 1 }, after, action: 'hold', values: { hold: 1 } });
    expect(lines(r.text)[7]).toBe('      - hold: 1');
    expect(r.label).toBe('Added a hold step at position 2 of a');
    expect(r.select).toBe('a.1');
  });
});

describe('layouts', () => {
  it('CR LF without a final line break: changed, added and new lines use CR LF, no final break is added', () => {
    const crlf = FILE.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
    const r1 = applied(crlf, { kind: 'set_step', at: at(crlf, 'a', 6), changes: [change('scroll.to', 300, 120), change('hold', undefined, 2)] });
    expect(r1.text.endsWith('\n')).toBe(false);
    expect(r1.text.split('\r\n')).toHaveLength(crlf.split('\r\n').length + 1);
    expect(r1.text).not.toMatch(/[^\r]\n/);
    expect(r1.text.endsWith('      - scroll: 120\r\n        hold: 2')).toBe(true);
    const r2 = applied(crlf, { kind: 'insert_step', to: { scene: 'a', index: 7 }, after: stepGuard(stepsOf(crlf, 'a')[6]), action: 'press', values: { 'press.key': 'Enter' } });
    expect(r2.text.endsWith('      - scroll: 300\r\n      - press: Enter')).toBe(true);
    expect(r2.text).not.toMatch(/[^\r]\n/);
  });

  it('an empty scene takes a new step as a block list; a long new step is written as a block', () => {
    const empty = 'video: e\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps: []  # none yet\n';
    const r = applied(empty, { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'click', values: { 'click.text': 'Start' } });
    expect(r.text).toBe('video: e\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:  # none yet\n      - click: Start\n');
    const long = 'x'.repeat(130);
    const r2 = applied(empty, { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'type', values: { 'type.text': long, 'type.into.label': 'Notes' } });
    expect(lines(r2.text).slice(6, 10)).toEqual(['      - type:', '          into:', '            label: Notes', `          text: ${long}`]);
  });

  it('a step written as an alias, or a value that only an alias holds, takes no form edit', () => {
    const aliased = 'video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - &s {click: One}\n      - *s\n      - click: {text: &t Two}\n      - click: {text: *t}\n';
    expect(() => set(aliased, 'a', 1, [change('click.text', 'One', 'Uno')])).toThrow(/alias/);
    expect(() => set(aliased, 'a', 3, [change('click.text', 'Two', 'Dos')])).toThrow(/alias/);
    // The anchored value itself: changing it would change the step that repeats it too — refused by the check.
    expect(() => set(aliased, 'a', 2, [change('click.text', 'Two', 'Dos')])).toThrow(/without changing other parts of the file/);
  });

  it('a field holding something a form cannot show (a scope written as a row, a URL with sign-in details) is locked, never written', () => {
    const t = 'video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: {text: Edit, in: {row: Order 12}}\n      - open: "https://u:pw@shop.example.test/x"\n';
    const f0 = stepFormValues(stepsOf(t, 'a')[0])!;
    expect(f0.locked['click.in']).toMatch(/YAML view/);
    expect(() => set(t, 'a', 0, [change('click.in', undefined, 'dialog')])).toThrow(/click\.in written in a form/);
    const f1 = stepFormValues(stepsOf(t, 'a')[1])!;
    expect(f1.values).toEqual({});
    expect(JSON.stringify(f1)).not.toContain('pw@');
    expect(() => set(t, 'a', 1, [change('open.url', undefined, '/y')])).toThrow(/sign-in details/);
  });

  it('review A: a field holding a hidden character is locked (an input would show it as nothing), with the character named', () => {
    const zw = String.fromCodePoint(0x200b);
    const t = `video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - type: {into: Name, text: "a${zw}b"}\n`;
    const f = stepFormValues(stepsOf(t, 'a')[0])!;
    expect(f.locked['type.text']).toBe('holds U+200B (a zero-width space), which a form cannot show: edit it in the YAML view');
    expect(f.values['type.text']).toBeUndefined();
    expect(() => set(t, 'a', 0, [change('type.text', undefined, 'ab')])).toThrow(/type\.text holds U\+200B/);
  });

  it('review B M3: removing a key of a {…} map written over several lines or holding a comment is refused; on one line it is cut', () => {
    const head = 'video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n';
    const multi = `${head}      - click: {role: button,  # the role\n          name: Save}\n`;
    expect(() => set(multi, 'a', 0, [change('click.name', 'Save', undefined)])).toThrow(/written over several lines or holds comments/);
    const commented = `${head}      - click: {role: button, name: Save}\n`;
    const r = set(commented, 'a', 0, [change('click.name', 'Save', undefined)]);
    expect(lines(r.text)[6]).toBe('      - click: {role: button}');
    // A value holding "#" inside quotes is cut with its key (only what lies between the tokens is looked at).
    const hashed = `${head}      - click: Save\n        caption: {kicker: "a # b", text: Saved}\n`;
    expect(lines(set(hashed, 'a', 0, [change('caption.kicker', 'a # b', undefined)]).text)[7]).toBe('        caption: {text: Saved}');
  });
});
