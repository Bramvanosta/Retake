import { GUIDE } from '@retake/core';
import type { ErrorKind } from '@retake/core';

/** A hook could not be prepared or failed while running. */
export class HookError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HookError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'invalid';
  }

  get errorDocs(): string {
    return GUIDE.scenarios;
  }
}

/**
 * A hook was refused before anything ran: host outside the allow-list, unconfirmed destructive hook, or a hook that
 * writes on a read-only run (L1.7).
 */
export class HookSecurityError extends Error {
  constructor(
    message: string,
    /** `mcp`: work submitted through MCP references a file or a secret it may not (core agent-trust). */
    public readonly reason: 'host' | 'destructive' | 'read-only' | 'mcp',
  ) {
    super(message);
    this.name = 'HookSecurityError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'refused';
  }

  get errorDocs(): string {
    return GUIDE.security;
  }
}

/** A journal file is unreadable or malformed. */
export class JournalError extends Error {
  constructor(
    message: string,
    public readonly file: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'invalid';
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
