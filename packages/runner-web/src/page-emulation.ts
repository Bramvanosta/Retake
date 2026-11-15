/** A page's own viewport (a page of a multi-page scene filmed at mobile or tablet size): BrowserSession.emulate. */
import type { CDPSession, Page } from 'playwright-core';
import { bestEffort } from '@retake/core/base';
import { mobileUserAgent } from './browser-args.js';

/** A page's own viewport: the CDP session that keeps it, the metrics it was given and the browser's own user agent. */
export interface PageEmulation {
  session: CDPSession;
  key: string;
  ua?: string;
}

/** The viewport a page of a multi-page scene is filmed at (BrowserSession.emulate). */
export interface EmulatedViewport {
  width: number;
  height: number;
  mobile?: boolean;
  touch?: boolean;
}

/** BrowserSession.emulate: device metrics, touch and user agent on the page's own CDP session, kept in `emulations`. */
export async function emulatePage(emulations: Map<Page, PageEmulation>, page: Page, vp: EmulatedViewport, scale: number): Promise<void> {
  const key = `${vp.width}x${vp.height}@${scale}${vp.mobile ? 'm' : ''}${vp.touch ? 't' : ''}`;
  let e = emulations.get(page);
  if (e?.key === key) return;
  if (!e) {
    e = { session: await page.context().newCDPSession(page), key: '' };
    emulations.set(page, e);
    page.on('close', () => emulations.delete(page));
  }
  e.key = key;
  const s = e.session;
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: scale,
    mobile: vp.mobile ?? false,
    screenWidth: vp.width,
    screenHeight: vp.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', vp.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  if (vp.mobile) {
    e.ua ??= await page.evaluate(() => navigator.userAgent).catch(() => undefined);
    if (e.ua) await bestEffort(s.send('Emulation.setUserAgentOverride', { userAgent: mobileUserAgent(e.ua) }), "a page closing as it opens keeps the browser's own user agent");
  } else if (e.ua) {
    await bestEffort(s.send('Emulation.setUserAgentOverride', { userAgent: e.ua }), "a page closing as it opens keeps the browser's own user agent");
  }
}
