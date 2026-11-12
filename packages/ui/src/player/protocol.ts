/**
 * The preview protocol (L4.5, DESIGN §4g; critique B2): what the Studio page and the sandboxed preview frame say to each
 * other. Shared by both sides, browser-only, no dependency. Version 1:
 *
 * - The frame opens a MessageChannel and posts exactly one `hello` on `window` to its parent, with the channel's port.
 *   The parent's window listener takes the first message whose source is the frame — a `hello` carrying a port, or the
 *   preview stops — and removes itself: every later message goes over the port, and a frame flooding `window` hits no
 *   listener at all (probe: a window listener froze the Studio tab for 53 s under 200,000 messages; none, 22 ms).
 * - Over the port, the parent drops nothing silently: a message that is not exactly one of the frame's messages, or one
 *   over the flood budget, stops the preview (port closed, frame removed, the reason shown). A frame never sends an
 *   invalid message; one that does runs code that is not the preview's.
 * - Parent → frame: `load` (the plan's capability URL and the frame to show), `seek`, `play`, `pause`, `rate`, `mute`,
 *   `clear`. Frame → parent: `loaded`, `frame`, `state`, `settled`, `ended`, `warning`, `error`. Text is short and shown
 *   as untrusted text; numbers are whole frames in range. Nothing received is ever evaluated.
 */

export const PROTOCOL_VERSION = 1;

/** Longest text a frame message carries (a warning, an error). */
export const TEXT_MAX = 300;
/** Most warnings / missing component ids in one `loaded`. */
export const LIST_MAX = 64;
/** Longest component id in `loaded.missing`. */
export const ID_MAX = 128;
/** Longest frame count of a plan the protocol accepts (a 2-hour video at 60 fps). */
export const FRAMES_MAX = 432_000;

/**
 * The parent's flood budget over the port (critique B2): above this many messages in one second the preview stops. A
 * playing preview sends at most one `frame` per animation frame (60/s) plus a few `state` / `settled`.
 */
export const FLOOD_MESSAGES_PER_S = 240;

/**
 * Strings of a component preview spec (L4.7) that are text drawn, never loaded — exempt from the "every URL is one this
 * preview serves" scan on both sides (the server's checkPreviewSpec, the frame's own check). A fixed list of paths
 * (root `spec`, array indices written `[*]`): the sample address a browser layout draws in its bar, each pane's, the
 * theme's brand address. Plus a slot value of a component use (`spec.….slots.<name>`) equal to that brand address: a
 * slot filled from `default_from: theme.brand.url`. Nothing else, so no free-form path widens it (L4.7 review A M2).
 */
export const PREVIEW_DISPLAY_PATHS: readonly string[] = ['spec.scene.url', 'spec.scene.rects.panes[*].url', 'spec.theme.brand.url'];
const PREVIEW_SLOT_PATH = /^spec(?:\.[A-Za-z_]+)+\.slots\.[A-Za-z0-9_-]+$/;

/** Whether `value` at `path` (as the scans write it: `spec.a.b[0].c`) is display text of `spec` (see PREVIEW_DISPLAY_PATHS). */
export function isPreviewDisplayText(path: string, value: string, spec: unknown): boolean {
  const norm = path.replace(/\[\d+\]/g, '[*]');
  if (PREVIEW_DISPLAY_PATHS.includes(norm)) return true;
  const theme = spec && typeof spec === 'object' ? (spec as { theme?: { brand?: { url?: unknown } } }).theme : undefined;
  const brandUrl = theme && typeof theme === 'object' ? theme.brand?.url : undefined;
  return typeof brandUrl === 'string' && value === brandUrl && PREVIEW_SLOT_PATH.test(norm);
}

export type ParentMessage =
  | { v: 1; type: 'load'; plan_url: string; frame: number }
  | { v: 1; type: 'seek'; frame: number }
  | { v: 1; type: 'play' }
  | { v: 1; type: 'pause' }
  | { v: 1; type: 'rate'; rate: 0.5 | 1 | 2 }
  | { v: 1; type: 'mute'; muted: boolean }
  | { v: 1; type: 'clear' };

export interface HelloMessage {
  v: 1;
  type: 'hello';
  /** The bundle's hash (16 hex). */
  bundle: string;
}

export type FrameMessage =
  | { v: 1; type: 'loaded'; frames: number; missing: string[]; warnings: string[] }
  | { v: 1; type: 'frame'; frame: number }
  | { v: 1; type: 'state'; playing: boolean; buffering: boolean; muted: boolean }
  | { v: 1; type: 'settled'; frame: number }
  | { v: 1; type: 'ended' }
  | { v: 1; type: 'warning'; message: string }
  | { v: 1; type: 'error'; message: string };

type Rec = Record<string, unknown>;

function plain(d: unknown): Rec | undefined {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const proto = Object.getPrototypeOf(d) as unknown;
  return proto === Object.prototype || proto === null ? (d as Rec) : undefined;
}

/** Exactly these keys (no more, no fewer). */
function keysAre(d: Rec, keys: readonly string[]): boolean {
  const own = Object.keys(d);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(d, k));
}

const isFrame = (n: unknown, max = FRAMES_MAX): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
const isText = (s: unknown, max = TEXT_MAX): s is string => typeof s === 'string' && s.length <= max;

/** Text cut to `max` characters (the frame side: what it sends always fits). */
export function clip(text: string, max = TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A parent message, or undefined (the frame ignores it). */
export function parseParentMessage(data: unknown): ParentMessage | undefined {
  const d = plain(data);
  if (!d || d.v !== PROTOCOL_VERSION) return undefined;
  switch (d.type) {
    case 'load':
      return keysAre(d, ['v', 'type', 'plan_url', 'frame']) && isText(d.plan_url, 2048) && isFrame(d.frame) ? (d as ParentMessage) : undefined;
    case 'seek':
      return keysAre(d, ['v', 'type', 'frame']) && isFrame(d.frame) ? (d as ParentMessage) : undefined;
    case 'play':
    case 'pause':
    case 'clear':
      return keysAre(d, ['v', 'type']) ? (d as ParentMessage) : undefined;
    case 'rate':
      return keysAre(d, ['v', 'type', 'rate']) && (d.rate === 0.5 || d.rate === 1 || d.rate === 2) ? (d as ParentMessage) : undefined;
    case 'mute':
      return keysAre(d, ['v', 'type', 'muted']) && typeof d.muted === 'boolean' ? (d as ParentMessage) : undefined;
    default:
      return undefined;
  }
}

/** The frame's `hello` (with its port checked by the caller), or undefined. */
export function parseHello(data: unknown): HelloMessage | undefined {
  const d = plain(data);
  if (!d || d.v !== PROTOCOL_VERSION || d.type !== 'hello') return undefined;
  return keysAre(d, ['v', 'type', 'bundle']) && typeof d.bundle === 'string' && /^[0-9a-f]{16}$/.test(d.bundle) ? (d as unknown as HelloMessage) : undefined;
}

/**
 * A frame message, or undefined (the parent then stops the preview). `frames`: the loaded plan's length — `frame` and
 * `settled` must lie in [0, frames]; before any `loaded` only FRAMES_MAX bounds them.
 */
export function parseFrameMessage(data: unknown, frames = FRAMES_MAX): FrameMessage | undefined {
  const d = plain(data);
  if (!d || d.v !== PROTOCOL_VERSION) return undefined;
  switch (d.type) {
    case 'loaded': {
      if (!keysAre(d, ['v', 'type', 'frames', 'missing', 'warnings']) || !isFrame(d.frames) || d.frames < 1) return undefined;
      const { missing, warnings } = d;
      if (!Array.isArray(missing) || missing.length > LIST_MAX || !missing.every((x) => isText(x, ID_MAX))) return undefined;
      if (!Array.isArray(warnings) || warnings.length > LIST_MAX || !warnings.every((x) => isText(x))) return undefined;
      return d as FrameMessage;
    }
    case 'frame':
    case 'settled':
      return keysAre(d, ['v', 'type', 'frame']) && isFrame(d.frame, frames) ? (d as FrameMessage) : undefined;
    case 'state':
      return keysAre(d, ['v', 'type', 'playing', 'buffering', 'muted']) && typeof d.playing === 'boolean' && typeof d.buffering === 'boolean' && typeof d.muted === 'boolean'
        ? (d as FrameMessage)
        : undefined;
    case 'ended':
      return keysAre(d, ['v', 'type']) ? (d as FrameMessage) : undefined;
    case 'warning':
    case 'error':
      return keysAre(d, ['v', 'type', 'message']) && isText(d.message) ? (d as FrameMessage) : undefined;
    default:
      return undefined;
  }
}

/** Messages in a sliding one-second window: `take()` false once over the budget (the caller stops the preview). */
export class FloodBudget {
  private readonly times: number[] = [];
  constructor(
    private readonly perSecond = FLOOD_MESSAGES_PER_S,
    private readonly now: () => number = () => performance.now(),
  ) {}

  take(): boolean {
    const t = this.now();
    while (this.times.length > 0 && t - this.times[0] >= 1000) this.times.shift();
    if (this.times.length >= this.perSecond) return false;
    this.times.push(t);
    return true;
  }
}
