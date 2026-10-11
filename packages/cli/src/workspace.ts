import { resolve } from 'node:path';
import { findWorkspaceRoot, loadProject, loadWorkspaceConfig } from '@demo-studio/core';
import type { BrowserConfig, LoadedProject, WorkspaceConfig } from '@demo-studio/core';

export interface GlobalOptions {
  /** Workspace root (overrides $DEMO_STUDIO_ROOT and the studio.yaml lookup). */
  root?: string;
  verbose?: boolean;
  color?: boolean;
}

/** The workspace a command works in: `--root`, else $DEMO_STUDIO_ROOT, else the studio.yaml lookup from the cwd. */
export async function openWorkspace(opts: GlobalOptions): Promise<WorkspaceConfig> {
  const root = opts.root ? resolve(opts.root) : findWorkspaceRoot();
  return loadWorkspaceConfig(root);
}

/** studio.yaml `browser` ← project.yaml `browser` (the project wins; args from both are kept). */
function mergeBrowserConfig(ws?: BrowserConfig, project?: BrowserConfig): BrowserConfig | undefined {
  if (!ws) return project;
  if (!project) return { ...ws };
  const args = [...(ws.args ?? []), ...(project.args ?? [])];
  const out: BrowserConfig = { ...ws, ...project };
  if (args.length) out.args = args;
  else delete out.args;
  return out;
}

/** Load a project of the workspace (slug or directory) with the workspace browser settings folded in. */
export async function openProject(ws: WorkspaceConfig, slugOrDir: string): Promise<LoadedProject> {
  const project = await loadProject(slugOrDir, ws.root);
  const browser = mergeBrowserConfig(ws.browser, project.config.browser);
  if (browser) project.config = { ...project.config, browser };
  return project;
}
