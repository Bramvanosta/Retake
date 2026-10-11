import type { Page } from 'playwright-core';
import type { Pacing, PointSpec } from '@demo-studio/core';
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
}

export type MouseButton = 'left' | 'right' | 'middle';
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** ~60 Hz: one dispatched mouse move per frame. */
const TICK_MS = 1000 / 60;

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

  constructor(private readonly host: PointerHost) {}

  pos(): PointSpec {
    return { x: this.x, y: this.y };
  }

  private sample(): void {
    this.host.timeline.sampleCursor({ x: this.x, y: this.y, visible: this.visible, down: this.down });
  }

  /** Jump without animation (scene start, page switch, file-drag entry point). */
  async teleport(p: PointSpec): Promise<void> {
    const x = snap(p.x, this.host.scale);
    const y = snap(p.y, this.host.scale);
    await this.host.page().mouse.move(x, y);
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
    const start = wallNow();
    let tick = 0;
    for (;;) {
      throwIfAborted(this.host.signal);
      const u = ms <= 0 ? 1 : Math.min(1, (wallNow() - start) / ms);
      const e = easeInOutCubic(u);
      const p = path(e);
      const x = u >= 1 ? to.x : snap(p.x, this.host.scale);
      const y = u >= 1 ? to.y : snap(p.y, this.host.scale);
      if (x !== this.x || y !== this.y) {
        await mouse.move(x, y);
        this.x = x;
        this.y = y;
        this.sample();
      }
      if (u >= 1) break;
      tick++;
      const wait = start + tick * TICK_MS - wallNow();
      if (wait > 1) await sleep(wait, this.host.signal);
    }
    return ms;
  }

  /** Mouse down at the current position; returns its capture time. */
  async press(button: MouseButton = 'left', clickCount = 1): Promise<number> {
    const t = this.host.timeline.now();
    await this.host.page().mouse.down({ button, clickCount });
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
