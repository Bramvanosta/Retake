/**
 * The render settings of a machine (L5.15, DESIGN §4r): how Remotion's browser draws (`gl`), which encoder writes the
 * video (`encoder`), how many frames render at a time (`concurrency`) and which ffmpeg encodes the frames (`ffmpeg`,
 * L7.3). From retake.yaml `render:` (the work's WorkPolicy `render`, core agent-policy.ts, as `ffmpeg`), else
 * `RETAKE_RENDER_GL` / `RETAKE_RENDER_ENCODER` / `RETAKE_RENDER_CONCURRENCY` / `RETAKE_RENDER_FFMPEG`, else `auto`. A GPU
 * is a property of the machine, not of the product: not in project.yaml.
 * The policy itself (what `auto` means here, the probes, the fallback) is the editor's (render/policy.ts).
 */

export const RENDER_GL_SETTINGS = ['auto', 'gpu', 'software'] as const;
export const RENDER_ENCODER_SETTINGS = ['auto', 'videotoolbox', 'libx264'] as const;
/**
 * Which ffmpeg encodes a render's frames (L7.3): `own` — this machine's (retake.yaml `ffmpeg:` → `$RETAKE_FFMPEG` → the
 * app's → PATH) when it qualifies, `library` — the rendering library's own, `auto` — the editor's choice (render/policy.ts:
 * ours for a render drawn on the GPU, the library's on the software path and inside the app bundle).
 */
export const RENDER_FFMPEG_SETTINGS = ['auto', 'own', 'library'] as const;
/** `concurrency` bounds (the CLI's `--concurrency` takes the same). */
export const RENDER_CONCURRENCY_MAX = 16;

export type RenderGlSetting = (typeof RENDER_GL_SETTINGS)[number];
export type RenderEncoderSetting = (typeof RENDER_ENCODER_SETTINGS)[number];
export type RenderFfmpegSetting = (typeof RENDER_FFMPEG_SETTINGS)[number];

/** retake.yaml `render:` (every key optional). */
export interface RenderSettings {
  gl?: RenderGlSetting;
  encoder?: RenderEncoderSetting;
  concurrency?: number;
  ffmpeg?: RenderFfmpegSetting;
}

/** The variables of the settings, by key. */
export const RENDER_ENV = { gl: 'RETAKE_RENDER_GL', encoder: 'RETAKE_RENDER_ENCODER', concurrency: 'RETAKE_RENDER_CONCURRENCY', ffmpeg: 'RETAKE_RENDER_FFMPEG' } as const;

/** A render setting that cannot be used (a bad variable value): its message names the variable. */
export class RenderSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderSettingsError';
  }
}

/** The settings the environment sets (blank variables are unset); RenderSettingsError naming the variable when invalid. Pure. */
export function renderSettingsFromEnv(env: Record<string, string | undefined>): RenderSettings {
  const out: RenderSettings = {};
  const gl = env[RENDER_ENV.gl]?.trim();
  if (gl) {
    if (!(RENDER_GL_SETTINGS as readonly string[]).includes(gl)) throw new RenderSettingsError(`$${RENDER_ENV.gl} is "${gl}": use ${RENDER_GL_SETTINGS.join(', ')}`);
    out.gl = gl as RenderGlSetting;
  }
  const encoder = env[RENDER_ENV.encoder]?.trim();
  if (encoder) {
    if (!(RENDER_ENCODER_SETTINGS as readonly string[]).includes(encoder)) throw new RenderSettingsError(`$${RENDER_ENV.encoder} is "${encoder}": use ${RENDER_ENCODER_SETTINGS.join(', ')}`);
    out.encoder = encoder as RenderEncoderSetting;
  }
  const concurrency = env[RENDER_ENV.concurrency]?.trim();
  if (concurrency) {
    const n = Number(concurrency);
    if (!/^\d+$/.test(concurrency) || n < 1 || n > RENDER_CONCURRENCY_MAX) throw new RenderSettingsError(`$${RENDER_ENV.concurrency} is "${concurrency}": use a whole number from 1 to ${RENDER_CONCURRENCY_MAX}`);
    out.concurrency = n;
  }
  const ffmpeg = env[RENDER_ENV.ffmpeg]?.trim();
  if (ffmpeg) {
    if (!(RENDER_FFMPEG_SETTINGS as readonly string[]).includes(ffmpeg)) throw new RenderSettingsError(`$${RENDER_ENV.ffmpeg} is "${ffmpeg}": use ${RENDER_FFMPEG_SETTINGS.join(', ')}`);
    out.ffmpeg = ffmpeg as RenderFfmpegSetting;
  }
  return out;
}
