import { formatPath, GUIDE, missingOrInvalid } from '@retake/core/base';
import type { ComponentIssue } from './types.js';
import type { ErrorKind } from '@retake/core/base';

/** A component that cannot be found, resolved, created or validated. The message is written for the user. */
export class ComponentError extends Error {
  constructor(
    message: string,
    readonly issues: ComponentIssue[] = [],
    /** Component directory the issues are relative to, when there is one. */
    readonly dir?: string,
  ) {
    super(message);
    this.name = 'ComponentError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return /already exists/.test(this.message) ? 'conflict' : missingOrInvalid(this.message, this.issues);
  }

  get errorDocs(): string {
    return GUIDE.components;
  }
}

/** "file:line:col severity path: message" per issue; `dir` prefixes the file names. */
export function formatComponentIssues(issues: readonly ComponentIssue[], dir?: string): string {
  return issues
    .map((i) => {
      let loc = dir ? `${dir.replace(/[\\/]+$/, '')}/${i.file}` : i.file;
      if (i.line !== undefined) loc += `:${i.line}:${i.col ?? 1}`;
      const path = formatPath(i.path);
      return `${loc} ${i.severity}${path ? ` ${path}` : ''}: ${i.message}`;
    })
    .join('\n');
}
