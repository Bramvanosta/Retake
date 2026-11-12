import { resolve } from 'node:path';
import { workPolicy } from '@retake/core/policy';
import type { BrowserConfig, LoadedProject, WorkspaceConfig } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { WorkspaceReads } from './workspace-reads/reads.js';

/** Where a workspace is: `root` (the CLI's `--root`), else $RETAKE_ROOT, else the retake.yaml lookup from the cwd. */
export interface WorkspaceOptions {
  root?: string;
  /**
   * This process serves trust `mcp` (core agent-policy.ts): the jobs worker and its job processes, the MCP server, the
   * Studio server — never a command a person types. Its jobs then run no program from inside the workspace and pass
   * Chromium, in browser.args, only switches of core AGENT_ALLOWED_SWITCHES. Said by every caller (false: a person's
   * policy, the CLI's), never left to a default.
   */
  agent: boolean;
  /**
   * What the workspace is read by (ports.ts EnginePorts `reads`): the composition root's port — the disk's for the
   * product, a MemoryWorkspace's in tests. Said by every caller, never left to a default.
   */
  reads: WorkspaceReads;
}

/** A workspace as a command opened it: its retake.yaml, and the policy its work runs under (core WorkPolicy). */
export interface OpenedWorkspace extends WorkspaceConfig {
  /**
   * What the work of this workspace runs under: its retake.yaml `ffmpeg` (core media-tools `ffmpegBin`) and `render:`
   * (core render-settings.ts, L5.15), and — with `agent` — the agent policy on for its folders. The engine passes it to
   * every adapter that starts a program, a browser or ffmpeg.
   */
  readonly policy: WorkPolicy;
  /** What this workspace is read by (WorkspaceOptions.reads): every load of its projects, scenarios and themes. */
  readonly reads: WorkspaceReads;
}

/**
 * The workspace a command works in: `root`, else $RETAKE_ROOT, else the retake.yaml lookup from the cwd, with the
 * policy its work runs under (`agent`: the agent policy on for its folders).
 */
export async function openWorkspace(opts: WorkspaceOptions): Promise<OpenedWorkspace> {
  const { reads } = opts;
  const root = opts.root ? resolve(opts.root) : reads.findWorkspaceRoot();
  const ws = await reads.loadWorkspaceConfig(root);
  return { ...ws, policy: workPolicy(ws, { agent: !!opts.agent }), reads };
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
export async function openProject(ws: WorkspaceConfig & Pick<OpenedWorkspace, 'reads'>, slugOrDir: string): Promise<LoadedProject> {
  const project = await ws.reads.loadProject(slugOrDir, ws.root);
  let wsBrowser = ws.browser;
  if (wsBrowser?.locale !== undefined && project.config.locale !== undefined) {
    wsBrowser = { ...wsBrowser };
    delete wsBrowser.locale;
  }
  const browser = mergeBrowserConfig(wsBrowser, project.config.browser);
  if (browser) project.config = { ...project.config, browser };
  return project;
}
