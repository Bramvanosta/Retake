/**
 * Run a scenario in a headless browser: setup hooks, scenes (page switching, open, still, steps), screencast
 * capture, teardown hooks (always), encoding, timeline.json and run.json. The lifecycle any capture has is
 * capture/lifecycle.ts; what drives Chromium and films it is capture/browser-driver.ts (the seam: capture/driver.ts).
 */
import type { RunRecord } from '@retake/core/run';
import { browserDriver } from './capture/browser-driver.js';
import { runCapture } from './capture/lifecycle.js';
import type { DriverFactory } from './capture/driver.js';
import type { RunOptions } from './capture/options.js';

export type { FilmingEvent, FilmingReport, RunOptions } from './capture/options.js';

/**
 * A run's options and what drives the product and films it (capture/driver.ts): another package's driver — an iOS
 * environment's, which the composition hands in. Absent: the browser's (browserDriver), which refuses an iOS environment.
 */
export type RunScenarioOptions = RunOptions & { driver?: DriverFactory };
export { DISK_FREE_MIN_GB, DISK_FREE_MIN_SHARE, choppyCause, diskCheck, motionWarnings } from './capture/perf-words.js';

/**
 * Run a scenario in a headless browser (the browser driver under the capture lifecycle), or with the driver the
 * options hand in (`driver`: an iOS environment's). Never throws for step failures: the returned RunRecord carries the
 * status and error.
 */
export function runScenario(opts: RunScenarioOptions): Promise<RunRecord> {
  return runCapture(opts, opts.driver ?? browserDriver);
}
