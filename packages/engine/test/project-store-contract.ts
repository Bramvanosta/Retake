/**
 * The ProjectStore port's contract (L7.10): what every adapter of `ProjectStores` does, run on the disk's
 * (project-store.test.ts) and the memory one (memory-store.test.ts). Written against the disk adapter as it was first
 * (a characterization), then run on both: the exact refusal and conflict messages (one set of words, storage.ts), and
 * one exact journal line per outcome under a ManualClock (key order included).
 *
 * A harness gives a fresh workspace (`root`, a project `acme` at `<root>/projects/acme`), a folder outside it
 * (`outside`), and how the adapter's own state is seen: the journal's lines as written, a file's bytes, the names in a
 * folder, a file put in place without the store.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOURNAL_FILES_MAX, ManualClock, callerOf, sha256Hex } from '../src/index.js';
import type { EngineError, FolderStage, ProjectStores, StoreScope } from '../src/index.js';

export interface StoreHarness {
  stores: ProjectStores;
  /** The workspace: its journal is the one written. */
  root: string;
  /** A folder outside the workspace (a components or templates folder configured elsewhere). */
  outside: string;
  /** The journal's lines as written, oldest first, without their line break. */
  lines(): Promise<string[]>;
  /** A file's bytes; undefined when there is none. */
  read(path: string): Promise<Buffer | undefined>;
  /** The names directly in a folder, sorted, the state folder (`.retake`) left out; [] when there is none. */
  list(dir: string): Promise<string[]>;
  /** Make a folder (the disk stages a new folder in an existing parent; the memory store has no folders of its own). */
  mkdir(dir: string): Promise<void>;
  /** Put a file in place without the store (no journal line). */
  seed(path: string, data: string | Buffer): Promise<void>;
  cleanup(): Promise<void>;
}

const AT = '2026-03-04T05:06:07.000Z';
const CLI = { client: 'cli', channel: 'cli', trust: 'author' };
const UI = { client: 'ui', channel: 'studio', trust: 'mcp' };

async function failure(p: Promise<unknown>): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('did not fail');
}

/** A journal line as the journal writes it: built here member by member, so the key order is asserted too. */
const line = (o: Record<string, unknown>): string => JSON.stringify({ v: 1, at: AT, ...o });

export function projectStoreContract(adapter: string, make: () => Promise<StoreHarness>): void {
  async function withStore(fn: (h: StoreHarness, scope: (caller?: 'cli' | 'ui' | 'mcp') => StoreScope, clock: ManualClock) => Promise<void>): Promise<void> {
    const h = await make();
    const clock = new ManualClock(AT);
    try {
      await fn(h, (caller = 'cli') => ({ workspace: h.root, caller: callerOf(caller), clock, stores: h.stores }), clock);
    } finally {
      await h.cleanup();
    }
  }

  describe(`the ProjectStore contract: ${adapter}`, () => {
    it('writes: created with if_match null, replaced on its hash; the result names the ref, the path, the hash and the bytes; one exact line each', async () => {
      await withStore(async (h, scope) => {
        const dir = join(h.root, 'projects', 'acme');
        const store = h.stores.of({ dir, slug: 'acme' }, scope('ui'));
        expect(store.root).toBe(dir);
        expect(store.project).toBe('acme');
        const made = await store.writeText('README.md', '# Acme\n', { ifMatch: null, what: 'readme' });
        expect(made).toEqual({ ref: 'README.md', path: join(dir, 'README.md'), sha256: sha256Hex('# Acme\n'), bytes: 7 });
        const replaced = await store.writeText('README.md', '# Acmé\n', { ifMatch: sha256Hex('# Acme\n'), what: 'readme' });
        expect(replaced).toEqual({ ref: 'README.md', path: join(dir, 'README.md'), sha256: sha256Hex('# Acmé\n'), bytes: 8 });
        expect((await h.read(join(dir, 'README.md')))?.toString('utf8')).toBe('# Acmé\n');
        expect(await store.readText('README.md')).toEqual({ text: '# Acmé\n', sha256: sha256Hex('# Acmé\n'), utf8: true });
        const nested = await store.writeFileAt(join(dir, 'scenarios', 'q.yaml'), 'video: q\n', { ifMatch: null, what: 'scenario' });
        expect(nested.ref).toBe('scenarios/q.yaml');
        expect(await h.lines()).toEqual([
          line({ by: UI, project: 'acme', op: 'write', what: 'readme', path: 'projects/acme/README.md', if_match: null, sha256: sha256Hex('# Acme\n'), bytes: 7, outcome: 'ok' }),
          line({ by: UI, project: 'acme', op: 'write', what: 'readme', path: 'projects/acme/README.md', if_match: sha256Hex('# Acme\n'), sha256: sha256Hex('# Acmé\n'), bytes: 8, outcome: 'ok' }),
          line({ by: UI, project: 'acme', op: 'write', what: 'scenario', path: 'projects/acme/scenarios/q.yaml', if_match: null, sha256: sha256Hex('video: q\n'), bytes: 9, outcome: 'ok' }),
        ]);
      });
    });

    it('conflicts: null on a file, a stale hash, a hash on no file — exact words, details.current, the file kept, one line with no sha256 each', async () => {
      await withStore(async (h, scope) => {
        const dir = join(h.root, 'projects', 'acme');
        await h.seed(join(dir, 'README.md'), '# Theirs\n');
        const current = sha256Hex('# Theirs\n');
        const store = h.stores.of({ dir, slug: 'acme' }, scope());
        const exists = await failure(store.writeText('README.md', '# Mine\n', { ifMatch: null, what: 'readme' }));
        expect([exists.name, exists.code, exists.message, exists.details, exists.fix]).toEqual(['EngineError', 'conflict', 'README.md: already exists', { current }, `read it again and pass if_match: "${current}"`]);
        const stale = await failure(store.writeText('README.md', '# Mine\n', { ifMatch: sha256Hex('stale'), what: 'readme' }));
        expect([stale.code, stale.message, stale.details, stale.fix]).toEqual(['conflict', 'README.md: changed since it was read (if_match does not match its content)', { current }, `read it again and pass if_match: "${current}"`]);
        const missing = await failure(store.writeText('notes/none.md', '# Mine\n', { ifMatch: sha256Hex('# Theirs\n'), what: 'readme' }));
        expect([missing.code, missing.message, missing.details, missing.fix]).toEqual(['conflict', 'notes/none.md: does not exist (if_match names a content it never had)', { current: null }, undefined]);
        expect((await h.read(join(dir, 'README.md')))?.toString('utf8')).toBe('# Theirs\n');
        expect(await h.read(join(dir, 'notes', 'none.md'))).toBeUndefined();
        expect(await h.lines()).toEqual([
          line({ by: CLI, project: 'acme', op: 'write', what: 'readme', path: 'projects/acme/README.md', if_match: null, outcome: 'conflict' }),
          line({ by: CLI, project: 'acme', op: 'write', what: 'readme', path: 'projects/acme/README.md', if_match: sha256Hex('stale'), outcome: 'conflict' }),
          line({ by: CLI, project: 'acme', op: 'write', what: 'readme', path: 'projects/acme/notes/none.md', if_match: current, outcome: 'conflict' }),
        ]);
      });
    });

    it('refusals: a ref that is not folder-relative in checkRef\'s words, a path outside the folder or the folder itself named by its label; none is journaled', async () => {
      await withStore(async (h, scope) => {
        const dir = join(h.root, 'projects', 'acme');
        const store = h.stores.of({ dir, slug: 'acme' }, scope());
        for (const bad of ['../x.md', '/etc/passwd', 'a\\b.md', 'a//b.md', '', './a.md', 'a/../b.md', 'C:/x.md']) {
          const e = await failure(store.writeText(bad, 'x', { ifMatch: null, what: 'readme' }));
          expect([e.code, e.message]).toEqual(['invalid', `invalid file reference "${bad}": use a path relative to the project folder, without ".." (e.g. scenarios/quote.yaml)`]);
          expect(() => store.resolve(bad)).toThrow(e.message);
          await expect(store.readText(bad)).rejects.toThrow(e.message);
        }
        const out = join(h.root, 'elsewhere.md');
        const e = await failure(store.writeFileAt(out, 'x', { ifMatch: null, what: 'readme' }));
        expect([e.code, e.message]).toEqual(['invalid', `${out} is outside the project folder ${dir}`]);
        expect(() => store.refOf(dir)).toThrow(`${dir} is the project folder itself, not a file of it`);
        expect(() => store.refOf('projects/acme/README.md')).toThrow(`projects/acme/README.md is outside the project folder ${dir}`);
        // A store with a label names its own folder.
        const components = join(h.outside, 'components');
        const c = h.stores.at(components, scope(), { label: '<components_dir>' });
        expect((await failure(c.writeFileAt(out, 'x', { ifMatch: null, what: 'component' }))).message).toBe(`${out} is outside the components folder ${components}`);
        expect(() => c.refOf(components)).toThrow(`${components} is the components folder itself, not a file of it`);
        const templates = join(h.outside, 'templates');
        expect(() => h.stores.at(templates, scope(), { label: '<templates_dir>' }).refOf(out)).toThrow(`${out} is outside the themes folder ${templates}`);
        expect(() => h.stores.at(h.root, scope()).refOf(h.outside)).toThrow(`${h.outside} is outside the project folder ${h.root}`);
        expect(() => h.stores.folder(dir).refOf(out)).toThrow(`${out} is outside the project folder ${dir}`);
        expect(await h.lines()).toEqual([]);
        expect(await h.read(out)).toBeUndefined();
      });
    });

    it('the journal: by the scope\'s caller, the project with of() or a slug, the path under its label outside the workspace, at the scope\'s clock', async () => {
      await withStore(async (h, scope, clock) => {
        const ws = h.stores.at(h.root, scope('mcp'));
        expect(ws.project).toBeUndefined();
        await ws.writeText('retake.yaml', 'version: 1\n', { ifMatch: null, what: 'workspace' });
        clock.advance(1500);
        const later = clock.now();
        const components = join(h.outside, 'components');
        await h.stores.at(components, scope('ui'), { label: '<components_dir>' }).writeText('acme/card/README.md', '# Card\n', { ifMatch: null, what: 'component' });
        await h.stores.at(join(h.outside, 'new-project'), scope(), { project: 'new-project' }).writeText('project.yaml', 'name: N\n', { ifMatch: null, what: 'project' });
        await h.stores.at(join(h.outside, 'plain'), scope()).writeText('a.txt', 'a', { ifMatch: null, what: 'sandbox' });
        const at2 = new Date(later).toISOString();
        expect(await h.lines()).toEqual([
          line({ by: { client: 'mcp', channel: 'mcp', trust: 'mcp' }, op: 'write', what: 'workspace', path: 'retake.yaml', if_match: null, sha256: sha256Hex('version: 1\n'), bytes: 11, outcome: 'ok' }),
          JSON.stringify({ v: 1, at: at2, by: UI, op: 'write', what: 'component', path: '<components_dir>/acme/card/README.md', if_match: null, sha256: sha256Hex('# Card\n'), bytes: 7, outcome: 'ok' }),
          JSON.stringify({ v: 1, at: at2, by: CLI, project: 'new-project', op: 'write', what: 'project', path: '<project>/project.yaml', if_match: null, sha256: sha256Hex('name: N\n'), bytes: 8, outcome: 'ok' }),
          JSON.stringify({ v: 1, at: at2, by: CLI, op: 'write', what: 'sandbox', path: '<store>/a.txt', if_match: null, sha256: sha256Hex('a'), bytes: 1, outcome: 'ok' }),
        ]);
      });
    });

    it('createFolder: staged under a hidden name, renamed into place, journaled with its files (at most JOURNAL_FILES_MAX, the rest counted)', async () => {
      await withStore(async (h, scope) => {
        const parent = join(h.root, 'templates');
        await h.mkdir(parent);
        const store = h.stores.at(parent, scope());
        const src = await mkdtemp(join(tmpdir(), 'retake-store-contract-src-'));
        try {
          await writeFile(join(src, 'font.ttf'), Buffer.from([0, 1, 2]));
          let seen: string[] = [];
          const made = await store.createFolder(parent, 'mine', {
            what: 'theme',
            build: async (stage: FolderStage) => {
              expect(stage.dir).toMatch(new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.tmp-mine-[0-9a-f]{12}$`));
              await stage.write('template.yaml', 'name: mine\n');
              await stage.copy('fonts/a.ttf', join(src, 'font.ttf'));
              seen = await h.list(parent);
              const twice = await failure(stage.write('template.yaml', 'again'));
              expect((twice as unknown as NodeJS.ErrnoException).code).toBe('EEXIST');
              return 'built';
            },
            recheck: async () => ({ existing: false }),
          });
          expect(seen).toEqual([expect.stringMatching(/^\.tmp-mine-[0-9a-f]{12}$/)]);
          expect(made).toEqual({ result: 'built', dir: join(parent, 'mine'), replaced: false });
          expect(await h.list(parent)).toEqual(['mine']);
          expect((await h.read(join(parent, 'mine', 'template.yaml')))?.toString('utf8')).toBe('name: mine\n');
          expect(await h.read(join(parent, 'mine', 'fonts', 'a.ttf'))).toEqual(Buffer.from([0, 1, 2]));
          // More files than a line lists; `files` says which are journaled.
          const many = Array.from({ length: JOURNAL_FILES_MAX + 2 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
          await store.createFolder(parent, 'many', {
            what: 'component',
            build: async (stage) => {
              for (const f of many) await stage.write(f, f);
            },
            recheck: async () => ({ existing: false }),
          });
          await store.createFolder(parent, 'listed', { what: 'theme', build: async (stage) => stage.write('a', 'a').then(() => ['only-this']), recheck: async () => ({ existing: false }), files: (r) => r });
          expect(await h.lines()).toEqual([
            line({ by: CLI, op: 'folder', what: 'theme', path: 'templates/mine', files: ['template.yaml', 'fonts/a.ttf'], outcome: 'ok' }),
            line({ by: CLI, op: 'folder', what: 'component', path: 'templates/many', files: many.slice(0, JOURNAL_FILES_MAX), files_more: 2, outcome: 'ok' }),
            line({ by: CLI, op: 'folder', what: 'theme', path: 'templates/listed', files: ['only-this'], outcome: 'ok' }),
          ]);
        } finally {
          await rm(src, { recursive: true, force: true });
        }
      });
    });

    it('createFolder: a failed build or recheck leaves no stage and is journaled; an existing folder is replaced whole', async () => {
      await withStore(async (h, scope) => {
        const parent = join(h.outside, 'themes');
        await h.mkdir(parent);
        const store = h.stores.at(parent, scope('ui'), { label: '<templates_dir>' });
        await h.seed(join(parent, 'mine', 'old.yaml'), 'old\n');
        await h.seed(join(parent, 'mine', 'deep', 'old.txt'), 'old\n');
        const broken = await failure(
          store.createFolder(parent, 'broken', {
            what: 'theme',
            build: async (stage) => {
              await stage.write('template.yaml', 'x');
              throw new Error('does not validate');
            },
            recheck: async () => ({ existing: false }),
          }),
        );
        expect(broken.message).toBe('does not validate');
        const taken = await failure(
          store.createFolder(parent, 'mine', {
            what: 'theme',
            build: async (stage) => stage.write('template.yaml', 'new\n'),
            recheck: async () => Promise.reject(Object.assign(new Error('mine is taken'), { errorKind: 'conflict' })),
          }),
        );
        expect(taken.message).toBe('mine is taken');
        expect(await h.list(parent)).toEqual(['mine']);
        expect(await h.list(join(parent, 'mine'))).toEqual(['deep', 'old.yaml']);
        const again = await store.createFolder(parent, 'mine', { what: 'theme', build: async (stage) => stage.write('template.yaml', 'new\n'), recheck: async () => ({ existing: true }) });
        expect(again).toEqual({ result: undefined, dir: join(parent, 'mine'), replaced: true });
        expect(await h.list(parent)).toEqual(['mine']);
        expect(await h.list(join(parent, 'mine'))).toEqual(['template.yaml']);
        expect(await h.read(join(parent, 'mine', 'old.yaml'))).toBeUndefined();
        expect(await h.lines()).toEqual([
          line({ by: UI, op: 'folder', what: 'theme', path: '<templates_dir>/broken', outcome: 'internal' }),
          line({ by: UI, op: 'folder', what: 'theme', path: '<templates_dir>/mine', outcome: 'conflict' }),
          line({ by: UI, op: 'folder', what: 'theme', path: '<templates_dir>/mine', files: ['template.yaml'], outcome: 'ok' }),
        ]);
      });
    });

    it('createFolder: a recheck that says no folder while the name holds files fails as the rename does — nothing merged, the folder kept, no stage left, journaled', async () => {
      await withStore(async (h, scope) => {
        const parent = join(h.outside, 'themes');
        await h.mkdir(parent);
        const store = h.stores.at(parent, scope('ui'), { label: '<templates_dir>' });
        await h.seed(join(parent, 'mine', 'old.yaml'), 'old\n');
        const e = (await failure(store.createFolder(parent, 'mine', { what: 'theme', build: async (stage) => stage.write('template.yaml', 'new\n'), recheck: async () => ({ existing: false }) }))) as unknown as NodeJS.ErrnoException;
        // The rename of a folder over one that holds files: ENOTEMPTY on macOS (EEXIST on some systems).
        expect(['ENOTEMPTY', 'EEXIST']).toContain(e.code);
        expect(e.message.startsWith(`${e.code}:`)).toBe(true);
        expect(await h.list(parent)).toEqual(['mine']);
        expect(await h.list(join(parent, 'mine'))).toEqual(['old.yaml']);
        expect(await h.read(join(parent, 'mine', 'template.yaml'))).toBeUndefined();
        expect(await h.lines()).toEqual([line({ by: UI, op: 'folder', what: 'theme', path: '<templates_dir>/mine', outcome: 'internal' })]);
      });
    });

    it('createFolder: two creations of one name at once — the second\'s recheck finds the first\'s folder', async () => {
      await withStore(async (h, scope) => {
        const parent = join(h.root, 'components');
        await h.mkdir(parent);
        const store = h.stores.at(parent, scope());
        const create = (text: string) =>
          store.createFolder(parent, 'card', {
            what: 'component',
            build: async (stage) => stage.write('index.tsx', text),
            recheck: async () => {
              if ((await h.list(parent)).includes('card')) throw Object.assign(new Error('card already exists'), { errorKind: 'conflict' });
              return { existing: false };
            },
          });
        const [a, b] = await Promise.allSettled([create('a'), create('b')]);
        const outcomes = [a.status, b.status].sort();
        expect(outcomes).toEqual(['fulfilled', 'rejected']);
        const lost = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
        expect((lost.reason as Error).message).toBe('card already exists');
        const won = a.status === 'fulfilled' ? 'a' : 'b';
        expect(await h.list(parent)).toEqual(['card']);
        expect((await h.read(join(parent, 'card', 'index.tsx')))?.toString('utf8')).toBe(won);
        expect((await h.lines()).sort()).toEqual(
          [line({ by: CLI, op: 'folder', what: 'component', path: 'components/card', files: ['index.tsx'], outcome: 'ok' }), line({ by: CLI, op: 'folder', what: 'component', path: 'components/card', outcome: 'conflict' })].sort(),
        );
      });
    });

    it('folder(): a missing file reads as undefined; a file\'s text, its sha256 and whether it is UTF-8', async () => {
      await withStore(async (h) => {
        const dir = join(h.root, 'projects', 'acme');
        await h.seed(join(dir, 'README.md'), '# Acme\n');
        await h.seed(join(dir, 'latin1.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        const folder = h.stores.folder(dir);
        expect(folder.root).toBe(dir);
        expect(await folder.readText('none.md')).toBeUndefined();
        expect(await folder.readText('README.md')).toEqual({ text: '# Acme\n', sha256: sha256Hex('# Acme\n'), utf8: true });
        expect(await folder.readText('latin1.md')).toEqual({ text: 'caf\uFFFD', sha256: sha256Hex(Buffer.from([0x63, 0x61, 0x66, 0xe9])), utf8: false });
        expect(folder.resolve('scenarios/q.yaml')).toBe(join(dir, 'scenarios', 'q.yaml'));
        expect(folder.refOf(join(dir, 'scenarios', 'q.yaml'))).toBe('scenarios/q.yaml');
        expect(await h.lines()).toEqual([]);
      });
    });
  });
}
