/**
 * The paths a record holds (R-SHR-01 – 03): run.json, a render record (renders/<id>.json) and a review's report.json.
 * One rule, written here only:
 *
 * - **On a disk**, a path is written relative to the folder of the file that holds it, with `/` separators, when that
 *   folder and the path both lie inside the project folder (a lexical check, core path-inside: a `runs/` that is a
 *   link stays relative, nothing is resolved on the disk). Any other path is written absolute, as before. So a project
 *   folder copied to another place — another workspace, another Mac — still names its own runs, videos and frames.
 * - **In memory**, every path is absolute: a reader resolves a relative path against the folder of the file it read,
 *   never against the process's current folder (`''` stays `''`: "none"). A relative path is bounded the way the writer
 *   bounds it: one that resolves outside its bound — run.json: its run folder; a render record of `renders/`: its
 *   project (the folder above `renders/`); a record elsewhere: its own folder — was not written by Retake and is read
 *   as `''` (none: missing). An absolute path is read as written, but for the records an older Retake wrote, all
 *   absolute: a path inside the folder they were written in is rebased onto the folder they are read from (run.json:
 *   its old `dir`; a version 1 render record: its old project — only when its own anchor has a project's shape, so a
 *   crafted record cannot move a path anywhere but into the project it is read in). Nothing is rewritten on a disk.
 * - run.json's `dir` is written `"."` and read as the folder the record was read from; a version 2 render record's
 *   `record` is written as its file's base name and read as the file read.
 *
 * The members are mapped in place — a record keeps its members' order (the readers hand a record on as the file
 * holds it, the tests compare them as text). The record as the file holds it is kept by the reader that needs it
 * (core io render-folder.ts: a read's `written`): what an answer quotes under `untrusted` is the disk's text.
 *
 * Pure: node:path only, no I/O.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { relativeInside } from './path-inside.js';

/** Where a record is written: the folder of its file and the project folder (both absolute, spelt from one root). */
export interface RecordPlace {
  folder: string;
  project: string;
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A path as a record writes it (the module's rule): relative to `at.folder`, `/`-separated, when the folder and the
 * path both lie inside `at.project`; else as it is. `''` and a path that is not absolute are left as they are.
 */
export function pathOnDisk(p: string, at: RecordPlace): string {
  if (p === '' || !isAbsolute(p)) return p;
  if (relativeInside(at.folder, at.project) === undefined || relativeInside(p, at.project) === undefined) return p;
  const rel = relative(at.folder, p);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/**
 * A path as a reader takes it: a relative one against `folder` (the folder of the file read) — `''` (none) when it
 * resolves outside `bound` (a path the writer never writes relative) —, an absolute one as written.
 */
function pathRead(p: string, folder: string, bound: string): string {
  if (p === '' || isAbsolute(p)) return p;
  const at = resolve(folder, ...p.split('/'));
  return relativeInside(at, bound) === undefined ? '' : at;
}

/** `p` moved from `from` to `to` when it lies inside `from` (an older record's absolute path), else as it is. */
function rebased(p: string, from: string, to: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relativeInside(p, from);
  return rel === undefined ? p : rel === '' ? to : join(to, rel);
}

/** `value` with `f` applied to each named text member, mapped in place (same order); the same object when nothing changed. */
function mapped<T extends Record<string, unknown>>(value: T, keys: readonly string[], f: (p: string) => string): T {
  let out: Record<string, unknown> | undefined;
  for (const k of keys) {
    const v = value[k];
    if (!isText(v)) continue;
    const w = f(v);
    if (w === v) continue;
    out ??= { ...value };
    out[k] = w;
  }
  return (out ?? value) as T;
}

/** A list of texts mapped (a member that is no text kept); the same list when nothing changed. */
function mappedList(list: unknown, f: (p: string) => string): unknown {
  if (!Array.isArray(list)) return list;
  const out = list.map((v) => (isText(v) ? f(v) : v));
  return out.some((v, i) => v !== list[i]) ? out : list;
}

/** Every value of a table that is a text mapped; the same table when nothing changed. */
function mappedTable(table: unknown, f: (p: string) => string): unknown {
  if (!isPlain(table)) return table;
  return mapped(table, Object.keys(table), f);
}

/** `value` with `member` replaced by `f(member)` when that differs; the same object otherwise. */
function withMember<T extends Record<string, unknown>>(value: T, member: string, f: (v: unknown) => unknown): T {
  if (!(member in value)) return value;
  const v = value[member];
  const w = f(v);
  return w === v ? value : ({ ...value, [member]: w } as T);
}

// ── run.json ─────────────────────────────────────────────────────────────────

/** Every path of a run record, `dir` aside, mapped by `f` (capture, timeline, screenshots, the error's files, the optional failures' shots). */
function runPaths<T extends Record<string, unknown>>(record: T, f: (p: string) => string): T {
  let out = mapped(record, ['capture', 'timeline'], f);
  out = withMember(out, 'screenshots', (l) => mappedList(l, f));
  out = withMember(out, 'error', (e) => (isPlain(e) ? mapped(e, ['screenshot', 'dom'], f) : e));
  out = withMember(out, 'optional_failures', (l) => {
    if (!Array.isArray(l)) return l;
    const next = l.map((o) => (isPlain(o) ? mapped(o, ['screenshot'], f) : o));
    return next.some((o, i) => o !== l[i]) ? next : l;
  });
  return out;
}

/**
 * A run record as run.json holds it: `dir` (the run folder, absolute in memory) written `"."` and every other path
 * by the module's rule, against that folder. `project`: the project folder.
 */
export function runRecordOnDisk<T extends { dir: string }>(record: T, project: string): T {
  const at: RecordPlace = { folder: record.dir, project };
  const out = runPaths(record as T & Record<string, unknown>, (p) => pathOnDisk(p, at));
  return mapped(out, ['dir'], (p) => pathOnDisk(p, at));
}

/**
 * A run record read from `folder` (its run folder, as the file was opened): `dir` is that folder (resolved), a relative
 * path is resolved against it (`''` when it leaves it), an absolute path inside the record's old `dir` (an older record)
 * rebased onto it.
 */
export function runRecordRead<T extends object>(value: T, folder: string): T {
  if (!isPlain(value)) return value;
  const here = resolve(folder);
  const old = value.dir;
  const fromOld = isText(old) && isAbsolute(old) && resolve(old) !== here ? resolve(old) : undefined;
  const read = (p: string): string => (fromOld !== undefined && isAbsolute(p) ? rebased(p, fromOld, here) : pathRead(p, here, here));
  let out = runPaths(value, read);
  out = withMember(out, 'dir', (d) => (isText(d) ? here : d));
  return out as T;
}

// ── A render record ──────────────────────────────────────────────────────────

/** Every path of a render record, mapped by `f`: file, run_dir, and the plan's capture, tracks, music and assets. */
function renderPaths<T extends Record<string, unknown>>(record: T, f: (p: string) => string): T {
  let out = mapped(record, ['file', 'run_dir'], f);
  out = withMember(out, 'plan', (plan) => {
    if (!isPlain(plan)) return plan;
    let p = withMember(plan, 'source', (s) => (isPlain(s) ? mapped(s, ['file'], f) : s));
    p = withMember(p, 'music', (m) => (isPlain(m) ? mapped(m, ['file'], f) : m));
    p = withMember(p, 'tracks', (t) => {
      if (!isPlain(t)) return t;
      let tracks = t;
      for (const k of Object.keys(t)) tracks = withMember(tracks, k, (tr) => (isPlain(tr) ? mapped(tr, ['file'], f) : tr));
      return tracks;
    });
    return withMember(p, 'assets', (a) => mappedTable(a, f));
  });
  return out;
}

/**
 * A render record as renders/<id>.json holds it: every path by the module's rule against the record file's folder,
 * `record` (the record file itself) as its base name. `file`: the record file; `project`: the project folder.
 */
export function renderRecordOnDisk<T extends { record: string }>(record: T, at: { file: string; project: string }): T {
  const place: RecordPlace = { folder: dirname(at.file), project: at.project };
  const out = renderPaths(record as T & Record<string, unknown>, (p) => pathOnDisk(p, place));
  return mapped(out, ['record'], (p) => pathOnDisk(p, place));
}

/** The project a render record of `renders/` lies in: the folder above `renders/`, else undefined. */
function projectOfRecord(file: string): string | undefined {
  const folder = dirname(file);
  return basename(folder) === 'renders' ? dirname(folder) : undefined;
}

/** The number of names of an absolute path (`/` has none). */
const depth = (p: string): number => p.split(sep).filter(Boolean).length;

/**
 * The project a version 1 record was written in, by its own `record` (else its `file`): the folder above its
 * `renders/` — only when that has a project's shape (at least two names below the root: `<workspace>/<project>` at
 * the least), whatever it is called (a copy may be renamed). A crafted anchor never moves a path elsewhere:
 * `/renders/x.json` would make `/` the old project, and is no anchor.
 */
function formerProject(value: Record<string, unknown>): string | undefined {
  for (const k of ['record', 'file']) {
    const p = value[k];
    if (!isText(p) || !isAbsolute(p)) continue;
    const former = projectOfRecord(resolve(p));
    return former !== undefined && depth(former) >= 2 ? former : undefined;
  }
  return undefined;
}

/**
 * A render record read from `file`: a version 2 record's relative paths resolved against the file's folder, bounded by
 * its project (a record of `renders/`) or its own folder (a record elsewhere), and its `record` the file read; a
 * version 1 record's absolute paths inside the project it was written in rebased onto the project it is read in
 * (formerProject). Anything else as written. A value that is no object is handed back.
 */
export function renderRecordRead<T extends object>(value: T, file: string): T {
  if (!isPlain(value)) return value;
  const here = resolve(file);
  const folder = dirname(here);
  const current = projectOfRecord(here);
  let out: Record<string, unknown>;
  if (value.version === 1) {
    const former = current !== undefined ? formerProject(value) : undefined;
    if (former === undefined || current === undefined || former === current) return value;
    out = renderPaths(value, (p) => rebased(p, former, current));
    out = mapped(out, ['record'], (p) => rebased(p, former, current));
  } else {
    const bound = current ?? folder;
    out = renderPaths(value, (p) => pathRead(p, folder, bound));
    out = mapped(out, ['record'], () => here);
  }
  return out as T;
}

// ── A review's report.json ───────────────────────────────────────────────────

/**
 * A review's result as report.json holds it: its paths (the render's video and record, the previous render's video,
 * its files and the diff sheet) by the module's rule against the review's FINAL folder (never the temporary one it is
 * written in). Nothing reads these paths back (the review's files are found from its folder).
 */
export function reportOnDisk<T extends object>(result: T, at: RecordPlace): T {
  const f = (p: string): string => pathOnDisk(p, at);
  let out = result as T & Record<string, unknown>;
  out = withMember(out, 'render', (r) => (isPlain(r) ? mapped(r, ['file', 'record'], f) : r));
  out = withMember(out, 'diff', (d) => (isPlain(d) ? mapped(d, ['previous_file', 'sheet'], f) : d));
  out = withMember(out, 'files', (files) => {
    if (!isPlain(files)) return files;
    let x = mapped(files, ['dir', 'timeline', 'report_json', 'report_md', 'diff_sheet'], f);
    x = withMember(x, 'sheets', (l) => mappedList(l, f));
    x = withMember(x, 'keyframes', (t) => mappedTable(t, f));
    x = withMember(x, 'scene_sheets', (t) => {
      if (!isPlain(t)) return t;
      let s = t;
      for (const k of Object.keys(t)) s = withMember(s, k, (l) => mappedList(l, f));
      return s;
    });
    return x;
  });
  return out;
}
