/**
 * The accounts of a sandbox.yaml: the personas of its environment (checked like project.yaml `auth`), their username
 * and password (plain, a secret reference or {{compose_env:NAME}}) and the {{account.*}} tokens of their login steps.
 */
import type { IssuePath } from '../issues.js';
import { collectSecretRefs, listTemplateTokens } from '../templating.js';
import type { LocatedIssue } from '../validation/located.js';
import { checkAuth } from './auth.js';
import { CheckContext, isObj } from './context.js';
import { DIR_LABEL, composeEnvProblem, composeEnvRef } from './sandbox-files.js';
import { checkTokens } from './tokens.js';

/** Texts shorter than this are never masked (core redact: they would mangle every log). */
const MASKED_MIN = 3;

/** Why a plain password cannot be used at all, or null: one shorter than 3 characters is never masked in the logs. */
export function unmaskedPasswordReason(password: string): string | null {
  return password.length < MASKED_MIN
    ? `a plain password shorter than ${MASKED_MIN} characters is never masked in the logs (texts that short would mangle every log): use something like "sandbox-pass-4632"`
    : null;
}

/**
 * Why a plain password is weak for redaction, or null: every occurrence of a password's text is masked as *** in
 * logs, run files and messages, so a short or one-word one masks ordinary words too.
 */
export function weakPasswordReason(password: string): string | null {
  if (password.length < 8 || /^[a-z]+$/i.test(password)) {
    return 'a plain password shorter than 8 characters or made of one word is masked wherever that text appears in the logs (a password "demo" turns every "demo" into ***): use something like "sandbox-pass-4632"';
  }
  return null;
}

/** A password that is one secret reference ({{env:VAR}} / {{keychain:…}}): not plain text. */
function isSecretReference(v: string): boolean {
  const t = v.trim();
  return /^\{\{\s*[^{}]+?\s*\}\}$/.test(t) && collectSecretRefs(t).size === 1;
}

/** Issue paths of a checkAuth run on the accounts (as one global auth block) → their place in sandbox.yaml. */
function fromAuthPath(path: IssuePath): IssuePath {
  if (path[0] !== 'auth') return path;
  if (path[1] === 'personas' && path.length > 2) return ['accounts', ...path.slice(2)];
  if (path[1] === 'login_url') return path.slice(1);
  if (path.length === 1) return ['accounts'];
  return path.slice(1);
}

/** Sandbox.yaml paths → the auth block checkAuth reads (for its "is this part broken" questions). */
function toAuthPath(path: IssuePath): IssuePath | null {
  if (path[0] === 'accounts') return ['auth', 'personas', ...path.slice(1)];
  if (path[0] === 'login_url') return ['auth', ...path];
  return null;
}

/** The accounts as one global auth block (username / password left out) for checkAuth. */
function accountsAsAuth(value: Record<string, unknown>): Record<string, unknown> {
  const personas: Record<string, unknown> = {};
  if (isObj(value.accounts)) {
    for (const [name, a] of Object.entries(value.accounts)) {
      if (!isObj(a)) {
        personas[name] = a;
        continue;
      }
      const { username: _u, password: _p, ...persona } = a;
      personas[name] = persona;
    }
  }
  return { ...(value.login_url !== undefined ? { login_url: value.login_url } : {}), personas };
}

/** {{account.<field>}} tokens of a value (strings walked recursively). */
function accountFields(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    for (const expr of listTemplateTokens(v)) {
      const m = /^account\.(\w+)$/.exec(expr.trim());
      if (m) out.add(m[1]);
    }
  } else if (Array.isArray(v)) v.forEach((x) => accountFields(x, out));
  else if (isObj(v)) for (const x of Object.values(v)) accountFields(x, out);
  return out;
}

/**
 * The accounts, as the personas of the sandbox's environment: checked like project.yaml `auth` (one block, the
 * sandbox's pages), plus their username / password and the {{account.*}} tokens of their login steps.
 */
export function checkAccounts(
  value: Record<string, unknown>,
  ctx: CheckContext,
  { pageKeys, pageUrls, vars, env }: { pageKeys: readonly string[]; pageUrls: Record<string, string>; vars: ReadonlySet<string>; env: string },
): void {
  if (value.accounts === undefined && value.login_url === undefined) return;
  // checkAuth reads the accounts as one global auth block: its paths (and the schema's) are mapped both ways.
  const structural: LocatedIssue[] = [];
  for (const i of ctx.structural) {
    const path = toAuthPath(i.path);
    if (path) structural.push({ ...i, path, ...(i.loc ? { loc: { ...i.loc, path: toAuthPath(i.loc.path) ?? i.loc.path } } : {}) });
  }
  const sub = new CheckContext(structural, ctx.projectDir, DIR_LABEL, ctx.files);
  checkAuth(accountsAsAuth(value), { [env]: Object.fromEntries(pageKeys.map((k) => [k, pageUrls[k]])) }, sub, { vars }, { accounts: true });
  for (const i of sub.out) {
    ctx.out.push({ ...i, path: fromAuthPath(i.path), ...(i.loc ? { loc: { ...i.loc, path: fromAuthPath(i.loc.path) } } : {}) });
  }
  if (!isObj(value.accounts) || ctx.broken(['accounts'])) return;
  for (const [name, a] of Object.entries(value.accounts)) {
    const ap: IssuePath = ['accounts', name];
    if (!isObj(a) || ctx.broken(ap)) continue;
    for (const field of ['username', 'password'] as const) {
      const v = a[field];
      if (typeof v !== 'string' || !v.includes('{{')) continue;
      const fromFile = composeEnvRef(v);
      if (fromFile !== undefined) {
        const problem = composeEnvProblem(value, fromFile, ctx);
        if (problem) ctx.error([...ap, field], problem);
      } else if (!isSecretReference(v)) {
        ctx.error([...ap, field], `a ${field} is plain text or one {{env:VAR}} / {{keychain:service/account}} / {{compose_env:NAME}} reference (it is put into the login steps as is)`);
      }
    }
    if (typeof a.password === 'string' && !a.password.includes('{{')) {
      const unmasked = unmaskedPasswordReason(a.password);
      const weak = unmasked ? null : weakPasswordReason(a.password);
      if (unmasked) ctx.error([...ap, 'password'], unmasked);
      else if (weak) ctx.warning([...ap, 'password'], weak);
    }
    const { login, ...rest } = a;
    if (accountFields(rest).size > 0) checkTokens(rest, ap, { pages: pageKeys, vars, varsComplete: true, saved: new Set(), account: 'elsewhere' }, ctx);
    if (Array.isArray(login) && !ctx.broken([...ap, 'login'])) {
      for (const field of accountFields(login)) {
        if ((field === 'username' || field === 'password') && a[field] === undefined) {
          ctx.error([...ap, 'login'], `the login steps use {{account.${field}}}: give account ${name} a \`${field}\``, { path: [...ap, 'login'], key: true });
        }
      }
    }
  }
}
