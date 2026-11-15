/** Workspace and project loading: moved into @retake/engine (L3.1), shared with the MCP server. */
import { enginePorts, openWorkspace as openEngineWorkspace } from '@retake/engine/shell';
import type { EnginePorts, JobQueueView, OpenedWorkspace } from '@retake/engine';
import type { WorkspaceConfig } from '@retake/core/model';

export { openProject } from '@retake/engine/shell';

/**
 * The ports of the CLI's own work (ports.ts enginePorts: the system's clock, the disk's stores, the file queue, the
 * editor's renderer): what its commands stamp with, write authored files through and render with in process. Made
 * once per `main()` (its composition root, main.ts) and handed to every command in its global options (`ports`): a
 * command names the ports it is handed, never the adapters (the import-rules ratchet's `clock-read`, `store-new`,
 * `queue` and `loader-use` checks).
 */
export function cliEnginePorts(): EnginePorts {
  return enginePorts();
}

/** The workspace of a command a person types (`--root`, else $RETAKE_ROOT, else the lookup): a person's policy, the agent policy off. */
export function openWorkspace(global: Pick<GlobalOptions, 'root' | 'ports'>): Promise<OpenedWorkspace> {
  return openEngineWorkspace({ root: global.root, agent: false, reads: global.ports.reads, outputs: global.ports.outputs });
}

/**
 * The workspace's job queue, for the CLI's in-process commands (`retake inspect`, `retake record`, `retake theme
 * from-site`): they run their work here, not as jobs, and read the queue only so that their pruning spares the folders
 * a queued or running job names. Made by the command's ports (`queues`: the file queue).
 */
export function workspaceQueue(ws: Pick<WorkspaceConfig, 'root'>, ports: EnginePorts): JobQueueView {
  return ports.queues(ws.root, 'retake', ports.clock, ports.env).queue;
}

/** The options every command takes (`-C`, `-v`, `--no-color`). */
export interface ProgramOptions {
  /** Workspace root (overrides $RETAKE_ROOT and the retake.yaml lookup). */
  root?: string;
  verbose?: boolean;
  color?: boolean;
}

/** What every command is handed: the program's options and the CLI's ports (cliEnginePorts, made by main()). */
export interface GlobalOptions extends ProgramOptions {
  readonly ports: EnginePorts;
}
