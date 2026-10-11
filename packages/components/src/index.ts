/**
 * @demo-studio/components — components (plugins) of the edit: the contract (types), component.yaml manifests, the
 * registry (workspace → built-in library), validation, scaffolding and theme tokens (docs/DESIGN-phase2.md §1).
 *
 * Component implementations import shared helpers from `@demo-studio/components/kit` (never from this entry, which
 * is Node-only).
 */
export * from './types.js';
export { ComponentError, formatComponentIssues } from './errors.js';
export {
  MANIFEST_FILE,
  DEFAULT_ENTRY,
  DESIGN_SPACE,
  SEMVER_RE,
  SLOT_SOURCES,
  THEME_TOKENS,
  SlotSpecSchema,
  RectSchema,
  LayoutGeometrySchema,
  ComponentManifestFileSchema,
  checkManifest,
  normalizeManifest,
  parseManifest,
} from './manifest.js';
export type { ComponentManifestFile, ParsedManifest, ParseManifestOptions } from './manifest.js';
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
export { loadComponentRegistry, loadComponentDir } from './registry.js';
export type { ComponentRegistry, LoadComponentRegistryOptions, RegistryNotice } from './registry.js';
export { ALLOWED_IMPORTS, FORBIDDEN_APIS, checkComponentEntry, scanSource, stripComments } from './compile.js';
export type { EntryCheck } from './compile.js';
export { validateComponent, validateComponentDir } from './validate.js';
export type { ComponentValidation, ValidateComponentOptions } from './validate.js';
export { createComponent, componentDisplayName } from './create.js';
export type { CreateComponentOptions, CreatedComponent } from './create.js';
export { themeTokens, themeFontFamilies, fontFileFace } from './theme.js';
export type { ThemeUrls } from './theme.js';
export { COMPONENT_SCHEMA_FILE, KIT_MODULE, LIBRARY_DIR, PACKAGE_DIR, SCAFFOLDS_DIR, kitEntry, scaffoldDir } from './paths.js';
export { fillSlots, slotSource } from './slots.js';
export type { FilledSlots, SlotContext } from './slots.js';
/** The kit's pure easing curves (no React), for Node-side consumers such as the edit planner. */
export { CAMERA_EASINGS, DEFAULT_ZOOM_EASE, cubicBezier } from './kit/easing.js';
export type { Bezier, EasingFn } from './kit/easing.js';
