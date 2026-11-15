/**
 * The Outputs port: what the engine generates in a project and reads back, each kind a member of its own — the run
 * folders (runs/<id>/: run.json, timeline.json, the scenario snapshot, the film), the renders (renders/: a record and
 * the files named after it), the reviews (review/<render id>/), the raw exports (exports/) and the page inspections
 * (.retake/inspect/<id>/). The project store (store/store.ts) is the port of the authored
 * writes; the workspace reads (workspace-reads/reads.ts), of the loaders; this one, of the generated outputs.
 *
 * Chosen at the composition roots (ports.ts `enginePorts`): `diskOutputs` (disk-outputs.ts) for the product,
 * `MemoryOutputs` (memory-outputs.ts) for tests. It reaches the engine's work through the opened workspace
 * (workspace.ts `OpenedWorkspace.outputs`) and, for a run, its capture request (capture/runner.ts `CaptureRequest.runs`:
 * the in-memory runner writes its run folder there). Both adapters are one implementation (output-files.ts
 * `runOutputsOn`) over a file layer of their own: core's one reader of a run folder (core io run-folder.ts) and its
 * reservation of a run id (core io reserveRunId) on either; nothing in the engine outside this folder names those
 * readers, nor core's reader of renders/ (the import-rules ratchet's `output-read` check). The same contract suite runs on both adapters
 * (engine/test/outputs-contract.ts).
 *
 * Paths are absolute, as core's readers take them and as run.json records them: a runs folder (`runsDirOf`), a run
 * folder in it (`runFolderOf`), a file of the run folder named by one segment. Where each folder is lies here only
 * (`OUTPUT_DIRS`, a member's `dirOf`): the engine spells no path into a generated folder elsewhere (the `output-read`
 * check). A run's own files on the disk — its pictures, frames, videos and scenario snapshot, read through checked
 * descriptors — are this folder's run-files.ts (`RunFolder`).
 */
import { join } from 'node:path';
import { projectPath, statePath } from '@retake/core/project';
import type { RunId } from '@retake/core/ids';
import type { Read, RunFolderFacts, RunRead } from '@retake/core/run';
import type { NamedRenderFind, NamedRenderVerb, RecordFileText } from '@retake/core/io';
import type { Timeline } from '@retake/core/model';
import type { RenderEntry } from '@retake/core/render';

/** What a listed run folder's read may be spared (core io readRunFolder's options). */
export interface RunFolderReadOptions {
  /** Asked with the record once read: false → the timeline is not opened (core takeNeedsTimeline). */
  timeline?: (record: RunRead) => boolean;
  /** The timeline is not opened either when the folder holds no file that could be its film (prune). */
  filmFirst?: boolean;
}

/**
 * A file of a run folder as described: when it is a regular file, its size and, asked, the sha256 of its bytes; a link
 * whose real path leaves the run folder (or leads nowhere), and a file that has another name (a hard link: `oneName`),
 * is `link: 'refused'`, with neither.
 */
export interface RunFileFacts {
  bytes?: number;
  sha256?: string;
  link?: 'refused';
}

/** The run folders of the projects: their reads and the engine's own writes into them. */
export interface RunOutputs {
  /**
   * The run folders of `runsDir` in the one order of runs (core orderRuns): its real folders (no link) named by a run
   * id. [] when the runs folder does not exist; any other failure to list it throws.
   */
  ids(runsDir: string): Promise<RunId[]>;
  /** What the folder `name` of `runsDir` holds, for a listing and for `latest` (core io readRunFolder: no link followed). */
  folder(runsDir: string, name: string, o?: RunFolderReadOptions): Promise<RunFolderFacts>;
  /** What a run folder a person named holds and its whole timeline, from one read (core io readNamedRun: through links). */
  named(dir: string): Promise<{ facts: RunFolderFacts; timeline: Read<Timeline> }>;
  /** The run.json of the run folder `dir` through the one reader (core io readRunRecord); `follow`: through a link. */
  record(dir: string, o?: { follow?: boolean }): Promise<RunRead>;
  /** The UTF-8 text of the file `file` of the run folder `dir`; undefined when it is not there. */
  readText(dir: string, file: string): Promise<string | undefined>;
  /** The bytes of the file `file` of the run folder `dir`, read as `readText` reads it; undefined when it is not there. */
  readBytes(dir: string, file: string): Promise<Uint8Array | undefined>;
  /**
   * What is at `file` of the run folder `dir`: undefined when nothing is there; a regular file's size (and, `hash`, its
   * sha256); `{}` for anything else. A link is followed only to a real path inside the run folder's real path; any
   * other link, and a file that has another name (a hard link), is `{ link: 'refused' }`.
   */
  describe(dir: string, file: string, o?: { hash?: boolean }): Promise<RunFileFacts | undefined>;
  /**
   * What tells a held read of `path` (a run folder, a file of one) that it is stale: a text that changes when it does,
   * `-` when nothing is there. Nothing is followed (a link is said as a link) but with `follow` (a watch of what a link
   * leads to: its target's text).
   */
  signature(path: string, o?: { follow?: boolean }): Promise<string>;
  /**
   * Whether runs/<id> of the project is a folder (not a link) whose real path lies inside the project's real runs
   * folder, which lies in the project: the run folders the engine's views offer as takes.
   */
  inside(projectDir: string, id: string): Promise<boolean>;
  /** Every entry name of `runsDir` (folders, links, files), in the storage's order; [] when it does not exist. */
  names(runsDir: string): Promise<string[]>;
  /** The text of the file `file` of the run folder `dir`, of at most `max` bytes (RecordFs text: `follow` or not). */
  readCapped(dir: string, file: string, o: { max: number; follow: boolean }): Promise<RecordFileText>;
  /** The bytes under `path` (a run folder, a file of one), no link followed; 0 when nothing is there. */
  size(path: string): Promise<number>;
  /** Remove the run folder `dir` and everything in it (nothing there: done). */
  remove(dir: string): Promise<void>;
  /** Remove a reserved run folder again while it is empty (a run that did not start); one that holds anything stays. */
  unreserve(dir: string): Promise<void>;
  /** A new run folder of `scenario` under `runsDir` (core io reserveRunId on this storage), named after the time `at`. */
  reserve(runsDir: string, scenario: string, at: Date): Promise<{ id: RunId; dir: string }>;
  /** Write the file `file` of the run folder `dir` atomically (its folder made); a text is written as UTF-8. */
  write(dir: string, file: string, data: string | Uint8Array): Promise<void>;
  /** Write a JSON file of the run folder (core io writeJson's form: two-space indent, a final newline). */
  writeJson(dir: string, file: string, value: unknown): Promise<void>;
}

/**
 * Whether a file has its one name only: a file with another name (a hard link, `nlink` above 1) may be any file of the
 * machine under a name in a generated folder, so neither a render's video (render-frames.ts) nor a run file's size and
 * sha256 (output-files.ts `describe`) is shown of it. The rule those two share.
 */
export function oneName(st: { nlink: number }): boolean {
  return st.nlink === 1;
}

/** What is at a path of a generated folder, no link followed: undefined when nothing is there. */
export type OutputKind = 'file' | 'folder' | 'link' | 'other';

/**
 * A generated folder of the projects (renders/, review/, exports/, .retake/inspect/): its reads, its sizes and the
 * engine's own writes and removals in it. Paths are absolute; none is followed through a link but by `readText`.
 */
export interface OutputFolder {
  /** The folder of the project `projectDir` this member holds. */
  dirOf(projectDir: string): string;
  /** The names of the entries of `dir`, in the storage's order; [] when it does not exist (or is no folder). */
  names(dir: string): Promise<string[]>;
  /** What is at `path`, no link followed. */
  kind(path: string): Promise<OutputKind | undefined>;
  /** The UTF-8 text of the file `path`; undefined when it is not there (or is a folder). */
  readText(path: string): Promise<string | undefined>;
  /** The text of a file of at most `max` bytes, as core's readers of records read one (RecordFs text: `follow` or not, never blocking). */
  readCapped(path: string, o: { max: number; follow: boolean }): Promise<RecordFileText>;
  /** The bytes under `path`: a file's size, a folder's files added up (no link followed: a link counts its own size); 0 when nothing is there. */
  size(path: string): Promise<number>;
  /** Remove a file or a folder and everything under it (nothing there: done). */
  remove(path: string): Promise<void>;
  /** Remove one file (a link is removed, never what it leads to); a folder there is a failure; nothing there is done. */
  removeFile(path: string): Promise<void>;
  /**
   * Make the folder `path` and its parents (one there already: done), inside the project `projectDir` once links are
   * followed: the nearest folder already there is checked before anything is made, the folder made after it — a link
   * out of the project is refused (EngineError `refused`) and nothing is made where it leads.
   */
  makeFolder(path: string, projectDir: string): Promise<void>;
  /** Write the file `path` atomically (its folder made); a text is written as UTF-8. */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** Write a JSON file (core io writeJson's form: two-space indent, a final newline). */
  writeJson(path: string, value: unknown): Promise<void>;
  /** What tells a held read of `path` that it is stale (`-` when nothing is there; no link followed but with `follow`). */
  signature(path: string, o?: { follow?: boolean }): Promise<string>;
  /**
   * Whether this folder of the project `projectDir` — or `path`, a folder in it — lies inside the project once links
   * are followed (both real paths; false when either cannot be resolved): a folder linked out of the project is not
   * read, written or cleaned as the project's.
   */
  within(projectDir: string, path?: string): Promise<boolean>;
}

/** renders/ of the projects: a generated folder, and its records through core's one reader of renders/. */
export interface RenderOutputs extends OutputFolder {
  /** renders/ of `dir` as a listing reads it (core io readRendersFolder: no link followed, each file within its cap); `only` picks names. */
  entries(rendersDir: string, only?: (name: string) => boolean): Promise<RenderEntry[]>;
  /** renders/<name>.json as a listing reads it (core io readListedRender: no link followed, within the cap). */
  listed(rendersDir: string, name: string): Promise<RenderEntry>;
  /** renders/<id>.json read by its id: the record's own file, never through a link, whatever its size (core io readRenderById). */
  byId(rendersDir: string, id: string): Promise<RenderEntry>;
  /**
   * The render someone named (core io findNamedRender: `latest` of a scenario, an id, or a .json / .mp4 path at a
   * terminal; an id only through MCP), or why none is.
   */
  named(rendersDir: string, arg: string, o: { verb: NamedRenderVerb; slug: string; scenario?: string; trust?: 'author' | 'mcp' }): Promise<NamedRenderFind>;
  /**
   * Take the lock file `path` (a render version's, `.<scenario>-v<N>.lock`) holding `text`, its folder made: rejects
   * with code EEXIST when anything is already there (two renders never take one version).
   */
  lock(path: string, text: string): Promise<void>;
  /** Remove the lock file `path`: a file only (a folder there is a failure, said on the job); nothing there is done. */
  unlock(path: string): Promise<void>;
}

/** The engine's generated outputs, by kind. */
export interface Outputs {
  readonly runs: RunOutputs;
  readonly renders: RenderOutputs;
  readonly reviews: OutputFolder;
  readonly exports: OutputFolder;
  readonly inspections: OutputFolder;
}

/** The runs folder of a project (runs/). */
export function runsDirOf(projectDir: string): string {
  return projectPath(projectDir, 'runs');
}

/** The run folder `id` of a project (runs/<id>): a path only, the id as the caller checked or listed it. */
export function runFolderOf(projectDir: string, id: string): string {
  return join(runsDirOf(projectDir), id);
}

/** Where each generated folder of a project is (the members' `dirOf`). */
export const OUTPUT_DIRS = {
  renders: (projectDir: string) => projectPath(projectDir, 'renders'),
  reviews: (projectDir: string) => projectPath(projectDir, 'review'),
  exports: (projectDir: string) => projectPath(projectDir, 'exports'),
  inspections: (projectDir: string) => statePath(projectDir, 'inspect'),
} as const;
