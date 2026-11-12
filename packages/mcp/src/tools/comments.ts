/**
 * Frame comments (L3.6, R-MCP-17..19, R-DEC-06; L4.6): comments_list, comment_reply and comment_resolve are the
 * engine's operations since L7.16 (packages/engine/src/operations/comments.ts); this server serves them as these very
 * objects, in tools/list order. The caps stay named here for the server's tests.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

export { COMMENTS_LIST_UNTRUSTED_MAX, COMMENT_ENTRIES_SHOWN, PROPOSAL_ROWS_UNTRUSTED_MAX } from '@retake/engine/contract';

export const commentsList = OPERATIONS_BY_NAME.comments_list;
export const commentReply = OPERATIONS_BY_NAME.comment_reply;
export const commentResolve = OPERATIONS_BY_NAME.comment_resolve;

export const COMMENT_TOOLS = [commentsList, commentReply, commentResolve] as const satisfies readonly ToolDef[];
