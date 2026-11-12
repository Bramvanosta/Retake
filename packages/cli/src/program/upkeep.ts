import { Argument } from 'commander';
import type { JsonSchemaName } from '@retake/core';
import { doctorCommand } from '../commands/doctor.js';
import { journalCommand } from '../commands/journal.js';
import type { JournalOptions } from '../commands/journal.js';
import type { DoctorOptions } from '../commands/doctor.js';
import { SCHEMA_NAMES, schemaCommand } from '../commands/misc.js';
import { pruneCommand } from '../commands/prune.js';
import type { PruneOptions } from '../commands/prune.js';
import type { ProgramContext } from './context.js';

/** The machine and the workspace: prune, doctor, journal, schema. */
export function registerUpkeepCommands({ program, action }: ProgramContext): void {
  program
    .command('prune')
    .description("free disk space: list (and with --yes delete) failed captures, dry runs, older captures and renders nothing uses — the last good capture of each scenario, the captures renders and comments use and the last renders of each scenario stay")
    .argument('<project>', 'project slug or directory')
    .option('--keep-renders <n>', 'renders kept per scenario and variant (default 3), with their reviews')
    .option('--yes', 'delete (default: only list what would go and how much it frees)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, o: PruneOptions) => pruneCommand(u, g, p, o)));

  program
    .command('doctor')
    .description('check this machine for Retake: Node, Chromium, ffmpeg, display, keychain, notifications, workspace, theme fonts')
    .option('--project <slug>', "also check a project: its personas' sessions (never signed in, expired, in use, inside a git work tree) and its environments' hosts (HEAD, 5 s timeout)")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: DoctorOptions) => doctorCommand(u, g, o)));

  program
    .command('journal')
    .description('the workspace journal: each scenario, README, thread, theme or component written and each hook run — who, when, the outcome')
    .option('--project <slug>', 'only the lines of this project')
    .option('--writes', 'only the authored writes')
    .option('--hooks', 'only the hook runs')
    .option('--limit <n>', 'the newest n lines (default 50)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: JournalOptions) => journalCommand(u, g, o)));

  program
    .command('schema')
    .description('print a JSON Schema (for editor autocompletion and agents)')
    .addArgument(new Argument('[name]', 'which schema').choices(SCHEMA_NAMES).default('scenario'))
    .action(action((u, _g, name: JsonSchemaName) => schemaCommand(u, name)));
}
