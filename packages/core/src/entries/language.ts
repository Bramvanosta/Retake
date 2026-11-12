/**
 * @retake/core/language — the scenario language's shapes: steps and their actions, targets, multi-page scenes, tutorial
 * switches, the video's edit info, a scene's templating, the step and settings schemas.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids); the
 * ratchet's `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of
 * the file that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages'
 * sources import an entry: the `core-root` check).
 */
export * from '../steps.js';
export * from '../targets.js';
export * from '../pages.js';
export * from '../tutorial.js';
export * from '../video.js';
export * from '../scenario-template.js';
export { ACTION_ARG_SCHEMAS, ACTION_DESCRIPTIONS, OVERLAY_MAX_SECONDS, OverlaySpecSchema, STEP_COMMON_KEYS, StepSchema } from '../schemas/steps.js';
export { AuthConfigSchema, BrowserConfigSchema, CapturePartialSchema, CaptureSettingsSchema, PacingPartialSchema, PacingSchema } from '../schemas/settings.js';
