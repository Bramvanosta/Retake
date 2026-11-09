/**
 * L6.13: The Library: its view, a component's detail, the posters and loops, their renders. Each op once, typed by
 * StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';

export const useLibraryView = readHook('library_view');
export const useLibraryComponent = readHook('library_component');
export const libraryImages = op('library_images');
export const libraryRender = op('library_render');
