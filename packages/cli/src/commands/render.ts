import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPONENT_ID_RE, FRAME_STYLE_LAYOUTS, MULTI_PAGE_LAYOUTS, editReplannedMessage, scenarioChangedMessage, takeWords, untilStep } from '@retake/core';
import { scenarioSinceRun } from '@retake/core/io';
import type { LoadedProject } from '@retake/core';
import { defaultStillFile, editorErrorOf, editorRenderer, findRunOf, planWork, renderInProcess, stillInProcess } from '@retake/engine';
import type { EditOverrides, RenderProgress, RenderRecord, RunRef } from '@retake/engine';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { cliPorts, openProject, openWorkspace } from '../workspace.js';
import { printReview, runReview } from './review.js';
import { heavyGate } from '../heavy-gate.js';
import type { GlobalOptions } from '../workspace.js';

export interface RenderCommandOptions {
  /** `--no-wait` (wait: false): start even while a take films, at normal priority (L5.14). */
  wait?: boolean;
  /** Run id, run directory or "latest" (default latest of the scenario). */
  run?: string;
  theme?: string;
  /** Frame style or layout component id for every scene. */
  frame?: string;
  vertical?: boolean;
  square?: boolean;
  scale?: string;
  /** commander: --music <file> (string) or --no-music (false). */
  music?: string | boolean;
  /** commander: --no-intro / --no-outro set these to false. */
  intro?: boolean;
  outro?: boolean;
  /** commander: --tutorial (true) / --no-tutorial (false): every tutorial overlay on, or none (L2.10). */
  tutorial?: boolean;
  out?: string;
  concurrency?: string;
  json?: boolean;
  /** Review the render right after it (retake review). */
  review?: boolean;
}

export interface StillCommandOptions {
  /** `--no-wait` (wait: false): start even while a take films, at normal priority (L5.14). */
  wait?: boolean;
  run?: string;
  /** Output frame number (required). */
  frame?: string;
  /** Frame (layout) of every scene: a FrameStyle or a layout component id (`retake render --frame`). */
  layout?: string;
  theme?: string;
  vertical?: boolean;
  square?: boolean;
  out?: string;
  json?: boolean;
}

/** The variant asked by `--vertical` / `--square` (not both). */
export function variantOption(opts: { vertical?: boolean; square?: boolean }): EditOverrides['variant'] {
  if (opts.vertical && opts.square) throw new UsageError('--vertical and --square: pick one variant');
  return opts.vertical ? 'vertical' : opts.square ? 'square' : undefined;
}

function checkFrameSpec(frame: string | undefined): void {
  if (frame !== undefined && !(frame in FRAME_STYLE_LAYOUTS) && !(frame in MULTI_PAGE_LAYOUTS) && !COMPONENT_ID_RE.test(frame)) {
    throw new UsageError(`--frame "${frame}": use ${[...Object.keys(FRAME_STYLE_LAYOUTS), ...Object.keys(MULTI_PAGE_LAYOUTS)].join(', ')} or a layout component id (namespace/name)`);
  }
}

function positiveNumber(name: string, value: string | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new UsageError(`${name} "${value}": use a number in (0, ${max}]`);
  return n;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function bar(fraction: number, width = 28): string {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  return `${'█'.repeat(full)}${'░'.repeat(width - full)}`;
}

/** The live progress line of a render (interactive terminals) and one line per stage otherwise. */
class RenderProgressPrinter {
  private stage = '';
  private readonly started = performance.now();

  constructor(private readonly ui: Ui) {}

  handle(p: RenderProgress): void {
    const { ui } = this;
    const c = ui.c;
    if (p.stage !== this.stage) {
      if (this.stage) ui.clearStatus();
      this.stage = p.stage;
      if (!ui.io.interactive && p.stage !== 'done') ui.line(c.dim(`${p.stage}…`));
      if (p.stage === 'bundling' && p.cached) ui.line(c.dim('bundle: cached'));
    }
    if (p.stage === 'bundling' && p.cached && p.progress >= 1) return;
    const pct = `${Math.round(p.overall * 100)}%`.padStart(4);
    let detail = '';
    if ((p.stage === 'rendering' || p.stage === 'retrying') && p.totalFrames) detail = `frame ${p.renderedFrames ?? 0}/${p.totalFrames}${p.eta_s !== undefined ? ` · ${p.eta_s} s left` : ''}`;
    else if (p.stage === 'encoding' && p.totalFrames) detail = `encoded ${p.encodedFrames ?? 0}/${p.totalFrames}`;
    else if (p.stage === 'bundling') detail = `${Math.round(p.progress * 100)}%`;
    if (p.stage !== 'done') ui.setStatus(`${c.cyan(bar(p.overall))} ${pct}  ${p.stage.padEnd(9)} ${c.dim(detail)}  ${c.dim(formatMs(performance.now() - this.started))}`);
  }

  done(): void {
    this.ui.clearStatus();
  }
}

/** Ctrl+C cancels the render (nothing is written under the final name). */
function abortOnSigint(ui: Ui): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onSigint = () => {
    ui.clearStatus();
    ui.warn('cancelling the render…');
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  return { signal: controller.signal, dispose: () => process.removeListener('SIGINT', onSigint) };
}

/** "h264 VideoToolbox 8M", "h264 crf 16" (L5.15: the encoder of the record). */
export function encodingWords(r: Pick<RenderRecord, 'encoding'>): string {
  const e = r.encoding;
  return e.encoder === 'h264_videotoolbox' ? `h264 VideoToolbox ${e.bitrate ?? ''}`.trimEnd() : `h264 crf ${e.crf ?? 16}`;
}

/**
 * "on the GPU", "in software", "in software after a GPU failure" (L5.15: what drew the render), "in software after
 * this machine's ffmpeg failed at the encode" (L7.3) — never the failure's own words.
 */
export function glWords(r: Pick<RenderRecord, 'policy'>): string {
  const p = r.policy;
  if (!p) return 'in software';
  if (p.fallback) return 'in software after a GPU failure';
  if (p.ffmpeg?.failed !== undefined) return "in software after this machine's ffmpeg failed at the encode";
  return p.gl.used === 'angle' ? 'on the GPU' : 'in software';
}

function summary(ui: Ui, r: RenderRecord): void {
  const c = ui.c;
  ui.ok(`rendered ${c.bold(r.id)} → ${ui.path(r.file)}`);
  const probe = r.probe ? ` · checked: ${r.probe.duration_s.toFixed(2)} s, ${r.probe.width}×${r.probe.height}, ${r.probe.audio_streams} audio track${r.probe.audio_streams === 1 ? '' : 's'}` : '';
  ui.line(`  ${r.duration_s.toFixed(2)} s · ${r.frames} frames @ ${r.fps} fps · ${r.width}×${r.height} · ${formatBytes(r.size_bytes)} · ${encodingWords(r)}, ${r.encoding.audio} audio${probe}`);
  ui.line(
    c.dim(
      `  theme ${r.template} · run ${r.run_id} · bundle ${r.bundle.cached ? 'cached' : `built in ${formatMs(r.bundle.ms)}`} · render ${formatMs(r.timings.render_ms)} (concurrency ${r.concurrency}) ${glWords(r)} · total ${formatMs(r.timings.total_ms)}`,
    ),
  );
  ui.line(c.dim(`  record ${ui.path(r.record)}`));
  for (const w of r.warnings) ui.warn(w);
}

/**
 * What `latest` said of the run it picked (core latestTake, through the editor's findRun), as lines for stderr — none
 * for a run that was named, none when there is nothing to say:
 * - the newer captures it passed over (failed, cancelled, not finished or interrupted, without their film…), each with
 *   its id and the rule's fixed words for the reason (never a message read from a file), at most five named and the
 *   rest counted; then the newer run folders whose run.json is missing or does not read as a record (a count: nothing
 *   says which scenario they are of); then how to name one instead;
 * - where the capture it picked ends when it was stopped by `--until` (it is still the latest capture): the step when
 *   run.json names it as a scenario does (core untilStep), else only that it stops early — no text of a file is
 *   printed as the file has it.
 * `scenario`: the scenario asked for, when one was; `name`: how a run is named to the command.
 */
export function latestNotice(run: RunRef, o: { scenario?: string; name?: string } = {}): string[] {
  const pick = run.latest;
  if (!pick) return [];
  const lines: string[] = [];
  const n = pick.passed.length + pick.passed_more;
  const w = pick.without_record;
  if (n > 0 || w > 0) {
    const parts: string[] = [];
    if (n > 0) {
      const list = pick.passed.map((p) => `${p.run} (${takeWords(p.why, { run: p.run, verb: 'render' })})`);
      if (pick.passed_more > 0) list.push(`and ${pick.passed_more} more`);
      parts.push(`${n} newer capture${n === 1 ? '' : 's'}${o.scenario ? ` of "${o.scenario}"` : ''} passed over — ${list.join('; ')}`);
    }
    if (w > 0) parts.push(`${w} newer run folder${w === 1 ? '' : 's'} without a run.json that reads as a record ${w === 1 ? 'was' : 'were'} not considered`);
    lines.push(`run ${run.id} is used: ${parts.join('; ')} (${o.name ?? 'name one with --run <id>'})`);
  }
  if (pick.take?.until) {
    const at = untilStep(pick.take.until);
    lines.push(`run ${run.id} stops ${at ? `at step ${at.scene}.${at.step}` : 'early'} (\`--until\`): the capture holds the scenario up to there`);
  }
  return lines;
}

/** latestNotice on stderr; nothing with `--json` (as the commands' other notes). */
export function warnLatest(ui: Ui, run: RunRef, o: { scenario?: string; name?: string; json?: boolean } = {}): void {
  if (o.json) return;
  for (const line of latestNotice(run, o)) ui.warn(line);
}

/**
 * L5.5: before a render, say whether the scenario file changed since the run was captured — its filmed part (the render
 * shows the take as captured: re-capture to film it), or its edit alone (re-planned on this take). A run that cannot be
 * found says nothing here: the render reports it.
 */
async function warnScenarioChanged(ui: Ui, project: LoadedProject, runArg: string, scenario: string): Promise<void> {
  let dir: string;
  let id: string;
  try {
    ({ dir, id } = await findRunOf(project, runArg, scenario));
  } catch {
    return;
  }
  const since = scenarioSinceRun(project, dir, scenario);
  if (!since?.changed) return;
  if (since.filmed === undefined || since.filmed.length > 0) ui.warn(scenarioChangedMessage(scenario, id, `\`retake run ${project.slug} ${scenario}\``, since.filmed));
  else ui.info(editReplannedMessage(scenario, id));
}

/**
 * `retake render <project> <scenario>`: plan and render the latest capture of a scenario (or `--run`) into
 * renders/<scenario>-v<N>.mp4 + .json, with a progress bar and a summary.
 */
export async function renderCommand(ui: Ui, global: GlobalOptions, projectArg: string, scenario: string, opts: RenderCommandOptions): Promise<ExitCode> {
  checkFrameSpec(opts.frame);
  const scale = positiveNumber('--scale', opts.scale, 4);
  const concurrency = positiveNumber('--concurrency', opts.concurrency, 16);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const overrides: EditOverrides = {};
  const variant = variantOption(opts);
  if (opts.frame) overrides.frame = opts.frame;
  if (variant) overrides.variant = variant;
  if (scale !== undefined) overrides.scale = scale;
  if (opts.music === false) overrides.music = false;
  // A path from the shell (cwd) when it exists there, else relative to the project like the scenario's `music.file`.
  else if (typeof opts.music === 'string') overrides.music = existsSync(resolve(opts.music)) ? resolve(opts.music) : opts.music;
  if (opts.intro === false) overrides.intro = false;
  if (opts.outro === false) overrides.outro = false;
  if (opts.tutorial !== undefined) overrides.tutorial = opts.tutorial;
  await warnScenarioChanged(ui, project, opts.run ?? 'latest', scenario);
  // Captures first (L5.14): the run is the one named now ("latest" resolved before any wait, critique M10).
  // The editor's errors state their kind (core error-kind.ts): main prints their message alone, exit 1.
  const run = await findRunOf(project, opts.run ?? 'latest', scenario);
  const runId = run.id;
  // What `latest` passed over, and a capture stopped by `--until` (stderr; nothing for a run that was named).
  warnLatest(ui, run, { scenario, json: opts.json });
  const gate = await heavyGate(ui, { root: ws.root, what: 'rendering', noWait: opts.wait === false });
  if (gate.waited) ui.info(`rendering run ${runId}`);
  const printer = opts.json ? null : new RenderProgressPrinter(ui);
  const { signal, dispose } = abortOnSigint(ui);
  try {
    // The render, then its line of the workspace's history (the engine's in-process operation).
    const record = await renderInProcess({
      renderer: editorRenderer(),
      workPolicy: ws.policy,
      project,
      root: ws.root,
      clock: cliPorts.clock,
      run: runId,
      scenario,
      template: opts.theme,
      overrides,
      out: opts.out ? resolve(opts.out) : undefined,
      concurrency: concurrency !== undefined ? Math.round(concurrency) : undefined,
      signal,
      onProgress: (p) => printer?.handle(p),
    });
    printer?.done();
    if (!opts.json) summary(ui, record);
    let review;
    if (opts.review) {
      try {
        review = await runReview(ui, { policy: ws.policy, project, root: ws.root, render: record.record, quiet: opts.json });
      } catch (e) {
        if (e instanceof Error && e.name === 'ReviewError') throw new CliError(`rendered ${record.id}, but the review failed: ${e.message}`);
        throw e;
      }
      if (!opts.json) printReview(ui, review);
    }
    if (opts.json) {
      const { plan: _plan, ...rest } = record;
      if (review) {
        const { thumbnails: _t, ...r } = review;
        ui.result(JSON.stringify({ ...rest, review: r }, null, 2));
      } else ui.result(JSON.stringify(rest, null, 2));
    }
    return EXIT.ok;
  } catch (e) {
    printer?.done();
    // A cancelled render in the CLI's words; any other error as it is.
    if ((await editorErrorOf(e)) === 'render_cancelled') throw new CliError('render cancelled: nothing was written');
    throw e;
  } finally {
    dispose();
    await gate.dispose();
  }
}

/** `retake still <project> <scenario> --frame <n>`: one output frame of the planned video as a PNG. */
export async function stillCommand(ui: Ui, global: GlobalOptions, projectArg: string, scenario: string, opts: StillCommandOptions): Promise<ExitCode> {
  if (opts.frame === undefined || !/^\d+$/.test(opts.frame)) throw new UsageError('--frame <n>: the output frame number (0-based) is required');
  const frame = Number(opts.frame);
  checkFrameSpec(opts.layout);
  const variant = variantOption(opts);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const overrides: EditOverrides = {};
  if (variant) overrides.variant = variant;
  if (opts.layout) overrides.frame = opts.layout;
  const { plan, run, registry } = await planWork({
    workPolicy: ws.policy,
    project,
    run: opts.run ?? 'latest',
    scenario,
    ...(opts.theme ? { template: opts.theme } : {}),
    overrides,
    root: ws.root,
    measureMusic: false,
  });
  warnLatest(ui, run, { scenario, json: opts.json });
  if (frame >= plan.durationInFrames) throw new CliError(`--frame ${frame} is past the end of the video (${plan.durationInFrames} frames, 0–${plan.durationInFrames - 1})`);
  const out = opts.out ? resolve(opts.out) : await defaultStillFile(project, scenario, plan.variant, frame);
  // Captures first (L5.14): the run was planned (resolved) before any wait.
  const gate = await heavyGate(ui, { root: ws.root, what: 'rendering', noWait: opts.wait === false });
  if (gate.waited) ui.info(`rendering frame ${frame} of run ${run.id}`);
  const t0 = performance.now();
  ui.setStatus(ui.c.dim(`  … rendering frame ${frame} of ${scenario}`));
  try {
    // The still, then its line of the workspace's history (a still is a render too).
    await stillInProcess({ renderer: editorRenderer(), workPolicy: ws.policy, plan, frame, out, root: ws.root, clock: cliPorts.clock, registry, project });
  } finally {
    ui.clearStatus();
    await gate.dispose();
  }
  const segment = plan.segments.filter((s) => s.from <= frame).pop();
  if (opts.json) {
    ui.result(JSON.stringify({ file: out, frame, time_s: frame / plan.fps, segment: segment?.id, run_id: run.id, width: plan.width, height: plan.height }, null, 2));
  } else {
    ui.ok(`frame ${frame} (${(frame / plan.fps).toFixed(2)} s, ${segment ? `${segment.kind} ${segment.id}` : '—'}) → ${ui.path(out)} ${ui.c.dim(formatMs(performance.now() - t0))}`);
  }
  return EXIT.ok;
}
