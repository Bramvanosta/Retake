import type { Command } from 'commander';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';

/** A command's action: given the Ui and the global options, it returns the exit code (`buildProgram` stores it). */
export type Action = <A extends unknown[]>(fn: (ui: Ui, g: GlobalOptions, ...args: A) => Promise<ExitCode> | ExitCode) => (...args: A) => Promise<void>;

/** What a command family registers its commands with: the program and the action wrapper. */
export interface ProgramContext {
  readonly program: Command;
  readonly action: Action;
}

/** L5.14: heavy commands wait for a take filming on this Mac, then yield to later ones; `--no-wait` skips both. */
export const NO_WAIT = 'start at once even while a take films on this Mac (default: wait for it, then go on at background priority during later takes)';

/** A repeatable option's parser: each value appended. */
export const collect = (value: string, previous: string[] = []) => [...previous, value];
