/**
 * Blank out comments, string literals, quoted identifiers and dollar-quoted bodies (same length,
 * so offsets are preserved): what remains are the SQL keywords and statement separators.
 */
export function maskSql(sql: string): string {
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
      blank(i + 1, Math.min(j, sql.length));
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

const TX_WORDS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'ABORT']);

/**
 * The first transaction-control statement of a SQL text (BEGIN, COMMIT, ROLLBACK, END, ABORT,
 * START TRANSACTION), or null. `ROLLBACK TO SAVEPOINT`, PL/pgSQL bodies and `BEGIN ATOMIC … END`
 * function bodies are not transaction control.
 */
export function transactionControl(sql: string): string | null {
  const statements = maskSql(sql).split(';');
  let atomicBody = false;
  for (const stmt of statements) {
    const words = stmt.trim().toUpperCase().match(/[A-Z_]+/g) ?? [];
    if (atomicBody) {
      if (words[0] === 'END') atomicBody = false;
      continue;
    }
    if (/\bBEGIN\s+ATOMIC\b/i.test(stmt)) {
      atomicBody = !/\bEND\s*$/i.test(stmt.trim());
      continue;
    }
    const [first, second] = words;
    if (!first) continue;
    if (first === 'ROLLBACK' && (second === 'TO' || second === 'PREPARED')) continue;
    if (first === 'COMMIT' && second === 'PREPARED') continue;
    if (TX_WORDS.has(first)) return first;
    if (first === 'START' && second === 'TRANSACTION') return 'START TRANSACTION';
  }
  return null;
}

/** 1-based line of a 1-based character position (Postgres error `position`). */
export function lineAt(text: string, position: number): number {
  let line = 1;
  const end = Math.min(position - 1, text.length);
  for (let i = 0; i < end; i++) if (text[i] === '\n') line++;
  return line;
}
