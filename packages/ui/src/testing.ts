/**
 * @retake/ui/testing — the Studio server's op table builder, for other packages' tests that read the ops' definitions
 * (names, schemas, annotations: the shared helper `@retake/test-support/studio-tools` builds it with stand-ins). No
 * product source imports this entry.
 */
export { studioTools } from './server/studio.js';
export type { StudioToolDeps } from './server/studio.js';
