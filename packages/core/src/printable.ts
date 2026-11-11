/**
 * Text a person or a model reads, made safe to show: the character classes that reorder or hide text (the bidirectional
 * formatting characters, the invisible format characters), third-party text made printable on one line
 * (printableText), and every hidden character written out before a person says yes to a text (showHiddenChars).
 * Pure; shared by the agent rules, the frame comments, the hooks' and the engine's messages.
 */

/**
 * The bidirectional formatting characters (they reorder what a terminal or a Markdown viewer shows), as the source of a
 * RegExp character class (use the `u` flag).
 */
export const BIDI_CONTROL_CHARS = '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069';
/**
 * Invisible format characters \u2014 zero-width space, word joiner and the invisible operators (U+2060\u20132064), the byte-order
 * mark / zero-width no-break space, the tag characters (U+E0000\u2013E007F) \u2014: a reader sees nothing where a model still
 * reads text. The source of a RegExp character class (use the `u` flag). ZWJ / ZWNJ stay (scripts and emoji need them).
 */
export const INVISIBLE_FORMAT_CHARS = '\\u200b\\u2060-\\u2064\\ufeff\\u{e0000}-\\u{e007f}';
const INVISIBLE_G = new RegExp(`[${INVISIBLE_FORMAT_CHARS}]+`, 'gu');
// eslint-disable-next-line no-control-regex
const UNPRINTABLE_G = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${BIDI_CONTROL_CHARS}]+`, 'gu');

/**
 * Third-party text made printable on one line: invisible format characters removed (INVISIBLE_FORMAT_CHARS), C0 / C1
 * controls, DEL and the bidirectional formatting characters replaced by a space, runs of spaces collapsed.
 */
export function printableText(s: string): string {
  return s.replace(INVISIBLE_G, '').replace(UNPRINTABLE_G, ' ').replace(/\s+/g, ' ').trim();
}
/** Spaces other than U+0020, joiners, fillers and variation selectors: they read as a space or as nothing. */
const LOOKALIKE_CHARS = '\\u00a0\\u034f\\u115f\\u1160\\u1680\\u180e\\u2000-\\u200a\\u200c\\u200d\\u202f\\u205f\\u3000\\u3164\\ufe00-\\ufe0f\\uffa0\\u{e0100}-\\u{e01ef}';
// eslint-disable-next-line no-control-regex
const HIDDEN_G = new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u2028\\u2029${BIDI_CONTROL_CHARS}${INVISIBLE_FORMAT_CHARS}${LOOKALIKE_CHARS}]`, 'gu');

/**
 * Text a person reads before saying yes to it, every character there: each control (newlines kept), soft hyphen, line or
 * paragraph separator, bidirectional or invisible character, space other than U+0020, joiner, filler or variation
 * selector written out as `\u{1b}`.
 */
export function showHiddenChars(s: string): string {
  return s.replace(HIDDEN_G, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

/** showHiddenChars on one line: a newline written out too (`\u{a}`) — a name, a key, a heading. */
export function showHiddenCharsLine(s: string): string {
  return showHiddenChars(s).replace(/\n/g, '\\u{a}');
}
