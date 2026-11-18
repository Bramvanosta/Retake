import { Option } from 'commander';
import { initCommand } from '../commands/init.js';
import { listCommand, newCommand } from '../commands/project.js';
import type { NewOptions } from '../commands/project.js';
import { validateCommand } from '../commands/validate.js';
import { projectAdoptCommand } from '../commands/adopt.js';
import type { AdoptOptions } from '../commands/adopt.js';
import type { ValidateOptions } from '../commands/validate.js';
import { projectExportCommand, projectImportCommand, projectTrustCommand } from '../commands/project-archive.js';
import type { ProjectExportOptions, ProjectImportOptions, ProjectTrustOptions } from '../commands/project-archive.js';
import { collect } from './context.js';
import type { ProgramContext } from './context.js';

/** The workspace and its projects: init, new, list, validate, project adopt / export / import / trust. */
export function registerWorkspaceCommands({ program, action }: ProgramContext): void {
  program
    .command('init')
    .description('make a folder a workspace: retake.yaml (every key commented), projects/ and a .gitignore; an existing workspace is left as it is, a non-empty folder refused')
    .argument('[dir]', 'the folder (default: the current one; created when missing)')
    .action(action((u, g, dir: string | undefined) => initCommand(u, g, dir)));

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

  const project = program
    .command('project')
    .description("a project's own library (themes, components and brand files taken from the workspace into the project folder), and a project in one ZIP: export, import, trust");
  project
    .command('adopt')
    .description(
      "take workspace themes into the project's templates/, workspace components into its components/ and brand files into its brand/, so the project folder alone carries its look; moves them (the workspace's set aside under .retake/adopted/), refused while another project uses a theme or component or a job is queued or running — --copy leaves the workspace's",
    )
    .argument('<project>', 'project slug')
    .option('--theme <name>', 'a workspace theme, by name (repeatable)', collect)
    .option('--component <id>', 'a workspace component, by id "namespace/name" (repeatable)', collect)
    .option('--brand <path>', "a brand file (an image, a font, a token file) relative to the workspace root, e.g. brand/logo.svg (repeatable, one file each): into the project's brand/", collect)
    .option('--copy', "copy: the workspace's stay where they are")
    .option('--json', 'machine-readable output')
    .action(action((u, g, slug: string, o: AdoptOptions) => projectAdoptCommand(u, g, slug, o)));
  project
    .command('export')
    .description(
      "write the project as one ZIP, a project archive (default: its exports/<slug>-project-<stamp>.zip): its files, its own themes and components and the workspace's it uses, a manifest; never .retake/, .env files, sessions, exports/ or key files",
    )
    .argument('<project>', 'project slug')
    .option('--with-runs', 'also its runs, renders and reviews')
    .option('--out <path>', 'the archive file, or a folder for it (never inside the project but its exports/)')
    .option('--dry-run', 'say what would go in, write nothing')
    .option('--json', 'machine-readable output')
    .action(action((u, g, slug: string, o: ProjectExportOptions) => projectExportCommand(u, g, slug, o)));
  project
    .command('import')
    .description('make a project archive a project of this workspace: imported untrusted, nothing of it runs until `retake project trust`')
    .argument('<archive>', 'the .zip file retake project export wrote')
    .option('--as <slug>', 'the project slug here (default: the one it was exported as)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, archive: string, o: ProjectImportOptions) => projectImportCommand(u, g, archive, o)));
  project
    .command('trust')
    .description("list what of an imported project runs (its code files, what project.yaml asks of this machine), then trust it on a person's yes at a terminal — or discard the import")
    .argument('<project>', 'project slug')
    .option('--list', 'list only')
    .option('--discard', 'set the folder of an import nobody trusted aside under .retake/imports/discarded/ and forget the import')
    .option('--json', 'machine-readable output')
    .action(action((u, g, slug: string, o: ProjectTrustOptions) => projectTrustCommand(u, g, slug, o)));

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
