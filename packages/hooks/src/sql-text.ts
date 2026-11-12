import { maskSql } from '@retake/core/base';

/** The SQL masking lives in core (the read-only classifier uses it too). */
export { maskSql };

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
