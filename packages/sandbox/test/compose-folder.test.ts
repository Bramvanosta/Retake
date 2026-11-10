/**
 * v0.2.1 — a docker-compose sandbox whose compose files live in another folder than sandbox.yaml (the product's
 * repository): the compose project's folder is the first compose file's, as for docker compose itself, so the relative
 * paths of the compose files resolve next to them; containers made from sandbox.yaml's folder (v0.2.0) stay the
 * sandbox's own. Docker under the agent policy: started by its checked real path, under the name it was found as (a
 * multi-call binary picks its role from argv[0]: OrbStack's `docker`). An account's `{{compose_env:NAME}}` password:
 * the value of the sandbox's compose env file.
 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, PERSON_POLICY, envFileValues, workPolicyFrom } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { ComposeProvider, SandboxError, composeArgs, composeProject, composeProjectName, emptyState, runDocker, sandboxPaths } from '@retake/sandbox';
import type { DockerExec, ProviderContext } from '@retake/sandbox';
import { startedProgram } from '../src/compose.js';

let tmp = '';
beforeAll(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'retake-compose-folder-')));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const COMPOSE = ['services:', '  app:', '    image: busybox', '    env_file: .env', ''].join('\n');
const ACCOUNT = [
  'login_url: /sign-in',
  'accounts:',
  '  buyer:',
  '    pages: [app]',
  '    username: orders@example.com',
  '    password: "{{compose_env:DEMO_BUYER_PASSWORD}}"',
  '    login:',
  '      - open: "app:/sign-in"',
  '      - type: {into: {label: Password}, text: "{{account.password}}"}',
];

/** A project in `<tmp>/<name>/workspace`, its sandbox.yaml lines `manifest`; `files` are written relative to sandbox/. */
async function project(name: string, manifest: string[], files: Record<string, string>, provider = 'docker-compose'): Promise<LoadedProject> {
  const dir = join(tmp, name, 'workspace');
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Compose folder test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  stage: sandbox/sandbox.yaml', ''].join('\n'));
  const service = provider === 'process' ? '  app: {command: "node server.js", url: "http://localhost:4791", health: false, pages: {app: "http://localhost:4791"}}' : '  app: {url: "http://localhost:4791", health: false, pages: {app: "http://localhost:4791"}}';
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), ['version: 1', `provider: ${provider}`, ...manifest, 'services:', service, ''].join('\n'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, 'sandbox', rel, '..'), { recursive: true });
    await writeFile(join(dir, 'sandbox', rel), text);
  }
  return loadProject(dir);
}

function ctxOf(p: LoadedProject): ProviderContext {
  return { project: p, policy: PERSON_POLICY, sandbox: p.sandboxes!.stage, paths: sandboxPaths(p.dir, 'stage'), state: emptyState('stage', 'docker-compose'), save: () => undefined, log: () => undefined };
}

const psLine = (wd: string) => JSON.stringify({ Service: 'app', Name: 'p-app-1', ID: 'abc', State: 'running', Health: '', ExitCode: 0, Status: 'Up', Publishers: [], Labels: `com.docker.compose.project.working_dir=${wd},com.docker.compose.service=app` });

describe('compose files outside the folder of sandbox.yaml (v0.2.1)', () => {
  it('the compose project\'s folder is the first compose file\'s: --project-directory and the name\'s hash', async () => {
    const p = await project('elsewhere', ['compose: {files: [../../product/docker/compose.yaml]}'], { '../../product/docker/compose.yaml': COMPOSE, '../../product/docker/.env': 'APP_TAG=1\n' });
    const sandboxDir = join(tmp, 'elsewhere', 'workspace', 'sandbox');
    const composeDir = join(tmp, 'elsewhere', 'product', 'docker');
    const ref = composeProject(p, p.sandboxes!.stage);
    expect(ref.dir).toBe(composeDir);
    expect(ref.sandboxDir).toBe(sandboxDir);
    expect(ref.name).toBe(composeProjectName(p.slug, 'stage', composeDir));
    expect(composeArgs(ref)).toEqual(['compose', '--ansi', 'never', '-p', ref.name, '--project-directory', composeDir, '-f', join(composeDir, 'compose.yaml'), '--env-file', join(composeDir, '.env')]);
  });

  it('next to sandbox.yaml nothing changes: one folder, the same name as before', async () => {
    const p = await project('beside', [], { 'compose.yaml': COMPOSE });
    const ref = composeProject(p, p.sandboxes!.stage);
    expect(ref.dir).toBe(join(tmp, 'beside', 'workspace', 'sandbox'));
    expect(ref.sandboxDir).toBeUndefined();
    expect(ref.name).toBe(composeProjectName(p.slug, 'stage', ref.dir));
  });

  it('containers made from the compose folder or from sandbox.yaml\'s folder (v0.2.0) are the sandbox\'s own; another folder\'s are refused', async () => {
    const p = await project('own', ['compose: {files: [../../product/compose.yaml], project: retake-test-own}'], { '../../product/compose.yaml': COMPOSE });
    const ref = composeProject(p, p.sandboxes!.stage);
    const psFrom = (wd: string) => {
      const exec: DockerExec = async () => ({ code: 0, stdout: psLine(wd), stderr: '', ms: 1 });
      return new ComposeProvider({ policy: PERSON_POLICY, exec }).ps(ctxOf(p));
    };
    await expect(psFrom(ref.dir)).resolves.toHaveLength(1);
    await expect(psFrom(ref.sandboxDir!)).resolves.toHaveLength(1);
    await expect(psFrom(join(tmp, 'another-checkout'))).rejects.toThrow(SandboxError);
    await expect(psFrom(join(tmp, 'another-checkout'))).rejects.toThrow(/belongs to another folder/);
  });
});

describe('docker under the agent policy keeps the name it was found as (v0.2.1)', () => {
  it('the checked real path is started as argv[0] = the link\'s name; a plain binary and a typed command are left alone', async () => {
    const dir = join(tmp, 'bin');
    await mkdir(dir, { recursive: true });
    const link = join(dir, 'docker');
    await symlink(process.execPath, link);
    expect(startedProgram(PERSON_POLICY, link, 'docker')).toEqual({ program: link, problem: null });
    const agent = workPolicyFrom([join(tmp, 'some-workspace')]);
    const checked = startedProgram(agent, link, 'docker');
    expect(checked.problem).toBeNull();
    expect(checked.program).toBe(realpathSync(process.execPath));
    expect(checked.argv0).toBe(basename(checked.program) === 'docker' ? undefined : 'docker');
    const real = realpathSync(process.execPath);
    expect(startedProgram(agent, real, 'docker')).toEqual({ program: real, problem: null });
  });

  it('runDocker starts the program under that name', async () => {
    const r = await runDocker(process.execPath, ['-e', 'process.stdout.write(process.argv0)'], { argv0: 'docker', policy: PERSON_POLICY });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('docker');
  });
});

describe('an account\'s {{compose_env:NAME}} (v0.2.1)', () => {
  it('reads env files as docker compose does for the common forms', () => {
    expect(envFileValues('# demo\nA=plain value # a comment\nexport B="two\\nlines \\"q\\""\nC=\'as $it is # kept\'\n D = x#y\nE=\nA=last wins\n')).toEqual({ A: 'last wins', B: 'two\nlines "q"', C: 'as $it is # kept', D: 'x#y', E: '' });
  });

  it('the password is the env file\'s value: in the login steps, and a secret of the persona', async () => {
    const p = await project('account', ACCOUNT, { 'compose.yaml': COMPOSE, '.env': 'APP_TAG=1\nDEMO_BUYER_PASSWORD="buyer-pass-4791"\n' });
    const sb = p.sandboxes!.stage;
    expect(sb.secrets.buyer).toEqual(['buyer-pass-4791']);
    expect(sb.manifest.accounts?.buyer.password).toBe('{{compose_env:DEMO_BUYER_PASSWORD}}');
    expect(JSON.stringify(p.config.auth)).toContain('buyer-pass-4791');
    expect(JSON.stringify(p.config.auth)).not.toContain('compose_env');
  });

  it('refuses a name the env file does not set, a sandbox without env file, and a process sandbox — never a value', async () => {
    const said = async (load: Promise<LoadedProject>) => {
      const e = await load.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      return String((e as Error).message) + JSON.stringify((e as ConfigError).issues ?? []);
    };
    const unset = await said(project('unset', ACCOUNT, { 'compose.yaml': COMPOSE, '.env': 'OTHER=secret-value-1\n' }));
    expect(unset).toMatch(/DEMO_BUYER_PASSWORD is not set in the sandbox's compose env file/);
    expect(unset).not.toContain('secret-value-1');
    expect(await said(project('nofile', ACCOUNT, { 'compose.yaml': COMPOSE }))).toMatch(/there is none/);
    expect(await said(project('off', ['compose: {env_file: false}', ...ACCOUNT], { 'compose.yaml': COMPOSE, '.env': 'DEMO_BUYER_PASSWORD=x\n' }))).toMatch(/says there is none/);
    expect(await said(project('process', ACCOUNT, {}, 'process'))).toMatch(/docker-compose sandbox: this one is not/);
  });
});
