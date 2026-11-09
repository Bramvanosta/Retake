/**
 * The one way the runner launches Chromium (capture sessions, sign-in and recording windows, site extraction, artefact
 * rendering, the cursor atlas, the doctor's probe): every launch spreads launchOptions last, so Chromium's OS sandbox is
 * on (Playwright launches it without by default), site isolation is asked for, and its switches carry nothing that turns
 * either off (core sandboxOffArgProblem); then each launch but the doctor's (which reports it) refuses a browser whose
 * own command line says otherwise (refuseUnsandboxed). A source scan (test/launch-options.test.ts) keeps every launch here.
 */
import { createRequire } from 'node:module';
import type { Browser } from 'playwright-core';
import { agentPolicyFolders, environmentHttpCredentials, policyArgsProblems, policyProgram, programProblem, sandboxOffArgProblem, sandboxOffArgsProblems } from '@retake/core';
import type { BrowserConfig, LoadedProject, PageHttpCredentials } from '@retake/core';
import { RunnerError } from './errors.js';

const require = createRequire(import.meta.url);

/** The options every runner launch ends with. */
export interface LaunchSecurity {
  chromiumSandbox: true;
  args: string[];
}

/** The switch that gives every site a renderer process of its own (site isolation), whatever the browser's default. */
export const SITE_PER_PROCESS = '--site-per-process';

/**
 * The launch options that keep Chromium sandboxed, for the runner's own switches `args` then `browserArgs` (the
 * config's `browser.args`): the OS sandbox on, and site isolation asked for (SITE_PER_PROCESS) — the headless shell and
 * some builds leave it off by default. Throws a RunnerError when a switch of either would turn the sandbox or site
 * isolation off, or open the browser to other code — project.yaml and retake.yaml refuse them already; this holds for a
 * config that reached the runner another way. Under the agent policy (core agent-policy.ts: a job of the worker), also
 * when an entry of `browserArgs` is not a switch or not one of the switches such a job may pass (core agentArgProblem).
 */
export function launchOptions(o: { args: readonly string[]; browserArgs?: readonly string[] }): LaunchSecurity {
  const user = o.browserArgs ?? [];
  const all = [...o.args, ...user];
  const problems = [...sandboxOffArgsProblems(all), ...policyArgsProblems(user)];
  if (problems.length) throw new RunnerError(`Chromium was not launched: ${problems.map((p) => p.message).join('; ')}`);
  return { chromiumSandbox: true, args: all.includes(SITE_PER_PROCESS) ? all : [...all, SITE_PER_PROCESS] };
}

interface PlaywrightRegistry {
  registry: { findExecutable(name: string): { executablePath(lang?: string): string | undefined } | undefined };
}

/**
 * The executable playwright-core starts for `channel` (its own browsers: PLAYWRIGHT_BROWSERS_PATH, else its cache; a
 * channel such as `chrome`: the installed one) — the headless shell for a headless launch without a channel, as
 * playwright-core picks it. Null when playwright-core does not say.
 */
export function playwrightExecutable(channel: string | undefined, headless: boolean): string | null {
  try {
    const { registry } = require('playwright-core/lib/server/registry/index') as PlaywrightRegistry;
    return registry.findExecutable(channel ?? (headless ? 'chromium-headless-shell' : 'chromium'))?.executablePath('javascript') || null;
  } catch {
    return null;
  }
}

/**
 * playwright-core's launch target for a browser config: `browser.executable`, else `$RETAKE_CHROMIUM`, else a channel
 * (new headless by default; `headless-shell` lets Playwright pick its headless shell). Under the agent policy (core
 * policyProgram), the executable is started by the real path that was checked, and a RunnerError is thrown when it is a
 * relative path or lies inside the workspace — the browser playwright-core would pick for the channel too
 * (`o.headless`: the launch is headless, the default), wherever PLAYWRIGHT_BROWSERS_PATH puts it.
 */
export function launchTarget(b: BrowserConfig = {}, o: { headless?: boolean } = {}): { executablePath?: string; channel?: string } {
  const given = b.executable ?? process.env.RETAKE_CHROMIUM ?? undefined;
  if (given) {
    const checked = policyProgram(given, b.executable ? 'browser.executable' : '$RETAKE_CHROMIUM');
    if (checked.problem) throw new RunnerError(`Chromium was not launched: ${checked.problem}`);
    return { executablePath: checked.program, channel: undefined };
  }
  const channel = b.channel === 'headless-shell' ? undefined : (b.channel ?? 'chromium');
  if (agentPolicyFolders()) {
    const picked = playwrightExecutable(channel, o.headless !== false);
    const what = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ? '$PLAYWRIGHT_BROWSERS_PATH' : "Playwright's browser";
    const problem = picked ? programProblem(picked, what) : null;
    if (problem) throw new RunnerError(`Chromium was not launched: ${problem}`);
  }
  return { executablePath: undefined, channel };
}

/**
 * After a launch: the browser's own command line (browserSandbox) holds no switch that turns its sandbox or site
 * isolation off, or opens it to other code — what an executable that adds switches itself (`browser.executable`,
 * RETAKE_CHROMIUM, RETAKE_CHROMIUM_HEADLESS_SHELL) would pass. Otherwise the browser is closed (`close`) and a
 * RunnerError says which switches and what to change. A browser that does not report its command line is kept.
 */
export async function refuseUnsandboxed(browser: Browser | null, close: () => Promise<unknown>, what = 'Chromium'): Promise<void> {
  const sandbox = browser ? await browserSandbox(browser) : null;
  if (!sandbox || sandbox.on) return;
  await close().catch(() => undefined);
  throw new RunnerError(
    `${what} was refused: it runs with ${sandbox.off.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(' ')} on its command line (a switch that turns its sandbox or site isolation off, or opens it to other code) — ` +
      'the executable adds switches itself (browser.executable, RETAKE_CHROMIUM or RETAKE_CHROMIUM_HEADLESS_SHELL): use one that starts Chromium as it is given',
  );
}

/** What a running browser's own command line says about its sandbox (`retake doctor`). */
export interface BrowserSandbox {
  /** No switch of the command line turns the sandbox or site isolation off, or opens the browser to other code. */
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

/**
 * The HTTP credentials a browser on environment `envName` is launched with (core environmentHttpCredentials: the
 * sign-in details of its page URLs, for that origin only); undefined when its pages have none. Throws a RunnerError
 * when they cannot be given (several origins, two different details for one).
 */
export function launchCredentials(project: Pick<LoadedProject, 'config'>, envName: string): PageHttpCredentials | undefined {
  const r = environmentHttpCredentials(project, envName);
  if (r.problem) throw new RunnerError(r.problem);
  return r.credentials;
}
