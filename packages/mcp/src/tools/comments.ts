/**
 * Frame comments (R-MCP-17..19, R-DEC-06): comments_list, comment_reply and comment_resolve are the
 * engine's operations (packages/engine/src/operations/comments.ts); this server serves them as these very
 * objects, in tools/list order. The caps stay named here for the server's tests.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

export { COMMENTS_LIST_UNTRUSTED_MAX, COMMENT_ENTRIES_SHOWN, PROPOSAL_ROWS_UNTRUSTED_MAX } from '@retake/engine/contract';

export const commentsList: Op<'comments_list'> = OPERATIONS_BY_NAME.comments_list;
export const commentReply: Op<'comment_reply'> = OPERATIONS_BY_NAME.comment_reply;
export const commentResolve: Op<'comment_resolve'> = OPERATIONS_BY_NAME.comment_resolve;

export const COMMENT_TOOLS: readonly [Op<'comments_list'>, Op<'comment_reply'>, Op<'comment_resolve'>] = [commentsList, commentReply, commentResolve] as const satisfies readonly ToolDef[];
