/** The façade's `comments` (createEngine): threads on renders — read, add and reopen (a person's), reply (a proposal: Claude's), resolve, anchor, apply a proposal, counts. */
import type { CommentAuthor } from '@retake/core';
import { EngineError } from '../errors.js';
import { memoRegistry } from '../timeline-view.js';
import { MCP_AUTHOR_NAME, addComment, anchorAt, applyProposal, defaultAuthorName, getComment, getProposal, listComments, reopenComment, replyComment, resolveComment } from '../comments.js';
import { anchorsOnShownRender, needsIfMatch, proposes, speaksAsPerson } from '../caller.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.comments. */
export function commentsApi(ctx: EngineContext): Engine['comments'] {
  const { caller, ws, scope, project, commentIndex } = ctx;
  // Who an entry is written by: the channel, never a person; anything but the CLI and the Studio counts as the MCP
  // (fail-safe). The name of a person channel is this process's (the page never names an author).
  const commentAuthor = (): CommentAuthor => (caller.channel === 'mcp' ? { via: 'mcp', name: MCP_AUTHOR_NAME } : { via: caller.channel, name: defaultAuthorName() });
  // What only a person channel does (a terminal, the Studio): create and reopen threads.
  const personOnly = (what: string, where = `retake comment ${what.split(' ')[0]} in a terminal, or the Studio`) => {
    if (!speaksAsPerson(caller)) {
      throw new EngineError('refused', `${what} is for a person (${where}): an agent replies to and resolves comments`);
    }
  };
  // Every client but the CLI acts on the version of a thread it read.
  const needIfMatch = (ifMatch: string | undefined | null, what: string) => {
    if (needsIfMatch(caller) && (ifMatch === undefined || ifMatch === null)) {
      throw new EngineError('invalid', `if_match is required to ${what} a comment: the hash comments_list returned for the thread`, { details: { argument: 'if_match' } });
    }
  };
  return {
    list: async (slug, req) => listComments(await project(slug), req),
    get: async (slug, id) => getComment(await project(slug), id),
    add: async (slug, req) => {
      personOnly('add (creating a thread)');
      // The Studio comments the render it showed: a reused id is a conflict, never another render's frame.
      if (anchorsOnShownRender(caller) && (req.render_created_at === undefined || req.render_created_at === null)) {
        throw new EngineError('invalid', 'render_created_at is required to comment from the Studio: the created_at of the render shown', { details: { argument: 'render_created_at' } });
      }
      return addComment(await project(slug), req, commentAuthor(), scope);
    },
    reply: async (slug, id, text, o = {}) => {
      // Proposals are Claude's: a person changes the file; any other channel's entry would be labelled as Claude's.
      if (o.proposal !== undefined && !proposes(caller)) {
        throw new EngineError('refused', 'a proposal comes from Claude (comment_reply over MCP): from a terminal or the Studio, change the scenario and reply');
      }
      return replyComment(await project(slug), id, text, commentAuthor(), {
        ...(o.proposal !== undefined ? { proposal: o.proposal } : {}),
        registry: async () => (await memoRegistry(ws)).registry,
        scope,
      });
    },
    resolve: async (slug, id, req) => {
      needIfMatch(req.if_match, 'resolve');
      return resolveComment(
        await project(slug),
        id,
        { note: req.note, ...(req.render_id !== undefined ? { render_id: req.render_id } : {}), ...(req.if_match !== undefined ? { ifMatch: req.if_match } : {}) },
        commentAuthor(),
        { scope },
      );
    },
    reopen: async (slug, id, note, o = {}) => {
      personOnly('reopen (reopening a thread)');
      needIfMatch(o.if_match, 'reopen');
      return reopenComment(await project(slug), id, note, commentAuthor(), { ...(o.if_match !== undefined && o.if_match !== null ? { ifMatch: o.if_match } : {}), scope });
    },
    anchorAt: async (slug, req) => anchorAt(await project(slug), req),
    apply: async (slug, id, req) => {
      personOnly('apply (applying a proposal)', 'in the Studio: an agent proposes, a person applies');
      needIfMatch(req.if_match, 'apply');
      return applyProposal(
        await project(slug),
        id,
        { entry_id: req.entry_id, ...(req.if_match !== undefined && req.if_match !== null ? { ifMatch: req.if_match } : {}) },
        commentAuthor(),
        { registry: async () => (await memoRegistry(ws)).registry, scope },
      );
    },
    proposal: async (slug, id, entryId) => getProposal(await project(slug), id, entryId, { registry: async () => (await memoRegistry(ws)).registry }),
    counts: async (slug, o = {}) => commentIndex.counts(await project(slug), o),
  };
}
