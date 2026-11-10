/**
 * Plan a run (L3.2): the one place where a render, a still, `retake still` and the MCP server's plan_preview turn a
 * capture run into an EditPlan — the run, its timeline, the theme, the registry, the music's length, the project files
 * the plan reads, then `planEdit`.
 *
 * With trust `mcp` (work submitted through the MCP server, core agent-trust) it is also the choke point of what a
 * render may read and serve, in two gates that no path around them can skip:
 * 1. before any file is read (no ffprobe, no CSV read: a refusal must not tell whether a file exists): every file the
 *    timeline names (card / overlay images, `data:` CSV slots, own media, Lottie files as code) and the music bed are
 *    files of the project folder; the theme is a name (or project.yaml's own template); no slot value is a remote URL;
 * 2. after planning: every file the plan serves (`plan.assets`) lies in the project folder, the run folder or the theme
 *    folder, symbolic links resolved — whatever named it (an image slot without an extension, a theme's logo or font).
 * And the run itself: one that is reached through a symbolic link and lies outside the project folder is refused
 * (core namedRunProblem) — gate 2 alone would take the link's target for "the run folder".
 *
 * Whether the run can be planned is the one rule of a named run (core take.ts namedRunProblem) on the facts of the one
 * reader (core/io readNamedRun); `latest` was picked by the rule of a usable capture (runs.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_FILM, displayPages, editReplannedMessage, insideFolder, isCaptureScene, issuesMessage, namedRunProblem, parseScenario, renderFileProblems, replanEdit, resolveEnvironment, takeWords, templateRefProblem, timelineProblem, timelineVideo, GUIDE } from '@retake/core';
import { loadProjectTemplate, readNamedRun, scenarioSinceRun, nodeFileFacts, fileFacts } from '@retake/core/io';
import type { LoadedProject, LoadedTemplate, NamedProblem, Read, RunFolderFacts, Scenario, TemplateContext, Timeline, ErrorKind, WorkPolicy, WorkFileFacts } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { planFileUses, planInputFiles, remoteSlotUses } from '../inputs.js';
import { planEdit } from '../plan.js';
import { musicFile, musicSpecOf } from '../planner/music.js';
import { PLAN_ASSET_SCHEME } from '../plan-types.js';
import type { EditOverrides, EditPlan } from '../plan-types.js';
import { probeMedia } from './probe.js';
import { locateRun, recordEnv, runScenario } from './runs.js';
import type { RunRef } from './runs.js';
import { RenderError } from './types.js';

/** Who asked: a human at the CLI (`author`), or work submitted through the MCP server (`mcp`). */
export type PlanTrust = 'author' | 'mcp';

/** A plan refused by the trust rules of work submitted through MCP: one positioned message per problem. */
export class PlanTrustError extends RenderError {
  constructor(readonly problems: string[]) {
    super(`refused through MCP:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'PlanTrustError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  override get errorKind(): ErrorKind {
    return 'refused';
  }

  override get errorDocs(): string {
    return GUIDE.security;
  }
}

export interface PlanRunOptions {
  /** What the work runs under (core WorkPolicy): the ffprobe of its files. */
  workPolicy: WorkPolicy;
  project: LoadedProject;
  /** Run id, run directory, or "latest" (of `scenario` when given). */
  run: string;
  /** Scenario name: required to match the run's; picks the run with "latest". */
  scenario?: string;
  /** Theme to use instead of the run's (name, ./path or a loaded template). */
  template?: string | LoadedTemplate;
  overrides?: EditOverrides;
  /** Workspace root (default: the project's). */
  root?: string;
  registry?: ComponentRegistry;
  /** Default `author`: no trust gate. */
  trust?: PlanTrust;
  /** Measure the music bed with ffprobe so the plan loops or trims it (default true; a still does without). */
  measureMusic?: boolean;
  /** How the music bed is measured (default: ffprobe each time; the Studio's timeline memoises it by file, L4.5). */
  musicLength?: (file: string) => Promise<number | undefined>;
  /**
   * Where the edit comes from (L5.5). `auto` (default): today's scenario file when its filmed part is unchanged since
   * the run, else the run as captured. `run`: the run as captured.
   */
  edit?: 'auto' | 'run';
  /**
   * The scenario file's text to plan the edit from instead of today's file (L4.5, critique B5): a render job's snapshot
   * of the file as it was planned at submit (its job folder's edit.yaml). The same parse, filmed-part check and trust
   * gates apply; only the source of the text differs.
   */
  editText?: string;
}

/**
 * Where a plan's edit came from (L5.5): today's scenario file re-planned on the run (`scenario`: its filmed part is
 * unchanged since the capture), or the run as captured (`run`: no snapshot or file, the filmed part changed, or today's
 * file does not validate).
 */
export interface PlannedEdit {
  from: 'scenario' | 'run';
  /** sha256 of today's file the edit was planned from (from `scenario`). */
  sha256?: string;
  /** What today's edit changed against the run's (keys, scene ids, step keys; from `scenario`). */
  changes?: string[];
  /**
   * Whether the filmed part changed since the run (true: re-capture to film it), absent when it cannot be told (no
   * scenario file or no snapshot).
   */
  scenario_changed?: boolean;
  /** What changed in the filmed part (keys, scene ids, step keys); absent when the file no longer reads as YAML. */
  filmed_changes?: string[];
  /** Why today's file was not used although its filmed part is unchanged. */
  reason?: string;
}

export interface PlannedRun {
  project: LoadedProject;
  root: string;
  run: RunRef;
  timeline: Timeline;
  template: LoadedTemplate;
  registry: ComponentRegistry;
  captureFile: string;
  /** The overrides planned with (`theme` set to the theme's name when one was asked). */
  overrides: EditOverrides;
  /** The run's scenario snapshot (undefined when absent or invalid). */
  scenario?: Scenario;
  /** Where the edit came from (L5.5). */
  edit: PlannedEdit;
  /** The scenario text the edit was planned from (from `scenario`): what a render job snapshots at submit (L4.5). */
  editText?: string;
  plan: EditPlan;
  plan_ms: number;
}

/** The theme a plan of this run uses: asked, else the overrides', else the run's, else the project's. */
function themeRef(o: Pick<PlanRunOptions, 'template' | 'overrides' | 'project'>, timeline: Timeline): string | LoadedTemplate | undefined {
  return o.template ?? o.overrides?.theme ?? timeline.video?.template ?? o.project.config.template;
}

/** Gate 1 (trust `mcp`): what the plan will read, checked before anything is read. Empty: nothing refused. */
export function preReadProblems(project: LoadedProject, timeline: Timeline, video: Timeline['video'], o: Pick<PlanRunOptions, 'template' | 'overrides' | 'project'>): string[] {
  const problems: string[] = [];
  const theme = themeRef(o, timeline);
  if (typeof theme === 'string') {
    const where = o.template !== undefined ? 'the theme asked' : o.overrides?.theme !== undefined ? 'the theme of the overrides' : timeline.video?.template !== undefined ? "the run's theme (the scenario's template:)" : 'the theme';
    const p = templateRefProblem(theme, project.config.template, where);
    if (p) problems.push(p);
  }
  const uses = planFileUses(timeline).map((u) => ({ ref: u.ref, where: u.where }));
  const music = musicSpecOf(video, o.overrides ?? {});
  if (music) uses.push({ ref: music.file, where: typeof o.overrides?.music === 'string' ? 'the music of the overrides' : 'the music bed (music.file)' });
  problems.push(...renderFileProblems(project.dir, uses, nodeFileFacts));
  for (const r of remoteSlotUses(timeline)) {
    problems.push(`${r.where}: ${r.ref} is a remote URL: through MCP a render loads no remote file — put the file in the project (assets/) and name it there`);
  }
  return problems;
}

/** Gate 2 (trust `mcp`): every file the plan serves lies in the project, the run or the theme folder. */
export function servedFileProblems(plan: Pick<EditPlan, 'assets'>, folders: { project: string; run: string; theme: string }): string[] {
  const problems: string[] = [];
  for (const [url, file] of Object.entries(plan.assets)) {
    const name = url.startsWith(PLAN_ASSET_SCHEME) ? url.slice(PLAN_ASSET_SCHEME.length) : url;
    if (insideFolder(folders.project, file, nodeFileFacts) || insideFolder(folders.run, file, nodeFileFacts) || insideFolder(folders.theme, file, nodeFileFacts)) {
      // A hard link inside the folders may be the same file as one outside them (review A N4): never served.
      if (hardLinked(file)) problems.push(`the plan serves ${name} from ${file}, a file with more than one name (a hard link): through MCP a render serves none`);
      continue;
    }
    problems.push(`the plan serves ${name} from ${file}, outside the project, the run and the theme folders: through MCP a render serves only those`);
  }
  return problems;
}

/** Whether a regular file has more than one name (a hard link: the same bytes may also lie outside the folders). */
function hardLinked(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

/**
 * The facts of the run folder a plan works on, read through symbolic links (a named run always was), and whether the
 * folder really lies in the project (`inside`: its real path, links followed — the folder's own or one above it, as
 * a `runs/` that is a link to another disk). The rule decides with both (core namedRunProblem): through MCP a run
 * outside the project is refused — one someone named, and one `latest` picked too, which was inside when it was
 * picked (runs.ts locateRun) and can only be outside now if the folder changed since; at a terminal nothing of it applies.
 */
async function namedRunFacts(project: LoadedProject, dir: string): Promise<{ facts: RunFolderFacts; inside: boolean; timeline: Read<Timeline> }> {
  // One read of the folder: its facts and its whole timeline (timeline.json is parsed once).
  const { facts, timeline } = await readNamedRun(dir);
  return { facts, inside: insideFolder(project.dir, dir, nodeFileFacts), timeline };
}

/** Plan a capture run (see the module comment); throws RenderError (PlanTrustError for a trust refusal). */
export async function planRun(o: PlanRunOptions): Promise<PlannedRun> {
  const t0 = performance.now();
  const project = o.project;
  const trust = o.trust ?? 'author';
  const root = resolve(o.root ?? project.root);
  const run = await locateRun(project, o.run, o.scenario, { trust });
  const facts = await namedRunFacts(project, run.dir);
  const refused = namedRunProblem(facts.facts, { ...(o.scenario !== undefined ? { scenario: o.scenario } : {}), trust, inside: facts.inside });
  const words = (problem: NamedProblem): string => takeWords(problem, { run: run.id, verb: 'render', dir: run.dir });
  if (refused?.why === 'linked-outside' || refused?.why === 'outside' || refused?.why === 'linked-files' || refused?.why === 'film-outside') throw new PlanTrustError([words(refused)]);
  // A missing film is said where it always was: after the trust gate and the theme (no-film is the rule's last test).
  if (refused && refused.why !== 'no-film') throw new RenderError(words(refused));
  // The head read and the whole does not: its lists are not lists.
  const read = facts.timeline;
  if (!read.ok) throw new RenderError(words(timelineProblem(read) ?? { why: 'no-timeline' }));
  const captured = read.value;
  const overrides: EditOverrides = { ...(o.overrides ?? {}) };
  const scenarioSnapshot = await runScenario(run.dir);
  const envName = recordEnv(facts.facts.record);
  const { timeline, edit, warnings: editWarnings, text: editText } = editOfToday(project, run, captured, envName, o.edit ?? 'auto', o.editText, fileFacts(o.workPolicy));
  const video = timeline.video ?? (scenarioSnapshot ? timelineVideo(scenarioSnapshot, project.config) : undefined);
  if (trust === 'mcp') {
    const problems = preReadProblems(project, timeline, video, o);
    if (problems.length) throw new PlanTrustError(problems);
  }
  const theme = themeRef(o, timeline);
  const template = theme && typeof theme === 'object' ? theme : await loadProjectTemplate(project, theme, { files: fileFacts(o.workPolicy) });
  if (o.template || overrides.theme) overrides.theme = template.name;
  const registry = o.registry ?? (await loadComponentRegistry({ root }));
  // The film the rule judged: the name the run's own timeline gives (`capture.mp4` when it names none).
  if (refused) throw new RenderError(words(refused));
  const captureFile = join(run.dir, facts.facts.timeline.ok ? facts.facts.timeline.value.film : DEFAULT_FILM);
  // The planner is pure: the music track's length is measured here so it can plan the loops (or the trim).
  const musicSpec = musicSpecOf(video, overrides);
  let musicDuration_s: number | undefined;
  if (musicSpec && o.measureMusic !== false) {
    const file = musicFile(musicSpec, project);
    if (!existsSync(file)) throw new RenderError(`music file not found: ${file}`);
    const length = o.musicLength ? await o.musicLength(file) : (await probeMedia(file, o.workPolicy))?.duration_s;
    if (length !== undefined && length > 0) musicDuration_s = length;
  }
  const files = await planInputFiles(timeline, project, template, o.workPolicy);
  const plan = planEdit({ timeline, template, project, registry, captureFile, scenario: scenarioSnapshot, env: envName, overrides, musicDuration_s, files });
  noteEdit(plan, edit, editWarnings, run.id);
  if (trust === 'mcp') {
    const problems = servedFileProblems(plan, { project: project.dir, run: run.dir, theme: template.dir });
    if (problems.length) throw new PlanTrustError(problems);
  }
  return {
    project,
    root,
    run,
    timeline,
    template,
    registry,
    captureFile,
    overrides,
    ...(scenarioSnapshot ? { scenario: scenarioSnapshot } : {}),
    edit,
    ...(editText !== undefined ? { editText } : {}),
    plan,
    plan_ms: Math.round(performance.now() - t0),
  };
}

/** A plan's note on where its edit came from, and the warnings of the re-plan (L5.5). */
export function noteEdit(plan: EditPlan, edit: PlannedEdit, warnings: readonly string[], runId: string): void {
  if (edit.from === 'scenario' && edit.changes?.length) {
    plan.notes.unshift(`${editReplannedMessage(plan.meta.scenario, runId)} (changed: ${edit.changes.slice(0, 12).join(', ')}${edit.changes.length > 12 ? ', …' : ''})`);
  }
  plan.warnings.push(...warnings);
}

/**
 * The timeline a plan reads (L5.5): the run's, rewritten with today's edit when the scenario file's filmed part is
 * unchanged since the capture (core scenarioSinceRun, replanEdit); else the run's as captured. `editText` (L4.5): the
 * file's text as a render job snapshotted it, read instead of today's file. `text`: the text the edit came from.
 */
export function editOfToday(
  project: LoadedProject,
  run: Pick<RunRef, 'id' | 'dir'>,
  captured: Timeline,
  envName: string | undefined,
  mode: 'auto' | 'run' = 'auto',
  editText: string | undefined,
  /** How today's scenario's files are looked at (core FileFacts): the work's. */
  files: WorkFileFacts,
): { timeline: Timeline; edit: PlannedEdit; warnings: string[]; text?: string } {
  const asCaptured = (edit: PlannedEdit, warnings: string[] = []) => ({ timeline: captured, edit, warnings });
  if (mode === 'run') return asCaptured({ from: 'run' });
  const since = scenarioSinceRun(project, run.dir, captured.scenario, editText);
  if (!since) return asCaptured({ from: 'run' });
  if (since.filmed === undefined) return asCaptured({ from: 'run', scenario_changed: true });
  if (since.filmed.length > 0) return asCaptured({ from: 'run', scenario_changed: true, filmed_changes: since.filmed });
  const sha256 = createHash('sha256').update(since.now).digest('hex');
  const file = since.file;
  const now = parseScenario(since.now, { files, file, project });
  const then = parseScenario(since.then);
  if (!now.scenario) {
    const reason = `today's scenario ${captured.scenario} does not validate: the render shows the edit of run ${run.id} as captured — ${issuesMessage('scenario', now.issues, file).split('\n').slice(0, 4).join(' ')}`;
    return asCaptured({ from: 'run', scenario_changed: false, filmed_changes: [], reason }, [reason]);
  }
  if (!then.scenario) {
    const reason = `the snapshot of run ${run.id} does not validate any more: the render shows its edit as captured`;
    return asCaptured({ from: 'run', scenario_changed: false, filmed_changes: [], reason }, [reason]);
  }
  // The snapshot must describe this take: every scene it filmed is a capture scene of the snapshot, in its order.
  const thenIds = then.scenario.scenes.filter(isCaptureScene).map((e) => e.id);
  const filmedIds = captured.scenes.filter((x) => x.kind === 'scene').map((x) => x.id);
  if (filmedIds.some((id, i) => thenIds[i] !== id)) {
    const reason = `the snapshot of run ${run.id} does not describe the scenes its timeline filmed: the render shows its edit as captured`;
    return asCaptured({ from: 'run', scenario_changed: false, filmed_changes: [], reason }, [reason]);
  }
  let pages: Record<string, string> = {};
  try {
    pages = displayPages(resolveEnvironment(project, envName ?? captured.environment?.name));
  } catch {
    /* an environment since removed: {{page}} tokens of a changed text then say so */
  }
  const ctx: TemplateContext = { pages, vars: { ...(project.config.vars ?? {}), ...(now.scenario.vars ?? {}) }, run: { id: run.id, dir: run.dir }, hooks: {} };
  const r = replanEdit({ timeline: captured, now: now.scenario, then: then.scenario, project: project.config, ctx });
  return { timeline: r.timeline, edit: { from: 'scenario', sha256, changes: r.changes, scenario_changed: false, filmed_changes: [] }, warnings: r.warnings, text: since.now };
}
