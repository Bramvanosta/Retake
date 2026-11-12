/**
 * The capture runner's contract for a run (the CaptureRunner port's `run`, `load`, `cancelled`, `cleanupSync`;
 * src/capture/runner.ts), one suite every adapter passes: the runner package (`runnerWebCapture`, a real headless
 * Chromium on a local page) and the in-memory runner (src/capture/memory-capture.ts). A dry run succeeds with a timeline
 * and its events in order; a capture writes a video and a timeline and tells `onFilming` start then stop; a cancel
 * before the run (the port's own `cancelled()` as the reason) and during it gives a cancelled record with the reason's
 * message; `until` stops after its step; a dry run waits at the pause gate and records the pause; a watched live sink
 * gets frames; an inspection's report reaches `onResult` and its folder is `runsDir/runId`; the setup and teardown run
 * through the handed hook runner, in that order, as the agent's (`agentWritten`); `cancelled` and `cleanupSync` work
 * once loaded.
 *
 * Not here, because it is not an adapter's: what the engine builds the request from (execute-run.ts, inspect-job.ts:
 * capture-runner.test.ts), and everything a real browser does on a page (runner-web's own tests).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { LoadedProject, RunProgress, RunRecord, Scenario } from '@retake/core';
import type { InspectReport, LiveFrame } from '@retake/runner-web/types';
import type { CaptureRequest, CaptureRunner } from '../src/capture/runner.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { FAST, makeScenario } from '../../runner-web/test/helpers.js';

export interface ContractCapture {
  runner: CaptureRunner;
  /** A project (a folder of its own) whose environment `test` has the page `app`, served for a real browser. */
  project: LoadedProject;
}

const ONE = [{ id: 'one', page: 'app', open: '/', steps: [{ hold: 0.2 }, { hold: 0.2 }, { hold: 0.2 }] }];

/** `make(name)`: an adapter and its project, new each call. */
export function captureRunnerContract(adapter: string, make: (name: string) => Promise<ContractCapture>, o: { skip?: boolean } = {}): void {
  describe.skipIf(o.skip === true)(`the capture runner contract (${adapter})`, () => {
    let n = 0;
    const request = (c: ContractCapture, name: string, scenario: Omit<Scenario, 'video'>, over: Partial<CaptureRequest> = {}): CaptureRequest => ({
      policy: PERSON_POLICY,
      project: c.project,
      scenario: makeScenario(name, { pacing: FAST, ...scenario }),
      mode: 'dry',
      env: 'test',
      runId: `20261111-1200${String(n++).padStart(2, '0')}-${name}`,
      hookRunner: new MemoryHookRunner(),
      ...over,
    });
    const onDisk = async (rec: RunRecord) => JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')) as RunRecord;

    it('a dry run: a succeeded record (run.json too), a timeline, run_start first, each step started then ended, run_end last', async () => {
      const c = await make('dry');
      const events: RunProgress[] = [];
      const rec = await c.runner.run(request(c, 'dry', { scenes: ONE }, { onProgress: (e) => events.push(e) }));
      expect(rec.error?.message).toBeUndefined();
      expect(rec).toMatchObject({ status: 'succeeded', mode: 'dry', steps_total: 3, steps_done: 3, env: 'test' });
      expect(rec.timeline && existsSync(rec.timeline)).toBe(true);
      expect(rec.capture).toBeUndefined();
      expect((await onDisk(rec)).status).toBe('succeeded');
      expect(events[0]?.type).toBe('run_start');
      expect(events.at(-1)?.type).toBe('run_end');
      const steps = events.flatMap((e) => (e.type === 'step_start' || e.type === 'step_end' ? [`${e.type} ${e.scene}.${e.step}`] : []));
      expect(steps).toEqual(['step_start one.0', 'step_end one.0', 'step_start one.1', 'step_end one.1', 'step_start one.2', 'step_end one.2']);
    });

    it('a capture: a video and a timeline; onFilming start, then stop, never for a dry run', async () => {
      const c = await make('capture');
      const filming: string[] = [];
      const rec = await c.runner.run(request(c, 'capture', { scenes: ONE }, { mode: 'capture', onFilming: (s) => void filming.push(s) }));
      expect(rec.error?.message).toBeUndefined();
      expect(rec.status).toBe('succeeded');
      expect(rec.capture && existsSync(rec.capture)).toBe(true);
      expect(rec.timeline && existsSync(rec.timeline)).toBe(true);
      expect(filming).toEqual(['start', 'stop']);
      const dry: string[] = [];
      await c.runner.run(request(c, 'capture-dry', { scenes: ONE }, { onFilming: (s) => void dry.push(s) }));
      expect(dry).toEqual([]);
    });

    it("a cancel before the run (the port's own cancel as the reason) and during it: a cancelled record with the reason's message", async () => {
      const c = await make('cancel');
      await c.runner.load();
      const before = new AbortController();
      before.abort(c.runner.cancelled('run cancelled (cancel requested)'));
      const early = await c.runner.run(request(c, 'cancel-before', { scenes: ONE }, { signal: before.signal }));
      expect(early.status).toBe('cancelled');
      expect(early.error?.message).toBe('run cancelled (cancel requested)');
      expect(early.steps_done).toBe(0);
      expect((await onDisk(early)).status).toBe('cancelled');

      const during = new AbortController();
      const ends: string[] = [];
      const t0 = Date.now();
      const rec = await c.runner.run(
        request(
          c,
          'cancel-during',
          { scenes: [{ id: 'one', page: 'app', open: '/', steps: [{ hold: 0.1 }, { wait: 20 }, { hold: 0.1 }] }] },
          {
            signal: during.signal,
            onProgress: (e) => {
              if (e.type === 'step_start' && e.step === 1) setTimeout(() => during.abort(c.runner.cancelled('run cancelled (SIGTERM)')), 200);
              if (e.type === 'step_end') ends.push(`${e.step} ${e.status}`);
            },
          },
        ),
      );
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(rec.status).toBe('cancelled');
      expect(rec.error?.message).toBe('run cancelled (SIGTERM)');
      // The step the cancel stopped counts as attempted (its step_end says failed); the next one never starts.
      expect(ends).toEqual(['0 ok', '1 failed']);
      expect(rec.steps_done).toBe(2);
      expect(rec.steps_total).toBe(3);
    });

    it('`until` stops after its step: the steps up to it ran, the record says where and why', async () => {
      const c = await make('until');
      const rec = await c.runner.run(request(c, 'until', { scenes: ONE }, { until: 'one.1' }));
      expect(rec.status).toBe('succeeded');
      expect(rec.steps_total).toBe(2);
      expect(rec.steps_done).toBe(2);
      expect(rec.stopped_at).toEqual({ scene: 'one', step: 1, reason: 'until' });
      expect(rec.options.until).toBe('one.1');
    });

    it('a dry run waits at the pause gate while it asks: paused, then resumed, the pause recorded; every step runs', async () => {
      const c = await make('pause');
      const gate = { requested: true };
      const events: RunProgress[] = [];
      const rec = await c.runner.run(
        request(
          c,
          'pause',
          { scenes: ONE },
          {
            pause: gate,
            onProgress: (e) => {
              events.push(e);
              if (e.type === 'pause' && e.state === 'paused') setTimeout(() => (gate.requested = false), 300);
            },
          },
        ),
      );
      expect(rec.status).toBe('succeeded');
      expect(rec.steps_done).toBe(3);
      const pauses = events.flatMap((e) => (e.type === 'pause' ? [`${e.state} ${e.scene}.${e.step}`] : []));
      expect(pauses).toEqual(['paused one.0', 'resumed one.0']);
      expect(rec.pauses).toHaveLength(1);
      expect(rec.pauses![0]).toMatchObject({ scene: 'one', step: 0 });
      expect(rec.pauses![0]!.ms).toBeGreaterThanOrEqual(250);
      expect(rec.paused).toBeUndefined();
    });

    it('a watched live sink gets frames; one nobody watches gets none', async () => {
      const c = await make('live');
      const sink = (wanted: boolean) => {
        const frames: LiveFrame[] = [];
        return { frames, sink: { wanted, onWanted: () => () => undefined, frame: (f: LiveFrame) => void frames.push(f) } };
      };
      const watched = sink(true);
      const rec = await c.runner.run(request(c, 'live', { scenes: ONE }, { live: watched.sink }));
      expect(rec.status).toBe('succeeded');
      expect(watched.frames.length).toBeGreaterThan(0);
      expect(watched.frames[0]!.data.length).toBeGreaterThan(0);
      const nobody = sink(false);
      await c.runner.run(request(c, 'live-off', { scenes: ONE }, { live: nobody.sink }));
      expect(nobody.frames).toEqual([]);
    });

    it("an inspection: its report reaches onResult and inspect.json, in the folder runsDir/runId; the scenario's hooks are skipped", async () => {
      const c = await make('inspect');
      const runsDir = join(c.project.dir, '.retake', 'inspect');
      const reports: InspectReport[] = [];
      const hookRunner = new MemoryHookRunner();
      const rec = await c.runner.run(
        request(
          c,
          'inspect',
          { setup: [{ name: 'arm', shell: { run: 'true' } }], scenes: ONE },
          { runsDir, runId: 'i_01JCONTRACTINSPECT0000000', hookRunner, inspect: { onResult: (r) => void reports.push(r) } },
        ),
      );
      expect(rec.error?.message).toBeUndefined();
      expect(rec.dir).toBe(join(runsDir, 'i_01JCONTRACTINSPECT0000000'));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ version: 1, status: 'ok', at: 'end', file: join(rec.dir, 'inspect.json') });
      expect(reports[0]!.replay).toMatchObject({ steps_done: 3, steps_total: 3, hooks: 'skipped' });
      expect(existsSync(join(rec.dir, 'inspect.json'))).toBe(true);
      expect(hookRunner.calls).toEqual([]);
      expect(rec.hooks.setup).toBe('skipped');
    });

    it("the setup, then the teardown, run through the handed hook runner as the agent's; their outcome is the record's", async () => {
      const c = await make('hooks');
      const hookRunner = new MemoryHookRunner();
      const rec = await c.runner.run(
        request(c, 'hooks', { setup: [{ name: 'arm', shell: { run: 'true' } }], teardown: [{ name: 'reset', shell: { run: 'true' } }], scenes: ONE }, { hooks: 'run', hookRunner }),
      );
      expect(rec.error?.message).toBeUndefined();
      expect(rec.hooks).toEqual({ setup: 'ok', teardown: 'ok' });
      const runs = hookRunner.calls.flatMap((x) => (x.op === 'run' ? [{ phase: x.phase, names: x.hooks.map((h) => h.name), agentWritten: x.agentWritten, dry: x.dry }] : []));
      expect(runs).toEqual([
        { phase: 'setup', names: ['arm'], agentWritten: true, dry: false },
        { phase: 'teardown', names: ['reset'], agentWritten: true, dry: false },
      ]);
      expect(hookRunner.calls[0]).toEqual({ op: 'journals.open', arg: join(rec.dir, 'hooks-journal.json') });
      expect(hookRunner.executed.map((e) => `${e.phase} ${e.name}`)).toEqual(['setup arm', 'teardown reset']);
    });

    it('a hook runner whose load fails fails the run, nothing run, in the words of a hooks package that could not be loaded', async () => {
      const c = await make('hooks-broken');
      const hookRunner = new MemoryHookRunner();
      hookRunner.load = async () => {
        throw new Error('Cannot find package');
      };
      const rec = await c.runner.run(request(c, 'hooks-broken', { setup: [{ name: 'arm', shell: { run: 'true' } }], scenes: ONE }, { hooks: 'run', hookRunner }));
      expect(rec.status).toBe('failed');
      expect(rec.error?.message).toBe('this scenario has hooks (setup, teardown or hook steps) but @retake/hooks could not be loaded: Cannot find package');
      expect(hookRunner.calls).toEqual([]);
    });

    it('once loaded: the cancel is a CancelledError of kind cancelled, its message kept; the clean-up answers a count', async () => {
      const c = await make('sync');
      await c.runner.load();
      const e = c.runner.cancelled('run cancelled (SIGINT)');
      expect(e.name).toBe('CancelledError');
      expect((e as Error & { errorKind?: string }).errorKind).toBe('cancelled');
      expect(e.message).toBe('run cancelled (SIGINT)');
      expect(typeof c.runner.cleanupSync()).toBe('number');
    });
  });
}
