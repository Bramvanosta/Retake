/**
 * The MCP server's render tools: the engine's operations (plan_preview and render_status since L7.14, render since
 * L7.15), served here as these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const { plan_preview: planPreview, render_status: renderStatus } = OPERATIONS_BY_NAME;
const render: Op<'render'> = OPERATIONS_BY_NAME.render;

export { render };
export const RENDER_TOOLS: readonly [Op<'plan_preview'>, Op<'render'>, Op<'render_status'>] = [planPreview, render, renderStatus] as const satisfies readonly ToolDef[];
