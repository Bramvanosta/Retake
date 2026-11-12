import type { Page } from 'playwright-core';
import type { Pacing, PointSpec } from '@retake/core/model';
import type { KitClient } from './session.js';
import type { TimelineBuilder } from './timeline.js';
import { Jitter, arcPath, distance, easeInOutCubic, moveDuration, snap } from './motion.js';
import { sleep, throwIfAborted, wallNow } from './util.js';

export interface PointerHost {
  page(): Page;
  kit(): KitClient;
  timeline: TimelineBuilder;
  pacing: Pacing;
  signal: AbortSignal;
  scale: number;
  /** Clock of the motion loop (tests inject a fake one to simulate a loaded machine): default wall clock + sleep. */
  clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
  /** Where cursor samples go (default: the timeline's cursor — a page's own track in a multi-page scene, L2.11). */
  sample?: (s: { x: number; y: number; visible: boolean; down?: boolean }) => void;
  /** Called before a press (L1.3: the runtime lets the capture catch up with the cursor's last painted position). */
  beforePress?: () => Promise<void>;
  /** Called once a press is dispatched (L5.7: the recorder keeps frames flowing while its ripple plays). */
  afterPress?: () => void;
}

export type MouseButton = 'left' | 'right' | 'middle';
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** ~60 Hz: one dispatched mouse move per frame. */
export const TICK_MS = 1000 / 60;
/**
 * Most motion time one tick may advance (ms): two frames. The glide runs on its own motion clock, advanced by the
 * wall time between ticks but never by more than this, so a stalled runner (a loaded machine: a late timer, a slow
 * CDP round trip) PAUSES the cursor and then continues the eased path — it never skips ahead, which would show as a
 * jump in the capture. On time, every tick advances exactly the wall time (the motion keeps its planned duration).
 */
export const MAX_TICK_ADVANCE_MS = 2 * TICK_MS;

/**
 * Node-side cursor: moves the REAL CDP mouse in small eased steps. The in-page overlay follows the resulting
 * pointer events, so the drawn cursor, hover states and click reactions are synchronised by construction.
 */
export class Pointer {
  x = 0;
  y = 0;
  known = false;
  visible = true;
  down = false;
  /** Wall time (epoch ms) the last move that changed the position was dispatched (0: none yet). */
  lastMoveAt = 0;

  constructor(private readonly host: PointerHost) {}

  pos(): PointSpec {
    return { x: this.x, y: this.y };
  }

  private sample(): void {
    const s = { x: this.x, y: this.y, visible: this.visible, down: this.down };
    if (this.host.sample) this.host.sample(s);
    else this.host.timeline.sampleCursor(s);
  }

  /** Take over the position and visibility of another pointer on the same page (no move: the page already shows it there). */
  adopt(o: { x: number; y: number; known: boolean; visible: boolean }): void {
    if (!o.known) return;
    this.x = o.x;
    this.y = o.y;
    this.known = true;
    this.visible = o.visible;
    this.sample();
  }

  /** Jump without animation (scene start, page switch, file-drag entry point). */
  async teleport(p: PointSpec): Promise<void> {
    const x = snap(p.x, this.host.scale);
    const y = snap(p.y, this.host.scale);
    await this.host.page().mouse.move(x, y);
    if (x !== this.x || y !== this.y) this.lastMoveAt = Date.now();
    this.x = x;
    this.y = y;
    this.known = true;
    await this.host.kit().cursorSet(x, y, this.visible);
    this.sample();
  }

  /** Re-draw the cursor at its current position on the (newly) active page. */
  async syncPage(): Promise<void> {
    if (!this.known) return;
    await this.teleport(this.pos());
  }

  async setVisible(visible: boolean): Promise<void> {
    this.visible = visible;
    await this.host.kit().cursorShow(visible);
    this.sample();
  }

  /** Eased, slightly arced travel; duration from distance unless `ms` is given. Returns the duration used. */
  async moveTo(target: PointSpec, opts: { ms?: number; jitter?: Jitter; arc?: boolean } = {}): Promise<number> {
    const to = { x: snap(target.x, this.host.scale), y: snap(target.y, this.host.scale) };
    if (!this.known) {
      await this.teleport(to);
      return 0;
    }
    const from = this.pos();
    const dist = distance(from, to);
    if (dist < 0.5) return 0;
    let ms = opts.ms ?? moveDuration(dist, this.host.pacing);
    if (opts.ms === undefined && opts.jitter) ms = opts.jitter.ms(ms);
    const path =
      opts.arc === false
        ? (e: number) => ({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e })
        : arcPath(from, to, opts.jitter?.side() ?? 1);
    const mouse = this.host.page().mouse;
    const clock = this.host.clock ?? { now: wallNow, sleep };
    // Motion time (ms along the planned glide), advanced per tick by the elapsed wall time capped at
    // MAX_TICK_ADVANCE_MS: a late tick resumes the path where it was instead of jumping ahead.
    let motion = 0;
    let last = clock.now();
    for (;;) {
      throwIfAborted(this.host.signal);
      const u = ms <= 0 ? 1 : Math.min(1, motion / ms);
      const e = easeInOutCubic(u);
      const p = path(e);
      const x = u >= 1 ? to.x : snap(p.x, this.host.scale);
      const y = u >= 1 ? to.y : snap(p.y, this.host.scale);
      if (x !== this.x || y !== this.y) {
        await mouse.move(x, y);
        this.lastMoveAt = Date.now();
        this.x = x;
        this.y = y;
        this.sample();
      }
      if (u >= 1) break;
      const wait = last + TICK_MS - clock.now();
      if (wait > 1) await clock.sleep(wait, this.host.signal);
      const now = clock.now();
      motion += Math.min(Math.max(0, now - last), MAX_TICK_ADVANCE_MS);
      last = now;
    }
    return ms;
  }

  /** Mouse down at the current position; returns its capture time. */
  async press(button: MouseButton = 'left', clickCount = 1): Promise<number> {
    if (clickCount === 1) await this.host.beforePress?.();
    throwIfAborted(this.host.signal);
    const t = this.host.timeline.now();
    await this.host.page().mouse.down({ button, clickCount });
    if (clickCount === 1) this.host.afterPress?.();
    this.down = true;
    this.sample();
    return t;
  }

  async release(button: MouseButton = 'left', clickCount = 1): Promise<void> {
    await this.host.page().mouse.up({ button, clickCount });
    this.down = false;
    this.sample();
  }

  /** Real click (or double click) at the current position; returns the capture time of the first mousedown. */
  async click(opts: { button?: MouseButton; count?: 1 | 2; modifiers?: Modifier[]; pressMs?: number } = {}): Promise<number> {
    const button = opts.button ?? 'left';
    const kb = this.host.page().keyboard;
    for (const m of opts.modifiers ?? []) await kb.down(m);
    let t = 0;
    try {
      const count = opts.count ?? 1;
      for (let i = 1; i <= count; i++) {
        const ti = await this.press(button, i);
        if (i === 1) t = ti;
        await sleep(opts.pressMs ?? this.host.pacing.press_ms, this.host.signal);
        await this.release(button, i);
        if (i < count) await sleep(70, this.host.signal);
      }
    } finally {
      for (const m of [...(opts.modifiers ?? [])].reverse()) await kb.up(m).catch(() => undefined);
    }
    return t;
  }
}
