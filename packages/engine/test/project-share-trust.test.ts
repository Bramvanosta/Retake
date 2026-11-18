/**
 * R-SHR-41, R-SHR-44, R-SHR-46…48: what the trust of an imported sandbox rests on — the files, never the manifest.
 * Docker replaced by the memory share of the Sandboxes port:
 * - an env or secret file the compose files reach through `include:`, `extends` or `${…}` is never in an archive, and
 *   the export says so (without the sandbox: read by Retake; with it: as docker compose resolved it);
 * - a repacked archive whose manifest hides everything: the import and trust listings recompute privileged, host
 *   namespaces, the socket and `/` mounts and the extra service from the compose files; the override covers every
 *   service, and the one without an image keeps its sandbox from starting; an image put on a service the compose
 *   files lack is refused at import;
 * - the mark's images and what trust loaded are signed: an edit untrusts, or reads as nothing loaded; the override is
 *   read only while it matches the signed mark;
 * - where a missing mount or env file goes once imported; a platform mismatch; Docker's disk; a load failing part-way.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxImagesOverride } from '@retake/core/project';
import type { ImageFacts, ShareFacts } from '@retake/sandbox/types';
import { createZip } from '../src/archive/zip-write.js';
import { openZip } from '../src/archive/zip-read.js';
import { createEngine } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { guardUntrusted } from '../src/project-archive/guard.js';
import { diskNote } from '../src/project-archive/images-work.js';
import type { ProjectManifest } from '../src/project-archive/manifest.js';
import { importMarkFile, importTrust, readImportMark } from '../src/project-archive/trust.js';
import type { ProductAdapters } from '../src/ports.js';
import { MemorySandboxShare, MemorySandboxes } from '../src/sandboxes/memory-sandboxes.js';

let root: string;
let other: string;
const proj = (slug = 'demo', at = root) => join(at, 'projects', slug);
const APP = `sha256:${'a'.repeat(64)}`;
const MAIL = `sha256:${'b'.repeat(64)}`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function write(file: string, text: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** demo: a sandbox within the compose subset whose compose files lie outside the project (the product's infra folder). */
async function demo(): Promise<void> {
  const p = proj();
  await write(join(p, 'project.yaml'), 'name: Demo\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n');
  await write(
    join(p, 'sandbox', 'sandbox.yaml'),
    'version: 1\nprovider: docker-compose\ncompose:\n  files: [../../../infra/compose.yaml]\nservices:\n  app: {url: "http://127.0.0.1:4634", pages: {app: "http://127.0.0.1:4634"}}\n',
  );
  await write(
    join(root, 'infra', 'compose.yaml'),
    'services:\n  app:\n    build: ../app-src\n    env_file: app.env\n    volumes: [../data:/data]\n  mail:\n    image: axllent/mailpit:v1.29.4\n  helper:\n    image: busybox:1.38.0\n',
  );
}

/** What docker would say (paths real, as docker gives them): only the images are read from it. */
function facts(): ShareFacts {
  const real = realpathSync(root);
  return {
    project: 'retake-demo-sbx-1',
    files: [join(real, 'infra', 'compose.yaml')],
    envKeys: [],
    services: [
      { name: 'app', image: 'retake-demo-sbx-1-app', build: join(real, 'app-src'), binds: [], envFiles: [], envFileKeys: [] },
      { name: 'mail', image: 'axllent/mailpit:v1.29.4', binds: [], envFiles: [], envFileKeys: [] },
      { name: 'helper', image: 'busybox:1.38.0', binds: [], envFiles: [], envFileKeys: [] },
    ],
    secretFiles: [],
    configFiles: [],
    includes: [],
  };
}

/**
 * Probes of compose files outside the subset (merge keys, interpolation, extends, includes, providers, host files, devices…), inside the project (`sandbox/`), with
 * the files they reach planted. Each `compose` is sandbox/compose.yaml; `files` adds files (project paths); `more`
 * names a second compose file sandbox.yaml lists.
 */
const PROBES: Record<string, { compose: string; files?: Record<string, string>; more?: string }> = {
  'merge key': { compose: 'x-base: &base {privileged: true, network_mode: host, volumes: ["/:/hostroot"]}\nservices:\n  app: {<<: *base, image: busybox:1.38.0}\n' },
  'interpolated privileged': { compose: 'services:\n  app: {image: busybox:1.38.0, privileged: "${PRIV:-true}", pid: "${PIDMODE:-host}"}\n' },
  'privileged yes': { compose: 'services:\n  app: {image: busybox:1.38.0, privileged: "yes"}\n' },
  'nested extends': {
    compose: 'services:\n  ext: {extends: {file: ext1.yaml, service: mid}}\n',
    files: { 'sandbox/ext1.yaml': 'services:\n  mid: {extends: {file: ext2.yaml, service: root}}\n', 'sandbox/ext2.yaml': 'services:\n  root: {image: busybox:1.38.0, privileged: true}\n' },
  },
  'post_start': { compose: 'services:\n  app: {image: busybox:1.38.0, post_start: [{command: id, privileged: true, user: root}]}\n' },
  'include project_directory /': {
    compose: 'include: [{path: inc/extra.yaml, project_directory: /}]\nservices: {}\n',
    files: { 'sandbox/inc/extra.yaml': 'services:\n  e: {image: busybox:1.38.0, volumes: ["./:/hostroot2"]}\n' },
  },
  'climbing bind of a second file': {
    compose: 'services:\n  app: {image: busybox:1.38.0}\n',
    more: 'd1/d2/more.yaml',
    files: { 'sandbox/d1/d2/more.yaml': `services:\n  app: {volumes: ["${'../'.repeat(21)}:/up"]}\n` },
  },
  provider: { compose: 'services:\n  relp: {provider: {type: ./evil.sh, options: {a: b}}}\n', files: { 'sandbox/evil.sh': '#!/bin/sh\ntouch /tmp/x\n' } },
  'driver_opts volume': { compose: 'volumes:\n  rootvol: {driver_opts: {type: none, o: bind, device: /}}\nservices:\n  named: {image: busybox:1.38.0, volumes: ["rootvol:/r"]}\n' },
  'host-file secret': {
    compose: 'secrets:\n  sshkey: {file: ~/.ssh/id_ed25519}\nconfigs:\n  awscfg: {file: /etc/hosts}\nservices:\n  app: {image: busybox:1.38.0, secrets: [sshkey], configs: [awscfg]}\n',
  },
  'device_cgroup_rules': { compose: 'services:\n  app: {image: busybox:1.38.0, device_cgroup_rules: ["b *:* rwm"], cgroup: host}\n' },
  'remote include': { compose: 'include: ["https://127.0.0.1:9/x.git#main:compose.yaml"]\nservices: {}\n' },
  'extends string': { compose: 'services:\n  base: {image: busybox:1.38.0, privileged: true}\n  app: {extends: base}\n' },
  'uts host': { compose: 'services:\n  app: {image: busybox:1.38.0, uts: host}\n' },
  'env file elsewhere, outside the subset': {
    compose: 'services:\n  app: {image: busybox:1.38.0, privileged: true, env_file: ../elsewhere.txt}\n',
    files: { 'elsewhere.txt': 'TOKEN=planted-secret-v6\n' },
  },
  'bind into the hooks': { compose: 'services:\n  app: {image: busybox:1.38.0, volumes: ["../hooks:/h"]}\n' },
  'bind of the sandbox folder': { compose: 'services:\n  app: {image: busybox:1.38.0, volumes: [".:/s"]}\n' },
  'root literal env file': { compose: 'services:\n  app: {image: busybox:1.38.0, privileged: true, env_file: [app-secrets.txt]}\n', files: { 'sandbox/app-secrets.txt': 'TOKEN=planted-secret-v1\n' } },
  'root interpolated env file': { compose: 'services:\n  app: {image: busybox:1.38.0, env_file: "${CREDS:-v2.txt}"}\n', files: { 'sandbox/v2.txt': 'TOKEN=planted-secret-v2\n' } },
  'root include': {
    compose: 'include: [inc.yaml]\nservices: {}\n',
    files: { 'sandbox/inc.yaml': 'services:\n  b: {image: busybox:1.38.0, env_file: inc-secrets.txt}\n', 'sandbox/inc-secrets.txt': 'TOKEN=planted-secret-v3\n' },
  },
  'env file outside': { compose: `services:\n  app: {image: busybox:1.38.0, env_file: "${'../'.repeat(6)}etc/environment"}\n` },
  'climbing bind': { compose: `services:\n  app: {image: busybox:1.38.0, volumes: ["${'../'.repeat(6)}etc:/x"]}\n` },
  // Env and secret files reached indirectly, each planted.
  'env files reached indirectly': {
    compose: 'include:\n  - {path: inc.yaml, env_file: [v2.txt]}\nsecrets:\n  s6: {file: "${S6:-v6.txt}"}\nservices:\n  a: {image: busybox:1.38.0, env_file: "${CREDS:-v1.txt}"}\n',
    more: 'sub/more.yaml',
    files: {
      'sandbox/inc.yaml': 'services:\n  b: {image: busybox:1.38.0, env_file: v3.txt}\n',
      'sandbox/sub/more.yaml': 'services:\n  a: {env_file: v7.txt}\n',
      ...Object.fromEntries(['v1', 'v2', 'v3', 'v6', 'v7'].map((v) => [`sandbox/${v}.txt`, `TOKEN=planted-secret-${v}\n`])),
      'sandbox/sub/v7.txt': 'TOKEN=planted-secret-v7\n',
    },
  },
};

/**
 * A probe written into the project (sandbox.yaml naming sandbox/compose.yaml, and its second file when it has one);
 * `root`: sandbox.yaml and its compose files at the project's root instead (the probe's `sandbox/` files there too).
 */
async function plantProbe(name: string, o: { root?: boolean } = {}): Promise<void> {
  const probe = PROBES[name]!;
  const p = proj();
  await rm(join(p, 'sandbox'), { recursive: true, force: true });
  // What an earlier probe left outside sandbox/ (its root files, a root sandbox) goes too.
  for (const f of ['sandbox.yaml', 'compose.yaml', ...Object.values(PROBES).flatMap((x) => Object.keys(x.files ?? {}).flatMap((k) => [k.replace(/^sandbox\//, ''), k]))])
    if (!f.startsWith('sandbox/')) await rm(join(p, f), { recursive: true, force: true });
  const base = o.root ? p : join(p, 'sandbox');
  await write(join(p, 'project.yaml'), `name: Demo\nsandboxes:\n  sbx: ${o.root ? 'sandbox.yaml' : 'sandbox/sandbox.yaml'}\n`);
  await write(join(base, 'sandbox.yaml'), `version: 1\nprovider: docker-compose\ncompose:\n  files: [compose.yaml${probe.more ? `, ${probe.more}` : ''}]\nservices: {}\n`);
  await write(join(base, 'compose.yaml'), probe.compose);
  for (const [f, text] of Object.entries(probe.files ?? {})) await write(join(p, o.root ? f.replace(/^sandbox\//, '') : f), text);
}

const HELPER = `sha256:${'c'.repeat(64)}`;
const IMAGES: Record<string, ImageFacts> = {
  'retake-demo-sbx-1-app': { id: APP, os: 'linux', arch: 'arm64', size: 412_000_000 },
  'axllent/mailpit:v1.29.4': { id: MAIL, os: 'linux', arch: 'arm64', size: 38_000_000 },
  'busybox:1.38.0': { id: HELPER, os: 'linux', arch: 'arm64', size: 4_000_000 },
};
const shareOf = (o: ConstructorParameters<typeof MemorySandboxShare>[0] = {}) => new MemorySandboxShare({ compose: { sbx: facts() }, images: IMAGES, ...o });
const engineWith = (at: string, share: MemorySandboxShare, client: 'cli' | 'mcp' = 'cli'): Promise<Engine> =>
  createEngine({ root: at, client, autoStartWorker: false, ports: { sandboxes: new MemorySandboxes({ share }) } });

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}

/** Every byte of an archive, and its manifest. */
async function contents(file: string): Promise<{ bytes: Buffer; names: string[]; manifest: ProjectManifest }> {
  const z = await openZip(file, { entryMax: () => Number.MAX_SAFE_INTEGER });
  const all: Buffer[] = [];
  for (const e of z.entries) all.push(await z.readAll(e, 1 << 28));
  const names = z.entries.map((e) => e.name);
  await z.close();
  return { bytes: Buffer.concat(all), names, manifest: JSON.parse(all.at(-1)!.toString('utf8')) as ProjectManifest };
}

/** The archive again: project files replaced (`files`: project path → bytes, their manifest entries updated), the manifest changed. */
async function repack(file: string, files: Record<string, string>, change: (m: ProjectManifest) => void, raw: Record<string, Buffer> = {}): Promise<string> {
  const z = await openZip(file, { entryMax: () => Number.MAX_SAFE_INTEGER });
  const out = join(dirname(file), `repacked-${Math.random().toString(16).slice(2)}.zip`);
  const w = await createZip(out, { limits: { entryMax: () => Number.MAX_SAFE_INTEGER } });
  let manifest: ProjectManifest | undefined;
  const items: Array<{ name: string; data: Buffer; mode: 0o644 | 0o755 }> = [];
  for (const e of z.entries) {
    if (e.dir) continue;
    const b = await z.readAll(e, 1 << 28);
    if (e.name === 'retake-project.json') manifest = JSON.parse(b.toString('utf8')) as ProjectManifest;
    else items.push({ name: e.name, data: b, mode: e.mode === 0o755 ? 0o755 : 0o644 });
  }
  await z.close();
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const at = items.find((i) => i.name === `project/${path}`);
    if (at) at.data = data;
    else items.push({ name: `project/${path}`, data, mode: 0o644 });
    const f = manifest!.files.find((x) => x.path === path);
    if (f) Object.assign(f, { size: data.length, sha256: sha(data) });
    else manifest!.files.push({ path, size: data.length, sha256: sha(data), mode: '644', origin: 'project' });
  }
  for (const [name, data] of Object.entries(raw)) {
    const at = items.find((i) => i.name === name);
    if (at) at.data = data;
  }
  change(manifest!);
  const entries = new Set((manifest!.images ?? []).map((i) => i.entry));
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.name.startsWith('images/') && !entries.has(items[i]!.name)) items.splice(i, 1);
  items.sort((a, b) => (a.name < b.name ? -1 : 1));
  const mtime = new Date('2026-11-18T00:00:00Z');
  for (const i of items) await w.add(i.name, { data: i.data }, { mode: i.mode, mtime });
  await w.add('retake-project.json', { data: Buffer.from(JSON.stringify(manifest)) }, { mode: 0o644, mtime });
  await w.close();
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-share-trust-a-'));
  other = await mkdtemp(join(tmpdir(), 'retake-share-trust-b-'));
  for (const r of [root, other]) {
    await writeFile(join(r, 'retake.yaml'), 'projects_dir: projects\n');
    await mkdir(join(r, 'projects'), { recursive: true });
  }
  await demo();
});

afterEach(async () => {
  for (const r of [root, other]) if (r) await rm(r, { recursive: true, force: true });
});

/** A fake product's adapters whose sandboxes hand out a recording handle (and keep the project each open was given). */
function adapters() {
  const calls: string[] = [];
  const given: Array<{ sandboxes?: Record<string, { imagesOverride?: unknown }> }> = [];
  const rec = (what: string) => async () => (calls.push(what), {}) as never;
  const handle = { env: 'sbx', up: rec('up'), prepareTake: rec('prepareTake'), reset: rec('reset'), down: rec('down'), status: rec('status') };
  const base = {
    hooks: { run: rec('hooks.run') },
    reviewer: {},
    capture: { run: rec('capture.run'), record: rec('record'), sessions: { check: rec('check'), signIn: rec('signIn') }, hookPages: { open: rec('hookPages.open') } },
    sandboxes: {
      open: async (p: never) => {
        given.push(p);
        return handle;
      },
      init: rec('init'),
    },
    renderer: { video: rec('video'), stills: rec('stills'), previews: { bundle: rec('bundle') } },
    registries: {},
  };
  return { g: guardUntrusted(base as unknown as ProductAdapters, process.env), calls, given };
}
const imported = (slug: string) => ({ root: other, dir: proj(slug, other), slug, config: { sandboxes: { sbx: 'sandbox/sandbox.yaml' } }, sandboxes: { sbx: { env: 'sbx' } } });

describe('the compose subset: anything outside it is not handed over (R-SHR-41, R-SHR-46)', () => {
  it('every recheck probe is refused by --with-sandbox, naming what is outside; without the sandbox the files it reaches are left out', async () => {
    const cli = await engineWith(root, shareOf());
    let n = 0;
    for (const name of Object.keys(PROBES)) {
      await plantProbe(name);
      const e = await refusal(cli.projects.exportArchive({ project: 'demo', withSandbox: true, out: join(root, `w-${n}.zip`) }));
      expect(e.message, name).toMatch(/its compose files are outside the compose subset an archive hands over/);
      const without = await cli.projects.exportArchive({ project: 'demo', out: join(root, `o-${n++}.zip`) });
      const c = await contents(without.file!);
      for (const v of ['v1', 'v2', 'v3', 'v6', 'v7']) expect(c.bytes.includes(Buffer.from(`planted-secret-${v}`)), `${name} ${v}`).toBe(false);
      for (const f of Object.keys(PROBES[name]!.files ?? {}).filter((f) => f.endsWith('.txt'))) expect(without.excluded.sensitive, `${name} ${f}`).toContain(f);
    }
  });

  it('names each key outside the subset (merge keys, interpolation, includes, providers, host files, devices…)', async () => {
    const cli = await engineWith(root, shareOf());
    const words: Record<string, RegExp> = {
      'merge key': /a YAML merge key \(<<\)|a YAML anchor/,
      'interpolated privileged': /services\.app\.privileged: not a service setting/,
      'nested extends': /services\.ext\.extends: not a service setting/,
      post_start: /services\.app\.post_start: not a service setting/,
      'include project_directory /': /include: not a top-level key/,
      'climbing bind of a second file': /a compose file in another folder than the first/,
      provider: /services\.relp\.provider: not a service setting/,
      'driver_opts volume': /volumes\.rootvol\.driver_opts: not a volume setting/,
      'host-file secret': /secrets: not a top-level key/,
      device_cgroup_rules: /device_cgroup_rules: not a service setting/,
      'remote include': /include: not a top-level key/,
      'uts host': /services\.app\.uts: not a service setting/,
      'climbing bind': /a bind that resolves outside the sandbox's data folder/,
      'bind into the hooks': /volumes \.\.\/hooks: a bind that resolves outside the sandbox's data folder sandbox\/data/,
      'bind of the sandbox folder': /volumes \.: a bind that resolves outside the sandbox's data folder/,
      'privileged yes': /services\.app\.privileged: not a service setting/,
      'extends string': /services\.app\.extends: not a service setting/,
      'env file outside': /services\.app\.env_file \.\.\/.*: resolves outside the project/,
      'env files reached indirectly': /interpolation \(`\$…`\) outside a service's environment values/,
    };
    let n = 0;
    for (const [name, w] of Object.entries(words)) {
      await plantProbe(name);
      expect((await refusal(cli.projects.exportArchive({ project: 'demo', withSandbox: true, out: join(root, `n-${n++}.zip`) }))).message, name).toMatch(w);
    }
  });

  it('a crafted archive whose compose files are outside the subset is refused at import', async () => {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const there = await engineWith(other, shareOf());
    let n = 0;
    for (const [name, probe] of Object.entries(PROBES)) {
      const files: Record<string, string> = { 'sandbox/compose-files/compose.yaml': probe.compose };
      for (const [f, text] of Object.entries(probe.files ?? {})) files[f.replace(/^sandbox\//, 'sandbox/compose-files/')] = text;
      if (probe.more) files['sandbox/sandbox.yaml'] = `version: 1\nprovider: docker-compose\ncompose:\n  files: [compose-files/compose.yaml, compose-files/${probe.more}]\nservices: {}\n`;
      const crafted = await repack(r.file!, files, () => undefined);
      const e = await refusal(there.projects.importArchive(crafted, { as: `crafted-${n++}` }));
      expect(e.message, name).toMatch(/its sandbox is outside the compose subset an archive hands over/);
    }
    // Within the subset but a built service the archive carries no image for: refused too.
    const built = await repack(r.file!, { 'sandbox/compose-files/compose.yaml': `${await readFile(join(root, 'infra', 'compose.yaml'), 'utf8')}  side:\n    build: ./evil\n` }, () => undefined);
    expect((await refusal(there.projects.importArchive(built, { as: 'built' }))).message).toMatch(/services\.side: it is built and the archive carries no image for it/);
  });

  it('the env files of a sandbox within the subset are left out, with or without the sandbox, and named', async () => {
    const p = proj();
    await write(join(p, 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: docker-compose\nservices: {}\n');
    await write(join(p, 'sandbox', 'compose.yaml'), 'services:\n  app: {image: busybox:1.38.0, env_file: creds.txt}\n');
    await write(join(p, 'sandbox', 'creds.txt'), 'TOKEN=planted-secret-creds\n');
    await write(join(p, 'sandbox', 'notes.txt'), 'kept\n');
    const cli = await engineWith(root, shareOf({ compose: { sbx: { ...facts(), services: [{ name: 'app', image: 'busybox:1.38.0', binds: [], envFiles: [], envFileKeys: [] }] } } }));
    for (const [n, req] of [
      ['without', { project: 'demo' }],
      ['with', { project: 'demo', withSandbox: true }],
    ] as const) {
      const r = await cli.projects.exportArchive({ ...req, out: join(root, `env-${n}.zip`) });
      const c = await contents(r.file!);
      expect(c.bytes.includes(Buffer.from('planted-secret-creds')), n).toBe(false);
      expect(r.excluded.sensitive, n).toContain('sandbox/creds.txt');
      expect(c.names, n).toContain('project/sandbox/notes.txt');
      if (n === 'with') expect(c.manifest.sandbox?.[0]?.service_env_files).toEqual([{ service: 'app', path: 'sandbox/creds.txt', keys: ['TOKEN'], expected_at: 'sandbox/creds.txt' }]);
    }
  });

  it('an archive made without the sandbox imports; its sandbox outside the subset never starts through Retake', async () => {
    await plantProbe('provider');
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo' });
    const there = await engineWith(other, shareOf());
    await there.projects.importArchive(r.file!, { as: 'plain' });
    const view = await there.projects.trustView('plain');
    expect(view.sandbox_settings.join('\n')).toMatch(/sandbox sbx: NOT HANDED OVER — sandbox\/compose\.yaml: services\.relp\.provider: not a service setting/);
    await there.projects.trust('plain', view);
    const { g, calls } = adapters();
    const h = await g.sandboxes.open(imported('plain') as never, undefined, {} as never);
    expect((await refusal(h.up())).message).toMatch(/sandbox sbx of plain was imported and its compose files are outside the compose subset an archive hands over: it never starts through Retake/);
    await h.down();
    expect(calls).toEqual(['down']);
  });

  it("a sandbox at the project's root: outside the subset its export is refused (move it into a folder); within it, its env files are left out", async () => {
    let n = 0;
    for (const name of ['root literal env file', 'root interpolated env file', 'root include']) {
      await plantProbe(name, { root: true });
      const cli = await engineWith(root, shareOf());
      const e = await refusal(cli.projects.exportArchive({ project: 'demo', out: join(root, `root-${n++}.zip`) }));
      expect(e.message, name).toMatch(
        /its compose files are at the project's root and outside the compose subset an archive hands over .*move sandbox\.yaml and its compose files into a folder of their own \(sandbox\/\)/,
      );
    }
    // Within the subset at the root: the env file it names left out (the reader names it, whatever the folder).
    await rm(join(proj(), 'compose.yaml'));
    await write(join(proj(), 'compose.yaml'), 'services:\n  app: {image: busybox:1.38.0, env_file: [app-secrets.txt]}\n');
    await write(join(proj(), 'app-secrets.txt'), 'TOKEN=planted-secret-root\n');
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', out: join(root, 'root-ok.zip') });
    expect((await contents(r.file!)).bytes.includes(Buffer.from('planted-secret-root'))).toBe(false);
    expect(r.excluded.sensitive).toContain('app-secrets.txt');
  });

  it('--no-images without --with-sandbox is refused', async () => {
    const cli = await engineWith(root, shareOf());
    expect((await refusal(cli.projects.exportArchive({ project: 'demo', images: false }))).message).toMatch(/--no-images .* goes with --with-sandbox/);
  });
});

describe('the trust listing and the override come from the files, never the manifest (R-SHR-46)', () => {
  it("lists every service's accepted settings and where its env files and mounts go; the override covers every service", async () => {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const c = await contents(r.file!);
    expect(c.manifest.sandbox?.[0]?.service_env_files).toEqual([{ service: 'app', path: '../../infra/app.env', keys: [], expected_at: 'sandbox/compose-files/app.env' }]);
    expect(c.manifest.sandbox?.[0]?.host_mounts).toEqual([{ service: 'app', source: '../../data', target: '/data', expected_at: 'sandbox/data' }]);
    // The manifest emptied: the listing still says everything, from the files.
    const emptied = await repack(r.file!, {}, (m) => {
      for (const p of m.sandbox ?? []) Object.assign(p, { host_mounts: [], outside: [], service_env_files: [] });
    });
    const there = await engineWith(other, shareOf());
    const imp = await there.projects.importArchive(emptied, { as: 'shared' });
    const said = imp.sandbox_settings.join('\n');
    expect(said).toMatch(/service app — built from \.\.\/app-src, runs the carried image aaaaaaaaaaaa/);
    expect(said).toMatch(/service app mounts sandbox\/data at \/data/);
    expect(said).toMatch(/service app reads the env file sandbox\/compose-files\/app\.env \(never carried: provide it there\)/);
    expect(said).not.toMatch(/NOT HANDED OVER/);
    await there.projects.trust('shared', await there.projects.trustView('shared'));
    await there.projects.loadImages('shared');
    const override = await readFile(sandboxImagesOverride(proj('shared', other), 'sbx'), 'utf8');
    expect(override.match(/build: !reset null\n {4}pull_policy: never/g)).toHaveLength(3);
  });

  it('an image put on a service the compose files lack, or that names another image, is refused at import', async () => {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const there = await engineWith(other, shareOf());
    const extra = await repack(r.file!, {}, (m) => m.sandbox![0]!.images.push({ service: 'evil', name: 'x', id: APP }));
    expect((await refusal(there.projects.importArchive(extra, { as: 'extra' }))).message).toMatch(/puts an image on service evil of sandbox sbx, which its compose files do not have/);
    const renamed = await repack(r.file!, {}, (m) => {
      for (const i of m.sandbox![0]!.images) if (i.service === 'mail') i.name = 'postgres:17-alpine';
    });
    expect((await refusal(there.projects.importArchive(renamed, { as: 'renamed' }))).message).toMatch(
      /service mail of sandbox sbx, whose compose file names another image \(axllent\/mailpit:v1\.29\.4, not postgres:17-alpine\)/,
    );
  });
});

describe('the mark is signed; the override is read only while it matches (R-SHR-47)', () => {
  async function trusted(share = shareOf()): Promise<Engine> {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const there = await engineWith(other, share);
    await there.projects.importArchive(r.file!, { as: 'shared' });
    await there.projects.trust('shared', await there.projects.trustView('shared'));
    return there;
  }

  it("an edit of the mark's images untrusts; a forged or edited load reads as nothing loaded", async () => {
    const there = await trusted();
    const file = importMarkFile(other, 'shared');
    const good = await readFile(file, 'utf8');
    const m = JSON.parse(good);
    m.images[0].uses[0].service = 'mail';
    await writeFile(file, JSON.stringify(m));
    expect((await importTrust({ root: other, dir: proj('shared', other), slug: 'shared' }, process.env)).state).toBe('untrusted');
    // A load forged before any: nothing loaded, the sandbox waits.
    const f = JSON.parse(good);
    f.loaded = { at: 'x', images: { [APP]: 'x', [MAIL]: 'x', [HELPER]: 'x' }, overrides: {}, missing: [], sig: 'f'.repeat(64) };
    await writeFile(file, JSON.stringify(f));
    expect((await there.projects.trustView('shared')).images.some((i) => i.loaded)).toBe(false);
    const { g } = adapters();
    expect((await refusal((await g.sandboxes.open(imported('shared') as never, undefined, {} as never)).up())).message).toMatch(/not loaded yet/);
    // A real load, then its missing list emptied by hand: the signature no longer holds.
    await writeFile(file, good);
    await there.projects.loadImages('shared');
    const l = JSON.parse(await readFile(file, 'utf8'));
    expect(l.loaded.overrides.sbx).toMatch(/^[0-9a-f]{64}$/);
    l.loaded.images = {};
    await writeFile(file, JSON.stringify(l));
    expect((await there.projects.trustView('shared')).images.some((i) => i.loaded)).toBe(false);
  });

  it('a changed override is not read and refuses starts; the trust listing says so', async () => {
    const there = await trusted();
    await there.projects.loadImages('shared');
    const { g, calls, given } = adapters();
    await (await g.sandboxes.open(imported('shared') as never, undefined, {} as never)).up();
    expect(calls).toEqual(['up']);
    expect(given[0]?.sandboxes?.sbx?.imagesOverride).toMatchObject({ file: sandboxImagesOverride(proj('shared', other), 'sbx') });
    expect((await there.projects.trustView('shared')).overrides.join('\n')).toMatch(/as trust wrote it/);
    await writeFile(sandboxImagesOverride(proj('shared', other), 'sbx'), 'services:\n  app:\n    privileged: true\n');
    const h = await g.sandboxes.open(imported('shared') as never, undefined, {} as never);
    expect((await refusal(h.up())).message).toMatch(/compose override of sandbox sbx of shared is gone or changed since trust wrote it \(it is not read\)/);
    expect(given[1]?.sandboxes?.sbx?.imagesOverride).toBeUndefined();
    expect((await there.projects.trustView('shared')).overrides.join('\n')).toMatch(/CHANGED since trust: not read/);
    // Written again by --images.
    await there.projects.loadImages('shared');
    await (await g.sandboxes.open(imported('shared') as never, undefined, {} as never)).up();
    expect(calls).toEqual(['up', 'up']);
  });
});

describe('platform, disk, partial loads, save without --platform (R-SHR-48)', () => {
  it('warns of another platform at import; says the disk estimate; refuses a disk too small, naming the slug', async () => {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const there = await engineWith(other, shareOf({ docker: { compose: '2.29.0', server: '29.0.0', platform: 'linux/amd64', savePlatform: true } }));
    const imp = await there.projects.importArchive(r.file!, { as: 'shared' });
    expect(imp.warnings.join('\n')).toMatch(/built for linux\/arm64, this machine's Docker runs linux\/amd64: it runs under emulation, slowly, or not at all/);
    await there.projects.trust('shared', await there.projects.trustView('shared'));
    const loaded = await there.projects.loadImages('shared');
    expect(loaded.notes.join('\n')).toMatch(/the images need about \d+ MB on Docker's disk \(an estimate; Docker Desktop and OrbStack keep it in their VM/);
    await expect(diskNote(tmpdir(), Number.MAX_SAFE_INTEGER, 'shared')).rejects.toThrow(/has \d+ MB free, the images need \d+ MB: free space there, then retake project trust shared --images/);
    expect(await diskNote(tmpdir(), 1, 'shared', statfs)).toBeUndefined();
  });

  it('a load failing part-way keeps what loaded, writes no override, and a second run loads only the rest', async () => {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const share = shareOf({ loads: (e) => (e[0] === MAIL ? [] : [...e]) });
    const there = await engineWith(other, share);
    await there.projects.importArchive(r.file!, { as: 'shared' });
    await there.projects.trust('shared', await there.projects.trustView('shared'));
    const first = await there.projects.loadImages('shared');
    expect(first.loaded.map((l) => l.id)).toEqual([APP]);
    expect(first.waiting).toMatch(/the image bbbbbbbbbbbb is refused/);
    expect(existsSync(sandboxImagesOverride(proj('shared', other), 'sbx'))).toBe(false);
    expect((await there.projects.trustView('shared')).images.map((i) => [i.id, i.loaded])).toEqual([
      [APP, true],
      [MAIL, false],
      [HELPER, false],
    ]);
    share.o.loads = undefined;
    const second = await there.projects.loadImages('shared');
    expect(second.loaded.map((l) => l.id)).toEqual([MAIL, HELPER]);
    expect(share.calls.filter((c) => c.op === 'load').map((c) => (c.args[1] as string[])[0])).toEqual([APP, MAIL, MAIL, HELPER]);
    expect(existsSync(sandboxImagesOverride(proj('shared', other), 'sbx'))).toBe(true);
    const mark = await readImportMark(other, 'shared');
    expect(typeof mark === 'object' && Object.keys(mark.loaded?.images ?? {}).sort()).toEqual([APP, MAIL, HELPER].sort());
  });

  it('an image whose bytes once decompressed pass its size (a bomb) is refused at import', async () => {
    const cli = await engineWith(root, shareOf());
    const r = await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    const bomb = gzipSync(Buffer.alloc(70 * 1024 * 1024));
    const entry = `images/sha256-${'a'.repeat(64)}.tar.gz`;
    const file = await repack(
      r.file!,
      {},
      (m) => {
        for (const i of m.images ?? []) if (i.entry === entry) Object.assign(i, { bytes: bomb.length, sha256: sha(bomb), size: 0 });
      },
      { [entry]: bomb },
    );
    const there = await engineWith(other, shareOf());
    expect((await refusal(there.projects.importArchive(file, { as: 'bomb' }))).message).toMatch(/holds more than \d+ bytes once decompressed \(more than its image's size\)/);
    expect(existsSync(proj('bomb', other))).toBe(false);
  });

  it("containerd's image store: saving and loading are refused, not supported yet", async () => {
    const ctr = { compose: '2.29.0', server: '29.0.0', platform: 'linux/arm64', savePlatform: true, store: 'containerd' as const };
    const cli = await engineWith(root, shareOf({ docker: ctr }));
    expect((await refusal(cli.projects.exportArchive({ project: 'demo', withSandbox: true }))).message).toMatch(
      /containerd's image store, whose image ids are manifest digests: saving images for an archive there is not supported yet/,
    );
    const r = await (await engineWith(root, shareOf())).projects.exportArchive({ project: 'demo', withSandbox: true });
    const there = await engineWith(other, shareOf({ docker: ctr }));
    await there.projects.importArchive(r.file!, { as: 'shared' });
    await there.projects.trust('shared', await there.projects.trustView('shared'));
    expect((await there.projects.loadImages('shared')).waiting).toMatch(/containerd's image store.*not supported yet/);
  });

  it('saves without --platform where docker save does not take it', async () => {
    const share = shareOf({ docker: { compose: '2.29.0', server: '24.0.0', platform: 'linux/arm64', savePlatform: false } });
    const cli = await engineWith(root, share);
    await cli.projects.exportArchive({ project: 'demo', withSandbox: true });
    expect(share.calls.filter((c) => c.op === 'save').map((c) => c.args[1])).toEqual([undefined, undefined, undefined]);
  });
});
