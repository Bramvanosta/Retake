import { envResetCommand, hooksRollbackCommand, hooksRunCommand, hooksTrustCommand } from '../commands/hooks.js';
import type { HookCommandOptions, HooksTrustOptions } from '../commands/hooks.js';
import { sandboxDownCommand, sandboxInitCommand, sandboxLogsCommand, sandboxResetCommand, sandboxStatusCommand, sandboxUpCommand } from '../commands/sandbox.js';
import type { SandboxCommandOptions } from '../commands/sandbox.js';
import { envAddCommand, envRemoveCommand, envSetCommand } from '../commands/env.js';
import type { EnvEditOptions } from '../commands/env.js';
import { collect } from './context.js';
import type { ProgramContext } from './context.js';
import type { Command } from 'commander';

/** The product's state around a take: hooks, env, sandbox. */
export function registerEnvironmentCommands({ program, action }: ProgramContext): void {
  const hooks = program.command('hooks').description('run hooks or replay rollbacks outside a capture');
  hooks
    .command('run')
    .description('run <scenario>:setup, <scenario>:teardown, reset (project.yaml) or a YAML file listing hooks')
    .argument('<project>', 'project slug or directory')
    .argument('<source>', '<scenario>:setup | <scenario>:teardown | reset | hooks/<file>.yaml')
    .option('--env <name>', 'environment')
    .option('--yes', 'approve destructive hooks that lack "confirm: true", and run the shell and sql hooks of a scenario an agent wrote last without asking')
    .option('--allow-writes', 'let hooks write to a production environment (only where project.yaml sets access: read-write)')
    .option('--dry', "fill in the hooks' {{…}} values and security-check them without executing them")
    .action(action((u, g, p: string, s: string, o: HookCommandOptions) => hooksRunCommand(u, g, p, s, o)));
  hooks
    .command('rollback')
    .description('replay the pending rollbacks of a run (or of every run)')
    .argument('<project>', 'project slug or directory')
    .argument('[id]', 'run id (folder under runs/) or hooks journal id (.retake/journals/<id>.json)')
    .option('--env <name>', 'environment')
    .option('--allow-writes', 'replay rollbacks of a production environment (only where project.yaml sets access: read-write)')
    .option(
      '--replay-unsigned',
      'ask about each rollback Retake did not record in its journal with this home (shown in full, y/N; in a terminal only; never a sql or js one, one with secrets or on a sandbox)',
    )
    .option('--dry', 'describe the rollbacks without executing them')
    .action(action((u, g, p: string, r: string | undefined, o: HookCommandOptions) => hooksRollbackCommand(u, g, p, r, o)));
  hooks
    .command('trust')
    .description('after reading them, mark the shell and sql hooks of a scenario an agent wrote as yours: runs no longer ask about them until they change')
    .argument('<project>', 'project slug or directory')
    .argument('<scenario>', 'scenario name or YAML file')
    .option('--env <name>', 'environment whose pages fill the listing (default: scenario env, project default_env, first one)')
    .option('--yes', 'mark them without asking (they are listed first)')
    .action(action((u, g, p: string, s: string, o: HooksTrustOptions) => hooksTrustCommand(u, g, p, s, o)));

  const env = program.command('env').description('the environments of project.yaml: add, change, remove; reset one');
  env
    .command('reset')
    .description('replay pending rollback journals, then run the project `reset` hooks')
    .argument('<project>', 'project slug or directory')
    .option('--env <name>', 'environment')
    .option('--yes', 'approve destructive hooks that lack "confirm: true"')
    .option('--allow-writes', 'write to a production environment (only where project.yaml sets access: read-write)')
    .option(
      '--replay-unsigned',
      'ask about each rollback Retake did not record in its journal with this home (shown in full, y/N; in a terminal only; never a sql or js one, one with secrets or on a sandbox)',
    )
    .option('--dry', 'describe without executing')
    .action(action((u, g, p: string, o: HookCommandOptions) => envResetCommand(u, g, p, o)));
  registerEnvEdits(env, action);

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
    .description("the last lines of the services' logs (process: .retake/sandbox/<env>/logs/; docker-compose: docker compose logs)")
    .argument('<project>', 'project slug or directory')
    .argument('[service]', 'only this service')
    .option('--env <name>', sandboxEnvHelp)
    .option('--lines <n>', 'lines per service (default 50)')
    .option('--follow', 'docker-compose: keep reading until Ctrl-C')
    .action(action((u, g, p: string, svc: string | undefined, o: SandboxCommandOptions) => sandboxLogsCommand(u, g, p, svc, o)));
}

/** `retake env add | set | remove`: the environments of project.yaml (R-ENV-06). */
function registerEnvEdits(env: Command, action: ProgramContext['action']): void {
  const pageHelp = 'a page: key=url, or key=url,display=host (the URL the video shows instead); repeatable';
  env
    .command('add')
    .description("add an environment to project.yaml (only its lines are written: the file's comments and layout stay)")
    .argument('<project>', 'project slug or directory')
    .argument('<env>', 'the new environment name')
    .option('--page <key=url[,display=host]>', pageHelp, collect)
    .option('--production', 'a production environment (read-only unless --read-write)')
    .option('--read-only', 'stop every write of a run to its hosts')
    .option('--read-write', 'let runs write (a production environment then only with --allow-writes)')
    .option('--default', 'the environment scenarios without env: use (default_env)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, e: string, o: EnvEditOptions) => envAddCommand(u, g, p, e, o)));
  env
    .command('set')
    .description('change an environment of project.yaml: pages, production, access, default (only what changes is written)')
    .argument('<project>', 'project slug or directory')
    .argument('<env>', 'an environment of project.yaml (never a sandbox)')
    .option('--page <key=url[,display=host]>', `${pageHelp} (replaces that page whole)`, collect)
    .option('--remove-page <key>', 'remove a page (repeatable)', collect)
    .option('--production', 'mark it production')
    .option('--no-production', 'no longer production')
    .option('--read-only', 'stop every write of a run to its hosts')
    .option('--read-write', 'let runs write (a production environment then only with --allow-writes)')
    .option('--default', 'the environment scenarios without env: use (default_env)')
    .option('--no-default', 'default_env no longer names it')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, e: string, o: EnvEditOptions) => envSetCommand(u, g, p, e, o)));
  env
    .command('remove')
    .description("remove an environment from project.yaml (and default_env when it names it); its scenarios and saved sessions stay")
    .argument('<project>', 'project slug or directory')
    .argument('<env>', 'an environment of project.yaml (never a sandbox)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, e: string, o: EnvEditOptions) => envRemoveCommand(u, g, p, e, o)));
}
