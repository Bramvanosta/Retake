/**
 * The driver seam for a driver of another package (capture/driver.ts): runScenario takes the driver the options hand
 * in, the lifecycle hands it its tools (a step failure made by them is the run's failed step), a device's take reaches
 * the timeline with its own scale and device (and its raw export has no cursor layer); the browser driver refuses an
 * iOS environment before anything opens.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, TimelineSchema } from '@retake/core';
import type { ResolvedEnvironment } from '@retake/core';
import { browserDriver } from '../src/capture/browser-driver.js';
import { refuseIosEnvironment } from '../src/capture/browser-guards.js';
import type { CaptureDriver, CaptureRun, CaptureTools, DriverFactory, DriverTake } from '../src/capture/driver.js';
import { CAPTURE_TOOLS } from '../src/capture/lifecycle.js';
import { RunnerError } from '../src/errors.js';
import { RawExportError, exportCapture } from '../src/raw/index.js';
import { runScenario } from '../src/run.js';
import type { RunScenarioOptions } from '../src/run.js';
import { StepFailure } from '../src/scenes.js';
import { makeProject, tempDir, testHookRunner } from './helpers.js';
import { inRunsOf, makeScenario } from '@retake/test-support/capture';

let dir: string;
beforeAll(async () => {
  dir = await tempDir('rw-seam-');
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A device driver of the test's own: films three frames of a 402×874 pt screen at 3, or fails its first step. */
function deviceDriver(o: { fail?: boolean; seen?: (tools: CaptureTools) => void } = {}): DriverFactory {
  return (run: CaptureRun, tools: CaptureTools): CaptureDriver => {
    o.seen?.(tools);
    return {
      prepare: async () => undefined,
      identify: () => undefined,
      open: async () => undefined,
      hooks: () => ({}),
      setHookSteps: () => undefined,
      film: async () => {
        run.startCapture();
        run.clock.t0Wall -= 1000;
        if (o.fail) throw tools.stepFailure('no element "Add to quote" on the screen', { scene: 'one', step: 0, action: 'click', dom: '<tree/>' });
      },
      failed: async (e) => e,
      stop: async () => {
        run.endT = run.clock.now();
        run.stopFilming();
      },
      close: async () => undefined,
      finish: async (): Promise<DriverTake> => ({
        discard: false,
        capture: { file: 'capture.mp4', frames: 3, frameTimes: [0, 0.4, 0.9], size: { width: 402, height: 874, scale: 3 }, device: { kind: 'ios', name: 'iPhone 17 Pro', runtime: 'iOS 26.5' } },
      }),
      cleanupSync: () => undefined,
    };
  };
}

function opts(name: string, driver: DriverFactory): RunScenarioOptions {
  return {
    ...inRunsOf({
      policy: PERSON_POLICY,
      project: makeProject(dir, { app: 'http://127.0.0.1:9' }),
      scenario: makeScenario(name, { scenes: [{ id: 'one', steps: [{ click: 'Add to quote' }] }] }),
      mode: 'capture',
      runId: `${name}-${Date.now()}`,
      hookRunner: testHookRunner(),
    }),
    driver,
  };
}

describe('a driver of another package', () => {
  it("is the run's driver: its take's size, scale and device are the timeline's", async () => {
    let tools: CaptureTools | undefined;
    const rec = await runScenario(opts('device', deviceDriver({ seen: (t) => (tools = t) })));
    expect(tools).toBe(CAPTURE_TOOLS);
    expect(rec.status).toBe('succeeded');
    const timeline = TimelineSchema.parse(JSON.parse(await readFile(join(rec.dir, 'timeline.json'), 'utf8')));
    expect(timeline.capture).toMatchObject({ file: 'capture.mp4', width: 402, height: 874, scale: 3, frames: 3, device: { kind: 'ios', name: 'iPhone 17 Pro', runtime: 'iOS 26.5' } });
    // Its raw export has no cursor layer to give: refused in the export's words, before anything is encoded.
    await expect(exportCapture({ policy: PERSON_POLICY, project: makeProject(dir, { app: 'http://127.0.0.1:9' }), runDir: rec.dir, cursor: 'layer', out: join(dir, 'pkg-layer') })).rejects.toThrow(
      `run ${rec.id} was filmed on a device (iPhone 17 Pro): its touches have no cursor layer — export it with --cursor baked (or --cursor none, for a run captured with --raw --cursor none)`,
    );
    await expect(
      exportCapture({ policy: PERSON_POLICY, project: makeProject(dir, { app: 'http://127.0.0.1:9' }), runDir: rec.dir, cursor: 'layer', out: join(dir, 'pkg-layer') }),
    ).rejects.toBeInstanceOf(RawExportError);
  });

  it('a step failure made by the tools is the failed step of the run (scene, step, action, snippet)', async () => {
    const rec = await runScenario(opts('device-failed', deviceDriver({ fail: true })));
    expect(rec).toMatchObject({ status: 'failed', error: { message: 'no element "Add to quote" on the screen', scene: 'one', step: 0, action: 'click', dom: '<tree/>' } });
  });

  it("the tools are the lifecycle's own: a StepFailure, a RunnerError, the cancel test, the templating, --until", () => {
    expect(CAPTURE_TOOLS.stepFailure('x', { scene: 's', step: 1, action: 'click' })).toBeInstanceOf(StepFailure);
    expect(CAPTURE_TOOLS.runnerError('x')).toBeInstanceOf(RunnerError);
    expect(CAPTURE_TOOLS.isCancelled(new RunnerError('x'))).toBe(false);
    expect(CAPTURE_TOOLS.caption('Hi')).toEqual({ text: 'Hi' });
    const entry = { id: 'a', steps: [{ wait: 1 }, { wait: 2 }, { wait: 3 }] };
    expect(CAPTURE_TOOLS.untilSteps(entry, 0, { sceneIndex: 0, stepIndex: 1 }).steps).toHaveLength(2);
  });
});

describe('the browser driver on an iOS environment', () => {
  const ios: ResolvedEnvironment = { name: 'simulator', pages: {}, ios: { app: 'build/Buyer.app', device: 'iPhone 17 Pro' } };

  it('refuses it before anything opens', async () => {
    expect(() => refuseIosEnvironment(ios)).toThrow("environment simulator is an iOS environment: the browser films web pages only (its runs are the iOS runner's)");
    expect(() => refuseIosEnvironment({ name: 'staging', pages: { app: 'https://app.example.com' } } as ResolvedEnvironment)).not.toThrow();
    // Its first phase, with nothing of a browser behind it: the refusal comes first.
    const run = { env: ios, opts: {}, project: makeProject(dir, {}), sc: { video: 'v', scenes: [] }, secrets: { addValue: () => undefined }, log: () => undefined } as unknown as CaptureRun;
    await expect(browserDriver(run).prepare()).rejects.toThrow(/is an iOS environment/);
  });
});
