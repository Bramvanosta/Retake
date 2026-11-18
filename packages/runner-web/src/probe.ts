import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { bundleInfo, insideTools, toolProblem, toolsDir } from '@retake/core/io';
import type { BrowserConfig } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { BundleInfo } from '@retake/core/io';
import { browserSandbox, launchOptions } from './launch.js';
import type { BrowserSandbox } from './launch.js';
import { DEFAULT_BROWSER_ARGS, gpuInfoOf } from './session.js';
import type { GpuInfo, SystemInfoReply } from './session.js';
import { wallNow } from './util.js';
import { errorMessage } from '@retake/core/base';

/** What `retake doctor` learns about the browser the runner would launch. */
export interface ChromiumProbe {
  /** Executable the runner launches (null when Playwright knows none). */
  path: string | null;
  /** Where the path comes from. */
  /** `tools`: the app's downloaded browser (`<RETAKE_HOME>/tools`). */
  source: 'browser.executable' | 'RETAKE_CHROMIUM' | 'tools' | 'playwright';
  exists: boolean;
  /** Browser version reported after a successful launch. */
  version?: string;
  /** A headless launch (new headless mode unless channel is headless-shell) rendered a page. */
  launched: boolean;
  /** Launch + render time in ms. */
  ms?: number;
  /** Why the app's downloaded browser cannot be used (core toolProblem): it is then not launched. */
  problem?: string;
  /** First line of the launch error. */
  error?: string;
  /** The launched browser's GPU status (R-FLD-24: Chromium's own report, the one chrome://gpu shows). */
  gpu?: GpuInfo;
  /** Whether the launched browser runs sandboxed, read from its own command line (absent: it did not report it). */
  sandbox?: BrowserSandbox;
}

/**
 * The executable the runner would use, and where that choice comes from: `browser.executable` → `$RETAKE_CHROMIUM` →
 * playwright-core's registry — the app's downloaded Tools when Retake runs from one (core `prepareBundle` points it at
 * `<RETAKE_HOME>/tools/browsers`), else Playwright's cache. `problem`: why the app's browser cannot be used yet (not
 * downloaded, or its check fails: core toolProblem), in which case it is not launched.
 */
export function chromiumExecutable(browser?: BrowserConfig, bundle: BundleInfo | null = bundleInfo()): { path: string | null; source: ChromiumProbe['source']; problem?: string } {
  if (browser?.executable) return { path: browser.executable, source: 'browser.executable' };
  if (process.env.RETAKE_CHROMIUM) return { path: process.env.RETAKE_CHROMIUM, source: 'RETAKE_CHROMIUM' };
  const problem = toolProblem(browser?.channel === 'headless-shell' ? 'render-browser' : 'browser', process.env, bundle);
  try {
    const path = chromium.executablePath() || null;
    return { path, source: path && bundle && insideTools(path, toolsDir(process.env)) ? 'tools' : 'playwright', ...(problem ? { problem } : {}) };
  } catch {
    return { path: null, source: bundle ? 'tools' : 'playwright', ...(problem ? { problem } : {}) };
  }
}

/** Locate Chromium and (optionally) launch it headless the way the runner does, render a page, and close it. */
export async function probeChromium(browser: BrowserConfig | undefined, opts: { launch?: boolean; timeoutMs?: number; policy: WorkPolicy }): Promise<ChromiumProbe> {
  const { path, source, problem } = chromiumExecutable(browser);
  const out: ChromiumProbe = { path, source, exists: !!path && existsSync(path), launched: false, ...(problem ? { problem } : {}) };
  // An app's browser that is not downloaded (or fails its check) is never launched by the probe.
  if (opts.launch === false || !out.exists || problem) return out;
  const t0 = wallNow();
  const executablePath = source === 'playwright' || source === 'tools' ? undefined : (path ?? undefined);
  const channel = executablePath ? undefined : browser?.channel === 'headless-shell' ? undefined : (browser?.channel ?? 'chromium');
  let b: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    b = await chromium.launch({
      headless: true,
      channel,
      executablePath,
      timeout: opts.timeoutMs ?? 30_000,
      ...launchOptions({ args: DEFAULT_BROWSER_ARGS, browserArgs: browser?.args, policy: opts.policy }),
    });
    out.version = b.version();
    const page = await b.newPage({ viewport: { width: 320, height: 200 } });
    await page.setContent('<p id="ok">ok</p>');
    out.launched = (await page.textContent('#ok')) === 'ok';
    out.ms = Math.round(wallNow() - t0);
    const sandbox = await browserSandbox(b);
    if (sandbox) out.sandbox = sandbox;
    try {
      const cdp = await b.newBrowserCDPSession();
      out.gpu = gpuInfoOf((await cdp.send('SystemInfo.getInfo')) as SystemInfoReply);
      await cdp.detach().catch(() => undefined);
    } catch {
      /* an older browser: no GPU line */
    }
  } catch (e) {
    out.error = errorMessage(e).split('\n')[0];
  } finally {
    await b?.close().catch(() => undefined);
  }
  return out;
}
