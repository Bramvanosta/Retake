/**
 * The workspace index (L4.1, R-ARC-05, ADR-2): `<workspace>/.retake/index.sqlite`, a cache of what the files say —
 * projects (name, error, README text), runs (run.json), renders (renders/*.json), the job history (history.jsonl) and a
 * full-text search over them — that the Studio reads for its activity feed and its search box. The files stay the only
 * source of truth: every write goes to files through the engine, the index follows.
 *
 * - Rebuilt from files: `reconcile()` stats the sources (sources.ts: a few stats per project), re-reads only what
 *   changed (a project's summary, its README, its runs, its renders; history.jsonl from the byte after the last line it
 *   read — a shorter file or another inode is read again from the start) and writes it in one transaction.
 * - Missing → built; corrupt (SQLITE_CORRUPT / SQLITE_NOTADB by errcode, or `pragma quick_check` not ok), of another
 *   schema, or not a regular file (a symbolic link: SQLite would create the db, -wal and -shm at its target) → deleted
 *   with its -wal / -shm (links removed, never followed) and rebuilt: a cache, nothing to keep.
 * - Files are read only when they are regular files of the project, within a size cap (review A L3): a render record
 *   or README linked out of the project is never indexed, a FIFO never read.
 * - No jobs table (critique B2): an unfinished job's state is derived from process liveness, which no file records —
 *   `activity()` reads unfinished jobs live from the queue; finished ones are history lines.
 * - One writer: the Studio server holding the discovery file (ui.json). The worker and the CLI never open it.
 * - Text in it is shown by the Studio as text (never HTML); a search query becomes quoted prefix terms bound as a
 *   parameter — no FTS syntax from the user reaches SQLite.
 */
import { lstat, mkdir, open as openFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LoadedProject, WorkspaceConfig } from '@retake/core';
import { HISTORY_VERSION, historyFile } from '../history.js';
import type { HistoryEntry } from '../history.js';
import type { JobQueueView } from '../jobs/job-queue.js';
import { jobProject } from '../jobs/queue-core.js';
import { stateDir } from '../workspace-state.js';
import { FINISHED_JOB_STATES } from '../jobs/types.js';
import type { JobRecord } from '../jobs/types.js';
import { listProjectSummaries } from '../projects.js';
import type { ProjectSummary } from '../projects.js';
import { listRuns } from '../runs.js';
import type { RunSummary } from '../runs.js';
import { LocalStorage } from '../storage.js';
import { isCorruptionError, loadSqlite } from './sqlite.js';
import type { SqliteLoader } from './sqlite.js';
import { diffSources, runChanges, scanSources, sourceKey } from './sources.js';
import type { RunChange, RunRow } from './sources.js';

/** Bumped when the tables change: an index of another schema is rebuilt. */
export const INDEX_SCHEMA = 1;
/** README text kept for the search, at most (the tool's own cap). */
const README_INDEX_MAX = 200_000;
/** A run folder holds at most this many runs in the index (newest first). */
export const RUNS_INDEX_MAX = 5000;
/** Bytes read of a README for the index, at most (a bigger one is indexed without its text). */
const README_BYTES_MAX = 4 * 1024 * 1024;
/** A render record bigger than this is not one (skipped). */
const RENDER_RECORD_MAX = 1024 * 1024;

export function indexFile(root: string): string {
  return join(stateDir(root), 'index.sqlite');
}

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sources(key TEXT PRIMARY KEY, sig TEXT NOT NULL);
CREATE TABLE projects(slug TEXT PRIMARY KEY, name TEXT NOT NULL, error TEXT, scenarios INTEGER NOT NULL);
CREATE TABLE runs(project TEXT NOT NULL, id TEXT NOT NULL, scenario TEXT, mode TEXT, status TEXT, env TEXT, started_at TEXT, finished_at TEXT, PRIMARY KEY(project, id));
CREATE TABLE renders(project TEXT NOT NULL, id TEXT NOT NULL, scenario TEXT, run_id TEXT, status TEXT, template TEXT, created_at TEXT, PRIMARY KEY(project, id));
CREATE TABLE history(seq INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, project TEXT, job TEXT, submitted_by TEXT, state TEXT, entry TEXT NOT NULL);
CREATE INDEX history_at ON history(at);
CREATE INDEX history_project ON history(project, at);
CREATE VIRTUAL TABLE search USING fts5(kind UNINDEXED, project UNINDEXED, ref, title, body, tokenize = 'unicode61');
`;

/** Why the index file was (re)built when it was opened. */
export type IndexRebuild = 'missing' | 'corrupt' | 'schema' | 'not_a_file';

/** A finished job or CLI command, as history.jsonl recorded it (ids, kinds, states — no product text). */
export interface HistoryRow extends Omit<HistoryEntry, 'v'> {
  seq: number;
}

/** One line of the activity feed: an unfinished job (live from the queue) or a history line. */
export interface ActivityItem {
  source: 'queue' | 'history';
  /** queued: when it was queued; running: when it started; history: when it finished. */
  at: string;
  kind: string;
  project?: string;
  state: string;
  job?: string;
  submitted_by: string;
  ms?: number;
  run?: { id: string; scenario: string; mode: string; status?: string };
  render?: { id: string; scenario?: string };
  /** A running job's progress (steps, phase, fraction). */
  progress?: JobRecord['progress'];
  /** L5.14: a heavy job a filming take holds (waiting, slowed or past the cap: JobRecord.yield). */
  yield?: JobRecord['yield'];
}

export interface SearchHit {
  kind: 'project' | 'scenario' | 'run' | 'render';
  project: string;
  /** The slug, scenario name, run id or render id. */
  ref: string;
  /** The project's name, the scenario's name, "<scenario> · <mode> · <status>" of a run, "<scenario> · <theme> · <status>" of a render. */
  title: string;
  /** A few words around the match in the README (projects), else absent. */
  snippet?: string;
}

/** What a reconcile changed: the source keys re-read, the runs that changed (critique B1), and the generation after it. */
export interface IndexChanges {
  keys: string[];
  runs: RunChange[];
  generation: number;
}

export interface IndexOptions {
  /** The workspace's job queue (one with its own memory: JobQueueView.withOwnMemory), for the activity feed's unfinished jobs. */
  queue: JobQueueView;
  /** node:sqlite (default: loaded with the scoped warning filter). */
  loader?: SqliteLoader;
}

/**
 * "a b*" → `"a"* "b"*`: every word a quoted prefix term (quotes doubled, control characters dropped — a NUL would end
 * the string inside SQLite), so no FTS syntax passes; empty → null.
 */
export function ftsQuery(q: string): string | null {
  const words = q
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .split(/[\s"*^:()+\-]+/u)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 12);
  return words.length ? words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ') : null;
}

interface RenderRow {
  id: string;
  scenario?: string;
  run_id?: string;
  status?: string;
  template?: string;
  created_at?: string;
}

/**
 * The text of a project file for the index: undefined unless it is a regular file (a link to another file of the project
 * is followed; a FIFO or a device never opened) of at most `max` bytes, inside the project once links are followed
 * (LocalStorage refuses a link leading out).
 */
async function readSmall(dir: string, ref: string, max: number): Promise<string | undefined> {
  try {
    const st = await stat(join(dir, ...ref.split('/')));
    if (!st.isFile() || st.size > max) return undefined;
    return (await new LocalStorage(dir).readText(ref))?.text;
  } catch {
    return undefined;
  }
}

/** renders/*.json of a project, read as data (no editor package: the index never loads Remotion). */
async function readRenders(dir: string): Promise<RenderRow[]> {
  let files: string[];
  try {
    files = (await readdir(join(dir, 'renders'))).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const out: RenderRow[] = [];
  for (const f of files) {
    try {
      const text = await readSmall(dir, `renders/${f}`, RENDER_RECORD_MAX);
      if (text === undefined) continue;
      const r = JSON.parse(text) as Record<string, unknown>;
      if (r?.version !== 1 || typeof r.id !== 'string') continue;
      const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
      out.push({ id: r.id, scenario: s('scenario'), run_id: s('run_id'), status: s('status'), template: s('template'), created_at: s('created_at') });
    } catch {
      // not a render record
    }
  }
  return out;
}

async function readmeText(dir: string): Promise<string> {
  // A README leading out of the project is never read (storage.ts), nor one that is not a regular file.
  return (await readSmall(dir, 'README.md', README_BYTES_MAX))?.slice(0, README_INDEX_MAX) ?? '';
}

/** What a reconcile read from files for one project, before the transaction writes it. */
interface ProjectRead {
  slug: string;
  gone: boolean;
  summary?: ProjectSummary;
  readme?: string;
  runs?: RunSummary[];
  renders?: RenderRow[];
}

export class WorkspaceIndex {
  private reconciling: Promise<IndexChanges> | undefined;
  private closed = false;
  /** Jobs seen finished: their job.json never changes again, so activity() does not read it again (review B L1). */
  private readonly finishedJobs = new Set<string>();

  private constructor(
    private readonly db: DatabaseSync,
    private readonly ws: WorkspaceConfig,
    private readonly queue: JobQueueView,
    readonly file: string,
    /** Why the file was built at open; undefined when an existing index was reused. */
    readonly rebuilt: IndexRebuild | undefined,
  ) {}

  /**
   * The workspace's index, opened (built or rebuilt when missing, corrupt or of another schema); null when this
   * Node.js has no node:sqlite (22.0–22.12). Not reconciled yet: call `reconcile()`.
   */
  static async open(ws: WorkspaceConfig, o: IndexOptions): Promise<WorkspaceIndex | null> {
    const sqlite = await (o.loader ?? loadSqlite)();
    if (!sqlite) return null;
    const file = indexFile(ws.root);
    await mkdir(stateDir(ws.root), { recursive: true });
    // lstat, never stat: a link (even a dangling one) in place of the db, its -wal or its -shm is not followed (review
    // A L4) — the files are removed (rm removes a link itself) and the index rebuilt.
    const kinds = await Promise.all([file, `${file}-wal`, `${file}-shm`].map((f) => lstat(f).then((st) => (st.isFile() ? 'file' : 'other'), () => 'none')));
    const existed = kinds[0] !== 'none';
    const remove = async () => {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) await rm(f, { force: true });
    };
    const create = () => {
      const db = new sqlite.DatabaseSync(file, { timeout: 2000 });
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(SCHEMA);
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?), (?, ?)').run('schema', String(INDEX_SCHEMA), 'generation', '0');
      return db;
    };
    const queue = o.queue;
    if (kinds.includes('other')) {
      await remove();
      return new WorkspaceIndex(create(), ws, queue, file, 'not_a_file');
    }
    if (!existed) return new WorkspaceIndex(create(), ws, queue, file, 'missing');
    let db: DatabaseSync | undefined;
    let why: IndexRebuild | undefined;
    try {
      db = new sqlite.DatabaseSync(file, { timeout: 2000 });
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
      if (Object.values(check ?? {})[0] !== 'ok') why = 'corrupt';
      else {
        const hasMeta = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as { n: number };
        const schema = hasMeta.n ? (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value?: string } | undefined)?.value : undefined;
        if (schema !== String(INDEX_SCHEMA)) why = 'schema';
      }
    } catch (e) {
      if (!isCorruptionError(e)) {
        db?.close();
        throw e;
      }
      why = 'corrupt';
    }
    if (why === undefined && db) {
      db.exec('PRAGMA journal_mode = WAL');
      return new WorkspaceIndex(db, ws, queue, file, undefined);
    }
    try {
      db?.close();
    } catch {
      // a corrupt file may not even close cleanly
    }
    await remove();
    return new WorkspaceIndex(create(), ws, queue, file, why);
  }

  /** Bumped by every reconcile that changed something. */
  get generation(): number {
    return Number((this.db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string }).value);
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Bring the index up to date with the files; concurrent callers share one pass. */
  reconcile(): Promise<IndexChanges> {
    if (this.closed) return Promise.resolve({ keys: [], runs: [], generation: 0 });
    return (this.reconciling ??= this.pass().finally(() => {
      this.reconciling = undefined;
    }));
  }

  private async pass(): Promise<IndexChanges> {
    const unfinished = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT project, id FROM runs WHERE status IN ('queued', 'running')").all() as Array<{ project: string; id: string }>) {
      unfinished.set(r.project, [...(unfinished.get(r.project) ?? []), r.id]);
    }
    const next = await scanSources(this.ws, unfinished);
    const prev = new Map((this.db.prepare('SELECT key, sig FROM sources').all() as Array<{ key: string; sig: string }>).map((r) => [r.key, r.sig]));
    const keys = diffSources(prev, next);
    if (keys.length === 0 || this.closed) return { keys: [], runs: [], generation: this.generation };

    // Read what changed (async), then write it in one transaction (sync).
    const reads = new Map<string, ProjectRead>();
    const readOf = (slug: string) => reads.get(slug) ?? reads.set(slug, { slug, gone: !next.has(`project:${slug}`) }).get(slug)!;
    let summaries: Map<string, ProjectSummary> | undefined;
    for (const key of keys) {
      const { kind, project } = sourceKey(key);
      // A scenario file's own key, a scenario's comment folder: nothing to read (the project key re-reads the names).
      if (project === undefined || kind === 'scenario' || kind === 'comments') continue;
      const r = readOf(project);
      if (r.gone) continue;
      const dir = join(this.ws.projectsDir, project);
      if (kind === 'project') {
        summaries ??= new Map((await listProjectSummaries(this.ws)).map((s) => [s.slug, s]));
        r.summary = summaries.get(project);
      } else if (kind === 'readme') r.readme = await readmeText(dir);
      else if (kind === 'runs') r.runs = await listRuns({ dir } as LoadedProject, { limit: RUNS_INDEX_MAX }).catch(() => []);
      else if (kind === 'renders') r.renders = await readRenders(dir);
    }
    const history = keys.includes('history') ? await this.readHistory() : undefined;
    if (this.closed) return { keys: [], runs: [], generation: 0 };

    const db = this.db;
    const runs: RunChange[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const delSearch = db.prepare('DELETE FROM search WHERE project = ? AND kind = ?');
      const addSearch = db.prepare('INSERT INTO search(kind, project, ref, title, body) VALUES (?, ?, ?, ?, ?)');
      for (const r of reads.values()) {
        if (r.gone) {
          for (const t of ['projects', 'runs', 'renders']) db.prepare(`DELETE FROM ${t} WHERE ${t === 'projects' ? 'slug' : 'project'} = ?`).run(r.slug);
          db.prepare('DELETE FROM search WHERE project = ?').run(r.slug);
          continue;
        }
        if (r.summary) {
          const s = r.summary;
          db.prepare('INSERT INTO projects(slug, name, error, scenarios) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, error = excluded.error, scenarios = excluded.scenarios').run(
            s.slug,
            s.name,
            s.error ?? null,
            s.scenarios.length,
          );
          delSearch.run(s.slug, 'scenario');
          for (const name of s.scenarios) addSearch.run('scenario', s.slug, name, name, '');
        }
        if (r.summary || r.readme !== undefined) {
          const name = r.summary?.name ?? (db.prepare('SELECT name FROM projects WHERE slug = ?').get(r.slug) as { name?: string } | undefined)?.name ?? r.slug;
          const body = r.readme ?? (db.prepare("SELECT body FROM search WHERE project = ? AND kind = 'project'").get(r.slug) as { body?: string } | undefined)?.body ?? '';
          delSearch.run(r.slug, 'project');
          addSearch.run('project', r.slug, r.slug, name, body);
        }
        if (r.runs) {
          const before = db.prepare('SELECT id, scenario, status FROM runs WHERE project = ?').all(r.slug) as unknown as RunRow[];
          const after: RunRow[] = r.runs.filter((x) => !x.newer).map((x) => ({ id: x.id, scenario: x.scenario ?? null, status: x.status ?? null }));
          runs.push(...runChanges(r.slug, before, after, prev.get(`runs:${r.slug}`), next.get(`runs:${r.slug}`)));
          db.prepare('DELETE FROM runs WHERE project = ?').run(r.slug);
          delSearch.run(r.slug, 'run');
          const add = db.prepare('INSERT INTO runs(project, id, scenario, mode, status, env, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const run of r.runs) {
            if (run.newer) continue;
            add.run(r.slug, run.id, run.scenario ?? null, run.mode ?? null, run.status ?? null, run.env ?? null, run.started_at ?? null, run.finished_at ?? null);
            addSearch.run('run', r.slug, run.id, [run.scenario, run.mode === 'dry' ? 'dry run' : 'capture', run.status].filter(Boolean).join(' · '), run.env ?? '');
          }
        }
        if (r.renders) {
          db.prepare('DELETE FROM renders WHERE project = ?').run(r.slug);
          delSearch.run(r.slug, 'render');
          const add = db.prepare('INSERT INTO renders(project, id, scenario, run_id, status, template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
          for (const x of r.renders) {
            add.run(r.slug, x.id, x.scenario ?? null, x.run_id ?? null, x.status ?? null, x.template ?? null, x.created_at ?? null);
            addSearch.run('render', r.slug, x.id, [x.scenario, x.template, x.status].filter(Boolean).join(' · '), '');
          }
        }
      }
      if (history) {
        if (history.reset) db.exec('DELETE FROM history');
        const add = db.prepare('INSERT INTO history(at, kind, project, job, submitted_by, state, entry) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const e of history.entries) add.run(e.at, e.kind, e.project ?? null, e.job ?? null, e.submitted_by ?? null, e.state ?? null, JSON.stringify(e));
        this.setMeta('history_ino', history.ino);
        this.setMeta('history_offset', String(history.offset));
      }
      const setSource = db.prepare('INSERT INTO sources(key, sig) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET sig = excluded.sig');
      const delSource = db.prepare('DELETE FROM sources WHERE key = ?');
      for (const k of keys) {
        const v = next.get(k);
        if (v === undefined) delSource.run(k);
        else setSource.run(k, v);
      }
      this.setMeta('generation', String(this.generation + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { keys, runs, generation: this.generation };
  }

  /** history.jsonl from where the last pass stopped (whole lines only); from the start when it shrank or was replaced. */
  private async readHistory(): Promise<{ reset: boolean; ino: string; offset: number; entries: HistoryEntry[] }> {
    const file = historyFile(this.ws.root);
    let fh;
    try {
      fh = await openFile(file, 'r');
    } catch {
      return { reset: true, ino: '-', offset: 0, entries: [] };
    }
    try {
      const st = await fh.stat();
      const ino = String(st.ino);
      let offset = Number(this.meta('history_offset') ?? 0);
      const reset = this.meta('history_ino') !== ino || st.size < offset;
      if (reset) offset = 0;
      const length = st.size - offset;
      if (length <= 0) return { reset, ino, offset, entries: [] };
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0) return { reset, ino, offset, entries: [] };
      const entries: HistoryEntry[] = [];
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as HistoryEntry;
          if (e && e.v === HISTORY_VERSION && typeof e.at === 'string' && typeof e.kind === 'string') entries.push(e);
        } catch {
          // a torn or foreign line
        }
      }
      return { reset, ino, offset: offset + end + 1, entries };
    } finally {
      await fh.close();
    }
  }

  /** Finished jobs and CLI commands, newest first. */
  history(o: { project?: string; limit?: number } = {}): HistoryRow[] {
    const limit = Math.max(1, Math.min(o.limit ?? 20, 200));
    const rows = (
      o.project === undefined
        ? this.db.prepare('SELECT seq, entry FROM history ORDER BY at DESC, seq DESC LIMIT ?').all(limit)
        : this.db.prepare('SELECT seq, entry FROM history WHERE project = ? ORDER BY at DESC, seq DESC LIMIT ?').all(o.project, limit)
    ) as Array<{ seq: number; entry: string }>;
    return rows.map((r) => {
      const { v: _v, ...e } = JSON.parse(r.entry) as HistoryEntry;
      return { seq: r.seq, ...e };
    });
  }

  /**
   * The activity feed: unfinished jobs first — read live from the queue, their derived states included — then finished
   * jobs and CLI commands from the history, newest first.
   */
  async activity(o: { project?: string; limit?: number } = {}): Promise<ActivityItem[]> {
    const limit = Math.max(1, Math.min(o.limit ?? 20, 200));
    // Jobs whose job.json still says queued or running, with their state derived now: one whose worker died reads
    // `interrupted` (no file says so; the next worker persists it), a cancelled one before it started `cancelled`.
    const live: JobRecord[] = [];
    // L5.14: what holds heavy work, read once for the whole feed.
    let hold: Promise<'here' | 'elsewhere' | undefined> | undefined;
    const once = () => (hold ??= this.queue.takeHold());
    for (const id of (await this.queue.ids()).reverse()) {
      if (this.finishedJobs.has(id)) continue;
      const stored = await this.queue.stored(id).catch(() => undefined);
      if (stored && FINISHED_JOB_STATES.has(stored.state)) this.finishedJobs.add(id);
      if (!stored || (stored.state !== 'queued' && stored.state !== 'running')) continue;
      if (o.project !== undefined && jobProject(stored.input) !== o.project) continue;
      live.push(await this.queue.derive(stored, { hold: once }));
      if (live.length >= limit) break;
    }
    const items: ActivityItem[] = live.map((j) => {
      const i = j.input as unknown as Record<string, unknown>;
      return {
        source: 'queue',
        at: (j.state === 'running' && j.started_at) || j.created_at,
        kind: j.kind,
        ...(jobProject(j.input) ? { project: jobProject(j.input) } : {}),
        state: j.state,
        job: j.id,
        submitted_by: String(i.submitted_by ?? 'mcp'),
        ...(j.kind === 'run' ? { run: { id: String(i.run_id), scenario: String(i.scenario), mode: String(i.mode) } } : {}),
        ...(typeof i.render_id === 'string' ? { render: { id: i.render_id, ...(typeof i.scenario === 'string' ? { scenario: i.scenario } : {}) } } : {}),
        ...(j.progress ? { progress: j.progress } : {}),
        ...(j.yield ? { yield: j.yield } : {}),
      };
    });
    for (const h of this.history({ ...(o.project !== undefined ? { project: o.project } : {}), limit })) {
      if (items.length >= limit) break;
      items.push({
        source: 'history',
        at: h.at,
        kind: h.kind,
        ...(h.project ? { project: h.project } : {}),
        state: h.state,
        ...(h.job ? { job: h.job } : {}),
        submitted_by: h.submitted_by,
        ...(h.ms !== undefined ? { ms: h.ms } : {}),
        ...(h.run ? { run: h.run } : {}),
        ...(h.render ? { render: h.render } : h.review ? { render: { id: h.review.render } } : h.export ? { render: { id: h.export.render } } : {}),
      });
    }
    return items.slice(0, limit);
  }

  /** Projects (name, slug, README), scenarios, runs and renders matching every word of `q` (as prefixes), best first. */
  search(q: string, o: { limit?: number; project?: string } = {}): SearchHit[] {
    const match = ftsQuery(q);
    if (!match) return [];
    const limit = Math.max(1, Math.min(o.limit ?? 20, 50));
    const sql = `SELECT kind, project, ref, title, snippet(search, 4, '', '', '…', 12) AS snippet FROM search WHERE search MATCH ?${o.project !== undefined ? ' AND project = ?' : ''} ORDER BY rank LIMIT ?`;
    const rows = (o.project !== undefined ? this.db.prepare(sql).all(match, o.project, limit) : this.db.prepare(sql).all(match, limit)) as Array<{ kind: SearchHit['kind']; project: string; ref: string; title: string; snippet: string }>;
    return rows.map((r) => ({
      kind: r.kind,
      project: r.project,
      ref: r.ref,
      title: r.title,
      ...(r.kind === 'project' && r.snippet ? { snippet: r.snippet } : {}),
    }));
  }

  /** Row counts (tests, diagnostics). */
  counts(): { projects: number; runs: number; renders: number; history: number; search: number } {
    const n = (t: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { projects: n('projects'), runs: n('runs'), renders: n('renders'), history: n('history'), search: n('search') };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
