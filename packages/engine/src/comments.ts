/**
 * The frame comment store (L3.6, R-CMT-02..05, ADR-1 #4): thread files `<project>/comments/<scenario>/<id>.json` (core
 * CommentThreadSchema), their stills `<project>/.retake/comments/<id>.jpg` (machine-local: product frames never
 * enter git), and the views clients read.
 *
 * Writes: a thread is created whole (a link: never over an existing file); an entry is appended under the thread's lock
 * (`<project>/.retake/locks/comment-<id>.lock`, core/io's TakeLock: created whole, stale only when its
 * process is gone — never by age —, retried while busy), read → checked → appended → written atomically (temp + rename)
 * with the hash just read, so `ifMatch` (comment_resolve's if_match) is checked inside the lock. A file that does not
 * read as a thread is never overwritten.
 *
 * Reads: only `c_<ULID>.json` files of scenario folders (temp files, other names and symbolic links skipped; a link or
 * a broken file is reported by name), the file name equal to the thread id and the folder to its scenario. Paths are
 * rebuilt from ids, never taken from a file. A view keeps every free text (comment, entries, notes, author names, an
 * anchor value of an unknown shape) under `untrusted`; the status is derived from the entries.
 *
 * Trust: who wrote an entry is the channel (`author.via`), set by the caller — the CLI (`cli`) or the engine for its
 * clients (`studio` for the Studio web app, `mcp` for every other client). Only the person channels (`cli`, `studio`)
 * create and reopen threads (Engine.comments refuses both for any other client); the Studio acts on the version of a
 * thread it showed (`if_match`) and on the render it showed (`render_created_at`).
 *
 * Costs (L4.6, critique B8 / B12): the thread is written before its still (the still is an exact select from frame 0:
 * its time grows with the frame's position, a failure is a warning); `CommentIndex` counts and places threads from the
 * thread files alone (no render records, no views), memoised per file signature.
 */
export { COMMENT_FILE_MAX_BYTES, COMMENT_LIST_MAX_FILES, COMMENT_LOCK_WAIT_MS, COMMENT_STILL_MAX_BYTES, MCP_AUTHOR_NAME, checkCommentId, commentLockFile, commentRef, commentStillFile, defaultAuthorName } from './comments/store.js';
export { COMMENT_COUNT_MAX_FOLDERS, CommentIndex, getComment, listComments, recordShapeOk, timecodeOf } from './comments/views.js';
export type { CommentCountsView, CommentEntryView, CommentListRequest, CommentListView, CommentProposalSummary, CommentSummary, CommentView } from './comments/views.js';
export { addComment, anchorAt, prepareComment, reopenComment, replyComment, resolveComment } from './comments/threads.js';
export type { CommentAddRequest, CommentAdded, CommentAnchorRequest, CommentAnchorView, CommentPrepareRequest, CommentResolveRequest, CommentWritten, PreparedComment } from './comments/threads.js';
export { applyProposal, getProposal, proposalForPreview } from './comments/proposals.js';
export type { CommentApplied, CommentApplyRequest, CommentProposalView, ProposalPreview } from './comments/proposals.js';
export { PROPOSAL_CONTEXT_LINES } from './comment-proposals.js';
export type { ProposalRow } from './comment-proposals.js';
