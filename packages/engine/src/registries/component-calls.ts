/**
 * The components package's pure work, beside its registry and its catalogue's disk work (registries.ts: the port): what
 * the engine's catalogue, previews, themes and brands compute — a manifest's params' defaults and checks, a component's
 * fit for a use, the palette and theme-file makers, a font file's face from its name, the theme tokens, the kit's major,
 * where a scaffold and the library's samples lie, and the library's constants. None reads or writes a file, compiles or
 * runs code (the port's members do). Loaded through the engine's loader on the first call (lazy.ts `components`, the module the composition package binds); each
 * member is the package's own, handed on unchanged.
 */
import type * as Library from '@retake/components';
import { components } from '../lazy.js';

/** The package's members the engine's component work calls (the same functions and values, by name). */
export type ComponentCalls = Pick<
  typeof Library,
  | 'KIT_API_VERSION'
  | 'PREVIEW_FILE'
  | 'PREVIEW_MAX_BYTES'
  | 'PREVIEW_SAMPLES_DIR'
  | 'PREVIEW_SIZE'
  | 'PREVIEW_THEME'
  | 'applyParamDefaults'
  | 'componentFit'
  | 'derivePalette'
  | 'fontFileFace'
  | 'generateThemeFile'
  | 'kitMajorOf'
  | 'paletteTone'
  | 'paramDefaults'
  | 'scaffoldDir'
  | 'themeTokens'
  | 'validateParamValue'
>;

/** The component calls (loads the components package on the first call). */
export async function componentCalls(): Promise<ComponentCalls> {
  const c = await components();
  return {
    KIT_API_VERSION: c.KIT_API_VERSION,
    PREVIEW_FILE: c.PREVIEW_FILE,
    PREVIEW_MAX_BYTES: c.PREVIEW_MAX_BYTES,
    PREVIEW_SAMPLES_DIR: c.PREVIEW_SAMPLES_DIR,
    PREVIEW_SIZE: c.PREVIEW_SIZE,
    PREVIEW_THEME: c.PREVIEW_THEME,
    applyParamDefaults: c.applyParamDefaults,
    componentFit: c.componentFit,
    derivePalette: c.derivePalette,
    fontFileFace: c.fontFileFace,
    generateThemeFile: c.generateThemeFile,
    kitMajorOf: c.kitMajorOf,
    paletteTone: c.paletteTone,
    paramDefaults: c.paramDefaults,
    scaffoldDir: c.scaffoldDir,
    themeTokens: c.themeTokens,
    validateParamValue: c.validateParamValue,
  };
}
