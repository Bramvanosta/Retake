/**
 * @retake/components — components (plugins) of the edit: the contract (types), component.yaml manifests, the
 * registry (workspace → built-in library), validation, scaffolding and theme tokens (docs/DESIGN-phase2.md §1).
 *
 * Component implementations import shared helpers from `@retake/components/kit` (never from this entry, which
 * is Node-only).
 */
export * from './types.js';
export { COMPONENT_KINDS } from '@retake/core/model';
export { ComponentError, formatComponentIssues } from './errors.js';
export {
  MANIFEST_FILE,
  DEFAULT_ENTRY,
  DESIGN_SPACE,
  VARIANTS,
  SEMVER_RE,
  KIT_RANGE_RE,
  kitMajorOf,
  SLOT_SOURCES,
  THEME_TOKENS,
  MULTI_USE_KINDS,
  SlotSpecSchema,
  GeometryValueSchema,
  RectSchema,
  LayoutGeometrySchema,
  ComponentManifestFileSchema,
  checkManifest,
  normalizeManifest,
  parseManifest,
} from './manifest.js';
export type { ComponentManifestFile, ParsedManifest, ParseManifestOptions } from './manifest.js';
export {
  DEFAULT_CAPTURE_ASPECT,
  GEOMETRY_BUILTINS,
  GEOMETRY_FUNCTIONS,
  GEOMETRY_KEYS,
  GeometryExpressionError,
  evalGeometryValue,
  evalLayoutGeometry,
  expressionIdentifiers,
  geometryIsDynamic,
  geometryScope,
  isMultiPaneGeometry,
  parseGeometryExpression,
} from './geometry.js';
export { ANCHOR_BUILTINS, ANCHOR_KEYS, anchorScope, evalAnchor, oneHotName, paramEnums } from './geometry.js';
export type { AnchorContext } from './geometry.js';
export type { GeometryValue } from './geometry.js';
export {
  PARAM_TYPES,
  SUPPORTED_KEYWORDS,
  ANNOTATION_KEYWORDS,
  applyParamDefaults,
  checkParamsSchema,
  paramDefaults,
  validateParamValue,
} from './json-schema.js';
export type { JsonSchemaNode, ParamType } from './json-schema.js';
export { componentJsonSchema, writeComponentJsonSchema } from './schema-json.js';
export { loadComponentRegistry, loadComponentDir, usableAs } from './registry.js';
export type { ComponentRegistry, LoadComponentRegistryOptions, RegistryNotice } from './registry.js';
export { componentFit } from './fit.js';
export type { ComponentFit, ComponentUse } from './fit.js';
export {
  ALLOWED_IMPORTS,
  FORBIDDEN_APIS,
  HASHED_FILE,
  PREVIEW_ARTIFACTS,
  UNHASHED_DIRS,
  checkComponentEntry,
  importProblem,
  scanSource,
  stripComments,
  unhashedFileProblem,
  unhashedImportMessage,
} from './compile.js';
export type { EntryCheck } from './compile.js';
export { validateComponent, validateComponentDir } from './validate.js';
export type { ComponentValidation, ValidateComponentOptions } from './validate.js';
export { BUILTIN_NAMESPACE, createComponent, componentDisplayName } from './create.js';
export type { CreateComponentOptions, CreatedComponent } from './create.js';
export { themeTokens, themeFontFamilies, fontFileFace } from './theme.js';
export type { ThemeUrls } from './theme.js';
export { COMPONENT_SCHEMA_FILE, GEOMETRY_MODULE, KIT_API_VERSION, KIT_MODULE, LIBRARY_DIR, PACKAGE_DIR, SCAFFOLDS_DIR, geometryEntry, kitEntry, scaffoldDir } from './paths.js';
export { fillSlots, slotSource } from './slots.js';
export { parseCsv, parseNumber } from './data.js';
export type { FilledSlots, SlotContext } from './slots.js';
/** The kit's pure easing curves (no React), for Node-side consumers such as the edit planner. */
export { CAMERA_EASINGS, DEFAULT_ZOOM_EASE, cubicBezier } from './kit/easing.js';
export type { Bezier, EasingFn } from './kit/easing.js';
/** The kit's text fitting (pure, no React), for Node-side consumers such as the review. */
export { estimateTextWidth, fitText, wrapText } from './kit/fit-text.js';
/** Caption band placement (pure), shared by studio/caption-overlay and the review. */
export { CAPTION_BAND_INSET, CAPTION_BAND_MIN_SCREEN, CAPTION_BAND_PAD_X, captionBandBox, captionMaxLines } from './kit/devices.js';
export type { CaptionBandInput } from './kit/devices.js';
export type { FitTextOptions, FitTextResult, TextFont, TextMeasurer } from './kit/fit-text.js';
export {
  PREVIEW_FILE,
  PREVIEW_FORMAT,
  PREVIEW_MAX_BYTES,
  PREVIEW_META_FILE,
  PREVIEW_SAMPLES_DIR,
  PREVIEW_SIZE,
  PREVIEW_THEME,
  README_BEGIN,
  README_END,
  componentSourceFiles,
  componentSourceHash,
  mergePreviewReadme,
  pngSize,
  previewMoment,
  previewReadmeBlock,
  previewStatus,
  readPreviewMeta,
  writePreviewReadme,
} from './preview.js';
export type { PreviewMeta, PreviewStatus } from './preview.js';
/** Themes from brand inputs (L3.5): the deterministic palette and the generated template.yaml. */
export { DARK_PAPER_LUMINANCE, PALETTE_THRESHOLDS, derivePalette, paletteTone } from './brand/palette.js';
export type { Palette, PaletteAdjustment, PaletteBackground, PaletteCheck, PaletteColors, PaletteInput, PaletteTone } from './brand/palette.js';
export { generateThemeFile } from './brand/template-file.js';
export type { ThemeFile, ThemeFileInput } from './brand/template-file.js';
