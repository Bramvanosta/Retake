/**
 * @retake/core/model — the shared contracts every context names: points and boxes, component kinds and references, a
 * user file's fields and its checks (types/model.ts, media.ts), the primitive schemas, the ports to the machine
 * (FileFacts, VideoProber), a path's place under a root, the render settings, the confinement of agent work, and the
 * checks' shared context. Each other context declares its own types (types/<context>.ts).
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base); the ratchet's
 * `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of the file
 * that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages' sources import
 * an entry: the `core-root` check).
 */
export * from '../types/model.js';
export * from '../media.js';
export * from '../file-facts.js';
export * from '../render-settings.js';
export * from '../confinement.js';
export { isUnder } from '../client-path.js';
export { BBoxSchema, COMPONENT_ID_RE, ComponentKindSchema, ComponentRefSchema, KEY_RE, PointSchema, SLUG_RE, SlotsSchema, componentIdSchema, keyString } from '../schemas/primitives.js';
