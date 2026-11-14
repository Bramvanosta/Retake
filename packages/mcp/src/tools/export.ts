/** The MCP server's export tool: the engine's operation (L7.15), served here as that very object. */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const { export: exportTool } = OPERATIONS_BY_NAME;

export { exportTool };
export const EXPORT_TOOLS = [exportTool] as const satisfies readonly ToolDef[];
