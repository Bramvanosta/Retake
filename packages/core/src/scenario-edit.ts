/**
 * Scenario edits from the Studio (L4.3, R-UI-11 / R-UI-12): the rules every write of a scenario the Studio makes goes
 * through, pure and shared by the engine's write path (engine scenarios.edit) and its tests: the YAML tab
 * (`replace_text`), undo / redo (`restore`) and the Blocks tab's step edits (step-edits.ts), all on the same rules.
 *
 * - Size: a scenario the Studio writes holds at most SCENARIO_EDIT_MAX_CHARS characters (MCP scenario_save's cap).
 * - Input rules (critique B9; review A L2 / M2): what the Studio writes adds no character that reads as nothing or as a
 *   line break in an editor — C0 / C1 controls (NEL included) but tab and line breaks, a carriage return not followed
 *   by a line feed (an editor shows a line break where YAML reads none), DEL, U+2028 / U+2029, the direction controls
 *   (a Trojan-source line), every format and default-ignorable character (zero-width, soft hyphen, variation
 *   selectors, Hangul fillers, tags…) and the braille blank, a byte-order mark past the start. A file that already
 *   holds some keeps them (they are shown as marks) only on lines it already has, unchanged: a text with more of one
 *   than the file it replaces, or with one on a line the file does not have (moved from a comment into a value), is
 *   refused, naming the character and where. A zero-width joiner between two pictographs and a variation selector
 *   after an emoji (emoji sequences) are fine.
 * - Hooks unchanged (critique B3; review A H1): a scenario's `setup`, `teardown` and `mocks` run on this Mac, so a save
 *   from the Studio — where script in a page cannot be told from a click — must leave them exactly as they were
 *   (canonical JSON); while the file has any, what they read from the scenario — its `vars` (templated into a shell
 *   line, a SQL text, an HTTP body) and its `env` (where they run) — must stay as they were too. They are edited in an
 *   editor.
 * - Verify (plan §3.1): an edit that builds text from a value is refused unless the text, re-parsed with parseYaml (the
 *   alias checks included: a bare parseDocument misses an alias before its anchor), has exactly the intended value.
 */
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from './comments.js';
import { formatPath } from './issues.js';
import type { IssuePath } from './issues.js';
import type { FieldEdit } from './field-edits.js';
import type { StepEdit } from './step-edits.js';
import { parseYaml } from './validation/yaml-source.js';

/** The largest scenario the Studio writes (characters): MCP scenario_save's cap. */
export const SCENARIO_EDIT_MAX_CHARS = 500_000;

/**
 * The kinds of `scenario_edit`: the YAML tab's text, undo / redo's byte-exact restore, the Blocks tab's step edits
 * (step-edits.ts STEP_EDIT_KINDS — written out here: step-edits imports this module's input rules) and the timeline's
 * field edits (L4.5, field-edits.ts `set_field`).
 */
export const SCENARIO_EDIT_KINDS = ['replace_text', 'restore', 'move_step', 'delete_step', 'duplicate_step', 'set_step', 'insert_step', 'set_field'] as const;
export type ScenarioEditKind = (typeof SCENARIO_EDIT_KINDS)[number];

export type ScenarioEdit =
  /** The YAML tab's text: written as given, with a final line break added when it has none (as scenario_save). */
  | { kind: 'replace_text'; text: string }
  /** Undo / redo: the exact bytes of an earlier version (`text_hash`: their sha256, checked), no line break added. */
  | { kind: 'restore'; text: string; text_hash: string }
  /** The Blocks tab: move, delete, duplicate, change or add a step (step-edits.ts: text splices, verified). */
  | StepEdit
  /** The timeline (L4.5): one edit value of the video, a scene, a card or an interstitial (field-edits.ts, verified). */
  | FieldEdit;

// Characters the Studio never adds (see the header): controls, format and default-ignorable characters, line /
// paragraph separators, the Hangul fillers and the braille blank; tab, line feed and a CR LF's carriage return are left
// out in hiddenChars, a BOM is allowed at offset 0 only.
const HIDDEN_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u115f\u1160\u2800\u3164\uffa0]/gu;
const PICTO = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{fe0f}]/u;
/** What a variation selector U+FE0E / U+FE0F may follow (text or emoji presentation: "1", a heart). */
const EMOJI = /\p{Emoji}/u;

const NAMES: Record<string, string> = {
  '\r': 'a carriage return without a line feed',
  '\u0085': 'a next-line control (NEL)',
  '\u2028': 'a line separator',
  '\u2029': 'a paragraph separator',
  '\ufeff': 'a byte-order mark (zero-width no-break space)',
  '\u200b': 'a zero-width space',
  '\u200c': 'a zero-width non-joiner',
  '\u200d': 'a zero-width joiner',
  '\u2060': 'a word joiner',
  '\t': 'a tab',
};

/** "U+202E (a direction control)". */
export function hiddenCharName(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const what =
    NAMES[c] ??
    (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
      ? 'a control character'
      : (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x061c || cp === 0x200e || cp === 0x200f
        ? 'a direction control'
        : 'an invisible character');
  return `${hex} (${what})`;
}

/** Each hidden character of `text` with its offset (a BOM at offset 0 and a ZWJ inside an emoji sequence left out). */
function hiddenChars(text: string): Array<{ c: string; at: number }> {
  const out: Array<{ c: string; at: number }> = [];
  for (const m of text.matchAll(HIDDEN_G)) {
    const at = m.index;
    if (m[0] === '\t' || m[0] === '\n' || (m[0] === '\r' && text[at + 1] === '\n')) continue;
    if (m[0] === '\ufeff' && at === 0) continue;
    if ((m[0] === '\ufe0f' || m[0] === '\ufe0e') && at > 0) {
      const low = text.charCodeAt(at - 1) >= 0xdc00 && text.charCodeAt(at - 1) <= 0xdfff;
      if (EMOJI.test(String.fromCodePoint(text.codePointAt(low ? at - 2 : at - 1) ?? 0))) continue;
    }
    if (m[0] === '\u200d' && at > 0) {
      const low = text.charCodeAt(at - 1) >= 0xdc00 && text.charCodeAt(at - 1) <= 0xdfff;
      const prev = String.fromCodePoint(text.codePointAt(low ? at - 2 : at - 1) ?? 0);
      const next = String.fromCodePoint(text.codePointAt(at + 1) ?? 0);
      if (PICTO.test(prev) && PICTO.test(next)) continue;
    }
    out.push({ c: m[0], at });
  }
  return out;
}

/** The first hidden character of `text` (the input rules' class, a tab left out), or undefined. */
export function firstHiddenChar(text: string): string | undefined {
  return hiddenChars(text).find((h) => h.c !== '\t')?.c;
}

/** 1-based line and column of an offset. */
export function lineColOf(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: offset - start + 1 };
}

/** The 1-based line of each offset (ascending), in one pass. */
function linesOf(text: string, offsets: readonly number[]): number[] {
  const out: number[] = [];
  let line = 1;
  let from = 0;
  for (const at of offsets) {
    for (let i = text.indexOf('\n', from); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) {
      line++;
      from = i + 1;
    }
    out.push(line);
  }
  return out;
}

/**
 * Why `text` may not be written in place of `base` (critique B9, review A L2), or null: a hidden character on a line
 * `base` does not have word for word (a new one, or one moved — from a comment into a value), else one it holds more
 * of than `base` does (a copied line) — the first such occurrence named with its line and column.
 */
export function newHiddenCharProblem(text: string, base: string): string | null {
  const found = hiddenChars(text);
  if (!found.length) return null;
  const say = (f: { c: string; at: number }) => {
    const { line, col } = lineColOf(text, f.at);
    return `line ${line}, column ${col} holds ${hiddenCharName(f.c)}: the Studio never writes one (it reads as nothing, or as a line break, in an editor) — remove it`;
  };
  const baseLines = new Set(base.split('\n'));
  const lines = text.split('\n');
  const lineNos = linesOf(text, found.map((f) => f.at));
  const moved = found.findIndex((_, i) => !baseLines.has(lines[lineNos[i] - 1] ?? ''));
  if (moved !== -1) return say(found[moved]);
  const have = new Map<string, number>();
  for (const { c } of hiddenChars(base)) have.set(c, (have.get(c) ?? 0) + 1);
  const now = new Map<string, number>();
  for (const { c } of found) now.set(c, (now.get(c) ?? 0) + 1);
  for (const [c, n] of now) {
    if (n <= (have.get(c) ?? 0)) continue;
    // Every occurrence is on a line the base has: the extra one is a copy — name the last.
    return say(found.filter((f) => f.c === c).at(-1)!);
  }
  return null;
}

/**
 * Why a single value typed in a Studio form is refused (critique B9; the forms of a later part), or null: any hidden
 * character (a tab is fine), a line break in a single-line field, more than 10,000 characters. `field` names it.
 */
export function editValueProblem(value: string, o: { field: IssuePath | string; multiline?: boolean }): string | null {
  const field = typeof o.field === 'string' ? o.field : formatPath(o.field);
  if (value.length > 10_000) return `${field}: at most 10,000 characters (${value.length.toLocaleString('en')})`;
  if (!o.multiline && /[\r\n]/.test(value)) return `${field}: one line only (no line break)`;
  for (const { c } of hiddenChars(value)) if (c !== '\t') return `${field} holds ${hiddenCharName(c)}: the Studio never writes one — remove it`;
  return null;
}

/** The sections of a scenario that run on this Mac: a save from the Studio leaves them unchanged. */
export const HOOK_SECTIONS = ['setup', 'teardown', 'hooks', 'mocks'] as const;

/**
 * The hook sections (HOOK_SECTIONS) of `next` that differ from `base`'s (parsed YAML values; a section absent and one
 * written empty differ only in text, so both count as none). `base` undefined (it does not parse): every section
 * `next` has counts as changed.
 */
export function changedHookSections(base: unknown, next: unknown): string[] {
  const section = (v: unknown, k: string): string => {
    const s = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
    return s === undefined || s === null || (Array.isArray(s) && s.length === 0) ? '' : canonicalJson(s);
  };
  return HOOK_SECTIONS.filter((k) => (base === undefined ? section(next, k) !== '' : section(base, k) !== section(next, k)));
}

/** What hooks and mocks read from the scenario (review A H1): its vars (templated into them) and its environment. */
export const HOOK_INPUTS = ['vars', 'env'] as const;

/**
 * The hook inputs (HOOK_INPUTS) of `next` that differ from `base`'s, when `base` has any hook or mock (review A H1: a
 * var templated into a shell hook is a command; another env runs the hooks against another product) — else none. An
 * absent section and an empty one are the same. `base` undefined (it does not parse): none (changedHookSections then
 * refuses any hook `next` has).
 */
export function changedHookInputs(base: unknown, next: unknown): string[] {
  const field = (v: unknown, k: string): string => {
    const s = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
    return s === undefined || s === null || (typeof s === 'object' && Object.keys(s).length === 0) ? '' : canonicalJson(s);
  };
  if (base === undefined || !HOOK_SECTIONS.some((k) => field(base, k) !== '')) return [];
  return HOOK_INPUTS.filter((k) => field(base, k) !== field(next, k));
}

/** The refusal of a Studio save that changes what the file's hooks read (review A H1). */
export function hookInputsChangedMessage(fields: readonly string[]): string {
  return `${fields.join(' and ')} changed: this scenario has hooks or mocks, which read its vars and its environment and run on this Mac, so the Studio saves it only with vars and env unchanged — change them in your editor`;
}

/** The refusal of a Studio save that changes hooks (critique B3). */
export function hooksChangedMessage(sections: readonly string[]): string {
  return `${sections.join(', ')} changed: hooks and mocks run on this Mac, so the Studio saves a scenario only with them unchanged — edit them in your editor`;
}

/**
 * The verify of an edit built from a value (plan §3.1.4): `text` re-parsed with parseYaml (syntax, recursive aliases,
 * an alias before its anchor) must give exactly `intended`. Null when it does, else why not.
 */
export function verifyEditText(text: string, intended: unknown): string | null {
  const parsed = parseYaml(text);
  if (parsed.value === undefined || parsed.issues.some((i) => i.severity === 'error')) {
    const first = parsed.issues.find((i) => i.severity === 'error');
    return `the edit would not give valid YAML${first ? ` (${first.message}${first.line !== undefined ? `, line ${first.line}` : ''})` : ''}`;
  }
  if (!isDeepStrictEqual(parsed.value, intended)) return 'the edit cannot be made without changing other parts of the file — change it in the YAML tab';
  return null;
}

/** The line break a text mostly uses (CR LF when most of its line breaks are CR LF). */
export function textEol(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const all = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 >= all ? '\r\n' : '\n';
}
