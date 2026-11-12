/**
 * An operation's definition (L6.12–13, moved here from contract.ts in L7.13): one zod input schema (published as JSON
 * Schema, and the parser), annotations and a handler over the engine — `ToolDef`, typed by its input, its answer and
 * its name — and an engine operation (`OperationDef`): a `ToolDef` whose name is an operation of the catalogue, with
 * the caller rules it holds beyond "served by" (`callers`, checked by invoke after the parse). The shells serve these
 * definitions (MCP as tools, the Studio as `POST /v1/call/<op>`) through invoke.ts. @retake/engine/contract re-exports
 * this module.
 */
import type { z } from 'zod';
import type { Approver } from '../approvals.js';
import type { Caller } from '../caller.js';
import type { OperationName } from '../catalogue.js';
import type { Engine } from '../engine.js';
import type { EngineError } from '../errors.js';

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
  /**
   * The caller rules of the operation beyond "served by" (invoke checks them after the parse, before the handler):
   * an error to answer, or undefined. Its facets (effect, job, admission…) are the catalogue's, never repeated here.
   */
  callers?(caller: Caller, args: z.output<S>): EngineError | undefined;
}

/** An operation of the engine (operations/): a definition whose name is an operation of the catalogue. */
export type OperationDef<S extends z.ZodType = z.ZodType, D extends object = object, N extends OperationName = OperationName> = ToolDef<S, D, N>;

/**
 * An operation, its types inferred from its definition: the input from `input`, the data from what `run` answers (the
 * union of its answers: inferred through the whole output, so that each `return` adds its own), the name.
 */
export function defineTool<S extends z.ZodType, O extends ToolOutput, N extends string>(t: Omit<ToolDef<S, O['data'], N>, 'run'> & { run(args: z.output<S>, ctx: ToolContext): Promise<O> }): ToolDef<S, O['data'], N> {
  return t;
}

/** An engine operation (defineTool's inference), its name held to the catalogue at compile time. */
export function defineOperation<S extends z.ZodType, O extends ToolOutput, N extends OperationName>(t: Omit<OperationDef<S, O['data'], N>, 'run'> & { run(args: z.output<S>, ctx: ToolContext): Promise<O> }): OperationDef<S, O['data'], N> {
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
