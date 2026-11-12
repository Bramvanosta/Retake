import { Command, CommanderError } from 'commander';
import { resolve } from 'node:path';
import { RETAKE_VERSION } from '@retake/core';
import { assertOutsideBundle, bundleInfoOrNull } from '@retake/core/io';
import { EXIT, errorMessage, errorText, exitCodeOf, isKnownError } from './errors.js';
import type { ExitCode } from './errors.js';
import { memoryIo, processIo } from './io.js';
import type { Io } from './io.js';
import { registerCaptureCommands } from './program/capture.js';
import { registerCommentCommands } from './program/comment.js';
import type { Action, ProgramContext } from './program/context.js';
import { registerEditCommands } from './program/edit.js';
import { registerEnvironmentCommands } from './program/environment.js';
import { registerLaterCommands } from './program/later.js';
import { registerLookCommands } from './program/look.js';
import { registerServiceCommands } from './program/services.js';
import { registerSignInCommands } from './program/sign-in.js';
import { registerUpkeepCommands } from './program/upkeep.js';
import { registerWorkspaceCommands } from './program/workspace.js';
import { Ui } from './ui.js';
import type { GlobalOptions } from './workspace.js';

export const VERSION = RETAKE_VERSION;

/**
 * The command families, in the order `--help` lists their commands: each registers its own (src/program/).
 */
const FAMILIES: readonly ((ctx: ProgramContext) => void)[] = [
  registerWorkspaceCommands,
  registerCaptureCommands,
  registerEditCommands,
  registerEnvironmentCommands,
  registerLookCommands,
  registerCommentCommands,
  registerUpkeepCommands,
  registerSignInCommands,
  registerServiceCommands,
  registerLaterCommands,
];

/** Build the `retake` program. Actions store their exit code through `setExit`. */
function buildProgram(io: Io, setExit: (code: ExitCode) => void): Command {
  const program = new Command('retake');
  let ui: Ui | null = null;
  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const getUi = (): Ui => {
    if (!ui) {
      const g = globals();
      ui = new Ui({ ...io, color: io.color && g.color !== false }, g.verbose === true);
    }
    return ui;
  };
  const action: Action =
    <A extends unknown[]>(fn: (ui: Ui, g: GlobalOptions, ...args: A) => Promise<ExitCode> | ExitCode) =>
    async (...args: A) => {
      setExit(await fn(getUi(), globals(), ...args));
    };

  program
    .description('Retake: precise YAML scenarios → product videos captured from a real web app')
    .version(bundleInfoOrNull() ? `${VERSION} (app bundle: ${bundleInfoOrNull()!.sealed})` : VERSION, '-V, --version')
    .option('-C, --root <dir>', 'workspace root (default: $RETAKE_ROOT, else the nearest folder with retake.yaml)')
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
  // Nothing writes inside the app bundle (core bundle.ts): every command's --out is refused there, before it starts.
  program.hook('preAction', (_program, command) => {
    const out = command.opts<{ out?: unknown }>().out;
    if (typeof out === 'string' && out) assertOutsideBundle(resolve(out), `--out ${out}`, bundleInfoOrNull());
  });

  for (const register of FAMILIES) register({ program, action });

  return program;
}

/** The help of every command, the program's first and hidden ones included (the glossary's word guard reads it). */
export function helpTexts(): string[] {
  const out: string[] = [];
  const walk = (c: Command): void => {
    out.push(c.helpInformation());
    c.commands.forEach(walk);
  };
  walk(buildProgram(memoryIo(), () => {}));
  return out;
}

/**
 * Every command that runs something, by its path (`run`, `hooks run`; hidden ones included, the groups themselves
 * not): what the operation catalogue (@retake/engine/contract) is held to.
 */
export function commandPaths(): string[] {
  const out: string[] = [];
  const walk = (c: Command, prefix: string): void => {
    for (const sub of c.commands) {
      const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
      if (sub.commands.length) walk(sub, path);
      else out.push(path);
    }
  };
  walk(buildProgram(memoryIo(), () => {}), '');
  return out;
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
      ui.error(errorText(e));
    } else {
      ui.error(`unexpected error: ${errorMessage(e)}`);
      if (e instanceof Error && e.stack) ui.line(ui.c.dim(e.stack));
    }
    return exitCodeOf(e);
  }
}
