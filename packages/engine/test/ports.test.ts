/**
 * The ports bag's L7.11 members, HookRunner and Reviewer: the product's adapters are the default (each member loading
 * its package on its call, through the loader of its home), a handed one is kept, and the package adapters hand the
 * package's answers on unchanged — a review's frames and thumbnails through the light thumbnail entry, never the
 * package root (the editor behind it).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectPath, statePath } from '@retake/core';
import type { HookContext } from '@retake/core';
import { thumbJpeg } from '@retake/review/thumbs';
import { enginePorts, packageHookRunner, packageReviewer, systemClock } from '../src/index.js';
import type { HookRunner, Reviewer } from '../src/index.js';
import * as lazy from '../src/lazy.js';
import { MEMORY_PNG } from '../src/render/memory-renderer.js';

// Which loader each member called: the real loaders, recorded.
const calls: string[] = [];
// A loader made to fail once (the package cannot be loaded): its error, as thrown.
const failing: { next?: Error } = {};
vi.mock('../src/lazy.js', async (actual) => {
  const real = await actual<typeof import('../src/lazy.js')>();
  const spy = <K extends keyof typeof real>(k: K) =>
    ((...a: unknown[]) => {
      calls.push(k);
      const e = failing.next;
      failing.next = undefined;
      return e ? Promise.reject(e) : (real[k] as (...x: unknown[]) => unknown)(...a);
    }) as (typeof real)[K];
  return { editor: spy('editor'), review: spy('review'), thumbs: spy('thumbs'), hooks: spy('hooks') };
});

const dir = await mkdtemp(join(tmpdir(), 'retake-ports-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(() => void calls.splice(0));

describe('the ports bag: the hook runner and the reviewer', () => {
  it('defaults to the package adapters and keeps the ones handed; making them loads nothing', () => {
    const p = enginePorts();
    expect(Object.keys(p).sort()).toEqual(['clock', 'hooks', 'reviewer', 'stores']);
    expect(typeof p.hooks.run).toBe('function');
    expect(typeof p.reviewer.frames.thumb).toBe('function');
    expect(calls).toEqual([]);
    const hooks = { marker: 'hooks' } as unknown as HookRunner;
    const reviewer = { marker: 'reviewer' } as unknown as Reviewer;
    const given = enginePorts({ hooks, reviewer });
    expect(given.hooks).toBe(hooks);
    expect(given.reviewer).toBe(reviewer);
    expect(given.clock).toBe(systemClock);
    expect(lazy.thumbs).toBeTypeOf('function');
  });

  it("the reviewer's frames come from the thumbnail entry, the rest from the package root", async () => {
    const r = packageReviewer();
    const viaPort = await r.frames.thumb(MEMORY_PNG, { maxPx: 64, quality: 70 });
    const direct = await thumbJpeg(MEMORY_PNG, { maxPx: 64, quality: 70 });
    expect(Buffer.compare(viaPort.data, direct.data)).toBe(0);
    expect([viaPort.width, viaPort.height]).toEqual([direct.width, direct.height]);
    expect(calls).toEqual(['thumbs']);
    calls.splice(0);
    expect(await r.frames.at(join(dir, 'none.mp4'), [], { policy: { kind: 'person' } as never })).toEqual([]);
    expect(calls).toEqual(['thumbs']);
    calls.splice(0);
    // recover on a folder that does not exist: nothing to put back (best effort), through the root.
    await r.recover(join(dir, 'review', 'none'));
    expect(calls).toEqual(['review']);
  });

  it("a review package that cannot be loaded: load and each member reject with the loader's own error", async () => {
    const r = packageReviewer();
    const broken = new Error('cannot load @retake/review/thumbs');
    failing.next = broken;
    await expect(r.frames.load()).rejects.toBe(broken);
    expect(calls).toEqual(['thumbs']);
    failing.next = broken;
    await expect(r.frames.thumb(MEMORY_PNG)).rejects.toBe(broken);
    // Loaded the next time: the load is not kept failed.
    await expect(r.frames.load()).resolves.toBeUndefined();
  });

  it("the hook runner's journals answer as the package does, and refuse a journal another runner opened", async () => {
    const h = packageHookRunner();
    expect(await h.journals.find(dir, 'r1')).toEqual({ file: null, looked: [projectPath(dir, 'runs', 'r1', 'hooks-journal.json'), statePath(dir, 'journals', 'r1.json')] });
    expect(await h.journals.standaloneFile(dir, 'r1')).toBe(statePath(dir, 'journals', 'r1.json'));
    expect(await h.journals.openPending(dir)).toEqual([]);
    expect(calls.every((c) => c === 'hooks')).toBe(true);
    const foreign = { pending: () => [], isSigned: () => false, rollbackAll: async () => [] };
    await expect(h.run([], {} as HookContext, { phase: 'setup', journal: foreign })).rejects.toMatchObject({ name: 'EngineError', code: 'internal' });
    await expect(h.journals.rollback([{ file: 'x.json', journal: foreign }], {} as HookContext)).rejects.toMatchObject({ code: 'internal' });
    // A journal it opened runs (no hook: nothing journaled).
    const journal = await h.journals.open(statePath(dir, 'journals', 'empty.json'));
    expect(journal.pending()).toEqual([]);
    expect(await h.run([], {} as HookContext, { phase: 'teardown', journal })).toEqual({ ok: true, results: [] });
  });
});
