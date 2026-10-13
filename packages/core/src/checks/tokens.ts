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

/** Where tokens are not allowed (scenario scenes and video text, R-RUN-16/17). */
export interface TokenRules {
  /** A name the runner uses as written (an `emit` name): any token is an error. */
  literal?(path: IssuePath, value: string): boolean;
  /** Text the edited video shows (captions, overlays, cards, the title…): a secret reference is an error. */
  noSecret?(path: IssuePath): boolean;
}

function checkToken(expr: string, path: IssuePath, scope: TokenScope, inRollback: boolean, ctx: CheckContext): void {
  if (SECRET.test(expr)) return;
  const parts = expr.split('.').map((s) => s.trim());
  const [head, second] = parts;
  switch (head) {
    case 'run':
      if (second !== 'id' && second !== 'dir') ctx.error(path, `unknown template key {{${expr}}}; available: run.id, run.dir`);
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
 * `vars` values are inserted as written, never templated (BL-56): a {{token}} in one would reach the page or the video
 * as `{{…}}` (or, for a secret reference, could carry an environment value into what the video shows).
 */
export function checkVarsValues(vars: unknown, path: IssuePath, ctx: CheckContext): void {
  if (typeof vars === 'string') {
    const exprs = listTemplateTokens(vars);
    if (exprs.length) {
      ctx.error(path, `{{${exprs[0]}}}: a vars value is not templated (it would be inserted as written): write the value, or put the token where the variable is used`);
    }
  } else if (Array.isArray(vars)) vars.forEach((v, i) => checkVarsValues(v, [...path, i], ctx));
  else if (isObj(vars)) for (const [k, v] of Object.entries(vars)) checkVarsValues(v, [...path, k], ctx);
}

/**
 * Check every {{token}} found in the strings of `value` (recursively). `note` fields are skipped;
 * `{{response.*}}` is accepted under a `rollback` key; `rules` forbids tokens or secrets at some paths.
 */
export function checkTokens(value: unknown, path: IssuePath, scope: TokenScope, ctx: CheckContext, inRollback = false, rules?: TokenRules): void {
  if (typeof value === 'string') {
    const exprs = listTemplateTokens(value);
    if (exprs.length && rules?.literal?.(path, value)) {
      ctx.error(path, `{{${exprs[0]}}} is not templated here: this name is used as written`);
      return;
    }
    for (const expr of exprs) {
      if (SECRET.test(expr) && rules?.noSecret?.(path)) {
        ctx.error(
          path,
          `{{${expr}}} would be shown in the video and kept in clear in timeline.json: secret references belong in step ` +
            'arguments (typed text, URLs, targets) — use {{vars.…}} for text the video may show',
        );
        continue;
      }
      checkToken(expr, path, scope, inRollback, ctx);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkTokens(v, [...path, i], scope, ctx, inRollback, rules));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'note') continue;
      checkTokens(v, [...path, k], scope, ctx, inRollback || k === 'rollback', rules);
    }
  }
}
