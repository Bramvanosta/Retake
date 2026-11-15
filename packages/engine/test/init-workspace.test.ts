/**
 * `retake init`'s workspace (engine init-workspace.ts) on its ports: the folder read through the workspace reads (their
 * disk), the files and the `projects/` folder made through the project store — on the disk, and on a MemoryWorkspace
 * where nothing reaches the machine's disk.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INIT_WORKSPACE_YAML, ManualClock, MemoryWorkspace, enginePorts, initWorkspace } from '../src/index.js';

describe('initWorkspace on its ports', () => {
  it('on the disk: retake.yaml, .gitignore and an empty projects/ folder; a workspace already there is left as it is', async () => {
    const base = await mkdtemp(join(tmpdir(), 'retake-init-'));
    try {
      const root = join(base, 'ws');
      expect(await initWorkspace(root, enginePorts())).toEqual({ root, created: true });
      expect(await readFile(join(root, 'retake.yaml'), 'utf8')).toBe(INIT_WORKSPACE_YAML);
      expect((await stat(join(root, 'projects'))).isDirectory()).toBe(true);
      expect(existsSync(join(root, '.gitignore'))).toBe(true);
      expect(await initWorkspace(root, enginePorts())).toEqual({ root, created: false });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('in memory: the folder read from the memory disk (a file there refused, hidden files aside), the files written to the memory store', async () => {
    const m = new MemoryWorkspace();
    const ports = { clock: new ManualClock('2026-11-14T10:00:00.000Z'), stores: m.stores, reads: m.reads };
    m.seed('/mem/full/notes.txt', 'x');
    await expect(initWorkspace('/mem/full', ports)).rejects.toThrow('/mem/full is not empty and is not a workspace (no retake.yaml)');
    m.seed('/mem/file', 'x');
    await expect(initWorkspace('/mem/file', ports)).rejects.toThrow('/mem/file is not a folder');
    m.seed('/mem/hidden/.DS_Store', 'x');
    expect(await initWorkspace('/mem/hidden', ports)).toEqual({ root: '/mem/hidden', created: true });
    expect(m.stores.files().get('/mem/hidden/retake.yaml')?.toString('utf8')).toBe(INIT_WORKSPACE_YAML);
    expect(m.stores.files().has('/mem/hidden/.gitignore')).toBe(true);
    m.seed('/mem/ws/retake.yaml', 'version: 1\n');
    expect(await initWorkspace('/mem/ws', ports)).toEqual({ root: '/mem/ws', created: false });
    expect(existsSync('/mem')).toBe(false);
  });
});
