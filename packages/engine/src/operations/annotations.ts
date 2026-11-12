/**
 * The annotations of the engine's operations (moved from the MCP server's tools/define.ts in L7.13, with the
 * operations that use them): the hints a client reads, held to each operation's catalogue facets (annotationProblem).
 */
import type { ToolAnnotations } from './define.js';

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Writes authored files of the workspace (never deletes; overwrites need if_match). */
export const WRITE_FILES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Asks for a job's cancel (its teardown and rollbacks still run). */
export const CANCEL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Opens a browser on the user's machine for a human to sign in (or plays a persona's login steps): saves a session. */
export const SIGN_IN: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
