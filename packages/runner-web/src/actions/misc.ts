import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Page } from 'playwright-core';
import { collectSecretRefs, interpolate, interpolateDeep, isPoint, projectFileProblem, secretRefsProblem } from '@demo-studio/core';
import type { EmitArgs, EvalArgs, NormalizedArgsMap, NotifyArgs, ScreenshotArgs, TargetSpec } from '@demo-studio/core';
import { StepError, errorMessage } from '../errors.js';
import { resolveTarget } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { fileSlug } from '../util.js';
import type { ActionResult } from './types.js';

/**
 * Evaluate a function body (may `return` / `await`; receives `arg`) in the page. Evaluated through CDP, so
 * the page's CSP does not apply.
 */
export async function evalInPage(page: Page, body: string, arg: unknown = null): Promise<unknown> {
  return page.evaluate(`(async (arg) => {\n${body}\n})(${JSON.stringify(arg ?? null)})`);
}

function jsonSafe(v: unknown): unknown {
  try {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

export async function screenshot(ctx: StepContext, args: ScreenshotArgs): Promise<ActionResult> {
  const { rt } = ctx;
  await mkdir(rt.screenshotsDir, { recursive: true });
  const file = join(rt.screenshotsDir, `${fileSlug(args.name)}.png`);
  await rt.page.screenshot({ path: file, fullPage: args.full_page ?? false });
  return { data: { path: file } };
}

export async function evalStep(ctx: StepContext, args: EvalArgs): Promise<ActionResult> {
  const { rt } = ctx;
  let body = args.js;
  if (body === undefined && args.file !== undefined) {
    if (rt.agentTrust) {
      const problem = projectFileProblem(rt.project.dir, args.file, { code: true });
      if (problem) throw new StepError(`eval: ${problem}`);
    }
    const file = isAbsolute(args.file) ? args.file : join(rt.project.dir, args.file);
    try {
      body = await readFile(file, 'utf8');
    } catch (e) {
      throw new StepError(`eval: cannot read ${file}: ${errorMessage(e)}`);
    }
    // Through MCP a file's code names no secret: only project.yaml resolves them (core agent-trust).
    const secrets = rt.agentTrust ? secretRefsProblem(collectSecretRefs(body), `eval file ${args.file}`) : null;
    if (secrets) throw new StepError(`eval: ${secrets}`);
  }
  if (body === undefined) throw new StepError('eval: give `js` (function body) or `file`');
  // Scene templating leaves `eval` alone: its code (a file's too) and arg are templated now, their secrets resolved.
  await rt.secrets.prefetch([body, args.arg]);
  const code = interpolate(body, rt.template);
  const arg = args.arg === undefined ? null : interpolateDeep(args.arg, rt.template);
  try {
    const value = await evalInPage(rt.page, code, arg);
    return { data: { value: jsonSafe(value) } };
  } catch (e) {
    throw new StepError(`eval: ${errorMessage(e).replace(/^page\.evaluate: /, '').split('\n')[0]}`);
  }
}

/** Desktop notification: osascript on macOS, notify-send on Linux when present; always logged. */
export async function notify(ctx: StepContext, args: NotifyArgs): Promise<ActionResult> {
  const title = args.title ?? 'Demo Studio';
  ctx.rt.log('info', `notify: ${title}: ${args.message}`);
  const cmd: [string, string[]] | null =
    process.platform === 'darwin'
      ? ['osascript', ['-e', `display notification ${JSON.stringify(args.message)} with title ${JSON.stringify(title)}`]]
      : process.platform === 'linux'
        ? ['notify-send', [title, args.message]]
        : null;
  if (cmd) {
    await new Promise<void>((resolve) => {
      const child = spawn(cmd[0], cmd[1], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return { data: { title, message: args.message } };
}

export async function emit(_ctx: StepContext, args: EmitArgs): Promise<ActionResult> {
  return { data: { name: args.name, data: args.data ?? null } };
}

export async function cursor(ctx: StepContext, args: NormalizedArgsMap['cursor']): Promise<ActionResult> {
  const { pointer } = ctx.rt;
  switch (args.mode) {
    case 'show':
    case 'hide':
      await pointer.setVisible(args.mode === 'show');
      return { point: pointer.pos(), data: { visible: pointer.visible } };
    case 'set': {
      if (!isPoint(args.to)) throw new StepError('cursor: `set` needs a point {x, y}');
      await pointer.teleport(args.to);
      return { point: pointer.pos() };
    }
    case 'move': {
      if (args.to === undefined) throw new StepError('cursor: `move` needs a target or a point');
      if (isPoint(args.to)) {
        await pointer.moveTo(args.to, { ms: args.duration !== undefined ? args.duration * 1000 : undefined, jitter: ctx.jitter });
        return { point: pointer.pos() };
      }
      const r = await resolveTarget(ctx, args.to as TargetSpec);
      await pointer.moveTo(r.point, { ms: args.duration !== undefined ? args.duration * 1000 : undefined, jitter: ctx.jitter });
      return { target: { desc: r.desc, bbox: r.bbox }, point: pointer.pos() };
    }
  }
}
