/**
 * Field feedback 2, point 30: the build secrets of a docker-compose sandbox's `up`, on a fake docker.
 * - sandbox.yaml `compose.secrets` values reach the `up` command's environment only (never another compose call, never
 *   argv), resolved only when a service this up builds needs them; BuildKit's progress is plain on that up;
 * - every line of that up (log file, debug log, progress notes) and every message it throws is masked with them;
 * - an empty build secret is refused before anything starts (no `compose.secrets`, an empty env file value, a job
 *   without the variable), leading with the keychain; a job's refusal names RETAKE_WORKER_KEEP_ENV;
 * - which services this up builds: `--build`, `pull_policy: build`, a missing image (whatever the pull policy) —
 *   never an image already here without `--build`;
 * - a `compose.secrets` name no build secret reads, one a running container mounts, or one docker compose would put
 *   anywhere else (a marker value handed to `config` shows where) is refused; `false` marks an optional secret;
 * - the failing BuildKit step's last lines (a real run's output, data/buildkit-failed-step.txt) end the message;
 * - the previous up's log is kept as compose-up.log.1.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, workPolicyFrom } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { LoadedProject, WorkPolicy } from '@retake/core';
import { SandboxError, sandboxPaths } from '@retake/sandbox';
import { ComposeProvider, parseComposeConfig } from '../src/compose.js';
import { failedBuildStep } from '../src/docker.js';
import type { DockerExec, DockerResult, DockerRunOptions } from '../src/docker.js';
import { emptyState } from '../src/state.js';
import type { ProviderContext } from '../src/provider.js';
import { packageHooks } from './hook-runner.js';

const TOKEN = 'npm-token-0f3a9c2e77';
const REAL_FAILURE = readFileSync(fileURLToPath(new URL('./data/buildkit-failed-step.txt', import.meta.url)), 'utf8');

let tmp = '';
let server: Server;
let port = 0;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-build-secrets-'));
  server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

/** A compose file whose `app` builds with secret NPM_TOKEN read from the variable NPM_TOKEN. */
const composeYaml = (extra = '') => `services:
  app:
    build: {context: ., secrets: [NPM_TOKEN]}
    image: demo-app:1
${extra}secrets:
  NPM_TOKEN: {environment: NPM_TOKEN}
`;

async function project(name: string, manifest: string[], files: Record<string, string> = {}): Promise<LoadedProject> {
  const dir = join(tmp, name);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Build secrets test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
  for (const [f, text] of Object.entries({ 'compose.yaml': composeYaml(), ...files })) await writeFile(join(dir, 'sandbox', f), text);
  await writeFile(
    join(dir, 'sandbox', 'sandbox.yaml'),
    ['version: 1', 'provider: docker-compose', ...manifest, 'services:', `  app: {url: "http://localhost:${port}", health: /, pages: {app: "http://localhost:${port}"}}`, ''].join('\n'),
  );
  return loadProject(dir);
}

/**
 * The config docker would print: app built with secret NPM_TOKEN (pull policy as given), the secret read from
 * `secretVariable`; `extra`: more of app's own keys (an `environment`, its runtime `secrets`).
 */
function config(pull?: string, secretVariable = 'NPM_TOKEN', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    services: {
      app: {
        image: 'demo-app:1',
        ...(pull ? { pull_policy: pull } : {}),
        build: { context: '.', secrets: [{ source: 'NPM_TOKEN' }] },
        ports: [{ host_ip: '127.0.0.1', target: 80, published: String(port), protocol: 'tcp' }],
        ...extra,
      },
    },
    secrets: { NPM_TOKEN: { name: 'p_NPM_TOKEN', environment: secretVariable } },
  });
}

const psRunning = () =>
  JSON.stringify({
    Service: 'app',
    Name: 'p-app-1',
    ID: 'id-app',
    State: 'running',
    Health: 'healthy',
    ExitCode: 0,
    Status: 'Up',
    Labels: 'com.docker.compose.project=p,com.docker.compose.service=app',
    Publishers: [{ URL: '127.0.0.1', TargetPort: 80, PublishedPort: port, Protocol: 'tcp' }],
  });

interface Call {
  args: string[];
  env?: Record<string, string>;
}

/**
 * A fake docker: `config` answers `cfg` (a function of the environment it is handed: what docker compose would put
 * where), `up` answers `up` (its lines fed to onLine), the image is here or not; every call and its env recorded.
 */
function fakeDocker(o: { cfg: string | ((env: Record<string, string>) => string); image?: boolean; up?: Partial<DockerResult> }): { exec: DockerExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: DockerExec = async (args, opts?: DockerRunOptions) => {
    calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
    const text = args.join(' ');
    const answer = (a: Partial<DockerResult>): DockerResult => {
      for (const line of `${a.stdout ?? ''}\n${a.stderr ?? ''}`.split('\n')) if (line.trim()) opts?.onLine?.(line);
      return { code: 0, stdout: '', stderr: '', ms: 1, ...a };
    };
    if (/^compose version --short$/.test(text)) return answer({ stdout: '5.5.0\n' });
    if (/^info --format/.test(text)) return answer({ stdout: '29.4.0\n' });
    if (/^ps (--filter publish=\d+ )+--format/.test(text) || /^volume ls /.test(text)) return answer({});
    if (/^image inspect /.test(text)) return answer(o.image ? { stdout: 'sha256:abc\n' } : { code: 1, stderr: 'Error: No such image: demo-app:1' });
    if (/ config --format json$/.test(text)) return answer({ stdout: typeof o.cfg === 'function' ? o.cfg(opts?.env ?? {}) : o.cfg });
    // Running already (its port is the sandbox's own): the up checks the build secrets, then runs.
    if (/ ps --all --format json$/.test(text)) return answer({ stdout: psRunning() });
    if (/ up -d --wait /.test(text)) {
      return answer(o.up ?? { stdout: ` Image demo-app:1 Built\n #7 0.1 using ${TOKEN}\n Container p-app-1 Started` });
    }
    if (/ stop /.test(text)) return answer({});
    return { code: 1, stdout: '', stderr: `no route for: ${text}`, ms: 1 };
  };
  return { exec, calls };
}

/** A provider context whose secrets resolve from `secrets` (a reference not in it fails like an unset variable). */
function ctxOf(p: LoadedProject, policy: WorkPolicy, secrets: Record<string, string> = {}): ProviderContext & { logs: string[]; notes: string[]; resolved: string[] } {
  const logs: string[] = [];
  const notes: string[] = [];
  const resolved: string[] = [];
  const ctx = {
    resolveSecret: async (ref: string) => {
      resolved.push(ref);
      if (!Object.hasOwn(secrets, ref)) throw new Error(`environment variable ${ref.replace(/^env:/, '')} is not set`);
      return secrets[ref];
    },
    hookRunner: packageHooks,
    project: p,
    policy,
    sandbox: p.sandboxes!.sandbox,
    paths: sandboxPaths(p.dir, 'sandbox'),
    state: emptyState('sandbox', 'docker-compose'),
    save: () => undefined,
    log: (_l: string, m: string) => logs.push(m),
    progress: { step: () => undefined, note: (t: string) => notes.push(t) },
    logs,
    notes,
    resolved,
  };
  return ctx as unknown as ProviderContext & { logs: string[]; notes: string[]; resolved: string[] };
}

const upCall = (calls: Call[]) => calls.find((c) => c.args.includes('up'));
const agentPolicy = () => workPolicyFrom([tmp]);

describe('build secrets of a docker-compose up', () => {
  it('compose.secrets reach the up command alone, masked in every line it writes; BuildKit progress plain', async () => {
    const p = await project('passed', ['compose: {secrets: {NPM_TOKEN: "{{keychain:retake-demo/npm}}"}}']);
    const { exec, calls } = fakeDocker({ cfg: config() });
    const ctx = ctxOf(p, PERSON_POLICY, { 'keychain:retake-demo/npm': TOKEN });
    await new ComposeProvider({ policy: PERSON_POLICY, exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] }).up(ctx, { build: true });
    expect(upCall(calls)!.env).toEqual({ NPM_TOKEN: TOKEN, BUILDKIT_PROGRESS: 'plain' });
    // Exactly one call carries it, and no call's argv names it.
    expect(calls.filter((c) => JSON.stringify(c.env ?? {}).includes(TOKEN)).length).toBe(1);
    expect(calls.some((c) => c.args.join(' ').includes(TOKEN))).toBe(false);
    const log = await readFile(join(ctx.paths.logs, 'compose-up.log'), 'utf8');
    expect(log).toContain('#7 0.1 using ***');
    for (const text of [log, ...ctx.logs, ...ctx.notes]) expect(text).not.toContain(TOKEN);
    expect(ctx.resolved).toEqual(['keychain:retake-demo/npm']);
  });

  it('an empty build secret is refused before anything starts, leading with the keychain; a job names RETAKE_WORKER_KEEP_ENV', async () => {
    const p = await project('empty', []);
    const saved = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    try {
      for (const policy of [PERSON_POLICY, agentPolicy()]) {
        const { exec, calls } = fakeDocker({ cfg: config(), image: true });
        const err = await new ComposeProvider({ policy, exec }).up(ctxOf(p, policy), { build: true }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SandboxError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/^sandbox sandbox: service app builds with secret NPM_TOKEN, read from NPM_TOKEN, which is empty for docker compose \(the environment of /);
        expect(msg).toContain(
          'docker compose would pass the secret empty, and the build step that reads it would fail\n  — give it in sandbox.yaml: `compose.secrets: {NPM_TOKEN: "{{keychain:<service>/<account>}}"}`',
        );
        expect(msg).toContain('docker compose build --no-cache <service>');
        expect(msg.includes('RETAKE_WORKER_KEEP_ENV=NPM_TOKEN')).toBe(policy !== PERSON_POLICY);
        expect(upCall(calls)).toBeUndefined();
      }
    } finally {
      if (saved !== undefined) process.env.NPM_TOKEN = saved;
    }
  });

  it("the env file's value counts (non-empty: accepted, nothing added to the up's environment; empty: refused)", async () => {
    const filled = await project('env-file', [], { '.env': 'NPM_TOKEN=from-the-file-1\n' });
    const a = fakeDocker({ cfg: config() });
    await new ComposeProvider({ policy: PERSON_POLICY, exec: a.exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] }).up(ctxOf(filled, PERSON_POLICY), {
      build: true,
    });
    expect(upCall(a.calls)!.env).toEqual({ BUILDKIT_PROGRESS: 'plain' });
    const empty = await project('env-file-empty', [], { '.env': 'NPM_TOKEN=\n' });
    const b = fakeDocker({ cfg: config() });
    const err = await new ComposeProvider({ policy: PERSON_POLICY, exec: b.exec }).up(ctxOf(empty, PERSON_POLICY), { build: true }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('which is empty for docker compose (the env file (NPM_TOKEN=))');
  });

  it('which services this up builds: --build, pull_policy build or a missing image (whatever the pull policy) — not an image already here', async () => {
    const p = await project('which', ['compose: {secrets: {NPM_TOKEN: "{{env:NPM_TOKEN}}"}}']);
    const cases: Array<{ build: boolean; image: boolean; pull?: string; refused: boolean }> = [
      { build: false, image: true, refused: false },
      { build: false, image: false, refused: true },
      { build: false, image: true, pull: 'build', refused: true },
      // docker compose builds a `pull_policy: never` service too, under --build or when its image is missing.
      { build: true, image: true, pull: 'never', refused: true },
      { build: false, image: false, pull: 'never', refused: true },
      { build: false, image: true, pull: 'never', refused: false },
      { build: true, image: true, refused: true },
    ];
    for (const c of cases) {
      const { exec } = fakeDocker({ cfg: config(c.pull), image: c.image });
      const ctx = ctxOf(p, PERSON_POLICY);
      const err = await new ComposeProvider({ policy: PERSON_POLICY, exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] }).up(ctx, { build: c.build }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err === null ? 'started' : (err as Error).message.split('\n')[0], JSON.stringify(c)).toBe(
        c.refused
          ? 'sandbox sandbox: service app builds with secret NPM_TOKEN, read from NPM_TOKEN: compose.secrets.NPM_TOKEN ({{env:NPM_TOKEN}}) cannot be read (environment variable NPM_TOKEN is not set)'
          : 'started',
      );
      // A reference no built service needs is never resolved (a plain up from the app never reaches the keychain).
      expect(ctx.resolved, JSON.stringify(c)).toEqual(c.refused ? ['env:NPM_TOKEN'] : []);
    }
  });

  it('a compose.secrets name no build secret reads, one a container mounts at run time, or one docker compose puts anywhere else is refused', async () => {
    const up = async (p: LoadedProject, cfg: string | ((env: Record<string, string>) => string)) =>
      (
        (await new ComposeProvider({ policy: PERSON_POLICY, exec: fakeDocker({ cfg }).exec })
          .up(ctxOf(p, PERSON_POLICY, { 'env:NPM_TOKEN': TOKEN }), { build: true })
          .catch((e: unknown) => e)) as Error
      ).message;
    const unused = await project('unused', ['compose: {secrets: {OTHER_TOKEN: "{{env:OTHER_TOKEN}}"}}']);
    expect(await up(unused, config())).toBe(
      "sandbox sandbox: compose.secrets.OTHER_TOKEN — no build secret of the compose files reads OTHER_TOKEN (a top-level `secrets: {<id>: {environment: OTHER_TOKEN}}` mounted by a service's `build.secrets`): compose.secrets holds build secrets only — remove it, or declare the secret in the compose file",
    );
    const p = await project('placed', ['compose: {secrets: {NPM_TOKEN: "{{env:NPM_TOKEN}}"}}']);
    // A secret only a running container mounts is no build secret.
    const runtimeOnly = JSON.stringify({ ...JSON.parse(config()), services: { app: { image: 'demo-app:1', secrets: [{ source: 'NPM_TOKEN', target: '/run/secrets/NPM_TOKEN' }] } } });
    expect(await up(p, runtimeOnly)).toMatch(/^sandbox sandbox: compose\.secrets\.NPM_TOKEN — no build secret of the compose files reads NPM_TOKEN/);
    expect(await up(p, config(undefined, 'NPM_TOKEN', { secrets: [{ source: 'NPM_TOKEN', target: '/run/secrets/NPM_TOKEN' }] }))).toBe(
      'sandbox sandbox: compose.secrets.NPM_TOKEN — service app mounts secret NPM_TOKEN (read from NPM_TOKEN) in its running container (its own `secrets:`): the value would be in that container at /run/secrets/NPM_TOKEN — compose.secrets holds build secrets only: mount it in `build.secrets` alone',
    );
    // Wherever docker compose puts the value it is handed (a bare `environment: [NPM_TOKEN]`, a build argument, a
    // `${NPM_TOKEN}` of an included file), the marker shows in its config: refused, the real value never resolved.
    const placing = (env: Record<string, string>) => config(undefined, 'NPM_TOKEN', { environment: { NPM_TOKEN: env.NPM_TOKEN ?? null } });
    const msg = await up(p, placing);
    expect(msg).toMatch(
      /^sandbox sandbox: compose\.secrets\.NPM_TOKEN — the compose files put NPM_TOKEN's value outside a build secret \(a container's `environment`, a build argument, or a `\$\{NPM_TOKEN\}` in a compose file, an included one or the env file\)/,
    );
    expect(msg).not.toContain('retake-marker-');
    // The marker reaches config alone (the up never ran), and the real value was never read.
    const { exec, calls } = fakeDocker({ cfg: placing });
    const ctx = ctxOf(p, PERSON_POLICY, { 'env:NPM_TOKEN': TOKEN });
    await new ComposeProvider({ policy: PERSON_POLICY, exec }).up(ctx, { build: true }).catch(() => undefined);
    expect(calls.filter((c) => c.env && Object.keys(c.env).length).map((c) => c.args.slice(-3).join(' '))).toEqual(['config --format json']);
    expect(upCall(calls)).toBeUndefined();
    expect(ctx.resolved).toEqual([]);
  });

  it('a secret declared false is optional: never resolved nor refused when empty; a secret id may differ from its variable', async () => {
    const optional = await project('optional', ['compose: {secrets: {NPM_TOKEN: false}}']);
    const a = fakeDocker({ cfg: config() });
    const ctx = ctxOf(optional, PERSON_POLICY);
    const saved = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    try {
      await new ComposeProvider({ policy: PERSON_POLICY, exec: a.exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] }).up(ctx, { build: true });
    } finally {
      if (saved !== undefined) process.env.NPM_TOKEN = saved;
    }
    expect(upCall(a.calls)!.env).toEqual({ BUILDKIT_PROGRESS: 'plain' });
    expect(ctx.resolved).toEqual([]);
    // Secret id NPM_TOKEN read from the variable REGISTRY_TOKEN.
    const other = await project('other-variable', ['compose: {secrets: {REGISTRY_TOKEN: "{{env:REGISTRY_TOKEN}}"}}']);
    const b = fakeDocker({ cfg: config(undefined, 'REGISTRY_TOKEN') });
    await new ComposeProvider({ policy: PERSON_POLICY, exec: b.exec, listeners: async () => [{ pid: 1, pgid: 1, command: 'OrbStack Helper', port }] }).up(
      ctxOf(other, PERSON_POLICY, { 'env:REGISTRY_TOKEN': TOKEN }),
      { build: true },
    );
    expect(upCall(b.calls)!.env).toEqual({ REGISTRY_TOKEN: TOKEN, BUILDKIT_PROGRESS: 'plain' });
  });

  it('a value shorter than 3 characters is refused: it could not be masked', async () => {
    const p = await project('short', ['compose: {secrets: {NPM_TOKEN: "{{env:NPM_TOKEN}}"}}']);
    const { exec } = fakeDocker({ cfg: config() });
    const err = await new ComposeProvider({ policy: PERSON_POLICY, exec }).up(ctxOf(p, PERSON_POLICY, { 'env:NPM_TOKEN': 'ab' }), { build: true }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'sandbox sandbox: service app builds with secret NPM_TOKEN, read from NPM_TOKEN: its value (compose.secrets.NPM_TOKEN ({{env:NPM_TOKEN}})) is shorter than 3 characters — it could not be masked in the logs',
    );
  });

  it("a failed build: the failing step's last lines end the message, masked (a real BuildKit output); the previous log is kept as .1", async () => {
    const real = REAL_FAILURE.replaceAll('probe-secret-value-123', TOKEN);
    expect(real).toContain(TOKEN);
    const p = await project('failed', ['compose: {secrets: {NPM_TOKEN: "{{env:NPM_TOKEN}}"}}']);
    const { exec } = fakeDocker({ cfg: config(), up: { code: 1, stderr: real } });
    const ctx = ctxOf(p, PERSON_POLICY, { 'env:NPM_TOKEN': TOKEN });
    await mkdir(ctx.paths.logs, { recursive: true });
    await writeFile(join(ctx.paths.logs, 'compose-up.log'), 'the previous up\n');
    const err = await new ComposeProvider({ policy: PERSON_POLICY, exec }).up(ctx, { build: true }).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('— the build step that failed, its last lines:\n');
    expect(msg).toContain('    installing with token ***\n    ERR_FETCH_401 GET https://registry.example/pkg: Unauthorized - 401\n    ERROR: process');
    expect(await readFile(join(ctx.paths.logs, 'compose-up.log.1'), 'utf8')).toBe('the previous up\n');
    expect(await readFile(join(ctx.paths.logs, 'compose-up.log'), 'utf8')).not.toContain(TOKEN);
  });
});

describe('the parts', () => {
  it("failedBuildStep: the first failed step's own lines, without their prefix, at most 15; null for an output without one", () => {
    expect(failedBuildStep(REAL_FAILURE)).toEqual([
      `[stage-0 3/3] RUN --mount=type=secret,id=TOK,env=TOK sh -c 'echo "installing with token $TOK"; echo "ERR_FETCH_401 GET https://registry.example/pkg: Unauthorized - 401" >&2; exit 1'`,
      'installing with token probe-secret-value-123',
      'ERR_FETCH_401 GET https://registry.example/pkg: Unauthorized - 401',
      `ERROR: process "/bin/sh -c sh -c 'echo \\"installing with token $TOK\\"; echo \\"ERR_FETCH_401 GET https://registry.example/pkg: Unauthorized - 401\\" >&2; exit 1'" did not complete successfully: exit code: 1`,
    ]);
    const long = ['#9 [app 2/2] RUN install', ...Array.from({ length: 30 }, (_, i) => `#9 ${i}.0 line ${i}`), '#9 ERROR: exit code: 1'].join('\n');
    expect(failedBuildStep(long)).toEqual([...Array.from({ length: 14 }, (_, i) => `line ${i + 16}`), 'ERROR: exit code: 1']);
    expect(failedBuildStep(' Container p-app-1 Started\nError response from daemon: x')).toBeNull();
  });

  it('parseComposeConfig: the build secrets of each built service (short and long form), pull policies, environment secrets', () => {
    const cfg = parseComposeConfig(
      JSON.stringify({
        services: {
          app: { build: { context: '.', secrets: ['A', { source: 'B', target: 'b' }, { source: 'B' }] }, pull_policy: 'build' },
          db: { image: 'postgres:17-alpine' },
          tool: { build: { context: '.' } },
        },
        secrets: { A: { environment: 'A_TOKEN' }, B: { file: '/x' } },
      }),
      'p',
    );
    expect([cfg.builds, cfg.pulls, cfg.secretEnv]).toEqual([{ app: ['A', 'B'], tool: [] }, { app: 'build' }, { A: 'A_TOKEN' }]);
  });
});
