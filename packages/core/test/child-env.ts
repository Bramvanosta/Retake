/**
 * The environment of a process a test starts with an explicit `env` (an MCP server over stdio or HTTP, a CLI command):
 * only what the test gives passes, so the rules of every test run go with it (core retake-home.test.ts is the canary):
 * - CFFIXED_USER_HOME: the run's scratch one (L5.16 Library hygiene: Chromium's crash reporter writes into the
 *   account's ~/Library without it);
 * - RETAKE_CAPTURES_DIR: the file's own filming-marker folder (vitest.setup.ts, L5.14);
 * - RETAKE_RENDER_GL / RETAKE_RENDER_ENCODER: the render pin of vitest.setup.ts (L5.15: `software` / `libx264`), so the
 *   renders of the server's worker and job processes take the software path as the test process does.
 * PATH and HOME are the test process's; `extra` comes last (RETAKE_HOME, the test's own variables, another PATH).
 */
export function testChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const pass = (name: string) => (process.env[name] !== undefined ? { [name]: process.env[name]! } : {});
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '',
    RETAKE_CAPTURES_DIR: process.env.RETAKE_CAPTURES_DIR ?? '',
    ...pass('RETAKE_RENDER_GL'),
    ...pass('RETAKE_RENDER_ENCODER'),
    ...extra,
  };
}
