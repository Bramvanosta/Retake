/**
 * R-ISS-08: the hold of a page load (pure LoadHold, fake clock) — which frames are written, when a hold ends and what
 * its record says.
 */
import { describe, expect, it } from 'vitest';
import { HOLD_AFTER_PAINT_MS, HOLD_FLUSH_MS, HOLD_IDLE_GRACE_MS, HOLD_MAX_MS, HOLD_PLUGIN_GRACE_MS, LoadHold, PAINT_SLACK_MS } from '../src/hold.js';

interface F {
  wall: number;
  id: string;
}

/** A LoadHold on a fake clock: `at(ms)` moves time (running due timers), `frame(id, stampOffset)` feeds a frame. */
function setup(opts: { refresh?: boolean } = {}) {
  let now = 1000;
  let timers: Array<{ due: number; fn: () => void; live: boolean }> = [];
  const kept: F[] = [];
  let refreshes = 0;
  const hold = new LoadHold<F>({
    now: () => now,
    setTimer: (ms, fn) => {
      const t = { due: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    keep: (f) => kept.push(f),
    ...(opts.refresh ? { refresh: () => void refreshes++ } : {}),
  });
  const at = (t: number) => {
    for (;;) {
      const due = timers.filter((x) => x.live && x.due <= t).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      now = due.due;
      due.live = false;
      due.fn();
    }
    timers = timers.filter((x) => x.live);
    now = t;
  };
  /** A frame arriving now, painted `age` ms ago: true when written (kept by the caller). */
  const frame = (id: string, age = 1): boolean => {
    const f = { id, wall: now - age };
    const w = hold.frame(f);
    if (w) kept.push(f);
    return w;
  };
  return { hold, at, frame, kept, refreshes: () => refreshes, now: () => now };
}

describe('LoadHold (R-ISS-08)', () => {
  it('writes every frame while nothing loads', () => {
    const { hold, frame, kept } = setup();
    expect(frame('a')).toBe(true);
    expect(frame('b')).toBe(true);
    expect(kept.map((f) => f.id)).toEqual(['a', 'b']);
    expect(hold.records).toEqual([]);
  });

  it('holds from the commit until a frame painted after the first contentful paint', () => {
    const { hold, at, frame, kept } = setup();
    hold.begin('L1', 'navigation', 'app');
    expect(hold.holding).toBe(true);
    at(1020);
    expect(frame('blank')).toBe(false);
    at(1500);
    expect(frame('skeleton')).toBe(false);
    // The paint's frame arrives ≈ 15 ms before its signal.
    at(1800);
    expect(frame('painted', 2)).toBe(false);
    at(1815);
    hold.painted('L1', 1798);
    // Within HOLD_AFTER_PAINT_MS the frames are still held (the kit draws the cursor meanwhile).
    at(1815 + HOLD_AFTER_PAINT_MS - 10);
    expect(frame('cursor')).toBe(false);
    at(1815 + HOLD_AFTER_PAINT_MS + 5);
    expect(frame('next')).toBe(true);
    expect(kept.map((f) => f.id)).toEqual(['next']);
    expect(hold.holding).toBe(false);
    expect(hold.records).toEqual([{ since: 1000, until: 1815 + HOLD_AFTER_PAINT_MS + 4, how: 'paint', held: 4, kind: 'navigation', page: 'app' }]);
  });

  it('a still page: its newest frame painted after the paint is written HOLD_FLUSH_MS after the signal, with its own time', () => {
    const { hold, at, frame, kept } = setup();
    hold.begin('L1');
    at(1300);
    frame('skeleton');
    at(1400);
    frame('painted', 2);
    at(1415);
    hold.painted('L1', 1398);
    at(1430);
    frame('cursor', 1);
    at(1415 + HOLD_FLUSH_MS);
    expect(kept.map((f) => f.id)).toEqual(['cursor']);
    expect(hold.records[0]).toMatchObject({ until: 1429, how: 'paint', held: 3 });
  });

  it('never writes a frame painted before the paint — also one arriving after its signal', () => {
    const { hold, at, frame, kept } = setup();
    hold.begin('L1');
    at(1400);
    hold.painted('L1', 1395);
    at(1400 + HOLD_AFTER_PAINT_MS + 1);
    // Painted 30 ms before the paint, delivered late: held.
    expect(frame('late-skeleton', HOLD_AFTER_PAINT_MS + 36)).toBe(false);
    expect(frame('painted', 5)).toBe(true);
    expect(kept.map((f) => f.id)).toEqual(['painted']);
    // After the hold too.
    expect(frame('older', 300)).toBe(false);
    expect(frame('fresh')).toBe(true);
    expect(1395 - PAINT_SLACK_MS).toBeLessThan(1400);
  });

  it('the paint frame never comes (dropped, or Chromium stops sending): a fresh frame is asked for, then the hold ends', () => {
    const { hold, at, frame, kept, refreshes } = setup({ refresh: true });
    hold.begin('L1');
    at(1200);
    frame('skeleton');
    at(1400);
    hold.painted('L1', 1390);
    at(1400 + HOLD_FLUSH_MS);
    expect(refreshes()).toBe(1);
    expect(hold.holding).toBe(true);
    at(1400 + HOLD_FLUSH_MS + 20);
    expect(frame('refreshed', 2)).toBe(true);
    expect(hold.records[0]).toMatchObject({ how: 'paint', until: 1400 + HOLD_FLUSH_MS + 18 });
    expect(kept.map((f) => f.id)).toEqual(['refreshed']);
  });

  it('without a refresh that works, the hold ends 2 × HOLD_FLUSH_MS after the signal, writing nothing older', () => {
    const { hold, at, frame, kept, refreshes } = setup({ refresh: true });
    hold.begin('L1');
    at(1200);
    frame('skeleton');
    at(1400);
    hold.painted('L1', 1390);
    at(1400 + 2 * HOLD_FLUSH_MS);
    expect(refreshes()).toBe(1);
    expect(hold.holding).toBe(false);
    expect(kept).toEqual([]);
    expect(hold.records[0]).toMatchObject({ how: 'paint', until: 1400 + 2 * HOLD_FLUSH_MS });
  });

  it('ignores the paint and load of another document; a second commit continues the hold', () => {
    const { hold, at } = setup();
    hold.begin('L1');
    hold.painted('OLD');
    hold.loaded('OLD');
    hold.idle('OLD');
    at(3000);
    expect(hold.holding).toBe(true);
    // A client redirect: the newer document must paint.
    hold.begin('L2');
    hold.painted('L1');
    at(3000 + HOLD_FLUSH_MS * 3);
    expect(hold.holding).toBe(true);
    hold.painted('L2', 3400);
    at(3400 + HOLD_FLUSH_MS * 3);
    expect(hold.records).toHaveLength(1);
    expect(hold.records[0]).toMatchObject({ since: 1000, how: 'paint' });
  });

  it('a document that never paints content: released after load and network idle (a PDF viewer sooner), its newest frame written then', () => {
    const { hold, at, frame, kept, refreshes } = setup({ refresh: true });
    hold.begin('L1', 'navigation', 'tab', false);
    at(1100);
    hold.loaded('L1');
    at(1200);
    frame('viewer');
    at(1500);
    frame('pdf');
    at(1700);
    hold.idle('L1');
    at(1700 + HOLD_PLUGIN_GRACE_MS - 1);
    expect(hold.holding).toBe(true);
    at(1700 + HOLD_PLUGIN_GRACE_MS);
    // Shown from the release on (the held time is cut by the edit): the newest frame stamped then, and a fresh one asked
    // for (Chromium may have stopped sending frames). Nothing painted before the release is written after it.
    expect(kept.map((f) => [f.id, f.wall])).toEqual([['pdf', 1700 + HOLD_PLUGIN_GRACE_MS]]);
    expect(hold.records[0]).toMatchObject({ how: 'load', until: 1700 + HOLD_PLUGIN_GRACE_MS, held: 2 });
    expect(refreshes()).toBe(1);
    expect(frame('in-flight', 5)).toBe(false);
    expect(frame('fresh', 0)).toBe(true);
    // A web page that paints nothing (only solid colours) is given HOLD_IDLE_GRACE_MS: it may render from a timer.
    const web = setup();
    web.hold.begin('L1');
    web.hold.loaded('L1');
    web.hold.idle('L1');
    web.at(1000 + HOLD_IDLE_GRACE_MS - 1);
    expect(web.hold.holding).toBe(true);
    web.at(1000 + HOLD_IDLE_GRACE_MS);
    expect(web.hold.records[0].how).toBe('load');
  });

  it('a paint after network idle wins over the grace; a blank tab is never released by its own load', () => {
    const a = setup();
    a.hold.begin('L1');
    a.hold.loaded('L1');
    a.hold.idle('L1');
    a.at(1100);
    a.hold.painted('L1', 1095);
    a.at(5000);
    expect(a.hold.records[0].how).toBe('paint');
    const b = setup();
    b.hold.begin('BLANK', 'blank');
    b.hold.loaded('BLANK');
    b.hold.idle('BLANK');
    b.at(1000 + HOLD_IDLE_GRACE_MS + 1000);
    expect(b.hold.holding).toBe(true);
    // Its navigation continues the hold (now a navigation).
    b.hold.begin('L1');
    b.hold.painted('L1', b.now());
    b.at(b.now() + 2 * HOLD_FLUSH_MS);
    expect(b.hold.records[0]).toMatchObject({ since: 1000, kind: 'navigation' });
  });

  it('HOLD_MAX_MS: released as `limit`, the newest frame written then', () => {
    const { hold, at, frame, kept } = setup();
    hold.begin('L1');
    at(2000);
    frame('spinner');
    at(1000 + HOLD_MAX_MS);
    expect(kept.map((f) => [f.id, f.wall])).toEqual([['spinner', 1000 + HOLD_MAX_MS]]);
    expect(hold.records[0]).toMatchObject({ how: 'limit', until: 1000 + HOLD_MAX_MS, kind: 'navigation' });
    // A blank tab too (the runner warns for every limit).
    const blank = setup();
    blank.hold.begin('BLANK', 'blank');
    blank.at(1000 + HOLD_MAX_MS);
    expect(blank.hold.records[0]).toMatchObject({ how: 'limit', kind: 'blank' });
    // No frame held at all (dropped by the size check): a fresh one is asked for.
    const none = setup({ refresh: true });
    none.hold.begin('L1');
    none.at(1000 + HOLD_MAX_MS);
    expect(none.refreshes()).toBe(1);
    expect(none.hold.records[0]).toMatchObject({ how: 'limit', until: 1000 + HOLD_MAX_MS });
  });

  it('a release never writes a frame of the previous document (stamped before the commit, delivered after it)', () => {
    const { hold, at, frame, kept, refreshes } = setup({ refresh: true });
    at(1100);
    hold.begin('L1');
    frame('old-page', 30);
    hold.loaded('L1');
    hold.idle('L1');
    at(1100 + HOLD_IDLE_GRACE_MS);
    expect(kept).toEqual([]);
    expect(refreshes()).toBe(1);
    expect(hold.records[0]).toMatchObject({ how: 'load', since: 1100, until: 1100 + HOLD_IDLE_GRACE_MS });
  });

  it('kind: what is held — a blank tab, then the navigation that continues it', () => {
    const { hold } = setup();
    expect(hold.kind).toBeNull();
    hold.begin('BLANK', 'blank');
    expect(hold.kind).toBe('blank');
    hold.begin('L1');
    expect(hold.kind).toBe('navigation');
    hold.leave('left', true);
    expect(hold.kind).toBeNull();
  });

  it('leaving writes nothing, except when the recorder never wrote a frame', () => {
    const a = setup();
    a.hold.begin('L1');
    a.at(1200);
    a.frame('blank');
    a.at(1300);
    a.hold.leave('left', true);
    expect(a.kept).toEqual([]);
    expect(a.hold.records[0]).toMatchObject({ how: 'left', until: 1300 });
    const b = setup();
    b.hold.begin('BLANK', 'blank');
    b.at(1200);
    b.frame('blank');
    b.at(1300);
    b.hold.leave('end', false);
    expect(b.kept.map((f) => f.id)).toEqual(['blank']);
    expect(b.hold.records[0]).toMatchObject({ how: 'end', until: 1199 });
  });

  it('waitEnd resolves on the end of the hold (at once when none), false at its time-out', async () => {
    const { hold, at } = setup();
    await expect(hold.waitEnd(10)).resolves.toBe(true);
    hold.begin('L1');
    const w = hold.waitEnd(5000);
    const late = hold.waitEnd(50);
    at(1100);
    await expect(late).resolves.toBe(false);
    hold.leave('left', true);
    await expect(w).resolves.toBe(true);
    expect(hold.ends).toBe(1);
    // A cancelled run stops waiting (false at once, and on abort).
    hold.begin('L2');
    const ac = new AbortController();
    const cancelled = hold.waitEnd(5000, ac.signal);
    ac.abort();
    await expect(cancelled).resolves.toBe(false);
    await expect(hold.waitEnd(5000, ac.signal)).resolves.toBe(false);
    expect(hold.holding).toBe(true);
  });

  it('heldSince counts the holds of at least the minimum since a moment', () => {
    const { hold, at } = setup();
    hold.begin('L1');
    at(1100);
    hold.leave('left', true); // 100 ms
    at(2000);
    hold.begin('L2');
    at(2500);
    hold.leave('left', true); // 500 ms
    expect(hold.heldSince(0, 150)).toBe(500);
    expect(hold.heldSince(0, 50)).toBe(600);
    expect(hold.heldSince(2200, 150)).toBe(300);
    expect(hold.heldSince(2600, 0)).toBe(0);
  });
});
