/**
 * The engine's clock (the Clock port, src/clock.ts): the system's clock, the manual one for tests, and the ports bag
 * that chooses them at the composition roots (src/ports.ts).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualClock, createEngine, dateOf, diskProjectStores, enginePorts, readJournal, stampOf, systemClock } from '../src/index.js';
import type { JobQueue } from '../src/index.js';
import { RUN_INPUT } from './job-queue-contract.js';

describe('the engine clock', () => {
  it('the system clock reads the time now; stampOf and dateOf give it as a stamp and a Date', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    const fixed = { now: () => Date.UTC(2026, 10, 11, 9, 30, 0, 250) };
    expect(stampOf(fixed)).toBe('2026-11-11T09:30:00.250Z');
    expect(dateOf(fixed).getTime()).toBe(fixed.now());
  });

  it('a manual clock stands still until it is set or moved forward', () => {
    const c = new ManualClock('2026-01-02T03:04:05.006Z');
    expect(stampOf(c)).toBe('2026-01-02T03:04:05.006Z');
    expect(c.now()).toBe(c.now());
    c.advance(1_500);
    expect(stampOf(c)).toBe('2026-01-02T03:04:06.506Z');
    c.set(0);
    expect(stampOf(c)).toBe('1970-01-01T00:00:00.000Z');
    expect(stampOf(new ManualClock())).toBe('2026-01-01T00:00:00.000Z');
    expect(new ManualClock(1_000).now()).toBe(1_000);
  });

  it('a manual clock refuses a time that is not one and never moves back', () => {
    expect(() => new ManualClock('not a time')).toThrow(RangeError);
    expect(() => new ManualClock(Number.NaN)).toThrow(RangeError);
    const c = new ManualClock(5_000);
    expect(() => c.set('yesterday')).toThrow(RangeError);
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(c.now()).toBe(5_000);
  });

  it('the ports bag gives the product adapters for the ports not handed, and keeps the ones handed', () => {
    // The hook runner and the reviewer (L7.11) are the packages' adapters: ports.test.ts.
    expect(enginePorts()).toMatchObject({ clock: systemClock, stores: diskProjectStores, hooks: expect.any(Object), reviewer: expect.any(Object) });
    const clock = new ManualClock();
    const p = enginePorts({ clock });
    expect(p.clock).toBe(clock);
    expect(p.stores).toBe(diskProjectStores);
  });
});

describe('createEngine({ ports })', () => {
  it('stamps what the façade writes with the clock it is handed: its queue, its authored writes and their journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retake-engine-clock-'));
    const savedHome = process.env.RETAKE_HOME;
    process.env.RETAKE_HOME = join(root, '.home');
    try {
      await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
      await mkdir(join(root, 'projects'), { recursive: true });
      const clock = new ManualClock('2026-05-06T07:08:09.010Z');
      const engine = await createEngine({ root, client: 'ui', autoStartWorker: false, ports: { clock } });
      // The façade shows its queue as a view; behind it is the file queue createEngine built with the clock.
      expect((await (engine.queue as JobQueue).enqueue(RUN_INPUT)).created_at).toBe('2026-05-06T07:08:09.010Z');
      clock.advance(60_000);
      await engine.projects.create({ name: 'Acme', slug: 'acme' });
      const view = await engine.projects.get('acme');
      clock.advance(60_000);
      await engine.projects.updateReadme('acme', '# Acme\n', view.readme_hash);
      const lines = await readJournal(root);
      expect(lines.length).toBeGreaterThan(1);
      expect(new Set(lines.filter((l) => l.op === 'folder' || (l.op === 'write' && l.what === 'project')).map((l) => l.at))).toEqual(new Set(['2026-05-06T07:09:09.010Z']));
      expect(lines.filter((l) => l.op === 'write' && l.what === 'readme').map((l) => l.at)).toEqual(['2026-05-06T07:10:09.010Z']);
    } finally {
      if (savedHome === undefined) delete process.env.RETAKE_HOME;
      else process.env.RETAKE_HOME = savedHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
