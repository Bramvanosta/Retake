/**
 * @retake/core — every entry of core at once (L7.35, audit 2026-11-10 D1): the contexts' entries, kept as one namespace
 * for tests, scripts and anything outside the packages' sources. A package's sources import the entry of what they use
 * (`@retake/core/<context>`; the ratchet's `core-root` check), and the machine's side is `@retake/core/io`.
 */
export * from './entries/base.js';
export * from './entries/model.js';
export * from './entries/ids.js';
export * from './entries/language.js';
export * from './entries/environment.js';
export * from './entries/policy.js';
export * from './entries/hooks.js';
export * from './entries/project.js';
export * from './entries/sandbox.js';
export * from './entries/scenario.js';
export * from './entries/comments.js';
export * from './entries/run.js';
export * from './entries/render.js';
export * from './entries/theme.js';
export * from './entries/schema.js';
