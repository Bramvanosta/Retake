import { envResetCommand, hooksRollbackCommand, hooksRunCommand, hooksTrustCommand } from '../commands/hooks.js';
import type { HookCommandOptions, HooksTrustOptions } from '../commands/hooks.js';
import { sandboxDownCommand, sandboxInitCommand, sandboxLogsCommand, sandboxResetCommand, sandboxStatusCommand, sandboxUpCommand } from '../commands/sandbox.js';
import type { SandboxCommandOptions } from '../commands/sandbox.js';
import type { ProgramContext } from './context.js';

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

  const env = program.command('env').description('environment maintenance');
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
