/**
 * The Outputs port: what the engine generates in a project and reads back — today the run folders (runs/<id>/: run.json,
 * timeline.json, the scenario snapshot, the film), each kind a member of its own (renders, reviews, exports and
 * inspections join it, each a member beside `runs`). The project store (store/store.ts) is the port of the authored
 * writes; the workspace reads (workspace-reads/reads.ts), of the loaders; this one, of the generated outputs.
 *
 * Chosen at the composition roots (ports.ts `enginePorts`): `diskOutputs` (disk-outputs.ts) for the product,
 * `MemoryOutputs` (memory-outputs.ts) for tests. It reaches the engine's work through the opened workspace
 * (workspace.ts `OpenedWorkspace.outputs`) and, for a run, its capture request (capture/runner.ts `CaptureRequest.runs`:
 * the in-memory runner writes its run folder there). Both adapters are one implementation (output-files.ts
 * `runOutputsOn`) over a file layer of their own: core's one reader of a run folder (core io run-folder.ts) and its
 * reservation of a run id (core io reserveRunId) on either; nothing in the engine outside this folder names those
 * readers (the import-rules ratchet's `output-read` check). The same contract suite runs on both adapters
 * (engine/test/outputs-contract.ts).
 *
 * Paths are absolute, as core's readers take them and as run.json records them: a runs folder (`runsDirOf`), a run
 * folder in it, a file of the run folder named by one segment.
 */
import { projectPath } from '@retake/core/project';
import type { RunId } from '@retake/core/ids';
import type { Read, RunFolderFacts, RunRead } from '@retake/core/run';
import type { Timeline } from '@retake/core/model';

/** What a listed run folder's read may be spared (core io readRunFolder's options). */
export interface RunFolderReadOptions {
  /** Asked with the record once read: false → the timeline is not opened (core takeNeedsTimeline). */
  timeline?: (record: RunRead) => boolean;
  /** The timeline is not opened either when the folder holds no file that could be its film (prune). */
  filmFirst?: boolean;
}

/** A file of a run folder as described: when it is a regular file (through a link), its size and, asked, the sha256 of its bytes. */
export interface RunFileFacts {
  bytes?: number;
  sha256?: string;
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
  /**
   * What is at `file` of the run folder `dir`, read through a link as the run status always read it: undefined when
   * nothing is there; a regular file's size (and, `hash`, its sha256); `{}` for anything else.
   */
  describe(dir: string, file: string, o?: { hash?: boolean }): Promise<RunFileFacts | undefined>;
  /**
   * What tells a held read of `path` (a run folder, a file of one) that it is stale: a text that changes when it does,
   * `-` when nothing is there. Nothing is followed (a link is said as a link).
   */
  signature(path: string): Promise<string>;
  /**
   * Whether runs/<id> of the project is a folder (not a link) whose real path lies inside the project's real runs
   * folder, which lies in the project: the run folders the engine's views offer as takes.
   */
  inside(projectDir: string, id: string): Promise<boolean>;
  /** A new run folder of `scenario` under `runsDir` (core io reserveRunId on this storage), named after the time `at`. */
  reserve(runsDir: string, scenario: string, at: Date): Promise<{ id: RunId; dir: string }>;
  /** Write the file `file` of the run folder `dir` atomically (its folder made); a text is written as UTF-8. */
  write(dir: string, file: string, data: string | Uint8Array): Promise<void>;
  /** Write a JSON file of the run folder (core io writeJson's form: two-space indent, a final newline). */
  writeJson(dir: string, file: string, value: unknown): Promise<void>;
}

/** The engine's generated outputs, by kind (slice by slice: the runs first). */
export interface Outputs {
  readonly runs: RunOutputs;
}

/** The runs folder of a project (runs/). */
export function runsDirOf(projectDir: string): string {
  return projectPath(projectDir, 'runs');
}
