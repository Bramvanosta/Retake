/**
 * L4.2 part 3: the scenario screen's logic without a browser — the thumbnail loader (only rows on screen, ≤ 24 keys
 * of one run per call, ≤ 2 calls at a time, a call aborted when its rows all left the screen, `budget` / `cancelled`
 * asked again, a hostile answer never becomes a picture, keyed by run and the run's own key) and which events make the
 * screen read its view again (its own file, its runs starting / finishing / going away, a reconnection — never a
 * run's progress, another scenario or another project).
 */
import { describe, expect, it } from 'vitest';
import { scenarioEventAction } from '../src/app/events.js';
import type { StudioEvent } from '../src/app/events.js';
import { BATCH_MAX, IN_FLIGHT_MAX, ThumbLoader } from '../src/app/thumbs.js';
import type { ThumbAnswer } from '../src/app/thumbs.js';
import { bindingWords, layoutWords, missingWords, runErrorWords } from '../src/app/words/scenario-words.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]).toString('base64');

/** What every answer names (the loader keys by the run it asked for, not by these). */
const OF = { project: 'p', run: 'r' };

interface Pending {
  run: string;
  keys: string[];
  signal: AbortSignal;
  resolve(a: ThumbAnswer): void;
  reject(e: unknown): void;
}

/** A loader whose calls and timer the test drives by hand. */
function harness(o: { cacheMax?: number } = {}) {
  const calls: Pending[] = [];
  const timers: Array<() => void> = [];
  const loader = new ThumbLoader({
    fetch: (run, keys, signal) =>
      new Promise<ThumbAnswer>((resolve, reject) => {
        const p: Pending = { run, keys, signal, resolve, reject };
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        calls.push(p);
      }),
    schedule: (fn) => void timers.push(fn),
    ...(o.cacheMax ? { cacheMax: o.cacheMax } : {}),
  });
  const tick = () => {
    for (const t of timers.splice(0)) t();
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const ok = (keys: string[]): ThumbAnswer => ({ ...OF, thumbs: keys.map((key) => ({ key, mime: 'image/jpeg', base64: JPEG, width: 480, height: 270, from: 'frame' })), missing: [] });
  return { loader, calls, tick, flush, ok };
}

const keys = (n: number, scene = 's') => Array.from({ length: n }, (_x, i) => `${scene}.${i}`);

describe('ThumbLoader', () => {
  it('asks only for rows on screen, in calls of at most 24 keys of one run, at most 2 at a time', async () => {
    const h = harness();
    for (const k of keys(60)) h.loader.setVisible('run-a', k, true);
    expect(h.calls).toHaveLength(0); // batched after the delay
    h.tick();
    expect([BATCH_MAX, IN_FLIGHT_MAX]).toEqual([24, 2]);
    expect(h.calls.map((c) => c.keys.length)).toEqual([24, 24]);
    expect(h.loader.inFlight).toBe(2);
    expect(h.calls.every((c) => c.run === 'run-a')).toBe(true);
    h.calls[0].resolve(h.ok(h.calls[0].keys));
    await h.flush();
    h.tick();
    expect(h.calls.map((c) => c.keys.length)).toEqual([24, 24, 12]);
    expect(h.calls[2].keys[0]).toBe('s.48');
    expect(h.loader.get('run-a', 's.0')).toMatchObject({ state: 'ok', base64: JPEG, width: 480, height: 270 });
    // A key already known is never asked again.
    h.loader.setVisible('run-a', 's.0', false);
    h.loader.setVisible('run-a', 's.0', true);
    h.tick();
    expect(h.calls).toHaveLength(3);
  });

  it('keys are per run: the same step key of another run is another picture', async () => {
    const h = harness();
    h.loader.setVisible('run-a', 'one.0', true);
    h.loader.setVisible('run-b', 'one.0', true);
    h.tick();
    expect(h.calls.map((c) => [c.run, c.keys])).toEqual([
      ['run-a', ['one.0']],
      ['run-b', ['one.0']],
    ]);
    h.calls[0].resolve(h.ok(['one.0']));
    await h.flush();
    expect(h.loader.get('run-a', 'one.0')?.state).toBe('ok');
    expect(h.loader.get('run-b', 'one.0')).toBeUndefined();
  });

  it('aborts a call whose rows all left the screen (scroll-away); asks again when they come back', async () => {
    const h = harness();
    for (const k of keys(30)) h.loader.setVisible('r', k, true);
    h.tick();
    const [first, second] = h.calls;
    // One row of the first call is still on screen: it goes on. Every row of the second left: aborted.
    for (const k of first.keys.slice(1)) h.loader.setVisible('r', k, false);
    for (const k of second.keys) h.loader.setVisible('r', k, false);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
    await h.flush();
    expect(h.loader.inFlight).toBe(1);
    expect(h.loader.get('r', second.keys[0])).toBeUndefined(); // not cached as missing
    h.loader.setVisible('r', second.keys[0], true);
    h.tick();
    expect(h.calls.at(-1)?.keys).toEqual([second.keys[0]]);
    // The screen goes away: everything in flight is aborted.
    h.loader.close();
    expect(h.calls.every((c) => c.signal.aborted)).toBe(true);
  });

  it('budget and cancelled are asked again while on screen; other reasons are kept; an all-budget answer does not loop', async () => {
    const h = harness();
    for (const k of keys(4)) h.loader.setVisible('r', k, true);
    h.tick();
    h.calls[0].resolve({
      ...OF,
      thumbs: [{ key: 's.0', mime: 'image/jpeg', base64: JPEG, width: 4, height: 3, from: 'screenshot' }],
      missing: [
        { key: 's.1', reason: 'budget' },
        { key: 's.2', reason: 'not_reached' },
        { key: 's.3', reason: 'cancelled' },
      ],
    });
    await h.flush();
    h.tick();
    expect(h.calls[1].keys).toEqual(['s.1', 's.3']);
    expect(h.loader.get('r', 's.2')).toEqual({ state: 'missing', reason: 'not_reached' });
    h.calls[1].resolve({
      ...OF,
      thumbs: [],
      missing: [
        { key: 's.1', reason: 'budget' },
        { key: 's.3', reason: 'budget' },
      ],
    });
    await h.flush();
    h.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.loader.get('r', 's.1')).toEqual({ state: 'missing', reason: 'failed' });
  });

  it('a hostile answer never becomes a picture: bad base64, a scheme, markup, absurd sizes, keys not asked for', async () => {
    const h = harness();
    for (const k of keys(6)) h.loader.setVisible('r', k, true);
    h.tick();
    h.calls[0].resolve({
      ...OF,
      thumbs: [
        { key: 's.0', mime: 'image/jpeg', base64: 'javascript:alert(1)', width: 4, height: 3, from: 'frame' },
        { key: 's.1', mime: 'image/jpeg', base64: `${JPEG}"><img src=x onerror=alert(1)>`, width: 4, height: 3, from: 'frame' },
        { key: 's.2', mime: 'image/jpeg', base64: JPEG, width: 100_000, height: 3, from: 'frame' },
        { key: 's.3', mime: 'image/jpeg', base64: JPEG, width: -1, height: 3, from: 'frame' },
        { key: 's.4', mime: 'image/jpeg', base64: JPEG, width: 4, height: 3, from: 'frame' },
        { key: 'other.0', mime: 'image/jpeg', base64: JPEG, width: 4, height: 3, from: 'frame' },
      ],
      // @ts-expect-error — a hostile answer: a reason the engine never gives
      missing: [{ key: 's.5', reason: '<script>' }],
    });
    await h.flush();
    for (const k of ['s.0', 's.1', 's.2', 's.3']) expect(h.loader.get('r', k), k).toEqual({ state: 'missing', reason: 'unreadable' });
    expect(h.loader.get('r', 's.4')?.state).toBe('ok');
    expect(h.loader.get('r', 'other.0')).toBeUndefined();
    expect(h.loader.get('r', 's.5')).toEqual({ state: 'missing', reason: 'unreadable' });
  });

  it('a failed call marks its keys (no retry loop); listeners hear about their own key only', async () => {
    const h = harness();
    let heard = 0;
    let other = 0;
    h.loader.subscribe('r', 's.0', () => heard++);
    h.loader.subscribe('r', 's.9', () => other++);
    h.loader.setVisible('r', 's.0', true);
    h.tick();
    h.calls[0].reject(new Error('500'));
    await h.flush();
    h.tick();
    expect(h.loader.get('r', 's.0')).toEqual({ state: 'missing', reason: 'failed' });
    expect(h.calls).toHaveLength(1);
    expect(heard).toBe(1);
    expect(other).toBe(0);
  });

  it('keeps at most cacheMax pictures, dropping the oldest off screen first', async () => {
    const h = harness({ cacheMax: 5 });
    for (const k of keys(8)) h.loader.setVisible('r', k, true);
    h.tick();
    h.calls[0].resolve(h.ok(keys(8)));
    await h.flush();
    expect(keys(8).filter((k) => h.loader.get('r', k))).toHaveLength(8); // all on screen: none dropped
    for (const k of keys(4)) h.loader.setVisible('r', k, false);
    h.loader.setVisible('r', 'x.0', true);
    h.tick();
    h.calls[1].resolve(h.ok(['x.0']));
    await h.flush();
    expect([...keys(8), 'x.0'].filter((k) => h.loader.get('r', k))).toEqual(['s.4', 's.5', 's.6', 's.7', 'x.0']);
  });
});

describe('scenario screen events (critique B1)', () => {
  const ws = (e: Partial<Extract<StudioEvent, { type: 'workspace' }>>): StudioEvent => ({ type: 'workspace', projects: ['p'], readme: [], ...e });
  const run = (change: 'new' | 'status' | 'progress' | 'removed', o: { project?: string; scenario?: string | null; run?: string } = {}) => ({
    project: o.project ?? 'p',
    run: o.run ?? '20261023-100000-quote',
    scenario: o.scenario === undefined ? 'quote' : o.scenario,
    status: 'running',
    finished: false,
    change,
  });
  const act = (e: StudioEvent) => scenarioEventAction(e, 'p', 'quote');

  it('re-reads for its own file, its runs appearing / changing status / going away, and a reconnection', () => {
    expect(act(ws({ scenarios: ['p/quote'] }))).toEqual({ reread: true, progress: [] });
    for (const c of ['new', 'status', 'removed'] as const) expect(act(ws({ runs: [run(c)] })).reread, c).toBe(true);
    expect(act({ type: 'resync' })).toEqual({ reread: true, progress: [] });
  });

  it('a run of its scenario that only progressed: a run_status read, never the view', () => {
    expect(act(ws({ runs: [run('progress'), run('progress', { run: 'b' })] }))).toEqual({ reread: false, progress: ['20261023-100000-quote', 'b'] });
  });

  it('ignores everything else: another scenario, another project, a run with no scenario, a README, jobs, the index', () => {
    for (const e of [
      ws({}),
      ws({ scenarios: ['p/catalogue', 'other/quote', 'p/quote2'] }),
      ws({ runs: [run('status', { scenario: 'catalogue' }), run('new', { project: 'other' }), run('status', { scenario: null })] }),
      ws({ readme: ['p'] }),
      { type: 'index', generation: 3 } as StudioEvent,
    ]) {
      expect(act(e), JSON.stringify(e)).toEqual({ reread: false, progress: [] });
    }
  });

  it('a jobs event: no re-read, only a check of the run shown running (review B M4: a dead worker writes no run.json)', () => {
    expect(act({ type: 'jobs', changed: ['job-1'] } as StudioEvent)).toEqual({ reread: false, progress: [], jobs: true });
  });
});

describe('scenario screen words (review fixes)', () => {
  it('a run error leads with the screen’s 1-based step (review B M2); anything else is left as it is', () => {
    expect(runErrorWords('scene proposal, step 2 (click “Send”): timeout')).toBe('step 3 of proposal (click “Send”): timeout');
    expect(runErrorWords('scene a, step 0: unknown page "x"')).toBe('step 1 of a: unknown page "x"');
    expect(runErrorWords('page.goto: net::ERR_CONNECTION_REFUSED (scene a, step 0)')).toBe('page.goto: net::ERR_CONNECTION_REFUSED (scene a, step 0)');
  });

  it('a step with no single action says so (review B M3)', () => {
    expect(missingWords({ missing: 'unreadable', why: 'this step has no single action (fix it in the file)' })).toBe('Cannot tell: this step has no single action (fix it in the file)');
  });

  it('a scene’s layout: its frame, else the video’s, else the render’s choice for several pages (review B M1)', () => {
    expect(layoutWords(undefined, 'pip', 2)).toBe('2 pages, picture in picture (pip) — the video’s frame');
    expect(layoutWords('split', 'pip', 2)).toBe('2 pages, side by side (split)');
    expect(layoutWords(undefined, undefined, 2)).toMatch(/^2 pages: chosen at render — side by side \(split\), or picture in picture \(pip\)/);
    expect(layoutWords('phone', undefined, 1)).toBe('frame phone');
    expect(layoutWords(undefined, undefined, 1)).toBe("the video's");
  });
});

describe('scenario screen words', () => {
  it('says every state of a step without a picture in words', () => {
    expect(missingWords({ missing: 'not_reached', why: 'the run failed at step 1 of two' })).toBe('Not reached: the run failed at step 1 of two');
    expect(missingWords({ missing: 'changed', run_key: 'one.1' })).toBe('Changed since this run');
    expect(missingWords({ missing: 'new' })).toBe('New since this run');
    expect(missingWords({ missing: 'scene_changed' })).toMatch(/scene changed/);
    expect(missingWords({ missing: 'scene_skipped' })).toMatch(/skipped/);
    expect(missingWords({ missing: 'scene_not_in_run' })).toMatch(/not in this run/);
    expect(missingWords({ missing: 'unreadable' })).toMatch(/^Cannot tell/);
    expect(bindingWords(undefined, false)).toBe('no run with pictures yet');
    expect(bindingWords({ run_key: 'a.0', status: 'failed', picture: 'error_screenshot' }, true)).toBe('failed in this run');
    expect(bindingWords({ run_key: 'a.0', status: 'dry', picture: null }, true)).toBe('not executed (irreversible)');
  });
});
