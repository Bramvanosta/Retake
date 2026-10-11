import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal, runHooks } from '@demo-studio/hooks';
import type { HookStep } from '@demo-studio/core';
import { closedPort, makeContext, makeProject, startApi, tempProject } from './helpers.js';

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
  api.requests.length = 0;
  api.replies.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

function setup() {
  const project = makeProject(tmp.dir, { console: api.base });
  return { project, ...makeContext(project) };
}

describe('http hooks', () => {
  it('checks the status: 2xx by default, `expect` otherwise', async () => {
    const { ctx } = setup();
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const ok = await runHooks([{ http: { url: '{{console}}/status/204' } }], ctx, { phase: 'teardown', journal });
    expect(ok.ok).toBe(true);
    expect(ok.results[0]).toMatchObject({ status: 'ok', message: '204 No Content', description: `http GET ${api.base}/status/204` });

    const bad = await runHooks([{ http: { url: '{{console}}/status/409' } }], ctx, { phase: 'teardown', journal });
    expect(bad.ok).toBe(false);
    expect(bad.results[0].error).toBe(`GET ${api.base}/status/409: expected 2xx, got 409 Conflict: {"status":409}`);

    const expected = await runHooks([{ http: { url: '{{console}}/status/409', expect: [200, 409] } }], ctx, {
      phase: 'teardown',
      journal,
    });
    expect(expected.ok).toBe(true);
  });

  it('save_as feeds the templating of later hooks, then the rollback uses {{response.json.id}}', async () => {
    const { ctx } = setup();
    ctx.vars = { greeting: 'Your sample is on its way' };
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const hooks: HookStep[] = [
      {
        name: 'create reply',
        http: {
          method: 'POST',
          url: '{{console}}/api/replies',
          json: { text: '{{vars.greeting}}' },
          save_as: 'reply',
          rollback: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}' },
        },
      },
      { http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'follow-up to {{hooks.reply.json.id}}' } } },
    ];
    const res = await runHooks(hooks, ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(true);
    expect(ctx.saved.reply).toMatchObject({ status: 201, json: { id: 42, text: 'Your sample is on its way' } });
    expect((ctx.saved.reply as { headers: Record<string, string> }).headers['content-type']).toBe('application/json');
    expect([...api.replies.values()].map((r) => r.text)).toEqual(['Your sample is on its way', 'follow-up to 42']);
    expect(api.requests[0].headers['content-type']).toBe('application/json');

    expect(journal.pending()).toHaveLength(1);
    expect(journal.pending()[0].rollback).toMatchObject({
      kind: 'http',
      description: `http DELETE ${api.base}/api/replies/42`,
      request: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}' },
      data: { pages: { console: api.base }, extra: { response: { json: { id: 42 } } } },
    });

    // Rollback from a fresh journal instance, as `studio hooks rollback` would do.
    const reopened = await Journal.open(journal.file);
    const fresh = makeContext(makeProject(tmp.dir, { console: api.base })).ctx;
    const rolled = await reopened.rollbackAll(fresh);
    expect(rolled).toMatchObject([{ phase: 'rollback', ok: true, status: 'ok', message: '204 No Content' }]);
    expect([...api.replies.keys()]).toEqual([43]);
    expect(api.requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/replies/42' });
  });

  it('a rollback that cannot be templated after the request fails the hook', async () => {
    const { ctx } = setup();
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const res = await runHooks(
      [{ http: { method: 'POST', url: '{{console}}/api/replies', rollback: { method: 'DELETE', url: '{{console}}/x/{{response.json.uuid}}' } } }],
      ctx,
      { phase: 'setup', journal },
    );
    expect(res.ok).toBe(false);
    expect(res.results[0].error).toMatch(/^ran \(201 Created\) but its rollback cannot be prepared: unknown template key \{\{response\.json\.uuid\}\}/);
    expect(journal.pending()).toHaveLength(0);
  });

  it('rejects unknown template keys and malformed requests before sending anything', async () => {
    const { ctx } = setup();
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const res = await runHooks(
      [
        { http: { url: '{{admin}}/x' } },
        { http: { url: '/api/replies' } },
        { http: { url: '{{console}}/api/replies', json: { a: 1 } } },
        { http: { method: 'POST', url: '{{console}}/api/replies', rollback: { url: '{{console}}/{{hooks.nope.json.id}}' } } },
      ],
      ctx,
      { phase: 'teardown', journal },
    );
    expect(res.results.map((r) => r.error)).toEqual([
      expect.stringMatching(/^unknown template key \{\{admin\}\}; available: console, /),
      'http hook: "/api/replies" is not an absolute URL; start it with a page key such as {{console}}/path',
      'http hook: a GET request cannot have a body; set method: POST (or PUT / PATCH)',
      undefined, // teardown: rollbacks are ignored, so the bad template does not matter
    ]);
    expect(api.requests.map((r) => r.method)).toEqual(['POST']);

    const setupRes = await runHooks(
      [{ http: { method: 'POST', url: '{{console}}/api/replies', rollback: { url: '{{console}}/{{hooks.nope.json.id}}' } } }],
      ctx,
      { phase: 'setup', journal },
    );
    expect(setupRes.results[0].error).toMatch(/^unknown template key \{\{hooks\.nope\.json\.id\}\}/);
    expect(api.requests).toHaveLength(1);
  });

  it('follows redirects inside the allow-list and refuses one that leaves it', async () => {
    const { ctx } = setup();
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const inside = await runHooks([{ http: { url: `{{console}}/redirect?to=${encodeURIComponent('/status/200')}` } }], ctx, {
      phase: 'teardown',
      journal,
    });
    expect(inside.results[0]).toMatchObject({ ok: true, message: '200 OK' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const outside = await runHooks(
      [{ http: { url: `{{console}}/redirect?to=${encodeURIComponent('http://collector.example.net/steal')}` } }],
      ctx,
      { phase: 'teardown', journal },
    );
    expect(outside.results[0]).toMatchObject({ ok: false, status: 'refused' });
    expect(outside.results[0].error).toMatch(/^refusing to contact collector\.example\.net: it is not in the allow-list/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const kept = await runHooks([{ http: { url: '{{console}}/redirect?to=/status/302', expect: 302 } }], ctx, {
      phase: 'teardown',
      journal,
    });
    expect(kept.results[0]).toMatchObject({ ok: true, message: '302 Found' });
  });

  it('reports connection failures with their cause and keeps non-JSON bodies as text', async () => {
    const { ctx } = setup();
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const port = await closedPort();
    const res = await runHooks(
      [{ http: { url: '{{console}}/text', save_as: 'plain' } }, { http: { url: `http://127.0.0.1:${port}/nothing-listens` } }],
      ctx,
      { phase: 'teardown', journal },
    );
    expect(ctx.saved.plain).toMatchObject({ status: 200, body: 'plain text', json: undefined });
    expect(res.results[1].error).toBe(`GET http://127.0.0.1:${port}/nothing-listens failed: fetch failed (connect ECONNREFUSED 127.0.0.1:${port})`);
  });

  it('journals every execution with phase, timestamps and status', async () => {
    const { ctx } = setup();
    const file = join(tmp.dir, 'runs/r1/hooks-journal.json');
    const journal = await Journal.open(file);
    await runHooks([{ name: 'reset', http: { method: 'POST', url: '{{console}}/api/replies' } }], ctx, { phase: 'teardown', journal });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toMatchObject({ version: 1, entries: [{ seq: 1, name: 'reset', kind: 'http', phase: 'teardown', status: 'ok', env: 'local' }] });
    expect(Date.parse(saved.entries[0].started_at)).toBeLessThanOrEqual(Date.parse(saved.entries[0].finished_at));
    expect(saved.entries[0].description).toBe(`reset: http POST ${api.base}/api/replies`);
  });
});
