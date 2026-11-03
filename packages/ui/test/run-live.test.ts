/**
 * L4.4 part B: the Run screen's stream `POST /v1/live` — no browser, no worker: the test plays the worker (it claims the
 * job, writes the run's log.jsonl and the job's events.jsonl, and opens the job's live channel, engine
 * live-channel.ts, feeding frames to its sink).
 *
 * - S5 the gate: token, another page, method, content type, body cap and shape; at most 2 run streams (a 3rd 503);
 *   never an op.
 * - The log view: a snapshot then progress events whose `seq` is the byte offset of the line's end; `after` resumes
 *   without a duplicate; the job's worker notes merged (its `run` events are not repeated); unknown or malformed lines
 *   dropped; a line over 64 KiB skipped with a note; `end` once the run and its job ended.
 * - S9 untrusted text and no paths: no path field (run_start's `dir`), no workspace / home path in any text, the
 *   filmed site's and hooks' text under `untrusted`, capped at 2,000 characters.
 * - The picture: one upstream per job whatever the number of page streams, opened only while a page stream wants frames
 *   and closed when none does; a capture streams only when the page asked; a terminal's run shows none; the relay is
 *   latest-only (a page that never reads holds one frame at most); S4 no frame ever lands on disk.
 * - Review fixes: U+2028 / U+2029 in a page's text never lose an event (escaped on the wire, the page's parser splits
 *   lines on `\n` only — A M1); a hook named by its description is scrubbed as a text, URLs in texts masked (A notes);
 *   the run's and the worker's lines merged by time (B L5); a snapshot carries the last 500 log lines (B tests).
 */
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, openLiveChannel, selfIdentity } from '@retake/engine';
import type { JobRecord, LiveChannel } from '@retake/engine';
import { LIVE_SNAPSHOT_LOG_LINES, LIVE_TEXT_MAX, RUN_LIVE_STREAMS_MAX, maskUrls, mergeByTime, startStudioServer } from '../src/index.js';
import { parseSseBlock, readSse } from '../src/app/sse.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const P = 'northfield-fixture';
const savedHome = process.env.RETAKE_HOME;
let ws: string;
let studio: StudioServer;
let queue: FileJobQueue;
const project = () => join(ws, 'projects', P);
const runDir = (id: string) => join(project(), 'runs', id);

const scenario = (video: string) =>
  [`video: ${video}`, 'scenes:', '  - id: a', '    page: console', '    open: /', '    steps:', '      - hold: 1', '      - click: {text: Catalog}', ''].join('\n');

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-live-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  for (const n of ['live-a', 'live-b', 'live-c', 'live-d', 'live-e', 'live-f', 'live-g', 'live-h', 'live-i']) await writeFile(join(project(), 'scenarios', `${n}.yaml`), scenario(n));
  studio = await startStudioServer({ root: ws, startWorker: false, runPollMs: 40 });
  queue = new FileJobQueue(ws);
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' });
const call = (op: string, args: unknown) => raw(studio.port, 'POST', `/v1/call/${op}`, auth(), JSON.stringify(args));

interface Ev {
  event: string;
  data: Record<string, unknown>;
}
interface LiveStream {
  status: number;
  events: Ev[];
  text(): string;
  next(event: string, ms?: number, pred?: (d: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  ended(ms?: number): Promise<void>;
  close(): void;
}

/** A run stream read over a raw request, as the page reads it through fetch. */
function live(body: unknown, headers: Record<string, string> = auth()): Promise<LiveStream> {
  return new Promise((resolve, reject) => {
    const events: Ev[] = [];
    const waiters: Array<() => void> = [];
    let all = '';
    const text = JSON.stringify(body);
    const req: ClientRequest = request(
      { host: '127.0.0.1', port: studio.port, path: '/v1/live', method: 'POST', headers: { host: `127.0.0.1:${studio.port}`, 'content-length': String(Buffer.byteLength(text)), ...headers }, setHost: false, agent: false },
      (res) => {
        let buf = '';
        let done = false;
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          all += c;
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const parsed = parseSseBlock(block);
            if (parsed) events.push({ event: parsed.type, data: JSON.parse(parsed.data) as Record<string, unknown> });
          }
          for (const w of waiters.splice(0)) w();
        });
        res.on('end', () => {
          done = true;
          for (const w of waiters.splice(0)) w();
        });
        res.on('error', () => undefined);
        const taken = new Map<string, number>();
        resolve({
          status: res.statusCode ?? 0,
          events,
          text: () => all,
          next(event, ms = 5000, pred = () => true) {
            return new Promise((ok, fail) => {
              const t = setTimeout(() => fail(new Error(`no ${event} event within ${ms} ms (got ${events.map((e) => e.event).join(', ')})`)), ms);
              const look = () => {
                const from = taken.get(event) ?? 0;
                const i = events.findIndex((x, n) => n >= from && x.event === event && pred(x.data));
                if (i >= 0) {
                  taken.set(event, i + 1);
                  clearTimeout(t);
                  ok(events[i].data);
                } else waiters.push(look);
              };
              look();
            });
          },
          ended: (ms = 5000) =>
            new Promise<void>((ok, fail) => {
              const t = setTimeout(() => fail(new Error(`the stream did not end within ${ms} ms`)), ms);
              const look = () => (done ? (clearTimeout(t), ok()) : waiters.push(look));
              look();
            }),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Queue a run of `name` from the Studio, then take its job as a worker would (claimed by this process, running). */
async function runningJob(name: string, mode: 'dry' | 'capture' = 'dry'): Promise<{ run: string; job: string }> {
  const r = await call('scenario_run', { project: P, name, mode });
  expect(r.status, r.body).toBe(200);
  const { run_id, job } = r.json<{ data: { run_id: string; job: string } }>().data;
  const me = await selfIdentity();
  expect(await queue.claim(job, me)).toBe(true);
  const rec = (await queue.get(job)) as JobRecord;
  await queue.write({ ...rec, state: 'running', started_at: new Date().toISOString(), worker: { ...me, host: hostname() } });
  return { run: run_id, job };
}

async function finishJob(job: string, state: 'succeeded' | 'failed' = 'succeeded'): Promise<void> {
  const rec = (await queue.get(job)) as JobRecord;
  await queue.write({ ...rec, state, finished_at: new Date().toISOString() });
}

const line = (ev: Record<string, unknown>) => JSON.stringify({ ts: '2026-10-26T12:00:00.000Z', ...ev }) + '\n';
const log = (run: string, ...evs: Array<Record<string, unknown> | string>) => appendFile(join(runDir(run), 'log.jsonl'), evs.map((e) => (typeof e === 'string' ? e : line(e))).join(''));
const runRecord = (run: string, over: Record<string, unknown> = {}) => ({
  id: run, project: P, scenario: 'x', mode: 'dry', status: 'running', started_at: '2026-10-26T12:00:00.000Z', dir: runDir(run), env: 'local',
  options: { hooks: 'skip', headed: false }, steps_total: 2, steps_done: 0, screenshots: [join(runDir(run), 'screenshots', '001-a.0.png')],
  hooks: { setup: 'skipped', teardown: 'skipped' }, warnings: [], ...over,
});

/** A JPEG-looking frame whose bytes say which one it is. */
function jpeg(n: number, size = 4096): Buffer {
  const b = Buffer.alloc(size, (n * 7) % 251);
  b.writeUInt32BE(0xffd8ffe0, 0);
  b.writeUInt32BE(n, 8);
  return b;
}
const frame = (ch: LiveChannel, n: number, size?: number) => ch.sink.frame({ data: jpeg(n, size), width: 960, height: 540, at: Date.now(), page: 'console' });
const channel = async (j: { run: string; job: string }) => openLiveChannel({ queue, jobId: j.job, runId: j.run, worker: await selfIdentity() });

describe('POST /v1/live: the gate (S5)', () => {
  it('token, another page, method, content type, body cap and shape; an unknown run 404; at most 2 streams; never an op', async () => {
    const j = await runningJob('live-a');
    const body = JSON.stringify({ project: P, run_id: j.run, frames: false });
    const p = studio.port;
    const before = studio.calls;
    expect((await raw(p, 'POST', '/v1/live', { 'content-type': 'application/json' }, body)).status).toBe(401);
    expect((await raw(p, 'POST', '/v1/live', { ...auth(), authorization: 'Bearer nope' }, body)).status).toBe(401);
    expect((await raw(p, 'POST', '/v1/live', { ...auth(), origin: 'http://127.0.0.1:4401' }, body)).status).toBe(403);
    expect((await raw(p, 'POST', '/v1/live', { ...auth(), 'sec-fetch-site': 'same-site' }, body)).status).toBe(403);
    expect((await raw(p, 'POST', '/v1/live', { ...auth(), host: `evil.example:${p}` }, body)).status).toBe(421);
    expect((await raw(p, 'GET', '/v1/live', { authorization: auth().authorization })).status).toBe(405);
    expect((await raw(p, 'POST', '/v1/live', { ...auth(), 'content-type': 'text/plain' }, body)).status).toBe(415);
    expect((await raw(p, 'POST', '/v1/live', auth(), JSON.stringify({ project: P, run_id: j.run, pad: 'x'.repeat(5000) }))).status).toBe(413);
    for (const bad of [{ project: P, run_id: '../x' }, { project: '../p', run_id: j.run }, { project: P, run_id: j.run, path: '/etc' }, { project: P, run_id: j.run, after: { log: -1 } }, { project: P }]) {
      const r = await raw(p, 'POST', '/v1/live', auth(), JSON.stringify(bad));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await raw(p, 'POST', '/v1/live', auth(), JSON.stringify({ project: P, run_id: '20200101-000000-nope' }))).status).toBe(404);
    const a = await live({ project: P, run_id: j.run, frames: false });
    const b = await live({ project: P, run_id: j.run, frames: false });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Array.isArray((await a.next('snapshot')).events)).toBe(true);
    const c = await raw(p, 'POST', '/v1/live', auth(), body);
    expect(c.status).toBe(503);
    expect(c.json<{ error: { code: string } }>().error.code).toBe('too_many_streams');
    expect(studio.runLive.streamCount).toBe(RUN_LIVE_STREAMS_MAX);
    // A closed stream frees its slot.
    a.close();
    await until('a slot freed', () => studio.runLive.streamCount === 1);
    const d = await live({ project: P, run_id: j.run, frames: false });
    expect(d.status).toBe(200);
    b.close();
    d.close();
    await until('no stream', () => studio.runLive.streamCount === 0);
    expect(studio.calls).toBe(before);
    await finishJob(j.job);
  });
});

describe('POST /v1/live: steps and log from log.jsonl', () => {
  it('snapshot then progress with byte-offset seq; after resumes without a duplicate; job notes merged; long lines skipped; end', async () => {
    const j = await runningJob('live-b');
    await log(
      j.run,
      { type: 'run_start', run: runRecord(j.run) },
      { type: 'outline', steps: [{ scene: 'a', step: 0, action: 'hold', desc: 'hold 1 s' }, { scene: 'a', step: 1, action: 'click', desc: 'click "Catalog"' }] },
      { type: 'session', persona: 'supplier', status: 'signed_in_auto', detail: 'Signed in as <b>Maja</b>' },
      { type: 'scene_start', scene: 'a', index: 0 },
      { type: 'step_start', scene: 'a', step: 0, action: 'hold', desc: 'hold 1 s' },
      'not json\n',
      { type: 'mystery', secret: 'x' },
      { type: 'step_end', scene: 'a', step: 0, action: 'hold', status: 'bogus', ms: 1 },
    );
    await appendFile(join(queue.jobDir(j.job), 'events.jsonl'), [
      JSON.stringify({ seq: 1, t: '2026-10-26T12:00:00.000Z', type: 'state', state: 'running' }),
      JSON.stringify({ seq: 2, t: '2026-10-26T12:00:00.000Z', type: 'run', event: { type: 'log', level: 'info', message: 'a run event, already in log.jsonl' } }),
      JSON.stringify({ seq: 3, t: '2026-10-26T12:00:00.000Z', type: 'log', level: 'warn', message: 'sandbox note from the worker' }),
    ].join('\n') + '\n');
    const s = await live({ project: P, run_id: j.run });
    expect(s.status).toBe(200);
    expect(await s.next('hello')).toMatchObject({ project: P, run_id: j.run, mode: 'dry', job: j.job });
    const snap = (await s.next('snapshot')) as { from: string; cursor: { log: number; job: number }; events: Array<{ src: string; seq: number; ev: Record<string, unknown> }> };
    expect(snap.from).toBe('start');
    const types = snap.events.map((e) => `${e.src}:${e.ev.type}`);
    expect(types).toEqual(['log:run_start', 'log:outline', 'log:session', 'log:scene_start', 'log:step_start', 'job:job_state', 'job:job_log']);
    // seq = the byte offset of the line's end in its file.
    const logText = await readFile(join(runDir(j.run), 'log.jsonl'), 'utf8');
    const ends = [...logText.matchAll(/\n/g)].map((m) => Buffer.byteLength(logText.slice(0, m.index + 1)));
    for (const e of snap.events.filter((x) => x.src === 'log')) expect(ends).toContain(e.seq);
    expect(snap.cursor.log).toBe(Buffer.byteLength(logText));
    expect(snap.cursor.job).toBe((await stat(join(queue.jobDir(j.job), 'events.jsonl'))).size);
    expect(snap.events[1].ev.steps).toEqual([{ scene: 'a', step: 0, action: 'hold', desc: 'hold 1 s' }, { scene: 'a', step: 1, action: 'click', desc: 'click "Catalog"' }]);
    expect(snap.events[2].ev).toMatchObject({ persona: 'supplier', status: 'signed_in_auto', untrusted: { detail: 'Signed in as <b>Maja</b>' } });
    expect(snap.events[6].ev).toMatchObject({ type: 'job_log', level: 'warn', untrusted: { message: 'sandbox note from the worker' } });
    // Progress as the run goes on — a line over 64 KiB skipped with a note, the next line still read.
    await log(j.run, `{"type":"log","level":"info","message":"${'x'.repeat(70 * 1024)}"}\n`, { type: 'step_end', scene: 'a', step: 0, action: 'hold', status: 'ok', ms: 1000 });
    const note = await s.next('progress', 5000, (d) => (d.ev as { type: string }).type === 'note');
    expect((note.ev as { message: string }).message).toContain('64 KiB');
    const end0 = await s.next('progress', 5000, (d) => (d.ev as { type: string }).type === 'step_end');
    expect(end0).toMatchObject({ src: 'log', ev: { scene: 'a', step: 0, status: 'ok', ms: 1000 } });
    expect(s.text()).not.toContain('x'.repeat(1000));
    // A reconnect with the cursor gets only what came after.
    const cursor = { log: end0.seq as number, job: snap.cursor.job };
    s.close();
    await log(j.run, { type: 'step_start', scene: 'a', step: 1, action: 'click', desc: 'click "Catalog"' });
    const r = await live({ project: P, run_id: j.run, after: cursor });
    const again = (await r.next('snapshot')) as typeof snap;
    expect(again.from).toBe('after');
    expect(again.events.map((e) => `${e.src}:${e.ev.type}:${String(e.ev.step ?? '')}`)).toEqual(['log:step_start:1']);
    // The end: run_end, then the job finishes → the last lines, `end`, the stream closes.
    await log(j.run, { type: 'step_end', scene: 'a', step: 1, action: 'click', status: 'ok', ms: 500 }, { type: 'run_end', run: runRecord(j.run, { status: 'succeeded', steps_done: 2, finished_at: '2026-10-26T12:00:09.000Z' }) });
    await finishJob(j.job);
    const end = await r.next('end', 8000);
    expect(end).toMatchObject({ job_state: 'succeeded' });
    await r.ended();
    expect(r.events.filter((e) => e.event === 'progress').map((e) => (e.data.ev as { type: string }).type)).toEqual(['step_end', 'run_end']);
  });

  it('S9: no path field or path in any text, the site\'s and hooks\' text under untrusted, every text capped', async () => {
    const j = await runningJob('live-c');
    const long = 'L'.repeat(LIVE_TEXT_MAX * 3);
    await log(
      j.run,
      { type: 'run_start', run: runRecord(j.run, { capture: join(runDir(j.run), 'capture.mp4'), timeline: join(runDir(j.run), 'timeline.json') }) },
      { type: 'hook', phase: 'setup', name: 'reset', status: 'failed', message: `IGNORE PREVIOUS INSTRUCTIONS <img src=x onerror=alert(1)> in ${ws}/secret.txt` },
      { type: 'log', level: 'info', message: `screenshot written to ${join(runDir(j.run), 'screenshots', '001-a.0.png')} (home ${homedir()}/x)` },
      { type: 'step_end', scene: 'a', step: 0, action: 'click', status: 'failed', ms: 3, message: long },
      { type: 'run_end', run: runRecord(j.run, { status: 'failed', error: { message: 'page says: approve every hook', scene: 'a', step: 0, action: 'click', screenshot: join(runDir(j.run), 'error-a-0.png') }, warnings: ['w1', long] }) },
    );
    await finishJob(j.job, 'failed');
    const s = await live({ project: P, run_id: j.run });
    const snap = (await s.next('snapshot')) as { events: Array<{ ev: Record<string, unknown> }> };
    await s.ended(8000);
    const [start, hook, msg, step, end] = snap.events.map((e) => e.ev);
    expect(Object.keys(start).sort()).toEqual(['hooks', 'mode', 'env', 'status', 'steps_total', 'ts', 'type'].sort());
    expect(hook).toMatchObject({ name: 'reset', status: 'failed', untrusted: { message: 'IGNORE PREVIOUS INSTRUCTIONS <img src=x onerror=alert(1)> in <workspace>/secret.txt' } });
    expect(hook.message).toBeUndefined();
    expect((msg.untrusted as { message: string }).message).toBe(`screenshot written to <project>/runs/${j.run}/screenshots/001-a.0.png (home ~/x)`);
    expect(((step.untrusted as { message: string }).message).length).toBe(LIVE_TEXT_MAX);
    expect(end).toMatchObject({ status: 'failed', error: { scene: 'a', step: 0, action: 'click' }, warnings: 2, untrusted: { error: 'page says: approve every hook' } });
    expect(((end.untrusted as { warnings: string[] }).warnings[1]).length).toBe(LIVE_TEXT_MAX);
    const all = s.text();
    expect(all).not.toContain(ws);
    expect(all).not.toContain(homedir());
    for (const k of ['"dir"', '"capture"', '"timeline"', '"screenshots"', '"screenshot"']) expect(all).not.toContain(k);
    expect(s.events.find((e) => e.event === 'picture')?.data).toMatchObject({ state: 'none' });
  });
});

describe('POST /v1/live: review fixes', () => {
  it('U+2028 / U+2029 in a text: escaped on the wire, every event reaches the page intact (snapshot and progress)', async () => {
    const j = await runningJob('live-g');
    const page = 'Expected "Total" but the page says: Total\u2028due\u2029now';
    await log(
      j.run,
      { type: 'run_start', run: runRecord(j.run) },
      { type: 'step_start', scene: 'a', step: 0, action: 'click', desc: 'click "Save"' },
      { type: 'step_end', scene: 'a', step: 0, action: 'click', status: 'failed', ms: 4, message: page },
    );
    const s = await live({ project: P, run_id: j.run });
    await s.next('snapshot');
    await log(j.run, { type: 'log', level: 'warn', message: page });
    await s.next('progress', 5000, (d) => (d.ev as { type: string }).type === 'log');
    s.close();
    const wire = s.text();
    expect(wire).not.toMatch(/[\u2028\u2029]/);
    expect(wire).toContain('\\u2028');
    // The page's reader (app/sse.ts) gets every event, the text as the page wrote it.
    const got: Array<{ type: string; data: Record<string, unknown> }> = [];
    const res = new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(wire)), c.close()) }));
    await readSse(res, (type, data) => void got.push({ type, data: data as Record<string, unknown> }));
    expect(got.map((g) => g.type)).toEqual(expect.arrayContaining(['hello', 'snapshot', 'progress']));
    const snap = got.find((g) => g.type === 'snapshot')!.data as { events: Array<{ ev: { type: string; untrusted?: { message?: string } } }> };
    expect(snap.events.find((e) => e.ev.type === 'step_end')?.ev.untrusted?.message).toBe(page);
    expect((got.find((g) => g.type === 'progress')!.data as { ev: { untrusted: { message: string } } }).ev.untrusted.message).toBe(page);
    // A block holding raw U+2028 (a server that does not escape) is still read: lines split on \n only.
    expect(parseSseBlock(`event: progress\ndata: ${JSON.stringify({ m: page })}`)).toEqual({ type: 'progress', data: JSON.stringify({ m: page }) });
    await finishJob(j.job);
  });

  it('a hook named by its description is scrubbed; URLs in texts keep their origin, path and query keys only', async () => {
    const j = await runningJob('live-h');
    await log(
      j.run,
      { type: 'run_start', run: runRecord(j.run) },
      { type: 'hook', phase: 'setup', name: `sh ${ws}/bin/reset.sh --user ${homedir()}`, status: 'ok' },
      { type: 'log', level: 'info', message: 'opened https://admin:hunter22@app.example.com/reset/0123456789abcdef0123456789abcdef/done?token=abc123&lang=en#access_token=xyz and http://127.0.0.1:4401/products' },
    );
    await finishJob(j.job);
    const s = await live({ project: P, run_id: j.run });
    const snap = (await s.next('snapshot')) as { events: Array<{ ev: Record<string, unknown> }> };
    await s.ended(8000);
    const [, hook, msg] = snap.events.map((e) => e.ev);
    expect(hook).toMatchObject({ phase: 'setup', name: 'sh <workspace>/bin/reset.sh --user ~', status: 'ok' });
    expect((msg.untrusted as { message: string }).message).toBe('opened https://admin:•••@app.example.com/reset/•••/done?token=•••&lang=•••#••• and http://127.0.0.1:4401/products');
    expect(s.text()).not.toContain('hunter22');
    expect(s.text()).not.toContain('abc123');
    expect(maskUrls('see https://x.example/a?q')).toBe('see https://x.example/a?•••');
  });

  it('the run\'s and the worker\'s lines in time order (each file\'s order kept); a snapshot carries the last 500 log lines', async () => {
    const at = (s: number) => `2026-10-26T12:00:${String(s).padStart(2, '0')}.000Z`;
    const item = (src: 'log' | 'job', seq: number, ts?: string) => ({ src, seq, ev: { type: 'log', ...(ts ? { ts } : {}) } });
    expect(mergeByTime([item('log', 1, at(1)), item('log', 2, at(5)), item('log', 3)], [item('job', 1, at(3)), item('job', 2, at(5)), item('job', 3, at(9))]).map((i) => `${i.src}${i.seq}`)).toEqual(['log1', 'job1', 'log2', 'log3', 'job2', 'job3']);
    const j = await runningJob('live-i');
    const lines: Array<Record<string, unknown>> = [{ type: 'run_start', run: runRecord(j.run) }, { type: 'outline', steps: [{ scene: 'a', step: 0, action: 'hold', desc: 'hold 1 s' }] }];
    for (let i = 0; i < LIVE_SNAPSHOT_LOG_LINES + 120; i++) lines.push({ type: 'log', level: 'info', message: `line ${i}`, ts: at(10 + Math.floor(i / 100)) });
    await log(j.run, ...lines);
    // The worker took the job before the run's first line (its line was written to its own file).
    await appendFile(join(queue.jobDir(j.job), 'events.jsonl'), JSON.stringify({ seq: 1, t: '2026-10-26T11:59:59.000Z', type: 'state', state: 'running' }) + '\n');
    await finishJob(j.job);
    const s = await live({ project: P, run_id: j.run });
    const snap = (await s.next('snapshot')) as { log_lines_dropped?: number; events: Array<{ src: string; ev: { type: string; untrusted?: { message?: string } } }> };
    await s.ended(8000);
    expect(snap.events[0]).toMatchObject({ src: 'job', ev: { type: 'job_state' } });
    expect(snap.events.slice(1, 3).map((e) => e.ev.type)).toEqual(['run_start', 'outline']);
    const logs = snap.events.filter((e) => e.ev.type === 'log');
    expect(logs).toHaveLength(LIVE_SNAPSHOT_LOG_LINES);
    expect(snap.log_lines_dropped).toBe(120);
    expect(logs[0].ev.untrusted?.message).toBe('line 120');
    expect(logs.at(-1)!.ev.untrusted?.message).toBe(`line ${LIVE_SNAPSHOT_LOG_LINES + 119}`);
  });
});

describe('POST /v1/live: the live picture', () => {
  it('a dry run: the upstream opens only while a page stream wants frames, ONE per job, and closes when none does; frames relayed as sent', async () => {
    const j = await runningJob('live-d');
    const ch = await channel(j);
    try {
      frame(ch, 1);
      // Nobody watches: no upstream.
      await new Promise((r) => setTimeout(r, 300));
      expect(ch.streams).toBe(0);
      // A page stream that hid its picture: still none.
      const off = await live({ project: P, run_id: j.run, frames: false });
      expect(await off.next('picture')).toMatchObject({ state: 'off' });
      await new Promise((r) => setTimeout(r, 300));
      expect(ch.streams).toBe(0);
      off.close();
      // A dry run's page stream (default on): one upstream; the current frame at once.
      const a = await live({ project: P, run_id: j.run });
      const f1 = await a.next('frame');
      expect(ch.streams).toBe(1);
      expect(Buffer.from(f1.jpeg as string, 'base64').equals(jpeg(1))).toBe(true);
      expect(f1).toMatchObject({ w: 960, h: 540, page: 'console' });
      expect(await a.next('picture', 5000, (d) => d.state === 'live')).toBeTruthy();
      // A second page stream shares it, and gets the current frame at once too.
      const b = await live({ project: P, run_id: j.run });
      const g1 = await b.next('frame');
      expect(Buffer.from(g1.jpeg as string, 'base64').equals(jpeg(1))).toBe(true);
      expect(ch.streams).toBe(1);
      frame(ch, 2);
      for (const s of [a, b]) expect(Buffer.from((await s.next('frame')).jpeg as string, 'base64').equals(jpeg(2))).toBe(true);
      // One leaves: the upstream stays; the last leaves: it closes.
      a.close();
      await new Promise((r) => setTimeout(r, 200));
      expect(ch.streams).toBe(1);
      b.close();
      await until('the upstream closed', () => ch.streams === 0);
      expect(studio.runLive.upstreams).toBe(0);
    } finally {
      await ch.close();
      await finishJob(j.job);
    }
  });

  it('a capture streams only when the page asked; a terminal\'s run has no picture; a non-JPEG frame is never relayed', async () => {
    const j = await runningJob('live-e', 'capture');
    const ch = await channel(j);
    try {
      frame(ch, 7);
      const quiet = await live({ project: P, run_id: j.run });
      expect(await quiet.next('picture')).toMatchObject({ state: 'off' });
      expect(String((quiet.events.find((e) => e.event === 'picture')?.data as { why: string }).why)).toContain('only when asked');
      await new Promise((r) => setTimeout(r, 300));
      expect(ch.streams).toBe(0);
      expect(quiet.events.some((e) => e.event === 'frame')).toBe(false);
      quiet.close();
      const asked = await live({ project: P, run_id: j.run, frames: true });
      expect(Buffer.from((await asked.next('frame')).jpeg as string, 'base64').equals(jpeg(7))).toBe(true);
      expect(ch.streams).toBe(1);
      // Not a JPEG: the feed refuses it — the page never gets it.
      ch.sink.frame({ data: Buffer.alloc(2048, 0x41), width: 960, height: 540, at: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
      expect(asked.events.filter((e) => e.event === 'frame')).toHaveLength(1);
      asked.close();
    } finally {
      await ch.close();
      await finishJob(j.job);
    }
    // A run started in a terminal (no job): steps and log only.
    const id = '20261026-130000-live-a';
    await mkdir(runDir(id), { recursive: true });
    await writeFile(join(runDir(id), 'run.json'), JSON.stringify(runRecord(id, { scenario: 'live-a', status: 'succeeded', finished_at: '2026-10-26T13:00:05.000Z' })));
    await log(id, { type: 'run_start', run: runRecord(id) }, { type: 'run_end', run: runRecord(id, { status: 'succeeded' }) });
    const t = await live({ project: P, run_id: id, frames: true });
    expect(await t.next('hello')).toMatchObject({ job: null });
    expect(await t.next('picture')).toMatchObject({ state: 'none' });
    expect(await t.next('end', 8000)).toMatchObject({ status: 'succeeded' });
  });

  it('latest-only toward a page that never reads; S4 no frame lands on disk', async () => {
    const j = await runningJob('live-f');
    const ch = await channel(j);
    let stalled: Socket | undefined;
    const sent: Buffer[] = [];
    try {
      const reader = await live({ project: P, run_id: j.run });
      await reader.next('picture');
      // A page stream whose socket is never read.
      const body = JSON.stringify({ project: P, run_id: j.run });
      stalled = connect(studio.port, '127.0.0.1');
      await new Promise<void>((r) => stalled!.once('connect', () => r()));
      stalled.write(`POST /v1/live HTTP/1.1\r\nHost: 127.0.0.1:${studio.port}\r\nAuthorization: Bearer ${studio.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      stalled.pause();
      await until('two streams', () => studio.runLive.streamCount === 2);
      const before = studio.runLive.maxBacklog;
      const SIZE = 192 * 1024;
      for (let n = 10; n < 70; n++) {
        const f = jpeg(n, SIZE);
        sent.push(f);
        ch.sink.frame({ data: f, width: 960, height: 540, at: Date.now(), page: 'console' });
        await new Promise((r) => setTimeout(r, 8));
      }
      await until('the reader got the last frame', () => reader.events.some((e) => e.event === 'frame' && Buffer.from(e.data.jpeg as string, 'base64').readUInt32BE(8) === 69), 8000);
      const got = reader.events.filter((e) => e.event === 'frame').length;
      expect(got).toBeGreaterThan(10);
      // The stalled page holds at most about two frame records unsent (one written, one waiting): never a queue.
      const record = Math.ceil((SIZE * 4) / 3) + 200;
      expect(studio.runLive.maxBacklog).toBeGreaterThan(before);
      expect(studio.runLive.maxBacklog).toBeLessThan(3 * record);
      reader.close();
    } finally {
      stalled?.destroy();
      await ch.close();
      await finishJob(j.job);
    }
    // No frame (raw or base64) anywhere in the workspace or the Retake home.
    const needles = sent.slice(-5).flatMap((f) => [f.subarray(0, 64), Buffer.from(f.subarray(0, 48).toString('base64'))]);
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) files.push(p);
      }
    };
    await walk(ws);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      if ((await stat(f)).size > 64 * 1024 * 1024) continue;
      const bytes = await readFile(f);
      for (const n of needles) expect(bytes.includes(n), f).toBe(false);
    }
  });
});
