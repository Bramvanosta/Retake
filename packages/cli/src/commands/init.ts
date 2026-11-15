import { WORKSPACE_FILE } from '@retake/core/project';
import { initWorkspace as initWorkspaceWith } from '@retake/engine/shell';
import type { EnginePorts, InitResult } from '@retake/engine';
import type { GlobalOptions } from '../workspace.js';
import { EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';

/** Make `dir` a workspace (the engine's initWorkspace), its files written through the CLI's ports as a person's work. */
export function initWorkspace(dir: string, ports: EnginePorts): Promise<InitResult> {
  return initWorkspaceWith(dir, ports);
}

/** `retake init [dir]`: make a folder (default: the current one) a workspace. */
export async function initCommand(ui: Ui, global: GlobalOptions, dir: string | undefined): Promise<ExitCode> {
  const r = await initWorkspace(dir ?? process.cwd(), global.ports);
  if (r.created) ui.ok(`workspace ${ui.path(r.root)}: ${WORKSPACE_FILE}, projects/ — next: retake new <slug> (from that folder, or with --root)`);
  else ui.ok(`${ui.path(r.root)} already is a workspace (${WORKSPACE_FILE} left as it is)`);
  return EXIT.ok;
}
