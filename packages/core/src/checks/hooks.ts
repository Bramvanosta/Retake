import { destructiveReason, hookKind, sqlSource } from '../destructive.js';
import { allowedHosts, isHostAllowed } from '../hosts.js';
import type { IssuePath } from '../issues.js';
import { shellHostRefs } from '../shell-hosts.js';
import type { HookStep, HttpHookSpec, JsHookSpec, LoadedProject, ShellHookSpec, SqlHookSpec } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';

export interface HookCheckOptions {
  /** Page keys a js hook may name (undefined → not checked). */
  pages?: readonly string[];
  /** `save_as` names seen so far (shared across setup / teardown); filled by this check. */
  saved: Set<string>;
  /** The project whose allow-list shell hooks are checked against (undefined → not checked). */
  project?: Pick<LoadedProject, 'config'>;
  /**
   * Destructive hooks need no `confirm: true` (sandbox seeds, L1.8: they rebuild a local, disposable copy). Their files
   * are read from the check context's directory (the sandbox folder) either way.
   */
  destructiveOk?: boolean;
  /** Why an http hook cannot take `auth: {persona}` here (a sandbox seed: no session exists yet); absent: it can. */
  noPersonaAuth?: string;
}

/**
 * Hosts a shell hook names in its literal text that the allow-list refuses (R-SEC-06). Parts computed at run time
 * (`$VAR`, `$(…)`, `{{…}}`) are skipped here: the runtime check expands them and may refuse more.
 */
function checkShellHosts(spec: string | ShellHookSpec, kp: IssuePath, ctx: CheckContext, project: Pick<LoadedProject, 'config'>): void {
  const s: ShellHookSpec = typeof spec === 'string' ? { run: spec } : spec;
  const at = (key: 'run' | 'rollback') => (typeof spec === 'string' ? kp : [...kp, key]);
  const report = (refs: ReturnType<typeof shellHostRefs>, path: (envKey?: string) => IssuePath) => {
    for (const r of refs) {
      if (r.unresolved || isHostAllowed(r.host, project)) continue;
      ctx.error(
        path(r.envKey),
        `shell hook names host ${r.host} (${r.via}): it is not allowed: use localhost, an environment host, or add it to allow_hosts (allowed: ${allowedHosts(project).join(', ')})`,
      );
    }
  };
  report(shellHostRefs(s.run, { env: s.env }), (envKey) => (envKey ? [...kp, 'env', envKey] : at('run')));
  if (s.rollback !== undefined) report(shellHostRefs(s.rollback), () => at('rollback'));
}

/** Semantic checks of a list of hooks (schema-valid entries only). */
export function checkHooks(list: unknown, base: IssuePath, ctx: CheckContext, opts: HookCheckOptions): void {
  if (!Array.isArray(list)) return;
  list.forEach((raw, i) => checkHook(raw, [...base, i], ctx, opts));
}

/** Semantic checks of named hooks (L5.8, `hooks:` of a scenario or project.yaml): each name's entry, or each entry of its list. */
export function checkNamedHooks(map: unknown, base: IssuePath, ctx: CheckContext, opts: HookCheckOptions): void {
  if (!isObj(map)) return;
  for (const [name, v] of Object.entries(map)) {
    if (Array.isArray(v)) checkHooks(v, [...base, name], ctx, opts);
    else checkHook(v, [...base, name], ctx, opts);
  }
}

/** Semantic checks of one hook entry at path `p` (schema-valid entries only). */
function checkHook(raw: unknown, p: IssuePath, ctx: CheckContext, opts: HookCheckOptions): void {
  if (!isObj(raw) || ctx.broken(p)) return;
  const hook = raw as unknown as HookStep;
  const kind = hookKind(hook);
  const kp = [...p, kind];
  switch (kind) {
    case 'sql': {
      const spec = (hook as { sql: string | SqlHookSpec }).sql;
      if (typeof spec === 'object' && !spec.file === !spec.query) {
        ctx.error(kp, 'sql needs exactly one of `file` or `query`');
      }
      const { file } = sqlSource(spec);
      if (file) ctx.file(file, typeof spec === 'string' ? kp : [...kp, 'file'], 'SQL file', 'error');
      if (typeof spec === 'object' && spec.rollback !== undefined) {
        const rb = spec.rollback;
        if (typeof rb === 'object' && !rb.file === !rb.query) {
          ctx.error([...kp, 'rollback'], 'rollback needs exactly one of `file` or `query`');
        }
        const rbFile = typeof rb === 'string' ? sqlSource(rb).file : rb.file;
        if (rbFile) ctx.file(rbFile, [...kp, 'rollback'], 'rollback SQL file', 'error');
      }
      break;
    }
    case 'js': {
      const spec = (hook as { js: string | JsHookSpec }).js;
      if (typeof spec === 'object') {
        if (!spec.code === !spec.file) ctx.error(kp, 'js needs exactly one of `code` or `file`');
        if (spec.file) ctx.file(spec.file, [...kp, 'file'], 'JS file', 'error');
        if (spec.page && opts.pages && !opts.pages.includes(spec.page)) {
          ctx.error(
            [...kp, 'page'],
            `unknown page "${spec.page}"${suggestion(spec.page, opts.pages)} (available: ${opts.pages.join(', ') || 'none'})`,
          );
        }
      }
      break;
    }
    case 'http': {
      const http = (hook as { http: HttpHookSpec }).http;
      const name = http.save_as;
      if (name !== undefined) {
        if (opts.saved.has(name)) ctx.error([...kp, 'save_as'], `save_as "${name}" is already used by another hook`);
        opts.saved.add(name);
      }
      for (const [req, rp] of [[http, kp], [http.rollback, [...kp, 'rollback']]] as Array<[HttpHookSpec['rollback'], IssuePath]>) {
        if (!isObj(req) || req.auth === undefined) continue;
        if (opts.noPersonaAuth) ctx.error([...rp, 'auth'], opts.noPersonaAuth, { path: [...rp, 'auth'], key: true });
        const header = Object.keys(req.headers ?? {}).find((h) => ['authorization', 'cookie'].includes(h.toLowerCase()));
        if (header) ctx.error([...rp, 'headers', header], `\`auth: {persona}\` sets the ${header} header from the persona's session: remove one of the two`);
      }
      break;
    }
    case 'shell':
      if (opts.project) checkShellHosts((hook as { shell: string | ShellHookSpec }).shell, kp, ctx, opts.project);
      break;
  }
  if (hook.writes !== undefined && kind !== 'shell') {
    ctx.error(
      [...p, 'writes'],
      `\`writes\` is for shell hooks: ${kind === 'js' ? 'a js hook is guarded in its tab (its writes are stopped on a read-only run)' : `the writes of ${kind === 'http' ? 'an http hook are seen in its method and body' : 'a sql hook are seen in its statements'}`}`,
      { path: [...p, 'writes'], key: true },
    );
  }
  const reason = opts.destructiveOk ? null : destructiveReason(hook, ctx.hookFiles());
  if (reason && hook.confirm !== true) {
    ctx.error(p, `destructive hook (${reason}) requires "confirm: true"`, { path: kp, key: true });
  }
}
