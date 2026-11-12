import type { ToolAnnotations } from '@retake/engine/contract';

/**
 * A tool of the server is an operation of the contract (@retake/engine/contract): its definition lives there, and
 * `defineTool` keeps its input, answer and name types (a tool table is typed by them: tool-set.ts TOOLS).
 */
export type { ToolContext, ToolDef } from '@retake/engine/contract';
export { defineTool } from '@retake/engine/contract';

/**
 * The annotations of the engine's operations (L7.13: READ, WRITE_FILES, CANCEL, SIGN_IN; L7.17: THEME_WRITE,
 * PREVIEW_JOB, SITE_JOB; L7.15: RUN_JOB, JOB_CANCEL, RENDER_JOB), shared by the tools here.
 */
export { CANCEL, PREVIEW_JOB, READ, SIGN_IN, SITE_JOB, THEME_WRITE, WRITE_FILES } from '@retake/engine/contract';
export { JOB_CANCEL, RENDER_JOB, RUN_JOB } from '@retake/engine/contract';
/** Starts a job that runs hooks against an environment (a real run may write or delete: approvals guard it). */
export const HOOK_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** Starts or resets a local sandbox (a reset rewrites the sandbox's own data, nothing else). */
export const SANDBOX_JOB: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
