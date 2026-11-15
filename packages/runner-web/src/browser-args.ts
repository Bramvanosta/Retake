/** The capture browser's Chromium switches, and the mobile user agent of an emulated page. */
import type { BrowserConfig } from '@retake/core/project';

/** Chromium flags for clean, uninterrupted captures (background tabs keep rendering). */
export const DEFAULT_BROWSER_ARGS = [
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-features=Translate,MediaRouter',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * `browser.frame_rate_limit: false` launches Chromium without its frame rate limiter. With the limiter, frame
 * production stops ≈ 0.26 s after a dialog whose overlay has a backdrop-filter closes (measured on macOS / Metal: the
 * click ripple freezes in the capture); without it that stall is gone, but the compositor draws back to back:
 * requestAnimationFrame runs at thousands of Hz while anything animates (24 000 Hz with a CSS spinner on screen), so
 * animations that advance a fixed step per frame play far too fast, and the CPU climbs 2–6×. Default: the limiter.
 */
export function frameRateArgs(b: Pick<BrowserConfig, 'frame_rate_limit' | 'args'> = {}): string[] {
  if (b.frame_rate_limit !== false || b.args?.includes('--disable-frame-rate-limit')) return [];
  return ['--disable-frame-rate-limit'];
}

/**
 * Launch flags for a capture at device scale `scale` (measured in docs/HANDOFF.md): the CDP screencast of
 * headless Chromium (new headless and the headless shell alike) sends frames at the window's physical size, which
 * stays at CSS size whatever `deviceScaleFactor` the page emulates — `Emulation.setDeviceMetricsOverride` on the
 * recorder's session and `Page.captureScreenshot` give CSS-size images too. Forcing the browser's own device scale
 * factor makes the compositor surface `scale`× larger, so a 1920×1080 viewport at scale 2 is captured as real
 * 3840×2160 frames (text rasterised at 2×, not upscaled). Not used for headed windows (the display's own scale
 * applies) nor when the project already passes the flag.
 */
export function scaleArgs(scale: number, headed: boolean | undefined, extra: readonly string[] = []): string[] {
  if (headed || !(scale > 0) || scale === 1) return [];
  if (extra.some((a) => a.startsWith('--force-device-scale-factor'))) return [];
  return [`--force-device-scale-factor=${scale}`];
}

/**
 * A mobile user agent derived from the browser's own (same engine and version): the platform token becomes an Android
 * phone and "Mobile" is added, so sites that pick their layout from the user agent serve the phone one.
 */
export function mobileUserAgent(ua: string): string {
  let out = ua.replace(/\([^)]*\)/, '(Linux; Android 14; K)');
  if (!/\bMobile\b/.test(out)) out = out.replace(/ Safari\//, ' Mobile Safari/');
  return out;
}
