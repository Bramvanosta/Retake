import { Option } from 'commander';
import { initCommand } from '../commands/init.js';
import { listCommand, newCommand } from '../commands/project.js';
import type { NewOptions } from '../commands/project.js';
import { validateCommand } from '../commands/validate.js';
import type { ValidateOptions } from '../commands/validate.js';
import { collect } from './context.js';
import type { ProgramContext } from './context.js';

/** The workspace and its projects: init, new, list, validate. */
export function registerWorkspaceCommands({ program, action }: ProgramContext): void {
  program
    .command('init')
    .description('make a folder a workspace: retake.yaml (every key commented), projects/ and a .gitignore; an existing workspace is left as it is, a non-empty folder refused')
    .argument('[dir]', 'the folder (default: the current one; created when missing)')
    .action(action((u, _g, dir: string | undefined) => initCommand(u, dir)));

  program
    .command('new')
    .description('create a project (README.md, project.yaml, scenarios/, hooks/, assets/); on a terminal without --env it asks for environments and personas, and offers to sign each one in')
    .argument('<slug>', 'project folder name: lower-case letters, digits and "-"')
    .option('--name <name>', 'display name (default: the slug)')
    .option('--theme <name>', 'theme: a workspace theme, a starter (default, editorial, motion) or ./path (default: default)')
    // The name before the glossary (docs/GLOSSARY.md): still accepted, no longer shown.
    .addOption(new Option('--template <name>').hideHelp())
    .option('--env <name=key:url,...>', 'environment pages, e.g. staging=app:https://app.staging.example.com (repeatable)', collect)
    .action(action((u, g, slug: string, o: NewOptions) => newCommand(u, g, slug, o)));

  program
    .command('list')
    .description('list the projects (with their scenarios) and themes of the workspace')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: { json?: boolean }) => listCommand(u, g, o)));

  program
    .command('validate')
    .description('validate project.yaml, its theme and a scenario (every scenario when omitted)')
    .argument('<project>', 'project slug or directory')
    .argument('[scenario]', 'scenario name or YAML file')
    .option('--env <name>', 'environment to check page keys against')
    .option('--until <ref>', 'check that this step reference resolves')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, s: string | undefined, o: ValidateOptions) => validateCommand(u, g, p, s, o)));
}
