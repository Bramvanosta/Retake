/**
 * R-SHR-45: a project's Docker sandbox handed over in a project archive, for real (RETAKE_TEST_DOCKER=1: a running
 * Docker with busybox:1.38.0 present — nothing is pulled). Two scratch workspaces on this machine:
 * - A: a sandbox whose compose file lies outside the project (`infra/compose.yaml`), its app built locally FROM
 *   busybox as `retake-test-<token>-app` (`pull_policy: never`), a bind mount, a default `.env` beside it with a value;
 *   `retake sandbox up --build`, down, then `retake project export --with-sandbox` (the image saved by id);
 * - the app image removed here, so the load is real;
 * - B: `retake project import --as <slug>-b`: nothing loaded (no image of that id, no retake-share-* tag), `sandbox up`
 *   refused (untrusted); `retake project trust` with a person's "y" at a scripted terminal (never from a shell): the
 *   image loaded and tagged `retake-share-<slug>-b-sbx-app:<12 hex>`, the override written; the person provides the
 *   env file; `sandbox up` healthy without building (the build context is not there), then down;
 * - a tar saved by tag (`docker save busybox:1.38.0`) is refused before docker load.
 * Everything this run made is removed after: containers, networks, volumes, the test and share images (busybox stays).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { sandboxImagesOverride } from '@retake/core/project';
import { createSandboxShare, dockerEnv, findDocker } from '@retake/sandbox';
import { EXIT, main, memoryIo } from '../src/index.js';

const ENABLED = process.env.RETAKE_TEST_DOCKER === '1';
const DOCKER = findDocker() ?? 'docker';
const TOKEN = randomBytes(3).toString('hex');
const SLUG = `st-${TOKEN}`;
const SLUG_B = `${SLUG}-b`;
const APP_IMAGE = `retake-test-${TOKEN}-app`;
const PORT = 4633;

function docker(args: string[], o: { input?: string } = {}): string {
  return execFileSync(DOCKER, args, { encoding: 'utf8', env: dockerEnv(PERSON_POLICY), stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000, ...(o.input !== undefined ? { input: o.input } : {}) });
}
const tryDocker = (args: string[]): string => {
  try {
    return docker(args);
  } catch {
    return '';
  }
};
const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** The entries of a plain ustar tar (a docker save: no pax, short names). */
function untar(b: Buffer): Array<{ name: string; type: string; data: Buffer }> {
  const out: Array<{ name: string; type: string; data: Buffer }> = [];
  for (let at = 0; at + 512 <= b.length; ) {
    const h = b.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    out.push({ name, type: String.fromCharCode(h[156]!), data: Buffer.from(b.subarray(at + 512, at + 512 + size)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A ustar tar of entries. */
function retar(entries: ReadonlyArray<{ name: string; type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(e.type === '5' ? '0000755\0' : '0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write(e.type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

let a = '';
let b = '';
let scratch = '';

async function write(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function retake(root: string, args: string[], answers?: string[]) {
  const io = memoryIo(answers ? { answers } : {});
  const code = await main(['node', 'retake', '--root', root, ...args], io);
  return { code, out: io.stdout(), err: io.stderr(), text: io.stdout() + io.stderr() };
}

/** Remove what this run made: its compose projects, its images and tags (never busybox). */
function sweep(): void {
  for (const p of JSON.parse(tryDocker(['compose', 'ls', '-a', '--format', 'json']) || '[]') as Array<{ Name: string }>) {
    if (p.Name.startsWith(`retake-${SLUG}`)) tryDocker(['compose', '-p', p.Name, 'down', '--volumes', '--remove-orphans']);
  }
  for (const kind of ['container', 'volume', 'network'] as const) {
    const ls = kind === 'container' ? ['ps', '-a', '--format', '{{.Names}}'] : [kind, 'ls', '--format', '{{.Name}}'];
    for (const n of lines(tryDocker(ls))) if (n.startsWith(`retake-${SLUG}`)) tryDocker(kind === 'container' ? ['rm', '-f', n] : [kind, 'rm', n]);
  }
  const ids = new Set<string>();
  for (const ref of [`${APP_IMAGE}*`, `retake-share-${SLUG}*`, `retake-test-${TOKEN}-*`]) {
    for (const l of lines(tryDocker(['images', '--filter', `reference=${ref}`, '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']))) {
      const [tag, id] = l.split(' ');
      if (id) ids.add(id);
      if (tag) tryDocker(['image', 'rm', tag]);
    }
  }
  for (const id of ids) if (!lines(tryDocker(['image', 'inspect', '--format', '{{join .RepoTags " "}}', id])).join('')) tryDocker(['image', 'rm', id]);
}

describe.skipIf(!ENABLED)("a project's Docker sandbox in its archive, for real (RETAKE_TEST_DOCKER=1)", () => {
  beforeAll(async () => {
    expect(lines(docker(['images', '-q', 'busybox:1.38.0'])), 'busybox:1.38.0 must be present (nothing is pulled)').not.toEqual([]);
    scratch = await mkdtemp(join(tmpdir(), 'retake-share-docker-'));
    a = join(scratch, 'a');
    b = join(scratch, 'b');
    for (const r of [a, b]) {
      await write(join(r, 'retake.yaml'), 'projects_dir: projects\n');
      await mkdir(join(r, 'projects'), { recursive: true });
    }
    const p = join(a, 'projects', SLUG);
    await write(join(p, 'project.yaml'), `name: Share test\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n`);
    await write(
      join(p, 'sandbox', 'sandbox.yaml'),
      `version: 1\nprovider: docker-compose\ncompose:\n  files: [../../../infra/compose.yaml]\nservices:\n  app:\n    url: "http://127.0.0.1:${PORT}/"\n    pages: {app: "http://127.0.0.1:${PORT}/"}\n`,
    );
    await write(
      join(a, 'infra', 'compose.yaml'),
      `services:\n  app:\n    build: ../app-src\n    image: ${APP_IMAGE}\n    pull_policy: never\n    ports: ["127.0.0.1:${PORT}:8080"]\n    environment: {GREETING: "\${GREETING:-none}"}\n    volumes: ["../data:/data:ro"]\n`,
    );
    await write(join(a, 'infra', '.env'), 'GREETING=planted-share-value\n');
    await write(join(a, 'data', 'note.txt'), 'host data\n');
    await write(join(a, 'app-src', 'index.html'), '<h1>share test</h1>\n');
    await write(join(a, 'app-src', 'Dockerfile'), 'FROM busybox:1.38.0\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n');
  }, 120_000);

  afterAll(async () => {
    sweep();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 300_000);

  it('export --with-sandbox, import elsewhere: nothing loaded until trust; trust loads and tags; the sandbox runs unbuilt', async () => {
    // A: built and started once (the image is this machine's), then down.
    const up = await retake(a, ['sandbox', 'up', SLUG, '--env', 'sbx', '--build']);
    expect(up.code, up.text).toBe(EXIT.ok);
    expect((await retake(a, ['sandbox', 'down', SLUG, '--env', 'sbx', '--volumes'])).code).toBe(EXIT.ok);
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', APP_IMAGE]).trim();
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);

    const ex = await retake(a, ['project', 'export', SLUG, '--with-sandbox', '--json']);
    expect(ex.code, ex.text).toBe(EXIT.ok);
    const r = JSON.parse(ex.out) as {
      file: string;
      images: Array<{ id: string; platform: string; size: number }>;
      sandbox: Array<{ copied: unknown[]; host_mounts: unknown[]; env_file?: { included: boolean; keys: string[] } }>;
    };
    expect(r.images.map((i) => i.id)).toEqual([id]);
    expect(r.images[0]?.platform).toMatch(/^linux\//);
    expect(r.sandbox[0]?.copied).toEqual([{ from: '../../infra/compose.yaml', to: 'sandbox/compose-files/compose.yaml' }]);
    expect(r.sandbox[0]?.host_mounts).toEqual([{ service: 'app', source: '../../data', target: '/data', expected_at: 'sandbox/data' }]);
    expect(r.sandbox[0]?.env_file).toEqual({ path: 'sandbox/compose-files/.env', from: '../../infra/.env', keys: ['GREETING'], included: false });
    expect((await readFile(r.file)).includes(Buffer.from('planted-share-value'))).toBe(false);

    // The image goes from this machine: the load below is a real one.
    docker(['image', 'rm', APP_IMAGE]);
    expect(tryDocker(['image', 'inspect', id])).toBe('');

    // B: imported, nothing loaded, the sandbox refused.
    const imp = await retake(b, ['project', 'import', r.file, '--as', SLUG_B]);
    expect(imp.code, imp.text).toBe(EXIT.ok);
    expect(imp.text).toMatch(/extracted, not loaded/);
    expect(tryDocker(['image', 'inspect', id])).toBe('');
    expect(lines(docker(['images', '--filter', `reference=retake-share-${SLUG_B}*`, '-q']))).toEqual([]);
    const refused = await retake(b, ['sandbox', 'up', SLUG_B, '--env', 'sbx']);
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.text).toMatch(/is not trusted/);

    // A person's yes at a (scripted) terminal: loaded, tagged, the override written.
    const t = await retake(b, ['project', 'trust', SLUG_B], ['y']);
    expect(t.code, t.text).toBe(EXIT.ok);
    const tag = `retake-share-${SLUG_B}-sbx-app:${id.slice(7)}`;
    expect(t.text).toContain(`loaded: ${tag}`);
    expect(docker(['image', 'inspect', '--format', '{{.Id}}', tag]).trim()).toBe(id);
    const override = await readFile(sandboxImagesOverride(join(b, 'projects', SLUG_B), 'sbx'), 'utf8');
    expect(override).toContain(`image: "${tag}"`);
    expect(override).toContain('build: !reset null');

    // The person provides the env file the archive did not carry; the sandbox starts without building.
    await write(join(b, 'projects', SLUG_B, 'sandbox', 'compose-files', '.env'), 'GREETING=provided\n');
    const upB = await retake(b, ['sandbox', 'up', SLUG_B, '--env', 'sbx']);
    expect(upB.code, upB.text).toBe(EXIT.ok);
    const page = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    expect(page).toContain('share test');
    expect((await retake(b, ['sandbox', 'down', SLUG_B, '--env', 'sbx', '--volumes'])).code).toBe(EXIT.ok);
  }, 600_000);

  it('a hostile tar (a lowercase repotags naming a tag of this machine) is refused: the tag stays where it was, nothing is loaded', async () => {
    const victim = `retake-test-${TOKEN}-victim:1`;
    const evil = `retake-test-${TOKEN}-evil`;
    const ctx = join(scratch, 'evil');
    await write(join(ctx, 'Dockerfile'), 'FROM busybox:1.38.0\nRUN echo evil > /evil\n');
    docker(['build', '--pull=false', '-q', '-t', evil, ctx]);
    const evilId = docker(['image', 'inspect', '--format', '{{.Id}}', evil]).trim();
    const busyId = docker(['image', 'inspect', '--format', '{{.Id}}', 'busybox:1.38.0']).trim();
    docker(['tag', busyId, victim]);
    const raw = join(scratch, 'evil.tar');
    execFileSync(DOCKER, ['save', '-o', raw, evilId], { env: dockerEnv(PERSON_POLICY), timeout: 120_000 });
    docker(['image', 'rm', evil]);
    expect(tryDocker(['image', 'inspect', evilId])).toBe('');
    // The save as it is, its manifest.json given a lowercase repotags naming the victim (Go reads it as RepoTags).
    const tar = await readFile(raw);
    const entries = untar(tar).map((e) => {
      if (e.name !== 'manifest.json') return e;
      const m = JSON.parse(e.data.toString()) as Array<Record<string, unknown>>;
      delete m[0]!.RepoTags;
      m[0]!.repotags = [victim];
      return { ...e, data: Buffer.from(JSON.stringify(m)) };
    });
    const hostile = join(scratch, 'hostile.tar.gz');
    await writeFile(hostile, gzipSync(retar(entries)));
    const sha = createHash('sha256')
      .update(await readFile(hostile))
      .digest('hex');
    await expect(createSandboxShare().load(hostile, { expect: [evilId], sha256: sha, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(/refused, nothing loaded: .*repotags/);
    expect(docker(['image', 'inspect', '--format', '{{.Id}}', victim]).trim()).toBe(busyId);
    expect(tryDocker(['image', 'inspect', evilId])).toBe('');
    // The same save untouched loads, untagged; the victim still where it was.
    const good = join(scratch, 'good.tar.gz');
    await writeFile(good, gzipSync(tar));
    const gsha = createHash('sha256')
      .update(await readFile(good))
      .digest('hex');
    expect(await createSandboxShare().load(good, { expect: [evilId], sha256: gsha, maxBytes: 1 << 30, policy: PERSON_POLICY })).toEqual({ loaded: [evilId] });
    expect(docker(['image', 'inspect', '--format', '{{.Id}}', victim]).trim()).toBe(busyId);
    expect(docker(['image', 'inspect', '--format', '{{json .RepoTags}}', evilId]).trim()).toBe('[]');
    docker(['image', 'rm', victim]);
    docker(['image', 'rm', evilId]);
  }, 300_000);

  it('env files reached indirectly are never in an archive, with or without the sandbox', async () => {
    const slug = `${SLUG}-env`;
    const p = join(a, 'projects', slug);
    await write(join(p, 'project.yaml'), 'name: Env probe\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n');
    await write(join(p, 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: docker-compose\ncompose:\n  files: [compose.yaml, sub/more.yaml]\nservices: {}\n');
    await write(
      join(p, 'sandbox', 'compose.yaml'),
      'include:\n  - {path: inc.yaml, env_file: [v2.txt]}\n  - {path: inc3.yaml, project_directory: .}\nsecrets:\n  s6: {file: "${S6:-v6.txt}"}\nservices:\n  a: {image: busybox:1.38.0, pull_policy: never, env_file: "${CREDS:-v1.txt}", secrets: [s6]}\n',
    );
    await write(join(p, 'sandbox', 'inc.yaml'), 'services:\n  b: {image: busybox:1.38.0, pull_policy: never}\n');
    await write(join(p, 'sandbox', 'inc3.yaml'), 'services:\n  c: {image: busybox:1.38.0, pull_policy: never, env_file: v3.txt}\n');
    await write(join(p, 'sandbox', 'sub', 'more.yaml'), 'services:\n  a: {env_file: v7.txt}\n');
    for (const v of ['v1', 'v2', 'v3', 'v6', 'v7']) await write(join(p, 'sandbox', `${v}.txt`), `TOKEN=planted-secret-${v}\n`);
    const without = await retake(a, ['project', 'export', slug, '--json']);
    expect(without.code, without.text).toBe(EXIT.ok);
    const zip = await readFile((JSON.parse(without.out) as { file: string }).file);
    for (const v of ['v1', 'v2', 'v3', 'v6', 'v7']) expect(zip.includes(Buffer.from(`planted-secret-${v}`)), v).toBe(false);
    const withSb = await retake(a, ['project', 'export', slug, '--with-sandbox', '--no-images']);
    expect(withSb.code).not.toBe(EXIT.ok);
    expect(withSb.text).toMatch(/outside the compose subset an archive hands over/);
  }, 120_000);

  it('a provider service of an imported sandbox (made without the sandbox) never runs: its sandbox never starts', async () => {
    const slug = `${SLUG}-prov`;
    const p = join(a, 'projects', slug);
    const marker = join(scratch, 'provider-ran');
    await write(join(p, 'project.yaml'), 'name: Provider probe\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n');
    await write(join(p, 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: docker-compose\nservices: {}\n');
    await write(join(p, 'sandbox', 'compose.yaml'), 'services:\n  relp: {provider: {type: ./evil.sh, options: {a: b}}}\n');
    await write(join(p, 'sandbox', 'evil.sh'), `#!/bin/sh\ntouch ${marker}\n`);
    const ex = await retake(a, ['project', 'export', slug, '--json']);
    expect(ex.code, ex.text).toBe(EXIT.ok);
    const as = `${slug}-b`;
    expect((await retake(b, ['project', 'import', (JSON.parse(ex.out) as { file: string }).file, '--as', as])).code).toBe(EXIT.ok);
    const t = await retake(b, ['project', 'trust', as], ['y']);
    expect(t.code, t.text).toBe(EXIT.ok);
    expect(t.text).toMatch(/NOT HANDED OVER — .*services\.relp\.provider/);
    const up = await retake(b, ['sandbox', 'up', as, '--env', 'sbx']);
    expect(up.code).not.toBe(EXIT.ok);
    expect(up.text).toMatch(/outside the compose subset an archive hands over: it never starts through Retake/);
    expect(existsSync(marker)).toBe(false);
  }, 120_000);

  it('a tar saved by tag is refused before docker load', async () => {
    const file = join(scratch, 'by-tag.tar.gz');
    const raw = join(scratch, 'by-tag.tar');
    execFileSync(DOCKER, ['save', '-o', raw, 'busybox:1.38.0'], { env: dockerEnv(PERSON_POLICY), timeout: 120_000 });
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(file));
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', 'busybox:1.38.0']).trim();
    const sha = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    await expect(createSandboxShare().load(file, { expect: [id], sha256: sha, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(
      /refused, nothing loaded: .*(names tags|names an image|repositories)/,
    );
  }, 120_000);
});
