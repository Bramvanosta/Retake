/**
 * The Studio's comment ops (L4.6 part C, R-UI-27 / R-UI-28 / R-UI-29): threads_list, threads_counts, thread_get,
 * thread_still, render_outline, render_frame, frame_anchor, thread_add, thread_reply, thread_resolve, thread_reopen and
 * thread_apply are the engine's operations since L7.16 (packages/engine/src/operations/comment-screen.ts: their inputs,
 * caller rules, chain keys and path-free answers); the server serves them as these very objects (uiTools). Named here
 * for the app (the answer types), the server's other ops (pathFree, COMMENT_OPS) and the tests (the mappers and caps).
 */

/** A text of the tool (a warning, a problem) without any absolute path: the engine's (L7.17), named here for the Studio's ops. */
export { pathFree } from '@retake/engine';
export { THREADS_LIST_MAX, THREAD_ENTRIES_SHOWN, THREAD_ITEM_TEXT_MAX, proposalOffer, threadAnswer, threadItem } from '@retake/engine/contract';
export type { OfferFacts, ProposalAnswer, ProposalOffer, ThreadAnswer, ThreadApplyAnswer, ThreadGetAnswer, ThreadItem, ThreadsListAnswer } from '@retake/engine/contract';

/** The names of the comment ops (served by the Studio, never an MCP tool's name). */
export const COMMENT_OPS = [
  'threads_list',
  'threads_counts',
  'thread_get',
  'thread_still',
  'render_outline',
  'render_frame',
  'frame_anchor',
  'thread_add',
  'thread_reply',
  'thread_resolve',
  'thread_reopen',
  'thread_apply',
] as const;
