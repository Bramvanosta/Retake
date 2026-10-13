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
      // Postgres block comments nest.
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
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      const escapes = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      if (c === '"' && opts.identifiers) {
        out[i] = ' ';
        for (let k = i + 1; k < Math.min(j, sql.length); k++) if (!/[A-Za-z0-9_$]/.test(out[k])) out[k] = out[k] === '\n' ? '\n' : '_';
        if (j < sql.length) out[j] = ' ';
      } else blank(i + 1, Math.min(j, sql.length));
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      const prev = sql[i - 1] ?? '';
      if (m && !/[\w$]/.test(prev)) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        blank(i + tag.length, end < 0 ? sql.length : end);
        i = stop;
      } else i++;
    } else i++;
  }
  return out.join('');
}
