/**
 * `studio mcp --print-config`: how an MCP client starts this server. GUI clients (Claude desktop) see neither the shell's
 * version-manager shims nor Homebrew: the snippet names an absolute Node.js ≥ 22 — a stable alias of it where one exists,
 * so a patch upgrade does not break the registration — and carries a PATH with the folders the tools the engine runs
 * live in (ffmpeg, docker, psql).
 */
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

export const SERVER_NAME = 'demo-studio';

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

/**
 * The current PATH, the node's own folder first, without the folders a package manager added for the script it runs,
 * plus the Homebrew / system folders that exist and are missing.
 */
export function clientPath(node: string, current = process.env.PATH ?? '', exists: (p: string) => boolean = existsSync): string {
  const parts = [dirname(node), ...current.split(delimiter).filter((p) => p && !TRANSIENT_PATH.test(p))];
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
      PATH: clientPath(node, env.PATH ?? ''),
      ...(env.DEMO_STUDIO_HOME ? { DEMO_STUDIO_HOME: env.DEMO_STUDIO_HOME } : {}),
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
