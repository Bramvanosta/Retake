/** Workspace and project loading: moved into @retake/engine (L3.1), shared with the MCP server. */
import { FileJobQueue } from '@retake/engine';
import type { JobQueueView } from '@retake/engine';
import type { WorkspaceConfig } from '@retake/core';

export { openWorkspace, openProject } from '@retake/engine';

/**
 * The workspace's job queue, for the CLI's in-process commands (`retake inspect`, `retake record`, `retake theme
 * from-site`): they run their work here, not as jobs, and read the queue only so that their pruning spares the folders
 * a queued or running job names. The CLI's one composition root of a queue (the import-rules ratchet's `queue` rule).
 */
export function workspaceQueue(ws: Pick<WorkspaceConfig, 'root'>): JobQueueView {
  return new FileJobQueue(ws.root);
}

export interface GlobalOptions {
  /** Workspace root (overrides $RETAKE_ROOT and the retake.yaml lookup). */
  root?: string;
  verbose?: boolean;
  color?: boolean;
}
