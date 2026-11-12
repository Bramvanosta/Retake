/**
 * A tool of the server is an operation of the contract (@retake/engine/contract): its definition lives there, and
 * `defineTool` keeps its input, answer and name types (a tool table is typed by them: tool-set.ts TOOLS).
 */
export type { ToolContext, ToolDef } from '@retake/engine/contract';
export { defineTool } from '@retake/engine/contract';

/**
 * The annotations of the engine's operations (L7.13: READ, WRITE_FILES, CANCEL, SIGN_IN; L7.17: THEME_WRITE,
 * PREVIEW_JOB, SITE_JOB; L7.15: RUN_JOB, JOB_CANCEL, RENDER_JOB; L7.19: HOOK_JOB, SANDBOX_JOB), shared by the tools here.
 */
export { CANCEL, PREVIEW_JOB, READ, SIGN_IN, SITE_JOB, THEME_WRITE, WRITE_FILES } from '@retake/engine/contract';
export { JOB_CANCEL, RENDER_JOB, RUN_JOB } from '@retake/engine/contract';
export { HOOK_JOB, SANDBOX_JOB } from '@retake/engine/contract';
