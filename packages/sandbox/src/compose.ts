/**
 * The docker-compose provider: the sandbox's services are the compose files' (`compose.files`, default compose.yaml
 * next to sandbox.yaml), run through the `docker compose` CLI under a project name of their own — `compose.project`,
 * else `retake-<project>-<environment>-<hash of the folder>` (two checkouts of one project never share containers or
 * volumes). The folder is the first compose file's, as for docker compose itself: the files may live elsewhere than
 * sandbox.yaml (the product's repository), and their relative paths resolve next to them. Every call names the project,
 * its folder and its files (`-p`, `--project-directory`, `-f`) and its env file (`--env-file`: the image versions and
 * settings of `${VAR}`s — the names it sets are left out of the shell's environment, which would win over it), with
 * `COMPOSE_*` variables of the shell left out, and every command reads the project's containers first (`ps`):
 * containers of that name made from another folder (another checkout sharing a `compose.project`) refuse it.
 *
 * up: the compose files read (`config --format json`); a name an earlier up used (compose.project changed since) still
 * running refused; no container of another project may publish one of the ports, on any address (`docker ps --filter
 * publish=`: OrbStack lets one publish [::1] / [::] next to the sandbox's 127.0.0.1, and `localhost` reaches ::1
 * first); every port the files publish free (any listener refuses: OrbStack lets a container publish a busy port, and
 * the other program then answers part of the traffic) except those the project's own running containers hold, then
 * `up -d --wait --wait-timeout <s> --remove-orphans [--build]` (output in logs/compose-up.log). Its exit code is not
 * trusted — `--wait` can exit 0 on a timeout —: `ps --all --format json` must then show every service running, healthy
 * or without a healthcheck. The published ports must be held by the container runtime alone (lsof) and by no other
 * project's container (docker ps again), every manifest service must pass its health check (default a GET of its url,
 * 120 s) and every Postgres database of sandbox.yaml must answer — health checks, pg, the mailbox clear and sql seed
 * steps connect to the address Docker publishes the port on (127.0.0.1, ::1), never to `localhost`. down: `down
 * --remove-orphans [--volumes]` (never `--rmi`), the earlier names too (kept in the state until their volumes are
 * gone). exec seeds: `exec -T`. logs: `logs --tail`. An interrupted or failed up stops the services that call started
 * (`stop`: their logs stay).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interpolateDeep } from '@retake/core/base';
import { resolveEnvironment } from '@retake/core/environment';
import { prefetchSecrets } from '@retake/core/io';
import type { ExecStepSpec } from '@retake/core/sandbox';
import { dockerEnv, firstErrorLine } from './docker.js';
import type { DockerResult } from './docker.js';
import { checkExecHosts, masker, sandboxSecrets } from './seed.js';
import { SandboxError, interrupted } from './errors.js';
import { healthNow, pinHealth, serviceHealth, waitHealthy } from './health.js';
import { shownPath } from './paths.js';
import { describeListeners } from './ports.js';
import { COMPOSE_CAPABILITIES } from './provider.js';
import type {
  DataStorage,
  DownOptions,
  DownResult,
  OwnerUse,
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ProviderLogs,
  ServiceLogFile,
  ServiceStatus,
  ServicesAround,
  UpOptions,
  UpResult,
} from './provider.js';
import { COMPOSE_HEALTH_TIMEOUT_S, STARTING_LINE, containerProblem, dataMount, foreignListeners, indent, serviceProblems, waitTimeoutS } from './compose-parse.js';
import type { PsEntry } from './compose-parse.js';
import { composeArgs, startedProgram } from './compose-project.js';
import type { ComposeProjectRef, ComposeRecord } from './compose-project.js';
import { EXEC_MARK, EXEC_TIMEOUT_S, KILL_EXEC_SCRIPT, ComposeRunner } from './compose-runner.js';

export {
  COMPOSE_HEALTH_TIMEOUT_S,
  COMPOSE_LOG_TAIL,
  DOCKER_HELPER,
  STARTING_LINE,
  connectAddress,
  containerProblem,
  dataMount,
  foreignListeners,
  parseComposeConfig,
  parseDockerPs,
  parseLabels,
  parsePs,
  serviceProblems,
  waitTimeoutS,
} from './compose-parse.js';
export type { ComposeConfig, PortContainer, PsEntry, PublishedPort } from './compose-parse.js';
export { composeArgs, composeProject, composeProjectName, composeRecord, startedProgram } from './compose-project.js';
export type { ComposeProjectRef, ComposeRecord } from './compose-project.js';
export { EXEC_MARK, EXEC_TIMEOUT_S, KILL_EXEC_SCRIPT } from './compose-runner.js';
export type { ComposeProviderOptions } from './compose-runner.js';

export class ComposeProvider extends ComposeRunner implements Provider {
  readonly kind = 'docker-compose' as const;
  readonly capabilities: Readonly<ProviderCapabilities> = COMPOSE_CAPABILITIES;

  async up(ctx: ProviderContext, opts: UpOptions = {}): Promise<UpResult> {
    const t0 = Date.now();
    ctx.progress?.step('compose', 'reading the compose files, checking the ports');
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const cfg = await this.config(ctx, ref);
    const before = await this.ps(ctx, ref);
    this.checkDeclaredPorts(ctx, cfg);
    // A name an earlier up used (compose.project changed since) still running: its containers hold the ports and data.
    const previous: ComposeProjectRef[] = [];
    for (const old of this.previousRefs(ctx, ref)) {
      const ps = await this.ps(ctx, old);
      if (ps.some((e) => e.state === 'running')) {
        throw new SandboxError(
          `${this.where(ctx)}: compose project ${old.name} — the name an earlier up of this sandbox used (compose.project changed since) — is still running: ${this.downCommand(ctx)} takes it down (its volumes stay unless --volumes), then up`,
          'port',
        );
      }
      // Kept in the state until its containers and volumes are gone (down removes them).
      if (ps.length || (await this.volumesOf(ctx, old.name)).length) previous.push(old);
    }
    const runningBefore = new Map(before.filter((e) => e.state === 'running').map((e) => [e.service, e.id]));
    const published = cfg.ports.map((p) => ({ port: p.port, label: `port ${p.port} (service ${p.service}, published)` }));
    await this.checkOtherPublishers(ctx, ref, published, 'localhost could reach it instead of the sandbox');
    await this.checkFree(ctx, ref, cfg, before);
    // On disk before anything starts: a crash leaves a project `down` can still find (and the earlier names, until
    // their volumes are gone).
    const record: ComposeRecord = { project: ref.name, dir: ref.dir, ...(previous.length ? { previous: previous.map((p) => ({ project: p.name, dir: p.dir })) } : {}) };
    ctx.state.provider_state = { ...(ctx.state.provider_state ?? {}), compose: record };
    ctx.save();
    this.started = cfg.services.filter((s) => !runningBefore.has(s));
    const timeoutS = waitTimeoutS(ctx.sandbox);
    mkdirSync(ctx.paths.logs, { recursive: true });
    const upLog = join(ctx.paths.logs, 'compose-up.log');
    const args = ['up', '-d', '--wait', '--wait-timeout', String(timeoutS), '--remove-orphans', ...(opts.build ? ['--build'] : [])];
    writeFileSync(upLog, `── ${new Date().toISOString()} · retake sandbox ${ctx.sandbox.env} · docker ${composeArgs(ref).join(' ')} ${args.join(' ')}\n`);
    // One docker command builds, then starts and waits: its output says which it is doing (an image line, then the
    // first network / volume / container line).
    const waiting = `every service running and healthy, up to ${timeoutS} s`;
    let building = opts.build === true;
    ctx.progress?.step(building ? 'build' : 'start', building ? 'docker compose build' : waiting);
    const r = await this.compose(ref, args, {
      signal: ctx.signal,
      onLine: (line) => {
        appendFileSync(upLog, `${line}\n`);
        ctx.log('debug', line);
        if (building && STARTING_LINE.test(line)) {
          building = false;
          ctx.progress?.step('start', waiting);
        }
        if (line.trim()) ctx.progress?.note(line.trim());
      },
    });
    if (r.aborted || ctx.signal?.aborted) throw interrupted(this.where(ctx));
    if (r.error) throw new SandboxError(`${this.where(ctx)}: docker compose up could not be run: ${r.error}`);
    // Not the exit code: `--wait` may exit 0 when it times out.
    const after = await this.ps(ctx, ref);
    const problems = serviceProblems(cfg.services, after);
    if (problems.length) {
      const why = r.code === 0 ? `not every service is running and healthy after ${timeoutS} s` : `docker compose up failed (${firstErrorLine(r)})`;
      throw new SandboxError(await this.failure(ctx, ref, `${this.where(ctx)}: ${why}`, problems), 'unhealthy');
    }
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose up failed: ${firstErrorLine(r)} (log: ${shownPath(upLog)})`);
    const started = cfg.services.filter((s) => !after.some((e) => e.service === s && e.id === runningBefore.get(s)));
    this.started = started;
    await this.checkOwned(ctx, ref, after);
    // A container of another project started meanwhile next to ours (on [::1] / [::]).
    await this.checkOtherPublishers(ctx, ref, published, 'part of the traffic would reach it, not the sandbox');
    this.remember(after);
    for (const [name, svc] of Object.entries(ctx.sandbox.manifest.services)) {
      try {
        const health = pinHealth(serviceHealth(name, svc, COMPOSE_HEALTH_TIMEOUT_S), this.addresses);
        ctx.progress?.step(`health ${name}`, `up to ${Math.round(health.timeoutMs / 1000)} s`);
        await waitHealthy(health, { signal: ctx.signal });
      } catch (e) {
        if (e instanceof SandboxError && e.code === 'unhealthy') throw new SandboxError(await this.withTail(ctx, ref, `${this.where(ctx)}: ${e.message}`, name), 'unhealthy');
        throw e;
      }
    }
    if (Object.keys(ctx.sandbox.manifest.databases ?? {}).length) ctx.progress?.step('databases', `each one answering, up to ${timeoutS} s`);
    await this.waitDatabases(ctx, timeoutS);
    return { started, kept: cfg.services.filter((s) => !started.includes(s)), changed: [], ms: Date.now() - t0 };
  }

  async down(ctx: ProviderContext, opts: DownOptions = {}): Promise<DownResult> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const before = await this.ps(ctx, ref);
    // The names an earlier up used (compose.project changed since), each from its own folder: taken down too.
    const previous: Array<{ ref: ComposeProjectRef; ps: PsEntry[] }> = [];
    for (const old of this.previousRefs(ctx, ref)) previous.push({ ref: old, ps: await this.ps(ctx, old) });
    const stopped = [...new Set(before.filter((e) => e.state === 'running').map((e) => e.service))];
    const flags = ['--remove-orphans', ...(opts.volumes ? ['--volumes'] : [])];
    const r = await this.compose(ref, ['down', ...flags], { timeoutMs: 180_000, onLine: (l) => ctx.log('debug', l) });
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose down failed: ${firstErrorLine(r)}`);
    const left: Array<{ project: string; dir: string }> = [];
    for (const { ref: old, ps } of previous) {
      const res = await this.compose(old, ['down', ...flags], { timeoutMs: 180_000, onLine: (l) => ctx.log('debug', l) });
      if (res.code === 0 && ps.length) ctx.log('info', `also took down compose project ${old.name} (the name an earlier up of this sandbox used)`);
      // Forgotten once nothing of it is left; its volumes stay (and so does its name) unless --volumes.
      const volumes = res.code === 0 ? await this.volumesOf(ctx, old.name) : ['?'];
      if (volumes.length) {
        left.push({ project: old.name, dir: old.dir });
        ctx.log(
          'warn',
          `${this.where(ctx)}: compose project ${old.name} (the name an earlier up of this sandbox used) still has ${res.code === 0 ? `its volumes (${volumes.join(', ')})` : `resources (docker compose down failed: ${firstErrorLine(res)})`}: ${this.downCommand(ctx)} --volumes removes them`,
        );
      }
    }
    const ps = { ...(ctx.state.provider_state ?? {}) };
    delete ps.compose;
    if (left.length) ps.compose = { project: ref.name, dir: ref.dir, previous: left } satisfies ComposeRecord;
    if (opts.volumes) {
      delete ps.snapshot;
      delete ps.base;
    }
    ctx.state.provider_state = ps;
    ctx.save();
    return { stopped, dataGone: !!opts.volumes };
  }

  async status(ctx: ProviderContext): Promise<ServiceStatus[]> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const [cfg, ps] = await Promise.all([this.config(ctx, ref), this.ps(ctx, ref)]);
    this.remember(ps);
    await this.notePrevious(ctx, ref);
    const declared = Object.keys(ctx.sandbox.manifest.services);
    const names = [...declared, ...cfg.services.filter((s) => !declared.includes(s))];
    for (const s of ps) if (!names.includes(s.service)) names.push(s.service);
    const out: ServiceStatus[] = [];
    for (const name of names) {
      const mine = ps.filter((e) => e.service === name);
      const s: ServiceStatus = { name, state: 'stopped', ...(cfg.services.includes(name) ? {} : { orphan: true }) };
      const e = mine.find((x) => x.state === 'running') ?? mine[0];
      if (e) {
        s.container = e.name;
        s.docker = e.status;
      }
      if (e?.state === 'running') {
        s.state = e.health === 'starting' ? 'starting' : 'running';
        const problem = containerProblem(e);
        const svc = ctx.sandbox.manifest.services[name];
        const why = problem ?? (svc ? await healthNow(pinHealth(serviceHealth(name, svc, COMPOSE_HEALTH_TIMEOUT_S), this.addresses)) : null);
        s.health = why ?? 'ok';
        s.healthy = why === null;
      } else if (e) {
        s.note = containerProblem(e) ?? e.state;
      }
      out.push(s);
    }
    return out;
  }

  /** status: a name an earlier up used (compose.project changed since) that still has containers or volumes, as a note. */
  private async notePrevious(ctx: ProviderContext, ref: ComposeProjectRef): Promise<void> {
    for (const old of this.previousRefs(ctx, ref)) {
      const ps = await this.ps(ctx, old);
      const volumes = await this.volumesOf(ctx, old.name);
      if (!ps.length && !volumes.length) continue;
      const what = [
        ps.length ? `${ps.length} container${ps.length === 1 ? '' : 's'}${ps.some((e) => e.state === 'running') ? ' (running)' : ''}` : '',
        volumes.length ? `its volumes (${volumes.join(', ')})` : '',
      ]
        .filter(Boolean)
        .join(' and ');
      ctx.log(
        'warn',
        `compose project ${old.name} — the name an earlier up of this sandbox used (compose.project changed since) — still has ${what}: ${this.downCommand(ctx)}${volumes.length ? ' --volumes' : ''} removes them`,
      );
    }
  }

  /** Where to connect to a port the sandbox's own containers publish (127.0.0.1, ::1…), or undefined when none does. */
  async address(ctx: ProviderContext, port: number): Promise<string | undefined> {
    if (!this.addresses.has(port)) {
      await this.docker(ctx);
      this.remember(await this.ps(ctx, this.ref(ctx)));
    }
    return this.addresses.get(port);
  }

  async restart(ctx: ProviderContext, service: string): Promise<void> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    await this.ps(ctx, ref);
    const r = await this.compose(ref, ['restart', service], { timeoutMs: 180_000, signal: ctx.signal, onLine: (l) => ctx.log('debug', l) });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose restart ${service} failed: ${firstErrorLine(r)}`);
    await this.waitRunning(ctx, ref, [service], waitTimeoutS(ctx.sandbox));
    const svc = ctx.sandbox.manifest.services[service];
    if (svc) await waitHealthy(pinHealth(serviceHealth(service, svc, COMPOSE_HEALTH_TIMEOUT_S), this.addresses), { signal: ctx.signal });
  }

  /**
   * An `exec` seed step: the command inside a running service (`exec -T`), its output returned and kept in
   * logs/seed.log — secrets masked (the values it resolved, the sandbox's plain passwords). The hosts it names are
   * checked first, like a shell hook's (checkExecHosts). Every process it starts in the container carries
   * RETAKE_EXEC=<token>: an interrupt or a timeout stops them there too (killExec), not only the docker client.
   */
  async exec(ctx: ProviderContext, step: ExecStepSpec): Promise<string> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const values = { command: step.command, env: step.env ?? {} };
    const { resolver } = await prefetchSecrets(values, ctx.resolveSecret);
    const resolved: string[] = [];
    const secrets = (key: string) => {
      const v = resolver(key);
      if (v !== undefined) resolved.push(v);
      return v;
    };
    const pages = resolveEnvironment(ctx.project, ctx.sandbox.env).pages;
    const { command, env } = interpolateDeep(values, { pages, vars: ctx.project.config.vars ?? {}, secrets });
    const mask = masker([...resolved, ...sandboxSecrets(ctx.sandbox)]);
    if (!this.composeServices) {
      await this.ps(ctx, ref); // the project's folder (never a step in another checkout's container)
      this.composeServices = (await this.config(ctx, ref)).services;
    }
    checkExecHosts(ctx, typeof command === 'string' ? command : command.join(' '), env, this.composeServices);
    const argv = typeof command === 'string' ? ['sh', '-c', command] : command;
    const token = randomBytes(8).toString('hex');
    // Values travel in docker's own environment (-e NAME), never on its command line.
    const args = ['exec', '-T', '-e', EXEC_MARK, ...Object.keys(env).flatMap((k) => ['-e', k]), step.service, ...argv];
    const timeoutS = step.timeout_s ?? EXEC_TIMEOUT_S;
    mkdirSync(ctx.paths.logs, { recursive: true });
    const seedLog = join(ctx.paths.logs, 'seed.log');
    const shown = typeof step.command === 'string' ? step.command : step.command.join(' ');
    appendFileSync(seedLog, `── ${new Date().toISOString()} · exec in ${step.service}: ${mask(shown)}\n`);
    this.running = { ref, service: step.service, token };
    let r: DockerResult;
    try {
      r = await this.compose(ref, args, {
        timeoutMs: timeoutS * 1000,
        signal: ctx.signal,
        env: { ...env, [EXEC_MARK]: token },
        onLine: (l) => {
          appendFileSync(seedLog, `${mask(l)}\n`);
          ctx.log('debug', `${step.service}: ${mask(l)}`);
          if (l.trim()) ctx.progress?.note(mask(l).trim());
        },
      });
      if (r.aborted || r.timedOut) {
        const left = await this.killExec(ref, step.service, token, 'TERM');
        if (left) ctx.log('warn', `${this.where(ctx)}: ${left}`);
      }
    } finally {
      this.running = null;
    }
    const output = mask(`${r.stdout}${r.stderr}`);
    if (r.aborted) throw interrupted(`exec in ${step.service}`);
    if (r.timedOut) throw new Error(`did not finish within ${timeoutS} s (timeout_s): stopped`);
    if (r.error) throw new Error(`docker could not be run: ${r.error}`);
    if (r.code !== 0) {
      const tail = output.trim().split('\n').slice(-20).join('\n');
      throw new Error(`exited with code ${r.code}${tail ? ` — last lines:\n${indent(tail)}` : ''}`);
    }
    return output;
  }

  async stopStarted(ctx: ProviderContext): Promise<string[]> {
    const names = this.started;
    this.started = [];
    if (!names.length) return [];
    const ref = this.lastRef ?? this.ref(ctx);
    await this.compose(ref, ['stop', ...names], { timeoutMs: 120_000 }).catch(() => undefined);
    return names;
  }

  killStartedSync(ctx: ProviderContext): void {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* gone */
    }
    // An exec step running in a container: its processes there too (the docker client alone would leave them).
    const exec = this.running;
    this.running = null;
    const bin = this.bin ? startedProgram(this.policy, this.bin, this.binWhat) : null;
    const argv0 = bin?.argv0 ? { argv0: bin.argv0 } : {};
    if (exec && bin && !bin.problem) {
      spawnSync(bin.program, [...composeArgs(exec.ref), 'exec', '-T', exec.service, 'sh', '-c', KILL_EXEC_SCRIPT, 'sh', exec.token, 'KILL'], {
        ...argv0,
        env: dockerEnv(this.policy, process.env, exec.ref.envKeys, exec.ref.pass),
        timeout: 10_000,
        cwd: exec.ref.dir,
        ...(exec.ref.overrideText !== undefined ? { input: exec.ref.overrideText, stdio: ['pipe', 'ignore', 'ignore'] as const } : { stdio: 'ignore' as const }),
      });
    }
    const names = this.started;
    this.started = [];
    if (!names.length || !bin || bin.problem) return;
    const ref = this.lastRef ?? this.ref(ctx);
    spawnSync(bin.program, [...composeArgs(ref), 'kill', ...names], {
      ...argv0,
      env: dockerEnv(this.policy, process.env, ref.envKeys, ref.pass),
      timeout: 10_000,
      cwd: ref.dir,
      ...(ref.overrideText !== undefined ? { input: ref.overrideText, stdio: ['pipe', 'ignore', 'ignore'] as const } : { stdio: 'ignore' as const }),
    });
  }

  /** Docker keeps the logs: no files (logs() reads them through docker compose logs). */
  logFiles(): ServiceLogFile[] {
    return [];
  }

  async logs(ctx: ProviderContext, opts: { service?: string; lines: number }): Promise<ProviderLogs[]> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    await this.ps(ctx, ref);
    const cfg = await this.config(ctx, ref);
    const declared = Object.keys(ctx.sandbox.manifest.services);
    const names = [...declared, ...cfg.services.filter((s) => !declared.includes(s))];
    if (opts.service !== undefined && !names.includes(opts.service)) {
      throw new SandboxError(`unknown service "${opts.service}" (sandbox ${ctx.sandbox.env}: ${names.join(', ')})`);
    }
    const out: ProviderLogs[] = [];
    for (const service of opts.service === undefined ? names : [opts.service]) {
      const r = await this.compose(ref, ['logs', '--no-color', '--no-log-prefix', '--tail', String(opts.lines), service], { timeoutMs: 30_000 });
      out.push({ service, source: `docker compose -p ${ref.name} logs ${service}`, text: `${r.stdout}${r.stderr}`.replace(/\n+$/, '') });
    }
    return out;
  }

  /** `docker compose logs --follow` until the signal aborts, each line written as it comes. */
  async followLogs(ctx: ProviderContext, opts: { service?: string; lines: number; signal: AbortSignal; write: (line: string) => void }): Promise<void> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    await this.ps(ctx, ref);
    if (opts.service !== undefined) {
      const cfg = await this.config(ctx, ref);
      if (!cfg.services.includes(opts.service)) throw new SandboxError(`unknown service "${opts.service}" (sandbox ${ctx.sandbox.env}: ${cfg.services.join(', ')})`);
    }
    await this.compose(ref, ['logs', '--follow', '--no-color', '--tail', String(opts.lines), ...(opts.service ? [opts.service] : [])], { signal: opts.signal, onLine: opts.write });
  }

  /**
   * The compose service publishing this host port (a snapshot's database by default; `use` names another: the
   * mailbox, a seed's database): a running service of the sandbox's own project, made from its folder, and no other
   * program listening on it nor another container publishing it (on [::1] / [::]: `docker ps --filter publish`).
   * Throws SandboxError otherwise.
   */
  async publishedBy(ctx: ProviderContext, port: number, use: OwnerUse = SNAPSHOT_USE): Promise<string> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const ps = await this.ps(ctx, ref);
    const e = ps.find((x) => x.state === 'running' && x.publishers.some((p) => p.port === port && p.protocol === 'tcp'));
    if (!e) {
      throw new SandboxError(`${this.where(ctx)}: port ${port} (${use.what}) is not published by a running service of compose project ${ref.name} — ${use.why}`);
    }
    const wd = e.labels['com.docker.compose.project.working_dir'];
    if (!this.ownContainer(ref, ref.name, wd)) {
      throw new SandboxError(
        `${this.where(ctx)}: port ${port} (${use.what}) is published by container ${e.name}, which was not made from this sandbox's folder (${wd || 'no folder label'}) — ${use.why}`,
        'port',
      );
    }
    const ls = await this.listen([port]);
    const foreign = ls ? foreignListeners([port], ls) : [];
    if (foreign.length) {
      throw new SandboxError(`${this.where(ctx)}: port ${port} (${use.what}) is also used by another program (${describeListeners(foreign[0].by)}) — ${use.why}`, 'port');
    }
    await this.checkOtherPublishers(ctx, ref, [{ port, label: `port ${port} (${use.what})` }], 'localhost could reach it instead of the sandbox');
    this.remember(ps);
    return e.service;
  }

  /** What a reset empties or a seed rewrites must be published by the project (publishedBy). */
  servedBy(ctx: ProviderContext, port: number, use: OwnerUse): Promise<string> {
    return this.publishedBy(ctx, port, use);
  }

  /**
   * The running services (compose files' order), their `depends_on`, and where `database`'s container keeps its data:
   * a named volume of this compose project or an anonymous one (`down --volumes` removes both), a bind mount or an
   * external volume (it does not).
   */
  async servicesAround(ctx: ProviderContext, database: string): Promise<ServicesAround> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const [cfg, ps] = await Promise.all([this.config(ctx, ref), this.ps(ctx, ref)]);
    const running = cfg.services.filter((s) => ps.some((e) => e.service === s && e.state === 'running'));
    const db = ps.find((e) => e.service === database && e.state === 'running');
    let storage: DataStorage = { kind: 'unknown' };
    if (db) {
      const r = await this.run(['inspect', '--format', '{{json .Mounts}}', db.id], { timeoutMs: 30_000 });
      const m = r.code === 0 ? dataMount(r.stdout.trim()) : null;
      if (m?.type === 'bind') storage = { kind: 'bind', where: m.name };
      else if (m?.type === 'volume') {
        if (/^[0-9a-f]{64}$/.test(m.name)) storage = { kind: 'volume' };
        else {
          const v = await this.run(['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', m.name], { timeoutMs: 30_000 });
          storage = v.code === 0 && v.stdout.trim() === ref.name ? { kind: 'volume', where: m.name } : { kind: 'external', where: m.name };
        }
      }
    }
    return { running, depends: cfg.depends, storage };
  }

  /**
   * The image of every service (`service=<image id>`, or `missing`): part of the seed hash, so a rebuilt app (new
   * migrations) makes the snapshot stale.
   */
  async hashInputs(ctx: ProviderContext): Promise<string[]> {
    await this.docker(ctx);
    const cfg = await this.config(ctx);
    const names = [...new Set(Object.values(cfg.images))];
    const ids = new Map<string, string>();
    const all = await this.run(['image', 'inspect', '--format', '{{.Id}}', ...names], { timeoutMs: 30_000 });
    const lines = all.stdout.trim().split('\n').filter(Boolean);
    if (all.code === 0 && lines.length === names.length) names.forEach((n, i) => ids.set(n, lines[i].trim()));
    else {
      for (const n of names) {
        const one = await this.run(['image', 'inspect', '--format', '{{.Id}}', n], { timeoutMs: 30_000 });
        if (one.code === 0 && one.stdout.trim()) ids.set(n, one.stdout.trim());
      }
    }
    const out = cfg.services.map((s) => `image ${s}=${ids.get(cfg.images[s]) ?? 'missing'}`).sort();
    // The env file's settings: another value there is another product.
    const ref = this.ref(ctx);
    if (ref.envFile) {
      try {
        out.push(`env-file ${createHash('sha256').update(readFileSync(ref.envFile)).digest('hex')}`);
      } catch {
        out.push('env-file missing');
      }
    }
    return out;
  }
}

/** publishedBy's default: the snapshot's database. */
const SNAPSHOT_USE: OwnerUse = {
  what: "the snapshot's database",
  why: "a snapshot reset drops and recreates that database, so it must be the sandbox's own: publish the database's port in the compose file, or use strategy reseed",
};
