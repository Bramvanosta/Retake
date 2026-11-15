import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

/** The sign-in and sandbox tools: the engine's operations (operations/auth.ts and operations/sandbox.ts). */
const { auth_status: authStatus, auth_login: authLogin, sandbox_status: sandboxStatus, sandbox_up: sandboxUp, sandbox_reset: sandboxReset, sandbox_init: sandboxInit } = OPERATIONS_BY_NAME;

export const ENVIRONMENT_TOOLS: readonly [Op<'auth_status'>, Op<'auth_login'>, Op<'sandbox_status'>, Op<'sandbox_up'>, Op<'sandbox_reset'>, Op<'sandbox_init'>] = [
  authStatus,
  authLogin,
  sandboxStatus,
  sandboxUp,
  sandboxReset,
  sandboxInit,
] as const satisfies readonly ToolDef[];
