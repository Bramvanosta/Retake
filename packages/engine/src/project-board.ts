/**
 * The Studio's Project screen in one read (L5.10a, critique H1): `engine.projects.board(project)` → every scenario's
 * facts for the poster grid, the smart groups and the inspector — never through `scenarios.view` (its 16-entry memos
 * would thrash past 16 scenarios and evict the open scenario screen's entries).
 *
 * - File facts (parsed, errors, warnings, title, content counts, environment, theme): core validation + scenarioBlocks
 *   without run blockers or bindings, in a memo of its own keyed by the file's stat (inode, size, mtime) and the project
 *   files' signatures (project.yaml, sandbox.yaml, hooks/, retake.yaml, the project theme's folder and template.yaml),
 *   sized past BOARD_SCENARIOS_MAX. An entry also holds the files its checks looked for (own media, data, SQL…: core
 *   CheckContext.filesRead), re-statted before it is trusted, and expires after FILE_FACTS_TTL_MS (the scenario view's
 *   text TTL) — review A-M1: an asset removed shows at once, anything else within the minute.
 * - Runs: ONE pass over the project's runs folder, newest first — the newest BOARD_RUNS_WINDOW run.json re-checked by
 *   their stat — grouped by scenario: the running take, the last finished one, the capture (the timeline's rule: the
 *   newest succeeded capture with its video, `until` allowed) and the newest complete dry run. Older runs (finished: they
 *   do not change) are summed up once per project in the same groups and held while the older ids stay the same; new
 *   ones joining at their head are added to it (review A-L2: a never-run scenario no longer walks the folder each read).
 * - "Current": the capture's own scenario.yaml against today's file (core scenarioTextChanged + filmedChanges: an edit-only
 *   change keeps the take current; no snapshot: null), memoised by (capture, snapshot stat, file hash).
 * - Poster and length: `poster(project, run)` — the last step of the capture's timeline with a picture (the binding's
 *   rule) and its scenes' summed length, memoised by the run folder's and timeline's stat.
 * - Renders: one readdir of renders/ (records memoised by their stat) and ONE pass over the job queue per call (render,
 *   review and run jobs of the project; each job.json memoised by its stat, review A-M3), split by scenario in memory —
 *   the running take's job comes from that pass too. The render shown is the newest succeeded landscape render that
 *   shows today's file (the same capture, file bytes and theme, no override: render-words sameVersion), else the newest
 *   succeeded landscape one (review B-L2).
 * Path-free; text read from a file (the video's title, an environment the project does not have) under `untrusted`,
 * capped; strings from run.json only when they have the expected shape (an environment name, an ISO time).
 */
import { lstatSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { SLUG_RE } from '@retake/core/model';
import { isRunId, isThemeName, parseRenderId } from '@retake/core/ids';
import { projectPath } from '@retake/core/project';
import { SCENARIO_COMPARE_MAX_BYTES, filmedChanges, scenarioBlocks, scenarioTextChanged } from '@retake/core/scenario';
import { orderRenders } from '@retake/core/render';
import type { LoadedProject, RunStatus } from '@retake/core/model';
import type { RenderEntry, StoredRenderRecord } from '@retake/core/render';
import { fileFacts, projectTemplateFolderId } from '@retake/core/io';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import type { JobRecord } from './jobs/types.js';
import { jobProject } from './jobs/queue-core.js';
import type { JobQueueView } from './jobs/job-queue.js';
import type { JobFiles } from './jobs/queue.js';
import { RunDataCache, errorScreenshotName, runPictures, stepScreenshotName } from './run-data.js';
import { RunFolder, lsig } from './run-files.js';
import type { ThumbSource } from './run-thumbs.js';
import { readListedRecord, renderView, failureWords, scenarioRenderOf } from './renders.js';
import type { ScenarioRenderView } from './renders.js';
import { readRecord, runFolderIds, takeVerdict } from './runs.js';
import type { RunRecordOnDisk } from './runs.js';
import { capturePicture, stepRef } from './scenario-view.js';
import type { ViewRunStatus } from './scenario-view.js';
import { getScenario, validateScenarioText } from './scenarios.js';
import type { OpenedWorkspace } from './workspace.js';

/** Scenarios the board describes, at most (past it: names only, `truncated`). */
export const BOARD_SCENARIOS_MAX = 200;
/** The newest run folders re-checked at every read (older finished runs are read once). */
export const BOARD_RUNS_WINDOW = 300;
/** A title from a file, at most (characters). */
export const BOARD_TITLE_MAX = 200;
/** File-fact entries held (one per scenario, past the cap). */
const FILE_MEMO_MAX = 512;
/** A file-fact entry is recomputed at least this often (the scenario view's TEXT_TTL_MS: themes, templates, components). */
export const FILE_FACTS_TTL_MS = 60_000;
/** Jobs of the project the board reads, at most (newest first). */
const BOARD_JOBS_MAX = 300;
/** job.json records held (by their stat), all projects together. */
const JOB_MEMO_MAX = 8192;
/** run.json records held (by their stat). */
const RUN_MEMO_MAX = 8192;
/** Projects whose older runs are summed up and held. */
const OLDER_MEMO_MAX = 16;
const JOB_KINDS: ReadonlySet<string> = new Set(['render', 'review', 'run']);
/** An ISO time as run.json holds it (anything else is not passed on). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const iso = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && ISO_RE.test(v) ? v : undefined);
/** Validations at once on a cold read. */
const BOARD_CONCURRENCY = 4;

const KNOWN: ReadonlySet<string> = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const FINISHED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

/** A run as the board tells it. */
export interface BoardRun {
  id: string;
  mode: 'dry' | 'capture';
  status: ViewRunStatus;
  started_at: string;
  finished_at?: string;
  steps_done: number;
  steps_total: number;
  /** Why it is partial, steps 1-based: "until step 4 of request", "failed at step 3 of proposal", "cancelled", "interrupted". */
  partial?: string;
  /** Its job (a run started from a terminal has none). */
  job?: string;
}

export interface BoardScenario {
  name: string;
  /** sha256 of the file (a render's `edit.sha256` against it: render-words sameVersion). */
  hash?: string;
  file: { parsed: boolean; ok: boolean; errors: number; warnings: number; unreadable?: true };
  content: { scenes: number; cards: number; interstitials: number; steps: number; hooks: number };
  /** The file's environment when the project has it, else the project's default (an unknown one: `untrusted.env`). */
  env?: string;
  /** The theme a render of today's file uses (the file's `template:`, else the project's; a render record's `template`). */
  theme?: string;
  running?: BoardRun;
  last_run?: BoardRun;
  /** The capture a render edits (the timeline's rule) and whether today's file still films the same take (null: cannot tell). */
  capture?: { id: string; env: string; finished_at?: string; current: boolean | null };
  /** The newest complete dry run. */
  dry?: { id: string; finished_at?: string };
  /** The newest succeeded landscape render (a render the Studio lists, review included). */
  render?: ScenarioRenderView;
  /**
   * With `render`: whether it shows today's file — the same capture, file bytes and theme (by the theme's folder, a
   * theme the row cannot name included; a record of before L7.9 by its folder's name), no option beyond the files'.
   * The Studio says "Rendered" only then.
   */
  render_current?: boolean;
  /** The newest render attempt failed (its record or its job), after `render` if any. */
  render_failed?: { render_id: string; at: string };
  /** A render of the scenario queued or running. */
  render_job?: { job: string; state: 'queued' | 'running'; reviewing: boolean; fraction?: number };
  /** The newest render's length, else the capture's scenes summed. */
  length?: { seconds: number; from: 'render' | 'capture' };
  /** The capture's (else the dry run's) last step with a picture: run_thumbs takes `key`. */
  poster?: { run: string; key: string };
  /** `env`: an environment the file names that the project does not have (capped, as written). */
  untrusted: { title?: string; error?: string; env?: string };
}

export interface ProjectBoardView {
  project: string;
  default_env?: string;
  scenarios: BoardScenario[];
  /** Past BOARD_SCENARIOS_MAX: how many are described. */
  truncated?: { shown: number; total: number };
  /** Render and review job ids the board shows (a page re-reads it when one of them, or a job it never saw, changes). */
  jobs: string[];
}

export interface RunPoster {
  run: string;
  key: string | null;
  /** Its scenes' captured length summed (s), when the timeline has one. */
  seconds?: number;
}

export interface ProjectBoardContext {
  ws: OpenedWorkspace;
  queue: JobQueueView;
  /** The queue's paths: a job's record is memoised by its file's stat (JobFiles.record). */
  files: Pick<JobFiles, 'record'>;
  project(slug: string): Promise<LoadedProject>;
  /** The run's status with its job overlaid, for a run whose job is not in the board's queue pass (a pass cut short). */
  overlay(slug: string, run: { id: string; status: RunStatus }): Promise<ViewRunStatus>;
}

/** What the board knows of one scenario file (not core's FileFacts port). */
interface BoardFileFacts {
  hash?: string;
  yaml?: string;
  file: BoardScenario['file'];
  content: BoardScenario['content'];
  env?: string;
  /** The file's `template:` as written. */
  template?: string;
  title?: string;
  error?: string;
  /** When computed (ms), the files its checks looked for and their signatures then (review A-M1). */
  at?: number;
  deps?: string[];
  depSig?: string;
}

interface RunEntry {
  sig: string;
  record: RunRecordOnDisk | null;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
  return value;
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** A stat signature without awaiting (thousands of job.json per board read: review A-M3). */
function lsigSync(path: string): string {
  try {
    const s = lstatSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

type Found = { id: string; record: RunRecordOnDisk };
/** A scenario's runs as the board groups them. */
interface RunGroup {
  running?: Found;
  last?: Found;
  capture?: Found;
  dry?: Found;
  lastRun?: BoardRun;
}
/** Older runs summed up per scenario (newest first), held while the older ids stay the same. */
interface OlderIndex {
  ids: string[];
  groups: Map<string, RunGroup>;
}
/** A job's overlay on a queued / running run.json (the engine's own rule). */
const overlaid = (status: string, job: JobRecord): ViewRunStatus | undefined =>
  job.state === 'interrupted' || ((job.state === 'cancelled' || job.state === 'failed') && status === 'queued') ? job.state : undefined;

/**
 * The theme name a render of today's file records (editor plan-run themeRef → the template folder's name): a name as it
 * is, a path its folder's name; undefined when that is not a theme's name (core isThemeName — the one rule for a theme
 * that exists). The same test as a render view's `theme` (renders.ts renderView): the two are compared to tell whether
 * a render shows today's file, so a name one side drops and the other keeps would make a render of another theme look
 * current.
 */
function themeName(p: LoadedProject, ref: string | undefined): string | undefined {
  if (typeof ref !== 'string' || ref.length > 200) return undefined;
  const name = themeIdentity(p, ref);
  return name !== undefined && isThemeName(name) ? name : undefined;
}

/**
 * The theme's name as a render record holds it (`template`: the name of the folder the editor loaded, core io
 * template.ts loadTemplateDir), whatever that folder is called and however long its reference: a name as it is, a
 * path its folder's name. The board compares it with a record that holds no `template_folder` (one of before L7.9),
 * never shows it (`theme` is themeName).
 */
function themeIdentity(p: LoadedProject, ref: string | undefined): string | undefined {
  if (typeof ref !== 'string' || ref === '') return undefined;
  return SLUG_RE.test(ref) ? ref : basename(resolve(p.dir, ref));
}

/** The project boards of one engine (memos apart from the scenario views'). */
export class ProjectBoards {
  private readonly files = new Map<string, BoardFileFacts>();
  private readonly paths = new Map<string, string>();
  private readonly runs = new Map<string, RunEntry>();
  private readonly pictures = new Map<string, Awaited<ReturnType<typeof runPictures>>>();
  private readonly takes = new Map<string, boolean>();
  private readonly currents = new Map<string, boolean | null>();
  private readonly posters = new Map<string, RunPoster>();
  private readonly renderRecords = new Map<string, { sig: string; entry: RenderEntry }>();
  private readonly jobMemo = new Map<string, { sig: string; rec: JobRecord | null }>();
  private readonly older = new Map<string, OlderIndex>();
  /** The board's own run reader (never the scenario screen's cache). */
  private readonly runData = new RunDataCache();
  /** Counters for tests: file facts computed, run.json and job.json read, posters and "current" computed, older runs walked. */
  readonly stats = { files: 0, runs: 0, jobs: 0, posters: 0, current: 0, older: 0 };

  constructor(private readonly ctx: ProjectBoardContext) {}

  async board(slug: string): Promise<ProjectBoardView> {
    const p = await this.ctx.project(slug);
    const names = p.scenarios.slice(0, BOARD_SCENARIOS_MAX);
    const psig = await this.projectSig(p);
    const [facts, groups, pass] = await Promise.all([pool(names, BOARD_CONCURRENCY, (n) => this.boardFileFacts(p, n, psig)), this.runGroups(p, new Set(names)), this.jobsOf(slug)]);
    const jobs = pass.jobs;
    const envs = p.config.environments ?? {};
    const renderJobs = jobs.filter((j) => j.input.kind === 'render');
    const reviewJobs = jobs.filter((j) => j.input.kind === 'review' && !FINISHED_JOB_STATES.has(j.state));
    const runJobs = new Map(jobs.filter((j) => j.input.kind === 'run').map((j) => [j.input.kind === 'run' ? j.input.run_id : '', j]));
    const records = await this.renderRecordsOf(p, new Set(names));
    const shownJobs = new Set<string>();
    // Today's theme folder of each reference (core io projectTemplateFolderId, the editor's rule), once per board.
    const folders = new Map<string, Promise<string | undefined>>();
    const folderIds = (ref: string | undefined): Promise<string | undefined> => {
      if (typeof ref !== 'string') return Promise.resolve(undefined);
      let id = folders.get(ref);
      if (!id) folders.set(ref, (id = projectTemplateFolderId(p, ref).catch(() => undefined)));
      return id;
    };
    const out: BoardScenario[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const f = facts[i];
      const g = groups.get(name) ?? {};
      const s: BoardScenario = { name, file: f.file, content: f.content, untrusted: {} };
      if (f.hash) s.hash = f.hash;
      // An environment the file names is the production's location only when the project has it (review A-M2).
      if (f.env !== undefined) {
        if (Object.hasOwn(envs, f.env)) s.env = f.env;
        else s.untrusted.env = f.env.slice(0, BOARD_TITLE_MAX);
      } else if (p.config.default_env) s.env = p.config.default_env;
      const theme = themeName(p, f.template ?? p.config.template);
      if (theme) s.theme = theme;
      const ref = f.template ?? p.config.template;
      const themeId = themeIdentity(p, ref);
      const themeFolder = await folderIds(ref);
      if (f.title) s.untrusted.title = f.title;
      if (f.error) s.untrusted.error = f.error;
      // The running take, its job's state overlaid (a worker that died: interrupted).
      if (g.running) {
        const job = runJobs.get(g.running.id);
        // Not in the pass: a take from a terminal (no job) — unless the pass stopped at its cap.
        // A group's running take is one whose record says queued or running (runGroups).
        const raw: RunStatus = g.running.record.status === 'queued' ? 'queued' : 'running';
        const status = job ? (overlaid(raw, job) ?? raw) : pass.complete ? this.statusOf(raw) : await this.ctx.overlay(slug, { id: g.running.id, status: raw });
        const run = this.boardRun(g.running.id, g.running.record, status, job?.id);
        // Its job is not in `jobs`: a take's progress is the page's run_status, never a board read (critique M2).
        if (status === 'queued' || status === 'running') s.running = run;
        else if (!g.last || run.id > g.last.id) g.lastRun = run;
      }
      if (!g.lastRun && g.last) g.lastRun = this.boardRun(g.last.id, g.last.record, this.statusOf(g.last.record.status), runJobs.get(g.last.id)?.id);
      if (g.lastRun) s.last_run = g.lastRun;
      if (g.capture) {
        const current = f.yaml !== undefined && f.hash ? await this.current(p, g.capture.id, f.yaml, f.hash) : null;
        const fin = iso(g.capture.record.finished_at);
        s.capture = { id: g.capture.id, env: typeof g.capture.record.env === 'string' && g.capture.record.env.length <= 100 && SLUG_RE.test(g.capture.record.env) ? g.capture.record.env : 'unknown', ...(fin ? { finished_at: fin } : {}), current };
      }
      if (g.dry) {
        const fin = iso(g.dry.record.finished_at);
        s.dry = { id: g.dry.id, ...(fin ? { finished_at: fin } : {}) };
      }
      // Renders: the newest succeeded landscape one, a newer failure, the job running.
      const recs = records.get(name) ?? [];
      const mine = renderJobs.filter((j) => j.input.kind === 'render' && j.input.scenario === name);
      // The newest render that shows today's file (render-words sameVersion's rule, review B-L2), else the newest one.
      const landscape = recs.filter((r) => r.status !== 'failed' && r.status !== 'cancelled' && (r.variant ?? 'landscape') === 'landscape');
      const views = landscape.map((r) => ({ r, v: renderView(p.dir, r, mine, reviewJobs) }));
      // The theme by its identity (BL-164): the record's folder against today's (two folders of one name are two
      // themes); a record of before L7.9, which holds no folder, by its folder's name — also when it is no theme name.
      const sameTheme = (r: StoredRenderRecord): boolean =>
        typeof r.template_folder === 'string' && themeFolder !== undefined ? r.template_folder === themeFolder : themeId === undefined || r.template === themeId;
      const shows = (x: { r: StoredRenderRecord; v: ScenarioRenderView }) =>
        !!f.hash && !!g.capture && x.v.edit.sha256 === f.hash && x.v.run_id === g.capture.id && sameTheme(x.r) && x.v.overrides.length === 0;
      const shown = views.find(shows);
      const pick = shown ?? views[0];
      const best = pick?.r;
      if (pick) {
        s.render = pick.v;
        s.render_current = shown !== undefined;
      }
      const newestRec = recs[0];
      if (newestRec && newestRec.status === 'failed' && newestRec !== best) s.render_failed = { render_id: newestRec.id, at: newestRec.created_at };
      const newestJob = mine[0];
      if (newestJob && newestJob.input.kind === 'render' && (newestJob.state === 'failed' || newestJob.state === 'interrupted')) {
        const at = newestJob.finished_at ?? newestJob.created_at;
        if (!newestRec || at > newestRec.created_at) s.render_failed = { render_id: newestJob.input.render_id, at };
      }
      const open = mine.find((j) => !FINISHED_JOB_STATES.has(j.state));
      if (open) {
        s.render_job = { job: open.id, state: open.state === 'running' ? 'running' : 'queued', reviewing: open.state === 'running' && (open.progress?.phase ?? '').startsWith('review:'), ...(open.progress?.fraction !== undefined ? { fraction: open.progress.fraction } : {}) };
        shownJobs.add(open.id);
      }
      for (const j of reviewJobs) if (j.input.kind === 'review' && recs.some((r) => r.id === (j.input as { render_id: string }).render_id)) shownJobs.add(j.id);
      // Poster: a failed take newer than the capture shows its error screenshot when it has one (review B-L5: the
      // production's word is that failure), else the capture's picture, else the dry run's. Length: the capture's.
      const failed = s.last_run && s.last_run.status === 'failed' && (!g.capture || s.last_run.id > g.capture.id) ? await this.poster(p, s.last_run.id) : undefined;
      const pictured = g.capture?.id ?? g.dry?.id;
      const fromCapture = pictured ? await this.poster(p, pictured) : undefined;
      const poster = failed?.key ? failed : fromCapture;
      if (poster?.key) s.poster = { run: poster.run, key: poster.key };
      if (s.render && s.render.duration_s > 0) s.length = { seconds: s.render.duration_s, from: 'render' };
      else if (g.capture && pictured === g.capture.id && fromCapture?.seconds !== undefined) s.length = { seconds: fromCapture.seconds, from: 'capture' };
      out.push(s);
    }
    return {
      project: slug,
      ...(p.config.default_env ? { default_env: p.config.default_env } : {}),
      scenarios: out,
      ...(p.scenarios.length > names.length ? { truncated: { shown: names.length, total: p.scenarios.length } } : {}),
      jobs: [...shownJobs].sort(),
    };
  }

  /** The last pictured step of a run's timeline and its scenes' length (memoised by the folder's and timeline's stat). */
  async poster(p: LoadedProject, runId: string): Promise<RunPoster> {
    const dir = projectPath(p.dir, 'runs', runId);
    const key = `${dir}\0${await lsig(dir)}\0${await lsig(join(dir, 'timeline.json'))}`;
    const hit = this.posters.get(key);
    if (hit) return hit;
    this.stats.posters++;
    const run = isRunId(runId) ? await this.runData.get(p.dir, runId) : null;
    let found: string | null = null;
    let seconds: number | undefined;
    if (run) {
      // A failed take: the error screenshot of the step it failed at (run_thumbs serves it under that key, either mode).
      const err = run.record?.status === 'failed' ? run.record.error : undefined;
      if (err && typeof err.scene === 'string' && SLUG_RE.test(err.scene) && typeof err.step === 'number' && Number.isInteger(err.step) && err.step >= 0 && run.screenshots.has(errorScreenshotName(err.scene, err.step))) found = `${err.scene}.${err.step}`;
      const seen = new Map<string, ThumbSource | null>();
      const events = [...run.events.values()];
      for (let i = events.length - 1; i >= 0 && found === null; i--) {
        const ev = events[i];
        if (ev.status === 'skipped') continue;
        let picture: ThumbSource | null = null;
        if (run.mode === 'capture') picture = await capturePicture(run, ev, seen);
        else if (run.mode === 'dry') {
          const shot = ev.status === 'failed' ? errorScreenshotName(ev.scene, ev.step) : stepScreenshotName(ev.scene, ev.step, ev.action);
          picture = shot && run.screenshots.has(shot) ? 'screenshot' : null;
        }
        if (picture) found = `${ev.scene}.${ev.step}`;
      }
      let sum = 0;
      for (const sc of run.scenes.values()) {
        const d = Number(sc.t_end) - Number(sc.t_start);
        if (Number.isFinite(d) && d > 0) sum += d;
      }
      if (sum > 0) seconds = Math.round(sum * 10) / 10;
    }
    return remember(this.posters, key, { run: runId, key: found, ...(seconds !== undefined ? { seconds } : {}) }, FILE_MEMO_MAX);
  }

  // ── Files ───────────────────────────────────────────────────────────────

  private async projectSig(p: LoadedProject): Promise<string> {
    // The project's theme as validation loads it (templateOf): its folder (a file added or gone) and its template.yaml.
    const ref = p.config.template;
    const theme = SLUG_RE.test(ref) ? join(this.ctx.ws.templatesDir, ref) : resolve(p.dir, ref);
    const files = [join(p.dir, 'project.yaml'), join(p.dir, 'sandbox.yaml'), projectPath(p.dir, 'hooks'), join(this.ctx.ws.root, 'retake.yaml'), theme, join(theme, 'template.yaml')];
    return (await Promise.all(files.map(lsig))).join('|');
  }

  /** The files a file-fact entry's checks looked for, signed together. */
  private async depSig(deps: readonly string[]): Promise<string> {
    return (await Promise.all(deps.map(lsig))).join('|');
  }

  private async boardFileFacts(p: LoadedProject, name: string, psig: string): Promise<BoardFileFacts> {
    const known = this.paths.get(`${p.dir}\0${name}`);
    let sig = '';
    if (known) {
      try {
        const st = await stat(known);
        sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        sig = '';
      }
    }
    const key = `${p.dir}\0${name}\0${sig}\0${psig}`;
    const hit = sig ? this.files.get(key) : undefined;
    // Trusted while young and while every file its checks looked for is as it was (review A-M1).
    if (hit && (hit.at === undefined || Date.now() - hit.at < FILE_FACTS_TTL_MS) && (!hit.deps || (await this.depSig(hit.deps)) === hit.depSig)) return hit;
    this.stats.files++;
    const empty = { scenes: 0, cards: 0, interstitials: 0, steps: 0, hooks: 0 };
    let text: Awaited<ReturnType<typeof getScenario>>;
    try {
      text = await getScenario(p, name);
    } catch (e) {
      return { file: { parsed: false, ok: false, errors: 1, warnings: 0, unreadable: true }, content: empty, error: failureWords(e instanceof Error ? e.message : String(e)) };
    }
    remember(this.paths, `${p.dir}\0${name}`, text.path, FILE_MEMO_MAX);
    let fileSig = '';
    try {
      const st = await stat(text.path);
      fileSig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      /* gone meanwhile: not memoised */
    }
    const filesRead = new Set<string>();
    const at = Date.now();
    const { ok, issues } = await validateScenarioText(p, text.yaml, { files: fileFacts(this.ctx.ws.policy), name, filesRead });
    const deps = [...filesRead].sort();
    const depSig = await this.depSig(deps);
    const blocks = scenarioBlocks(text.yaml, { issues });
    const content = { ...empty };
    const sceneIds = new Set<string>();
    for (const e of blocks.entries) {
      if (e.type === 'scene') sceneIds.add(e.id);
      else if (e.type === 'card') content.cards++;
      else if (e.type === 'interstitial') content.interstitials++;
    }
    content.scenes = sceneIds.size;
    content.steps = blocks.step_count;
    content.hooks = blocks.hooks.setup.length + blocks.hooks.teardown.length + blocks.hooks.named.length;
    const t = blocks.video.title;
    const title = (t?.text ?? t?.kicker ?? '').trim().slice(0, BOARD_TITLE_MAX);
    const facts: BoardFileFacts = {
      hash: text.hash,
      yaml: text.yaml,
      file: { parsed: blocks.parsed, ok, errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length },
      content,
      ...(blocks.video.env ? { env: blocks.video.env } : {}),
      ...(blocks.video.template ? { template: blocks.video.template } : {}),
      ...(title ? { title } : {}),
      at,
      deps,
      depSig,
    };
    return fileSig ? remember(this.files, `${p.dir}\0${name}\0${fileSig}\0${psig}`, facts, FILE_MEMO_MAX) : facts;
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  private statusOf(raw: string): ViewRunStatus {
    return KNOWN.has(raw) ? (raw as ViewRunStatus) : 'unknown';
  }

  private boardRun(id: string, r: RunRecordOnDisk, status: ViewRunStatus, job: string | undefined): BoardRun {
    let partial: string | undefined;
    if (status === 'cancelled') partial = 'cancelled';
    else if (status === 'interrupted') partial = 'interrupted';
    else if (status === 'failed') partial = r.error && typeof r.error.scene === 'string' ? `failed at ${stepRef(r.error.scene, r.error.step)}` : 'failed';
    else if (r.stopped_at?.reason === 'until') partial = `until ${stepRef(r.stopped_at.scene, r.stopped_at.step)}`;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return {
      id,
      mode: r.mode === 'dry' ? 'dry' : 'capture',
      status,
      started_at: typeof r.started_at === 'string' ? r.started_at : '',
      ...(typeof r.finished_at === 'string' ? { finished_at: r.finished_at } : {}),
      steps_done: n(r.steps_done),
      steps_total: n(r.steps_total),
      ...(partial ? { partial } : {}),
      ...(job ? { job } : {}),
    };
  }

  /** run.json of a run: re-checked by its stat (`check`), else held once read (an older finished run). */
  private async record(projectDir: string, id: string, check: boolean): Promise<RunRecordOnDisk | null> {
    const file = projectPath(projectDir, 'runs', id, 'run.json');
    const key = `${projectDir}\0${id}`;
    const held = this.runs.get(key);
    if (held && !check && (held.record === null || FINISHED.has(this.statusOf(held.record.status)))) return held.record;
    const sig = await lsig(file);
    if (held && held.sig === sig) return held.record;
    this.stats.runs++;
    const { record } = sig === '-' ? { record: undefined } : await readRecord(file);
    const rec = record && typeof record.scenario === 'string' ? record : null;
    remember(this.runs, key, { sig, record: rec }, RUN_MEMO_MAX);
    return rec;
  }

  private async picturesOf(projectDir: string, id: string, mode: string): Promise<Awaited<ReturnType<typeof runPictures>>> {
    const key = `${projectDir}\0${id}\0${await lsig(projectPath(projectDir, 'runs', id))}`;
    if (this.pictures.has(key)) return this.pictures.get(key)!;
    return remember(this.pictures, key, await runPictures(projectDir, id, mode), 2048);
  }

  /** Whether a run is a take (core takeOf over the one reader), held while its folder and its timeline keep their signatures. */
  private async takeOf(projectDir: string, id: string): Promise<boolean> {
    const dir = projectPath(projectDir, 'runs', id);
    const key = `${projectDir}\0${id}\0${await lsig(dir)}\0${await lsig(join(dir, 'timeline.json'))}`;
    if (this.takes.has(key)) return this.takes.get(key)!;
    // As the board's pictures: only of a run folder that really lies in the project (RunFolder).
    return remember(this.takes, key, (await takeVerdict(projectDir, id)).usable && (await RunFolder.open(projectDir, id)) !== null, 2048);
  }

  /** One finished run into its scenario's group (newest first: the first of each kind wins). */
  private async addFinished(p: LoadedProject, g: RunGroup, id: string, r: RunRecordOnDisk): Promise<void> {
    const status = this.statusOf(r.status);
    if (!g.last) g.last = { id, record: r };
    // The scenario's capture is the take a render edits: the one rule, never this file's own (frames without a film are no take).
    if (r.mode === 'capture' && status === 'succeeded' && !g.capture && (await this.takeOf(p.dir, id))) g.capture = { id, record: r };
    if (r.mode === 'dry' && status === 'succeeded' && !g.dry && r.stopped_at?.reason !== 'until' && !g.capture && (await this.picturesOf(p.dir, id, r.mode)) !== null) g.dry = { id, record: r };
  }

  /** Runs `ids` (newest first, past the window: finished) summed up per scenario. */
  private async summed(p: LoadedProject, ids: readonly string[]): Promise<Map<string, RunGroup>> {
    const out = new Map<string, RunGroup>();
    for (const id of ids) {
      this.stats.older++;
      const r = await this.record(p.dir, id, false);
      if (!r) continue;
      const status = this.statusOf(r.status);
      // An old take left "running" (its process gone) is no group's last take: the window's rule.
      if (status === 'queued' || status === 'running') continue;
      const g = out.get(r.scenario) ?? {};
      out.set(r.scenario, g);
      await this.addFinished(p, g, id, r);
    }
    return out;
  }

  /**
   * The project's older runs (past the window) summed up, held while their ids stay the same; ids that joined at the
   * head (the window moved on) are summed and put before what was held (review A-L2).
   */
  private async olderGroups(p: LoadedProject, ids: readonly string[]): Promise<Map<string, RunGroup>> {
    const held = this.older.get(p.dir);
    const k = held ? ids.length - held.ids.length : -1;
    let tailSame = held !== undefined && k >= 0;
    for (let i = 0; tailSame && held && i < held.ids.length; i++) if (ids[k + i] !== held.ids[i]) tailSame = false;
    let groups: Map<string, RunGroup>;
    if (held && tailSame) {
      if (k === 0) return held.groups;
      const head = await this.summed(p, ids.slice(0, k));
      groups = new Map(held.groups);
      for (const [name, h] of head) {
        const o = groups.get(name) ?? {};
        // The head is newer: its last take and capture win; a dry run counts only when no newer capture exists.
        groups.set(name, { ...(h.last ?? o.last ? { last: h.last ?? o.last } : {}), ...(h.capture ?? o.capture ? { capture: h.capture ?? o.capture } : {}), ...(h.dry ? { dry: h.dry } : !h.capture && o.dry ? { dry: o.dry } : {}) });
      }
    } else groups = await this.summed(p, ids);
    remember(this.older, p.dir, { ids: [...ids], groups }, OLDER_MEMO_MAX);
    return groups;
  }

  private async runGroups(p: LoadedProject, names: ReadonlySet<string>) {
    const groups = new Map<string, RunGroup>();
    let ids: string[] = [];
    try {
      // The one order of runs (core orderRuns): a folder named to sort above the dates is never before a dated run.
      ids = await runFolderIds(p.dir);
    } catch {
      return groups;
    }
    // The window is read at once (stats in parallel) and re-checked at every read.
    const window = await Promise.all(ids.slice(0, BOARD_RUNS_WINDOW).map((id) => this.record(p.dir, id, true)));
    for (let i = 0; i < window.length; i++) {
      const id = ids[i];
      const r = window[i];
      if (!r || !names.has(r.scenario)) continue;
      const g = groups.get(r.scenario) ?? {};
      groups.set(r.scenario, g);
      const status = this.statusOf(r.status);
      if (status === 'queued' || status === 'running') {
        // Only the newest unfinished take counts.
        if (!g.running && !g.last) g.running = { id, record: r };
        continue;
      }
      await this.addFinished(p, g, id, r);
    }
    // A scenario still without its last take and capture: the older runs, summed up once (review A-L2).
    if (ids.length > BOARD_RUNS_WINDOW && [...names].some((n) => !groups.get(n)?.last || !groups.get(n)?.capture)) {
      const older = await this.olderGroups(p, ids.slice(BOARD_RUNS_WINDOW));
      for (const name of names) {
        const o = older.get(name);
        if (!o) continue;
        const g = groups.get(name) ?? {};
        groups.set(name, g);
        const hadCapture = g.capture !== undefined;
        if (!g.last && o.last) g.last = o.last;
        if (!g.capture && o.capture) g.capture = o.capture;
        if (!g.dry && !hadCapture && o.dry) g.dry = o.dry;
      }
    }
    return groups;
  }

  /** Whether today's file films the capture's take: unchanged, or only its edit changed (null: no snapshot to tell). */
  private async current(p: LoadedProject, runId: string, yaml: string, hash: string): Promise<boolean | null> {
    const snap = projectPath(p.dir, 'runs', runId, 'scenario.yaml');
    const key = `${snap}\0${await lsig(snap)}\0${hash}`;
    if (this.currents.has(key)) return this.currents.get(key)!;
    this.stats.current++;
    const folder = await RunFolder.open(p.dir, runId);
    const read = folder ? await folder.read('scenario.yaml', SCENARIO_COMPARE_MAX_BYTES) : undefined;
    const then = read?.ok ? read.bytes.toString('utf8') : undefined;
    const changed = scenarioTextChanged(yaml, then);
    let current: boolean | null;
    if (changed === undefined) current = null;
    else if (!changed) current = true;
    else {
      const filmed = filmedChanges(yaml, then as string);
      current = filmed !== undefined && filmed.length === 0;
    }
    return remember(this.currents, key, current, FILE_MEMO_MAX);
  }

  // ── Jobs ────────────────────────────────────────────────────────────────

  /**
   * The project's render, review and run jobs, newest first, at most BOARD_JOBS_MAX — ONE pass over the queue, each
   * job.json read once while its stat holds (review A-M3: jobs are never pruned; a finished job never changes).
   * `complete`: the pass saw the whole queue (a run whose job is not in it has none).
   */
  private async jobsOf(slug: string): Promise<{ jobs: JobRecord[]; complete: boolean }> {
    const q = this.ctx.queue;
    const ids = await q.ids();
    const jobs: JobRecord[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      if (jobs.length >= BOARD_JOBS_MAX) return { jobs, complete: false };
      const id = ids[i];
      const sig = lsigSync(this.ctx.files.record(id));
      let held = this.jobMemo.get(id);
      if (!held || held.sig !== sig) {
        this.stats.jobs++;
        const stored = sig === '-' ? undefined : await q.stored(id).catch(() => undefined);
        held = { sig, rec: stored && JOB_KINDS.has(stored.kind) ? stored : null };
        remember(this.jobMemo, id, held, JOB_MEMO_MAX);
      }
      const rec = held.rec;
      if (!rec || jobProject(rec.input) !== slug) continue;
      jobs.push(FINISHED_JOB_STATES.has(rec.state) ? rec : await q.derive(rec));
    }
    return { jobs, complete: true };
  }

  // ── Renders ─────────────────────────────────────────────────────────────

  /** The project's render records per scenario, newest first (one readdir; records held while their stat holds). */
  private async renderRecordsOf(p: LoadedProject, names: ReadonlySet<string>): Promise<Map<string, StoredRenderRecord[]>> {
    const out = new Map<string, StoredRenderRecord[]>();
    const files = await readdir(projectPath(p.dir, 'renders')).catch(() => [] as string[]);
    // renders/<render id>.json of one of the scenarios (named by the file first: no other file is read); the record is
    // filed under the scenario its name gives when it is a render of it (core's rule: a complete record of its own
    // file that says that scenario).
    const wanted: Array<{ f: string; scenario: string }> = [];
    for (const f of files) {
      const scenario = f.endsWith('.json') ? parseRenderId(f.slice(0, -5))?.scenario : undefined;
      if (scenario !== undefined && names.has(scenario)) wanted.push({ f, scenario });
    }
    const sigs = await Promise.all(wanted.map((w) => lsig(projectPath(p.dir, 'renders', w.f))));
    // The files whose stat changed are read one after another: a record's text (megabytes with its plan) is parsed and
    // let go before the next one is read — two hundred of them held at once cost a cold board a tenth of its time.
    for (const [i, { f, scenario }] of wanted.entries()) {
      const key = `${p.dir}\0${f}`;
      const sig = sigs[i] as string;
      let held = this.renderRecords.get(key);
      if (!held || held.sig !== sig) {
        held = { sig, entry: await readListedRecord(p.dir, f.slice(0, -5)) };
        remember(this.renderRecords, key, held, 4096);
      }
      const record = scenarioRenderOf(held.entry, scenario);
      if (record) {
        const list = out.get(scenario) ?? [];
        list.push(record);
        out.set(scenario, list);
      }
    }
    // Newest first (the one order of renders, reversed).
    for (const [scenario, list] of out) out.set(scenario, orderRenders(list).reverse());
    return out;
  }
}
