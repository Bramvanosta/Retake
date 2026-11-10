/**
 * Pruning a project's generated folders (L5.7, R-FLD-28): `runs/`, `renders/` and `review/` grow with every take and
 * render (24 GB in three days on the first real use). Kept: the last succeeded capture of each scenario, every take a
 * kept render or a comment thread uses, the last `keep_renders` succeeded renders of each scenario and variant (and
 * every render a thread was made or resolved on), their reviews, and whatever a queued or running job names. Deleted:
 * failed, cancelled and interrupted takes, dry runs, older captures nothing uses, older and failed renders, reviews of
 * renders that are gone. A dry run (the default) deletes nothing and says what would go and how much it frees.
 * `exports/` is never touched.
 *
 * A scenario's last renders are counted among its renders only: the records whose id is `<their scenario>-v<N>`, as
 * the tool names them (refs.ts isRenderOfItsScenario — what `latest` picks). Any other record of renders/ (a video
 * written there under another name, a name past the id's length or version) is no render of the count: it never takes
 * a render's place, it stays with its review and its take when it succeeded, and goes only when it failed or was
 * cancelled.
 *
 * What cannot be read is never read as "no thread": when the comment threads cannot be listed, every render and every
 * take stays (a thread may name any of them); when a thread file or a scenario's folder of comments/ does not read as
 * threads (broken, a link, in the wrong place), every render and take of that scenario stays — a scenario named
 * without regard to case, as a folder of comments/ may be. The result says so (`threads_unread`). `only` limits a
 * deletion to the items a person approved (an agent's prune: engine `projects.prune` asks first, approvals.ts
 * `takePruneApproval`).
 */
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedProject } from '@retake/core';
import { listCommentsAndUnread } from './comments/views.js';
import { editor } from './lazy.js';
import { isRenderOfItsScenario } from './refs.js';
import { isMadeRunId, parseRenderId, projectPath, projectRef, runIdOfScenario } from '@retake/core';

/** Renders kept per scenario and variant (and their reviews). */
export const DEFAULT_KEEP_RENDERS = 3;

export interface PruneRequest {
  /** Default DEFAULT_KEEP_RENDERS. */
  keep_renders?: number;
  /** Default true: delete nothing, report. */
  dry_run?: boolean;
  /** Ids a queued or running job names (never deleted). */
  busy?: (id: string) => boolean;
  /**
   * Delete only these (`pruneKey`: `<kind>:<id>` → the paths it had then), among what can go now: what a person
   * approved. One of them that something uses by now stays (`skipped`), and so does whatever became prunable since
   * (`not_asked`); of an approved item, only the paths it had then go (a file added since stays).
   */
  only?: ReadonlyMap<string, readonly string[]>;
}

/** An item's key in `PruneRequest.only`. */
export function pruneKey(i: Pick<PruneItem, 'kind' | 'id'>): string {
  return `${i.kind}:${i.id}`;
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
  /** With `only`: the approved items that could not go any more (something uses them now, or they are gone) — kept. */
  skipped?: Array<{ kind: PruneItem['kind']; id: string }>;
  /** With `only`: how many items can go now that were not approved — kept. */
  not_asked?: number;
  /**
   * Set when comment threads could not be read and something stays for it: which, and what. The threads cannot be
   * listed at all: no render and no take is an item — a thread may name any of them —, whatever `keep_renders` says.
   * Some thread files or scenario folders do not read as threads: no render and no take of their scenarios is an item
   * (the scenarios named are those a render or a take of the project is of).
   */
  threads_unread?: string;
}

async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await readdir(path).catch(() => [] as string[])) n += await sizeOf(join(path, e));
  return n;
}

/** What prune reads of a run.json: the members its own rule decides on, as the file says them. */
interface PruneRun {
  id: string;
  status: string;
  mode?: unknown;
  scenario: string;
}

/**
 * Prune's own read of a run.json — NOT the one reader of the run folders (core/io readRunRecord), on purpose: what
 * prune keeps and deletes is decided in a lot of its own, and until then it reads as it always has (any JSON object
 * with a text `id` and `status`; a link is followed; the format's version is not looked at). Sending it through the
 * reader would change what it keeps (a linked run folder, a record of a newer Retake).
 */
async function pruneReadRun(dir: string): Promise<PruneRun | null> {
  try {
    const r = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as PruneRun | null;
    return r && typeof r.id === 'string' && typeof r.status === 'string' ? r : null;
  } catch {
    return null;
  }
}

/**
 * The last capture of each scenario BY ITS RECORD — prune's own rule until that decision, NOT the usable-capture rule
 * (core takeOf): the newest run whose run.json says a capture that succeeded, whether or not its timeline and its film
 * are there. `runs`: oldest first (the last of a scenario wins).
 */
function pruneLastCapture(runs: readonly PruneRun[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const r of runs) if (r.mode === 'capture' && r.status === 'succeeded') last.set(r.scenario, r.id);
  return last;
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

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
  // Every render and take stays (the threads are not listed), or those of these scenarios (some threads are not read).
  let keepAll = false;
  let notListed: string | undefined;
  const keepOf: string[] = [];
  try {
    const { list, unread } = await listCommentsAndUnread(project, { status: 'all' });
    for (const t of list.threads) {
      threadRenders.add(t.render_id);
      threadRuns.add(t.run_id);
      if (t.resolution?.render_id) threadRenders.add(t.resolution.render_id);
    }
    // Not "no thread" either: a file or a folder that does not read as threads may hold one of its scenario.
    if (unread.all) keepAll = true;
    else keepOf.push(...unread.scenarios);
  } catch (e) {
    // Not "no threads": what a thread could keep is unknown, so every render and every take stays.
    const why = (e as NodeJS.ErrnoException | null)?.code;
    keepAll = true;
    notListed = `the comment threads of ${project.slug} cannot be listed${typeof why === 'string' && /^[A-Z0-9_]{1,40}$/.test(why) ? ` (${why})` : ''}: every render and take is kept (make ${projectRef('comments')}/ of the project readable, then prune again)`;
  }
  /**
   * Whether an unread thread may name this render or take: one of a scenario whose threads are not all read — by the
   * scenario its record names or by the one its id names, without regard to case (a folder of comments/ on a disk that
   * ignores case may differ from its scenario by case only). `held`: the unread scenarios something stays for.
   */
  const held = new Set<string>();
  const unreadBy = (...is: Array<(s: string) => boolean>): boolean => {
    let any = keepAll;
    for (const s of keepOf) {
      if (is.some((f) => f(s))) {
        held.add(s);
        any = true;
      }
    }
    return any;
  };
  const sameName = (a: unknown, s: string): boolean => typeof a === 'string' && a.toLowerCase() === s.toLowerCase();
  const unreadRender = (r: { id: string; scenario: string }) => unreadBy((s) => sameName(r.scenario, s), (s) => sameName(parseRenderId(r.id)?.scenario, s));
  const unreadRun = (r: { id: string; scenario: string }) => unreadBy((s) => sameName(r.scenario, s), (s) => runIdOfScenario(r.id, s));

  // Renders: the last `keepRenders` succeeded of each scenario and variant, and those a thread names.
  const ed = await editor();
  const renders = await ed.listRenders(project.dir);
  const rendersDir = projectPath(project.dir, 'renders');
  const rendersFiles = await readdir(rendersDir).catch(() => [] as string[]);
  const keptRenders = new Set<string>();
  const groups = new Map<string, typeof renders>();
  for (const r of renders) {
    // Counted: the renders of their scenario only. Another record that succeeded stays, in nobody's count.
    if (!isRenderOfItsScenario(r)) {
      if (r.status === 'succeeded') keptRenders.add(r.id);
      continue;
    }
    const key = `${r.scenario} ${r.variant}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  for (const g of groups.values()) {
    const ok = g.filter((r) => r.status === 'succeeded').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const r of ok.slice(-keepRenders)) keptRenders.add(r.id);
  }
  for (const r of renders) if (unreadRender(r) || threadRenders.has(r.id) || busy(r.id)) keptRenders.add(r.id);
  for (const r of renders) {
    if (keptRenders.has(r.id)) continue;
    // A record's files are named after its id: an id that is empty or starts with a dot names no render's files.
    if (r.id === '' || r.id.startsWith('.')) continue;
    const paths = rendersFiles.filter((f) => f === `${r.id}.json` || f.startsWith(`${r.id}.`)).map((f) => join(rendersDir, f));
    let bytes = 0;
    for (const p of paths) bytes += await sizeOf(p);
    items.push({ kind: 'render', id: r.id, scenario: r.scenario, reason: r.status === 'succeeded' ? 'older render' : `${r.status} render`, bytes, paths });
  }

  // Reviews: review/<render id>/ of the renders kept.
  const reviewDir = projectPath(project.dir, 'review');
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
  const runsDir = projectPath(project.dir, 'runs');
  const runs: PruneRun[] = [];
  const unreadable: string[] = [];
  for (const name of (await readdir(runsDir).catch(() => [] as string[])).sort()) {
    // Only a take of the shape the tool makes is ever a candidate (a folder named by hand stays).
    if (!isMadeRunId(name)) continue;
    const r = await pruneReadRun(join(runsDir, name));
    if (r) runs.push({ ...r, id: name });
    else unreadable.push(name);
  }
  const usedRuns = new Set<string>([...threadRuns]);
  for (const r of renders) if (keptRenders.has(r.id)) usedRuns.add(r.run_id);
  const lastCapture = pruneLastCapture(runs);
  let runsKept = unreadable.length;
  for (const r of runs) {
    const keep = unreadRun(r) || !FINISHED.has(r.status) || busy(r.id) || usedRuns.has(r.id) || lastCapture.get(r.scenario) === r.id;
    if (keep) {
      runsKept++;
      continue;
    }
    const path = join(runsDir, r.id);
    const reason = r.mode === 'dry' ? 'dry run' : r.status === 'succeeded' ? 'older capture nothing uses' : `${r.status} take`;
    items.push({ kind: 'run', id: r.id, scenario: r.scenario, reason, bytes: await sizeOf(path), paths: [path] });
  }

  // What stays for the threads that were not read: said with the scenarios something of theirs is here for.
  let threadsUnread = notListed;
  if (threadsUnread === undefined && keepAll) threadsUnread = `some comment threads of ${project.slug} cannot be read (the comment list says which): every render and take is kept`;
  else if (threadsUnread === undefined && held.size) {
    const names = keepOf.filter((s) => held.has(s));
    const named = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
    threadsUnread = `some comment threads of ${project.slug} cannot be read (the comment list says which): every render and take of ${named} is kept`;
  }

  // Only what a person approved, of what can still go now.
  let skipped: PruneResult['skipped'];
  let notAsked: number | undefined;
  if (req.only) {
    const only = req.only;
    const now = new Set(items.map(pruneKey));
    skipped = [...only.keys()].filter((k) => !now.has(k)).sort().map((k) => {
      const at = k.indexOf(':');
      return { kind: k.slice(0, at) as PruneItem['kind'], id: k.slice(at + 1) };
    });
    const unasked = items.filter((i) => !only.has(pruneKey(i)));
    notAsked = unasked.length;
    for (const i of unasked) {
      if (i.kind === 'run') runsKept++;
      else if (i.kind === 'render') keptRenders.add(i.id);
      else reviewsKept++;
    }
    const approved: PruneItem[] = [];
    for (const i of items) {
      const then = only.get(pruneKey(i));
      if (!then) continue;
      const paths = i.paths.filter((p) => then.includes(p));
      let bytes = 0;
      for (const p of paths) bytes += await sizeOf(p);
      approved.push({ ...i, paths, bytes });
    }
    items.splice(0, items.length, ...approved);
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
    ...(skipped ? { skipped, not_asked: notAsked ?? 0 } : {}),
    ...(threadsUnread !== undefined ? { threads_unread: threadsUnread } : {}),
  };
}

/** "1.2 GB", "340 MB", "12 kB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} kB`;
}
