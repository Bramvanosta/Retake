/**
 * What the Studio's library and theme screens watch (L4.7, critique B5): file-level stat signatures — names, sizes and
 * mtimes of every file, links named and never followed, dot entries and node_modules skipped, bounded — because a
 * folder's mtime moves neither on an in-place rewrite of a file nor on a new folder two levels down (probe E1: Claude
 * rewriting `index.tsx`, a second component of a namespace). Nothing is read: stats only.
 *
 * - `components`: one signature per namespace folder of components_dir (`acme`), over every file of its component
 *   folders — what componentFolderHash (the library key's and the preview allow-list's definition of a component's
 *   content) reads; an in-place rewrite moves it.
 * - `themes`: one signature per real folder of templates_dir (the editor's themeStatSignature walk: the files the
 *   theme content hash covers).
 * - `site`: one signature of `.retake/site/` (the folder and each extraction's site.json).
 *
 * The library view's memo (operations/library.ts) is keyed on the same walks; the Studio's event stream (ui live.ts)
 * diffs them each poll and says which themes / namespaces changed, and that an extraction appeared. (L7.17: moved from
 * the Studio's server with library_view, whose memo reads them.)
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from '@retake/core';
import { editor } from './lazy.js';

/** Entries a tree signature looks at, at most (a component folder is a handful of files). */
export const WATCH_ENTRIES_MAX = 5000;
/** Folder depth a tree signature walks, at most. */
export const WATCH_DEPTH_MAX = 6;
/** Namespaces / themes / site extractions looked at, at most. */
export const WATCH_FOLDERS_MAX = 500;
/**
 * Entries one scan looks at over every folder, at most (review A L4: the per-folder bounds alone allow 500 × 5,000
 * lstat calls a second on the Studio's event loop). Spent: the folders left get a coarse signature — their own stat
 * (an entry added or removed moves it; a file rewritten in place there is not seen until the tree is smaller).
 */
export const WATCH_SCAN_BUDGET = 20_000;

/** A scan's shared entry budget. */
export interface WatchBudget {
  left: number;
}

export function watchBudget(entries = WATCH_SCAN_BUDGET): WatchBudget {
  return { left: entries };
}

const SKIP = new Set(['node_modules']);

function names(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * The stat signature of every file under `dir` (16 hex): relative names, sizes and mtimes; a link is named with its own
 * mtime, never followed; dot entries and node_modules skipped; at most WATCH_ENTRIES_MAX entries and WATCH_DEPTH_MAX
 * levels (beyond: counted as "truncated"). A missing folder is "-".
 */
export function treeSignature(dir: string, budget?: WatchBudget): string {
  try {
    if (!lstatSync(dir).isDirectory()) return '-';
  } catch {
    return '-';
  }
  if (budget && budget.left <= 0) return coarse(dir);
  const h = createHash('sha256');
  let seen = 0;
  let stop = false;
  const walk = (d: string, rel: string, depth: number) => {
    for (const n of names(d)) {
      if (stop) return;
      if (n.startsWith('.') || SKIP.has(n)) continue;
      if (++seen > WATCH_ENTRIES_MAX || (budget && budget.left-- <= 0)) {
        h.update('truncated\0');
        stop = true;
        return;
      }
      const p = join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) h.update(`${r}\0link\0${st.mtimeMs}\0`);
      else if (st.isDirectory()) {
        h.update(`${r}/\0`);
        if (depth < WATCH_DEPTH_MAX) walk(p, r, depth + 1);
        else h.update('deep\0');
      } else h.update(`${r}\0${st.size}\0${st.mtimeMs}\0${st.ino}\0`);
    }
  };
  walk(dir, '', 1);
  return h.digest('hex').slice(0, 16);
}

/** Folders of `dir` that are real folders (not links), not hidden, sorted, at most WATCH_FOLDERS_MAX. */
function realFolders(dir: string): string[] {
  const out: string[] = [];
  for (const n of names(dir)) {
    if (out.length >= WATCH_FOLDERS_MAX) break;
    if (n.startsWith('.')) continue;
    try {
      if (lstatSync(join(dir, n)).isDirectory()) out.push(n);
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** One signature per namespace folder of components_dir: every file of its component folders (see the header). */
export function componentNamespaceSignatures(componentsDir: string, budget: WatchBudget = watchBudget()): Map<string, string> {
  const out = new Map<string, string>();
  for (const ns of realFolders(componentsDir)) out.set(ns, treeSignature(join(componentsDir, ns), budget));
  return out;
}

/** One signature per real theme folder of templates_dir (themeStatSignature: the files of the theme content hash). */
export async function themeSignatures(templatesDir: string, budget: WatchBudget = watchBudget()): Promise<Map<string, string>> {
  const { themeStatSignature } = await editor();
  const out = new Map<string, string>();
  for (const name of realFolders(templatesDir)) {
    const dir = join(templatesDir, name);
    out.set(name, budget.left <= 0 ? coarse(dir) : themeStatSignature(dir, { budget }));
  }
  return out;
}

/** A folder's coarse signature once the scan's budget is spent: its own stat only. */
function coarse(dir: string): string {
  return `coarse ${statSig(dir)}`;
}

const statSig = (p: string): string => {
  try {
    const st = lstatSync(p);
    return `${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return '-';
  }
};

/** The signature of `.retake/site/`: the folder, and each extraction folder's own stat and site.json's. */
export function siteSignature(root: string): string {
  const dir = statePath(root, 'site');
  const parts = [statSig(statePath(root)), statSig(dir)];
  for (const id of realFolders(dir)) parts.push(`${id}=${statSig(join(dir, id))}|${statSig(join(dir, id, 'site.json'))}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** Everything the library / theme screens watch, as one map: `components:<ns>`, `themes:<name>`, `site`. */
export async function libraryWatchScan(o: { root: string; componentsDir: string; templatesDir: string; budget?: number }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // One budget for the whole scan (review A L4); site extractions are at most WATCH_FOLDERS_MAX stats, outside it.
  const budget = watchBudget(o.budget);
  for (const [ns, sig] of componentNamespaceSignatures(o.componentsDir, budget)) out.set(`components:${ns}`, sig);
  for (const [name, sig] of await themeSignatures(o.templatesDir, budget)) out.set(`themes:${name}`, sig);
  out.set('site', siteSignature(o.root));
  return out;
}

/** What changed between two scans, as the `workspace` event says it (only the fields that changed). */
export function libraryChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): { themes?: string[]; components?: string[]; site?: true } {
  const themes = new Set<string>();
  const comps = new Set<string>();
  let site = false;
  const note = (k: string) => {
    if (k === 'site') site = true;
    else if (k.startsWith('themes:')) themes.add(k.slice(7));
    else if (k.startsWith('components:')) comps.add(k.slice(11));
  };
  for (const [k, v] of after) if (before.get(k) !== v) note(k);
  for (const k of before.keys()) if (!after.has(k)) note(k);
  return { ...(themes.size ? { themes: [...themes].sort() } : {}), ...(comps.size ? { components: [...comps].sort() } : {}), ...(site ? { site: true as const } : {}) };
}
