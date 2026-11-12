/**
 * The WorkspaceReads port (workspace-reads/): its contract on both adapters (workspace-reads-contract.ts), and what the
 * memory one adds — one Map for the reads and the store, so what the engine writes through its store is what its next
 * load reads; the engine opened on it reads no folder of the disk. The plain-file rule both disks decide by (core
 * plainFileVerdict) and the node words of the memory disk's errors are checked here too.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plainFileVerdict } from '@retake/core/model';
import { STARTER_TEMPLATES_DIR, fsError, memoryDisk, nodeWorkspaceDisk } from '@retake/core/io';
import { memoryCopy } from '@retake/test-support/workspace';
import { ManualClock, MemoryWorkspace, createEngine, diskWorkspaceReads, enginePorts } from '../src/index.js';
import { workspaceReadsContract } from './workspace-reads-contract.js';

workspaceReadsContract('disk', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'retake-reads-')));
  return {
    reads: diskWorkspaceReads,
    root,
    write: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    link: async (path, target) => {
      await mkdir(dirname(path), { recursive: true });
      await symlink(target, path);
    },
    folder: async (path) => void (await mkdir(path, { recursive: true })),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

workspaceReadsContract('memory', async () => {
  const mem = new MemoryWorkspace();
  // The starter themes, where the loaders look for them (copied from the repository once).
  await memoryCopy(mem, STARTER_TEMPLATES_DIR);
  return {
    reads: mem.reads,
    root: join(sep, 'retake-memory', 'reads'),
    write: async (path, data) => void mem.seed(path, data),
    link: async (path, target) => void mem.link(path, target),
    folder: async (path) => void mem.folder(path),
    cleanup: async () => undefined,
  };
});

describe('the memory disk: what it answers as node does', () => {
  it('node’s words for a missing file, a folder read as a file and a file listed as a folder', async () => {
    // And (review fix) a path through a file and a link loop: ENOTDIR and ELOOP with node's errno, never ENOENT.
    const d = memoryDisk({
      files: new Map([['/m/a.txt', Buffer.from('a')]]),
      links: new Map([
        ['/m/l1', 'l2'],
        ['/m/l2', 'l1'],
      ]),
    });
    const real = await mkdtemp(join(tmpdir(), 'retake-disk-words-'));
    try {
      await writeFile(join(real, 'a.txt'), 'a');
      await symlink('l2', join(real, 'l1'));
      await symlink('l1', join(real, 'l2'));
      const both = async (f: (disk: typeof nodeWorkspaceDisk, at: string) => Promise<unknown>) => {
        const words = async (disk: typeof nodeWorkspaceDisk, at: string) =>
          f(disk, at).then(
            () => 'ok',
            (e: NodeJS.ErrnoException) => `${e.code} ${e.errno} ${e.syscall} ${e.message.split(at).join('<at>')}`,
          );
        return [await words(d, '/m'), await words(nodeWorkspaceDisk, real)];
      };
      for (const [mem, disk] of [
        await both((disk, at) => disk.readFile(join(at, 'none.txt'))),
        await both((disk, at) => disk.readFile(at)),
        await both((disk, at) => disk.list(join(at, 'a.txt'))),
        await both((disk, at) => disk.list(join(at, 'none'))),
        await both((disk, at) => disk.readFile(join(at, 'a.txt', 'x'))),
        await both((disk, at) => disk.readFile(join(at, 'l1'))),
        await both((disk, at) => disk.list(join(at, 'l1'))),
      ])
        expect(mem).toBe(disk);
      expect(fsError('ENOENT', 'open', '/x').message).toBe("ENOENT: no such file or directory, open '/x'");
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  it('the plain-file rule: not a file, then the caller’s check, then the cap — one function both disks decide by', () => {
    expect(plainFileVerdict({ isFile: false, size: 0, verified: () => false }, 10)).toBe('not_file');
    expect(plainFileVerdict({ isFile: true, size: 99, verified: () => false }, 10)).toBe('link');
    expect(plainFileVerdict({ isFile: true, size: 11 }, 10)).toBe('too_large');
    expect(plainFileVerdict({ isFile: true, size: 10 }, 10)).toBeUndefined();
    const d = memoryDisk({
      files: new Map([['/m/big', Buffer.alloc(11)]]),
      links: new Map([
        ['/m/l', 'big'],
        ['/n', '/m'],
      ]),
    });
    expect(d.readPlain('/m/big', 10)).toEqual({ ok: false, reason: 'too_large', size: 11 });
    expect(d.readPlain('/m/l', 100)).toEqual({ ok: false, reason: 'link' });
    // A link in a folder's place is followed (O_NOFOLLOW guards the last segment only), as on the disk.
    expect(d.readPlain('/n/big', 100)).toMatchObject({ ok: true });
    expect(d.readPlain('/m', 100)).toEqual({ ok: false, reason: 'not_file' });
    expect(d.readPlain('/m/none', 100)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('a MemoryWorkspace: one Map for the reads and the store', () => {
  it('a project created through the engine is written to the Map and loaded back from it; no folder of the disk is made', async () => {
    const mem = new MemoryWorkspace();
    const root = join(sep, 'retake-memory', 'engine');
    mem.seed(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
    await memoryCopy(mem, STARTER_TEMPLATES_DIR);
    const engine = await createEngine({ root, client: 'mcp', autoStartWorker: false, ports: { ...mem.ports(), clock: new ManualClock('2026-05-06T07:08:09.000Z') } });
    expect(engine.workspace.reads).toBe(mem.reads);
    const p = await engine.projects.create({ name: 'Acme', environments: { local: { app: 'http://127.0.0.1:4999' } } });
    expect([p.slug, p.dir, p.scenarios]).toEqual(['acme', join(root, 'projects', 'acme'), []]);
    expect((await engine.projects.list()).map((x) => x.slug)).toEqual(['acme']);
    const saved = await engine.scenarios.save('acme', 'first', 'video: first\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - click: Go\n', { ifMatch: null });
    expect(saved.created).toBe(true);
    expect((await engine.projects.get('acme')).scenarios).toEqual(['first']);
    expect([...mem.stores.files().keys()].filter((k) => k.startsWith(join(root, 'projects')))).toContain(join(root, 'projects', 'acme', 'scenarios', 'first.yaml'));
    expect(existsSync(root)).toBe(false);
    // The themes come from the Map too: the starters copied in, listed as the workspace's templates folder holds none.
    expect((await engine.templates.list()).templates.map((t) => t.name)).toEqual(['default', 'editorial', 'motion']);
  });

  it('a link is refused where the store has written: one Map never holds a file and a link of one name', () => {
    const mem = new MemoryWorkspace().seed('/m/p/README.md', '# x\n');
    expect(() => mem.link('/m/p/README.md', '../x')).toThrow('MemoryWorkspace.link: /m/p/README.md holds files: a link cannot be put in their place');
    expect(() => mem.link('/m/p', '/elsewhere')).toThrow('holds files');
    expect(mem.link('/m/q', '/m/p').reads.disk.facts.kind('/m/q/README.md')).toBe('file');
  });

  it('the composition roots hand the disk’s reads unless a test hands its own', () => {
    expect(enginePorts().reads).toBe(diskWorkspaceReads);
    const mem = new MemoryWorkspace();
    expect(enginePorts({ reads: mem.reads }).reads).toBe(mem.reads);
  });
});
