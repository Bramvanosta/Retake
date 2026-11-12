import { isAbsolute, parse, relative } from 'node:path';
import pc from 'picocolors';
import { formatPath, relativeInside } from '@retake/core/base';
import type { ValidationIssue } from '@retake/core/model';
import type { Colors, Io } from './io.js';

export { formatMs } from '@retake/engine';

/** Output helpers shared by every command: colours, paths, durations, issue lists, a live status line. */
export class Ui {
  readonly c: Colors;
  private status = '';

  constructor(
    readonly io: Io,
    readonly verbose = false,
  ) {
    this.c = pc.createColors(io.color);
  }

  /** Print a line on stderr (above the live status line, which is redrawn). */
  line(text = ''): void {
    this.clearStatus();
    this.io.err(`${text}\n`);
    this.drawStatus();
  }

  /** Print a line on stdout (results meant to be piped). */
  result(text = ''): void {
    this.io.out(`${text}\n`);
  }

  /** A transient line redrawn in place on interactive terminals (ignored otherwise). */
  setStatus(text: string): void {
    if (!this.io.interactive) return;
    this.clearStatus();
    this.status = text;
    this.drawStatus();
  }

  clearStatus(): void {
    if (!this.io.interactive || !this.status) return;
    this.io.err('\r\x1b[2K');
    this.status = '';
  }

  private drawStatus(): void {
    if (this.io.interactive && this.status) this.io.err(this.status);
  }

  ok(text: string): void {
    this.line(`${this.c.green('✓')} ${text}`);
  }

  /** A warning; the lines of a multi-line one stay under its first line (after the icon). */
  warn(text: string): void {
    this.line(`${this.c.yellow('!')} ${this.c.yellow(hangingIndent(text))}`);
  }

  /** An error; the lines of a multi-line one stay under its first line (after the icon). */
  error(text: string): void {
    this.line(`${this.c.red('✗')} ${this.c.red(hangingIndent(text))}`);
  }

  info(text: string): void {
    this.line(text);
  }

  debug(text: string): void {
    if (this.verbose) this.line(this.c.dim(text));
  }

  /** Path relative to the working directory when inside it, else absolute. */
  path(p: string): string {
    return displayPath(p);
  }

  /** "file:12:5 error scenes[1].steps[3].click: message", severity coloured. */
  issue(i: ValidationIssue, file?: string): string {
    let loc = file ? this.path(file) : '';
    if (i.line !== undefined) loc += `${loc ? ':' : ''}${i.line}:${i.col ?? 1}`;
    const sev = i.severity === 'error' ? this.c.red('error') : this.c.yellow('warning');
    const where = formatPath(i.path);
    return `${loc ? `${this.c.dim(loc)} ` : ''}${sev} ${where ? `${this.c.bold(where)}: ` : ''}${i.message}`;
  }
}

/** Continuation lines indented by the width of a status icon and its space ("✗ "). */
function hangingIndent(text: string): string {
  return text.replace(/\n/g, '\n  ');
}

export function displayPath(p: string): string {
  const cwd = process.cwd();
  // From the filesystem root a relative path would read like an absolute one without its leading slash.
  if (!isAbsolute(p) || cwd === parse(cwd).root) return p;
  return relativeInside(p, cwd, { self: false, dotDotPrefix: true }) ?? p;
}

/** Cut to `max` characters with an ellipsis. */
export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
