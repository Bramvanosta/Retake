/**
 * R-SHR-40…44: a project archive with its sandbox (`--with-sandbox`), on the disk, Docker replaced by the memory share
 * of the Sandboxes port (the sandbox package's tests hold the tar check and docker load's answer):
 * - export: the compose file outside the project copied next to sandbox.yaml (`compose-files/`), the archive's
 *   sandbox.yaml naming it there; the env file (named settings.txt: by path, not by name), the compose secrets and a
 *   service's env file never in it, their key names listed; bind mounts and the build context listed, never copied;
 *   each image saved by id into `images/sha256-<hex>.tar.gz`, its platform and size said; a built image this machine
 *   does not hold refused with the fix; `--with-env` carries the env file (origin env);
 * - MCP never takes the sandbox nor an env file (refused; not in its schema);
 * - import: the images extracted to the workspace's state, never the project, nothing loaded; an env file in an
 *   archive only when its manifest says a person carried it;
 * - trust loads them (never before): the ids expected, tagged `retake-share-<slug>-…`, the compose override written
 *   (`build: !reset null`, `pull_policy: never`); Docker down, an old Compose or another id loaded: the images wait;
 *   a start of the sandbox is refused while they wait; discard removes the extracted images.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseYaml } from '@retake/core/base';
import { sandboxImagesOverride } from '@retake/core/project';
import type { ImageFacts, ShareFacts } from '@retake/sandbox/types';
import { createZip } from '../src/archive/zip-write.js';
import { openZip } from '../src/archive/zip-read.js';
import { createEngine } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { OPERATIONS_BY_NAME } from '../src/operations/index.js';
import { guardUntrusted } from '../src/project-archive/guard.js';
import type { ProjectManifest } from '../src/project-archive/manifest.js';
import { importImagesDir } from '../src/project-archive/trust.js';
import type { ProductAdapters } from '../src/ports.js';
import { MemorySandboxShare, MemorySandboxes } from '../src/sandboxes/memory-sandboxes.js';
import type { MemoryShareOptions } from '../src/sandboxes/memory-sandboxes.js';

let root: string;
let other: string;
const proj = (slug = 'demo', at = root) => join(at, 'projects', slug);
const APP = `sha256:${'a'.repeat(64)}`;
const MAIL = `sha256:${'b'.repeat(64)}`;
const SECRET = 'planted-secret-value';

async function write(file: string, text: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** demo: a docker-compose sandbox whose main compose file lies outside the project (the product's infra folder). */
async function demo(): Promise<void> {
  const p = proj();
  await write(join(p, 'project.yaml'), 'name: Demo\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n');
  await write(
    join(p, 'sandbox', 'sandbox.yaml'),
    '# the demo sandbox\nversion: 1\nprovider: docker-compose\ncompose:\n  files: [../../../infra/compose.yaml, ../../../infra/compose.local.yaml]\n  env_file: settings.txt\nservices:\n  app: {url: "http://127.0.0.1:4631", pages: {app: "http://127.0.0.1:4631"}}\n',
  );
  await write(join(root, 'infra', 'compose.local.yaml'), 'services:\n  app:\n    env_file: app.env\n');
  await write(join(root, 'infra', 'app.env'), `SERVICE_TOKEN=${SECRET}-2\n`);
  await write(join(p, 'sandbox', 'settings.txt'), `DB_PASSWORD=${SECRET}\nAPP_TAG=1\n`);
  await write(join(p, 'sandbox', 'app.env'), `SERVICE_TOKEN=${SECRET}-2\n`);
  await write(join(p, 'sandbox', 'secrets', 'db.txt'), `${SECRET}-3\n`);
  await write(join(root, 'infra', 'compose.yaml'), 'services:\n  app:\n    build: ../app-src\n    ports: ["4631:80"]\n    volumes: [../data:/data]\n  mail:\n    image: axllent/mailpit:v1.29.4\n');
}

/** What docker would say of demo's sandbox (the memory share's answers). */
function facts(): ShareFacts {
  // As docker gives them: real paths (/private/var… on a Mac), which the export spells as the project's own.
  const real = realpathSync(root);
  const s = join(real, 'projects', 'demo', 'sandbox');
  return {
    project: 'retake-demo-sbx-12345678',
    files: [join(real, 'infra', 'compose.yaml'), join(s, 'compose.local.yaml')],
    envFile: join(s, 'settings.txt'),
    envKeys: ['DB_PASSWORD', 'APP_TAG'],
    services: [
      {
        name: 'app',
        image: 'retake-demo-sbx-12345678-app',
        build: join(real, 'app-src'),
        binds: [{ source: join(real, 'data'), target: '/data' }],
        envFiles: [join(s, 'app.env')],
        envFileKeys: [{ file: join(s, 'app.env'), keys: ['SERVICE_TOKEN'] }],
      },
      { name: 'mail', image: 'axllent/mailpit:v1.29.4', binds: [], envFiles: [], envFileKeys: [] },
    ],
    secretFiles: [join(s, 'secrets', 'db.txt')],
    configFiles: [],
    includes: [],
  };
}

const IMAGES: Record<string, ImageFacts> = {
  'retake-demo-sbx-12345678-app': { id: APP, os: 'linux', arch: 'arm64', size: 412_000_000 },
  'axllent/mailpit:v1.29.4': { id: MAIL, os: 'linux', arch: 'arm64', size: 38_000_000 },
};

async function engineWith(at: string, client: 'cli' | 'mcp', share: MemorySandboxShare): Promise<Engine> {
  return createEngine({ root: at, client, autoStartWorker: false, ports: { sandboxes: new MemorySandboxes({ share }) } });
}

const shareOf = (o: MemoryShareOptions = {}) => new MemorySandboxShare({ compose: { sbx: facts() }, images: IMAGES, ...o });

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}

/** The entries of an archive: names, the manifest, every byte, one entry's text. */
async function contents(file: string): Promise<{ names: string[]; manifest: ProjectManifest; bytes: Buffer; text: (name: string) => Promise<string> }> {
  const z = await openZip(file, { entryMax: () => Number.MAX_SAFE_INTEGER });
  const all: Buffer[] = [];
  const byName = new Map<string, Buffer>();
  for (const e of z.entries) {
    const b = await z.readAll(e, 1 << 28);
    all.push(b);
    byName.set(e.name, b);
  }
  await z.close();
  const manifest = JSON.parse(byName.get('retake-project.json')!.toString('utf8')) as ProjectManifest;
  return { names: [...byName.keys()], manifest, bytes: Buffer.concat(all), text: async (n) => byName.get(n)?.toString('utf8') ?? '' };
}

/** The archive again with its manifest changed and entries renamed (`from` → `to`: a project path), sorted, the manifest last. */
async function repack(file: string, change: (m: ProjectManifest) => void, rename: Record<string, string> = {}): Promise<string> {
  const z = await openZip(file, { entryMax: () => Number.MAX_SAFE_INTEGER });
  const out = join(dirname(file), `repacked-${Math.random().toString(16).slice(2)}.zip`);
  const w = await createZip(out, { limits: { entryMax: () => Number.MAX_SAFE_INTEGER } });
  const items: Array<{ name: string; data: Buffer; mode: 0o644 | 0o755 }> = [];
  let manifest: ProjectManifest | undefined;
  for (const e of z.entries) {
    if (e.dir) continue;
    const b = await z.readAll(e, 1 << 28);
    if (e.name === 'retake-project.json') manifest = JSON.parse(b.toString('utf8')) as ProjectManifest;
    else items.push({ name: rename[e.name.replace(/^project\//, '')] ? `project/${rename[e.name.replace(/^project\//, '')]}` : e.name, data: b, mode: e.mode === 0o755 ? 0o755 : 0o644 });
  }
  await z.close();
  for (const f of manifest!.files) f.path = rename[f.path] ?? f.path;
  change(manifest!);
  items.sort((a, b) => (a.name < b.name ? -1 : 1));
  const mtime = new Date('2026-11-18T00:00:00Z');
  for (const i of items) await w.add(i.name, { data: i.data }, { mode: i.mode, mtime });
  await w.add('retake-project.json', { data: Buffer.from(JSON.stringify(manifest)) }, { mode: 0o644, mtime });
  await w.close();
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-share-a-'));
  other = await mkdtemp(join(tmpdir(), 'retake-share-b-'));
  for (const r of [root, other]) {
    await writeFile(join(r, 'retake.yaml'), 'projects_dir: projects\n');
    await mkdir(join(r, 'projects'), { recursive: true });
  }
  await demo();
});

afterEach(async () => {
  for (const r of [root, other]) if (r) await rm(r, { recursive: true, force: true });
});

describe('export --with-sandbox (R-SHR-40, R-SHR-41, R-SHR-42, R-SHR-43)', () => {
  it("copies the outside compose file and rewrites sandbox.yaml's paths; never an env file, secret or service env file; images saved by id", async () => {
    const share = shareOf();
    const cli = await engineWith(root, 'cli', share);
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const c = await contents(r.file!);
    expect(c.names).toEqual(
      expect.arrayContaining([
        `images/sha256-${'a'.repeat(64)}.tar.gz`,
        `images/sha256-${'b'.repeat(64)}.tar.gz`,
        'project/sandbox/compose-files/compose.yaml',
        'project/sandbox/compose-files/compose.local.yaml',
        'project/sandbox/sandbox.yaml',
      ]),
    );
    // The images first, the manifest last.
    expect(c.names[0]).toMatch(/^images\//);
    expect(c.names.at(-1)).toBe('retake-project.json');
    // sandbox.yaml names the copy (comments kept); the copy is the outside file, byte for byte.
    const sb = await c.text('project/sandbox/sandbox.yaml');
    expect(sb).toContain('# the demo sandbox');
    expect((parseYaml(sb).value as { compose: unknown }).compose).toEqual({ files: ['compose-files/compose.yaml', 'compose-files/compose.local.yaml'], env_file: 'settings.txt' });
    expect(await c.text('project/sandbox/compose-files/compose.yaml')).toBe(await readFile(join(root, 'infra', 'compose.yaml'), 'utf8'));
    // No value of the env file (named settings.txt) or the service's env file anywhere.
    expect(c.bytes.includes(Buffer.from(SECRET))).toBe(false);
    expect(c.names.some((n) => /settings\.txt|app\.env|db\.txt/.test(n))).toBe(false);
    const part = c.manifest.sandbox?.[0];
    expect(part).toMatchObject({
      env: 'sbx',
      provider: 'docker-compose',
      copied: [
        { from: '../../infra/compose.yaml', to: 'sandbox/compose-files/compose.yaml' },
        { from: '../../infra/compose.local.yaml', to: 'sandbox/compose-files/compose.local.yaml' },
      ],
      rewritten: ['sandbox/sandbox.yaml'],
      env_file: { path: 'sandbox/settings.txt', keys: ['DB_PASSWORD', 'APP_TAG'], included: false },
      service_env_files: [{ service: 'app', path: '../../infra/app.env', keys: ['SERVICE_TOKEN'], expected_at: 'sandbox/compose-files/app.env' }],
      host_mounts: [{ service: 'app', source: '../../data', target: '/data', expected_at: 'sandbox/data' }],
      images: [
        { service: 'app', name: 'retake-demo-sbx-12345678-app', id: APP },
        { service: 'mail', name: 'axllent/mailpit:v1.29.4', id: MAIL },
      ],
    });
    expect(part?.outside).toEqual(expect.arrayContaining([{ ref: '../../app-src', what: expect.stringMatching(/build context of service app \(never carried: its image is\)/) }]));
    expect(c.manifest.options).toEqual({ with_runs: false, with_sandbox: true, with_env: false, images: true });
    expect(c.manifest.images?.map((i) => [i.id, i.platform, i.size])).toEqual([
      [APP, 'linux/arm64', 412_000_000],
      [MAIL, 'linux/arm64', 38_000_000],
    ]);
    // Saved by id, with --platform (the docker here takes it).
    expect(share.calls.filter((x) => x.op === 'save').map((x) => x.args)).toEqual([
      [APP, 'linux/arm64'],
      [MAIL, 'linux/arm64'],
    ]);
    expect(r.images?.map((i) => i.services)).toEqual([['sbx/app'], ['sbx/mail']]);
    expect(c.manifest.code_files).toContain('sandbox/compose-files/compose.yaml');
  });

  it('a built image this machine does not hold is refused with the fix; --no-images is refused for a built service', async () => {
    const cli = await engineWith(root, 'cli', shareOf({ images: { 'axllent/mailpit:v1.29.4': IMAGES['axllent/mailpit:v1.29.4']! } }));
    const e = await refusal(cli.projects.exportArchive({ project: 'demo', withSandbox: true, dryRun: true }));
    expect(e.message).toMatch(
      /the image of service app .* is not on this machine — it is built from \.\.\/\.\.\/app-src, which an archive never carries: retake sandbox up demo --env sbx --build first, or export with --no-images/,
    );
    expect((await refusal(cli.projects.exportArchive({ project: 'demo', withSandbox: true, images: false }))).message).toMatch(/services\.app: it is built, and --no-images carries no image for it/);
  });

  it('--with-env carries the env file (origin env), a person only; MCP never takes the sandbox', async () => {
    const share = shareOf();
    const cli = await engineWith(root, 'cli', share);
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true, withEnv: true });
    const c = await contents(r.file!);
    expect(c.manifest.files.find((f) => f.path === 'sandbox/settings.txt')?.origin).toBe('env');
    expect(c.manifest.options.with_env).toBe(true);
    expect(c.bytes.includes(Buffer.from(`DB_PASSWORD=${SECRET}`))).toBe(true);
    // Still never the service's env file.
    expect(c.bytes.includes(Buffer.from(`${SECRET}-2`))).toBe(false);
    const mcp = await engineWith(root, 'mcp', share);
    expect((await refusal(mcp.projects.exportArchive({ project: 'demo', withSandbox: true }))).message).toMatch(/through MCP a project is exported without its sandbox/);
    expect((await refusal(mcp.projects.exportArchive({ project: 'demo', withEnv: true }))).message).toMatch(/through MCP/);
    expect((await refusal(cli.projects.exportArchive({ project: 'demo', withEnv: true }))).message).toMatch(/goes with --with-sandbox/);
    const shape = Object.keys((OPERATIONS_BY_NAME.project_export as unknown as { input: { shape: Record<string, unknown> } }).input.shape);
    expect(shape.sort()).toEqual(['dry_run', 'project']);
  });
});

describe('import and trust (R-SHR-44)', () => {
  async function exported(o: { withEnv?: boolean } = {}): Promise<string> {
    const cli = await engineWith(root, 'cli', shareOf());
    return (await cli.projects.exportArchive({ project: 'demo', withSandbox: true, ...(o.withEnv ? { withEnv: true } : {}) })).file!;
  }

  it('extracts the images to the workspace state, never the project; nothing loaded until trust, then loaded, tagged and overridden', async () => {
    const file = await exported();
    const share = shareOf();
    const there = await engineWith(other, 'cli', share);
    const imp = await there.projects.importArchive(file, { as: 'shared' });
    expect(imp.images.map((i) => i.services)).toEqual([['sbx/app'], ['sbx/mail']]);
    expect(imp.sandbox_notes.join('\n')).toMatch(/service app mounts \.\.\/\.\.\/data at \/data \(not carried: put that folder at sandbox\/data, or the mount is empty\)/);
    expect(imp.sandbox_notes.join('\n')).toMatch(/its env file is not carried: put it at sandbox\/settings\.txt \(keys DB_PASSWORD, APP_TAG\)/);
    const imagesDir = importImagesDir(other, 'shared');
    expect((await readdir(imagesDir)).sort()).toEqual([`sha256-${'a'.repeat(64)}.tar.gz`, `sha256-${'b'.repeat(64)}.tar.gz`]);
    expect(existsSync(join(proj('shared', other), 'images'))).toBe(false);
    expect(share.calls.some((x) => x.op === 'load' || x.op === 'tag')).toBe(false);
    // Not before trust.
    expect((await refusal(there.projects.loadImages('shared'))).message).toMatch(/is not trusted: its images are loaded once a person trusts it/);
    const view = await there.projects.trustView('shared');
    expect(view.images.map((i) => [i.id, i.loaded])).toEqual([
      [APP, false],
      [MAIL, false],
    ]);
    await there.projects.trust('shared', view);
    const r = await there.projects.loadImages('shared');
    expect(r.waiting).toBeUndefined();
    expect(share.calls.filter((x) => x.op === 'load').map((x) => (x.args[1] as string[])[0])).toEqual([APP, MAIL]);
    expect([...share.tags.entries()].sort()).toEqual([
      [`retake-share-shared-sbx-app:${'a'.repeat(64)}`, APP],
      [`retake-share-shared-sbx-mail:${'b'.repeat(64)}`, MAIL],
    ]);
    const override = await readFile(sandboxImagesOverride(proj('shared', other), 'sbx'), 'utf8');
    // (A YAML reader without compose's tags reads `!reset null` as the text "null".)
    expect(parseYaml(override).value).toEqual({
      services: {
        app: { image: `retake-share-shared-sbx-app:${'a'.repeat(64)}`, build: 'null', pull_policy: 'never' },
        mail: { image: `retake-share-shared-sbx-mail:${'b'.repeat(64)}`, build: 'null', pull_policy: 'never' },
      },
    });
    expect(override.match(/build: !reset null/g)).toHaveLength(2);
    expect((await there.projects.trustView('shared')).images.every((i) => i.loaded)).toBe(true);
    expect(existsSync(imagesDir)).toBe(false);
    expect((await there.projects.loadImages('shared')).loaded).toEqual([]);
  });

  it('the images wait when Docker is down, Compose is older than v2.24, or docker loads another id', async () => {
    const file = await exported();
    for (const [o, words] of [
      [{ docker: new Error('the Docker daemon is not running') }, /Docker is not ready \(the Docker daemon is not running\)/],
      [{ docker: { compose: '2.20.0', server: '24.0.0', platform: 'linux/arm64', savePlatform: false } }, /needs Docker Compose v2\.24\.0 or later .* this one is 2\.20\.0/],
      [{ loads: () => [`sha256:${'e'.repeat(64)}`] }, /the image aaaaaaaaaaaa is refused \(docker load refused: it loaded sha256:e+/],
      [{ tamper: true }, /the image aaaaaaaaaaaa is refused \(the image file is refused, nothing loaded: the file does not hold the bytes recorded at import \(sha256\)\)/],
    ] as const) {
      await rm(proj('shared', other), { recursive: true, force: true });
      await rm(join(other, '.retake'), { recursive: true, force: true });
      const share = shareOf(o as MemoryShareOptions);
      const there = await engineWith(other, 'cli', share);
      await there.projects.importArchive(file, { as: 'shared' });
      await there.projects.trust('shared', await there.projects.trustView('shared'));
      if ('tamper' in o) await writeFile(join(importImagesDir(other, 'shared'), `sha256-${'a'.repeat(64)}.tar.gz`), 'swapped');
      const r = await there.projects.loadImages('shared');
      expect(r.waiting).toMatch(words);
      expect(r.waiting).toMatch(/the images wait: retake project trust shared --images loads them/);
      expect(share.tags.size).toBe(0);
      expect(existsSync(sandboxImagesOverride(proj('shared', other), 'sbx'))).toBe(false);
      expect((await there.projects.trustView('shared')).images.some((i) => i.loaded)).toBe(false);
    }
  });

  it('a start of the sandbox is refused while its images wait; status and down pass; discard removes the extracted images', async () => {
    const file = await exported();
    const share = shareOf();
    const there = await engineWith(other, 'cli', share);
    await there.projects.importArchive(file, { as: 'shared' });
    await there.projects.trust('shared', await there.projects.trustView('shared'));
    const calls: string[] = [];
    const rec = (what: string) => async () => (calls.push(what), {}) as never;
    const handle = { env: 'sbx', up: rec('up'), prepareTake: rec('prepareTake'), reset: rec('reset'), down: rec('down'), status: rec('status') };
    const base = {
      hooks: { run: rec('hooks.run') },
      reviewer: {},
      capture: { run: rec('capture.run'), record: rec('record'), sessions: { check: rec('check'), signIn: rec('signIn') }, hookPages: { open: rec('hookPages.open') } },
      sandboxes: { open: async () => handle, init: rec('init') },
      renderer: { video: rec('video'), stills: rec('stills'), previews: { bundle: rec('bundle') } },
      registries: {},
    };
    const g = guardUntrusted(base as unknown as ProductAdapters, process.env);
    const project = { root: other, dir: proj('shared', other), slug: 'shared', config: { sandboxes: { sbx: 'sandbox/sandbox.yaml' } }, sandboxes: {} };
    const h = await g.sandboxes.open(project as never, undefined, {} as never);
    for (const m of ['up', 'prepareTake', 'reset'] as const)
      expect((await refusal(h[m]())).message).toMatch(/runs the images its project archive carried, and they are not loaded yet: .*retake project trust shared --images/);
    await h.status();
    await h.down();
    expect(calls).toEqual(['status', 'down']);
    await there.projects.loadImages('shared');
    await (await g.sandboxes.open(project as never, undefined, {} as never)).up();
    expect(calls).toEqual(['status', 'down', 'up']);
    // Discard (a second import, untrusted): its extracted images go.
    await there.projects.importArchive(file, { as: 'second' });
    expect(existsSync(importImagesDir(other, 'second'))).toBe(true);
    await there.projects.discardImport('second');
    expect(existsSync(importImagesDir(other, 'second'))).toBe(false);
  });

  it('an env file is imported only when the manifest says a person carried it', async () => {
    const withEnv = await exported({ withEnv: true });
    const there = await engineWith(other, 'cli', shareOf());
    await there.projects.importArchive(withEnv, { as: 'with-env' });
    expect(await readFile(join(proj('with-env', other), 'sandbox', 'settings.txt'), 'utf8')).toContain('DB_PASSWORD=');
    // The env file under an env file's name (.env): refused unless the manifest says a person carried it, as such.
    const renamed = { 'sandbox/settings.txt': 'sandbox/.env' };
    const asEnv = await repack(withEnv, () => undefined, renamed);
    await there.projects.importArchive(asEnv, { as: 'as-env' });
    expect(existsSync(join(proj('as-env', other), 'sandbox', '.env'))).toBe(true);
    const forged = await repack(
      withEnv,
      (m) => {
        m.options.with_env = false;
      },
      renamed,
    );
    expect((await refusal(there.projects.importArchive(forged, { as: 'forged' }))).message).toMatch(/holds an env file \(\.env\*\): sandbox\/\.env$/);
    const relabelled = await repack(
      withEnv,
      (m) => {
        for (const f of m.files) if (f.origin === 'env') f.origin = 'project';
      },
      renamed,
    );
    expect((await refusal(there.projects.importArchive(relabelled, { as: 'relabelled' }))).message).toMatch(/holds an env file/);
    // An origin env without with_env, whatever the name.
    const unsaid = await repack(withEnv, (m) => {
      m.options.with_env = false;
    });
    expect((await refusal(there.projects.importArchive(unsaid, { as: 'unsaid' }))).message).toMatch(/sandbox\/settings\.txt \(its manifest does not say a person carried it\)/);
  });
});
