/** Process exit codes of `studio`. */
export const EXIT = {
  ok: 0,
  /** Validation errors, a failed run or hook, a missing project… */
  failure: 1,
  /** Bad command line (unknown command/option, missing argument, invalid value). */
  usage: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error the CLI reports as a one-line message (no stack) with a given exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.failure,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Invalid command-line usage (exit code 2). */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = 'UsageError';
  }
}

/** Error types whose message is already written for the user (no stack trace needed). */
const KNOWN = new Set([
  'CliError',
  'UsageError',
  'ConfigError',
  'ScenarioError',
  'EnvironmentError',
  'TemplateError',
  'StepError',
  'RunnerError',
  'EncodeError',
  'CancelledError',
  'HookError',
  'HookSecurityError',
  'JournalError',
  'ComponentError',
  'RenderError',
  'PlanError',
  'ReviewError',
]);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True for errors raised on purpose by Demo Studio packages (as opposed to bugs). */
export function isKnownError(e: unknown): boolean {
  return e instanceof Error && KNOWN.has(e.name);
}

export function exitCodeOf(e: unknown): ExitCode {
  return e instanceof CliError ? e.exitCode : EXIT.failure;
}
