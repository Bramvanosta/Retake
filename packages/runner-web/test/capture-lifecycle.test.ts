/**
 * The capture lifecycle without a browser (L7.31, finding X2: runner-web capture/lifecycle.ts over the driver seam,
 * capture/driver.ts): a driver of the test's own runs the phases the browser driver runs, so another driver could be
 * added — the run folder, record and log, the hook phases around the driver's, the filming notices, the timeline built
 * from the driver's take, a failure, a discard and a cancel.
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, TimelineSchema } from '@retake/core';
import type { RunProgress, Scenario } from '@retake/core';
import type { CaptureDriver, CaptureRun, DriverTake } from '../src/capture/driver.js';
import { runCapture } from '../src/capture/lifecycle.js';
import type { RunOptions } from '../src/capture/options.js';
import { LoginPageError, StepError } from '../src/errors.js';
import type { HookStepOutcome } from '../src/runtime.js';
import { StepFailure } from '../src/scenes.js';
import { makeProject, makeScenario, tempDir, testHookRunner } from './helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await tempDir('rw-lifecycle-');
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A driver that films nothing: it says which phase ran, with what it saw of the run then. */
class FakeDriver implements CaptureDriver {
  readonly calls: string[] = [];
  hookStep: ((name: string) => Promise<HookStepOutcome>) | null = null;
  stepHook: HookStepOutcome | null = null;
  /** What the js hooks ran in the driver's pages. */
  readonly evaluated: Array<[string | undefined, string]> = [];
  constructor(
    private readonly run: CaptureRun,
    private readonly o: { film?: (run: CaptureRun, d: FakeDriver) => Promise<void>; discard?: boolean; file?: (p: string) => boolean } = {},
  ) {}
  private seen(phase: string, extra = ''): void {
    this.calls.push(`${phase}${extra}`);
  }
  async prepare(): Promise<void> {
    this.seen('prepare');
  }
  identify(): void {
    this.run.secrets.addValue('s3cr3t-of-the-driver');
    this.seen('identify');
  }
  async open(): Promise<void> {
    this.seen('open');
  }
  hooks() {
    this.seen('hooks');
    return {
      evalInPage: async (page: string | undefined, code: string) => {
        this.evaluated.push([page, code]);
        return 'from the fake page';
      },
    };
  }
  setHookSteps(run: (name: string) => Promise<HookStepOutcome>): void {
    this.hookStep = run;
    this.seen('setHookSteps');
  }
  async film(): Promise<void> {
    this.seen('film', this.o.file?.('setup') ? ' (after the setup)' : '');
    this.run.startCapture();
    this.run.clock.t0Wall -= 2000; // two seconds of take
    this.run.timeline.warn('a warning of the take: s3cr3t-of-the-driver');
    if (this.hookStep) this.stepHook = await this.hookStep('mark');
    await this.o.film?.(this.run, this);
  }
  async failed(e: unknown): Promise<unknown> {
    this.seen('failed');
    return e;
  }
  async stop(): Promise<void> {
    this.run.endT = this.run.captureStarted ? this.run.clock.now() : 0;
    this.run.stopFilming();
    this.seen('stop', this.o.file?.('teardown') ? ' (after the teardown?)' : '');
  }
  async close(): Promise<void> {
    this.seen('close', this.o.file?.('teardown') ? ' (after the teardown)' : '');
  }
  async finish(): Promise<DriverTake> {
    this.seen('finish');
    return { discard: this.o.discard === true, capture: { file: '', frames: 3, frameTimes: [0, 0.5, 1] } };
  }
  cleanupSync(): void {
    this.seen('cleanupSync');
  }
}

function opts(name: string, scenario: Omit<Scenario, 'video'>, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    policy: PERSON_POLICY,
    project: makeProject(dir, { app: 'http://127.0.0.1:9' }),
    scenario: makeScenario(name, scenario),
    mode: 'capture',
    runId: `${name}-${Date.now()}`,
    hookRunner: testHookRunner(),
    ...extra,
  };
}

describe('the capture lifecycle over a driver (L7.31)', () => {
  it("runs the driver's phases in order around the hooks, tells the filming, and writes run.json and the timeline of its take", async () => {
    const marks = join(dir, 'marks');
    const file = (p: string) => existsSync(`${marks}-${p}`);
    let driver!: FakeDriver;
    const events: RunProgress[] = [];
    const filming: string[] = [];
    const rec = await runCapture(
      opts('phases', {
        setup: [{ name: 'setup', shell: `touch ${marks}-setup` }, { name: 'page', js: { code: 'return document.title', page: 'app' } }],
        teardown: [{ name: 'teardown', shell: `touch ${marks}-teardown` }],
        hooks: { mark: [{ name: 'mark', shell: 'true' }] },
        scenes: [{ id: 'one', steps: [{ wait: 10 }, { hook: 'mark' }] }],
      }, { onProgress: (e) => events.push(e), onFilming: (s) => void filming.push(s) }),
      (run) => (driver = new FakeDriver(run, { file })),
    );
    expect(driver.calls).toEqual(['prepare', 'identify', 'open', 'hooks', 'setHookSteps', 'film (after the setup)', 'stop', 'close (after the teardown)', 'finish']);
    expect(filming).toEqual(['start', 'stop']);
    expect(driver.stepHook).toMatchObject({ hook: 'mark', results: ['mark: exit 0'] });
    // The setup's js hook ran where the driver said (its hooks' evalInPage).
    expect(driver.evaluated).toEqual([['app', 'return document.title']]);
    expect(rec).toMatchObject({ status: 'succeeded', mode: 'capture', steps_total: 2, hooks: { setup: 'ok', teardown: 'ok', steps: 'ok' } });
    // The outline is told before the driver opens anything; the driver's secret is masked wherever the run writes.
    const types = events.map((e) => e.type);
    expect(types.indexOf('outline')).toBeGreaterThan(types.indexOf('run_start'));
    expect(types.at(-1)).toBe('run_end');
    expect(JSON.stringify(rec)).not.toContain('s3cr3t-of-the-driver');
    expect(rec.warnings).toEqual(['a warning of the take: ***']);
    const timeline = TimelineSchema.parse(JSON.parse(await readFile(join(rec.dir, 'timeline.json'), 'utf8')));
    expect(timeline.capture).toMatchObject({ file: '', frames: 3 });
    expect(timeline.capture.duration).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8'))).toMatchObject({ status: 'succeeded', timeline: join(rec.dir, 'timeline.json') });
    expect(existsSync(join(rec.dir, 'scenario.yaml')) && existsSync(join(rec.dir, 'hooks-journal.json'))).toBe(true);
  });

  it('a dry run skips the hooks and tells no filming; a skipped hook step answers it was skipped', async () => {
    let driver!: FakeDriver;
    const filming: string[] = [];
    const rec = await runCapture(
      opts('dry', { setup: [{ name: 'never', shell: 'false' }], hooks: { mark: [{ name: 'mark', shell: 'false' }] }, scenes: [{ id: 'one', steps: [{ hook: 'mark' }] }] }, { mode: 'dry', onFilming: (s) => void filming.push(s) }),
      (run) => (driver = new FakeDriver(run)),
    );
    expect(driver.calls).toEqual(['prepare', 'identify', 'open', 'setHookSteps', 'film', 'stop', 'close', 'finish']);
    expect(filming).toEqual([]);
    expect(driver.stepHook).toEqual({ hook: 'mark', skipped: true });
    expect(rec).toMatchObject({ status: 'succeeded', hooks: { setup: 'skipped', teardown: 'none', steps: 'skipped' } });
  });

  it("a failed take: the driver's word on the failure is the run's, the teardown still runs, the step is in the error", async () => {
    let driver!: FakeDriver;
    const rec = await runCapture(
      opts('failed', { teardown: [{ name: 'teardown', shell: 'true' }], scenes: [{ id: 'one', steps: [{ wait: 10 }] }] }),
      (run) =>
        (driver = new FakeDriver(run, {
          film: async () => {
            throw new StepFailure('the button is gone', 'one', 0, 'click');
          },
        })),
    );
    expect(driver.calls).toEqual(['prepare', 'identify', 'open', 'hooks', 'film', 'failed', 'stop', 'close', 'finish']);
    expect(rec).toMatchObject({ status: 'failed', error: { message: 'the button is gone', scene: 'one', step: 0, action: 'click' }, hooks: { teardown: 'ok' } });
  });

  it('a take the driver discards writes no timeline; a cancel ends the run cancelled', async () => {
    const discarded = await runCapture(opts('discard', { scenes: [{ id: 'one', steps: [{ wait: 10 }] }] }), (run) =>
      new FakeDriver(run, {
        discard: true,
        film: async () => {
          throw new LoginPageError('page "app" landed on the sign-in page');
        },
      }),
    );
    expect(discarded.status).toBe('failed');
    expect(discarded.timeline).toBeUndefined();
    expect(existsSync(join(discarded.dir, 'timeline.json'))).toBe(false);
    const ac = new AbortController();
    const cancelled = await runCapture(opts('cancel', { scenes: [{ id: 'one', steps: [{ wait: 10 }] }] }, { signal: ac.signal }), (run) =>
      new FakeDriver(run, {
        film: async (r) => {
          ac.abort(new StepError('stopped'));
          if (r.signal.aborted) throw new (await import('../src/errors.js')).CancelledError('run cancelled (cancel requested)');
        },
      }),
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', error: { message: 'run cancelled (cancel requested)' } });
  });

  it('refusals made before anything runs reach no driver phase but stop, close and finish', async () => {
    let driver!: FakeDriver;
    const rec = await runCapture(opts('refused', { scenes: [{ id: 'one', open: '/x', steps: [{ wait: 10 }] }] }, { hookTrust: 'mcp', signal: AbortSignal.abort() }), (run) => (driver = new FakeDriver(run)));
    expect(driver.calls).toEqual(['failed', 'stop', 'close', 'finish']);
    expect(rec.status).toBe('cancelled');
  });
});
