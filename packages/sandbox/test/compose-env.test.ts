/**
 * The env file of a docker-compose sandbox (L5.8, R-FLD-32): image versions and settings read from a `.env` next to the
 * compose file (or `compose.env_file`), passed to every compose command (`--env-file`), the names it sets left out of
 * the environment docker runs with (a shell's value would win over the file's), its hash in the seed's inputs, and the
 * validation of `env_file` and of a COMPOSE_PROFILES in it. The unit part runs on a fake docker; the last test asks
 * the real `docker compose config` (DEMO_STUDIO_TEST_DOCKER=1; the docker CLI and its daemon, no image needed) what it
 * read: the file's tag wins over the shell's, the subfolder's file is the one read.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, composeEnvFile, envFileKeys, loadProject } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import { ComposeProvider, composeArgs, composeProject, dockerEnv, emptyState, sandboxPaths } from '@demo-studio/sandbox';
import type { DockerExec, DockerRunOptions, ProviderContext } from '@demo-studio/sandbox';

const ENABLED = process.env.DEMO_STUDIO_TEST_DOCKER === '1';
let tmp = '';
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'demo-studio-compose-env-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const COMPOSE = ['services:', '  app:', '    image: "busybox:${APP_TAG:-unset}"', '    environment: {GREETING: "${GREETING:-none}"}', ''].join('\n');

/** A project whose docker-compose sandbox reads `compose` (sandbox.yaml lines `manifest`, files under sandbox/). */
async function project(name: string, manifest: string[], files: Record<string, string>): Promise<LoadedProject> {
  const dir = join(tmp, name);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Env file test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  stage: sandbox/sandbox.yaml', ''].join('\n'));
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), ['version: 1', 'provider: docker-compose', ...manifest, 'services:', '  app: {url: "http://localhost:4790", health: false, pages: {app: "http://localhost:4790"}}', ''].join('\n'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, 'sandbox', rel, '..'), { recursive: true });
    await writeFile(join(dir, 'sandbox', rel), text);
  }
  return loadProject(dir);
}

function ctxOf(p: LoadedProject): ProviderContext {
  const sandbox = p.sandboxes!.stage;
  return { project: p, sandbox, paths: sandboxPaths(p.dir, 'stage'), state: emptyState('stage', 'docker-compose'), save: () => undefined, log: () => undefined };
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
    const env = dockerEnv({ PATH: '/usr/bin', APP_TAG: 'from-the-shell', COMPOSE_PROFILES: 'debug' }, ref.envKeys);
    expect(env).toEqual({ PATH: '/usr/bin' });
    const calls: Array<{ args: string[]; opts?: DockerRunOptions }> = [];
    const exec: DockerExec = async (a, o) => {
      calls.push({ args: a, ...(o ? { opts: o } : {}) });
      return { code: 0, stdout: JSON.stringify({ name: ref.name, services: { app: { image: 'busybox:1.38.0' } } }), stderr: '', ms: 1 };
    };
    const provider = new ComposeProvider({ exec });
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
    const inputs = await new ComposeProvider({ exec }).hashInputs(ctxOf(p));
    expect(inputs.find((i) => i.startsWith('env-file '))).toMatch(/^env-file [0-9a-f]{64}$/);
  });

  it('refuses a missing env_file and a COMPOSE_PROFILES in the env file', async () => {
    await expect(project('missing', ['compose: {env_file: stage.env}'], { 'compose.yaml': COMPOSE })).rejects.toThrow(ConfigError);
    const err = await project('profiles', [], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=1\nCOMPOSE_PROFILES=debug\n' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message) + JSON.stringify((err as ConfigError).issues ?? [])).toMatch(/sets COMPOSE_PROFILES/);
  });

  it.skipIf(!ENABLED)('the real docker compose reads the file: its tag wins over the shell, the subfolder file is the one read', async () => {
    const p = await project('real', ['compose: {env_file: config/stage.env}'], { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=dev\n', 'config/stage.env': 'APP_TAG=1.38.0\nGREETING=from-the-file\n' });
    const before = process.env.APP_TAG;
    process.env.APP_TAG = 'from-the-shell';
    try {
      const cfg = await new ComposeProvider().config(ctxOf(p));
      expect(cfg.images.app).toBe('busybox:1.38.0');
    } finally {
      if (before === undefined) delete process.env.APP_TAG;
      else process.env.APP_TAG = before;
    }
  });
});
