import type {
  CaptureSettings,
  CursorSample,
  TimelineTrack,
  ViewportPreset,
  RunMode,
  Timeline,
  TimelineEvent,
  TimelineMarker,
  TimelinePageSegment,
  TimelineArtefact,
  TimelineScene,
  TimelineVideo,
} from '@demo-studio/core';
import { round3, wallNow } from './util.js';

/** Capture-time clock: seconds since t0 (the moment recording starts), on the wall clock of screencast frames. */
export class CaptureClock {
  constructor(public t0Wall: number = wallNow()) {}
  /** Current capture time in seconds (ms precision). */
  now(): number {
    return round3((wallNow() - this.t0Wall) / 1000);
  }
  /** Capture time of a wall-clock instant (epoch ms). */
  at(wallMs: number): number {
    return round3((wallMs - this.t0Wall) / 1000);
  }
}

/** Intervals without any new frame for at least `min` seconds (the screen did not change). */
export function computeIdle(frameTimes: number[], end: number, min = 0.5): Array<{ t_start: number; t_end: number }> {
  const ts = [...frameTimes].sort((a, b) => a - b);
  const out: Array<{ t_start: number; t_end: number }> = [];
  let prev = 0;
  for (const t of [...ts, end]) {
    if (t - prev >= min) out.push({ t_start: round3(prev), t_end: round3(t) });
    prev = Math.max(prev, t);
  }
  return out;
}

/**
 * Cursor samples closer than this belong to the same continuous move. Moves are dispatched at ~60 Hz, but a page
 * that renders slowly also slows the dispatch down (each input event waits for the renderer): stay tolerant.
 */
const MOVE_GAP_S = 0.25;
/** Moves shorter than this are too short to judge the capture frame rate. */
const MOVE_MIN_S = 0.2;

export interface MotionCapture {
  /** Continuous cursor moves long enough to be judged. */
  moves: number;
  /** Moves captured below the threshold frame rate. */
  slow: number;
  /** Lowest frame rate observed during a move, and when (capture time of the move start). */
  worst?: { fps: number; t: number };
}

/**
 * Frame rate the video actually shows while the cursor moves (the screen changes for sure then): the lower of the
 * screencast frames and the cursor positions dispatched per second. Moves below `minFps` look choppy; slow
 * rendering is the usual cause (no GPU, heavy effects).
 */
export function motionCapture(frameTimes: readonly number[], cursor: readonly CursorSample[], minFps: number): MotionCapture {
  const ts = [...frameTimes].sort((a, b) => a - b);
  const countIn = (a: number, b: number) => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ts[m] < a) lo = m + 1;
      else hi = m;
    }
    let n = 0;
    for (let i = lo; i < ts.length && ts[i] <= b; i++) n++;
    return n;
  };
  const out: MotionCapture = { moves: 0, slow: 0 };
  let start = 0;
  for (let i = 1; i <= cursor.length; i++) {
    if (i < cursor.length && cursor[i].t - cursor[i - 1].t < MOVE_GAP_S) continue;
    const first = start;
    start = i;
    const a = cursor[first]?.t;
    const b = cursor[i - 1]?.t;
    if (a === undefined || b === undefined || b - a < MOVE_MIN_S) continue;
    out.moves++;
    // What the video shows is bounded by both the frames captured and the cursor positions dispatched.
    const fps = Math.min(countIn(a, b), i - first) / (b - a);
    if (fps < minFps) out.slow++;
    if (!out.worst || fps < out.worst.fps) out.worst = { fps: round3(fps), t: a };
  }
  return out;
}

/** Append a cursor sample unless it repeats the last one (same place, visibility and button). */
export function pushCursorSample(list: CursorSample[], s: Omit<CursorSample, 't'> & { t: number }): void {
  const last = list[list.length - 1];
  if (last && last.x === s.x && last.y === s.y && last.visible === s.visible && !!last.down === !!s.down) return;
  const sample: CursorSample = { t: s.t, x: s.x, y: s.y, visible: s.visible };
  if (s.down) sample.down = true;
  list.push(sample);
}

/**
 * The track of one page of multi-page scenes (L2.11): its video, viewport, the intervals it was recorded, its URL
 * segments and its own cursor, on the capture clock.
 */
export class TrackBuilder {
  readonly recording: Array<{ t_start: number; t_end: number }> = [];
  readonly pages: TimelinePageSegment[] = [];
  readonly cursor: CursorSample[] = [];
  frames = 0;
  private since: number | null = null;

  constructor(
    readonly info: Pick<TimelineTrack, 'id' | 'file' | 'frames_file' | 'width' | 'height' | 'scale' | 'fps'> & { mobile?: boolean; touch?: boolean; preset?: ViewportPreset },
    private readonly clock: CaptureClock,
  ) {}

  get recordingNow(): boolean {
    return this.since !== null;
  }

  start(url?: string): void {
    if (this.since !== null) return;
    this.since = this.clock.now();
    this.pageSegment(url);
  }

  stop(): void {
    if (this.since === null) return;
    const t = this.clock.now();
    this.recording.push({ t_start: this.since, t_end: t });
    const cur = this.pages[this.pages.length - 1];
    if (cur && cur.t_start >= this.since - 1e-6) cur.t_end = t;
    this.since = null;
  }

  sampleCursor(s: Omit<CursorSample, 't'> & { t?: number }): void {
    pushCursorSample(this.cursor, { ...s, t: s.t ?? this.clock.now() });
  }

  /** A URL segment while recording (a navigation of the page). */
  pageSegment(url: string | undefined): void {
    if (this.since === null) return;
    const t = this.clock.now();
    const cur = this.pages[this.pages.length - 1];
    const inPeriod = cur !== undefined && cur.t_start >= this.since - 1e-6;
    if (inPeriod && cur.url === url) return;
    // A fresh tab's about:blank is never shown: its first navigation owns the segment.
    if (inPeriod && cur.url === 'about:blank' && url !== undefined) {
      cur.url = url;
      return;
    }
    if (inPeriod) {
      cur.t_end = t;
      if (cur.t_start === t) this.pages.pop();
    }
    this.pages.push({ id: this.info.id, t_start: t, t_end: t, ...(url !== undefined ? { url } : {}) });
  }

  build(end: number): TimelineTrack {
    if (this.since !== null) {
      this.recording.push({ t_start: this.since, t_end: end });
      const cur = this.pages[this.pages.length - 1];
      if (cur && cur.t_start >= this.since - 1e-6) cur.t_end = Math.max(cur.t_end, end);
      this.since = null;
    }
    const out: TimelineTrack = {
      id: this.info.id,
      file: this.info.file,
      frames_file: this.info.frames_file,
      width: this.info.width,
      height: this.info.height,
      scale: this.info.scale,
      ...(this.info.mobile ? { mobile: true } : {}),
      ...(this.info.touch ? { touch: true } : {}),
      ...(this.info.preset ? { preset: this.info.preset } : {}),
      fps: this.info.fps,
      frames: this.frames,
      recording: this.recording,
      pages: this.pages,
      cursor: this.cursor,
    };
    return out;
  }
}

export interface TimelineMeta {
  run_id: string;
  project: string;
  scenario: string;
  mode: RunMode;
  capture: CaptureSettings;
  /** The scenario's edit info (title, intro, outro, frame, template, music). */
  video?: TimelineVideo;
}

/** Collects scenes, events, markers, page segments and the cursor track during a run. */
export class TimelineBuilder {
  readonly scenes: TimelineScene[] = [];
  readonly events: TimelineEvent[] = [];
  readonly markers: TimelineMarker[] = [];
  readonly pages: TimelinePageSegment[] = [];
  readonly cursor: CursorSample[] = [];
  readonly warnings: string[] = [];
  readonly createdAt = new Date().toISOString();
  /** Captured emails, documents and notifications (the run's ArtefactStore items). */
  artefacts: TimelineArtefact[] = [];
  /** Per-page tracks of multi-page scenes (L2.11), in the order they were first recorded. */
  readonly tracks: TrackBuilder[] = [];

  constructor(
    public readonly meta: TimelineMeta,
    public readonly clock: CaptureClock,
  ) {}

  now(): number {
    return this.clock.now();
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  sampleCursor(s: Omit<CursorSample, 't'> & { t?: number }): void {
    pushCursorSample(this.cursor, { ...s, t: s.t ?? this.now() });
  }

  /** Close the current page segment and open a new one (page switch or main-frame navigation). */
  pageSegment(id: string, url: string | undefined): void {
    const t = this.now();
    const cur = this.pages[this.pages.length - 1];
    if (cur && cur.id === id && cur.url === url) return;
    // A fresh tab's about:blank is never shown: its first navigation owns the segment (as a browser's address
    // bar shows the URL being loaded).
    if (cur && cur.id === id && cur.url === 'about:blank' && url !== undefined) {
      cur.url = url;
      return;
    }
    if (cur) cur.t_end = t;
    if (cur && cur.t_start === t) this.pages.pop();
    this.pages.push({ id, t_start: t, t_end: t, url });
  }

  addScene(scene: TimelineScene): TimelineScene {
    this.scenes.push(scene);
    return scene;
  }

  addEvent(e: TimelineEvent): TimelineEvent {
    this.events.push(e);
    return e;
  }

  addMarker(m: TimelineMarker): void {
    this.markers.push(m);
  }

  /**
   * `frameTimes`: the frames of the main capture (single-page scenes); `idleFrameTimes` (default: the same) the frames
   * of every recorded page — the screen is idle only when none of them changed.
   */
  build(capture: { file: string; duration: number; frames: number; frameTimes: number[]; idleFrameTimes?: number[]; size?: { width: number; height: number } }): Timeline {
    const end = round3(capture.duration);
    const last = this.pages[this.pages.length - 1];
    if (last) last.t_end = Math.max(last.t_end, end);
    return {
      version: 1,
      run_id: this.meta.run_id,
      project: this.meta.project,
      scenario: this.meta.scenario,
      created_at: this.createdAt,
      mode: this.meta.mode,
      capture: {
        file: capture.file,
        width: capture.size?.width ?? this.meta.capture.width,
        height: capture.size?.height ?? this.meta.capture.height,
        scale: this.meta.capture.scale,
        fps: this.meta.capture.fps,
        duration: end,
        t0_wall: Math.round(this.clock.t0Wall),
        frames: capture.frames,
      },
      ...(this.meta.video ? { video: this.meta.video } : {}),
      scenes: this.scenes,
      events: this.events,
      markers: this.markers,
      pages: this.pages,
      cursor: this.cursor,
      idle: this.meta.mode === 'capture' ? computeIdle(capture.idleFrameTimes ?? capture.frameTimes, end) : [],
      ...(this.artefacts.length ? { artefacts: this.artefacts } : {}),
      ...(this.tracks.length ? { tracks: this.tracks.map((t) => t.build(end)) } : {}),
      warnings: this.warnings,
    };
  }
}
