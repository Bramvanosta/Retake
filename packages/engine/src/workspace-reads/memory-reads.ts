/**
 * A workspace in memory: the WorkspaceReads port (reads.ts) and the ProjectStores port (store/store.ts) over one Map of
 * files, so what a test seeds is what the engine loads, and what the engine writes through its store is read back by
 * the next load — no folder of the disk exists for it. The reads are core's loaders on core's memoryDisk: every refusal,
 * suggestion and order is the loaders' own; the plain-file rule (a link, a folder, a size) is the one the disk's
 * readPlainFile decides by (core file-facts.ts plainFileVerdict). The same contract suite runs on both adapters
 * (engine/test/workspace-reads-contract.ts).
 *
 * Limits (what only the disk has, said so a test does not rely on the fake for it): no file modes, no special files (a
 * FIFO), no program can run (`isExecutable` is false), case counts (APFS ignores it by default), a video is probed only
 * when seeded (`video`), and the engine's reads and records that are not through a port — run folders, renders, the job
 * queue, the index, a store's `stage.copy` source, the project's record of scenario writes (a save warns that it could
 * not be written) — still go to the disk. The store does not follow the links seeded here: a write under a link's path
 * lands in the Map under the path as named (on the disk it would land where the link leads), so a test of a write
 * through a link belongs on the disk. The app-bundle check (core io insideBundle, a node real path) is not on the
 * disk port: a memory test cannot exercise that refusal. Paths are absolute and compared as written.
 */
import { normalize, sep } from 'node:path';
import type { VideoProbe } from '@retake/core/model';
import { memoryDisk, workspaceReader } from '@retake/core/io';
import { MemoryProjectStores } from '../store/memory-store.js';
import type { WorkspaceReads } from './reads.js';

export class MemoryWorkspace {
  readonly #files = new Map<string, Buffer>();
  readonly #links = new Map<string, string>();
  readonly #folders = new Set<string>();
  readonly #videos = new Map<string, VideoProbe>();
  /** The store port over the same files (its journal in memory). */
  readonly stores: MemoryProjectStores;
  /** The reads port: core's loaders on these files. */
  readonly reads: WorkspaceReads;

  constructor() {
    this.stores = new MemoryProjectStores({ files: this.#files });
    const disk = memoryDisk({ files: this.#files, links: this.#links, folders: this.#folders, videos: this.#videos });
    this.reads = workspaceReader(disk, () => disk.facts);
  }

  /** Put a file in place (absolute path; its folders exist with it); no journal line. */
  seed(path: string, data: string | Uint8Array): this {
    this.#files.set(normalize(path), Buffer.from(data));
    return this;
  }

  /**
   * A symbolic link at `path` to `target` (relative to its folder, or absolute). Refused where a file is, or under a
   * path that holds files (the Map would hold both a link and what the store wrote through its name).
   */
  link(path: string, target: string): this {
    const p = normalize(path);
    const under = p + sep;
    if ([...this.#files.keys()].some((k) => k === p || k.startsWith(under))) throw new Error(`MemoryWorkspace.link: ${p} holds files: a link cannot be put in their place`);
    this.#links.set(p, target);
    return this;
  }

  /** An empty folder. */
  folder(path: string): this {
    this.#folders.add(normalize(path));
    return this;
  }

  /** What the checks' VideoProber answers for a video file. */
  video(path: string, probe: VideoProbe): this {
    this.#videos.set(normalize(path), probe);
    return this;
  }

  /** Remove a file, a link or an empty folder. */
  remove(path: string): this {
    const p = normalize(path);
    this.#files.delete(p);
    this.#links.delete(p);
    this.#folders.delete(p);
    return this;
  }

  /** The two ports, for `createEngine({ ports })`. */
  ports(): { stores: MemoryProjectStores; reads: WorkspaceReads } {
    return { stores: this.stores, reads: this.reads };
  }
}
