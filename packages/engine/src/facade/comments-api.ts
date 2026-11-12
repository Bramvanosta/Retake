/** The façade's `comments` (createEngine): threads on renders — read, add and reopen (a person's), reply (a proposal: Claude's), resolve, anchor, apply a proposal, counts. */
import type { CommentAuthor } from '@retake/core/comments';
import { EngineError } from '../errors.js';
import { memoRegistry } from '../timeline-view.js';
import { MCP_AUTHOR_NAME, addComment, anchorAt, applyProposal, defaultAuthorName, getComment, getProposal, listComments, reopenComment, replyComment, resolveComment } from '../comments.js';
import { commentReplyRefused, commentResolveRefused, proposalApplyRefused, threadAddRefused, threadReopenRefused } from '../comments/rules.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** Throws a caller rule's refusal (comments/rules.ts). */
const refuse = (e: EngineError | undefined): void => {
  if (e) throw e;
};

/** engine.comments. */
export function commentsApi(ctx: EngineContext): Engine['comments'] {
  const { caller, ws, scope, project, commentIndex } = ctx;
  // Who an entry is written by: the channel, never a person; anything but the CLI and the Studio counts as the MCP
  // (fail-safe). The name of a person channel is this process's (the page never names an author).
  const commentAuthor = (): CommentAuthor => (caller.channel === 'mcp' ? { via: 'mcp', name: MCP_AUTHOR_NAME } : { via: caller.channel, name: defaultAuthorName() });
  return {
    list: async (slug, req) => listComments(await project(slug), req),
    get: async (slug, id) => getComment(await project(slug), id),
    add: async (slug, req) => {
      refuse(threadAddRefused(caller, req.render_created_at));
      return addComment(await project(slug), req, commentAuthor(), scope, ws.policy, ctx.ports.reviewer.frames);
    },
    reply: async (slug, id, text, o = {}) => {
      refuse(commentReplyRefused(caller, o.proposal));
      return replyComment(await project(slug), id, text, commentAuthor(), {
        ...(o.proposal !== undefined ? { proposal: o.proposal } : {}),
        registry: async () => (await memoRegistry(ws)).registry,
        scope,
        files: ctx.files,
      });
    },
    resolve: async (slug, id, req) => {
      refuse(commentResolveRefused(caller, req.if_match));
      return resolveComment(
        await project(slug),
        id,
        { note: req.note, ...(req.render_id !== undefined ? { render_id: req.render_id } : {}), ...(req.if_match !== undefined ? { ifMatch: req.if_match } : {}) },
        commentAuthor(),
        { scope },
      );
    },
    reopen: async (slug, id, note, o = {}) => {
      refuse(threadReopenRefused(caller, o.if_match));
      return reopenComment(await project(slug), id, note, commentAuthor(), { ...(o.if_match !== undefined && o.if_match !== null ? { ifMatch: o.if_match } : {}), scope });
    },
    anchorAt: async (slug, req) => anchorAt(await project(slug), req),
    apply: async (slug, id, req) => {
      refuse(proposalApplyRefused(caller, req.if_match));
      return applyProposal(await project(slug), id, { entry_id: req.entry_id, ...(req.if_match !== undefined && req.if_match !== null ? { ifMatch: req.if_match } : {}) }, commentAuthor(), {
        registry: async () => (await memoRegistry(ws)).registry,
        scope,
        files: ctx.files,
      });
    },
    proposal: async (slug, id, entryId) => getProposal(await project(slug), id, entryId, { registry: async () => (await memoRegistry(ws)).registry, files: ctx.files }),
    counts: async (slug, o = {}) => commentIndex.counts(await project(slug), o),
  };
}
