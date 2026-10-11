import type { JsHookSpec } from '@demo-studio/core';
import { describeJs } from '../describe.js';
import { HookError } from '../errors.js';
import { redactText } from '../secrets.js';
import { hookTemplateContext, render, snapshotFor, snapshotTemplateContext } from '../template.js';
import type { HookContext, RollbackAction } from '../types.js';
import { oneLine } from '../util.js';
import { ignoreRollback, readProjectFile } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';

export const JS_NEEDS_PAGE = 'js hooks need a browser page: run them through the runner (studio run / run_capture)';

function checkPage(ctx: HookContext, page: string | undefined): void {
  if (page !== undefined && !Object.hasOwn(ctx.env.pages, page)) {
    const keys = Object.keys(ctx.env.pages);
    throw new HookError(`js hook: unknown page "${page}" (environment ${ctx.env.name} has: ${keys.join(', ') || 'no pages'})`);
  }
}

async function evaluate(ctx: HookContext, page: string | undefined, code: string): Promise<string> {
  if (!ctx.evalInPage) throw new HookError(JS_NEEDS_PAGE);
  const value = await ctx.evalInPage(page, code);
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
  const source = s.file ? await readProjectFile(ctx.project.dir, s.file, 'JS file') : s.code!;
  const code = render(source, await hookTemplateContext(ctx, source));

  ignoreRollback(k, s.rollback !== undefined);
  let rollback: RollbackAction | undefined;
  if (s.rollback !== undefined && k.phase === 'setup') {
    const tpl = await hookTemplateContext(ctx, s.rollback);
    const rbCode = render(s.rollback, tpl);
    rollback = {
      kind: 'js',
      code: s.rollback,
      ...(s.page !== undefined ? { page: s.page } : {}),
      data: snapshotFor(ctx, s.rollback, tpl),
      description: redactText(ctx, describeJs({ code: rbCode }, s.page)),
    };
  }
  return {
    description: redactText(ctx, describeJs(s.file ? { file: s.file } : { code }, s.page)),
    destructive: null,
    async execute() {
      return { message: await evaluate(ctx, s.page, code), rollback };
    },
  };
}

export async function rollbackJs(action: Extract<RollbackAction, { kind: 'js' }>, r: RollbackEnv): Promise<string> {
  const code = render(action.code, await snapshotTemplateContext(r.ctx, action.data, action.code));
  return evaluate(r.ctx, action.page, code);
}
