import { destructiveReason, hookKind, sqlSource } from '../destructive.js';
import { allowedHosts, isHostAllowed } from '../hosts.js';
import type { IssuePath } from '../issues.js';
import { shellHostRefs } from '../shell-hosts.js';
import type { HookStep, JsHookSpec, LoadedProject, ShellHookSpec, SqlHookSpec } from '../types.js';
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
  list.forEach((raw, i) => {
    const p = [...base, i];
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
        const name = (hook as { http: { save_as?: string } }).http.save_as;
        if (name !== undefined) {
          if (opts.saved.has(name)) ctx.error([...kp, 'save_as'], `save_as "${name}" is already used by another hook`);
          opts.saved.add(name);
        }
        break;
      }
      case 'shell':
        if (opts.project) checkShellHosts((hook as { shell: string | ShellHookSpec }).shell, kp, ctx, opts.project);
        break;
    }
    const reason = destructiveReason(hook, { projectDir: ctx.projectDir });
    if (reason && hook.confirm !== true) {
      ctx.error(p, `destructive hook (${reason}) requires "confirm: true"`, { path: kp, key: true });
    }
  });
}
