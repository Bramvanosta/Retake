/**
 * `retake mcp --print-config`: how an MCP client starts this server. GUI clients (Claude desktop) see neither the shell's
 * version-manager shims nor Homebrew: the snippet names an absolute Node.js ≥ 22 — a stable alias of it where one exists,
 * so a patch upgrade does not break the registration — and carries a PATH with the folders the tools the engine runs
 * live in (ffmpeg, docker, psql). It also prints the Claude Code plugin route (L3.7: the repository's local marketplace,
 * the `skills/` plugin with its userConfig values); `retake mcp` itself serves with `clientPath` as its PATH.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bundleInfo, clientPath, retakeHome } from '@retake/core';
import type { BundleInfo } from '@retake/core';

export { clientPath };

export const SERVER_NAME = 'retake';
/** The plugin and its marketplace (`.claude-plugin/marketplace.json` at the repository root, the plugin in `skills/`). */
export const PLUGIN_NAME = 'retake';
export const PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_NAME}`;

/**
 * A path to the same Node.js major that survives patch upgrades: mise's `installs/node/<major>` alias, Homebrew's
 * `opt/node@<major>` (or `opt/node`); else the path as it is.
 */
export function stableNodePath(execPath: string, exists: (p: string) => boolean = existsSync): string {
  // mise / asdf `…/node/22.16.0/bin/node`, nvm `…/node/v22.16.0/bin/node`: the major's folder when there is one.
  const major = /\/node\/v?(\d+)\.\d+\.\d+\/bin\/node$/.exec(execPath);
  if (major) {
    const alias = execPath.replace(/\/node\/v?\d+\.\d+\.\d+\/bin\/node$/, `/node/${major[1]}/bin/node`);
    if (alias !== execPath && exists(alias)) return alias;
  }
  const brew = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (brew) {
    const alias = `${brew[1]}/opt/${brew[2]}/bin/node`;
    if (exists(alias)) return alias;
  }
  return execPath;
}

export interface McpConfigInput {
  /** Workspace root (absolute). */
  root: string;
  /** The retake entry point (absolute path of packages/cli/dist/bin.js). */
  bin: string;
  /** Default: process.execPath, through stableNodePath. */
  node?: string;
  env?: NodeJS.ProcessEnv;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function mcpServerEntry(o: McpConfigInput): McpServerEntry {
  const env = o.env ?? process.env;
  const node = o.node ?? stableNodePath(process.execPath);
  let bin = o.bin;
  try {
    bin = realpathSync(bin);
  } catch {
    // printed as given
  }
  return {
    command: node,
    args: [bin, '--root', o.root, 'mcp'],
    env: {
      PATH: clientPath(node, env.PATH ?? '', existsSync, o.root),
      // absolute, as the plugin route prints it: a GUI client's cwd is not the shell's
      ...(env.RETAKE_HOME?.trim() ? { RETAKE_HOME: retakeHome(env) } : {}),
    },
  };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `mcpServers` block of .mcp.json (Claude Code, per project) and of Claude desktop's claude_desktop_config.json. */
export function mcpConfigJson(o: McpConfigInput): { mcpServers: Record<string, McpServerEntry> } {
  return { mcpServers: { [SERVER_NAME]: mcpServerEntry(o) } };
}

/** `claude mcp add …`: the same registration for Claude Code, per user. */
export function claudeCodeCommand(o: McpConfigInput): string {
  const e = mcpServerEntry(o);
  const envFlags = Object.entries(e.env).map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`);
  return ['claude mcp add', SERVER_NAME, '--scope user', ...envFlags, '--', shellQuote(e.command), ...e.args.map(shellQuote)].join(' ');
}

/**
 * MCP over HTTP (L4.1): the registration of `retake mcp --http` — a URL and the bearer header, no command. The printed
 * registrations never carry the token itself (review A M1): the `.mcp.json` block names the environment variable
 * Claude Code expands when it reads the file (a project's `.mcp.json` is often committed), and the `claude mcp add`
 * line reads the token file in the shell that runs it (the shell history keeps `$(cat …)`, not the token).
 */
export interface McpHttpEntry {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

/** The environment variable the `.mcp.json` registration reads the token from (Claude Code expands `${…}` there). */
export const MCP_HTTP_TOKEN_ENV = 'RETAKE_MCP_TOKEN';

export function mcpHttpEntry(o: { url: string }): McpHttpEntry {
  return { type: 'http', url: o.url, headers: { Authorization: `Bearer \${${MCP_HTTP_TOKEN_ENV}}` } };
}

/** The `mcpServers` block for .mcp.json with the HTTP registration (the token from $RETAKE_MCP_TOKEN). */
export function mcpHttpConfigJson(o: { url: string }): { mcpServers: Record<string, McpHttpEntry> } {
  return { mcpServers: { [SERVER_NAME]: mcpHttpEntry(o) } };
}

/** `"$(cat '<token file>')"`: the token, read from its file by the shell that runs the line. */
function tokenFromFile(tokenFile: string): string {
  return `$(cat ${shellQuote(tokenFile)})`;
}

/**
 * `claude mcp add --transport http …`: the same registration for Claude Code, per user (Claude Code keeps the header in
 * its own user settings); the token read from `tokenFile` when the line runs.
 */
export function claudeCodeHttpCommand(o: { url: string; tokenFile: string }): string {
  return ['claude mcp add --transport http', SERVER_NAME, shellQuote(o.url), '--scope user', '--header', `"Authorization: Bearer ${tokenFromFile(o.tokenFile)}"`].join(' ');
}

/** The line that gives the `.mcp.json` registration its token: `export RETAKE_MCP_TOKEN="$(cat '<token file>')"`. */
export function mcpHttpTokenExport(tokenFile: string): string {
  return `export ${MCP_HTTP_TOKEN_ENV}="${tokenFromFile(tokenFile)}"`;
}

/**
 * The folder holding the local plugin marketplace (`.claude-plugin/marketplace.json` + `skills/`): the app bundle's
 * `plugin/` when Retake runs from one (L5.16), else the first such folder above the retake entry point (the repository),
 * or undefined (an install without the repository's `skills/`).
 */
export function pluginMarketplaceRoot(bin: string, exists: (p: string) => boolean = existsSync, bundle: BundleInfo | null = bundleInfo()): string | undefined {
  if (bundle) {
    const dir = bundle.paths.plugin;
    return exists(join(dir, '.claude-plugin', 'marketplace.json')) && exists(join(dir, 'skills', '.claude-plugin', 'plugin.json')) ? dir : undefined;
  }
  let dir = dirname(bin);
  try {
    dir = dirname(realpathSync(bin));
  } catch {
    // as given
  }
  for (;;) {
    if (exists(join(dir, '.claude-plugin', 'marketplace.json')) && exists(join(dir, 'skills', '.claude-plugin', 'plugin.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The Claude Code plugin route, two lines: add the repository's marketplace (user settings; a second add is a no-op),
 * then install the plugin from the workspace folder with `--scope local` (enabled in that folder only) and the userConfig
 * values the plugin's .mcp.json starts the server with — the same Node.js, entry point and workspace as `mcpServerEntry`,
 * and `home` when RETAKE_HOME is set (the plugin's server gets RETAKE_HOME from it). Running the install line
 * again updates the values.
 */
export function pluginInstallCommands(o: McpConfigInput & { repo: string }): string[] {
  const e = mcpServerEntry(o);
  const env = o.env ?? process.env;
  const config: Array<[string, string]> = [['node', e.command], ['cli', e.args[0]], ['workspace', o.root]];
  if (env.RETAKE_HOME?.trim()) config.push(['home', retakeHome(env)]);
  return [
    `claude plugin marketplace add ${shellQuote(o.repo)}`,
    `cd ${shellQuote(o.root)} && claude plugin install ${PLUGIN_ID} --scope local ${config.map(([k, v]) => `--config ${shellQuote(`${k}=${v}`)}`).join(' ')}`,
  ];
}
