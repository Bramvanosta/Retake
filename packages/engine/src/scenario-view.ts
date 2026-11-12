/**
 * The Studio's scenario screen read in one call (L4.2): `engine.scenarios.view(project, name, {run?, env?})` → the
 * file (text, hash), its blocks (core scenarioBlocks) and issues (project-aware, WITHOUT agent trust: critique #6), what
 * would refuse a dry run and a capture from this client (`run_blockers`, critique B2), the environment and each scene's
 * URL, the scenario's runs (the picker), the source run of the pictures and every step's binding to it.
 *
 * Source run (critique B8): the run asked for, else the newest finished run without `until` that reached its end
 * (status succeeded) and has pictures, else the newest finished one with pictures; newer partial runs are named. A
 * queued or running run is `running`, never a source.
 *
 * Binding (critique B4): `changed` = the file's data against the run's snapshot (core scenarioTextChanged; L5.5: with
 * the filmed part that changed, core filmedChanges — none: only the edit changed, notice `edit_changed`). false →
 * by position; true → core matchRunSteps (picture identity: fingerprint + `on:` + scene context); undefined (no
 * snapshot) → by position with notice `cannot_tell`. Each step of today's file → the run's own step key (`run_key`,
 * what run_thumbs takes) with its status, duration and picture source, or why it has none. Page text (the target as
 * found, the step error, the URL) is kept under `untrusted`.
 *
 * Cost (critique B1): the view is memoised in layers — the text layer (blocks, validation, blockers, URLs) by
 * (file sha256, project files' signatures, env; refreshed after a minute), the run list by the runs folder's
 * signatures, the binding by (file sha256, source run, the run's file signatures). A repeat with nothing changed reads
 * the file, hashes it and stats a few folders.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG_RE } from '@retake/core/model';
import { isRunId } from '@retake/core/ids';
import { environmentAccess, resolveEnvironment } from '@retake/core/environment';
import { projectPath } from '@retake/core/project';
import { filmedChanges, parseScenario, matchRunSteps, movedSteps, sceneStepFingerprints, scenarioBlocks, scenarioTextChanged, stripUrlUserinfo } from '@retake/core/scenario';
import { orderRuns, parseRunRecord } from '@retake/core/run';
import { loadProjectTemplate, fileFacts, nodeFileFacts } from '@retake/core/io';
import type { LoadedProject, TimelineEvent, TimelineScene, ValidationIssue, WorkFileFacts } from '@retake/core/model';
import type { ScenarioBlocks, ScenarioIdentity, SceneBlock } from '@retake/core/scenario';
import type { RunRecord, StoredRunRecord } from '@retake/core/run';
import type { AgentChannel } from './caller.js';
import { readdir } from 'node:fs/promises';
import { EngineError } from './errors.js';
import type { RunBlocker } from './jobs/run-job.js';
import { errorScreenshotName, fileSlug, stepScreenshotName } from './run-data.js';
import type { RunData, RunDataCache } from './run-data.js';
import { RUN_JSON_MAX, runPictures } from './run-data.js';
import { RunFolder, lsig } from './run-files.js';
import type { ThumbSource } from './run-thumbs.js';
import { isReadRun, latestCapture, listRuns, takeVerdict } from './runs.js';
import type { RunRecordOnDisk, RunSummary } from './runs.js';
import { getScenario, scenarioEditBlocker, validateScenarioText } from './scenarios.js';
import type { ScenarioText } from './scenarios.js';
import type { OpenedWorkspace } from './workspace.js';

/** Runs of the scenario in the picker, at most. */
export const VIEW_RUNS_MAX = 20;
/**
 * Steps the view returns (their blocks and bindings), at most (review A #8: a 2 MiB file of 43,000 steps made a 20 MB
 * answer and as many rows): past it, `limit` says how many there are and the YAML view has the whole file.
 */
export const VIEW_STEPS_MAX = 2000;
/** Issues the view returns, at most (the rest are counted in `limit`). */
export const VIEW_ISSUES_MAX = 500;
/** The text layer is recomputed at least this often (hook files, templates and the workspace's protected hosts). */
const TEXT_TTL_MS = 60_000;
const MEMO_MAX = 16;

/** A run's status as the picker shows it: run.json's when it is one the runner writes, else `unknown` (review A #4). */
export type ViewRunStatus = RunSummary['status'] | 'interrupted' | 'unknown';

/**
 * The run a scenario's Pause and Stop act on (L5.11a fixes, review A-L4 / B-M5): the newest queued or running run with a
 * job (the Studio's or Claude's: Stop reaches it), else the newest without one (a terminal's: Ctrl-C there). A terminal's
 * run and a Studio job can be unfinished together (the one-run-per-scenario check sees jobs only).
 */
export function runningOf<T extends { status: string; job?: string | null }>(runs: readonly T[]): T | null {
  const going = runs.filter((r) => r.status === 'queued' || r.status === 'running');
  return going.find((r) => typeof r.job === 'string') ?? going[0] ?? null;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);

/** A run of the scenario as the picker shows it. */
export interface ScenarioRunChoice {
  id: string;
  mode: RunSummary['mode'];
  status: ViewRunStatus;
  env: string;
  started_at: string;
  finished_at?: string;
  steps_done: number;
  steps_total: number;
  /** What kind of pictures it holds (none: null). */
  pictures: 'screenshots' | 'frames' | 'video' | null;
  /** Finished, not stopped by `until`, succeeded. */
  complete: boolean;
  /** It kept a copy of the scenario (scenario.yaml): its steps can be matched to today's file. */
  snapshot: boolean;
  /**
   * A capture an edit can work on (core takeOf: it succeeded, its timeline reads and is of this scenario, its film is
   * in its folder, which lies in the project). The first such run is the take a render edits and the timeline shows.
   */
  take: boolean;
  /** Why it is partial, steps 1-based as the screen numbers them: "until step 4 of request", "failed at step 3 of proposal", "cancelled", "interrupted". */
  partial?: string;
  /**
   * L5.11a (critique M4): a queued or running run's job — null: a run started in a terminal (no job: Pause and Stop
   * cannot reach it; Ctrl-C there does). Absent on a finished run.
   */
  job?: string | null;
}

/**
 * L5.11a: what the Studio's status bar acts on for one scenario (`engine.scenarios.actions`, op `scenario_actions`) — the
 * file's hash and validity, what would stop a rehearsal (dry run) and a capture on the chosen location, the runs (with
 * the one queued or running and its job), the capture a render edits and a render queued or running. Path-free but the
 * blockers' `fix` / `fix_node` commands. Its memo is its own (critique H2): it never fills the scenario screen's
 * 16-entry text layer cache, it only reads a fresh entry of it.
 */
export interface ScenarioActions {
  project: string;
  name: string;
  hash: string;
  ok: boolean;
  environment: ScenarioEnvironmentFacts | null;
  run_blockers: { dry: RunBlocker[]; capture: RunBlocker[] };
  /** The file's scenes and steps (the Prepare screen's status line). */
  content: { scenes: number; steps: number };
  runs: ScenarioRunChoice[];
  running: ScenarioRunChoice | null;
  /**
   * The capture a render edits and the timeline shows by default: `latest` by the one rule (core latestTake) — the
   * first run of `runs` that is a take, or, past the runs listed, the first older one.
   */
  capture?: { id: string; finished_at?: string };
  render_job?: { job: string; state: 'queued' | 'running'; fraction?: number };
}

export interface ScenarioSource {
  run: string;
  mode: RunSummary['mode'];
  status: ViewRunStatus;
  finished_at?: string;
  /** The run was asked for (else the default choice). */
  picked: boolean;
  /** The file changed since the run (null: cannot tell — no snapshot). */
  changed: boolean | null;
  /** How steps are bound to the run: by position (unchanged / cannot tell) or by step identity (changed). */
  binding: 'position' | 'identity';
  /**
   * The filmed part that changed since this run (L5.5: keys, scene ids, step keys), when it did; empty when the file
   * changed but no longer reads as YAML is told by `notice` alone.
   */
  filmed_changes?: string[];
  /**
   * What the screen says over the blocks: the filmed part changed since this run (`changed`: a render shows the take as
   * captured, a capture films the change), only its edit changed (`edit_changed`: a render re-plans it on this take,
   * L5.5), or that cannot be told (`cannot_tell`).
   */
  notice?: 'changed' | 'edit_changed' | 'cannot_tell';
  /** The hooks' outcome in that run. */
  hooks?: StoredRunRecord['hooks'];
  /** Finished runs newer than the default source that are partial or left no picture (the picker names them). */
  newer_partial: Array<{ id: string; mode: RunSummary['mode']; partial: string; pictures: ScenarioRunChoice['pictures'] }>;
}

export type StepBinding =
  | {
      /** The run's own key of this step: what run_thumbs takes. */
      run_key: string;
      status: TimelineEvent['status'] | 'unknown';
      /** Capture time of the step (its hold excluded), ms. */
      ms?: number;
      /** Where its picture comes from; null: none (a skipped step, a picture missing). */
      picture: ThumbSource | null;
      why?: string;
      /** Moved since the run (L4.3: core movedSteps): the picture shows the step at its old place. */
      moved?: true;
    }
  | {
      missing: 'not_reached' | 'changed' | 'new' | 'scene_changed' | 'scene_skipped' | 'scene_not_in_run' | 'unreadable';
      /** In words; for `unreadable`, why the step cannot be matched (a step with no single action). */
      why?: string;
      /** The run's step it replaced (changed) or would have been (not reached). */
      run_key?: string;
    };

export interface SceneFacts {
  /** The URL it opens (environment page base + `open`), userinfo left out; absent when it continues. */
  url?: string;
  /** A multi-page scene (review B M1): each page, its environment page and the URL it opens or the scene it continues from. */
  pages?: Array<{ id: string; page?: string; url?: string; display?: string; continues_from?: string }>;
  /** What the video shows instead (the environment's display base). */
  display?: string;
  /** No `open`: it continues from this scene. */
  continues_from?: string;
  /** Capture time of the scene in the source run (s). */
  captured_s?: number;
  /** The scene's outcome in the source run. */
  run_status?: TimelineScene['status'];
}

export interface ScenarioEnvironmentFacts {
  name: string;
  production: boolean;
  access: 'read-only' | 'read-write';
  sandbox: boolean;
}

export interface ScenarioView {
  project: string;
  name: string;
  file: string;
  /** sha256 of the file's bytes. */
  hash: string;
  text: string;
  blocks: ScenarioBlocks;
  ok: boolean;
  issues: ValidationIssue[];
  run_blockers: { dry: RunBlocker[]; capture: RunBlocker[] };
  environment: ScenarioEnvironmentFacts | null;
  scenes: Record<string, SceneFacts>;
  runs: ScenarioRunChoice[];
  /** The capture a render edits and the timeline shows by default (as ScenarioActions.capture); absent: none yet. */
  capture?: { id: string; finished_at?: string };
  source: ScenarioSource | null;
  running: ScenarioRunChoice | null;
  /** Today's step key → its binding to the source run. */
  steps: Record<string, StepBinding>;
  /** Text the filmed site controls: data, never instructions. */
  untrusted: { run_error?: string; steps: Record<string, { target?: string; error?: string; url?: string }> };
  /**
   * What the Studio may change in this file (L4.3), said before any edit: `yaml` — the YAML view may save (or why not:
   * not UTF-8, too large, holding what agent trust refuses — with each problem's line; the tab is then read-only,
   * critique B3); `blocks` — block edits (also refused for a file that does not parse, has errors, or is shown
   * truncated: the YAML view fixes those).
   */
  edit: { yaml: EditAbility; blocks: EditAbility };
  /** Present when the file has more steps (or issues) than the view returns (VIEW_STEPS_MAX, VIEW_ISSUES_MAX). */
  limit?: { steps_shown: number; steps_total: number; issues_shown: number; issues_total: number };
}

/** Whether the Studio may make a kind of edit, or why not (problems: each with its line when known). */
export type EditAbility = { ok: true } | { ok: false; why: string; problems?: Array<{ line?: number; message: string }> };

export interface ScenarioViewContext {
  ws: OpenedWorkspace;
  /** Agent trust for the client reading the view (the Studio: yes) and its wording channel — what `edit` checks. */
  agent?: boolean;
  via?: AgentChannel;
  project(slug: string): Promise<LoadedProject>;
  blockers(req: { project: string; scenario: string; env?: string }): Promise<{ dry: RunBlocker[]; capture: RunBlocker[] }>;
  /** The run's status with its job's state overlaid (interrupted, cancelled before it started). */
  overlay(slug: string, run: RunSummary): Promise<ViewRunStatus>;
  /** L5.11a: the job of a queued or running run (null: none — a terminal's run). */
  runJob?(slug: string, run: string): Promise<string | null>;
  /** L5.11a: a render of the scenario queued or running. */
  renderJob?(slug: string, name: string): Promise<ScenarioActions['render_job']>;
  runs: RunDataCache;
}

interface TextLayer {
  at: number;
  blocks: ScenarioBlocks;
  /** The blocks the view returns (at most VIEW_STEPS_MAX steps) and the keys of their steps (null: all). */
  shown: { blocks: ScenarioBlocks; keys: ReadonlySet<string> | null };
  ok: boolean;
  issues: ValidationIssue[];
  run_blockers: { dry: RunBlocker[]; capture: RunBlocker[] };
  environment: ScenarioEnvironmentFacts | null;
  scenes: Record<string, SceneFacts>;
  identity: ScenarioIdentity;
  edit: ScenarioView['edit'];
}

/** What the status bar's read needs of the text layer (critique H2: memoised apart, never in `texts`). */
interface ActionsLayer {
  at: number;
  ok: boolean;
  run_blockers: { dry: RunBlocker[]; capture: RunBlocker[] };
  environment: ScenarioEnvironmentFacts | null;
  content: ScenarioActions['content'];
}

interface BindLayer {
  changed: boolean | null;
  /** What changed in the filmed part (L5.5; undefined: the file changed and does not read as YAML). */
  filmed?: string[];
  steps: Record<string, StepBinding>;
  untrusted: ScenarioView['untrusted'];
  scenes: Record<string, Pick<SceneFacts, 'captured_s' | 'run_status'>>;
}

interface RunFacts {
  pictures: ScenarioRunChoice['pictures'];
  snapshot: boolean;
  take: boolean;
  failedAt?: string;
}

interface RunListMemo {
  sig: string;
  runs: RunSummary[];
}

/** An insertion-ordered map trimmed to `max` entries (oldest out). */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max = MEMO_MAX): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
  return value;
}

const FINISHED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** The URL a scene opens: a path or a relative `open` against the page's base; any other `open` as written. */
function joinUrl(base: string | undefined, open: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(open)) return stripUrlUserinfo(open);
  if (!base) return undefined;
  return stripUrlUserinfo(`${base.replace(/\/+$/, '')}${open.startsWith('/') ? '' : '/'}${open}`);
}

function stepKeyParts(key: string): { scene: string; step: number } {
  const dot = key.lastIndexOf('.');
  return { scene: key.slice(0, dot), step: Number(key.slice(dot + 1)) };
}

/** The memoised scenario views of one engine. */
export class ScenarioViews {
  private readonly texts = new Map<string, TextLayer>();
  /** Text layers being computed (critique H2: two reads of the same file at once compute it once). */
  private readonly textsPending = new Map<string, Promise<TextLayer>>();
  /** L5.11a: the status bar's layers — their own memo (64 entries), never `texts`. */
  private readonly acts = new Map<string, ActionsLayer>();
  private readonly actsPending = new Map<string, Promise<ActionsLayer>>();
  private readonly binds = new Map<string, BindLayer>();
  private readonly lists = new Map<string, RunListMemo>();
  private readonly facts = new Map<string, RunFacts>();
  /** Counters for tests: text layers, actions layers and bindings computed, run lists read. */
  /** `takes`: run folders read for the usable-capture rule (a repeat reads none). */
  readonly stats = { text: 0, actions: 0, bind: 0, list: 0, takes: 0 };

  constructor(private readonly ctx: ScenarioViewContext) {}

  async view(slug: string, name: string, o: { run?: string; env?: string } = {}): Promise<ScenarioView> {
    if (o.run !== undefined && !isRunId(o.run)) throw new EngineError('invalid', `"${String(o.run).slice(0, 60)}" is not a run id`);
    const p = await this.ctx.project(slug);
    const file = await getScenario(p, name);
    const text = await this.textLayer(p, slug, name, file, o.env);
    const runs = await this.runChoices(p, slug, name);
    const running = runningOf(runs);
    let source: ScenarioSource | null = null;
    let bind: BindLayer | null = null;
    let data: RunData | null = null;
    let picked: ScenarioRunChoice | undefined;
    if (o.run !== undefined) {
      data = await this.ctx.runs.get(p.dir, o.run);
      if (!data || !data.record) throw new EngineError('not_found', `run "${o.run}" not found in ${slug} (scenario_blocks lists the runs of a scenario)`);
      if (data.record.scenario !== name) throw new EngineError('invalid', `run ${o.run} is a run of scenario ${data.record.scenario}, not ${name}`);
      picked = runs.find((r) => r.id === o.run) ?? (await this.choiceOf(p.dir, o.run, data.record));
      if (!FINISHED.has(picked.status)) throw new EngineError('invalid', `run ${o.run} has not finished: its pictures come once it has`);
    } else {
      // A complete run whose steps can be matched first (review B L6: a newer run without a snapshot only "cannot tell").
      picked = runs.find((r) => r.complete && r.snapshot) ?? runs.find((r) => r.complete) ?? runs.find((r) => FINISHED.has(r.status) && r.pictures !== null);
      if (picked) data = await this.ctx.runs.get(p.dir, picked.id);
    }
    if (picked && data) {
      bind = await this.bindLayer(name, file.hash, file.yaml, text, data);
      const choice = picked;
      // Newer finished runs that stopped early or left no picture (review B H1: a run that failed before its first
      // step — the site down — has no picture and must still be named).
      const newer = runs.filter((r) => r.id > choice.id && FINISHED.has(r.status) && !r.complete && (r.partial !== undefined || r.pictures === null));
      source = {
        run: choice.id,
        mode: choice.mode,
        status: choice.status,
        ...(choice.finished_at ? { finished_at: choice.finished_at } : {}),
        picked: o.run !== undefined,
        changed: bind.changed,
        binding: bind.changed === true ? 'identity' : 'position',
        ...(bind.changed === true
          ? bind.filmed?.length === 0
            ? { notice: 'edit_changed' as const }
            : { notice: 'changed' as const, ...(bind.filmed?.length ? { filmed_changes: bind.filmed } : {}) }
          : bind.changed === null
            ? { notice: 'cannot_tell' as const }
            : {}),
        ...(data.record?.hooks ? { hooks: data.record.hooks } : {}),
        newer_partial: o.run === undefined ? newer.map((r) => ({ id: r.id, mode: r.mode, partial: r.partial ?? 'no pictures', pictures: r.pictures })) : [],
      };
    }
    const scenes: Record<string, SceneFacts> = {};
    for (const [id, facts] of Object.entries(text.scenes)) scenes[id] = { ...facts, ...(bind?.scenes[id] ?? {}) };
    const keys = text.shown.keys;
    const steps = bind?.steps ?? {};
    const untrusted = bind?.untrusted ?? { steps: {} };
    const issues = text.issues.length > VIEW_ISSUES_MAX ? text.issues.slice(0, VIEW_ISSUES_MAX) : text.issues;
    const capture = await this.captureOf(p, name, runs);
    return {
      project: slug,
      name,
      file: file.file,
      hash: file.hash,
      text: file.yaml,
      blocks: text.shown.blocks,
      ok: text.ok,
      issues,
      run_blockers: text.run_blockers,
      edit: text.edit,
      environment: text.environment,
      scenes,
      runs,
      ...(capture ? { capture } : {}),
      source,
      running,
      steps: keys ? Object.fromEntries(Object.entries(steps).filter(([k]) => keys.has(k))) : steps,
      untrusted: keys ? { ...untrusted, steps: Object.fromEntries(Object.entries(untrusted.steps).filter(([k]) => keys.has(k))) } : untrusted,
      ...(keys || issues !== text.issues
        ? { limit: { steps_shown: keys ? keys.size : text.blocks.step_count, steps_total: text.blocks.step_count, issues_shown: issues.length, issues_total: text.issues.length } }
        : {}),
    };
  }

  /**
   * L5.11a: the status bar's read (critique H2) — the text layer's blockers when a fresh one is cached (a hit, never an
   * insert), else its own lighter layer (validation, blockers, environment; no binding, no URLs) in its own memo; the
   * runs as the view lists them; a render queued or running.
   */
  async actions(slug: string, name: string, o: { env?: string } = {}): Promise<ScenarioActions> {
    const p = await this.ctx.project(slug);
    const file = await getScenario(p, name);
    const layer = await this.actionsLayer(p, slug, name, file, o.env);
    const runs = await this.runChoices(p, slug, name);
    const running = runningOf(runs);
    const cap = await this.captureOf(p, name, runs);
    const render_job = this.ctx.renderJob ? await this.ctx.renderJob(slug, name) : undefined;
    return {
      project: slug,
      name,
      hash: file.hash,
      ok: layer.ok,
      environment: layer.environment,
      run_blockers: layer.run_blockers,
      content: layer.content,
      runs,
      running,
      ...(cap ? { capture: { id: cap.id, ...(cap.finished_at ? { finished_at: cap.finished_at } : {}) } } : {}),
      ...(render_job ? { render_job } : {}),
    };
  }

  private async actionsLayer(p: LoadedProject, slug: string, name: string, file: ScenarioText, env: string | undefined): Promise<ActionsLayer> {
    const key = [p.dir, name, file.hash, env ?? '', await this.projectSig(p)].join('\0');
    const fresh = <T extends { at: number }>(x: T | undefined) => (x && Date.now() - x.at < TEXT_TTL_MS ? x : undefined);
    const fromText = (t: TextLayer): ActionsLayer => ({ at: t.at, ok: t.ok, run_blockers: t.run_blockers, environment: t.environment, content: contentOf(t.blocks) });
    const text = fresh(this.texts.get(key));
    if (text) return fromText(text);
    const own = fresh(this.acts.get(key));
    if (own) return own;
    const textPending = this.textsPending.get(key);
    if (textPending) return fromText(await textPending);
    const pending = this.actsPending.get(key);
    if (pending) return pending;
    const job = (async () => {
      this.stats.actions++;
      const { ok, issues } = await validateScenarioText(p, file.yaml, { files: fileFacts(this.ctx.ws.policy), name, ...(env !== undefined ? { env } : {}) });
      const blocks = scenarioBlocks(file.yaml, { issues, hookFiles: { projectDir: p.dir, files: nodeFileFacts } });
      const run_blockers = studioBlockers(await this.ctx.blockers({ project: slug, scenario: name, ...(env !== undefined ? { env } : {}) }), blocks, ok, issues);
      return remember(this.acts, key, { at: Date.now(), ok, run_blockers, environment: environmentFacts(p, env ?? blocks.video.env), content: contentOf(blocks) }, 64);
    })();
    this.actsPending.set(key, job);
    try {
      return await job;
    } finally {
      this.actsPending.delete(key);
    }
  }

  // ── Text layer ──────────────────────────────────────────────────────────

  private async projectSig(p: LoadedProject): Promise<string> {
    const files = [join(p.dir, 'project.yaml'), join(p.dir, 'sandbox.yaml'), projectPath(p.dir, 'hooks'), join(this.ctx.ws.root, 'retake.yaml')];
    return (await Promise.all(files.map(lsig))).join('|');
  }

  private async textLayer(p: LoadedProject, slug: string, name: string, file: ScenarioText, env: string | undefined): Promise<TextLayer> {
    const key = [p.dir, name, file.hash, env ?? '', await this.projectSig(p)].join('\0');
    const hit = this.texts.get(key);
    if (hit && Date.now() - hit.at < TEXT_TTL_MS) return hit;
    // Single flight (critique H2): a second read of the same file while the first computes waits for it.
    const pending = this.textsPending.get(key);
    if (pending) return pending;
    const job = this.computeText(p, slug, name, file, env, key);
    this.textsPending.set(key, job);
    try {
      return await job;
    } finally {
      this.textsPending.delete(key);
    }
  }

  private async computeText(p: LoadedProject, slug: string, name: string, file: ScenarioText, env: string | undefined, key: string): Promise<TextLayer> {
    const { yaml } = file;
    this.stats.text++;
    const { ok, issues } = await validateScenarioText(p, yaml, { files: fileFacts(this.ctx.ws.policy), name, ...(env !== undefined ? { env } : {}) });
    const blocks = scenarioBlocks(yaml, { issues, hookFiles: { projectDir: p.dir, files: nodeFileFacts } });
    const run_blockers = studioBlockers(await this.ctx.blockers({ project: slug, scenario: name, ...(env !== undefined ? { env } : {}) }), blocks, ok, issues);
    let environment: ScenarioEnvironmentFacts | null = null;
    let pages: Record<string, string> = {};
    let display: Record<string, string> = {};
    try {
      const e = resolveEnvironment(p, env ?? blocks.video.env);
      environment = { name: e.name, production: e.production === true, access: environmentAccess(e), sandbox: e.sandbox !== undefined };
      pages = e.pages;
      display = e.display ?? {};
    } catch {
      /* an unknown environment: an issue of the file says so */
    }
    const firstPage = Object.keys(pages)[0];
    const scenes: Record<string, SceneFacts> = {};
    const identity: ScenarioIdentity = new Map();
    let previous: string | undefined;
    /** A multi-page scene's page id → the last scene that filmed it and its environment page. */
    const filmed = new Map<string, { scene: string; page: string | undefined }>();
    const opens = (page: string | undefined, open: string, into: { url?: string; display?: string }) => {
      const url = joinUrl(page ? pages[page] : undefined, open);
      const shown = joinUrl(page ? display[page] : undefined, open);
      if (url) into.url = url;
      if (shown && page && display[page]) into.display = shown;
    };
    for (const entry of blocks.entries) {
      if (entry.type !== 'scene') continue;
      const s: SceneBlock = entry;
      if (!scenes[s.id]) {
        const page = s.page ?? firstPage;
        const facts: SceneFacts = {};
        if (s.pages) {
          // Each page: its environment page, and the URL it opens — or the scene it continues from (review B M1).
          facts.pages = s.pages.map((pg) => {
            const before = filmed.get(pg.id);
            const envPage = pg.page ?? before?.page ?? (pages[pg.id] !== undefined ? pg.id : firstPage);
            const out: NonNullable<SceneFacts['pages']>[number] = { id: pg.id, ...(envPage !== undefined ? { page: envPage } : {}) };
            if (pg.open !== undefined) opens(envPage, pg.open, out);
            else if (before) out.continues_from = before.scene;
            else opens(envPage, '/', out);
            filmed.set(pg.id, { scene: s.id, page: envPage });
            return out;
          });
        } else if (typeof s.open === 'string') opens(page, s.open, facts);
        else if (previous) facts.continues_from = previous;
        scenes[s.id] = facts;
      }
      if (!identity.has(s.id))
        identity.set(s.id, {
          context: s.context,
          steps: s.steps.map((st) => ({
            ...(st.fingerprint ? { fp: st.fingerprint } : {}),
            ...(st.fingerprint && st.action ? { action: st.action } : {}),
            ...(st.picture ? { picture: st.picture } : {}),
            n: st.occurrence,
          })),
        });
      previous = s.id;
    }
    const shown = trimBlocks(blocks, VIEW_STEPS_MAX);
    const edit = await editAbility(
      p,
      file,
      { agent: this.ctx.agent ?? false, via: this.ctx.via ?? 'studio', files: fileFacts(this.ctx.ws.policy) },
      { parsed: blocks.parsed, ok, truncated: shown.keys !== null },
    );
    return remember(this.texts, key, { at: Date.now(), blocks, shown, ok, issues, run_blockers, environment, scenes, identity, edit });
  }

  // ── Runs of the scenario ────────────────────────────────────────────────

  /** What tells the cached run list is stale: the runs folder, its newest folders and their run.json, unfinished runs'. */
  private async runsSig(p: LoadedProject, memo: RunListMemo | undefined): Promise<string> {
    const dir = projectPath(p.dir, 'runs');
    let names: string[] = [];
    try {
      names = orderRuns(await readdir(dir)).slice(0, 8);
    } catch {
      return '-';
    }
    const watch = new Set(names);
    for (const r of memo?.runs ?? []) if (!FINISHED.has(r.status)) watch.add(r.id);
    const parts = await Promise.all([...watch].sort().map(async (id) => `${id}=${await lsig(join(dir, id))}/${await lsig(join(dir, id, 'run.json'))}`));
    return [await lsig(dir), ...parts].join('|');
  }

  private async runChoices(p: LoadedProject, slug: string, name: string): Promise<ScenarioRunChoice[]> {
    const key = `${p.dir}\0${name}`;
    const memo = this.lists.get(key);
    const sig = await this.runsSig(p, memo);
    let list = memo && memo.sig === sig ? memo.runs : undefined;
    if (!list) {
      this.stats.list++;
      list = (await listRuns(p, { scenario: name, limit: VIEW_RUNS_MAX })).filter(isReadRun);
      remember(this.lists, key, { sig, runs: list }, 64);
    }
    return Promise.all(
      list.map(async (r) => {
        if (r.status !== 'queued' && r.status !== 'running') return this.choice(p.dir, r, r.status);
        const status: ViewRunStatus = await this.ctx.overlay(slug, r);
        const c = await this.choice(p.dir, r, status);
        // An unfinished run's job (critique M4): null for a terminal's run, which Pause and Stop cannot reach.
        return status === 'queued' || status === 'running' ? { ...c, job: this.ctx.runJob ? await this.ctx.runJob(slug, r.id) : null } : c;
      }),
    );
  }

  /**
   * What the picker says of a run beyond run.json's summary — its pictures and where a failed run failed — held while
   * the run folder's signature holds (a finished run's files do not change; deleting frames changes the folder).
   */
  private async factsOf(projectDir: string, id: string, mode: string, finished: boolean, failed: boolean, capture: boolean): Promise<RunFacts> {
    // A succeeded capture's verdict also reads its timeline's head: that file's signature is in its key.
    const key = `${projectDir}\0${id}\0${await lsig(projectPath(projectDir, 'runs', id))}${capture ? `\0${await lsig(projectPath(projectDir, 'runs', id, 'timeline.json'))}` : ''}`;
    const hit = finished ? this.facts.get(key) : undefined;
    if (hit) return hit;
    const pictures = await runPictures(projectDir, id, mode);
    const snapshot = (await lsig(projectPath(projectDir, 'runs', id, 'scenario.yaml'))) !== '-';
    let failedAt: string | undefined;
    if (failed) {
      const folder = await RunFolder.open(projectDir, id);
      const r = folder ? await folder.read('run.json', RUN_JSON_MAX) : undefined;
      try {
        const record = r?.ok ? parseRunRecord(JSON.parse(r.bytes.toString('utf8'))) : undefined;
        const err = record?.ok ? record.value.error : undefined;
        if (err && typeof err.scene === 'string') failedAt = stepRef(err.scene, err.step);
      } catch {
        /* not a run.json the runner wrote */
      }
    }
    // Only a capture whose record says it succeeded can be a take: the rule is asked for those alone (one read, held;
    // runs.ts takeVerdict: a take is a run folder that really lies in the project).
    if (capture) this.stats.takes++;
    const take = capture ? (await takeVerdict(projectDir, id)).usable : false;
    const facts: RunFacts = { pictures, snapshot, take, ...(failedAt ? { failedAt } : {}) };
    if (finished) remember(this.facts, key, facts, 512);
    return facts;
  }

  private async choice(projectDir: string, r: RunSummary, raw: ViewRunStatus): Promise<ScenarioRunChoice> {
    // run.json is a file anyone may write: a status the runner never writes is `unknown`, never shown as written.
    const status: ViewRunStatus = KNOWN_STATUSES.has(raw) ? raw : 'unknown';
    const finished = FINISHED.has(status);
    const { pictures, snapshot, failedAt, take } = await this.factsOf(projectDir, r.id, r.mode, finished, status === 'failed', r.mode === 'capture' && status === 'succeeded');
    let partial: string | undefined;
    if (status === 'cancelled') partial = 'cancelled';
    else if (status === 'interrupted') partial = 'interrupted';
    else if (status === 'failed') partial = failedAt ? `failed at ${failedAt}` : 'failed';
    else if (r.stopped_at?.reason === 'until') partial = `until ${stepRef(r.stopped_at.scene, r.stopped_at.step)}`;
    return {
      id: r.id,
      mode: r.mode,
      status,
      env: r.env,
      started_at: r.started_at,
      ...(r.finished_at ? { finished_at: r.finished_at } : {}),
      steps_done: r.steps_done,
      steps_total: r.steps_total,
      pictures,
      complete: finished && status === 'succeeded' && partial === undefined && pictures !== null,
      snapshot,
      take,
      ...(partial ? { partial } : {}),
    };
  }

  /**
   * `latest` of the scenario for the Studio — what Render edits, what the timeline shows without a chosen take: the
   * one rule (core latestTake, through runs.ts), with no window. The runs listed are the scenario's newest in the
   * rule's own order and each says whether it is a take, so the first that does is the answer; when none does and the
   * list is full, older runs exist that it does not show, and the rule is asked over all of them.
   */
  private async captureOf(p: LoadedProject, name: string, runs: readonly ScenarioRunChoice[]): Promise<{ id: string; finished_at?: string } | undefined> {
    const listed = runs.find((r) => r.take);
    if (listed) return { id: listed.id, ...(listed.finished_at ? { finished_at: listed.finished_at } : {}) };
    if (runs.length < VIEW_RUNS_MAX) return undefined;
    const take = (await latestCapture(p, name)).take;
    return take ? { id: take.run, finished_at: take.finished_at } : undefined;
  }

  /** A picked run older than the picker's list. */
  private choiceOf(projectDir: string, id: string, rec: RunRecordOnDisk): Promise<ScenarioRunChoice> {
    const summary: RunSummary = {
      id,
      scenario: rec.scenario,
      mode: rec.mode,
      status: rec.status,
      env: rec.env,
      started_at: rec.started_at,
      ...(rec.finished_at ? { finished_at: rec.finished_at } : {}),
      steps_done: rec.steps_done,
      steps_total: rec.steps_total,
      ...(rec.stopped_at ? { stopped_at: rec.stopped_at } : {}),
    };
    return this.choice(projectDir, summary, summary.status);
  }

  // ── Binding ─────────────────────────────────────────────────────────────

  private async bindLayer(name: string, hash: string, yaml: string, text: TextLayer, run: RunData): Promise<BindLayer> {
    const key = [run.folder.dir, run.sig, name, hash].join('\0');
    const hit = this.binds.get(key);
    if (hit) return hit;
    this.stats.bind++;
    return remember(this.binds, key, await bindSteps(yaml, text, run));
  }
}

/**
 * A step as a person reads it on the screen: "step 3 of proposal" — 1-based like the screen's rows and the inspector
 * ("Step 3 of scene proposal"), never the run's 0-based key `proposal.2`; "scene proposal" without a step.
 */
export function stepRef(scene: string, step: number | undefined): string {
  // A run.json's scene is text anyone may write: a scene id only (review A #4), else no name at all.
  if (typeof scene !== 'string' || scene.length > 120 || !SLUG_RE.test(scene)) return typeof step === 'number' && Number.isInteger(step) && step >= 0 ? `step ${step + 1} of a scene` : 'a scene';
  return typeof step === 'number' && Number.isInteger(step) && step >= 0 ? `step ${step + 1} of ${scene}` : `scene ${scene}`;
}

/**
 * The blocks with at most `max` steps — the entries up to the one holding the last step kept (its later steps cut,
 * every entry after it left out; the counts stay the file's) —, and the keys of the steps kept; null when nothing is cut.
 */
function trimBlocks(blocks: ScenarioBlocks, max: number): TextLayer['shown'] {
  if (blocks.step_count <= max) return { blocks, keys: null };
  const keys = new Set<string>();
  let left = max;
  const entries: ScenarioBlocks['entries'] = [];
  for (const e of blocks.entries) {
    if (left <= 0) break;
    if (e.type !== 'scene') {
      entries.push(e);
      continue;
    }
    const steps = e.steps.slice(0, left);
    left -= steps.length;
    for (const st of steps) keys.add(st.key);
    entries.push(steps.length === e.steps.length ? e : { ...e, steps });
  }
  return { blocks: { ...blocks, entries }, keys };
}

/** "scenes[3].steps[0].click" in a message → "step 1 of <scene id> (click)" — a person's words for a file path. */
function humanPaths(message: string, blocks: ScenarioBlocks): string {
  return message.replace(/\b(scenes|setup|teardown)\[(\d+)\](?:\.steps\[(\d+)\])?((?:\.[A-Za-z_][\w-]*|\[\d+\])*)/g, (_m, list: string, i: string, j: string | undefined, rest: string) => {
    const tail = rest ? ` (${rest.replace(/^\./, '')})` : '';
    if (list !== 'scenes') return `${list} hook ${Number(i) + 1}${tail}`;
    const e = blocks.entries[Number(i)];
    const name = e && e.type !== 'unknown' ? `${e.type === 'scene' ? 'scene' : e.type} ${e.id}` : `entry ${Number(i) + 1}`;
    return j !== undefined ? `step ${Number(j) + 1} of ${name}${tail}` : `${name}${tail}`;
  });
}

/** The retake command line for a person without `retake` on their PATH: the built entry run by this node. */
function nodeCommand(fix: string): string | undefined {
  if (!fix.startsWith('retake ')) return undefined;
  const bin = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
  if (!existsSync(bin)) return undefined;
  const q = (x: string) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
  return `${q(process.execPath)} ${q(bin)} ${fix.slice('retake '.length)}`;
}

/**
 * Run blockers as the Studio shows them (review B M2, M6, L6): a file with errors gets one blocker saying to fix it
 * first, with no command (the terminal refuses the file too); paths in messages become step / scene words; a command
 * also comes as `node …/bin.js …` for a person without `retake` on their PATH.
 */
function studioBlockers(b: { dry: RunBlocker[]; capture: RunBlocker[] }, blocks: ScenarioBlocks, ok: boolean, issues: ValidationIssue[]): { dry: RunBlocker[]; capture: RunBlocker[] } {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const one = (x: RunBlocker): RunBlocker => {
    if (!ok && x.code === 'invalid') {
      return {
        code: 'invalid',
        kind: 'invalid',
        message: `the file has ${errors} error${errors === 1 ? '' : 's'} (listed with the blocks): fix the file first — a run from the terminal refuses it too`,
        fix_file: true,
      };
    }
    const fixNode = x.fix ? nodeCommand(x.fix) : undefined;
    return { ...x, message: humanPaths(x.message, blocks), ...(fixNode ? { fix_node: fixNode } : {}) };
  };
  const list = (l: RunBlocker[]) => l.map(one).filter((x, i, all) => all.findIndex((y) => y.message === x.message) === i);
  return { dry: list(b.dry), capture: list(b.capture) };
}

/** A file's scenes and steps (the counts of the whole file). */
function contentOf(blocks: ScenarioBlocks): ScenarioActions['content'] {
  return { scenes: blocks.entries.filter((e) => e.type === 'scene').length, steps: blocks.step_count };
}

/** An environment's flags (null: the project has none by that name — an issue of the file says so). */
function environmentFacts(p: LoadedProject, env: string | undefined): ScenarioEnvironmentFacts | null {
  try {
    const e = resolveEnvironment(p, env);
    return { name: e.name, production: e.production === true, access: environmentAccess(e), sandbox: e.sandbox !== undefined };
  } catch {
    return null;
  }
}

/** Why a step cannot be matched to a run's (review B M3: it said the run's timeline could not be read). */
const NO_SINGLE_ACTION = 'this step has no single action (fix it in the file)';

/** Why a step the run should have reached has no event: where the run stopped. */
function notReachedWhy(run: RunData): string {
  const r = run.record;
  if (r?.error?.scene !== undefined) return `the run failed at ${stepRef(r.error.scene, r.error.step)}`;
  if (r?.stopped_at?.reason === 'until') return `the run stopped at ${stepRef(r.stopped_at.scene, r.stopped_at.step)} (until)`;
  if (r?.status === 'cancelled') return 'the run was cancelled before it';
  if (!run.timeline) return 'the run left no timeline';
  return 'the run ended before it';
}

/** Where a capture's step picture comes from: its page's kept frames, else its video (null: neither). */
export async function capturePicture(run: RunData, ev: TimelineEvent, seen: Map<string, ThumbSource | null>): Promise<ThumbSource | null> {
  const src = run.pageSource(ev);
  if (!src) return null;
  const known = seen.get(src.track);
  if (known !== undefined) return known;
  const index = await run.frameIndex(src.framesFile);
  const kind: ThumbSource | null = index && index.files.length > 0 ? 'frame' : (await run.folder.video(src.video)).ok ? 'video' : null;
  seen.set(src.track, kind);
  return kind;
}

/** Steps of today's file (`yaml`, its text layer) bound to a run. */
async function bindSteps(yaml: string, text: TextLayer, run: RunData): Promise<BindLayer> {
  let changed: boolean | null = scenarioTextChanged(yaml, run.snapshot) ?? null;
  let matches: Map<string, ReturnType<typeof matchRunSteps> extends Map<string, infer V> ? V : never> | undefined;
  if (changed === true) {
    const then = sceneStepFingerprints(run.snapshot as string);
    if (then) matches = matchRunSteps(text.identity, then);
    else changed = null;
  }
  const moved = matches ? movedSteps(text.identity, matches) : new Set<string>();
  const steps: Record<string, StepBinding> = {};
  const untrusted: BindLayer['untrusted'] = { steps: {}, ...(run.record?.error?.message ? { run_error: run.record.error.message } : {}) };
  const scenes: BindLayer['scenes'] = {};
  const why = notReachedWhy(run);
  // The irreversible step a dry run stopped each scene at (its later steps are recorded as skipped).
  const stoppedAt = new Map<string, number>();
  for (const ev of run.events.values()) if (ev.status === 'dry' && !stoppedAt.has(ev.scene)) stoppedAt.set(ev.scene, ev.step);
  const sources = new Map<string, ThumbSource | null>();
  for (const entry of text.blocks.entries) {
    if (entry.type !== 'scene') continue;
    const rs = run.scenes.get(entry.id);
    if (rs && !scenes[entry.id]) {
      const d = Number(rs.t_end) - Number(rs.t_start);
      scenes[entry.id] = { ...(Number.isFinite(d) && d > 0 ? { captured_s: Math.round(d * 1000) / 1000 } : {}), ...(typeof rs.status === 'string' ? { run_status: rs.status } : {}) };
    }
    for (const st of entry.steps) {
      if (steps[st.key]) continue;
      let runKey = st.key;
      if (matches) {
        const m = matches.get(st.key);
        if (!m) {
          steps[st.key] = { missing: 'unreadable' };
          continue;
        }
        if ('missing' in m) {
          steps[st.key] = { missing: m.missing, ...('run_index' in m ? { run_key: `${entry.id}.${m.run_index}` } : {}), ...(m.missing === 'unreadable' ? { why: NO_SINGLE_ACTION } : {}) };
          continue;
        }
        runKey = `${entry.id}.${m.run_index}`;
      } else if (!st.action) {
        steps[st.key] = { missing: 'unreadable', why: NO_SINGLE_ACTION };
        continue;
      }
      const { scene, step } = stepKeyParts(runKey);
      const ev = run.events.get(runKey);
      if (!ev) {
        if (rs?.status === 'skipped') {
          steps[st.key] = { missing: 'scene_skipped', run_key: runKey };
          continue;
        }
        if (run.mode === 'dry' && !run.timeline) {
          const prefix = `${fileSlug(scene)}-${String(step).padStart(2, '0')}-`;
          const shot = [...run.screenshots].find((n) => n.startsWith(prefix) && stepScreenshotName(scene, step, n.slice(prefix.length, -4)) === n);
          if (shot) {
            steps[st.key] = { run_key: runKey, status: 'unknown', picture: 'screenshot' };
            continue;
          }
        }
        steps[st.key] = { missing: 'not_reached', why, run_key: runKey };
        continue;
      }
      const ms = Math.round((Number(ev.t_end) - Number(ev.t_start)) * 1000);
      let picture: ThumbSource | null = null;
      let stepWhy: string | undefined;
      if (ev.status === 'skipped') {
        const at = stoppedAt.get(scene);
        stepWhy = at !== undefined && at < step ? `after ${stepRef(scene, at)}, irreversible: a dry run stops the scene there` : 'skipped';
      } else {
        if (ev.status === 'failed' && run.screenshots.has(errorScreenshotName(scene, step))) picture = 'error_screenshot';
        else if (run.mode === 'dry') {
          const name = stepScreenshotName(scene, step, ev.action);
          picture = name && run.screenshots.has(name) ? 'screenshot' : null;
        } else if (run.mode === 'capture') picture = await capturePicture(run, ev, sources);
        if (ev.status === 'failed' && picture === null && run.mode === 'dry') stepWhy = 'no screenshot of the failure';
      }
      steps[st.key] = {
        run_key: runKey,
        status: ev.status,
        ...(Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
        picture,
        ...(stepWhy ? { why: stepWhy } : {}),
        ...(moved.has(st.key) ? { moved: true as const } : {}),
      };
      const page: { target?: string; error?: string; url?: string } = {};
      if (typeof ev.target?.desc === 'string') page.target = ev.target.desc;
      if (typeof ev.error === 'string') page.error = ev.error;
      if (typeof ev.url === 'string') page.url = stripUrlUserinfo(ev.url);
      if (Object.keys(page).length) untrusted.steps[st.key] = page;
    }
  }
  const filmed = changed === true ? filmedChanges(yaml, run.snapshot as string) : undefined;
  return { changed, ...(filmed !== undefined ? { filmed } : {}), steps, untrusted, scenes };
}

/**
 * The view's `edit` (L4.3): scenarioEditBlocker for the YAML view; block edits also need a file that parses, has no
 * error and is shown whole.
 */
async function editAbility(
  p: LoadedProject,
  file: ScenarioText,
  o: { agent: boolean; via: AgentChannel; files: WorkFileFacts },
  facts: { parsed: boolean; ok: boolean; truncated: boolean },
): Promise<ScenarioView['edit']> {
  let scenario;
  if (o.agent && file.utf8) {
    const template = await loadProjectTemplate(p, undefined, { files: o.files }).then(
      (t) => t.template,
      () => undefined,
    );
    scenario = parseScenario(file.yaml, { files: o.files, file: file.path, project: p, template }).scenario;
  }
  const blocked = scenarioEditBlocker(p, file, scenario, o);
  const yaml: EditAbility = blocked ? { ok: false, why: blocked.why, ...(blocked.problems.length ? { problems: blocked.problems } : {}) } : { ok: true };
  const blocks: EditAbility = !yaml.ok
    ? yaml
    : !facts.parsed
      ? { ok: false, why: 'This file is not valid YAML: fix it in the YAML view first.' }
      : !facts.ok
        ? { ok: false, why: 'This file has errors: fix them in the YAML view first (every block edit would be refused).' }
        : facts.truncated
          ? { ok: false, why: `Only the first ${VIEW_STEPS_MAX.toLocaleString('en')} steps are shown: edit this file in the YAML view.` }
          : { ok: true };
  return { yaml, blocks };
}
