import type { IssuePath } from '../issues.js';
import { listTemplateTokens } from '../templating.js';
import { suggestion } from '../validation/suggest.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';

/** What {{tokens}} can refer to in a document. */
export interface TokenScope {
  /** Environment page keys; undefined when unknown (no project) → bare keys are not checked. */
  pages?: readonly string[];
  /** Declared variables (project vars + scenario vars). */
  vars: ReadonlySet<string>;
  /** Whether `vars` is complete (false without a project: project vars are unknown). */
  varsComplete: boolean;
  /** `save_as` names of http hooks ({{hooks.<name>…}}). */
  saved: ReadonlySet<string>;
}

const SECRET = /^(env|keychain|secret):/;

function checkToken(expr: string, path: IssuePath, scope: TokenScope, inRollback: boolean, ctx: CheckContext): void {
  if (SECRET.test(expr)) return;
  const parts = expr.split('.').map((s) => s.trim());
  const [head, second] = parts;
  switch (head) {
    case 'run':
      return;
    case 'vars':
      if (scope.varsComplete && (second === undefined || !scope.vars.has(second))) {
        const declared = [...scope.vars];
        ctx.error(
          path,
          `unknown variable {{${expr}}}${second ? suggestion(second, declared) : ''}; declared: ${declared.join(', ') || 'none'}`,
        );
      }
      return;
    case 'hooks':
      if (second === undefined || !scope.saved.has(second)) {
        ctx.warning(path, `{{${expr}}}: no http hook declares save_as "${second ?? ''}"`);
      }
      return;
    case 'response':
      if (!inRollback) ctx.error(path, `{{${expr}}} is only available inside an http hook's rollback`);
      return;
  }
  if (!scope.pages) return;
  const isPage = parts.length === 1 && scope.pages.includes(head);
  if (isPage || scope.vars.has(head) || !scope.varsComplete) return;
  const available = [...scope.pages, ...[...scope.vars].map((v) => `vars.${v}`), 'env:VAR', 'keychain:service/account'];
  ctx.error(path, `unknown template key {{${expr}}}${suggestion(head, [...scope.pages, ...scope.vars])}; available: ${available.join(', ')}`);
}

/**
 * Check every {{token}} found in the strings of `value` (recursively). `note` fields are skipped;
 * `{{response.*}}` is accepted under a `rollback` key.
 */
export function checkTokens(value: unknown, path: IssuePath, scope: TokenScope, ctx: CheckContext, inRollback = false): void {
  if (typeof value === 'string') {
    for (const expr of listTemplateTokens(value)) checkToken(expr, path, scope, inRollback, ctx);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkTokens(v, [...path, i], scope, ctx, inRollback));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'note') continue;
      checkTokens(v, [...path, k], scope, ctx, inRollback || k === 'rollback');
    }
  }
}
