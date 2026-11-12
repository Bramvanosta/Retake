import { LATER_COMMANDS, laterCommand } from '../commands/misc.js';
import type { ProgramContext } from './context.js';

/** The commands of later phases (each says so and exits). */
export function registerLaterCommands({ program, action }: ProgramContext): void {
  for (const later of LATER_COMMANDS) {
    program
      .command(later.name)
      .description(`(phase ${later.phase}) ${later.summary}`)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument('[args...]')
      .action(action((u) => laterCommand(u, later.name, later.phase)));
  }
}
