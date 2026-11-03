import { sqlSource } from '@retake/core';
import type { HookKind, HookStep, HttpHookSpec, JsHookSpec, ShellHookSpec, SqlHookSpec } from '@retake/core';
import { HookError } from './errors.js';
import { oneLine } from './util.js';

const KINDS: readonly HookKind[] = ['http', 'sql', 'shell', 'js'];

/** The hook's kind; throws when the entry does not carry exactly one of http, sql, shell, js. */
export function hookKindOf(hook: HookStep): HookKind {
  if (hook === null || typeof hook !== 'object' || Array.isArray(hook)) {
    throw new HookError('a hook must be a mapping with one of: http, sql, shell, js');
  }
  const kinds = KINDS.filter((k) => Object.hasOwn(hook, k));
  if (kinds.length !== 1) {
    const keys = Object.keys(hook).join(', ') || '(none)';
    throw new HookError(
      kinds.length === 0
        ? `a hook needs one of: http, sql, shell, js (keys: ${keys})`
        : `a hook has several types (${kinds.join(', ')}); split it into separate hooks`,
    );
  }
  return kinds[0];
}

export function describeHttp(method: string, url: string): string {
  return `http ${method} ${url}`;
}

export function describeSql(source: { file?: string; query?: string }, db?: string): string {
  const what = source.file ?? `"${oneLine(source.query ?? '', 60)}"`;
  return `sql ${what}${db ? ` on ${db}` : ''}`;
}

export function describeShell(run: string): string {
  return `shell "${oneLine(run, 80)}"`;
}

export function describeJs(source: { file?: string; code?: string }, page?: string): string {
  const what = source.file ?? `"${oneLine(source.code ?? '', 60)}"`;
  return `js ${what}${page ? ` on page ${page}` : ''}`;
}

export function withName(name: string | undefined, description: string): string {
  return name ? `${name}: ${description}` : description;
}

/**
 * Short human description of a hook in its template form (no secret is ever resolved):
 * `http POST {{console}}/api/replies → hooks.reply`, `sql hooks/reset.sql on main`, `shell "pnpm seed"`.
 */
export function describeHook(hook: HookStep): string {
  let kind: HookKind;
  try {
    kind = hookKindOf(hook);
  } catch {
    return 'invalid hook';
  }
  let body: string;
  switch (kind) {
    case 'http': {
      const spec = (hook as { http: HttpHookSpec }).http;
      body = describeHttp(spec.method ?? 'GET', spec.url) + (spec.save_as ? ` → hooks.${spec.save_as}` : '');
      break;
    }
    case 'sql': {
      const spec = (hook as { sql: string | SqlHookSpec }).sql;
      body = describeSql(sqlSource(spec), typeof spec === 'object' ? spec.db : undefined);
      break;
    }
    case 'shell': {
      const spec = (hook as { shell: string | ShellHookSpec }).shell;
      body = describeShell(typeof spec === 'string' ? spec : spec.run);
      break;
    }
    case 'js': {
      const spec = (hook as { js: string | JsHookSpec }).js;
      body = typeof spec === 'string' ? describeJs({ code: spec }) : describeJs(spec, spec.page);
      break;
    }
  }
  return withName(hook.name, body);
}

/** A setup hook's rollback in its template form (no secret resolved), or undefined: what an approval shows of it. */
export function describeRollback(hook: HookStep): string | undefined {
  let kind: HookKind;
  try {
    kind = hookKindOf(hook);
  } catch {
    return undefined;
  }
  switch (kind) {
    case 'http': {
      const rb = (hook as { http: HttpHookSpec }).http.rollback;
      return rb ? describeHttp((rb.method ?? 'GET').toUpperCase(), rb.url) : undefined;
    }
    case 'sql': {
      const spec = (hook as { sql: string | SqlHookSpec }).sql;
      const rb = typeof spec === 'object' ? spec.rollback : undefined;
      return rb === undefined ? undefined : describeSql(typeof rb === 'string' ? sqlSource(rb) : rb, typeof spec === 'object' ? spec.db : undefined);
    }
    case 'shell': {
      const spec = (hook as { shell: string | ShellHookSpec }).shell;
      return typeof spec === 'object' && spec.rollback !== undefined ? describeShell(spec.rollback) : undefined;
    }
    case 'js': {
      const spec = (hook as { js: string | JsHookSpec }).js;
      return typeof spec === 'object' && spec.rollback !== undefined ? describeJs({ code: spec.rollback }, spec.page) : undefined;
    }
  }
}
