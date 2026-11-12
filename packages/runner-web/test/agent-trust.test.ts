/**
 * L3.1 review, in the runner (trust `mcp`: a job submitted through MCP): the scenario's secret references and files are
 * refused before anything runs, and a step reading a file whose path only templating reveals (drop_file.path, eval.file)
 * checks it when it runs — inside the project folder, an eval file not agent-writable and naming no secret.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '@retake/core';
import { runScenario } from '../src/index.js';
import { dropFile } from '../src/actions/drag.js';
import { evalStep } from '../src/actions/misc.js';
import type { StepContext } from '../src/runtime.js';
import { FAST, makeProject, makeScenario, startServer, tempDir, testHookRunner } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';
import { STUDIO_CONFINEMENT } from '../../core/test/helpers.js';

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
  const e = await p.then(
    () => undefined,
    (x: unknown) => x as Error,
  );
  return e?.message ?? '';
}

describe('runner, trust mcp', () => {
  it('a scenario naming a secret or a file outside the project fails before the browser (an unusable executable is never launched)', async () => {
    const sc: Omit<Scenario, 'video'> = {
      pacing: FAST,
      scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ eval: { js: "throw new Error(btoa('{{env:HOME}}'))" } }, { drop_file: { zone: { css: 'body' }, path: join(outside, 'secret.txt') } }] }],
    };
    const base = { project: makeProject(dir, { app: 'http://127.0.0.1:9' }), scenario: makeScenario('leak', sc), mode: 'dry' as const, env: 'test', browser: { executable: '/nonexistent/chromium' } };
    const rec = await runScenario({ policy: PERSON_POLICY, ...base, runId: `leak-${Date.now()}`, hookTrust: 'mcp' });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toMatch(/^refused \(work submitted through MCP\): the scenario uses \{\{env:HOME\}\}.*; step home\.1 \(drop_file\.path\): .* is an absolute path/);
    // The CLI (trust author) goes on to the browser, which fails here.
    const author = await runScenario({ policy: PERSON_POLICY, ...base, runId: `leak-author-${Date.now()}` });
    expect(author.error?.message).not.toContain('work submitted through MCP');
  });

  it("a scenario opening another origin than the environment's pages fails before the browser, saying what to change", async () => {
    const sc: Omit<Scenario, 'video'> = {
      pacing: FAST,
      scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ new_tab: { href: 'http://127.0.0.1:10/admin', as: 'other' } }, { open: 'http://127.0.0.1:9/ok' }] }],
    };
    const base = {
      project: makeProject(dir, { app: 'http://127.0.0.1:9' }),
      scenario: makeScenario('elsewhere', sc),
      mode: 'dry' as const,
      env: 'test',
      browser: { executable: '/nonexistent/chromium' },
    };
    const rec = await runScenario({ policy: PERSON_POLICY, ...base, runId: `elsewhere-${Date.now()}`, hookTrust: 'mcp', hookVia: STUDIO_CONFINEMENT });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toMatch(
      /^refused \(work submitted from the Studio\): scenes\[0\]\.steps\[0\]\.new_tab\.href: http:\/\/127\.0\.0\.1:10\/admin is on http:\/\/127\.0\.0\.1:10, not an origin of environment test's pages \(http:\/\/127\.0\.0\.1:9\)/,
    );
    expect(rec.error?.message).toContain('add its origin as a page of environment test in project.yaml');
    expect(rec.error?.message).not.toContain('steps[1]');
    const author = await runScenario({ policy: PERSON_POLICY, ...base, runId: `elsewhere-author-${Date.now()}` });
    expect(author.error?.message).not.toContain('work submitted');
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

  it("the scenario's own hooks are the agent's — a shell one setting a loader variable is refused, in its setup, named hooks and teardown — and so is a project.yaml hook rendered with the scenario's vars", async () => {
    const server = await startServer({ '/': '<html><body><h1>Home</h1></body></html>' });
    try {
      const steps = [{ hook: 'warm' }, { hold: 0.1 }];
      const run = (name: string, sc: Omit<Scenario, 'video'>, project = makeProject(dir, { app: server.url })) =>
        runScenario({
          policy: PERSON_POLICY,
          project,
          scenario: makeScenario(name, { pacing: FAST, ...sc }),
          mode: 'dry',
          hooks: 'run',
          env: 'test',
          runId: `${name}-${Date.now()}`,
          hookTrust: 'mcp',
          confirmHook: () => true,
          hookRunner: testHookRunner(),
        });
      const shared = (vars?: Record<string, string>) => {
        const p = makeProject(dir, { app: server.url });
        p.config.hooks = { warm: { shell: { run: '{{vars.prefix}} true' } } };
        if (vars) p.config.vars = vars;
        return p;
      };
      const setup = await run('own-setup', { setup: [{ name: 'tooling', shell: { run: 'PATH=/usr/bin:/bin true' } }], scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ hold: 0.1 }] }] });
      expect(setup.status).toBe('failed');
      expect(setup.error?.message).toContain('setup hooks failed (tooling: refusing shell hook: it uses `PATH=` (it sets PATH, a loader variable)');
      const own = await run(
        'own-named',
        { hooks: { warm: { shell: { run: 'true', env: { NODE_OPTIONS: '-r ./x.cjs' } } } }, scenes: [{ id: 'home', page: 'app', open: '/', steps }] },
        shared({ prefix: 'LANG=C' }),
      );
      expect(own.status).toBe('failed');
      expect(own.error?.message).toContain('hook "warm" failed (warm: refusing shell hook: it uses its env `NODE_OPTIONS` (a loader variable)');
      const agentVars = await run('agent-vars', { vars: { prefix: 'PATH=/usr/bin:/bin' }, scenes: [{ id: 'home', page: 'app', open: '/', steps }] }, shared());
      expect(agentVars.status).toBe('failed');
      expect(agentVars.error?.message).toContain('hook "warm" failed (warm: refusing shell hook: it uses `PATH=` (it sets PATH, a loader variable)');
      // Its teardown is the agent's too: refused, nothing runs (a person's hook there would run, approved).
      const marker = join(dir, 'teardown-ran');
      const teardown = await run('own-teardown', {
        teardown: [{ name: 'tidy', shell: { run: `PATH=/usr/bin:/bin touch ${marker}` } }],
        scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ hold: 0.1 }] }],
      });
      expect(teardown.hooks?.teardown).toBe('failed');
      expect(existsSync(marker)).toBe(false);
      // project.yaml's hook with project.yaml's own vars: a person's — it runs.
      const person = await run('person-vars', { scenes: [{ id: 'home', page: 'app', open: '/', steps }] }, shared({ prefix: 'PATH=/usr/bin:/bin' }));
      expect(person.error?.message).toBeUndefined();
      expect(person.status).toBe('succeeded');
    } finally {
      await server.close();
    }
  });
});
