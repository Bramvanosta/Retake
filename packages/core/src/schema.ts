/**
 * Zod schemas of every file format (scenario, project, template, timeline, run record) and their
 * JSON Schemas. Objects are strict: unknown keys are errors (typo protection).
 * For precise, positioned messages use parseScenario / parseProjectYaml rather than `safeParse`.
 */
export { SLUG_RE, KEY_RE, COMPONENT_ID_RE, FRAME_STYLES, componentIdSchema } from './schemas/primitives.js';
export {
  PointSchema,
  BBoxSchema,
  TargetObjectSchema,
  TargetSpecSchema,
  ScopeSpecSchema,
  CaptionSpecSchema,
  EaseSpecSchema,
  CameraHintSchema,
  FrameStyleSchema,
  FrameSpecSchema,
  TransitionSchema,
  ComponentKindSchema,
  ComponentRefSchema,
  SlotsSchema,
} from './schemas/primitives.js';
export {
  StepSchema,
  OverlaySpecSchema,
  OVERLAY_MAX_SECONDS,
  ACTION_ARG_SCHEMAS,
  ACTION_DESCRIPTIONS,
  STEP_COMMON_KEYS,
} from './schemas/steps.js';
export { HookStepSchema, HOOK_KINDS, HOOK_COMMON_KEYS } from './schemas/hooks.js';
export {
  SceneSchema,
  SceneCursorSchema,
  InterstitialSchema,
  CardSchema,
  SceneEntrySchema,
  ScenarioSchema,
} from './schemas/scenario.js';
export {
  CaptureSettingsSchema,
  CapturePartialSchema,
  PacingSchema,
  PacingPartialSchema,
  AuthConfigSchema,
  BrowserConfigSchema,
} from './schemas/settings.js';
export { ProjectFileSchema, ProjectConfigSchema, WorkspaceFileSchema } from './schemas/project.js';
export { TemplateSchema, TemplateFileSchema } from './schemas/template.js';
export { TimelineSchema, RunRecordSchema } from './schemas/timeline.js';
export {
  scenarioJsonSchema,
  projectJsonSchema,
  templateJsonSchema,
  timelineJsonSchema,
  writeJsonSchemas,
  JSON_SCHEMAS,
} from './schemas/json.js';
export type { JsonSchema, JsonSchemaName } from './schemas/json.js';
