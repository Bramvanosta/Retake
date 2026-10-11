import { destructiveReason, hookKind, sqlSource } from '../destructive.js';
import type { IssuePath } from '../issues.js';
import type { HookStep, JsHookSpec, SqlHookSpec } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';

export interface HookCheckOptions {
  /** Page keys a js hook may name (undefined → not checked). */
  pages?: readonly string[];
  /** `save_as` names seen so far (shared across setup / teardown); filled by this check. */
  saved: Set<string>;
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
        if (file) ctx.file(file, typeof spec === 'string' ? kp : [...kp, 'file'], 'SQL file', 'warning');
        if (typeof spec === 'object' && spec.rollback !== undefined) {
          const rb = spec.rollback;
          if (typeof rb === 'object' && !rb.file === !rb.query) {
            ctx.error([...kp, 'rollback'], 'rollback needs exactly one of `file` or `query`');
          }
          const rbFile = typeof rb === 'string' ? sqlSource(rb).file : rb.file;
          if (rbFile) ctx.file(rbFile, [...kp, 'rollback'], 'rollback SQL file', 'warning');
        }
        break;
      }
      case 'js': {
        const spec = (hook as { js: string | JsHookSpec }).js;
        if (typeof spec === 'object') {
          if (!spec.code === !spec.file) ctx.error(kp, 'js needs exactly one of `code` or `file`');
          if (spec.file) ctx.file(spec.file, [...kp, 'file'], 'JS file', 'warning');
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
        break;
    }
    const reason = destructiveReason(hook, { projectDir: ctx.projectDir });
    if (reason && hook.confirm !== true) {
      ctx.error(p, `destructive hook (${reason}) requires "confirm: true"`, { path: kp, key: true });
    }
  });
}
