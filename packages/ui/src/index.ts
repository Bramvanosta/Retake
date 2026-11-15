/**
 * @retake/ui — the Studio web app and its server (R-UI-01): `retake ui` serves a React app, bundled in memory
 * by esbuild, and the engine's `/v1` HTTP API of one workspace on 127.0.0.1 behind the engine's gate; the app calls an
 * allow-list of operations — the engine's operations it shares with the MCP server and its own ops — through the same
 * SDK-free call (`invoke`, @retake/engine/contract). The MCP server never depends on this package: it keeps working
 * without it.
 */

export { startStudioServer } from './server/studio.js';
export type { StudioServer } from './server/studio.js';
export { launchStudio } from './server/launch.js';
export { startSupervisor } from './server/supervise.js';
export { applyShellLine } from './server/setup-ops.js';
