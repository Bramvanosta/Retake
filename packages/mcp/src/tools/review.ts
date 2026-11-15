/**
 * The MCP server's review tools: the engine's operations (review_get since L7.14, review since L7.15), served here as
 * these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const { review_get: reviewGet } = OPERATIONS_BY_NAME;
const reviewTool: Op<'review'> = OPERATIONS_BY_NAME.review;

export { reviewTool };
export const REVIEW_TOOLS: readonly [Op<'review'>, Op<'review_get'>] = [reviewTool, reviewGet] as const satisfies readonly ToolDef[];
