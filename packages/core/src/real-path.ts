/** The real path every comparison of agent-policy.ts is made on (realPathOf). */
import { basename, dirname, join } from 'node:path';
import type { FileFacts } from './file-facts.js';

/**
 * The real path of `p`: its existing part resolved (symbolic links followed, and the case of each name as it is on
 * disk — FileFacts.nativeRealpath), the rest appended.
 */
export function realPathOf(p: string, files: FileFacts): string {
  const real = files.nativeRealpath(p);
  if (real !== undefined) return real;
  const parent = dirname(p);
  return parent === p ? p : join(realPathOf(parent, files), basename(p));
}
