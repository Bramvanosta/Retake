/**
 * The ProjectStore port's memory adapter (store/memory-store.ts): the contract suite the disk adapter passes
 * (project-store-contract.ts), its stated limit (a `build` reading its stage from the disk fails), and the README's
 * rules through the engine on in-memory ports — conflict, creation, the cap, and project_get reading back what was
 * written — with exact journal lines under a ManualClock. One disk test of each kind stays: engine.test.ts (conflict,
 * replacement), storage-links.test.ts (a link written through), project-store.test.ts (the journal on disk).
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock, MemoryProjectStores, README_MAX_CHARS, callerOf, createEngine, sha256Hex } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { projectStoreContract } from './project-store-contract.js';

projectStoreContract('memory', async () => {
  const stores = new MemoryProjectStores();
  const base = join(sep, 'retake-memory', String(Math.random()).slice(2));
  const ws = join(base, 'ws');
  return {
    stores,
    root: ws,
    outside: join(base, 'outside'),
    lines: async () => stores.journalLines(ws).map((l) => l.replace(/\n$/, '')),
    read: async (path) => stores.files().get(path),
    list: async (dir) => [...new Set([...stores.files().keys()].filter((k) => k.startsWith(dir + sep)).map((k) => k.slice(dir.length + 1).split(sep)[0]))].sort(),
    mkdir: async () => undefined,
    seed: async (path, data) => stores.seed(path, data),
    cleanup: async () => undefined,
  };
});

async function failure(p: Promise<unknown>): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('did not fail');
}

describe('the memory store: what only the disk does', () => {
  it('a build that reads its stage from the disk fails (the stage is in memory), and leaves nothing', async () => {
    const stores = new MemoryProjectStores();
    const parent = join(sep, 'retake-memory', 'limit', 'templates');
    const store = stores.at(parent, { workspace: join(sep, 'retake-memory', 'limit'), caller: callerOf('cli'), clock: new ManualClock(), stores });
    const e = await failure(
      store.createFolder(parent, 'mine', {
        what: 'theme',
        build: async (stage) => {
          await stage.write('template.yaml', 'name: mine\n');
          return readdir(stage.dir);
        },
        recheck: async () => ({ existing: false }),
      }),
    );
    expect((e as unknown as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect([...stores.files().keys()]).toEqual([]);
    expect(stores.journal()).toEqual([expect.objectContaining({ op: 'folder', path: 'templates/mine', outcome: 'internal' })]);
    expect(existsSync(parent)).toBe(false);
  });

  it('a recheck that says no folder while the name is a file fails as the rename does (ENOTDIR): the file kept, no stage', async () => {
    const stores = new MemoryProjectStores();
    const parent = join(sep, 'retake-memory', 'file', 'templates');
    await stores.seed(join(parent, 'mine'), 'a file\n');
    const store = stores.at(parent, { workspace: join(sep, 'retake-memory', 'file'), caller: callerOf('cli'), clock: new ManualClock(), stores });
    const e = await failure(store.createFolder(parent, 'mine', { what: 'theme', build: async (stage) => stage.write('template.yaml', 'x\n'), recheck: async () => ({ existing: false }) }));
    expect((e as unknown as NodeJS.ErrnoException).code).toBe('ENOTDIR');
    expect([...stores.files().keys()]).toEqual([join(parent, 'mine')]);
    expect(stores.journal()).toEqual([expect.objectContaining({ op: 'folder', path: 'templates/mine', outcome: 'internal' })]);
  });
});

describe('the README on in-memory ports (engine.projects: updateReadme, get)', () => {
  const AT = '2026-05-06T07:08:09.000Z';
  const clock = new ManualClock(AT);
  const stores = new MemoryProjectStores();
  let root: string;
  let dir: string;
  let engine: Engine;
  const readmeLine = (o: Record<string, unknown>) => JSON.stringify({ v: 1, at: AT, by: { client: 'mcp', channel: 'mcp', trust: 'mcp' }, project: 'acme', op: 'write', what: 'readme', path: 'projects/acme/README.md', ...o });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'retake-memory-readme-'));
    dir = join(root, 'projects', 'acme');
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
    // The project loads from the disk (core loadProject); its README is the memory store's only.
    await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Acme\nenvironments:\n  local:\n    app: http://127.0.0.1:4999\n');
    engine = await createEngine({ root, client: 'mcp', autoStartWorker: false, ports: { clock, stores } });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a missing README is created (no if_match), then replaced on its hash only; get reads it back through the port', async () => {
    expect(await engine.projects.get('acme')).toMatchObject({ readme: null, readme_hash: null });
    const made = await engine.projects.updateReadme('acme', '# Acme', undefined);
    expect(made).toEqual({ file: 'README.md', path: join(dir, 'README.md'), hash: sha256Hex('# Acme\n') });
    expect(stores.files().get(join(dir, 'README.md'))?.toString('utf8')).toBe('# Acme\n');
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
    const view = await engine.projects.get('acme');
    expect([view.readme, view.readme_hash]).toEqual(['# Acme\n', sha256Hex('# Acme\n')]);
    // Exists: if_match is required, and must be its hash.
    const none = await failure(engine.projects.updateReadme('acme', '# New', undefined));
    expect([none.code, none.message, none.details]).toEqual(['conflict', 'README.md of acme exists: pass if_match with the readme_hash you read (project_get), so a change made meanwhile is not lost', { current: view.readme_hash }]);
    const stale = await failure(engine.projects.updateReadme('acme', '# New', sha256Hex('stale')));
    expect([stale.code, stale.message, stale.details]).toEqual(['conflict', 'README.md: changed since it was read (if_match does not match its content)', { current: view.readme_hash }]);
    await engine.projects.updateReadme('acme', '# New\n', view.readme_hash);
    expect((await engine.projects.get('acme')).readme).toBe('# New\n');
    expect(stores.journalLines(root).map((l) => l.trimEnd())).toEqual([
      readmeLine({ if_match: null, sha256: sha256Hex('# Acme\n'), bytes: 7, outcome: 'ok' }),
      readmeLine({ if_match: sha256Hex('stale'), outcome: 'conflict' }),
      readmeLine({ if_match: view.readme_hash, sha256: sha256Hex('# New\n'), bytes: 6, outcome: 'ok' }),
    ]);
    // Nothing reached the disk's journal.
    expect(existsSync(join(root, '.retake', 'journal.jsonl'))).toBe(false);
  });

  it('the cap holds for the file as written: README_MAX_CHARS with its final line break, refused before the store (no line)', async () => {
    const current = (await engine.projects.get('acme')).readme_hash;
    const before = stores.journalLines(root).length;
    const over = await failure(engine.projects.updateReadme('acme', 'x'.repeat(README_MAX_CHARS), current));
    expect([over.code, over.message]).toEqual(['invalid', `README.md would be ${(README_MAX_CHARS + 1).toLocaleString('en')} characters with its final line break: at most ${README_MAX_CHARS.toLocaleString('en')}`]);
    expect(stores.journalLines(root)).toHaveLength(before);
    const at = await engine.projects.updateReadme('acme', `${'x'.repeat(README_MAX_CHARS - 1)}\n`, current);
    expect(at.hash).toBe(sha256Hex(`${'x'.repeat(README_MAX_CHARS - 1)}\n`));
    expect((await engine.projects.get('acme')).readme).toHaveLength(README_MAX_CHARS);
  });
});
