/**
 * @demo-studio/ui — the Studio web app and its server (L4.1, R-UI-01): `studio ui` serves a React app, bundled in memory
 * by esbuild, and the engine's `/v1` HTTP API of one workspace on 127.0.0.1 behind the engine's gate; the app calls an
 * allow-list of the MCP server's tools through the same SDK-free tool layer (`callTool`). The MCP server never depends
 * on this package: it keeps working without it.
 */
export { APP_ENTRY, INDEX_HTML, UI_TARGETS, buildUi } from './bundle.js';
export type { UiAsset } from './bundle.js';
export { CALL_BODY_MAX, SMALL_BODY_MAX, UI_OPS, startStudioServer, uiTools } from './server/studio.js';
export type { StudioServer, StudioServerOptions, UiOp } from './server/studio.js';
export { EVENT_KEEPALIVE_MS, EVENT_POLL_MS, EVENT_STREAMS_MAX, Live, noIndexError } from './server/live.js';
export type { LiveOptions } from './server/live.js';
export { INDEX_OPS, OWN_OPS, indexOps, overviewOp } from './server/ops.js';
export type { ProjectOverview } from './server/ops.js';
export { launchStudio } from './server/launch.js';
export type { Launched } from './server/launch.js';
