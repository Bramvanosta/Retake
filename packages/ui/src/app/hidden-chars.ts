/**
 * Core's hidden characters (core hidden-chars.ts), as the Studio's front end uses them: it imports types only, so the
 * sources are written again here, and packages/ui/test/hidden-chars.test.ts holds them to core's, source for source.
 * Read core's header for what each one holds and who uses it.
 */

/** Controls, format and default-ignorable characters, line / paragraph separators, the Hangul fillers, the braille blank. */
export const HIDDEN_CHARS = '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u115f\\u1160\\u2800\\u3164\\uffa0';

/** The space separators other than U+0020. */
export const SPACE_LOOKALIKES = '\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000';

/** The bidirectional formatting characters (they reorder what is shown). */
export const BIDI_CONTROL_CHARS = '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069';

/** What an emoji sequence's zero-width joiner may join (on both sides). */
export const PICTOGRAPH_CHARS = '\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{fe0f}';

/** What a variation selector U+FE0E / U+FE0F may follow. */
export const EMOJI_CHARS = '\\p{Emoji}';

const HIDDEN = new RegExp(`[${HIDDEN_CHARS}]`, 'u');
const PICTO = new RegExp(`[${PICTOGRAPH_CHARS}]`, 'u');
const EMOJI = new RegExp(`[${EMOJI_CHARS}]`, 'u');

/**
 * Whether `text` holds a hidden character, an emoji sequence's parts aside (core hasHidden): a presentation selector
 * after an emoji, a zero-width joiner between two pictographs.
 */
export function hasHidden(text: string): boolean {
  const chars = Array.from(text);
  return chars.some((c, i) => {
    if (!HIDDEN.test(c)) return false;
    const prev = chars[i - 1] ?? '';
    if ((c === '️' || c === '︎') && EMOJI.test(prev)) return false;
    return !(c === '‍' && PICTO.test(prev) && PICTO.test(chars[i + 1] ?? ''));
  });
}
