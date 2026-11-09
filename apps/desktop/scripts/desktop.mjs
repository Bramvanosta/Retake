#!/usr/bin/env node
/**
 * The desktop shell's commands (L5.2; docs/guide/desktop-app.md "Desktop app (macOS)") — `pnpm desktop:<command>`:
 *
 * - `dev [--root <workspace>] [--route '#/p/…']` — a debug build, run with this Node.js and the repository's built CLI
 *   (RETAKE_NODE / RETAKE_CLI: a debug build honours them).
 * - `build [--out <folder>]` — a release build assembled into `<productName>.app` (Info.plist, icon, launch.json naming
 *   this Node.js and the repository's CLI), signed ad hoc (`codesign -s -`): a local app, never installed anywhere —
 *   move it yourself if you want it in Applications. `--id` (tests only) gives it another bundle id under the
 *   app's own (`<identifier>.<suffix>`).
 * - `test` — the shell's rules (apps/desktop/core: no dependency, seconds).
 * - `clean` — the build folders (the shell's ≈ 1–2 GB, the rules crate's ≈ 10 MB), Tauri's generated `gen/` and the
 *   built app's Launch Services record.
 *
 * Cargo always runs with `--locked` (Cargo.lock is committed), with `--offline` when CARGO_NET_OFFLINE=true or
 * `--offline` is passed (a machine whose cargo cache lacks a crate: `cargo fetch --locked` once with a network). The
 * build folders are CARGO_TARGET_DIR when set, else apps/desktop/target (the shell) and apps/desktop/core/target (the
 * rules crate, also what desktop-core.test.ts builds) — inside the checkout, git-ignored, one set per checkout or
 * worktree. Rust is never needed by `pnpm build` or `pnpm test`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP_DIR, '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
// The binary's name has one place: Cargo.toml `name` (the shell's log prefix is the same constant: main.rs BIN).
const BIN = /^name = "([^"]+)"/m.exec(readFileSync(join(APP_DIR, 'Cargo.toml'), 'utf8'))[1];
// The app's name and bundle id have one place: tauri.conf.json (productName, identifier); the shell reads the name there too.
const CONF = JSON.parse(readFileSync(join(APP_DIR, 'tauri.conf.json'), 'utf8'));
const PRODUCT = CONF.productName;
export const BUNDLE_ID = CONF.identifier;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
};
const offline = process.env.CARGO_NET_OFFLINE === 'true' || (rest.includes('--offline') && (rest.splice(rest.indexOf('--offline'), 1), true));
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(APP_DIR, 'target');
const coreTarget = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(APP_DIR, 'core', 'target');
const CORE = join(APP_DIR, 'core', 'Cargo.toml');

function fail(message, code = 1) {
  process.stderr.write(`desktop: ${message}\n`);
  process.exit(code);
}

function cargo(args, manifest = join(APP_DIR, 'Cargo.toml'), dir = target) {
  const env = { ...process.env, CARGO_TARGET_DIR: dir, ...(offline ? { CARGO_NET_OFFLINE: 'true' } : {}) };
  const r = spawnSync('cargo', [...args, '--locked', ...(offline ? ['--offline'] : []), '--manifest-path', manifest], { stdio: 'inherit', env });
  if (r.error && r.error.code === 'ENOENT') fail('the desktop shell needs Rust (cargo on PATH) and the Xcode command line tools: docs/guide/desktop-app.md › Desktop app (macOS)', 2);
  if (r.status !== 0) {
    fail(`cargo ${args[0]} failed${offline ? ' (offline: a crate missing from the cargo cache needs `cargo fetch --locked` once with a network)' : ''}`, r.status ?? 1);
  }
}

function needMac() {
  if (process.platform !== 'darwin') fail('the desktop shell is macOS only for now (BACKLOG BL-37)', 2);
}

function needCli() {
  if (!existsSync(CLI)) fail('run pnpm build first (the app runs packages/cli/dist/bin.js)', 2);
  if (Number(process.versions.node.split('.')[0]) < 22) fail(`Node.js 22 or later runs the Studio; this is ${process.version}`, 2);
}

function version() {
  return /^version = "([^"]+)"/m.exec(readFileSync(join(APP_DIR, 'Cargo.toml'), 'utf8'))[1];
}

/**
 * macOS asks before a process of the app reaches the local network (a capture of a product on another machine of the
 * network: the worker and its browser are the app's children — critique M8). Also the bundled app's (bundle.mjs).
 */
export const LOCAL_NETWORK_USAGE = `${PRODUCT} captures web apps you point it at, which may run on your local network.`;
export const APP_CATEGORY = 'public.app-category.developer-tools';

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function infoPlist(id, v) {
  const entries = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: PRODUCT,
    CFBundleExecutable: BIN,
    CFBundleIconFile: 'icon',
    CFBundleIdentifier: id,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: PRODUCT,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: v,
    CFBundleVersion: v,
    LSApplicationCategoryType: APP_CATEGORY,
    LSMinimumSystemVersion: '13.0',
    NSLocalNetworkUsageDescription: LOCAL_NETWORK_USAGE,
  };
  const body = Object.entries(entries)
    .map(([k, v2]) => `\t<key>${k}</key>\n\t<string>${xml(v2)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
\t<key>NSHighResolutionCapable</key>
\t<true/>
</dict>
</plist>
`;
}

function run(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], env });
  if (r.status !== 0) fail(`${cmd} failed`);
}

/**
 * L5.13b: the icns slots drawn for their size — the mark's tiny (16 pt) and small (32 pt) drawings, file → pixel size
 * (`pnpm -F @retake/ui gen:mark` writes them to icons/iconset/; mark.ts MARK_ICONSET, a test compares the two lists).
 */
export const DRAWN_ICONS = Object.freeze({ 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64 });

/**
 * What is wrong with the drawn icons in `dir` (none: an empty list): each must be there, a PNG, of its slot's pixel size
 * (read from its IHDR header — iconutil accepts a mis-sized PNG without a word). No sips fallback for those slots.
 */
export function drawnIconProblems(dir = join(APP_DIR, 'icons', 'iconset')) {
  const problems = [];
  for (const [file, px] of Object.entries(DRAWN_ICONS)) {
    const p = join(dir, file);
    if (!existsSync(p)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const b = readFileSync(p);
    if (b.length < 24 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.subarray(12, 16).toString('latin1') !== 'IHDR') {
      problems.push(`${file} is not a PNG`);
      continue;
    }
    const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (w !== px || h !== px) problems.push(`${file} is ${w}×${h}, its slot needs ${px}×${px}`);
  }
  return problems;
}

/**
 * icon.png (1024²) → icon.icns through an iconset (sips + iconutil, both part of macOS). L5.13b: the 16 and 32 pt slots
 * are the drawn icons of icons/iconset/ (required, sizes checked), the larger ones are downscaled from icon.png. Also
 * the bundled app's icon (bundle.mjs, L5.16: `env`, the build's allow-listed environment).
 */
export function icns(out, env = process.env) {
  const problems = drawnIconProblems();
  if (problems.length) fail(`apps/desktop/icons/iconset: ${problems.join('; ')} — run pnpm -F @retake/ui gen:mark`);
  const work = mkdtempSync(join(tmpdir(), 'retake-icon-'));
  try {
    const set = join(work, 'icon.iconset');
    mkdirSync(set);
    const src = join(APP_DIR, 'icons', 'icon.png');
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [file, px] of [[`icon_${size}x${size}.png`, size], [`icon_${size}x${size}@2x.png`, size * 2]]) {
        if (file in DRAWN_ICONS) copyFileSync(join(APP_DIR, 'icons', 'iconset', file), join(set, file));
        else run('sips', ['-z', String(px), String(px), src, '--out', join(set, file)], env);
      }
    }
    run('iconutil', ['-c', 'icns', set, '-o', out], env);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function build() {
  needMac();
  needCli();
  const out = resolve(flag('--out') ?? join(target, 'release', 'bundle'));
  const id = flag('--id') ?? BUNDLE_ID;
  if (id !== BUNDLE_ID && !(id.startsWith(`${BUNDLE_ID}.`) && /^[a-z0-9-]{1,32}$/.test(id.slice(BUNDLE_ID.length + 1)))) fail(`--id must be ${BUNDLE_ID}.<suffix> (tests)`, 2);
  if (/^\/Applications(\/|$)/.test(out)) fail('the app is built in the repository (or --out), never into /Applications', 2);
  cargo(['build', '--release', '--features', 'custom-protocol']);
  const { stableNodePath } = await import(pathToFileURL(join(REPO, 'packages', 'engine', 'dist', 'integrations.js')).href);
  const app = join(out, `${PRODUCT}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), infoPlist(id, version()));
  copyFileSync(join(target, 'release', BIN), join(app, 'Contents', 'MacOS', BIN));
  chmodSync(join(app, 'Contents', 'MacOS', BIN), 0o755);
  icns(join(app, 'Contents', 'Resources', 'icon.icns'));
  // What the app runs (docs/guide/desktop-app.md): this Node.js (by a path that survives a patch upgrade) and this repository's CLI.
  writeFileSync(join(app, 'Contents', 'Resources', 'launch.json'), `${JSON.stringify({ version: 1, node: stableNodePath(process.execPath), cli: CLI }, null, 2)}\n`);
  // Ad hoc: a local signature (no identity, no entitlement) so macOS runs the bundle as one app.
  run('codesign', ['--force', '--sign', '-', app]);
  process.stdout.write(`${app}\n`);
}

function dev() {
  needMac();
  needCli();
  cargo(['build']);
  const child = spawn(join(target, 'debug', BIN), rest, { stdio: 'inherit', env: { ...process.env, RETAKE_NODE: process.execPath, RETAKE_CLI: CLI } });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function clean() {
  const app = join(target, 'release', 'bundle', `${PRODUCT}.app`);
  if (process.platform === 'darwin' && existsSync(app) && existsSync(LSREGISTER)) spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
  if (existsSync(target)) cargo(['clean']);
  if (existsSync(coreTarget)) cargo(['clean'], CORE, coreTarget);
  rmSync(join(APP_DIR, 'gen'), { recursive: true, force: true });
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  switch (command) {
    case 'dev':
      dev();
      break;
    case 'build':
      await build();
      break;
    case 'test':
      cargo(['test'], CORE, coreTarget);
      break;
    case 'clean':
      clean();
      break;
    default:
      fail('usage: node apps/desktop/scripts/desktop.mjs dev|build|test|clean', 2);
  }
}
