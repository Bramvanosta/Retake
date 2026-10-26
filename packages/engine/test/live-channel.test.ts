/**
 * L4.4: the live channel of a running `run` job (jobs/live-channel.ts) — the worker's loopback listener the live picture
 * leaves through. Its gate (S1: Host, any browser header, the token, route / method, at most 2 streams), live.json (S2:
 * created 0600, removed at the end, trusted only as a private regular file naming this job and the live worker holding
 * its claim), latest-only backpressure (S10: a reader that never reads holds one record at most) and the frame cache
 * (a new stream gets the current picture at once). No browser: frames are handed to the sink by the test. Review A:
 * idle connections never lock the Studio out (closed after LIVE_IDLE_MS; the oldest makes room for a newcomer, a stream
 * never does), and live.json is read without following a link (the open descriptor checked).
 */
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, LIVE_IDLE_MS, LIVE_PATH, LIVE_SOCKETS_MAX, LIVE_STREAMS_MAX, newJobId, openLiveChannel, openLiveFeed, readLiveChannel, selfIdentity } from '../src/index.js';
import type { LiveChannel, LiveFeedFrame } from '../src/index.js';

let root: string;
let queue: FileJobQueue;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-live-'));
  queue = new FileJobQueue(root);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A job folder claimed by this process (as the worker running it). */
async function claimedJob(): Promise<string> {
  const id = newJobId();
  await mkdir(queue.jobDir(id), { recursive: true });
  expect(await queue.claim(id, await selfIdentity())).toBe(true);
  return id;
}

/** A JPEG-looking frame of `size` bytes whose bytes say which frame it is. */
function jpeg(n: number, size = 2048): Buffer {
  const b = Buffer.alloc(size, n % 251);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  return b;
}

function frame(ch: LiveChannel, n: number, size?: number): void {
  ch.sink.frame({ data: jpeg(n, size), width: 960, height: 540, at: Date.now(), page: 'console' });
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request with exactly these headers (no fetch defaults); the body read for a refusal, the stream left open otherwise. */
function send(port: number, o: { method?: string; path?: string; headers?: OutgoingHttpHeaders }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? LIVE_PATH, headers: { host: `127.0.0.1:${port}`, ...o.headers }, agent: false }, (res) => {
      if (res.statusCode === 200) {
        res.destroy();
        resolve({ status: 200, headers: res.headers, body: '' });
        return;
      }
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const until = async (what: string, fn: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the live channel of a run job', () => {
  it('S2: live.json is created 0600, names the job, its run and the claiming worker; removed when the channel closes', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: '20261026-120000-quote', worker: await selfIdentity() });
    try {
      const file = queue.liveFile(id);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const info = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(info).toMatchObject({ v: 1, port: ch.port, job: id, run: '20261026-120000-quote', pid: process.pid });
      expect(info.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // No temporary file left beside it.
      expect((await readdir(queue.jobDir(id))).sort()).toEqual(['claim', 'live.json']);
      expect((await readLiveChannel(queue, id))?.port).toBe(ch.port);
    } finally {
      await ch.close();
    }
    expect(existsSync(queue.liveFile(id))).toBe(false);
    expect(await readLiveChannel(queue, id)).toBeNull();
  });

  it('S1: the gate — wrong Host 421, any Origin or Sec-Fetch-* header 403, no or a wrong token 401, another route 404 / method 405; nothing streams', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: 'r1', worker: await selfIdentity() });
    try {
      const info = (await readLiveChannel(queue, id))!;
      const auth = { authorization: `Bearer ${info.token}` };
      const p = ch.port;
      expect((await send(p, { headers: { ...auth, host: `evil.example:${p}` } })).status).toBe(421);
      expect((await send(p, { headers: { ...auth, host: `127.0.0.1:${p + 1}` } })).status).toBe(421);
      // A browser's request, even from this very origin: refused (no page may reach the channel).
      expect((await send(p, { headers: { ...auth, origin: `http://127.0.0.1:${p}` } })).status).toBe(403);
      expect((await send(p, { headers: { ...auth, 'sec-fetch-site': 'same-origin' } })).status).toBe(403);
      expect((await send(p, { headers: { ...auth, 'sec-fetch-dest': 'image' } })).status).toBe(403);
      expect((await send(p, {})).status).toBe(401);
      expect((await send(p, { headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status).toBe(401);
      expect((await send(p, { headers: auth, path: '/v1/input' })).status).toBe(404);
      const post = await send(p, { headers: auth, method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers['access-control-allow-origin']).toBeUndefined();
      expect(ch.streams).toBe(0);
      expect(ch.sink.wanted).toBe(false);
      // The valid request streams (Node's fetch sends Sec-Fetch-Mode: cors alone: accepted).
      expect((await send(p, { headers: { ...auth, 'sec-fetch-mode': 'cors' } })).status).toBe(200);
    } finally {
      await ch.close();
    }
  });

  it('S1: at most 2 streams (503 beyond); wanted while one is open; a new stream gets the latest frame at once', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: 'r2', worker: await selfIdentity() });
    const ac = new AbortController();
    try {
      const info = (await readLiveChannel(queue, id))!;
      const changes: boolean[] = [];
      ch.sink.onWanted((w) => changes.push(w));
      frame(ch, 1);
      frame(ch, 2);
      const got: LiveFeedFrame[][] = [[], []];
      const feeds = [0, 1].map((i) => openLiveFeed(info, { signal: ac.signal, onFrame: (f) => got[i].push(f) }));
      await until('two streams', () => ch.streams === 2);
      expect(ch.sink.wanted).toBe(true);
      expect(changes[0]).toBe(true);
      // The cache: each new stream got frame 2 (the latest), not frame 1.
      await until('the cached frame', () => got[0].length === 1 && got[1].length === 1);
      for (const g of got) expect(g[0].data.equals(jpeg(2))).toBe(true);
      expect(LIVE_STREAMS_MAX).toBe(2);
      const third = await send(ch.port, { headers: { authorization: `Bearer ${info.token}` } });
      expect(third.status).toBe(503);
      expect(JSON.parse(third.body).error.code).toBe('too_many_streams');
      frame(ch, 3);
      await until('frame 3 on both streams', () => got.every((g) => g.length === 2));
      expect(got[0][1].header).toMatchObject({ v: 1, kind: 'frame', page: 'console', w: 960, h: 540 });
      expect(got[0][1].header.seq).toBeGreaterThan(got[0][0].header.seq);
      ac.abort();
      await Promise.all(feeds);
      await until('no stream', () => ch.streams === 0);
      expect(ch.sink.wanted).toBe(false);
      expect(changes.at(-1)).toBe(false);
    } finally {
      ac.abort();
      await ch.close();
    }
  });

  it('S1: idle sockets never lock the channel: a valid feed connects at once past 8 of them; they close by themselves; a stream is never dropped for a newcomer', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: 'r6', worker: await selfIdentity() });
    const ac = new AbortController();
    const socks: Socket[] = [];
    let closed = 0;
    const idle = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const sock = connect(ch.port, '127.0.0.1');
        sock.on('error', () => undefined);
        sock.on('close', () => closed++);
        await new Promise<void>((r) => sock.once('connect', () => r()));
        socks.push(sock);
      }
    };
    try {
      const info = (await readLiveChannel(queue, id))!;
      await idle(LIVE_SOCKETS_MAX);
      await new Promise((r) => setTimeout(r, 100));
      frame(ch, 1);
      const got: LiveFeedFrame[] = [];
      const t0 = Date.now();
      const feed = openLiveFeed(info, { signal: ac.signal, onFrame: (f) => got.push(f) });
      await until('the cached frame', () => got.length === 1, 3000);
      // Room was made at once — not when the idle sockets time out.
      expect(Date.now() - t0).toBeLessThan(LIVE_IDLE_MS / 2);
      // The idle sockets the server did not close to make room close by themselves.
      await until('every idle socket closed', () => closed === LIVE_SOCKETS_MAX, LIVE_IDLE_MS + 3000);
      // As many idle sockets again: the stream stays and still gets frames.
      await idle(LIVE_SOCKETS_MAX);
      frame(ch, 2);
      await until('frame 2 on the stream', () => got.length === 2, 3000);
      expect(got[1].data.equals(jpeg(2))).toBe(true);
      expect(ch.streams).toBe(1);
      ac.abort();
      await feed;
    } finally {
      ac.abort();
      for (const sock of socks) sock.destroy();
      await ch.close();
    }
  });

  it('S10: a reader that never reads holds one waiting frame at most (latest-only), whatever the run sends', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: 'r3', worker: await selfIdentity() });
    let sock: Socket | undefined;
    try {
      const info = (await readLiveChannel(queue, id))!;
      sock = connect(ch.port, '127.0.0.1');
      await new Promise<void>((r) => sock!.once('connect', () => r()));
      sock.write(`GET ${LIVE_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${ch.port}\r\nAuthorization: Bearer ${info.token}\r\n\r\n`);
      sock.pause(); // never reads
      await until('the stream', () => ch.streams === 1);
      const size = 64 * 1024;
      for (let n = 0; n < 300; n++) {
        frame(ch, n, size);
        if (n % 10 === 0) await new Promise((r) => setTimeout(r, 2));
      }
      await new Promise((r) => setTimeout(r, 100));
      // One record in Node's buffer beyond its high-water mark (16 KiB), never a queue of them (300 × 64 KiB).
      expect(ch.maxBacklog).toBeGreaterThan(0);
      expect(ch.maxBacklog).toBeLessThanOrEqual(2 * size + 16 * 1024);
    } finally {
      sock?.destroy();
      await ch.close();
    }
  });

  it('S2: live.json is not trusted unless private, a regular file, of this job, and its worker holds the claim and lives', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: 'r4', worker: await selfIdentity() });
    const file = queue.liveFile(id);
    try {
      const good = await readFile(file, 'utf8');
      expect(await readLiveChannel(queue, id)).not.toBeNull();
      // Group / other bits.
      await chmod(file, 0o644);
      expect(await readLiveChannel(queue, id)).toBeNull();
      await chmod(file, 0o600);
      expect(await readLiveChannel(queue, id)).not.toBeNull();
      // Another job's live.json copied here.
      const other = await claimedJob();
      await writeFile(queue.liveFile(other), good, { mode: 0o600 });
      expect(await readLiveChannel(queue, other)).toBeNull();
      // A link to a private file that would be trusted as live.json itself (this job's, the claiming worker's): the
      // link alone refuses it (opened without following it — no window between a check and the read).
      const linked = await claimedJob();
      const target = join(root, `link-target-${id}.json`);
      await writeFile(target, JSON.stringify({ ...JSON.parse(good), job: linked }), { mode: 0o600 });
      await rename(target, queue.liveFile(linked));
      expect(await readLiveChannel(queue, linked)).not.toBeNull();
      await rename(queue.liveFile(linked), target);
      await symlink(target, queue.liveFile(linked));
      expect(await readLiveChannel(queue, linked)).toBeNull();
      // A worker that does not hold the claim (another pid in live.json).
      const forged = await claimedJob();
      await writeFile(queue.liveFile(forged), JSON.stringify({ ...JSON.parse(good), job: forged, pid: process.pid + 1 }), { mode: 0o600 });
      expect(await readLiveChannel(queue, forged)).toBeNull();
      // The claim's worker is gone (a pid that exited): a stale file of a killed worker.
      const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;
      const stale = newJobId();
      await mkdir(queue.jobDir(stale), { recursive: true });
      await writeFile(join(queue.jobDir(stale), 'claim'), JSON.stringify({ pid: dead, at: new Date().toISOString() }));
      await writeFile(queue.liveFile(stale), JSON.stringify({ ...JSON.parse(good), job: stale, pid: dead, started_at: undefined }), { mode: 0o600 });
      expect(await readLiveChannel(queue, stale)).toBeNull();
      // Garbage.
      await writeFile(file, '{"v":1,', { mode: 0o600 });
      expect(await readLiveChannel(queue, id)).toBeNull();
    } finally {
      await ch.close();
    }
  });

  it('the feed checks every record: a frame that is not a JPEG ends it', async () => {
    const id = await claimedJob();
    const ch = await openLiveChannel({ queue, jobId: id, runId: 'r5', worker: await selfIdentity() });
    try {
      const info = (await readLiveChannel(queue, id))!;
      const got: LiveFeedFrame[] = [];
      const feed = openLiveFeed(info, { onFrame: (f) => got.push(f) });
      await until('the stream', () => ch.streams === 1);
      frame(ch, 7);
      await until('the frame', () => got.length === 1);
      ch.sink.frame({ data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), width: 10, height: 10, at: Date.now() });
      await expect(feed).rejects.toThrow(/not a JPEG/);
      expect(got).toHaveLength(1);
    } finally {
      await ch.close();
    }
  });
});
