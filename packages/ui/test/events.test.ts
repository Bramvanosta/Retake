/**
 * L4.1 part 3: the Studio's event stream and its index ops — `GET /v1/events` behind the gate (token required, other
 * pages refused, GET only), hello, an outside README edit → `workspace` within 2 s, a job written to the queue →
 * `jobs`, at most 4 streams (a 5th 503, a closed one frees its slot), a stream never counts as an op; `activity_list`
 * and `search` through /v1/call; a Node.js without node:sqlite → those two `unavailable`, events still flow.
 * L4.6 (T12): ⚑ a thread written or an entry appended (a temp file renamed into its scenario's comments folder, as the
 * store writes) → `workspace {comments: ['<slug>/<scenario>']}` naming that scenario only; the comments screen's filter
 * (app events.ts commentsEventAction) re-reads for its own scenario only.
 */
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, indexFile, newJobId } from '@demo-studio/engine';
import { EVENT_STREAMS_MAX, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';
import { commentsEventAction } from '../src/app/events.js';
import type { StudioEvent } from '../src/app/events.js';

interface Stream {
  status: number;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  next(event: string, ms?: number): Promise<Record<string, unknown>>;
  /** The whole body once the server ended it (a refusal's JSON), within `ms`. */
  body(ms?: number): Promise<string>;
  close(): void;
}

/** An event stream read over a raw request (the Studio's page reads it the same way, through fetch). */
function stream(port: number, headers: Record<string, string>): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest;
    const events: Stream['events'] = [];
    const waiters: Array<() => void> = [];
    let taken = 0;
    req = request({ host: '127.0.0.1', port, path: '/v1/events', method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false, agent: false }, (res) => {
      let buf = '';
      let all = '';
      const ended = new Promise<void>((r) => res.on('end', () => r()));
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        all += c;
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
          for (const w of waiters.splice(0)) w();
        }
      });
      res.on('error', () => undefined);
      resolve({
        status: res.statusCode ?? 0,
        events,
        next(event, ms = 4000) {
          // The first such event not yet taken (it may have arrived already).
          return new Promise((ok, fail) => {
            const t = setTimeout(() => fail(new Error(`no ${event} event within ${ms} ms (got ${JSON.stringify(events.slice(taken))})`)), ms);
            const look = () => {
              const i = events.findIndex((x, n) => n >= taken && x.event === event);
              if (i >= 0) {
                taken = i + 1;
                clearTimeout(t);
                ok(events[i].data);
              } else waiters.push(look);
            };
            look();
          });
        },
        body: (ms = 4000) =>
          Promise.race([ended.then(() => all), new Promise<string>((_, fail) => setTimeout(() => fail(new Error(`the response did not end within ${ms} ms (status ${res.statusCode})`)), ms))]),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let ws: string;
let studio: StudioServer;
const savedHome = process.env.DEMO_STUDIO_HOME;
const P = 'northfield-fixture';
const auth = () => ({ authorization: `Bearer ${studio.token}` });
const json = { 'content-type': 'application/json' };
const call = (s: StudioServer, op: string, args: unknown = {}) => raw(s.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${s.token}`, ...json }, JSON.stringify(args));
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return f();
};

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-events-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'projects', P, 'README.md'), '# Northfield\n\nGreen coffee for roasters.\n');
  await mkdir(join(ws, '.demo-studio'), { recursive: true });
  await writeFile(
    join(ws, '.demo-studio', 'history.jsonl'),
    `${JSON.stringify({ v: 1, at: '2026-10-16T07:01:00.000Z', kind: 'run', project: P, submitted_by: 'cli', state: 'succeeded', run: { id: '20261016-090000-catalogue', scenario: 'catalogue', mode: 'capture', status: 'succeeded' }, counted: { captures: 1, dry_runs: 0, renders: 0 } })}\n`,
  );
  studio = await startStudioServer({ root: ws, pollMs: 200 });
});

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('/v1/events', () => {
  it('the gate first: no token 401, another page 403 even with the token, GET only', async () => {
    expect((await raw(studio.port, 'GET', '/v1/events')).status).toBe(401);
    expect((await raw(studio.port, 'GET', '/v1/events', { ...auth(), 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await raw(studio.port, 'GET', '/v1/events', { ...auth(), origin: `http://127.0.0.1:${studio.port + 1}` })).status).toBe(403);
    expect((await raw(studio.port, 'GET', '/v1/events', { ...auth(), host: `rebind.test:${studio.port}` })).status).toBe(421);
    expect((await raw(studio.port, 'POST', '/v1/events', { ...auth(), ...json }, '{}')).status).toBe(405);
    expect(studio.streams).toBe(0);
  });

  it('hello, then an outside README edit → workspace {readme} within 2 s, a queued job → jobs; never an op', async () => {
    const calls = studio.calls;
    const s = await stream(studio.port, { ...auth(), 'sec-fetch-site': 'same-origin' });
    try {
      expect(s.status).toBe(200);
      expect(await s.next('hello')).toMatchObject({ api: 1, index: true });
      const t = Date.now();
      const changed = s.next('workspace');
      await writeFile(join(ws, 'projects', P, 'README.md'), '# Northfield\n\nChanged in another editor.\n');
      expect(await changed).toEqual({ projects: [P], readme: [P] });
      expect(Date.now() - t).toBeLessThan(2000);
      const jobs = s.next('jobs');
      const q = new FileJobQueue(ws);
      const id = newJobId();
      await mkdir(join(q.dir, id), { recursive: true });
      await writeFile(join(q.dir, id, 'job.json'), JSON.stringify({ version: 1, id, kind: 'run', input: { v: 1, kind: 'run', project: P, scenario: 'quote', mode: 'dry', run_id: '20261018-100000-quote', submitted_by: 'mcp' }, state: 'queued', created_at: new Date().toISOString() }));
      expect(await jobs).toEqual({ changed: [id] });
      expect(studio.calls).toBe(calls);
    } finally {
      s.close();
    }
    expect(await until(() => studio.streams === 0)).toBe(true);
  });

  it('at most 4 streams (EVENT_STREAMS_MAX): the next one 503 too_many_streams; a closed one frees its slot', async () => {
    expect(EVENT_STREAMS_MAX).toBe(4);
    const open: Stream[] = [];
    try {
      for (let i = 0; i < EVENT_STREAMS_MAX; i++) open.push(await stream(studio.port, auth()));
      expect(open.map((s) => s.status)).toEqual(Array(EVENT_STREAMS_MAX).fill(200));
      expect(studio.streams).toBe(EVENT_STREAMS_MAX);
      // Read as a stream (review B L9): a server that wrongly accepted a 5th would hold the request open, and a plain
      // request would wait for the test's timeout instead of failing here.
      const over = await stream(studio.port, auth());
      open.push(over);
      expect(over.status).toBe(503);
      expect((JSON.parse(await over.body()) as { error: { code: string } }).error.code).toBe('too_many_streams');
      open.pop();
      // The API still answers meanwhile.
      expect((await raw(studio.port, 'GET', '/v1/info', auth())).status).toBe(200);
      open.pop()!.close();
      expect(await until(() => studio.streams === EVENT_STREAMS_MAX - 1)).toBe(true);
      const again = await stream(studio.port, auth());
      open.push(again);
      expect(again.status).toBe(200);
    } finally {
      for (const s of open) s.close();
    }
    expect(await until(() => studio.streams === 0)).toBe(true);
  });
});

describe('comment events (L4.6, T12)', () => {
  /** A thread file written as the store writes it: a temp file in the folder, renamed over its name. */
  const writeThread = async (scenario: string, id: string, body: string) => {
    const folder = join(ws, 'projects', P, 'comments', scenario);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${id}.tmp`), body);
    await rename(join(folder, `${id}.tmp`), join(folder, `${id}.json`));
  };

  it('⚑ a thread written, an entry appended → workspace {comments} naming <slug>/<scenario> only', async () => {
    const s = await stream(studio.port, auth());
    try {
      await s.next('hello');
      const id = 'c_01JQ4000000000000000000001';
      let changed = s.next('workspace');
      await writeThread('quote', id, '{"version":1}\n');
      expect(await changed).toEqual({ projects: [P], readme: [], comments: [`${P}/quote`] });
      // An entry appended (the same name renamed over): the folder's mtime moves, the event names it again.
      await new Promise((r) => setTimeout(r, 30));
      changed = s.next('workspace');
      await writeThread('quote', id, '{"version":1,"entries":[]}\n');
      expect(await changed).toEqual({ projects: [P], readme: [], comments: [`${P}/quote`] });
      // Another scenario's thread: that scenario only.
      changed = s.next('workspace');
      await writeThread('catalogue', 'c_01JQ4000000000000000000002', '{}\n');
      expect(await changed).toEqual({ projects: [P], readme: [], comments: [`${P}/catalogue`] });
    } finally {
      s.close();
    }
    expect(await until(() => studio.streams === 0)).toBe(true);
  });

  it("the comments screen's filter re-reads for its own scenario only (commentsEventAction)", () => {
    const act = (e: StudioEvent) => commentsEventAction(e, 'p', 'quote');
    const none = { threads: false, scenario: false, renders: false };
    expect(act({ type: 'workspace', projects: ['p'], readme: [], comments: ['p/quote'] })).toEqual({ threads: true, scenario: false, renders: false });
    expect(act({ type: 'workspace', projects: ['p'], readme: [], comments: ['p/other', 'q/quote'] })).toEqual(none);
    expect(act({ type: 'workspace', projects: ['p'], readme: [], scenarios: ['p/quote'] })).toEqual({ threads: false, scenario: true, renders: false });
    expect(act({ type: 'workspace', projects: ['p'], readme: [], renders: ['p'] })).toEqual({ threads: false, scenario: false, renders: true });
    expect(act({ type: 'workspace', projects: ['p'], readme: ['p'] })).toEqual(none);
    expect(act({ type: 'jobs', changed: ['j_1'] })).toEqual(none);
    expect(act({ type: 'resync' })).toEqual({ threads: true, scenario: true, renders: true });
  });
});

describe('the index ops', () => {
  it('search: README words, scenarios, run ids as prefixes; activity_list: queue first, then history', async () => {
    expect((await stat(indexFile(ws))).isFile()).toBe(true);
    const s = await call(studio, 'search', { q: 'another edit' });
    expect(s.status).toBe(200);
    expect(s.json<{ data: { hits: Array<{ kind: string; ref: string }> } }>().data.hits).toEqual([expect.objectContaining({ kind: 'project', ref: P })]);
    const q = await call(studio, 'search', { q: 'quo', project: P });
    expect(q.json<{ data: { hits: Array<{ kind: string; ref: string }> } }>().data.hits.map((h) => `${h.kind}:${h.ref}`)).toEqual(expect.arrayContaining(['scenario:quote', 'run:20261017-120000-quote']));
    expect((await call(studio, 'search', { q: '' })).json<{ data: { hits: unknown[] } }>().data.hits).toEqual([]);
    expect((await call(studio, 'search', { q: 'x'.repeat(201) })).status).toBe(400);
    expect((await call(studio, 'search', { q: 'a', project: '../x' })).status).toBe(400);
    const a = await call(studio, 'activity_list', { limit: 10 });
    expect(a.status).toBe(200);
    const items = a.json<{ data: { items: Array<{ source: string; state: string; kind: string }> } }>().data.items;
    expect(items[0]).toMatchObject({ source: 'queue', state: 'queued', kind: 'run' });
    expect(items.at(-1)).toMatchObject({ source: 'history', kind: 'run', state: 'succeeded' });
    expect((await call(studio, 'activity_list', { project: 'other' })).json<{ data: { items: unknown[] } }>().data.items).toEqual([]);
  });

  it('a Node.js without node:sqlite: activity and search answer unavailable (503); the event stream still says what changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-ui-nosqlite-'));
    await fixtureWorkspace(dir);
    const s2 = await startStudioServer({ root: dir, sqlite: async () => null, pollMs: 200 });
    try {
      for (const op of ['activity_list', 'search']) {
        const r = await call(s2, op, op === 'search' ? { q: 'x' } : {});
        expect(r.status, op).toBe(503);
        expect(r.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'unavailable', message: expect.stringContaining('Node.js 22.13') });
      }
      expect((await call(s2, 'project_list')).status).toBe(200);
      await expect(stat(indexFile(dir))).rejects.toThrow();
      const s = await stream(s2.port, { authorization: `Bearer ${s2.token}` });
      try {
        expect(await s.next('hello')).toMatchObject({ index: false, generation: null });
        const changed = s.next('workspace');
        await writeFile(join(dir, 'projects', P, 'README.md'), '# Changed\n');
        expect(await changed).toEqual({ projects: [P], readme: [P] });
      } finally {
        s.close();
      }
    } finally {
      await s2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
