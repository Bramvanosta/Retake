/**
 * @retake/engine/contract — the operation contract the shells share (no protocol, no SDK): an operation's definition
 * (`ToolDef`: one zod input schema, annotations and a handler over the engine; operations/define.ts), one SDK-free call
 * (`invoke`: served by the shell, the zod parse with problems named per argument, the caller rules, then the handler;
 * every failure an EngineError; operations/invoke.ts), the engine's operations (`OPERATIONS`, L7.13), the cap on text under
 * `untrusted` keys (`capUntrusted`), the Studio's pinned arguments (`pinArguments`), and the operation catalogue
 * re-exported (catalogue.ts: every operation once, its facets and the shells that serve it; @retake/engine/catalogue is
 * the same without the rest, for a page). The MCP server serves these definitions as MCP tools; the Studio's server
 * serves them as `POST /v1/call/<op>`. Not browser-safe: errors.js reaches @retake/core.
 */
import { z } from 'zod';
import type { ArgumentPin } from './catalogue.js';
import type { ToolData, ToolDef } from './operations/define.js';

// The operation catalogue, also its own browser-safe entry (@retake/engine/catalogue).
export {
  ADMISSION_RULES,
  CATALOGUE,
  CODE_RUNS,
  EFFECTS,
  SHELLS,
  annotationProblem,
  catalogueOperation,
  cliCommandsOf,
  facetProblem,
  hintsOf,
  servedBy,
  servedNames,
  studioPins,
  studioStatus,
} from './catalogue.js';
export type { AdmissionRule, ArgumentPin, CodeRun, Effect, Facets, FacetHints, NotServed, Operation, OperationName, Shell, StudioOpName, StudioPinsOf, StudioServe } from './catalogue.js';

// An operation's definition and one call of it (operations/: define.ts, invoke.ts), and the engine's operations
// (operations/index.ts), with the pieces the shells' own operations still share with them (schema pieces, annotations,
// waits, compacts, words, job lines, the run and sign-in summaries: L7.13).
export { argumentProblems, defineOperation, defineTool } from './operations/define.js';
export type { OperationDef, Progress, ToolAnnotations, ToolArgs, ToolCallOutcome, ToolContext, ToolData, ToolDef, ToolImage, ToolOutput, ToolsByName } from './operations/define.js';
export { callTool, invoke } from './operations/invoke.js';
export type { InvokeOptions } from './operations/invoke.js';
export { OPERATIONS, OPERATIONS_BY_NAME } from './operations/index.js';
export type { OperationsByName } from './operations/index.js';
export { CANCEL, READ, SIGN_IN, WRITE_FILES } from './operations/annotations.js';
export { componentId, editOverrides, envName, ifMatch, projectSlug, renderId, runId, scenarioName, templateName } from './operations/schema.js';
export { JOB_WAIT_MAX_S, WAIT_HEARTBEAT_MS, WAIT_MAX_S, waitJob, waitS } from './operations/wait.js';
export { COMPACT_FINDINGS_MAX, COMPACT_MESSAGE_MAX, COMPACT_WARNINGS_MAX, compactRunStatus, cutMessage, detail } from './operations/compact.js';
export type { Detail } from './operations/compact.js';
export { issueLine, plural } from './operations/words.js';
export { jobData, jobErrorLine, jobLine, previewImages, untrustedError } from './operations/job-lines.js';
export type { JobData } from './operations/job-lines.js';
export { runOutput, runStatusSummary } from './operations/runs.js';
export { environmentJobSummary, jobOutput } from './operations/auth.js';

/** Longest untrusted string a result carries. */
export const UNTRUSTED_MAX = 2000;

export function truncate(s: string, max = UNTRUSTED_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
}

/** Every string under `untrusted` keys, truncated (at any depth). */
export function capUntrusted<T>(value: T, inside = false): T {
  if (typeof value === 'string') return (inside ? truncate(value) : value) as T;
  if (Array.isArray(value)) return value.map((v) => capUntrusted(v, inside)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capUntrusted(v, inside || k === 'untrusted')])) as T;
  }
  return value;
}

/** The schema of one pinned argument: its one value, optional or its default when absent. */
export type PinSchema<P extends ArgumentPin> = P['absent'] extends 'default' ? z.ZodDefault<z.ZodLiteral<P['value']>> : z.ZodOptional<z.ZodLiteral<P['value']>>;
/** An object input with these arguments pinned (the others its own). */
export type PinnedInput<S extends z.ZodType, P extends readonly ArgumentPin[]> = P extends readonly []
  ? S
  : S extends z.ZodObject<infer Sh, infer C>
    ? z.ZodObject<Omit<Sh, P[number]['arg']> & { [A in P[number] as A['arg']]: PinSchema<A> }, C>
    : never;
/** An operation with these arguments pinned (pinArguments): its input narrowed, its data and name its own. */
export type PinnedTool<T extends ToolDef, P extends readonly ArgumentPin[]> = P extends readonly [] ? T : ToolDef<PinnedInput<T['input'], P>, ToolData<T>, T['name']>;

/**
 * An operation with some of its arguments pinned (the catalogue's `studio.pins`): each pinned argument accepts its one
 * value only — absent or that value (`optional`), or that value when absent (`default`) — with its own description;
 * the other arguments are the operation's own. The input must be an object schema.
 */
export function pinArguments<T extends ToolDef<z.ZodObject>, const P extends readonly ArgumentPin[]>(t: T, pins: P): PinnedTool<T, P> {
  const shape: Record<string, z.ZodType> = {};
  for (const p of pins) {
    const value = z.literal(p.value);
    shape[p.arg] = (p.absent === 'default' ? value.default(p.value as never) : value.optional()).describe(p.description);
  }
  return { ...t, input: t.input.extend(shape) } as unknown as PinnedTool<T, P>;
}
