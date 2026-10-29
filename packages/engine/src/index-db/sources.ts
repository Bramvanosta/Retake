/**
 * What the workspace index and the Studio's event stream watch (L4.1, critique C2): a bounded stat poll — never a
 * recursive fs.watch (no FSEvents flood from a capture's frames, deterministic tests). One scan stats, per project,
 * project.yaml (+ sandbox.yaml) and the scenarios/ folder, README.md, the runs/, renders/ and review/ folders (+ the run.json
 * of the runs it was told are unfinished), and the workspace's history.jsonl: a few stats per project, nothing read.
 *
 * A source is a key (`project:<slug>`, `readme:<slug>`, `runs:<slug>`, `renders:<slug>`, `scenario:<slug>/<name>`,
 * `history`) and a signature (inode, size, mtime of each file or folder it covers); a key whose signature changed is a
 * change to re-read. Each scenario file is signed on its own (L4.2): an in-place save changes no folder, and the
 * scenario screen re-reads only its own file's changes (critique B1). The index reads nothing for a scenario key (the
 * project key covers the list of names).
 *
 * Comments (L4.6, plan D9): `comments:<slug>/<scenario>` per real scenario folder of comments/ (at most
 * COMMENT_SOURCE_MAX_FOLDERS per project), signed by the folder's own stat — the store writes a thread or an entry by a
 * temp file renamed into that folder, which moves its mtime (probe E4); an in-place edit by hand does not. Nothing is
 * read for it either: the Studio re-reads its own scenario's threads.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceConfig } from '@demo-studio/core';
import { historyFile } from '../history.js';

export type SourceKind = 'project' | 'readme' | 'runs' | 'renders' | 'scenario' | 'comments' | 'history';

/** Scenario folders of comments/ watched per project, at most. */
export const COMMENT_SOURCE_MAX_FOLDERS = 200;
/** A scenario folder name of comments/ (core SLUG_RE). */
const COMMENT_FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A scenario file name (scenarios/<name>.yaml or .yml). */
const SCENARIO_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.ya?ml$/;

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

/** Scenario names of a scenarios/ folder → their files (.yaml, then .yml), sorted. */
async function scenarioFiles(dir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of names.sort()) {
    const m = SCENARIO_FILE_RE.exec(f);
    if (m) out.set(m[1], [...(out.get(m[1]) ?? []), f]);
  }
  return out;
}

/** The real scenario folders of a comments/ folder (no links, names of scenarios), sorted, at most COMMENT_SOURCE_MAX_FOLDERS. */
async function commentFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && COMMENT_FOLDER_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, COMMENT_SOURCE_MAX_FOLDERS);
  } catch {
    return [];
  }
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
    // L5.10a fixes (review A-L4): review/ too — a review run from a terminal swaps review/<id> in by a rename (no job,
    // no renders/ change): a board or a render list re-reads its verdict.
    out.set(`renders:${slug}`, `${await sig(join(dir, 'renders'))}|${await sig(join(dir, 'review'))}`);
    for (const [name, files] of await scenarioFiles(join(dir, 'scenarios'))) {
      out.set(`scenario:${slug}/${name}`, (await Promise.all(files.map((f) => sig(join(dir, 'scenarios', f))))).join('|'));
    }
    for (const name of await commentFolders(join(dir, 'comments'))) out.set(`comments:${slug}/${name}`, await sig(join(dir, 'comments', name)));
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

/** The kind and project of a source key (and the scenario name of a `scenario:` or `comments:` key). */
export function sourceKey(key: string): { kind: SourceKind; project?: string; scenario?: string } {
  const i = key.indexOf(':');
  if (i < 0) return { kind: key as SourceKind };
  const kind = key.slice(0, i) as SourceKind;
  const rest = key.slice(i + 1);
  if (kind !== 'scenario' && kind !== 'comments') return { kind, project: rest };
  const j = rest.indexOf('/');
  return { kind, project: rest.slice(0, j), scenario: rest.slice(j + 1) };
}

/**
 * What changed, as the event stream says it: projects touched (any key of theirs), READMEs changed, scenario files
 * changed, added or removed (`<slug>/<name>`) and — only when there are any — scenarios whose comment threads changed
 * (`comments`, `<slug>/<scenario>`: a thread created, an entry appended, a folder added or removed).
 */
export function workspaceChanges(keys: readonly string[]): { projects: string[]; readme: string[]; scenarios: string[]; comments?: string[]; history: boolean } {
  const projects = new Set<string>();
  const readme = new Set<string>();
  const scenarios = new Set<string>();
  const comments = new Set<string>();
  let history = false;
  for (const k of keys) {
    const { kind, project, scenario } = sourceKey(k);
    if (kind === 'history') history = true;
    if (project === undefined) continue;
    projects.add(project);
    if (kind === 'readme') readme.add(project);
    if (kind === 'scenario' && scenario !== undefined) scenarios.add(`${project}/${scenario}`);
    if (kind === 'comments' && scenario !== undefined) comments.add(`${project}/${scenario}`);
  }
  return { projects: [...projects].sort(), readme: [...readme].sort(), scenarios: [...scenarios].sort(), ...(comments.size ? { comments: [...comments].sort() } : {}), history };
}

/** A run of a project as the index holds it (what a run change is told from). */
export interface RunRow {
  id: string;
  scenario: string | null;
  status: string | null;
}

/**
 * A run that started, progressed, finished or went away (L4.2, critique B1): the `workspace` event names the run and
 * its scenario, so a scenario screen re-reads only for runs of its own scenario.
 */
export interface RunChange {
  project: string;
  run: string;
  scenario: string | null;
  status: string | null;
  finished: boolean;
  /** new: a run folder appeared; status: its status changed; progress: an unfinished run's run.json was rewritten; removed. */
  change: 'new' | 'status' | 'progress' | 'removed';
}

const FINISHED_RUN = new Set(['succeeded', 'failed', 'cancelled']);

/** The run.json signatures a `runs:<slug>` signature holds (`<id>=<sig>` parts: the unfinished runs it watched). */
function watchedRuns(sig: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (sig ?? '').split('|').slice(1)) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i), part.slice(i + 1));
  }
  return out;
}

/** The runs of a project that changed between two reads (rows) and two `runs:` signatures, by run id. */
export function runChanges(project: string, before: readonly RunRow[], after: readonly RunRow[], prevSig?: string, nextSig?: string): RunChange[] {
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const sigsBefore = watchedRuns(prevSig);
  const sigsAfter = watchedRuns(nextSig);
  const out: RunChange[] = [];
  const row = (r: RunRow, change: RunChange['change']): RunChange => ({ project, run: r.id, scenario: r.scenario, status: r.status, finished: FINISHED_RUN.has(r.status ?? ''), change });
  for (const r of after) {
    const o = old.get(r.id);
    if (!o) out.push(row(r, 'new'));
    else if (o.status !== r.status) out.push(row(r, 'status'));
    else if (!FINISHED_RUN.has(r.status ?? '') && sigsBefore.has(r.id) && sigsAfter.has(r.id) && sigsBefore.get(r.id) !== sigsAfter.get(r.id)) out.push(row(r, 'progress'));
  }
  for (const o of before) if (!now.has(o.id)) out.push({ ...row(o, 'removed'), finished: FINISHED_RUN.has(o.status ?? '') });
  return out.sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));
}
