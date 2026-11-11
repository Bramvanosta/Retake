import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { bundleInfo, insideBundle } from '@retake/core/io';
import type { BrowserConfig, WorkPolicy } from '@retake/core';
import type { BundleInfo } from '@retake/core/io';
import { browserSandbox, launchOptions } from './launch.js';
import type { BrowserSandbox } from './launch.js';
import { DEFAULT_BROWSER_ARGS, gpuInfoOf } from './session.js';
import type { GpuInfo, SystemInfoReply } from './session.js';
import { wallNow } from './util.js';

/** What `retake doctor` learns about the browser the runner would launch. */
export interface ChromiumProbe {
  /** Executable the runner launches (null when Playwright knows none). */
  path: string | null;
  /** Where the path comes from. */
  source: 'browser.executable' | 'RETAKE_CHROMIUM' | 'bundled' | 'playwright';
  exists: boolean;
  /** Browser version reported after a successful launch. */
  version?: string;
  /** A headless launch (new headless mode unless channel is headless-shell) rendered a page. */
  launched: boolean;
  /** Launch + render time in ms. */
  ms?: number;
  /** First line of the launch error. */
  error?: string;
  /** The launched browser's GPU status (L5.7, R-FLD-24: Chromium's own report, the one chrome://gpu shows). */
  gpu?: GpuInfo;
  /** Whether the launched browser runs sandboxed, read from its own command line (absent: it did not report it). */
  sandbox?: BrowserSandbox;
}

/**
 * The executable the runner would use, and where that choice comes from: `browser.executable` → `$RETAKE_CHROMIUM` →
 * playwright-core's registry — the app bundle's browsers when Retake runs from one (core `prepareBundle`), else
 * Playwright's cache.
 */
export function chromiumExecutable(browser?: BrowserConfig, bundle: BundleInfo | null = bundleInfo()): { path: string | null; source: ChromiumProbe['source'] } {
  if (browser?.executable) return { path: browser.executable, source: 'browser.executable' };
  if (process.env.RETAKE_CHROMIUM) return { path: process.env.RETAKE_CHROMIUM, source: 'RETAKE_CHROMIUM' };
  try {
    const path = chromium.executablePath() || null;
    return { path, source: path && insideBundle(path, bundle) ? 'bundled' : 'playwright' };
  } catch {
    return { path: null, source: bundle ? 'bundled' : 'playwright' };
  }
}

/** Locate Chromium and (optionally) launch it headless the way the runner does, render a page, and close it. */
export async function probeChromium(browser: BrowserConfig | undefined, opts: { launch?: boolean; timeoutMs?: number; policy: WorkPolicy }): Promise<ChromiumProbe> {
  const { path, source } = chromiumExecutable(browser);
  const out: ChromiumProbe = { path, source, exists: !!path && existsSync(path), launched: false };
  if (opts.launch === false || !out.exists) return out;
  const t0 = wallNow();
  const executablePath = source === 'playwright' || source === 'bundled' ? undefined : (path ?? undefined);
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
    out.error = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  } finally {
    await b?.close().catch(() => undefined);
  }
  return out;
}
