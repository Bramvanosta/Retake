/**
 * L5.14 (captures first): which queued job a worker's slot takes next — the pure `pick` over the stored records.
 */
import { describe, expect, it } from 'vitest';
import { pick, takeWaiting } from '../src/index.js';
import type { PickRecord } from '../src/index.js';

let n = 0;
const id = () => `j_01KA${String(n++).padStart(22, '0')}`;
const rec = (kind: string, extra: Partial<PickRecord> & { mode?: string } = {}): PickRecord => {
  const { mode, ...rest } = extra;
  return { id: id(), state: 'queued', kind, input: { kind, ...(mode ? { mode } : {}) }, claimed: false, ...rest };
};

describe('pick (L5.14)', () => {
  it('a capture goes before an older heavy job; each slot takes the oldest of its class', () => {
    const render = rec('render');
    const review = rec('review');
    const take = rec('run', { mode: 'capture' });
    const login = rec('auth_login');
    const records = [take, review, render, login]; // any order: ids decide
    expect(pick(records, { slot: 'capture', filmingLive: false })).toBe(take.id);
    // The heavy slot: a filming take of this workspace is queued.
    expect(pick(records, { slot: 'heavy', filmingLive: false })).toBeUndefined();
    expect(pick([render, review, login], { slot: 'heavy', filmingLive: false })).toBe(render.id);
    expect(pick([render, review, login], { slot: 'capture', filmingLive: false })).toBe(login.id);
  });

  it('heavy work waits while a filming marker holds (any workspace, any terminal)', () => {
    const render = rec('render');
    expect(pick([render], { slot: 'heavy', filmingLive: true })).toBeUndefined();
    expect(pick([render], { slot: 'heavy', filmingLive: false })).toBe(render.id);
  });

  it('a queued filming take here holds heavy claims — even queued behind a recording', () => {
    const record = rec('record', { state: 'running' });
    const take = rec('run', { mode: 'capture' });
    const render = rec('render');
    expect(pick([record, take, render], { slot: 'heavy', filmingLive: false })).toBeUndefined();
    expect(takeWaiting(take)).toBe(true);
  });

  it('review B M3 / L7: a claimed or running take holds by its live filming state only (the worker\'s filmingLive), a cancelled queued take holds nothing', () => {
    const render = rec('render');
    // Claimed by the capture slot (its setup hooks run) or running (setup, teardown, paused): the worker says whether it films.
    const claimed = rec('run', { mode: 'capture', claimed: true });
    const running = rec('run', { mode: 'capture', state: 'running' });
    expect(pick([claimed, running, render], { slot: 'heavy', filmingLive: false })).toBe(render.id);
    expect(pick([claimed, running, render], { slot: 'heavy', filmingLive: true })).toBeUndefined();
    const cancelled = rec('run', { mode: 'capture', cancelled: true });
    expect(takeWaiting(cancelled)).toBe(false);
    expect(pick([cancelled, render], { slot: 'heavy', filmingLive: false })).toBe(render.id);
    // It is still claimed by the capture slot, which closes it without running it.
    expect(pick([cancelled, render], { slot: 'capture', filmingLive: false })).toBe(cancelled.id);
  });

  it('only filming holds: a dry run, a recording, an inspection or hooks do not stop a render', () => {
    const render = rec('render');
    for (const r of [rec('run', { mode: 'dry' }), rec('record', { state: 'running' }), rec('inspect'), rec('hooks'), rec('sandbox_reset'), rec('auth_login', { mode: 'headed' })]) {
      expect(pick([r, render], { slot: 'heavy', filmingLive: false })).toBe(render.id);
    }
    expect(takeWaiting(rec('run', { mode: 'dry' }))).toBe(false);
  });

  it('claimed and finished jobs are not taken; an unknown kind goes to the capture slot (refused there)', () => {
    const claimed = rec('render', { claimed: true });
    const done = rec('render', { state: 'succeeded' });
    const unknown = rec('teleport');
    expect(pick([claimed, done], { slot: 'heavy', filmingLive: false })).toBeUndefined();
    expect(pick([claimed, done, unknown], { slot: 'capture', filmingLive: false })).toBe(unknown.id);
    expect(pick([unknown], { slot: 'heavy', filmingLive: false })).toBeUndefined();
  });
});
