/**
 * L5.12a: the Review report's "Show in Edit" hand-off — one pending seek per tab (module memory, like proposal-focus):
 * the report sets it (the render a finding is on, its frame, its step) and opens Edit on that render's capture; Edit takes
 * it once, when its view and its renders are read, and seeks to the frame only when the render shows the version on
 * screen (versionNote(…).same: the same plan and theme files) — else to the step, with a note that the render was made
 * from another version. Never a write, never a URL: the frame does not travel in the address.
 * L5.12a fixes (review A-L6): the ask lives only as long as the way to that Edit — a route change anywhere else drops it,
 * and so does an Edit that cannot show the take (an error, a blocked take): never a stale seek on a later visit.
 */
import { parseRoute } from '../route.js';

export interface EditSeek {
  slug: string;
  scenario: string;
  render_id: string;
  /** The finding's frame of that render, when it has one. */
  frame?: number;
  /** The finding's step key (`<scene>.<step>`), when it has one. */
  step?: string;
}

let pending: EditSeek | null = null;

/** The address changed: the ask stays only on that scenario's Edit (where the report sent it). */
export function editSeekRouteChanged(hash: string): void {
  if (!pending) return;
  const r = parseRoute(hash);
  if (r.name === 'timeline' && r.slug === pending.slug && r.scenario === pending.scenario) return;
  pending = null;
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => editSeekRouteChanged(location.hash));

/** The report asks Edit to show a finding (replaces any earlier ask). */
export function seekInEdit(s: EditSeek): void {
  pending = { ...s };
}

/** Edit's take: the pending ask for this scenario, once (then forgotten); another scenario's stays. */
export function takeEditSeek(slug: string, scenario: string): EditSeek | null {
  if (!pending || pending.slug !== slug || pending.scenario !== scenario) return null;
  const p = pending;
  pending = null;
  return p;
}
