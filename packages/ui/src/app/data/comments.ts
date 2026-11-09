/**
 * L6.13: Review › Comments: the threads, a frame's anchor and pictures, the thread writes, Claude's proposal applied.
 * Each op once, typed by StudioOps (data/ops.ts).
 */
import { call } from '../api.js';
import type { OpArgs } from '../api.js';
import { op, readHook } from './client.js';

export const useThreadsList = readHook('threads_list');
export const useThreadsCounts = readHook('threads_counts');
export const useThreadGet = readHook('thread_get');
export const useThreadStill = readHook('thread_still');
export const threadAdd = op('thread_add');
export const threadApply = op('thread_apply');
export const threadResolve = op('thread_resolve');
export const frameAnchor = op('frame_anchor');
export const useRenderOutline = readHook('render_outline');
export const renderFrame = op('render_frame');

/** The thread writes of the thread panel's one helper (Reply, Resolve, Reopen): the op is the helper's argument. */
export type ThreadPanelWrite = 'thread_reply' | 'thread_resolve' | 'thread_reopen';

/** A panel write's own arguments: the thread (project, comment_id) is the helper's. */
export type ThreadPanelArgs = { [K in ThreadPanelWrite]: Omit<OpArgs<K>, 'project' | 'comment_id'> }[ThreadPanelWrite];

/** One thread write of the thread panel (ThreadPanel.tsx ThreadActions' send). */
export function threadWrite(name: ThreadPanelWrite, args: OpArgs<ThreadPanelWrite>): Promise<unknown> {
  return call(name, args);
}
