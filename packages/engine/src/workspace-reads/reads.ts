/**
 * The workspace reads as a port: what the engine knows of a workspace's folders that no store answers — its retake.yaml,
 * its projects (project.yaml, sandboxes, README, scenario names), a scenario's file, its themes and their folder ids —
 * read by core's loaders on one disk (core io reader.ts WorkspaceReader: the loaders' own code, whatever disk answers).
 * The project store (store/store.ts) is the port of the authored writes and of a folder read by ref; this one, of the
 * loaders. Chosen at the composition roots (ports.ts `enginePorts`): `diskWorkspaceReads` (disk-reads.ts) for the
 * product, `MemoryWorkspace` (memory-reads.ts) for tests. It reaches the engine's work through the opened workspace
 * (workspace.ts `OpenedWorkspace.reads`); nothing in the engine outside this folder names a loader of
 * `@retake/core/io` (the import-rules ratchet's `workspace-read` check).
 */
import type { WorkspaceReader } from '@retake/core/io';

/** The loaders on the workspace's disk, and the FileFacts the checks of its work use (`fileFacts(policy)`). */
export type WorkspaceReads = WorkspaceReader;
