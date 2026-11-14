/**
 * @retake/core/model — the shared contracts every context names: the data model of types.ts (the scenario, project,
 * template, timeline and run types; not split by context yet), the primitive schemas, user media, the ports to the
 * machine (FileFacts, VideoProber), the render settings, the confinement of agent work, and the checks' shared context.
 * A type-only import of this context is free for every other (scripts/audit/lib.mjs CORE_CONTEXTS).
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base); the ratchet's
 * `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of the file
 * that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages' sources import
 * an entry: the `core-root` check).
 */
export * from '../types.js';
export * from '../media.js';
export * from '../file-facts.js';
export * from '../render-settings.js';
export * from '../confinement.js';
export {
  BBoxSchema,
  COMPONENT_ID_RE,
  CameraHintSchema,
  CaptionSpecSchema,
  ComponentKindSchema,
  ComponentRefSchema,
  EaseSpecSchema,
  FRAME_STYLES,
  FrameSpecSchema,
  FrameStyleSchema,
  KEY_RE,
  MULTI_PAGE_FRAMES,
  PointSchema,
  SLUG_RE,
  ScopeSpecSchema,
  SlotsSchema,
  TargetObjectSchema,
  TargetSpecSchema,
  TransitionSchema,
  TutorialSwitchSchema,
  componentIdSchema,
  keyString,
} from '../schemas/primitives.js';
