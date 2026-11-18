/**
 * Small Tools for tests: three fixture trees shaped like the real ones (a browser `.app` with a framework
 * link and an installer script the manifest prunes, a render browser with its program, a compositor npm package), their
 * archives (a zip made with ditto, a tgz made with tar), and a manifest naming them (`entries`, their sha256 and tree
 * digests computed here) — and hand-written archives for the installer's refusals (`zipOf`, `tgzOf`: an entry name or
 * kind no real archive tool would write: `../x`, `/abs`, a file below a link, a device). Never the network: the URLs
 * are the publishers' hosts with versions no publisher has (`0.0.1`), and every test hands its own fetch.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { treeDigest, treeSummary } from '@retake/core/io';
import type { ToolEntry, ToolId } from '@retake/core/io';

export const FIXTURE_MARKERS = ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED'];

/** One fixture Tool: its entry, its archive on disk and its source tree (what a right install holds). */
export interface FixtureTool {
  entry: ToolEntry;
  archive: string;
  bytes: Buffer;
  source: string;
}

export interface FixtureTools {
  /** In install order (render-browser, compositor, browser). */
  tools: FixtureTool[];
  entries: ToolEntry[];
  /** A folder holding each archive under its URL's file name (`--from-archives`). */
  archives: string;
  byId(id: ToolId): FixtureTool;
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function write(p: string, text: string, mode = 0o644): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  chmodSync(p, mode);
}

const ENV = { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' };

function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: ENV, ...(cwd ? { cwd } : {}) });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.error?.message}`);
}

/** A zip of `src`'s contents (entries relative to it), links and modes kept, no resource forks or attributes. */
export function dittoZip(src: string, out: string): void {
  run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--noacl', src, out]);
}

/** A tgz of `src`'s `top` folder, no macOS metadata. */
export function tarTgz(src: string, top: string, out: string): void {
  run('/usr/bin/tar', ['--no-mac-metadata', '--no-xattrs', '-czf', out, '-C', src, top]);
}

/**
 * The three fixture Tools under `base` (a fresh folder of the test's): trees, archives, entries. `version` changes
 * every digest (another release of the same Tools: a test of an update or of prune).
 */
export async function toolFixtures(base: string, version = '0.0.1'): Promise<FixtureTools> {
  const archives = join(base, 'archives');
  mkdirSync(archives, { recursive: true });
  const tools: FixtureTool[] = [];

  // The render browser: a program and a library beside it (the zip's top folder, as Google's).
  const shellSrc = join(base, 'src-shell');
  write(join(shellSrc, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), `#!/bin/sh\necho render-browser ${version}\n`, 0o755);
  write(join(shellSrc, 'chrome-headless-shell-mac-arm64', 'libfake.dylib'), `library ${version}\n`.repeat(64), 0o755);
  write(join(shellSrc, 'chrome-headless-shell-mac-arm64', 'LICENSE.headless_shell'), 'fixture licence\n');
  // The browser: an .app with a framework whose Current is a link (as the real one's), and an installer script pruned.
  const appSrc = join(base, 'src-browser');
  const fw = join(appSrc, 'chrome-mac-arm64', 'Fixture Browser.app', 'Contents', 'Frameworks', 'Fixture.framework');
  write(join(appSrc, 'chrome-mac-arm64', 'Fixture Browser.app', 'Contents', 'MacOS', 'Fixture Browser'), `#!/bin/sh\necho browser ${version}\n`, 0o755);
  write(join(fw, 'Versions', version, 'Fixture'), `framework ${version}\n`.repeat(128), 0o755);
  write(join(fw, 'Versions', version, 'Resources', 'install.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  symlinkSync(version, join(fw, 'Versions', 'Current'));
  symlinkSync(join('Versions', 'Current', 'Fixture'), join(fw, 'Fixture'));
  // The compositor: an npm package (its files under package/).
  const compSrc = join(base, 'src-compositor');
  write(join(compSrc, 'package', 'package.json'), JSON.stringify({ name: 'fixture-compositor', version }));
  write(join(compSrc, 'package', 'remotion'), `#!/bin/sh\necho compositor ${version}\n`, 0o755);
  write(join(compSrc, 'package', 'libcompositor.dylib'), `codec ${version}\n`.repeat(32), 0o755);

  const shellZip = join(archives, 'chrome-headless-shell-mac-arm64.zip');
  dittoZip(shellSrc, shellZip);
  const appZip = join(archives, 'chrome-mac-arm64.zip');
  dittoZip(appSrc, appZip);
  const compTgz = join(archives, `compositor-darwin-arm64-${version}.tgz`);
  tarTgz(compSrc, 'package', compTgz);

  const prune = [`chrome-mac-arm64/Fixture Browser.app/Contents/Frameworks/Fixture.framework/Versions/${version}/Resources/install.sh`];
  // What a right install holds: the browser's tree without its pruned script.
  const appTree = join(base, 'tree-browser');
  run('/usr/bin/ditto', [appSrc, appTree]);
  rmSync(join(appTree, ...prune[0]!.split('/')));

  const cft = `https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-arm64`;
  const common = { publisher: 'Fixture publisher', licence: 'Fixture licence', version };
  const entry = async (id: ToolId, over: Partial<ToolEntry>, archive: string, tree: string): Promise<FixtureTool> => {
    const bytes = readFileSync(archive);
    const sum = treeSummary(tree);
    const e: ToolEntry = {
      id,
      label: id === 'browser' ? 'Browser' : id === 'render-browser' ? 'Render browser' : 'Compositor',
      name: `Fixture ${id}`,
      ...common,
      folder: '',
      url: '',
      archive: 'zip',
      bytes: bytes.length,
      sha256: sha256(bytes),
      tree: await treeDigest(tree, FIXTURE_MARKERS),
      disk: Math.max(1, sum.bytes),
      executable: '.',
      ...over,
    };
    return { entry: e, archive, bytes, source: tree };
  };
  tools.push(
    await entry(
      'render-browser',
      { folder: `browsers/chromium_headless_shell-${version.replace(/\D/g, '')}`, url: `${cft}/chrome-headless-shell-mac-arm64.zip`, executable: 'chrome-headless-shell-mac-arm64/chrome-headless-shell', markers: FIXTURE_MARKERS },
      shellZip,
      shellSrc,
    ),
  );
  tools.push(
    await entry(
      'compositor',
      { folder: `compositor-${version}`, url: `https://registry.npmjs.org/@remotion/compositor-darwin-arm64/-/compositor-darwin-arm64-${version}.tgz`, archive: 'tgz', root: 'package' },
      compTgz,
      join(compSrc, 'package'),
    ),
  );
  tools.push(
    await entry(
      'browser',
      {
        folder: `browsers/chromium-${version.replace(/\D/g, '')}`,
        url: `${cft}/chrome-mac-arm64.zip`,
        executable: 'chrome-mac-arm64/Fixture Browser.app/Contents/MacOS/Fixture Browser',
        markers: FIXTURE_MARKERS,
        prune,
      },
      appZip,
      appTree,
    ),
  );
  return { tools, entries: tools.map((t) => t.entry), archives, byId: (id) => tools.find((t) => t.entry.id === id)! };
}

// ── Hand-written archives (what no archive tool would write) ─────────────────────

/** An entry of a hand-written zip: a file, a folder or a link (its target as data), with a mode. */
export interface ZipEntry {
  name: string;
  kind?: 'file' | 'dir' | 'link' | 'fifo';
  data?: string;
  mode?: number;
}

const TYPE_BITS = { file: 0o100000, dir: 0o040000, link: 0o120000, fifo: 0o010000 } as const;

function crc32(b: Buffer): number {
  let c = ~0;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A zip of these entries, stored (no compression), unix modes in the external attributes (links, folders, setuid). */
export function zipOf(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const kind = e.kind ?? 'file';
    const name = Buffer.from(kind === 'dir' && !e.name.endsWith('/') ? `${e.name}/` : e.name);
    const data = Buffer.from(e.data ?? '');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((TYPE_BITS[kind] | (e.mode ?? (kind === 'dir' ? 0o755 : 0o644))) << 16) | (kind === 'dir' ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** An entry of a hand-written tar: a type flag as tar writes it (`0` file, `5` folder, `2` link, `3` device, `6` fifo). */
export interface TarEntry {
  name: string;
  type?: '0' | '5' | '2' | '1' | '3' | '6';
  data?: string;
  link?: string;
  mode?: number;
}

/** A gzipped ustar archive of these entries. */
export function tgzOf(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157, 100, 'utf8');
    h.write('ustar\u000000', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/**
 * Valid manifest entries with made-up digests, for a fake app bundle (`bundle.json` `tools`) that is never installed
 * from: every check of their shape passes, no archive exists.
 */
export function fakeToolEntries(version = '0.0.1'): ToolEntry[] {
  const rev = version.replace(/\D/g, '');
  const cft = `https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-arm64`;
  const common = { publisher: 'Fixture publisher', licence: 'Fixture licence', version, bytes: 1000, disk: 2000, archive: 'zip' as const };
  return [
    {
      ...common,
      id: 'render-browser',
      label: 'Render browser',
      name: 'Fixture render browser',
      folder: `browsers/chromium_headless_shell-${rev}`,
      url: `${cft}/chrome-headless-shell-mac-arm64.zip`,
      sha256: '1'.repeat(64),
      tree: '2'.repeat(64),
      executable: 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      markers: FIXTURE_MARKERS,
    },
    {
      ...common,
      id: 'compositor',
      label: 'Compositor',
      name: 'Fixture compositor',
      folder: `compositor-${version}`,
      url: `https://registry.npmjs.org/@remotion/compositor-darwin-arm64/-/compositor-darwin-arm64-${version}.tgz`,
      archive: 'tgz',
      root: 'package',
      sha256: '3'.repeat(64),
      tree: '4'.repeat(64),
      executable: '.',
    },
    {
      ...common,
      id: 'browser',
      label: 'Browser',
      name: 'Fixture browser',
      folder: `browsers/chromium-${rev}`,
      url: `${cft}/chrome-mac-arm64.zip`,
      sha256: '5'.repeat(64),
      tree: '6'.repeat(64),
      executable: 'chrome-mac-arm64/Fixture Browser.app/Contents/MacOS/Fixture Browser',
      markers: FIXTURE_MARKERS,
    },
  ];
}

/**
 * A fixture Tool as a right install leaves it under the Tools folder `dir` (its tree, markers and `.verified` stamp),
 * without the installer: for the readers' tests (resolvers, doctor, the queue's gate). Answers its folder.
 */
export function placeTool(dir: string, t: FixtureTool): string {
  const folder = join(dir, ...t.entry.folder.split('/'));
  mkdirSync(join(folder, '..'), { recursive: true });
  run('/usr/bin/ditto', [t.source, folder]);
  for (const m of t.entry.markers ?? []) writeFileSync(join(folder, m), '');
  const sum = treeSummary(folder, t.entry.markers ?? []);
  writeFileSync(join(folder, '.verified'), JSON.stringify({ v: 1, tree: t.entry.tree, entries: sum.entries, bytes: sum.bytes, at: new Date(0).toISOString() }));
  return folder;
}

/** A fake app bundle (no file of it is read but what this names) whose bundle.json lists `entries`. */
export function fakeToolsBundle(root: string, entries: ToolEntry[]): import('@retake/core/io').BundleInfo {
  return {
    root,
    sealed: root,
    manifest: { v: 2, app: '0.0.1', node: '22.16.0', playwright: { core: '1.65.1' }, compositor: '0.0.1', ffmpeg: null, minimum_macos: '15.0', tools: entries, paths: { node: '', engine: '', ffmpeg: null, templates: '', plugin: '' } },
    paths: { node: join(root, 'node'), engine: join(root, 'engine'), ffmpeg: null, templates: join(root, 'templates'), plugin: join(root, 'plugin') },
  };
}
