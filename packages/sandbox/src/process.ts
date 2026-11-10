/**
 * The process provider: each service of sandbox.yaml is a local program started detached in a process group of its own
 * (it outlives the CLI), its output appended to `.retake/sandbox/<env>/logs/<service>.log` (the previous run's
 * kept as `.log.1`). Its state entry (pid + start time) is written right after the spawn, before anything waits. A
 * first word `node` runs the CLI's own Node (`process.execPath`: a folder's Node version manager could pick another
 * one); a string command runs with `sh -c` (PATH lookup). Services inherit the CLI's environment without the package
 * manager's and test runner's variables (npm_*, PNPM_*, VITEST*, NODE_ENV…) unless sandbox.yaml sets them, plus
 * RETAKE_SANDBOX=<env>. Starting one drops the sandbox's seed record (what it held in memory is gone: the next up
 * seeds). Stopping sends SIGTERM to the group, SIGKILL after `stop_timeout_s` (default 10), then stops the descendants
 * that had left the group (a browser Playwright launched detached) and checks the ports are free.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { interpolateDeep, policyChildEnv, prefetchSecrets, resolveEnvironment } from '@retake/core';
import type { SandboxService } from '@retake/core';
import { SandboxError, errorMessage, interrupted } from './errors.js';
import { healthNow, serviceHealth, waitHealthy } from './health.js';
import { serviceLog, shownPath } from './paths.js';
import { busyPorts, describeListeners, listeners, portLabel, probePort, sandboxPorts } from './ports.js';
import type { SandboxPort } from './ports.js';
import { bootTime, groupMembers, groupTree, identify, killGroupSync, processStart, processTable, signalState, stopGroup } from './proc.js';
import type { DownResult, OwnerUse, Provider, ProviderContext, ServiceLogFile, ServiceStatus, UpResult } from './provider.js';
import { isProcessService, writeState } from './state.js';
import type { ProcessServiceState } from './state.js';

/** Default seconds between SIGTERM and SIGKILL. */
export const DEFAULT_STOP_TIMEOUT_S = 10;
/** Lines of a service's log quoted when it fails to start. */
export const LOG_TAIL_LINES = 20;

/** Variables of the CLI's own environment a service does not inherit (unless sandbox.yaml sets them). */
const DROPPED_ENV = /^(npm_|pnpm_|VITEST|__VITEST|JEST_WORKER)/i;
const DROPPED_EXACT = new Set(['INIT_CWD', 'NODE_ENV', 'NODE_OPTIONS', 'TEST', 'PNPM_SCRIPT_SRC_DIR', 'PNPM_PACKAGE_NAME']);

/** The program and arguments of a service: argv (`node` → this Node) or `sh -c <string>`. */
export function resolveCommand(command: string | string[]): { file: string; args: string[]; display: string } {
  if (Array.isArray(command)) {
    const [first, ...rest] = command;
    return { file: first === 'node' ? process.execPath : first, args: rest, display: command.join(' ') };
  }
  return { file: '/bin/sh', args: ['-c', command], display: command };
}

/** The hash of a service's definition (command, cwd, env as written): a changed one is reported by up and status. */
export function serviceHash(svc: SandboxService): string {
  return createHash('sha256')
    .update(JSON.stringify({ command: svc.command ?? null, cwd: svc.cwd ?? '.', env: Object.entries(svc.env ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)) }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The environment of a service: the CLI's (filtered) — under the agent policy (a job of the Studio, the desktop app or
 * an MCP client) only core childEnv's allow-list of it (the shell's own variables and project.yaml `pass_env:`) —,
 * sandbox.yaml's `env` (templated) and RETAKE_SANDBOX.
 */
export async function serviceEnv(ctx: Pick<ProviderContext, 'project' | 'sandbox'>, svc: SandboxService, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  const inherited = policyChildEnv(base, { pass: ctx.project.config.pass_env }) ?? base;
  for (const [k, v] of Object.entries(inherited)) if (v !== undefined && !DROPPED_ENV.test(k) && !DROPPED_EXACT.has(k)) out[k] = v;
  if (svc.env) {
    const { resolver } = await prefetchSecrets(svc.env);
    const pages = resolveEnvironment(ctx.project, ctx.sandbox.env).pages;
    Object.assign(out, interpolateDeep(svc.env, { pages, vars: ctx.project.config.vars ?? {}, secrets: resolver }));
  }
  out.RETAKE_SANDBOX = ctx.sandbox.env;
  return out;
}

/** The last `n` lines of a file ('' when it cannot be read). */
export function tailLines(file: string, n: number): string {
  try {
    const text = readFileSync(file, 'utf8');
    const lines = text.replace(/\n+$/, '').split('\n');
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

interface Started {
  pid: number;
  child: ChildProcess;
  exit: { code: number | null; signal: NodeJS.Signals | null } | { error: string } | null;
}

function exitText(e: NonNullable<Started['exit']>): string {
  if ('error' in e) return `could not start: ${e.error}`;
  return e.signal ? `was stopped by ${e.signal}` : `exited with code ${e.code}`;
}

export class ProcessProvider implements Provider {
  readonly kind = 'process' as const;
  /** Services this instance started (this call), by name. */
  private readonly started = new Map<string, Started>();

  logFiles(ctx: ProviderContext): ServiceLogFile[] {
    return Object.keys(ctx.sandbox.manifest.services).map((service) => ({ service, file: serviceLog(ctx.paths, service) }));
  }

  private ports(ctx: ProviderContext, service: string): SandboxPort[] {
    return sandboxPorts(ctx.sandbox.manifest).filter((p) => p.service === service);
  }

  /** A failure message with the service's log tail. */
  private withLog(ctx: ProviderContext, service: string, message: string): string {
    const file = serviceLog(ctx.paths, service);
    const tail = tailLines(file, LOG_TAIL_LINES);
    const shown = shownPath(file);
    return tail ? `${message} — last lines of ${shown}:\n${tail.split('\n').map((l) => `    ${l}`).join('\n')}` : `${message} (log: ${shown})`;
  }

  /** Refuse to start a service whose ports something already listens on, naming it. */
  private async checkFree(ctx: ProviderContext, service: string): Promise<void> {
    const busy = await busyPorts(this.ports(ctx, service));
    if (!busy.length) return;
    const lines = busy.map(({ port, by }) =>
      `${portLabel(port)} is in use by ${by ? `another program (${describeListeners(by)})` : 'another program (lsof cannot see it: another user\'s?)'}`,
    );
    throw new SandboxError(`sandbox ${ctx.sandbox.env}: ${lines.join('; ')} — stop it or change the port in ${shownPath(ctx.sandbox.file)}`, 'port');
  }

  /**
   * Every port of a service must be listened on by its own processes, and by nothing else (a second program would take
   * part of the traffic). It waits, up to the service's health timeout, until its process tree listens on each one (a
   * service without a health check binds its ports when it is ready); only a program lsof names is blamed.
   */
  private async checkOwned(ctx: ProviderContext, service: string, pgid: number, timeoutMs: number, gone?: () => string | null): Promise<void> {
    const ports = this.ports(ctx, service);
    if (!ports.length) return;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const ls = await listeners(ports.map((p) => p.port));
      if (ls === null) return; // no lsof: cannot tell (the start-time pre-check still ran)
      const tree = new Set(groupTree(await processTable(), pgid).map((p) => p.pid));
      const foreign: string[] = [];
      const missing: SandboxPort[] = [];
      for (const p of ports) {
        const by = ls.filter((l) => l.port === p.port);
        const others = by.filter((l) => !tree.has(l.pid));
        if (others.length) foreign.push(`${portLabel(p)} is also used by another program (${describeListeners(others)})`);
        else if (!by.length) missing.push(p);
      }
      if (foreign.length) {
        throw new SandboxError(
          `sandbox ${ctx.sandbox.env}: ${foreign.join('; ')} — part of the traffic would not reach the sandbox: stop it or change the port in ${shownPath(ctx.sandbox.file)}`,
          'port',
        );
      }
      if (!missing.length) return;
      if (ctx.signal?.aborted) throw interrupted(`service ${service} was not listening yet`);
      const why = gone?.();
      if (why) throw new SandboxError(`service ${service} ${why}`, 'unhealthy');
      if (Date.now() >= until) {
        const answers = await Promise.all(missing.map((p) => probePort(p.port)));
        if (answers.some(Boolean)) {
          const lines = missing.filter((_, i) => answers[i]).map((p) => `${portLabel(p)} answers, but lsof shows no process of service ${service} listening on it (another user's program?)`);
          throw new SandboxError(`sandbox ${ctx.sandbox.env}: ${lines.join('; ')} — stop it or change the port in ${shownPath(ctx.sandbox.file)}`, 'port');
        }
        throw new SandboxError(
          `service ${service}: nothing listens on ${missing.map(portLabel).join(', ')} after ${Math.round(timeoutMs / 1000)} s — is it the port the service listens on?`,
          'unhealthy',
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Record the members of a service's group (it is healthy now): identify recognises it by them when its leader exits. */
  private async remember(ctx: ProviderContext, name: string): Promise<void> {
    const entry = ctx.state.services[name];
    if (!isProcessService(entry)) return;
    const members = groupMembers(await processTable(), entry.pid);
    if (members.length) entry.members = members;
  }

  /** identify() with what the state and this call know of a service. */
  private identity(name: string, entry: ProcessServiceState): Promise<'ours' | 'gone' | 'reused'> {
    return identify(entry.pid, entry.started_at, { boot: entry.boot, members: entry.members, spawned: this.started.get(name)?.pid === entry.pid });
  }

  /** Spawn a service detached, its log rotated; its state entry is written before this returns. */
  private async spawnService(ctx: ProviderContext, name: string, svc: SandboxService): Promise<Started> {
    if (svc.command === undefined) throw new SandboxError(`service ${name} has no command (provider process)`);
    const { file, args, display } = resolveCommand(svc.command);
    const cwd = resolve(ctx.sandbox.dir, svc.cwd ?? '.');
    if (!existsSync(cwd)) throw new SandboxError(`service ${name}: working directory ${cwd} not found`);
    const env = await serviceEnv(ctx, svc);
    const boot = bootTime();
    mkdirSync(ctx.paths.logs, { recursive: true });
    const log = serviceLog(ctx.paths, name);
    if (existsSync(log)) renameSync(log, `${log}.1`);
    // O_APPEND: the log can be truncated in place (trimLogs) while the service writes.
    const fd = openSync(log, 'a');
    let child: ChildProcess;
    try {
      writeSync(fd, `── ${new Date().toISOString()} · retake sandbox ${ctx.sandbox.env} · ${display} (in ${cwd})\n`);
      child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    const started: Started = { pid: child.pid ?? -1, child, exit: null };
    child.once('exit', (code, signal) => (started.exit = { code, signal }));
    child.once('error', (e) => (started.exit = { error: errorMessage(e) }));
    child.unref();
    if (child.pid === undefined) {
      await new Promise((r) => setImmediate(r));
      throw new SandboxError(`service ${name} ${exitText(started.exit ?? { error: 'no process was created' })} (${display})`, 'unhealthy');
    }
    // On disk before anything is awaited (a kill -9 or a second Ctrl-C now still leaves it tracked): the start time
    // is now's — within START_TOLERANCE_MS of ps' — until ps gives the exact one below.
    const entry: ProcessServiceState = {
      kind: 'process',
      pid: child.pid,
      started_at: new Date().toISOString(),
      command: display,
      hash: serviceHash(svc),
      status: 'starting',
      ...(boot !== null ? { boot } : {}),
    };
    ctx.state.services[name] = entry;
    // What the sandbox held in this service's memory is gone: seeded again by the next up (or this one).
    delete ctx.state.seed;
    ctx.save();
    this.started.set(name, started);
    const start = await processStart(child.pid);
    if (start !== null && ctx.state.services[name] === entry) {
      entry.started_at = new Date(start).toISOString();
      ctx.save();
    }
    return started;
  }

  /** Why a started service cannot become healthy (its whole group is gone), or null. */
  private gone(s: Started): string | null {
    if (s.exit === null) return null;
    if ('error' in s.exit) return exitText(s.exit);
    // A group of zombies (EPERM on macOS for a moment) is gone too.
    return signalState(-s.pid) !== 'alive' ? exitText(s.exit) : null;
  }

  /** Start one service and wait until it is healthy and owns its ports. */
  private async startOne(ctx: ProviderContext, name: string, svc: SandboxService): Promise<void> {
    await this.checkFree(ctx, name);
    const s = await this.spawnService(ctx, name, svc);
    try {
      const health = serviceHealth(name, svc);
      const t0 = Date.now();
      await waitHealthy(health, { signal: ctx.signal, gone: () => this.gone(s) });
      await this.checkOwned(ctx, name, s.pid, Math.max(0, health.timeoutMs - (Date.now() - t0)), () => this.gone(s));
    } catch (e) {
      if (e instanceof SandboxError && e.code === 'unhealthy') throw new SandboxError(this.withLog(ctx, name, `sandbox ${ctx.sandbox.env}: ${e.message}`), 'unhealthy');
      throw e;
    }
    const entry = ctx.state.services[name];
    if (isProcessService(entry)) entry.status = 'running';
    await this.remember(ctx, name);
    ctx.save();
  }

  async up(ctx: ProviderContext): Promise<UpResult> {
    const t0 = Date.now();
    const out: UpResult = { started: [], kept: [], changed: [], ms: 0 };
    const services = ctx.sandbox.manifest.services;
    // Services of an earlier sandbox.yaml (renamed, removed): stopped first, their ports may be needed.
    for (const name of Object.keys(ctx.state.services)) {
      if (Object.hasOwn(services, name)) continue;
      await this.stopEntry(ctx, name);
      ctx.log('info', `stopped service ${name}: sandbox.yaml no longer declares it`);
    }
    for (const [name, svc] of Object.entries(services)) {
      if (ctx.signal?.aborted) throw interrupted(`sandbox ${ctx.sandbox.env}`);
      const entry = ctx.state.services[name];
      if (isProcessService(entry)) {
        const id = await this.identity(name, entry);
        if (id === 'ours') {
          if (entry.hash !== serviceHash(svc)) {
            out.changed.push(name);
            ctx.log('warn', `service ${name} changed in sandbox.yaml since it started (pid ${entry.pid}): it keeps running as it was — retake sandbox down, then up, to apply the change`);
          }
          try {
            const gone = () => (signalState(-entry.pid) !== 'alive' ? 'stopped while its health was checked' : null);
            const health = serviceHealth(name, svc);
            const t0 = Date.now();
            await waitHealthy(health, { signal: ctx.signal, gone });
            await this.checkOwned(ctx, name, entry.pid, Math.max(0, health.timeoutMs - (Date.now() - t0)), gone);
          } catch (e) {
            if (e instanceof SandboxError && e.code === 'unhealthy') throw new SandboxError(this.withLog(ctx, name, `sandbox ${ctx.sandbox.env}: ${e.message} (it was already running, pid ${entry.pid})`), 'unhealthy');
            throw e;
          }
          entry.status = 'running';
          await this.remember(ctx, name);
          ctx.save();
          out.kept.push(name);
          continue;
        }
        if (id === 'reused') ctx.log('info', `service ${name}: pid ${entry.pid} is not its process any more (another program's, or a group it cannot recognise) — starting it again`);
        delete ctx.state.services[name];
        ctx.save();
      } else if (entry) {
        delete ctx.state.services[name];
        ctx.save();
      }
      await this.startOne(ctx, name, svc);
      out.started.push(name);
    }
    out.ms = Date.now() - t0;
    return out;
  }

  /** Stop a service of the state (if it is still ours) and remove its entry; warn about ports still held. */
  private async stopEntry(ctx: ProviderContext, name: string): Promise<boolean> {
    const entry = ctx.state.services[name];
    let stopped = false;
    if (isProcessService(entry) && (await this.identity(name, entry)) === 'ours') {
      const svc = ctx.sandbox.manifest.services[name];
      const r = await stopGroup(entry.pid, (svc?.stop_timeout_s ?? DEFAULT_STOP_TIMEOUT_S) * 1000);
      stopped = true;
      if (r.forced) ctx.log('warn', `service ${name} did not stop within ${svc?.stop_timeout_s ?? DEFAULT_STOP_TIMEOUT_S} s of SIGTERM: killed (SIGKILL)`);
      if (r.leftovers) ctx.log('info', `service ${name}: stopped ${r.leftovers} process${r.leftovers === 1 ? '' : 'es'} it had started outside its group`);
    }
    delete ctx.state.services[name];
    this.started.delete(name);
    ctx.save();
    if (stopped) await this.warnHeld(ctx, name);
    return stopped;
  }

  /** After a stop: a port of the service still held (a process that escaped its group) is named. */
  private async warnHeld(ctx: ProviderContext, name: string): Promise<void> {
    const ports = this.ports(ctx, name);
    if (!ports.length) return;
    const until = Date.now() + 2000;
    let busy = await busyPorts(ports);
    while (busy.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      busy = await busyPorts(ports);
    }
    for (const { port, by } of busy) {
      ctx.log('warn', `${portLabel(port)} is still in use after the service stopped${by ? ` (${describeListeners(by)})` : ''}: a process it started left its process group — stop it by hand`);
    }
  }

  async down(ctx: ProviderContext): Promise<DownResult> {
    const order = Object.keys(ctx.sandbox.manifest.services);
    const names = Object.keys(ctx.state.services).sort((a, b) => order.indexOf(b) - order.indexOf(a));
    const stopped: string[] = [];
    for (const name of names) if (await this.stopEntry(ctx, name)) stopped.push(name);
    return { stopped, dataGone: true };
  }

  async status(ctx: ProviderContext): Promise<ServiceStatus[]> {
    const services = ctx.sandbox.manifest.services;
    const out: ServiceStatus[] = [];
    const names = [...Object.keys(services), ...Object.keys(ctx.state.services).filter((n) => !Object.hasOwn(services, n))];
    for (const name of names) {
      const svc = services[name];
      const entry = ctx.state.services[name];
      const s: ServiceStatus = { name, state: 'stopped', ...(svc ? {} : { orphan: true }) };
      if (isProcessService(entry)) {
        const id = await this.identity(name, entry);
        if (id === 'ours') {
          Object.assign(s, { state: entry.status === 'running' ? 'running' : 'starting', pid: entry.pid, started_at: entry.started_at, command: entry.command });
          if (svc && entry.hash !== serviceHash(svc)) s.changed = true;
          if (svc) {
            const why = await healthNow(serviceHealth(name, svc));
            s.health = why ?? 'ok';
            s.healthy = why === null;
          }
        } else if (id === 'reused') s.note = `its recorded pid ${entry.pid} is not its process any more (another program's, or a group Retake cannot recognise)`;
      }
      out.push(s);
    }
    return out;
  }

  async restart(ctx: ProviderContext, service: string): Promise<void> {
    const svc = ctx.sandbox.manifest.services[service];
    if (!svc) throw new SandboxError(`unknown service "${service}"`);
    const seed = ctx.state.seed;
    await this.stopEntry(ctx, service);
    await this.startOne(ctx, service, svc);
    // reset.restart, right after the seed: that seed lives in the sandbox's database, not in this process.
    if (seed) {
      ctx.state.seed = seed;
      ctx.save();
    }
  }

  /**
   * The service serving this port (the mailbox, a database a seed rewrites): one of sandbox.yaml's process services
   * names it (url, pages, health) and its own processes alone listen on it.
   */
  async servedBy(ctx: ProviderContext, port: number, use: OwnerUse): Promise<string> {
    const where = `sandbox ${ctx.sandbox.env}: port ${port} (${use.what})`;
    const p = sandboxPorts(ctx.sandbox.manifest).find((x) => x.port === port);
    if (!p) throw new SandboxError(`${where} is not a port of a service of this sandbox (its url, pages or health) — ${use.why}`);
    const entry = ctx.state.services[p.service];
    if (!isProcessService(entry) || (await this.identity(p.service, entry)) !== 'ours') {
      throw new SandboxError(`${where}: service ${p.service}, which declares it, is not running — ${use.why}`);
    }
    const ls = await listeners([port]);
    if (ls !== null) {
      const tree = new Set(groupTree(await processTable(), entry.pid).map((x) => x.pid));
      const others = ls.filter((l) => l.port === port && !tree.has(l.pid));
      if (others.length) throw new SandboxError(`${where} is also used by another program (${describeListeners(others)}) — ${use.why}`, 'port');
      if (!ls.some((l) => l.port === port)) throw new SandboxError(`${where}: no process of service ${p.service} listens on it — ${use.why}`);
    }
    return p.service;
  }

  async stopStarted(ctx: ProviderContext): Promise<string[]> {
    const names = [...this.started.keys()].reverse();
    for (const name of names) await this.stopEntry(ctx, name);
    return names;
  }

  killStartedSync(ctx: ProviderContext): void {
    for (const [name, s] of this.started) {
      killGroupSync(s.pid);
      delete ctx.state.services[name];
    }
    this.started.clear();
    try {
      writeState(ctx.paths.state, ctx.state);
    } catch {
      /* exiting anyway */
    }
  }
}
