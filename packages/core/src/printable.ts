/**
 * Text a person or a model reads, made safe to show: third-party text made printable on one line (printableText), and
 * every hidden character written out before a person says yes to a text (showHiddenChars). The character classes are
 * hidden-chars.ts's. Pure; shared by the agent rules, the frame comments, the hooks' and the engine's messages.
 */

import { HIDDEN_CHARS, SPACE_LOOKALIKES, stripHidden } from './hidden-chars.js';

/**
 * Third-party text made printable on one line: its hidden characters (hidden-chars.ts HIDDEN_CHARS, an emoji
 * sequence's joiner and selector kept) out — controls, line breaks and direction controls as a space, the invisible and
 * format ones removed —, runs of spaces collapsed.
 */
export function printableText(s: string): string {
  return stripHidden(s).replace(/\s+/g, ' ').trim();
}

// Every hidden character (hidden-chars.ts) and every space but U+0020; a line feed is kept (showHiddenCharsLine writes it).
const HIDDEN_G = new RegExp(`(?!\\n)[${HIDDEN_CHARS}${SPACE_LOOKALIKES}]`, 'gu');

/**
 * Text a person reads before saying yes to it, every character there: each hidden character (hidden-chars.ts
 * HIDDEN_CHARS: controls but the line feed, format and default-ignorable characters, line or paragraph separators,
 * fillers, the braille blank) and each space other than U+0020 written out as `\u{1b}`.
 */
export function showHiddenChars(s: string): string {
  return s.replace(HIDDEN_G, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

/** showHiddenChars on one line: a newline written out too (`\u{a}`) — a name, a key, a heading. */
export function showHiddenCharsLine(s: string): string {
  return showHiddenChars(s).replace(/\n/g, '\\u{a}');
}
