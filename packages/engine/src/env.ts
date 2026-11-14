/**
 * The environment the engine reads (its variables: the Retake home, the captures folder, the time limits a person
 * sets, the display, the author's name): a value its composition root hands it (ports.ts EnginePorts `env`: this
 * process's for the product, a test's own), never `process.env` read where it is used (the import-rules ratchet's
 * `env-read` check).
 */

/** The variables of an environment, read only. */
export type EngineEnv = Readonly<Record<string, string | undefined>>;

/** No display a window could open on: Linux with neither DISPLAY nor WAYLAND_DISPLAY set (macOS always has one). */
export function noDisplay(env: EngineEnv, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
