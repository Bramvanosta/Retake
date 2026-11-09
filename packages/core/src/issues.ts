import type { ValidationIssue } from './types.js';
import { GUIDE, missingOrInvalid } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

export type IssuePath = Array<string | number>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** ["scenes", 1, "steps", 3, "click"] → "scenes[1].steps[3].click" */
export function formatPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/**
 * One line per issue: "file:12:5 error scenes[1].steps[3].click: unknown key "txt" (did you mean "text"?)".
 * The location part is omitted when unknown; the path part when the issue is about the whole document.
 */
export function formatIssues(issues: readonly ValidationIssue[], file?: string): string {
  return issues
    .map((i) => {
      let loc = file ?? '';
      if (i.line !== undefined) loc += `${loc ? ':' : ''}${i.line}:${i.col ?? 1}`;
      const path = formatPath(i.path);
      const head = [loc, i.severity].filter(Boolean).join(' ');
      return path ? `${head} ${path}: ${i.message}` : `${head}: ${i.message}`;
    })
    .join('\n');
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function errorsOf(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

export function warningsOf(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'warning');
}

/** Error carrying validation issues (invalid project.yaml, template.yaml, retake.yaml, missing files…). */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
    public readonly file?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return missingOrInvalid(this.message, this.issues);
  }

  get errorDocs(): string {
    return GUIDE.workspace;
  }
}

/** "<what> <file> is invalid:\n<formatted issues>" */
export function issuesMessage(what: string, issues: readonly ValidationIssue[], file?: string): string {
  const errors = errorsOf(issues);
  const n = errors.length;
  return `${what}${file ? ` ${file}` : ''} has ${n} error${n === 1 ? '' : 's'}:\n${formatIssues(errors, file)}`;
}
