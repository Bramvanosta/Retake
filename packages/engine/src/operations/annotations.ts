/**
 * The annotations of the engine's operations (moved from the MCP server's tools/define.ts in L7.13, L7.17 and L7.15, with
 * the operations that use them): the hints a client reads, held to each operation's catalogue facets (annotationProblem).
 */
import type { ToolAnnotations } from './define.js';

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Writes authored files of the workspace (never deletes; overwrites need if_match). */
export const WRITE_FILES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Asks for a job's cancel (its teardown and rollbacks still run). */
export const CANCEL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Opens a browser on the user's machine for a human to sign in (or plays a persona's login steps): saves a session. */
export const SIGN_IN: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/**
 * Writes a new theme folder (templates/<name>/); with replace: true it removes the theme of that name first — only one
 * this tool made through MCP that nobody changed since — hence destructive.
 */
export const THEME_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Starts a preview job: stills of a component or a theme in <workspace>/.retake/previews/ (never a component folder). */
export const PREVIEW_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/**
 * Starts a site extraction: a clean headless browser opens one public page a human approved (GET only, public addresses
 * only) and its colours, font names and logo PNGs go to <workspace>/.retake/site/ (no theme written).
 */
export const SITE_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Starts a job that drives a browser (and hooks) against an environment of the user's product. */
export const RUN_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** A job's cancel, which discards a recording whose window is open (the catalogue: job_cancel is destructive). */
export const JOB_CANCEL: ToolAnnotations = { ...CANCEL, destructiveHint: true };
/**
 * Starts a render, review or export job (no product environment is touched: it works on a capture or a render already
 * made, in the worker, and writes only the project's renders/, review/ and exports/ folders).
 */
export const RENDER_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
