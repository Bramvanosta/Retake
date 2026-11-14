/**
 * The MCP server's render tools: the engine's operations (plan_preview and render_status since L7.14, render since
 * L7.15), served here as these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const { plan_preview: planPreview, render, render_status: renderStatus } = OPERATIONS_BY_NAME;

export { render };
export const RENDER_TOOLS = [planPreview, render, renderStatus] as const satisfies readonly ToolDef[];
