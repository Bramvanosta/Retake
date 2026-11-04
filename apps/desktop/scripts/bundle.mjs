#!/usr/bin/env node
/**
 * The app bundle's payload (L5.16, DESIGN §4p) — `node apps/desktop/scripts/bundle.mjs stage --out <dir> [--ffmpeg <dir>]`:
 * everything `Retake.app/Contents/Resources` holds besides the shell, staged into a folder outside the checkout,
 * offline:
 *
 *   bundle.json          the manifest core reads (bundle.ts): versions, relative paths, sha256 and sizes
 *   node/bin/node        the Node.js running this script (major 22), re-signed ad hoc
 *   engine/              `pnpm deploy --prod` of @retake/cli, hoisted (no machine path), pruned (maps, .d.ts, .bin);
 *                        Remotion's compositor with its install names rewritten to @loader_path; engine/templates/
 *                        (the git-tracked starter themes)
 *   browsers/            the Chromium and headless shell revisions the deployed playwright-core pins, from Playwright's cache
 *   ffmpeg/bin/          ffmpeg + ffprobe from --ffmpeg (relocatable: system libraries only), else none (ffmpeg: null)
 *   plugin/              the Claude plugin marketplace (.claude-plugin/marketplace.json + the git-tracked skills/)
 *   licenses/            Node.js, Chromium, Remotion, THIRD-PARTY.md (the deployed npm packages), apps/desktop/licenses/
 *                        (our ffmpeg's and Remotion's compositor's GPL notices and source offers)
 *
 * Signing (beyond ad hoc), the Tauri app and the DMG are part b's (`pnpm desktop:bundle`). `checkStage(dir)` is the
 * layout check run at the end and by the tests on a small fake stage. Never writes inside the checkout or /Applications:
 * pnpm imports the injected workspace packages as hard links to the checkout's own files (package.json, dist/), so
 * `deployEngine` gives every linked file of the deploy an inode of its own before anything is written (`breakHardLinks`),
 * `checkStage` refuses a file with more than one link, and `stage` ends by comparing the checkout's `git status` (and
 * the bytes of every file it lists) with what it was before.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP_DIR, '..', '..');
/** Lowest macOS the bundle runs on: Remotion's own libraries are built for 15.0 (part b puts it in Info.plist). */
export const MINIMUM_MACOS = '15.0';
/** Node.js major the engine needs (package.json engines) and the stage copies. */
const NODE_MAJOR = 22;
/** Marker files playwright-core's registry checks in each browser folder (they must stay empty: the app seals them). */
export const BROWSER_MARKERS = ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED'];
/** What the stage writes in its folder first, so a later stage may replace it (and nothing else). */
const STAGE_MARK = '.retake-stage';
/** Text files the machine-path check reads (bounded: a bigger file is skipped — none of ours is). */
const TEXT_FILE = /\.(?:js|mjs|cjs|json|md|markdown|txt|ya?ml|html?|css|tsx?|jsx|svg|sh|plist|xml)$/i;
const TEXT_MAX_BYTES = 8 * 1024 * 1024;

class StageError extends Error {}

const within = (dir, p) => {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new StageError(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new StageError(`${cmd} ${args.slice(0, 3).join(' ')}… failed (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ')}`);
  return r.stdout;
}

/** Every file and link under `dir` (depth first), as paths. */
export function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, out);
  }
  return out;
}

/** Mach-O by its first four bytes: thin 32 / 64-bit (either byte order) and FAT (universal) binaries. */
export function machOKind(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 0) < 4) return null;
    const m = b.readUInt32BE(0);
    if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return 'thin';
    // FAT: 0xcafebabe is also Java's class magic; Java classes are not shipped, the arch count tells them apart.
    if (m === 0xcafebabe || m === 0xcafebabf) {
      const n = Buffer.alloc(4);
      readSync(fd, n, 0, 4, 4);
      return n.readUInt32BE(0) > 0 && n.readUInt32BE(0) < 20 ? 'fat' : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sizeOf(p) {
  const out = run('du', ['-sk', p]);
  return Number(out.split(/\s/)[0]) * 1024;
}

/**
 * The layout check (also the tests'): bundle.json's paths inside the stage and present; every symbolic link relative
 * and resolving inside the stage; no regular file with more than one hard link (a link shared with the checkout or a
 * store: a write to either changes the other); no `machinePaths` (the build machine's home and checkout) in any text
 * file of the stage (TEXT_FILE, up to TEXT_MAX_BYTES each); the browser markers empty; one playwright-core; every
 * Mach-O listed. Returns `{ problems, machO }`.
 */
export function checkStage(dir, opts = {}) {
  const root = realpathSync(resolve(dir));
  const problems = [];
  const machinePaths = (opts.machinePaths ?? [homedir(), REPO]).filter((p) => p && p !== '/');
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8'));
  } catch (e) {
    problems.push(`bundle.json: ${e.message}`);
  }
  if (manifest) {
    if (manifest.v !== 1) problems.push('bundle.json: v must be 1');
    for (const key of ['node', 'engine', 'browsers', 'templates', 'plugin', 'ffmpeg']) {
      const rel = manifest.paths?.[key];
      if (rel === null && key === 'ffmpeg') continue;
      if (typeof rel !== 'string' || !rel || isAbsolute(rel)) {
        problems.push(`bundle.json: paths.${key} must be a relative path`);
        continue;
      }
      const abs = resolve(root, rel);
      if (!within(root, abs)) problems.push(`bundle.json: paths.${key} (${rel}) leaves the stage`);
      else if (!existsSync(abs)) problems.push(`bundle.json: paths.${key} (${rel}) is missing`);
    }
    if (manifest.paths?.engine && !existsSync(join(root, manifest.paths.engine, 'dist', 'bin.js'))) problems.push('engine/dist/bin.js is missing');
    for (const rev of [manifest.playwright?.chromium && `chromium-${manifest.playwright.chromium}`, manifest.playwright?.headless_shell && `chromium_headless_shell-${manifest.playwright.headless_shell}`].filter(Boolean)) {
      for (const m of BROWSER_MARKERS) {
        const f = join(root, manifest.paths?.browsers ?? 'browsers', rev, m);
        if (!existsSync(f)) problems.push(`${relative(root, f)} is missing`);
        else if (statSync(f).size !== 0) problems.push(`${relative(root, f)} is not empty`);
      }
    }
  }
  const machO = [];
  let playwrights = 0;
  for (const p of walk(root)) {
    const st = lstatSync(p);
    const rel = relative(root, p);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(p);
      if (isAbsolute(target)) problems.push(`${rel}: link to an absolute path (${target})`);
      else if (!within(root, resolve(dirname(p), target))) problems.push(`${rel}: link leaves the stage (${target})`);
      continue;
    }
    if (st.isDirectory()) {
      if (p.endsWith(`${sep}node_modules${sep}playwright-core`)) playwrights++;
      continue;
    }
    const name = p.slice(p.lastIndexOf(sep) + 1);
    if (st.nlink > 1) problems.push(`${rel}: ${st.nlink} hard links (the stage must own each of its files)`);
    if (TEXT_FILE.test(name) && st.size <= TEXT_MAX_BYTES) {
      const text = readFileSync(p, 'utf8');
      for (const m of machinePaths) if (text.includes(m)) problems.push(`${rel} names a path of the build machine (${m})`);
    }
    if (st.size >= 4 && (st.mode & 0o111 || /\.(dylib|node|so)$/.test(name))) {
      const kind = machOKind(p);
      if (kind) machO.push({ path: rel, kind });
    }
  }
  if (manifest && playwrights !== 1) problems.push(`the engine holds ${playwrights} copies of playwright-core (one is pinned to the bundled browsers)`);
  return { problems, machO };
}

/** The install names of a Mach-O that are bare file names (no folder: found only through DYLD_LIBRARY_PATH). */
export function bareInstallNames(otoolL) {
  return otoolL
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' (')[0])
    .filter((n) => n && !n.includes('/'));
}

/** Rewrite the compositor's bare install names to @loader_path/<name> (the hardened runtime ignores DYLD_LIBRARY_PATH). */
function relinkCompositor(dir) {
  const files = readdirSync(dir).filter((f) => machOKind(join(dir, f)));
  for (const f of files) {
    const file = join(dir, f);
    const args = [];
    if (f.endsWith('.dylib')) args.push('-id', `@loader_path/${f}`);
    for (const name of bareInstallNames(run('otool', ['-L', file]))) if (name !== f || !f.endsWith('.dylib')) args.push('-change', name, `@loader_path/${name}`);
    if (args.length) run('install_name_tool', [...args, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    run('codesign', ['--force', '-s', '-', file]);
    const left = bareInstallNames(run('otool', ['-L', file])).filter((n) => !(f.endsWith('.dylib') && n === f));
    if (left.length) throw new StageError(`${file}: install names left bare: ${left.join(', ')}`);
  }
  return files;
}

/** ffmpeg / ffprobe handed with --ffmpeg: both present, run, system libraries only; their -version / -buildconf. */
function checkFfmpeg(dir) {
  const out = {};
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const file = join(dir, tool);
    if (!existsSync(file)) throw new StageError(`--ffmpeg ${dir}: no ${tool} there`);
    const libs = run('otool', ['-L', file]).split('\n').slice(1).map((l) => l.trim().split(' (')[0]).filter(Boolean);
    const foreign = libs.filter((l) => !l.startsWith('/usr/lib/') && !l.startsWith('/System/'));
    if (foreign.length) throw new StageError(`${file} links libraries outside the system (${foreign.join(', ')}): it would not run from the app`);
    out[tool] = run(file, ['-hide_banner', '-version'], { env: { PATH: '/usr/bin:/bin' } }).split('\n')[0];
  }
  const encoders = run(join(dir, 'ffmpeg'), ['-hide_banner', '-encoders'], { env: { PATH: '/usr/bin:/bin' } });
  const licence = run(join(dir, 'ffmpeg'), ['-hide_banner', '-L'], { env: { PATH: '/usr/bin:/bin' } });
  return {
    version: /version\s+(\S+)/.exec(out.ffmpeg)?.[1] ?? out.ffmpeg,
    licence: /GNU General Public License/.test(licence) ? 'GPL-2.0-or-later' : /Lesser General Public License/.test(licence) ? 'LGPL-2.1-or-later' : 'unknown',
    libx264: /\slibx264\s/.test(encoders),
  };
}

function licenceOf(dir) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md', 'COPYING']) if (existsSync(join(dir, name))) return name;
  return null;
}

/** THIRD-PARTY.md: every npm package of the deployed engine with its version, licence field and licence file. */
function thirdParty(engine) {
  const rows = [];
  const visit = (nm) => {
    if (!existsSync(nm)) return;
    for (const e of readdirSync(nm)) {
      if (e.startsWith('.')) continue;
      const dirs = e.startsWith('@') ? readdirSync(join(nm, e)).map((x) => join(nm, e, x)) : [join(nm, e)];
      for (const d of dirs) {
        try {
          const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
          const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : 'see package');
          rows.push(`| ${pkg.name} | ${pkg.version} | ${lic} | ${licenceOf(d) ? `engine/${relative(engine, join(d, licenceOf(d)))}` : '—'} |`);
        } catch {
          // not a package
        }
        visit(join(d, 'node_modules'));
      }
    }
  };
  visit(join(engine, 'node_modules'));
  rows.sort();
  return `# Third-party npm packages in this app's engine\n\nGenerated by apps/desktop/scripts/bundle.mjs. Each package keeps its own licence file in its folder.\n\n| Package | Version | Licence | Licence file |\n|---|---|---|---|\n${rows.join('\n')}\n`;
}

/**
 * Give every regular file under `dir` with more than one hard link an inode of its own (a copy renamed over it, mode
 * kept). pnpm deploy imports injected workspace packages as hard links to the checkout's files: written in place, the
 * stage would rewrite the checkout. Returns how many files were unlinked.
 */
export function breakHardLinks(dir) {
  let n = 0;
  for (const p of walk(dir)) {
    const st = lstatSync(p);
    if (!st.isFile() || st.nlink < 2) continue;
    const tmp = `${p}.retake-unlink-${process.pid}`;
    copyFileSync(p, tmp);
    chmodSync(tmp, st.mode & 0o7777);
    renameSync(tmp, p);
    n++;
  }
  return n;
}

/**
 * `pnpm deploy` of `filter` (production dependencies, injected workspace packages, hoisted: the isolated layout names
 * the build machine's paths in .pnpm folders), offline, into `engine`; then its hard links broken (before any write),
 * pnpm's own records removed and the injected packages' `workspace:` / `file:` specs replaced by their versions, as
 * published packages name each other. Exported for the tests (a mini workspace).
 */
export function deployEngine(repo, engine, filter = '@retake/cli') {
  run('pnpm', ['--config.inject-workspace-packages=true', '--config.node-linker=hoisted', '--filter', filter, '--prod', '--offline', 'deploy', engine], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const unlinked = breakHardLinks(engine);
  // pnpm's own records name the build machine (store, file: links): the engine runs without them.
  for (const f of ['pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.package-lock.json']) rmSync(join(engine, f), { recursive: true, force: true });
  const scopes = readdirSync(join(engine, 'node_modules')).filter((e) => e.startsWith('@'));
  const injected = [];
  for (const scope of scopes) for (const d of readdirSync(join(engine, 'node_modules', scope))) injected.push(join(engine, 'node_modules', scope, d, 'package.json'));
  for (const pkgFile of [join(engine, 'package.json'), ...injected.filter((f) => existsSync(f))]) {
    const text = readFileSync(pkgFile, 'utf8');
    const pkg = JSON.parse(text);
    let changed = false;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[group] ?? {})) {
        if (typeof spec === 'string' && (spec.includes('file:') || spec.startsWith('workspace:'))) {
          pkg[group][name] = JSON.parse(readFileSync(join(engine, 'node_modules', name, 'package.json'), 'utf8')).version;
          changed = true;
        }
      }
    }
    if (changed) writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { unlinked };
}

/**
 * What `git status` says of the checkout, with the sha256 of every file it lists (a file modified already and written
 * again keeps its status line: its bytes tell). The stage compares it before and after.
 */
export function repoSnapshot(repo) {
  const out = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo });
  const lines = [];
  const entries = out.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const path = e.slice(3);
    // A rename / copy is followed by its source path.
    if (e[0] === 'R' || e[0] === 'C') i++;
    const abs = join(repo, path);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    lines.push(`${e.slice(0, 2)} ${path} ${st?.isFile() ? sha256(abs) : st ? 'other' : 'gone'}`);
  }
  return lines.join('\n');
}

/**
 * The files of `rel` (a folder of the checkout) git tracks — what a stage may copy of it (no stray, ignored or
 * untracked file: a `.env`, notes, `.DS_Store`). `untracked: true` adds the untracked files git does not ignore, minus
 * dot files (the licence folder, written before its first commit).
 */
export function trackedFiles(repo, rel, o = {}) {
  const tracked = run('git', ['ls-files', '-z', '--', rel], { cwd: repo }).split('\0').filter(Boolean);
  const others = o.untracked
    ? run('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', rel], { cwd: repo })
        .split('\0')
        .filter((f) => f && !f.split('/').some((part) => part.startsWith('.')))
    : [];
  return [...new Set([...tracked, ...others])].filter((f) => existsSync(join(repo, f)));
}

/** Copy the git-tracked files of `rel` (a folder of the checkout) to `to`, keeping their relative layout. */
function copyTracked(repo, rel, to, o = {}) {
  for (const f of trackedFiles(repo, rel, o)) {
    const dest = join(to, relative(rel, f));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repo, f), dest);
    chmodSync(dest, statSync(join(repo, f)).mode & 0o7777);
  }
}

/**
 * The stage (see the module comment). Returns the manifest written. Whatever happens, the checkout must be as it was
 * (`repoSnapshot` before and after): a stage that changed it fails loudly, naming both states.
 */
export function stage(opts) {
  const before = repoSnapshot(REPO);
  let result;
  let failure;
  try {
    result = stageInto(opts);
  } catch (e) {
    failure = e;
  }
  const after = repoSnapshot(REPO);
  if (after !== before) {
    throw new StageError(`the stage changed the checkout (${REPO}) — restore it before anything else${failure ? ` (the stage also failed: ${failure.message})` : ''}:\n  before:\n${before}\n  after:\n${after}`);
  }
  if (failure) throw failure;
  return result;
}

function stageInto({ out, ffmpeg }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new StageError('the app bundle is macOS on Apple silicon only for now (BACKLOG BL-139)');
  if (Number(process.versions.node.split('.')[0]) !== NODE_MAJOR) throw new StageError(`run the stage with Node.js ${NODE_MAJOR} (it copies the Node.js running it); this is ${process.version}`);
  if (!existsSync(join(REPO, 'packages', 'cli', 'dist', 'bin.js'))) throw new StageError('run pnpm build first');
  const dir = resolve(out);
  if (within(REPO, dir) || within(dir, REPO)) throw new StageError(`--out ${dir}: stage outside the checkout (a scratch folder)`);
  if (within('/Applications', dir)) throw new StageError('--out: never into /Applications');
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!existsSync(join(dir, STAGE_MARK))) throw new StageError(`--out ${dir} is not empty and is not a previous stage`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STAGE_MARK), '');
  const t0 = Date.now();
  const say = (m) => process.stderr.write(`stage: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);

  // The engine: deployed, its hard links to the checkout broken first (deployEngine).
  const engine = join(dir, 'engine');
  const { unlinked } = deployEngine(REPO, engine);
  say(`engine deployed (${unlinked} files linked to the checkout or the store, now copies)`);
  for (const p of walk(engine)) {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    const base = p.slice(p.lastIndexOf(sep) + 1);
    if (st.isDirectory() && base === '.bin' && p.includes(`${sep}node_modules${sep}`)) rmSync(p, { recursive: true, force: true });
    else if (st.isFile() && /\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(base)) rmSync(p, { force: true });
  }
  copyTracked(REPO, 'templates', join(engine, 'templates'));
  const compositorDir = join(engine, 'node_modules', '@remotion', 'compositor-darwin-arm64');
  const compositor = relinkCompositor(compositorDir);
  // The relinked compositor runs without DYLD_LIBRARY_PATH (what the hardened runtime ignores).
  run(join(compositorDir, 'ffprobe'), ['-hide_banner', '-version'], { env: { PATH: '/usr/bin:/bin' } });
  say(`engine pruned, compositor relinked (${compositor.length} files)`);

  // Node.js: this one (major 22), system libraries only, re-signed ad hoc (part b signs it for real).
  const nodeBin = join(dir, 'node', 'bin', 'node');
  mkdirSync(dirname(nodeBin), { recursive: true });
  cpSync(process.execPath, nodeBin);
  const nodeLibs = run('otool', ['-L', nodeBin]).split('\n').slice(1).map((l) => l.trim().split(' (')[0]).filter(Boolean);
  const foreign = nodeLibs.filter((l) => !l.startsWith('/usr/lib/') && !l.startsWith('/System/'));
  if (foreign.length) throw new StageError(`${process.execPath} links libraries outside the system (${foreign.join(', ')})`);
  run('codesign', ['--force', '-s', '-', nodeBin]);
  run(nodeBin, ['--version'], { env: {} });
  say('node copied');

  // Browsers: the revisions the deployed playwright-core pins, from Playwright's cache (never downloaded here).
  const pwDir = join(engine, 'node_modules', 'playwright-core');
  const pw = JSON.parse(readFileSync(join(pwDir, 'package.json'), 'utf8'));
  const pins = JSON.parse(readFileSync(join(pwDir, 'browsers.json'), 'utf8')).browsers;
  const rev = (name) => pins.find((b) => b.name === name)?.revision;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? resolve(process.env.PLAYWRIGHT_BROWSERS_PATH) : join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const browsers = join(dir, 'browsers');
  mkdirSync(browsers, { recursive: true });
  for (const folder of [`chromium-${rev('chromium')}`, `chromium_headless_shell-${rev('chromium-headless-shell')}`]) {
    const from = join(cache, folder);
    if (!existsSync(join(from, 'INSTALLATION_COMPLETE'))) throw new StageError(`${from} is missing: run (with a network) node ${relative(REPO, join(REPO, 'node_modules', 'playwright-core', 'cli.js'))} install chromium chromium-headless-shell — playwright-core ${pw.version} pins ${folder}`);
    run('ditto', [from, join(browsers, folder)]);
    for (const m of BROWSER_MARKERS) {
      writeFileSync(join(browsers, folder, m), '');
      // A fresh mark: playwright-core re-validates (and rewrites, empty) one older than 30 days.
      utimesSync(join(browsers, folder, m), new Date(), new Date());
    }
  }
  say('browsers copied');

  // ffmpeg (optional): relocatable (system libraries only), else the system's is used (ffmpeg: null).
  let ffmpegInfo = null;
  if (ffmpeg) {
    const info = checkFfmpeg(resolve(ffmpeg));
    mkdirSync(join(dir, 'ffmpeg', 'bin'), { recursive: true });
    const sums = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
      cpSync(join(resolve(ffmpeg), tool), join(dir, 'ffmpeg', 'bin', tool));
      sums[tool] = sha256(join(dir, 'ffmpeg', 'bin', tool));
    }
    ffmpegInfo = { version: info.version, licence: info.licence, libx264: info.libx264, sha256: sums };
    say(`ffmpeg ${info.version} (${info.licence}${info.libx264 ? ', libx264' : ', no libx264: H.264 through VideoToolbox'})`);
  }

  // The Claude plugin marketplace, then licences.
  mkdirSync(join(dir, 'plugin', '.claude-plugin'), { recursive: true });
  cpSync(join(REPO, '.claude-plugin', 'marketplace.json'), join(dir, 'plugin', '.claude-plugin', 'marketplace.json'));
  copyTracked(REPO, 'skills', join(dir, 'plugin', 'skills'));
  const lic = join(dir, 'licenses');
  mkdirSync(join(lic, 'node'), { recursive: true });
  const nodePrefix = resolve(dirname(process.execPath), '..');
  if (existsSync(join(nodePrefix, 'LICENSE'))) cpSync(join(nodePrefix, 'LICENSE'), join(lic, 'node', 'LICENSE'));
  else throw new StageError(`no LICENSE beside ${process.execPath} (Node.js's licence must ship with it)`);
  mkdirSync(join(lic, 'chromium'), { recursive: true });
  writeFileSync(
    join(lic, 'chromium', 'NOTICE.md'),
    `# Chromium\n\nChromium ${pins.find((b) => b.name === 'chromium')?.browserVersion ?? ''} as built by the Playwright project (playwright-core ${pw.version}, revisions ${rev('chromium')} / ${rev('chromium-headless-shell')}).\nChromium is distributed under the BSD 3-clause licence of The Chromium Authors and the licences of its third-party components;\nthe complete list is built into the browser (chrome://credits). Playwright: Apache-2.0 (engine/node_modules/playwright-core/LICENSE).\n`,
  );
  mkdirSync(join(lic, 'remotion'), { recursive: true });
  const remotionLicence = join(engine, 'node_modules', 'remotion', licenceOf(join(engine, 'node_modules', 'remotion')) ?? 'LICENSE.md');
  if (existsSync(remotionLicence)) cpSync(remotionLicence, join(lic, 'remotion', 'LICENSE.md'));
  // Remotion's compositor carries its own GPL ffmpeg: its notice and source offer (apps/desktop/licenses/remotion-compositor)
  // must name the version deployed.
  const compositorVersion = JSON.parse(readFileSync(join(compositorDir, 'package.json'), 'utf8')).version;
  const compositorNotice = join(APP_DIR, 'licenses', 'remotion-compositor', 'README.md');
  if (!existsSync(compositorNotice) || !readFileSync(compositorNotice, 'utf8').includes(`@remotion/compositor-darwin-arm64 ${compositorVersion}`)) {
    throw new StageError(`${relative(REPO, compositorNotice)} must describe @remotion/compositor-darwin-arm64 ${compositorVersion} (its ffmpeg version, configuration and source): update it with the Remotion upgrade`);
  }
  copyTracked(REPO, relative(REPO, join(APP_DIR, 'licenses')), lic, { untracked: true });
  writeFileSync(join(lic, 'THIRD-PARTY.md'), thirdParty(engine));
  say('plugin and licences');

  // Stage hygiene: no extended attributes (provenance / quarantine on the copied browsers).
  run('xattr', ['-cr', dir]);

  const cliPkg = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8'));
  const compositorPkg = JSON.parse(readFileSync(join(compositorDir, 'package.json'), 'utf8'));
  const manifest = {
    v: 1,
    app: cliPkg.version,
    node: process.versions.node,
    playwright: { core: pw.version, chromium: rev('chromium'), headless_shell: rev('chromium-headless-shell') },
    compositor: compositorPkg.version,
    ffmpeg: ffmpegInfo,
    minimum_macos: MINIMUM_MACOS,
    paths: { node: 'node/bin/node', engine: 'engine', browsers: 'browsers', ffmpeg: ffmpegInfo ? 'ffmpeg/bin' : null, templates: 'engine/templates', plugin: 'plugin' },
    sha256: { node: sha256(nodeBin) },
    sizes: {},
  };
  for (const part of ['node', 'engine', 'browsers', 'ffmpeg', 'plugin', 'licenses']) if (existsSync(join(dir, part))) manifest.sizes[part] = sizeOf(join(dir, part));
  writeFileSync(join(dir, 'bundle.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  rmSync(join(dir, STAGE_MARK), { force: true });
  const { problems, machO } = checkStage(dir);
  writeFileSync(join(dir, STAGE_MARK), '');
  if (problems.length) throw new StageError(`the stage fails its own check:\n  ${problems.join('\n  ')}`);
  manifest.sizes.total = sizeOf(dir);
  say(`done: ${(manifest.sizes.total / 1e6).toFixed(0)} MB, ${machO.length} Mach-O files`);
  return { manifest, machO };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (command === 'stage') {
      const out = flag('--out');
      if (!out) throw new StageError('stage --out <dir> [--ffmpeg <dir with ffmpeg and ffprobe>]');
      const { manifest } = stage({ out, ffmpeg: flag('--ffmpeg') });
      process.stdout.write(`${JSON.stringify({ out: resolve(out), sizes: manifest.sizes, ffmpeg: manifest.ffmpeg, app: manifest.app }, null, 1)}\n`);
    } else if (command === 'check') {
      const { problems, machO } = checkStage(rest[0] ?? '.');
      process.stdout.write(`${JSON.stringify({ problems, machO: machO.length }, null, 1)}\n`);
      process.exit(problems.length ? 1 : 0);
    } else {
      throw new StageError('usage: bundle.mjs stage --out <dir> [--ffmpeg <dir>] | check <dir>');
    }
  } catch (e) {
    process.stderr.write(`bundle: ${e instanceof StageError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
