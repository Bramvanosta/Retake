import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

/** The hooks tools: the engine's operations (operations/hooks.ts), served as they are. */
const { hooks_run: hooksRun, env_reset: envReset } = OPERATIONS_BY_NAME;

export const HOOK_TOOLS: readonly [Op<'hooks_run'>, Op<'env_reset'>] = [hooksRun, envReset] as const satisfies readonly ToolDef[];
