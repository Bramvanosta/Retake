/**
 * `studio mcp`: the MCP server over stdio (L3.1), for Claude Code, Claude desktop or any MCP client. stdout carries the
 * protocol only: this command writes nothing else there (diagnostics go to stderr). `--print-config` prints the
 * registration instead.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspaceRoot } from '@demo-studio/core';
import { EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';

export interface McpCommandOptions {
  printConfig?: boolean;
}

/** The built entry point (dist/bin.js), also when this runs from the sources (tests). */
export function studioBin(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // …/dist/commands or …/src/commands
  const pkg = dirname(here);
  return basename(pkg) === 'src' ? join(dirname(pkg), 'dist', 'bin.js') : join(pkg, 'bin.js');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The workspace root `studio mcp` serves: `--root`, $DEMO_STUDIO_ROOT or the studio.yaml lookup; it must look like one. */
function workspaceRoot(global: GlobalOptions): string | undefined {
  const root = global.root ? resolve(global.root) : findWorkspaceRoot();
  return existsSync(join(root, 'studio.yaml')) || isDir(join(root, 'projects')) ? root : undefined;
}

export async function mcpCommand(ui: Ui, global: GlobalOptions, opts: McpCommandOptions): Promise<ExitCode> {
  const root = workspaceRoot(global);
  if (!root) {
    ui.error(
      'studio mcp: no workspace here (no studio.yaml or projects/ folder): pass --root <workspace folder> or set DEMO_STUDIO_ROOT (`studio mcp --root <dir> --print-config` prints the registration)',
    );
    return EXIT.usage;
  }
  const mcp = await import('@demo-studio/mcp');
  if (opts.printConfig) {
    const input = { root, bin: studioBin() };
    ui.result(JSON.stringify(mcp.mcpConfigJson(input), null, 2));
    ui.line('');
    const repo = mcp.pluginMarketplaceRoot(input.bin);
    const either = repo ? 'Either Claude Code with the server alone' : 'Claude Code';
    ui.line(`${either}, for every project of this user (or put the JSON above in .mcp.json at the workspace root):`);
    ui.line(`  ${mcp.claudeCodeCommand(input)}`);
    if (repo) {
      ui.line(`Or the Claude Code plugin (the Demo Studio skills and this server), enabled in this workspace folder only — not both, or Claude Code gets two ${mcp.SERVER_NAME} servers:`);
      for (const l of mcp.pluginInstallCommands({ ...input, repo })) ui.line(`  ${l}`);
      ui.line(`  (run the install line again to change a value; skills edited in ${join(repo, 'skills')} load at the next session. claude --plugin-dir is for editing the skills: it loads them without this server's values.)`);
    }
    ui.line("Claude desktop: the JSON above in ~/Library/Application Support/Claude/claude_desktop_config.json, then restart it.");
    ui.line('Secrets that {{env:…}} references need go in "env" (or the keychain): a GUI client does not read your shell profile. The plugin carries none: use the keychain, or the registration above.');
    return EXIT.ok;
  }
  // A client may start the server with a bare PATH (Claude desktop, a plugin): complete it like a registration's, absolute
  // entries only and none inside the workspace (the cwd is the client's project folder, the agent writes files in the
  // workspace), so the server and the jobs worker it starts find ffmpeg & co., never a program the agent wrote.
  process.env.PATH = mcp.clientPath(process.execPath, process.env.PATH ?? '', undefined, root);
  await mcp.startMcpServer({ root, log: (m) => ui.line(m) });
  return EXIT.ok;
}
