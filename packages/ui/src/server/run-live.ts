/**
 * The Run screen's stream (R-UI-16 – R-UI-18): `POST /v1/live {project, run_id, after?, frames?}` — server-sent
 * events read by the page through `fetch` (the token in a header, the run in the JSON body: no id in a URL or a log),
 * behind the same gate as every route. One stream follows one run:
 *
 * - **Steps and log** come from the run's own `log.jsonl` (every progress event, redacted by the runner — a job's run
 *   and a terminal's `retake run` alike) and, for a job's run, the worker's notes of its `events.jsonl` — tailed while
 *   the stream is open and never otherwise: a stat-and-read every RUN_LIVE_POLL_MS from byte offsets, through the
 *   run-file rules (RunFolder: no link followed, no FIFO held, checked once open), at most LIVE_READ_CHUNK
 *   bytes per read, a line longer than LIVE_LINE_MAX skipped with a note (never a buffer without a bound). An event's
 *   `seq` is the byte offset of its line's end in its file; `after: {log, job}` resumes after a reconnect without a
 *   duplicate. On connect: one `snapshot` (the events since `after`, else since the start — at most the last
 *   LIVE_TAIL_MAX bytes of a long log, said so — with the log lines cut to the last LIVE_SNAPSHOT_LOG_LINES), then
 *   `progress` events, `job` (its state, a pause or a stop asked) on change, and `end` once the run and its job ended.
 * - **Events are a view**, never raw RunProgress: every field type-checked (the files are data an agent could have
 *   written), unknown events dropped, no path field (a RunRecord's `dir`, outputs, screenshots), every text capped at
 *   LIVE_TEXT_MAX characters with the workspace and home folders replaced (`<workspace>`, `~`), the filmed site's and
 *   the hooks' text (step and log messages, session details, hook messages, errors, warnings) under `untrusted`: the
 *   page renders it as text, never as a link or HTML.
 * - **The live picture** of a job's run: frames from the worker's live channel (engine live-channel.ts) — ONE upstream
 *   per job whatever the number of page streams (the worker serves 2), opened only while a page stream wants frames
 *   and closed when none does (a hidden tab drops its stream, the picture toggled off reopens it with `frames: false`);
 *   a capture's stream carries frames only when the page asked for them (`frames: true`: the picture costs Chromium CPU
 *   during a take), a dry run's unless it said `frames: false`. Latest-only on this hop too: a frame is written only
 *   when the page's socket needs no drain, else it replaces the one waiting frame. Frames live in memory only (the
 *   upstream's current frame, dropped when it closes): never written, logged or put in an event file; `event: frame`
 *   carries the JPEG as base64 for a canvas (createImageBitmap — no CSP change, no `src=`). `picture` events say what
 *   the picture is doing: off, none (a terminal's run, or ended), waiting, live, busy (the worker serves no more).
 * - At most RUN_LIVE_STREAMS_MAX streams (with the event stream and calls, below a browser's 6 connections per host); a
 *   third gets 503 `too_many_streams`. A stream is never an op: the op counter does not move.
 *
 * Nothing here logs a token, a body, a frame or a line of the files it reads.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { zRunId } from '@retake/core/ids';
import { PROJECT_SLUG_RE } from '@retake/core/project';
import { ERROR_STATUS, FINISHED_JOB_STATES, RunFolder, openProjectBySlug, securityHeaders } from '@retake/engine/shell';
import { EngineError, toEngineError } from '@retake/engine';
import type { Engine, JobQueueView, RangeRead, OpenedWorkspace } from '@retake/engine';
import { sseText } from './live.js';
import { JsonlTail, LIVE_TAIL_MAX } from './jsonl-tail.js';
import { maskUrls } from './run-live-view.js';
import type { LiveItem, Scrub } from './run-live-view.js';
import { FrameFeed, RunStream } from './run-stream.js';
import type { PictureState } from './run-stream.js';

export { JsonlTail, LIVE_LINE_MAX, LIVE_READ_CHUNK, LIVE_TAIL_MAX } from './jsonl-tail.js';
export { LIVE_OUTLINE_MAX, URL_MASK, maskUrls, mergeByTime, viewJobEvent, viewProgress } from './run-live-view.js';
export type { LiveItem, Scrub } from './run-live-view.js';
export type { PictureState } from './run-stream.js';

const sse = sseText;

/** Run streams served at once, at most. */
export const RUN_LIVE_STREAMS_MAX = 2;
/** How often an open stream reads the run's files (ms). */
export const RUN_LIVE_POLL_MS = 300;
/** Log lines a snapshot carries, at most (the newest). */
export const LIVE_SNAPSHOT_LOG_LINES = 500;
/** A text field of an event, at most (characters). */
export const LIVE_TEXT_MAX = 2000;
/** A comment line on every run stream this often (ms). */
const KEEPALIVE_MS = 15_000;

const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug, never a path');
const runId = zRunId('a run id, never a path');
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The body of `POST /v1/live`. */
export const RunLiveInput = z.strictObject({
  project,
  run_id: runId,
  /** The last `seq` of each source the page holds (a reconnect): the snapshot then carries only what came after. */
  after: z.strictObject({ log: offset, job: offset.optional() }).optional(),
  /** The live picture: default on for a dry run, off for a capture (the page asks for it with true). */
  frames: z.boolean().optional(),
});

/** A scrubber that hides these folders (longest first) and caps the text. */
export function scrubber(folders: Array<{ path: string; as: string }>, max = LIVE_TEXT_MAX): Scrub {
  const pairs: Array<[RegExp, string, number]> = [];
  for (const f of folders) {
    const forms = new Set([f.path]);
    try {
      forms.add(realpathSync(f.path));
    } catch {
      /* a folder that does not resolve keeps its given form */
    }
    for (const form of forms) {
      const p = form.endsWith('/') ? form.slice(0, -1) : form;
      // The folder itself or a path under it — never a longer name that starts the same (/Users/a vs /Users/ab).
      if (p) pairs.push([new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'g'), f.as, p.length]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);
  return (text) => {
    let s = text.length > max * 4 ? text.slice(0, max * 4) : text;
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    for (const [re, as] of pairs) s = s.replace(re, as);
    s = maskUrls(s);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
}

export interface RunLiveOptions {
  engine: Engine;
  ws: OpenedWorkspace;
  pollMs?: number;
  log?: (message: string) => void;
}

/** The run streams of one Studio server. */
export class RunLive {
  readonly engine: Engine;
  /**
   * The engine's job queue itself, not one with its own memory: it is asked only who claimed a job (claimOf keeps no
   * memory), a job's live record and its events by byte range (the port's reads: no path of the queue here), never
   * what holds heavy work.
   */
  readonly queue: Pick<JobQueueView, 'claimOf' | 'liveRecord' | 'eventsRange'>;
  readonly pollMs: number;
  readonly feeds = new Map<string, FrameFeed>();
  private readonly streams = new Set<RunStream>();
  private reserved = 0;
  private keepalive: NodeJS.Timeout | undefined;
  private closed = false;
  /** Upstream frame connections open now (tests). */
  upstreams = 0;
  /** The most bytes a page stream's socket held unsent so far (tests: latest-only). */
  maxBacklog = 0;

  constructor(private readonly o: RunLiveOptions) {
    this.engine = o.engine;
    this.queue = o.engine.queue;
    this.pollMs = o.pollMs ?? RUN_LIVE_POLL_MS;
  }

  log(message: string): void {
    this.o.log?.(message);
  }

  noteBacklog(n: number): void {
    if (n > this.maxBacklog) this.maxBacklog = n;
  }

  /** Run streams open now. */
  get streamCount(): number {
    return this.streams.size;
  }

  /**
   * `POST /v1/live` (the gate passed, the body read): a stream, or an answer through `fail` — 503 when
   * RUN_LIVE_STREAMS_MAX are open, 400 for a bad body, 404 for no such run.
   */
  async open(res: ServerResponse, body: Record<string, unknown>, fail: (status: number, code: string, message: string) => void): Promise<void> {
    if (this.closed || this.streams.size + this.reserved >= RUN_LIVE_STREAMS_MAX) {
      fail(503, 'too_many_streams', `this Studio serves at most ${RUN_LIVE_STREAMS_MAX} run streams: close the live screen in another tab (this one follows the run without its picture)`);
      return;
    }
    const parsed = RunLiveInput.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      fail(400, 'invalid', `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`);
      return;
    }
    const a = parsed.data;
    this.reserved++;
    let stream: RunStream;
    let mode: string;
    let picture: { state: PictureState; why: string } | null;
    let jobId: string | null;
    let snapshot: { from: 'start' | 'after'; truncated: boolean; items: LiveItem[]; notes: string[] };
    try {
      const p = await openProjectBySlug(this.o.ws, a.project);
      const status = await this.engine.runs.status(a.project, a.run_id);
      const folder = await RunFolder.open(p.dir, a.run_id);
      if (!folder) throw new EngineError('not_found', `run ${a.run_id} has no readable folder in ${a.project} (a link, or outside the project)`);
      mode = status.mode;
      jobId = status.job?.id ?? null;
      const scrub = scrubber([
        { path: p.dir, as: '<project>' },
        { path: resolve(this.o.ws.root), as: '<workspace>' },
        { path: homedir(), as: '~' },
      ]);
      // Where the log is read from: after the page's cursor, else the start — at most its last LIVE_TAIL_MAX bytes.
      const size = (r: RangeRead | { ok: false }) => (r.ok ? r.size : 0);
      const logSize = size(folder.readRange('log.jsonl', 0, 0));
      let logStart = a.after?.log ?? 0;
      let from: 'start' | 'after' = a.after ? 'after' : 'start';
      if (logStart > logSize) {
        logStart = 0;
        from = 'start';
      }
      const truncated = logSize - logStart > LIVE_TAIL_MAX;
      if (truncated) logStart = logSize - LIVE_TAIL_MAX;
      const log = new JsonlTail((o, m) => folder.readRange('log.jsonl', o, m), logStart, truncated);
      let jobLog: JsonlTail | null = null;
      if (jobId) {
        const events = (o: number, m: number) => this.queue.eventsRange(jobId!, o, m);
        const jobSize = size(await events(0, 0));
        let jobStart = from === 'after' ? (a.after?.job ?? 0) : 0;
        if (jobStart > jobSize) jobStart = 0;
        const cut = jobSize - jobStart > LIVE_TAIL_MAX;
        if (cut) jobStart = jobSize - LIVE_TAIL_MAX;
        jobLog = new JsonlTail(events, jobStart, cut);
      }
      stream = new RunStream({ live: this, res, req: { project: a.project, run: a.run_id, jobId }, log, jobLog, scrub });
      const first = await stream.pull(LIVE_TAIL_MAX);
      snapshot = { from, truncated, items: first.items, notes: first.notes };
      const finished = status.finished || (status.job ? FINISHED_JOB_STATES.has(status.job.state) : false);
      const wants = a.frames ?? mode === 'dry';
      picture = !jobId
        ? { state: 'none', why: 'this run was started in a terminal: steps and log only' }
        : finished
          ? { state: 'none', why: 'the run has ended' }
          : !wants
            ? { state: 'off', why: a.frames === false ? 'the picture is hidden' : 'a capture shows its picture only when asked (it costs CPU during the take)' }
            : null;
    } catch (e) {
      this.reserved--;
      const err = toEngineError(e);
      fail(ERROR_STATUS[err.code], err.code, err.message);
      return;
    }
    this.reserved--;
    if (this.closed || res.destroyed) return;
    res.writeHead(200, { ...securityHeaders('api'), 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.streams.add(stream);
    res.on('close', () => stream.close());
    stream.write(sse('hello', { project: a.project, run_id: a.run_id, mode, job: jobId }));
    // The snapshot: every event but the log lines cut to the newest LIVE_SNAPSHOT_LOG_LINES.
    const isLog = (i: LiveItem) => i.ev.type === 'log' || i.ev.type === 'job_log';
    let logs = snapshot.items.filter(isLog).length;
    const items = snapshot.items.filter((i) => !isLog(i) || logs-- <= LIVE_SNAPSHOT_LOG_LINES);
    const dropped = snapshot.items.length - items.length;
    stream.write(
      sse('snapshot', {
        from: snapshot.from,
        truncated: snapshot.truncated,
        ...(dropped ? { log_lines_dropped: dropped } : {}),
        cursor: stream.cursor(),
        events: items,
        ...(snapshot.notes.length ? { notes: snapshot.notes } : {}),
      }),
    );
    if (picture) stream.setPicture(picture.state, picture.why);
    else this.subscribe(stream, jobId!);
    this.schedule();
    stream.start();
  }

  /** The job's one upstream (opened now when it is the first page stream wanting frames). */
  private subscribe(s: RunStream, jobId: string): void {
    let feed = this.feeds.get(jobId);
    if (!feed) {
      feed = new FrameFeed(this, jobId);
      this.feeds.set(jobId, feed);
      void feed.run().catch((e: unknown) => this.log(`retake ui: a live picture failed: ${e instanceof Error ? e.name : 'error'}`));
    }
    feed.add(s);
  }

  /** A stream ended: out of the set, out of its upstream (closed when it was the last). */
  drop(s: RunStream): void {
    this.streams.delete(s);
    s.feed?.remove(s);
    this.schedule();
  }

  private schedule(): void {
    const want = this.streams.size > 0 && !this.closed;
    if (want && !this.keepalive) {
      this.keepalive = setInterval(() => {
        for (const s of this.streams) s.write(': keepalive\n\n');
      }, KEEPALIVE_MS);
      this.keepalive.unref();
    } else if (!want && this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
  }

  /** Ends every stream and every upstream. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams]) s.close();
    for (const f of [...this.feeds.values()]) f.stop();
    this.schedule();
  }
}
