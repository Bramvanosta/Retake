/**
 * What the Record screen watches (L4.8): each recording folder's own files — events.jsonl (the runner streams it while
 * the window is open), studio.json (the annotations: another tab arranged the draft), record.json (the draft and the
 * check written) and meta.json (the folder created) — by size and mtime. Nothing is read: stats only, never through a
 * link. The event stream (live.ts) diffs the scans each poll and names the recordings that changed
 * (`workspace {records: ['<project>/<rec_id>']}`): a Record screen re-reads its own recording's view then, on top of its
 * own poll while the recording is live. A project whose `.retake` or records folder is a link is not looked into
 * (reads never follow a link out of a project).
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_SLUG_RE, RECORD_ID_RE } from '@retake/core';

/** Recording folders looked at per project, at most (the newest; the records folder keeps about 20). */
export const RECORD_WATCH_PER_PROJECT = 40;
/** Projects looked at, at most. */
export const RECORD_WATCH_PROJECTS_MAX = 200;
const FILES = ['events.jsonl', 'studio.json', 'record.json', 'meta.json'] as const;

function stamp(file: string): string {
  try {
    const s = lstatSync(file);
    return s.isFile() ? `${s.size}:${s.mtimeMs}` : s.isSymbolicLink() ? 'link' : '?';
  } catch {
    return '-';
  }
}

function dirs(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && re.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** A real folder (lstat: not a link). */
function realDir(dir: string): boolean {
  try {
    const s = lstatSync(dir);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}

/** `<project>/<rec_id>` → the stat signature of its files, for every project of `projectsDir` (real folders only). */
export function recordsWatchScan(projectsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const slug of dirs(projectsDir, PROJECT_SLUG_RE).sort().slice(0, RECORD_WATCH_PROJECTS_MAX)) {
    const root = join(projectsDir, slug, '.retake', 'records');
    if (!realDir(join(projectsDir, slug, '.retake')) || !realDir(root)) continue;
    for (const id of dirs(root, RECORD_ID_RE).sort().reverse().slice(0, RECORD_WATCH_PER_PROJECT)) {
      out.set(`${slug}/${id}`, FILES.map((f) => stamp(join(root, id, f))).join('|'));
    }
  }
  return out;
}

/** The recordings whose folder appeared, went away or whose files changed between two scans (sorted). */
export function recordsChanges(prev: Map<string, string>, next: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [k, v] of next) if (prev.get(k) !== v) changed.add(k);
  for (const k of prev.keys()) if (!next.has(k)) changed.add(k);
  return [...changed].sort();
}
