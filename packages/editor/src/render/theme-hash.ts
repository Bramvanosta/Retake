/**
 * A theme folder's content (L4.5 fixes, review B #3): its hash, written in each render record (`template_sha256`) and
 * computed by the Studio's timeline view, so "from this version" also means "with the same theme files" — a font, a
 * logo or template.yaml changed since a render makes it another version; and a cheap signature of the same files
 * (size and mtime) for the timeline view's memo.
 *
 * Both walk the folder the same way: regular files only (a link is named, never followed), dot entries, node_modules
 * and previews skipped, at most THEME_FILES_MAX files; the hash reads at most THEME_HASH_BYTES_MAX bytes in all, a file
 * beyond that counted by its size and mtime.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Bytes of theme files read for the hash, at most (files beyond: by size and mtime). */
export const THEME_HASH_BYTES_MAX = 64 * 1024 * 1024;
/** Files of a theme folder looked at, at most. */
export const THEME_FILES_MAX = 2000;
const SKIP_DIRS = new Set(['node_modules', 'previews']);

type Entry = { rel: string; file: string; size: number; mtimeMs: number; link: boolean };

function walk(dir: string): Entry[] {
  const out: Entry[] = [];
  const go = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= THEME_FILES_MAX) return;
      if (n.startsWith('.')) continue;
      const p = join(d, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      const rel = relative(dir, p).split(sep).join('/');
      if (st.isSymbolicLink()) out.push({ rel, file: p, size: 0, mtimeMs: st.mtimeMs, link: true });
      else if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) go(p);
      } else if (st.isFile()) out.push({ rel, file: p, size: st.size, mtimeMs: st.mtimeMs, link: false });
    }
  };
  go(dir);
  return out;
}

/** The theme folder's content hash (16 hex; see the module comment). */
export function themeContentHash(dir: string): string {
  const h = createHash('sha256');
  let budget = THEME_HASH_BYTES_MAX;
  for (const e of walk(dir)) {
    h.update(`${e.rel}\0`);
    if (e.link) h.update('link\0');
    else if (e.size <= budget) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(e.file);
      } catch {
        h.update('unreadable\0');
        continue;
      }
      budget -= bytes.length;
      h.update(`${bytes.length}\0`).update(bytes).update('\0');
    } else h.update(`stat ${e.size} ${e.mtimeMs}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

/** A cheap signature of the theme folder's files: names, sizes and mtimes (16 hex). */
export function themeStatSignature(dir: string): string {
  const h = createHash('sha256');
  for (const e of walk(dir)) h.update(`${e.rel}\0${e.link ? 'link' : e.size}\0${e.mtimeMs}\0`);
  return h.digest('hex').slice(0, 16);
}
