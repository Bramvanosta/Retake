/**
 * The ports bag's L7.11 and L7.12 members, HookRunner, Reviewer and CaptureRunner: the product's adapters are the
 * default (each member loading its package on its call, through the loader of its home), a handed one is kept, and the
 * package adapters hand the package's answers on unchanged — a review's frames and thumbnails through the light
 * thumbnail entry, never the package root (the editor behind it); the capture runner's cancel is the runner's own error,
 * and its two synchronous members work once it is loaded only.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectPath, statePath } from '@retake/core';
import type { HookContext } from '@retake/core';
import { thumbJpeg } from '@retake/review/thumbs';
import { CancelledError, registerSessionCopy } from '@retake/runner-web';
import { enginePorts, packageHookRunner, packageReviewer, runnerWebCapture, systemClock } from '../src/index.js';
import type { CaptureRunner, HookBrowser, HookRunner, Reviewer } from '../src/index.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
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
  return { editor: spy('editor'), review: spy('review'), thumbs: spy('thumbs'), hooks: spy('hooks'), runnerWeb: spy('runnerWeb') };
});

const dir = await mkdtemp(join(tmpdir(), 'retake-ports-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(() => void calls.splice(0));

describe('the ports bag: the hook runner and the reviewer', () => {
  it('defaults to the package adapters and keeps the ones handed; making them loads nothing', () => {
    const p = enginePorts();
    expect(Object.keys(p).sort()).toEqual(['capture', 'clock', 'hooks', 'reviewer', 'stores']);
    expect(typeof p.capture.run).toBe('function');
    expect(typeof p.hooks.run).toBe('function');
    expect(typeof p.reviewer.frames.thumb).toBe('function');
    expect(calls).toEqual([]);
    const hooks = { marker: 'hooks' } as unknown as HookRunner;
    const reviewer = { marker: 'reviewer' } as unknown as Reviewer;
    const capture = { marker: 'capture' } as unknown as CaptureRunner;
    const given = enginePorts({ hooks, reviewer, capture });
    expect(given.hooks).toBe(hooks);
    expect(given.reviewer).toBe(reviewer);
    expect(given.capture).toBe(capture);
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

describe('the ports bag: the capture runner', () => {
  it("the runner package's cancel and clean-up work once it is loaded, and refuse before", async () => {
    const c = runnerWebCapture();
    // Made, not loaded: a signal handler of a root that forgot its load() fails loudly, never silently.
    expect(calls).toEqual([]);
    const thrown = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(thrown(() => c.cancelled('run cancelled (SIGTERM)'))).toMatchObject({ name: 'EngineError', code: 'internal' });
    expect(() => c.cleanupSync()).toThrow(/before it was loaded: its composition root awaits capture.load\(\) first/);
    await c.load();
    expect(calls).toEqual(['runnerWeb']);
    const e = c.cancelled('run cancelled (SIGTERM)');
    // The runner's own class: what runner-web's isCancelled and the engine's checks (its name, its kind) tell a cancel by.
    expect(e).toBeInstanceOf(CancelledError);
    expect(e.name).toBe('CancelledError');
    expect(e.message).toBe('run cancelled (SIGTERM)');
    expect((e as unknown as { errorKind: string }).errorKind).toBe('cancelled');
    expect(c.cancelled().message).toBe('run cancelled');
    // The session copies this process made (a persona's cookies) are removed, synchronously, and counted.
    const copy = join(dir, 'retake-session-x');
    await mkdir(copy);
    registerSessionCopy(copy);
    expect(c.cleanupSync()).toBe(1);
    expect(existsSync(copy)).toBe(false);
    expect(c.cleanupSync()).toBe(0);
  });

  it("the runner package's sessions and js-hook pages answer as the package does; a browser of another runner is refused", async () => {
    const c = runnerWebCapture();
    expect(await c.sessions.lock(join(dir, 'no-profile'))).toEqual({ state: 'none' });
    expect(await c.sessions.status(join(dir, 'no-status.json'))).toBeNull();
    expect(calls.every((x) => x === 'runnerWeb')).toBe(true);
    const foreign: HookBrowser = { close: async () => undefined };
    await expect(c.hookPages.evalIn(foreign, { project: { config: {}, slug: 'p' } as never, env: { name: 'e', pages: { a: 'http://127.0.0.1:1/' } }, log: () => undefined }, 'a', '1')).rejects.toMatchObject({ name: 'EngineError', code: 'internal' });
  });

  it('a runner package that cannot be loaded: load rejects with the loader\'s own error, and is not kept failed', async () => {
    const c = runnerWebCapture();
    const broken = new Error('cannot load @retake/runner-web');
    failing.next = broken;
    await expect(c.load()).rejects.toBe(broken);
    expect(() => c.cleanupSync()).toThrow(/before it was loaded/);
    await expect(c.load()).resolves.toBeUndefined();
    expect(c.cleanupSync()).toBe(0);
  });

  it('the in-memory runner: refuses its synchronous members before load(), as the package does; then a cancel of the runner\'s name and kind, clean-ups counted, every call kept', async () => {
    const m = new MemoryCaptureRunner();
    expect(() => m.cancelled('x')).toThrow(/the capture runner's cancelled was called before it was loaded/);
    expect(() => m.cleanupSync()).toThrow(expect.objectContaining({ name: 'EngineError', code: 'internal' }));
    expect(m.cleanups).toBe(0);
    m.calls.splice(0);
    await m.load();
    const e = m.cancelled('job cancelled (SIGINT)');
    expect([e.name, e.message, (e as unknown as { errorKind: string }).errorKind]).toEqual(['CancelledError', 'job cancelled (SIGINT)', 'cancelled']);
    expect(m.cleanupSync()).toBe(0);
    expect(m.cleanups).toBe(1);
    expect(m.calls).toEqual([{ member: 'load' }, { member: 'cancelled', message: 'job cancelled (SIGINT)' }, { member: 'cleanupSync' }]);
    // Its sessions are the in-memory ones (memory-sessions.ts): a persona that declares no check is unchecked, in the runner's words.
    expect(await m.sessions.check({ persona: { name: 'buyer' } } as never)).toEqual({ status: 'unchecked', detail: 'no check declared', ms: 0 });
    expect(calls).toEqual([]);
  });

  it('the hook runner loads its package on load(), as the capture\'s hooks need it', async () => {
    await packageHookRunner().load();
    expect(calls).toEqual(['hooks']);
    await expect(new MemoryHookRunner().load()).resolves.toBeUndefined();
  });
});
