/**
 * The Run screen's stream client: `POST /v1/live` read through fetch (sse.ts), folded into one state — the
 * run's start, its outline (every step it executes), each step's status, the preflight's sessions, hooks, pauses, the
 * log (capped), the job, the picture's state and the end. Frames never enter React state: they go straight to the
 * LiveView's canvas through `onFrame`.
 *
 * - **Reconnect with a cursor**: the page keeps the largest `seq` of each source (`log`, `job`); a stream that drops
 *   without `end` is opened again with `after` (no duplicate, nothing missed), with a growing delay.
 * - **Only while watched**: a hidden tab closes its stream (the Studio then closes the job's upstream when
 *   no other page wants frames) and opens it again with `after` when it is shown. Toggling the picture reopens the
 *   stream with `frames: true / false`. `frames` is sent only when the person chose; otherwise the server's default
 *   holds — the picture on for a dry run, off for a capture (it costs Chromium CPU during the take).
 * - **503** (every run stream of this Studio taken — another tab): the screen follows the run with a `run_status` read
 *   every few seconds instead, and tries the stream again later.
 *
 * Every text of the view arrives already reduced by the server; the screen renders each one as a text node (Txt).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { openStream } from '../api.js';
import type { ApiError } from '../api.js';
import { runStatus } from '../data/shoot.js';
import { readSse } from '../sse.js';
import { EMPTY, applyEvent, int, obj, opt, str } from './live-fold.js';
import type { LiveFrame, PictureState, RunLiveState, RunStatusLite, StreamConn } from './live-fold.js';

export { EMPTY, LIVE_BOX, LOG_KEEP, SETTLE_FRAMES, applyEvent, nextLayout, pauseMaxWords, placeFrame, stepCounts, stepKey, stepStatus } from './live-fold.js';
export type {
  HookRow,
  JobView,
  LiveFrame,
  LogLine,
  OutlineStep,
  PauseRow,
  PictureState,
  RunEndView,
  RunLiveState,
  RunStartView,
  RunStatusLite,
  SessionRow,
  Size,
  StepRowStatus,
  StepState,
  StreamConn,
} from './live-fold.js';

/** A refused stream (503) is tried again after this long (ms). */
const BUSY_RETRY_MS = 30_000;
/** run_status read this often while the stream is refused (ms). */
const FALLBACK_POLL_MS = 2500;
/** At most this often the screen re-renders for new events (ms). */
const FLUSH_MS = 100;
/** A frame's JPEG as base64, at most (the worker's 512 KiB cap, encoded). */
const FRAME_B64_MAX = 700_000;

/** Tracks `document.visibilityState`: false while the tab is hidden (in the background, minimised). */
export function useVisible(): boolean {
  const [visible, set] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => set(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

export interface RunLive {
  state: RunLiveState;
  conn: StreamConn;
  /** The stream's refusal (404 no such run, 400…), as the server said it. */
  error: ApiError | null;
  /** run_status, while the stream is refused (503). */
  fallback: RunStatusLite | null;
}

interface FoldRefs {
  stateRef: MutableRefObject<RunLiveState>;
  cursor: MutableRefObject<{ log: number; job: number } | null>;
  ended: MutableRefObject<boolean>;
  frameRef: MutableRefObject<(f: LiveFrame) => void>;
  flushTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setState: (s: RunLiveState) => void;
}

/** The stream's events folded into `stateRef` (rendered at most every FLUSH_MS), its cursor and its end; frames to `frameRef`. */
function useEventHandler({ stateRef, cursor, ended, frameRef, flushTimer, setState }: FoldRefs): (type: string, data: unknown) => boolean {
  const flush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      setState(stateRef.current);
    }, FLUSH_MS);
  }, [flushTimer, stateRef, setState]);

  const advance = (source: unknown, seq: unknown) => {
    if (!cursor.current || !int(seq)) return;
    if (source === 'log' && seq > cursor.current.log) cursor.current = { ...cursor.current, log: seq };
    if (source === 'job' && seq > cursor.current.job) cursor.current = { ...cursor.current, job: seq };
  };

  const handle = (type: string, data: unknown): boolean => {
    const d = obj(data);
    switch (type) {
      case 'hello':
        stateRef.current = { ...stateRef.current, hello: { mode: str(d.mode) ? d.mode : 'dry', job: str(d.job) ? d.job : null } };
        break;
      case 'snapshot': {
        let s = d.from === 'start' ? { ...EMPTY, hello: stateRef.current.hello, picture: stateRef.current.picture, job: stateRef.current.job } : stateRef.current;
        const c = obj(d.cursor);
        cursor.current = { log: int(c.log) ? c.log : 0, job: int(c.job) ? c.job : 0 };
        if (d.truncated === true) s = { ...s, truncated: true };
        if (int(d.log_lines_dropped)) s = { ...s, logDropped: s.logDropped + d.log_lines_dropped };
        for (const it of Array.isArray(d.events) ? d.events : []) {
          const i = obj(it);
          s = applyEvent(s, str(i.src) ? i.src : 'log', int(i.seq) ? i.seq : 0, obj(i.ev));
        }
        for (const n of Array.isArray(d.notes) ? d.notes.filter(str) : []) s = applyEvent(s, 'log', 0, { type: 'note', message: n });
        stateRef.current = s;
        break;
      }
      case 'progress':
        stateRef.current = applyEvent(stateRef.current, str(d.src) ? d.src : 'log', int(d.seq) ? d.seq : 0, obj(d.ev));
        advance(d.src, d.seq);
        break;
      case 'job':
        if (str(d.state)) {
          const w = d.waits_for;
          const waits: { waits_for?: 'browser' | 'render' } = w === 'browser' || w === 'render' ? { waits_for: w } : {};
          stateRef.current = { ...stateRef.current, job: { state: d.state, pause_requested: d.pause_requested === true, cancel_requested: d.cancel_requested === true, ...waits } };
        }
        break;
      case 'picture':
        if (str(d.state)) stateRef.current = { ...stateRef.current, picture: { state: d.state as PictureState, ...opt('why', str(d.why) ? d.why : undefined) } };
        break;
      case 'frame':
        if (int(d.seq) && int(d.w) && int(d.h) && d.w > 0 && d.h > 0 && d.w <= 4096 && d.h <= 4096 && str(d.jpeg) && d.jpeg.length <= FRAME_B64_MAX) {
          frameRef.current({ seq: d.seq, w: d.w, h: d.h, jpeg: d.jpeg });
        }
        return true;
      case 'end':
        ended.current = true;
        stateRef.current = { ...stateRef.current, ended: { ...opt('status', str(d.status) ? d.status : undefined), ...opt('job_state', str(d.job_state) ? d.job_state : undefined) } };
        flush();
        return false;
      default:
        return true;
    }
    flush();
    return true;
  };
  return handle;
}

/**
 * Follow one run: its stream while the tab is visible (`frames`: null = the server's default), frames to `onFrame`.
 */
export function useRunLive(slug: string, runId: string, frames: boolean | null, onFrame: (f: LiveFrame) => void): RunLive {
  const [state, setState] = useState<RunLiveState>(EMPTY);
  const [conn, setConn] = useState<StreamConn>('connecting');
  const [error, setError] = useState<ApiError | null>(null);
  const [fallback, setFallback] = useState<RunStatusLite | null>(null);
  const visible = useVisible();
  const stateRef = useRef<RunLiveState>(EMPTY);
  const cursor = useRef<{ log: number; job: number } | null>(null);
  const ended = useRef(false);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handle = useEventHandler({ stateRef, cursor, ended, frameRef, flushTimer, setState });
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // A new run on the same screen: everything from the start.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another project or run id is the trigger to reset the state
  useEffect(() => {
    stateRef.current = EMPTY;
    cursor.current = null;
    ended.current = false;
    setState(EMPTY);
    setError(null);
    setFallback(null);
  }, [slug, runId]);

  useEffect(() => {
    if (ended.current) return;
    if (!visible) {
      setConn('hidden');
      return;
    }
    const ac = new AbortController();
    void (async () => {
      let backoff = 1000;
      while (!ac.signal.aborted && !ended.current) {
        setConn('connecting');
        const body = { project: slug, run_id: runId, ...(cursor.current ? { after: cursor.current } : {}), ...(frames !== null ? { frames } : {}) };
        let r: Awaited<ReturnType<typeof openStream>>;
        try {
          r = await openStream('/v1/live', body, ac.signal);
        } catch {
          return; // the session ended: the shell says so
        }
        if (ac.signal.aborted) return;
        if (r.res) {
          setConn('open');
          setError(null);
          backoff = 1000;
          await readSse(r.res, (t, d) => handleRef.current(t, d));
          if (ac.signal.aborted) return;
          if (ended.current) {
            setConn('ended');
            return;
          }
        } else if (r.status === 503) {
          setConn('busy');
          await sleep(BUSY_RETRY_MS, ac.signal);
          continue;
        } else if (r.status >= 400 && r.status < 500) {
          setError(r.error ?? { code: 'internal', message: `HTTP ${r.status}` });
          setConn('error');
          return;
        }
        setConn('retrying');
        await sleep(backoff, ac.signal);
        backoff = Math.min(backoff * 2, 10_000);
      }
    })();
    return () => ac.abort();
  }, [slug, runId, frames, visible]);

  // Refused stream: run_status every few seconds while the tab is visible.
  useEffect(() => {
    if (conn !== 'busy' || !visible) return;
    let live = true;
    const read = () =>
      runStatus({ project: slug, run_id: runId }).then(
        (d) => live && setFallback(d),
        () => undefined,
      );
    void read();
    const t = setInterval(read, FALLBACK_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [conn, visible, slug, runId]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  return { state, conn, error, fallback };
}
