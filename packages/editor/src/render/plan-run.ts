/**
 * Plan a run (L3.2): the one place where a render, a still, `studio still` and the MCP server's plan_preview turn a
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
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { insideFolder, loadProjectTemplate, readJson, renderFileProblems, templateRefProblem, timelineVideo } from '@demo-studio/core';
import type { LoadedProject, LoadedTemplate, Scenario, Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { planFileUses, planInputFiles, remoteSlotUses } from '../inputs.js';
import { musicFile, musicSpecOf, planEdit } from '../plan.js';
import { PLAN_ASSET_SCHEME } from '../plan-types.js';
import type { EditOverrides, EditPlan } from '../plan-types.js';
import { probeMedia } from './probe.js';
import { findRun, runEnv, runScenario } from './runs.js';
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
}

export interface PlanRunOptions {
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
  plan: EditPlan;
  plan_ms: number;
}

/** The theme a plan of this run uses: asked, else the overrides', else the run's, else the project's. */
function themeRef(o: PlanRunOptions, timeline: Timeline): string | LoadedTemplate | undefined {
  return o.template ?? o.overrides?.theme ?? timeline.video?.template ?? o.project.config.template;
}

/** Gate 1 (trust `mcp`): what the plan will read, checked before anything is read. Empty: nothing refused. */
export function preReadProblems(project: LoadedProject, timeline: Timeline, video: Timeline['video'], o: Pick<PlanRunOptions, 'template' | 'overrides' | 'project'>): string[] {
  const problems: string[] = [];
  const theme = themeRef(o as PlanRunOptions, timeline);
  if (typeof theme === 'string') {
    const where = o.template !== undefined ? 'the theme asked' : o.overrides?.theme !== undefined ? 'the theme of the overrides' : timeline.video?.template !== undefined ? "the run's theme (the scenario's template:)" : 'the theme';
    const p = templateRefProblem(theme, project.config.template, where);
    if (p) problems.push(p);
  }
  const uses = planFileUses(timeline).map((u) => ({ ref: u.ref, where: u.where }));
  const music = musicSpecOf(video, o.overrides ?? {});
  if (music) uses.push({ ref: music.file, where: typeof o.overrides?.music === 'string' ? 'the music of the overrides' : 'the music bed (music.file)' });
  problems.push(...renderFileProblems(project.dir, uses));
  for (const r of remoteSlotUses(timeline)) {
    problems.push(`${r.where}: ${r.ref} is a remote URL: through MCP a render loads no remote file — put the file in the project (assets/) and name it there`);
  }
  return problems;
}

/** Gate 2 (trust `mcp`): every file the plan serves lies in the project, the run or the theme folder. */
export function servedFileProblems(plan: Pick<EditPlan, 'assets'>, folders: { project: string; run: string; theme: string }): string[] {
  const problems: string[] = [];
  for (const [url, file] of Object.entries(plan.assets)) {
    if (insideFolder(folders.project, file) || insideFolder(folders.run, file) || insideFolder(folders.theme, file)) continue;
    const name = url.startsWith(PLAN_ASSET_SCHEME) ? url.slice(PLAN_ASSET_SCHEME.length) : url;
    problems.push(`the plan serves ${name} from ${file}, outside the project, the run and the theme folders: through MCP a render serves only those`);
  }
  return problems;
}

/** Plan a capture run (see the module comment); throws RenderError (PlanTrustError for a trust refusal). */
export async function planRun(o: PlanRunOptions): Promise<PlannedRun> {
  const t0 = performance.now();
  const project = o.project;
  const trust = o.trust ?? 'author';
  const root = resolve(o.root ?? project.root);
  const run = findRun(project, o.run, o.scenario);
  const timelineFile = join(run.dir, 'timeline.json');
  if (!existsSync(timelineFile)) throw new RenderError(`run ${run.id} has no timeline.json (${run.dir})`);
  const timeline = await readJson<Timeline>(timelineFile);
  if (o.scenario && timeline.scenario !== o.scenario) throw new RenderError(`run ${run.id} is a run of scenario "${timeline.scenario}", not "${o.scenario}"`);
  if (timeline.mode === 'dry') throw new RenderError(`run ${run.id} is a dry run: there is no capture to render`);
  const overrides: EditOverrides = { ...(o.overrides ?? {}) };
  const scenarioSnapshot = await runScenario(run.dir);
  const video = timeline.video ?? (scenarioSnapshot ? timelineVideo(scenarioSnapshot, project.config) : undefined);
  if (trust === 'mcp') {
    const problems = preReadProblems(project, timeline, video, o);
    if (problems.length) throw new PlanTrustError(problems);
  }
  const theme = themeRef(o, timeline);
  const template = theme && typeof theme === 'object' ? theme : await loadProjectTemplate(project, theme);
  if (o.template || overrides.theme) overrides.theme = template.name;
  const registry = o.registry ?? (await loadComponentRegistry({ root }));
  const captureFile = join(run.dir, timeline.capture.file || 'capture.mp4');
  if (!existsSync(captureFile)) throw new RenderError(`run ${run.id} has no capture video (${captureFile})`);
  // The planner is pure: the music track's length is measured here so it can plan the loops (or the trim).
  const musicSpec = musicSpecOf(video, overrides);
  let musicDuration_s: number | undefined;
  if (musicSpec && o.measureMusic !== false) {
    const file = musicFile(musicSpec, project);
    if (!existsSync(file)) throw new RenderError(`music file not found: ${file}`);
    const probe = await probeMedia(file);
    if (probe && probe.duration_s > 0) musicDuration_s = probe.duration_s;
  }
  const files = await planInputFiles(timeline, project, template);
  const plan = planEdit({ timeline, template, project, registry, captureFile, scenario: scenarioSnapshot, env: await runEnv(run.dir), overrides, musicDuration_s, files });
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
    plan,
    plan_ms: Math.round(performance.now() - t0),
  };
}
