/**
 * `studio mcp --print-config`: how an MCP client starts this server. GUI clients (Claude desktop) see neither the shell's
 * version-manager shims nor Homebrew: the snippet names an absolute Node.js ≥ 22 — a stable alias of it where one exists,
 * so a patch upgrade does not break the registration — and carries a PATH with the folders the tools the engine runs
 * live in (ffmpeg, docker, psql). It also prints the Claude Code plugin route (L3.7: the repository's local marketplace,
 * the `skills/` plugin with its userConfig values); `studio mcp` itself serves with `clientPath` as its PATH.
 */
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { studioHome } from '@demo-studio/core';

export const SERVER_NAME = 'demo-studio';
/** The plugin and its marketplace (`.claude-plugin/marketplace.json` at the repository root, the plugin in `skills/`). */
export const PLUGIN_NAME = 'demo-studio';
export const PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_NAME}`;

/** Folders a GUI client's PATH lacks where Homebrew and the system keep the tools the engine runs. */
const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

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

/**
 * Folders a package manager puts on the PATH of the script it runs (`pnpm studio …`): a project's node_modules/.bin, its
 * own versioned install (corepack, node-gyp-bin). Not for a registration: they move or vanish with the next install.
 */
const TRANSIENT_PATH = /(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)|[\\/]corepack[\\/]|[\\/]node-gyp-bin(?:[\\/]|$)/;

/** A path and, when it exists, its real path (macOS: /tmp → /private/tmp, /var → /private/var). */
function spellings(p: string): string[] {
  const abs = resolve(p);
  try {
    return [...new Set([abs, realpathSync(abs)])];
  } catch {
    return [abs];
  }
}

/** Whether `p` is `folder` or inside it, under any spelling of either. */
function isUnder(p: string, folder: string): boolean {
  const roots = spellings(folder);
  return spellings(p).some((x) => roots.some((r) => x === r || x.startsWith(r.endsWith(sep) ? r : r + sep)));
}

/**
 * The current PATH, the node's own folder first, without the folders a package manager added for the script it runs,
 * plus the Homebrew / system folders that exist and are missing. Absolute entries only: a relative one (`.`, `bin`)
 * resolves against the cwd, and a server's cwd is the client's project folder, where an agent writes files. For the same
 * reason, no entry inside the workspace (`workspace`, when given: `<ws>/bin`, `<ws>/node_modules/.bin`): the agent writes
 * files there, and the server's children would run them. The node's folder goes first, so the `node` the server's
 * children find is the one that runs it (the registered one).
 */
export function clientPath(node: string, current = process.env.PATH ?? '', exists: (p: string) => boolean = existsSync, workspace?: string): string {
  const parts = [
    dirname(node),
    ...current.split(delimiter).filter((p) => p && isAbsolute(p) && !TRANSIENT_PATH.test(p) && !(workspace && isUnder(p, workspace))),
  ];
  for (const p of EXTRA_PATH) if (exists(p)) parts.push(p);
  return [...new Set(parts)].join(delimiter);
}

export interface McpConfigInput {
  /** Workspace root (absolute). */
  root: string;
  /** The studio entry point (absolute path of packages/cli/dist/bin.js). */
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
      ...(env.DEMO_STUDIO_HOME?.trim() ? { DEMO_STUDIO_HOME: studioHome(env) } : {}),
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
 * MCP over HTTP (L4.1): the registration of `studio mcp --http` — a URL and the bearer header, no command. The printed
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
export const MCP_HTTP_TOKEN_ENV = 'DEMO_STUDIO_MCP_TOKEN';

export function mcpHttpEntry(o: { url: string }): McpHttpEntry {
  return { type: 'http', url: o.url, headers: { Authorization: `Bearer \${${MCP_HTTP_TOKEN_ENV}}` } };
}

/** The `mcpServers` block for .mcp.json with the HTTP registration (the token from $DEMO_STUDIO_MCP_TOKEN). */
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

/** The line that gives the `.mcp.json` registration its token: `export DEMO_STUDIO_MCP_TOKEN="$(cat '<token file>')"`. */
export function mcpHttpTokenExport(tokenFile: string): string {
  return `export ${MCP_HTTP_TOKEN_ENV}="${tokenFromFile(tokenFile)}"`;
}

/**
 * The repository folder holding the local plugin marketplace (`.claude-plugin/marketplace.json`) the studio entry point
 * belongs to: the first such folder above it, or undefined (an install without the repository's `skills/`).
 */
export function pluginMarketplaceRoot(bin: string, exists: (p: string) => boolean = existsSync): string | undefined {
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
 * and `home` when DEMO_STUDIO_HOME is set (the plugin's server gets DEMO_STUDIO_HOME from it). Running the install line
 * again updates the values.
 */
export function pluginInstallCommands(o: McpConfigInput & { repo: string }): string[] {
  const e = mcpServerEntry(o);
  const env = o.env ?? process.env;
  const config: Array<[string, string]> = [['node', e.command], ['studio', e.args[0]], ['workspace', o.root]];
  if (env.DEMO_STUDIO_HOME?.trim()) config.push(['home', studioHome(env)]);
  return [
    `claude plugin marketplace add ${shellQuote(o.repo)}`,
    `cd ${shellQuote(o.root)} && claude plugin install ${PLUGIN_ID} --scope local ${config.map(([k, v]) => `--config ${shellQuote(`${k}=${v}`)}`).join(' ')}`,
  ];
}
