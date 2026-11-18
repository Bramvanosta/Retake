/**
 * At a terminal, with the sandbox (R-SHR-41, R-SHR-42, R-SHR-44): `retake project export --with-sandbox` says the
 * images (count, platform, sizes) and what it copies, mounts and leaves out before writing; `--with-env` asks a y/N
 * naming the env file and its key count (no terminal: refused; a no: nothing written); `retake project trust` loads the
 * images after its yes (`--no-images`: they wait; `--images` asks again, then loads). In process (main + memoryIo),
 * the Sandboxes port's memory share in place of Docker.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { productPorts } from '@retake/compose';
import { sandboxImagesOverride } from '@retake/core/project';
import { MemorySandboxShare, MemorySandboxes } from '@retake/engine/testing';
import { EXIT, main, memoryIo } from '../src/index.js';

let a: string;
let b: string;
const proj = (root: string, slug = 'demo') => join(root, 'projects', slug);
const PERSON = { ...process.env, CLAUDECODE: undefined, RETAKE_AGENT: undefined };
const APP = `sha256:${'a'.repeat(64)}`;

async function write(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function share(o: { tagFails?: string; inspectFails?: string } = {}): MemorySandboxShare {
  return new MemorySandboxShare({
    compose: {
      sbx: {
        project: 'retake-demo-sbx-1',
        files: [join(a, 'infra', 'compose.yaml')],
        envFile: join(a, 'infra', '.env'),
        envKeys: ['DB_PASSWORD', 'APP_TAG'],
        services: [{ name: 'app', image: 'retake-demo-sbx-1-app', build: join(a, 'app-src'), binds: [{ source: join(a, 'data'), target: '/data' }], envFiles: [], envFileKeys: [] }],
        secretFiles: [],
        configFiles: [],
        includes: [],
      },
    },
    images: { 'retake-demo-sbx-1-app': { id: APP, os: 'linux', arch: 'arm64', size: 412_000_000 } },
    ...o,
  });
}

async function retake(root: string, args: string[], o: { answers?: string[]; share?: MemorySandboxShare } = {}) {
  const io = memoryIo(o.answers ? { answers: o.answers } : {});
  const ports = productPorts({ env: PERSON, sandboxes: new MemorySandboxes({ share: o.share ?? share() }) });
  const code = await main(['node', 'retake', '--root', root, ...args], io, ports);
  return { code, out: io.stdout(), err: io.stderr(), text: io.stdout() + io.stderr(), questions: io.questions() };
}

beforeEach(async () => {
  a = await mkdtemp(join(tmpdir(), 'retake-share-cli-a-'));
  b = await mkdtemp(join(tmpdir(), 'retake-share-cli-b-'));
  for (const r of [a, b]) {
    await writeFile(join(r, 'retake.yaml'), 'projects_dir: projects\n');
    await mkdir(join(r, 'projects'), { recursive: true });
  }
  await write(join(proj(a), 'project.yaml'), 'name: Demo\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n');
  await write(
    join(proj(a), 'sandbox', 'sandbox.yaml'),
    'version: 1\nprovider: docker-compose\ncompose:\n  files: [../../../infra/compose.yaml]\n  env_file: ../../../infra/.env\nservices:\n  app: {url: "http://127.0.0.1:4632", pages: {app: "http://127.0.0.1:4632"}}\n',
  );
  await write(join(a, 'infra', '.env'), 'DB_PASSWORD=never-printed\nAPP_TAG=1\n');
  await write(join(a, 'infra', 'compose.yaml'), 'services:\n  app:\n    build: ../app-src\n    volumes: [../data:/data]\n');
});

afterEach(async () => {
  for (const r of [a, b]) await rm(r, { recursive: true, force: true });
});

const zips = async () => (await readdir(join(proj(a), 'exports')).catch(() => [] as string[])).filter((f) => f.endsWith('.zip'));

describe('retake project export --with-sandbox', () => {
  it('says the images, the copies, the mounts and the env keys before writing; never a value', async () => {
    const r = await retake(a, ['project', 'export', 'demo', '--with-sandbox', '--dry-run']);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.text).toMatch(/sandbox images: 1 \(linux\/arm64\), about 412 MB before compression — sbx\/app 412 MB linux\/arm64/);
    expect(r.text).toMatch(/sandbox sbx: \.\.\/\.\.\/infra\/compose\.yaml copied as sandbox\/compose-files\/compose\.yaml/);
    expect(r.text).toMatch(/sandbox sbx: env file sandbox\/compose-files\/\.env — not carried \(2 keys: DB_PASSWORD, APP_TAG\)/);
    expect(r.text).toMatch(/service app mounts \.\.\/\.\.\/data \(\/data\) — a folder of this machine, never carried: the importer puts one at sandbox\/data/);
    expect(r.text).toMatch(/service app mounts \.\.\/\.\.\/data \(\/data\) — a folder of this machine, never carried/);
    expect(r.text).toMatch(/the importer's Compose must be v2\.24 or later/);
    expect(r.text).not.toContain('never-printed');
    expect(await zips()).toEqual([]);
  });

  it('--with-env asks a y/N naming the file and its key count; no terminal or a no writes nothing', async () => {
    const none = await retake(a, ['project', 'export', 'demo', '--with-sandbox', '--with-env']);
    expect(none.code).not.toBe(EXIT.ok);
    expect(none.err).toMatch(/takes a person's yes at a terminal/);
    const no = await retake(a, ['project', 'export', 'demo', '--with-sandbox', '--with-env'], { answers: ['n'] });
    expect(no.code).not.toBe(EXIT.ok);
    // The file read on this machine, named as it is, and where it goes.
    expect(no.questions).toEqual([
      expect.stringMatching(/The archive will hold \.\.\/\.\.\/infra\/\.env \(as sandbox\/compose-files\/\.env, 2 keys\) with its values, in clear, for whoever gets the file: carry it\?/),
    ]);
    expect(await zips()).toEqual([]);
    const yes = await retake(a, ['project', 'export', 'demo', '--with-sandbox', '--with-env'], { answers: ['y'] });
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.text).toMatch(/env file sandbox\/compose-files\/\.env — CARRIED, with its values/);
    expect(await zips()).toHaveLength(1);
  });
});

describe('retake project trust: the images loaded after the yes', () => {
  async function imported(o: { tagFails?: string; inspectFails?: string } = {}): Promise<MemorySandboxShare> {
    const r = await retake(a, ['project', 'export', 'demo', '--with-sandbox', '--json']);
    expect(r.code, r.err).toBe(EXIT.ok);
    const file = JSON.parse(r.out).file as string;
    const there = share(o);
    const imp = await retake(b, ['project', 'import', file, '--as', 'shared'], { share: there });
    expect(imp.code, imp.err).toBe(EXIT.ok);
    expect(imp.text).toMatch(/its sandbox's images \(1, extracted, not loaded: trust loads them\)/);
    expect(there.calls.some((c) => c.op === 'load')).toBe(false);
    return there;
  }

  it('trust loads and tags them after the yes', async () => {
    const there = await imported();
    const t = await retake(b, ['project', 'trust', 'shared'], { answers: ['y'], share: there });
    expect(t.code, t.err).toBe(EXIT.ok);
    expect(t.text).toMatch(/its sandbox's images \(1, loaded into Docker after the yes, tagged retake-share-\*\)/);
    expect(t.text).toMatch(/image aaaaaaaaaaaa loaded: retake-share-shared-sbx-app:aaaaaaaaaaaa/);
    expect(existsSync(sandboxImagesOverride(proj(b, 'shared'), 'sbx'))).toBe(true);
  });

  it('--no-images leaves them waiting; --images asks, then loads', async () => {
    const there = await imported();
    const t = await retake(b, ['project', 'trust', 'shared', '--no-images'], { answers: ['y'], share: there });
    expect(t.code, t.err).toBe(EXIT.ok);
    expect(t.text).toMatch(/its sandbox's images wait: retake project trust shared --images loads them/);
    expect(there.calls.some((c) => c.op === 'load')).toBe(false);
    const no = await retake(b, ['project', 'trust', 'shared', '--images'], { answers: ['n'], share: there });
    expect(no.code).not.toBe(EXIT.ok);
    expect(no.questions).toEqual([expect.stringMatching(/Load 1 image\(s\) of shared \(about 412 MB\) into Docker\?/)]);
    expect(there.calls.some((c) => c.op === 'load')).toBe(false);
    const yes = await retake(b, ['project', 'trust', 'shared', '--images'], { answers: ['y'], share: there });
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.text).toMatch(/image aaaaaaaaaaaa loaded/);
  });

  it('a load that fails after the yes says the project is trusted and the images wait, with the command', async () => {
    const there = await imported({ tagFails: 'Error response from daemon: no such image' });
    const t = await retake(b, ['project', 'trust', 'shared'], { answers: ['y'], share: there });
    expect(t.code, t.err).toBe(EXIT.ok);
    expect(t.text).toMatch(/shared is trusted/);
    expect(t.text).toMatch(/the image aaaaaaaaaaaa is refused \(docker tag .*no such image\) — the images wait: retake project trust shared --images loads them/);
  });

  it('a load that throws after the yes (Docker gone mid-way) still says trusted, and that the images wait', async () => {
    // A service the archive carries no image for: its image is looked for on this machine, and Docker is gone.
    await write(join(a, 'infra', 'compose.yaml'), 'services:\n  app:\n    build: ../app-src\n    volumes: [../data:/data]\n  extra:\n    image: busybox:1.38.0\n');
    const there = await imported({ inspectFails: 'Cannot connect to the Docker daemon' });
    const t = await retake(b, ['project', 'trust', 'shared'], { answers: ['y'], share: there });
    expect(t.code, t.err).toBe(EXIT.ok);
    expect(t.text).toMatch(/shared is trusted/);
    expect(t.text).toMatch(/Cannot connect to the Docker daemon — the images wait: retake project trust shared --images loads them/);
  });

  it('--no-images without --with-sandbox is refused', async () => {
    const r = await retake(a, ['project', 'export', 'demo', '--no-images']);
    expect(r.code).not.toBe(EXIT.ok);
    expect(r.err).toMatch(/--no-images leaves the sandbox's images out: it goes with --with-sandbox/);
  });
});
