/**
 * The caller rules of the comments, one refusal each (L7.16): the comments façade (facade/comments-api.ts) throws what
 * they return, in this order and before the project is read; the engine's comment operations return the same as their
 * `callers` (operations/comments.ts, comment-screen.ts), so a refusal reads the same through invoke and through the
 * façade (the CLI's way).
 */
import { EngineError } from '../errors.js';
import { anchorsOnShownRender, needsIfMatch, proposes, speaksAsPerson } from '../caller.js';
import type { Caller } from '../caller.js';

// What only a person channel does (a terminal, the Studio): create and reopen threads, apply proposals.
function personOnly(c: Caller, what: string, where = `retake comment ${what.split(' ')[0]} in a terminal, or the Studio`): EngineError | undefined {
  return speaksAsPerson(c) ? undefined : new EngineError('refused', `${what} is for a person (${where}): an agent replies to and resolves comments`);
}
// Every client but the CLI acts on the version of a thread it read.
function needIfMatch(c: Caller, ifMatch: string | undefined | null, what: string): EngineError | undefined {
  if (needsIfMatch(c) && (ifMatch === undefined || ifMatch === null)) {
    return new EngineError('invalid', `if_match is required to ${what} a comment: the hash comments_list returned for the thread`, { details: { argument: 'if_match' } });
  }
  return undefined;
}
/** Creating a thread: a person's; the Studio names the render it showed (a reused id is a conflict, never another render's frame). */
export function threadAddRefused(c: Caller, renderCreatedAt: string | undefined | null): EngineError | undefined {
  const person = personOnly(c, 'add (creating a thread)');
  if (person) return person;
  if (anchorsOnShownRender(c) && (renderCreatedAt === undefined || renderCreatedAt === null)) {
    return new EngineError('invalid', 'render_created_at is required to comment from the Studio: the created_at of the render shown', { details: { argument: 'render_created_at' } });
  }
  return undefined;
}
/** A reply: its proposal is Claude's (a person changes the file; any other channel's entry would be labelled as Claude's). */
export function commentReplyRefused(c: Caller, proposal: unknown): EngineError | undefined {
  if (proposal !== undefined && !proposes(c)) {
    return new EngineError('refused', 'a proposal comes from Claude (comment_reply over MCP): from a terminal or the Studio, change the scenario and reply');
  }
  return undefined;
}
/** A resolve, on the version read. */
export function commentResolveRefused(c: Caller, ifMatch: string | undefined | null): EngineError | undefined {
  return needIfMatch(c, ifMatch, 'resolve');
}
/** A reopen: a person's, on the version read. */
export function threadReopenRefused(c: Caller, ifMatch: string | undefined | null): EngineError | undefined {
  return personOnly(c, 'reopen (reopening a thread)') ?? needIfMatch(c, ifMatch, 'reopen');
}
/** Applying a proposal: a person's (an agent proposes), on the version read. */
export function proposalApplyRefused(c: Caller, ifMatch: string | undefined | null): EngineError | undefined {
  return personOnly(c, 'apply (applying a proposal)', 'in the Studio: an agent proposes, a person applies') ?? needIfMatch(c, ifMatch, 'apply');
}
