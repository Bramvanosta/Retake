/**
 * Plan a run: the one place where a render, a still, `retake still` and the MCP server's plan_preview turn a
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
import { issuesMessage, GUIDE, planAssetName } from '@retake/core/base';
import { isCaptureScene } from '@retake/core/language';
import { timelineVideo } from '@retake/core/language';
import { displayPages, resolveEnvironment } from '@retake/core/environment';
import { editReplannedMessage, insideFolder, parseScenario, renderFileProblems, templateRefProblem } from '@retake/core/scenario';
import { replanEdit } from '@retake/core/run';
import { DEFAULT_FILM, namedRunProblem, takeWords, timelineProblem } from '@retake/core/run';
import { loadProjectTemplate, readNamedRun, scenarioSinceRun, nodeFileFacts, fileFacts } from '@retake/core/io';
import type { TemplateContext, ErrorKind } from '@retake/core/base';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedTemplate } from '@retake/core/theme';
import type { Timeline } from '@retake/core/run';
import type { WorkFileFacts } from '@retake/core/model';
import type { NamedProblem, Read, RunFolderFacts } from '@retake/core/run';
import type { ComponentRegistry } from '@retake/components/geometry';
import { planFileUses, planInputFiles, remoteSlotUses } from '../inputs.js';
import { planEdit } from '../plan.js';
import { musicFile, musicSpecOf } from '../planner/music.js';
import type { EditOverrides, EditPlan } from '../plan-types.js';
import { probeMedia } from './probe.js';
import { registryFrom } from './registry-source.js';
import { locateRun, recordEnv, runScenario } from './runs.js';
import type { RunRef } from './runs.js';
import { RenderError } from './types.js';
import type { PlanRunOptions, PlannedEdit, PlannedRun } from '../work-types.js';
export type { PlanRunOptions, PlanTrust, PlannedEdit, PlannedRun } from '../work-types.js';

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

/** The theme a plan of this run uses: asked, else the overrides', else the run's, else the project's. */
function themeRef(o: Pick<PlanRunOptions, 'template' | 'overrides' | 'project'>, timeline: Timeline): string | LoadedTemplate | undefined {
  return o.template ?? o.overrides?.theme ?? timeline.video?.template ?? o.project.config.template;
}

/** Gate 1 (trust `mcp`): what the plan will read, checked before anything is read. Empty: nothing refused. */
export function preReadProblems(
  project: LoadedProject,
  timeline: Timeline,
  video: Timeline['video'],
  o: Pick<PlanRunOptions, 'template' | 'overrides' | 'project'> & { registry?: ComponentRegistry },
): string[] {
  const problems: string[] = [];
  const theme = themeRef(o, timeline);
  if (typeof theme === 'string') {
    const where =
      o.template !== undefined
        ? 'the theme asked'
        : o.overrides?.theme !== undefined
          ? 'the theme of the overrides'
          : timeline.video?.template !== undefined
            ? "the run's theme (the scenario's template:)"
            : 'the theme';
    const p = templateRefProblem(theme, project.config.template, where);
    if (p) problems.push(p);
  }
  const uses = planFileUses(timeline).map((u) => ({ ref: u.ref, where: u.where }));
  const music = musicSpecOf(video, o.overrides ?? {});
  if (music) uses.push({ ref: music.file, where: typeof o.overrides?.music === 'string' ? 'the music of the overrides' : 'the music bed (music.file)' });
  problems.push(...renderFileProblems(project.dir, uses, nodeFileFacts));
  // A slot the component only shows or encodes (a CTA's url, its QR code) is not a file to load: its manifest says.
  const slotType = (component: string | undefined, slot: string): string | undefined => {
    if (!component || !o.registry) return undefined;
    try {
      return o.registry.get(component).manifest.slots[slot]?.type;
    } catch {
      return undefined;
    }
  };
  for (const r of remoteSlotUses(timeline, slotType)) {
    problems.push(`${r.where}: ${r.ref} is a remote URL: through MCP a render loads no remote file — put the file in the project (assets/) and name it there`);
  }
  return problems;
}

/** Gate 2 (trust `mcp`): every file the plan serves lies in the project, the run or the theme folder. */
export function servedFileProblems(plan: Pick<EditPlan, 'assets'>, folders: { project: string; run: string; theme: string }): string[] {
  const problems: string[] = [];
  for (const [url, file] of Object.entries(plan.assets)) {
    const name = planAssetName(url);
    if (insideFolder(folders.project, file, nodeFileFacts) || insideFolder(folders.run, file, nodeFileFacts) || insideFolder(folders.theme, file, nodeFileFacts)) {
      // A hard link inside the folders may be the same file as one outside them: never served.
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
  const run = typeof o.run === 'string' ? await locateRun(project, o.run, o.scenario, { trust }) : o.run;
  const facts = await namedRunFacts(project, run.dir);
  const purpose = o.purpose ?? 'render';
  const ruled = namedRunProblem(facts.facts, { ...(o.scenario !== undefined ? { scenario: o.scenario } : {}), trust, inside: facts.inside });
  // A plan alone reads no film: a run without its film still plans (`retake plan`), as it always has.
  const refused = purpose === 'plan' && ruled?.why === 'no-film' ? null : ruled;
  const words = (problem: NamedProblem): string => takeWords(problem, { run: run.id, verb: purpose, dir: run.dir });
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
  // The registry first (the components' own files, not the run's): gate 1 reads slot types from the manifests.
  const registry = await registryFrom(o.registry, root, 'plan');
  if (trust === 'mcp') {
    const problems = preReadProblems(project, timeline, video, { ...o, registry });
    if (problems.length) throw new PlanTrustError(problems);
  }
  const theme = themeRef(o, timeline);
  const template = theme && typeof theme === 'object' ? theme : await loadProjectTemplate(project, theme, { files: fileFacts(o.workPolicy) });
  if (o.template || overrides.theme) overrides.theme = template.name;
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

/** A plan's note on where its edit came from, and the warnings of the re-plan. */
export function noteEdit(plan: EditPlan, edit: PlannedEdit, warnings: readonly string[], runId: string): void {
  if (edit.from === 'scenario' && edit.changes?.length) {
    plan.notes.unshift(`${editReplannedMessage(plan.meta.scenario, runId)} (changed: ${edit.changes.slice(0, 12).join(', ')}${edit.changes.length > 12 ? ', …' : ''})`);
  }
  plan.warnings.push(...warnings);
}

/**
 * The timeline a plan reads: the run's, rewritten with today's edit when the scenario file's filmed part is
 * unchanged since the capture (core scenarioSinceRun, replanEdit); else the run's as captured. `editText`: the
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
