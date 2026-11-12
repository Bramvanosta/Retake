/** A sign-in of the auth app's accounts through a headless browser, as `retake login` leaves it (the app: @retake/test-support/auth). */
import { chromium } from 'playwright-core';
import { launchTarget, writeSnapshot } from '../src/index.js';
import { PERSON_POLICY } from '@retake/core';
import { ACCOUNTS } from '@retake/test-support/auth';

/**
 * What `retake login` leaves behind, made headless: a master profile signed in as `persona` (its session cookie, if
 * any, is lost when it closes — as with a real browser) and the snapshot of that session (session cookies included).
 */
export async function signInMaster(opts: { url: string; persona: string; profileDir?: string; snapshot: string; project: string; env: string }): Promise<void> {
  const a = ACCOUNTS[opts.persona];
  const context = opts.profileDir
    ? await chromium.launchPersistentContext(opts.profileDir, { headless: true, ...launchTarget({}, { policy: PERSON_POLICY }) })
    : await (await chromium.launch({ headless: true, ...launchTarget({}, { policy: PERSON_POLICY }) })).newContext();
  try {
    const p = context.pages()[0] ?? (await context.newPage());
    await p.goto(`${opts.url}/sign-in`);
    await p.fill('input[name=email]', a.email);
    await p.fill('input[name=password]', a.password);
    await Promise.all([p.waitForURL(`${opts.url}/`), p.click('button[type=submit]')]);
    const state = await context.storageState();
    await writeSnapshot(opts.snapshot, state, { project: opts.project, env: opts.env, persona: opts.persona, how: 'test' });
  } finally {
    const browser = context.browser();
    await context.close();
    if (!opts.profileDir) await browser?.close();
  }
}
