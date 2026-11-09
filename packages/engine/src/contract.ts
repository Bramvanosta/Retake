/**
 * @retake/engine/contract — the operation contract the shells share (no protocol, no SDK): an operation's definition
 * (`ToolDef`: one zod input schema, annotations and a handler over the engine), one SDK-free call (`callTool`: the zod
 * parse with problems named per argument, then the handler; every failure an EngineError), the cap on text under
 * `untrusted` keys (`capUntrusted`), the Studio's pinned arguments (`pinArguments`), and the operation catalogue
 * (catalogue.ts: every operation once, with the shells that serve it). The MCP server serves these definitions as MCP
 * tools; the Studio's server serves them as `POST /v1/call/<op>`.
 */
import { z } from 'zod';
import type { Approver } from './approvals.js';
import type { ArgumentPin } from './catalogue.js';
import type { Engine } from './engine.js';
import { EngineError, toEngineError } from './errors.js';

export { CATALOGUE, OPERATION_KINDS, SHELLS, catalogueOperation, cliCommandsOf, servedBy, servedNames, studioPins, studioStatus } from './catalogue.js';
export type { ArgumentPin, NotServed, Operation, OperationKind, Shell, StudioServe } from './catalogue.js';

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

export interface ToolOutput {
  summary: string;
  data: Record<string, unknown>;
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

/** An operation: one zod input schema (published as JSON Schema, and the parser), annotations and a handler. */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/** One line per problem, naming the argument: "project: a project slug…". */
export function argumentProblems(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const where = i.path.length ? i.path.map(String).join('.') : '(arguments)';
    const keys = (i as { keys?: string[] }).keys;
    return i.code === 'unrecognized_keys' && keys ? `${where}: unknown argument${keys.length > 1 ? 's' : ''} ${keys.join(', ')}` : `${where}: ${i.message}`;
  });
}

/** What a call gave: its output, or the error (invalid arguments included) as an EngineError. */
export type ToolCallOutcome = { ok: true; output: ToolOutput } | { ok: false; error: EngineError };

/**
 * One call, SDK-free (L4.1): the zod parse (problems named per argument), then the handler with the engine; never
 * throws — every failure comes back as an EngineError. The MCP protocol layer and the Studio's HTTP API
 * (`POST /v1/call/<op>` of `retake ui`) both run operations through this, so validation, trust and errors stay one.
 */
export async function callTool(t: ToolDef, engine: () => Promise<Engine>, args: unknown, ctx: Omit<ToolContext, 'engine'>): Promise<ToolCallOutcome> {
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

/**
 * An operation with some of its arguments pinned (the catalogue's `studio.pins`): each pinned argument accepts its one
 * value only — absent or that value (`optional`), or that value when absent (`default`) — with its own description;
 * the other arguments are the operation's own. The input must be an object schema.
 */
export function pinArguments(t: ToolDef, pins: readonly ArgumentPin[]): ToolDef {
  const shape: Record<string, z.ZodType> = {};
  for (const p of pins) {
    const value = z.literal(p.value);
    shape[p.arg] = (p.absent === 'default' ? value.default(p.value as never) : value.optional()).describe(p.description);
  }
  return { ...t, input: (t.input as z.ZodObject).extend(shape) };
}
