import type { z } from 'zod';
import type { Approver, Engine } from '@retake/engine';
import type { Progress, ToolAnnotations } from '../server.js';
import type { ToolOutput } from '../result.js';

export interface ToolContext {
  engine: Engine;
  /** Aborted when the client cancels the call: it ends a wait, never the job. */
  signal: AbortSignal;
  /** Progress notifications while a call waits (when the client asked for them). */
  progress?: (p: Progress) => void;
  /** Asks the client's user to approve hooks (form elicitation); undefined when the client cannot ask anyone. */
  approver?: Approver;
}

/** A tool of the server: one zod input schema (published as JSON Schema, and the parser), annotations and a handler. */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<S extends z.ZodType>(t: ToolDef<S>): ToolDef {
  return t as unknown as ToolDef;
}

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Writes authored files of the workspace (never deletes; overwrites need if_match). */
export const WRITE_FILES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/**
 * Writes a new theme folder (templates/<name>/); with replace: true it removes the theme of that name first — only one
 * this tool made through MCP that nobody changed since — hence destructive.
 */
export const THEME_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Starts a job that drives a browser (and hooks) against an environment of the user's product. */
export const RUN_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Asks for a job's cancel (its teardown and rollbacks still run). */
export const CANCEL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Starts a job that runs hooks against an environment (a real run may write or delete: approvals guard it). */
export const HOOK_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** Opens a browser on the user's machine for a human to sign in (or plays a persona's login steps): saves a session. */
export const SIGN_IN: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Starts or resets a local sandbox (a reset rewrites the sandbox's own data, nothing else). */
export const SANDBOX_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/**
 * Starts a render, review or export job (no product environment is touched: it works on a capture or a render already
 * made, in the worker, and writes only the project's renders/, review/ and exports/ folders).
 */
export const RENDER_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Starts a preview job: stills of a component or a theme in <workspace>/.retake/previews/ (never a component folder). */
export const PREVIEW_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/**
 * Starts a site extraction: a clean headless browser opens one public page a human approved (GET only, public addresses
 * only) and its colours, font names and logo PNGs go to <workspace>/.retake/site/ (no theme written).
 */
export const SITE_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
