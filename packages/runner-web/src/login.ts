import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { resolveEnvironment } from '@demo-studio/core';
import type { BrowserConfig, LoadedProject } from '@demo-studio/core';
import { projectBrowser, resolveAuth } from './config.js';
import { RunnerError } from './errors.js';
import { DEFAULT_BROWSER_ARGS } from './session.js';

export interface LoginOptions {
  project: LoadedProject;
  env?: string;
  /** Environment page key to open (default: the first one). */
  page?: string;
  /** Explicit URL (overrides env/page). */
  url?: string;
  browser?: BrowserConfig;
}

/**
 * Open a HEADED browser on the project's persistent profile so the user can sign in once; resolves when the
 * window is closed. The runner then reuses the profile headless.
 */
export async function openLoginBrowser(opts: LoginOptions): Promise<{ profileDir: string; url: string }> {
  const env = resolveEnvironment(opts.project, opts.env);
  const { profileDir } = resolveAuth(opts.project, env.name);
  if (!profileDir) {
    throw new RunnerError(
      `project "${opts.project.slug}" has no auth.profile${env.name ? ` for environment "${env.name}"` : ''}: add one to project.yaml to keep a signed-in browser profile`,
    );
  }
  const key = opts.page ?? Object.keys(env.pages)[0];
  const url = opts.url ?? (key ? env.pages[key] : undefined);
  if (!url) throw new RunnerError(`environment "${env.name}" has no page "${opts.page ?? ''}"`);
  await mkdir(profileDir, { recursive: true });
  const b = projectBrowser(opts.project, opts.browser);
  const executablePath = b.executable ?? process.env.DEMO_STUDIO_CHROMIUM ?? undefined;
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: executablePath ? undefined : b.channel === 'headless-shell' ? undefined : (b.channel ?? 'chromium'),
    executablePath,
    viewport: null,
    locale: b.locale,
    timezoneId: b.timezone,
    args: [...DEFAULT_BROWSER_ARGS.filter((a) => a !== '--hide-scrollbars'), ...(b.args ?? [])],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url).catch(() => undefined);
  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    page.on('close', () => {
      if (context.pages().length === 0) void context.close();
    });
  });
  return { profileDir, url };
}
