import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Journal, runHooks } from '@retake/hooks';
import type { HookStep } from '@retake/core';
import { addSecret, redactDeep, redactText } from '../src/secrets.js';
import type { HookContext } from '../src/types.js';
import { makeContext, makeProject, startApi, tempProject } from './helpers.js';

const TOKEN = 'nf-staging-token-8f3a1c';
const PASSWORD = 'p@ss word/42';

let api: Awaited<ReturnType<typeof startApi>>;
let tmp: Awaited<ReturnType<typeof tempProject>>;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  tmp = await tempProject();
  process.env.NF_TEST_TOKEN = TOKEN;
  process.env.NF_TEST_PASSWORD = PASSWORD;
});
afterEach(async () => {
  delete process.env.NF_TEST_TOKEN;
  delete process.env.NF_TEST_PASSWORD;
  await tmp.cleanup();
});

describe('secrets', () => {
  it('are used in requests and rollbacks but never appear in logs, results or journals', async () => {
    const project = makeProject(tmp.dir, { console: api.base });
    const { ctx, logText } = makeContext(project);
    const file = join(tmp.dir, 'runs/r1/hooks-journal.json');
    const journal = await Journal.open(file);
    const hooks: HookStep[] = [
      {
        http: {
          method: 'POST',
          url: '{{console}}/api/replies?key={{env:NF_TEST_TOKEN}}',
          headers: { authorization: 'Bearer {{env:NF_TEST_TOKEN}}' },
          json: { text: 'hello' },
          rollback: {
            method: 'DELETE',
            url: '{{console}}/api/replies/{{response.json.id}}?key={{env:NF_TEST_TOKEN}}',
            headers: { authorization: 'Bearer {{env:NF_TEST_TOKEN}}' },
          },
        },
      },
      {
        shell: {
          run: 'echo "token=$NF_TOKEN password={{env:NF_TEST_PASSWORD}}"; echo "$NF_TOKEN" >&2',
          env: { NF_TOKEN: '{{env:NF_TEST_TOKEN}}' },
          rollback: 'echo "undo with {{env:NF_TEST_PASSWORD}}"',
        },
      },
      { http: { url: '{{console}}/status/500?key={{env:NF_TEST_TOKEN}}' } },
    ];
    const res = await runHooks(hooks, ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => [r.phase, r.status])).toEqual([
      ['setup', 'ok'],
      ['setup', 'ok'],
      ['setup', 'failed'],
      ['rollback', 'ok'],
      ['rollback', 'ok'],
    ]);

    // The real values reached the server…
    expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests[0].url).toBe(`/api/replies?key=${TOKEN}`);
    expect(api.requests.at(-1)).toMatchObject({ method: 'DELETE', url: `/api/replies/42?key=${TOKEN}` });
    expect(api.requests.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    // …but never the logs, results or the journal (in clear or URL-encoded).
    const journalText = await readFile(file, 'utf8');
    const resultsText = JSON.stringify(res.results);
    for (const secret of [TOKEN, PASSWORD, encodeURIComponent(PASSWORD)]) {
      expect(logText()).not.toContain(secret);
      expect(resultsText).not.toContain(secret);
      expect(journalText).not.toContain(secret);
    }
    expect(logText()).toContain(`http POST ${api.base}/api/replies?key=***`);
    expect(logText()).toContain('stdout:\ntoken=*** password=***');
    expect(logText()).toContain('stderr:\n***');
    expect(logText()).toContain('undo with ***');
    expect(res.results[2].error).toBe(`GET ${api.base}/status/500?key=***: expected 2xx, got 500 Internal Server Error: {"status":500}`);
    // The journal keeps the template form of the rollbacks.
    const entries = JSON.parse(journalText).entries;
    expect(entries[0].rollback.request.headers.authorization).toBe('Bearer {{env:NF_TEST_TOKEN}}');
    expect(entries[0].rollback.description).toBe(`http DELETE ${api.base}/api/replies/42?key=***`);
    expect(entries[1].rollback.env).toEqual({ NF_TOKEN: '{{env:NF_TEST_TOKEN}}' });
  });

  it('a missing secret fails the hook before anything runs', async () => {
    const { ctx } = makeContext(makeProject(tmp.dir, { console: api.base }));
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const before = api.requests.length;
    const res = await runHooks([{ http: { url: '{{console}}/status/200', headers: { 'x-key': '{{env:NF_TEST_UNSET}}' } } }], ctx, {
      phase: 'setup',
      journal,
    });
    expect(res.results[0].error).toBe('environment variable NF_TEST_UNSET is not set');
    expect(api.requests.length).toBe(before);
  });

  it('dry runs never resolve secrets', async () => {
    const { ctx, logText } = makeContext(makeProject(tmp.dir, { console: api.base }), { dryRun: true });
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const res = await runHooks([{ shell: 'curl -H "x-key: {{keychain:northfield/staging-api}}" {{console}}' }], ctx, { phase: 'setup', journal });
    expect(res.results[0]).toMatchObject({ status: 'dry', description: `shell "curl -H "x-key: ***" ${api.base}"` });
    expect(logText()).toContain('would run shell');
  });
});

describe('redaction of overlapping secrets', () => {
  it('the longer secret is masked whole, whatever order they were registered in; redactDeep too', () => {
    for (const order of [
      ['abc', 'abcdef'],
      ['abcdef', 'abc'],
    ]) {
      const ctx = {} as HookContext;
      for (const v of order) addSecret(ctx, v);
      expect(redactText(ctx, 'x abcdef y abc z'), order.join(',')).toBe('x *** y *** z');
      expect(redactDeep(ctx, { a: ['x abcdef y'], b: { c: 'abcdef' }, n: 1 })).toEqual({ a: ['x *** y'], b: { c: '***' }, n: 1 });
    }
  });

  it('a secret under 3 characters is not registered (it would mangle every log)', () => {
    const ctx = {} as HookContext;
    addSecret(ctx, 'ab');
    addSecret(ctx, 'xyz');
    expect(redactText(ctx, 'ab xyz')).toBe('ab ***');
  });
});

describe("secrets through the context's resolver (the engine's Secrets port)", () => {
  it('a real run resolves through ctx.resolveSecret only, and a dry run checks a variable through it: never this process', async () => {
    const { secretResolver } = await import('../src/secrets.js');
    const project = makeProject(tmp.dir, { console: api.base });
    const asked: string[] = [];
    const handed: Record<string, string> = { 'env:HANDED_ONLY': 'h4nded' };
    const resolveSecret = async (ref: string) => {
      asked.push(ref);
      if (Object.hasOwn(handed, ref)) return handed[ref]!;
      throw new Error(`environment variable ${ref.slice(4)} is not set`);
    };
    const real = { ...makeContext(project).ctx, resolveSecret };
    const r = await secretResolver(real, { a: '{{env:HANDED_ONLY}}' });
    expect(r('env:HANDED_ONLY')).toBe('h4nded');
    // A reference the value did not name is unresolved, even one this process has (NF_TEST_TOKEN is set).
    expect(process.env.NF_TEST_TOKEN).toBe(TOKEN);
    expect(r('env:NF_TEST_TOKEN')).toBeUndefined();
    await expect(secretResolver(real, { a: '{{env:NF_TEST_TOKEN}}' })).rejects.toThrow('environment variable NF_TEST_TOKEN is not set');
    const dry = { ...makeContext(project).ctx, dryRun: true, resolveSecret };
    const d = await secretResolver(dry, { a: '{{env:HANDED_ONLY}}', b: '{{env:NF_TEST_TOKEN}}' });
    expect([d('env:HANDED_ONLY'), d('env:NF_TEST_TOKEN')]).toEqual(['***', undefined]);
    expect(asked).toEqual(['env:HANDED_ONLY', 'env:NF_TEST_TOKEN', 'env:HANDED_ONLY', 'env:NF_TEST_TOKEN']);
  });
});
