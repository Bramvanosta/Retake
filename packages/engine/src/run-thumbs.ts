/**
 * Thumbnails of a run's steps for the Studio's scenario screen (L4.2): `engine.runs.thumbs(project, run, keys)` →
 * base64 JPEGs (≤ 480 px) of a batch of the run's own step keys ("<scene>.<index>" of the run — the screen maps today's
 * steps to them, critique B4).
 *
 * Which picture: a dry run's step screenshot; a failed step's error screenshot (either mode); for a capture the frame
 * on screen at the end of the step after its hold (run-data.ts: the CFR grid rule, critique B3) — from the kept frames,
 * else from the video, on the track of the page the step acted on in a multi-page scene.
 *
 * Cost and safety (critique B6, B7): every file through RunFolder (no link followed, names validated, sizes capped,
 * checked once open); a video only as a regular file inside the run, handed to ffmpeg as open descriptors; one ffmpeg
 * process per batch and video (≤ 1 per run, ≤ 2 at once); sharp work ≤ 2 at once, each source read inside its slot
 * (≤ 2 sources of ≤ 16 MiB in memory, review A #2); the reviewer's frames (the product's: the review package's `./thumbs` entry only, no editor / Remotion import). Thumbnails live in memory
 * only (a byte-bounded LRU keyed by the run folder, the run's file signatures and the run's step key): never written.
 */
import { closeSync } from 'node:fs';
import type { TimelineEvent } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import { EngineError } from './errors.js';
import { RunDataCache, errorScreenshotName, fileSlug, frameAt, gridFrame, seekTime, stepScreenshotName } from './run-data.js';
import type { PageSource, RunData } from './run-data.js';
import type { FrameTools } from './review/reviewer.js';

/** Keys per call, at most. */
export const RUN_THUMBS_MAX_KEYS = 24;
/** A run's step key: "<scene id>.<step index>". */
export const RUN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.\d{1,4}$/;
/** One thumbnail's base64, at most (the page refuses a longer data URL). */
export const THUMB_BASE64_MAX = 200_000;
/** The base64 of one answer, at most (keys past it come back `missing: budget`: ask again). */
export const RUN_THUMBS_RESPONSE_MAX = 2 * 1024 * 1024;
/** Thumbnails held in memory, in base64 characters. */
export const THUMB_CACHE_BYTES = 32 * 1024 * 1024;
/**
 * Source images read for a thumbnail, at most: a screenshot (PNG; a full-page 1440 px one is a few MB) and a kept frame.
 * A source is read inside its sharp slot (review A #2): at most SHARP_SLOTS sources are held at once.
 */
export const SCREENSHOT_MAX = 16 * 1024 * 1024;
const FRAME_MAX = 16 * 1024 * 1024;
/** ffmpeg processes at once (all runs) and sharp jobs at once. */
const FFMPEG_SLOTS = 2;
const SHARP_SLOTS = 2;

export type ThumbSource = 'screenshot' | 'error_screenshot' | 'frame' | 'video';

export interface RunThumb {
  key: string;
  mime: 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  from: ThumbSource;
}

export type ThumbMissingReason = 'no_step' | 'not_reached' | 'no_picture' | 'unreadable' | 'too_large' | 'budget' | 'cancelled';

export interface RunThumbsView {
  project: string;
  run: string;
  thumbs: RunThumb[];
  missing: Array<{ key: string; reason: ThumbMissingReason }>;
}

/** A counting semaphore; a waiter whose signal aborts leaves the queue. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly slots: number) {}

  get busy(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new EngineError('cancelled', 'cancelled');
    if (this.active >= this.slots) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        };
        const stop = () => {
          const i = this.waiting.indexOf(go);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new EngineError('cancelled', 'cancelled'));
        };
        this.waiting.push(go);
        signal?.addEventListener('abort', stop, { once: true });
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** A byte-bounded LRU of thumbnails (base64 length counted). */
class ThumbCache {
  private readonly map = new Map<string, RunThumb>();
  private bytes = 0;
  constructor(private readonly max: number) {}

  get size(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.bytes };
  }

  get(key: string): RunThumb | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: RunThumb): void {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.base64.length;
      this.map.delete(key);
    }
    if (v.base64.length > this.max) return;
    this.map.set(key, v);
    this.bytes += v.base64.length;
    while (this.bytes > this.max) {
      const [k, oldest] = this.map.entries().next().value as [string, RunThumb];
      this.map.delete(k);
      this.bytes -= oldest.base64.length;
    }
  }
}

export interface RunThumbsOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  policy: WorkPolicy;
  /** What takes a video's frames and makes the JPEGs (its composition root's reviewer, review/reviewer.ts). */
  frames: Pick<FrameTools, 'load' | 'at' | 'thumb'>;
  /** Thumbnail cache size in base64 characters (default THUMB_CACHE_BYTES). */
  cacheBytes?: number;
  /** ffmpeg binary (default: core `ffmpegBin()` — retake.yaml, $RETAKE_FFMPEG, the app's, PATH). */
  ffmpeg?: string;
  /** Kill an ffmpeg process after this long (default 10 s). */
  ffmpegTimeoutMs?: number;
}

type Plan = { kind: 'file'; key: string; rel: string; max: number; from: ThumbSource } | { kind: 'video'; key: string; video: string; seconds: number };

/** The thumbnail service of one engine (its caches and its process slots). */
export class RunThumbs {
  readonly runs: RunDataCache;
  private readonly cache: ThumbCache;
  private readonly ffmpeg = new Semaphore(FFMPEG_SLOTS);
  private readonly sharp = new Semaphore(SHARP_SLOTS);
  /** Per run folder: the tail of its video batches (one ffmpeg per run at a time). */
  private readonly runChains = new Map<string, Promise<unknown>>();
  /**
   * Counters for tests: thumbnails made, ffmpeg processes started, the most ffmpeg processes at once, source bytes held
   * now and at most (read, not yet encoded).
   */
  readonly stats = { made: 0, ffmpeg: 0, ffmpegPeak: 0, sourceBytes: 0, sourceBytesPeak: 0 };

  constructor(
    private readonly o: RunThumbsOptions,
    runs?: RunDataCache,
  ) {
    this.runs = runs ?? new RunDataCache();
    this.cache = new ThumbCache(o.cacheBytes ?? THUMB_CACHE_BYTES);
  }

  get cacheSize(): { entries: number; bytes: number } {
    return this.cache.size;
  }

  /** The engine's ffmpeg slots (L4.6: the render frames of the comment viewer wait for the same slots). */
  get ffmpegSlots(): Semaphore {
    return this.ffmpeg;
  }

  async thumbs(projectDir: string, project: string, runId: string, keys: readonly string[], o: { signal?: AbortSignal } = {}): Promise<RunThumbsView> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0 || wanted.length > RUN_THUMBS_MAX_KEYS) throw new EngineError('invalid', `ask for 1 to ${RUN_THUMBS_MAX_KEYS} step keys at a time (asked ${wanted.length})`);
    const bad = wanted.find((k) => !RUN_KEY_RE.test(k));
    if (bad !== undefined) throw new EngineError('invalid', `"${bad.slice(0, 60)}" is not a step key ("<scene id>.<step index>" of the run)`);
    const run = await this.runs.get(projectDir, runId);
    if (!run) throw new EngineError('not_found', `run "${runId}" not found in ${project} (or its folder is a link, or outside the project)`);
    const results = new Map<string, RunThumb | ThumbMissingReason>();
    const plans: Plan[] = [];
    for (const key of wanted) {
      const hit = this.cache.get(cacheKey(run, key));
      if (hit) results.set(key, hit);
      else {
        const p = await planFor(run, key);
        if (typeof p === 'string') results.set(key, p);
        else plans.push(...p);
      }
    }
    await this.make(run, plans, results, o.signal);
    const thumbs: RunThumb[] = [];
    const missing: RunThumbsView['missing'] = [];
    let budget = RUN_THUMBS_RESPONSE_MAX;
    for (const key of wanted) {
      const r = results.get(key) ?? 'no_picture';
      if (typeof r === 'string') missing.push({ key, reason: r });
      else if (r.base64.length > budget) missing.push({ key, reason: 'budget' });
      else {
        budget -= r.base64.length;
        thumbs.push(r);
      }
    }
    return { project, run: runId, thumbs, missing };
  }

  /** Carry out the plans: files first (sharp, ≤ 2 at once), then one ffmpeg per video for what is left. */
  private async make(run: RunData, plans: Plan[], results: Map<string, RunThumb | ThumbMissingReason>, signal?: AbortSignal): Promise<void> {
    if (plans.length === 0) return;
    const r = this.o.frames;
    // Loaded before the slots catch their failures: frames that cannot be loaded fail the call, never read as missing.
    await r.load();
    const done = (key: string) => {
      const v = results.get(key);
      return v !== undefined && typeof v !== 'string';
    };
    const keep = (key: string, data: Buffer, width: number, height: number, from: ThumbSource) => {
      const base64 = data.toString('base64');
      if (base64.length > THUMB_BASE64_MAX) {
        results.set(key, 'too_large');
        return;
      }
      const t: RunThumb = { key, mime: 'image/jpeg', base64, width, height, from };
      this.stats.made++;
      this.cache.set(cacheKey(run, key), t);
      results.set(key, t);
    };
    /** Read a source (`read`) and encode it, both inside one sharp slot: never more than SHARP_SLOTS sources in memory. */
    const jpeg = async (read: () => Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }>) => {
      const release = await this.sharp.acquire(signal);
      let held = 0;
      try {
        const got = await read();
        if (!got.ok) return got;
        held = got.bytes.length;
        this.stats.sourceBytes += held;
        this.stats.sourceBytesPeak = Math.max(this.stats.sourceBytesPeak, this.stats.sourceBytes);
        return { ok: true as const, thumb: await r.thumb(got.bytes) };
      } finally {
        this.stats.sourceBytes -= held;
        release();
      }
    };
    // Files (screenshots, kept frames), keys in parallel, each key's sources in order (an error screenshot before
    // the frame); the video is the last resort.
    const fileGroups = new Map<string, Array<Extract<Plan, { kind: 'file' }>>>();
    for (const p of plans) if (p.kind === 'file') fileGroups.set(p.key, [...(fileGroups.get(p.key) ?? []), p]);
    await Promise.all(
      [...fileGroups.values()].map(async (group) => {
        for (const p of group) {
          if (signal?.aborted || done(p.key)) return;
          try {
            const t = await jpeg(() => run.folder.read(p.rel, p.max));
            if (!t.ok) {
              results.set(p.key, t.reason === 'too_large' ? 'too_large' : 'unreadable');
              continue;
            }
            keep(p.key, t.thumb.data, t.thumb.width, t.thumb.height, p.from);
          } catch {
            if (signal?.aborted) return;
            results.set(p.key, 'unreadable');
          }
        }
      }),
    );
    const videoPlans = plans.filter((p): p is Extract<Plan, { kind: 'video' }> => p.kind === 'video' && !done(p.key));
    const byVideo = new Map<string, Array<Extract<Plan, { kind: 'video' }>>>();
    for (const p of videoPlans) byVideo.set(p.video, [...(byVideo.get(p.video) ?? []), p]);
    for (const [video, batch] of byVideo) {
      if (signal?.aborted) break;
      const v = await run.folder.video(video);
      if (!v.ok) {
        for (const p of batch) if (!done(p.key)) results.set(p.key, v.reason === 'missing' ? (results.get(p.key) ?? 'no_picture') : 'unreadable');
        continue;
      }
      // Opened when its turn comes (one ffmpeg per run at a time), handed over as descriptors: ffmpeg opens no path.
      const frames = await this.oneVideoBatch(run.folder.dir, async () => {
        const open = run.folder.openVideo(video, batch.length);
        if (!open.ok) return null;
        try {
          return await this.ffmpegFrames(
            r,
            { fds: open.fds },
            batch.map((p) => p.seconds),
            signal,
          );
        } finally {
          for (const fd of open.fds) closeSync(fd);
        }
      });
      if (!frames) {
        for (const p of batch) if (!done(p.key)) results.set(p.key, signal?.aborted ? 'cancelled' : 'unreadable');
        continue;
      }
      await Promise.all(
        batch.map(async (p, i) => {
          const png = frames[i];
          if (!png) {
            if (!done(p.key)) results.set(p.key, 'no_picture');
            return;
          }
          try {
            const t = await jpeg(async () => ({ ok: true as const, bytes: png }));
            if (t.ok) keep(p.key, t.thumb.data, t.thumb.width, t.thumb.height, 'video');
          } catch {
            if (!done(p.key)) results.set(p.key, signal?.aborted ? 'cancelled' : 'unreadable');
          }
        }),
      );
    }
    if (signal?.aborted) for (const p of plans) if (!results.has(p.key)) results.set(p.key, 'cancelled');
  }

  /** Runs `fn` after the run's previous video batch (one ffmpeg per run at a time). */
  private oneVideoBatch<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.runChains.get(runDir) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.runChains.set(runDir, tail);
    void tail.then(() => {
      if (this.runChains.get(runDir) === tail) this.runChains.delete(runDir);
    });
    return next;
  }

  private async ffmpegFrames(r: RunThumbsOptions['frames'], input: { fds: number[] }, seconds: number[], signal?: AbortSignal): Promise<Array<Buffer | null> | null> {
    let release: (() => void) | undefined;
    try {
      release = await this.ffmpeg.acquire(signal);
      this.stats.ffmpeg++;
      this.stats.ffmpegPeak = Math.max(this.stats.ffmpegPeak, this.ffmpeg.busy);
      return await r.at(input, seconds, {
        policy: this.o.policy,
        ...(signal ? { signal } : {}),
        ...(this.o.ffmpeg ? { ffmpeg: this.o.ffmpeg } : {}),
        ...(this.o.ffmpegTimeoutMs ? { timeoutMs: this.o.ffmpegTimeoutMs } : {}),
      });
    } catch {
      return null;
    } finally {
      release?.();
    }
  }
}

function cacheKey(run: RunData, key: string): string {
  return `${run.folder.dir}\0${run.sig}\0${key}`;
}

/** The sources to try for one step key of a run, in order; or why there is none. */
async function planFor(run: RunData, key: string): Promise<Plan[] | ThumbMissingReason> {
  const dot = key.lastIndexOf('.');
  const scene = key.slice(0, dot);
  const step = Number(key.slice(dot + 1));
  const ev: TimelineEvent | undefined = run.events.get(key);
  const plans: Plan[] = [];
  if (!ev) {
    // A dry run without a timeline (it stopped before writing one): its screenshot, found by name.
    if (run.mode === 'dry') {
      const prefix = `${fileSlug(scene)}-${String(step).padStart(2, '0')}-`;
      const name = [...run.screenshots].find((n) => n.startsWith(prefix) && stepScreenshotName(scene, step, n.slice(prefix.length, -4)) === n);
      if (name) return [{ kind: 'file', key, rel: `screenshots/${name}`, max: SCREENSHOT_MAX, from: 'screenshot' }];
    }
    return run.timeline ? 'not_reached' : 'no_step';
  }
  if (ev.status === 'skipped') return 'not_reached';
  if (ev.status === 'failed') {
    const err = errorScreenshotName(scene, step);
    if (run.screenshots.has(err)) plans.push({ kind: 'file', key, rel: `screenshots/${err}`, max: SCREENSHOT_MAX, from: 'error_screenshot' });
  }
  if (run.mode === 'dry') {
    const name = stepScreenshotName(scene, step, ev.action);
    if (name && run.screenshots.has(name)) plans.push({ kind: 'file', key, rel: `screenshots/${name}`, max: SCREENSHOT_MAX, from: 'screenshot' });
    return plans.length ? plans : 'no_picture';
  }
  const src: PageSource | undefined = run.pageSource(ev);
  if (!src) return plans.length ? plans : 'no_picture';
  const t = ev.hold && Number.isFinite(ev.hold.t_end) ? ev.hold.t_end : ev.t_end;
  const n = gridFrame(t, src.fps, src.count);
  const index = await run.frameIndex(src.framesFile);
  if (index && index.files.length > 0) {
    const i = frameAt(index, n, src.fps, src.end);
    plans.push({ kind: 'file', key, rel: `${src.framesFolder}/${index.files[i]}`, max: FRAME_MAX, from: 'frame' });
  }
  plans.push({ kind: 'video', key, video: src.video, seconds: seekTime(n, src.fps) });
  return plans;
}
