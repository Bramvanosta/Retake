/**
 * The iOS driver's clean-up and its take's end (src/ios-driver.ts) with a fake simctl: a cancelled run still clears the
 * status bar and shuts down the device it booted (never under the run's cancel); the recording is deleted when it makes
 * no take (cancelled, nothing filmed) unless RETAKE_IOS_KEEP_RECORDING=1; a take cancelled while it is being made is
 * reported cancelled, not failed (the take is made under the run's cancel); the ripple takes the colour of the
 * scenario's theme when it names one; a take whose scenario and project write no frame is marked for the default one.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_POLICY } from '@retake/core/policy';
import { loadProject } from '@retake/core/io';
import type { CaptureRun, CaptureTools } from '@retake/runner-web/types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createIosDriver, markFrameDefault } from '../src/ios-driver.js';
import type { Exec, ProcResult, RunOpts } from '../src/proc.js';
import { finishTake } from '../src/take.js';

// The real finishTake, watched: the take is made under the run's cancel.
vi.mock('../src/take.js', async (actual) => {
  const m = await actual<typeof import('../src/take.js')>();
  return { ...m, finishTake: vi.fn(m.finishTake) };
});

const root = mkdtempSync(join(tmpdir(), 'retake-ios-driver-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

class Cancel extends Error {}

const TOOLS = {
  isCancelled: (e: unknown) => e instanceof Cancel,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  runnerError: (m: string) => new Error(m),
} as unknown as CaptureTools;

function fakeExec() {
  const runs: Array<{ args: string; signal: AbortSignal | undefined }> = [];
  const exec: Exec = {
    run: async (_p: string, args: readonly string[], o?: RunOpts): Promise<ProcResult> => {
      runs.push({ args: args.join(' '), signal: o?.signal });
      return { code: 0, signal: null, stdout: '', stderr: '' };
    },
    start: () => {
      throw new Error('not here');
    },
  };
  return { exec, runs };
}

function fakeRun(name: string, abort: AbortController, o: { failure?: unknown } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.ios'), { recursive: true });
  const run = {
    dir,
    signal: abort.signal,
    failure: o.failure ?? null,
    captureStarted: true,
    endT: 2,
    capture: { fps: 30, crf: 18 },
    record: {},
    opts: { policy: PERSON_POLICY, template: { name: 't', template: { cursor: {} } } },
    timeline: { sampleCursor: () => undefined, cursorEffect: () => undefined },
    emit: () => undefined,
    log: () => undefined,
  } as unknown as CaptureRun;
  return { run, mov: join(dir, '.ios', 'capture.mov') };
}

/** The driver after a take: what prepare, open and film would have set. */
function filmed(driver: object): void {
  Object.assign(driver, { simctl: {}, device: { udid: 'UDID' }, screen: { width: 40, height: 80, scale: 3 }, recorded: true, statusBarSet: true, bootedHere: true });
}

describe('the iOS driver', () => {
  it("the ripple's colour: the scenario's theme (`template:`), else the project's", async () => {
    const dir = join(root, 'ws', 'projects', 'buyer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.yaml'), 'name: Buyer\nenvironments:\n  simulator:\n    ios: {app: com.example.buyer, device: iPhone 17 Pro}\n');
    const project = await loadProject(dir);
    const colour = async (template: string | undefined) => {
      const { run } = fakeRun(`ripple-${template}`, new AbortController());
      Object.assign(run, { project, sc: { ...(template ? { template } : {}) }, opts: { policy: PERSON_POLICY } });
      const driver = createIosDriver({ exec: fakeExec().exec, platform: 'darwin', env: {} })(run, TOOLS);
      return (driver as unknown as { rippleColor(): Promise<readonly number[]> }).rippleColor();
    };
    expect(await colour('editorial')).toEqual([138, 35, 50, 0.45]);
    expect(await colour(undefined)).toEqual([59, 94, 201, 0.45]);
  });

  it("a cancelled run still clears the status bar and shuts down the device it booted, never under the run's cancel", async () => {
    const f = fakeExec();
    const abort = new AbortController();
    const { run } = fakeRun('close', abort);
    const driver = createIosDriver({ exec: f.exec, platform: 'darwin', env: {} })(run, TOOLS);
    filmed(driver);
    abort.abort(new Cancel('cancelled'));
    await driver.close();
    expect(f.runs.map((r) => r.args)).toEqual(['simctl status_bar UDID clear', 'simctl shutdown UDID']);
    for (const r of f.runs) expect(r.signal?.aborted ?? false, r.args).toBe(false);
  });

  it('the recording of a cancelled take is deleted (it holds what was typed), unless RETAKE_IOS_KEEP_RECORDING=1', async () => {
    for (const keep of [false, true]) {
      const abort = new AbortController();
      const { run, mov } = fakeRun(`cancelled-${keep}`, abort, { failure: new Cancel('cancelled') });
      writeFileSync(mov, 'mov');
      const driver = createIosDriver({ exec: fakeExec().exec, platform: 'darwin', env: keep ? { RETAKE_IOS_KEEP_RECORDING: '1' } : {} })(run, TOOLS);
      filmed(driver);
      const take = await driver.finish();
      expect(take.capture.file).toBe('');
      expect(existsSync(mov), `keep ${keep}`).toBe(keep);
    }
  });

  it('a take cancelled while it is made (the probe, the conversion) is cancelled, not failed; its recording deleted', async () => {
    const abort = new AbortController();
    const { run, mov } = fakeRun('mid-finish', abort);
    writeFileSync(mov, 'not a movie');
    const driver = createIosDriver({ exec: fakeExec().exec, platform: 'darwin', env: {} })(run, TOOLS);
    filmed(driver);
    const done = driver.finish();
    abort.abort(new Cancel('run cancelled (SIGINT)'));
    await done;
    expect(vi.mocked(finishTake).mock.calls.at(-1)?.[0].signal).toBe(abort.signal);
    expect(run.failure).toBeInstanceOf(Cancel);
    expect(existsSync(mov)).toBe(false);
  });

  it('a take whose scenario and project write no frame is marked for the default frame; a written one is kept', () => {
    const marked = (scFrame: string | undefined, defaulted: boolean) => {
      const video: { frame_default?: true } = {};
      const run = { timeline: { meta: { video } }, sc: scFrame === undefined ? {} : { frame: scFrame }, project: { config: defaulted ? { frame_defaulted: true } : {} } };
      markFrameDefault(run as unknown as Parameters<typeof markFrameDefault>[0]);
      return video.frame_default === true;
    };
    expect(marked(undefined, true)).toBe(true);
    expect(marked('card', true)).toBe(false);
    expect(marked(undefined, false)).toBe(false);
  });
});
