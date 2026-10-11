import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ShellHookSpec } from '@demo-studio/core';
import { describeShell } from '../describe.js';
import { shellDestructiveReason } from '../destructive.js';
import { HookError } from '../errors.js';
import { redactText } from '../secrets.js';
import { hookTemplateContext, renderDeep, snapshotFor, snapshotTemplateContext } from '../template.js';
import type { HookContext, HookLogLevel, RollbackAction } from '../types.js';
import { tail } from '../util.js';
import { ignoreRollback } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';

export const DEFAULT_SHELL_TIMEOUT_S = 120;
/** Grace period between SIGTERM and SIGKILL of a timed-out process group. */
const KILL_GRACE_MS = 2_000;
/** Output kept per stream (the tail). */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** Output copied into one log message. */
const LOG_OUTPUT_CHARS = 4_000;
/** After the shell exits, how long to wait for its pipes to close (a background child may keep them open). */
const PIPE_GRACE_MS = 200;

interface ShellCommand {
  run: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface ShellOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > MAX_OUTPUT_BYTES && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  text(): string {
    const s = Buffer.concat(this.chunks).toString('utf8');
    return s.length > MAX_OUTPUT_BYTES ? s.slice(s.length - MAX_OUTPUT_BYTES) : s;
  }
}

/** `sh -c` in its own process group, so a timeout kills the whole tree. */
function runShell(cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = new TailBuffer();
    const err = new TailBuffer();
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      // After a timeout the pending SIGKILL still reaches stragglers of the group (unref'd: never blocks exit).
      if (!timedOut) clearTimeout(killTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise({ code, signal, stdout: out.text(), stderr: err.text(), timedOut });
    };
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new HookError(`cannot start sh: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      pipeTimer = setTimeout(() => finish(code, signal), PIPE_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function resolveCwd(ctx: HookContext, cwd: string | undefined): Promise<string> {
  const dir = resolve(ctx.project.dir, cwd ?? '.');
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new HookError(`shell hook: working directory ${cwd ?? '.'} does not exist (${dir})`);
  return dir;
}

function hookEnv(ctx: HookContext, extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEMO_STUDIO_PROJECT_DIR: ctx.project.dir,
    DEMO_STUDIO_ENV: ctx.env.name,
    ...(ctx.runId ? { DEMO_STUDIO_RUN_ID: ctx.runId } : {}),
    ...extra,
  };
}

async function execute(
  ctx: HookContext,
  log: (level: HookLogLevel, msg: string) => void,
  cmd: ShellCommand,
  timeoutS: number,
): Promise<string> {
  const cwd = await resolveCwd(ctx, cmd.cwd);
  const r = await runShell(cmd.run, cwd, hookEnv(ctx, cmd.env), timeoutS * 1000);
  const label = describeShell(cmd.run);
  if (r.stdout.trim()) log('info', `${label} stdout:\n${tail(r.stdout.trimEnd(), LOG_OUTPUT_CHARS)}`);
  if (r.stderr.trim()) log('info', `${label} stderr:\n${tail(r.stderr.trimEnd(), LOG_OUTPUT_CHARS)}`);
  if (r.timedOut) throw new HookError(`${label} timed out after ${timeoutS} s (process group killed)`);
  if (r.code !== 0) {
    const output = (r.stderr.trim() || r.stdout.trim()).trimEnd();
    const how = r.code === null ? `was killed by ${r.signal}` : `exited with code ${r.code}`;
    throw new HookError(`${label} ${how}${output ? `: ${tail(output, 1_000)}` : ''}`);
  }
  return 'exit 0';
}

export async function prepareShell(spec: string | ShellHookSpec, k: KindEnv): Promise<PreparedHook> {
  const { ctx, log } = k;
  const s: ShellHookSpec = typeof spec === 'string' ? { run: spec } : spec;
  const forward: ShellCommand = { run: s.run, cwd: s.cwd, env: s.env };
  const cmd = renderDeep(forward, await hookTemplateContext(ctx, forward));
  await resolveCwd(ctx, cmd.cwd);
  const timeout = s.timeout ?? DEFAULT_SHELL_TIMEOUT_S;

  ignoreRollback(k, s.rollback !== undefined);
  let rollback: RollbackAction | undefined;
  if (s.rollback !== undefined && k.phase === 'setup') {
    const template: ShellCommand = { run: s.rollback, cwd: s.cwd, env: s.env };
    const tpl = await hookTemplateContext(ctx, template);
    const rb = renderDeep(template, tpl);
    rollback = {
      kind: 'shell',
      run: s.rollback,
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      ...(s.env !== undefined ? { env: s.env } : {}),
      timeout,
      data: snapshotFor(ctx, template, tpl),
      description: redactText(ctx, describeShell(rb.run)),
    };
  }
  return {
    description: redactText(ctx, describeShell(cmd.run)),
    destructive: shellDestructiveReason(cmd.run, { projectDir: ctx.project.dir }),
    async execute() {
      return { message: await execute(ctx, log, cmd, timeout), rollback };
    },
  };
}

export async function rollbackShell(action: Extract<RollbackAction, { kind: 'shell' }>, r: RollbackEnv): Promise<string> {
  const template: ShellCommand = { run: action.run, cwd: action.cwd, env: action.env };
  const cmd = renderDeep(template, await snapshotTemplateContext(r.ctx, action.data, template));
  return execute(r.ctx, r.log, cmd, action.timeout ?? DEFAULT_SHELL_TIMEOUT_S);
}
