import { Option } from 'commander';
import { exportCommand } from '../commands/export.js';
import type { ExportCommandOptions } from '../commands/export.js';
import { planCommand } from '../commands/plan.js';
import type { PlanCommandOptions } from '../commands/plan.js';
import { renderCommand, stillCommand } from '../commands/render.js';
import { reviewCommand } from '../commands/review.js';
import type { ReviewCommandOptions } from '../commands/review.js';
import type { RenderCommandOptions, StillCommandOptions } from '../commands/render.js';
import { NO_WAIT } from './context.js';
import type { ProgramContext } from './context.js';

/** From a capture to the finished video: plan, render, review, export, still. */
export function registerEditCommands({ program, action }: ProgramContext): void {
  program
    .command('plan')
    .description('plan the edit of a capture (segments, components, speeds, trims, zooms, captions) without rendering')
    .argument('<project>', 'project slug or directory')
    .argument('<run>', 'run id (folder under runs/), run directory, or "latest"')
    .option('--scenario <name>', 'with "latest": the latest run of this scenario')
    .option('--theme <name>', 'plan with another theme (a theme name or ./path) instead of the one the run used')
    .option('--frame <frame>', 'frame of every scene: card, browser, laptop, phone, tablet, raw, split or pip (multi-page scenes) or a layout component id')
    .option('--vertical', 'the vertical 9:16 variant (1080×1920, reframed on the cursor and the targets)')
    .option('--square', 'the square 1:1 variant (1080×1080, reframed on the cursor and the targets)')
    .option('--json', 'print the plan as JSON')
    .option('--out <file>', 'write the plan JSON to a file')
    .action(action((u, g, p: string, r: string, o: PlanCommandOptions) => planCommand(u, g, p, r, o)));

  program
    .command('render')
    .description('render a capture into a finished video: renders/<scenario>-v<N>.mp4 + .json (theme, components, captions)')
    .argument('<project>', 'project slug or directory')
    .argument('<scenario>', 'scenario name')
    .option('--run <id>', 'run id, run directory or "latest" (default: the latest capture of the scenario)')
    .option('--theme <name>', 'render with another theme (a theme name or ./path) instead of the one the run used')
    .option('--frame <frame>', 'frame of every scene: card, browser, laptop, phone, tablet, raw, split or pip (multi-page scenes) or a layout component id')
    .option('--vertical', 'the vertical 9:16 variant (1080×1920, reframed on the cursor and the targets), written as <scenario>-v<N>-vertical.mp4')
    .option('--square', 'the square 1:1 variant (1080×1080, reframed), written as <scenario>-v<N>-square.mp4')
    .option('--music <file>', 'music bed (an audio file: path from here, else relative to the project) instead of the scenario\'s')
    .option('--no-music', 'leave the scenario\'s music bed out')
    .option('--tutorial', 'turn every tutorial overlay on (key caps, spotlight, step badges, loupe, progress bar) over the scenario\'s switches')
    .option('--no-tutorial', 'leave the tutorial overlays out')
    .option('--scale <n>', 'output size multiplier of 1920×1080 (default: the capture scale)')
    .option('--no-intro', 'leave the intro out')
    .option('--no-outro', 'leave the outro out')
    .option('--out <file>', 'write the video (and its .json record) here instead of renders/')
    .option('--concurrency <n>', 'frames rendered in parallel, 1-16 (default: retake.yaml render.concurrency, $RETAKE_RENDER_CONCURRENCY, else 3 on the GPU path, 3/4 of the CPUs in software)')
    .option('--json', 'print the render record (without the plan) as JSON')
    .option('--review', 'review the render right after it (retake review: sheets, key frames, report)')
    .option('--no-wait', NO_WAIT)
    .action(action((u, g, p: string, s: string, o: RenderCommandOptions) => renderCommand(u, g, p, s, o)));

  program
    .command('review')
    .description('review a render: contact sheets, per-scene sheets, key frames, timeline and report in review/<render>/')
    .argument('<project>', 'project slug or directory')
    .argument('<render>', 'render id (e.g. catalogue-v3), a renders/<id>.json or .mp4 path, or "latest"')
    .addOption(new Option('--fps <n>', 'contact sheet frames per second').choices(['1', '2']))
    .option('--previous <id>', 'compare with this render (default: the previous render of the same scenario)')
    .option('--no-previous', 'do not compare with a previous render')
    .option('--scenario <name>', 'with "latest": the latest render of this scenario')
    .option('--strict', 'exit with 1 when the review is not clean (errors or warnings)')
    .option('--json', 'print the review result (report.json) as JSON')
    .option('--no-wait', NO_WAIT)
    .action(action((u, g, p: string, r: string, o: ReviewCommandOptions) => reviewCommand(u, g, p, r, o)));

  program
    .command('export')
    .description('export a render: mp4_1080p, mp4_4k, webm, vertical_9x16, square_1x1, gif_preview → exports/<render>/ + manifest.json')
    .argument('<project>', 'project slug or directory')
    .argument('<render>', 'render id (e.g. quote-v6), a renders/<id>.json or .mp4 path, or "latest"')
    .option('--formats <list>', 'comma-separated formats, or "all" (default: mp4_1080p,webm,gif_preview)')
    .option('--scenario <name>', 'with "latest": the latest render of this scenario')
    .option('--out <dir>', 'output folder (default: exports/<render-id>/)')
    .option('--gif-start <s>', 'start of the GIF preview, seconds (default: around the first marker, else the start)')
    .option('--concurrency <n>', 'frames rendered in parallel by re-rendered formats')
    .option('--json', 'print the export manifest as JSON')
    .option('--no-wait', NO_WAIT)
    .action(action((u, g, p: string, r: string, o: ExportCommandOptions) => exportCommand(u, g, p, r, o)));

  program
    .command('still')
    .description('render one frame of the planned video as a PNG (renders/stills/)')
    .argument('<project>', 'project slug or directory')
    .argument('<scenario>', 'scenario name')
    .requiredOption('--frame <n>', 'output frame number (0-based)')
    .option('--run <id>', 'run id, run directory or "latest" (default: the latest capture of the scenario)')
    .option('--layout <frame>', 'frame of every scene (as `retake render --frame`): card, browser, laptop, phone, tablet, raw, split or pip (multi-page scenes) or a layout id')
    .option('--theme <name>', 'plan with another theme (a theme name or ./path)')
    .option('--vertical', 'a frame of the vertical 9:16 variant')
    .option('--square', 'a frame of the square 1:1 variant')
    .option('--out <file>', 'PNG file to write')
    .option('--json', 'print the result as JSON')
    .option('--no-wait', NO_WAIT)
    .action(action((u, g, p: string, s: string, o: StillCommandOptions) => stillCommand(u, g, p, s, o)));
}
