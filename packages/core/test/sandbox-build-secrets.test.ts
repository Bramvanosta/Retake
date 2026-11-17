/**
 * Field feedback 2, point 30: sandbox.yaml `compose.secrets` — variables `docker compose up` gets when it builds,
 * each one secret reference. What validation refuses: a plain value, a {{compose_env:}} one, a loader variable, a
 * COMPOSE_* name, a name the env file sets too, the key on a process sandbox.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSandboxYaml } from '@retake/core';
import { nodeFileFacts } from '@retake/core/io';
import type { ValidationIssue } from '@retake/core';
import { errors, tempDir, warnings, writeFiles } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const COMPOSE_YAML = `services:
  app:
    build: {context: ., secrets: [NPM_TOKEN]}
secrets:
  NPM_TOKEN: {environment: NPM_TOKEN}
`;

async function sandboxDir(files: Record<string, string>): Promise<string> {
  const t = await tempDir('retake-build-secrets-');
  cleanups.push(t.cleanup);
  await writeFiles(t.dir, files);
  return t.dir;
}

const manifest = (secrets: string, provider = 'docker-compose') => `version: 1
provider: ${provider}
compose:
  secrets:
${secrets}
services:
  app: {url: http://localhost:4600, pages: {app: http://localhost:4600}${provider === 'process' ? ', command: x' : ''}}
`;

const SETTING = 'is a setting of docker, compose or the system (which daemon, which config, which proxy, which certificates, what is started), never a build secret: remove it';

const paths = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

describe('sandbox.yaml compose.secrets', () => {
  it('an {{env:VAR}} or a {{keychain:service/account}} reference is valid, or false (optional); a name no secret of the compose files reads is a warning', async () => {
    const dir = await sandboxDir({ 'compose.yaml': COMPOSE_YAML, '.env': 'APP_VERSION=1.2.0\n' });
    const text = manifest('    NPM_TOKEN: "{{env:NPM_TOKEN}}"\n    SENTRY_AUTH_TOKEN: "{{keychain:retake-demo/sentry}}"\n    OTHER: "{{ secret:env:OTHER_TOKEN }}"\n    OPTIONAL: false');
    const p = parseSandboxYaml(text, join(dir, 'sandbox.yaml'), { files: nodeFileFacts, env: 'sandbox' });
    expect(paths(p.issues)).toEqual([]);
    expect(p.manifest?.compose?.secrets).toEqual({ NPM_TOKEN: '{{env:NPM_TOKEN}}', SENTRY_AUTH_TOKEN: '{{keychain:retake-demo/sentry}}', OTHER: '{{ secret:env:OTHER_TOKEN }}', OPTIONAL: false });
    const unread = (n: string) =>
      `compose.secrets.${n}: compose.secrets: no secret of the compose files reads ${n} (a top-level \`secrets: {<id>: {environment: ${n}}}\`): sandbox up refuses it unless an included file declares it`;
    expect(warnings(p.issues).map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual(['SENTRY_AUTH_TOKEN', 'OTHER', 'OPTIONAL'].map(unread));
    // A text validated alone (no folder: the compose files unread) warns of nothing.
    expect(warnings(parseSandboxYaml(text).issues)).toEqual([]);
  });

  it('a plain value, a {{compose_env:}} or two references are refused: each value is one secret reference', async () => {
    const dir = await sandboxDir({ 'compose.yaml': COMPOSE_YAML });
    const text = manifest('    PLAIN: "ghp-not-a-reference"\n    FROM_FILE: "{{compose_env:TOKEN}}"\n    TWO: "{{env:A}}{{env:B}}"\n    MIXED: "Bearer {{env:A}}"');
    const one = 'is one {{env:VAR}} or {{keychain:service/account}} reference (a plain value belongs in the env file, which docker compose reads itself), or false for an optional build secret';
    expect(paths(parseSandboxYaml(text, join(dir, 'sandbox.yaml'), { files: nodeFileFacts }).issues)).toEqual([
      `compose.secrets.PLAIN: compose.secrets: PLAIN ${one}`,
      `compose.secrets.FROM_FILE: compose.secrets: FROM_FILE ${one}`,
      `compose.secrets.TWO: compose.secrets: TWO ${one}`,
      `compose.secrets.MIXED: compose.secrets: MIXED ${one}`,
    ]);
  });

  it('a loader variable, a COMPOSE_* name or a name the env file sets too is refused', async () => {
    const dir = await sandboxDir({ 'compose.yaml': COMPOSE_YAML, '.env': 'NPM_TOKEN=\nAPP_VERSION=1.2.0\n' });
    const text = manifest('    NODE_OPTIONS: "{{env:X}}"\n    npm_config_registry: "{{env:X}}"\n    COMPOSE_PROFILES: "{{env:X}}"\n    NPM_TOKEN: "{{env:NPM_TOKEN}}"');
    const out = paths(parseSandboxYaml(text, join(dir, 'sandbox.yaml'), { files: nodeFileFacts }).issues);
    expect(out).toHaveLength(4);
    const loader = 'is a loader variable (it makes a program load code or read its settings from elsewhere), never a build secret: remove it';
    expect(out[0]).toBe(`compose.secrets.NODE_OPTIONS: compose.secrets: NODE_OPTIONS ${loader}`);
    expect(out[1]).toBe(`compose.secrets.npm_config_registry: compose.secrets: npm_config_registry ${loader}`);
    expect(out[2]).toBe(`compose.secrets.COMPOSE_PROFILES: compose.secrets: COMPOSE_PROFILES ${SETTING}`);
    expect(out[3]).toBe('compose.secrets.NPM_TOKEN: compose.secrets: the env file sets NPM_TOKEN too — keep one of them (a secret belongs here, a plain setting in the env file)');
  });

  it("docker's, buildx's, BuildKit's, compose's and the system's own settings are refused (they would steer docker, not feed a build)", async () => {
    expect(paths(parseSandboxYaml(manifest('    HOME: "{{env:X}}"')).issues)).toEqual([
      'compose.secrets.HOME: compose.secrets: HOME is a loader variable (it makes a program load code or read its settings from elsewhere), never a build secret: remove it',
    ]);
    const names = [
      'DOCKER_CONFIG',
      'docker_host',
      'BUILDX_CONFIG',
      'BUILDKIT_HOST',
      'COMPOSE_FILE',
      'HTTPS_PROXY',
      'no_proxy',
      'SSL_CERT_FILE',
      'TMPDIR',
      'LC_ALL',
      'SSH_AUTH_SOCK',
      'XDG_RUNTIME_DIR',
      'TMP',
      'TEMP',
    ];
    const text = manifest(names.map((n) => `    ${n}: "{{env:X}}"`).join('\n'));
    expect(paths(parseSandboxYaml(text).issues)).toEqual(names.map((n) => `compose.secrets.${n}: compose.secrets: ${n} ${SETTING}`));
    // An ordinary token name next to them stays valid.
    expect(paths(parseSandboxYaml(manifest('    SENTRY_AUTH_TOKEN: "{{env:SENTRY_AUTH_TOKEN}}"\n    DOCKERISH_TOKEN: "{{env:X}}"')).issues)).toEqual([]);
  });

  it('a name that is not a variable name is refused by the schema; the key is for docker-compose only', async () => {
    expect(paths(parseSandboxYaml(manifest('    "1BAD": "{{env:X}}"')).issues).join('\n')).toMatch(/a variable name is letters, digits and "_", not starting with a digit/);
    expect(paths(parseSandboxYaml(manifest('    NPM_TOKEN: "{{env:NPM_TOKEN}}"', 'process')).issues)).toEqual([
      'compose: `compose` is for provider docker-compose (this sandbox starts local processes)',
    ]);
  });
});
