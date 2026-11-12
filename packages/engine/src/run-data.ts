/**
 * What the scenario screen needs of a run (L4.2): run.json, timeline.json, the scenario snapshot, the dry-run
 * screenshots' names, frame indexes — read through RunFolder (critique B6) and held in memory, keyed by the run folder
 * and the signatures of its files (critique B4: by run id + the run's own keys, never today's scenario). Nothing here
 * writes a file.
 *
 * The frame of a step (critique B3): the picture on screen at the end of the step, after its hold — capture time
 * T = `hold.t_end ?? t_end` — on the capture's CFR grid, as the runner's encoder made the video (runner-web
 * cfrSchedule): output frame n = min(floor(T·fps), frames − 1) with frames = round(duration·fps); kept frames give the
 * latest frame stamped at or before n/fps (+ 0.5 ms), the video the frame at n (seek to (n − ¼)/fps: an input seek
 * returns the first frame at or after the time). Both sources therefore give the same picture, the last step's
 * included (its hold ends at the very end of the capture, past the last frame's start).
 */
import type { Timeline, TimelineEvent, TimelineScene, TimelineTrack } from '@retake/core/model';
import { ACTION_NAMES } from '@retake/core/model';
import { SCENARIO_COMPARE_MAX_BYTES } from '@retake/core/scenario';
import { parseRunRecord } from '@retake/core/run';
import { parseTimeline } from '@retake/core/run';
import { RUN_RECORD_MAX, TIMELINE_MAX } from '@retake/core/io';
import { RUN_FRAME_NAME_RE, RunFolder, TRACK_FRAMES_RE, TRACK_VIDEO_RE, lsig } from './run-files.js';
import { listedRecord } from './runs.js';
import type { RunRecordOnDisk } from './runs.js';

/** run.json and timeline.json larger than this are not read (not files the runner wrote). */
export const RUN_JSON_MAX = RUN_RECORD_MAX;
export { TIMELINE_MAX };
/** A frame index (frames.jsonl: ≈ 33 bytes per frame) larger than this is not read. */
export const FRAME_INDEX_MAX = 32 * 1024 * 1024;
/** Runs held in memory at once. */
const RUN_DATA_CACHE = 6;
/** A frame stamped this close after an output tick still counts for that tick (as runner-web cfrSchedule). */
const TICK_EPS_S = 0.0005;

const ACTIONS: ReadonlySet<string> = new Set(ACTION_NAMES);

/** File-name-safe slug of a scene id, as the runner names screenshots (runner-web fileSlug). */
export function fileSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** A dry run's picture of a step: `<scene>-<NN>-<action>.png` (runner-web scenes.ts dryScreenshot). */
export function stepScreenshotName(scene: string, step: number, action: string): string | undefined {
  return ACTIONS.has(action) ? `${fileSlug(scene)}-${String(step).padStart(2, '0')}-${action}.png` : undefined;
}

/** A failed step's picture: `error-<scene>-<step>.png` (unpadded; both modes). */
export function errorScreenshotName(scene: string, step: number): string {
  return `error-${fileSlug(scene)}-${step}.png`;
}

/** Output frame of capture time `t` on a CFR grid of `count` frames (critique B3: floor, clamped to the last frame). */
export function gridFrame(t: number, fps: number, count: number): number {
  if (!(fps > 0) || !Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(Math.max(1, count) - 1, Math.floor(t * fps + 1e-6)));
}

/** The time an input seek must ask for to land on output frame n (first frame at or after it). */
export function seekTime(n: number, fps: number): number {
  return Math.max(0, (n - 0.25) / fps);
}

/** A frame index: entries sorted by time, names validated. */
export interface FrameIndex {
  files: string[];
  times: number[];
}

/** The entry of `index` on screen at output frame n (latest with t ≤ n/fps + ε among t ≤ end; the first otherwise). */
export function frameAt(index: FrameIndex, n: number, fps: number, end: number): number {
  const tick = n / fps + TICK_EPS_S;
  let lo = 0;
  let hi = index.times.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = index.times[mid];
    if (t <= tick && t <= end) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best < 0 ? 0 : best;
}

/** Parse a frames.jsonl: `{file, t}` per line; a line with another name or no finite time is left out. */
export function parseFrameIndex(text: string): FrameIndex {
  const rows: Array<{ file: string; t: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { file?: unknown; t?: unknown };
      if (typeof v.file === 'string' && RUN_FRAME_NAME_RE.test(v.file) && typeof v.t === 'number' && Number.isFinite(v.t)) rows.push({ file: v.file, t: v.t });
    } catch {
      /* not a line the recorder wrote */
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return { files: rows.map((r) => r.file), times: rows.map((r) => r.t) };
}

/** Where the pictures of a step's page come from in a capture: its frames (folder + index) and its video. */
export interface PageSource {
  /** '' = the main capture; else the track id. */
  track: string;
  framesFile: string;
  framesFolder: string;
  video: string;
  fps: number;
  /** Output frames of its video. */
  count: number;
  /** Capture time the video ends at. */
  end: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One run as read: its record, timeline (events by "<scene>.<step>"), snapshot and screenshot names. */
export class RunData {
  private readonly frameIndexes = new Map<string, Promise<FrameIndex | null>>();
  readonly scenes = new Map<string, TimelineScene>();
  readonly events = new Map<string, TimelineEvent>();

  constructor(
    readonly folder: RunFolder,
    /** Signature of the files read (a change re-reads the run). */
    readonly sig: string,
    readonly record: RunRecordOnDisk | undefined,
    readonly timeline: Timeline | undefined,
    /** The run's `scenario.yaml` (undefined: missing, a link, too large, unreadable). */
    readonly snapshot: string | undefined,
    /** File names of screenshots/ (empty when it is missing or a link). */
    readonly screenshots: ReadonlySet<string>,
  ) {
    for (const s of timeline?.scenes ?? []) if (isObj(s) && typeof s.id === 'string' && !this.scenes.has(s.id)) this.scenes.set(s.id, s);
    for (const e of timeline?.events ?? []) {
      // scene_open, scene_still and notifications have step −1: they belong to no step (critique B12).
      if (!isObj(e) || typeof e.scene !== 'string' || !Number.isInteger(e.step) || e.step < 0 || !ACTIONS.has(e.action)) continue;
      const key = `${e.scene}.${e.step}`;
      if (!this.events.has(key)) this.events.set(key, e);
    }
  }

  get id(): string {
    return this.folder.id;
  }

  get mode(): 'capture' | 'dry' | undefined {
    return this.record?.mode ?? this.timeline?.mode;
  }

  /** The page source of an event of a capture (its track in a multi-page scene), or undefined. */
  pageSource(ev: TimelineEvent): PageSource | undefined {
    const tl = this.timeline;
    if (!tl || !isObj(tl.capture)) return undefined;
    const duration = Number(tl.capture.duration);
    if (!Number.isFinite(duration) || duration <= 0) return undefined;
    const scene = this.scenes.get(ev.scene);
    if (scene && Array.isArray(scene.pages) && scene.pages.length > 0) {
      // The page the step acted on (the runner records it: ev.page), else the scene's first page.
      const page = scene.pages.find((p) => isObj(p) && p.id === ev.page) ?? scene.pages[0];
      const track: TimelineTrack | undefined = (tl.tracks ?? []).find((t) => isObj(t) && t.id === page?.track);
      if (!track || typeof track.frames_file !== 'string' || typeof track.file !== 'string') return undefined;
      if (!TRACK_FRAMES_RE.test(track.frames_file) || !TRACK_VIDEO_RE.test(track.file)) return undefined;
      const fps = Number(track.fps);
      if (!(fps > 0)) return undefined;
      return { track: track.id, framesFile: track.frames_file, framesFolder: track.frames_file.replace(/\.jsonl$/, ''), video: track.file, fps, count: Math.max(1, Math.round(duration * fps)), end: duration };
    }
    const fps = Number(tl.capture.fps);
    if (!(fps > 0)) return undefined;
    return { track: '', framesFile: 'frames.jsonl', framesFolder: 'frames', video: 'capture.mp4', fps, count: Math.max(1, Math.round(duration * fps)), end: duration };
  }

  /** A frame index of the run (cached; null when missing, a link, too large or unreadable). */
  frameIndex(file: string): Promise<FrameIndex | null> {
    let p = this.frameIndexes.get(file);
    if (!p) {
      p = this.folder.read(file, FRAME_INDEX_MAX).then((r) => (r.ok ? parseFrameIndex(r.bytes.toString('utf8')) : null));
      this.frameIndexes.set(file, p);
    }
    return p;
  }
}

async function readJson(folder: RunFolder, name: string, max: number): Promise<unknown> {
  const r = await folder.read(name, max);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The files whose signatures make a run's cache key (plus every page track's files: trackFiles). */
const SIGNED = ['run.json', 'timeline.json', 'scenario.yaml', 'screenshots', 'frames.jsonl', 'capture.mp4', 'frames'];

/** The page tracks' files of a run folder (`frames-<page>.jsonl`, `capture-<page>.mp4` and their frame folders), sorted. */
async function trackFiles(folder: RunFolder): Promise<string[]> {
  return (await folder.names()).filter((n) => TRACK_FRAMES_RE.test(n) || TRACK_VIDEO_RE.test(n) || TRACK_FRAMES_RE.test(`${n}.jsonl`)).sort();
}

/** Runs read, in memory (a small LRU by run folder; an entry is used while its files' signatures hold). */
export class RunDataCache {
  private readonly entries = new Map<string, Promise<RunData | null>>();
  private readonly sigs = new Map<string, string>();
  /** Runs read from files (tests: a repeat reads nothing). */
  reads = 0;

  async get(projectDir: string, runId: string): Promise<RunData | null> {
    const folder = await RunFolder.open(projectDir, runId);
    if (!folder) return null;
    // A multi-page run's pictures are in its tracks' files: their signatures count too (review A #8).
    const sig = (await Promise.all([...SIGNED, ...(await trackFiles(folder))].map(async (n) => `${n}=${await folder.sig(n)}`))).join('|');
    const key = folder.dir;
    const cached = this.entries.get(key);
    if (cached && this.sigs.get(key) === sig) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const p = this.load(folder, sig);
    this.entries.delete(key);
    this.entries.set(key, p);
    this.sigs.set(key, sig);
    while (this.entries.size > RUN_DATA_CACHE) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.sigs.delete(oldest);
    }
    return p;
  }

  private async load(folder: RunFolder, sig: string): Promise<RunData | null> {
    this.reads++;
    const [recordValue, timelineValue, snap, shots] = await Promise.all([
      readJson(folder, 'run.json', RUN_JSON_MAX),
      readJson(folder, 'timeline.json', TIMELINE_MAX),
      folder.read('scenario.yaml', SCENARIO_COMPARE_MAX_BYTES),
      folder.list('screenshots'),
    ]);
    // The bytes are the confined folder's (RunFolder); what they are is the one parse boundary's to say (core run-record.ts).
    const record = recordValue === undefined ? undefined : listedRecord(parseRunRecord(recordValue));
    const read = timelineValue === undefined ? undefined : parseTimeline(timelineValue);
    const timeline = read?.ok ? read.value : undefined;
    return new RunData(folder, sig, record, timeline, snap.ok ? snap.bytes.toString('utf8') : undefined, new Set(shots ?? []));
  }
}

/** Which kind of pictures a run folder holds, from a few lstats (nothing parsed): what the run picker says. */
export async function runPictures(projectDir: string, runId: string, mode: string | undefined): Promise<'screenshots' | 'frames' | 'video' | null> {
  const folder = await RunFolder.open(projectDir, runId);
  if (!folder) return null;
  if (mode === 'dry') {
    const names = await folder.list('screenshots');
    return names?.some((n) => n.endsWith('.png')) ? 'screenshots' : null;
  }
  const index = await lsig(`${folder.dir}/frames.jsonl`);
  if (index !== '-' && (await folder.folder('frames')).ok) return 'frames';
  if ((await folder.video('capture.mp4')).ok) return 'video';
  // A scenario made only of multi-page scenes has its frames in per-page folders.
  const names = await folder.names();
  if (names.some((n) => TRACK_FRAMES_RE.test(n))) return 'frames';
  if (names.some((n) => TRACK_VIDEO_RE.test(n))) return 'video';
  const errors = await folder.list('screenshots');
  return errors?.some((n) => n.endsWith('.png')) ? 'screenshots' : null;
}
