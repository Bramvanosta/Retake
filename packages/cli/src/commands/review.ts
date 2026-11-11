import type { Finding, ReviewProgress } from '@retake/review';
import { environmentLine, findingLine, summaryLine } from '@retake/review';
import { findRenderOf, reviewWork } from '@retake/engine';
import type { ReviewResult } from '@retake/engine';
import { printableText } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs, plural } from '../ui.js';
import { renderNotes } from './render-notes.js';
import { openProject, openWorkspace } from '../workspace.js';
import { heavyGate } from '../heavy-gate.js';
import type { GlobalOptions } from '../workspace.js';

export interface ReviewCommandOptions {
  /** `--no-wait` (wait: false): start even while a take films, at normal priority (L5.14). */
  wait?: boolean;
  fps?: string;
  /** Render id to compare with; commander sets false for --no-previous. */
  previous?: string | false;
  /** With "latest": the latest render of this scenario. */
  scenario?: string;
  /** Exit with 1 when the review is not clean. */
  strict?: boolean;
  json?: boolean;
}

const STAGES: Record<ReviewProgress['stage'], string> = {
  loading: 'loading the render',
  frames: 'decoding frames',
  capture: 'checking the capture',
  previous: 'comparing with the previous render',
  checks: 'running the checks',
  sheets: 'drawing the contact sheets',
  writing: 'writing the report',
  done: 'done',
};

function fpsOption(value: string | undefined): 1 | 2 | undefined {
  if (value === undefined) return undefined;
  if (value === '1' || value === '2') return Number(value) as 1 | 2;
  throw new UsageError(`--fps "${value}": the contact sheet takes 1 or 2 frames per second`);
}

/** The summary of a review on the terminal: verdict, findings, files. */
export function printReview(ui: Ui, r: ReviewResult): void {
  const c = ui.c;
  const head = `review ${c.bold(r.render.id)} (${r.render.duration_s.toFixed(2)} s, ${plural(r.durations.segments.length, 'segment')}) → ${ui.path(r.files.dir)}`;
  if (r.clean) ui.ok(`${head}\n  ${c.green(summaryLine(r))}`);
  else ui.line(`${r.counts.error ? c.red('✗') : c.yellow('!')} ${head}\n  ${r.counts.error ? c.red(summaryLine(r)) : c.yellow(summaryLine(r))}`);
  if (r.environment) ui.line(c.dim(`  environment ${environmentLine(r.environment)}`));
  const colour = (f: Finding) => (f.severity === 'error' ? c.red : f.severity === 'warning' ? c.yellow : c.dim);
  for (const f of r.findings) ui.line(`  ${colour(f)(f.severity.padEnd(7))} ${findingLine(f, false)}`);
  const files = r.files;
  const scenePages = Object.values(files.scene_sheets).flat().length;
  ui.line(
    c.dim(
      `  files: ${files.sheets.map((f) => ui.path(f)).join(', ')} · ${plural(Object.keys(files.scene_sheets).length, 'scene sheet')}${scenePages > Object.keys(files.scene_sheets).length ? ` (${scenePages} pages)` : ''} · ${plural(Object.keys(files.keyframes).length, 'key frame')} · timeline.json · report.json · report.md${files.diff_sheet ? ` · ${ui.path(files.diff_sheet)}` : ''}`,
    ),
  );
  ui.line(c.dim(`  report ${ui.path(files.report_md)} · ${formatMs(r.review.ms)}`));
}

/** Run a review with a status line; returns the result. */
export async function runReview(
  ui: Ui,
  opts: { policy: WorkPolicy; project: Parameters<typeof reviewWork>[0]['project']; root: string; render: string; scenario?: string; fps?: 1 | 2; previous?: string | false; quiet?: boolean },
): Promise<ReviewResult> {
  try {
    return await reviewWork({
      policy: opts.policy,
      project: opts.project,
      root: opts.root,
      render: opts.render,
      scenario: opts.scenario,
      fps: opts.fps,
      previous: opts.previous,
      thumbnails: false,
      onProgress: (p) => {
        if (!opts.quiet) ui.setStatus(ui.c.dim(`  … ${STAGES[p.stage]}${p.progress !== undefined && p.stage === 'frames' ? ` ${Math.round(p.progress * 100)} %` : ''}`));
      },
    });
  } finally {
    ui.clearStatus();
  }
}

/**
 * `retake review <project> <render|latest>`: contact sheets, per-scene sheets, key frames, the output-time timeline and
 * report.json/report.md in review/<render>/, and the findings on the terminal.
 */
export async function reviewCommand(ui: Ui, global: GlobalOptions, projectArg: string, render: string, opts: ReviewCommandOptions): Promise<ExitCode> {
  const fps = fpsOption(opts.fps);
  if (typeof opts.previous === 'string' && opts.previous.trim() === '') throw new UsageError('--previous needs a render id (or use --no-previous)');
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  // Captures first (L5.14): the render is the one named now ("latest" resolved before any wait, critique M10).
  // `latest` names a FILE of renders/: the review then reads that file (never the id its record says, looked up again).
  // A render named is looked at first only to say what it is (a record renamed by hand); the review finds it again
  // and says why when it cannot be reviewed.
  let found: Awaited<ReturnType<typeof findRenderOf>> | undefined;
  if (render === 'latest') {
    try {
      found = await findRenderOf(project, render, opts.scenario);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  } else found = await findRenderOf(project, render).catch(() => undefined);
  const renderId = render === 'latest' && found ? found.entry.name : render;
  if (found && !opts.json) for (const line of renderNotes(project.dir, found)) ui.warn(line);
  const gate = await heavyGate(ui, { root: ws.root, what: 'reviewing', noWait: opts.wait === false });
  if (gate.waited) ui.info(`reviewing render ${printableText(renderId)}`);
  let result: ReviewResult;
  try {
    result = await runReview(ui, { policy: ws.policy, project, root: ws.root, render: renderId, scenario: opts.scenario, fps, previous: opts.previous, quiet: opts.json });
  } catch (e) {
    if (e instanceof Error && e.name === 'ReviewError') throw new CliError(e.message);
    throw e;
  } finally {
    await gate.dispose();
  }
  if (opts.json) {
    const { thumbnails: _t, ...rest } = result;
    ui.result(JSON.stringify(rest, null, 2));
  } else printReview(ui, result);
  return opts.strict && !result.clean ? EXIT.failure : EXIT.ok;
}
