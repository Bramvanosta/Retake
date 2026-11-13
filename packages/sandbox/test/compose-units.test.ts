/**
 * The docker-compose provider without Docker (L1.8 part C): project names, compose argv, `ps` / `config` parsing in both
 * output forms, the post-`--wait` verification (never the exit code), the port checks (busy before, foreign listeners
 * after), exec / down / status / logs / hash inputs / snapshot ownership on a fake docker, the own-folder check of every
 * command, a renamed compose.project, other projects' containers publishing a sandbox port (docker ps) and the
 * published address health checks / the mailbox clear connect to, the version and daemon checks, the snapshot helpers,
 * `retake sandbox init` (files, ports, project.yaml edited in place, existing files, validation) and core
 * addSandboxEntry.
 */
import { resolveSecretRef } from '@retake/core/io';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSandboxEntry, PERSON_POLICY, workPolicyFrom } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { LoadedProject, WorkPolicy } from '@retake/core';
import {
  ComposeProvider,
  SandboxError,
  composeArgs,
  composeProject,
  composeProjectName,
  KILL_EXEC_SCRIPT,
  dockerEnv,
  dockerReady,
  checkOnce,
  clearMailbox,
  connectAddress,
  emptyState,
  findDocker,
  foreignListeners,
  initSandbox,
  openSandbox,
  parseComposeConfig,
  parseLabels,
  parsePostgresUrl,
  parseDockerPs,
  parsePs,
  pinHealth,
  pinnedAddress,
  pgEndpoint,
  parseVersion,
  quoteIdent,
  quoteLiteral,
  runSeed,
  sandboxPaths,
  schemaRef,
  serviceProblems,
  snapshotComment,
  snapshotTarget,
  versionAtLeast,
  waitTimeoutS,
} from '@retake/sandbox';
import type { DockerExec, DockerResult, Listener, ProviderContext, PsEntry } from '@retake/sandbox';

/** The policy the work below runs under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
let policy: WorkPolicy = PERSON_POLICY;

/** The scaffold's writer in these tests: plain files (the engine's project store in the CLI). */
const plainWrite = async (file: string, text: string): Promise<void> => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
};

let tmp = '';
const afterAllClose: Server[] = [];
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-compose-units-'));
});
afterAll(async () => {
  for (const s of afterAllClose) s.close();
  await rm(tmp, { recursive: true, force: true });
});

const COMPOSE = ['services:', '  app: {image: busybox:1.38.0}', '  db: {image: postgres:17-alpine}', ''].join('\n');

/** A project with one docker-compose sandbox (`sandbox.yaml` lines), loaded. */
async function composeProjectDir(name: string, manifest: string[], compose = COMPOSE): Promise<LoadedProject> {
  const dir = join(tmp, name);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Compose test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
  await writeFile(join(dir, 'sandbox', 'compose.yaml'), compose);
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), ['version: 1', 'provider: docker-compose', ...manifest, ''].join('\n'));
  return loadProject(dir);
}

const ok = (stdout = ''): Partial<DockerResult> => ({ code: 0, stdout });

/** A fake docker: the first route whose pattern matches the joined argv answers; every call is recorded. */
function fakeDocker(routes: Array<[RegExp, Partial<DockerResult> | ((args: string[]) => Partial<DockerResult>)]>): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: DockerExec = async (args, opts) => {
    calls.push(args);
    const text = args.join(' ');
    for (const [re, answer] of routes) {
      if (!re.test(text)) continue;
      const a = typeof answer === 'function' ? answer(args) : answer;
      for (const line of `${a.stdout ?? ''}`.split('\n')) if (line.trim()) opts?.onLine?.(line);
      return { code: 0, stdout: '', stderr: '', ms: 1, ...a };
    }
    return { code: 1, stdout: '', stderr: `no route for: ${text}`, ms: 1 };
  };
  return { exec, calls };
}

const READY: Array<[RegExp, Partial<DockerResult>]> = [
  [/^compose version --short$/, ok('5.1.2\n')],
  [/^info --format/, ok('29.4.0\n')],
  // No container of another project publishes the ports; no volume left by an earlier name.
  [/^ps (--filter publish=\d+ )+--format \{\{json \.\}\}$/, ok('')],
  [/^volume ls --filter label=com\.docker\.compose\.project=/, ok('')],
];

function psLine(o: { service: string; state?: string; health?: string; id?: string; ports?: number[]; wd?: string; exit?: number }): string {
  return JSON.stringify({
    Service: o.service,
    Name: `p-${o.service}-1`,
    ID: o.id ?? `id-${o.service}`,
    State: o.state ?? 'running',
    Health: o.health ?? '',
    ExitCode: o.exit ?? 0,
    Status: 'Up 2 seconds',
    Labels: `com.docker.compose.project=p,com.docker.compose.service=${o.service}${o.wd ? `,com.docker.compose.project.working_dir=${o.wd}` : ''}`,
    Publishers: (o.ports ?? []).map((p) => ({ URL: '127.0.0.1', TargetPort: 80, PublishedPort: p, Protocol: 'tcp' })),
  });
}

function configJson(services: Record<string, number[]>): string {
  return JSON.stringify({
    services: Object.fromEntries(
      Object.entries(services).map(([s, ports]) => [s, { image: `${s}:1`, ports: ports.map((p) => ({ host_ip: '127.0.0.1', target: 80, published: String(p), protocol: 'tcp' })) }]),
    ),
  });
}

function ctxOf(project: LoadedProject): ProviderContext & { logs: string[] } {
  const sandbox = project.sandboxes!.sandbox;
  const logs: string[] = [];
  const ctx = {
    resolveSecret: resolveSecretRef,
    project,
    policy,
    sandbox,
    paths: sandboxPaths(project.dir, 'sandbox'),
    state: emptyState('sandbox', 'docker-compose'),
    save: () => undefined,
    log: (_l: string, m: string) => logs.push(m),
    logs,
  };
  return ctx as ProviderContext & { logs: string[] };
}

/** An HTTP server answering 200 on a free port. */
async function httpServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

describe('compose project, argv and output parsing', () => {
  it('names a project retake-<slug>-<env>-<hash of the folder>, at most 63 characters, distinct per folder', () => {
    const a = composeProjectName('northfield-fixture', 'sandbox', '/work/a/northfield-fixture/sandbox');
    const b = composeProjectName('northfield-fixture', 'sandbox', '/work/b/northfield-fixture/sandbox');
    expect(a).toMatch(/^retake-northfield-fixture-sandbox-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(composeProjectName('northfield-fixture', 'sandbox', '/work/a/northfield-fixture/sandbox')).toBe(a);
    const long = composeProjectName('A Very Long Project Name With Spaces And Ünïcode'.repeat(3), 'Sandbox_Docker', '/x');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^retake-[a-z0-9][a-z0-9_-]*-[0-9a-f]{8}$/);
  });

  it('builds every compose call with --ansi never, the project name, its folder and its files', async () => {
    const project = await composeProjectDir('argv', [
      'compose: {files: [compose.yaml], project: retake-test-argv}',
      'services:',
      '  app: {url: "http://localhost:4600", pages: {app: "http://localhost:4600"}}',
    ]);
    const ref = composeProject(project, project.sandboxes!.sandbox);
    expect(ref.name).toBe('retake-test-argv');
    expect(composeArgs(ref)).toEqual(['compose', '--ansi', 'never', '-p', 'retake-test-argv', '--project-directory', ref.dir, '-f', join(ref.dir, 'compose.yaml')]);
  });

  it('parses ps --format json as NDJSON (Compose 2.21+) and as one array (older); labels with commas in values; one-off containers left out', () => {
    const line = JSON.stringify({
      Service: 'db',
      Name: 'p-db-1',
      ID: 'abc',
      State: 'running',
      Health: 'healthy',
      ExitCode: 0,
      Status: 'Up 1 minute (healthy)',
      Labels: 'com.docker.compose.project.config_files=/a/compose.yaml,/a/extra.yaml,com.docker.compose.project.working_dir=/a,com.docker.compose.service=db',
      Publishers: [
        { URL: '127.0.0.1', TargetPort: 5432, PublishedPort: 4601, Protocol: 'tcp' },
        { URL: '', TargetPort: 9, PublishedPort: 0, Protocol: 'tcp' },
      ],
    });
    const oneoff = JSON.stringify({ Service: 'db', Name: 'p-db-run-1', State: 'running', Labels: 'com.docker.compose.oneoff=True' });
    const nd = parsePs(`${line}\n${oneoff}\n`);
    const arr = parsePs(JSON.stringify([JSON.parse(line), JSON.parse(oneoff)]));
    expect(nd).toEqual(arr);
    expect(nd).toHaveLength(1);
    expect(nd[0]).toMatchObject({ service: 'db', state: 'running', health: 'healthy', publishers: [{ port: 4601, target: 5432, host: '127.0.0.1', protocol: 'tcp' }] });
    expect(nd[0].labels['com.docker.compose.project.config_files']).toBe('/a/compose.yaml,/a/extra.yaml');
    expect(nd[0].labels['com.docker.compose.project.working_dir']).toBe('/a');
    expect(parsePs('')).toEqual([]);
    expect(parseLabels('a=1,b=x,y,c=3')).toEqual({ a: '1', b: 'x,y', c: '3' });
  });

  it('reads config --format json: services, published TCP ports (ranges expanded, unpublished and UDP left out), images', () => {
    const cfg = parseComposeConfig(
      JSON.stringify({
        services: {
          app: {
            ports: [
              { published: '4700-4702', target: 80, protocol: 'tcp' },
              { target: 81, protocol: 'tcp' },
              { published: '4703', target: 53, protocol: 'udp' },
            ],
          },
          db: { image: 'postgres:17-alpine', ports: [{ host_ip: '127.0.0.1', published: '4601', target: 5432, protocol: 'tcp' }] },
        },
      }),
      'proj',
    );
    expect(cfg.services).toEqual(['app', 'db']);
    expect(cfg.ports.map((p) => `${p.service}:${p.host || '*'}:${p.port}`)).toEqual(['app:*:4700', 'app:*:4701', 'app:*:4702', 'db:127.0.0.1:4601']);
    expect(cfg.images).toEqual({ app: 'proj-app', db: 'postgres:17-alpine' });
  });

  it('judges containers by state and health, never by the exit code of up --wait', () => {
    const ps: PsEntry[] = parsePs(
      [
        psLine({ service: 'app', health: 'healthy' }),
        psLine({ service: 'db', health: 'starting' }),
        psLine({ service: 'job', state: 'exited', exit: 0 }),
        psLine({ service: 'cache' }),
        psLine({ service: 'sick', health: 'unhealthy' }),
      ].join('\n'),
    );
    expect(serviceProblems(['app', 'db', 'job', 'cache', 'sick', 'gone'], ps)).toEqual([
      { service: 'db', problem: 'running, health starting (not healthy yet)' },
      { service: 'job', problem: 'exited (exit code 0)' },
      { service: 'sick', problem: 'running, unhealthy' },
      { service: 'gone', problem: 'no container' },
    ]);
  });

  it('finds the programs that share a published port with the container runtime', () => {
    const helper = (port: number): Listener => ({ pid: 100, pgid: 100, command: 'OrbStack Helper', port });
    const node = (port: number): Listener => ({ pid: 200, pgid: 200, command: 'node', port });
    expect(foreignListeners([4600, 4601], [helper(4600), helper(4601)])).toEqual([]);
    expect(foreignListeners([4600, 4601], [helper(4600), helper(4601), node(4600)])).toEqual([{ port: 4600, by: [node(4600)] }]);
    // An unknown runtime: the one program on every published port is it.
    const odd = (port: number): Listener => ({ pid: 300, pgid: 300, command: 'mystery-vm', port });
    expect(foreignListeners([4600, 4601], [odd(4600), odd(4601)])).toEqual([]);
    expect(foreignListeners([4600, 4601], [odd(4600), node(4601)])).toHaveLength(2);
    expect(foreignListeners([4600], [])).toEqual([]);
  });

  it('versions, the docker binary and its environment', () => {
    expect(parseVersion('5.1.2')).toEqual([5, 1, 2]);
    expect(parseVersion('v2.29.1-desktop.1')).toEqual([2, 29, 1]);
    expect(parseVersion('Docker Compose version v2.20.0')).toEqual([2, 20, 0]);
    expect(versionAtLeast([5, 1, 2], [2, 17, 0])).toBe(true);
    expect(versionAtLeast([2, 16, 9], [2, 17, 0])).toBe(false);
    expect(versionAtLeast([2, 17, 0], [2, 17, 0])).toBe(true);
    expect(findDocker({ RETAKE_DOCKER: '/opt/x/docker', PATH: '/bin' }, () => false)).toBe('/opt/x/docker');
    expect(findDocker({ PATH: '/nowhere' }, (p) => p === '/home/u/.orbstack/bin/docker', '/home/u')).toBe('/home/u/.orbstack/bin/docker');
    expect(findDocker({ PATH: '/nowhere' }, () => false, '/home/u')).toBeNull();
    const env = dockerEnv(policy, { PATH: '/bin', COMPOSE_PROFILES: 'extra', COMPOSE_FILE: 'x.yaml', compose_project_name: 'y', DOCKER_HOST: 'unix:///x' });
    expect(env).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///x' });
  });

  it('refuses a missing compose plugin, an old Compose and a stopped daemon with what to do', async () => {
    const run = (routes: Array<[RegExp, Partial<DockerResult>]>) => dockerReady(fakeDocker(routes).exec, 'docker');
    await expect(run([[/compose version/, { code: 1, stderr: "docker: 'compose' is not a docker command." }]])).rejects.toThrow(/`docker compose` is not available .*Compose v2 plugin/);
    await expect(run([[/compose version/, ok('2.12.2')]])).rejects.toThrow(/this one is 2\.12\.2 — update Docker/);
    await expect(
      run([
        [/compose version/, ok('2.20.0')],
        [/^info/, { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }],
      ]),
    ).rejects.toThrow(/the Docker daemon is not running \(start Docker Desktop or OrbStack\): Cannot connect/);
    await expect(run([[/compose version/, { code: null, error: 'spawn docker ENOENT' }]])).rejects.toThrow(/could not be run \(spawn docker ENOENT\)/);
    expect(await run(READY)).toEqual({ bin: 'docker', compose: '5.1.2', server: '29.4.0' });
  });

  it('waits as long as the longest health timeout of the manifest (default 120 s)', async () => {
    const project = await composeProjectDir('wait', ['services:', '  app: {url: "http://localhost:4600", health: {path: /, timeout_s: 300}, pages: {app: "http://localhost:4600"}}']);
    expect(waitTimeoutS(project.sandboxes!.sandbox)).toBe(300);
    const short = await composeProjectDir('wait3', ['services:', '  app: {url: "http://localhost:4600", health: {path: /, timeout_s: 5}, pages: {app: "http://localhost:4600"}}']);
    expect(waitTimeoutS(short.sandboxes!.sandbox)).toBe(5);
    const plain = await composeProjectDir('wait2', ['services:', '  app: {url: "http://localhost:4600", pages: {app: "http://localhost:4600"}}']);
    expect(waitTimeoutS(plain.sandboxes!.sandbox)).toBe(120);
  });
});

describe('the compose provider on a fake docker', () => {
  it('up: the exit code of `up --wait` is not trusted — a service still starting fails with its state and logs, then stop removes what it started', async () => {
    const project = await composeProjectDir('up-starting', ['services:', '  app: {url: "http://localhost:47391", pages: {app: "http://localhost:47391"}}']);
    let upDone = false;
    const { exec, calls } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47391], db: [] }))],
      [/ ps --all --format json$/, () => ok(upDone ? [psLine({ service: 'app', health: 'healthy', ports: [47391] }), psLine({ service: 'db', health: 'starting' })].join('\n') : '')],
      [/ up -d --wait --wait-timeout 120 --remove-orphans$/, () => ((upDone = true), ok(' Container p-db-1 Waiting'))],
      [/ logs --no-color --no-log-prefix --tail 30 db$/, ok('database system is starting up')],
      [/ stop app db$/, ok()],
    ]);
    const provider = new ComposeProvider({ policy, exec, listeners: async () => [] });
    const ctx = ctxOf(project);
    const err = await provider.up(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('unhealthy');
    expect((err as Error).message).toMatch(
      /not every service is running and healthy after 120 s:\n {2}db: running, health starting \(not healthy yet\)\n— last lines of docker compose logs db:\n {4}database system is starting up/,
    );
    // The project was on disk before anything started.
    expect(ctx.state.provider_state?.compose).toMatchObject({ project: composeProject(project, project.sandboxes!.sandbox).name });
    expect(await provider.stopStarted(ctx)).toEqual(['app', 'db']);
    expect(calls.some((c) => c.join(' ').endsWith(' stop app db'))).toBe(true);
  });

  it('up: running services are kept, the manifest health checked, nothing started (and --build passed through)', async () => {
    const { server, port } = await httpServer();
    try {
      const project = await composeProjectDir('up-kept', ['services:', `  app: {url: "http://localhost:${port}", health: /, pages: {app: "http://localhost:${port}"}}`]);
      const ps = [psLine({ service: 'app', health: 'healthy', ports: [port] }), psLine({ service: 'db' })].join('\n');
      const { exec, calls } = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [port], db: [] }))], [/ ps --all --format json$/, ok(ps)], [/ up -d --wait /, ok()]]);
      const provider = new ComposeProvider({ policy, exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] });
      const res = await provider.up(ctxOf(project), { build: true });
      expect(res).toMatchObject({ started: [], kept: ['app', 'db'], changed: [] });
      expect(calls.find((c) => c.includes('up'))!.slice(-6)).toEqual(['-d', '--wait', '--wait-timeout', '120', '--remove-orphans', '--build']);
      expect(await provider.stopStarted(ctxOf(project))).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('up: a published port another program listens on is refused before anything starts, naming it; so is a manifest port nobody publishes', async () => {
    const { server, port } = await httpServer();
    try {
      const project = await composeProjectDir('up-busy', ['services:', `  app: {url: "http://localhost:${port}", pages: {app: "http://localhost:${port}"}}`]);
      const { exec, calls } = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [port], db: [] }))], [/ ps --all --format json$/, ok('')]]);
      const err = await new ComposeProvider({ policy, exec }).up(ctxOf(project)).catch((e: unknown) => e);
      expect((err as SandboxError).code).toBe('port');
      expect((err as Error).message).toMatch(
        new RegExp(`port ${port} \\(service app, published\\) is in use by another program \\(node, pid ${process.pid}\\) — stop it or change the port in .*compose\\.yaml`),
      );
      expect(calls.some((c) => c.includes('up'))).toBe(false);

      const unpublished = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [port + 1], db: [] }))], [/ ps --all --format json$/, ok('')]]);
      const err2 = await new ComposeProvider({ policy, exec: unpublished.exec }).up(ctxOf(project)).catch((e: unknown) => e);
      expect((err2 as Error).message).toMatch(new RegExp(`port ${port} \\(service app, url, page app\\) is not published by the compose files \\(they publish: ${port + 1}\\)`));
    } finally {
      server.close();
    }
  });

  it('up: after up, a second program on a published port is refused (part of the traffic would not reach the sandbox)', async () => {
    const { server, port } = await httpServer();
    try {
      const project = await composeProjectDir('up-foreign', ['services:', `  app: {url: "http://localhost:${port}", pages: {app: "http://localhost:${port}"}}`]);
      const ps = [psLine({ service: 'app', ports: [port] }), psLine({ service: 'db' })].join('\n');
      const { exec } = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [port], db: [] }))], [/ ps --all --format json$/, ok(ps)], [/ up -d --wait /, ok()]]);
      const provider = new ComposeProvider({
        policy,
        exec,
        listeners: async () => [
          { pid: 1, pgid: 1, command: 'OrbStack Helper', port },
          { pid: 4242, pgid: 4242, command: 'node', port },
        ],
      });
      const err = await provider.up(ctxOf(project)).catch((e: unknown) => e);
      expect((err as SandboxError).code).toBe('port');
      expect((err as Error).message).toMatch(new RegExp(`port ${port} \\(service app, published\\) is also used by another program \\(node, pid 4242\\)`));
    } finally {
      server.close();
    }
  });

  it('up and down refuse a compose project of the same name made from another folder (another checkout)', async () => {
    const project = await composeProjectDir('other-dir', ['compose: {project: retake-test-shared}', 'services:', '  app: {url: "http://localhost:47392", pages: {app: "http://localhost:47392"}}']);
    const ps = psLine({ service: 'app', wd: '/somewhere/else/sandbox' });
    const { exec, calls } = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [47392], db: [] }))], [/ ps --all --format json$/, ok(ps)]]);
    const provider = new ComposeProvider({ policy, exec });
    await expect(provider.up(ctxOf(project))).rejects.toThrow(
      /compose project retake-test-shared belongs to another folder \(\/somewhere\/else\/sandbox\): give this sandbox its own name \(compose\.project in/,
    );
    await expect(provider.down(ctxOf(project))).rejects.toThrow(/belongs to another folder/);
    expect(calls.some((c) => c.includes('up') || c.includes('down'))).toBe(false);
  });

  it('down: --remove-orphans, --volumes on request (the snapshot forgotten), never --rmi', async () => {
    const project = await composeProjectDir('down', ['services:', '  app: {url: "http://localhost:47393", pages: {app: "http://localhost:47393"}}']);
    const { exec, calls } = fakeDocker([...READY, [/ ps --all --format json$/, ok(psLine({ service: 'app' }))], [/ down /, ok()]]);
    const ctx = ctxOf(project);
    ctx.state.provider_state = { compose: { project: 'x' }, snapshot: { hash: 'h' } };
    const kept = await new ComposeProvider({ policy, exec }).down(ctxOf(project));
    expect(kept).toEqual({ stopped: ['app'], dataGone: false });
    const res = await new ComposeProvider({ policy, exec }).down(ctx, { volumes: true });
    expect(res).toEqual({ stopped: ['app'], dataGone: true });
    expect(ctx.state.provider_state).toEqual({});
    const downs = calls.filter((c) => c.includes('down')).map((c) => c.slice(c.indexOf('down')).join(' '));
    expect(downs).toContain('down --remove-orphans');
    expect(downs).toContain('down --remove-orphans --volumes');
    // The project name an earlier up recorded ("x") is taken down too, from its own folder (K2).
    const dir = composeProject(project, project.sandboxes!.sandbox).dir;
    expect(calls.some((c) => c.join(' ') === `compose --ansi never -p x --project-directory ${dir} down --remove-orphans --volumes`)).toBe(true);
    expect(calls.some((c) => c.includes('--rmi'))).toBe(false);
  });

  it('a renamed compose.project: up refuses while the old name runs, status names what it left, down takes it down from its folder and forgets it once its volumes are gone (K9)', async () => {
    const project = await composeProjectDir('renamed', ['compose: {project: retake-test-new}', 'services:', '  app: {url: "http://localhost:47408", pages: {app: "http://localhost:47408"}}']);
    const ref = composeProject(project, project.sandboxes!.sandbox);
    let oldPs = psLine({ service: 'app', ports: [47408], wd: ref.dir });
    let oldVolumes = 'retake-test-old_data\n';
    const { exec, calls } = fakeDocker([
      [/ -p retake-test-old .* ps --all --format json$/, () => ok(oldPs)],
      [/^volume ls --filter label=com\.docker\.compose\.project=retake-test-old /, () => ok(oldVolumes)],
      [/ -p retake-test-old .* down /, () => ((oldPs = ''), ok())],
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47408], db: [] }))],
      [/ ps --all --format json$/, ok('')],
      [/ down /, ok()],
    ]);
    const provider = new ComposeProvider({ policy, exec, listeners: async () => [] });
    const ctx = ctxOf(project);
    ctx.state.provider_state = { compose: { project: 'retake-test-old', dir: ref.dir } };
    await expect(provider.up(ctx)).rejects.toMatchObject({
      message: expect.stringMatching(
        /compose project retake-test-old — the name an earlier up of this sandbox used \(compose\.project changed since\) — is still running: retake sandbox down renamed takes it down/,
      ),
    });
    expect(calls.some((c) => c.includes('up'))).toBe(false);
    const st = await provider.status(ctx);
    expect(st.map((x) => x.name)).toEqual(['app', 'db']);
    expect(ctx.logs).toContain(
      'compose project retake-test-old — the name an earlier up of this sandbox used (compose.project changed since) — still has 1 container (running) and its volumes (retake-test-old_data): retake sandbox down renamed --volumes removes them',
    );
    // down: the old name too (from its folder); its volume stays, so does its name.
    await provider.down(ctx);
    expect(calls.some((c) => c.join(' ') === `compose --ansi never -p retake-test-old --project-directory ${ref.dir} down --remove-orphans`)).toBe(true);
    expect(ctx.state.provider_state?.compose).toEqual({ project: 'retake-test-new', dir: ref.dir, previous: [{ project: 'retake-test-old', dir: ref.dir }] });
    expect(ctx.logs.at(-1)).toMatch(/compose project retake-test-old .* still has its volumes \(retake-test-old_data\): retake sandbox down renamed --volumes removes them/);
    // down --volumes: nothing of it left — forgotten.
    oldVolumes = '';
    await provider.down(ctx, { volumes: true });
    expect(ctx.state.provider_state?.compose).toBeUndefined();
  });

  it('every command reads the project first: status, publishedBy, exec, restart and logs refuse a compose project of the same name made from another folder (K2)', async () => {
    const project = await composeProjectDir('other-dir-all', [
      'compose: {project: retake-test-shared2}',
      'services:',
      '  app: {url: "http://localhost:47404", pages: {app: "http://localhost:47404"}}',
    ]);
    const ps = psLine({ service: 'db', ports: [47405], wd: '/somewhere/else/sandbox' });
    const { exec, calls } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47404], db: [47405] }))],
      [/ ps --all --format json$/, ok(ps)],
      [/ (exec|restart|logs) /, ok('done\n')],
    ]);
    const provider = new ComposeProvider({ policy, exec, listeners: async () => [] });
    const other = /compose project retake-test-shared2 belongs to another folder \(\/somewhere\/else\/sandbox\)/;
    await expect(provider.status(ctxOf(project))).rejects.toThrow(other);
    await expect(provider.publishedBy(ctxOf(project), 47405)).rejects.toThrow(other);
    await expect(provider.servedBy(ctxOf(project), 47405, { what: 'the mailbox', why: 'x' })).rejects.toThrow(other);
    await expect(provider.exec(ctxOf(project), { service: 'db', command: 'psql -c "DROP TABLE t"' })).rejects.toThrow(other);
    await expect(provider.restart(ctxOf(project), 'app')).rejects.toThrow(other);
    await expect(provider.logs(ctxOf(project), { lines: 5 })).rejects.toThrow(other);
    expect(calls.filter((c) => c.includes('exec') || c.includes('restart') || c.includes('logs'))).toEqual([]);
    // A container of the project without the folder label is not taken for the sandbox's own either.
    const unlabelled = fakeDocker([...READY, [/ ps --all --format json$/, ok(psLine({ service: 'db', ports: [47405] }))]]);
    await expect(new ComposeProvider({ policy, exec: unlabelled.exec, listeners: async () => [] }).publishedBy(ctxOf(project), 47405)).rejects.toMatchObject({
      code: 'port',
      message: expect.stringMatching(/port 47405 \(the snapshot's database\) is published by container p-db-1, which was not made from this sandbox's folder \(no folder label\)/),
    });
  });

  it('another container publishing a port of the sandbox (on [::1] / [::], next to its 127.0.0.1) is refused before up, after up and by publishedBy (K3)', async () => {
    const project = await composeProjectDir('intruder', ['services:', '  app: {url: "http://localhost:47406", pages: {app: "http://localhost:47406"}}']);
    const ref = composeProject(project, project.sandboxes!.sandbox);
    const intruder = JSON.stringify({
      Names: 'other-web-1',
      Labels: 'com.docker.compose.project=other,com.docker.compose.project.working_dir=/work/other',
      Ports: '[::]:47406->8080/tcp, [::]:47407->5432/tcp',
    });
    const own = JSON.stringify({ Names: 'p-app-1', Labels: `com.docker.compose.project=${ref.name},com.docker.compose.project.working_dir=${ref.dir}`, Ports: '127.0.0.1:47406->8080/tcp' });
    let others = `${own}\n${intruder}`;
    const ps = [psLine({ service: 'app', ports: [47406], wd: ref.dir }), psLine({ service: 'db', ports: [47407], wd: ref.dir })].join('\n');
    const { exec, calls } = fakeDocker([
      [/^ps (--filter publish=\d+ )+--format/, () => ok(others)],
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47406], db: [47407] }))],
      [/ ps --all --format json$/, ok(ps)],
      [/ up -d --wait /, () => ((others = `${own}\n${intruder}`), ok())],
    ]);
    const provider = new ComposeProvider({ policy, exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port: 47406 }] });
    const before = await provider.up(ctxOf(project)).catch((e: unknown) => e);
    expect(before).toMatchObject({ code: 'port' });
    expect((before as Error).message).toMatch(
      /port 47406 \(service app, published\) is also published by container other-web-1 of compose project other \(on \[::\]\); port 47407 \(service db, published\) is also published by container other-web-1 of compose project other \(on \[::\]\) — localhost could reach it instead of the sandbox: stop it or change the port in /,
    );
    expect(calls.some((c) => c.includes('up'))).toBe(false);
    // Free before up, published by another container once up ran.
    others = own;
    const after = await provider.up(ctxOf(project)).catch((e: unknown) => e);
    expect((after as Error).message).toMatch(/port 47406 \(service app, published\) is also published by container other-web-1 .* — part of the traffic would reach it, not the sandbox/);
    others = intruder;
    await expect(provider.publishedBy(ctxOf(project), 47407)).rejects.toThrow(
      /port 47407 \(the snapshot's database\) is also published by container other-web-1 of compose project other \(on \[::\]\)/,
    );
    others = own;
    expect(await provider.publishedBy(ctxOf(project), 47407)).toBe('db');
  });

  it('parses docker ps and picks the address to connect to: 127.0.0.1 for 0.0.0.0, ::1 for ::, IPv4 first (K3)', () => {
    const text = [
      JSON.stringify({
        Names: 'a',
        Labels: 'com.docker.compose.project=p,com.docker.compose.project.working_dir=/w',
        Ports: '0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 127.0.0.1:9000-9001->9000-9001/tcp, 1110/tcp, 0.0.0.0:53->53/udp',
      }),
      JSON.stringify({ Names: 'b', Labels: '', Ports: '' }),
    ].join('\n');
    expect(parseDockerPs(text)).toEqual([
      {
        name: 'a',
        project: 'p',
        dir: '/w',
        ports: [
          { port: 5432, host: '0.0.0.0' },
          { port: 5432, host: '::' },
          { port: 9000, host: '127.0.0.1' },
          { port: 9001, host: '127.0.0.1' },
        ],
      },
      { name: 'b', project: '', dir: '', ports: [] },
    ]);
    expect(connectAddress(['127.0.0.1'])).toBe('127.0.0.1');
    expect(connectAddress(['0.0.0.0', '::'])).toBe('127.0.0.1');
    expect(connectAddress(['::'])).toBe('::1');
    expect(connectAddress(['::1'])).toBe('::1');
    expect(connectAddress([''])).toBe('127.0.0.1');
    expect(connectAddress([])).toBeUndefined();
  });

  it('health checks, a mailbox clear and the snapshot reach the address Docker publishes on, never where localhost resolves first (K3)', async () => {
    // localhost:<port> on ::1 is another program answering 503; the sandbox's own service is on 127.0.0.1:<port>.
    const v4 = createServer((req, res) => {
      seen.push(`v4 ${req.method} ${req.url} host=${req.headers.host}`);
      res.end('ready');
    });
    const seen: string[] = [];
    await new Promise<void>((r) => v4.listen(0, '127.0.0.1', r));
    const port = (v4.address() as AddressInfo).port;
    const v6 = createServer((req, res) => {
      seen.push(`v6 ${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('not the sandbox');
    });
    const v6ok = await new Promise<boolean>((r) => {
      v6.once('error', () => r(false));
      v6.listen(port, '::1', () => r(true));
    });
    afterAllClose.push(v4, v6);
    const url = `http://localhost:${port}/up`;
    expect(await checkOnce({ kind: 'http', url, text: 'ready', address: '127.0.0.1' })).toBeNull();
    expect(seen.pop()).toBe(`v4 GET /up host=localhost:${port}`);
    if (v6ok) expect(await checkOnce({ kind: 'http', url })).toBe('HTTP 503'); // what localhost alone reaches here
    expect(
      pinHealth(
        {
          service: 'app',
          targets: [
            { kind: 'http', url },
            { kind: 'http', url: `http://127.0.0.1:${port}/` },
            { kind: 'http', url: 'http://localhost:1/' },
          ],
          timeoutMs: 1000,
          intervalMs: 10,
        },
        new Map([[port, '127.0.0.1']]),
      ).targets,
    ).toEqual([
      { kind: 'http', url, address: '127.0.0.1' },
      { kind: 'http', url: `http://127.0.0.1:${port}/` },
      { kind: 'http', url: 'http://localhost:1/' },
    ]);
    expect(pinnedAddress(`http://db.localhost:${port}/`, new Map([[port, '::1']]))).toBe('::1');
    expect(pinnedAddress(`http://[::1]:${port}/`, new Map([[port, '127.0.0.1']]))).toBeUndefined();
    // up: the manifest's health check goes to the published address.
    const project = await composeProjectDir('pinned', [
      'services:',
      `  app: {url: "http://localhost:${port}", health: {path: /up, text: ready}, pages: {app: "http://localhost:${port}"}}`,
      'mailbox: {provider: mailpit, url: "http://localhost:' + port + '"}',
    ]);
    const ref = composeProject(project, project.sandboxes!.sandbox);
    const { exec } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [port], db: [] }))],
      [/ ps --all --format json$/, ok([psLine({ service: 'app', health: 'healthy', ports: [port], wd: ref.dir }), psLine({ service: 'db', wd: ref.dir })].join('\n'))],
      [/ up -d --wait /, ok()],
    ]);
    const provider = new ComposeProvider({ policy, exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] });
    const ctx = ctxOf(project);
    seen.length = 0;
    await provider.up(ctx);
    expect(seen.filter((x) => x.startsWith('v6'))).toEqual([]);
    expect(seen).toContain(`v4 GET /up host=localhost:${port}`);
    expect(await provider.address(ctx, port)).toBe('127.0.0.1');
    // The mailbox clear: DELETE on the published address.
    seen.length = 0;
    expect(await clearMailbox(project, project.sandboxes!.sandbox, resolveSecretRef, (p) => provider.address(ctx, p))).toBe('cleared');
    expect(seen).toEqual([`v4 DELETE /api/v1/messages host=localhost:${port}`]);
  });

  it('exec: the command inside the service (sh -c for a string), values passed in the environment, output returned; a failure gives the exit code and the last lines', async () => {
    const project = await composeProjectDir('exec', [
      'services:',
      '  app: {url: "http://localhost:47394", pages: {app: "http://localhost:47394"}}',
      'seed:',
      '  - exec: {service: db, command: "psql -c \'select 1\'", env: {PGUSER: demo}}',
    ]);
    let env: Record<string, string> | undefined;
    const { exec, calls } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47394], db: [] }))],
      [/ ps --all --format json$/, ok('')],
      [/ exec -T -e RETAKE_EXEC -e PGUSER db sh -c psql -c 'select 1'$/, ok(' ?column?\n        1\n')],
      [/ exec -T -e RETAKE_EXEC -e TOKEN db sh -c echo/, ok('token is from-env-token-7\n')],
      [/ exec -T -e RETAKE_EXEC db false$/, { code: 3, stderr: 'boom\n' }],
    ]);
    const wrapped: DockerExec = (args, opts) => {
      if (args.includes('exec')) env = opts?.env;
      return exec(args, opts);
    };
    const provider = new ComposeProvider({ policy, exec: wrapped });
    const ctx = ctxOf(project);
    expect(await provider.exec(ctx, { service: 'db', command: "psql -c 'select 1'", env: { PGUSER: 'demo' } })).toContain('?column?');
    expect(env).toEqual({ PGUSER: 'demo', RETAKE_EXEC: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(calls.some((c) => c.join(' ').includes('PGUSER=demo'))).toBe(false);
    await expect(provider.exec(ctx, { service: 'db', command: ['false'] })).rejects.toThrow(/exited with code 3 — last lines:\n {4}boom/);
    expect(await readFile(join(ctx.paths.logs, 'seed.log'), 'utf8')).toMatch(/exec in db: psql -c 'select 1'\n \?column\?/);
    // A resolved secret is masked in what the step prints (seed.log, the returned output).
    process.env.RETAKE_TEST_EXEC_TOKEN = 'from-env-token-7';
    try {
      expect(await provider.exec(ctx, { service: 'db', command: 'echo "token is $TOKEN"', env: { TOKEN: '{{env:RETAKE_TEST_EXEC_TOKEN}}' } })).toBe('token is ***\n');
    } finally {
      delete process.env.RETAKE_TEST_EXEC_TOKEN;
    }
    const log = await readFile(join(ctx.paths.logs, 'seed.log'), 'utf8');
    expect(log).toContain('token is ***');
    expect(log).not.toContain('from-env-token-7');
  });

  it("exec: the hosts a step names are checked like a shell hook's — a compose service, localhost or an allowed host; never a production one (I5)", async () => {
    const project = await composeProjectDir('exechosts', ['services:', '  app: {url: "http://localhost:47402", pages: {app: "http://localhost:47402"}}']);
    project.config.environments.production = { app: 'https://app.example.com' };
    project.config.environment_settings = { ...project.config.environment_settings, production: { production: true } };
    project.config.vars = { remote: 'https://data.example.net/dump.sql' };
    const { exec, calls } = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [47402], db: [] }))], [/ ps --all --format json$/, ok('')], [/ exec -T /, ok('done\n')]]);
    const provider = new ComposeProvider({ policy, exec });
    const ctx = ctxOf(project);
    expect(await provider.exec(ctx, { service: 'app', command: 'curl -fsS http://db:5432/ http://localhost:47402/' })).toBe('done\n');
    // Templated hosts are seen once rendered (validation could not see them).
    await expect(provider.exec(ctx, { service: 'app', command: 'curl -fsS {{vars.remote}}' })).rejects.toMatchObject({
      code: 'seed',
      message: expect.stringMatching(/^refusing an exec step that names host data\.example\.net \(/),
    });
    await expect(provider.exec(ctx, { service: 'app', command: ['curl', '-X', 'POST', 'https://app.example.com/api/reset'] })).rejects.toThrow(/a host of environment production/);
    expect(calls.filter((c) => c.includes('exec') && c.join(' ').includes('curl')).length).toBe(1);
  });

  it("exec: an interrupt or a timeout stops the step's processes inside the container too, and stays an interrupt (K6)", async () => {
    const project = await composeProjectDir('execkill', [
      'services:',
      '  app: {url: "http://localhost:47403", pages: {app: "http://localhost:47403"}}',
      'seed:',
      '  - exec: {service: db, command: "sleep 30"}',
    ]);
    const killed: string[][] = [];
    const ready = fakeDocker([...READY, [/ config --format json$/, ok(configJson({ app: [47403], db: [] }))], [/ ps --all --format json$/, ok('')]]);
    const exec: DockerExec = async (args, opts) => {
      if (args.includes('-c') && args.includes(KILL_EXEC_SCRIPT)) {
        killed.push(args.slice(args.indexOf(KILL_EXEC_SCRIPT) + 1));
        return { code: 0, stdout: '', stderr: '', ms: 1 };
      }
      if (args.includes('exec')) {
        // The step "runs" until the signal aborts or its timeout passes.
        await new Promise<void>((r) => {
          opts?.signal?.addEventListener('abort', () => r(), { once: true });
          setTimeout(r, 300);
        });
        return opts?.signal?.aborted ? { code: null, stdout: '', stderr: '', ms: 1, aborted: true } : { code: null, stdout: '', stderr: '', ms: 1, timedOut: true };
      }
      return ready.exec(args, opts);
    };
    const provider = new ComposeProvider({ policy, exec });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const e = await provider.exec({ ...ctxOf(project), signal: ac.signal }, { service: 'db', command: 'sleep 30' }).catch((x) => x);
    expect(e).toMatchObject({ code: 'interrupted' });
    expect(killed).toEqual([['sh', expect.stringMatching(/^[0-9a-f]{16}$/), 'TERM']]);
    await expect(provider.exec(ctxOf(project), { service: 'db', command: 'sleep 30', timeout_s: 1 })).rejects.toThrow(/did not finish within 1 s \(timeout_s\): stopped/);
    expect(killed.length).toBe(2);
    // The seed keeps it an interrupt (exit 130), not a failed seed.
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 50);
    const ctx = { ...ctxOf(project), signal: ac2.signal };
    await expect(runSeed(ctx, provider, { by: 'test', log: () => undefined, signal: ac2.signal })).rejects.toMatchObject({ code: 'interrupted' });
    expect(killed.length).toBe(3);
  });

  it('seed reports: every step at its position among all the seed steps, an exec step too (kind exec, never its command)', async () => {
    const project = await composeProjectDir('seedreport', [
      'services:',
      '  app: {url: "http://localhost:47407", pages: {app: "http://localhost:47407"}}',
      'seed:',
      '  - {name: first, shell: "true"}',
      '  - {name: load, exec: {service: db, command: "echo loaded"}}',
      '  - {name: second, shell: "true"}',
      '  - {name: third, shell: "true"}',
      '  - {name: broken, exec: {service: db, command: "exit 4"}}',
    ]);
    const { exec } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47407], db: [] }))],
      [/ ps --all --format json$/, ok('')],
      [/ exec -T .*exit 4/, { code: 4, stdout: '' }],
      [/ exec -T /, ok('loaded\n')],
    ]);
    const provider = new ComposeProvider({ policy, exec });
    const seen: unknown[] = [];
    const ctx = { ...ctxOf(project), recordSeedRun: async (r: { index: number; name?: string; kind?: string; phase: string; status: string }) => void seen.push({ name: r.name, kind: r.kind, ...r }) };
    await expect(runSeed(ctx, provider, { by: 'test', log: () => undefined })).rejects.toMatchObject({ code: 'seed', message: expect.stringContaining('seed step 5/5') });
    expect(
      seen.map((r) => {
        const x = r as Record<string, unknown>;
        return `${x.index} ${x.name} ${x.kind} ${x.phase} ${x.status}`;
      }),
    ).toEqual(['0 first shell seed ok', '1 load exec seed ok', '2 second shell seed ok', '3 third shell seed ok', '4 broken exec seed failed']);
    // An exec step's report carries no command text.
    for (const r of seen.slice(1, 2).concat(seen.slice(4))) expect(JSON.stringify(r)).not.toMatch(/echo loaded|exit 4/);
  });

  it("status: every compose service (the manifest's first), its container and docker's health; logs through docker compose logs", async () => {
    // health: false still probes the pages (served here).
    const { server, port } = await httpServer();
    afterAllClose.push(server);
    const project = await composeProjectDir('status', ['services:', `  app: {url: "http://localhost:${port}", health: false, pages: {app: "http://localhost:${port}"}}`]);
    const ps = [psLine({ service: 'db', health: 'starting' }), psLine({ service: 'app', health: 'healthy', ports: [port] }), psLine({ service: 'old', state: 'exited', exit: 137 })].join('\n');
    const { exec } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [port], db: [] }))],
      [/ ps --all --format json$/, ok(ps)],
      [/ logs --no-color --no-log-prefix --tail 5 app$/, ok('GET /\n')],
      [/ logs --no-color --no-log-prefix --tail 5 db$/, ok('ready\n')],
    ]);
    const provider = new ComposeProvider({ policy, exec });
    const st = await provider.status(ctxOf(project));
    expect(st.map((s) => [s.name, s.state, s.healthy, s.orphan ?? false])).toEqual([
      ['app', 'running', true, false],
      ['db', 'starting', false, false],
      ['old', 'stopped', undefined, true],
    ]);
    expect(st[0].container).toBe('p-app-1');
    expect(st[1].health).toBe('running, health starting (not healthy yet)');
    expect(st[2].note).toBe('exited (exit code 137)');
    expect(await provider.logs(ctxOf(project), { lines: 5 })).toEqual([
      { service: 'app', source: expect.stringMatching(/^docker compose -p retake-status-sandbox-[0-9a-f]{8} logs app$/), text: 'GET /' },
      { service: 'db', source: expect.stringMatching(/logs db$/), text: 'ready' },
    ]);
    await expect(provider.logs(ctxOf(project), { service: 'nope', lines: 5 })).rejects.toThrow(/unknown service "nope" \(sandbox sandbox: app, db\)/);
  });

  it('hash inputs are the image ids of the services; a snapshot database must be published by a running service of the project', async () => {
    const project = await composeProjectDir('hash', ['services:', '  app: {url: "http://localhost:47396", pages: {app: "http://localhost:47396"}}']);
    const { exec } = fakeDocker([
      ...READY,
      [/ config --format json$/, ok(configJson({ app: [47396], db: [] }))],
      [/^image inspect --format \{\{\.Id\}\} app:1 db:1$/, ok('sha256:aaa\nsha256:bbb\n')],
      [
        / ps --all --format json$/,
        ok([psLine({ service: 'db', ports: [47397], wd: composeProject(project, project.sandboxes!.sandbox).dir }), psLine({ service: 'app', state: 'exited', ports: [] })].join('\n')),
      ],
    ]);
    const provider = new ComposeProvider({ policy, exec, listeners: async () => [] });
    expect(await provider.hashInputs(ctxOf(project))).toEqual(['image app=sha256:aaa', 'image db=sha256:bbb']);
    expect(await provider.publishedBy(ctxOf(project), 47397)).toBe('db');
    await expect(provider.publishedBy(ctxOf(project), 5432)).rejects.toThrow(
      /port 5432 \(the snapshot's database\) is not published by a running service of compose project retake-hash-sandbox-[0-9a-f]{8}/,
    );
    // servedBy (the mailbox, a seed's database): the same rule, its own words.
    await expect(provider.servedBy(ctxOf(project), 8025, { what: 'the mailbox http://localhost:8025', why: 'every reset empties it' })).rejects.toThrow(
      /port 8025 \(the mailbox http:\/\/localhost:8025\) is not published by a running service of compose project .* — every reset empties it$/,
    );
    expect(await provider.servedBy(ctxOf(project), 47397, { what: 'the mailbox', why: 'x' })).toBe('db');
    const foreign = new ComposeProvider({
      policy,
      exec,
      listeners: async () => [
        { pid: 9, pgid: 9, command: 'OrbStack Helper', port: 47397 },
        { pid: 10, pgid: 10, command: 'postgres', port: 47397 },
      ],
    });
    await expect(foreign.publishedBy(ctxOf(project), 47397)).rejects.toThrow(/also used by another program \(postgres, pid 10\)/);
  });

  it('a docker-compose sandbox without docker says how to get it (status, up)', async () => {
    const project = await composeProjectDir('nodocker', ['services:', '  app: {url: "http://localhost:47398", pages: {app: "http://localhost:47398"}}']);
    const sb = openSandbox(project, undefined, policy, resolveSecretRef);
    const exec: DockerExec = async () => ({ code: null, stdout: '', stderr: '', ms: 0, error: 'spawn docker ENOENT' });
    const provider = new ComposeProvider({ policy, exec, docker: '/nowhere/docker' });
    await expect(provider.status(ctxOf(project))).rejects.toThrow(/sandbox sandbox: docker-compose sandboxes need Docker with Compose v2\.17 or later: \/nowhere\/docker could not be run/);
    expect(sb.kind).toBe('docker-compose');
  });
});

describe('snapshot helpers', () => {
  it('quotes identifiers and literals, names the template, reads the database of a URL', async () => {
    expect(quoteIdent('app')).toBe('"app"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(snapshotComment('abc')).toBe('retake snapshot abc');
    expect(parsePostgresUrl('postgres://demo:pw@localhost:4601/app')).toEqual({ host: 'localhost', port: 4601, database: 'app' });
    expect(parsePostgresUrl('postgresql://u@[::1]/my%20db')).toEqual({ host: '::1', port: 5432, database: 'my db' });
    const project = await composeProjectDir('snap', [
      'services:',
      '  app: {url: "http://localhost:47399", pages: {app: "http://localhost:47399"}}',
      'reset: {strategy: snapshot, snapshot: {database: second}}',
      'databases:',
      '  main: {url: "postgres://demo:sandbox-pass-1@localhost:47400/app"}',
      '  second: {url: "postgres://demo:{{env:RETAKE_TEST_SNAP_PW}}@localhost:47401/shop"}',
    ]);
    process.env.RETAKE_TEST_SNAP_PW = 'from-env-pass';
    try {
      const t = await snapshotTarget(project, project.sandboxes!.sandbox, resolveSecretRef);
      expect(t).toEqual({
        key: 'second',
        url: 'postgres://demo:from-env-pass@localhost:47401/shop',
        host: 'localhost',
        port: 47401,
        database: 'shop',
        user: 'demo',
        password: 'from-env-pass',
        template: 'shop__ds_snapshot',
      });
    } finally {
      delete process.env.RETAKE_TEST_SNAP_PW;
    }
  });

  it("where pg connects is read with pg's own parser: a host / port query parameter or a unix socket is refused (K1)", () => {
    expect(pgEndpoint('postgres://demo:pw-4632@localhost:4632/app', 'db')).toEqual({ host: 'localhost', port: 4632, database: 'app', user: 'demo', password: 'pw-4632' });
    expect(pgEndpoint('postgresql://u@[::1]:4632/app', 'db')).toMatchObject({ host: '::1', port: 4632 });
    expect(() => pgEndpoint('postgres://demo:pw@localhost:4882/app?port=5432', 'database main')).toThrow(
      /^database main: it would connect to localhost:5432\/app, not to the localhost:4882 its URL names \(a host or port query parameter\)$/,
    );
    expect(() => pgEndpoint('postgres://demo:pw@localhost:4882/app?host=db.example.com', 'db')).toThrow(/would connect to db\.example\.com:4882\/app/);
    expect(() => pgEndpoint('postgres://demo:pw@localhost:4882/app?host=/tmp', 'db')).toThrow(/through the unix socket \/tmp/);
    expect(() => pgEndpoint('postgres://demo:pw@db.example.com:5432/app', 'db')).toThrow(/db\.example\.com is not on this machine/);
  });
});

describe('retake sandbox init', () => {
  async function bareProject(name: string, yaml: string): Promise<LoadedProject> {
    const dir = join(tmp, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project.yaml'), yaml);
    return loadProject(dir);
  }

  it('writes the docker-compose scaffold on free ports, adds the sandbox to project.yaml in place, and the result validates', async () => {
    const yaml = ['# My project', 'name: Init test', 'environments:', '  local: {app: "http://localhost:4600"}   # the dev server', ''].join('\n');
    const project = await bareProject('init', yaml);
    const busy = new Set([4601]);
    const res = await initSandbox(project, { write: plainWrite, isFree: async (p) => !busy.has(p) });
    // 4600: a page of environment local; 4601: busy.
    expect(res.ports).toEqual({ app: 4602, db: 4603, mailpit: 4604 });
    expect(res.projectYaml).toBe('added');
    expect(res.files.map((f) => f.slice(res.dir.length + 1))).toEqual(['README.md', 'app/index.html', 'compose.yaml', 'sandbox.yaml', 'seed/01-demo-data.sql']);
    expect(await readFile(project.file, 'utf8')).toBe(`${yaml}sandboxes:\n  sandbox: sandbox/sandbox.yaml\n`);
    const manifest = await readFile(res.manifest, 'utf8');
    expect(manifest).not.toMatch(/__[A-Z_]+__/);
    expect(manifest).toContain('url: "postgres://demo:pg-sandbox-4603@localhost:4603/app"');
    expect(manifest).toMatch(/^# yaml-language-server: \$schema=\S+sandbox\.schema\.json$/m);
    const compose = await readFile(join(res.dir, 'compose.yaml'), 'utf8');
    expect(compose).toContain('"127.0.0.1:4602:8080"');
    expect(compose).toContain('pg_isready -h 127.0.0.1 -U demo -d app');
    expect(compose).toMatch(/image: axllent\/mailpit:v1\.\d+\.\d+/);
    const loaded = await loadProject(project.dir);
    const sandbox = loaded.sandboxes!.sandbox;
    expect(sandbox.issues).toEqual([]);
    expect(sandbox.manifest).toMatchObject({ provider: 'docker-compose', reset: { strategy: 'snapshot' } });
    expect(loaded.config.environments.sandbox).toEqual({ app: 'http://localhost:4602' });

    // A second one: its own folder and ports, the first one's ports skipped.
    const second = await initSandbox(loaded, { write: plainWrite, env: 'demo', isFree: async () => true });
    expect(second.dir).toBe(join(project.dir, 'sandbox', 'demo'));
    // 4601 is free now; 4602–4604 are the first sandbox's.
    expect(second.ports).toEqual({ app: 4601, db: 4605, mailpit: 4606 });
    expect(await readFile(project.file, 'utf8')).toBe(`${yaml}sandboxes:\n  sandbox: sandbox/sandbox.yaml\n  demo: sandbox/demo/sandbox.yaml\n`);
    expect(await readFile(join(second.dir, 'README.md'), 'utf8')).toContain('retake sandbox up init --env demo');
    const both = await loadProject(project.dir);
    expect(Object.keys(both.sandboxes!)).toEqual(['sandbox', 'demo']);

    // Names taken, an existing sandbox without --force; --force rewrites its files on its own ports.
    await expect(initSandbox(both, { write: plainWrite, env: 'local' })).rejects.toThrow(/environment local already exists in project\.yaml: give the sandbox another name/);
    await expect(initSandbox(both, { write: plainWrite, env: 'demo' })).rejects.toThrow(/sandbox demo already exists \(sandbox\/demo\/sandbox\.yaml\): --force/);
    await expect(initSandbox(both, { write: plainWrite, env: 'Bad Name' })).rejects.toThrow(/cannot name an environment/);
    const again = await initSandbox(both, { write: plainWrite, env: 'demo', force: true, isFree: async () => true });
    expect(again.projectYaml).toBe('kept');
    expect(again.ports).toEqual({ app: 4601, db: 4605, mailpit: 4606 });
  });

  it('never writes over a file the scaffold would write (compose.yaml, README.md, seed/…) without --force (K5)', async () => {
    const project = await bareProject('init-existing', 'name: Init existing\nenvironments:\n  local: {app: "http://localhost:9"}\n');
    await mkdir(join(project.dir, 'sandbox', 'seed'), { recursive: true });
    await writeFile(join(project.dir, 'sandbox', 'compose.yaml'), 'services: {mine: {image: busybox:1.38.0}}\n');
    await writeFile(join(project.dir, 'sandbox', 'seed', '01-demo-data.sql'), '-- mine\n');
    await expect(initSandbox(project, { write: plainWrite, isFree: async () => true })).rejects.toThrow(
      'sandbox/compose.yaml, sandbox/seed/01-demo-data.sql already exist: --force writes the scaffold over them, or give the sandbox another name (--env)',
    );
    expect(await readFile(join(project.dir, 'sandbox', 'compose.yaml'), 'utf8')).toBe('services: {mine: {image: busybox:1.38.0}}\n');
    expect(existsSync(join(project.dir, 'sandbox', 'sandbox.yaml'))).toBe(false);
    expect(await readFile(project.file, 'utf8')).not.toContain('sandboxes');
    const forced = await initSandbox(project, { write: plainWrite, force: true, isFree: async () => true });
    expect(await readFile(join(forced.dir, 'compose.yaml'), 'utf8')).toContain('postgres:17-alpine');
  });

  it('names the schema relatively inside one top-level folder, else with a file:// URL', () => {
    expect(schemaRef('/Users/me/ws/projects/p/sandbox', '/Users/me/retake/packages/core/schema/sandbox.schema.json')).toBe('../../../../retake/packages/core/schema/sandbox.schema.json');
    expect(schemaRef('/private/tmp/ws/p/sandbox', '/Users/me/retake/packages/core/schema/sandbox.schema.json')).toBe('file:///Users/me/retake/packages/core/schema/sandbox.schema.json');
  });

  it('core addSandboxEntry: appended, after the last entry of a block mapping, inside a one-line flow mapping — nothing else of the text changes (K8); refused when taken', () => {
    expect(addSandboxEntry('name: X\n', 'sandbox', 'sandbox/sandbox.yaml')).toBe('name: X\nsandboxes:\n  sandbox: sandbox/sandbox.yaml\n');
    expect(addSandboxEntry('name: X', 'sandbox', 'a.yaml')).toBe('name: X\nsandboxes:\n  sandbox: a.yaml\n');
    const block = 'name: X\nsandboxes:   # ours\n    one: a.yaml\n\n    # comment\n    two: b.yaml\ndefault_env: one\n';
    expect(addSandboxEntry(block, 'three', 'c.yaml')).toBe('name: X\nsandboxes:   # ours\n    one: a.yaml\n\n    # comment\n    two: b.yaml\n    three: c.yaml\ndefault_env: one\n');
    expect(addSandboxEntry('name: X\nsandboxes:\n', 'one', 'a.yaml')).toBe('name: X\nsandboxes:\n  one: a.yaml\n');
    expect(addSandboxEntry('name: X  # keep me\nsandboxes: {one: a.yaml}\n', 'two', 'b.yaml')).toBe('name: X  # keep me\nsandboxes: {one: a.yaml, two: b.yaml}\n');
    // Long lines, other flow mappings and comments stay as written; a `...` document end stays last; CRLF stays CRLF.
    const long =
      'name: X\ndescription: "a fairly long description string that goes well past eighty characters in width, surely"\nenvironments: {local: {app: "http://localhost:9"}}   # keep\nsandboxes: {}\n';
    expect(addSandboxEntry(long, 'sandbox', 'sandbox/sandbox.yaml')).toBe(long.replace('sandboxes: {}', 'sandboxes: {sandbox: sandbox/sandbox.yaml}'));
    expect(addSandboxEntry('name: X\nvars: {k: v}\n...\n', 'sandbox', 'a.yaml')).toBe('name: X\nvars: {k: v}\nsandboxes:\n  sandbox: a.yaml\n...\n');
    expect(addSandboxEntry('name: X\r\nsandboxes:\r\n  a: a.yaml\r\n', 'b', 'b.yaml')).toBe('name: X\r\nsandboxes:\r\n  a: a.yaml\r\n  b: b.yaml\r\n');
    expect(addSandboxEntry('name: X\r\nvars: {k: v}\r\n', 'b', 'b.yaml')).toBe('name: X\r\nvars: {k: v}\r\nsandboxes:\r\n  b: b.yaml\r\n');
    // A flow mapping over several lines: the Document API, lines never folded.
    const multi = addSandboxEntry('name: X\ndescription: "a fairly long description string that goes well past eighty characters in width, surely"\nsandboxes: {\n  one: a.yaml\n}\n', 'two', 'b.yaml');
    expect(multi).toContain('description: "a fairly long description string that goes well past eighty characters in width, surely"\n');
    expect(multi).toMatch(/two: b\.yaml/);
    expect(addSandboxEntry(block, 'one', 'a.yaml')).toBe(block);
    expect(() => addSandboxEntry(block, 'one', 'other.yaml')).toThrow(/already declares sandbox one \(a\.yaml\)/);
    expect(() => addSandboxEntry('sandboxes: [a]\n', 'one', 'a.yaml')).toThrow(/`sandboxes` is not a mapping/);
  });
});
