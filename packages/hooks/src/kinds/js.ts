import { isHostRefusedError, isWriteRefusedError, protectedHostMessage, readOnlyHookMessage } from '@retake/core';
import type { JsHookSpec } from '@retake/core';
import { describeJs } from '../describe.js';
import { HookError, HookSecurityError } from '../errors.js';
import { redactText } from '../secrets.js';
import { hookTemplateContext, render, snapshotFor, snapshotTemplateContext } from '../template.js';
import { journalsRollback } from '../types.js';
import type { HookContext, RollbackAction } from '../types.js';
import { oneLine } from '../util.js';
import { ignoreRollback, readHookFile } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';
import type { ShownAction } from '../shown.js';

export const JS_NEEDS_PAGE = 'js hooks need a browser page: run them through the runner (retake run / run_capture)';

function checkPage(ctx: HookContext, page: string | undefined): void {
  if (page !== undefined && !Object.hasOwn(ctx.env.pages, page)) {
    const keys = Object.keys(ctx.env.pages);
    throw new HookError(`js hook: unknown page "${page}" (environment ${ctx.env.name} has: ${keys.join(', ') || 'no pages'})`);
  }
}

async function evaluate(ctx: HookContext, page: string | undefined, code: string): Promise<string> {
  if (!ctx.evalInPage) throw new HookError(JS_NEEDS_PAGE);
  let value: unknown;
  try {
    value = await ctx.evalInPage(page, code);
  } catch (e) {
    // The runner's hook tab blocked a host outside the allow-list (R-SEC-06): a refusal, like http and sql.
    if (isHostRefusedError(e)) throw new HookSecurityError(e.message, 'host');
    // On a read-only run the tab stopped a write the hook needed (L1.7): refused like a writing http hook.
    // On any run, a write to a host of another, read-only environment (production) is refused the same way.
    if (isWriteRefusedError(e)) {
      const access = ctx.access ?? { env: e.env, mode: 'read-only' as const };
      const reason = `${e.writes.join(', ')}, stopped in its tab`;
      const hit = e.protectedBy ? access.protected?.find((p) => p.env === e.protectedBy) : undefined;
      const message = hit ? protectedHostMessage(reason, hit, access) : readOnlyHookMessage(reason, access);
      throw new HookSecurityError(`${message}${e.detail ? `; ${e.detail}` : ''}`, 'read-only');
    }
    throw e;
  }
  if (value === undefined) return 'done';
  let shown: string;
  try {
    shown = JSON.stringify(value) ?? String(value);
  } catch {
    shown = String(value);
  }
  return `returned ${oneLine(shown, 120)}`;
}

export async function prepareJs(spec: string | JsHookSpec, k: KindEnv): Promise<PreparedHook> {
  const { ctx } = k;
  const s: JsHookSpec = typeof spec === 'string' ? { code: spec } : spec;
  if (!s.code === !s.file) throw new HookError('js hook needs exactly one of `code` or `file`');
  checkPage(ctx, s.page);
  const source = s.file ? await readHookFile(ctx, ctx.project.dir, s.file, 'JS file') : s.code!;
  const code = render(source, await hookTemplateContext(ctx, source));

  ignoreRollback(k, s.rollback !== undefined);
  let rollback: RollbackAction | undefined;
  let rollbackShown: ShownAction | undefined;
  if (s.rollback !== undefined && journalsRollback(k.phase)) {
    const tpl = await hookTemplateContext(ctx, s.rollback);
    const rbCode = render(s.rollback, tpl);
    rollback = {
      kind: 'js',
      code: s.rollback,
      ...(s.page !== undefined ? { page: s.page } : {}),
      data: snapshotFor(ctx, s.rollback, tpl),
      description: redactText(ctx, describeJs({ code: rbCode }, s.page)),
    };
    rollbackShown = { kind: 'js', ...(s.page !== undefined ? { page: s.page } : {}), code: rbCode };
  }
  return {
    description: redactText(ctx, describeJs(s.file ? { file: s.file } : { code }, s.page)),
    shown: { kind: 'js', ...(s.page !== undefined ? { page: s.page } : {}), ...(s.file ? { file: s.file } : { code }) },
    destructive: null,
    // Its requests are guarded in its tab on a read-only run; a rollback is a write the guard cannot judge.
    writes: rollback ? 'its rollback: JavaScript run in the page' : null,
    ...(rollback && rollbackShown ? { rollback: { description: rollback.description, reason: 'JavaScript run in the page', shown: rollbackShown } } : {}),
    async execute() {
      return { message: await evaluate(ctx, s.page, code), rollback };
    },
  };
}

export async function rollbackJs(action: Extract<RollbackAction, { kind: 'js' }>, r: RollbackEnv): Promise<string> {
  const code = render(action.code, await snapshotTemplateContext(r.ctx, action.data, action.code, r.env));
  return evaluate(r.ctx, action.page, code);
}
