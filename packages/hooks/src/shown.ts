/**
 * A hook as a person reads it before saying yes to it — an approval through MCP or the Studio, a replay of a journal
 * entry Retake did not sign: every field in full on a line of its own, every hidden character written out.
 */
import { showHiddenChars, showHiddenCharsLine } from '@retake/core';
import type { RollbackAction } from './types.js';

/** Text shown to a person: every control, bidirectional or invisible character written out (`\u{1b}`), newlines kept (core). */
export const visible = showHiddenChars;

/** What a hook (or its rollback) does, field by field: the shape fieldLines shows. */
export type ShownAction =
  | { kind: 'shell'; run: string; cwd?: string; env?: Record<string, string>; timeout?: number }
  | { kind: 'http'; method: string; url: string; headers?: Record<string, string>; json?: unknown; body?: string }
  | { kind: 'sql'; db?: string; file?: string; query?: string }
  | { kind: 'js'; page?: string; file?: string; code?: string };

/**
 * One field: `name: value` (a value that is not a string as JSON), every hidden character written out; each further
 * line of a value on a line of its own after `  | `, so a value never reads as another field. Undefined: no line.
 */
export function fieldLines(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  const [first, ...rest] = visible(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))).split('\n');
  // The name too (an env or header key is the hook author's text): on its own line, every character visible.
  return [`${showHiddenCharsLine(name)}: ${first}`, ...rest.map((l) => `  | ${l}`)];
}

/** Every field of an action, one per line (fieldLines), each name after `prefix` (`rollback `). */
export function actionLines(a: ShownAction, prefix = ''): string[] {
  const out: string[] = [];
  const field = (name: string, value: unknown) => out.push(...fieldLines(`${prefix}${name}`, value));
  switch (a.kind) {
    case 'shell':
      field('run', a.run);
      field('cwd', a.cwd);
      for (const [k, v] of Object.entries(a.env ?? {})) field(`env ${k}`, v);
      field('timeout (s)', a.timeout);
      break;
    case 'http':
      field('method', a.method.toUpperCase());
      field('url', a.url);
      for (const [k, v] of Object.entries(a.headers ?? {})) field(`header ${k}`, v);
      field('json', a.json);
      field('body', a.body);
      break;
    case 'sql':
      field('db', a.db);
      field('file', a.file);
      field('query', a.query);
      break;
    case 'js':
      field('page', a.page);
      field('file', a.file);
      field('code', a.code);
      break;
  }
  return out;
}

/** A journaled rollback action as fields (its templates as they stand: the caller fills them first when it can). */
export function shownRollback(a: RollbackAction): ShownAction {
  switch (a.kind) {
    case 'shell':
      return { kind: 'shell', run: a.run, ...(a.cwd !== undefined ? { cwd: a.cwd } : {}), ...(a.env ? { env: a.env } : {}), ...(a.timeout !== undefined ? { timeout: a.timeout } : {}) };
    case 'http': {
      const r = a.request;
      return { kind: 'http', method: r.method ?? 'GET', url: r.url, ...(r.headers ? { headers: r.headers } : {}), ...(r.json !== undefined ? { json: r.json } : {}), ...(r.body !== undefined ? { body: r.body } : {}) };
    }
    case 'sql':
      return { kind: 'sql', db: a.db, ...(a.file !== undefined ? { file: a.file } : {}), query: a.query };
    case 'js':
      return { kind: 'js', ...(a.page !== undefined ? { page: a.page } : {}), code: a.code };
  }
}
