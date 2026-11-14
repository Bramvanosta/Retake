/**
 * The types the app's StudioOps (src/app/data/ops.ts) is derived from, held exactly for the Studio's comment operations
 * (L7.16: they became the engine's operations; written on the commit before the move): each op's arguments as a page
 * sends them (`ToolArgs`) and its answer (`ToolData`) of `StudioTools` (server/studio.ts). A type that widens or
 * narrows fails `pnpm typecheck` (tsconfig.test.json), not this file's run: the run only says the file is part of the
 * suite.
 */
import { describe, expect, it } from 'vitest';
import type { ToolArgs, ToolData } from '@retake/engine/contract';
import type { CommentAnchorView, CommentCountsView, RenderFrameView, RenderOutlineView } from '@retake/engine';
import type { ThreadAnswer, ThreadApplyAnswer, ThreadGetAnswer, ThreadsListAnswer } from '../src/index.js';
import type { StudioTools } from '../src/server/studio.js';

/** A and B are each other's (mutually assignable) and have the same keys (an extra optional member counts). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Exact<A, B> = Same<A, B> extends true ? Same<keyof A, keyof B> : false;
type Holds<T extends true> = T;

type Args<K extends keyof StudioTools> = ToolArgs<StudioTools[K]>;
type Data<K extends keyof StudioTools> = ToolData<StudioTools[K]>;

type Region = { x: number; y: number; w: number; h: number };
type Written = { thread: ThreadAnswer; entry: string; hash: string };

export type Checks = [
  Holds<Exact<Args<'threads_list'>, { project: string; name: string; status?: 'open' | 'resolved' | 'all' | undefined; render?: string | undefined; limit?: number | undefined }>>,
  Holds<Exact<Data<'threads_list'>, ThreadsListAnswer>>,
  Holds<Exact<Args<'threads_counts'>, { project: string; name?: string | undefined }>>,
  Holds<Exact<Data<'threads_counts'>, CommentCountsView>>,
  Holds<Exact<Args<'thread_get'>, { project: string; comment_id: string; entry_id?: string | undefined }>>,
  Holds<Exact<Data<'thread_get'>, ThreadGetAnswer>>,
  Holds<Exact<Args<'thread_still'>, { project: string; comment_id: string }>>,
  Holds<Exact<Data<'thread_still'>, { comment_id: string; mime: string; base64: string; width: number; height: number }>>,
  Holds<Exact<Args<'render_outline'>, { project: string; render_id: string; created_at?: string | undefined }>>,
  Holds<Exact<Data<'render_outline'>, RenderOutlineView>>,
  Holds<Exact<Args<'render_frame'>, { project: string; render_id: string; created_at: string; frame: number; session: string }>>,
  Holds<Exact<Data<'render_frame'>, RenderFrameView>>,
  Holds<Exact<Args<'frame_anchor'>, { project: string; render_id: string; created_at: string; frame: number; region?: Region | undefined }>>,
  Holds<Exact<Data<'frame_anchor'>, Omit<CommentAnchorView, 'warnings'> & { warnings: string[] }>>,
  Holds<Exact<Args<'thread_add'>, { project: string; render_id: string; created_at: string; frame: number; region?: Region | undefined; text: string }>>,
  Holds<Exact<Data<'thread_add'>, { thread: ThreadAnswer; warnings: string[] }>>,
  Holds<Exact<Args<'thread_reply'>, { project: string; comment_id: string; text: string }>>,
  Holds<Exact<Data<'thread_reply'>, Written>>,
  Holds<Exact<Args<'thread_resolve'>, { project: string; comment_id: string; note: string; render_id?: string | undefined; if_match: string }>>,
  Holds<Exact<Data<'thread_resolve'>, Written>>,
  Holds<Exact<Args<'thread_reopen'>, { project: string; comment_id: string; note?: string | undefined; if_match: string }>>,
  Holds<Exact<Data<'thread_reopen'>, Written>>,
  Holds<Exact<Args<'thread_apply'>, { project: string; comment_id: string; entry_id: string; if_match: string }>>,
  Holds<Exact<Data<'thread_apply'>, ThreadApplyAnswer>>,
];

describe("the Studio's comment operations' types (L7.16)", () => {
  it('are held by pnpm typecheck (this run only says the file is in the suite)', () => {
    expect(true).toBe(true);
  });
});
