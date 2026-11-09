/**
 * L6.13: The themes: the list, a theme's view and its writes (edit, copy, create), its preview, the brand files and
 * the site extractions. Each op once, typed by StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';
import type { OpArgs } from './client.js';

export const useThemeList = readHook('theme_list');
export const themeView = op('theme_view');
export const themeEdit = op('theme_edit');
export const themeCopy = op('theme_copy');
export const themeCreate = op('theme_create');
export const themePreview = op('theme_preview');
export const brandFiles = op('brand_files');
export const siteList = op('site_list');
export const useSiteList = readHook('site_list');

/** theme_create's input (the New theme form's: theme-words.ts createInput). */
export type ThemeCreateInput = OpArgs<'theme_create'>;
/** One edit of theme_edit (its input's `edit`). */
export type ThemeEditInput = OpArgs<'theme_edit'>['edit'];
