/**
 * The env file of a docker-compose sandbox (L5.8, R-FLD-32): image versions and settings read from a `.env` next to the
 * compose file (or `compose.env_file`), passed to every compose command (`--env-file`), the names it sets left out of
 * the environment docker runs with (a shell's value would win over the file's), its hash in the seed's inputs, and the
 * validation of `env_file` and of a COMPOSE_PROFILES in it. The unit part runs on a fake docker; the last test asks
 * the real `docker compose config` (RETAKE_TEST_DOCKER=1; the docker CLI and its daemon, no image needed) what it
 * read: the file's tag wins over the shell's, the subfolder's file is the one read.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, envFileKeys, PERSON_POLICY, workPolicyFrom } from '@retake/core';
import { composeEnvFile, loadProject } from '@retake/core/io';
import type { LoadedProject, WorkPolicy } from '@retake/core';
import { ComposeProvider, SandboxError, composeArgs, composeProject, dockerEnv, emptyState, sandboxPaths } from '@retake/sandbox';
import type { DockerExec, DockerRunOptions, ProviderContext } from '@retake/sandbox';

/** The policy the work below runs under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
let policy: WorkPolicy = PERSON_POLICY;

const ENABLED = process.env.RETAKE_TEST_DOCKER === '1';
let tmp = '';
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-compose-env-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const COMPOSE = ['services:', '  app:', '    image: "busybox:${APP_TAG:-unset}"', '    environment: {GREETING: "${GREETING:-none}"}', ''].join('\n');

/** A project whose docker-compose sandbox reads `compose` (sandbox.yaml lines `manifest`, files under sandbox/). */
async function project(name: string, manifest: string[], files: Record<string, string>, extra: string[] = []): Promise<LoadedProject> {
  const dir = join(tmp, name);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Env file test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  stage: sandbox/sandbox.yaml', ...extra, ''].join('\n'));
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), ['version: 1', 'provider: docker-compose', ...manifest, 'services:', '  app: {url: "http://localhost:4790", health: false, pages: {app: "http://localhost:4790"}}', ''].join('\n'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, 'sandbox', rel, '..'), { recursive: true });
    await writeFile(join(dir, 'sandbox', rel), text);
  }
  return loadProject(dir);
}

function ctxOf(p: LoadedProject): ProviderContext {
  const sandbox = p.sandboxes!.stage;
  return { project: p, policy, sandbox, paths: sandboxPaths(p.dir, 'stage'), state: emptyState('stage', 'docker-compose'), save: () => undefined, log: () => undefined };
}

describe('env file of a docker-compose sandbox (L5.8)', () => {
  it('reads the names an env file sets, export and comments included', () => {
    expect(envFileKeys('# versions\nAPP_TAG=1.38.0\nexport GREETING="hi there"\n\n  DB_PASS = x\nnot a line\nAPP_TAG=again\n')).toEqual(['APP_TAG', 'GREETING', 'DB_PASS']);
  });

  it('defaults to the .env next to the first compose file, passes it to every compose command and drops its names from the environment', async () => {
    const p = await project('default', [], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=1.38.0\nGREETING=from-the-file\n' });
    const sb = p.sandboxes!.stage;
    expect(composeEnvFile(sb)).toBe(join(sb.dir, '.env'));
    const ref = composeProject(p, sb);
    expect(ref.envKeys).toEqual(['APP_TAG', 'GREETING']);
    const args = composeArgs(ref);
    expect(args.slice(args.indexOf('--env-file'), args.indexOf('--env-file') + 2)).toEqual(['--env-file', ref.envFile]);
    // The shell's APP_TAG and COMPOSE_PROFILES never reach docker; the rest of the shell does.
    const env = dockerEnv(policy, { PATH: '/usr/bin', APP_TAG: 'from-the-shell', COMPOSE_PROFILES: 'debug' }, ref.envKeys);
    expect(env).toEqual({ PATH: '/usr/bin' });
    const calls: Array<{ args: string[]; opts?: DockerRunOptions }> = [];
    const exec: DockerExec = async (a, o) => {
      calls.push({ args: a, ...(o ? { opts: o } : {}) });
      return { code: 0, stdout: JSON.stringify({ name: ref.name, services: { app: { image: 'busybox:1.38.0' } } }), stderr: '', ms: 1 };
    };
    const provider = new ComposeProvider({ policy, exec });
    const cfg = await provider.config(ctxOf(p));
    expect(cfg.images.app).toBe('busybox:1.38.0');
    expect(calls[0].args).toContain('--env-file');
    expect(calls[0].opts?.unset).toEqual(['APP_TAG', 'GREETING']);
  });

  it('takes compose.env_file (relative to sandbox.yaml) or none (false), and hashes the file into the seed inputs', async () => {
    const p = await project('written', ['compose: {env_file: config/stage.env}'], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=dev\n', 'config/stage.env': 'APP_TAG=1.38.0\n' });
    expect(composeEnvFile(p.sandboxes!.stage)).toBe(join(p.sandboxes!.stage.dir, 'config', 'stage.env'));
    const none = await project('none', ['compose: {env_file: false}'], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=dev\n' });
    expect(composeEnvFile(none.sandboxes!.stage)).toBeUndefined();
    expect(composeArgs(composeProject(none, none.sandboxes!.stage))).not.toContain('--env-file');
    const exec: DockerExec = async (a) => {
      if (a.includes('config')) return { code: 0, stdout: JSON.stringify({ services: { app: { image: 'busybox:1.38.0' } } }), stderr: '', ms: 1 };
      if (a[0] === 'image') return { code: 0, stdout: 'sha256:abc\n', stderr: '', ms: 1 };
      if (a.includes('version')) return { code: 0, stdout: '2.29.1', stderr: '', ms: 1 };
      if (a[0] === 'info') return { code: 0, stdout: '27.0.0', stderr: '', ms: 1 };
      return { code: 0, stdout: '', stderr: '', ms: 1 };
    };
    const inputs = await new ComposeProvider({ policy, exec }).hashInputs(ctxOf(p));
    expect(inputs.find((i) => i.startsWith('env-file '))).toMatch(/^env-file [0-9a-f]{64}$/);
  });

  it('refuses a missing env_file and a COMPOSE_PROFILES in the env file', async () => {
    await expect(project('missing', ['compose: {env_file: stage.env}'], { 'compose.yaml': COMPOSE })).rejects.toThrow(ConfigError);
    const err = await project('profiles', [], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=1\nCOMPOSE_PROFILES=debug\n' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message) + JSON.stringify((err as ConfigError).issues ?? [])).toMatch(/sets COMPOSE_PROFILES/);
  });

  it('under the agent policy docker gets core childEnv\'s allow-list: DOCKER_* and BUILDKIT_* kept, pass_env passed, a secret never', async () => {
    const p = await project('policy', [], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=1.38.0\n' }, ['pass_env: [GREETING]']);
    const ref = composeProject(p, p.sandboxes!.stage);
    expect(ref.pass).toEqual(['GREETING']);
    const shell = { PATH: '/usr/bin', HOME: '/home/me', DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONTEXT: 'orbstack', BUILDKIT_PROGRESS: 'plain', GREETING: 'from-the-shell', APP_TAG: 'from-the-shell', COMPOSE_PROFILES: 'debug', AWS_SECRET_ACCESS_KEY: 'exported' };
    // A command a person types: everything but COMPOSE_* and the env file's names.
    expect(dockerEnv(policy, shell, ref.envKeys, ref.pass)).toEqual({ PATH: '/usr/bin', HOME: '/home/me', DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONTEXT: 'orbstack', BUILDKIT_PROGRESS: 'plain', GREETING: 'from-the-shell', AWS_SECRET_ACCESS_KEY: 'exported' });
    policy = workPolicyFrom([p.dir], policy.ffmpeg, policy.render);
    try {
      expect(dockerEnv(policy, shell, ref.envKeys, ref.pass)).toEqual({ PATH: '/usr/bin', HOME: '/home/me', DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONTEXT: 'orbstack', BUILDKIT_PROGRESS: 'plain', GREETING: 'from-the-shell' });
      expect(dockerEnv(policy, shell, ref.envKeys)).not.toHaveProperty('GREETING');
    } finally {
      policy = workPolicyFrom(null, policy.ffmpeg, policy.render);
    }
    // Every compose command of the provider carries project.yaml's pass_env.
    const calls: Array<DockerRunOptions | undefined> = [];
    const exec: DockerExec = async (_a, o) => {
      calls.push(o);
      return { code: 0, stdout: JSON.stringify({ services: { app: { image: 'busybox:1.38.0' } } }), stderr: '', ms: 1 };
    };
    await new ComposeProvider({ policy, exec }).config(ctxOf(p));
    expect(calls[0]?.pass).toEqual(['GREETING']);
  });

  it('under the agent policy the docker binary is a program like any other: $RETAKE_DOCKER inside the workspace or relative is refused before it starts; one outside starts by its real path', async () => {
    const p = await project('docker-bin', [], { 'compose.yaml': COMPOSE });
    // A stand-in docker that writes how it was started ($0) beside itself, then answers nothing.
    const standIn = async (file: string) => {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, '#!/bin/sh\necho "$0" >> "$(dirname "$0")/ran.txt"\n');
      await chmod(file, 0o755);
    };
    const inside = join(p.dir, 'bin', 'docker');
    await standIn(inside);
    const outside = join(tmp, 'docker-elsewhere', 'docker-real');
    await standIn(outside);
    await symlink(outside, join(tmp, 'docker-elsewhere', 'docker'));
    const before = process.env.RETAKE_DOCKER;
    policy = workPolicyFrom([p.dir], policy.ffmpeg, policy.render);
    try {
      process.env.RETAKE_DOCKER = inside;
      await expect(new ComposeProvider({ policy }).docker(ctxOf(p))).rejects.toThrow(/^sandbox stage: docker-compose sandboxes: \$RETAKE_DOCKER \(.*\/bin\/docker\) lies inside the workspace .*: move the program out of the workspace and point \$RETAKE_DOCKER at its new place$/);
      await expect(new ComposeProvider({ policy }).config(ctxOf(p))).rejects.toThrow(/\$RETAKE_DOCKER .* lies inside the workspace/);
      expect(existsSync(join(p.dir, 'bin', 'ran.txt'))).toBe(false);
      process.env.RETAKE_DOCKER = 'bin/docker';
      await expect(new ComposeProvider({ policy }).docker(ctxOf(p))).rejects.toThrow(/\$RETAKE_DOCKER \(bin\/docker\) is a relative path/);
      process.env.RETAKE_DOCKER = join(tmp, 'docker-elsewhere', 'docker');
      await expect(new ComposeProvider({ policy }).docker(ctxOf(p))).rejects.toThrow(SandboxError);
      expect(readFileSync(join(tmp, 'docker-elsewhere', 'ran.txt'), 'utf8').trim().split('\n')[0]).toBe(realpathSync(outside));
    } finally {
      policy = workPolicyFrom(null, policy.ffmpeg, policy.render);
      if (before === undefined) delete process.env.RETAKE_DOCKER;
      else process.env.RETAKE_DOCKER = before;
    }
    // A command a person types: the binary runs where it is.
    process.env.RETAKE_DOCKER = inside;
    try {
      await new ComposeProvider({ policy }).docker(ctxOf(p)).catch(() => undefined);
      expect(existsSync(join(p.dir, 'bin', 'ran.txt'))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.RETAKE_DOCKER;
      else process.env.RETAKE_DOCKER = before;
    }
  });

  it.skipIf(!ENABLED)('the real docker compose under the agent policy: a shell variable reaches the compose file only through pass_env', async () => {
    const files = { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=1.38.0\n' };
    const listed = await project('real-pass', [], files, ['pass_env: [GREETING]']);
    const unlisted = await project('real-nopass', [], files);
    const before = process.env.GREETING;
    process.env.GREETING = 'from-the-shell';
    const greeting = (cfg: unknown) => JSON.stringify(cfg).match(/"GREETING":"([^"]*)"/)?.[1];
    policy = workPolicyFrom([tmp], policy.ffmpeg, policy.render);
    try {
      const calls: string[] = [];
      const real: DockerExec = async (a, o) => {
        const { runDocker, findDocker } = await import('@retake/sandbox');
        const r = await runDocker(findDocker()!, a, o);
        if (a.includes('config')) calls.push(r.stdout);
        return r;
      };
      await new ComposeProvider({ policy, exec: real }).config(ctxOf(listed));
      await new ComposeProvider({ policy, exec: real }).config(ctxOf(unlisted));
      expect(greeting(JSON.parse(calls[0]))).toBe('from-the-shell');
      expect(greeting(JSON.parse(calls[1]))).toBe('none');
    } finally {
      policy = workPolicyFrom(null, policy.ffmpeg, policy.render);
      if (before === undefined) delete process.env.GREETING;
      else process.env.GREETING = before;
    }
  });

  it.skipIf(!ENABLED)('the real docker compose reads the file: its tag wins over the shell, the subfolder file is the one read', async () => {
    const p = await project('real', ['compose: {env_file: config/stage.env}'], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=dev\n', 'config/stage.env': 'APP_TAG=1.38.0\nGREETING=from-the-file\n' });
    const before = process.env.APP_TAG;
    process.env.APP_TAG = 'from-the-shell';
    try {
      const cfg = await new ComposeProvider({ policy }).config(ctxOf(p));
      expect(cfg.images.app).toBe('busybox:1.38.0');
    } finally {
      if (before === undefined) delete process.env.APP_TAG;
      else process.env.APP_TAG = before;
    }
  });
});
