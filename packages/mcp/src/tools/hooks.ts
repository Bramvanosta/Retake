import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

/** The hooks tools: the engine's operations (L7.19: operations/hooks.ts), served as they are. */
const { hooks_run: hooksRun, env_reset: envReset } = OPERATIONS_BY_NAME;

export const HOOK_TOOLS = [hooksRun, envReset] as const satisfies readonly ToolDef[];
