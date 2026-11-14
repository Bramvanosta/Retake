/**
 * The Studio's component library ops (L4.7, R-UI-06 / R-UI-06b): library_view, library_images, library_render and
 * library_component are the engine's operations (L7.17: packages/engine/src/operations/library.ts, with library_view's
 * memo and library_render's one-at-a-time key). Not MCP tools: Claude has component_list, component_get and
 * component_preview. This file names their caps and the answer types the app reads.
 */
export { LIBRARY_IMAGES_ANSWER_MAX, LIBRARY_VIEW_MEMO_MAX, LOOP_DATA_MAX, POSTER_DATA_MAX, componentAnswer } from '@retake/engine/contract';
export type { LibraryComponentAnswer, LibraryImage, LibraryImagesAnswer, LibraryItem, LibraryParam, LibraryRenderAnswer, LibrarySlot, LibraryViewAnswer } from '@retake/engine/contract';

/** The library ops' names. */
export const LIBRARY_OPS = ['library_view', 'library_images', 'library_render', 'library_component'] as const;
