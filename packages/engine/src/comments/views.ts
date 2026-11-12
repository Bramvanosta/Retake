/** The views of comment threads clients read (see ../comments.ts): a thread, a listing, counts and pins. */
import { open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hunkStats } from '@retake/core/base';
import { COMMENTS_DIR, SLUG_RE } from '@retake/core/model';
import { isRenderId, renderIdOf } from '@retake/core/ids';
import { projectRef, statePath, scenarioRef } from '@retake/core/project';
import { deriveStatus, locateAnchorStep, proposalStates, trustedAnchor } from '@retake/core/comments';
import { latestProjectRender, orderRenders, projectRenderOf, quotableRender, renderNot, renderNotWords } from '@retake/core/render';
import type { FrameCommentAnchor, LoadedProject } from '@retake/core/model';
import type { RenderVariant } from '@retake/core/ids';
import type { CommentAuthor, CommentEntry, CommentProposal, CommentRegion, CommentThread, ProposalState } from '@retake/core/comments';
import type { ProjectRender, RenderEntry, RenderLatestPick, StoredRenderRecord } from '@retake/core/render';
import { EngineError } from '../errors.js';
import { checkScenarioName } from '../refs.js';
import { latestRenderMembers, readById, renderEntries, renderFileProblem } from '../render-records.js';
import type { LatestRenderNotice, PassedOverRenders } from '../render-records.js';
import { LocalStorage } from '../storage.js';
import { COMMENT_LIST_MAX_FILES, COMMENT_STILL_MAX_BYTES, THREAD_FILE_RE, argError, commentRef, commentStillFile, locateThread, lstatOrNull, readThread, realDir } from './store.js';
import type { ThreadFile } from './store.js';

// ── Views ───────────────────────────────────────────────────────────────────

/** An entry as clients see it: ids, kind, channel, dates, render (free text under the thread's `untrusted`). */
export interface CommentEntryView {
  id: string;
  kind: CommentEntry['kind'];
  via: CommentAuthor['via'];
  created_at: string;
  render_id?: string;
  render_created_at?: string;
  /** A reply's proposal (L4.6): its state against today's file and its size — the lines themselves: `comments.proposal`. */
  proposal?: CommentProposalSummary;
  /** An apply (L4.6): the reply whose proposal it applied and the sha256 of the file written. */
  applies?: string;
  scenario_sha256?: string;
}

/** A proposal as a thread view carries it: trusted fields only (ids, hashes, counts, words of the tool). */
export interface CommentProposalSummary {
  state: ProposalState;
  /** The newest proposal, pending or undone, on an open thread: Apply and Preview are offered for it. */
  actionable: boolean;
  delta: CommentProposal['delta'];
  added: number;
  removed: number;
  hunks: number;
  base_sha256: string;
  result_sha256: string;
}

export interface CommentView {
  id: string;
  scenario: string;
  /** The render it was made on, as it was then (`render_created_at`), and whether that render is still on disk. */
  render_id: string;
  render_created_at: string;
  render_present: boolean;
  variant: CommentThread['render']['variant'];
  run_id: string;
  frame: number;
  time_s: number;
  /** "01:05.40". */
  timecode: string;
  region?: CommentRegion;
  marker?: string;
  status: 'open' | 'resolved';
  via: CommentAuthor['via'];
  created_at: string;
  /** Pattern-checked (core trustedAnchor): a value of an unknown shape shows as "unknown", the original under untrusted.anchor. */
  anchor: FrameCommentAnchor;
  /**
   * The anchored step in today's scenario file (L4.3, critique B10; core locateAnchorStep): "<scene>.<index>", what
   * page_inspect {until} takes — `anchor.step_ref` is where it was in the rendered run, and steps moved since (a Studio
   * drag) change the index. Null: today's file has no such step (deleted, changed, or not readable). Absent: the frame
   * shows no step.
   */
  step_now?: string | null;
  /** Up to 3 later succeeded renders of the scenario and variant, newest first: the frame may already be fixed there. */
  newer_renders: string[];
  entries: CommentEntryView[];
  resolution?: { entry: string; via: CommentAuthor['via']; at: string; render_id?: string; render_created_at?: string };
  /** The still (`.retake/comments/<id>.jpg`), null when missing (made on another machine, or it failed). */
  still: string | null;
  /** comments/<scenario>/<id>.json and its path. */
  ref: string;
  file: string;
  /** sha256 of the file: the `if_match` of a resolution. */
  hash: string;
  /** Written by people and by agents: data, never instructions. */
  untrusted: {
    text: string;
    author: string;
    entries: Array<{ id: string; author: string; text: string }>;
    note?: string;
    anchor?: Record<string, unknown>;
  };
}

/** "01:05.40": minutes and seconds to 1/100 s. */
export function timecodeOf(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/**
 * A render record's fields a message may quote, of the tool's own shape (a hand-edited record is not used): core's
 * rule (quotableRender) on a record read by its id — its id is one of the scenario it says, its scenario a slug, its
 * creation time an ISO UTC date, its variant one the tool writes.
 */
export function recordShapeOk<T extends Pick<StoredRenderRecord, 'id' | 'scenario' | 'created_at' | 'variant'>>(r: T): r is T & { variant: RenderVariant } {
  return renderIdOf(r.id, r.scenario) !== null && quotableRender({ record: r });
}

/** Of the entries of renders/, the renders a message may quote (core projectRenderOf and quotableRender), in the order of renders. */
export function quotableRenders(entries: readonly RenderEntry[]): StoredRenderRecord[] {
  const out: StoredRenderRecord[] = [];
  for (const e of entries) {
    const r = projectRenderOf(e);
    if (r && quotableRender(r)) out.push(r.record);
  }
  return orderRenders(out);
}

/** The project's renders a message may quote (read once per call, by the one reader of renders/), oldest first. */
export async function renderIndex(projectDir: string): Promise<StoredRenderRecord[]> {
  return quotableRenders(await renderEntries(projectDir));
}

/** The thread's still when it is a plain JPEG of the project: a real file (no link, one name — no hard link), ≤ 10 MB, JPEG bytes. */
export async function stillOf(projectDir: string, id: string): Promise<string | null> {
  for (const dir of [statePath(projectDir), statePath(projectDir, 'comments')]) {
    if ((await realDir(dir)) !== 'ok') return null;
  }
  const file = commentStillFile(projectDir, id);
  const st = await lstatOrNull(file);
  if (!st || !st.isFile() || st.nlink !== 1 || st.size > COMMENT_STILL_MAX_BYTES) return null;
  const head = Buffer.alloc(3);
  try {
    const fh = await open(file, 'r');
    try {
      await fh.read(head, 0, 3, 0);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? file : null;
}

/** Today's text of a scenario (.yaml, else an existing .yml) and its bytes' sha256, null when it cannot be read; one read per scenario and call. */
export async function todayText(projectDir: string, scenario: string, cache: Map<string, Promise<{ text: string; sha256: string } | null>>): Promise<{ text: string; sha256: string } | null> {
  let p = cache.get(scenario);
  if (!p) {
    const storage = new LocalStorage(projectDir);
    p = (async () => {
      for (const ref of [scenarioRef(scenario), scenarioRef(scenario, '.yml')]) {
        try {
          const r = await storage.readText(ref);
          if (r) return { text: r.text, sha256: r.sha256 };
        } catch {
          return null;
        }
      }
      return null;
    })();
    cache.set(scenario, p);
  }
  return p;
}

export type TextCache = Map<string, Promise<{ text: string; sha256: string } | null>>;

export function proposalSummary(p: CommentProposal, state: ProposalState, actionable: boolean): CommentProposalSummary {
  const st = hunkStats(p.hunks);
  return { state, actionable, delta: p.delta, added: st.added, removed: st.removed, hunks: p.hunks.length, base_sha256: p.base_sha256, result_sha256: p.result_sha256 };
}

export async function threadView(
  projectDir: string,
  thread: CommentThread,
  hash: string,
  renders: readonly StoredRenderRecord[],
  texts: TextCache = new Map(),
): Promise<CommentView> {
  const { status, resolution } = deriveStatus(thread.entries);
  const { anchor, untrusted: badAnchor } = trustedAnchor(thread.anchor);
  let stepNow: string | null | undefined;
  if (anchor.scene !== undefined && anchor.step !== undefined) {
    const today = await todayText(projectDir, thread.scenario, texts);
    stepNow = today === null ? null : (locateAnchorStep(today.text, anchor) ?? null);
  }
  // Proposals (L4.6): their state against today's file (critique B4), read only when the thread holds one.
  const states = thread.entries.some((e) => e.proposal)
    ? new Map(proposalStates(thread.entries, (await todayText(projectDir, thread.scenario, texts))?.sha256 ?? null).map((x) => [x.entry, x]))
    : undefined;
  const current = renders.find((r) => r.id === thread.render.id);
  const newer = renders
    .filter((r) => r.scenario === thread.scenario && r.variant === thread.render.variant && r.status === 'succeeded' && r.created_at > thread.render.created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 3)
    .map((r) => r.id);
  return {
    id: thread.id,
    scenario: thread.scenario,
    render_id: thread.render.id,
    render_created_at: thread.render.created_at,
    render_present: !!current && current.status === 'succeeded' && current.created_at === thread.render.created_at,
    variant: thread.render.variant,
    run_id: thread.render.run_id,
    frame: thread.frame,
    time_s: thread.time_s,
    timecode: timecodeOf(thread.time_s),
    ...(thread.region ? { region: thread.region } : {}),
    ...(thread.marker ? { marker: thread.marker } : {}),
    status,
    via: thread.author.via,
    created_at: thread.created_at,
    anchor,
    ...(stepNow !== undefined ? { step_now: stepNow } : {}),
    newer_renders: newer,
    entries: thread.entries.map((e) => {
      const st = states?.get(e.id);
      return {
        id: e.id,
        kind: e.kind,
        via: e.author.via,
        created_at: e.created_at,
        ...(e.render_id !== undefined ? { render_id: e.render_id, render_created_at: e.render_created_at } : {}),
        ...(e.proposal && st ? { proposal: proposalSummary(e.proposal, st.state, st.actionable && status === 'open') } : {}),
        ...(e.applies !== undefined ? { applies: e.applies, scenario_sha256: e.scenario_sha256 } : {}),
      };
    }),
    ...(resolution
      ? {
          resolution: {
            entry: resolution.entry,
            via: resolution.by.via,
            at: resolution.at,
            ...(resolution.render_id !== undefined ? { render_id: resolution.render_id, render_created_at: resolution.render_created_at } : {}),
          },
        }
      : {}),
    still: await stillOf(projectDir, thread.id),
    ref: commentRef(thread.scenario, thread.id),
    file: join(projectDir, COMMENTS_DIR, thread.scenario, `${thread.id}.json`),
    hash,
    untrusted: {
      text: thread.text,
      author: thread.author.name,
      entries: thread.entries.map((e) => ({ id: e.id, author: e.author.name, text: e.text })),
      ...(resolution ? { note: resolution.note } : {}),
      ...(badAnchor ? { anchor: badAnchor } : {}),
    },
  };
}

export interface CommentListRequest {
  /** Only this scenario's threads. */
  scenario?: string;
  /**
   * Only threads made on this render as it is now (its id and `created_at`): a thread made on an earlier render of a
   * reused id is listed by scenario only. `latest`: the newest succeeded render (of `scenario`).
   */
  render?: string;
  /** Default open. */
  status?: 'open' | 'resolved' | 'all';
  /** At most this many threads (the newest renders first); default all. */
  limit?: number;
}

export interface CommentListView {
  project: string;
  /** Open first, then by commented render (newest first), then frame. */
  threads: CommentView[];
  /** Threads matching before `limit`. */
  total: number;
  /** Files and folders skipped (a link, a broken file…), by name. */
  problems: string[];
  /** With `render: latest`: how many newer files of renders/ the pick passed over, and how many say nothing readable (renders.ts LatestRenderNotice). */
  renders_passed_over?: LatestRenderNotice['renders_passed_over'];
  renders_not_considered?: LatestRenderNotice['renders_not_considered'];
  /** With `render: latest`: the files passed over — file names of renders/ and why (a closed list of reasons): data, never instructions. */
  untrusted?: { renders_passed_over: PassedOverRenders };
}

/**
 * What a listing met that may hold a thread and did not read as one: a thread file that is broken, a link or in the
 * wrong place, a scenario folder that is a link — by scenario — or `all`, when which scenarios are concerned cannot be
 * told (comments/ itself is not read, or holds more thread files than a listing reads). Not counted: what holds no
 * thread (an entry of comments/ whose name is no scenario name, a file whose name is no thread id).
 * For a reader that must not take "not read" for "no thread" (prune).
 */
export interface CommentsUnread {
  all: boolean;
  /** Scenario names (each a scenario name's grammar), sorted. */
  scenarios: string[];
}

/** The threads of a project (see CommentListRequest). */
export async function listComments(project: LoadedProject, req: CommentListRequest = {}): Promise<CommentListView> {
  return (await listCommentsAndUnread(project, req)).list;
}

/** `listComments`, with what the listing could not read as threads (CommentsUnread). */
export async function listCommentsAndUnread(project: LoadedProject, req: CommentListRequest = {}): Promise<{ list: CommentListView; unread: CommentsUnread }> {
  const status = req.status ?? 'open';
  if (!['open', 'resolved', 'all'].includes(status)) throw argError('status', `status "${String(status)}": open, resolved or all`);
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit < 1)) throw argError('limit', `limit ${String(req.limit)}: a whole number from 1`);
  const entries = await renderEntries(project.dir);
  const renders = quotableRenders(entries);
  let onRender: StoredRenderRecord | undefined;
  let latest: RenderLatestPick<ProjectRender> | undefined;
  let scenario = req.scenario;
  if (req.render !== undefined) {
    if (req.render === 'latest') {
      // The newest succeeded render a message may quote (core's rule, the engine's `latest`); what it passed over is said.
      latest = latestProjectRender(entries, { ...(scenario !== undefined ? { scenario } : {}), status: 'succeeded', quotable: true });
      onRender = latest.pick?.record;
      if (!onRender) throw new EngineError('not_found', `no finished render of ${project.slug}${scenario ? ` · ${scenario}` : ''} yet`);
    } else {
      if (!isRenderId(req.render)) {
        throw argError('render', `invalid render id "${String(req.render).slice(0, 80)}": <scenario>-v<N>, or "latest"`);
      }
      const id = req.render;
      onRender = renders.find((r) => r.id === id);
      // A render NAMED has no listing's cap: a record too big for the listing is read whole by its id.
      const listed = entries.find((e) => e.name === id);
      const entry = !onRender && listed && !listed.read.ok && listed.read.problem === 'too-big' ? await readById(project.dir, id) : listed;
      if (!onRender && entry && entry !== listed) onRender = quotableRenders([entry])[0];
      if (!onRender) {
        // A file that is there is never "not found": what it is, and why no thread is listed on it.
        if (entry) throw renderFileProblem(entry, id) ?? notQuoted(entry, id);
        throw new EngineError('not_found', `render "${id}" not found in ${project.slug} (no renders/${id}.json): list by scenario to see threads made on an earlier render of that id`);
      }
    }
    if (scenario !== undefined && onRender.scenario !== scenario) throw argError('render', `render ${onRender.id} is a render of ${onRender.scenario}, not of ${scenario}`);
    scenario = onRender.scenario;
  }

  const problems: string[] = [];
  let unreadAll = false;
  const unreadOf = new Set<string>();
  const root = join(project.dir, COMMENTS_DIR);
  const rootState = await realDir(root);
  const files: ThreadFile[] = [];
  if (rootState === 'ok') {
    let skippedNames = 0;
    for (const d of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (scenario !== undefined && d.name !== scenario) {
        // Same letters, another case: the threads a case-insensitive disk wrote there for this scenario (name safe: = scenario but case).
        if (d.name.toLowerCase() === scenario.toLowerCase()) problems.push(`${COMMENTS_DIR}/${d.name}/ differs from ${scenario} only by case: skipped (rename it ${scenario}/ or remove it)`);
        continue;
      }
      if (!SLUG_RE.test(d.name)) {
        skippedNames++;
        continue;
      }
      if (d.isSymbolicLink()) {
        problems.push(`${COMMENTS_DIR}/${d.name}/ is a symbolic link: skipped`);
        unreadOf.add(d.name);
        continue;
      }
      if (!d.isDirectory()) continue;
      for (const f of (await readdir(join(root, d.name), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        // Temp files of an interrupted write, and anything that is not a thread file, are not threads.
        if (!THREAD_FILE_RE.test(f.name)) continue;
        const ref = `${COMMENTS_DIR}/${d.name}/${f.name}`;
        if (f.isSymbolicLink()) {
          problems.push(`${ref} is a symbolic link: skipped`);
          unreadOf.add(d.name);
          continue;
        }
        if (!f.isFile()) continue;
        if (files.length >= COMMENT_LIST_MAX_FILES) {
          problems.push(`more than ${COMMENT_LIST_MAX_FILES} thread files: the rest were not read`);
          unreadAll = true;
          break;
        }
        files.push({ scenario: d.name, id: f.name.slice(0, -'.json'.length), ref, path: join(root, d.name, f.name) });
      }
    }
    if (skippedNames) problems.push(`${COMMENTS_DIR}/ holds ${skippedNames} ${skippedNames === 1 ? 'entry' : 'entries'} whose name is not a scenario name: skipped`);
  } else if (rootState !== 'missing') {
    problems.push(`${COMMENTS_DIR}/ is ${rootState}: not read`);
    unreadAll = true;
  }

  const views: CommentView[] = [];
  const texts: TextCache = new Map();
  for (const f of files) {
    const r = await readThread(project.dir, f);
    if (!r.ok) {
      problems.push(r.problem);
      unreadOf.add(f.scenario);
      // A well-formed thread in another scenario's folder, or under another id: its own scenario's too.
      if (r.scenario !== undefined && SLUG_RE.test(r.scenario) && r.scenario.length <= 100) unreadOf.add(r.scenario);
      continue;
    }
    if (onRender && (r.thread.render.id !== onRender.id || r.thread.render.created_at !== onRender.created_at)) continue;
    const view = await threadView(project.dir, r.thread, r.hash, renders, texts);
    if (status !== 'all' && view.status !== status) continue;
    views.push(view);
  }
  views.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) ||
      b.render_created_at.localeCompare(a.render_created_at) ||
      a.frame - b.frame ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
  return {
    list: { project: project.slug, threads: req.limit !== undefined ? views.slice(0, req.limit) : views, total: views.length, problems, ...latestRenderMembers(latest) },
    unread: { all: unreadAll, scenarios: [...unreadOf].sort() },
  };
}

/** Why a record of renders/ that reads under its own id is no render a comment is listed on: the refusal (fixed words; the file's name is the id asked). */
function notQuoted(entry: RenderEntry, id: string): EngineError {
  const ref = projectRef('renders', `${id}.json`);
  const why = renderNot(entry);
  if (why === 'unknown-status' || why === 'incomplete' || why === 'another-scenario' || why === 'other-name') return new EngineError('refused', `${ref} is not used: ${renderNotWords(why)}`);
  // (No variant at all is said as that: the sentence of the anchor names one the tool never writes.)
  if (entry.read.ok && entry.read.value.variant === undefined) return new EngineError('refused', `${ref} is not used: its record has no variant (or one that is no text)`);
  return new EngineError('refused', `${ref} has a scenario, created_at or variant the tool never writes: not used`);
}

/** One thread's view. */
export async function getComment(project: LoadedProject, id: string): Promise<CommentView> {
  const f = await locateThread(project.dir, id);
  const r = await readThread(project.dir, f);
  if (!r.ok) throw new EngineError('invalid', r.problem);
  return threadView(project.dir, r.thread, r.hash, await renderIndex(project.dir));
}

// ── Counts and pins from the thread files alone (L4.6, critique B8) ─────────

/** Scenario folders of comments/ one count reads, at most (as the `comments:` sources). */
export const COMMENT_COUNT_MAX_FOLDERS = 200;

/** What a count or a pin needs of one thread file: its status and where it points (no view, no render record). */
export interface CommentSummary {
  id: string;
  scenario: string;
  render_id: string;
  render_created_at: string;
  frame: number;
  status: 'open' | 'resolved';
}

export interface CommentCountsView {
  project: string;
  /** Per scenario folder holding threads: open and resolved threads. */
  scenarios: Record<string, { open: number; resolved: number }>;
  /** Thread files that do not read as threads (a link, a broken file…): left out of the counts. */
  problems: number;
}

export type Summarised = { sig: string; summary: CommentSummary | null };

/**
 * Thread summaries of a project's scenario folders, read from the thread files only (readThread: the same checks as a
 * listing) and memoised per file signature (inode, size, mtime): a count after a reply reads one file. No render
 * record, no still, no scenario text is read (a listing reads all three per thread).
 */
export class CommentIndex {
  /** `<project dir>\0<scenario>` → file name → its signature and summary (null: not a valid thread). */
  private readonly memo = new Map<string, Map<string, Summarised>>();
  /** Thread files read (parsed) since this index was made: for tests. */
  readonly stats = { reads: 0 };

  /** The summaries of one scenario folder, in file name order (≤ COMMENT_LIST_MAX_FILES); problems counted. */
  async ofScenario(projectDir: string, scenario: string): Promise<{ threads: CommentSummary[]; problems: number }> {
    checkScenarioName(scenario);
    const root = join(projectDir, COMMENTS_DIR);
    if ((await realDir(root)) !== 'ok') return { threads: [], problems: 0 };
    const state = await realDir(join(root, scenario));
    const key = `${projectDir}\0${scenario}`;
    if (state !== 'ok') {
      this.memo.delete(key);
      return { threads: [], problems: state === 'missing' ? 0 : 1 };
    }
    // The exact folder name on disk (a case-insensitive disk would also open "Quote/" for "quote").
    if (!(await readdir(root)).includes(scenario)) return { threads: [], problems: 0 };
    const old = this.memo.get(key) ?? new Map<string, Summarised>();
    const next = new Map<string, Summarised>();
    const threads: CommentSummary[] = [];
    let problems = 0;
    const names = (await readdir(join(root, scenario))).filter((n) => THREAD_FILE_RE.test(n)).sort();
    for (const name of names.slice(0, COMMENT_LIST_MAX_FILES)) {
      const path = join(root, scenario, name);
      const st = await lstatOrNull(path);
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isFile()) {
        problems++;
        continue;
      }
      const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
      let got = old.get(name);
      if (!got || got.sig !== sig) {
        this.stats.reads++;
        const id = name.slice(0, -'.json'.length);
        const r = await readThread(projectDir, { scenario, id, ref: commentRef(scenario, id), path });
        got = {
          sig,
          summary: r.ok
            ? { id, scenario, render_id: r.thread.render.id, render_created_at: r.thread.render.created_at, frame: r.thread.frame, status: deriveStatus(r.thread.entries).status }
            : null,
        };
      }
      next.set(name, got);
      if (got.summary) threads.push(got.summary);
      else problems++;
    }
    if (names.length > COMMENT_LIST_MAX_FILES) problems++;
    this.memo.set(key, next);
    return { threads, problems };
  }

  /** Open and resolved threads per scenario folder of a project (one scenario: `scenario`). */
  async counts(project: LoadedProject, o: { scenario?: string } = {}): Promise<CommentCountsView> {
    const out: CommentCountsView = { project: project.slug, scenarios: {}, problems: 0 };
    let folders: string[];
    if (o.scenario !== undefined) folders = [checkScenarioName(o.scenario)];
    else {
      const root = join(project.dir, COMMENTS_DIR);
      if ((await realDir(root)) !== 'ok') return out;
      folders = (await readdir(root)).filter((n) => SLUG_RE.test(n)).sort().slice(0, COMMENT_COUNT_MAX_FOLDERS);
    }
    for (const scenario of folders) {
      const { threads, problems } = await this.ofScenario(project.dir, scenario);
      out.problems += problems;
      if (!threads.length) continue;
      const c = { open: 0, resolved: 0 };
      for (const t of threads) c[t.status]++;
      out.scenarios[scenario] = c;
    }
    return out;
  }
}
