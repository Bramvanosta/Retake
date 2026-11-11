/**
 * @retake/engine/contract — the operation contract the shells share (no protocol, no SDK): an operation's definition
 * (`ToolDef`: one zod input schema, annotations and a handler over the engine), one SDK-free call (`callTool`: the zod
 * parse with problems named per argument, then the handler; every failure an EngineError), the cap on text under
 * `untrusted` keys (`capUntrusted`), the Studio's pinned arguments (`pinArguments`), and the operation catalogue
 * re-exported (catalogue.ts: every operation once, its facets and the shells that serve it; @retake/engine/catalogue is
 * the same without the rest, for a page). The MCP server serves these definitions as MCP tools; the Studio's server
 * serves them as `POST /v1/call/<op>`. Not browser-safe: errors.js reaches @retake/core.
 */
import { z } from 'zod';
import type { Approver } from './approvals.js';
import type { ArgumentPin } from './catalogue.js';
import type { Engine } from './engine.js';
import { EngineError, toEngineError } from './errors.js';

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

/** The hints a client reads about an operation (the MCP tool annotations). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Progress of a call that waits (MCP progress notifications). */
export interface Progress {
  progress: number;
  total?: number;
  message?: string;
}

/** An image a result shows (a contact sheet, a key frame): a label and its file. */
export interface ToolImage {
  label: string;
  file: string;
}

/** What an operation answers: a summary line or more, and its data (`D`: the JSON object a client reads). */
export interface ToolOutput<D extends object = object> {
  summary: string;
  data: D;
  /**
   * Images to show the client, in order: the first ones go inline as JPEG thumbnails (after the text, each preceded by
   * its label), within the caps; the others are listed as files to read. Never base64 in `data`.
   */
  images?: ToolImage[];
}

export interface ToolContext {
  engine: Engine;
  /** Aborted when the client cancels the call: it ends a wait, never the job. */
  signal: AbortSignal;
  /** Progress notifications while a call waits (when the client asked for them). */
  progress?: (p: Progress) => void;
  /** Asks the client's user to approve hooks (form elicitation); undefined when the client cannot ask anyone. */
  approver?: Approver;
}

/**
 * An operation: one zod input schema (published as JSON Schema, and the parser), annotations and a handler. Its types
 * are kept (L6.12–L6.13 fixes): `S` the input, `D` the data it answers, `N` its name — so a table of operations says
 * each one's arguments and answer (`ToolArgs`, `ToolData`, `ToolsByName`). `ToolDef` alone is any operation.
 */
export interface ToolDef<S extends z.ZodType = z.ZodType, D extends object = object, N extends string = string> {
  name: N;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutput<D>>;
}

/**
 * An operation, its types inferred from its definition: the input from `input`, the data from what `run` answers (the
 * union of its answers: inferred through the whole output, so that each `return` adds its own), the name.
 */
export function defineTool<S extends z.ZodType, O extends ToolOutput, N extends string>(t: Omit<ToolDef<S, O['data'], N>, 'run'> & { run(args: z.output<S>, ctx: ToolContext): Promise<O> }): ToolDef<S, O['data'], N> {
  return t;
}

/** The arguments an operation takes, as a client sends them (its input schema's input type). */
export type ToolArgs<T extends ToolDef> = z.input<T['input']>;
/** The data an operation answers. */
export type ToolData<T extends ToolDef> = Awaited<ReturnType<T['run']>>['data'];
/** A table of operations by name. */
export type ToolsByName<T extends ToolDef> = { [E in T as E['name']]: E };

/** One line per problem, naming the argument: "project: a project slug…". */
export function argumentProblems(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const where = i.path.length ? i.path.map(String).join('.') : '(arguments)';
    const keys = (i as { keys?: string[] }).keys;
    return i.code === 'unrecognized_keys' && keys ? `${where}: unknown argument${keys.length > 1 ? 's' : ''} ${keys.join(', ')}` : `${where}: ${i.message}`;
  });
}

/** What a call gave: its output, or the error (invalid arguments included) as an EngineError. */
export type ToolCallOutcome<D extends object = object> = { ok: true; output: ToolOutput<D> } | { ok: false; error: EngineError };

/**
 * One call, SDK-free: the zod parse (problems named per argument), then the handler with the engine; never
 * throws — every failure comes back as an EngineError. The MCP protocol layer and the Studio's HTTP API
 * (`POST /v1/call/<op>` of `retake ui`) both run operations through this, so validation, trust and errors stay one.
 */
export async function callTool<D extends object>(t: ToolDef<z.ZodType, D>, engine: () => Promise<Engine>, args: unknown, ctx: Omit<ToolContext, 'engine'>): Promise<ToolCallOutcome<D>> {
  const parsed = t.input.safeParse(args);
  if (!parsed.success) {
    const problems = argumentProblems(parsed.error);
    return { ok: false, error: new EngineError('invalid', `invalid arguments for ${t.name}:\n${problems.join('\n')}`, { details: { arguments: problems } }) };
  }
  try {
    return { ok: true, output: await t.run(parsed.data, { ...ctx, engine: await engine() }) };
  } catch (e) {
    return { ok: false, error: toEngineError(e) };
  }
}

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
