/**
 * What a shell hook gets of the environment: everything in a command a person types; under the agent policy (a job of
 * the Studio, the desktop app or an MCP client) core childEnv's allow-list, project.yaml `pass_env:`, its own `env`
 * (`{{env:NAME}}` resolved from this process's environment) and Retake's RETAKE_* variables — and, when it fails, a hint
 * naming the variables it saw.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY, workPolicyFrom } from '@retake/core';
import type { WorkPolicy } from '@retake/core';

/** The policy the hooks below run under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
let policy: WorkPolicy = PERSON_POLICY;
import { Journal, runHooks } from '@retake/hooks';
import { makeContext, makeProject, tempProject } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
const SECRET = 'T_CHILD_ENV_SECRET';
const PASSED = 'T_CHILD_ENV_PASSED';

beforeEach(async () => {
  tmp = await tempProject('retake-child-env-');
  process.env[SECRET] = 'exported-in-the-terminal';
  process.env[PASSED] = 'listed-in-pass-env';
});
afterEach(async () => {
  policy = workPolicyFrom(null);
  delete process.env[SECRET];
  delete process.env[PASSED];
  await tmp.cleanup();
});

/** Runs `env` into env.txt (declared env OWN = {{env:SECRET}}), returns the variables it saw. */
async function seen(): Promise<Record<string, string>> {
  const project = makeProject(tmp.dir, {}, { pass_env: [PASSED] });
  const journal = await Journal.open(join(tmp.dir, '.retake', 'journal.json'));
  const res = await runHooks([{ name: 'env', shell: { run: 'env > env.txt', env: { OWN: `{{env:${SECRET}}}` } }, writes: false }], makeContext(project, { policy }).ctx, { phase: 'setup', journal });
  expect(res.ok, JSON.stringify(res.results)).toBe(true);
  const text = await readFile(join(tmp.dir, 'env.txt'), 'utf8');
  return Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function failure(): Promise<string> {
  const project = makeProject(tmp.dir, {}, { pass_env: [PASSED] });
  const journal = await Journal.open(join(tmp.dir, '.retake', 'journal.json'));
  const res = await runHooks([{ name: 'fails', shell: { run: 'exit 3', env: { OWN: 'x' } }, writes: false }], makeContext(project, { policy }).ctx, { phase: 'setup', journal });
  expect(res.ok).toBe(false);
  return res.results[0].error ?? '';
}

describe('the environment of a shell hook', () => {
  it('under the agent policy: the shell\'s own variables, pass_env, its own env — never an exported secret', async () => {
    policy = workPolicyFrom([tmp.dir]);
    const env = await seen();
    expect(env[SECRET]).toBeUndefined();
    expect(env[PASSED]).toBe('listed-in-pass-env');
    // Its own env: {{env:NAME}} is read from the worker's environment, as before.
    expect(env.OWN).toBe('exported-in-the-terminal');
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PATH).toBeTruthy();
    expect(env.RETAKE_ENV).toBe('local');
    expect(env.VITEST).toBeUndefined();
  });

  it('in a command a person types: everything it was started with', async () => {
    const env = await seen();
    expect(env[SECRET]).toBe('exported-in-the-terminal');
    expect(env[PASSED]).toBe('listed-in-pass-env');
    expect(env.OWN).toBe('exported-in-the-terminal');
  });

  it('a hook that fails under the agent policy says which variables it saw and how to pass another', async () => {
    policy = workPolicyFrom([tmp.dir]);
    const error = await failure();
    expect(error).toMatch(/^shell "exit 3" exited with code 3 \(a job the Studio, the desktop app or an MCP client starts gives its programs only some variables/);
    expect(error).toMatch(new RegExp(`this one saw HOME, (?:[A-Z_]+, )*PATH, (?:[A-Z_]+, )*${PASSED}(?:, [A-Z_]+)*; if it needs another`));
    expect(error).not.toContain('RETAKE_ENV');
    expect(error).not.toContain(SECRET);
    expect(error).toContain('project.yaml `pass_env:`');
  });

  it('outside the policy a failure has no such hint', async () => {
    expect(await failure()).toBe('shell "exit 3" exited with code 3');
  });
});
