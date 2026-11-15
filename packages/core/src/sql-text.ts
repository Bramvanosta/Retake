/**
 * Blank out comments, string literals, quoted identifiers and dollar-quoted bodies (same length,
 * so offsets are preserved): what remains are the SQL keywords and statement separators.
 * `identifiers`: a quoted identifier keeps its name as one word instead (`"transaction_read_only"` reads
 * ` transaction_read_only `, `"my col"` reads ` my_col `) — the read-only classifier judges what it names.
 */
export function maskSql(sql: string, opts: { identifiers?: boolean } = {}): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const j = blockCommentEnd(sql, i);
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      const j = quotedEnd(sql, i);
      if (c === '"' && opts.identifiers) keepIdentifier(out, i, j);
      else blank(i + 1, Math.min(j, sql.length));
      i = j + 1;
    } else if (c === '$') {
      const tag = dollarTag(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        blank(i + tag.length, end < 0 ? sql.length : end);
        i = stop;
      } else i++;
    } else i++;
  }
  return out.join('');
}

/** Index after the block comment opening at sql[i] (Postgres block comments nest). */
function blockCommentEnd(sql: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    if (sql[j] === '/' && sql[j + 1] === '*') {
      depth++;
      j += 2;
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      depth--;
      j += 2;
    } else j++;
  }
  return j;
}

/** Index of the quote closing the string or quoted identifier opening at sql[i] (doubled quotes, E'' escapes), or past the end. */
function quotedEnd(sql: string, i: number): number {
  const c = sql[i];
  const escapes = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !/\w/.test(sql[i - 2] ?? '');
  let j = i + 1;
  while (j < sql.length) {
    if (escapes && sql[j] === '\\') j += 2;
    else if (sql[j] === c && sql[j + 1] === c) j += 2;
    else if (sql[j] === c) break;
    else j++;
  }
  return j;
}

/** A quoted identifier from sql[i] to its closing quote at j kept as one word: quotes blanked, other characters `_`. */
function keepIdentifier(out: string[], i: number, j: number): void {
  out[i] = ' ';
  for (let k = i + 1; k < Math.min(j, out.length); k++) if (!/[A-Za-z0-9_$]/.test(out[k])) out[k] = out[k] === '\n' ? '\n' : '_';
  if (j < out.length) out[j] = ' ';
}

/** The dollar-quote tag (`$$`, `$body$`) opening at sql[i], or undefined (a `$` inside a word or a `$1` parameter). */
function dollarTag(sql: string, i: number): string | undefined {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
  const prev = sql[i - 1] ?? '';
  return m && !/[\w$]/.test(prev) ? m[0] : undefined;
}
