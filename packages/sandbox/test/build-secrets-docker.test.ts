/**
 * Field feedback 2, point 30, for real, gated by RETAKE_TEST_DOCKER=1 (a running Docker with busybox:1.38.0
 * present, never pulled). A compose file builds an image whose Dockerfile mounts a build secret read from a variable and
 * fails when it is empty; the sandbox runs under the agent policy (a job of the Studio, the desktop app or an MCP
 * client), where docker never inherits that variable:
 * - without `compose.secrets` the up is refused before anything is built, although this process has the variable;
 * - with `compose.secrets: {VAR: "{{env:…}}"}` the image builds with the secret (its length is served by the
 *   container), and the value is in no log;
 * - a build step that fails names its own last lines.
 * Every compose project and image is named `retake-test-<run token>-*` and removed after.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, workPolicyFrom } from '@retake/core';
import { loadProject, resolveSecretRef } from '@retake/core/io';
import { dockerEnv, findDocker, openSandbox, probePort, sandboxPaths } from '@retake/sandbox';
import { packageHooks } from './hook-runner.js';

const ENABLED = process.env.RETAKE_TEST_DOCKER === '1';
const DOCKER = findDocker() ?? 'docker';
const PREFIX = `retake-test-${randomBytes(3).toString('hex')}-`;
const TOKEN = `build-secret-${randomBytes(6).toString('hex')}`;
const projects: string[] = [];
let tmp = '';

function docker(args: string[]): string {
  return execFileSync(DOCKER, args, { encoding: 'utf8', env: dockerEnv(PERSON_POLICY), stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
}

beforeAll(async () => {
  if (!ENABLED) return;
  tmp = await mkdtemp(join(tmpdir(), 'retake-build-secrets-docker-'));
});
afterAll(async () => {
  if (!ENABLED) return;
  for (const p of projects) docker(['compose', '-p', p, 'down', '--volumes', '--rmi', 'local', '--remove-orphans']);
  for (const img of docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).split('\n')) if (img.startsWith(PREFIX)) docker(['image', 'rm', '-f', img]);
  await rm(tmp, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  for (;;) {
    const p = 47_000 + Math.floor(Math.random() * 1800);
    if (!(await probePort(p))) return p;
  }
}

/** A project whose sandbox builds `web` with secret TOK read from RETAKE_TEST_BUILD_VAR; `fail`: a step after it fails. */
async function sandboxProject(slug: string, secrets: boolean, fail = false): Promise<{ dir: string; port: number; name: string }> {
  const dir = join(tmp, slug);
  const port = await freePort();
  const name = `${PREFIX}${slug}`;
  projects.push(name);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(
    join(dir, 'sandbox', 'Dockerfile'),
    [
      'FROM busybox:1.38.0',
      'RUN --mount=type=secret,id=TOK,env=TOK sh -c \'test -n "$TOK" && mkdir -p /www && printf "%s" "${#TOK}" > /www/length\'',
      ...(fail ? ['RUN sh -c \'echo "fetching the private package"; echo "ERR_FETCH_401 Unauthorized" >&2; exit 1\''] : []),
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'sandbox', 'compose.yaml'),
    [
      'services:',
      '  web:',
      '    build: {context: ., secrets: [TOK]}',
      `    image: ${name}-web:1`,
      '    init: true',
      '    command: ["httpd", "-f", "-p", "8080", "-h", "/www"]',
      `    ports: ["127.0.0.1:${port}:8080"]`,
      'secrets:',
      '  TOK: {environment: RETAKE_TEST_BUILD_VAR}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'sandbox', 'sandbox.yaml'),
    [
      'version: 1',
      'provider: docker-compose',
      `compose: {project: ${name}${secrets ? ', secrets: {RETAKE_TEST_BUILD_VAR: "{{env:RETAKE_TEST_BUILD_TOKEN}}"}' : ''}}`,
      'services:',
      `  web: {url: "http://localhost:${port}", health: {path: /length, timeout_s: 60}, pages: {web: "http://localhost:${port}"}}`,
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'project.yaml'), ['name: Build secrets test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
  return { dir, port, name };
}

describe.skipIf(!ENABLED)('build secrets of a docker-compose sandbox for real (RETAKE_TEST_DOCKER=1)', () => {
  it('under the agent policy: refused without compose.secrets, built with it (the secret reaches the build, no log holds it)', async () => {
    const saved = { var: process.env.RETAKE_TEST_BUILD_VAR, token: process.env.RETAKE_TEST_BUILD_TOKEN };
    // This process has both: a job's docker inherits neither (core agent-env childEnv).
    process.env.RETAKE_TEST_BUILD_VAR = TOKEN;
    process.env.RETAKE_TEST_BUILD_TOKEN = TOKEN;
    try {
      const policy = workPolicyFrom([tmp]);
      const bare = await sandboxProject('bare', false);
      const refused = await openSandbox(await loadProject(bare.dir), undefined, policy, resolveSecretRef, packageHooks)
        .up({ build: true })
        .catch((e: unknown) => e);
      expect((refused as Error).message).toMatch(/service web builds with secret TOK, read from RETAKE_TEST_BUILD_VAR, which is empty for docker compose/);
      expect(docker(['image', 'ls', '-q', `${bare.name}-web`]).trim()).toBe('');

      const given = await sandboxProject('given', true);
      const sb = openSandbox(await loadProject(given.dir), undefined, policy, resolveSecretRef, packageHooks);
      await sb.up({ build: true });
      expect(await (await fetch(`http://127.0.0.1:${given.port}/length`)).text()).toBe(String(TOKEN.length));
      const logs = sandboxPaths(given.dir, 'sandbox').logs;
      expect(await readFile(join(logs, 'compose-up.log'), 'utf8')).not.toContain(TOKEN);
      await sb.down({ volumes: true });
    } finally {
      for (const [k, v] of [
        ['RETAKE_TEST_BUILD_VAR', saved.var],
        ['RETAKE_TEST_BUILD_TOKEN', saved.token],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 300_000);

  it("a build step that fails: the message ends with that step's own lines", async () => {
    process.env.RETAKE_TEST_BUILD_TOKEN = TOKEN;
    try {
      const failing = await sandboxProject('failing', true, true);
      const err = await openSandbox(await loadProject(failing.dir), undefined, PERSON_POLICY, resolveSecretRef, packageHooks)
        .up({ build: true })
        .catch((e: unknown) => e);
      const msg = (err as Error).message;
      // One first line (the person saw it cut at "exit code: 1):"), the services, then the step's own lines.
      expect(msg.split('\n')[0]).toMatch(/^sandbox sandbox: docker compose up failed \(failed to solve: .* exit code: 1\):$/);
      expect(msg).toContain('\n  web: no container\n');
      const step = msg.slice(msg.indexOf('— the build step that failed, its last lines:\n'));
      expect(step.split('\n').slice(1).sort()).toEqual(
        expect.arrayContaining(['    fetching the private package', '    ERR_FETCH_401 Unauthorized', expect.stringMatching(/^ {4}ERROR: process .* exit code: 1$/)]),
      );
      expect(msg).not.toContain(TOKEN);
    } finally {
      delete process.env.RETAKE_TEST_BUILD_TOKEN;
    }
  }, 300_000);
});
