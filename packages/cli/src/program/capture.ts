import { Option } from 'commander';
import { exportCaptureCommand } from '../commands/export-capture.js';
import type { ExportCaptureCommandOptions } from '../commands/export-capture.js';
import { runCommand } from '../commands/run.js';
import type { RunCommandOptions } from '../commands/run.js';
import { inspectCommand } from '../commands/inspect.js';
import { recordCommand } from '../commands/record.js';
import type { RecordCommandOptions } from '../commands/record.js';
import type { InspectCommandOptions } from '../commands/inspect.js';
import { NO_WAIT, collect } from './context.js';
import type { ProgramContext } from './context.js';

/** Filming and reading the product: run, record, inspect, export-capture. */
export function registerCaptureCommands({ program, action }: ProgramContext): void {
  program
    .command('run')
    .description('run a scenario headless: capture.mp4 + timeline.json (or a dry run with screenshots)')
    .argument('<project>', 'project slug or directory')
    .argument('<scenario>', 'scenario name or YAML file')
    .option('--dry', 'dry run: no video, a screenshot per step, irreversible steps not executed')
    .option('--until <ref>', 'stop after this step (<scene>.<step id|index>, a step id, or a scene id)')
    .addOption(new Option('--hooks <mode>', 'setup/teardown hooks (default: run for captures, skip for dry runs)').choices(['run', 'skip']))
    .option('--env <name>', 'environment (default: scenario env, project default_env, first one)')
    .option('--headed', 'show the browser window (needs a display)')
    .option('--allow-writes', 'let a run on a production environment write (only where project.yaml sets access: read-write; without it such a run is read-only)')
    .option('--yes', 'run the shell hooks of a scenario an agent wrote last without asking (they are listed; otherwise a terminal asks, and without one the run is refused)')
    .option('--sandbox', 'reset the sandbox to its seed before the take: up if needed, health, reset (environment: --env, the scenario env or default_env when a sandbox, else the first sandbox); it stays up after')
    .option('--json', 'stream progress events as JSON lines on stdout')
    .option('--raw', 'then export the raw package for editors (as retake export-capture: clips per scene, cursor data, markers)')
    .addOption(new Option('--cursor <mode>', 'with --raw: baked (as captured), none (captured without the cursor; data only) or layer (captured without it + a transparent cursor layer per clip)').choices(['baked', 'none', 'layer']))
    .addOption(new Option('--format <format>', 'with --raw: mp4 (H.264 high, CRF 14) or prores (ProRes 422 HQ)').choices(['mp4', 'prores']))
    .addOption(new Option('--fps <n>', 'with --raw: 30 or 60 fps').choices(['30', '60']))
    .addOption(new Option('--layer <format>', 'with --raw --cursor layer: prores (ProRes 4444) or webm (VP9 alpha)').choices(['prores', 'webm']))
    .option('--selects', 'with --raw: also one continuous selects file of the clips')
    .option('--no-cuts', 'with --raw: keep the loading inside scenes')
    .option('--out <dir>', 'with --raw: package folder (default exports/<run>-raw-<format><fps>-<cursor>/)')
    .option('--no-wait', 'with --raw: export at once even while another take films (default: wait for it, then yield to later takes)')
    .action(action((u, g, p: string, s: string, o: RunCommandOptions) => runCommand(u, g, p, s, o)));

  program
    .command('record')
    .description('open a browser window, perform a flow by hand, get a draft scenario (saved when the name is free) checked by a dry replay — nothing is filmed')
    .argument('<project>', 'project slug or directory')
    .argument('[name]', 'scenario name (default recorded-YYYYMMDD-HHMM); an existing one is never overwritten')
    .option('--env <name>', 'environment (default: default_env, else the first one)')
    .option('--persona <name>', 'the persona the window is signed in as, or none (default: the persona whose pages list the page)')
    .option('--page <key>', 'environment page the window opens (default: the persona\'s first page, else the first page)')
    .option('--path <path>', 'path under the page (default /)')
    .option('--url <url>', 'instead of --page / --path: a URL on one of the environment\'s origins')
    .option('--allow-writes', 'let the window write on a production environment (only where project.yaml sets access: read-write), as retake run')
    .option('--no-check', 'skip the check replay of the draft')
    .option('--json', 'print the outcome as JSON on stdout')
    .action(action((u, g, p: string, n: string | undefined, o: RecordCommandOptions) => recordCommand(u, g, p, n, o)));

  program
    .command('inspect')
    .description('replay a page or a scenario (dry, hooks skipped) and list the visible interactive elements with a target the runner resolves to each, plus a marked screenshot (what page_inspect gives Claude)')
    .argument('<project>', 'project slug or directory')
    .argument('<page>', 'an environment page key, a URL of one of its pages, or a scenario name (with --until)')
    .option('--env <name>', 'environment (default: scenario env, project default_env, first one)')
    .option('--path <path>', 'with a page: the path opened under it (default /)')
    .option('--until <ref>', 'with a scenario: inspect after this step (<scene>.<step id|index>, a step id, or a scene id)')
    .option('--persona <name>', 'with a page: sign it in as this persona ("none": signed out)')
    .option('--within <target>', 'list only the elements inside this target (YAML: "{role: dialog}", or text / CSS)')
    .option('--target <target>', 'check a target: matches and the one a step would use (repeatable, ≤ 20)', collect)
    .option('--limit <n>', 'elements listed (default 80, at most 300)')
    .addOption(new Option('--images <mode>', 'marked (default): also draw marked.jpg; none: the plain screenshot only').choices(['marked', 'none']))
    .option('--json', 'print the report (inspect.json) on stdout')
    .option('--out <dir>', 'folder for the inspection folder (default <project>/.retake/inspect/)')
    .action(action((u, g, p: string, w: string, o: InspectCommandOptions) => inspectCommand(u, g, p, w, o)));

  program
    .command('export-capture')
    .description('export a run raw for another editing tool: a clip per scene (loads cut), MP4 or ProRes, 30/60 fps, cursor baked/none/layer, FCPXML/EDL/OTIO/CSV markers, manifest')
    .argument('<project>', 'project slug or directory')
    .argument('<run>', 'run id (folder under runs/), run directory, or "latest"')
    .option('--scenario <name>', 'with "latest": the latest run of this scenario')
    .addOption(new Option('--format <format>', 'mp4 (H.264 high profile, CRF 14, yuv420p) or prores (ProRes 422 HQ .mov); default mp4 or project raw.format').choices(['mp4', 'prores']))
    .addOption(new Option('--fps <n>', '30 or 60 (real frame timing, never interpolated); default 30').choices(['30', '60']))
    .addOption(new Option('--cursor <mode>', 'baked (as captured), none (run captured with run --raw --cursor none) or layer (a transparent cursor video per clip); default: as captured').choices(['baked', 'none', 'layer']))
    .addOption(new Option('--layer <format>', 'cursor layer codec: prores (ProRes 4444) or webm (VP9 alpha); default prores').choices(['prores', 'webm']))
    .option('--selects', 'also one continuous selects file of the clips')
    .option('--no-cuts', 'keep the loading inside scenes (page loads before a scene are never in a clip)')
    .option('--out <dir>', 'package folder (default exports/<run>-raw-<format><fps>-<cursor>/)')
    .option('--json', 'print the package manifest as JSON')
    .option('--no-wait', NO_WAIT)
    .action(action((u, g, p: string, r: string, o: ExportCaptureCommandOptions) => exportCaptureCommand(u, g, p, r, o)));
}
