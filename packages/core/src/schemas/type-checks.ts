/**
 * Compile-time guarantees that the schemas match the shared types of types.ts:
 * whatever a schema accepts can be used as the corresponding type, and (where the type is not
 * looser than the language on purpose) every value of the type is accepted by the schema.
 */
import type { z } from 'zod';
import type {
  CameraHint,
  HookStep,
  ProjectConfig,
  RunRecord,
  Scenario,
  Step,
  TargetObject,
  Template,
  Timeline,
} from '../types.js';
import type { HookStepSchema } from './hooks.js';
import type { CameraHintSchema, TargetObjectSchema } from './primitives.js';
import type { ProjectConfigSchema } from './project.js';
import type { ScenarioSchema } from './scenario.js';
import type { StepSchema } from './steps.js';
import type { TemplateSchema } from './template.js';
import type { RunRecordSchema, TimelineSchema } from './timeline.js';

type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

// schema output → shared type
type _O1 = Assert<Extends<z.output<typeof ScenarioSchema>, Scenario>>;
type _O2 = Assert<Extends<z.output<typeof StepSchema>, Step>>;
type _O3 = Assert<Extends<z.output<typeof HookStepSchema>, HookStep>>;
type _O4 = Assert<Extends<z.output<typeof ProjectConfigSchema>, ProjectConfig>>;
type _O5 = Assert<Extends<z.output<typeof TemplateSchema>, Template>>;
type _O6 = Assert<Extends<z.output<typeof TimelineSchema>, Timeline>>;
type _O7 = Assert<Extends<z.output<typeof RunRecordSchema>, RunRecord>>;
type _O8 = Assert<Extends<z.output<typeof TargetObjectSchema>, TargetObject>>;
type _O9 = Assert<Extends<z.output<typeof CameraHintSchema>, CameraHint>>;
// shared type → schema input (Step / Scenario are looser on purpose: "exactly one action" is a runtime rule)
type _I1 = Assert<Extends<HookStep, z.input<typeof HookStepSchema>>>;
type _I2 = Assert<Extends<ProjectConfig, z.input<typeof ProjectConfigSchema>>>;
type _I3 = Assert<Extends<Template, z.input<typeof TemplateSchema>>>;
type _I4 = Assert<Extends<Timeline, z.input<typeof TimelineSchema>>>;
type _I5 = Assert<Extends<RunRecord, z.input<typeof RunRecordSchema>>>;
type _I6 = Assert<Extends<TargetObject, z.input<typeof TargetObjectSchema>>>;

/** Referencing every assertion keeps them alive under noUnusedLocals. */
export type SchemaTypeChecks = [_O1, _O2, _O3, _O4, _O5, _O6, _O7, _O8, _O9, _I1, _I2, _I3, _I4, _I5, _I6];
