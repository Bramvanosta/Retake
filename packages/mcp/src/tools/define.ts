/**
 * A tool of the server is an operation of the contract (@retake/engine/contract): its definition lives there, and
 * `defineTool` keeps its input, answer and name types (a tool table is typed by them: tool-set.ts TOOLS).
 */
export type { ToolContext, ToolDef } from '@retake/engine/contract';
import type { OPERATIONS_BY_NAME } from '@retake/engine/contract';

/** An engine operation as the contract types it: a tool table's explicit type (its declarations stay portable). */
export type Op<N extends keyof typeof OPERATIONS_BY_NAME> = (typeof OPERATIONS_BY_NAME)[N];
export { defineTool } from '@retake/engine/contract';

/**
 * The annotations of the engine's operations (READ, WRITE_FILES, CANCEL, SIGN_IN, THEME_WRITE,
 * PREVIEW_JOB, SITE_JOB, RUN_JOB, JOB_CANCEL, RENDER_JOB, HOOK_JOB, SANDBOX_JOB), shared by the tools here.
 */
export { CANCEL, PREVIEW_JOB, READ, SIGN_IN, SITE_JOB, THEME_WRITE, WRITE_FILES } from '@retake/engine/contract';
export { JOB_CANCEL, RENDER_JOB, RUN_JOB } from '@retake/engine/contract';
export { HOOK_JOB, SANDBOX_JOB } from '@retake/engine/contract';
