/** The MCP server's export tool: the engine's operation (L7.15), served here as that very object. */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const exportTool: Op<'export'> = OPERATIONS_BY_NAME.export;

export { exportTool };
export const EXPORT_TOOLS: readonly [Op<'export'>] = [exportTool] as const satisfies readonly ToolDef[];
