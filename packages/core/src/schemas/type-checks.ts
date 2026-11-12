/**
 * Compile-time guarantees that the schemas match the shared types of types.ts:
 * whatever a schema accepts can be used as the corresponding type, and (where the type is not
 * looser than the language on purpose) every value of the type is accepted by the schema.
 */
import type { z } from 'zod';
import type { CameraHint, HookStep, ProjectConfig, SandboxManifest, Scenario, Step, TargetObject, Template, Timeline } from '../types.js';
import type { HookStepSchema } from './hooks.js';
import type { CameraHintSchema, TargetObjectSchema } from './primitives.js';
import type { ProjectConfigSchema } from './project.js';
import type { SandboxFileSchema } from './sandbox.js';
import type { ScenarioSchema } from './scenario.js';
import type { StepSchema } from './steps.js';
import type { TemplateSchema } from './template.js';
import type { FailedRun, RunBase, RunRecord, StoredRunEngine, StoredRunPerf, StoredRunRecord, SucceededRun, UnknownStatusRun } from '../run-record.js';
import type { RunError, RunStatus } from '../types.js';
import type { FinishedRender, RenderAttempt, RenderBase, StoredPlan, StoredRenderBase, StoredRenderRecord, UnknownStatusRender } from '../render-record.js';
import type { RenderAttemptSchema, RenderRecordSchema, StoredRenderRecordSchema, UnknownStatusRenderSchema } from './render.js';
import type { RunRecordSchema, StoredRunEngineSchema, StoredRunPerfSchema, StoredRunRecordSchema, TimelineSchema, UnknownStatusRunSchema } from './timeline.js';

type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
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
type _O10 = Assert<Extends<z.output<typeof SandboxFileSchema>, SandboxManifest>>;
// shared type → schema input (Step / Scenario are looser on purpose: "exactly one action" is a runtime rule)
type _I1 = Assert<Extends<HookStep, z.input<typeof HookStepSchema>>>;
type _I2 = Assert<Extends<ProjectConfig, z.input<typeof ProjectConfigSchema>>>;
type _I3 = Assert<Extends<Template, z.input<typeof TemplateSchema>>>;
type _I4 = Assert<Extends<Timeline, z.input<typeof TimelineSchema>>>;
type _I5 = Assert<Extends<RunRecord, z.input<typeof RunRecordSchema>>>;
type _I6 = Assert<Extends<TargetObject, z.input<typeof TargetObjectSchema>>>;
type _I7 = Assert<Extends<SandboxManifest, z.input<typeof SandboxFileSchema>>>;

// ── The run record: a union of states (run-record.ts) ────────────────────────
// `Extends` both ways, never an equality: `{a}` and `{a; b?: never}` are assignable to each other and not identical.

// What this version writes: `_O7` and `_I5` above (the schema's output is a state; every state is accepted by it).
// What any version left on a disk: the stored schemas' outputs are the stored types.
type _R2 = Assert<Extends<z.output<typeof StoredRunRecordSchema>, StoredRunRecord>>;
// (the schema takes any text for the status; the reader alone says which text is none of the five: UnknownRunStatus)
type _R3 = Assert<Extends<z.output<typeof UnknownStatusRunSchema>, Omit<UnknownStatusRun, 'status'> & { status: string }>>;
type _R4 = Assert<Extends<z.output<typeof StoredRunEngineSchema>, StoredRunEngine>>;
type _R5 = Assert<Extends<z.output<typeof StoredRunPerfSchema>, StoredRunPerf>>;
// A written record is a stored one, not the reverse (a stored record's `engine.retake` may be absent).
type _R6 = Assert<Extends<RunRecord, StoredRunRecord>>;
type _R7 = Assert<Not<Extends<StoredRunRecord, RunRecord>>>;

// The states no writer may build.
type _Finished = { finished_at: string };
type _N1 = Assert<Not<Extends<RunBase & { status: 'succeeded' } & _Finished & { error: RunError }, RunRecord>>>;
type _N2 = Assert<Not<Extends<RunBase & { status: 'succeeded' } & _Finished & { current: { scene: string; step: number; action: string } }, RunRecord>>>;
type _N3 = Assert<Not<Extends<Omit<SucceededRun, 'finished_at'>, RunRecord>>>;
type _N4 = Assert<Not<Extends<Omit<FailedRun, 'finished_at'>, RunRecord>>>;
type _N5 = Assert<Not<Extends<Omit<FailedRun, 'error'>, RunRecord>>>;
type _N6 = Assert<Not<Extends<RunBase & { status: 'queued' } & _Finished, RunRecord>>>;
type _N7 = Assert<Not<Extends<RunBase & { status: 'queued'; current: { scene: string; step: number; action: string } }, RunRecord>>>;
type _N8 = Assert<Not<Extends<RunBase & { status: 'queued'; capture: string }, RunRecord>>>;
type _N9 = Assert<Not<Extends<RunBase & { status: 'running' } & _Finished, RunRecord>>>;
type _N10 = Assert<Not<Extends<RunBase & { status: 'queued'; error: RunError }, RunRecord>>>;
type _N11 = Assert<Not<Extends<RunBase & { status: 'running'; error: RunError }, RunRecord>>>;
// A run closed from outside IS a state: failed or cancelled, with the step it was at, its pause and what it had filmed
// (this fails if the union is tightened past what lies on disks).
type _ClosedFromOutside = RunBase & {
  status: 'failed' | 'cancelled';
  finished_at: string;
  error: RunError;
  current: { scene: string; step: number; action: string };
  paused: { scene: string; step: number; since: string };
  capture: string;
  timeline: string;
};
type _M1 = Assert<Extends<_ClosedFromOutside, RunRecord>>;
// The flat shape itself is not a state (this fails if the union is folded back into optional members).
type _M2 = Assert<Not<Extends<RunBase & { status: RunStatus; finished_at?: string; error?: RunError }, RunRecord>>>;

// The members that decide a state cannot be assigned, on a state or on the union: a status changes through the
// transitions only (each fails if `readonly` is dropped from a state, or from the members a state never has).
type _Same<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type _Decides = 'status' | 'finished_at' | 'error';
/** True when no state of `T` lets one of the three be assigned. */
type _Sealed<T> = (T extends unknown ? _Same<Pick<T, _Decides & keyof T>, Readonly<Pick<T, _Decides & keyof T>>> : never) extends true ? true : false;
type _W1 = Assert<_Sealed<RunRecord>>;
type _W2 = Assert<_Sealed<StoredRunRecord>>;
type _W3 = Assert<_Sealed<UnknownStatusRun>>;
type _W4 = Assert<Not<_Sealed<{ status: 'queued'; finished_at?: string }>>>;
// A status Retake never writes is no literal (none of the five is one), and no plain text is one either: only the
// reader makes it.
type _U1 = Assert<Not<Extends<'succeeded', UnknownStatusRun['status']>>>;
type _U2 = Assert<Not<Extends<string, UnknownStatusRun['status']>>>;

/** Referencing every assertion keeps them alive under noUnusedLocals. */
export type SchemaTypeChecks = [_O1, _O2, _O3, _O4, _O5, _O6, _O7, _O8, _O9, _O10, _I1, _I2, _I3, _I4, _I5, _I6, _I7];
/** The same for the run record's. */
export type RunRecordTypeChecks = [_W1, _W2, _W3, _W4, _U1, _U2, _R2, _R3, _R4, _R5, _R6, _R7, _N1, _N2, _N3, _N4, _N5, _N6, _N7, _N8, _N9, _N10, _N11, _M1, _M2];

// ── The render record: a union of states (render-record.ts) ──────────────────

type _Plan = StoredPlan;
type _Over = Readonly<Record<string, unknown>>;
type _Written = FinishedRender<_Plan, _Over>;
type _Tried = RenderAttempt<_Plan, _Over>;
type _Base = RenderBase<_Plan, _Over>;
// The schemas' outputs are the types (what this version writes; what it carries on an error; what a disk holds).
type _RR1 = Assert<Extends<z.output<typeof RenderRecordSchema>, _Written>>;
type _RR2 = Assert<Extends<z.output<typeof RenderAttemptSchema>, _Tried>>;
type _RR3 = Assert<Extends<z.output<typeof StoredRenderRecordSchema>, StoredRenderRecord>>;
// (the schema takes any text for the status; the reader alone says which text is none of the three)
type _RR4 = Assert<Extends<z.output<typeof UnknownStatusRenderSchema>, Omit<UnknownStatusRender, 'status'> & { status: string }>>;
// A written record is a stored one, not the reverse (a stored record may lack its plan and its variant).
type _RR5 = Assert<Extends<_Written, StoredRenderRecord>>;
type _RR6 = Assert<Extends<_Tried, StoredRenderRecord>>;
type _RR7 = Assert<Not<Extends<StoredRenderRecord, _Written | _Tried>>>;
// The states no writer may build.
type _RN1 = Assert<Not<Extends<_Base & { status: 'succeeded'; error: string }, _Written | _Tried>>>;
// (without `probe`, which an attempt never has: so that it is the missing error that is refused, nothing else)
type _NoProbe = Omit<_Base, 'probe'>;
type _RN2 = Assert<Not<Extends<_NoProbe & { status: 'failed' }, _Written | _Tried>>>;
type _RN3 = Assert<Not<Extends<_NoProbe & { status: 'cancelled' }, _Written | _Tried>>>;
// … and with its error it IS one (this fails if the two asserts above pass for another reason).
type _RN6 = Assert<Extends<_NoProbe & { status: 'failed'; error: string }, _Tried>>;
type _RN4 = Assert<Not<Extends<_NoProbe & { status: 'failed'; error: string; probe: NonNullable<_Base['probe']> }, _Written | _Tried>>>;
type _RN5 = Assert<Not<Extends<StoredRenderBase & { status: 'succeeded'; error: string }, StoredRenderRecord>>>;
// The flat shape itself is not a state (this fails if the union is folded back into optional members).
type _RM1 = Assert<Not<Extends<_Base & { status: 'succeeded' | 'failed' | 'cancelled'; error?: string }, _Written | _Tried>>>;
type _RM2 = Assert<Not<Extends<StoredRenderBase & { status: 'succeeded' | 'failed' | 'cancelled'; error?: string }, StoredRenderRecord>>>;
// The two members that decide a state cannot be assigned, on a state or on the union.
type _RDecides = 'status' | 'error';
type _RSealed<T> = (T extends unknown ? _Same<Pick<T, _RDecides & keyof T>, Readonly<Pick<T, _RDecides & keyof T>>> : never) extends true ? true : false;
type _RW1 = Assert<_RSealed<_Written | _Tried>>;
type _RW2 = Assert<_RSealed<StoredRenderRecord>>;
type _RW3 = Assert<_RSealed<UnknownStatusRender>>;
type _RW4 = Assert<Not<_RSealed<{ status: 'succeeded'; error?: string }>>>;
// A status Retake never writes is no literal, and no plain text is one either: only the reader makes it.
type _RU1 = Assert<Not<Extends<'succeeded', UnknownStatusRender['status']>>>;
type _RU2 = Assert<Not<Extends<string, UnknownStatusRender['status']>>>;

/** The same for the render record's. */
export type RenderRecordTypeChecks = [_RR1, _RR2, _RR3, _RR4, _RR5, _RR6, _RR7, _RN1, _RN2, _RN3, _RN4, _RN5, _RN6, _RM1, _RM2, _RW1, _RW2, _RW3, _RW4, _RU1, _RU2];
