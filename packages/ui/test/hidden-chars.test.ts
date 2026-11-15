/**
 * "Hidden character", written once (core hidden-chars.ts) and used by five surfaces: core's showHiddenChars (text a
 * person approves) and the scenario input rules (firstHiddenChar), and the Studio's diff (linePieces), its YAML view
 * (hiddenLines) and its "Create with Claude" prompt (cleanWords). The Studio imports types only: its mirror
 * (app/words/hidden-chars.ts) is held to core's here, source for source, and one table of code points says what each
 * surface does with each character.
 */
import { describe, expect, it } from 'vitest';
import * as core from '@retake/core/base';
import { firstHiddenChar, showHiddenChars } from '@retake/core';
import { BIDI_CONTROL_CHARS, EMOJI_CHARS, HIDDEN_CHARS, PICTOGRAPH_CHARS, SPACE_LOOKALIKES } from '../src/app/hidden-chars.js';
import { textProblem as recordTextProblem } from '../src/app/words/record-words.js';
import { textProblem as themeTextProblem } from '../src/app/words/theme-words.js';
import { visibleControls } from '../src/app/bits.js';
import { parseUpdateLine } from '../src/server/update-ops.js';
import { linePieces } from '../src/app/words/comment-words.js';
import { cleanWords } from '../src/app/words/library-words.js';
import { hiddenLines } from '../src/app/script/YamlTab.js';

describe('the Studio mirror is core’s classes', () => {
  it('source for source', () => {
    expect([HIDDEN_CHARS, SPACE_LOOKALIKES, PICTOGRAPH_CHARS, EMOJI_CHARS, BIDI_CONTROL_CHARS]).toEqual([
      core.HIDDEN_CHARS,
      core.SPACE_LOOKALIKES,
      core.PICTOGRAPH_CHARS,
      core.EMOJI_CHARS,
      core.BIDI_CONTROL_CHARS,
    ]);
  });
});

/** hidden: a hidden character (the input rules, the YAML view, the prompt); look: a space other than U+0020. */
type Kind = 'hidden' | 'look' | 'tab' | 'plain';
const TABLE: Array<[number, Kind]> = [
  [0x0000, 'hidden'],
  [0x0009, 'tab'],
  [0x001b, 'hidden'],
  [0x007f, 'hidden'],
  [0x0085, 'hidden'],
  [0x00a0, 'look'],
  [0x00ad, 'hidden'],
  [0x034f, 'hidden'],
  [0x061c, 'hidden'],
  [0x115f, 'hidden'],
  [0x1680, 'look'],
  [0x17b4, 'hidden'],
  [0x180e, 'hidden'],
  [0x2007, 'look'],
  [0x200b, 'hidden'],
  [0x200d, 'hidden'],
  [0x200e, 'hidden'],
  [0x2028, 'hidden'],
  [0x2029, 'hidden'],
  [0x202e, 'hidden'],
  [0x202f, 'look'],
  [0x2060, 'hidden'],
  [0x2066, 'hidden'],
  [0x206a, 'hidden'],
  [0x2800, 'hidden'],
  [0x3000, 'look'],
  [0x3164, 'hidden'],
  [0xfe0f, 'hidden'],
  [0xfeff, 'hidden'],
  [0xfff9, 'hidden'],
  [0xffa0, 'hidden'],
  [0x1bca0, 'hidden'],
  [0xe0041, 'hidden'],
  [0xe0100, 'hidden'],
  [0x0020, 'plain'],
  [0x0041, 'plain'],
  [0x00e9, 'plain'],
  [0x05d0, 'plain'],
  [0x1f600, 'plain'],
];

describe.each(TABLE.map(([cp, kind]) => [cp.toString(16).toUpperCase().padStart(4, '0'), cp, kind] as const))('U+%s', (_hex, cp, kind) => {
  const c = String.fromCodePoint(cp);
  const text = `a${c}b`;
  const hidden = kind === 'hidden';

  it('the scenario input rules refuse it when hidden (a tab, a space of any kind is allowed)', () => {
    expect(firstHiddenChar(text)).toBe(hidden ? c : undefined);
  });

  it('the YAML view names it when hidden (a tab left out)', () => {
    expect(hiddenLines(text)).toEqual(hidden ? [`line 1 (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`] : []);
  });

  it('the prompt drops it when hidden, makes a space of any space', () => {
    expect(cleanWords(text)).toBe(kind === 'plain' && cp !== 0x20 ? text : 'a b');
  });

  it('showHiddenChars writes it out when hidden, a tab or a space other than U+0020', () => {
    expect(showHiddenChars(text)).toBe(kind === 'plain' ? text : `a\\u{${cp.toString(16)}}b`);
  });

  it('the diff draws it as a code when hidden or a space other than U+0020 (a tab as a tab)', () => {
    const pieces = linePieces(text);
    expect(pieces.some((p) => p.kind === 'char')).toBe(hidden || kind === 'look');
    expect(pieces.some((p) => p.kind === 'tab')).toBe(kind === 'tab');
  });
});

describe('an emoji sequence keeps its joiner and its presentation selector', () => {
  const coder = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
  const heart = String.fromCodePoint(0x2764, 0xfe0f);

  it.each([coder, heart])('%s', (emoji) => {
    expect(firstHiddenChar(`a ${emoji} b`)).toBeUndefined();
    expect(linePieces(`a ${emoji} b`)).toEqual([{ kind: 'text', text: `a ${emoji} b` }]);
  });

  it('a joiner between letters, a selector after a letter: hidden', () => {
    expect(firstHiddenChar('a\u200db')).toBe('\u200d');
    expect(firstHiddenChar('a\ufe0f')).toBe('\ufe0f');
  });
});

describe('the single-field checks read the same class', () => {
  // Characters the former hand-written lists missed: soft hyphen, a deprecated format control, interlinear annotation,
  // the braille blank, a Hangul filler, a variation selector after a letter.
  const missed = ['\u00ad', '\u206a', '\ufff9', '\u2800', '\u3164', '\ufe0f'];

  it('a caption, kicker or awaited text: one line of visible text', () => {
    expect(recordTextProblem('Order placed', 100)).toBeNull();
    for (const c of [...missed, '\t', '\u202e']) expect(recordTextProblem(`Order${c} placed`, 100), c).toMatch(/One line of visible text/);
  });

  it('an emoji sequence passes both text checks (its joiner and selector are not hidden)', () => {
    for (const e of [String.fromCodePoint(0x2764, 0xfe0f), String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)]) {
      expect(recordTextProblem(`Saved ${e}`, 100), e).toBeNull();
      expect(themeTextProblem('brand.name', `Saved ${e}`), e).toBeNull();
    }
  });

  it('a theme text value: no invisible or direction character', () => {
    expect(themeTextProblem('brand.name', 'Northfield')).toBeNull();
    expect(themeTextProblem('brand.name', 'North\nfield')).toMatch(/one line/);
    for (const c of [...missed, '\u200b', '\u2066']) expect(themeTextProblem('brand.name', `North${c}field`), c).toMatch(/invisible or direction/);
  });

  it('a name shown with its direction controls as marks, the marks and joiners Retake knows included', () => {
    expect(visibleControls('a\u202eb\u200fc\u061cd')).toBe('a[U+202E]b[U+200F]c[U+61C]d');
    expect(visibleControls('plain')).toBe('plain');
  });

  it('an update’s notes: line feeds kept, any other hidden character refuses the line', () => {
    const line = (notes: string) => parseUpdateLine({ type: 'update', state: 'available', current: '0.2.6', version: '0.2.7', checked: null, notes });
    expect(line('Fixes.\nMore fixes.')).not.toBeNull();
    for (const c of [...missed, '\t', '\u202e', '\ufeff']) expect(line(`Fixes${c}.`), c).toBeNull();
  });
});
