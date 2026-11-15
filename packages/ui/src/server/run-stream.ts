/**
 * One page's stream of one run and the one upstream of a job's frames it shares (the Run screen's stream, run-live.ts):
 * the files' new lines as view events, the job's state, the end, and the live picture, latest-only.
 */
import type { ServerResponse } from 'node:http';
import { SLUG_RE } from '@retake/core/model';
import type { JobState } from '@retake/engine';
import { FINISHED_JOB_STATES, openLiveFeed, readLiveChannel } from '@retake/engine/shell';
import type { Engine, JobQueueView, LiveFeedFrame } from '@retake/engine';
import { sseText } from './live.js';
import { bestEffort } from '@retake/core/base';
import { LIVE_READ_CHUNK, LIVE_TAIL_MAX } from './jsonl-tail.js';
import type { JsonlTail } from './jsonl-tail.js';
import { mergeByTime, viewJobEvent, viewProgress } from './run-live-view.js';
import type { LiveItem, Scrub } from './run-live-view.js';

/** How long the upstream waits before trying the job's channel again (ms). */
const FEED_RETRY_MS = 1000;
/** After `run_end`, how long a stream waits for the job to finish before it ends anyway (ms). */
const END_GRACE_MS = 10_000;
/** Bytes read per poll and file, at most (a stream catches up over several polls). */
const POLL_READ_MAX = 8 * LIVE_READ_CHUNK;

export type PictureState = 'off' | 'none' | 'waiting' | 'live' | 'busy' | 'ended';

// ─── streams and the upstream of frames ──────────────────────────────────────────────────────────────────────────────

const sse = sseText;

/** What a stream and an upstream read of their server's run streams (RunLive, run-live.ts). */
export interface RunStreamHost {
  readonly engine: Engine;
  readonly queue: Pick<JobQueueView, 'claimOf' | 'liveRecord' | 'eventsRange'>;
  readonly pollMs: number;
  readonly feeds: Map<string, FrameFeed>;
  upstreams: number;
  log(message: string): void;
  noteBacklog(n: number): void;
  drop(s: RunStream): void;
}

/** What one stream is made of: its server's run streams, the page's response, the run, its two tails and the scrubber. */
export interface RunStreamOptions {
  live: RunStreamHost;
  res: ServerResponse;
  req: { project: string; run: string; jobId: string | null };
  log: JsonlTail;
  jobLog: JsonlTail | null;
  scrub: Scrub;
}

/** A page id a frame may name: the grammar of a scenario's names (core SLUG_RE), at most 100 characters. */
const isPageId = (v: string): boolean => v.length <= 100 && SLUG_RE.test(v);

/** One page's stream of one run. */
export class RunStream {
  private waitingFrame: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private ticks = 0;
  private sawEnd = 0;
  private lastJob = '';
  private ended = false;
  feed: FrameFeed | null = null;
  picture: PictureState | null = null;

  readonly live: RunStreamHost;
  readonly res: ServerResponse;
  readonly req: { project: string; run: string; jobId: string | null };
  private readonly log: JsonlTail;
  private readonly jobLog: JsonlTail | null;
  private readonly scrub: Scrub;

  constructor(o: RunStreamOptions) {
    this.live = o.live;
    this.res = o.res;
    this.req = o.req;
    this.log = o.log;
    this.jobLog = o.jobLog;
    this.scrub = o.scrub;
    o.res.on('drain', () => {
      const f = this.waitingFrame;
      this.waitingFrame = null;
      if (f) this.frame(f);
    });
  }

  get closed(): boolean {
    return this.ended || this.res.writableEnded || this.res.destroyed;
  }

  write(text: string): void {
    if (this.closed) return;
    this.res.write(text);
    this.live.noteBacklog(this.res.writableLength);
  }

  /** Latest-only: a frame waits (replacing the one waiting) while the socket needs a drain. */
  frame(text: string): void {
    if (this.closed) return;
    if (this.res.writableNeedDrain) {
      this.waitingFrame = text;
      return;
    }
    this.write(text);
  }

  setPicture(state: PictureState, why?: string): void {
    if (this.picture === state) return;
    this.picture = state;
    this.write(sse('picture', { state, ...(why ? { why } : {}) }));
  }

  /**
   * New lines of both files, as view items (at most POLL_READ_MAX bytes each, or `budget`), in time order (the run's
   * lines and the worker's merged by `ts`, each file's own order kept — a reload shows the same order).
   */
  async pull(budget = POLL_READ_MAX): Promise<{ items: LiveItem[]; notes: string[] }> {
    const notes: string[] = [];
    const take = async (tail: JsonlTail, src: LiveItem['src']): Promise<LiveItem[]> => {
      const items: LiveItem[] = [];
      const r = await tail.pull(budget);
      notes.push(...r.notes);
      for (const l of r.lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(l.text);
        } catch {
          continue;
        }
        const ev = src === 'log' ? viewProgress(parsed, this.scrub) : viewJobEvent(parsed, this.scrub);
        if (!ev) continue;
        if (src === 'log' && ev.type === 'run_end') this.sawEnd ||= Date.now();
        items.push({ src, seq: l.end, ev });
      }
      return items;
    };
    const run = await take(this.log, 'log');
    const job = this.jobLog ? await take(this.jobLog, 'job') : [];
    return { items: mergeByTime(run, job), notes };
  }

  cursor(): { log: number; job: number } {
    return { log: this.log.cursor, job: this.jobLog?.cursor ?? 0 };
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.live.pollMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const { items, notes } = await this.pull();
      for (const n of notes) this.write(sse('progress', { src: 'log', seq: this.log.cursor, ev: { type: 'note', message: n } }));
      for (const it of items) this.write(sse('progress', it));
      if (++this.ticks % 4 !== 0 && !this.sawEnd) return;
      await this.checkEnd();
    } catch (e) {
      this.live.log(`retake ui: a run stream failed: ${e instanceof Error ? e.name : 'error'}`);
      this.close();
    } finally {
      this.busy = false;
    }
  }

  /** The job's state (on change) and, once the run and its job ended, the last lines then `end`. */
  private async checkEnd(): Promise<void> {
    const { engine } = this.live;
    let jobState: JobState | null = null;
    if (this.req.jobId) {
      const job = await bestEffort(engine.jobs.get(this.req.jobId), 'a job that cannot be read is followed again on the next tick', null);
      if (job) {
        jobState = job.state;
        const view = { state: job.state, pause_requested: Boolean(job.pause_requested_at), cancel_requested: Boolean(job.cancel_requested_at) };
        const key = JSON.stringify(view);
        if (key !== this.lastJob) {
          this.lastJob = key;
          this.write(sse('job', view));
        }
      }
    }
    const jobDone = !this.req.jobId || jobState === null || FINISHED_JOB_STATES.has(jobState);
    // A job's run is over when its job is (the worker finalises run.json first); a terminal's when run.json says so.
    let runDone = this.sawEnd > 0 || (this.req.jobId !== null && jobDone);
    let status: string | undefined;
    if (jobDone) {
      const st = await bestEffort(engine.runs.status(this.req.project, this.req.run), 'a run whose status cannot be read is followed again on the next tick', null);
      status = st?.status;
      if (!this.req.jobId) runDone ||= st === null || st.finished;
    }
    const overdue = this.sawEnd > 0 && Date.now() - this.sawEnd > END_GRACE_MS;
    if (!(runDone && jobDone) && !overdue) return;
    if (this.closed) return;
    const last = await this.pull(LIVE_TAIL_MAX);
    for (const it of last.items) this.write(sse('progress', it));
    this.write(sse('end', { ...(status ? { status } : {}), ...(jobState ? { job_state: jobState } : {}) }));
    this.close();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    if (!this.res.writableEnded) this.res.end();
    this.live.drop(this);
  }
}

/** The one upstream of a job's frames, shared by the page streams that want them; closed when none does. */
export class FrameFeed {
  readonly subs = new Set<RunStream>();
  private readonly ac = new AbortController();
  state: PictureState = 'waiting';
  /** The current frame (memory only, while this upstream is open): what a page stream joining it is sent first. */
  private latest: string | null = null;
  connected = false;

  constructor(
    private readonly live: RunStreamHost,
    private readonly jobId: string,
  ) {}

  add(s: RunStream): void {
    this.subs.add(s);
    s.feed = this;
    s.setPicture(this.state);
    if (this.latest) s.frame(this.latest);
  }

  remove(s: RunStream): void {
    this.subs.delete(s);
    s.feed = null;
    if (this.subs.size === 0) this.stop();
  }

  stop(): void {
    this.latest = null;
    this.ac.abort();
    this.live.feeds.delete(this.jobId);
  }

  private set(state: PictureState, why?: string): void {
    this.state = state;
    if (state !== 'live') this.latest = null;
    for (const s of this.subs) s.setPicture(state, why);
  }

  private onFrame(f: LiveFeedFrame): void {
    if (this.ac.signal.aborted) return;
    const h = f.header;
    const text = sse('frame', { seq: h.seq, w: h.w, h: h.h, at: h.at, ...(h.page !== undefined && isPageId(h.page) ? { page: h.page } : {}), jpeg: f.data.toString('base64') });
    if (this.state !== 'live') this.set('live');
    this.latest = text;
    for (const s of this.subs) s.frame(text);
  }

  /** Follow the job's channel while a page stream wants frames: retry while it runs, `ended` once it ended. */
  async run(): Promise<void> {
    const signal = this.ac.signal;
    while (!signal.aborted) {
      const job = await bestEffort(this.live.engine.jobs.get(this.jobId), 'a job that cannot be read is followed again on the next tick', null);
      if (signal.aborted) return;
      if (!job || FINISHED_JOB_STATES.has(job.state)) {
        this.set('ended');
        return;
      }
      if (job.state === 'running') await this.follow(signal);
      await new Promise<void>((r) => {
        const t = setTimeout(r, FEED_RETRY_MS);
        signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
    }
  }

  /** The running job's channel, when it has one: its frames until it closes (`busy` when another Studio holds it). */
  private async follow(signal: AbortSignal): Promise<void> {
    const info = await readLiveChannel(this.live.queue, this.jobId);
    if (!info || signal.aborted) return;
    this.connected = true;
    this.live.upstreams++;
    try {
      await openLiveFeed(info, { signal, onFrame: (f) => this.onFrame(f) });
    } catch (e) {
      if (/answered 503/.test(e instanceof Error ? e.message : '')) this.set('busy', 'the live picture of this run is already open elsewhere (another Studio)');
    } finally {
      this.connected = false;
      this.live.upstreams--;
    }
    if (!signal.aborted && this.state === 'live') this.set('waiting');
  }
}
