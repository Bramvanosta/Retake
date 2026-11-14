/**
 * What a "hidden character" is, written once: a character a person cannot see, or cannot tell from another, where a
 * program (a model, a shell, YAML) still reads one. Each constant is the source of a RegExp character class (use the
 * `u` flag) written with escapes only, so that the file shows what it holds.
 *
 * - HIDDEN_CHARS, the class every rule starts from: controls, format and default-ignorable characters (direction
 *   controls, zero widths, soft hyphen, joiners, variation selectors, the tag characters…), line and paragraph
 *   separators, the Hangul fillers and the braille blank. The Studio never writes one into a scenario (scenario-edit.ts,
 *   which leaves out tab, line feed, a CR LF's carriage return, a BOM at offset 0 and an emoji sequence's joiner or
 *   presentation selector); the Studio's YAML view names them; the "Create with Claude" prompt drops them.
 * - SPACE_LOOKALIKES: every space separator but U+0020 (a no-break space looks like a space). Not hidden in a scenario
 *   (a French text has them), but written out wherever a person compares or approves text character by character
 *   (showHiddenChars, the Studio's diff).
 * - BIDI_CONTROL_CHARS and INVISIBLE_FORMAT_CHARS: the two parts of HIDDEN_CHARS that printableText takes out of
 *   third-party text shown on one line (the ones that reorder text, and the ones that hide text from a reader).
 * - PICTOGRAPH_CHARS and EMOJI_CHARS: what an emoji sequence's zero-width joiner joins and what a variation selector
 *   may follow — the one exception to HIDDEN_CHARS a text keeps.
 *
 * The Studio's front end imports types only: packages/ui/src/app/hidden-chars.ts mirrors these sources, and
 * packages/ui/test/hidden-chars.test.ts holds the mirror to them.
 */

/** Controls, format and default-ignorable characters, line / paragraph separators, the Hangul fillers, the braille blank. */
export const HIDDEN_CHARS = '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u115f\\u1160\\u2800\\u3164\\uffa0';

/** The space separators other than U+0020 (Unicode's `Zs`, written out). */
export const SPACE_LOOKALIKES = '\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000';

/** The bidirectional formatting characters (they reorder what a terminal or a Markdown viewer shows). */
export const BIDI_CONTROL_CHARS = '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069';

/**
 * Invisible format characters — zero-width space, word joiner and the invisible operators (U+2060–2064), the byte-order
 * mark / zero-width no-break space, the tag characters (U+E0000–E007F) —: a reader sees nothing where a model still
 * reads text. ZWJ / ZWNJ are not in it (scripts and emoji need them).
 */
export const INVISIBLE_FORMAT_CHARS = '\\u200b\\u2060-\\u2064\\ufeff\\u{e0000}-\\u{e007f}';

/** What an emoji sequence's zero-width joiner may join (on both sides). */
export const PICTOGRAPH_CHARS = '\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{fe0f}';

/** What a variation selector U+FE0E / U+FE0F may follow (text or emoji presentation: "1", a heart). */
export const EMOJI_CHARS = '\\p{Emoji}';

const PICTO = new RegExp(`[${PICTOGRAPH_CHARS}]`, 'u');
const EMOJI = new RegExp(`[${EMOJI_CHARS}]`, 'u');
const HIDDEN_G = new RegExp(`[${HIDDEN_CHARS}]`, 'gu');
/** The hidden characters that read as a break between words (controls, line / paragraph separators, direction controls). */
const BREAKING = new RegExp(`[\\p{Cc}\\p{Zl}\\p{Zp}${BIDI_CONTROL_CHARS}]`, 'u');

/** The code point that ends just before UTF-16 offset `at`. */
function before(text: string, at: number): string {
  const low = text.charCodeAt(at - 1) >= 0xdc00 && text.charCodeAt(at - 1) <= 0xdfff;
  return String.fromCodePoint(text.codePointAt(low ? at - 2 : at - 1) ?? 0);
}

/**
 * Whether the hidden character at UTF-16 offset `at` of `text` is part of an emoji sequence, the one exception a text
 * keeps: a presentation selector (U+FE0E / U+FE0F) after an emoji, a zero-width joiner between two pictographs.
 */
export function inEmojiSequence(text: string, at: number): boolean {
  const c = text[at];
  if (at === 0) return false;
  if (c === '\ufe0f' || c === '\ufe0e') return EMOJI.test(before(text, at));
  if (c === '\u200d') return PICTO.test(before(text, at)) && PICTO.test(String.fromCodePoint(text.codePointAt(at + 1) ?? 0));
  return false;
}

/**
 * `text` without its hidden characters (HIDDEN_CHARS, an emoji sequence's joiner and selector kept): the ones that
 * break words (controls, line / paragraph separators, direction controls) become a space (`o.spaced`, the default),
 * the others go. `o.keep`: the characters left as they are (a comment keeps its line feeds).
 */
export function stripHidden(text: string, o: { keep?: ReadonlySet<string>; spaced?: boolean } = {}): string {
  const spaced = o.spaced !== false;
  return text.replace(HIDDEN_G, (c: string, at: number) => (o.keep?.has(c) || inEmojiSequence(text, at) ? c : spaced && BREAKING.test(c) ? ' ' : ''));
}

/** Whether `text` holds a hidden character (an emoji sequence's parts and the `keep` characters aside). */
export function hasHidden(text: string, keep: ReadonlySet<string> = new Set()): boolean {
  for (const m of text.matchAll(HIDDEN_G)) if (!keep.has(m[0]) && !inEmojiSequence(text, m.index)) return true;
  return false;
}
