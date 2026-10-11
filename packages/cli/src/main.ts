import { Argument, Command, CommanderError, Option } from 'commander';
import { COMPONENT_KINDS } from '@demo-studio/core';
import type { JsonSchemaName } from '@demo-studio/core';
import { componentsCreateCommand, componentsListCommand, componentsValidateCommand } from './commands/components.js';
import type { ComponentsCreateOptions, ComponentsListOptions, ComponentsValidateOptions } from './commands/components.js';
import { doctorCommand } from './commands/doctor.js';
import type { DoctorOptions } from './commands/doctor.js';
import { envResetCommand, hooksRollbackCommand, hooksRunCommand } from './commands/hooks.js';
import type { HookCommandOptions } from './commands/hooks.js';
import { LATER_COMMANDS, SCHEMA_NAMES, laterCommand, loginCommand, schemaCommand } from './commands/misc.js';
import type { LoginOptions } from './commands/misc.js';
import { listCommand, newCommand } from './commands/project.js';
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
    .description('create a project (README.md, project.yaml, scenarios/, hooks/, assets/)')
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
    .option('--json', 'stream progress events as JSON lines on stdout')
    .action(action((u, g, p: string, s: string, o: RunCommandOptions) => runCommand(u, g, p, s, o)));

  const hooks = program.command('hooks').description('run hooks or replay rollbacks outside a capture');
  hooks
    .command('run')
    .description('run <scenario>:setup, <scenario>:teardown, reset (project.yaml) or a YAML file listing hooks')
    .argument('<project>', 'project slug or directory')
    .argument('<source>', '<scenario>:setup | <scenario>:teardown | reset | hooks/<file>.yaml')
    .option('--env <name>', 'environment')
    .option('--yes', 'approve destructive hooks that lack "confirm: true"')
    .option('--dry', 'template and security-check the hooks without executing them')
    .action(action((u, g, p: string, s: string, o: HookCommandOptions) => hooksRunCommand(u, g, p, s, o)));
  hooks
    .command('rollback')
    .description('replay the pending rollbacks of a run (or of every run)')
    .argument('<project>', 'project slug or directory')
    .argument('[id]', 'run id (folder under runs/) or hooks journal id (.demo-studio/journals/<id>.json)')
    .option('--env <name>', 'environment')
    .option('--dry', 'describe the rollbacks without executing them')
    .action(action((u, g, p: string, r: string | undefined, o: HookCommandOptions) => hooksRollbackCommand(u, g, p, r, o)));

  const env = program.command('env').description('environment maintenance');
  env
    .command('reset')
    .description('replay pending rollback journals, then run the project `reset` hooks')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', 'environment')
    .option('--yes', 'approve destructive hooks that lack "confirm: true"')
    .option('--dry', 'describe without executing')
    .action(action((u, g, p: string, o: HookCommandOptions) => envResetCommand(u, g, p, o)));

  const components = program.command('components').description('list, validate and scaffold components (intros, layouts, captions…)');
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
    .description('scaffold a workspace component (components/<namespace>/<name>/) from the template of its kind')
    .argument('<id>', 'component id "namespace/name" (lower-case letters, digits and "-")')
    .addOption(new Option('--kind <kind>', 'what it renders').choices([...COMPONENT_KINDS]).makeOptionMandatory())
    .option('--description <text>', 'one or two sentences: what it looks like and when to use it')
    .option('--name <name>', 'display name (default: from the id)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string, o: ComponentsCreateOptions) => componentsCreateCommand(u, g, id, o)));

  program
    .command('doctor')
    .description('check this machine for Demo Studio: Node, Chromium, ffmpeg, display, keychain, notifications, workspace, template fonts')
    .option('--project <slug>', "also check a project: its browser profile and its environments' hosts (HEAD, 5 s timeout)")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: DoctorOptions) => doctorCommand(u, g, o)));

  program
    .command('schema')
    .description('print a JSON Schema (for editor autocompletion and agents)')
    .addArgument(new Argument('[name]', 'which schema').choices(SCHEMA_NAMES).default('scenario'))
    .action(action((u, _g, name: JsonSchemaName) => schemaCommand(u, name)));

  program
    .command('login')
    .description("open a headed browser on the project's persistent profile to sign in once")
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', 'environment (selects the profile when auth is per environment)')
    .option('--page <key>', 'environment page to open (default: the first one)')
    .option('--url <url>', 'explicit URL to open')
    .action(action((u, g, p: string, o: LoginOptions) => loginCommand(u, g, p, o)));

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
