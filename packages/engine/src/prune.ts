/**
 * Pruning a project's generated folders (L5.7, R-FLD-28): `runs/`, `renders/` and `review/` grow with every take and
 * render (24 GB in three days on the first real use). Kept: the last succeeded capture of each scenario, every take a
 * kept render or a comment thread uses, the last `keep_renders` succeeded renders of each scenario and variant (and
 * every render a thread was made or resolved on), their reviews, and whatever a queued or running job names. Deleted:
 * failed, cancelled and interrupted takes, dry runs, older captures nothing uses, older and failed renders, reviews of
 * renders that are gone. A dry run (the default) deletes nothing and says what would go and how much it frees.
 * `exports/` is never touched.
 */
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedProject, RunRecord } from '@demo-studio/core';
import { listComments } from './comments.js';
import { editor } from './jobs/render-job.js';

/** Renders kept per scenario and variant (and their reviews). */
export const DEFAULT_KEEP_RENDERS = 3;

export interface PruneRequest {
  /** Default DEFAULT_KEEP_RENDERS. */
  keep_renders?: number;
  /** Default true: delete nothing, report. */
  dry_run?: boolean;
  /** Ids a queued or running job names (never deleted). */
  busy?: (id: string) => boolean;
}

export interface PruneItem {
  kind: 'run' | 'render' | 'review';
  id: string;
  scenario?: string;
  /** Why it goes ("failed take", "dry run", "older capture", "older render", "failed render", "review of a deleted render"). */
  reason: string;
  bytes: number;
  /** Paths removed (a render: its record, its video and its other files). */
  paths: string[];
}

export interface PruneResult {
  project: string;
  dry_run: boolean;
  keep_renders: number;
  items: PruneItem[];
  /** What it frees (or would free). */
  bytes: number;
  kept: { runs: number; renders: number; reviews: number };
  /** Paths that could not be removed. */
  problems: string[];
}

async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await readdir(path).catch(() => [] as string[])) n += await sizeOf(join(path, e));
  return n;
}

async function readRun(dir: string): Promise<RunRecord | null> {
  try {
    const r = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunRecord;
    return r && typeof r.id === 'string' && typeof r.status === 'string' ? r : null;
  } catch {
    return null;
  }
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9-]*$/;

/** See the module comment. */
export async function pruneProject(project: LoadedProject, req: PruneRequest = {}): Promise<PruneResult> {
  const keepRenders = req.keep_renders ?? DEFAULT_KEEP_RENDERS;
  if (!Number.isInteger(keepRenders) || keepRenders < 1) throw new Error(`keep_renders ${String(req.keep_renders)}: a whole number from 1`);
  const dry = req.dry_run !== false;
  const busy = req.busy ?? (() => false);
  const items: PruneItem[] = [];

  // Comment threads: the render each was made (or resolved) on, and that render's take.
  const threadRenders = new Set<string>();
  const threadRuns = new Set<string>();
  try {
    const list = await listComments(project, { status: 'all' });
    for (const t of list.threads) {
      threadRenders.add(t.render_id);
      threadRuns.add(t.run_id);
      if (t.resolution?.render_id) threadRenders.add(t.resolution.render_id);
    }
  } catch {
    /* no threads */
  }

  // Renders: the last `keepRenders` succeeded of each scenario and variant, and those a thread names.
  const ed = await editor();
  const renders = await ed.listRenders(project.dir);
  const rendersDir = join(project.dir, 'renders');
  const rendersFiles = await readdir(rendersDir).catch(() => [] as string[]);
  const keptRenders = new Set<string>();
  const groups = new Map<string, typeof renders>();
  for (const r of renders) {
    const key = `${r.scenario} ${r.variant}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  for (const g of groups.values()) {
    const ok = g.filter((r) => r.status === 'succeeded').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const r of ok.slice(-keepRenders)) keptRenders.add(r.id);
  }
  for (const r of renders) if (threadRenders.has(r.id) || busy(r.id)) keptRenders.add(r.id);
  for (const r of renders) {
    if (keptRenders.has(r.id)) continue;
    const paths = rendersFiles.filter((f) => f === `${r.id}.json` || f.startsWith(`${r.id}.`)).map((f) => join(rendersDir, f));
    let bytes = 0;
    for (const p of paths) bytes += await sizeOf(p);
    items.push({ kind: 'render', id: r.id, scenario: r.scenario, reason: r.status === 'succeeded' ? 'older render' : `${r.status} render`, bytes, paths });
  }

  // Reviews: review/<render id>/ of the renders kept.
  const reviewDir = join(project.dir, 'review');
  let reviewsKept = 0;
  for (const name of await readdir(reviewDir).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const path = join(reviewDir, name);
    if (!(await lstat(path).catch(() => null))?.isDirectory()) continue;
    if (keptRenders.has(name) || busy(name)) {
      reviewsKept++;
      continue;
    }
    const known = renders.some((r) => r.id === name);
    items.push({ kind: 'review', id: name, reason: known ? 'review of an older render' : 'review of a deleted render', bytes: await sizeOf(path), paths: [path] });
  }

  // Takes: the last succeeded capture per scenario, and every take a kept render or a thread uses.
  const runsDir = join(project.dir, 'runs');
  const runs: RunRecord[] = [];
  const unreadable: string[] = [];
  for (const name of (await readdir(runsDir).catch(() => [] as string[])).sort()) {
    if (!RUN_ID_RE.test(name)) continue;
    const r = await readRun(join(runsDir, name));
    if (r) runs.push({ ...r, id: name });
    else unreadable.push(name);
  }
  const usedRuns = new Set<string>([...threadRuns]);
  for (const r of renders) if (keptRenders.has(r.id)) usedRuns.add(r.run_id);
  const lastCapture = new Map<string, string>();
  for (const r of runs) if (r.mode === 'capture' && r.status === 'succeeded') lastCapture.set(r.scenario, r.id);
  let runsKept = unreadable.length;
  for (const r of runs) {
    const keep = !FINISHED.has(r.status) || busy(r.id) || usedRuns.has(r.id) || lastCapture.get(r.scenario) === r.id;
    if (keep) {
      runsKept++;
      continue;
    }
    const path = join(runsDir, r.id);
    const reason = r.mode === 'dry' ? 'dry run' : r.status === 'succeeded' ? 'older capture nothing uses' : `${r.status} take`;
    items.push({ kind: 'run', id: r.id, scenario: r.scenario, reason, bytes: await sizeOf(path), paths: [path] });
  }

  const problems: string[] = [];
  if (!dry) {
    for (const it of items) {
      for (const p of it.paths) {
        await rm(p, { recursive: true, force: true }).catch((e: unknown) => problems.push(`${p}: ${(e as Error).message}`));
      }
    }
  }
  const order = { run: 0, render: 1, review: 2 } as const;
  items.sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
  return {
    project: project.slug,
    dry_run: dry,
    keep_renders: keepRenders,
    items,
    bytes: items.reduce((n, i) => n + i.bytes, 0),
    kept: { runs: runsKept, renders: keptRenders.size, reviews: reviewsKept },
    problems,
  };
}

/** "1.2 GB", "340 MB", "12 kB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} kB`;
}
