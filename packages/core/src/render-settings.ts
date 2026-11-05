/**
 * The render settings of a machine (L5.15, DESIGN §4r): how Remotion's browser draws (`gl`), which encoder writes the
 * video (`encoder`) and how many frames render at a time (`concurrency`). From retake.yaml `render:` (the workspace
 * `openWorkspace` opened last in this process, as `ffmpeg`), else `RETAKE_RENDER_GL` / `RETAKE_RENDER_ENCODER` /
 * `RETAKE_RENDER_CONCURRENCY`, else `auto`. A GPU is a property of the machine, not of the product: not in project.yaml.
 * The policy itself (what `auto` means here, the probes, the fallback) is the editor's (render/policy.ts).
 */

export const RENDER_GL_SETTINGS = ['auto', 'gpu', 'software'] as const;
export const RENDER_ENCODER_SETTINGS = ['auto', 'videotoolbox', 'libx264'] as const;
/** `concurrency` bounds (the CLI's `--concurrency` takes the same). */
export const RENDER_CONCURRENCY_MAX = 16;

export type RenderGlSetting = (typeof RENDER_GL_SETTINGS)[number];
export type RenderEncoderSetting = (typeof RENDER_ENCODER_SETTINGS)[number];

/** retake.yaml `render:` (every key optional). */
export interface RenderSettings {
  gl?: RenderGlSetting;
  encoder?: RenderEncoderSetting;
  concurrency?: number;
}

/** The variables of the settings, by key. */
export const RENDER_ENV = { gl: 'RETAKE_RENDER_GL', encoder: 'RETAKE_RENDER_ENCODER', concurrency: 'RETAKE_RENDER_CONCURRENCY' } as const;

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
  return out;
}

let workspaceRender: RenderSettings | undefined;

/**
 * The open workspace's retake.yaml `render:` for this process (a CLI command, the MCP server, the Studio server and a
 * jobs worker each serve one workspace): `openWorkspace` sets it — or clears it — each time it opens one.
 */
export function useWorkspaceRender(settings: RenderSettings | undefined): void {
  workspaceRender = settings && Object.keys(settings).length ? { ...settings } : undefined;
}

/** This process's workspace render settings (retake.yaml `render:`), or undefined. */
export function workspaceRenderSettings(): RenderSettings | undefined {
  return workspaceRender ? { ...workspaceRender } : undefined;
}
