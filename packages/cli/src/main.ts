import { Argument, Command, CommanderError, Option } from 'commander';
import { COMPONENT_KINDS, DEMO_STUDIO_VERSION } from '@demo-studio/core';
import type { JsonSchemaName } from '@demo-studio/core';
import { commentAddCommand, commentListCommand, commentReopenCommand, commentReplyCommand, commentResolveCommand } from './commands/comment.js';
import type { CommentAddOptions, CommentListOptions, CommentWriteOptions } from './commands/comment.js';
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
import { mcpCommand } from './commands/mcp.js';
import { jobsCancelCommand, jobsListCommand, jobsStatusCommand } from './commands/jobs.js';
import { pruneCommand } from './commands/prune.js';
import type { PruneOptions } from './commands/prune.js';
import type { JobsListOptions, JobsStatusOptions } from './commands/jobs.js';
import { workerCommand } from './commands/worker.js';
import type { WorkerCommandOptions } from './commands/worker.js';
import type { McpCommandOptions } from './commands/mcp.js';
import { uiCommand } from './commands/ui.js';
import type { UiCommandOptions } from './commands/ui.js';
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
import { sandboxDownCommand, sandboxInitCommand, sandboxLogsCommand, sandboxResetCommand, sandboxStatusCommand, sandboxUpCommand } from './commands/sandbox.js';
import type { SandboxCommandOptions } from './commands/sandbox.js';
import { inspectCommand } from './commands/inspect.js';
import { recordCommand } from './commands/record.js';
import type { RecordCommandOptions } from './commands/record.js';
import type { InspectCommandOptions } from './commands/inspect.js';
import { themeCreateCommand, themeFromSiteCommand } from './commands/theme.js';
import type { ThemeCreateOptions } from './commands/theme.js';
import { validateCommand } from './commands/validate.js';
import type { ValidateOptions } from './commands/validate.js';
import { EXIT, errorMessage, exitCodeOf, isKnownError } from './errors.js';
import type { ExitCode } from './errors.js';
import { processIo } from './io.js';
import type { Io } from './io.js';
import { Ui } from './ui.js';
import type { GlobalOptions } from './workspace.js';

export const VERSION = DEMO_STUDIO_VERSION;

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
    .option('--sandbox', 'reset the sandbox to its seed before the take: up if needed, health, reset (environment: --env, the scenario env or default_env when a sandbox, else the first sandbox); it stays up after')
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
    .command('record')
    .description('open a browser window, perform a flow by hand, get a draft scenario (saved when the name is free) checked by a dry replay — nothing is filmed')
    .argument('<project>', 'project slug or directory')
    .argument('[name]', 'scenario name (default recorded-YYYYMMDD-HHMM); an existing one is never overwritten')
    .option('--env <name>', 'environment (default: default_env, else the first one)')
    .option('--persona <name>', 'the persona the window is signed in as, or none (default: the persona whose pages list the page)')
    .option('--page <key>', 'environment page the window opens (default: the persona\'s first page, else the first page)')
    .option('--path <path>', 'path under the page (default /)')
    .option('--url <url>', 'instead of --page / --path: a URL on one of the environment\'s origins')
    .option('--allow-writes', 'let the window write on a production environment (only where project.yaml sets access: read-write), as studio run')
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
    .option('--out <dir>', 'folder for the inspection folder (default <project>/.demo-studio/inspect/)')
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

  const sandbox = program.command('sandbox').description('start, seed, reset and stop the sandboxes of a project (sandbox.yaml: a disposable, local copy of the product)');
  const sandboxEnvHelp = 'sandbox environment (default: the first of project.yaml sandboxes)';
  sandbox
    .command('init')
    .description('write a docker-compose sandbox (app placeholder, Postgres, Mailpit, seed, README) and declare it in project.yaml')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', 'its environment name (default: sandbox)')
    .option('--force', 'write the scaffold over an existing sandbox folder')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, o: SandboxCommandOptions) => sandboxInitCommand(u, g, p, o)));
  sandbox
    .command('up')
    .description('start what is not running, wait until healthy, and seed when never seeded, when the seed changed or when a service started')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', sandboxEnvHelp)
    .option('--no-seed', 'do not seed')
    .option('--build', 'docker-compose: build the images first (docker compose up --build)')
    .action(action((u, g, p: string, o: SandboxCommandOptions) => sandboxUpCommand(u, g, p, o)));
  sandbox
    .command('down')
    .description('stop every service of the sandbox (a process sandbox loses its data; a docker-compose one keeps its volumes)')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', sandboxEnvHelp)
    .option('--volumes', 'docker-compose: remove the volumes too (the database and its snapshot: the next up seeds again)')
    .action(action((u, g, p: string, o: SandboxCommandOptions) => sandboxDownCommand(u, g, p, o)));
  sandbox
    .command('reset')
    .description('back to the seed: the snapshot restored (strategy snapshot) or the seed steps again, the mailbox emptied (the sandbox must be up)')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', sandboxEnvHelp)
    .option('--reseed', 'run the seed even when a snapshot could be restored (and take the snapshot again)')
    .action(action((u, g, p: string, o: SandboxCommandOptions) => sandboxResetCommand(u, g, p, o)));
  sandbox
    .command('status')
    .description('services (pid or container, health), pages, seed, last reset, take lock; exit 0 when up and healthy, 1 otherwise')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', sandboxEnvHelp)
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, o: SandboxCommandOptions) => sandboxStatusCommand(u, g, p, o)));
  sandbox
    .command('logs')
    .description("the last lines of the services' logs (process: .demo-studio/sandbox/<env>/logs/; docker-compose: docker compose logs)")
    .argument('<project>', 'project slug or directory')
    .argument('[service]', 'only this service')
    .option('--env <name>', sandboxEnvHelp)
    .option('--lines <n>', 'lines per service (default 50)')
    .option('--follow', 'docker-compose: keep reading until Ctrl-C')
    .action(action((u, g, p: string, svc: string | undefined, o: SandboxCommandOptions) => sandboxLogsCommand(u, g, p, svc, o)));

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

  const theme = program.command('theme').description('themes (templates) from brand files or a site');
  theme
    .command('create')
    .description('a new workspace theme (templates/<name>/) from a logo, hex colours and fonts over a base theme: palette derived and contrast-checked, files checked and copied, LICENSES.md; never an existing theme (except --replace of an unchanged one Demo Studio made)')
    .argument('<name>', 'new theme name: lower-case letters, digits and "-", not a starter\'s or an existing folder\'s')
    .requiredOption('--accent <hex>', 'brand colour (#rrggbb): kicker, rules, clock hand, cursor ripple — never changed')
    .requiredOption('--logo <file>', 'logo: .svg, .png, .jpg or .webp')
    .option('--text <hex>', 'text colour (default derived)')
    .option('--paper <hex>', 'paper colour (default derived; a dark paper makes a dark theme)')
    .option('--muted <hex>', 'muted colour (default derived)')
    .option('--dark <hex>', 'night tone of dark cards and interstitials (default derived)')
    .option('--background <spec>', 'a hex (solid) or radial:<from>:<to> / linear:<from>:<to> (default derived)')
    .option('--base <theme>', 'theme whose components, frame, captions and motion are kept (default editorial)')
    .option('--wordmark <file>', 'wordmark image of the outro (default: the brand name as text)')
    .option('--display-font <file>', 'display font: .ttf, .otf, .woff or .woff2 (default the base theme\'s)')
    .option('--body-font <file>', 'body font file, one per weight (repeatable; default the base theme\'s)', collect)
    .option('--brand-name <name>', 'brand name (drawn when there is no wordmark)')
    .option('--brand-url <url>', 'brand URL shown in the outro, e.g. example.com')
    .option('--no-adjust', 'keep colours that miss a contrast threshold (warnings only)')
    .option('--replace', 'replace a theme Demo Studio made under that name (this command or template_create_from_brand), when nobody changed it since')
    .option('--json', 'machine-readable output')
    .action(action((u, g, n: string, o: ThemeCreateOptions) => themeCreateCommand(u, g, n, o)));
  theme
    .command('from-site')
    .description('open one public https page in a clean headless browser (no profile, GET only, public addresses only) and extract its colours by role, font family names, logo candidates (PNG) and a screenshot into .demo-studio/site/<id>/, with a draft for `studio theme create`')
    .argument('<url>', 'https://<site>/<path>: default port, no query or fragment')
    .option('--json', 'machine-readable output')
    .action(action((u, g, url: string, o: { json?: boolean }) => themeFromSiteCommand(u, g, url, o)));

  const comment = program.command('comment').description('frame comments on renders: a comment on one frame (optionally a region), replies, resolution with the render that answers it (comments/<scenario>/<id>.json; Claude reads and answers them through MCP)');
  comment
    .command('add')
    .description('comment on one frame of a render: the anchor (segment, scene, step, component) is computed from the render\'s plan and the still kept in .demo-studio/comments/')
    .argument('<project>', 'project slug or directory')
    .argument('<render>', 'render id (e.g. quote-v3), or "latest"')
    .argument('<text>', 'the comment (at most 2000 characters)')
    .option('--at <seconds>', 'the frame on screen at this time of the render (the printed duration: the last frame)')
    .option('--frame <n>', 'output frame number (0-based)')
    .option('--marker <name>', 'the frame of a marker (a `mark:` step): its done frame, else its start (a name on several steps: use --frame)')
    .option('--region <x,y,w,h>', 'the commented region, 0..1 of the frame (e.g. 0.67,0.42,0.12,0.08)')
    .option('--scenario <name>', 'with "latest": the latest render of this scenario')
    .option('--author <name>', 'your name (default $DEMO_STUDIO_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, r: string, t: string, o: CommentAddOptions) => commentAddCommand(u, g, p, r, t, o)));
  comment
    .command('list')
    .description('threads of a project: anchor, texts, entries, still')
    .argument('<project>', 'project slug or directory')
    .option('--scenario <name>', 'only the threads of this scenario')
    .option('--render <id>', 'only the threads made on this render (an id or "latest")')
    .addOption(new Option('--status <status>', 'open (default), resolved or all').choices(['open', 'resolved', 'all']))
    .option('--limit <n>', 'at most this many threads')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, o: CommentListOptions) => commentListCommand(u, g, p, o)));
  comment
    .command('reply')
    .description('reply on a thread')
    .argument('<project>', 'project slug or directory')
    .argument('<id>', 'thread id (c_…)')
    .argument('<text>', 'the reply (at most 2000 characters)')
    .option('--author <name>', 'your name (default $DEMO_STUDIO_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, id: string, t: string, o: CommentWriteOptions) => commentReplyCommand(u, g, p, id, t, o)));
  comment
    .command('resolve')
    .description('resolve an open thread, optionally with the later render that answers it')
    .argument('<project>', 'project slug or directory')
    .argument('<id>', 'thread id (c_…)')
    .option('--note <text>', 'what was changed (required)')
    .option('--render <id>', 'the render that answers it: a later render of the same scenario and variant (an id or "latest")')
    .option('--author <name>', 'your name (default $DEMO_STUDIO_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, id: string, o: CommentWriteOptions) => commentResolveCommand(u, g, p, id, o)));
  comment
    .command('reopen')
    .description('reopen a resolved thread (its resolution does not answer it)')
    .argument('<project>', 'project slug or directory')
    .argument('<id>', 'thread id (c_…)')
    .option('--note <text>', 'why')
    .option('--author <name>', 'your name (default $DEMO_STUDIO_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, id: string, o: CommentWriteOptions) => commentReopenCommand(u, g, p, id, o)));

  program
    .command('prune')
    .description("free disk space: list (and with --yes delete) failed takes, dry runs, older captures and renders nothing uses — the last good take of each scenario, the takes renders and comments use and the last renders of each scenario stay")
    .argument('<project>', 'project slug or directory')
    .option('--keep-renders <n>', 'renders kept per scenario and variant (default 3), with their reviews')
    .option('--yes', 'delete (default: only list what would go and how much it frees)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, o: PruneOptions) => pruneCommand(u, g, p, o)));

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

  program
    .command('mcp')
    .description('MCP server over stdio (or HTTP with --http) so a Claude session (Claude Code, Claude desktop) can drive Demo Studio: projects, scenarios, runs, sessions, sandboxes (README "MCP")')
    .option('--print-config', 'print the registration for Claude Code (.mcp.json, claude mcp add) and Claude desktop instead of serving')
    .option('--http', 'serve over Streamable HTTP on 127.0.0.1 (with a stable token in the studio home) instead of stdio; with --print-config: the HTTP registration')
    .option('--port <n>', 'with --http: listen on this port (default 47820; 0: a free one)')
    .option('--rotate-token', 'with --http: replace the stable token first (every registration must be made again)')
    .option('--json', 'with --http: print one JSON line {type, url, port, pid} on stdout once serving')
    .action(action((u, g, o: McpCommandOptions) => mcpCommand(u, g, o)));

  program
    .command('ui')
    .description('the Studio web app of the workspace, on 127.0.0.1 until Ctrl-C (one server per workspace: run again to reopen it)')
    .option('--port <n>', 'listen on this port (default: a free one)')
    .option('--no-open', 'do not open a browser; print the link only')
    .option('--json', 'print one JSON line {type, v, url, port, pid, reused, player} on stdout and nothing else')
    .option('--supervised', 'for the desktop app: --json --no-open, and stop when stdin closes (the parent quit or died)')
    .action(action((u, g, o: UiCommandOptions) => uiCommand(u, g, o)));

  const jobs = program.command('jobs').description('jobs an MCP client (Claude) started: dry runs, captures, hooks, resets, sign-ins, sandboxes');
  jobs
    .command('list', { isDefault: true })
    .description('jobs of the workspace, newest first, and the worker')
    .option('--project <slug>', 'only the jobs of this project')
    .option('--state <state>', 'only jobs in this state (queued, running, succeeded, failed, cancelled, interrupted; repeatable)', collect)
    .option('--limit <n>', 'at most this many jobs (default 20)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: JobsListOptions) => jobsListCommand(u, g, o)));
  jobs
    .command('status')
    .description('one job: what it runs, its state, progress, result or error and the fix')
    .argument('<id>', 'job id (j_…)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string, o: JobsStatusOptions) => jobsStatusCommand(u, g, id, o)));
  jobs
    .command('cancel')
    .description('cancel a job: a queued one never starts; a running one stops, its teardown and rollbacks still run')
    .argument('<id>', 'job id (j_…)')
    .action(action((u, g, id: string) => jobsCancelCommand(u, g, id)));

  program
    .command('worker', { hidden: true })
    .description('run the jobs worker of the workspace (the MCP server starts it in the background)')
    .option('--idle-exit <ms>', 'exit after this long without a job (default 60000)')
    .option('--once', 'run at most one job, then exit')
    .action(action((u, g, o: WorkerCommandOptions) => workerCommand(u, g, o)));

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
