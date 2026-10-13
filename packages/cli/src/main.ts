import { Argument, Command, CommanderError, Option } from 'commander';
import { COMPONENT_KINDS } from '@demo-studio/core';
import type { JsonSchemaName } from '@demo-studio/core';
import { componentsCreateCommand, componentsListCommand, componentsPreviewCommand, componentsValidateCommand } from './commands/components.js';
import type { ComponentsCreateOptions, ComponentsListOptions, ComponentsPreviewOptions, ComponentsValidateOptions } from './commands/components.js';
import { doctorCommand } from './commands/doctor.js';
import type { DoctorOptions } from './commands/doctor.js';
import { envResetCommand, hooksRollbackCommand, hooksRunCommand } from './commands/hooks.js';
import type { HookCommandOptions } from './commands/hooks.js';
import { LATER_COMMANDS, SCHEMA_NAMES, laterCommand, schemaCommand } from './commands/misc.js';
import { authStatusCommand, loginCommand } from './commands/auth.js';
import type { AuthStatusOptions, LoginOptions } from './commands/auth.js';
import { exportCommand } from './commands/export.js';
import { exportCaptureCommand } from './commands/export-capture.js';
import type { ExportCaptureCommandOptions } from './commands/export-capture.js';
import type { ExportCommandOptions } from './commands/export.js';
import { planCommand } from './commands/plan.js';
import type { PlanCommandOptions } from './commands/plan.js';
import { listCommand, newCommand } from './commands/project.js';
import { renderCommand, stillCommand } from './commands/render.js';
import { reviewCommand } from './commands/review.js';
import type { ReviewCommandOptions } from './commands/review.js';
import type { RenderCommandOptions, StillCommandOptions } from './commands/render.js';
import type { NewOptions } from './commands/project.js';
import { runCommand } from './commands/run.js';
import type { RunCommandOptions } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import type { ValidateOptions } from './commands/validate.js';
import { EXIT, errorMessage, exitCodeOf, isKnownError } from './errors.js';
import type { ExitCode } from './errors.js';
import { processIo } from './io.js';
import type { Io } from './io.js';
import { Ui } from './ui.js';
import type { GlobalOptions } from './workspace.js';

export const VERSION = '0.1.0';

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Build the `studio` program. Actions store their exit code through `setExit`. */
function buildProgram(io: Io, setExit: (code: ExitCode) => void): Command {
  const program = new Command('studio');
  let ui: Ui | null = null;
  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const getUi = (): Ui => {
    if (!ui) {
      const g = globals();
      ui = new Ui({ ...io, color: io.color && g.color !== false }, g.verbose === true);
    }
    return ui;
  };
  const action =
    <A extends unknown[]>(fn: (ui: Ui, g: GlobalOptions, ...args: A) => Promise<ExitCode> | ExitCode) =>
    async (...args: A) => {
      setExit(await fn(getUi(), globals(), ...args));
    };

  program
    .description('Demo Studio: precise YAML scenarios → product videos captured from a real web app')
    .version(VERSION, '-V, --version')
    .option('-C, --root <dir>', 'workspace root (default: $DEMO_STUDIO_ROOT, else the nearest folder with studio.yaml)')
    .option('-v, --verbose', 'show debug and info messages')
    .option('--no-color', 'disable colours')
    .showSuggestionAfterError(true)
    .showHelpAfterError('(add --help for usage)')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s),
      writeErr: (s) => io.err(s),
      outputError: (s, write) => write(s),
    });

  program
    .command('new')
    .description('create a project (README.md, project.yaml, scenarios/, hooks/, assets/); on a terminal without --env it asks for environments and personas, and offers to sign each one in')
    .argument('<slug>', 'project folder name: lower-case letters, digits and "-"')
    .option('--name <name>', 'display name (default: the slug)')
    .option('--template <name>', 'template name or ./path (default: default)')
    .option('--env <name=key:url,...>', 'environment pages, e.g. staging=app:https://app.staging.example.com (repeatable)', collect)
    .action(action((u, g, slug: string, o: NewOptions) => newCommand(u, g, slug, o)));

  program
    .command('list')
    .description('list the projects (with their scenarios) and templates of the workspace')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: { json?: boolean }) => listCommand(u, g, o)));

  program
    .command('validate')
    .description('validate project.yaml, its template and a scenario (every scenario when omitted)')
    .argument('<project>', 'project slug or directory')
    .argument('[scenario]', 'scenario name or YAML file')
    .option('--env <name>', 'environment to check page keys against')
    .option('--until <ref>', 'check that this step reference resolves')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, s: string | undefined, o: ValidateOptions) => validateCommand(u, g, p, s, o)));

  program
    .command('run')
    .description('run a scenario headless: capture.mp4 + timeline.json (or a dry run with screenshots)')
    .argument('<project>', 'project slug or directory')
    .argument('<scenario>', 'scenario name or YAML file')
    .option('--dry', 'dry run: no recording, a screenshot per step, irreversible steps not executed')
    .option('--until <ref>', 'stop after this step (<scene>.<step id|index>, a step id, or a scene id)')
    .addOption(new Option('--hooks <mode>', 'setup/teardown hooks (default: run for captures, skip for dry runs)').choices(['run', 'skip']))
    .option('--env <name>', 'environment (default: scenario env, project default_env, first one)')
    .option('--headed', 'show the browser window (needs a display)')
    .option('--allow-writes', 'let a run on a production environment write (only where project.yaml sets access: read-write; without it such a run is read-only)')
    .option('--json', 'stream progress events as JSON lines on stdout')
    .option('--raw', 'then export the raw package for editors (as studio export-capture: clips per scene, cursor data, markers)')
    .addOption(new Option('--cursor <mode>', 'with --raw: baked (as captured), none (captured without the cursor; data only) or layer (captured without it + a transparent cursor layer per clip)').choices(['baked', 'none', 'layer']))
    .addOption(new Option('--format <format>', 'with --raw: mp4 (H.264 high, CRF 14) or prores (ProRes 422 HQ)').choices(['mp4', 'prores']))
    .addOption(new Option('--fps <n>', 'with --raw: 30 or 60 fps').choices(['30', '60']))
    .addOption(new Option('--layer <format>', 'with --raw --cursor layer: prores (ProRes 4444) or webm (VP9 alpha)').choices(['prores', 'webm']))
    .option('--selects', 'with --raw: also one continuous selects file of the clips')
    .option('--no-cuts', 'with --raw: keep the loading inside scenes')
    .option('--out <dir>', 'with --raw: package folder (default exports/<run>-raw-<format><fps>-<cursor>/)')
    .action(action((u, g, p: string, s: string, o: RunCommandOptions) => runCommand(u, g, p, s, o)));

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
    .action(action((u, g, p: string, r: string, o: ExportCaptureCommandOptions) => exportCaptureCommand(u, g, p, r, o)));

  program
    .command('plan')
    .description('plan the edit of a capture (segments, components, speeds, trims, zooms, captions) without rendering')
    .argument('<project>', 'project slug or directory')
    .argument('<run>', 'run id (folder under runs/), run directory, or "latest"')
    .option('--scenario <name>', 'with "latest": the latest run of this scenario')
    .option('--theme <name>', 'plan with another theme (template name or ./path) instead of the one the run used')
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
    .option('--theme <name>', 'render with another theme (template name or ./path) instead of the one the run used')
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
    .option('--concurrency <n>', 'frames rendered in parallel (default: 3/4 of the CPUs, at most 8)')
    .option('--json', 'print the render record (without the plan) as JSON')
    .option('--review', 'review the render right after it (studio review: sheets, key frames, report)')
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
    .action(action((u, g, p: string, r: string, o: ExportCommandOptions) => exportCommand(u, g, p, r, o)));

  program
    .command('still')
    .description('render one frame of the planned video as a PNG (renders/stills/)')
    .argument('<project>', 'project slug or directory')
    .argument('<scenario>', 'scenario name')
    .requiredOption('--frame <n>', 'output frame number (0-based)')
    .option('--run <id>', 'run id, run directory or "latest" (default: the latest capture of the scenario)')
    .option('--layout <frame>', 'frame of every scene (as `studio render --frame`): card, browser, laptop, phone, tablet, raw, split or pip (multi-page scenes) or a layout id')
    .option('--theme <name>', 'plan with another theme (template name or ./path)')
    .option('--vertical', 'a frame of the vertical 9:16 variant')
    .option('--square', 'a frame of the square 1:1 variant')
    .option('--out <file>', 'PNG file to write')
    .option('--json', 'print the result as JSON')
    .action(action((u, g, p: string, s: string, o: StillCommandOptions) => stillCommand(u, g, p, s, o)));

  const hooks = program.command('hooks').description('run hooks or replay rollbacks outside a capture');
  hooks
    .command('run')
    .description('run <scenario>:setup, <scenario>:teardown, reset (project.yaml) or a YAML file listing hooks')
    .argument('<project>', 'project slug or directory')
    .argument('<source>', '<scenario>:setup | <scenario>:teardown | reset | hooks/<file>.yaml')
    .option('--env <name>', 'environment')
    .option('--yes', 'approve destructive hooks that lack "confirm: true"')
    .option('--allow-writes', 'let hooks write to a production environment (only where project.yaml sets access: read-write)')
    .option('--dry', 'template and security-check the hooks without executing them')
    .action(action((u, g, p: string, s: string, o: HookCommandOptions) => hooksRunCommand(u, g, p, s, o)));
  hooks
    .command('rollback')
    .description('replay the pending rollbacks of a run (or of every run)')
    .argument('<project>', 'project slug or directory')
    .argument('[id]', 'run id (folder under runs/) or hooks journal id (.demo-studio/journals/<id>.json)')
    .option('--env <name>', 'environment')
    .option('--allow-writes', 'replay rollbacks of a production environment (only where project.yaml sets access: read-write)')
    .option('--dry', 'describe the rollbacks without executing them')
    .action(action((u, g, p: string, r: string | undefined, o: HookCommandOptions) => hooksRollbackCommand(u, g, p, r, o)));

  const env = program.command('env').description('environment maintenance');
  env
    .command('reset')
    .description('replay pending rollback journals, then run the project `reset` hooks')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', 'environment')
    .option('--yes', 'approve destructive hooks that lack "confirm: true"')
    .option('--allow-writes', 'write to a production environment (only where project.yaml sets access: read-write)')
    .option('--dry', 'describe without executing')
    .action(action((u, g, p: string, o: HookCommandOptions) => envResetCommand(u, g, p, o)));

  const components = program.command('components').description('list, validate, scaffold and preview components (intros, layouts, captions…)');
  components
    .command('list')
    .description('components of the workspace (components/) and the built-in library')
    .addOption(new Option('--kind <kind>', 'only this kind').choices([...COMPONENT_KINDS]))
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: ComponentsListOptions) => componentsListCommand(u, g, o)));
  components
    .command('validate')
    .description('check a component: manifest, params schema, preview samples, entry compile and imports (every workspace component when omitted)')
    .argument('[component]', 'component id (namespace/name) or folder')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string | undefined, o: ComponentsValidateOptions) => componentsValidateCommand(u, g, id, o)));
  components
    .command('create')
    .alias('new')
    .description('scaffold a workspace component (components/<namespace>/<name>/) from the template of its kind (alias: new)')
    .argument('<id>', 'component id "namespace/name" (lower-case letters, digits and "-")')
    .addOption(new Option('--kind <kind>', 'what it renders').choices([...COMPONENT_KINDS]).makeOptionMandatory())
    .option('--description <text>', 'one or two sentences: what it looks like and when to use it')
    .option('--name <name>', 'display name (default: from the id)')
    .option('--theme <name>', 'theme of the generated preview (default editorial)')
    .option('--no-preview', 'do not render preview.png')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string, o: ComponentsCreateOptions) => componentsCreateCommand(u, g, id, o)));
  components
    .command('preview')
    .description('render preview.png (960×540) + preview.json + the README block of a component, or of every component with --all')
    .argument('[component]', 'component id (namespace/name) or folder')
    .option('--all', 'every component: workspace, built-in library and the per-kind scaffolds')
    .option('--workspace', 'with --all: only the workspace components')
    .option('--stale', 'only previews that are missing or out of date')
    .option('--theme <name>', 'theme of the previews (template name or path; default editorial)')
    .option('--out <dir>', 'write only the images to <dir>/<namespace>/<name>.png (component folders untouched)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string | undefined, o: ComponentsPreviewOptions) => componentsPreviewCommand(u, g, id, o)));

  program
    .command('doctor')
    .description('check this machine for Demo Studio: Node, Chromium, ffmpeg, display, keychain, notifications, workspace, template fonts')
    .option('--project <slug>', "also check a project: its personas' sessions (never signed in, expired, in use, inside a git work tree) and its environments' hosts (HEAD, 5 s timeout)")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: DoctorOptions) => doctorCommand(u, g, o)));

  program
    .command('schema')
    .description('print a JSON Schema (for editor autocompletion and agents)')
    .addArgument(new Argument('[name]', 'which schema').choices(SCHEMA_NAMES).default('scenario'))
    .action(action((u, _g, name: JsonSchemaName) => schemaCommand(u, name)));

  program
    .command('login')
    .description("sign a persona in and save its session (a browser window; --auto: its login steps, headless)")
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', 'environment (default: the project default)')
    .option('--persona <name>', 'persona to sign in (needed when the environment has several)')
    .option('--auto', "sign in with the persona's login steps, headless (no window: CI, tests, a quick refresh)")
    .option('--page <key>', 'environment page the window opens (default: the persona check page)')
    .option('--url <url>', 'explicit URL the window opens')
    .action(action((u, g, p: string, o: LoginOptions) => loginCommand(u, g, p, o)));

  const auth = program.command('auth').description('signed-in sessions of personas');
  auth
    .command('status')
    .description('every persona: valid, expired or never signed in, and when it was last checked (--check: check now)')
    .option('--project <slug>', 'only this project')
    .option('--env <name>', 'with --project: only this environment')
    .option('--check', 'check each saved session now (headless, without signing in) and save the result; exit 1 when one is not valid')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: AuthStatusOptions) => authStatusCommand(u, g, o)));

  for (const later of LATER_COMMANDS) {
    program
      .command(later.name)
      .description(`(phase ${later.phase}) ${later.summary}`)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument('[args...]')
      .action(action((u) => laterCommand(u, later.name, later.phase)));
  }

  return program;
}

/**
 * Run the CLI with `argv` (process.argv form: the first two entries are ignored). Never throws:
 * returns the exit code (0 ok, 1 failure, 2 usage error).
 */
export async function main(argv: readonly string[] = process.argv, io: Io = processIo()): Promise<ExitCode> {
  let code: ExitCode = EXIT.ok;
  const program = buildProgram(io, (c) => (code = c));
  try {
    await program.parseAsync([...argv]);
    return code;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return EXIT.ok;
      return EXIT.usage;
    }
    const ui = new Ui(io, program.opts<GlobalOptions>().verbose === true);
    ui.clearStatus();
    if (isKnownError(e)) {
      ui.error(errorMessage(e));
    } else {
      ui.error(`unexpected error: ${errorMessage(e)}`);
      if (e instanceof Error && e.stack) ui.line(ui.c.dim(e.stack));
    }
    return exitCodeOf(e);
  }
}
