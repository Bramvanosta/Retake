/**
 * The live channel of a running `run` job (L4.4, R-UI-16): how the live picture (runner-web live-preview.ts) leaves the
 * worker for the Studio server — another process, often not started by the Studio (an MCP-started worker serves Studio
 * jobs too), so neither stdio nor IPC.
 *
 * Worker side (`openLiveChannel`): a loopback HTTP listener per running `run` job — engine `listenLoopback` (127.0.0.1,
 * a free port) behind engine `checkRequest` with `refuseBrowsers` (Host must be its own `127.0.0.1:<port>` or
 * `localhost:<port>`, any Origin or Sec-Fetch-* header refused, a fresh 32-byte bearer token compared in constant time),
 * one route `GET /v1/frames`, at most LIVE_STREAMS_MAX streams (503 beyond) and LIVE_SOCKETS_MAX sockets — a socket
 * that holds no stream is closed after LIVE_IDLE_MS, and the oldest of them makes room for a new one when all are taken
 * (idle connections never lock the Studio out; a stream is never dropped for a newcomer). The port and
 * token are in `<job>/live.json`, created 0600 from the start (never a wider window), written and removed by the
 * claiming worker only, with that worker's identity (pid + start time).
 *
 * Wire format (versioned; `kind` leaves room for other records — an input channel would be a separate authenticated
 * route, not built): a binary stream of records `u32 header length · JSON header {v, kind: 'frame', seq, page?, w, h,
 * at} · u32 byte length · JPEG`. Backpressure is latest-only per stream: a record is written only when the socket needs
 * no drain, else it replaces the one waiting record — a slow reader never makes a queue grow. The worker keeps one frame
 * cache, the latest record, so a new stream gets the current picture at once (a still page sends no new frame); it is
 * dropped when the job ends. Frames live in memory only: nothing here writes, logs or records one.
 *
 * Studio side (`readLiveChannel`, `openLiveFeed`): live.json is trusted only as a private regular file of this user
 * naming this job and the identity of the worker holding the job's claim, alive; the feed checks every record (sizes,
 * JPEG signature) before handing it on.
 */
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { RUN_ID_RE } from '../refs.js';
import { readPlainRange } from '../run-files.js';
import type { LiveFrame, LiveSink } from '@retake/runner-web';
import { checkRequest } from '../http/gate.js';
import type { RouteSpec } from '../http/gate.js';
import { LOOPBACK, listenLoopback } from '../http/listen.js';
import { newSecret } from '../http/token.js';
import { isAlive } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import type { FileJobQueue } from './queue.js';

export const LIVE_FILE_VERSION = 1;
export const LIVE_PATH = '/v1/frames';
/** Frame streams one job's channel serves at once (the Studio opens one per job; a second Studio, a test). */
export const LIVE_STREAMS_MAX = 2;
/** Sockets one channel keeps open at once (streams, and refused requests on keep-alive). */
export const LIVE_SOCKETS_MAX = 8;
/** A socket that holds no frame stream is closed after this long (ms): a request comes at once or not at all. */
export const LIVE_IDLE_MS = 2000;
/** A frame's JPEG, at most (a 960 px q60 frame is ≈ 40–60 KB). */
export const LIVE_FRAME_MAX_BYTES = 512 * 1024;
/** A record header, at most. */
const HEADER_MAX = 4096;
const LIVE_FILE_MAX = 4096;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,512}$/;
const ROUTE: RouteSpec = { methods: ['GET'], token: true, api: true };

/** <job>/live.json */
export interface LiveChannelInfo {
  v: typeof LIVE_FILE_VERSION;
  port: number;
  token: string;
  job: string;
  run: string;
  /** The worker holding the job's claim. */
  pid: number;
  started_at?: string;
}

/** A record header. */
export interface LiveFrameHeader {
  v: 1;
  kind: 'frame';
  seq: number;
  page?: string;
  w: number;
  h: number;
  /** Wall time the runner handed the frame on (epoch ms). */
  at: number;
}

export interface LiveChannel {
  /** Give it to the run (runner-web RunOptions.live). */
  readonly sink: LiveSink;
  readonly port: number;
  /** Frame streams open now. */
  readonly streams: number;
  /** The largest number of bytes one stream's socket held unsent so far (tests: latest-only backpressure). */
  readonly maxBacklog: number;
  /** Stop listening, end the streams, drop the frame cache, remove live.json. */
  close(): Promise<void>;
}

/** One record: u32 header length · header · u32 byte length · bytes. */
export function encodeRecord(header: LiveFrameHeader, data: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(8 + h.length + data.length);
  out.writeUInt32BE(h.length, 0);
  h.copy(out, 4);
  out.writeUInt32BE(data.length, 4 + h.length);
  data.copy(out, 8 + h.length);
  return out;
}

/** A frame stream: latest-only (one waiting record at most). */
class Stream {
  private waiting: Buffer | null = null;

  constructor(
    readonly res: ServerResponse,
    private readonly backlog: (n: number) => void,
  ) {
    res.on('drain', () => {
      const w = this.waiting;
      this.waiting = null;
      if (w) this.send(w);
    });
  }

  send(rec: Buffer): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    if (this.res.writableNeedDrain) {
      this.waiting = rec;
      return;
    }
    this.res.write(rec);
    this.backlog(this.res.writableLength);
  }
}

function answer(res: ServerResponse, status: number, code: string, message: string, allow?: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(allow ? { allow } : {}) });
  res.end(JSON.stringify({ error: { code, message } }));
}

/** live.json, created 0600 from the start (a temporary file renamed into place). */
async function writePrivate(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Open the live channel of a running `run` job (the claiming worker only): the listener, then live.json. Frames the
 * sink receives go to the open streams; `wanted` is true while a stream is open.
 */
export async function openLiveChannel(o: { queue: FileJobQueue; jobId: string; runId: string; worker: ProcessIdentity }): Promise<LiveChannel> {
  if (!RUN_ID_RE.test(o.runId) || o.runId.length > 200) throw new Error(`invalid run id "${o.runId}"`);
  const file = o.queue.liveFile(o.jobId);
  const token = newSecret();
  const streams = new Set<Stream>();
  const sockets = new Set<Socket>();
  /** The sockets that carry a frame stream (never closed to make room). */
  const streaming = new Set<Socket>();
  const listeners = new Set<(wanted: boolean) => void>();
  let latest: Buffer | null = null;
  let seq = 0;
  let maxBacklog = 0;
  let closed = false;
  let port = 0;
  const notify = () => {
    const wanted = streams.size > 0 && !closed;
    for (const fn of [...listeners]) {
      try {
        fn(wanted);
      } catch {
        /* a listener error must not break the channel */
      }
    }
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const g = checkRequest(req, { port, token, route: (p) => (p === LIVE_PATH ? ROUTE : undefined), refuseBrowsers: true });
    if (!g.ok) return answer(res, g.status, g.code, g.message, g.allow);
    if (closed) return answer(res, 410, 'gone', 'the run ended');
    if (streams.size >= LIVE_STREAMS_MAX) return answer(res, 503, 'too_many_streams', `at most ${LIVE_STREAMS_MAX} live streams per run`);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.flushHeaders();
    const stream = new Stream(res, (n) => (maxBacklog = Math.max(maxBacklog, n)));
    streams.add(stream);
    streaming.add(req.socket);
    const gone = () => {
      streaming.delete(req.socket);
      if (streams.delete(stream)) notify();
    };
    res.on('close', gone);
    req.on('close', gone);
    if (latest) stream.send(latest);
    if (streams.size === 1) notify();
  });
  server.on('connection', (socket: Socket) => {
    if (sockets.size >= LIVE_SOCKETS_MAX) {
      // Room for the newcomer: the oldest socket without a stream goes (idle, refused, or still sending its request).
      const idle = [...sockets].find((x) => !streaming.has(x));
      if (!idle) {
        socket.destroy();
        return;
      }
      sockets.delete(idle);
      idle.destroy();
    }
    sockets.add(socket);
    const idleTimer = setTimeout(() => {
      if (!streaming.has(socket)) socket.destroy();
    }, LIVE_IDLE_MS);
    idleTimer.unref();
    socket.on('close', () => {
      clearTimeout(idleTimer);
      sockets.delete(socket);
      streaming.delete(socket);
    });
  });
  port = await listenLoopback(server, 0);
  const info: LiveChannelInfo = { v: LIVE_FILE_VERSION, port, token, job: o.jobId, run: o.runId, pid: o.worker.pid, ...(o.worker.started_at ? { started_at: o.worker.started_at } : {}) };
  try {
    await writePrivate(file, JSON.stringify(info) + '\n');
  } catch (e) {
    server.close();
    throw e;
  }
  const sink: LiveSink = {
    get wanted() {
      return streams.size > 0 && !closed;
    },
    onWanted(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    frame(f: LiveFrame) {
      if (closed || f.data.length === 0 || f.data.length > LIVE_FRAME_MAX_BYTES) return;
      const rec = encodeRecord({ v: 1, kind: 'frame', seq: ++seq, ...(f.page !== undefined ? { page: f.page } : {}), w: f.width, h: f.height, at: Math.round(f.at) }, f.data);
      latest = rec;
      for (const s of streams) s.send(rec);
    },
  };
  return {
    sink,
    port,
    get streams() {
      return streams.size;
    },
    get maxBacklog() {
      return maxBacklog;
    },
    async close() {
      if (closed) return;
      closed = true;
      latest = null;
      await rm(file, { force: true }).catch(() => undefined);
      for (const s of streams) s.res.end();
      streams.clear();
      notify();
      listeners.clear();
      await new Promise<void>((r) => {
        server.close(() => r());
        for (const sock of sockets) sock.destroy();
      });
    },
  };
}

/**
 * The live channel of a running job, as the Studio server may trust it: live.json a regular file of this user with no
 * group or other permission bits, of bounded size, naming this job, a valid port and token, and the identity of the
 * worker that holds the job's claim — that worker alive (pid and start time). Null otherwise (no picture).
 */
export async function readLiveChannel(queue: FileJobQueue, jobId: string): Promise<LiveChannelInfo | null> {
  const file = queue.liveFile(jobId);
  // Opened without following a link and checked on the open descriptor (no window between the check and the read).
  const uid = process.getuid?.();
  const r = readPlainRange(file, 0, LIVE_FILE_MAX, { verify: (st) => (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0 && st.size <= LIVE_FILE_MAX });
  if (!r.ok) return null;
  const text = r.bytes.toString('utf8');
  let v: Partial<LiveChannelInfo>;
  try {
    v = JSON.parse(text) as Partial<LiveChannelInfo>;
  } catch {
    return null;
  }
  if (
    !v ||
    typeof v !== 'object' ||
    v.v !== LIVE_FILE_VERSION ||
    v.job !== jobId ||
    typeof v.run !== 'string' ||
    !RUN_ID_RE.test(v.run) ||
    v.run.length > 200 ||
    !Number.isInteger(v.port) ||
    (v.port as number) < 1 ||
    (v.port as number) > 65535 ||
    typeof v.token !== 'string' ||
    !TOKEN_RE.test(v.token) ||
    !Number.isInteger(v.pid) ||
    (v.started_at !== undefined && typeof v.started_at !== 'string')
  ) {
    return null;
  }
  const claim = await queue.claimOf(jobId).catch(() => undefined);
  if (!claim || claim.pid !== v.pid || (claim.started_at ?? null) !== (v.started_at ?? null)) return null;
  if (!(await isAlive(claim).catch(() => false))) return null;
  return { v: LIVE_FILE_VERSION, port: v.port as number, token: v.token, job: jobId, run: v.run, pid: v.pid as number, ...(v.started_at ? { started_at: v.started_at } : {}) };
}

export interface LiveFeedFrame {
  header: LiveFrameHeader;
  /** JPEG bytes (signature checked). */
  data: Buffer;
}

/**
 * Read a job's frame stream (the Studio server's upstream): every record checked — header ≤ 4 KiB of JSON with the
 * expected fields, a JPEG of at most LIVE_FRAME_MAX_BYTES starting `FF D8 FF`, w / h ≤ 4096 — anything else ends the
 * feed. Resolves when the stream ends (the run ended, `signal` aborted); rejects on a refused request or a bad record.
 */
export function openLiveFeed(info: Pick<LiveChannelInfo, 'port' | 'token'>, o: { onFrame(f: LiveFeedFrame): void; signal?: AbortSignal }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = request({ host: LOOPBACK, port: info.port, path: LIVE_PATH, method: 'GET', headers: { authorization: `Bearer ${info.token}` }, signal: o.signal }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`live channel answered ${res.statusCode}`));
        return;
      }
      let buf: Buffer = Buffer.alloc(0);
      const fail = (why: string) => {
        res.destroy();
        reject(new Error(`live channel: ${why}`));
      };
      res.on('data', (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          if (buf.length < 4) return;
          const hl = buf.readUInt32BE(0);
          if (hl === 0 || hl > HEADER_MAX) return fail('record header too large');
          if (buf.length < 8 + hl) return;
          const bl = buf.readUInt32BE(4 + hl);
          if (bl === 0 || bl > LIVE_FRAME_MAX_BYTES) return fail('frame too large');
          if (buf.length < 8 + hl + bl) return;
          let header: LiveFrameHeader;
          try {
            header = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8')) as LiveFrameHeader;
          } catch {
            return fail('bad record header');
          }
          const data = Buffer.from(buf.subarray(8 + hl, 8 + hl + bl));
          buf = buf.subarray(8 + hl + bl);
          const okHeader =
            header?.v === 1 &&
            header.kind === 'frame' &&
            Number.isInteger(header.seq) &&
            Number.isInteger(header.w) &&
            Number.isInteger(header.h) &&
            header.w > 0 &&
            header.h > 0 &&
            header.w <= 4096 &&
            header.h <= 4096 &&
            typeof header.at === 'number' &&
            (header.page === undefined || (typeof header.page === 'string' && header.page.length <= 200));
          if (!okHeader) return fail('bad record header');
          if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return fail('not a JPEG');
          try {
            o.onFrame({ header, data });
          } catch {
            /* a consumer error must not end the feed */
          }
        }
      });
      res.on('end', () => resolve());
      res.on('error', (e) => (o.signal?.aborted ? resolve() : reject(e)));
      res.on('close', () => resolve());
    });
    req.on('error', (e) => (o.signal?.aborted ? resolve() : reject(e)));
    req.end();
  });
}
