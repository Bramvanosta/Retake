import { resolve } from 'node:path';
import { findWorkspaceRoot, loadProject, loadWorkspaceConfig, useWorkspaceFfmpeg, useWorkspaceRender } from '@retake/core';
import type { BrowserConfig, LoadedProject, WorkspaceConfig } from '@retake/core';

/** Where a workspace is: `root` (the CLI's `--root`), else $RETAKE_ROOT, else the retake.yaml lookup from the cwd. */
export interface WorkspaceOptions {
  root?: string;
}

/**
 * The workspace a command works in: `root`, else $RETAKE_ROOT, else the retake.yaml lookup from the cwd. Its retake.yaml
 * `ffmpeg` becomes this process's ffmpeg (core bundle.ts `mediaTools`) and its `render:` this process's render settings
 * (core render-settings.ts, L5.15): a process serves one workspace.
 */
export async function openWorkspace(opts: WorkspaceOptions): Promise<WorkspaceConfig> {
  const root = opts.root ? resolve(opts.root) : findWorkspaceRoot();
  const ws = await loadWorkspaceConfig(root);
  useWorkspaceFfmpeg(ws.ffmpeg);
  useWorkspaceRender(ws.render);
  return ws;
}

/** retake.yaml `browser` ← project.yaml `browser` (the project wins; args from both are kept). */
function mergeBrowserConfig(ws?: BrowserConfig, project?: BrowserConfig): BrowserConfig | undefined {
  if (!ws) return project;
  if (!project) return { ...ws };
  const args = [...(ws.args ?? []), ...(project.args ?? [])];
  const out: BrowserConfig = { ...ws, ...project };
  if (args.length) out.args = args;
  else delete out.args;
  return out;
}

/**
 * Load a project of the workspace (slug or directory) with the workspace browser settings folded in. A project
 * `locale` is more specific than the workspace `browser.locale` default: the runner uses it as the browser locale
 * unless the project's own `browser.locale` is set.
 */
export async function openProject(ws: WorkspaceConfig, slugOrDir: string): Promise<LoadedProject> {
  const project = await loadProject(slugOrDir, ws.root);
  let wsBrowser = ws.browser;
  if (wsBrowser?.locale !== undefined && project.config.locale !== undefined) {
    wsBrowser = { ...wsBrowser };
    delete wsBrowser.locale;
  }
  const browser = mergeBrowserConfig(wsBrowser, project.config.browser);
  if (browser) project.config = { ...project.config, browser };
  return project;
}
