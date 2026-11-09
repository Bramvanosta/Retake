/**
 * Whether a path is inside a folder under any spelling of either (links followed, and without case where the file
 * system ignores it): the comparison the agent policy and the PATH a client gets (`@retake/core/io` clientPath) make.
 */
import { resolve } from 'node:path';
import type { FileFacts } from './file-facts.js';
import { pathInside } from './path-inside.js';

/** A path and, when it exists, its real path (macOS: /tmp → /private/tmp, /var → /private/var). */
function spellings(p: string, files: FileFacts): string[] {
  const abs = resolve(p);
  // nativeRealpath: the spelling the file system keeps (macOS: case-insensitive, `/Users/Me/WS` and `/users/me/ws` are
  // one folder — the JS realpath keeps the case it was given, review A #3).
  const real = files.nativeRealpath(abs);
  return real === undefined ? [abs] : [...new Set([abs, real])];
}

/**
 * Whether `p` is `folder` or inside it, under any spelling of either — and without case where the file system ignores it
 * (FileFacts.ignoresCase: a path that does not exist yet has no spelling of the disk's to compare).
 */
export function isUnder(p: string, folder: string, files: FileFacts): boolean {
  const roots = spellings(folder, files);
  return spellings(p, files).some((x) => roots.some((r) => pathInside(x, r, { compare: 'spelling', fold: files.ignoresCase })));
}
