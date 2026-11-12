import { authStatusCommand, loginCommand } from '../commands/auth.js';
import type { AuthStatusOptions, LoginOptions } from '../commands/auth.js';
import type { ProgramContext } from './context.js';

/** Personas' sessions: login, auth. */
export function registerSignInCommands({ program, action }: ProgramContext): void {
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
}
