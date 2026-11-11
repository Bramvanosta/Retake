/**
 * A render's own frames for the Studio's comment viewer (L4.6, R-UI-27; plan D2, critique B7): `renders.frame` → one
 * output frame of a succeeded render as a base64 JPEG (≤ 1280 px), `renders.outline` → what the viewer's slider needs
 * (frames, fps, size, markers, the threads made on that render as it is now).
 *
 * Which pixels: an input seek to (F − 0.5) / fps — the first frame at or after it is frame F —, which gives the same
 * decoded picture as the still's exact frame-number select (probes P1 / E1: libx264 with B-frames, an AAC track,
 * frames on both sides of keyframes). The fps and the frame count are the video's own (ffprobe of the open file), never
 * only the record's (renders/<id>.json is agent-writable): a record whose fps is not its video's is refused, and the
 * frames are bounded by min(record.frames, plan.durationInFrames, the video's frames) — the comment's own bound
 * (pickFrame) and the file's.
 *
 * Files: the video is `renders/<id>.mp4` built from the id (the record's `file` must name that same file), the renders/
 * folder a real folder of the project, the file opened without following a link and without blocking, a regular file
 * with one name (no hard link), checked again once open, handed to ffmpeg / ffprobe as a descriptor (fd protocol only).
 *
 * Cost (critique B7): frames live in a byte-bounded memory LRU (never written); ffmpeg and ffprobe share the engine's
 * ffmpeg slots with the run thumbnails (2 at once); at most RENDER_FRAME_QUEUE_MAX frame requests wait or run at once
 * (else `busy`, decided at arrival before the file is opened; outlines count too); a newer request of the same Studio
 * session and render supersedes the older one at arrival (its ffmpeg killed: newest wins — a request refused `busy`
 * supersedes nothing); each request ends within RENDER_FRAME_TIMEOUT_MS (else `unavailable`, reason `timeout`). A video
 * that does not start at 0 or has a variable frame rate is refused (frame times would not be frame numbers).
 */
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { isRenderId, projectPath, PROJECT_DIRS, projectRef, sameRender } from '@retake/core';
import { ffprobeBin } from '@retake/core/io';
import type { LoadedProject, RenderVariant, WorkPolicy } from '@retake/core';
import { CommentIndex, recordShapeOk, timecodeOf } from './comments.js';
import { EngineError } from './errors.js';
import { renderForWork } from './renders.js';
import type { RenderForWork } from './renders.js';
import type { Semaphore } from './run-thumbs.js';

/** Long side of a viewer frame, at most. */
export const RENDER_FRAME_MAX_PX = 1280;
/** JPEG quality of a viewer frame. */
export const RENDER_FRAME_QUALITY = 80;
/** One frame's base64, at most (the page's own cap on a sheet-sized data URL). */
export const RENDER_FRAME_BASE64_MAX = 2_000_000;
/** Frames held in memory, in base64 characters. */
export const RENDER_FRAME_CACHE_BYTES = 32 * 1024 * 1024;
/** Frame requests waiting or running at once (per engine), at most: past it, `busy`. */
export const RENDER_FRAME_QUEUE_MAX = 4;
/** A frame request ends (made, or `unavailable` with reason `timeout`) within this long. */
export const RENDER_FRAME_TIMEOUT_MS = 15_000;
/** Markers an outline lists, at most. */
export const RENDER_OUTLINE_MARKERS_MAX = 500;
/** A Studio session id (newest-wins key). */
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface RenderFrameRequest {
  render_id: string;
  /** The render record's `created_at` as the page read it: a reused id is a conflict. */
  created_at: string;
  frame: number;
}

export interface RenderFrameView {
  project: string;
  render_id: string;
  created_at: string;
  frame: number;
  time_s: number;
  timecode: string;
  mime: 'image/jpeg';
  base64: string;
  width: number;
  height: number;
}

export interface RenderOutlineRequest {
  render_id: string;
  /** When given, the render must still be that one (a conflict otherwise). */
  created_at?: string;
}

export interface RenderOutlineView {
  project: string;
  render_id: string;
  created_at: string;
  scenario: string;
  variant: RenderVariant;
  /** The video's own fps (= the record's, checked). */
  fps: number;
  /** Frames a comment and the viewer may name: 0 … frames − 1. */
  frames: number;
  width: number;
  height: number;
  duration_s: number;
  timecode: string;
  /** The plan's markers inside the frames (their names, from the scenario, under untrusted.markers at the same index). */
  markers: Array<{ frame: number; done?: number }>;
  /** Threads made on this render as it is now (its id and created_at), any status. */
  pins: Array<{ id: string; status: 'open' | 'resolved'; frame: number }>;
  untrusted: { markers: string[] };
}

/** What ffprobe reads of the open video. */
interface VideoProbe {
  fps: number;
  /** The average frame rate (frames over duration): ≠ fps for a variable frame rate. */
  avg_fps?: number;
  /** The first frame's time, in seconds (0 for every render the tool writes). */
  start_s?: number;
  frames?: number;
  width: number;
  height: number;
}

/**
 * An opened render video: its descriptor (closed by the caller; read by one child only — descriptors of one open share
 * their offset), its path and signature.
 */
interface Opened {
  record: RenderForWork & { variant: RenderVariant };
  fd: number;
  file: string;
  st: Stats;
  sig: string;
}

export interface RenderFramesOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  policy: WorkPolicy;
  /** The engine's ffmpeg slots (shared with the run thumbnails). */
  slots: Semaphore;
  ffmpeg?: string;
  ffprobe?: string;
  cacheBytes?: number;
  queueMax?: number;
  timeoutMs?: number;
  /** Thread summaries (the outline's pins). */
  comments?: CommentIndex;
}

type Review = typeof import('@retake/review/thumbs');
const review = (): Promise<Review> => import('@retake/review/thumbs');

/** ffprobe of an open descriptor (the fd protocol only); null when it cannot be read. */
function probeFd(fd: number, o: { ffprobe?: string; policy: WorkPolicy; signal: AbortSignal; timeoutMs: number }): Promise<VideoProbe | null> {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-protocol_whitelist', 'fd', '-f', 'mp4', '-fd', '3', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate,start_time,nb_frames,width,height', '-of', 'json', 'fd:'];
    const proc = spawn(ffprobeBin(o.policy, o.ffprobe), args, { stdio: ['ignore', 'pipe', 'ignore', fd] });
    let out = '';
    proc.stdout?.on('data', (c: Buffer) => {
      if (out.length < 64 * 1024) out += c.toString();
    });
    const kill = () => proc.kill('SIGKILL');
    const timer = setTimeout(kill, o.timeoutMs);
    o.signal.addEventListener('abort', kill, { once: true });
    const done = (v: VideoProbe | null) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', kill);
      resolve(v);
    };
    proc.on('error', () => done(null));
    proc.on('exit', (code) => {
      if (code !== 0) return done(null);
      try {
        const s = (JSON.parse(out) as { streams?: Array<Record<string, unknown>> }).streams?.[0];
        const rate = (v: unknown) => {
          const [num, den] = String(v ?? '0/1').split('/').map(Number);
          return den ? Math.round((num / den) * 1000) / 1000 : 0;
        };
        const fps = rate(s?.r_frame_rate);
        const avg = rate(s?.avg_frame_rate);
        const start = s?.start_time !== undefined ? Number(s.start_time) : undefined;
        const width = Number(s?.width ?? 0);
        const height = Number(s?.height ?? 0);
        const frames = s?.nb_frames !== undefined ? Number(s.nb_frames) : undefined;
        if (!(fps > 0) || !(width > 0) || !(height > 0)) return done(null);
        done({
          fps,
          width,
          height,
          ...(avg > 0 ? { avg_fps: avg } : {}),
          ...(start !== undefined && Number.isFinite(start) ? { start_s: start } : {}),
          ...(frames !== undefined && Number.isInteger(frames) && frames > 0 ? { frames } : {}),
        });
      } catch {
        done(null);
      }
    });
  });
}

/** A byte-bounded LRU (base64 length counted). */
class FrameCache {
  private readonly map = new Map<string, { base64: string; width: number; height: number }>();
  private bytes = 0;
  constructor(private readonly max: number) {}

  get(key: string) {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: { base64: string; width: number; height: number }): void {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.base64.length;
      this.map.delete(key);
    }
    if (v.base64.length > this.max) return;
    this.map.set(key, v);
    this.bytes += v.base64.length;
    while (this.bytes > this.max) {
      const [k, oldest] = this.map.entries().next().value as [string, { base64: string }];
      this.map.delete(k);
      this.bytes -= oldest.base64.length;
    }
  }
}

function stillThere(file: string, st: Stats): boolean {
  try {
    const l = lstatSync(file);
    return !l.isSymbolicLink() && l.ino === st.ino && l.dev === st.dev;
  } catch {
    return false;
  }
}

/** The frame service of one engine: its caches, its queue, its newest-wins table. */
export class RenderFrames {
  private readonly cache: FrameCache;
  private readonly probes = new Map<string, VideoProbe | null>();
  /** Requests waiting or running. */
  private readonly pending = new Set<AbortController>();
  /** `<project dir>\0<render id>\0<session>` → the request of that session in progress. */
  private readonly newest = new Map<string, AbortController>();
  readonly comments: CommentIndex;
  /** Counters for tests: frames made (ffmpeg runs), probes run, requests superseded, refused as busy. */
  readonly stats = { made: 0, probes: 0, superseded: 0, busy: 0 };

  constructor(private readonly o: RenderFramesOptions) {
    this.cache = new FrameCache(o.cacheBytes ?? RENDER_FRAME_CACHE_BYTES);
    this.comments = o.comments ?? new CommentIndex();
  }

  /** The record (shape, succeeded, files in the project, created_at as given) and its video opened (see the module comment). */
  private async open(project: LoadedProject, renderId: string, createdAt: string | undefined): Promise<Opened> {
    if (!isRenderId(renderId)) {
      throw new EngineError('invalid', `invalid render id "${String(renderId).slice(0, 80)}": <scenario>-v<N> (the renders list names them)`, { details: { argument: 'render_id' } });
    }
    // The one reader of renders/, by its id (renderForWork: its own file, no link, succeeded, its plan, its files in the
    // project), then what a message may quote: a render of its scenario (core renderIdOf) that core quotableRender takes.
    const record = await renderForWork(project, renderId);
    if (!recordShapeOk(record)) {
      throw new EngineError('refused', `${projectRef('renders', `${renderId}.json`)} has an id, scenario, created_at or variant the tool never writes: not used`);
    }
    // The render the page read, still (core sameRender: its id and its creation time).
    if (createdAt !== undefined && !sameRender(record, { id: renderId, created_at: createdAt })) {
      throw new EngineError('conflict', `render ${renderId} was replaced since it was read (another render now has its id): read the renders again`, {
        details: { current: record.created_at },
      });
    }
    const dir = projectPath(project.dir, 'renders');
    const d = await lstat(dir).catch(() => null);
    if (!d || d.isSymbolicLink() || !d.isDirectory()) throw new EngineError('refused', `${PROJECT_DIRS.renders}/ is not a real folder of the project: its videos are not shown`);
    const file = join(dir, `${renderId}.mp4`);
    const [realFile, realRecord] = await Promise.all([realpath(file).catch(() => null), realpath(record.file).catch(() => null)]);
    if (!realFile || realFile !== realRecord) throw new EngineError('refused', `${projectRef('renders', `${renderId}.json`)} names another file than ${projectRef('renders', `${renderId}.mp4`)}: not shown`);
    let fd: number;
    try {
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new EngineError('not_found', `the video of render ${renderId} is missing`);
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE') throw new EngineError('refused', `${projectRef('renders', `${renderId}.mp4`)} is a symbolic link: not shown`);
      throw new EngineError('refused', `${projectRef('renders', `${renderId}.mp4`)} cannot be opened: not shown`);
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new EngineError('refused', `${projectRef('renders', `${renderId}.mp4`)} is not a file: not shown`);
      if (st.nlink !== 1) throw new EngineError('refused', `${projectRef('renders', `${renderId}.mp4`)} has another name (a hard link): not shown`);
      if (!stillThere(file, st)) throw new EngineError('refused', `${projectRef('renders', `${renderId}.mp4`)} changed while it was opened: not shown`);
      return { record, fd, file, st, sig: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` };
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }

  /** The same file opened again for another child (its own offset): the same checks, the same inode. */
  private reopen(opened: Opened): number {
    const fd = openSync(opened.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== opened.st.ino || st.dev !== opened.st.dev || st.nlink !== 1) {
      closeSync(fd);
      throw new EngineError('refused', `${projectRef('renders', `${opened.record.id}.mp4`)} changed while it was read: not shown`);
    }
    return fd;
  }

  /**
   * The video's own fps and frames (ffprobe in one of the ffmpeg slots, memoised per file signature), checked against
   * the record; the frames a request may name.
   */
  private async bounds(opened: Opened, signal: AbortSignal, deadline: number): Promise<{ probe: VideoProbe; frames: number }> {
    const { record } = opened;
    let probe = this.probes.get(opened.sig);
    if (probe === undefined) {
      const release = await this.o.slots.acquire(signal).catch(() => {
        throw this.abortError(signal, record.id);
      });
      try {
        this.stats.probes++;
        const fd = this.reopen(opened);
        try {
          probe = await probeFd(fd, { ...(this.o.ffprobe ? { ffprobe: this.o.ffprobe } : {}), policy: this.o.policy, signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        } finally {
          closeSync(fd);
        }
      } finally {
        release();
      }
      if (signal.aborted) throw this.abortError(signal, record.id);
      if (this.probes.size > 256) this.probes.clear();
      this.probes.set(opened.sig, probe);
    }
    if (!probe) throw new EngineError('invalid', `the video of render ${record.id} cannot be read (ffprobe): not shown`);
    if (typeof record.fps !== 'number' || Math.abs(record.fps - probe.fps) > 1e-3 || record.plan?.fps !== record.fps) {
      throw new EngineError('refused', `${projectRef('renders', `${record.id}.json`)} says ${String(record.fps).slice(0, 20)} fps but its video holds ${probe.fps} fps: its frames cannot be told apart, not shown`);
    }
    // A frame is found by its time (F − 0.5) / fps: only a video that starts at 0 with a constant frame rate maps times
    // to frame numbers the way the still's frame select does (review B L4; a hand-replaced mp4).
    if (probe.start_s !== undefined && Math.abs(probe.start_s) >= 0.5 / probe.fps) {
      throw new EngineError('refused', `the video of render ${record.id} starts at ${probe.start_s} s, not 0: its frames cannot be told apart, not shown`);
    }
    if (probe.avg_fps !== undefined && Math.abs(probe.avg_fps - probe.fps) > 1e-3) {
      throw new EngineError('refused', `the video of render ${record.id} has a variable frame rate (${probe.avg_fps} fps on average, ${probe.fps} nominal): its frames cannot be told apart, not shown`);
    }
    const frames = Math.min(record.frames, record.plan.durationInFrames, probe.frames ?? Number.POSITIVE_INFINITY);
    if (!Number.isInteger(frames) || frames < 1) throw new EngineError('invalid', `render ${record.id} has no frame to show`);
    return { probe, frames };
  }

  private abortError(signal: AbortSignal, renderId: string): EngineError {
    const why = signal.reason as string | undefined;
    if (why === 'superseded') return new EngineError('cancelled', `a newer frame of render ${renderId} was asked: this one was dropped`, { details: { reason: 'superseded' } });
    // A timeout is not a full queue (review B L3): its own code, which the page says after a retry.
    if (why === 'timeout') return new EngineError('unavailable', `the frame of render ${renderId} took longer than ${(this.o.timeoutMs ?? RENDER_FRAME_TIMEOUT_MS) / 1000} s`, { details: { reason: 'timeout' } });
    return new EngineError('cancelled', 'cancelled');
  }

  /**
   * A request in: refused `busy` past RENDER_FRAME_QUEUE_MAX waiting or running (the one it would supersede not counted,
   * and left as it is when refused); else the same session's earlier request on this render is dropped (its ffmpeg
   * killed, its place freed) and this one becomes the newest. Synchronous: called before anything is awaited.
   */
  private admit(ctl: AbortController, key: string | undefined): void {
    const prev = key !== undefined ? this.newest.get(key) : undefined;
    const others = this.pending.size - (prev && this.pending.has(prev) ? 1 : 0);
    if (others >= (this.o.queueMax ?? RENDER_FRAME_QUEUE_MAX)) {
      this.stats.busy++;
      throw new EngineError('busy', 'the Studio is already making frames: try again in a moment', { details: { reason: 'queue_full' } });
    }
    if (prev) {
      this.stats.superseded++;
      this.pending.delete(prev);
      prev.abort('superseded');
    }
    if (key !== undefined) this.newest.set(key, ctl);
    this.pending.add(ctl);
  }

  /** One output frame of a render as a JPEG (see the module comment). `session`: the Studio session (newest wins). */
  async frame(project: LoadedProject, req: RenderFrameRequest, o: { session?: string; signal?: AbortSignal } = {}): Promise<RenderFrameView> {
    if (typeof req.created_at !== 'string') throw new EngineError('invalid', 'created_at is the created_at of the render as read', { details: { argument: 'created_at' } });
    if (typeof req.frame !== 'number' || !Number.isInteger(req.frame) || req.frame < 0) {
      throw new EngineError('invalid', `frame ${String(req.frame).slice(0, 40)}: an output frame number from 0`, { details: { argument: 'frame' } });
    }
    if (o.session !== undefined && (typeof o.session !== 'string' || !SESSION_RE.test(o.session))) throw new EngineError('invalid', 'a session id is 1 to 64 letters, digits, "-" or "_"');
    const timeoutMs = this.o.timeoutMs ?? RENDER_FRAME_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const ctl = new AbortController();
    const onOuter = () => ctl.abort('cancelled');
    if (o.signal?.aborted) throw new EngineError('cancelled', 'cancelled');
    const key = o.session !== undefined ? `${project.dir}\0${req.render_id}\0${o.session}` : undefined;
    // Before any await (review A L2 / N4): the bound, then newest wins — decided at arrival, never after the file is
    // opened. A request past the bound is refused without dropping the request it would have superseded.
    this.admit(ctl, key);
    o.signal?.addEventListener('abort', onOuter, { once: true });
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    let opened: Opened | undefined;
    try {
      opened = await this.open(project, req.render_id, req.created_at);
      if (ctl.signal.aborted) throw this.abortError(ctl.signal, req.render_id);
      const { record } = opened;
      const { probe, frames } = await this.bounds(opened, ctl.signal, deadline);
      if (req.frame >= frames) {
        throw new EngineError('invalid', `frame ${req.frame} is past the end of render ${record.id} (frames 0..${frames - 1})`, { details: { argument: 'frame' } });
      }
      const time_s = Math.round((req.frame / probe.fps) * 1000) / 1000;
      const view = (img: { base64: string; width: number; height: number }): RenderFrameView => ({
        project: project.slug,
        render_id: record.id,
        created_at: record.created_at,
        frame: req.frame,
        time_s,
        timecode: timecodeOf(time_s),
        mime: 'image/jpeg',
        ...img,
      });
      const cacheKey = `${opened.sig}\0${record.created_at}\0${req.frame}\0${RENDER_FRAME_MAX_PX}`;
      const hit = this.cache.get(cacheKey);
      if (hit) return view(hit);
      const r = await review();
      const release = await this.o.slots.acquire(ctl.signal).catch(() => {
        throw this.abortError(ctl.signal, record.id);
      });
      let png: Buffer | null;
      try {
        this.stats.made++;
        [png] = await r.videoFramesAt({ fds: [opened.fd] }, [(req.frame - 0.5) / probe.fps], {
          maxPx: RENDER_FRAME_MAX_PX,
          policy: this.o.policy,
          signal: ctl.signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
          ...(this.o.ffmpeg ? { ffmpeg: this.o.ffmpeg } : {}),
        });
      } catch (e) {
        if (ctl.signal.aborted) throw this.abortError(ctl.signal, record.id);
        throw new EngineError('internal', `frame ${req.frame} of render ${record.id} could not be read: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        release();
      }
      if (ctl.signal.aborted) throw this.abortError(ctl.signal, record.id);
      if (!png) throw new EngineError('not_found', `frame ${req.frame} of render ${record.id} is not in its video`);
      const jpeg = await r.thumbJpeg(png, { maxPx: RENDER_FRAME_MAX_PX, quality: RENDER_FRAME_QUALITY });
      const img = { base64: jpeg.data.toString('base64'), width: jpeg.width, height: jpeg.height };
      if (img.base64.length > RENDER_FRAME_BASE64_MAX) throw new EngineError('refused', `frame ${req.frame} of render ${record.id} is larger than ${RENDER_FRAME_BASE64_MAX} base64 characters: not shown`);
      this.cache.set(cacheKey, img);
      return view(img);
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onOuter);
      this.pending.delete(ctl);
      if (key !== undefined && this.newest.get(key) === ctl) this.newest.delete(key);
      if (opened) closeSync(opened.fd);
    }
  }

  /** What the viewer's slider needs of a render (see RenderOutlineView); the same checks and bounds as `frame`. */
  async outline(project: LoadedProject, req: RenderOutlineRequest): Promise<RenderOutlineView> {
    if (req.created_at !== undefined && typeof req.created_at !== 'string') throw new EngineError('invalid', 'created_at is the created_at of the render as read', { details: { argument: 'created_at' } });
    const timeoutMs = this.o.timeoutMs ?? RENDER_FRAME_TIMEOUT_MS;
    const ctl = new AbortController();
    // Bounded like the frames (review A N4): it holds a place of the queue while it reads and probes.
    this.admit(ctl, undefined);
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    let opened: Opened | undefined;
    try {
      opened = await this.open(project, req.render_id, req.created_at);
      const { record } = opened;
      const { probe, frames } = await this.bounds(opened, ctl.signal, Date.now() + timeoutMs);
      const markers: RenderOutlineView['markers'] = [];
      const names: string[] = [];
      for (const m of record.plan.markers ?? []) {
        if (markers.length >= RENDER_OUTLINE_MARKERS_MAX) break;
        if (!Number.isInteger(m.frame) || m.frame < 0 || m.frame >= frames) continue;
        markers.push({ frame: m.frame, ...(Number.isInteger(m.done) && (m.done as number) >= 0 && (m.done as number) < frames ? { done: m.done } : {}) });
        names.push(String(m.name ?? ''));
      }
      const { threads } = await this.comments.ofScenario(project.dir, record.scenario);
      const pins = threads
        .filter((t) => sameRender(record, { id: t.render_id, created_at: t.render_created_at }) && t.frame < frames)
        .map((t) => ({ id: t.id, status: t.status, frame: t.frame }))
        .sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
      const duration_s = Math.round((frames / probe.fps) * 1000) / 1000;
      return {
        project: project.slug,
        render_id: record.id,
        created_at: record.created_at,
        scenario: record.scenario,
        variant: record.variant,
        fps: probe.fps,
        frames,
        width: probe.width,
        height: probe.height,
        duration_s,
        timecode: timecodeOf(duration_s),
        markers,
        pins,
        untrusted: { markers: names },
      };
    } finally {
      clearTimeout(timer);
      this.pending.delete(ctl);
      if (opened) closeSync(opened.fd);
    }
  }
}
