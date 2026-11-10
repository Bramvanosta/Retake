/**
 * L6.13: Review › Comments: the threads, a frame's anchor and a thread's picture, the thread writes, Claude's proposal
 * applied (a render's frames and outline, which the comments' viewer shows too, are renders.ts').
 * Each op once, typed by StudioOps (data/ops.ts).
 */
import { call } from '../api.js';
import type { OpArgs, OpParams, OpResult } from '../api.js';
import { op, readHook } from './client.js';

export const useThreadsList = readHook('threads_list');
export const useThreadsCounts = readHook('threads_counts');
export const useThreadGet = readHook('thread_get');
export const useThreadStill = readHook('thread_still');
export const threadAdd = op('thread_add');
export const threadApply = op('thread_apply');
export const threadResolve = op('thread_resolve');
export const frameAnchor = op('frame_anchor');

/** The thread writes of the thread panel's one helper (Reply, Resolve, Reopen): the op is the helper's argument. */
export type ThreadPanelWrite = 'thread_reply' | 'thread_resolve' | 'thread_reopen';

/** A panel write's own arguments (those of that op: a reply's `text`, a resolve's `note`): the thread (project, comment_id) is the helper's. */
export type ThreadPanelArgs<K extends ThreadPanelWrite> = Omit<OpArgs<K>, 'project' | 'comment_id'>;

/** One thread write of the thread panel (ThreadPanel.tsx ThreadActions' send): that op's arguments, its answer. */
export function threadWrite<K extends ThreadPanelWrite>(name: K, args: OpArgs<K>): Promise<OpResult<K>> {
  // Every panel write takes arguments (OpParams<K> is `[args, o?]` for each): the checker cannot pick the branch of a K.
  return call(name, ...([args] as unknown as OpParams<K>));
}
