/** Workspace and project loading: moved into @retake/engine (L3.1), shared with the MCP server. */
import { enginePorts, openWorkspace as openEngineWorkspace } from '@retake/engine';
import type { EnginePorts, JobQueueView, OpenedWorkspace } from '@retake/engine';
import type { WorkspaceConfig } from '@retake/core/model';

export { openProject } from '@retake/engine';

/**
 * The ports of the CLI's own work (ports.ts enginePorts: the system's clock, the disk's stores, the file queue, the
 * editor's renderer): what its commands stamp with, write authored files through and render with in process. The
 * CLI's one composition root of them (the import-rules ratchet's `clock-read`, `store-new`, `queue` and `loader-use`
 * checks): a command names `cliPorts`, never the adapters.
 */
export const cliPorts: EnginePorts = enginePorts();

/** The workspace of a command a person types (`--root`, else $RETAKE_ROOT, else the lookup): a person's policy, the agent policy off. */
export function openWorkspace(global: Pick<GlobalOptions, 'root'>): Promise<OpenedWorkspace> {
  return openEngineWorkspace({ root: global.root, agent: false, reads: cliPorts.reads });
}

/**
 * The workspace's job queue, for the CLI's in-process commands (`retake inspect`, `retake record`, `retake theme
 * from-site`): they run their work here, not as jobs, and read the queue only so that their pruning spares the folders
 * a queued or running job names. Made by the CLI's ports (cliPorts.queues: the file queue).
 */
export function workspaceQueue(ws: Pick<WorkspaceConfig, 'root'>): JobQueueView {
  return cliPorts.queues(ws.root, 'retake', cliPorts.clock, cliPorts.env).queue;
}

export interface GlobalOptions {
  /** Workspace root (overrides $RETAKE_ROOT and the retake.yaml lookup). */
  root?: string;
  verbose?: boolean;
  color?: boolean;
}
