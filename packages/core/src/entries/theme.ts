/**
 * @retake/core/theme — themes and components: template.yaml read and checked with its defaults, a theme's components,
 * the theme editor's edits, brand inputs, the site a theme is drawn from.
 *
 * A context of core: its files may import the contexts before it (base, model, ids,
 * language, environment, policy, hooks, project, sandbox, scenario, comments, run, render); the ratchet's
 * `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of the file
 * that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages' sources import
 * an entry: the `core-root` check).
 */
export * from '../types/theme.js';
export * from '../template.js';
export * from '../components.js';
export * from '../theme-edits.js';
export * from '../brand.js';
export * from '../site.js';
export { TemplateFileSchema, TemplateSchema } from '../schemas/template.js';
