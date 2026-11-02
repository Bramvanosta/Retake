/**
 * L5.12b: the proposal's focus hand-off (the timeline's Back to the comment, ProposalBanner.tsx) — one pending ask per tab
 * (module memory, like edit-handoff.ts): the banner names the project and the thread; the thread's ProposalCard takes it
 * once and scrolls to the proposal, its heading focused. The ask lives only on the way to that thread: a route anywhere
 * else drops it (hashchange), and so does a thread that cannot be read — never a stale focus on a later visit.
 */
import { parseRoute } from './route.js';

let wanted: { slug: string; thread: string } | null = null;

/** Ask the thread screen to scroll to the thread's proposal when it opens (replaces any earlier ask). */
export function focusProposalOf(slug: string, threadId: string): void {
  wanted = { slug, thread: threadId };
}

/** The address changed: the ask stays only on that thread's comments route. */
export function proposalFocusRouteChanged(hash: string): void {
  if (!wanted) return;
  const r = parseRoute(hash);
  if (r.name === 'comments' && r.slug === wanted.slug && r.thread === wanted.thread) return;
  wanted = null;
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => proposalFocusRouteChanged(location.hash));

/** The thread cannot be read (an error, gone): no focus waits for a later visit. */
export function dropProposalFocus(): void {
  wanted = null;
}

/** Is a focus asked for this thread? Takes it once (the card); another thread's ask stays. */
export function takeProposalFocus(slug: string, threadId: string): boolean {
  if (!wanted || wanted.slug !== slug || wanted.thread !== threadId) return false;
  wanted = null;
  return true;
}
