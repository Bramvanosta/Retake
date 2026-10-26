import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IssuePath } from '../issues.js';
import { brokenUnder } from '../validation/document.js';
import type { LocatedIssue } from '../validation/located.js';
import { issue } from '../validation/located.js';

/** Shared state of the semantic checks of one document. */
export class CheckContext {
  readonly out: LocatedIssue[] = [];
  /**
   * Work an agent submits, by its channel (MCP, the Studio: review A L4): a file reference outside the directory is
   * reported as such without looking at it, and one that leads out through a link as not found — whether a file exists
   * outside the project is never told.
   */
  confined: 'mcp' | 'studio' | undefined = undefined;

  constructor(
    /** Issues of the structural (schema) pass: semantic checks skip broken subtrees. */
    readonly structural: readonly LocatedIssue[],
    /** Directory relative files are resolved against (undefined → files cannot be checked). */
    readonly projectDir?: string,
    /** How messages name that directory ("the project", "the template folder"). */
    readonly dirLabel = 'the project',
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
  file(rel: string, path: IssuePath, what: string, severity: 'error' | 'warning', dir: string | undefined = this.projectDir): void {
    if (!dir) {
      this.warning(path, `cannot check that ${what} "${rel}" exists: no project given`);
      return;
    }
    const abs = resolve(dir, rel);
    const where = dir === this.projectDir ? this.dirLabel : dir;
    if (this.confined && (isAbsolute(rel) || !isInside(dir, abs))) {
      // agent-trust projectFileProblem's words (that check needs a scenario that parses: this one runs first).
      this.out.push(issue('error', path, `${what} "${rel}" resolves outside ${where} folder: ${this.confined === 'studio' ? 'from the Studio' : 'through MCP'} only files of the project folder are read`));
      return;
    }
    let isFile = false;
    try {
      isFile = existsSync(abs) && statSync(abs).isFile() && (!this.confined || isInside(realpathSync(dir), realpathSync(abs)));
    } catch {
      isFile = false;
    }
    if (!isFile) {
      const consequence = severity === 'warning' ? ' (it will fail when it runs)' : '';
      this.out.push(issue(severity, path, `${what} "${rel}" not found in ${where}${consequence}`));
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
