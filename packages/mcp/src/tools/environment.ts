import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

/** The sign-in and sandbox tools: the engine's operations (L7.13: operations/auth.ts; L7.19: operations/sandbox.ts). */
const { auth_status: authStatus, auth_login: authLogin, sandbox_status: sandboxStatus, sandbox_up: sandboxUp, sandbox_reset: sandboxReset } = OPERATIONS_BY_NAME;

export const ENVIRONMENT_TOOLS = [authStatus, authLogin, sandboxStatus, sandboxUp, sandboxReset] as const satisfies readonly ToolDef[];
