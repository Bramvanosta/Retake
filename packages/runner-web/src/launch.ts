/**
 * The one way the runner launches Chromium (capture sessions, sign-in and recording windows, site extraction, artefact
 * rendering, the cursor atlas, the doctor's probe): every launch spreads launchOptions last, so Chromium's OS sandbox is
 * on (Playwright launches it without by default) and its switches carry nothing that turns the sandbox or site
 * isolation off (core sandboxOffArgProblem). A source scan (test/launch-options.test.ts) keeps every launch here.
 */
import type { Browser } from 'playwright-core';
import { sandboxOffArgProblem, sandboxOffArgsProblems } from '@retake/core';
import { RunnerError } from './errors.js';

/** The options every runner launch ends with. */
export interface LaunchSecurity {
  chromiumSandbox: true;
  args: string[];
}

/**
 * The launch options that keep Chromium sandboxed, for the switches `args` (the runner's own, then `browser.args`).
 * Throws a RunnerError when one would turn the sandbox or site isolation off — project.yaml and retake.yaml refuse them
 * already; this holds for a config that reached the runner another way.
 */
export function launchOptions(o: { args: readonly string[] }): LaunchSecurity {
  const problems = sandboxOffArgsProblems(o.args);
  if (problems.length) throw new RunnerError(`Chromium was not launched: ${problems.map((p) => p.message).join('; ')}`);
  return { chromiumSandbox: true, args: [...o.args] };
}

/** What a running browser's own command line says about its sandbox (`retake doctor`). */
export interface BrowserSandbox {
  /** No switch of the command line turns the sandbox or site isolation off. */
  on: boolean;
  /** The switches that do (empty when `on`). */
  off: string[];
}

/**
 * The browser's command line as Chromium reports it (CDP Browser.getBrowserCommandLine: what it was really started
 * with, the switches a wrapper executable adds included), read for sandbox-off switches. Null when the browser does not
 * report it.
 */
export async function browserSandbox(browser: Browser): Promise<BrowserSandbox | null> {
  let cdp: Awaited<ReturnType<Browser['newBrowserCDPSession']>> | undefined;
  try {
    cdp = await browser.newBrowserCDPSession();
    const { arguments: argv } = (await cdp.send('Browser.getBrowserCommandLine')) as { arguments: string[] };
    const off = argv.filter((a) => sandboxOffArgProblem(a) !== null);
    return { on: off.length === 0, off };
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}
