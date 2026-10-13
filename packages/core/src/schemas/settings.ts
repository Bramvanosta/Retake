import { z } from 'zod';
import type { AuthConfig, BrowserConfig, CaptureSettings, Pacing } from '../types.js';
import { millis, nonEmpty, positiveSeconds, seconds } from './primitives.js';

export const CaptureSettingsSchema = z
  .strictObject({
    width: z.number().int().min(200).max(7680).describe('Viewport width in CSS px.'),
    height: z.number().int().min(200).max(4320).describe('Viewport height in CSS px.'),
    scale: z.number().gt(0).max(4).describe('deviceScaleFactor: 1, or 2 for 4K from a 1920×1080 viewport.'),
    fps: z.number().int().min(1).max(120).describe('Output frame rate of capture.mp4.'),
    format: z.enum(['jpeg', 'png']).describe('Screencast frame format.'),
    quality: z.number().int().min(1).max(100).describe('JPEG quality (1-100).'),
    keep_frames: z.boolean().describe('Keep runs/<id>/frames after encoding.'),
    crf: z.number().int().min(0).max(51).describe('libx264 CRF of capture.mp4.'),
  })
  .meta({ id: 'CaptureSettings' }) satisfies z.ZodType<CaptureSettings>;

export const CapturePartialSchema = CaptureSettingsSchema.partial().meta({
  id: 'CaptureOverrides',
  description: 'Capture settings (merged over the defaults: 1920×1080, scale 1, 30 fps, jpeg 100, crf 16).',
});

export const PacingSchema = z
  .strictObject({
    scene_start_still: seconds().describe('Seconds still at scene start (1.5–2).'),
    move_base_ms: millis().describe('Cursor travel: ms = clamp(move_base_ms + distance·move_ms_per_px, move_min_ms, move_max_ms).'),
    move_ms_per_px: z.number().min(0).describe('See move_base_ms (field notes: 0.9 ms per px).'),
    move_min_ms: millis().describe('Shortest ordinary move (450).'),
    move_max_ms: millis().describe('Longest move (1100).'),
    nudge_px: z.number().min(0).describe('Moves shorter than this (px) are nudges: repeated clicks on almost the same spot.'),
    nudge_ms: millis().describe('Travel time of a nudge of nudge_px (shorter nudges: down to 60 % of it; zero-length moves: 0).'),
    nudge_hover_ms: millis().describe('Hover pause before pressing after a nudge.'),
    hover_ms: millis().describe('Hover pause before pressing (150–250).'),
    press_ms: millis().describe('mousedown → mouseup.'),
    after_click_ms: millis().describe('Pause after an ordinary click.'),
    after_popup_ms: millis().describe('Pause after a click that opened a popup (600–1000).'),
    after_navigation_ms: millis().describe('Minimum time after a click that navigated or changed the URL before the next step (1.5–2.8 s).'),
    popup_fallback_ms: millis().describe(
      'How long a click gets to show that an expected popup opened (aria-expanded / new popup, polled) before the next click strategy.',
    ),
    popup_timeout_ms: millis().describe('How long the last click strategy waits for an expected popup before reporting it missing.'),
    type_cps: z
      .number()
      .gt(0)
      .describe('Typing speed, characters per second (~14); a type step without cps adapts it: search fields ≤ 10, long free text up to 24.'),
    page_switch_ms: millis().describe('Multi-page scenes: pause before a step that acts on another page than the previous step (its cursor then glides from where it rests).'),
    scroll_duration: positiveSeconds().describe('Smooth scroll duration in seconds (1.5–2).'),
    scroll_offset: z.number().describe('Default scroll offset with a target (−140 ⇒ the target ends 140 px below the top).'),
    jitter: z.number().min(0).max(0.5).describe('Deterministic ±fraction jitter applied to durations (0 = none).'),
    settle_ms: millis().describe('After navigation: wait for network idle up to this many ms.'),
    park_hold: seconds().describe("Seconds a step's `park: true` holds the cursor still on the result (1.5–2.6)."),
    park_scroll_hold: seconds().describe("Seconds a scroll's `park: true` holds the cursor next to the target (3–3.5)."),
  })
  .meta({ id: 'Pacing' }) satisfies z.ZodType<Pacing>;

export const PacingPartialSchema = PacingSchema.partial().meta({
  id: 'PacingOverrides',
  description: 'Deterministic pacing overrides (merged over the field-tested defaults).',
});

export const AuthConfigSchema = z
  .strictObject({
    profile: nonEmpty().describe('Persistent, pre-authenticated Chromium profile directory (~ expanded).').optional(),
    storage_state: nonEmpty().describe('Playwright storageState JSON (alternative to profile).').optional(),
  })
  .meta({ id: 'AuthConfig', description: 'Never a password: a pre-authenticated profile or storage state.' }) satisfies z.ZodType<AuthConfig>;

export const BrowserConfigSchema = z
  .strictObject({
    executable: nonEmpty().optional(),
    channel: z.enum(['chromium', 'headless-shell', 'chrome']).describe("'chromium' = new headless (default).").optional(),
    headless: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    locale: nonEmpty().optional(),
    timezone: nonEmpty().optional(),
    color_scheme: z.enum(['light', 'dark']).optional(),
    frame_rate_limit: z
      .boolean()
      .describe(
        "false: run Chromium without its frame rate limiter — no ≈ 0.26 s capture stall when a dialog with a backdrop-filter overlay closes, but requestAnimationFrame then runs at thousands of Hz while anything animates (fixed-step animations play too fast) and 2–6× the CPU. Default true.",
      )
      .optional(),
  })
  .meta({ id: 'BrowserConfig' }) satisfies z.ZodType<BrowserConfig>;
