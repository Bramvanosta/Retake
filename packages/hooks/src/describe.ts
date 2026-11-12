import { sqlSource } from '@retake/core/hooks';
import type { HookKind, HookStep, HttpHookSpec, JsHookSpec, ShellHookSpec, SqlHookSpec } from '@retake/core/model';
import { HookError } from './errors.js';
import { actionLines } from './shown.js';
import type { ShownAction } from './shown.js';
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

/**
 * A hook as its file declares it (template form, no secret resolved), field by field, then its rollback's when
 * `rollback` (a setup or step hook's: the ones that journal one): what an approval shows of a hook it could not template
 * — and of a sandbox's seed step (shown.ts). Empty for a malformed entry.
 */
export function declaredHookLines(hook: HookStep, o: { rollback?: boolean } = {}): string[] {
  let kind: HookKind;
  try {
    kind = hookKindOf(hook);
  } catch {
    return [];
  }
  const out: string[] = [];
  const rb = (a: ShownAction | undefined) => {
    if (a && o.rollback) out.push(...actionLines(a, 'rollback '));
  };
  switch (kind) {
    case 'http': {
      const { rollback, save_as: _s, ...req } = (hook as { http: HttpHookSpec }).http;
      out.push(...actionLines(shownHttp(req)));
      rb(rollback ? shownHttp(rollback) : undefined);
      break;
    }
    case 'sql': {
      const spec = (hook as { sql: string | SqlHookSpec }).sql;
      const db = typeof spec === 'object' ? spec.db : undefined;
      out.push(...actionLines({ kind: 'sql', ...(db !== undefined ? { db } : {}), ...sqlSource(spec) }));
      const r = typeof spec === 'object' ? spec.rollback : undefined;
      rb(r === undefined ? undefined : { kind: 'sql', ...(db !== undefined ? { db } : {}), ...(typeof r === 'string' ? sqlSource(r) : r) });
      break;
    }
    case 'shell': {
      const spec = (hook as { shell: string | ShellHookSpec }).shell;
      const s: ShellHookSpec = typeof spec === 'string' ? { run: spec } : spec;
      const where = { ...(s.cwd !== undefined ? { cwd: s.cwd } : {}), ...(s.env ? { env: s.env } : {}) };
      out.push(...actionLines({ kind: 'shell', run: s.run, ...where, ...(s.timeout !== undefined ? { timeout: s.timeout } : {}) }));
      rb(s.rollback !== undefined ? { kind: 'shell', run: s.rollback, ...where } : undefined);
      break;
    }
    case 'js': {
      const spec = (hook as { js: string | JsHookSpec }).js;
      const s: JsHookSpec = typeof spec === 'string' ? { code: spec } : spec;
      const page = s.page !== undefined ? { page: s.page } : {};
      out.push(...actionLines({ kind: 'js', ...page, ...(s.file !== undefined ? { file: s.file } : { code: s.code ?? '' }) }));
      rb(s.rollback !== undefined ? { kind: 'js', ...page, code: s.rollback } : undefined);
      break;
    }
  }
  return out;
}

function shownHttp(r: { method?: string; url: string; headers?: Record<string, string>; json?: unknown; body?: string }): ShownAction {
  return {
    kind: 'http',
    method: r.method ?? 'GET',
    url: r.url,
    ...(r.headers && Object.keys(r.headers).length ? { headers: r.headers } : {}),
    ...(r.json !== undefined ? { json: r.json } : {}),
    ...(r.body !== undefined ? { body: r.body } : {}),
  };
}
