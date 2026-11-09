/**
 * What changes, as the Studio sees it (L4.1 part 3): the workspace index (engine WorkspaceIndex, node:sqlite) kept up
 * to date, and the event stream `GET /v1/events` — server-sent events read by the page through `fetch` (the token in a
 * header: EventSource cannot send one, and a token in a URL lands in logs and history).
 *
 * - A bounded stat poll, every second while a stream is open and never otherwise (critique C2: no recursive
 *   fs.watch): the index's reconcile (or, without node:sqlite, the same scan held in memory) and the job watch (live
 *   from the queue, critique B2). An op of the index (activity_list, search) refreshes first, so it never answers
 *   stale, and what it found goes out on the streams too.
 * - Events: `hello {api, index, generation}`, `workspace {projects, readme, files, scenarios?, renders?, runs?, comments?}`, `jobs {changed, projects}`
 *   (L5.10a fixes: `projects` the projects of the changed jobs; `files` the projects whose project.yaml, sandbox.yaml or
 *   scenario list changed),
 *   `index {generation}`, and a comment line every 15 s (proxies and idle sockets). `scenarios` names the scenario files
 *   changed (`<slug>/<name>`, an in-place save included) and `runs` the runs that started, progressed, finished or went
 *   away, each with its scenario (L4.2, critique B1): a scenario screen re-reads only for its own file and its own
 *   scenario's runs starting or finishing — a running run's progress is a `run_status` read, never a whole view.
 *   `renders` (L4.5 part E) names the projects whose renders/ or review/ folder changed: a render list or a board re-reads for its project.
 *   `comments` (L4.6) names the scenarios whose comment threads changed (`<slug>/<scenario>`, only when there are
 *   any): a Comments screen and a timeline re-read for their own scenario only.
 *   L4.7 (critique B5): `themes` names the theme folders of templates_dir whose files changed, `components` the
 *   namespaces of components_dir whose component files changed (an in-place rewrite included: library-watch.ts's
 *   file-level stat walk), `site: true` an extraction written or removed — the library and theme screens re-read on
 *   them (`projects` is then empty: no project changed). L4.8: `records` names the recordings whose own files changed
 *   (`<project>/<rec_id>`: events streamed while the window is open, the annotations, the draft and the check written,
 *   the folder created or removed — record-watch.ts); a Record screen re-reads its own recording's view on it.
 * - At most 4 streams (critique B1): the page keeps one per browser (the tab holding a Web Lock relays to the others
 *   over a BroadcastChannel); a 5th gets 503 `too_many_streams` and that tab re-reads on a timer instead. A stream is
 *   never an op: the op counter does not move.
 *
 * Only this server writes the index (it holds ui.json). Nothing here logs a token, a path's content or an event body.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ENGINE_HTTP_API, EngineError, JobsWatch, RUNS_INDEX_MAX, WorkspaceIndex, diffSources, jobProject, listRuns, runChanges, scanSources, securityHeaders, sourceKey, workspaceChanges } from '@retake/engine';
import type { JobQueue, RunChange, RunRow, SourceMap, SqliteLoader } from '@retake/engine';

import type { LoadedProject, WorkspaceConfig } from '@retake/core';
import { libraryChanges, libraryWatchScan } from './library-watch.js';
import { recordsChanges, recordsWatchScan } from './record-watch.js';

/**
 * One server-sent event: `data` is one line of JSON with U+2028 / U+2029 escaped (review A M1: JSON.stringify leaves
 * them raw, and a reader treating them as line ends would drop the event — a page's text may hold them).
 */
export function sseText(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n\n`;
}

/** Event streams served at once, at most (below a browser's 6 connections per host). */
export const EVENT_STREAMS_MAX = 4;
/** The stat poll's period while a stream is open (ms). */
export const EVENT_POLL_MS = 1000;
/** A comment line on every stream this often (ms). */
export const EVENT_KEEPALIVE_MS = 15_000;

export interface LiveOptions {
  ws: WorkspaceConfig;
  /** The engine's job queue (Engine.queue): the job watch and the index each read it as a reader of their own. */
  queue: JobQueue;
  /** node:sqlite (tests inject a Node.js without it). */
  sqlite?: SqliteLoader;
  pollMs?: number;
  log?: (message: string) => void;
}

/** Why the index cannot answer: this Node.js has no node:sqlite. */
export function noIndexError(): EngineError {
  return new EngineError('unavailable', `the workspace index needs node:sqlite: Node.js 22.13 or later (this is ${process.versions.node}); activity and search are off`, {
    fix: 'run retake ui with Node.js 22.13+ (projects and the README editor work without it)',
  });
}

export class Live {
  private readonly streams = new Set<ServerResponse>();
  private readonly jobs: JobsWatch;
  private sources: SourceMap | undefined;
  /** L4.7: the library / theme watch as last scanned (library-watch.ts). */
  private libSources: Map<string, string> | undefined;
  /** L4.8: the recordings' files as last scanned (record-watch.ts). */
  private recSources: Map<string, string> | undefined;
  /** Without node:sqlite: each project's runs as last read (what a run change is told from). */
  private readonly runRows = new Map<string, RunRow[]>();
  private timer: NodeJS.Timeout | undefined;
  private keepalive: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private closed = false;

  private constructor(
    private readonly o: LiveOptions,
    /** null: no node:sqlite on this Node.js. */
    readonly index: WorkspaceIndex | null,
  ) {
    this.jobs = new JobsWatch(o.queue.reader());
  }

  /** Opens (builds, rebuilds) and reconciles the index, and takes stock of the jobs. */
  static async start(o: LiveOptions): Promise<Live> {
    let index: WorkspaceIndex | null = null;
    try {
      index = await WorkspaceIndex.open(o.ws, { queue: o.queue.reader(), ...(o.sqlite ? { loader: o.sqlite } : {}) });
    } catch (e) {
      o.log?.(`retake ui: the workspace index could not be opened (${e instanceof Error ? e.message : String(e)}): activity and search are off`);
    }
    const live = new Live(o, index);
    const why = { corrupt: 'the file was damaged', schema: 'another version wrote it', not_a_file: 'it was not a regular file' } as const;
    if (index?.rebuilt && index.rebuilt !== 'missing') o.log?.(`retake ui: the workspace index was rebuilt (${why[index.rebuilt]})`);
    await live.refresh();
    return live;
  }

  /** Streams open now. */
  get streamCount(): number {
    return this.streams.size;
  }

  /** The index, up to date with the files; `unavailable` without node:sqlite. */
  async freshIndex(): Promise<WorkspaceIndex> {
    if (!this.index) throw noIndexError();
    await this.refresh();
    return this.index;
  }

  /** One poll: what changed goes out on the streams. Concurrent callers share it; a failure is logged, never thrown. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.refreshing ??= this.poll()
      .catch((e: unknown) => this.o.log?.(`retake ui: a workspace poll failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.refreshing = undefined;
      }));
  }

  private async poll(): Promise<void> {
    let keys: string[];
    let runs: RunChange[];
    let generation: number | undefined;
    if (this.index) {
      const c = await this.index.reconcile();
      keys = c.keys;
      runs = c.runs;
      generation = c.generation;
    } else {
      ({ keys, runs } = await this.scanWithoutIndex());
    }
    const changed = await this.jobs.poll();
    const libNext = await libraryWatchScan({ root: this.o.ws.root, componentsDir: this.o.ws.componentsDir, templatesDir: this.o.ws.templatesDir });
    const lib = this.libSources ? libraryChanges(this.libSources, libNext) : {};
    this.libSources = libNext;
    const recNext = recordsWatchScan(this.o.ws.projectsDir);
    const records = this.recSources ? recordsChanges(this.recSources, recNext) : [];
    this.recSources = recNext;
    if (this.closed) return;
    const w = workspaceChanges(keys);
    // L4.5 part E: the projects whose renders/ folder changed (a render written, a version reserved or released), or
    // their review/ (L5.10a fixes: a review run from a terminal).
    const renders = [...new Set(keys.map(sourceKey).filter((k) => k.kind === 'renders' && k.project !== undefined).map((k) => k.project as string))].sort();
    // L5.10a fixes: the projects whose project.yaml, sandbox.yaml or scenario list changed — always sent (empty: none),
    // so a page tells "a file no list names" from "a runs folder that changed with no run told yet".
    const files = [...new Set(keys.map(sourceKey).filter((k) => k.kind === 'project' && k.project !== undefined).map((k) => k.project as string))].sort();
    if (w.projects.length || Object.keys(lib).length || records.length) {
      this.send('workspace', {
        projects: w.projects,
        readme: w.readme,
        files,
        ...(w.scenarios.length ? { scenarios: w.scenarios } : {}),
        ...(renders.length ? { renders } : {}),
        ...(runs.length ? { runs } : {}),
        // L4.6 (plan D9): the scenarios whose comment threads changed — a thread written, an entry appended.
        ...(w.comments?.length ? { comments: w.comments } : {}),
        // L4.7: theme folders, component namespaces and site extractions that changed.
        ...lib,
        // L4.8: the recordings whose files changed (`<project>/<rec_id>`): a Record screen re-reads its own.
        ...(records.length ? { records } : {}),
      });
    }
    if (changed.length) {
      // L5.10a fixes (review A-L7): the projects of the changed jobs, so an open project's board ignores another one's.
      const projects = [...new Set(changed.map((id) => this.jobs.record(id)).map((j) => (j ? jobProject(j.input) : undefined)).filter((x): x is string => typeof x === 'string'))].sort();
      // L5.14: what a filming take holds of the workspace's jobs now (fixed words and a kind; null: nothing).
      this.send('jobs', { changed, projects, held: this.jobs.held() ?? null });
    }
    if (keys.length && generation !== undefined) this.send('index', { generation });
  }

  /** The index's scan held in memory (Node.js without node:sqlite), runs re-read on a `runs:` change as the index does. */
  private async scanWithoutIndex(): Promise<{ keys: string[]; runs: RunChange[] }> {
    const unfinished = new Map<string, string[]>();
    for (const [slug, rows] of this.runRows) {
      const ids = rows.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => r.id);
      if (ids.length) unfinished.set(slug, ids);
    }
    const next = await scanSources(this.o.ws, unfinished);
    const prev = this.sources;
    this.sources = next;
    const keys = prev ? diffSources(prev, next) : [...next.keys()];
    const runs: RunChange[] = [];
    for (const key of keys) {
      const { kind, project } = sourceKey(key);
      if (kind !== 'runs' || project === undefined) continue;
      const read = next.has(key) ? await listRuns({ dir: join(this.o.ws.projectsDir, project) } as LoadedProject, { limit: RUNS_INDEX_MAX }).catch(() => []) : [];
      const after: RunRow[] = read.filter((r) => !r.newer).map((r) => ({ id: r.id, scenario: r.scenario ?? null, status: r.status ?? null }));
      if (prev) runs.push(...runChanges(project, this.runRows.get(project) ?? [], after, prev.get(key), next.get(key)));
      this.runRows.set(project, after);
    }
    return { keys: prev ? keys : [], runs };
  }

  private send(event: string, data: unknown): void {
    const text = sseText(event, data);
    for (const res of this.streams) res.write(text);
  }

  /** `GET /v1/events` (the gate already passed): a stream, or 503 when 4 are open. */
  open(_req: IncomingMessage, res: ServerResponse, fail: (status: number, code: string, message: string) => void): void {
    if (this.closed || this.streams.size >= EVENT_STREAMS_MAX) {
      fail(503, 'too_many_streams', `this Studio serves at most ${EVENT_STREAMS_MAX} event streams: this tab re-reads on a timer instead`);
      return;
    }
    res.writeHead(200, { ...securityHeaders('api'), 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(sseText('hello', { api: ENGINE_HTTP_API, index: this.index !== null, generation: this.index?.generation ?? null }));
    this.streams.add(res);
    const drop = () => {
      this.streams.delete(res);
      this.schedule();
    };
    // The response's close (the client went away, or close() ended it) — never the request's: a GET's request
    // "closes" as soon as its empty body is read.
    res.on('close', drop);
    this.schedule();
  }

  /** The poll and the keepalive run while a stream is open, and only then. */
  private schedule(): void {
    const want = this.streams.size > 0 && !this.closed;
    if (want && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.o.pollMs ?? EVENT_POLL_MS);
      this.keepalive = setInterval(() => {
        for (const res of this.streams) res.write(': keepalive\n\n');
      }, EVENT_KEEPALIVE_MS);
      this.timer.unref();
      this.keepalive.unref();
    } else if (!want && this.timer) {
      clearInterval(this.timer);
      clearInterval(this.keepalive);
      this.timer = undefined;
      this.keepalive = undefined;
    }
  }

  /** Ends every stream, stops the poll and closes the index (after a poll in flight). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const res of this.streams) res.end();
    this.streams.clear();
    this.schedule();
    await this.refreshing;
    this.index?.close();
  }
}
