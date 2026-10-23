/**
 * What the workspace index and the Studio's event stream watch (L4.1, critique C2): a bounded stat poll — never a
 * recursive fs.watch (no FSEvents flood from a capture's frames, deterministic tests). One scan stats, per project,
 * project.yaml (+ sandbox.yaml) and the scenarios/ folder, README.md, the runs/ and renders/ folders (+ the run.json
 * of the runs it was told are unfinished), and the workspace's history.jsonl: a few stats per project, nothing read.
 *
 * A source is a key (`project:<slug>`, `readme:<slug>`, `runs:<slug>`, `renders:<slug>`, `history`) and a signature
 * (inode, size, mtime of each file or folder it covers); a key whose signature changed is a change to re-read.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceConfig } from '@demo-studio/core';
import { historyFile } from '../history.js';

export type SourceKind = 'project' | 'readme' | 'runs' | 'renders' | 'history';

/** `kind:slug` (`history` alone) → signature. */
export type SourceMap = Map<string, string>;

async function sig(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** Project folders of the workspace (a folder of projects_dir holding a project.yaml), by slug. */
async function projectSlugs(ws: WorkspaceConfig): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(ws.projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  // As core's listProjects: real folders, not hidden.
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

/**
 * Signatures of every source of the workspace. `unfinished` names, per project, the runs whose run.json is still being
 * written (the runner rewrites it in place while it runs: the runs/ folder alone would not change).
 */
export async function scanSources(ws: WorkspaceConfig, unfinished: ReadonlyMap<string, readonly string[]> = new Map()): Promise<SourceMap> {
  const out: SourceMap = new Map();
  for (const slug of await projectSlugs(ws)) {
    const dir = join(ws.projectsDir, slug);
    const yaml = await sig(join(dir, 'project.yaml'));
    if (yaml === '-') continue;
    out.set(`project:${slug}`, [yaml, await sig(join(dir, 'sandbox.yaml')), await sig(join(dir, 'scenarios'))].join('|'));
    out.set(`readme:${slug}`, await sig(join(dir, 'README.md')));
    const runs = [await sig(join(dir, 'runs'))];
    for (const id of unfinished.get(slug) ?? []) runs.push(`${id}=${await sig(join(dir, 'runs', id, 'run.json'))}`);
    out.set(`runs:${slug}`, runs.join('|'));
    out.set(`renders:${slug}`, await sig(join(dir, 'renders')));
  }
  out.set('history', await sig(historyFile(ws.root)));
  return out;
}

/** Keys added, removed or with another signature, sorted. */
export function diffSources(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const changed = new Set<string>();
  for (const [k, v] of after) if (before.get(k) !== v) changed.add(k);
  for (const k of before.keys()) if (!after.has(k)) changed.add(k);
  return [...changed].sort();
}

/** The kind and project of a source key. */
export function sourceKey(key: string): { kind: SourceKind; project?: string } {
  const i = key.indexOf(':');
  return i < 0 ? { kind: key as SourceKind } : { kind: key.slice(0, i) as SourceKind, project: key.slice(i + 1) };
}

/** What changed, as the event stream says it: projects touched (any key of theirs) and READMEs changed. */
export function workspaceChanges(keys: readonly string[]): { projects: string[]; readme: string[]; history: boolean } {
  const projects = new Set<string>();
  const readme = new Set<string>();
  let history = false;
  for (const k of keys) {
    const { kind, project } = sourceKey(k);
    if (kind === 'history') history = true;
    if (project === undefined) continue;
    projects.add(project);
    if (kind === 'readme') readme.add(project);
  }
  return { projects: [...projects].sort(), readme: [...readme].sort(), history };
}
