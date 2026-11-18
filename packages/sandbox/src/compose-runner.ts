/**
 * The docker compose side of the compose provider: docker found and checked under the agent policy, compose commands
 * of the sandbox's project, its config and containers read, the ports checked (declared, free, owned, published by no
 * other project), the log tails and failures worded, the databases waited for. ComposeProvider (compose.ts) builds the
 * provider's operations on it.
 */
import type { ChildProcess } from 'node:child_process';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { bestEffort, sleep } from '@retake/core/base';
import { sandboxNames } from '@retake/core/sandbox';
import { realpathOr } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core/policy';
import { dockerReady, findDocker, firstErrorLine, runDocker } from './docker.js';
import type { DockerExec, DockerInfo, DockerResult, DockerRunOptions } from './docker.js';
import { SandboxError, errorMessage, interrupted } from './errors.js';
import { shownPath } from './paths.js';
import { busyPorts, describeListeners, listeners, portLabel, sandboxPorts } from './ports.js';
import type { Listener, SandboxPort } from './ports.js';
import type { ProviderContext } from './provider.js';
import { pgAnswers, pgEndpoint, resolveDatabaseUrl } from './snapshot-postgres.js';
import { COMPOSE_LOG_TAIL, DOCKER_HELPER, connectAddress, foreignListeners, indent, parseComposeConfig, parseDockerPs, parsePs, serviceProblems } from './compose-parse.js';
import type { ComposeConfig, PortContainer, PsEntry } from './compose-parse.js';
import { composeArgs, composeProject, composeRecord, filesText, ownFolder, startedProgram } from './compose-project.js';
import type { ComposeProjectRef, StartedProgram } from './compose-project.js';

/** Default seconds of an `exec` seed step. */
export const EXEC_TIMEOUT_S = 300;
/** The variable every process of an exec seed step carries in its container (`RETAKE_EXEC=<token>`). */
export const EXEC_MARK = 'RETAKE_EXEC';
/**
 * Run inside a container as `sh -c <script> sh <token> TERM|KILL`: signals every process whose environment carries
 * RETAKE_EXEC=<token> (read from /proc/<pid>/environ) — SIGTERM, up to 3 s, then SIGKILL; KILL at once.
 */
export const KILL_EXEC_SCRIPT = [
  `mark="${EXEC_MARK}=$1"`,
  'pids() { for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] && continue; tr \'\\000\' \'\\n\' < "$d/environ" 2>/dev/null | grep -qx "$mark" && echo "$p"; done; }',
  'l=$(pids); [ -z "$l" ] && exit 0',
  'if [ "$2" = KILL ]; then kill -9 $l 2>/dev/null; exit 0; fi',
  'kill -15 $l 2>/dev/null',
  'for i in 1 2 3; do sleep 1; l=$(pids); [ -z "$l" ] && exit 0; done',
  'kill -9 $l 2>/dev/null; exit 0',
].join('\n');

export interface ComposeProviderOptions {
  /** What the work runs under (core WorkPolicy): docker is checked against its agent policy and gets its environment. */
  policy: WorkPolicy;
  /** The docker binary (default findDocker(): $RETAKE_DOCKER, PATH, the usual install places). */
  docker?: string;
  /** How docker is run (default runDocker; tests pass a fake). */
  exec?: DockerExec;
  /** Who listens on ports (default lsof). */
  listeners?: (ports: readonly number[]) => Promise<Listener[] | null>;
}

/** The base of ComposeProvider: what its operations share (compose.ts). */
export class ComposeRunner {
  protected readonly bin: string | null;
  /** How a refusal names the binary (`$RETAKE_DOCKER` when it came from there). */
  protected readonly binWhat: string;
  protected readonly policy: WorkPolicy;
  protected readonly run: DockerExec;
  protected readonly listen: (ports: readonly number[]) => Promise<Listener[] | null>;
  private ready: Promise<DockerInfo> | null = null;
  /** Services this instance started (this call): stopped when the call fails or is interrupted. */
  protected started: string[] = [];
  /** The `docker compose` process running now (a second Ctrl-C kills it). */
  protected child: ChildProcess | null = null;
  protected lastRef: ComposeProjectRef | null = null;
  /** The exec seed step running now (a second Ctrl-C stops its processes in the container). */
  protected running: { ref: ComposeProjectRef; service: string; token: string } | null = null;
  /** The compose files' services (an exec step may name them as hosts), read once per instance. */
  protected composeServices: string[] | undefined;
  /** port → the address Docker publishes it on, for the sandbox's own running containers (remember()). */
  protected readonly addresses = new Map<number, string>();

  constructor(opts: ComposeProviderOptions) {
    this.policy = opts.policy;
    this.bin = opts.docker ?? (opts.exec ? 'docker' : findDocker());
    this.binWhat = opts.docker === undefined && process.env.RETAKE_DOCKER ? '$RETAKE_DOCKER' : 'docker';
    this.run =
      opts.exec ??
      ((args, o) => {
        const bin = this.program();
        return bin
          ? runDocker(bin.program, args, { ...o, policy: this.policy, ...(bin.argv0 ? { argv0: bin.argv0 } : {}) })
          : Promise.resolve({ code: null, stdout: '', stderr: '', ms: 0, error: 'not found' });
      });
    this.listen = opts.listeners ?? listeners;
  }

  /**
   * The docker binary to start: under the agent policy (core policyProgram: a job of the Studio, the desktop app or an
   * MCP client) by the real path that was checked, and refused (SandboxError) when it is a relative path or lies inside
   * the workspace — `$RETAKE_DOCKER` and the PATH's docker alike. Null when there is none.
   */
  private program(): StartedProgram | null {
    if (!this.bin) return null;
    const checked = startedProgram(this.policy, this.bin, this.binWhat);
    if (checked.problem) throw new SandboxError(`docker-compose sandboxes: ${checked.problem}`);
    return checked;
  }

  /** The compose project of this sandbox. */
  ref(ctx: Pick<ProviderContext, 'project' | 'sandbox'>): ComposeProjectRef {
    this.lastRef = composeProject(ctx.project, ctx.sandbox);
    return this.lastRef;
  }

  protected where(ctx: ProviderContext): string {
    return `sandbox ${ctx.sandbox.env}`;
  }

  /** Docker found, Compose recent enough, the daemon running (checked once per instance). */
  async docker(ctx: ProviderContext): Promise<DockerInfo> {
    if (!this.bin) {
      throw new SandboxError(
        `${this.where(ctx)}: docker-compose sandboxes need Docker with Compose v2.17 or later: \`docker\` was not found (install Docker Desktop or OrbStack, or set RETAKE_DOCKER)`,
      );
    }
    try {
      this.ready ??= dockerReady(this.run, this.program()?.program ?? this.bin, ctx.signal);
      return await this.ready;
    } catch (e) {
      this.ready = null;
      if (e instanceof SandboxError) throw new SandboxError(`${this.where(ctx)}: ${e.message}`, e.code);
      throw e;
    }
  }

  /** A compose command of this project. */
  protected compose(ref: ComposeProjectRef, args: string[], opts: DockerRunOptions = {}): Promise<DockerResult> {
    return this.run([...composeArgs(ref), ...args], {
      // A fixed folder (never the caller's): what compose resolves against the process's cwd resolves there.
      cwd: ref.dir,
      ...opts,
      ...(ref.overrideText !== undefined ? { input: ref.overrideText } : {}),
      ...(ref.envKeys?.length ? { unset: ref.envKeys } : {}),
      ...(ref.pass?.length ? { pass: ref.pass } : {}),
      onSpawn: (c) => {
        this.child = c;
        opts.onSpawn?.(c);
      },
    }).finally(() => {
      this.child = null;
    });
  }

  /** The compose files as docker reads them. Throws SandboxError when docker refuses them. */
  async config(ctx: ProviderContext, ref: ComposeProjectRef = this.ref(ctx)): Promise<ComposeConfig> {
    const r = await this.compose(ref, ['config', '--format', 'json'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose cannot read ${ref.files.map((f) => shownPath(f)).join(', ')}: ${firstErrorLine(r)}`);
    try {
      return parseComposeConfig(r.stdout, ref.name);
    } catch (e) {
      throw new SandboxError(`${this.where(ctx)}: unexpected output of docker compose config: ${errorMessage(e)}`);
    }
  }

  /**
   * The project's containers (stopped ones too). Every command reads them first: containers of this project name made
   * from another folder (another checkout sharing a `compose.project`) refuse it — never read, reset or touched.
   */
  async ps(ctx: ProviderContext, ref: ComposeProjectRef = this.ref(ctx)): Promise<PsEntry[]> {
    const r = await this.compose(ref, ['ps', '--all', '--format', 'json'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose ps failed: ${firstErrorLine(r)}`);
    let ps: PsEntry[];
    try {
      ps = parsePs(r.stdout);
    } catch (e) {
      throw new SandboxError(`${this.where(ctx)}: unexpected output of docker compose ps: ${errorMessage(e)}`);
    }
    this.checkOwnFolder(ctx, ref, ps);
    return ps;
  }

  /** Containers of this project name made from another folder (another checkout): refused, never touched. */
  private checkOwnFolder(ctx: ProviderContext, ref: ComposeProjectRef, ps: readonly PsEntry[]): void {
    for (const e of ps) {
      const wd = e.labels['com.docker.compose.project.working_dir'];
      if (wd && !ownFolder(ref, wd)) {
        throw new SandboxError(
          `${this.where(ctx)}: compose project ${ref.name} belongs to another folder (${wd}): give this sandbox its own name (compose.project in ${shownPath(ctx.sandbox.file)}), or remove the other one (docker compose -p ${ref.name} down, from that folder)`,
        );
      }
    }
  }

  /** Is this container one of the sandbox's own: its compose project, made from its folder? */
  protected ownContainer(ref: ComposeProjectRef, project: string, dir: string | undefined): boolean {
    return project === ref.name && !!dir && ownFolder(ref, dir);
  }

  /** The compose projects an earlier up of this sandbox used under another name (compose.project changed since). */
  protected previousRefs(ctx: ProviderContext, ref: ComposeProjectRef): ComposeProjectRef[] {
    const rec = composeRecord(ctx.state);
    const out: ComposeProjectRef[] = [];
    const add = (project: string, dir: string) => {
      if (project !== ref.name && !out.some((p) => p.name === project)) out.push({ name: project, dir: dir ? realpathOr(dir, resolve(dir)) : ref.dir, files: [] });
    };
    for (const p of rec?.previous ?? []) add(p.project, p.dir);
    if (rec) add(rec.project, rec.dir);
    return out;
  }

  /** "retake sandbox down <project> [--env <env>]": the command that takes this sandbox down. */
  protected downCommand(ctx: ProviderContext): string {
    return `retake sandbox down ${ctx.project.slug}${sandboxNames(ctx.project)[0] === ctx.sandbox.env ? '' : ` --env ${ctx.sandbox.env}`}`;
  }

  /**
   * The containers of other projects publishing these host ports, on any address: OrbStack lets another container
   * publish a port next to the sandbox's 127.0.0.1 (on [::1] or [::]) — lsof then shows the runtime's helper alone, and
   * `localhost` may reach that container. `docker ps --filter publish=<port>` sees them.
   */
  private async otherPublishers(ctx: ProviderContext, ref: ComposeProjectRef, ports: readonly number[]): Promise<Array<{ port: number; by: PortContainer }>> {
    const wanted = [...new Set(ports)];
    if (!wanted.length) return [];
    const r = await this.run(['ps', ...wanted.flatMap((p) => ['--filter', `publish=${p}`]), '--format', '{{json .}}'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker ps failed: ${firstErrorLine(r)}`);
    let containers: PortContainer[];
    try {
      containers = parseDockerPs(r.stdout);
    } catch (e) {
      throw new SandboxError(`${this.where(ctx)}: unexpected output of docker ps: ${errorMessage(e)}`);
    }
    const out: Array<{ port: number; by: PortContainer }> = [];
    for (const c of containers) {
      if (this.ownContainer(ref, c.project, c.dir)) continue;
      for (const port of wanted) if (c.ports.some((p) => p.port === port)) out.push({ port, by: c });
    }
    return out;
  }

  /** Throws SandboxError port when a container of another project publishes one of these ports (otherPublishers). */
  protected async checkOtherPublishers(ctx: ProviderContext, ref: ComposeProjectRef, ports: ReadonlyArray<{ port: number; label: string }>, why: string): Promise<void> {
    const found = await this.otherPublishers(
      ctx,
      ref,
      ports.map((p) => p.port),
    );
    if (!found.length) return;
    const previous = this.previousRefs(ctx, ref).map((p) => p.name);
    const lines = found.map(({ port, by }) => {
      const label = ports.find((p) => p.port === port)?.label ?? `port ${port}`;
      const on = [...new Set(by.ports.filter((p) => p.port === port).map((p) => (p.host.includes(':') ? `[${p.host}]` : p.host || '*')))].join(', ');
      const project = !by.project
        ? ''
        : previous.includes(by.project)
          ? ` of compose project ${by.project} — the name an earlier up of this sandbox used (compose.project changed since): ${this.downCommand(ctx)} takes it down`
          : ` of compose project ${by.project}`;
      return `${label} is also published by container ${by.name}${project} (on ${on})`;
    });
    throw new SandboxError(`${this.where(ctx)}: ${lines.join('; ')} — ${why}: stop it or change the port in ${filesText(ref)}`, 'port');
  }

  /** Every port of the manifest's services (url, pages, health) must be one the compose files publish. */
  protected checkDeclaredPorts(ctx: ProviderContext, cfg: ComposeConfig): void {
    const published = new Set(cfg.ports.map((p) => p.port));
    const missing = sandboxPorts(ctx.sandbox.manifest).filter((p) => !published.has(p.port));
    if (!missing.length) return;
    const list = [...published].sort((a, b) => a - b).join(', ') || 'none';
    throw new SandboxError(
      `${this.where(ctx)}: ${missing.map(portLabel).join('; ')} ${missing.length === 1 ? 'is' : 'are'} not published by the compose files (they publish: ${list}) — publish ${missing.length === 1 ? 'it' : 'them'} ("127.0.0.1:<port>:<container port>"), or change the URL in ${shownPath(ctx.sandbox.file)}`,
      'port',
    );
  }

  /** Before up: the published ports not held by this project's running containers must be free. */
  protected async checkFree(ctx: ProviderContext, ref: ComposeProjectRef, cfg: ComposeConfig, ps: readonly PsEntry[]): Promise<void> {
    const ours = new Set(ps.filter((e) => e.state === 'running').flatMap((e) => e.publishers.map((p) => p.port)));
    const ports: SandboxPort[] = [];
    for (const p of cfg.ports) {
      if (ours.has(p.port) || ports.some((x) => x.port === p.port)) continue;
      ports.push({ port: p.port, service: p.service, what: ['published'] });
    }
    const busy = await busyPorts(ports);
    if (!busy.length) return;
    const lines = busy.map(({ port, by }) => {
      if (!by) return `${portLabel(port)} is in use by another program (lsof cannot see it: another user's?)`;
      // The container runtime's forwarder: a container of another project publishes it (docker ps shows which).
      if (by.every((l) => DOCKER_HELPER.test(l.command))) return `${portLabel(port)} is published by another container (${describeListeners(by)}; docker ps shows which)`;
      return `${portLabel(port)} is in use by another program (${describeListeners(by)})`;
    });
    throw new SandboxError(`${this.where(ctx)}: ${lines.join('; ')} — stop it or change the port in ${filesText(ref)}`, 'port');
  }

  /** After up: the runtime alone listens on the project's published ports. */
  protected async checkOwned(ctx: ProviderContext, ref: ComposeProjectRef, ps: readonly PsEntry[]): Promise<void> {
    const ports = [...new Set(ps.filter((e) => e.state === 'running').flatMap((e) => e.publishers.filter((p) => p.protocol === 'tcp').map((p) => p.port)))];
    if (!ports.length) return;
    const ls = await this.listen(ports);
    if (ls === null) return; // no lsof: the pre-check still ran
    const foreign = foreignListeners(ports, ls);
    if (!foreign.length) return;
    const lines = foreign.map(({ port, by }) => {
      const svc = ps.find((e) => e.publishers.some((p) => p.port === port))?.service ?? '?';
      return `port ${port} (service ${svc}, published) is also used by another program (${describeListeners(by)})`;
    });
    throw new SandboxError(`${this.where(ctx)}: ${lines.join('; ')} — part of the traffic would not reach the sandbox: stop it or change the port in ${filesText(ref)}`, 'port');
  }

  /** The last lines of a service's logs (indented), or ''. */
  private async logTail(ref: ComposeProjectRef, service: string, lines = COMPOSE_LOG_TAIL): Promise<string> {
    const r = await this.compose(ref, ['logs', '--no-color', '--no-log-prefix', '--tail', String(lines), service], { timeoutMs: 20_000 });
    return `${r.stdout}${r.stderr}`.trim();
  }

  /** A message with one service's log tail and where to read more. */
  protected async withTail(ctx: ProviderContext, ref: ComposeProjectRef, message: string, service: string): Promise<string> {
    const tail = await bestEffort(this.logTail(ref, service), 'the log tail only adds context to the error being raised', '');
    const more = `(retake sandbox logs ${ctx.project.slug} --env ${ctx.sandbox.env} shows more)`;
    return tail ? `${message}\n— last lines of docker compose logs ${service}:\n${indent(tail)}\n${more}` : `${message} ${more}`;
  }

  protected async failure(ctx: ProviderContext, ref: ComposeProjectRef, head: string, problems: Array<{ service: string; problem: string }>): Promise<string> {
    const parts = [`${head}:`, ...problems.map((p) => `  ${p.service}: ${p.problem}`)];
    for (const p of problems.slice(0, 3)) {
      const tail = await bestEffort(this.logTail(ref, p.service), 'the log tail only adds context to the error being raised', '');
      if (tail) parts.push(`— last lines of docker compose logs ${p.service}:\n${indent(tail)}`);
    }
    parts.push(`(retake sandbox logs ${ctx.project.slug} --env ${ctx.sandbox.env} shows more)`);
    return parts.join('\n');
  }

  /**
   * The server of every Postgres database of sandbox.yaml answers `SELECT 1` on it (pg_isready can say ready while init
   * scripts run). A database that does not exist yet (the seed creates it; an interrupted restore dropped it) or allows
   * no connections (an interrupted reset) counts: its server answers, and the reset repairs it.
   */
  protected async waitDatabases(ctx: ProviderContext, timeoutS: number): Promise<void> {
    for (const [key, db] of Object.entries(ctx.sandbox.manifest.databases ?? {})) {
      if (!/^postgres(ql)?:/i.test(db.url)) continue;
      const url = await resolveDatabaseUrl(ctx.project, db.url, ctx.resolveSecret);
      const named = pgEndpoint(url, `${this.where(ctx)}: database ${key}`);
      // A port the project publishes, named by a host name: on the address Docker publishes it on, never `localhost`.
      const address = db.external || isIP(named.host) ? undefined : this.addresses.get(named.port);
      const endpoint = address ? { ...named, host: address } : named;
      const { host, port, database } = endpoint;
      const t0 = Date.now();
      let tries = 0;
      for (;;) {
        if (ctx.signal?.aborted) throw interrupted(`${this.where(ctx)}: database ${key} was not ready yet`);
        tries++;
        const why = await pgAnswers(endpoint);
        if (why === null) break;
        if (Date.now() - t0 >= timeoutS * 1000) {
          throw new SandboxError(`${this.where(ctx)}: database ${key} (${database} on ${host}:${port}) does not answer SELECT 1 after ${timeoutS} s: ${why} (${tries} tries)`, 'unhealthy');
        }
        await sleep(500);
      }
    }
  }

  /** The volumes of a compose project (by its label). */
  protected async volumesOf(ctx: ProviderContext, project: string): Promise<string[]> {
    const r = await this.run(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker volume ls failed: ${firstErrorLine(r)}`);
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** The address Docker publishes each port of these (own, running) containers on: where pg and health checks connect. */
  protected remember(ps: readonly PsEntry[]): void {
    const hosts = new Map<number, string[]>();
    for (const e of ps) {
      if (e.state !== 'running') continue;
      for (const p of e.publishers) if (p.protocol === 'tcp') hosts.set(p.port, [...(hosts.get(p.port) ?? []), p.host]);
    }
    for (const [port, h] of hosts) {
      const address = connectAddress(h);
      if (address) this.addresses.set(port, address);
    }
  }

  /** Wait until these services run and are healthy again (after a restart). */
  protected async waitRunning(ctx: ProviderContext, ref: ComposeProjectRef, services: string[], timeoutS: number): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      if (ctx.signal?.aborted) throw interrupted(this.where(ctx));
      const ps = await this.ps(ctx, ref);
      const problems = serviceProblems(services, ps);
      if (!problems.length) {
        this.remember(ps);
        return;
      }
      if (Date.now() - t0 >= timeoutS * 1000) throw new SandboxError(await this.failure(ctx, ref, `${this.where(ctx)}: not healthy ${timeoutS} s after a restart`, problems), 'unhealthy');
      await sleep(500);
    }
  }

  /**
   * Stop, inside the service's container, every process an exec step started (they carry its token): SIGTERM, up to
   * 3 s, then SIGKILL (`KILL`: SIGKILL at once). A container without sh / /proc cannot be reached: null on success,
   * else what is left to do.
   */
  protected async killExec(ref: ComposeProjectRef, service: string, token: string, how: 'TERM' | 'KILL'): Promise<string | null> {
    const r = await this.compose(ref, ['exec', '-T', service, 'sh', '-c', KILL_EXEC_SCRIPT, 'sh', token, how], { timeoutMs: 20_000 });
    return r.code === 0 ? null : `the exec step's processes could not be stopped inside service ${service} (${firstErrorLine(r)}): docker compose -p ${ref.name} restart ${service} stops them`;
  }
}
