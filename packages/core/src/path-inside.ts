/**
 * Path containment, one implementation: whether a path is a folder or lies inside it. The checks of the tool do not all
 * mean the same thing, on purpose or by history, so each call states its semantics through the options:
 *
 * - `real`: a resolver applied to both paths first — `realPathOf` (agent-trust) to follow symbolic links. Default: the
 *   paths as given. This module stays pure: the caller brings the resolver that reads the disk.
 * - `self`: whether the folder itself counts as inside it. Default true.
 * - `fold`: compare without case (both lower-cased first), for file systems that ignore it. Default false.
 * - `compare`: `'resolved'` (default) asks `path.relative`, which resolves both against the current folder and
 *   normalises them (`a/b/../c` is `a/c`); `'spelling'` compares the paths as they are spelt — `p` is `dir`, or begins
 *   with `dir` and a separator (a `dir` spelt with a trailing separator is taken as it is) — without normalising.
 * - `dotDotPrefix` (`'resolved'` only): a relative path that merely begins with `..` — a first name such as `..cache` —
 *   counts as outside too. The stricter, older spelling of the check; by default only a `..` segment leads out.
 * - `trailingSepHoldsNothing` (`'spelling'` only): a `dir` spelt with a trailing separator — for a normalised or real
 *   path, only the filesystem root — holds nothing but itself (and nothing at all with `self: false`). By default such a
 *   `dir` is taken as it is.
 *
 * `packages/core/test/path-inside.test.ts` pins every combination the tool uses against the copies it replaced.
 */
import { isAbsolute, relative, sep } from 'node:path';

export interface PathInsideOptions {
  /** Applied to both paths before they are compared (e.g. `realPathOf`: symbolic links followed). */
  real?: (p: string) => string;
  /** Whether `dir` itself counts as inside `dir` (default true). */
  self?: boolean;
  /** Compare without case (default false). */
  fold?: boolean;
  /** `'resolved'` (default): path.relative of the two; `'spelling'`: a string prefix ending at a separator. */
  compare?: 'resolved' | 'spelling';
  /** `'resolved'` only: a relative path beginning with `..` (`..cache` too) counts as outside (default false). */
  dotDotPrefix?: boolean;
  /** `'spelling'` only: a `dir` spelt with a trailing separator holds nothing but itself (default false). */
  trailingSepHoldsNothing?: boolean;
}

/**
 * `p` relative to `dir` when `p` is inside `dir` under the options (platform separators; `''` for the folder itself;
 * lower-cased with `fold`, from the resolved spellings with `real`), else undefined.
 */
export function relativeInside(p: string, dir: string, o: PathInsideOptions = {}): string | undefined {
  const spell = (x: string) => {
    const y = o.real ? o.real(x) : x;
    return o.fold ? y.toLowerCase() : y;
  };
  const child = spell(p);
  const folder = spell(dir);
  if (o.compare === 'spelling') {
    if (child === folder) return o.self === false ? undefined : '';
    if (o.trailingSepHoldsNothing && folder.endsWith(sep)) return undefined;
    const head = folder.endsWith(sep) ? folder : folder + sep;
    return child.startsWith(head) ? child.slice(head.length) : undefined;
  }
  const rel = relative(folder, child);
  if (rel === '') return o.self === false ? undefined : '';
  const climbs = o.dotDotPrefix ? rel.startsWith('..') : rel === '..' || rel.startsWith(`..${sep}`);
  return climbs || isAbsolute(rel) ? undefined : rel;
}

/** Whether `p` is inside `dir` (or is `dir`, unless `self: false`) under the options: see the module comment. */
export function pathInside(p: string, dir: string, o: PathInsideOptions = {}): boolean {
  return relativeInside(p, dir, o) !== undefined;
}
