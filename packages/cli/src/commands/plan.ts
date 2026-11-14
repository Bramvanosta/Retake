import { resolve } from 'node:path';
import { COMPONENT_ID_RE, FRAME_STYLE_LAYOUTS, MULTI_PAGE_LAYOUTS } from '@retake/core/model';
import { scenarioChangedMessage } from '@retake/core/scenario';
import { writeJson } from '@retake/core/io';
import { planOfRun } from '@retake/engine';
import type { EditOverrides } from '@retake/engine';
import { EXIT, UsageError } from '../errors.js';
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
  const overrides: EditOverrides = {};
  if (opts.frame) overrides.frame = opts.frame;
  const variant = variantOption(opts);
  if (variant) overrides.variant = variant;
  // The engine's plan of a run (L7.22, U8a: planOfRun — the run by the rule every reader of runs shares, then the
  // planning of a render for a plan alone: its refusals say plan, a run without its film plans). What `latest` passed
  // over is said once the run is found, before any refusal (stderr); its errors state their kind: main prints their
  // sentence alone, exit 1. At a terminal (trust `author`) a theme may be a ./path.
  const { plan, edit, timeline, registry, run, summary } = await planOfRun(ws, project, runArg, {
    ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}),
    ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
    overrides,
    trust: 'author',
    onRun: (run) => warnLatest(ui, run, { ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}), name: 'name one in place of "latest"', json: opts.json }),
  });
  if (opts.out) {
    const out = resolve(opts.out);
    await writeJson(out, plan);
    if (!opts.json) ui.ok(`plan written to ${ui.path(out)}`);
  }
  // L5.5: the filmed part changed since the run (stderr, so --json stays parseable).
  if (edit.scenario_changed) ui.warn(scenarioChangedMessage(timeline.scenario, run.id, `\`retake run ${project.slug} ${timeline.scenario}\``, edit.filmed_changes));
  if (opts.json) {
    ui.result(JSON.stringify(plan, null, 2));
    return EXIT.ok;
  }
  const c = ui.c;
  for (const line of summary) {
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
