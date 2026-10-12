import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { COMPONENT_ID_RE, FRAME_STYLE_LAYOUTS, loadProjectTemplate, parseScenario, readJson, runIdMatchesScenario, writeJson } from '@demo-studio/core';
import type { LoadedProject, Scenario, Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import { planEdit, planInputFiles, summarizePlan } from '@demo-studio/editor';
import type { EditOverrides } from '@demo-studio/editor';
import { CliError, EXIT, UsageError } from '../errors.js';
import { variantOption } from './render.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface PlanCommandOptions {
  /** With `latest`: the latest run of this scenario. */
  scenario?: string;
  /** Theme (template name or ./path) instead of the one the run used. */
  theme?: string;
  /** Frame style or layout component id for every scene. */
  frame?: string;
  vertical?: boolean;
  square?: boolean;
  json?: boolean;
  /** Write the plan JSON to this file. */
  out?: string;
}

interface RunRef {
  id: string;
  dir: string;
}

/** A run folder whose timeline.json is a capture (not a dry run). */
function hasCaptureTimeline(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { mode?: string }).mode === 'capture';
  } catch {
    return false;
  }
}

/**
 * The run a command works on: a run id (folder of <project>/runs), a run directory, or `latest` (the most recent
 * capture run — dry runs and runs without a timeline are skipped —, of `scenario` when given). Run ids start with
 * their date, so they sort chronologically.
 */
export function resolveRun(project: LoadedProject, arg: string, scenario?: string): RunRef {
  const runsDir = join(project.dir, 'runs');
  if (arg === 'latest') {
    let ids: string[] = [];
    try {
      ids = readdirSync(runsDir).filter((id) => statSync(join(runsDir, id)).isDirectory());
    } catch {
      ids = [];
    }
    const candidates = ids
      .filter((id) => (scenario ? runIdMatchesScenario(id, scenario) : true))
      .filter((id) => hasCaptureTimeline(join(runsDir, id)))
      .sort()
      .reverse();
    if (candidates.length === 0) {
      throw new CliError(
        `no capture run${scenario ? ` of scenario "${scenario}"` : ''} in ${runsDir}: capture one with \`studio run ${project.slug} <scenario>\``,
      );
    }
    return { id: candidates[0], dir: join(runsDir, candidates[0]) };
  }
  const asId = join(runsDir, arg);
  if (existsSync(asId)) return { id: arg, dir: asId };
  const asDir = resolve(arg);
  if (isAbsolute(arg) || arg.startsWith('.') || /[\\/]/.test(arg)) {
    if (existsSync(asDir)) return { id: asDir.split(/[\\/]/).pop() ?? arg, dir: asDir };
  }
  throw new CliError(`run "${arg}" not found in ${runsDir} (use a run id, a run directory or "latest")`);
}

/** The scenario snapshot of a run (extra context for the planner); undefined when absent or invalid. */
async function runScenario(dir: string): Promise<Scenario | undefined> {
  try {
    const text = await readFile(join(dir, 'scenario.yaml'), 'utf8');
    return parseScenario(text).scenario;
  } catch {
    return undefined;
  }
}

/**
 * `studio plan <project> <run-id|latest>`: the edit plan of a capture (planEdit) as a human summary — segments with
 * their components, durations, speeds, trims, zooms, captions, notes and warnings — or as JSON (`--json`, `--out`).
 */
export async function planCommand(ui: Ui, global: GlobalOptions, projectArg: string, runArg: string, opts: PlanCommandOptions): Promise<ExitCode> {
  if (opts.frame !== undefined && !(opts.frame in FRAME_STYLE_LAYOUTS) && !COMPONENT_ID_RE.test(opts.frame)) {
    throw new UsageError(`--frame "${opts.frame}": use ${Object.keys(FRAME_STYLE_LAYOUTS).join(', ')} or a layout component id (namespace/name)`);
  }
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const run = resolveRun(project, runArg, opts.scenario);
  const timeline = await readJson<Timeline>(join(run.dir, 'timeline.json'));
  if (opts.scenario && timeline.scenario !== opts.scenario) {
    throw new CliError(`run ${run.id} is a run of scenario "${timeline.scenario}", not "${opts.scenario}"`);
  }
  if (timeline.mode === 'dry') throw new CliError(`run ${run.id} is a dry run: there is no capture to plan`);
  const themeRef = opts.theme ?? timeline.video?.template ?? project.config.template;
  const template = await loadProjectTemplate(project, themeRef);
  const registry = await loadComponentRegistry({ root: ws.root });
  const overrides: EditOverrides = {};
  if (opts.theme) overrides.theme = template.name;
  if (opts.frame) overrides.frame = opts.frame;
  const variant = variantOption(opts);
  if (variant) overrides.variant = variant;
  const plan = planEdit({
    timeline,
    template,
    project,
    registry,
    captureFile: join(run.dir, timeline.capture.file || 'capture.mp4'),
    scenario: await runScenario(run.dir),
    overrides,
    files: await planInputFiles(timeline, project),
  });
  if (opts.out) {
    const out = resolve(opts.out);
    await writeJson(out, plan);
    if (!opts.json) ui.ok(`plan written to ${ui.path(out)}`);
  }
  if (opts.json) {
    ui.result(JSON.stringify(plan, null, 2));
    return EXIT.ok;
  }
  const c = ui.c;
  const lines = summarizePlan(plan);
  for (const line of lines) {
    if (/^(Segments|Captions|Markers|Notes|Warnings|Music)\b/.test(line)) ui.result(c.bold(line));
    else if (line.startsWith('  ! ')) ui.result(c.yellow(line));
    else if (line.includes('MISSING')) ui.result(line.replace('MISSING', c.yellow('MISSING')));
    else ui.result(line);
  }
  for (const n of registry.notices) {
    if (n.severity === 'error') ui.warn(n.message);
  }
  return EXIT.ok;
}
