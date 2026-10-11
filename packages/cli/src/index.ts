/**
 * @demo-studio/cli — the `studio` command (docs/DESIGN.md §4). `main(argv, io)` runs it in-process
 * (tests, other tools) and returns the exit code instead of exiting.
 */
export { main, VERSION } from './main.js';
export { EXIT, CliError, UsageError } from './errors.js';
export type { ExitCode } from './errors.js';
export { processIo, memoryIo } from './io.js';
export type { Io } from './io.js';
export { parseEnvOptions } from './commands/project.js';
