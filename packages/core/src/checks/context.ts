import { isAbsolute, relative, resolve } from 'node:path';
import { needFiles } from '../file-facts.js';
import type { CheckFiles } from '../file-facts.js';
import type { Confinement } from '../confinement.js';
import type { IssuePath } from '../issues.js';
import { brokenUnder } from '../validation/document.js';
import type { LocatedIssue } from '../validation/located.js';
import { issue } from '../validation/located.js';
import { pathInside } from '../path-inside.js';

/** Shared state of the semantic checks of one document. */
export class CheckContext {
  readonly out: LocatedIssue[] = [];
  /**
   * Work an agent submits, with the words of its confinement (review A L4; L7.35: a value, core Confinement): a file
   * reference outside the directory is reported as such without looking at it, and one that leads out through a link as
   * not found — whether a file exists outside the project is never told.
   */
  confined: Confinement | undefined = undefined;
  /**
   * L5.10a fixes (review A-M1): when set, every file a check looks for is added (absolute path) — a caller memoising the
   * result (the Studio's project board) re-checks them before it trusts its memo.
   */
  filesRead: Set<string> | undefined = undefined;

  constructor(
    /** Issues of the structural (schema) pass: semantic checks skip broken subtrees. */
    readonly structural: readonly LocatedIssue[],
    /** Directory relative files are resolved against (undefined → files cannot be checked). */
    readonly projectDir?: string,
    /** How messages name that directory ("the project", "the template folder"). */
    readonly dirLabel = 'the project',
    /**
     * How the checks look at the disk (core FileFacts): needed as soon as a file is checked in a directory; with the
     * work's VideoProber, as soon as a video file is probed.
     */
    readonly files?: CheckFiles,
  ) {}

  /**
   * The directory and the port the hook rules read a project file through (DestructiveOptions): none without a
   * directory; with one, its FileFacts. The entry points require it beside a directory (FilesWith); a caller outside
   * the type checker that gave none keeps the run-time refusal where a file is first read (readProjectText's
   * needFiles), as before — hence the cast.
   */
  hookFiles(): { projectDir?: undefined } | { projectDir: string; files: CheckFiles } {
    return this.projectDir === undefined ? {} : ({ projectDir: this.projectDir, files: this.files } as { projectDir: string; files: CheckFiles });
  }

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
    if (this.confined && (isAbsolute(rel) || !pathInside(abs, dir, { dotDotPrefix: true }))) {
      // agent-trust projectFileProblem's words (that check needs a scenario that parses: this one runs first).
      this.out.push(issue('error', path, `${what} "${rel}" resolves outside ${where} folder: ${this.confined.words} only files of the project folder are read`));
      return;
    }
    this.filesRead?.add(abs);
    const files = needFiles(this.files, 'a file check');
    let isFile = false;
    try {
      if (files.kind(abs) === 'file') {
        const real = this.confined ? files.realpath(abs) : undefined;
        const realDir = this.confined ? files.realpath(dir) : undefined;
        isFile = !this.confined || (real !== undefined && realDir !== undefined && pathInside(real, realDir, { dotDotPrefix: true }));
      }
    } catch {
      isFile = false;
    }
    if (!isFile) {
      const consequence = severity === 'warning' ? ' (it will fail when it runs)' : '';
      this.out.push(issue(severity, path, `${what} "${rel}" not found in ${where}${consequence}`));
    }
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
