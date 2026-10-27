/**
 * The preview's allow-list of workspace components (L4.5 fixes, review A H1 c — the structural fix): the sandboxed
 * preview runs a component that is not built in only after the person allowed it in this Studio session, by its id and
 * its folder's content hash (editor componentFolderHash). A component an agent wrote or changed is code that has not
 * been looked at: until it is allowed it is not even in the frame's bundle (its uses draw their kind's stand-in), so
 * whatever channel the browser leaves open to a frame, its code never runs there. Built-in components always run.
 *
 * - Held in the Studio server's memory only: never persisted, cleared when the Studio stops.
 * - Keyed by content: an edited component is a new hash, held again until it is allowed again.
 * - Set only by the Studio's own op `preview_allow` (the Allow button of the timeline screen, which names the component
 *   and its hash): no MCP tool and no engine call reaches it.
 */
import { COMPONENT_ID_RE } from '@demo-studio/core';

/** Components allowed per session, at most (a workspace has a few dozen). */
export const PREVIEW_ALLOW_MAX = 512;
/** A folder content hash as the timeline shows it (16 hex). */
export const COMPONENT_HASH_RE = /^[0-9a-f]{16}$/;

export class PreviewAllowList {
  private readonly keys = new Set<string>();

  /** Allow one component at one content hash (returns false for a malformed id or hash, or when the list is full). */
  allow(id: string, hash: string): boolean {
    if (!COMPONENT_ID_RE.test(id) || !COMPONENT_HASH_RE.test(hash)) return false;
    if (this.keys.size >= PREVIEW_ALLOW_MAX && !this.keys.has(`${id}@${hash}`)) return false;
    this.keys.add(`${id}@${hash}`);
    return true;
  }

  /** Whether this component, with this exact content, was allowed in this session. */
  has(id: string, hash: string): boolean {
    return this.keys.has(`${id}@${hash}`);
  }

  get size(): number {
    return this.keys.size;
  }
}
