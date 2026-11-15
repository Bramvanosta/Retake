/**
 * The MCP server's run tools: the engine's operations (run_list, run_status, run_cancel since L7.13; run_dry and
 * run_capture since L7.15), served here as these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const { run_list: runList, run_status: runStatus, run_dry: runDry, run_capture: runCapture, run_cancel: runCancel } = OPERATIONS_BY_NAME;

export const RUN_TOOLS: readonly [Op<'run_list'>, Op<'run_status'>, Op<'run_dry'>, Op<'run_capture'>, Op<'run_cancel'>] = [
  runList,
  runStatus,
  runDry,
  runCapture,
  runCancel,
] as const satisfies readonly ToolDef[];
