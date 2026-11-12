import { CANCEL } from '@retake/engine/contract';
import type { ToolAnnotations } from '@retake/engine/contract';

/**
 * A tool of the server is an operation of the contract (@retake/engine/contract): its definition lives there, and
 * `defineTool` keeps its input, answer and name types (a tool table is typed by them: tool-set.ts TOOLS).
 */
export type { ToolContext, ToolDef } from '@retake/engine/contract';
export { defineTool } from '@retake/engine/contract';

/** The annotations of the engine's operations (L7.13: READ, WRITE_FILES, CANCEL, SIGN_IN), shared by the tools here. */
export { CANCEL, READ, SIGN_IN, WRITE_FILES } from '@retake/engine/contract';
/**
 * Writes a new theme folder (templates/<name>/); with replace: true it removes the theme of that name first — only one
 * this tool made through MCP that nobody changed since — hence destructive.
 */
export const THEME_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Starts a job that drives a browser (and hooks) against an environment of the user's product. */
export const RUN_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** A job's cancel, which discards a recording whose window is open (the catalogue: job_cancel is destructive). */
export const JOB_CANCEL: ToolAnnotations = { ...CANCEL, destructiveHint: true };
/** Starts a job that runs hooks against an environment (a real run may write or delete: approvals guard it). */
export const HOOK_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
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
