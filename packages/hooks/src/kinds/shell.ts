import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AGENT_SHELL_GRAMMAR, agentPolicyFolders, agentShellCwdProblems, agentShellEnvProblems, agentShellProblems, allowedHosts, bareEnvHint, channelWords, childEnv, childEnvHint, listTemplateTokens, policyChildEnv, sandboxOf, shellHostRefs, withOldOutgoingEnv, projectPath } from '@retake/core';
import type { ShellHookSpec } from '@retake/core';
import { checkShellHosts } from '../allow-list.js';
import { describeShell } from '../describe.js';
import { shellDestructiveReason } from '../destructive.js';
import { HookError, HookSecurityError } from '../errors.js';
import { redactText } from '../secrets.js';
import { hookTemplateContext, renderDeep, snapshotFor, snapshotTemplateContext } from '../template.js';
import { journalsRollback } from '../types.js';
import type { HookContext, HookLogLevel, RollbackAction } from '../types.js';
import { tail } from '../util.js';
import { baseDirOf, ignoreRollback } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';
import type { ShownAction } from '../shown.js';

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
  /** A sandbox environment's variables (sandboxEnv), under `env`. */
  base?: Record<string, string>;
  /**
   * L5.14: a rollback Retake did not sign — the terminal's environment is not passed on, only core childEnv's base of
   * it (the shell's own variables; no `pass_env:`).
   */
  bare?: boolean;
}

interface ShellOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Stopped by ctx.signal (Ctrl-C). */
  aborted: boolean;
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

/**
 * `sh -c` in its own process group, so a timeout — or an interrupt (`ctx.signal`) — stops the whole tree (SIGTERM, then
 * SIGKILL). The group is in `ctx.running` while it may still run: a second Ctrl-C kills it synchronously.
 */
function runShell(cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, ctx: Pick<HookContext, 'signal' | 'running'>): Promise<ShellOutcome> {
  return new Promise((resolvePromise, reject) => {
    if (ctx.signal?.aborted) {
      resolvePromise({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const child = spawn('sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    if (pgid !== undefined) ctx.running?.add(pgid);
    const forget = () => {
      if (pgid !== undefined) ctx.running?.delete(pgid);
    };
    const out = new TailBuffer();
    const err = new TailBuffer();
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = () => {
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        forget();
      }, KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      // After a timeout or an interrupt the pending SIGKILL still reaches stragglers of the group (unref'd: never
      // blocks exit); until then the group stays in ctx.running.
      if (!timedOut && !aborted) {
        clearTimeout(killTimer);
        forget();
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise({ code, signal, stdout: out.text(), stderr: err.text(), timedOut, aborted });
    };
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      forget();
      reject(new HookError(`cannot start sh: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      pipeTimer = setTimeout(() => finish(code, signal), PIPE_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function resolveCwd(ctx: HookContext, cwd: string | undefined): Promise<string> {
  const dir = resolve(baseDirOf(ctx), cwd ?? '.');
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new HookError(`shell hook: working directory ${cwd ?? '.'} does not exist (${dir})`);
  return dir;
}

/**
 * What sh gets of this process's environment: everything (a command a person types), core childEnv's allow-list under
 * the agent policy (a job of the Studio, the desktop app or an MCP client: the shell's own variables and project.yaml
 * `pass_env:`), its base only for a rollback Retake did not sign.
 */
function inheritedEnv(ctx: HookContext, cmd: ShellCommand): NodeJS.ProcessEnv {
  if (cmd.bare) return childEnv(process.env);
  return policyChildEnv(process.env, { pass: ctx.project.config.pass_env }) ?? process.env;
}

function hookEnv(ctx: HookContext, cmd: ShellCommand): NodeJS.ProcessEnv {
  return {
    ...inheritedEnv(ctx, cmd),
    // Also under the names from before L5.13, for a script that still reads them (legacy.ts; never read back).
    ...withOldOutgoingEnv({
      RETAKE_PROJECT_DIR: ctx.project.dir,
      RETAKE_ENV: ctx.env.name,
      ...(ctx.runId ? { RETAKE_RUN_ID: ctx.runId } : {}),
      // The project's allow-list, so a script can check the hosts it computes itself.
      RETAKE_ALLOWED_HOSTS: allowedHosts(ctx.project).join(','),
    }),
    ...cmd.base,
    ...cmd.env,
  };
}

/**
 * What a shell command on a sandbox environment (L1.8) gets on top of Retake's own environment: the `env` of the
 * sandbox's process services (templated like theirs) and RETAKE_SANDBOX=<env> — a seed's `npm run db:reset`
 * reaches the sandbox's database, never the one the developer's shell or `.env` file points at. The command's own
 * `env` wins; a variable two services set differently must be set there. Nothing on other environments.
 */
async function sandboxEnv(ctx: HookContext, env: string, own: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
  const sandbox = sandboxOf(ctx.project, env) ? ctx.project.sandboxes?.[env] : undefined;
  if (!sandbox) return undefined;
  const out: Record<string, string> = {};
  const from: Record<string, string> = {};
  if (sandbox.manifest.provider === 'process') {
    for (const [name, svc] of Object.entries(sandbox.manifest.services)) {
      if (!svc.env) continue;
      const values = renderDeep(svc.env, await hookTemplateContext(ctx, svc.env));
      for (const [k, v] of Object.entries(values)) {
        if (own && Object.hasOwn(own, k)) continue;
        if (Object.hasOwn(from, k) && out[k] !== v) {
          throw new HookError(`services ${from[k]} and ${name} of sandbox ${env} set ${k} differently: set ${k} in the shell command's own \`env\``);
        }
        out[k] = v;
        from[k] = name;
      }
    }
  }
  Object.assign(out, withOldOutgoingEnv({ RETAKE_SANDBOX: env }));
  return out;
}

/** The allow-list check of a templated command: with the environment sh will get (R-SEC-06). */
function checkHosts(ctx: HookContext, cmd: ShellCommand): void {
  checkShellHosts(cmd.run, hookEnv(ctx, cmd), cmd.env, ctx.project);
}

/** The hosts a command names (checked by checkHosts first). */
function hostsOf(ctx: HookContext, cmd: ShellCommand): string[] {
  return shellHostRefs(cmd.run, { vars: hookEnv(ctx, cmd), env: cmd.env }).flatMap((r) => (r.unresolved ? [] : [r.host]));
}

async function execute(
  ctx: HookContext,
  log: (level: HookLogLevel, msg: string) => void,
  cmd: ShellCommand,
  timeoutS: number,
): Promise<string> {
  const cwd = await resolveCwd(ctx, cmd.cwd);
  const env = hookEnv(ctx, cmd);
  const r = await runShell(cmd.run, cwd, env, timeoutS * 1000, ctx);
  const label = describeShell(cmd.run);
  if (r.stdout.trim()) log('info', `${label} stdout:\n${tail(r.stdout.trimEnd(), LOG_OUTPUT_CHARS)}`);
  if (r.stderr.trim()) log('info', `${label} stderr:\n${tail(r.stderr.trimEnd(), LOG_OUTPUT_CHARS)}`);
  if (r.aborted) throw new HookError(`${label} was interrupted (its process group stopped)`);
  if (r.timedOut) throw new HookError(`${label} timed out after ${timeoutS} s (process group killed)`);
  if (r.code !== 0) {
    const output = (r.stderr.trim() || r.stdout.trim()).trimEnd();
    const how = r.code === null ? `was killed by ${r.signal}` : `exited with code ${r.code}`;
    // The command got only some variables of this process's environment: say which (names only) — and, under the
    // agent policy, how to pass another (a rollback Retake did not sign takes none: pass_env does not reach it).
    const names = () => Object.keys(inheritedEnv(ctx, cmd));
    const hint = cmd.bare ? ` (${bareEnvHint(names())})` : agentPolicyFolders() ? ` (${childEnvHint(names())})` : '';
    throw new HookError(`${label} ${how}${output ? `: ${tail(output, 1_000)}` : ''}${hint}`);
  }
  return 'exit 0';
}

/** A value the agent's view reads in place of a secret token (agentShellView: a secret is never resolved for it). */
const INERT_VALUE = 'RETAKE_VALUE';
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SECRET_EXPR = /^(?:env|keychain|secret):/;

/** The root of a template expression as core's lookup reads it (`hooks .x` is `hooks`). */
const rootOf = (expr: string) => expr.split('.')[0].trim();

/**
 * What the agent's checks read of a templated command: the command rendered with the agent's own values — vars, pages,
 * `{{run.id}}` / `{{run.dir}}` (the run's folder, or where it would be: a dry preflight has none). A secret token is
 * refused before (agentShellTokenProblems); it reads as a plain word here only so the other words are still judged.
 * The submit's preflight and the worker read the same text.
 */
async function agentShellView(ctx: HookContext, cmd: Pick<ShellCommand, 'run' | 'cwd'>): Promise<{ run: string; cwd?: string }> {
  const inert = (text: string) => text.replace(TOKEN, (m, expr: string) => (SECRET_EXPR.test(expr.trim()) ? INERT_VALUE : m));
  const view = { run: inert(cmd.run), ...(cmd.cwd !== undefined ? { cwd: inert(cmd.cwd) } : {}) };
  const tpl = await hookTemplateContext(ctx, view);
  const id = ctx.runId ?? 'run';
  return renderDeep(view, { ...tpl, run: { id, dir: ctx.runDir ?? projectPath(ctx.project.dir, 'runs', id) } });
}

/** The end of every refusal of an agent-written shell hook: what it may be, and what a person does instead. */
function agentShellFix(ctx: HookContext): string {
  return `a shell hook written ${channelWords(ctx.via)} is ${AGENT_SHELL_GRAMMAR}, with no saved response or secret in it: have a person put it in hooks/<name>.yaml (\`retake hooks run <project> hooks/<name>.yaml\`), or run it in a terminal`;
}

/**
 * The template tokens an agent-written command (or working folder) may not hold: a saved response (`{{hooks.…}}`,
 * `{{response.…}}`: not known when the hook is asked about) and a secret (`{{env:…}}`, `{{keychain:…}}`,
 * `{{secret:…}}`: as an agent's scenario never names one, its value is never what the checks read). Each once.
 */
function agentShellTokenProblems(texts: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const text of texts) {
    if (text === undefined) continue;
    for (const expr of listTemplateTokens(text)) {
      const root = rootOf(expr);
      if (root === 'hooks' || root === 'response') add(`\`{{${expr}}}\` (a saved response: its value is not known when the hook is asked about)`);
      else if (SECRET_EXPR.test(expr.trim())) add(`\`{{${expr}}}\` (a secret: a shell hook the agent writes never names one)`);
    }
  }
  return out;
}

/** The plain-word grammar and rules (core agentShellCwdProblems / agentShellProblems) of a rendered command. */
function agentShellTextProblems(ctx: HookContext, text: { run: string; cwd?: string }): string[] {
  const base = baseDirOf(ctx);
  return [
    ...(text.cwd !== undefined ? agentShellCwdProblems(text.cwd, { projectDir: ctx.project.dir, cwd: base }) : []),
    ...agentShellProblems(text.run, { projectDir: ctx.project.dir, cwd: resolve(base, text.cwd ?? '.') }),
  ];
}

/**
 * Trust `mcp`, a hook the agent wrote (KindEnv.agentWritten): its command (or rollback) and working folder follow the
 * plain-word grammar and rules of core agentShellProblems / agentShellCwdProblems, read on agentShellView's text; no
 * saved response and no secret in them (agentShellTokenProblems). `env`: its names (agentShellEnvProblems), checked
 * with the command. `what`: "it" or "its rollback".
 */
async function checkAgentShell(ctx: HookContext, cmd: Pick<ShellCommand, 'run' | 'cwd' | 'env'>, what: string): Promise<void> {
  const problems: string[] = [...agentShellEnvProblems(cmd.env)];
  const tokens = agentShellTokenProblems([cmd.run, cmd.cwd]);
  problems.push(...tokens);
  if (!tokens.some((p) => p.includes('a saved response'))) problems.push(...agentShellTextProblems(ctx, await agentShellView(ctx, cmd)));
  if (!problems.length) return;
  throw new HookSecurityError(`refusing shell hook: ${what} uses ${problems.join('; ')} — ${agentShellFix(ctx)}`, 'mcp');
}

/**
 * `declared`: the hook's `writes` field (L1.7). A shell command writes unless the hook declares `writes: false`; even
 * then a destructive command (rm, dropdb, destructive SQL given to psql) and a rollback write.
 */
export async function prepareShell(spec: string | ShellHookSpec, k: KindEnv, declared?: { writes?: boolean }): Promise<PreparedHook> {
  const { ctx, log } = k;
  const s: ShellHookSpec = typeof spec === 'string' ? { run: spec } : spec;
  const forward: ShellCommand = { run: s.run, cwd: s.cwd, env: s.env };
  // An agent's hook: refused before anything of it is rendered (a saved response it names has no value yet).
  if (k.agentWritten) await checkAgentShell(ctx, forward, 'it');
  const rendered = renderDeep(forward, await hookTemplateContext(ctx, forward));
  const base = await sandboxEnv(ctx, ctx.env.name, rendered.env);
  const cmd: ShellCommand = { ...rendered, ...(base ? { base } : {}) };
  await resolveCwd(ctx, cmd.cwd);
  checkHosts(ctx, cmd);
  const timeout = s.timeout ?? DEFAULT_SHELL_TIMEOUT_S;

  ignoreRollback(k, s.rollback !== undefined);
  const hosts = hostsOf(ctx, cmd);
  let rollback: RollbackAction | undefined;
  let rollbackShown: ShownAction | undefined;
  if (s.rollback !== undefined && journalsRollback(k.phase)) {
    const template: ShellCommand = { run: s.rollback, cwd: s.cwd, env: s.env };
    // Its env names were checked with the command.
    if (k.agentWritten) await checkAgentShell(ctx, { run: s.rollback, ...(s.cwd !== undefined ? { cwd: s.cwd } : {}) }, 'its rollback');
    const tpl = await hookTemplateContext(ctx, template);
    const rb = renderDeep(template, tpl);
    const rbBase = await sandboxEnv(ctx, ctx.env.name, rb.env);
    if (rbBase) rb.base = rbBase;
    checkHosts(ctx, rb);
    hosts.push(...hostsOf(ctx, rb));
    rollback = {
      kind: 'shell',
      run: s.rollback,
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      ...(s.env !== undefined ? { env: s.env } : {}),
      timeout,
      // An agent's rollback is checked again when it is replayed (rollbackShell).
      ...(k.agentWritten ? { agent: true as const } : {}),
      data: snapshotFor(ctx, template, tpl),
      description: redactText(ctx, describeShell(rb.run)),
    };
    rollbackShown = { kind: 'shell', run: rb.run, ...(rb.cwd !== undefined ? { cwd: rb.cwd } : {}), ...(rb.env ? { env: rb.env } : {}) };
  }
  const destructive = shellDestructiveReason(cmd.run, { projectDir: baseDirOf(ctx) });
  return {
    description: redactText(ctx, describeShell(cmd.run)),
    shown: { kind: 'shell', run: rendered.run, ...(rendered.cwd !== undefined ? { cwd: rendered.cwd } : {}), ...(rendered.env ? { env: rendered.env } : {}), ...(s.timeout !== undefined ? { timeout: s.timeout } : {}) },
    destructive,
    writes:
      declared?.writes !== false
        ? 'a shell command — add `writes: false` to a shell hook that only reads'
        : destructive
          ? `${destructive}, although it declares writes: false`
          : s.rollback !== undefined && journalsRollback(k.phase)
            ? 'its rollback: a shell command'
            : null,
    hosts,
    ...(rollback && rollbackShown ? { rollback: { description: rollback.description, reason: 'a shell command (runs local code)', shown: rollbackShown } } : {}),
    async execute() {
      return { message: await execute(ctx, log, cmd, timeout), rollback };
    },
  };
}

/**
 * Replays a shell rollback. One an agent wrote (`agent`, under the entry's signature) is held to the agent's rules again
 * first, on the text it runs — its env names, no saved response or secret, the plain-word grammar and rules — whoever
 * replays it (`retake env reset` later, another environment, another folder).
 */
export async function rollbackShell(action: Extract<RollbackAction, { kind: 'shell' }>, r: RollbackEnv): Promise<string> {
  const template: ShellCommand = { run: action.run, cwd: action.cwd, env: action.env };
  if (action.agent) {
    const before = [...agentShellEnvProblems(action.env), ...agentShellTokenProblems([action.run, action.cwd])];
    if (before.length) throw new HookSecurityError(`refusing shell rollback: it uses ${before.join('; ')} — ${agentShellFix(r.ctx)}`, 'mcp');
  }
  const cmd = renderDeep(template, await snapshotTemplateContext(r.ctx, action.data, template));
  if (action.agent) {
    const problems = agentShellTextProblems(r.ctx, cmd);
    if (problems.length) throw new HookSecurityError(`refusing shell rollback: it uses ${problems.join('; ')} — ${agentShellFix(r.ctx)}`, 'mcp');
  }
  // The environment the hook ran in (a sandbox's own variables: its database, not the command's).
  const base = await sandboxEnv(r.ctx, r.env ?? r.ctx.env.name, cmd.env);
  // An unsigned one never gets them (journal.ts refuses it before).
  if (base && !r.unsigned) cmd.base = base;
  if (r.unsigned) cmd.bare = true;
  // Checked again when replayed: a journal may be rolled back later (`retake env reset`), with another environment.
  checkHosts(r.ctx, cmd);
  return execute(r.ctx, r.log, cmd, action.timeout ?? DEFAULT_SHELL_TIMEOUT_S);
}
