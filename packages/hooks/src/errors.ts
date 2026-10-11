/** A hook could not be prepared or failed while running. */
export class HookError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HookError';
  }
}

/** A hook was refused before anything ran: host outside the allow-list, or unconfirmed destructive hook. */
export class HookSecurityError extends Error {
  constructor(
    message: string,
    public readonly reason: 'host' | 'destructive',
  ) {
    super(message);
    this.name = 'HookSecurityError';
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
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
