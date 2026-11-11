/**
 * What the preview pages share (timeline_view, L4.5, and theme_preview, L4.7): the leases that keep a project's scope
 * on the player origin alive (PreviewLeases), and the workspace components a preview holds back until the person allows
 * them (PreviewHeld).
 */

/** A page's lease is forgotten after this long without a timeline_view (a tab closed without leaving). */
export const TIMELINE_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The preview pages' leases by project (lease → last seen): a project's scope on the player origin lives while one is
 * held — timeline pages (L4.5) and, L4.7, theme preview pages (theme_preview) share the set; `timeline_leave` ends a
 * lease of either; a lease unseen for TIMELINE_LEASE_TTL_MS is forgotten. The last one gone releases the scope.
 */
export class PreviewLeases {
  private readonly byProject = new Map<string, Map<string, number>>();

  constructor(
    private readonly release: (project: string) => void,
    private readonly ttl = TIMELINE_LEASE_TTL_MS,
  ) {}

  /** A page of `project` holds `lease` (seen now). */
  hold(project: string, lease: string, now = Date.now()): void {
    const m = this.byProject.get(project) ?? new Map<string, number>();
    m.set(lease, now);
    this.byProject.set(project, m);
  }

  /** A page left: its lease ends. The leases still held for the project (0: its scope was released). */
  leave(project: string, lease: string): number {
    const m = this.byProject.get(project);
    m?.delete(lease);
    if (!m || m.size === 0) {
      this.byProject.delete(project);
      this.release(project);
      return 0;
    }
    return m.size;
  }

  /** Forget leases unseen for the TTL; release the projects left with none. */
  prune(now = Date.now()): void {
    for (const [p, m] of this.byProject) {
      for (const [l, at] of m) if (now - at > this.ttl) m.delete(l);
      if (m.size === 0) {
        this.byProject.delete(p);
        this.release(p);
      }
    }
  }
}

/**
 * The workspace components this take uses that the preview does not run until the person allows them in this Studio
 * session (review A H1 c): id, kind and folder content hash — what the Allow button names and sends (preview_allow).
 */
export interface PreviewHeld {
  preview_held?: Array<{ id: string; kind: string; hash: string }>;
}
