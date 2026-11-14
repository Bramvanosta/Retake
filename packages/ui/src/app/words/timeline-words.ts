/**
 * The timeline screen's pure pieces (L4.5 part C): timecodes, the checks of the preview's two capability URLs, the
 * capture's codec as a media type and in words, what a key does, and the words of a frame (the scrubber's value text).
 * No DOM here (unit-tested in Node); TimelineScreen.tsx and PreviewFrame.tsx use them.
 */
import type { TimelineView } from '@retake/engine';

type Model = TimelineView['model'];

/** A frame as "m:ss.cc" (hundredths), or "h:mm:ss.cc" past an hour. */
export function timecode(frame: number, fps: number): string {
  const cs = Math.max(0, Math.round((frame / (fps > 0 ? fps : 30)) * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(c)}` : `${m}:${pad(s)}.${pad(c)}`;
}

/** The frame document of the player origin: `http://127.0.0.1:<port>/s/<capability>/frame`, nothing else. */
export const FRAME_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/s\/[A-Za-z0-9_-]{43}\/frame$/;
/** A preview plan of the same capability: `<origin>/m/<capability>/plan/<id>.json`. */
const PLAN_URL_RE = /^(http:\/\/127\.0\.0\.1:\d{1,5})\/m\/([A-Za-z0-9_-]{43})\/plan\/[A-Za-z0-9_-]{22}\.json$/;

/**
 * The preview's frame and plan URLs as timeline_view gave them, when both are what the player origin serves — one
 * origin, one capability — else null (the screen then shows no preview: the frame's `src` is never anything else).
 */
export function previewUrls(frameUrl: unknown, planUrl: unknown): { frame: string; plan: string } | null {
  if (typeof frameUrl !== 'string' || typeof planUrl !== 'string' || !FRAME_URL_RE.test(frameUrl)) return null;
  const p = PLAN_URL_RE.exec(planUrl);
  if (!p || frameUrl !== `${p[1]}/s/${p[2]}/frame`) return null;
  return { frame: frameUrl, plan: planUrl };
}

/** The capture's codec (ffprobe's name) as a media type a browser can be asked about, or null (unknown: assumed playable). */
export function codecType(codec: string | undefined): string | null {
  switch (codec) {
    case 'h264':
      return 'video/mp4; codecs="avc1.640028"';
    case 'hevc':
      return 'video/mp4; codecs="hvc1.1.6.L93.B0"';
    case 'vp9':
      return 'video/mp4; codecs="vp09.00.10.08"';
    case 'av1':
      return 'video/mp4; codecs="av01.0.04M.08"';
    default:
      return null;
  }
}

/** The codec in words ("H.264"), or its ffprobe name. */
export function codecWords(codec: string | undefined): string {
  return codec === 'h264' ? 'H.264' : codec === 'hevc' ? 'HEVC (H.265)' : codec === 'vp9' ? 'VP9' : codec === 'av1' ? 'AV1' : (codec ?? 'unknown');
}

/** What the browser says about a media type (MediaSource, else Media Capabilities). */
export interface CodecProbe {
  isTypeSupported?: (type: string) => boolean;
  decodingInfo?: (cfg: { type: 'file'; video: { contentType: string; width: number; height: number; bitrate: number; framerate: number } }) => Promise<{ supported: boolean }>;
}

/**
 * Whether this browser plays the capture's codec (plan D3, critique B14). Playwright's Chromium plays no H.264; the
 * real Chrome, Safari and Firefox on macOS do. Unknown codec or no way to ask: playable (the frame says if it fails).
 */
export async function canPlay(codec: string | undefined, probe: CodecProbe, size: { width: number; height: number; fps: number }): Promise<boolean> {
  const type = codecType(codec);
  if (!type) return true;
  if (probe.isTypeSupported) return probe.isTypeSupported(type);
  if (probe.decodingInfo) {
    try {
      return (await probe.decodingInfo({ type: 'file', video: { contentType: type, width: size.width, height: size.height, bitrate: 4_000_000, framerate: size.fps } })).supported;
    } catch {
      return true;
    }
  }
  return true;
}

/** The message a browser that cannot play the take gets (critique Q5: a message only; a proxy is backlog). */
export function cannotPlayWords(codec: string | undefined): string {
  return `This browser cannot play the take's ${codecWords(codec)} video: open the Studio in Chrome, Safari or Firefox. The tracks still work.`;
}

export type KeyAction = { kind: 'toggle' } | { kind: 'step'; frames: number } | { kind: 'seconds'; seconds: number } | { kind: 'home' } | { kind: 'end' } | { kind: 'segment'; dir: -1 | 1 };

/** Where a key was pressed: what the screen needs to know to leave a control its own keys. */
export interface KeyTarget {
  tag: string;
  type?: string;
  editable?: boolean;
  /** Inside a radio group (the inspector's choices, part D). */
  inRadioGroup?: boolean;
}

/**
 * What a key does on the timeline screen (plan D11, critique "smaller points"): Space play / pause, ← / → one frame,
 * Shift+← / → one second, Home / End, [ / ] the previous / next segment — never while typing (an input, a select, a
 * text area, an editable element) or in a radio group (its arrows move the choice); on the scrubber (a range input) its
 * own arrows, Home and End move it (no double step) and Space, [ / ] and Shift+← / → are the screen's; on a button or a
 * link Space is its own (it activates it).
 */
export function keyAction(e: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, t: KeyTarget): KeyAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const tag = t.tag.toLowerCase();
  if (t.editable || tag === 'textarea' || tag === 'select' || t.inRadioGroup) return null;
  const range = tag === 'input' && t.type === 'range';
  if (tag === 'input' && !range) return null;
  const space = e.key === ' ' || e.key === 'Spacebar';
  if (space) return tag === 'button' || tag === 'a' || tag === 'summary' ? null : { kind: 'toggle' };
  // The scrubber keeps its own arrows (one frame), Home and End; [ / ] and Shift+← → do what the keys line says there too
  // (L5.12a fixes, review A-L2: the caller's preventDefault stops the range's own step).
  if (range && !(e.key === '[' || e.key === ']' || (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')))) return null;
  switch (e.key) {
    case 'ArrowLeft':
      return e.shiftKey ? { kind: 'seconds', seconds: -1 } : { kind: 'step', frames: -1 };
    case 'ArrowRight':
      return e.shiftKey ? { kind: 'seconds', seconds: 1 } : { kind: 'step', frames: 1 };
    case 'Home':
      return { kind: 'home' };
    case 'End':
      return { kind: 'end' };
    case '[':
      return { kind: 'segment', dir: -1 };
    case ']':
      return { kind: 'segment', dir: 1 };
    default:
      return null;
  }
}

/** The frame a key action moves to (within [0, frames - 1]). */
export function targetFrame(a: Exclude<KeyAction, { kind: 'toggle' }>, frame: number, m: Pick<Model, 'frames' | 'fps' | 'segments'>): number {
  const last = Math.max(0, m.frames - 1);
  const clamp = (f: number) => Math.min(last, Math.max(0, Math.round(f)));
  switch (a.kind) {
    case 'step':
      return clamp(frame + a.frames);
    case 'seconds':
      return clamp(frame + a.seconds * m.fps);
    case 'home':
      return 0;
    case 'end':
      return last;
    case 'segment': {
      const starts = [...new Set(m.segments.map(landingOf))].sort((x, y) => x - y);
      if (a.dir > 0) return clamp(starts.find((s) => s > frame) ?? last);
      return clamp([...starts].reverse().find((s) => s < frame) ?? 0);
    }
  }
}

/**
 * Where a segment is shown when picked (a click, [ / ]): its first frame after the transition into it (review B: not
 * inside the crossfade, where the previous segment still shows), within the segment.
 */
export function landingOf(s: Pick<Model['segments'][number], 'from' | 'to'> & { transition?: { frames: number } }): number {
  return Math.max(s.from, Math.min(s.to - 1, s.from + (s.transition?.frames ?? 0)));
}

/** The segment and the step on screen at a frame (the last one starting at or before it). */
export function whereAt(frame: number, m: Pick<Model, 'segments' | 'steps'>): { segment?: Model['segments'][number]; step?: Model['steps'][number] } {
  let segment: Model['segments'][number] | undefined;
  for (const s of m.segments) if (s.from <= frame && frame < s.to) segment = s;
  let step: Model['steps'][number] | undefined;
  for (const s of m.steps) if (s.from <= frame && frame < s.to) step = s;
  return { ...(segment ? { segment } : {}), ...(step ? { step } : {}) };
}

/** A segment in words: "scene request", "card c1", "intro". */
export function segmentWords(s: Pick<Model['segments'][number], 'kind' | 'id'>): string {
  if (s.kind === 'intro' || s.kind === 'outro') return s.kind;
  return `${s.kind === 'clip' ? 'scene' : s.kind === 'interstitial' ? 'waiting screen' : s.kind} ${s.id}`;
}

/**
 * The scrubber's value text (plan D11): "0:12.40 · scene request · step 3 Click Request a quote" — 1-based steps like
 * every step a person reads; the label is the file's own text (shown, never run).
 */
export function frameWords(frame: number, m: Pick<Model, 'fps' | 'segments' | 'steps'>, labels: Record<string, string>): string {
  const w = whereAt(frame, m);
  const parts = [timecode(frame, m.fps)];
  if (w.segment) parts.push(segmentWords(w.segment));
  if (w.step && w.step.step >= 0) parts.push(`step ${w.step.step + 1}${labels[w.step.key] ? ` ${labels[w.step.key]}` : ` ${w.step.action}`}`);
  return parts.join(' · ');
}

/** Why the capture time jumps at a cut, in words. */
/** "1.4 s", or "under 0.1 s" for a cut too short to say in tenths (review B: never "0.0 s skipped"). */
export function skippedWords(seconds: number): string {
  return seconds < 0.05 ? 'under 0.1 s' : `${seconds.toFixed(1)} s`;
}

/** A cut in words: "a page load cut at 0:03.2: 1.4 s of the capture skipped". */
export function cutWords(c: { reason: string; at: number; src_from_s: number; src_to_s: number }, fps: number): string {
  return `${CUT_WORDS[c.reason] ?? 'a cut'} at ${timecode(c.at, fps)}: ${skippedWords(c.src_to_s - c.src_from_s)} of the capture skipped`;
}

export const CUT_WORDS: Record<string, string> = {
  idle: 'an idle wait cut',
  loading: 'a page load cut',
  frozen: 'a frozen screen cut',
  busy: 'a busy wait cut',
  hook: 'a hook step cut',
  gap: 'a cut',
};

/** The zoomed level's width, in viewport widths: about ten seconds per screen, at least twice the fit (critique C6). */
export function zoomFactor(frames: number, fps: number): number {
  const seconds = frames / (fps > 0 ? fps : 30);
  return Math.min(50, Math.max(2, seconds / 10));
}
