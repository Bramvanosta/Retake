import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IssuePath } from '../issues.js';
import { brokenUnder } from '../validation/document.js';
import type { LocatedIssue } from '../validation/located.js';
import { issue } from '../validation/located.js';

/** Shared state of the semantic checks of one document. */
export class CheckContext {
  readonly out: LocatedIssue[] = [];

  constructor(
    /** Issues of the structural (schema) pass: semantic checks skip broken subtrees. */
    private readonly structural: readonly LocatedIssue[],
    /** Directory relative files are resolved against (undefined → files cannot be checked). */
    readonly projectDir?: string,
  ) {}

  error(path: IssuePath, message: string, loc?: LocatedIssue['loc']): void {
    this.out.push(issue('error', path, message, loc));
  }

  warning(path: IssuePath, message: string, loc?: LocatedIssue['loc']): void {
    this.out.push(issue('warning', path, message, loc));
  }

  /** Whether the schema pass reported an error at or under `path`. */
  broken(path: IssuePath): boolean {
    return brokenUnder(this.structural, path);
  }

  /** Whether the whole document passed the schema. */
  get structurallyValid(): boolean {
    return !this.structural.some((i) => i.severity === 'error');
  }

  /**
   * Check that a project-relative file exists. Without a project directory a warning says it
   * could not be checked.
   */
  file(rel: string, path: IssuePath, what: string, severity: 'error' | 'warning'): void {
    if (!this.projectDir) {
      this.warning(path, `cannot check that ${what} "${rel}" exists: no project given`);
      return;
    }
    const abs = resolve(this.projectDir, rel);
    let isFile = false;
    try {
      isFile = existsSync(abs) && statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      const consequence = severity === 'warning' ? ' (it will fail when it runs)' : '';
      this.out.push(issue(severity, path, `${what} "${rel}" not found in the project${consequence}`));
    }
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
