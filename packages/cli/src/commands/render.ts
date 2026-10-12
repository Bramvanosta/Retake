import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPONENT_ID_RE, FRAME_STYLE_LAYOUTS, loadProjectTemplate, readJson } from '@demo-studio/core';
import type { Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import { RenderCancelledError, RenderError, VARIANT_SUFFIX, findRun, planEdit, renderStill, renderVideo, runScenario } from '@demo-studio/editor';
import type { EditOverrides, RenderProgress, RenderRecord } from '@demo-studio/editor';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import { printReview, runReview } from './review.js';
import type { GlobalOptions } from '../workspace.js';

export interface RenderCommandOptions {
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
  out?: string;
  concurrency?: string;
  json?: boolean;
  /** Review the render right after it (studio review). */
  review?: boolean;
}

export interface StillCommandOptions {
  run?: string;
  /** Output frame number (required). */
  frame?: string;
  /** Frame (layout) of every scene: a FrameStyle or a layout component id (`studio render --frame`). */
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
  if (frame !== undefined && !(frame in FRAME_STYLE_LAYOUTS) && !COMPONENT_ID_RE.test(frame)) {
    throw new UsageError(`--frame "${frame}": use ${Object.keys(FRAME_STYLE_LAYOUTS).join(', ')} or a layout component id (namespace/name)`);
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
    if (p.stage === 'rendering' && p.totalFrames) detail = `frame ${p.renderedFrames ?? 0}/${p.totalFrames}${p.eta_s !== undefined ? ` · ${p.eta_s} s left` : ''}`;
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

function summary(ui: Ui, r: RenderRecord): void {
  const c = ui.c;
  ui.ok(`rendered ${c.bold(r.id)} → ${ui.path(r.file)}`);
  const probe = r.probe ? ` · checked: ${r.probe.duration_s.toFixed(2)} s, ${r.probe.width}×${r.probe.height}, ${r.probe.audio_streams} audio track${r.probe.audio_streams === 1 ? '' : 's'}` : '';
  ui.line(`  ${r.duration_s.toFixed(2)} s · ${r.frames} frames @ ${r.fps} fps · ${r.width}×${r.height} · ${formatBytes(r.size_bytes)} · h264 crf ${r.encoding.crf}, ${r.encoding.audio} audio${probe}`);
  ui.line(
    c.dim(
      `  theme ${r.template} · run ${r.run_id} · bundle ${r.bundle.cached ? 'cached' : `built in ${formatMs(r.bundle.ms)}`} · render ${formatMs(r.timings.render_ms)} (concurrency ${r.concurrency}) · total ${formatMs(r.timings.total_ms)}`,
    ),
  );
  ui.line(c.dim(`  record ${ui.path(r.record)}`));
  for (const w of r.warnings) ui.warn(w);
}

/**
 * `studio render <project> <scenario>`: plan and render the latest capture of a scenario (or `--run`) into
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
  const printer = opts.json ? null : new RenderProgressPrinter(ui);
  const { signal, dispose } = abortOnSigint(ui);
  try {
    const record = await renderVideo({
      project,
      root: ws.root,
      run: opts.run ?? 'latest',
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
        review = await runReview(ui, { project, root: ws.root, render: record.record, quiet: opts.json });
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
    if (e instanceof RenderCancelledError) throw new CliError('render cancelled: nothing was written');
    if (e instanceof RenderError) throw new CliError(e.message);
    throw e;
  } finally {
    dispose();
  }
}

/** `studio still <project> <scenario> --frame <n>`: one output frame of the planned video as a PNG. */
export async function stillCommand(ui: Ui, global: GlobalOptions, projectArg: string, scenario: string, opts: StillCommandOptions): Promise<ExitCode> {
  if (opts.frame === undefined || !/^\d+$/.test(opts.frame)) throw new UsageError('--frame <n>: the output frame number (0-based) is required');
  const frame = Number(opts.frame);
  checkFrameSpec(opts.layout);
  const variant = variantOption(opts);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  let run;
  try {
    run = findRun(project, opts.run ?? 'latest', scenario);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const timeline = await readJson<Timeline>(join(run.dir, 'timeline.json'));
  if (timeline.scenario !== scenario) throw new CliError(`run ${run.id} is a run of scenario "${timeline.scenario}", not "${scenario}"`);
  if (timeline.mode === 'dry') throw new CliError(`run ${run.id} is a dry run: there is no capture to render`);
  const template = await loadProjectTemplate(project, opts.theme ?? timeline.video?.template ?? project.config.template);
  const registry = await loadComponentRegistry({ root: ws.root });
  const overrides: EditOverrides = {};
  if (opts.theme) overrides.theme = template.name;
  if (variant) overrides.variant = variant;
  if (opts.layout) overrides.frame = opts.layout;
  const plan = planEdit({
    timeline,
    template,
    project,
    registry,
    captureFile: join(run.dir, timeline.capture.file || 'capture.mp4'),
    scenario: await runScenario(run.dir),
    overrides,
  });
  if (frame >= plan.durationInFrames) throw new CliError(`--frame ${frame} is past the end of the video (${plan.durationInFrames} frames, 0–${plan.durationInFrames - 1})`);
  const out = opts.out
    ? resolve(opts.out)
    : join(project.dir, 'renders', 'stills', `${scenario}${VARIANT_SUFFIX[plan.variant]}-f${String(frame).padStart(5, '0')}.png`);
  const t0 = performance.now();
  ui.setStatus(ui.c.dim(`  … rendering frame ${frame} of ${scenario}`));
  try {
    await renderStill({ plan, frame, out, root: ws.root, registry });
  } catch (e) {
    if (e instanceof RenderError) throw new CliError(e.message);
    throw e;
  } finally {
    ui.clearStatus();
  }
  const segment = plan.segments.filter((s) => s.from <= frame).pop();
  if (opts.json) {
    ui.result(JSON.stringify({ file: out, frame, time_s: frame / plan.fps, segment: segment?.id, run_id: run.id, width: plan.width, height: plan.height }, null, 2));
  } else {
    ui.ok(`frame ${frame} (${(frame / plan.fps).toFixed(2)} s, ${segment ? `${segment.kind} ${segment.id}` : '—'}) → ${ui.path(out)} ${ui.c.dim(formatMs(performance.now() - t0))}`);
  }
  return EXIT.ok;
}
