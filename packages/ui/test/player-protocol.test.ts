/**
 * L4.5 part B: the preview protocol (src/player/protocol.ts) and the Studio page's side of it (src/player/parent.ts),
 * without a browser: strict message shapes both ways, the flood budget, and connectPreview on a fake window / iframe
 * with Node's own MessageChannel —
 * - ⚑ a message from another window is ignored; the first message from the frame disarms the window listener: a hello
 *   with a port connects, anything else stops the preview (critique B2);
 * - ⚑ over the port, an invalid message or one over the budget stops it: the port is closed, the frame removed;
 * - frames are bounded by the last `loaded`; a reloaded frame re-arms the listener and its new hello replaces the port.
 */
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { FLOOD_MESSAGES_PER_S, FloodBudget, TEXT_MAX, clip, parseFrameMessage, parseHello, parseParentMessage } from '../src/player/protocol.js';
import { STOP_FLOOD, STOP_INVALID, connectPreview } from '../src/player/parent.js';
import type { FrameMessage } from '../src/player/protocol.js';

describe('protocol messages', () => {
  it('parent → frame: exactly the known shapes', () => {
    expect(parseParentMessage({ v: 1, type: 'load', plan_url: 'http://127.0.0.1:1/m/x/plan/y.json', frame: 0 })).toBeDefined();
    expect(parseParentMessage({ v: 1, type: 'seek', frame: 12 })).toEqual({ v: 1, type: 'seek', frame: 12 });
    expect(parseParentMessage({ v: 1, type: 'rate', rate: 2 })).toBeDefined();
    expect(parseParentMessage({ v: 1, type: 'mute', muted: false })).toBeDefined();
    for (const bad of [
      null,
      'seek',
      [],
      { v: 2, type: 'seek', frame: 1 },
      { v: 1, type: 'seek', frame: 1.5 },
      { v: 1, type: 'seek', frame: -1 },
      { v: 1, type: 'seek', frame: '1' },
      { v: 1, type: 'seek', frame: 1, extra: true },
      { v: 1, type: 'rate', rate: 3 },
      { v: 1, type: 'play', x: 1 },
      { v: 1, type: 'eval', code: '1' },
      { v: 1, type: 'load', plan_url: 'x'.repeat(2049), frame: 0 },
    ]) expect(parseParentMessage(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it('⚑ frame → parent: exact keys, whole frames in range, short text, short lists', () => {
    expect(parseFrameMessage({ v: 1, type: 'loaded', frames: 90, missing: ['acme/x'], warnings: ['w'] })).toBeDefined();
    expect(parseFrameMessage({ v: 1, type: 'settled', frame: 90 }, 90)).toBeDefined();
    expect(parseFrameMessage({ v: 1, type: 'state', playing: true, buffering: false, muted: true })).toBeDefined();
    expect(parseFrameMessage({ v: 1, type: 'error', message: 'x'.repeat(TEXT_MAX) })).toBeDefined();
    for (const bad of [
      { v: 1, type: 'settled', frame: 91 },
      { v: 1, type: 'frame', frame: 3, extra: 1 },
      { v: 1, type: 'error', message: 'x'.repeat(TEXT_MAX + 1) },
      { v: 1, type: 'warning', message: 3 },
      { v: 1, type: 'loaded', frames: 0, missing: [], warnings: [] },
      { v: 1, type: 'loaded', frames: 9, missing: Array(65).fill('a'), warnings: [] },
      { v: 1, type: 'loaded', frames: 9, missing: ['x'.repeat(129)], warnings: [] },
      { v: 1, type: 'state', playing: 'yes', buffering: false, muted: true },
      { v: 1, type: 'state', playing: true, buffering: false },
      { v: 1, type: 'hello', bundle: '0123456789abcdef' },
      Object.assign(Object.create({ inherited: 1 }), { v: 1, type: 'ended' }),
    ]) expect(parseFrameMessage(bad, 90), JSON.stringify(bad)).toBeUndefined();
    expect(parseHello({ v: 1, type: 'hello', bundle: '0123456789abcdef' })).toBeDefined();
    expect(parseHello({ v: 1, type: 'hello', bundle: 'nope' })).toBeUndefined();
    expect(clip('x'.repeat(500))).toHaveLength(TEXT_MAX);
  });

  it('the flood budget: a sliding second', () => {
    let t = 0;
    const b = new FloodBudget(3, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t = 999;
    expect(b.take()).toBe(false);
    t = 1000;
    expect(b.take()).toBe(true);
    expect(FLOOD_MESSAGES_PER_S).toBe(240);
  });
});

// ── connectPreview on a fake page ────────────────────────────────────────────

type Listener = (e: { source: unknown; data: unknown; ports: readonly unknown[] }) => void;
const listeners = new Set<Listener>();
const savedWindow = (globalThis as { window?: unknown }).window;

function fakePage() {
  (globalThis as { window?: unknown }).window = {
    addEventListener: (t: string, l: Listener) => t === 'message' && listeners.add(l),
    removeEventListener: (t: string, l: Listener) => t === 'message' && listeners.delete(l),
  };
  const frameWindow = {};
  let onLoad: (() => void) | undefined;
  const iframe = {
    contentWindow: frameWindow as unknown,
    removed: false,
    addEventListener: (t: string, l: () => void) => t === 'load' && (onLoad = l),
    removeEventListener: () => (onLoad = undefined),
    remove() {
      this.removed = true;
      this.contentWindow = null;
    },
  };
  const post = (source: unknown, data: unknown, ports: unknown[] = []) => {
    for (const l of [...listeners]) l({ source, data, ports });
  };
  return { iframe, frameWindow, post, reload: () => onLoad?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const HELLO = { v: 1, type: 'hello', bundle: '0123456789abcdef' };

afterEach(() => {
  listeners.clear();
  (globalThis as { window?: unknown }).window = savedWindow;
});

function connect(p: ReturnType<typeof fakePage>, budget?: number) {
  const got: FrameMessage[] = [];
  const stops: string[] = [];
  const c = connectPreview(p.iframe as unknown as HTMLIFrameElement, { onMessage: (m) => got.push(m), onStop: (r) => stops.push(r), ...(budget ? { budget } : {}) });
  return { c, got, stops };
}

describe('connectPreview (the Studio page side)', () => {
  it('⚑ ignores other windows; the hello with a port connects and removes the window listener', async () => {
    const p = fakePage();
    const { c, got, stops } = connect(p);
    expect(listeners.size).toBe(1);
    p.post({}, HELLO, [new MessageChannel().port2]);
    p.post({}, { v: 1, type: 'error', message: 'from another window' });
    expect(listeners.size).toBe(1);
    expect(c.connected).toBe(false);
    const ch = new MessageChannel();
    p.post(p.frameWindow, HELLO, [ch.port2]);
    expect(listeners.size).toBe(0);
    expect(c.connected).toBe(true);
    // Later window messages from the frame reach no listener at all.
    p.post(p.frameWindow, { v: 1, type: 'warning', message: 'spoofed on window' });
    ch.port1.postMessage({ v: 1, type: 'loaded', frames: 30, missing: [], warnings: [] });
    ch.port1.postMessage({ v: 1, type: 'settled', frame: 30 });
    await tick();
    expect(got.map((m) => m.type)).toEqual(['loaded', 'settled']);
    expect(stops).toEqual([]);
    expect(c.send({ type: 'seek', frame: 3 })).toBe(true);
    const seen: unknown[] = [];
    ch.port1.on('message', (d) => seen.push(d));
    await tick();
    expect(seen).toEqual([{ v: 1, type: 'seek', frame: 3 }]);
    c.close();
    ch.port1.close();
  });

  it('⚑ the first message from the frame that is no hello with a port stops the preview', () => {
    for (const [data, ports] of [
      [{ v: 1, type: 'settled', frame: 1 }, [new MessageChannel().port2]],
      [HELLO, []],
      [{ ...HELLO, bundle: 'zz' }, [new MessageChannel().port2]],
    ] as const) {
      const p = fakePage();
      const { c, stops } = connect(p);
      p.post(p.frameWindow, data, [...ports]);
      expect(stops).toEqual([STOP_INVALID]);
      expect(p.iframe.removed).toBe(true);
      expect(listeners.size).toBe(0);
      expect(c.stopped).toBe(true);
      listeners.clear();
    }
  });

  it('⚑ an invalid port message, a frame out of the loaded range, or a flood stops it (port closed, frame removed)', async () => {
    for (const msgs of [
      [{ v: 1, type: 'frame', frame: 'x' }],
      [{ v: 1, type: 'loaded', frames: 30, missing: [], warnings: [] }, { v: 1, type: 'frame', frame: 31 }],
    ]) {
      const p = fakePage();
      const { stops } = connect(p);
      const ch = new MessageChannel();
      p.post(p.frameWindow, HELLO, [ch.port2]);
      for (const m of msgs) ch.port1.postMessage(m);
      await tick();
      expect(stops).toEqual([STOP_INVALID]);
      expect(p.iframe.removed).toBe(true);
      ch.port1.close();
    }
    const p = fakePage();
    const { got, stops } = connect(p, 50);
    const ch = new MessageChannel();
    p.post(p.frameWindow, HELLO, [ch.port2]);
    for (let i = 0; i < 2000; i++) ch.port1.postMessage({ v: 1, type: 'frame', frame: i % 10 });
    await tick();
    expect(stops).toEqual([STOP_FLOOD]);
    expect(got.length).toBe(50);
    expect(p.iframe.removed).toBe(true);
    ch.port1.close();
  });

  it('a reloaded frame re-arms the listener; its new hello replaces the port', async () => {
    const p = fakePage();
    const { c, got } = connect(p);
    const a = new MessageChannel();
    p.post(p.frameWindow, HELLO, [a.port2]);
    p.reload();
    expect(listeners.size).toBe(1);
    const b = new MessageChannel();
    p.post(p.frameWindow, HELLO, [b.port2]);
    expect(listeners.size).toBe(0);
    a.port1.postMessage({ v: 1, type: 'ended' });
    b.port1.postMessage({ v: 1, type: 'state', playing: false, buffering: false, muted: true });
    await tick();
    expect(got.map((m) => m.type)).toEqual(['state']);
    c.close();
    a.port1.close();
    b.port1.close();
  });
});
