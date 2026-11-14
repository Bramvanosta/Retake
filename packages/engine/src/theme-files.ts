/**
 * The theme hashes on this machine's disk: the planner entry's `themeContentHash` (a render record's template_sha256)
 * and `themeStatSignature` (names, sizes and mtimes, for a memo) read no disk themselves; this file layer is theirs
 * (synchronous, as their walk is).
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { themeContentHash, themeStatSignature } from '@retake/editor/plan';
import type { ThemeFiles } from '@retake/editor/plan';

export const NODE_THEME_FILES: ThemeFiles = {
  readdir: (dir) => readdirSync(dir),
  lstat: (path) => lstatSync(path),
  readFile: (path) => readFileSync(path),
};

/** A theme folder's content hash and the signature of its files. */
export interface ThemeHashes {
  contentHash(dir: string): string;
  /** `o.budget`: entries the walk may look at, decremented (shared over several folders; spent: the walk stops). */
  statSignature(dir: string, o?: { budget?: { left: number } }): string;
}

export const NODE_THEME_HASHES: ThemeHashes = {
  contentHash: (dir) => themeContentHash(dir, NODE_THEME_FILES),
  statSignature: (dir, o) => themeStatSignature(dir, NODE_THEME_FILES, o),
};
