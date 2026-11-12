/**
 * L4.4: pausing a run between steps (pause.ts) and the run's new progress events. A dry run waits at the top of a step
 * while its gate asks (run.json says `paused`, then records the pause); a cancel while paused ends the wait at once and
 * the teardown and the setup's rollbacks still run; a pause longer than its maximum stops the run the same way (a
 * capture's pause: capture-pause.test.ts). The `outline` event lists the steps the run executes (`until`, skipped scenes
 * honoured), once the secrets are known (a value written as is in a step is masked there too). Review fixes: the paused
 * event carries the pause's maximum; one length for a pause (run.json, the event); a dry run's pause is no "not filmed"
 * warning.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunProgress, RunRecord, Scenario } from '@retake/core';
import { runScenario } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { DRY_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, startServer, tempDir, testHookRunner } from './helpers.js';
import type { TestServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({
    '/dry.html': DRY_PAGE,
    '/arm': { body: '{"armed":true}', type: 'application/json' },
    '/reset': { body: '{"reset":true}', type: 'application/json' },
  });
  dir = await tempDir('rw-pause-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function run(name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> = {}): Promise<RunRecord> {
  const project = makeProject(dir, { app: server.url });
  return runScenario({
    policy: PERSON_POLICY,
    project,
    scenario: makeScenario(name, { pacing: FAST, ...scenario }),
    mode: 'dry',
    runId: `${name}-${Date.now()}`,
    hookRunner: testHookRunner(),
    ...opts,
  });
}

const HOOKS = {
  setup: [{ name: 'arm', http: { method: 'POST' as const, url: '{{app}}/arm', rollback: { method: 'DELETE' as const, url: '{{app}}/arm' } } }],
  teardown: [{ name: 'reset', http: { method: 'POST' as const, url: '{{app}}/reset' } }],
};
const THREE = [{ id: 'one', open: '/dry.html', steps: [{ hold: 0.1 }, { hold: 0.1 }, { hold: 0.1 }] }];

describe('pausing a run between steps', () => {
  it('a dry run waits before the next step while the gate asks: run.json says paused, then the pause is recorded; every step runs', async () => {
    const gate = { requested: false };
    const events: RunProgress[] = [];
    let duringPause: RunRecord | undefined;
    let runDir = '';
    const rec = await run(
      'pause-dry',
      { scenes: THREE },
      {
        pause: gate,
        onProgress: (e) => {
          events.push(e);
          if (e.type === 'run_start') runDir = e.run.dir;
          if (e.type === 'step_end' && e.step === 0) gate.requested = true;
          if (e.type === 'pause' && e.state === 'paused') {
            setTimeout(() => {
              void readFile(join(runDir, 'run.json'), 'utf8').then((t) => (duringPause = JSON.parse(t) as RunRecord));
            }, 400);
            setTimeout(() => (gate.requested = false), 1200);
          }
        },
      },
    );
    expect(rec.status, rec.error?.message).toBe('succeeded');
    expect(rec.steps_done).toBe(3);
    expect(duringPause?.paused).toMatchObject({ scene: 'one', step: 1 });
    expect(rec.paused).toBeUndefined();
    expect(rec.pauses).toHaveLength(1);
    expect(rec.pauses![0]).toMatchObject({ scene: 'one', step: 1 });
    expect(rec.pauses![0].ms).toBeGreaterThanOrEqual(1100);
    const onDisk = JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')) as RunRecord;
    expect(onDisk.paused).toBeUndefined();
    expect(onDisk.pauses).toEqual(rec.pauses);
    // The paused event says how long the pause may last (the Run screen shows it); the resumed one the same length as
    // run.json. A dry run films nothing: no "not filmed" warning (that one is a capture's).
    const pausedEv = events.find((e) => e.type === 'pause' && e.state === 'paused') as { max_ms?: number } | undefined;
    expect(pausedEv?.max_ms).toBe(30 * 60_000);
    expect((events.find((e) => e.type === 'pause' && e.state === 'resumed') as { ms?: number } | undefined)?.ms).toBe(rec.pauses![0].ms);
    expect(rec.warnings.filter((w) => /not filmed/.test(w))).toEqual([]);
    // Between step 0's end and step 1's start: paused, then resumed.
    const order = events.filter((e) => e.type === 'pause' || e.type === 'step_start' || e.type === 'step_end').map((e) => (e.type === 'pause' ? `pause ${e.state} ${e.step}` : `${e.type} ${e.step}`));
    expect(order).toEqual(['step_start 0', 'step_end 0', 'pause paused 1', 'pause resumed 1', 'step_start 1', 'step_end 1', 'step_start 2', 'step_end 2']);
    const log = (await readFile(join(rec.dir, 'log.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunProgress);
    expect(log.filter((e) => e.type === 'pause').map((e) => (e as { state: string }).state)).toEqual(['paused', 'resumed']);
  });

  it("a cancel while paused ends the wait at once: cancelled, the teardown and the setup's rollback still run, no `paused` left", async () => {
    const gate = { requested: true };
    const ac = new AbortController();
    const from = server.hits.length;
    let pausedAt = 0;
    const rec = await run(
      'pause-cancel',
      { ...HOOKS, scenes: THREE },
      {
        pause: gate,
        hooks: 'run',
        signal: ac.signal,
        onProgress: (e) => {
          if (e.type === 'pause' && e.state === 'paused') {
            pausedAt = Date.now();
            setTimeout(() => ac.abort(), 300);
          }
        },
      },
    );
    expect(Date.now() - pausedAt).toBeLessThan(5000);
    expect(rec.status).toBe('cancelled');
    expect(rec.steps_done).toBe(0);
    expect(rec.hooks).toEqual({ setup: 'ok', teardown: 'ok' });
    expect(
      server.hits
        .slice(from)
        .filter((h) => h.path === '/arm' || h.path === '/reset')
        .map((h) => `${h.method} ${h.path}`),
    ).toEqual(['POST /arm', 'POST /reset', 'DELETE /arm']);
    expect(rec.paused).toBeUndefined();
    expect(rec.pauses).toHaveLength(1);
    expect(rec.pauses![0]).toMatchObject({ scene: 'one', step: 0 });
    const onDisk = JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')) as RunRecord;
    expect(onDisk.status).toBe('cancelled');
    expect(onDisk.paused).toBeUndefined();
  });

  it('a pause longer than its maximum stops the run (cancelled, with the reason; the teardown runs)', async () => {
    const t0 = Date.now();
    const rec = await run('pause-max', { ...HOOKS, scenes: THREE }, { pause: { requested: true, maxMs: 400 }, hooks: 'run' });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(rec.status).toBe('cancelled');
    expect(rec.error?.message).toMatch(/^paused longer than 0\.4 s before step one\.0: the run was stopped/);
    expect(rec.hooks.teardown).toBe('ok');
    expect(rec.pauses![0].ms).toBeGreaterThanOrEqual(400);
    expect(rec.pauses![0].ms).toBeLessThan(3000);
  });

  it('the outline lists the steps the run executes before any step starts: `until` and skipped scenes honoured; secrets masked', async () => {
    const events: RunProgress[] = [];
    // A secret the scene uses ({{env:…}}, resolved by an injected reader), also written as is in a step (review A: the
    // outline came before the secrets were resolved, so that step's description showed it).
    const SECRET = 'Sesame-Open-2026';
    await run(
      'outline',
      {
        scenes: [
          { id: 'skipped', skip: true, open: '/dry.html', steps: [{ hold: 0.1 }] },
          { id: 'one', open: '/dry.html?k={{env:DS_PAUSE_TEST_SECRET}}', steps: [{ hold: 0.1 }, { click: { css: '#save' } }, { hold: 0.1 }] },
          { id: 'two', open: '/dry.html', steps: [{ hold: 0.1 }] },
        ],
      },
      { until: 'one.1', onProgress: (e) => events.push(e), resolveSecret: async () => SECRET },
    );
    // The literal value in a step: a second run, the same secret (an `optional` click on a text nobody shows).
    const literal: RunProgress[] = [];
    await run(
      'outline-literal',
      { scenes: [{ id: 'one', open: '/dry.html?k={{env:DS_PAUSE_TEST_SECRET}}', steps: [{ click: SECRET, optional: true, timeout: 0.3 }] }] },
      { onProgress: (e) => literal.push(e), resolveSecret: async () => SECRET },
    );
    expect(events[0].type).toBe('run_start');
    const at = events.findIndex((e) => e.type === 'outline');
    expect(at).toBeGreaterThan(0);
    expect(events.findIndex((e) => e.type === 'scene_start' || e.type === 'step_start')).toBeGreaterThan(at);
    expect(events[at]).toEqual({
      type: 'outline',
      steps: [
        { scene: 'one', step: 0, action: 'hold', desc: expect.any(String) },
        { scene: 'one', step: 1, action: 'click', desc: expect.stringContaining('#save') },
      ],
    });
    const outline = literal.find((e) => e.type === 'outline') as { steps: Array<{ desc: string }> } | undefined;
    expect(outline?.steps).toHaveLength(1);
    expect(outline!.steps[0].desc).not.toContain(SECRET);
    expect(outline!.steps[0].desc).toContain('***');
    expect(JSON.stringify(literal)).not.toContain(SECRET);
  });
});
