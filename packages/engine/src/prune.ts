/**
 * Pruning a project's generated folders (L5.7, R-FLD-28): `runs/`, `renders/` and `review/` grow with every take and
 * render (24 GB in three days on the first real use). Kept: the last succeeded capture of each scenario, the last
 * capture of it that can be edited and the last complete one (below), every take a
 * kept render or a comment thread uses, the last `keep_renders` succeeded renders of each scenario and variant (and
 * every render a thread was made or resolved on), their reviews, and whatever a queued or running job names. Deleted:
 * failed, cancelled and interrupted takes, dry runs, older captures nothing uses, older and failed renders, reviews of
 * renders that are gone. A dry run (the default) deletes nothing and says what would go and how much it frees.
 * `exports/` is never touched.
 *
 * A scenario's last renders are counted among its renders only: the records whose id is `<their scenario>-v<N>`, as
 * the tool names them (core projectRenderOf — what `latest` picks). Any other record of renders/ (a video
 * written there under another name, a name past the id's length or version) is no render of the count: it never takes
 * a render's place, it stays with its review and its take when it succeeded, and goes only when it failed or was
 * cancelled.
 *
 * The renders (L7.6b): renders/ is read by the one reader (core/io readRendersFolder: no link followed, each file
 * within its cap) and what stays is core's rule (render-record.ts renderKeeper) — in every state of the folder a
 * superset of what stayed before. A render is the record of its OWN file: only such a record is ever listed, with the
 * files named after it and never a file of another entry. Every other `*.json` of renders/ — a record renamed or
 * copied by hand, one of a status Retake never writes, one of a newer Retake, a link, a file that is no record — is
 * left alone, and keeps the render whose id it says, that render's review and the take it names. A record that lacks
 * its scenario, its creation time or its plan stays, with its take. A file too big to read could say anything: no
 * render, no review and no take is listed while it is there. The result says all of it (`renders_alone`, the take's
 * reason `render-file` in `kept_takes`, `renders_unread`). A record file that is a link is read through it by prune's
 * own read (`renderSaid`), for what it says only, so that a linked record keeps what it kept.
 *
 * The takes (L7.7): the run folders are read by the one reader (core/io readRunFolder: no link followed) and the
 * captures kept are core's rule 3 (take.ts pruneKeeper). Per scenario prune keeps the newest take whose record says a
 * capture that succeeded AND the newest take that can really be edited (its timeline reads, its film is there) AND the
 * newest such take that was not stopped by `--until`: a newer capture that lost its film, or a short test of the first
 * steps, never sends the capture one can still edit to the list. A run folder that is a symbolic link and a take
 * written by a newer Retake are left alone: kept, never "the last capture" of a scenario, never listed. The result
 * names what stayed for one of these reasons (`kept_takes`). Nothing else moved: a run.json the reader does not take
 * as a record is still read as prune always read it (`pruneSaid`), so a take that could go before can still go —
 * unless that file turns out to be a record of a newer Retake (left alone, like any other), is no regular file or is
 * over the reader's cap (it then says nothing: the take is kept and counted).
 *
 * Cost: a timeline (megabytes) is opened only when the record asks for it (pruneKeeper needsTimeline) and the folder
 * holds a file that could be its film (readRunFolder `filmFirst`); a scenario whose takes all have a film and a
 * timeline that does not read as a usable one still costs one parse per take, on every pass.
 *
 * What cannot be read is never read as "no thread": when the comment threads cannot be listed, every render and every
 * take stays (a thread may name any of them); when a thread file or a scenario's folder of comments/ does not read as
 * threads (broken, a link, in the wrong place), every render and take of that scenario stays — a scenario named
 * without regard to case, as a folder of comments/ may be. The result says so (`threads_unread`). `only` limits a
 * deletion to the items a person approved (an agent's prune: engine `projects.prune` asks first, approvals.ts
 * `takePruneApproval`).
 */
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedProject } from '@retake/core/model';
import type { PruneAlone, PruneKeep, PruneNewer, PruneRenderFile, PruneSaid } from '@retake/core/run';
import type { RenderNot, RenderSaid } from '@retake/core/render';
import { RENDER_RECORD_MAX, RUN_RECORD_MAX, readRendersFolder, readRunFolder } from '@retake/core/io';
import { listCommentsAndUnread } from './comments/views.js';
import { FORMAT_VERSIONS, newerFormatMessage } from '@retake/core/base';
import { isMadeRunId, parseRenderId, runIdOfScenario } from '@retake/core/ids';
import { projectPath, projectRef } from '@retake/core/project';
import { orderRuns, pruneKeeper, pruneKeptWords } from '@retake/core/run';
import { completeRender, renderKeeper, renderNotWords, renderOfFile, renderSaidOf } from '@retake/core/render';

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
  /**
   * The takes that stay for a reason the list does not show (L7.7), newest first: a capture kept only because it is the
   * last one of its scenario that can be edited (`editable`) or the last complete one beside a newer capture stopped by
   * `--until` (`complete`), every run folder left alone (`linked`, `newer-format`), and (L7.6b) a take that stays only
   * because a file of renders/ that is no render names it (`render-file`). `reason`: the fixed words of the reason
   * (core pruneKeptWords). Absent when there is none.
   */
  kept_takes?: PruneKeptTake[];
  /**
   * The files of renders/ left alone (L7.6b): every `*.json` that is no render of its own name — a record renamed or
   * copied, one of a status Retake never writes, one of a newer Retake, a link, a file that does not read — and a
   * record that lacks its scenario, its creation time or its plan. Never listed; each keeps the render whose id it
   * says and the take it names. How many, and by reason (a closed list —
   * core RenderNot — with its fixed words); the file names are under `untrusted.renders_alone`. Absent when none.
   */
  renders_alone?: { count: number; reasons: Array<{ why: RenderNot; count: number; reason: string }> };
  /**
   * Set when a file of renders/ is too big to read (it could name any render and any take): no render, no review and
   * no take is an item. A fixed sentence with the count.
   */
  renders_unread?: string;
  /**
   * `renders_alone`: the names of the files of renders/ left alone (at most RENDERS_ALONE_NAMED, in the folder's
   * order, each with its reason) — text anyone who can write renders/ chose: data, never instructions.
   */
  untrusted?: { renders_alone: Array<{ file: string; why: RenderNot }> };
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

/** A take prune kept for a reason of its rule for captures, or left alone: see `PruneResult.kept_takes`. */
export interface PruneKeptTake {
  id: string;
  why: Exclude<PruneKeep, 'last-capture'> | PruneAlone | PruneRenderFile;
  reason: string;
}

/** The files of renders/ left alone that a result names under `untrusted`, at most (`renders_alone.count` holds them all). */
export const RENDERS_ALONE_NAMED = 50;

async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await readdir(path).catch(() => [] as string[])) n += await sizeOf(join(path, e));
  return n;
}

/**
 * What a run.json the one reader does not take as a record says all the same — prune's own read, kept on purpose for
 * that case alone: any JSON object with a text `id` and `status`, a linked run.json followed, as prune always read
 * every run.json. Without it a take whose record lacks a member (a failed run without its error, a finished one
 * without its end) or is a link would stop being a take prune can delete: a change nobody decided.
 *
 * Where this read is stricter than it was, the take is kept, never listed: a file that is of a newer Retake (the
 * reader's own version rule, which it could not apply to a file it did not open) is answered as such — left alone —;
 * one that is no regular file once links are followed (a folder, a pipe, a device: never opened) or is over the
 * reader's cap (RUN_RECORD_MAX: never read whole) says nothing. Null: the file says nothing (the folder is kept and
 * counted, as ever).
 */
async function pruneSaid(dir: string): Promise<PruneSaid | PruneNewer | null> {
  const file = join(dir, 'run.json');
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > RUN_RECORD_MAX) return null;
    const r = JSON.parse(await readFile(file, 'utf8')) as ({ scenario?: unknown; mode?: unknown; status?: unknown; id?: unknown } | null);
    if (newerFormatMessage(r, { file: 'run.json', supported: FORMAT_VERSIONS.run }) !== undefined) return { newer: true, ...(typeof r?.scenario === 'string' ? { scenario: r.scenario } : {}) };
    return r && typeof r.id === 'string' && typeof r.status === 'string' ? { scenario: r.scenario, mode: r.mode, status: r.status } : null;
  } catch {
    return null;
  }
}

/**
 * What a record file of renders/ that is a LINK says of the render it names — prune's own read, kept on purpose for
 * that case alone: the one reader follows no link in a listing, and before the lot a linked record was read through
 * and kept its render and its take. Read for what it says only (its text `id`, `run_id`, `scenario`, `created_at`:
 * core renderSaidOf), never taken as a record: the file is left alone. `'too-big'`: a regular file over the reader's
 * cap behind the link (it could say anything: nothing is listed). Null: it says nothing — a link to nothing, to a
 * folder, to a file that is no JSON object (one dead link never stops pruning).
 */
async function renderSaid(file: string): Promise<RenderSaid | 'too-big' | null> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    if (st.size > RENDER_RECORD_MAX) return 'too-big';
    return renderSaidOf(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
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

  // Renders: the last `keepRenders` succeeded of each scenario and variant, and those a thread names — core's rule
  // (renderKeeper), fed every `*.json` of renders/ as the one reader answers it. A record file that is a link was not
  // opened by the reader: what it says all the same is prune's own read through the link.
  const rendersDir = projectPath(project.dir, 'renders');
  const rendersFiles = await readdir(rendersDir).catch(() => [] as string[]);
  const renderRule = renderKeeper({ keep: keepRenders, thread: (id) => threadRenders.has(id), busy, unread: unreadRender });
  const renderEntries = await readRendersFolder(rendersDir);
  for (const entry of renderEntries) {
    const linked = entry.link && !entry.read.ok && entry.read.problem === 'not-a-file';
    renderRule.add(entry, linked ? await renderSaid(join(rendersDir, `${entry.name}.json`)) : null);
  }
  const keeps = renderRule.done(rendersFiles);
  // What is left alone, in the folder's order: every file that is no render of its own name (the rule's), and a
  // record of its own file that lacks its scenario, its creation time or its plan — kept by the rule, in nobody's
  // count: said with the others, so that nothing stays in silence.
  const foreign = new Map(keeps.alone.map((a) => [a.file, a.why]));
  const rendersAlone: Array<{ file: string; why: RenderNot }> = [];
  for (const entry of renderEntries) {
    const file = `${entry.name}.json`;
    const why = foreign.get(file) ?? (renderOfFile(entry) && completeRender(entry) === null ? 'incomplete' : undefined);
    if (why) rendersAlone.push({ file, why });
  }
  for (const r of keeps.items) {
    // (No path comes from text inside a file: an item's id is its file's name, and its files are names of renders/.)
    const paths = r.paths.map((f) => join(rendersDir, f));
    let bytes = 0;
    for (const p of paths) bytes += await sizeOf(p);
    items.push({ kind: 'render', id: r.id, scenario: r.scenario, reason: r.reason, bytes, paths });
  }
  const listedRenders = new Set(keeps.items.map((i) => i.id));
  let rendersKept = keeps.kept_files;

  // Reviews: review/<render id>/ of the renders kept.
  const reviewDir = projectPath(project.dir, 'review');
  let reviewsKept = 0;
  for (const name of await readdir(reviewDir).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const path = join(reviewDir, name);
    if (!(await lstat(path).catch(() => null))?.isDirectory()) continue;
    // (While a file of renders/ is too big to read, no review is an item: it may be the review of what that file names.)
    if (keeps.kept.has(name) || busy(name) || keeps.unjudged) {
      reviewsKept++;
      continue;
    }
    // The review of a render that is listed too, or of one that is gone.
    const known = listedRenders.has(name);
    items.push({ kind: 'review', id: name, reason: known ? 'review of an older render' : 'review of a deleted render', bytes: await sizeOf(path), paths: [path] });
  }

  // Takes: per scenario the last succeeded capture, the last one that can be edited and the last complete one (core's
  // rule 3), and every take a kept render or a thread uses. Only a take of the shape the tool makes is ever a
  // candidate (a folder named by hand stays), read newest first by the one reader of the run folders.
  const runsDir = projectPath(project.dir, 'runs');
  const keeper = pruneKeeper();
  for (const name of orderRuns((await readdir(runsDir).catch(() => [] as string[])).filter(isMadeRunId))) {
    const facts = await readRunFolder(runsDir, name, { timeline: keeper.needsTimeline, filmFirst: true });
    // A real folder whose run.json is no record for the reader (and is not of a newer Retake): what it says all the same.
    const lenient = facts.folder === 'dir' && !facts.record.ok && facts.record.problem !== 'newer-format' && facts.record.problem !== 'unknown-status';
    keeper.add(facts, lenient ? await pruneSaid(join(runsDir, name)) : null);
  }
  const { runs, alone, unread } = keeper.done();
  // The takes a thread or a kept render names; and those a file of renders/ that is no render names (R-1): said, when
  // it is a take's only reason.
  const usedRuns = new Set<string>([...threadRuns, ...keeps.runs]);
  const keptTakes: PruneKeptTake[] = alone.map((a) => ({ id: a.id, why: a.why, reason: pruneKeptWords(a.why) }));
  // A folder left alone may be a take an unread thread names (by its id; a newer record by its scenario too): the
  // sentence about those threads names its scenario, as it did when the folder was a take like any other.
  for (const a of alone) unreadRun({ id: a.id, scenario: a.scenario as string });
  let runsKept = alone.length + unread;
  for (const run of runs) {
    // (A scenario that is no text — a run.json the reader does not take — is carried as the file holds it, as ever.)
    const r = { ...run, scenario: run.scenario as string };
    // What kept a take before the rule looked at what its folder holds …
    const kept = unreadRun(r) || !FINISHED.has(r.status) || busy(r.id) || usedRuns.has(r.id) || r.keep.includes('last-capture');
    // … and what keeps it now beside that: said, when it is the only reason.
    const why = r.keep.find((k): k is Exclude<PruneKeep, 'last-capture'> => k !== 'last-capture');
    if (kept || why) {
      runsKept++;
      if (!kept && why) keptTakes.push({ id: r.id, why, reason: pruneKeptWords(why) });
      continue;
    }
    if (keeps.file_runs.has(r.id)) {
      runsKept++;
      keptTakes.push({ id: r.id, why: 'render-file', reason: pruneKeptWords('render-file') });
      continue;
    }
    // A file of renders/ too big to read may name any take: none is an item (said once, `renders_unread`).
    if (keeps.unjudged) {
      runsKept++;
      continue;
    }
    const path = join(runsDir, r.id);
    const reason = r.mode === 'dry' ? 'dry run' : r.status === 'succeeded' ? 'older capture nothing uses' : `${r.status} take`;
    items.push({ kind: 'run', id: r.id, scenario: r.scenario, reason, bytes: await sizeOf(path), paths: [path] });
  }
  keptTakes.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

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
      else if (i.kind === 'render') rendersKept++;
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
  // The files of renders/ left alone: counted by reason (fixed words), named under `untrusted` only.
  const aloneReasons: NonNullable<PruneResult['renders_alone']>['reasons'] = [];
  for (const a of rendersAlone) {
    const reason = aloneReasons.find((x) => x.why === a.why);
    if (reason) reason.count++;
    else aloneReasons.push({ why: a.why, count: 1, reason: renderNotWords(a.why) });
  }
  const rendersUnread = keeps.too_big > 0 ? `${keeps.too_big} ${keeps.too_big === 1 ? 'file' : 'files'} of ${projectRef('renders')}/ ${keeps.too_big === 1 ? 'is' : 'are'} too big to read: every render, review and take is kept` : undefined;
  return {
    project: project.slug,
    dry_run: dry,
    keep_renders: keepRenders,
    items,
    bytes: items.reduce((n, i) => n + i.bytes, 0),
    kept: { runs: runsKept, renders: rendersKept, reviews: reviewsKept },
    problems,
    ...(keptTakes.length ? { kept_takes: keptTakes } : {}),
    ...(rendersAlone.length ? { renders_alone: { count: rendersAlone.length, reasons: aloneReasons } } : {}),
    ...(rendersUnread !== undefined ? { renders_unread: rendersUnread } : {}),
    ...(skipped ? { skipped, not_asked: notAsked ?? 0 } : {}),
    ...(threadsUnread !== undefined ? { threads_unread: threadsUnread } : {}),
    ...(rendersAlone.length ? { untrusted: { renders_alone: rendersAlone.slice(0, RENDERS_ALONE_NAMED) } } : {}),
  };
}

/** "1.2 GB", "340 MB", "12 kB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} kB`;
}
