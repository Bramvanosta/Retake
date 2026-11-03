/** Process exit codes of `retake`. */
export const EXIT = {
  ok: 0,
  /** Validation errors, a failed run or hook, a missing project… */
  failure: 1,
  /** Bad command line (unknown command/option, missing argument, invalid value). */
  usage: 2,
  /** Interrupted (Ctrl-C, SIGTERM) while holding a persona's browser: closed first (interrupt.ts). */
  interrupted: 130,
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
  'PreflightError',
  'LoginPageError',
  'EncodeError',
  'CancelledError',
  'HookError',
  'HookSecurityError',
  'AccessError',
  'ClockError',
  'JournalError',
  'ComponentError',
  'RenderError',
  'PlanError',
  'ReviewError',
  'SandboxError',
  'EngineError',
  'RunOptionError',
  'SandboxTakeError',
]);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The message of an error and, when it carries one (an EngineError: the refusal beside an old Studio, a busy lock…), its
 * `fix` on a second line — the one formatter of a refusal the CLI prints (L5.13a review B M2).
 */
export function errorText(e: unknown): string {
  const fix = e instanceof Error ? (e as { fix?: unknown }).fix : undefined;
  return `${errorMessage(e)}${typeof fix === 'string' && fix ? `\nfix: ${fix}` : ''}`;
}

/** True for errors raised on purpose by Retake packages (as opposed to bugs). */
export function isKnownError(e: unknown): boolean {
  return e instanceof Error && KNOWN.has(e.name);
}

export function exitCodeOf(e: unknown): ExitCode {
  return e instanceof CliError ? e.exitCode : EXIT.failure;
}
