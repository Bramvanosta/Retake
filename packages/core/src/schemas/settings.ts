import { z } from 'zod';
import { CAPTURE_ENCODERS } from '../types.js';
import type { AuthConfig, BrowserConfig, CaptureSettings, LoginPattern, LoginStep, Pacing, PersonaCheck, PersonaConfig } from '../types.js';
import { keyedUnion } from './keyed.js';
import { TargetSpecSchema, keyString, millis, nonEmpty, positiveSeconds, seconds, slugString } from './primitives.js';
import { ACTION_ARG_SCHEMAS } from './steps.js';

export const CaptureSettingsSchema = z
  .strictObject({
    width: z.number().int().min(200).max(7680).describe('Viewport width in CSS px.'),
    height: z.number().int().min(200).max(4320).describe('Viewport height in CSS px.'),
    scale: z.number().gt(0).max(4).describe('deviceScaleFactor: 1, or 2 for 4K from a 1920×1080 viewport.'),
    fps: z.number().int().min(1).max(120).describe('Output frame rate of capture.mp4.'),
    format: z.enum(['jpeg', 'png']).describe('Screencast frame format.'),
    quality: z.number().int().min(1).max(100).describe('JPEG quality of the screencast frames (1-100, default 90).'),
    keep_frames: z
      .boolean()
      .describe('Keep the screencast frames in runs/<id>/frames (real timing, for the raw export). Default false: capture.mp4 is encoded during the take.'),
    crf: z.number().int().min(0).max(51).describe('libx264 CRF of capture.mp4 (when the encoder is libx264).'),
    encoder: z
      .enum(CAPTURE_ENCODERS)
      .describe("Encoder of capture.mp4, fed during the take: auto (default: the Mac's hardware H.264 encoder when ffmpeg has it, else libx264), videotoolbox or libx264.")
      .optional(),
    prewarm: z
      .boolean()
      .describe('Visit each page of the scenario once off camera before the take, so the first visit is not filmed cold. Default false.')
      .optional(),
    step_shots: z
      .boolean()
      .describe('Keep one picture per step of a capture in runs/<id>/screenshots (the captured frame at the end of each step), as a dry run does. Default false.')
      .optional(),
  })
  .meta({ id: 'CaptureSettings' }) satisfies z.ZodType<CaptureSettings>;

export const CapturePartialSchema = CaptureSettingsSchema.partial().meta({
  id: 'CaptureOverrides',
  description: 'Capture settings (merged over the defaults: 1920×1080, scale 1, 30 fps, jpeg 90, frames not kept, encoder auto, crf 16).',
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

export const RunDefaultsSchema = z
  .strictObject({
    timeout_s: positiveSeconds()
      .describe(
        'Seconds every wait and action waits when it has no `timeout` of its own: targets, wait_for, wait_for_email, download… (built-in: 15; 30 for wait_for_email and download).',
      )
      .optional(),
  })
  .meta({ id: 'RunDefaults', description: 'Defaults of every step (a scenario\'s win over the project\'s).' });

export const PacingPartialSchema = PacingSchema.partial().meta({
  id: 'PacingOverrides',
  description: 'Deterministic pacing overrides (merged over the field-tested defaults).',
});

export const LoginPatternSchema = z
  .union([
    nonEmpty(),
    z.strictObject({
      regex: nonEmpty().describe('Regular expression tested against the origin + path of the URL (never its query).'),
      flags: z.string().regex(/^[dgimsuyv]*$/, { error: 'flags are regular expression flags (i, u…)' }).optional(),
    }),
  ])
  .meta({
    id: 'LoginPattern',
    description:
      'A sign-in page, matched against the origin + path of a URL (never its query): a path prefix ("/sign-in"; also "/sign-in/…", not "/sign-in-help"), ' +
      '"<environment page>:<path>", an absolute URL prefix ("https://sso.example.com") or {regex, flags?}.',
  }) satisfies z.ZodType<LoginPattern>;

export const LoginPatternsSchema = z.union([LoginPatternSchema, z.array(LoginPatternSchema).min(1)]);

export const PersonaCheckSchema = z
  .strictObject({
    url: nonEmpty().describe('Page the check opens: "<environment page>:<path>", a path on the persona\'s first page or a URL (default: the first page\'s "/").').optional(),
    expect_text: nonEmpty().describe('Text visible only when signed in (the account name…). Without it: signed in when the page loads off the sign-in pages.').optional(),
    expect_not_url: LoginPatternsSchema.describe('Pages the check must not end on (sign-in pages for the run\'s guard too).').optional(),
    timeout: positiveSeconds().describe('Seconds (default 10).').optional(),
  })
  .meta({ id: 'PersonaCheck', description: 'How the runner tells this persona is signed in, off camera before every run.' }) satisfies z.ZodType<PersonaCheck>;

const loginCommon = {
  timeout: positiveSeconds().describe('Seconds before the step fails (default 15).').optional(),
  note: z.string().optional(),
};
const LOGIN_ACTIONS = ['open', 'click', 'type', 'press', 'wait_for', 'wait'] as const;

/** A login step: one of six actions (scenario syntax), run off camera. Narrow on purpose (the project schema stays small). */
export const LoginStepSchema = keyedUnion(
  [
    z.strictObject({ open: ACTION_ARG_SCHEMAS.open.describe('Path on the persona\'s first page, "<environment page>:<path>" or a URL.'), ...loginCommon }),
    z.strictObject({ click: TargetSpecSchema.describe('Element to click.'), ...loginCommon }),
    z.strictObject({
      type: z.strictObject({
        into: TargetSpecSchema.describe('Field to click into first (it is cleared: a copied profile may have filled it).').optional(),
        text: z.string().describe('Text to type: a password comes from {{env:VAR}} or {{keychain:service/account}}.'),
        enter: z.boolean().describe('Press Enter afterwards.').optional(),
      }),
      ...loginCommon,
    }),
    z.strictObject({ press: ACTION_ARG_SCHEMAS.press, ...loginCommon }),
    z.strictObject({ wait_for: ACTION_ARG_SCHEMAS.wait_for, ...loginCommon }),
    z.strictObject({ wait: seconds().describe('Seconds.'), ...loginCommon }),
  ],
  { noun: 'login step', label: 'action', keys: LOGIN_ACTIONS, common: Object.keys(loginCommon), example: 'e.g. "open: console:/sign-in" or "click: Sign in"' },
  { id: 'LoginStep', description: `One login action (${LOGIN_ACTIONS.join(', ')}), run off camera.` },
) as unknown as z.ZodType<LoginStep>;

/** The fields of a persona (also of a sandbox account, which adds username and password). */
export const personaShape = {
  email: z
    .email({ error: 'email is a mail address (name@example.com)' })
    .describe('The persona\'s mail address: wait_for_email {to: persona:<name>} matches it, mail cards label the mailbox after the persona.')
    .optional(),
  pages: z.array(keyString('page')).describe('Environment pages this persona is signed into by default (a page belongs to at most one persona).').optional(),
  session: z
    .enum(['profile', 'storage_state'])
    .describe('profile (default): the Chromium profile `retake login` keeps, copied for each run; storage_state: cookies + localStorage only.')
    .optional(),
  check: PersonaCheckSchema.optional(),
  login_url: LoginPatternsSchema.describe('Sign-in pages of this persona (with auth.login_url).').optional(),
  login: z.array(LoginStepSchema).min(1).describe('Automated login, off camera, when the saved session is missing or expired (secret refs only).').optional(),
};

export const PersonaSchema = z
  .strictObject(personaShape)
  .meta({
    id: 'Persona',
    description: 'One account the videos are filmed as. Its session lives in ~/.retake (RETAKE_HOME), never in the project: no path here.',
  }) satisfies z.ZodType<PersonaConfig>;

export const AuthConfigSchema = z
  .strictObject({
    profile: nonEmpty().describe('Legacy single account: pre-authenticated Chromium profile directory (~ expanded). Prefer personas.').optional(),
    storage_state: nonEmpty().describe('Legacy single account: Playwright storageState JSON. Prefer personas.').optional(),
    login_url: LoginPatternsSchema.describe('Sign-in pages of every persona (and of pages without one): landing there during a run fails it.').optional(),
    personas: z.record(slugString('persona name'), PersonaSchema).describe('Named accounts: supplier, buyer, admin…').optional(),
  })
  .meta({ id: 'AuthConfig', description: 'Never a password: named personas (sessions kept outside the project), or a legacy pre-authenticated profile.' }) satisfies z.ZodType<AuthConfig>;

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
