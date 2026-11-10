/**
 * The one reader of a run folder (runs/<id>/): run.json and timeline.json as regular files within their caps, parsed at
 * the boundary (core run-record.ts) into a value or a typed problem — never a throw on a file someone else wrote — and
 * the facts the rules of core take.ts decide on. A run met in a listing is read without following any symbolic link;
 * a run a person named is read through them (`readNamedRunFolder`), and says which of its files are links.
 */
import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_FILM, isFilmName, parseRunRecord, parseTimeline, parseTimelineHead } from '../run-record.js';
import type { FileProblem, Read, RunRead, TimelineHead } from '../run-record.js';
import type { RunFolderFacts } from '../take.js';
import type { Timeline } from '../types.js';

/** A run.json bigger than this is not read (it is not one the runner wrote). */
export const RUN_RECORD_MAX = 32 * 1024 * 1024;
/** A timeline.json bigger than this is not read. */
export const TIMELINE_MAX = 64 * 1024 * 1024;

/** What the reader asks of a file system (node:fs/promises by default; a test hands its own). */
export interface RunFolderFs {
  lstat(path: string): Promise<RunFolderStat>;
  stat(path: string): Promise<RunFolderStat>;
  readFile(path: string): Promise<string>;
}
export interface RunFolderStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}
const NODE_FS: RunFolderFs = { lstat, stat, readFile: (path) => readFile(path, 'utf8') };

export interface ReadFileOptions {
  fs?: RunFolderFs;
  /** Read through a symbolic link (a run a person named). Default: a link is `not-a-file`. */
  follow?: boolean;
}

type Problem = { ok: false; problem: FileProblem };
const problem = (p: FileProblem): Problem => ({ ok: false, problem: p });
const gone = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException | null)?.code ?? '');

/** A JSON file: a regular file of at most `max` bytes, parsed; else the problem. `link`: the entry is a symbolic link. */
async function readJsonFile(file: string, max: number, o: ReadFileOptions): Promise<{ value: unknown; link: boolean } | { problem: Problem; link: boolean }> {
  const fs = o.fs ?? NODE_FS;
  let link = false;
  try {
    let st = await fs.lstat(file);
    link = st.isSymbolicLink();
    if (link) {
      if (!o.follow) return { problem: problem('not-a-file'), link };
      st = await fs.stat(file);
    }
    if (!st.isFile()) return { problem: problem('not-a-file'), link };
    if (st.size > max) return { problem: problem('too-big'), link };
  } catch (e) {
    return { problem: problem(gone(e) ? 'missing' : 'unreadable'), link };
  }
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (e) {
    return { problem: problem(gone(e) ? 'missing' : 'unreadable'), link };
  }
  try {
    return { value: JSON.parse(text) as unknown, link };
  } catch {
    return { problem: problem('not-json'), link };
  }
}

/** A run.json: the stored record, or the problem. */
export async function readRunRecord(file: string, o: ReadFileOptions = {}): Promise<RunRead> {
  const r = await readJsonFile(file, RUN_RECORD_MAX, o);
  return 'problem' in r ? r.problem : parseRunRecord(r.value);
}

/** The head of a timeline.json (mode, scenario, run, film), or the problem. For a caller that needs this one file (today: tests; the folder readers below read it themselves). */
export async function readTimelineHead(file: string, o: ReadFileOptions = {}): Promise<Read<TimelineHead>> {
  const r = await readJsonFile(file, TIMELINE_MAX, o);
  return 'problem' in r ? r.problem : parseTimelineHead(r.value);
}

/** A whole timeline.json (parseTimeline), or the problem of the file. */
export async function readTimeline(file: string, o: ReadFileOptions = {}): Promise<Read<Timeline>> {
  const r = await readJsonFile(file, TIMELINE_MAX, o);
  return 'problem' in r ? r.problem : parseTimeline(r.value);
}

type FolderFiles = Pick<RunFolderFacts, 'record' | 'timeline' | 'film' | 'recordLink' | 'timelineLink'>;

/** What a symbolic link, a regular file or anything else at `file` is, without reading it. */
async function kindOf(fs: RunFolderFs, file: string, follow: boolean): Promise<RunFolderFacts['film']> {
  try {
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) {
      // Named: a link to nothing is a missing film; listed: a link is a link, whatever lies behind it.
      if (follow) await fs.stat(file);
      return 'link';
    }
    return st.isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
}

/**
 * The files of a run folder. run.json first; then timeline.json — unless `o.timeline` answers that the record alone
 * decides (core takeNeedsTimeline): the timeline is then not opened (`not-read`, or `missing` when it is not there:
 * megabytes not parsed for a run its record already rules out) and only said to be a link or not, with the film under
 * its usual name. `whole` (asked
 * with `o.whole`): the whole timeline, from the same read and the same parse as its head.
 */
async function readFiles(dir: string, o: ReadFileOptions & { whole?: boolean; timeline?: (record: RunRead) => boolean }): Promise<FolderFiles & { whole?: Read<Timeline> }> {
  const fs = o.fs ?? NODE_FS;
  const rec = await readJsonFile(join(dir, 'run.json'), RUN_RECORD_MAX, o);
  const record: RunRead = 'problem' in rec ? rec.problem : parseRunRecord(rec.value);
  if (o.timeline && !o.timeline(record)) {
    // Not opened: said to be there or not, and a link or not (a folder with neither file is no run folder at all).
    const kind = await kindOf(fs, join(dir, 'timeline.json'), false);
    return { record, timeline: { ok: false, problem: kind === 'missing' ? 'missing' : 'not-read' }, film: await kindOf(fs, join(dir, DEFAULT_FILM), false), recordLink: rec.link, timelineLink: kind === 'link' };
  }
  const tl = await readJsonFile(join(dir, 'timeline.json'), TIMELINE_MAX, o);
  const timeline: Read<TimelineHead> = 'problem' in tl ? tl.problem : parseTimelineHead(tl.value);
  const whole: Read<Timeline> | undefined = o.whole ? ('problem' in tl ? tl.problem : parseTimeline(tl.value)) : undefined;
  const name = timeline.ok ? timeline.value.film : DEFAULT_FILM;
  // A film a listing takes is a file of the folder: a name that leads elsewhere is not looked at.
  const film: RunFolderFacts['film'] = !o.follow && !isFilmName(name) ? 'other' : await kindOf(fs, join(dir, name), o.follow === true);
  return { record, timeline, film, recordLink: rec.link, timelineLink: tl.link, ...(whole ? { whole } : {}) };
}

const UNREAD: FolderFiles = {
  record: { ok: false, problem: 'missing' },
  timeline: { ok: false, problem: 'missing' },
  film: 'missing',
  recordLink: false,
  timelineLink: false,
};

/**
 * What the folder `name` of `runsDir` holds, for a listing and for `latest`: nothing is read through a symbolic link.
 * A linked folder is `link` and nothing behind it is read; an entry that is gone or is no folder says so.
 * `o.timeline`: asked with the record once it is read — false: the timeline is not opened (see readFiles); a caller
 * that walks many runs hands core's takeNeedsTimeline, so that only a run that may be the take costs its timeline.
 */
export async function readRunFolder(runsDir: string, name: string, o: { fs?: RunFolderFs; timeline?: (record: RunRead) => boolean } = {}): Promise<RunFolderFacts> {
  const fs = o.fs ?? NODE_FS;
  const dir = join(runsDir, name);
  let folder: RunFolderFacts['folder'];
  try {
    const st = await fs.lstat(dir);
    folder = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other';
  } catch {
    folder = 'gone';
  }
  if (folder !== 'dir') return { name, folder, ...UNREAD };
  return { name, folder, ...(await readFiles(dir, { fs, ...(o.timeline ? { timeline: o.timeline } : {}) })) };
}

/**
 * What the run folder `dir` holds, for a run a person named by its id or its path: read through symbolic links, as
 * a named run always was — `folder: 'link'` and the files' link flags say what was followed (whether a linked run may
 * be used is the rule's: core take.ts namedRunProblem). For a caller that judges the run and does not work on its
 * timeline (today: tests; a plan and a raw export use readNamedRun, one read for both).
 */
export async function readNamedRunFolder(dir: string, o: { fs?: RunFolderFs } = {}): Promise<RunFolderFacts> {
  return (await readNamed(dir, { ...o, whole: false })).facts;
}

/**
 * readNamedRunFolder and the run's whole timeline (readTimeline's answer) from ONE read of timeline.json, parsed once:
 * for a caller that judges the named run and then works on its timeline (a plan, a raw export).
 */
export async function readNamedRun(dir: string, o: { fs?: RunFolderFs } = {}): Promise<{ facts: RunFolderFacts; timeline: Read<Timeline> }> {
  const r = await readNamed(dir, { ...o, whole: true });
  return { facts: r.facts, timeline: r.whole ?? { ok: false, problem: 'missing' } };
}

async function readNamed(dir: string, o: { fs?: RunFolderFs; whole: boolean }): Promise<{ facts: RunFolderFacts; whole?: Read<Timeline> }> {
  const fs = o.fs ?? NODE_FS;
  const name = basename(dir);
  let link: boolean;
  try {
    link = (await fs.lstat(dir)).isSymbolicLink();
    if (!(await fs.stat(dir)).isDirectory()) return { facts: { name, folder: 'other', ...UNREAD } };
  } catch {
    return { facts: { name, folder: 'gone', ...UNREAD } };
  }
  const { whole, ...files } = await readFiles(dir, { fs, follow: true, whole: o.whole });
  return { facts: { name, folder: link ? 'link' : 'dir', ...files }, ...(whole ? { whole } : {}) };
}
