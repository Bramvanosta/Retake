/**
 * The project store and the workspace journal (engine store/): every authored write goes through the store with
 * `if_match` — a hash replaces the version read, null creates — and is journaled whatever its outcome (who: the caller;
 * what: the file; when; the outcome), the line on disk before the write returns; a folder made whole is staged, renamed
 * into place and journaled with its files; the journal is append-only (one writer module, no other mode than append,
 * no delete path) and never holds a value (a hook's description, message or error); the engine's writes are journaled
 * as its caller's; and no module of the repository writes an authored file around the store.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  JOURNAL_VERSION,
  ProjectStore,
  appendJournal,
  callerOf,
  createEngine,
  fileWriter,
  hookEntry,
  hookRunRecorder,
  journalFile,
  journalPath,
  personScope,
  readJournal,
  sha256Hex,
  enginePorts,
  diskProjectStores,
  systemClock,
} from '../src/index.js';
import * as journalModule from '../src/store/journal.js';
import type { Engine, EngineError, JournalEntry } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';
import { projectStoreContract } from './project-store-contract.js';
import { scratchHome } from '@retake/test-support/home';

let root: string;
const retakeHome = scratchHome();
const lines = (): JournalEntry[] =>
  readFileSync(journalFile(root), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as JournalEntry);
const last = (): JournalEntry => lines().at(-1)!;

async function failure(p: Promise<unknown>): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('did not fail');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-project-store-'));
  retakeHome.use(join(root, '.home'));
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
  await mkdir(join(root, 'projects', 'acme'), { recursive: true });
});

afterAll(async () => {
  retakeHome.restore();
  await rm(root, { recursive: true, force: true });
});

// The port's contract on the disk adapter: a fresh workspace and a folder outside it each, the journal read as written.
projectStoreContract('disk', async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'retake-store-disk-')));
  const ws = join(base, 'ws');
  const outside = join(base, 'outside');
  await mkdir(join(ws, 'projects', 'acme'), { recursive: true });
  await mkdir(outside, { recursive: true });
  return {
    stores: diskProjectStores,
    root: ws,
    outside,
    lines: async () => (existsSync(journalFile(ws)) ? (await readFile(journalFile(ws), 'utf8')).split('\n').filter((l) => l !== '') : []),
    read: (path) => readFile(path).catch(() => undefined),
    list: async (dir) => (await readdir(dir).catch(() => [] as string[])).filter((n) => n !== '.retake').sort(),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    seed: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
});

describe('the project store', () => {
  it('a write is journaled with who, what, the hash and bytes, synced before it returns; a conflict is journaled and thrown', async () => {
    const store = diskProjectStores.of({ dir: join(root, 'projects', 'acme'), slug: 'acme' }, { workspace: root, caller: callerOf('ui'), ...enginePorts() });
    const res = await store.writeText('README.md', '# Acme\n', { ifMatch: null, what: 'readme' });
    // On disk when writeText returns (the journal is read here, synchronously, right after).
    expect(last()).toEqual({
      v: JOURNAL_VERSION,
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      by: { client: 'ui', channel: 'studio', trust: 'mcp' },
      project: 'acme',
      op: 'write',
      what: 'readme',
      path: 'projects/acme/README.md',
      if_match: null,
      sha256: sha256Hex('# Acme\n'),
      bytes: 7,
      outcome: 'ok',
    });
    expect(res.sha256).toBe(sha256Hex('# Acme\n'));
    // Its surface: no storage handed out (every write goes through the store); refs of its own folder only.
    expect('storage' in store).toBe(false);
    expect(Object.keys(store)).not.toContain('storage');
    expect(store.refOf(join(root, 'projects', 'acme', 'scenarios', 'q.yaml'))).toBe('scenarios/q.yaml');
    expect(() => store.refOf(join(root, 'elsewhere.yaml'))).toThrow();
    const e = await failure(store.writeText('README.md', '# Other\n', { ifMatch: sha256Hex('stale'), what: 'readme' }));
    expect(e.code).toBe('conflict');
    expect(last()).toMatchObject({ op: 'write', what: 'readme', path: 'projects/acme/README.md', if_match: sha256Hex('stale'), outcome: 'conflict' });
    expect(last()).not.toHaveProperty('sha256');
    expect(await readFile(join(root, 'projects', 'acme', 'README.md'), 'utf8')).toBe('# Acme\n');
    const created = await failure(store.writeText('README.md', 'again', { ifMatch: null, what: 'readme' }));
    expect(created.code).toBe('conflict');
    // The writer handed to an adapter: on the version it read (`previous`), else on the file as it is, else created.
    const write = fileWriter(store, 'sandbox');
    const readme = join(root, 'projects', 'acme', 'README.md');
    expect((await failure(write(readme, '# B\n', '# Not what is there\n'))).code).toBe('conflict');
    await write(readme, '# B\n', '# Acme\n');
    expect(last()).toMatchObject({ what: 'sandbox', if_match: sha256Hex('# Acme\n'), outcome: 'ok' });
    await write(readme, '# C\n');
    expect(last()).toMatchObject({ if_match: sha256Hex('# B\n'), outcome: 'ok' });
    await write(join(root, 'projects', 'acme', 'sandbox', 'new.yaml'), 'x: 1\n');
    expect(last()).toMatchObject({ path: 'projects/acme/sandbox/new.yaml', if_match: null, outcome: 'ok' });
  });

  it('a writer told there was no file (`previous` null) creates it, and never writes over one made in between', async () => {
    const store = diskProjectStores.of({ dir: join(root, 'projects', 'acme'), slug: 'acme' }, personScope(root, enginePorts()));
    const write = fileWriter(store, 'component');
    const fresh = join(root, 'projects', 'acme', 'notes', 'fresh.md');
    await write(fresh, '# Fresh\n', null);
    expect(last()).toMatchObject({ path: 'projects/acme/notes/fresh.md', if_match: null, outcome: 'ok' });
    // Read as missing, then made by someone else before the write: a conflict, their file kept.
    const between = join(root, 'projects', 'acme', 'notes', 'between.md');
    await mkdir(join(root, 'projects', 'acme', 'notes'), { recursive: true });
    await writeFile(between, '# Theirs\n');
    expect((await failure(write(between, '# Mine\n', null))).code).toBe('conflict');
    expect(last()).toMatchObject({ path: 'projects/acme/notes/between.md', if_match: null, outcome: 'conflict' });
    expect(await readFile(between, 'utf8')).toBe('# Theirs\n');
  });

  it('a store with a label names its own folder in a refusal: a README linked out of the components folder', async () => {
    const components = join(root, 'components');
    await mkdir(join(components, 'acme', 'card'), { recursive: true });
    await writeFile(join(root, 'outside.md'), '# Outside\n');
    await symlink(join(root, 'outside.md'), join(components, 'acme', 'card', 'README.md'));
    const write = fileWriter(diskProjectStores.at(components, personScope(root, enginePorts()), { label: '<components_dir>' }), 'component');
    const e = await failure(write(join(components, 'acme', 'card', 'README.md'), '# Card\n', '# Outside\n'));
    expect([e.code, e.message]).toEqual(['refused', `${join(components, 'acme', 'card', 'README.md')} leads out of the components folder (a symbolic link): not written`]);
    expect(await readFile(join(root, 'outside.md'), 'utf8')).toBe('# Outside\n');
    // A project's store keeps its words.
    await symlink(join(root, 'outside.md'), join(root, 'projects', 'acme', 'linked.md'));
    const p = await failure(
      fileWriter(diskProjectStores.of({ dir: join(root, 'projects', 'acme'), slug: 'acme' }, personScope(root, enginePorts())), 'readme')(
        join(root, 'projects', 'acme', 'linked.md'),
        'x',
        '# Outside\n',
      ),
    );
    expect(p.message).toMatch(/linked\.md leads out of the project folder \(a symbolic link\): not written$/);
  });

  it('a folder is staged, renamed into place and journaled with its files; a failed build leaves nothing and is journaled', async () => {
    const store = diskProjectStores.at(join(root, 'templates'), personScope(root, enginePorts()));
    await mkdir(join(root, 'templates'), { recursive: true });
    const made = await store.createFolder(join(root, 'templates'), 'mine', {
      what: 'theme',
      build: async (stage) => {
        await stage.write('template.yaml', 'name: mine\n');
        await stage.write('fonts/a.ttf', Buffer.from([0, 1, 2]));
        expect(relative(join(root, 'templates'), stage.dir)).toMatch(/^\.tmp-mine-[0-9a-f]{12}$/);
        return 'built';
      },
      recheck: async () => ({ existing: false }),
    });
    expect(made).toEqual({ result: 'built', dir: join(root, 'templates', 'mine'), replaced: false });
    expect(readdirSync(join(root, 'templates')).sort()).toEqual(['mine']);
    expect(last()).toMatchObject({
      by: { client: 'cli', channel: 'cli', trust: 'author' },
      op: 'folder',
      what: 'theme',
      path: 'templates/mine',
      files: ['template.yaml', 'fonts/a.ttf'],
      outcome: 'ok',
    });
    const e = await failure(
      store.createFolder(join(root, 'templates'), 'broken', {
        what: 'theme',
        build: async (stage) => {
          await stage.write('template.yaml', 'x');
          throw new Error('does not validate');
        },
        recheck: async () => ({ existing: false }),
      }),
    );
    expect(e.message).toBe('does not validate');
    expect(readdirSync(join(root, 'templates')).sort()).toEqual(['mine']);
    expect(last()).toMatchObject({ op: 'folder', path: 'templates/broken', outcome: 'internal' });
    // A name the recheck finds taken: refused, the stage removed.
    const taken = await failure(
      store.createFolder(join(root, 'templates'), 'mine', {
        what: 'theme',
        build: async () => undefined,
        recheck: async () => Promise.reject(Object.assign(new Error('taken'), { errorKind: 'conflict' })),
      }),
    );
    expect(taken.message).toBe('taken');
    expect(readdirSync(join(root, 'templates')).sort()).toEqual(['mine']);
    expect(last()).toMatchObject({ op: 'folder', path: 'templates/mine', outcome: 'conflict' });
  });
});

describe('the workspace journal', () => {
  it('is append-only: lines already there are kept, each write adds one; one module writes it and has no delete path', async () => {
    const before = readFileSync(journalFile(root), 'utf8');
    await appendJournal(root, { by: { client: 'cli', channel: 'cli', trust: 'author' }, op: 'write', what: 'scenario', path: 'x', outcome: 'ok' }, systemClock);
    const after = readFileSync(journalFile(root), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).split('\n').filter(Boolean)).toHaveLength(1);
    // The module's API: append, read and the names it builds — nothing that truncates, rewrites or removes.
    // journalLine formats a line (the memory store journals the same shape); appendJournal is the one that writes.
    expect(Object.keys(journalModule).sort()).toEqual([
      'JOURNAL_FILES_MAX',
      'JOURNAL_VERSION',
      'appendJournal',
      'hookEntry',
      'hookRunRecorder',
      'journalFile',
      'journalLine',
      'journalPath',
      'readJournal',
    ]);
    const src = readFileSync(join(REPO, 'packages/engine/src/store/journal.ts'), 'utf8');
    // L7.26: the journal appends and reads through the line logs' one discipline (store/append-log.ts), which the
    // history shares; neither file truncates, rewrites or removes.
    const log = readFileSync(join(REPO, 'packages/engine/src/store/append-log.ts'), 'utf8');
    for (const s of [src, log]) expect(s).not.toMatch(/\b(unlink|rm|truncate|ftruncate|writeFile|rename|copyFile)\b\s*\(/);
    expect([...src.matchAll(/\bopen\(/g)]).toHaveLength(0);
    // Two opens there: the writer's and the reader's; never a truncating or read-write mode.
    expect([...log.matchAll(/\bopen\(/g)]).toHaveLength(2);
    expect(log).not.toMatch(/O_TRUNC|'w\+?'|'r\+'/);
    // L7.34 (finding C4): what the two opens do, held by behaviour instead of their statements. A fresh journal is
    // created owner-only; each line is written whole under the journal's lock (`.retake/locks/journal.lock`) and
    // synced before appendJournal returns (the operation replies after it); a read changes nothing; the lock is gone
    // after. (A link in the journal's place is refused: "never appends through a symbolic link"; the lock's discipline
    // — stale and live holders, torn lines — is the append-log test's, for both logs.)
    const ws = await mkdtemp(join(tmpdir(), 'retake-journal-open-'));
    const probe = await open(join(ws, 'probe'), 'w');
    const handle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    await probe.close();
    const atSync: Array<{ text: string; locked: boolean }> = [];
    const realSync = handle.sync;
    const sync = vi.spyOn(handle, 'sync').mockImplementation(async function (this: unknown) {
      atSync.push({ text: existsSync(journalFile(ws)) ? readFileSync(journalFile(ws), 'utf8') : '', locked: existsSync(join(ws, '.retake', 'locks', 'journal.lock')) });
      return realSync.call(this);
    });
    try {
      await appendJournal(ws, { by: { client: 'cli', channel: 'cli', trust: 'author' }, op: 'write', what: 'scenario', path: 'whole', outcome: 'ok' }, systemClock);
      expect((await stat(journalFile(ws))).mode & 0o777).toBe(0o600);
      expect(atSync).toEqual([{ text: expect.stringMatching(/^\{.*"path":"whole".*\}\n$/), locked: true }]);
      expect(existsSync(join(ws, '.retake', 'locks', 'journal.lock'))).toBe(false);
      expect((await readJournal(ws)).map((e) => ('path' in e ? e.path : ''))).toEqual(['whole']);
      const bytes = readFileSync(journalFile(ws));
      const mtime = (await stat(journalFile(ws))).mtimeMs;
      await readJournal(ws);
      await readJournal(ws, { limit: 1 });
      expect([readFileSync(journalFile(ws)).equals(bytes), (await stat(journalFile(ws))).mtimeMs]).toEqual([true, mtime]);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
      await rm(ws, { recursive: true, force: true });
    }
    // The only module naming the journal's file (core's layout names it once).
    const naming = sourceFiles()
      .filter((f) => /WORKSPACE_JOURNAL_FILE|['"]journal\.jsonl['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f));
    expect(naming.sort()).toEqual(['packages/core/src/layout.ts', 'packages/engine/src/store/journal.ts']);
  });

  it('reads by project and kind, the newest last, skipping torn and foreign lines', async () => {
    await writeFile(journalFile(root), `${readFileSync(journalFile(root), 'utf8')}{"torn\n{"v":99,"op":"write","at":"x"}\n`);
    await hookRunRecorder(
      root,
      { caller: callerOf('mcp'), clock: systemClock },
      { project: 'acme', run: 'hooks-x' },
    )({ index: 0, name: 'reset', kind: 'http', phase: 'setup', status: 'ok', ms: 12.4 });
    const hooks = await readJournal(root, { op: 'hook' });
    expect(hooks).toEqual([
      {
        v: 1,
        at: expect.any(String),
        by: { client: 'mcp', channel: 'mcp', trust: 'mcp' },
        project: 'acme',
        op: 'hook',
        hook: 'reset',
        index: 0,
        kind: 'http',
        phase: 'setup',
        ms: 12,
        outcome: 'ok',
        run: 'hooks-x',
      },
    ]);
    expect((await readJournal(root, { op: 'write', limit: 2 })).map((e) => e.op)).toEqual(['folder', 'write']);
    expect((await readJournal(root, { project: 'acme' })).every((e) => e.project === 'acme')).toBe(true);
    expect(await readJournal(join(root, 'nowhere'))).toEqual([]);
  });

  it('a torn last line (no line break) is closed before the next append: only the torn line is lost', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'retake-journal-torn-'));
    try {
      const by = { client: 'cli', channel: 'cli', trust: 'author' } as const;
      await appendJournal(ws, { by, op: 'write', what: 'scenario', path: 'a', outcome: 'ok' }, systemClock);
      await appendFile(journalFile(ws), '{"v":1,"op":"write","at":"2026-01-01T00:00:00.000Z","by":{},"pa');
      await appendJournal(ws, { by, op: 'write', what: 'scenario', path: 'b', outcome: 'ok' }, systemClock);
      await appendJournal(ws, { by, op: 'write', what: 'scenario', path: 'c', outcome: 'ok' }, systemClock);
      expect((await readJournal(ws)).map((e) => (e.op === 'hook' ? '' : e.path))).toEqual(['a', 'b', 'c']);
      expect((await readJournal(ws, { limit: 2 })).map((e) => (e.op === 'hook' ? '' : e.path))).toEqual(['b', 'c']);
      expect(readFileSync(journalFile(ws), 'utf8').endsWith('\n')).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('never appends through a symbolic link; a failure is said at most once a minute, with the count lost', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'retake-journal-link-'));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const now = vi.spyOn(Date, 'now');
    try {
      await mkdir(join(ws, '.retake'), { recursive: true });
      await writeFile(join(ws, 'elsewhere.txt'), 'kept\n');
      await symlink(join(ws, 'elsewhere.txt'), journalFile(ws));
      const by = { client: 'cli', channel: 'cli', trust: 'author' } as const;
      const said = () => err.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('workspace journal'));
      const t0 = 4_000_000_000_000;
      now.mockReturnValue(t0);
      await appendJournal(ws, { by, op: 'write', what: 'scenario', path: 'x', outcome: 'ok' }, systemClock);
      expect(readFileSync(join(ws, 'elsewhere.txt'), 'utf8')).toBe('kept\n');
      expect(said()).toHaveLength(1);
      now.mockReturnValue(t0 + 30_000);
      await appendJournal(ws, { by, op: 'write', what: 'scenario', path: 'y', outcome: 'ok' }, systemClock);
      expect(said()).toHaveLength(1);
      now.mockReturnValue(t0 + 61_000);
      await appendJournal(ws, { by, op: 'write', what: 'scenario', path: 'z', outcome: 'ok' }, systemClock);
      expect(said()).toHaveLength(2);
      expect(said()[1]).toContain('(2 lines lost since the last warning)');
      expect(readFileSync(join(ws, 'elsewhere.txt'), 'utf8')).toBe('kept\n');
    } finally {
      err.mockRestore();
      now.mockRestore();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('a limit reads the end of the file only, and returns what a whole read would end with', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'retake-journal-tail-'));
    try {
      const by = { client: 'cli', channel: 'cli', trust: 'author' } as const;
      // Over two read chunks (64 KiB): lines of two projects, a multibyte name, a foreign line among them.
      for (let i = 0; i < 900; i++) {
        await appendJournal(ws, { by, project: i % 3 === 0 ? 'beta' : 'acme', op: 'write', what: 'scenario', path: `scenarios/é-${i}-${'x'.repeat(60)}.yaml`, outcome: 'ok' }, systemClock);
        if (i === 500) await appendFile(journalFile(ws), '{"v":99,"op":"write","at":"x"}\n');
      }
      expect(readFileSync(journalFile(ws)).length).toBeGreaterThan(2 * 64 * 1024);
      const all = await readJournal(ws, { project: 'beta' });
      for (const n of [1, 7, 150, 300, 1000]) expect(await readJournal(ws, { project: 'beta', limit: n })).toEqual(all.slice(Math.max(0, all.length - n)));
      expect(await readJournal(ws, { limit: 0 })).toEqual([]);
      expect(await readJournal(join(ws, 'nowhere'), { limit: 5 })).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("names a path workspace-relative however the workspace is spelt (its real path, a link), else by its store's label — never absolute", async () => {
    const base = await mkdtemp(join(tmpdir(), 'retake-journal-path-'));
    try {
      const ws = join(base, 'ws');
      await mkdir(join(ws, 'projects', 'acme'), { recursive: true });
      await symlink(ws, join(base, 'link'));
      const real = realpathSync(ws);
      expect(journalPath(ws, join(real, 'projects', 'acme', 'README.md'))).toBe('projects/acme/README.md');
      expect(journalPath(real, join(ws, 'projects', 'acme', 'README.md'))).toBe('projects/acme/README.md');
      expect(journalPath(ws, join(base, 'link', 'projects', 'new', 'x.yaml'))).toBe('projects/new/x.yaml');
      expect(journalPath(join(base, 'link'), join(ws, 'retake.yaml'))).toBe('retake.yaml');
      expect(journalPath(ws, ws)).toBe('.');
      const outside = join(base, 'themes');
      expect(journalPath(ws, join(outside, 'mine'), { label: '<templates_dir>', base: outside })).toBe('<templates_dir>/mine');
      expect(journalPath(ws, outside, { label: '<templates_dir>', base: outside })).toBe('<templates_dir>');
      expect(journalPath(ws, join(base, 'other', 'file.yaml'))).toBe('<outside workspace>/file.yaml');
      expect(journalPath(ws, join(ws, '..', 'ws2', 'f'))).toBe('<outside workspace>/f');

      // A store rooted at the workspace's real path (a theme edit), journaled with the workspace as it was given.
      await diskProjectStores.at(real, personScope(ws, enginePorts())).writeText('notes.md', 'x\n', { ifMatch: null, what: 'theme' });
      expect((await readJournal(ws)).at(-1)).toMatchObject({ path: 'notes.md', outcome: 'ok' });
      await diskProjectStores.at(join(base, 'link'), personScope(ws, enginePorts())).writeText('notes2.md', 'x\n', { ifMatch: null, what: 'theme' });
      expect((await readJournal(ws)).at(-1)).toMatchObject({ path: 'notes2.md', outcome: 'ok' });
      // A project and a templates folder configured outside the workspace: their labels.
      await mkdir(join(base, 'elsewhere', 'gamma'), { recursive: true });
      await diskProjectStores.of({ dir: join(base, 'elsewhere', 'gamma'), slug: 'gamma' }, personScope(ws, enginePorts())).writeText('README.md', '# G\n', { ifMatch: null, what: 'readme' });
      expect((await readJournal(ws)).at(-1)).toMatchObject({ project: 'gamma', path: '<project>/README.md' });
      await mkdir(outside, { recursive: true });
      await diskProjectStores
        .at(outside, personScope(ws, enginePorts()), { label: '<templates_dir>' })
        .createFolder(outside, 'mine', { what: 'theme', build: async (st) => st.write('template.yaml', 'name: mine\n'), recheck: async () => ({ existing: false }) });
      expect((await readJournal(ws)).at(-1)).toMatchObject({ op: 'folder', path: '<templates_dir>/mine', outcome: 'ok' });
      for (const e of await readJournal(ws)) if (e.op !== 'hook') expect(e.path.startsWith('/') || /^[A-Za-z]:/.test(e.path), e.path).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a folder's creation lock is the same however its parent is spelt (a link, its real path)", async () => {
    const base = await mkdtemp(join(tmpdir(), 'retake-journal-lock-'));
    try {
      const ws = join(base, 'ws');
      await mkdir(join(ws, 'templates'), { recursive: true });
      await symlink(ws, join(base, 'link'));
      const name = 'same';
      const seenOf = async (parent: string) => {
        let seen: string[] = [];
        await diskProjectStores
          .at(parent, personScope(ws, enginePorts()))
          .createFolder(parent, name, {
            what: 'theme',
            build: async () => undefined,
            recheck: async () => {
              seen = (await readdir(join(ws, '.retake', 'locks'))).filter((f) => f.startsWith('create-'));
              throw Object.assign(new Error('stop here'), { errorKind: 'conflict' });
            },
          })
          .catch(() => undefined);
        return seen;
      };
      const a = await seenOf(join(ws, 'templates'));
      const b = await seenOf(join(base, 'link', 'templates'));
      const c = await seenOf(realpathSync(join(ws, 'templates')));
      expect(a).toHaveLength(1);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('a hook line never holds a value: no description, message or error of the hook', () => {
    const entry = hookEntry({
      index: 1,
      name: 'seed',
      kind: 'sql',
      phase: 'seed',
      status: 'failed',
      ms: 3,
      ...{ description: 'sql INSERT … password=hunter2', message: 'secret row', error: 'token=abc' },
    } as never);
    expect(entry).toEqual({ op: 'hook', hook: 'seed', index: 1, kind: 'sql', phase: 'seed', ms: 3, outcome: 'failed' });
    expect(JSON.stringify(entry)).not.toMatch(/hunter2|secret row|token=abc/);
  });
});

describe('the engine journals its writes as its caller', () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  });

  it('a project created and its README replaced through MCP: by mcp, each file', async () => {
    await engine.projects.create({ name: 'Beta', slug: 'beta' });
    const project = (await readJournal(root, { project: 'beta', op: 'write' })).filter((e) => e.op === 'write');
    expect(project.map((e) => (e.op === 'write' ? `${e.what} ${e.path} ${e.outcome}` : ''))).toEqual([
      'project projects/beta/scenarios/.gitkeep ok',
      'project projects/beta/hooks/.gitkeep ok',
      'project projects/beta/assets/.gitkeep ok',
      'project projects/beta/project.yaml ok',
      'project projects/beta/README.md ok',
      'project projects/beta/.gitignore ok',
    ]);
    expect(project.every((e) => e.by.client === 'mcp' && e.by.trust === 'mcp')).toBe(true);
    const view = await engine.projects.get('beta');
    await engine.projects.updateReadme('beta', '# Beta', view.readme_hash);
    expect((await readJournal(root, { project: 'beta' })).at(-1)).toMatchObject({
      by: { client: 'mcp', channel: 'mcp', trust: 'mcp' },
      what: 'readme',
      path: 'projects/beta/README.md',
      if_match: view.readme_hash,
      sha256: sha256Hex('# Beta\n'),
      outcome: 'ok',
    });
  });
});

/** The expression a `.writeText(` at `at` is called on: back over balanced brackets and member accesses. */
function receiverOf(text: string, at: number): string {
  let i = at;
  let depth = 0;
  while (i > 0) {
    const c = text[i - 1];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[\w.$]/.test(c)) {
      // `new X(...)`: keep the keyword.
      if (c === ' ' && text.slice(Math.max(0, i - 4), i - 1) === 'new') i -= 4;
      break;
    }
    i--;
  }
  return text.slice(i, at).replace(/\s+/g, ' ').trim();
}

/** Every source file of the packages (not tests, not dist). */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'dist'].includes(e.name)) walk(p);
      } else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  // packages/test-support's sources are the tests' shared helpers: test code, as the test folders.
  for (const pkg of readdirSync(join(REPO, 'packages'))) if (pkg !== 'test-support' && existsSync(join(REPO, 'packages', pkg, 'src'))) walk(join(REPO, 'packages', pkg, 'src'));
  return out;
}

describe('no authored write around the store', () => {
  it('LocalStorage.writeText is called by the project store only, and the former writers write no file themselves', () => {
    const calls: string[] = [];
    for (const f of sourceFiles()) {
      const rel = relative(REPO, f);
      // The port's two adapters (disk, memory): a store writes through itself.
      if (rel === 'packages/engine/src/store/project-store.ts' || rel === 'packages/engine/src/store/memory-store.ts') continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\.writeText\(/g)) calls.push(`${rel}: ${receiverOf(text, m.index!)}`);
      if (/new LocalStorage\([^)]*\)\s*\.writeText\(/.test(text)) calls.push(`${rel}: new LocalStorage().writeText`);
    }
    // Each remaining receiver is a ProjectStore (a variable named store/storage built from one, or a call returning one:
    // storeOf, or a scope's stores' of / at).
    const bad = calls.filter((c) => !/: (navigator\.clipboard|store|storeOf\(.*\)|[\w.]*stores\.(?:of|at)\(.*\))$/.test(c));
    expect(bad).toEqual([]);
    // A `store` written through is a ProjectStore wherever it is made outside the store module (through the port).
    for (const f of sourceFiles().filter((x) => !x.endsWith('store/project-store.ts') && /\bstore\.writeText\(/.test(readFileSync(x, 'utf8')))) {
      const made = [...readFileSync(f, 'utf8').matchAll(/const store = (.+);/g)].map((m) => m[1]);
      expect(made.length, relative(REPO, f)).toBeGreaterThan(0);
      for (const m of made) expect(m, relative(REPO, f)).toMatch(/^(storeOf\(|[\w.]*stores\.(?:of|at)\()/);
    }
    // The modules that wrote authored files by hand before the store: no file write of their own left.
    const former = [
      'packages/core/src/project.ts',
      'packages/core/src/scenario.ts',
      'packages/components/src/create.ts',
      'packages/sandbox/src/init.ts',
      'packages/cli/src/commands/init.ts',
      'packages/engine/src/brand/create.ts',
      'packages/engine/src/brand/copy.ts',
    ];
    for (const f of former) expect(readFileSync(join(REPO, f), 'utf8'), f).not.toMatch(/\b(writeFile|writeFileSync|writeTextAtomic|copyFile|rename)\s*\(/);
  });
});
