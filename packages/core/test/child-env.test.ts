import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bareEnvHint, childEnv, childEnvHint, parseProjectYaml, passEnvProblem, policyChildEnv, useAgentPolicy } from '@retake/core';

const WS = '/work/space';

/** A worker's environment: the shell's own variables, a secret the person exported, loader variables, docker's. */
const SOURCE: NodeJS.ProcessEnv = {
  PATH: ['/usr/bin', 'bin', `${WS}/node_modules/.bin`, '/opt/homebrew/bin', '', '.'].join(delimiter),
  HOME: '/Users/someone',
  USER: 'someone',
  LOGNAME: 'someone',
  SHELL: '/bin/zsh',
  TMPDIR: '/tmp/x',
  TERM: 'xterm',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TZ: 'Europe/Paris',
  https_proxy: 'http://proxy.example.com:3128',
  NO_PROXY: 'localhost',
  SSL_CERT_FILE: '/etc/ssl/cert.pem',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
  STRIPE_SECRET_KEY: 'sk-test-secret',
  DATABASE_URL: 'postgres://u:pw@localhost:5432/app',
  NODE_OPTIONS: '--require ./x.cjs',
  GIT_SSH_COMMAND: 'x',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  DOCKER_CONTEXT: 'orbstack',
  BUILDKIT_PROGRESS: 'plain',
  COMPOSE_PROFILES: 'debug',
};

afterEach(() => useAgentPolicy(null));

describe('the environment of the programs a job starts under the agent policy (core childEnv)', () => {
  it('keeps the shell\'s own variables and drops everything else: secrets, loader variables, docker\'s', () => {
    const env = childEnv(SOURCE, { folders: [WS] });
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'PATH', 'SHELL', 'SSL_CERT_FILE', 'TERM', 'TMPDIR', 'TZ', 'USER', 'https_proxy'].sort(),
    );
    expect(env.HOME).toBe('/Users/someone');
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it('cleans PATH: absolute entries outside the workspace only', () => {
    expect(childEnv(SOURCE, { folders: [WS] }).PATH).toBe(['/usr/bin', '/opt/homebrew/bin'].join(delimiter));
    // The policy's own folders by default.
    useAgentPolicy([WS]);
    expect(childEnv(SOURCE).PATH).toBe(['/usr/bin', '/opt/homebrew/bin'].join(delimiter));
  });

  it('passes the names of project.yaml `pass_env:` on, never a loader variable', () => {
    const env = childEnv(SOURCE, { folders: [WS], pass: ['DATABASE_URL', 'NODE_OPTIONS', 'GIT_SSH_COMMAND', 'NOT_SET'] });
    expect(env.DATABASE_URL).toBe('postgres://u:pw@localhost:5432/app');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect('NOT_SET' in env).toBe(false);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('gives docker DOCKER_* and BUILDKIT_* too (which daemon it talks to), never COMPOSE_*', () => {
    const env = childEnv(SOURCE, { folders: [WS], docker: true });
    expect(env).toMatchObject({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'orbstack', BUILDKIT_PROGRESS: 'plain', HOME: '/Users/someone' });
    expect(env.COMPOSE_PROFILES).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("docker's variables by name only: a registry password or token exported as DOCKER_* / BUILDKIT_* never reaches it", () => {
    const named = { DOCKER_HOST: 'h', DOCKER_CONTEXT: 'c', DOCKER_CONFIG: '/c', DOCKER_CERT_PATH: '/p', DOCKER_TLS: '1', DOCKER_TLS_VERIFY: '1', DOCKER_API_VERSION: '1.45', DOCKER_DEFAULT_PLATFORM: 'linux/amd64', DOCKER_BUILDKIT: '1', BUILDKIT_PROGRESS: 'plain' };
    const secrets = { DOCKER_PASSWORD: 'pw', DOCKER_AUTH_CONFIG: '{"auths":{}}', DOCKER_TOKEN: 't', DOCKER_REGISTRY_PASSWORD: 'pw', BUILDKIT_TOKEN: 't', DOCKER_HOST_X: 'x' };
    const env = childEnv({ ...named, ...secrets }, { folders: [WS], docker: true });
    expect(env).toEqual(named);
    expect(childEnv({ ...named, ...secrets }, { folders: [WS] })).toEqual({});
  });

  it('applies only under the agent policy (policyChildEnv): a command a person types inherits', () => {
    expect(policyChildEnv(SOURCE, { pass: ['DATABASE_URL'] })).toBeNull();
    useAgentPolicy([WS]);
    const env = policyChildEnv(SOURCE, { pass: ['DATABASE_URL'] });
    expect(env?.DATABASE_URL).toBe('postgres://u:pw@localhost:5432/app');
    expect(env?.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('a failed hook\'s hint names the variables it saw (never their values) and how to pass one', () => {
    const hint = childEnvHint(['PATH', 'HOME', 'RETAKE_ENV', 'HOME']);
    expect(hint).toContain('saw HOME, PATH, RETAKE_ENV;');
    expect(hint).toContain('project.yaml `pass_env:`');
  });

  it("an unsigned rollback's hint names the variables it saw and never advises pass_env (it does not reach one)", () => {
    const hint = bareEnvHint(['PATH', 'HOME', 'PATH']);
    expect(hint).toBe("a rollback Retake did not sign gets only the shell's own variables of this environment, never project.yaml `pass_env:` — this one saw HOME, PATH; if it needs another, run it by hand");
    expect(hint).not.toContain('e.g. `pass_env:');
  });
});

describe('project.yaml `pass_env:`', () => {
  const project = (pass: string) => ['version: 1', 'name: Demo', 'environments:', '  staging: {app: "https://app.staging.example.com"}', `pass_env: ${pass}`, ''].join('\n');

  it('takes variable names', () => {
    const r = parseProjectYaml(project('[DATABASE_URL, STRIPE_TEST_KEY]'));
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.config?.pass_env).toEqual(['DATABASE_URL', 'STRIPE_TEST_KEY']);
  });

  it('refuses a loader variable and a name that is not one, with what to do instead', () => {
    const r = parseProjectYaml(project('[DATABASE_URL, NODE_OPTIONS, LD_PRELOAD, "A-B"]'));
    expect(r.config).toBeUndefined();
    const errors = r.issues.filter((i) => i.severity === 'error');
    expect(errors.map((i) => i.path)).toEqual([['pass_env', 1], ['pass_env', 2], ['pass_env', 3]]);
    expect(errors[0].message).toContain('NODE_OPTIONS is a loader variable');
    expect(errors[0].message).toContain('own `env`');
    expect(errors[2].message).toContain('not a variable name');
  });

  it('passEnvProblem: none for a plain name', () => {
    expect(passEnvProblem('DATABASE_URL')).toBeNull();
    expect(passEnvProblem('PYTHONPATH')).toMatch(/loader variable/);
    expect(passEnvProblem(join('a', 'b'))).toMatch(/not a variable name/);
  });
});
