/**
 * L4.3 part 1, core rules of the Studio's scenario writes: the verify (re-parsed with parseYaml — an alias before its
 * anchor throws only at toJS, critique A), hidden characters (critique B9), hooks unchanged (B3), positioned agent-trust
 * problems (B11), the line break a text uses.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentTrustProblems,
  agentTrustProblemsAt,
  changedHookInputs,
  changedHookSections,
  editValueProblem,
  firstHiddenChar,
  hiddenCharName,
  hookInputsChangedMessage,
  newHiddenCharProblem,
  parseScenario,
  parseYaml,
  textEol,
  verifyEditText,
} from '../src/index.js';
import type { Scenario } from '../src/index.js';
import { nodeFileFacts } from '@retake/core/io';

const cp = (h: number) => String.fromCodePoint(h);

describe('verifyEditText', () => {
  it('accepts a text whose value is the intended one, refuses another value, invalid YAML and an alias before its anchor', () => {
    expect(verifyEditText('a: [1, 2]\nb: x # c\n', { a: [1, 2], b: 'x' })).toBeNull();
    expect(verifyEditText('a: [1, 2]\n- eval: x\n', { a: [1, 2] })).toMatch(/^the edit would not give valid YAML/);
    expect(verifyEditText('a: 123\n', { a: '123' })).toBe('the edit cannot be made without changing other parts of the file — change it in the YAML view');
    // yaml 2.9 reports no error for an alias whose anchor comes after it: only toJS throws — parseYaml catches it.
    expect(verifyEditText('a: *x\nb: &x 1\n', { a: 1, b: 1 })).toMatch(/^the edit would not give valid YAML/);
  });
});

describe('hidden characters', () => {
  it('names each kind, refuses new ones with line and column, keeps those the base had, allows a leading BOM and emoji ZWJ', () => {
    expect(hiddenCharName(cp(0x202e))).toBe('U+202E (a direction control)');
    expect(hiddenCharName(cp(0x85))).toBe('U+0085 (a next-line control (NEL))');
    expect(hiddenCharName(cp(0x1b))).toBe('U+001B (a control character)');
    expect(hiddenCharName(cp(0xe0041))).toBe('U+E0041 (an invisible character)');
    const base = 'a: 1\nb: 2\n';
    expect(newHiddenCharProblem(base, base)).toBeNull();
    expect(newHiddenCharProblem(`a: 1\nb: 2${cp(0x2029)}\n`, base)).toBe(
      'line 2, column 5 holds U+2029 (a paragraph separator): the Studio never writes one (it reads as nothing, or as a line break, in an editor) — remove it',
    );
    const marked = `a: x${cp(0x202e)}y\nb: 2\n`;
    expect(newHiddenCharProblem(marked.replace('b: 2', 'b: 3'), marked)).toBeNull();
    expect(newHiddenCharProblem(`${marked}c: ${cp(0x202e)}\n`, marked)).toMatch(/^line 3, column 4 holds U\+202E/);
    expect(newHiddenCharProblem(`${cp(0xfeff)}${base}`, base)).toBeNull();
    expect(newHiddenCharProblem(`a: 1${cp(0xfeff)}\n`, base)).toMatch(/^line 1, column 5 holds U\+FEFF/);
    const family = `${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}`;
    expect(newHiddenCharProblem(`a: ${family}\n`, base)).toBeNull();
    expect(newHiddenCharProblem(`a: x${cp(0x200d)}y\n`, base)).toMatch(/holds U\+200D \(a zero-width joiner\)/);
    expect(newHiddenCharProblem('a: "tab\there"\r\n', base)).toBeNull();
  });

  it('editValueProblem: single-line fields refuse line breaks, every field hidden characters and over 10,000 characters', () => {
    expect(editValueProblem('Save', { field: ['scenes', 0, 'steps', 1, 'click'] })).toBeNull();
    expect(editValueProblem('a\tb', { field: 'x' })).toBeNull();
    expect(editValueProblem('a\nb', { field: ['caption', 'text'] })).toBe('caption.text: one line only (no line break)');
    expect(editValueProblem('a\nb', { field: 'note', multiline: true })).toBeNull();
    expect(editValueProblem(`a${cp(0x2066)}b`, { field: 'text' })).toBe('text holds U+2066 (a direction control): the Studio never writes one — remove it');
    expect(editValueProblem('x'.repeat(10_001), { field: 'text' })).toBe('text: at most 10,000 characters (10,001)');
  });
});

describe('changedHookSections', () => {
  it('compares setup, teardown and mocks by canonical JSON; an unreadable base counts every section the text has', () => {
    const v = (t: string) => parseYaml(t).value;
    const base = v('setup:\n  - http: {method: POST, url: x}\nscenes: []\n');
    expect(changedHookSections(base, v('setup:\n  - http: {url: x, method: POST}\nscenes: [1]\n'))).toEqual([]);
    expect(changedHookSections(base, v('setup:\n  - http: {url: y, method: POST}\n'))).toEqual(['setup']);
    expect(changedHookSections(base, v('scenes: []\n'))).toEqual(['setup']);
    expect(changedHookSections(base, v('setup:\n  - http: {method: POST, url: x}\nteardown: [{shell: ls}]\nmocks: [{match: x}]\n'))).toEqual(['teardown', 'mocks']);
    expect(changedHookSections(v('scenes: []\n'), v('setup: []\nscenes: []\n'))).toEqual([]);
    expect(changedHookSections(undefined, v('scenes: []\n'))).toEqual([]);
    expect(changedHookSections(undefined, v('teardown: [{shell: ls}]\n'))).toEqual(['teardown']);
  });
});

describe('agentTrustProblemsAt (critique B11)', () => {
  it('places each secret reference, file reference and template folder at its line; the same problems as agentTrustProblems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-trust-at-'));
    writeFileSync(join(dir, 'x.txt'), 'x');
    const text = [
      'video: t',
      'template: ./theme',
      'scenes:',
      '  - id: a',
      '    page: console',
      '    open: /',
      '    steps:',
      '      - type: {into: {label: A}, text: "{{env:ONE}}"}',
      '      - hold: 1',
      '        note: "{{env:NOT_TEMPLATED}}"',
      '      - drop_file: {zone: {label: B}, path: ../out.txt}',
      '      - type: {into: {label: C}, text: "{{keychain:svc/acct}}"}',
      '',
    ].join('\n');
    const { scenario } = parseScenario(text);
    expect(scenario).toBeDefined();
    const project = { dir, config: { template: 'default' } };
    const at = agentTrustProblemsAt(project, scenario as Scenario, text, { files: nodeFileFacts, via: 'studio' });
    expect(at.map((p) => [p.line, p.path.join('.')])).toEqual([
      [2, 'template'],
      [8, 'scenes.0.steps.0.type.text'],
      [12, 'scenes.0.steps.3.type.text'],
      [11, 'scenes.0.steps.2.drop_file.path'],
    ]);
    expect(at[1].message).toMatch(/^the scenario uses \{\{env:ONE\}\}: from the Studio a scenario never resolves a secret/);
    const flat = agentTrustProblems(project, scenario as Scenario, { files: nodeFileFacts, via: 'studio' });
    expect(flat).toHaveLength(3);
    expect(at.filter((p) => !p.message.startsWith('the scenario uses')).map((p) => p.message)).toEqual(flat.filter((m) => !m.startsWith('the scenario uses')));
  });
});

describe('review fixes (L4.3 review A)', () => {
  it('H1: while the base has a hook or a mock, its vars and env are frozen too; without one they are free', () => {
    const v = (t: string) => parseYaml(t).value;
    const hooked = v('vars: {customer: Acme}\nsetup:\n  - shell: "echo {{vars.customer}}"\nscenes: []\n');
    expect(changedHookInputs(hooked, v('vars: {customer: "x; cat ~/.ssh/k"}\nsetup:\n  - shell: "echo {{vars.customer}}"\nscenes: []\n'))).toEqual(['vars']);
    expect(changedHookInputs(hooked, v('env: prod\nvars: {customer: Acme}\nsetup:\n  - shell: "echo {{vars.customer}}"\nscenes: [1]\n'))).toEqual(['env']);
    expect(changedHookInputs(hooked, v('vars: {customer: Acme}\nsetup:\n  - shell: "echo {{vars.customer}}"\nscenes: [1, 2]\n'))).toEqual([]);
    expect(changedHookInputs(v('mocks: [{match: x}]\nscenes: []\n'), v('mocks: [{match: x}]\nvars: {a: b}\nscenes: []\n'))).toEqual(['vars']);
    expect(changedHookInputs(v('scenes: []\nvars: {a: b}\n'), v('scenes: []\nvars: {a: c}\nenv: prod\n'))).toEqual([]);
    expect(changedHookInputs(v('setup: [{shell: ls}]\nvars: {}\n'), v('setup: [{shell: ls}]\n'))).toEqual([]);
    expect(changedHookInputs(undefined, v('vars: {a: b}\n'))).toEqual([]);
    expect(hookInputsChangedMessage(['vars', 'env'])).toBe(
      'vars and env changed: this scenario has hooks or mocks, which read its vars and its environment and run on this Mac, so the Studio saves it only with vars and env unchanged — change them in your editor',
    );
  });

  it('M2: a carriage return without a line feed is a hidden character (a CR LF is not)', () => {
    const base = 'a: 1\nb: 2\n';
    expect(newHiddenCharProblem('a: 1  # x\r  b: 3\nb: 2\n', base)).toBe(
      'line 1, column 10 holds U+000D (a carriage return without a line feed): the Studio never writes one (it reads as nothing, or as a line break, in an editor) — remove it',
    );
    expect(newHiddenCharProblem('a: 1\r\nb: 2\r\n', base)).toBeNull();
    expect(editValueProblem('one\rtwo', { field: 'note', multiline: true })).toBe('note holds U+000D (a carriage return without a line feed): the Studio never writes one — remove it');
    expect(editValueProblem('one\r\ntwo', { field: 'note', multiline: true })).toBeNull();
  });

  it('L2: a hidden character the file has may not move to another line; the class covers default-ignorable characters and fillers', () => {
    const rlo = cp(0x202e);
    const base = `video: v\n# note ${rlo}x\nscenes: []\n`;
    // Moved from a comment into a value: the count is the same, the line is new.
    expect(newHiddenCharProblem(`video: "ok${rlo}gnp.exe"\n# note x\nscenes: []\n`, base)).toMatch(/^line 1, column 11 holds U\+202E/);
    // Lines the file has, moved as they are: fine; a copy of one: refused (the last occurrence named).
    expect(newHiddenCharProblem(`# note ${rlo}x\nvideo: v\nscenes: []\n`, base)).toBeNull();
    expect(newHiddenCharProblem(`video: v\n# note ${rlo}x\n# note ${rlo}x\nscenes: []\n`, base)).toMatch(/^line 3, column 8 holds U\+202E/);
    for (const c of [0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x2800, 0x3164, 0xfe00, 0xfe0e, 0xfff9, 0xfffb, 0xffa0, 0xe0100, 0xe01ef]) {
      expect(newHiddenCharProblem(`a: "o${cp(c)}k"\n`, 'a: ok\n'), c.toString(16)).toMatch(/holds U\+/);
      expect(firstHiddenChar(`o${cp(c)}k`), c.toString(16)).toBe(cp(c));
    }
    // Emoji sequences: a variation selector after an emoji, a ZWJ between pictographs.
    expect(newHiddenCharProblem(`a: "${cp(0x2764)}${cp(0xfe0f)} 1${cp(0xfe0f)}${cp(0x20e3)} ${cp(0x1f3f3)}${cp(0xfe0f)}${cp(0x200d)}${cp(0x1f308)}"\n`, 'a: ok\n')).toBeNull();
    expect(firstHiddenChar('a\tb')).toBeUndefined();
  });
});

describe('textEol', () => {
  it('CR LF when most line breaks are CR LF', () => {
    expect(textEol('a\r\nb\r\n')).toBe('\r\n');
    expect(textEol('a\nb\r\nc\n')).toBe('\n');
    expect(textEol('one line')).toBe('\n');
  });
});
