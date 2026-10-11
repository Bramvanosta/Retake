import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { BrowserConfig } from '@demo-studio/core';
import { DEFAULT_BROWSER_ARGS } from './session.js';
import { wallNow } from './util.js';

/** What `studio doctor` learns about the browser the runner would launch. */
export interface ChromiumProbe {
  /** Executable the runner launches (null when Playwright knows none). */
  path: string | null;
  /** Where the path comes from. */
  source: 'browser.executable' | 'DEMO_STUDIO_CHROMIUM' | 'playwright';
  exists: boolean;
  /** Browser version reported after a successful launch. */
  version?: string;
  /** A headless launch (new headless mode unless channel is headless-shell) rendered a page. */
  launched: boolean;
  /** Launch + render time in ms. */
  ms?: number;
  /** First line of the launch error. */
  error?: string;
}

/** The executable the runner would use, and where that choice comes from. */
export function chromiumExecutable(browser?: BrowserConfig): { path: string | null; source: ChromiumProbe['source'] } {
  if (browser?.executable) return { path: browser.executable, source: 'browser.executable' };
  if (process.env.DEMO_STUDIO_CHROMIUM) return { path: process.env.DEMO_STUDIO_CHROMIUM, source: 'DEMO_STUDIO_CHROMIUM' };
  try {
    return { path: chromium.executablePath() || null, source: 'playwright' };
  } catch {
    return { path: null, source: 'playwright' };
  }
}

/** Locate Chromium and (optionally) launch it headless the way the runner does, render a page, and close it. */
export async function probeChromium(browser?: BrowserConfig, opts: { launch?: boolean; timeoutMs?: number } = {}): Promise<ChromiumProbe> {
  const { path, source } = chromiumExecutable(browser);
  const out: ChromiumProbe = { path, source, exists: !!path && existsSync(path), launched: false };
  if (opts.launch === false || !out.exists) return out;
  const t0 = wallNow();
  const executablePath = source === 'playwright' ? undefined : (path ?? undefined);
  const channel = executablePath ? undefined : browser?.channel === 'headless-shell' ? undefined : (browser?.channel ?? 'chromium');
  let b: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    b = await chromium.launch({
      headless: true,
      channel,
      executablePath,
      args: [...DEFAULT_BROWSER_ARGS, ...(browser?.args ?? [])],
      timeout: opts.timeoutMs ?? 30_000,
    });
    out.version = b.version();
    const page = await b.newPage({ viewport: { width: 320, height: 200 } });
    await page.setContent('<p id="ok">ok</p>');
    out.launched = (await page.textContent('#ok')) === 'ok';
    out.ms = Math.round(wallNow() - t0);
  } catch (e) {
    out.error = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  } finally {
    await b?.close().catch(() => undefined);
  }
  return out;
}
