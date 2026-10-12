/**
 * Figures as people write them ("€720.00", "1 240 bags", "12,5 %", "-3.4k"): parse the number with its prefix, suffix,
 * decimals and separators, and format another value the same way — an animated counter ends exactly on the text it
 * was given. Pure (no React).
 */

export interface FigureFormat {
  /** Text before the number ("€", "Total: "). */
  prefix: string;
  /** Text after the number (" offers", "%", "k"). */
  suffix: string;
  value: number;
  decimals: number;
  /** Thousands separator ("," "." " " " " "'" or ""). */
  group: string;
  /** Decimal separator ("." or ","). */
  decimal: string;
  /** The minus sign as written ("-" or "−"), when negative. */
  minus?: string;
}

const GROUPS = [',', '.', ' ', ' ', ' ', "'", '’'];

/** The first number of a text, with how it is written; null when the text has no digit. */
export function parseFigure(text: string): FigureFormat | null {
  const m = /([-−+]?)(\d[\d,.   '’]*\d|\d)/.exec(text);
  if (!m) return null;
  const sign = m[1];
  let body = m[2];
  let end = m.index + m[0].length;
  // A trailing group separator belongs to the text ("12, then") — the regex never ends on one, nothing to do.
  const seps = [...body.matchAll(/[^\d]/g)].map((x) => ({ ch: x[0], at: x.index! }));
  let group = '';
  let decimal = '.';
  let decimals = 0;
  if (seps.length > 0) {
    const last = seps[seps.length - 1];
    const tail = body.length - last.at - 1;
    const kinds = [...new Set(seps.map((s) => s.ch))];
    if (kinds.length >= 2) {
      // "1,234.56" / "1.234,56" / "1 234,5": the last separator is the decimal one.
      decimal = last.ch;
      decimals = tail;
      group = seps[0].ch;
    } else if (seps.length === 1 && (last.ch === '.' || last.ch === ',') && tail !== 3) {
      // "720.00", "12,5": a decimal separator.
      decimal = last.ch;
      decimals = tail;
    } else if (seps.length === 1 && last.ch === '.' && tail === 3 && /^0/.test(body)) {
      decimal = '.';
      decimals = 3;
    } else {
      // "1,234", "1 234 567", "1.234.567": thousands.
      group = last.ch;
    }
    // Groups must be 1–3 digits then threes ("1,234,567"); otherwise ("12 34", "3.14.15") the number is its leading
    // digits with at most one decimal part, and the rest belongs to the suffix.
    if (group && !GROUPS.includes(group)) group = '';
    const intPart = decimals > 0 ? body.slice(0, body.length - decimals - 1) : body;
    const parts = group ? intPart.split(group) : [intPart];
    const valid = parts.every((p, i) => /^\d+$/.test(p) && (!group || (i === 0 ? p.length <= 3 : p.length === 3)));
    if (!valid) {
      const lead = /^(\d+)(?:([.,])(\d+))?/.exec(body)!;
      end = m.index + sign.length + lead[0].length;
      body = lead[0];
      group = '';
      decimal = lead[2] ?? '.';
      decimals = lead[3]?.length ?? 0;
    }
  }
  const intDigits = (decimals > 0 ? body.slice(0, body.length - decimals - 1) : body).replace(/[^\d]/g, '');
  const fracDigits = decimals > 0 ? body.slice(body.length - decimals) : '';
  const value = Number(`${intDigits}${fracDigits ? `.${fracDigits}` : ''}`) * (sign === '-' || sign === '−' ? -1 : 1);
  const out: FigureFormat = {
    prefix: text.slice(0, m.index) + (sign === '+' ? '+' : ''),
    suffix: text.slice(end),
    value,
    decimals,
    group,
    decimal,
  };
  if (sign === '-' || sign === '−') out.minus = sign;
  return out;
}

/** `value` written like `f` (same prefix, suffix, separators and decimals). */
export function formatFigure(value: number, f: Pick<FigureFormat, 'prefix' | 'suffix' | 'decimals' | 'group' | 'decimal' | 'minus'>): string {
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(f.decimals);
  const [int, frac] = fixed.split('.');
  const grouped = f.group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, f.group) : int;
  const num = frac !== undefined ? `${grouped}${f.decimal}${frac}` : grouped;
  return `${f.prefix}${neg ? (f.minus ?? '-') : ''}${num}${f.suffix}`;
}

/**
 * The text of a counter at progress `p` (0..1, already eased) from `from` to the figure's value: the original text at
 * p = 1, the intermediate values formatted like it.
 */
export function figureAt(text: string, p: number, from = 0): string {
  const f = parseFigure(text);
  if (!f) return text;
  if (p >= 1) return text;
  return formatFigure(from + (f.value - from) * Math.max(0, p), f);
}

/** A number from a table cell or a value as written ("1,234.5", "€ 12,50", "35 %", "−4"); NaN when there is none. */
export function parseNumber(text: string | number): number {
  if (typeof text === 'number') return text;
  const f = parseFigure(text);
  return f ? f.value : NaN;
}
