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
    move_base_ms: millis(),
    move_ms_per_px: z.number().min(0),
    move_min_ms: millis(),
    move_max_ms: millis(),
    hover_ms: millis().describe('Hover pause before pressing (150–250).'),
    press_ms: millis().describe('mousedown → mouseup.'),
    after_click_ms: millis().describe('Pause after an ordinary click.'),
    after_popup_ms: millis().describe('Pause after a click that opened a popup (600–1000).'),
    popup_timeout_ms: millis().describe('How long to wait for an expected popup before the next click strategy.'),
    type_cps: z.number().gt(0).describe('Typing speed, characters per second (9–24).'),
    scroll_duration: positiveSeconds().describe('Smooth scroll duration in seconds (1.5–2).'),
    jitter: z.number().min(0).max(0.5).describe('Deterministic ±fraction jitter applied to durations (0 = none).'),
    settle_ms: millis().describe('After navigation: wait for network idle up to this many ms.'),
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
  })
  .meta({ id: 'BrowserConfig' }) satisfies z.ZodType<BrowserConfig>;
