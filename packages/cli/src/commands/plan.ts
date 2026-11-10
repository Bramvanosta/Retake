import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { COMPONENT_ID_RE, DEFAULT_FILM, FRAME_STYLE_LAYOUTS, MULTI_PAGE_LAYOUTS, namedRunProblem, parseScenario, scenarioChangedMessage, takeWords, timelineProblem } from '@retake/core';
import { loadProjectTemplate, readNamedRun, writeJson, fileFacts } from '@retake/core/io';
import type { Scenario } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import { editOfToday, noteEdit, planEdit, planInputFiles, recordEnv, summarizePlan } from '@retake/editor';
import { findRunOf } from '@retake/engine';
import type { EditOverrides } from '@retake/editor';
import { CliError, EXIT, UsageError } from '../errors.js';
import { variantOption, warnLatest } from './render.js';
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
 * `retake plan <project> <run-id|latest>`: the edit plan of a capture (planEdit) as a human summary — segments with
 * their components, durations, speeds, trims, zooms, captions, notes and warnings — or as JSON (`--json`, `--out`).
 */
export async function planCommand(ui: Ui, global: GlobalOptions, projectArg: string, runArg: string, opts: PlanCommandOptions): Promise<ExitCode> {
  if (opts.frame !== undefined && !(opts.frame in FRAME_STYLE_LAYOUTS) && !(opts.frame in MULTI_PAGE_LAYOUTS) && !COMPONENT_ID_RE.test(opts.frame)) {
    throw new UsageError(`--frame "${opts.frame}": use ${[...Object.keys(FRAME_STYLE_LAYOUTS), ...Object.keys(MULTI_PAGE_LAYOUTS)].join(', ')} or a layout component id (namespace/name)`);
  }
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  // The run: a run id, a run directory, or `latest` — the newest capture an edit can work on, of `--scenario` when
  // given, by the rule every reader of runs shares (the editor's findRun, as render and export-capture; its errors
  // state their kind: main prints their sentence alone, exit 1).
  const run = await findRunOf(project, runArg, opts.scenario);
  warnLatest(ui, run, { ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}), name: 'name one in place of "latest"', json: opts.json });
  // The named run's rule (core namedRunProblem, over the one reader), in its sentence: a run.json a newer Retake wrote
  // (R-PRIN-13), no timeline or one that does not read, a run of another scenario, a dry run. A plan reads no film:
  // a run without its film still plans, as it always has.
  const { facts, timeline: whole } = await readNamedRun(run.dir);
  const problem = namedRunProblem(facts, { ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}), trust: 'author', inside: true });
  if (problem && problem.why !== 'no-film') throw new CliError(takeWords(problem, { run: run.id, verb: 'plan', dir: run.dir }));
  // The head reads and the whole does not: its lists are not lists.
  if (!whole.ok) throw new CliError(takeWords(timelineProblem(whole) ?? { why: 'no-timeline' }, { run: run.id, verb: 'plan', dir: run.dir }));
  const captured = whole.value;
  const env = recordEnv(facts.record);
  // L5.5: the edit of today's scenario file when its filmed part is unchanged since the run, else the run's.
  const { timeline, edit, warnings } = editOfToday(project, run, captured, env, 'auto', undefined, fileFacts(ws.policy));
  const themeRef = opts.theme ?? timeline.video?.template ?? project.config.template;
  const template = await loadProjectTemplate(project, themeRef, { files: fileFacts(ws.policy) });
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
    captureFile: join(run.dir, timeline.capture.file || DEFAULT_FILM),
    scenario: await runScenario(run.dir),
    env,
    overrides,
    files: await planInputFiles(timeline, project, template, ws.policy),
  });
  if (opts.out) {
    const out = resolve(opts.out);
    await writeJson(out, plan);
    if (!opts.json) ui.ok(`plan written to ${ui.path(out)}`);
  }
  noteEdit(plan, edit, warnings, run.id);
  // L5.5: the filmed part changed since the run (stderr, so --json stays parseable).
  if (edit.scenario_changed) ui.warn(scenarioChangedMessage(timeline.scenario, run.id, `\`retake run ${project.slug} ${timeline.scenario}\``, edit.filmed_changes));
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
