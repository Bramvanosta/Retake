import type {
  CaptureSettings,
  CursorEffect,
  CursorSample,
  TimelineTrack,
  ViewportPreset,
  RunMode,
  Timeline,
  TimelineEvent,
  TimelineBusy,
  TimelineLoadingUi,
  TimelineLoading,
  TimelinePause,
  TimelineStall,
  TimelineMarker,
  TimelinePageSegment,
  TimelineArtefact,
  TimelineEnvironment,
  TimelineScene,
  TimelineVideo,
} from '@retake/core/model';
import { round3, wallNow } from './util.js';

/**
 * Capture-time clock: seconds since t0 (the moment recording starts), on the wall clock of screencast frames, less the
 * pauses of the take (L4.4, R-UI-19): capture time stands still during a pause, so the video goes on from where it
 * paused. Every wall time converts through the list of pauses — also one recorded before a pause and converted after it
 * (a held page load, critique B1); a wall time inside a pause (open or closed) is the pause instant. `t0Wall` never moves.
 */
export class CaptureClock {
  /** The pauses (wall ms; `to` undefined while one is open), in order. */
  private readonly pauses: Array<{ from: number; to?: number }> = [];
  constructor(public t0Wall: number = wallNow()) {}
  /** Current capture time in seconds (ms precision). */
  now(): number {
    return this.at(wallNow());
  }
  /** Capture time of a wall-clock instant (epoch ms). */
  at(wallMs: number): number {
    let w = wallMs;
    let off = 0;
    for (const p of this.pauses) {
      if (w < p.from) break;
      if (p.to === undefined || w <= p.to) {
        w = p.from;
        break;
      }
      off += p.to - p.from;
    }
    return round3((w - this.t0Wall - off) / 1000);
  }
  /** A pause is open. */
  get paused(): boolean {
    return this.pauses.length > 0 && this.pauses[this.pauses.length - 1].to === undefined;
  }
  /** Wall ms the pauses took out of capture time so far (an open one up to now). */
  get pausedMs(): number {
    return this.pauses.reduce((n, p) => n + ((p.to ?? wallNow()) - p.from), 0);
  }
  /** Capture time stops at wall time `wall` (default now) until `resume`; returns the capture time it stops at. */
  pause(wall: number = wallNow()): number {
    if (this.paused) throw new Error('the capture clock is paused already');
    const last = this.pauses[this.pauses.length - 1];
    const from = last?.to !== undefined ? Math.max(wall, last.to) : wall;
    this.pauses.push({ from });
    return this.at(from);
  }
  /** Capture time goes on from wall time `wall` (default now; never before the pause began); returns the ms taken out. */
  resume(wall: number = wallNow()): number {
    const p = this.pauses[this.pauses.length - 1];
    if (!p || p.to !== undefined) throw new Error('the capture clock is not paused');
    p.to = Math.max(wall, p.from);
    return p.to - p.from;
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
/**
 * A frame gap at least this long while the cursor moves or a click ripple plays is a visible freeze (≥ 4–5 frames at
 * 30 fps). Shorter hitches (100–130 ms) remain on a Mac when the cursor enters an element with a hover effect: noise
 * a warning would repeat on every capture (L1.3).
 */
export const STALL_MIN_S = 0.15;
/** How long a click ripple animates after the press (kit: .5 s scale, .55 s fade). */
export const RIPPLE_S = 0.55;

export interface CaptureStall {
  /** Capture time (s) of the last frame before the gap. */
  t: number;
  /** Capture time (s) of the first frame after it. */
  t_end: number;
  /** Length of the frozen part (ms) that overlaps the motion or the ripple. */
  ms: number;
  during: 'move' | 'ripple';
}

export interface MotionCapture {
  /** Continuous cursor moves long enough to be judged. */
  moves: number;
  /** Moves captured below the threshold frame rate. */
  slow: number;
  /** Lowest frame rate observed during a move, and when (capture time of the move start). */
  worst?: { fps: number; t: number };
  /** Frame gaps ≥ STALL_MIN_S while the cursor moved or a click ripple played (L1.3): the capture froze there. */
  stalls: CaptureStall[];
}

/**
 * Frame rate the video actually shows while the cursor moves (the screen changes for sure then), on the motion
 * itself — from a move's first sample to its last change of position, not the rest and the press before a click: the
 * lower of the screencast frames and the cursor positions dispatched per second. Moves below `minFps` look choppy;
 * slow rendering is the usual cause (no GPU, heavy effects). Also reports the stalls: frame gaps of STALL_MIN_S or
 * more inside a motion or a click ripple (`effects`), which a per-move average hides — except around a page change
 * (`pageChanges`: the new page renders), over a page load the recorder held (`held`, R-ISS-08) and an isolated 1 px
 * nudge (the cursor waiting for a fresh frame).
 */
export function motionCapture(
  frameTimes: readonly number[],
  samples: readonly CursorSample[],
  minFps: number,
  effects: readonly CursorEffect[] = [],
  pageChanges: readonly number[] = [],
  held: ReadonlyArray<{ t_start: number; t_end: number }> = [],
): MotionCapture {
  const ts = [...frameTimes].sort((a, b) => a - b);
  // 1 px nudges (Runtime.awaitFreshFrame probing the capture while the cursor rests) are no motion: a step under 2 px
  // that the next sample takes straight back, or that stays alone more than 30 ms (a glide moves every ≈ 16 ms).
  const cursor = samples.filter((s, i) => {
    const prev = samples[i - 1];
    const next = samples[i + 1];
    if (!prev || Math.hypot(s.x - prev.x, s.y - prev.y) >= 2) return true;
    const back = !!next && next.x === prev.x && next.y === prev.y;
    return !(back || !next || next.t - s.t > 0.03);
  });
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
  const out: MotionCapture = { moves: 0, slow: 0, stalls: [] };
  const busy: Array<[number, number, CaptureStall['during']]> = [];
  let start = 0;
  for (let i = 1; i <= cursor.length; i++) {
    if (i < cursor.length && cursor[i].t - cursor[i - 1].t < MOVE_GAP_S) continue;
    const first = start;
    start = i;
    // The motion: up to the last sample that changed the position (press / release samples repeat it).
    let last = i - 1;
    while (last > first && cursor[last].x === cursor[last - 1].x && cursor[last].y === cursor[last - 1].y) last--;
    const a = cursor[first]?.t;
    const b = cursor[last]?.t;
    if (a === undefined || b === undefined || b <= a) continue;
    busy.push([a, b, 'move']);
    if (b - a < MOVE_MIN_S) continue;
    out.moves++;
    // What the video shows is bounded by both the frames captured and the cursor positions dispatched.
    const fps = Math.min(countIn(a, b), last - first + 1) / (b - a);
    if (fps < minFps) out.slow++;
    if (!out.worst || fps < out.worst.fps) out.worst = { fps: round3(fps), t: a };
  }
  for (const e of effects) if (e.type === 'ripple') busy.push([e.t, e.t + RIPPLE_S, 'ripple']);
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1];
    const b = ts[i];
    if (b - a < STALL_MIN_S) continue;
    // A page that changes (navigation, new route) renders its new content: that wait is the product's loading. A page
    // load the recorder held (R-ISS-08: no frame until it painted) is that loading too.
    if (pageChanges.some((t) => t > a - 0.3 && t < b)) continue;
    if (held.some((h) => h.t_start < b && h.t_end >= a)) continue;
    let best: CaptureStall | undefined;
    for (const [x, y, during] of busy) {
      const ov = Math.min(b, y) - Math.max(a, x);
      if (ov >= STALL_MIN_S && (!best || ov * 1000 > best.ms)) best = { t: round3(a), t_end: round3(b), ms: Math.round(ov * 1000), during };
    }
    if (best) out.stalls.push(best);
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

/** Append a cursor effect (L2.13) unless it repeats the icon already shown. */
export function pushCursorEffect(list: CursorEffect[], e: CursorEffect): void {
  if (e.type === 'icon') {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].type !== 'icon') continue;
      if (list[i].icon === e.icon) return;
      break;
    }
  }
  list.push({ ...e, t: round3(e.t) });
}

/** Effects in time order (the kit reports them asynchronously). */
function sortedEffects(list: readonly CursorEffect[]): CursorEffect[] {
  return [...list].sort((a, b) => a.t - b.t);
}

/**
 * The track of one page of multi-page scenes (L2.11): its video, viewport, the intervals it was recorded, its URL
 * segments and its own cursor, on the capture clock.
 */
export class TrackBuilder {
  readonly recording: Array<{ t_start: number; t_end: number }> = [];
  readonly pages: TimelinePageSegment[] = [];
  readonly cursor: CursorSample[] = [];
  /** Icon changes, presses and ripples of this page's cursor (L2.13). */
  readonly cursorEffects: CursorEffect[] = [];
  /** Page loads its recorder held (R-ISS-08), set when the run ends. */
  loading: TimelineLoading[] = [];
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

  cursorEffect(e: CursorEffect): void {
    pushCursorEffect(this.cursorEffects, e);
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
      ...(this.cursorEffects.length ? { cursor_effects: sortedEffects(this.cursorEffects) } : {}),
      ...(this.loading.length ? { loading: this.loading } : {}),
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
  /** Captured without the in-page cursor (raw export, L2.13). */
  cursor?: 'hidden';
}

/** Collects scenes, events, markers, page segments and the cursor track during a run. */
export class TimelineBuilder {
  readonly scenes: TimelineScene[] = [];
  readonly events: TimelineEvent[] = [];
  readonly markers: TimelineMarker[] = [];
  readonly pages: TimelinePageSegment[] = [];
  readonly cursor: CursorSample[] = [];
  /** Icon changes, presses and ripples of the main capture's cursor (L2.13). */
  readonly cursorEffects: CursorEffect[] = [];
  readonly warnings: string[] = [];
  readonly createdAt = new Date().toISOString();
  /** Captured emails, documents and notifications (the run's ArtefactStore items). */
  artefacts: TimelineArtefact[] = [];
  /** Per-page tracks of multi-page scenes (L2.11), in the order they were first recorded. */
  readonly tracks: TrackBuilder[] = [];
  /** Page loads the main capture held (R-ISS-08), set when the run ends. */
  loading: TimelineLoading[] = [];
  /** Where the main capture froze while the cursor moved or a ripple played (L5.7), set when the run ends. */
  stalls: TimelineStall[] = [];
  /** Waits the main capture showed after clicks (L5.7, R-FLD-26), set when the run ends. */
  busy: TimelineBusy[] = [];
  /** Hotfix v0.2.6: loading indicators in the filmed page (LoadingWatch). */
  loading_ui: TimelineLoadingUi[] = [];
  /** Where the take was paused between steps (L4.4). */
  readonly pauses: TimelinePause[] = [];
  /** The run's environment (L1.7): access, display table, clock; the read-only guard appends to `writes`. */
  environment?: TimelineEnvironment;

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

  cursorEffect(e: CursorEffect): void {
    pushCursorEffect(this.cursorEffects, e);
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
        ...(this.meta.cursor ? { cursor: this.meta.cursor } : {}),
      },
      ...(this.meta.video ? { video: this.meta.video } : {}),
      scenes: this.scenes,
      events: this.events,
      markers: this.markers,
      pages: this.pages,
      cursor: this.cursor,
      ...(this.cursorEffects.length ? { cursor_effects: sortedEffects(this.cursorEffects) } : {}),
      idle: this.meta.mode === 'capture' ? computeIdle(capture.idleFrameTimes ?? capture.frameTimes, end) : [],
      ...(this.loading.length ? { loading: this.loading } : {}),
      ...(this.stalls.length ? { stalls: this.stalls } : {}),
      ...(this.busy.length ? { busy: this.busy } : {}),
      ...(this.loading_ui.length ? { loading_ui: this.loading_ui } : {}),
      ...(this.pauses.length ? { pauses: this.pauses } : {}),
      ...(this.artefacts.length ? { artefacts: this.artefacts } : {}),
      ...(this.tracks.length ? { tracks: this.tracks.map((t) => t.build(end)) } : {}),
      ...(this.environment ? { environment: this.environment } : {}),
      warnings: this.warnings,
    };
  }
}
