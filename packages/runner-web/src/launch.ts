/**
 * The one way the runner launches Chromium (capture sessions, sign-in and recording windows, site extraction, artefact
 * rendering, the cursor atlas, the doctor's probe): every launch spreads launchOptions last, so Chromium's OS sandbox is
 * on (Playwright launches it without by default), site isolation is asked for, the browser reports its command line
 * (ENABLE_AUTOMATION), and its switches carry nothing that turns either off (core sandboxOffArgProblem); then each launch
 * but the doctor's (which reports it) refuses a browser whose own command line says otherwise, or that does not report
 * it (refuseUnsandboxed). A source scan (test/launch-options.test.ts) keeps every launch here.
 */
import { createRequire } from 'node:module';
import type { Browser } from 'playwright-core';
import { environmentHttpCredentials } from '@retake/core/environment';
import { policyArgsProblems, policyProgram, programProblem, sandboxOffArgProblem, sandboxOffArgsProblems } from '@retake/core/policy';
import type { BrowserConfig, LoadedProject } from '@retake/core/project';
import type { PageHttpCredentials } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import { bundleInfo, launchTool, playwrightBrowser, programLookup, toolProblem } from '@retake/core/io';
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
 * The switch without which Chromium does not report its command line (CDP Browser.getBrowserCommandLine answers "not
 * returned because --enable-automation not set"), so refuseUnsandboxed could not read it. playwright-core passed it by
 * default up to 1.56; 1.57 onwards does not, so every runner launch passes it itself (the browser behaves as before).
 */
export const ENABLE_AUTOMATION = '--enable-automation';

/**
 * Chromium features every runner launch turns off, whatever else it disables: RenderDocument (a new document per
 * navigation; on by default in Chromium 159) sends what a page sends while it unloads — beacons, keepalive fetches in
 * pagehide — from a document Playwright's route no longer sees, so the read-only guard missed them and they reached the
 * server (measured on Chromium 159: 3 of 4 reached it on a navigation away, none with the feature off; Chromium 141, of
 * playwright-core 1.56, routed them all).
 */
export const GUARD_DISABLED_FEATURES: readonly string[] = ['RenderDocument'];

/**
 * playwright-core's own `--disable-features=` list (1.65.1, its chromiumSwitches; launch-options.test.ts reads the real
 * one). Chromium reads only the last `--disable-features=` switch, so the one launchOptions adds replaces it: a launch
 * that disables no feature itself keeps Playwright's list this way.
 */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'HttpsUpgrades',
  'HttpsFirstBalancedModeAutoEnable',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'TcpPortRandomizationWin',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'PreconnectToSearch',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];

const DISABLE_FEATURES = /^--?disable-features=(.*)$/s;

/**
 * The one `--disable-features=` switch of a launch, last (Chromium reads only the last one): every feature its switches
 * disable — the runner's and browser.args' lists together, else Playwright's own (PLAYWRIGHT_DISABLED_FEATURES) — and
 * GUARD_DISABLED_FEATURES.
 */
function disableFeaturesSwitch(args: readonly string[]): string {
  const lists = args.flatMap((a) => DISABLE_FEATURES.exec(a)?.[1].split(',') ?? []);
  const named = lists.map((f) => f.trim()).filter(Boolean);
  return `--disable-features=${[...new Set([...(named.length ? named : PLAYWRIGHT_DISABLED_FEATURES), ...GUARD_DISABLED_FEATURES])].join(',')}`;
}

/**
 * The launch options that keep Chromium sandboxed, for the runner's own switches `args` then `browserArgs` (the
 * config's `browser.args`): the OS sandbox on, site isolation asked for (SITE_PER_PROCESS) — the headless shell and
 * some builds leave it off by default —, the command line reported (ENABLE_AUTOMATION), and one `--disable-features=`
 * switch, last, that keeps GUARD_DISABLED_FEATURES off whatever browser.args disables (disableFeaturesSwitch). Throws a RunnerError when a switch of either would turn the sandbox or site
 * isolation off, or open the browser to other code — project.yaml and retake.yaml refuse them already; this holds for a
 * config that reached the runner another way. Under the agent policy (core agent-policy.ts: a job of the worker), also
 * when an entry of `browserArgs` is not a switch or not one of the switches such a job may pass (core agentArgProblem).
 */
export function launchOptions(o: { args: readonly string[]; browserArgs?: readonly string[]; policy: WorkPolicy }): LaunchSecurity {
  const user = o.browserArgs ?? [];
  const all = [...o.args, ...user];
  const problems = [...sandboxOffArgsProblems(all), ...policyArgsProblems(o.policy, user)];
  if (problems.length) throw new RunnerError(`Chromium was not launched: ${problems.map((p) => p.message).join('; ')}`);
  const added = [SITE_PER_PROCESS, ENABLE_AUTOMATION].filter((a) => !all.includes(a));
  return { chromiumSandbox: true, args: [...all.filter((a) => !DISABLE_FEATURES.test(a)), ...added, disableFeaturesSwitch(all)] };
}

/**
 * The executable playwright-core starts for `channel` (its own browsers: PLAYWRIGHT_BROWSERS_PATH, else its cache; a
 * channel such as `chrome`: the installed one) — the headless shell for a headless launch without a channel, as
 * playwright-core picks it. Null when playwright-core does not say (core/io playwrightBrowser: the registry read once, through
 * this package's playwright-core).
 */
export function playwrightExecutable(channel: string | undefined, headless: boolean): string | null {
  return playwrightBrowser(require, channel ?? (headless ? 'chromium-headless-shell' : 'chromium'));
}

/**
 * playwright-core's launch target for a browser config: `browser.executable`, else `$RETAKE_CHROMIUM`, else a channel
 * (new headless by default; `headless-shell` lets Playwright pick its headless shell). Under the agent policy (core
 * policyProgram), the executable is started by the real path that was checked, and a RunnerError is thrown when it is a
 * relative path or lies inside the workspace — the browser playwright-core would pick for the channel too
 * (`o.headless`: the launch is headless, the default), wherever PLAYWRIGHT_BROWSERS_PATH puts it — and when
 * playwright-core does not say which browser that is (its registry moved or unreadable, an unknown channel): a browser
 * that cannot be checked is not started (fail closed).
 */
export function launchTarget(b: BrowserConfig = {}, o: { headless?: boolean; policy: WorkPolicy }): { executablePath?: string; channel?: string } {
  const given = b.executable ?? process.env.RETAKE_CHROMIUM ?? undefined;
  if (given) {
    const checked = policyProgram(o.policy, given, b.executable ? 'browser.executable' : '$RETAKE_CHROMIUM', programLookup());
    if (checked.problem) throw new RunnerError(`Chromium was not launched: ${checked.problem}`);
    return { executablePath: checked.program, channel: undefined };
  }
  const channel = b.channel === 'headless-shell' ? undefined : (b.channel ?? 'chromium');
  // The app's downloaded Tools (core/io tools.ts): a browser not downloaded yet, or whose check fails, is not started
  // (Playwright would say to run its own installer). An installed channel (`chrome`) is no Tool.
  const tool = launchTool(b, o.headless !== false);
  const missing = tool ? toolProblem(tool, process.env, bundleInfo()) : undefined;
  if (missing) throw new RunnerError(`Chromium was not launched: ${missing}`);
  if (o.policy.agentFolders) {
    const picked = playwrightExecutable(channel, o.headless !== false);
    const what = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ? '$PLAYWRIGHT_BROWSERS_PATH' : "Playwright's browser";
    if (!picked) {
      throw new RunnerError(
        `Chromium was not launched: playwright-core does not say which browser it would start for ${channel ? `channel ${channel}` : 'its headless shell'}, so it cannot be checked — set browser.executable (or $RETAKE_CHROMIUM) to a browser outside the workspace`,
      );
    }
    const problem = programProblem(o.policy, picked, what, programLookup());
    if (problem) throw new RunnerError(`Chromium was not launched: ${problem}`);
  }
  return { executablePath: undefined, channel };
}

/**
 * After a launch: the browser's own command line (browserSandbox) holds no switch that turns its sandbox or site
 * isolation off, or opens it to other code — what an executable that adds switches itself (`browser.executable`,
 * RETAKE_CHROMIUM, RETAKE_CHROMIUM_HEADLESS_SHELL) would pass. Otherwise the browser is closed (`close`) and a
 * RunnerError says which switches and what to change. A browser that does not report its command line (none to ask,
 * or CDP does not answer it) is refused the same way: it cannot be checked (fail closed).
 */
export async function refuseUnsandboxed(browser: Browser | null, close: () => Promise<unknown>, what = 'Chromium'): Promise<void> {
  const sandbox = browser ? await browserSandbox(browser) : null;
  if (sandbox?.on) return;
  await close().catch(() => undefined);
  if (!sandbox) {
    throw new RunnerError(
      `${what} was refused: it does not report its command line, so its sandbox and site isolation cannot be checked — ` +
        `the executable drops ${ENABLE_AUTOMATION} or is not a Chromium that answers it (browser.executable, RETAKE_CHROMIUM or RETAKE_CHROMIUM_HEADLESS_SHELL): use one that starts Chromium as it is given`,
    );
  }
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
