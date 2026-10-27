/**
 * The Studio page's side of the preview protocol (L4.5, protocol.ts; critique B2): connect one sandboxed preview frame.
 *
 * - Armed: one `message` listener on `window`, for the frame's `hello`. The FIRST message whose source is the frame
 *   disarms it — a valid `hello` carrying a MessagePort connects (replacing any older port); anything else stops the
 *   preview. Messages from other windows are ignored. The frame's `load` event re-arms it (a reloaded frame says hello
 *   again).
 * - Connected: every message arrives on the port; each must parse (parseFrameMessage, frames bounded by the last
 *   `loaded`) and fit the flood budget, else the preview stops: the port is closed, the frame removed from the page and
 *   `onStop` says why. The window listener is gone, so a frame flooding `window` costs the page nothing.
 *
 * The page never evaluates what it receives, and posts to the frame only over the port (no targetOrigin needed).
 */
import { FloodBudget, PROTOCOL_VERSION, parseFrameMessage, parseHello } from './protocol.js';
import type { FrameMessage, HelloMessage, ParentMessage } from './protocol.js';

type Outgoing = ParentMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

export interface PreviewConnectionOptions {
  /** The frame said hello (a reload says it again). */
  onHello?(hello: HelloMessage): void;
  onMessage(message: FrameMessage): void;
  /** The preview stopped (the frame is removed): the reason, for the person. */
  onStop(reason: string): void;
  /** Messages per second over the port (default FLOOD_MESSAGES_PER_S). */
  budget?: number;
}

export interface PreviewConnection {
  /** Post to the frame (dropped while not connected). */
  send(message: Outgoing): boolean;
  readonly connected: boolean;
  readonly stopped: boolean;
  /** Disconnect without removing the frame (the page leaves the screen). */
  close(): void;
}

/**
 * The preview iframe's attributes (L4.5): `sandbox="allow-scripts"` and no other sandbox token — never the same-origin
 * one (the frame would get the player origin's storage and could script a same-origin sibling), no popups, no forms,
 * no top navigation (the player-bundle lint scans for them); no Referer; autoplay for the music after the person
 * unmutes; out of the tab order and the accessibility tree (every control lives in the page).
 */
export const PREVIEW_FRAME_ATTRS = { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', allow: 'autoplay', 'aria-hidden': 'true', tabindex: '-1' } as const;

export const STOP_FLOOD = 'the preview stopped: a component sent too many messages';
export const STOP_INVALID = 'the preview stopped: it sent a message the Studio does not take';

export function connectPreview(iframe: HTMLIFrameElement, o: PreviewConnectionOptions): PreviewConnection {
  let port: MessagePort | null = null;
  let armed = false;
  let stopped = false;
  let closed = false;
  let frames: number | undefined;
  let budget = new FloodBudget(o.budget);

  const disarm = () => {
    if (armed) window.removeEventListener('message', onWindow);
    armed = false;
  };
  const dropPort = () => {
    if (port) {
      port.onmessage = null;
      port.close();
    }
    port = null;
  };
  const stop = (reason: string) => {
    if (stopped || closed) return;
    stopped = true;
    disarm();
    dropPort();
    iframe.removeEventListener('load', onLoad);
    iframe.remove();
    o.onStop(reason);
  };
  const onPort = (e: MessageEvent) => {
    if (!budget.take()) return stop(STOP_FLOOD);
    const m = parseFrameMessage(e.data, frames);
    if (!m) return stop(STOP_INVALID);
    if (m.type === 'loaded') frames = m.frames;
    o.onMessage(m);
  };
  function onWindow(e: MessageEvent) {
    if (e.source === null || e.source !== iframe.contentWindow) return;
    disarm();
    const hello = parseHello(e.data);
    const p = e.ports.length === 1 ? e.ports[0] : undefined;
    if (!hello || !p) return stop(STOP_INVALID);
    dropPort();
    port = p;
    frames = undefined;
    budget = new FloodBudget(o.budget);
    port.onmessage = onPort;
    o.onHello?.(hello);
  }
  const arm = () => {
    if (armed || stopped || closed) return;
    armed = true;
    window.addEventListener('message', onWindow);
  };
  function onLoad() {
    // A reloaded frame says hello again (its old port is dead): listen for it. The frame posts its hello from its own
    // load event, so this may run just before or just after that hello arrives; either way the next `hello` replaces
    // the port, and any other message from the frame on `window` disarms the listener and stops the preview.
    arm();
  }
  iframe.addEventListener('load', onLoad);
  arm();

  return {
    send(message) {
      if (!port || stopped || closed) return false;
      port.postMessage({ v: PROTOCOL_VERSION, ...message });
      return true;
    },
    get connected() {
      return port !== null && !stopped && !closed;
    },
    get stopped() {
      return stopped;
    },
    close() {
      if (closed) return;
      disarm();
      dropPort();
      iframe.removeEventListener('load', onLoad);
      closed = true;
    },
  };
}
