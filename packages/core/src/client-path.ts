/**
 * The PATH a process the tool starts for a client gets (L3.x `retake mcp`, L4.1 `retake ui`, L4.2 the jobs worker a
 * client starts): the node that runs it first, the current PATH without what a package manager added for the script it
 * runs and without anything inside the workspace, plus the Homebrew / system folders GUI clients lack.
 */
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { pathInside } from './path-inside.js';

/** Folders a GUI client's PATH lacks where Homebrew and the system keep the tools the engine runs. */
const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Folders a package manager puts on the PATH of the script it runs (`pnpm retake …`): a project's node_modules/.bin, its
 * own versioned install (corepack, node-gyp-bin). Not for a registration: they move or vanish with the next install.
 */
const TRANSIENT_PATH = /(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)|[\\/]corepack[\\/]|[\\/]node-gyp-bin(?:[\\/]|$)/;

/** A path and, when it exists, its real path (macOS: /tmp → /private/tmp, /var → /private/var). */
function spellings(p: string): string[] {
  const abs = resolve(p);
  try {
    // realpathSync.native: the spelling the file system keeps (macOS: case-insensitive, `/Users/Me/WS` and
    // `/users/me/ws` are one folder — the JS realpath keeps the case it was given, review A #3).
    return [...new Set([abs, realpathSync.native(abs)])];
  } catch {
    return [abs];
  }
}

/** File systems that ignore case by default: a path that does not exist (yet) is compared without case there. */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** Whether `p` is `folder` or inside it, under any spelling of either (and any case where the system ignores it). */
export function isUnder(p: string, folder: string): boolean {
  const roots = spellings(folder);
  return spellings(p).some((x) => roots.some((r) => pathInside(x, r, { compare: 'spelling', fold: FOLD_CASE })));
}

/**
 * The current PATH, the node's own folder first, without the folders a package manager added for the script it runs,
 * plus the Homebrew / system folders that exist and are missing. Absolute entries only: a relative one (`.`, `bin`)
 * resolves against the cwd, and a server's cwd is the client's project folder, where an agent writes files. For the same
 * reason, no entry inside the workspace (`workspace`, when given — its root, or all its folders: `<ws>/bin`,
 * `<ws>/node_modules/.bin`): the agent writes files there, and the server's children would run them. The node's folder goes first, so the `node` the server's
 * children find is the one that runs it (the registered one).
 */
export function clientPath(node: string, current = process.env.PATH ?? '', exists: (p: string) => boolean = existsSync, workspace?: string | readonly string[]): string {
  const folders = workspace === undefined ? [] : typeof workspace === 'string' ? [workspace] : workspace;
  const parts = [
    dirname(node),
    ...current.split(delimiter).filter((p) => p && isAbsolute(p) && !TRANSIENT_PATH.test(p) && !folders.some((f) => isUnder(p, f))),
  ];
  for (const p of EXTRA_PATH) if (exists(p)) parts.push(p);
  return [...new Set(parts)].join(delimiter);
}
