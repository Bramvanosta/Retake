import type { ErrorKind } from '@retake/core';
import { GUIDE } from '@retake/core';

/** Base class of every error raised by the web runner. */
export class RunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunnerError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'internal';
  }
}

export interface StepErrorDetails {
  /** Human description of the target (`text="Save" in dialog`). */
  target?: string;
  /** Visible candidates found. */
  candidates?: number;
  /** Matches that exist but are hidden. */
  hidden?: number;
  /** Visible texts near the query. */
  near?: string[];
  /** False when the `in` scope itself was missing. */
  scope_found?: boolean;
}

/** A step failed (target not found, condition not met, page error…). */
export class StepError extends RunnerError {
  constructor(
    message: string,
    public readonly details: StepErrorDetails = {},
    /** Kit ref of the element whose DOM best illustrates the failure (scope, partial match). */
    public readonly domRef: string | null = null,
  ) {
    super(message);
    this.name = 'StepError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  override get errorKind(): ErrorKind {
    return 'invalid';
  }

  get errorDocs(): string {
    return GUIDE.scenarios;
  }
}

/** The run was cancelled (AbortSignal, SIGINT/SIGTERM). */
export class CancelledError extends RunnerError {
  constructor(message = 'run cancelled') {
    super(message);
    this.name = 'CancelledError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  override get errorKind(): ErrorKind {
    return 'cancelled';
  }
}

/**
 * The session preflight stopped the run before anything ran or was recorded (L1.6): a persona's session is expired,
 * was never saved, could not be checked, or its profile is open in another browser. The message names the fix.
 */
export class PreflightError extends RunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }

  get errorDocs(): string {
    return GUIDE.environments;
  }
}

/**
 * A filmed page landed on a sign-in page during the run (L1.6). The run fails (not cancelled) and keeps nothing of the
 * capture: no frames, no video, no screenshot.
 */
export class LoginPageError extends RunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'LoginPageError';
  }

  get errorDocs(): string {
    return GUIDE.environments;
  }
}

/** ffmpeg failed or is missing. */
export class EncodeError extends RunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeError';
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError');
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Text for "nearby visible texts" lists in error messages. */
export function formatNear(near: string[] | undefined): string {
  if (!near || near.length === 0) return 'no visible text nearby';
  return `nearby visible texts: ${near.map((t) => JSON.stringify(t)).join(', ')}`;
}
