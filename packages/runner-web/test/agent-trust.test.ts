/**
 * L3.1 review, in the runner (trust `mcp`: a job submitted through MCP): the scenario's secret references and files are
 * refused before anything runs, and a step reading a file whose path only templating reveals (drop_file.path, eval.file)
 * checks it when it runs — inside the project folder, an eval file not agent-writable and naming no secret.
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '@demo-studio/core';
import { runScenario } from '../src/index.js';
import { dropFile } from '../src/actions/drag.js';
import { evalStep } from '../src/actions/misc.js';
import type { StepContext } from '../src/runtime.js';
import { FAST, makeProject, makeScenario, tempDir } from './helpers.js';

let dir: string;
let outside: string;

beforeAll(async () => {
  dir = await tempDir('rw-agent-trust-');
  outside = await tempDir('rw-agent-outside-');
  await writeFile(join(outside, 'secret.txt'), 'top secret');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'scenarios', 'x.js'), 'return 1');
  await writeFile(join(dir, 'assets', 'token.js'), "return '{{env:HOME}}'");
  await symlink(join(outside, 'secret.txt'), join(dir, 'assets', 'link.txt'));
});

afterAll(async () => {
  for (const d of [dir, outside]) if (d) await rm(d, { recursive: true, force: true });
});

/** A step context whose runtime only knows the project and its trust (the refusals come before any page is used). */
const ctx = (agentTrust: boolean) => ({ rt: { agentTrust, project: makeProject(dir, {}), secrets: { prefetch: async () => undefined } } }) as unknown as StepContext;

async function stepError(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (x: unknown) => x as Error);
  return e?.message ?? '';
}

describe('runner, trust mcp', () => {
  it('a scenario naming a secret or a file outside the project fails before the browser (an unusable executable is never launched)', async () => {
    const sc: Omit<Scenario, 'video'> = {
      pacing: FAST,
      scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ eval: { js: "throw new Error(btoa('{{env:HOME}}'))" } }, { drop_file: { zone: { css: 'body' }, path: join(outside, 'secret.txt') } }] }],
    };
    const base = { project: makeProject(dir, { app: 'http://127.0.0.1:9' }), scenario: makeScenario('leak', sc), mode: 'dry' as const, env: 'test', browser: { executable: '/nonexistent/chromium' } };
    const rec = await runScenario({ ...base, runId: `leak-${Date.now()}`, hookTrust: 'mcp' });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toMatch(/^refused \(work submitted through MCP\): the scenario uses \{\{env:HOME\}\}.*; step home\.1 \(drop_file\.path\): .* is an absolute path/);
    // The CLI (trust author) goes on to the browser, which fails here.
    const author = await runScenario({ ...base, runId: `leak-author-${Date.now()}` });
    expect(author.error?.message).not.toContain('work submitted through MCP');
  });

  it('drop_file.path and eval.file, as templated when the step runs: inside the project; eval code not agent-writable, without a secret', async () => {
    const zone = { css: 'body' };
    expect(await stepError(dropFile(ctx(true), { zone, path: join(outside, 'secret.txt') }))).toContain('is an absolute path');
    expect(await stepError(dropFile(ctx(true), { zone, path: '../' + outside.split('/').pop() + '/secret.txt' }))).toContain('resolves outside the project folder');
    expect(await stepError(dropFile(ctx(true), { zone, path: 'assets/link.txt' }))).toContain('resolves outside the project folder');
    expect(await stepError(evalStep(ctx(true), { file: 'scenarios/x.js' }))).toContain('a file an agent can write through MCP');
    expect(await stepError(evalStep(ctx(true), { file: 'assets/token.js' }))).toContain('eval file assets/token.js uses {{env:HOME}}');
    // Trust author: read as before (the fake runtime then fails further on, not on the file).
    expect(await stepError(dropFile(ctx(false), { zone, path: 'assets/link.txt' }))).not.toContain('outside the project');
    expect(await stepError(evalStep(ctx(false), { file: 'scenarios/x.js' }))).not.toContain('agent can write');
  });
});
