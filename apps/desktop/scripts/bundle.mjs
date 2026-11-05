#!/usr/bin/env node
/**
 * The bundled app (L5.16, DESIGN §4p).
 *
 * `pnpm desktop:bundle --out <dir> [--ffmpeg <dir>] [--stage <dir>]` (= `bundle.mjs build`; or RETAKE_BUNDLE_OUT;
 * `pnpm desktop:release …` = `build --release`, the person's signed and notarised run — sign.mjs):
 * stage → sign the payload (dry: ad hoc, sign.mjs) → bundle.json's hashes of the signed files → `tauri build --bundles
 * app --no-sign` with a generated config overlay (never committed: tauri.conf.json keeps `bundle.active: false`, so
 * `pnpm desktop:build` / `desktop:dev` / `desktop:test` — the developer app on the repository's CLI, launch.json version
 * 1 — are unchanged) → sign the shell and the app → verify (the signatures, Contents/Resources byte for byte against the
 * signed stage, attributes, Info.plist: `appProblems`) → then release.mjs `finishApp` (L5.16e fixes: a release re-signs
 * the ad hoc app with the Developer ID there, notarises and staples it; `--app-only` stops before): the update archive,
 * the DMG (`hdiutil create`, APFS, ULFO, an /Applications link; no Finder scripting; tried again on "Resource busy") →
 * verify it (`verifyDmg`: imageinfo; attached read-only, -nobrowse, at a mount point in `<out>`).
 * Everything lands in `<out>` — a dedicated folder (`checkFolder`: outside the checkout, /Applications, the home folder
 * and its Desktop / Documents / Downloads roots, ~/Library; empty or marked by an earlier build: `.retake-bundle`):
 * stage/, target/ (cargo; CARGO_TARGET_DIR when set outside the checkout), app/Retake.app (+ the Applications link: the
 * DMG's folder), Retake_<version>_aarch64.dmg, bundle-report.json (sizes, timings). Offline: Rust with --locked
 * (--offline when CARGO_NET_OFFLINE=true or --offline), the Tauri CLI rebuilt from the pnpm store, every file checked
 * against the sha512 pinned in apps/desktop/bundle/tauri-cli.json — no dependency added (an offline `pnpm add` rewrites
 * the lockfile without the optional platform packages it has no metadata for). Every child of the build — pnpm, git,
 * codesign, tauri and cargo (every crate's build script), hdiutil, xcrun — runs with one allow-listed environment
 * (`buildEnv`): no credential of the person's shell reaches any of them. tauri-build writes apps/desktop/gen (git
 * ignores it): the build puts that folder back as it was (`saveGenerated` / `restoreGenerated`), and the checkout's
 * snapshot covers it.
 *
 * `bundle.mjs stage --out <dir> [--ffmpeg <dir>]`: the payload alone —
 * everything `Retake.app/Contents/Resources` holds besides the shell, staged into a folder outside the checkout,
 * offline:
 *
 *   bundle.json          the manifest core reads (bundle.ts): versions, relative paths, sha256 (of the signed files,
 *                        after `build`: refreshManifestHashes) and sizes
 *   node/bin/node        the Node.js running this script (major 22), re-signed ad hoc
 *   node/guard.cjs       the module lookup guard (+ guard-hooks.mjs; apps/desktop/bundle/): every Node.js the app starts
 *                        loads it first (`--require`), so the app's code never resolves a module above the app
 *   engine/              `pnpm deploy --prod` of @retake/cli, hoisted (no machine path), pruned (maps, .d.ts, .bin,
 *                        playwright-core's browser-channel installer scripts — PRUNED);
 *                        Remotion's compositor with its install names rewritten to @loader_path; engine/templates/
 *                        (the git-tracked starter themes)
 *   browsers/            the Chromium and headless shell revisions the deployed playwright-core pins, from Playwright's cache
 *                        (less the framework's self-install script, which can run as root — PRUNED)
 *   ffmpeg/bin/          ffmpeg + ffprobe from --ffmpeg (relocatable: system libraries only), else none (ffmpeg: null)
 *   plugin/              the Claude plugin marketplace (.claude-plugin/marketplace.json + the git-tracked skills/)
 *   licenses/            Node.js, Chromium, Remotion, THIRD-PARTY.md (the deployed npm packages), apps/desktop/licenses/
 *                        (our ffmpeg's and Remotion's compositor's GPL notices and source offers)
 *
 *   (`build` adds launch.json — version 2, paths inside the app — and bin/retake, the launcher, before signing.)
 *
 * L5.16d, the updater: with RETAKE_UPDATE_FEED (the feed's https address — since L5.16f the repository's update-feed
 * release, `<server>/<owner>/<repo>/releases/download/update-feed/latest.json`, rc.json for a pre-release build:
 * `node scripts/release.mjs feed <version>` — any https feed for a local build) AND RETAKE_UPDATE_PUBKEY (the public
 * key `tauri signer generate` wrote), the build turns the cargo `updater` feature on and the overlay gains
 * `plugins.updater` = {pubkey, endpoints: [feed], requireSignedVersion, allowDowngrades: false} — never `dangerous*`,
 * never in the repository; one without the other is refused; neither: no updater ("Updates are off in this build"). Then, after the app is verified (and notarised), the update archive:
 * Retake.app.tar.gz made by us (`COPYFILE_DISABLE=1 /usr/bin/tar -czf`: the links kept, no AppleDouble file —
 * critique H3, checked against the app: `archiveProblems`) and signed by the Tauri CLI's `signer sign --app-version`
 * with TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) — given to that one command only — then verified here against the
 * public key (scripts/publish-update.mjs `verifyMinisign`). Without the private key the archive stays unsigned and
 * the report says so (nothing to publish).
 *
 * `checkStage(dir)` is the layout check run at the end and by the tests on a small fake stage. Never writes inside the checkout or /Applications (`checkFolder`):
 * pnpm imports the injected workspace packages as hard links to the checkout's own files (package.json, dist/), so
 * `deployEngine` gives every linked file of the deploy an inode of its own before anything is written (`breakHardLinks`),
 * `checkStage` refuses a file with more than one link, and `stage` ends by comparing the checkout's `git status` (and
 * the bytes of every file it lists) with what it was before.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MinisignError, decodePublicKey, verifyMinisign } from '../../../scripts/publish-update.mjs';
import { APP_CATEGORY, LOCAL_NETWORK_USAGE, icns } from './desktop.mjs';
import { finishApp } from './release.mjs';
import { SignError, readTable, signApp, signPayload, signer, verifyApp } from './sign.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP_DIR, '..', '..');
/** Lowest macOS the bundle runs on: Remotion's own libraries are built for 15.0 (Info.plist's LSMinimumSystemVersion). */
export const MINIMUM_MACOS = '15.0';
/**
 * The Node.js the stage copies (review e A-M3): this exact version and the sha256 of its official darwin-arm64
 * binary (apps/desktop/bundle/node.json) — a release never ships a Node.js nobody chose.
 */
export const NODE_PIN = JSON.parse(readFileSync(join(APP_DIR, 'bundle', 'node.json'), 'utf8'));
/**
 * The browsers the stage copies (review e A-M3): each Playwright revision folder's tree digest (`browserDigest`),
 * recorded from a known install (apps/desktop/bundle/browsers.json) — Playwright's installer checks no hash.
 */
export const BROWSER_PINS = JSON.parse(readFileSync(join(APP_DIR, 'bundle', 'browsers.json'), 'utf8'));
/** Marker files playwright-core's registry checks in each browser folder (they must stay empty: the app seals them). */
export const BROWSER_MARKERS = ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED'];
/** What the stage writes in its folder first, so a later stage may replace it (and nothing else). */
const STAGE_MARK = '.retake-stage';
/** What a build writes in its `--out` folder first: a later build may write there again (and nowhere else). */
export const BUILD_MARK = '.retake-bundle';
/** The module lookup guard's place in the payload (core BUNDLE_GUARD: the worker and MCP registration load it too). */
export const GUARD = 'node/guard.cjs';
/** What the stage removes from the payload: installer scripts nothing of Retake runs (one can run as root). */
export const PRUNED = ['engine/node_modules/playwright-core/bin', 'browsers/*/chrome-mac/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/*/Resources/install.sh'];
/**
 * What patches/@remotion__renderer@<version>.patch (root package.json `pnpm.patchedDependencies`) leaves in each file
 * of @remotion/renderer it changes, and how many times: on macOS the render browser keeps Chromium's OS sandbox and
 * isolates sites (`render-sandbox`); the bundle server listens on loopback only and refuses a foreign Host or a
 * cross-origin request (`loopback-server`). The stage refuses an engine whose renderer lacks one (`rendererPatchProblems`):
 * the deploy must carry the patch. docs/RELEASING.md says how to port it to another Remotion version.
 */
export const RENDERER_PATCH_MARKS = {
  'dist/open-browser.js': { 'retake-patch: render-sandbox': 1 },
  'dist/port-config.js': { 'retake-patch: loopback-server': 1 },
  'dist/serve-static.js': { 'retake-patch: loopback-server': 1 },
  'dist/esm/index.mjs': { 'retake-patch: render-sandbox': 1, 'retake-patch: loopback-server': 2 },
};
/** Text files the machine-path check reads (bounded: a bigger file is skipped — none of ours is). */
const TEXT_FILE = /\.(?:js|mjs|cjs|json|md|markdown|txt|ya?ml|html?|css|tsx?|jsx|svg|sh|plist|xml)$/i;
const TEXT_MAX_BYTES = 8 * 1024 * 1024;

export class StageError extends Error {}

const within = (dir, p) => {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The environment of every child of a build or a stage (pnpm, git, otool, codesign, ditto, xattr, sips, tauri and cargo
 * — every crate's build script —, hdiutil, plutil, xcrun): an allow-list — the system's basics, the Rust and Xcode
 * toolchains' own variables, pnpm's and corepack's settings (COREPACK_ENABLE_AUTO_PIN=0 keeps pnpm from pinning itself
 * into a package.json) — so no credential of the person's shell (APPLE_*, an updater key, a
 * registry or cloud token) reaches any of them (critique M1, review A M1). A name that reads as a credential is dropped
 * even where a prefix allows it (CARGO_REGISTRY_TOKEN). `extra`: the build's own explicit variables.
 */
const ENV_ALLOWED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'CI', 'NO_COLOR', 'SDKROOT', 'DEVELOPER_DIR', 'MACOSX_DEPLOYMENT_TARGET', 'RUSTFLAGS', 'RUSTDOCFLAGS', 'PNPM_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'PLAYWRIGHT_BROWSERS_PATH']);
const ENV_PREFIXES = /^(?:LC_|CARGO_|RUSTUP_|RUSTC|COREPACK_|npm_config_)/;
const ENV_CREDENTIAL = /TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|PRIVATE|(?:^|_)KEY(?:_|$)/i;
export function buildEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && (ENV_ALLOWED.has(k) || ENV_PREFIXES.test(k)) && !ENV_CREDENTIAL.test(k)) out[k] = v;
  return { ...out, ...extra };
}

/** The environment `run` gives a child unless told otherwise (`useBuildEnv`: a build or a stage sets it first). */
let childEnv = buildEnv(process.env);
export function useBuildEnv(env) {
  childEnv = env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: childEnv, ...opts });
  if (r.error) throw new StageError(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new StageError(`${cmd} ${args.slice(0, 3).join(' ')}… failed (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ')}`);
  return r.stdout;
}

/** The real path of `p` through its deepest existing ancestor (a link anywhere above a folder yet to be made is followed). */
function realOf(p) {
  try {
    return realpathSync(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(realOf(up), basename(p));
  }
}

/**
 * Where a build or a stage may write (`what`: --out, --stage): a dedicated folder, judged by its real path (links
 * followed) — outside the checkout, never /Applications (nor its Data volume path), ~/Applications or ~/Library, never
 * the home folder or a folder holding it, never the Desktop / Documents / Downloads folder itself (a folder of its own
 * inside them is fine). Returns the real path.
 */
export function checkFolder(p, what, env = process.env) {
  if (!p) throw new StageError(`${what} <dir> is needed: a scratch folder of its own (never inside the checkout)`);
  const dir = realOf(resolve(p));
  const repo = realOf(REPO);
  if (within(repo, dir) || within(dir, repo)) throw new StageError(`${what} ${dir}: outside the checkout (a scratch folder)`);
  for (const apps of ['/Applications', '/System/Volumes/Data/Applications']) if (within(realOf(apps), dir)) throw new StageError(`${what}: never into /Applications`);
  for (const home of new Set([homedir(), env.HOME].filter((h) => typeof h === 'string' && h.trim() && isAbsolute(h)).map((h) => realOf(resolve(h))))) {
    if (within(dir, home)) throw new StageError(`${what} ${dir}: the home folder or a folder holding it — use a folder of its own (${join(home, 'retake-build')})`);
    for (const sub of ['Library', 'Applications']) if (within(join(home, sub), dir)) throw new StageError(`${what} ${dir}: never inside ~/${sub}`);
    for (const sub of ['Desktop', 'Documents', 'Downloads']) if (dir === join(home, sub)) throw new StageError(`${what} ${dir}: a folder of its own is needed (${join(home, sub, 'retake-build')}), not ~/${sub} itself`);
  }
  return dir;
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

/**
 * The Node.js running the stage is the pinned one (NODE_PIN: its exact version, its binary's sha256) — the stage copies
 * it into the app. StageError, in one sentence that says what to do, otherwise.
 */
export function checkNode({ execPath = process.execPath, version = process.versions.node, platform = `${process.platform}-${process.arch}`, pin = NODE_PIN } = {}) {
  const want = pin.sha256?.[platform];
  if (version !== pin.version) throw new StageError(`run the stage with Node.js ${pin.version}, the version apps/desktop/bundle/node.json pins (the stage copies the Node.js running it into the app); this is v${version} (${execPath})`);
  if (!want) throw new StageError(`apps/desktop/bundle/node.json pins no Node.js binary for ${platform}`);
  const got = sha256(execPath);
  if (got !== want) throw new StageError(`${execPath} is not the official Node.js ${pin.version} binary apps/desktop/bundle/node.json pins (sha256 ${got}, pinned ${want}): install Node.js ${pin.version} from the Node.js project's downloads, or record a checked upgrade there`);
}

/**
 * A browser revision folder's digest: the sha256 of its treeDigest (every path, link target, file size, executable bit
 * and file sha256, in path order) less Playwright's marker files (the stage writes them anew).
 */
export function browserDigest(dir) {
  const tree = treeDigest(dir, { skip: BROWSER_MARKERS });
  const h = createHash('sha256');
  for (const k of [...tree.keys()].sort()) h.update(`${k.split(sep).join('/')}\t${tree.get(k)}\n`);
  return h.digest('hex');
}

/**
 * The browser folder `from` (Playwright's cache, revision `folder`) is the pinned one (BROWSER_PINS). StageError, in one
 * sentence, otherwise.
 */
export function checkBrowser(from, folder, pins = BROWSER_PINS) {
  const want = pins.digests?.[folder];
  if (!want) throw new StageError(`apps/desktop/bundle/browsers.json pins no digest for ${folder}: record it from a checked install (node apps/desktop/scripts/bundle.mjs browser-digest ${from})`);
  const got = browserDigest(from);
  if (got !== want) throw new StageError(`${from} is not the ${folder} apps/desktop/bundle/browsers.json pins (digest ${got}, pinned ${want}): reinstall it (rm -rf it, then playwright-core's install), or record a checked one there`);
}

/** Playwright's browser cache (PLAYWRIGHT_BROWSERS_PATH, else its default on macOS). */
function playwrightCache() {
  return process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? resolve(process.env.PLAYWRIGHT_BROWSERS_PATH) : join(homedir(), 'Library', 'Caches', 'ms-playwright');
}

/** Block the thread for `ms` (no event loop to give back to: the build is synchronous). */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * hdiutil, tried again on "Resource busy" only (review e B-M4: a known intermittent failure of create / attach /
 * detach on hosted macOS runners) — up to `tries` times, `delayMs` doubling between them; any other failure at once.
 * Returns stdout.
 */
export function hdiutil(args, { env = childEnv, tries = 3, delayMs = 2000, sleep = sleepSync } = {}) {
  for (let i = 1; ; i++) {
    const r = spawnSync('hdiutil', args, { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new StageError(`hdiutil could not start: ${r.error.message}`);
    if (r.status === 0) return r.stdout;
    const text = `${r.stderr || ''}${r.stdout || ''}`.trim();
    if (i >= tries || !/resource busy/i.test(text)) throw new StageError(`hdiutil ${args.slice(0, 2).join(' ')}… failed (${r.status}${i > 1 ? `, try ${i} of ${tries}` : ''}): ${text.split('\n').slice(-3).join(' | ')}`);
    process.stderr.write(`bundle: hdiutil ${args[0]}: resource busy — trying again in ${(delayMs * 2 ** (i - 1)) / 1000} s (${i + 1} of ${tries})\n`);
    sleep(delayMs * 2 ** (i - 1));
  }
}

function sizeOf(p) {
  const out = run('du', ['-sk', p]);
  return Number(out.split(/\s/)[0]) * 1024;
}

/**
 * The layout check (also the tests'): bundle.json's paths inside the stage and present; every symbolic link relative
 * and resolving inside the stage; no regular file with more than one hard link (a link shared with the checkout or a
 * store: a write to either changes the other); no `machinePaths` (the build machine's home and checkout) in any text
 * file of the stage (TEXT_FILE, up to TEXT_MAX_BYTES each); the browser markers empty; one playwright-core; the
 * engine's @remotion/renderer patched (RENDERER_PATCH_MARKS); every Mach-O listed. Returns `{ problems, machO }`.
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
    if (typeof manifest.paths?.engine === 'string' && existsSync(join(root, manifest.paths.engine))) problems.push(...rendererPatchProblems(join(root, manifest.paths.engine, 'node_modules', '@remotion', 'renderer')));
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
  for (const p of prunedIn(root)) problems.push(`${relative(root, p)}: an installer script the payload must not carry (PRUNED)`);
  return { problems, machO };
}

/** The problems of a @remotion/renderer folder (`dir`) against RENDERER_PATCH_MARKS: a file missing, a mark missing or repeated. */
export function rendererPatchProblems(dir, marks = RENDERER_PATCH_MARKS) {
  const problems = [];
  for (const [rel, want] of Object.entries(marks)) {
    const file = join(dir, rel);
    if (!existsSync(file)) {
      problems.push(`@remotion/renderer/${rel} is missing`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const [mark, n] of Object.entries(want)) {
      const found = text.split(mark).length - 1;
      if (found !== n) problems.push(`@remotion/renderer/${rel} carries "${mark}" ${found} times, not ${n}: the engine lacks patches/@remotion__renderer@*.patch (pnpm deploy must apply it)`);
    }
  }
  return problems;
}

/** The PRUNED paths present under `root` (their `*` stand for one path segment). */
export function prunedIn(root) {
  const found = [];
  for (const glob of PRUNED) {
    let level = [root];
    for (const part of glob.split('/')) {
      const re = new RegExp(`^${part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      level = level.flatMap((d) => {
        try {
          return lstatSync(d).isDirectory() ? readdirSync(d).filter((n) => re.test(n)).map((n) => join(d, n)) : [];
        } catch {
          return [];
        }
      });
    }
    found.push(...level);
  }
  return found;
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

/** Folders of the checkout a build writes although git ignores them: tauri-build's generated schemas (review A L2). */
export const GENERATED = ['apps/desktop/gen'];

/**
 * What `git status` says of the checkout, with the sha256 of every file it lists (a file modified already and written
 * again keeps its status line: its bytes tell), and every file of the GENERATED folders (`generated`) git ignores. The
 * stage and the build compare it before and after.
 */
export function repoSnapshot(repo, generated = GENERATED) {
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
  for (const g of generated) {
    const abs = join(repo, g);
    if (!existsSync(abs)) continue;
    for (const p of [abs, ...walk(abs)].sort()) {
      const st = lstatSync(p);
      lines.push(`!! ${relative(repo, p)} ${st.isFile() ? sha256(p) : st.isSymbolicLink() ? `-> ${readlinkSync(p)}` : 'dir'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Keep a copy of each GENERATED folder of `repo` in `work` (or note it absent) before tauri-build writes it; returns what
 * `restoreGenerated` puts back.
 */
export function saveGenerated(repo, work, generated = GENERATED) {
  return generated.map((g) => {
    const from = join(repo, g);
    if (!existsSync(from)) return [g, null];
    const to = join(work, `generated-${g.replace(/\//g, '_')}`);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    return [g, to];
  });
}

/** Put each folder `saveGenerated` noted back as it was: removed when it was absent, else its copy (then deleted). */
export function restoreGenerated(repo, saved) {
  for (const [g, copy] of saved) {
    const at = join(repo, g);
    rmSync(at, { recursive: true, force: true });
    if (copy) {
      cpSync(copy, at, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      rmSync(copy, { recursive: true, force: true });
    }
  }
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
  if (opts.env) useBuildEnv(buildEnv(opts.env));
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

function stageInto({ out, ffmpeg, env = process.env }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new StageError('the app bundle is macOS on Apple silicon only for now (BACKLOG BL-139)');
  checkNode();
  if (!existsSync(join(REPO, 'packages', 'cli', 'dist', 'bin.js'))) throw new StageError('run pnpm build first');
  const dir = checkFolder(out, '--out', env);
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
    else if (st.isDirectory() && p === join(engine, 'node_modules', 'playwright-core', 'bin')) rmSync(p, { recursive: true, force: true });
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
  // The module lookup guard every Node.js of the app loads first (apps/desktop/bundle/guard.cjs: DESIGN §4p).
  for (const [from, to] of [['guard.cjs', GUARD], ['guard-hooks.mjs', join(dirname(GUARD), 'guard-hooks.mjs')]]) copyFileSync(join(APP_DIR, 'bundle', from), join(dir, to));
  say('node copied');

  // Browsers: the revisions the deployed playwright-core pins, from Playwright's cache (never downloaded here).
  const pwDir = join(engine, 'node_modules', 'playwright-core');
  const pw = JSON.parse(readFileSync(join(pwDir, 'package.json'), 'utf8'));
  const pins = JSON.parse(readFileSync(join(pwDir, 'browsers.json'), 'utf8')).browsers;
  const rev = (name) => pins.find((b) => b.name === name)?.revision;
  const cache = playwrightCache();
  const browsers = join(dir, 'browsers');
  mkdirSync(browsers, { recursive: true });
  for (const folder of [`chromium-${rev('chromium')}`, `chromium_headless_shell-${rev('chromium-headless-shell')}`]) {
    const from = join(cache, folder);
    if (!existsSync(join(from, 'INSTALLATION_COMPLETE'))) throw new StageError(`${from} is missing: run (with a network) node ${relative(REPO, join(REPO, 'node_modules', 'playwright-core', 'cli.js'))} install chromium chromium-headless-shell — playwright-core ${pw.version} pins ${folder}`);
    checkBrowser(from, folder);
    run('ditto', [from, join(browsers, folder)]);
    for (const m of BROWSER_MARKERS) {
      writeFileSync(join(browsers, folder, m), '');
      // A fresh mark: playwright-core re-validates (and rewrites, empty) one older than 30 days.
      utimesSync(join(browsers, folder, m), new Date(), new Date());
    }
  }
  for (const p of prunedIn(dir)) rmSync(p, { recursive: true, force: true });
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

// ——— The app and the DMG (`build`) ———

/**
 * The Tauri CLI the app is laid out with, rebuilt from the pnpm store: 2.12.4, the version the store holds (the crates
 * are tauri 2.12.5 / tauri-build 2.7.4 — same minor: a test ties the two), every file pinned by its sha512 in
 * apps/desktop/bundle/tauri-cli.json (review A M2: the store's own index is not trusted on its own).
 */
export const TAURI_CLI_PINS = JSON.parse(readFileSync(join(APP_DIR, 'bundle', 'tauri-cli.json'), 'utf8'));
export const TAURI_CLI_VERSION = TAURI_CLI_PINS.version;
const CONF = JSON.parse(readFileSync(join(APP_DIR, 'tauri.conf.json'), 'utf8'));
/** The app's name (tauri.conf.json productName): `<name>.app`, the DMG's volume. */
export const PRODUCT = CONF.productName;
/** The launcher's place in Resources (the PATH link of the first run points here — part c). */
export const LAUNCHER = 'bin/retake';
/**
 * The bundled app's launch.json (version 2, read by the shell's desktop_core::launch_config): paths inside Resources —
 * the Node.js, the engine's entry and the module lookup guard the shell loads first (`node --require <preload> <cli>`).
 * L5.16d (review d A-L9): `updates` — "on" in a build made with an update feed, "off" otherwise (doctor says so; the
 * shell ignores the key).
 */
export function launchJson(manifest, { updates = false } = {}) {
  return { version: 2, bundled: true, node: manifest.paths.node, cli: `${manifest.paths.engine}/dist/bin.js`, preload: GUARD, updates: updates ? 'on' : 'off' };
}

/** The keys Tauri merges into its generated Info.plist (bundle.macOS.infoPlist): the local network words, the category. */
export function infoPlistExtras() {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>LSApplicationCategoryType</key>
\t<string>${esc(APP_CATEGORY)}</string>
\t<key>NSLocalNetworkUsageDescription</key>
\t<string>${esc(LOCAL_NETWORK_USAGE)}</string>
</dict>
</plist>
`;
}

/**
 * The configuration overlay `tauri build --config <file>` merges into tauri.conf.json (written to `<out>`, never
 * committed): the bundle on, the app only, the payload through `bundle.macOS.files` — each top-level item of the stage
 * to `Resources/<name>` (never `bundle.resources`, which dereferences links and breaks Chromium's framework: plan D1)
 * — the generated icns, the Info.plist extras, macOS 15. No signing identity (we sign: sign.mjs), no updater, no
 * plugin, nothing `dangerous`.
 */
export function bundleOverlay({ stage, icon, infoPlist }) {
  const files = {};
  for (const name of readdirSync(stage).sort()) if (!name.startsWith('.')) files[`Resources/${name}`] = join(stage, name);
  return {
    bundle: {
      active: true,
      targets: ['app'],
      icon: [icon],
      macOS: { minimumSystemVersion: MINIMUM_MACOS, hardenedRuntime: true, infoPlist, files },
    },
  };
}

/** The pnpm store's folder (`pnpm store path`). */
function pnpmStore() {
  const out = run('pnpm', ['store', 'path'], { cwd: REPO }).trim().split('\n');
  return out[out.length - 1].trim();
}

/**
 * The Tauri CLI (`@tauri-apps/cli` + its darwin-arm64 binary, `pins.version`) rebuilt in `dest` from the pnpm store's
 * index and content files — offline, no dependency. Refused unless each index names its package and version, lists
 * exactly the files `pins` names with exactly their sha512, and every content file matches it; every path stays inside
 * its package folder. Returns the path of its `tauri.js`.
 */
export function tauriCli(dest, store = pnpmStore(), pins = TAURI_CLI_PINS) {
  const TAURI_CLI_VERSION = pins.version;
  const index = join(store, 'index');
  const want = [`@tauri-apps+cli@${TAURI_CLI_VERSION}.json`, `@tauri-apps+cli-darwin-arm64@${TAURI_CLI_VERSION}.json`];
  const names = { [want[0]]: '@tauri-apps/cli', [want[1]]: '@tauri-apps/cli-darwin-arm64' };
  const found = new Map();
  for (const d of existsSync(index) ? readdirSync(index) : []) {
    let names;
    try {
      names = readdirSync(join(index, d));
    } catch {
      continue;
    }
    for (const n of names) for (const w of want) if (n.endsWith(`-${w}`)) found.set(w, join(index, d, n));
  }
  rmSync(dest, { recursive: true, force: true });
  for (const w of want) {
    if (!found.has(w)) throw new StageError(`the Tauri CLI ${TAURI_CLI_VERSION} is not in the pnpm store (${store}): fetch it once with a network (pnpm dlx @tauri-apps/cli@${TAURI_CLI_VERSION} --version)`);
    const idx = JSON.parse(readFileSync(found.get(w), 'utf8'));
    const notPinned = `the Tauri CLI in the pnpm store (${found.get(w)}) is not the pinned ${TAURI_CLI_VERSION} (apps/desktop/bundle/tauri-cli.json)`;
    if (idx.name !== names[w] || idx.version !== TAURI_CLI_VERSION) throw new StageError(`${notPinned}: it names ${idx.name}@${idx.version}`);
    const pinned = pins.packages?.[idx.name] ?? {};
    const listed = Object.fromEntries(Object.entries(idx.files ?? {}).map(([f, i]) => [f, String(i?.integrity)]));
    if (JSON.stringify(Object.entries(listed).sort()) !== JSON.stringify(Object.entries(pinned).sort())) throw new StageError(`${notPinned}: its files or their sha512 differ`);
    const pkgDir = join(dest, 'node_modules', ...idx.name.split('/'));
    for (const [file, info] of Object.entries(idx.files)) {
      if (file.split('/').includes('..') || isAbsolute(file) || !within(pkgDir, join(pkgDir, file))) throw new StageError(`${found.get(w)}: a file outside its package (${file})`);
      const [algo, b64] = String(info.integrity).split('-');
      if (algo !== 'sha512') throw new StageError(`${found.get(w)}: ${file} has no sha512`);
      const hex = Buffer.from(b64, 'base64').toString('hex');
      const blob = [join(store, 'files', hex.slice(0, 2), hex.slice(2)), join(store, 'files', hex.slice(0, 2), `${hex.slice(2)}-exec`)].find((p) => existsSync(p));
      if (!blob) throw new StageError(`the pnpm store lacks ${idx.name}/${file}: fetch the Tauri CLI once with a network`);
      const bytes = readFileSync(blob);
      if (createHash('sha512').update(bytes).digest('hex') !== hex) throw new StageError(`the pnpm store's ${idx.name}/${file} does not match its sha512`);
      mkdirSync(dirname(join(pkgDir, file)), { recursive: true });
      writeFileSync(join(pkgDir, file), bytes, { mode: info.mode & 0o777 });
    }
  }
  return checkTauriCliDir(dest, pins);
}

/**
 * A Tauri CLI folder laid out by `tauriCli` (`dir/node_modules/@tauri-apps/{cli,cli-darwin-arm64}`) holds exactly the
 * files `pins` names, each with exactly its sha512, and nothing else — no link, no other file or package (an extra
 * module could be loaded instead). The release workflow's `sign` job checks the folder the `build` job hands it so
 * before it runs anything of it (review e A-H1). Returns the path of its `tauri.js`; StageError otherwise.
 */
export function checkTauriCliDir(dir, pins = TAURI_CLI_PINS) {
  const root = resolve(dir);
  const want = new Map();
  for (const [pkg, files] of Object.entries(pins.packages ?? {})) for (const [file, integrity] of Object.entries(files)) want.set(['node_modules', ...pkg.split('/'), ...file.split('/')].join('/'), String(integrity));
  if (!want.size) throw new StageError('apps/desktop/bundle/tauri-cli.json pins no file');
  const dirs = new Set();
  for (const k of want.keys()) for (let i = k.indexOf('/'); i > 0; i = k.indexOf('/', i + 1)) dirs.add(k.slice(0, i));
  const problems = [];
  const seen = new Set();
  for (const abs of existsSync(root) ? walk(root) : []) {
    const rel = relative(root, abs).split(sep).join('/');
    const st = lstatSync(abs);
    if (st.isDirectory() && dirs.has(rel)) continue;
    if (!st.isFile() || !want.has(rel)) {
      problems.push(`${rel}: not a file of the pinned CLI`);
      continue;
    }
    const [algo, b64] = want.get(rel).split('-');
    if (algo !== 'sha512' || createHash('sha512').update(readFileSync(abs)).digest('base64') !== b64) problems.push(`${rel}: not its pinned sha512`);
    seen.add(rel);
  }
  for (const k of want.keys()) if (!seen.has(k)) problems.push(`${k}: missing`);
  if (problems.length) throw new StageError(`${root} is not the Tauri CLI ${pins.version} apps/desktop/bundle/tauri-cli.json pins: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5})` : ''}`);
  return join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
}

/**
 * The Tauri CLI the release's sign step runs: a fresh copy of the checked bytes of `dir` (a folder `tauriCli` laid out
 * — a real folder, no link), in a new temporary folder of its own under `base`. `dir` is checked first
 * (`checkTauriCliDir`); then each pinned file is read once (its last component never followed as a link: a link put
 * there after the check is refused), those very bytes checked against their sha512 and written to the copy, and the
 * copy checked again. Nothing beside or above `dir` (another `node_modules` next to it) is on the copy's module lookup
 * path. Returns `{ root, cliJs }`: the caller runs `cliJs` and removes `root`. StageError otherwise (the copy removed).
 * `check`: the folder check (`checkTauriCliDir`; tests' stand-ins only).
 */
export function freshTauriCli(dir, pins = TAURI_CLI_PINS, base = tmpdir(), { check = checkTauriCliDir } = {}) {
  const src = resolve(dir);
  const st = lstatSync(src, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new StageError(`${src}: not the Tauri CLI's folder (${st?.isSymbolicLink() ? 'a link' : st ? 'not a folder' : 'missing'})`);
  check(src, pins);
  const root = mkdtempSync(join(base, 'retake-tauri-cli-'));
  try {
    for (const [pkg, files] of Object.entries(pins.packages ?? {})) {
      for (const [file, integrity] of Object.entries(files)) {
        const rel = ['node_modules', ...pkg.split('/'), ...file.split('/')];
        if (rel.some((p) => !p || p === '.' || p === '..')) throw new StageError(`apps/desktop/bundle/tauri-cli.json: a file outside its package (${pkg}/${file})`);
        let fd;
        try {
          fd = openSync(join(src, ...rel), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        } catch (e) {
          throw new StageError(`${src}: ${rel.join('/')} ${e.code === 'ELOOP' ? 'is a link, not a file' : `cannot be read (${e.code ?? e.message})`}`);
        }
        let bytes;
        let mode;
        try {
          const f = fstatSync(fd);
          if (!f.isFile()) throw new StageError(`${src}: ${rel.join('/')} is not a file`);
          mode = f.mode & 0o755;
          bytes = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
        const [algo, b64] = String(integrity).split('-');
        if (algo !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== b64) throw new StageError(`${src}: ${rel.join('/')} is not its pinned sha512`);
        mkdirSync(join(root, ...rel.slice(0, -1)), { recursive: true });
        writeFileSync(join(root, ...rel), bytes, { mode, flag: 'wx' });
      }
    }
    return { root, cliJs: check(root, pins) };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/**
 * `tauri build`'s arguments: the app bundle only, unsigned (we sign), the overlay, the cargo features (L5.16d: `updater`
 * when the build has a feed and a key), cargo --locked (and --offline).
 */
export function tauriBuildArgs(overlay, offline, features = []) {
  return ['build', '--bundles', 'app', '--no-sign', '--ci', '--config', overlay, ...(features.length ? ['--features', features.join(',')] : []), '--', '--locked', ...(offline ? ['--offline'] : [])];
}

/** Run `tauri build` (cliJs: the CLI's tauri.js) in apps/desktop with `buildEnv(env)`, cargo's target in `targetDir`. */
export function tauriBuild({ cliJs, overlay, targetDir, env = process.env, offline = false, node = process.execPath, features = [] }) {
  const tauriEnv = buildEnv(env, { CARGO_TARGET_DIR: targetDir, ...(offline ? { CARGO_NET_OFFLINE: 'true' } : {}) });
  const r = spawnSync(node, [cliJs, ...tauriBuildArgs(overlay, offline, features)], { cwd: APP_DIR, env: tauriEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) throw new StageError(`tauri build could not start: ${r.error.message}`);
  if (r.status !== 0) throw new StageError(`tauri build failed (${r.status})${offline ? ' — offline: a crate missing from the cargo cache needs `cargo fetch --locked` once with a network' : ''}`);
  return join(targetDir, 'release', 'bundle', 'macos', `${PRODUCT}.app`);
}

// ---- L5.16d: the updater ----------------------------------------------------------------------------------------

/** The update archive's name (what publish-update.mjs uploads; the plugin skips its first path component). */
export const UPDATE_ARCHIVE = `${PRODUCT}.app.tar.gz`;

/**
 * The feed's address as the app compiles it in: https, no user, query or fragment, a `.json` file (latest.json, or
 * rc.json for a pre-release build). Returns it; StageError otherwise.
 */
export function checkFeed(value) {
  let u;
  try {
    u = new URL(String(value ?? '').trim());
  } catch {
    throw new StageError('RETAKE_UPDATE_FEED is not a URL (the https address of the feed: …/releases/download/update-feed/latest.json — node scripts/release.mjs feed <version>)');
  }
  if (u.protocol !== 'https:') throw new StageError(`RETAKE_UPDATE_FEED must be https (it is ${u.protocol.replace(':', '')}): the apps refuse anything else`);
  if (u.username || u.password || u.search || u.hash) throw new StageError('RETAKE_UPDATE_FEED must not carry a user, a query or a fragment');
  if (!u.pathname.endsWith('.json')) throw new StageError('RETAKE_UPDATE_FEED names the feed file itself (…/latest.json, or …/rc.json for a pre-release build)');
  return u.href;
}

/** The public key as the app compiles it in: a Tauri (minisign Ed25519) public key, base64 as `tauri signer generate` writes it. */
export function checkPubkey(value) {
  try {
    decodePublicKey(value);
  } catch (e) {
    if (e instanceof MinisignError) throw new StageError(`RETAKE_UPDATE_PUBKEY: ${e.message} — the content of the .pub file \`tauri signer generate\` wrote`);
    throw new StageError('RETAKE_UPDATE_PUBKEY is not a public key (the content of the .pub file `tauri signer generate` wrote)');
  }
  return String(value).trim();
}

/**
 * The feed's channel follows the app's version (review d B-L3): a pre-release build reads rc.json, a stable one
 * latest.json — anything else would put that install base on the wrong channel for good. Returns the feed.
 */
export function checkChannel(feed, version) {
  const want = String(version).includes('-') ? 'rc.json' : 'latest.json';
  if (new URL(feed).pathname.split('/').pop() !== want) throw new StageError(`RETAKE_UPDATE_FEED must end in /${want} for version ${version} (${want === 'rc.json' ? 'a pre-release reads rc.json' : 'a stable version reads latest.json'})`);
  return feed;
}

/**
 * The updater's build inputs: null (neither variable: no updater), or {feed, pubkey}; one without the other is refused,
 * so is a feed of the other channel than `version` (the app's: tauri.conf.json).
 */
export function updaterSettings(env = process.env, version = CONF.version) {
  const feed = env.RETAKE_UPDATE_FEED?.trim();
  const pubkey = env.RETAKE_UPDATE_PUBKEY?.trim();
  if (!feed && !pubkey) return null;
  if (!feed || !pubkey) throw new StageError('RETAKE_UPDATE_FEED and RETAKE_UPDATE_PUBKEY go together: set both for an app that updates itself, or neither');
  return { feed: checkChannel(checkFeed(feed), version), pubkey: checkPubkey(pubkey) };
}

/**
 * The overlay's updater part for a release or a person's bundle: the plugin's config (H2: the plugin needs it at
 * start; `requireSignedVersion` binds a signature to its version, `allowDowngrades: false` keeps "newer only") — never
 * a `dangerous*` key.
 */
export function updaterOverlay({ feed, pubkey }) {
  return { plugins: { updater: { pubkey: checkPubkey(pubkey), endpoints: [checkFeed(feed)], requireSignedVersion: true, allowDowngrades: false } } };
}

/**
 * The gated end-to-end test's overlay ONLY (never the command line's): a feed on 127.0.0.1 over http — the one place
 * insecure-transport flag of the plugin is set — and the app's version (the test builds 0.2.0 and 0.2.1).
 */
export function testUpdaterOverlay({ port, pubkey, version }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new StageError('testUpdaterOverlay: a port of 1024–65535');
  return {
    ...(version ? { version } : {}),
    plugins: { updater: { pubkey: checkPubkey(pubkey), endpoints: [`http://127.0.0.1:${port}/retake/latest.json`], requireSignedVersion: true, allowDowngrades: false, dangerousInsecureTransportProtocol: true } },
  };
}

/**
 * `tar`'s arguments for the update archive of `appDir/<product>.app` (run as /usr/bin/tar with COPYFILE_DISABLE=1, which
 * stops an older macOS tar from adding AppleDouble `._` entries): no extended attribute, ACL, file flag or Mac metadata
 * either (bsdtar 3.5 on macOS 26 writes extended attributes as pax headers otherwise — com.apple.provenance among them).
 */
export function updateArchiveArgs(appDir, archive, product = PRODUCT) {
  return ['--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', '-czf', archive, '-C', appDir, `${product}.app`];
}

/** The symbolic links under `dir`. */
export function linkCount(dir) {
  return walk(dir).filter((p) => lstatSync(p).isSymbolicLink()).length;
}

/**
 * What `tar -tvzf` lists that the updater must not install (critique H3): an AppleDouble `._` entry, an entry outside
 * `<product>.app/` (absolute, `..`), and a link count other than the app's (`links`: linkCount of the app).
 */
export function archiveProblems(listing, links, product = PRODUCT) {
  const rows = String(listing).split('\n').filter((l) => l.trim());
  const problems = [];
  let got = 0;
  for (const row of rows) {
    if (row.startsWith('l')) got++;
    // `tar -tv` rows: mode links owner group size date… path [-> target]; the path follows the time column.
    const m = /\d{1,2}:\d{2}\s+(.+?)(?: -> .*)?$/.exec(row) ?? /\s\d{4}\s+(.+?)(?: -> .*)?$/.exec(row);
    const path = m ? m[1] : row.trim().split(/\s+/).pop();
    const parts = path.split('/');
    if (parts.some((x) => x.startsWith('._'))) problems.push(`${path}: an AppleDouble entry`);
    if (path.startsWith('/') || parts.includes('..') || (parts[0] !== `${product}.app`)) problems.push(`${path}: outside ${product}.app/`);
  }
  if (got !== links) problems.push(`${got} links in the archive, ${links} in the app`);
  return problems;
}

/** Make the update archive of `app` in `dir` and check it; returns its path. */
export function makeUpdateArchive(app, dir, { env = childEnv } = {}) {
  const archive = join(dir, UPDATE_ARCHIVE);
  rmSync(archive, { force: true });
  run('/usr/bin/tar', updateArchiveArgs(dirname(app), archive, basename(app, '.app')), { env: { ...env, COPYFILE_DISABLE: '1' } });
  const problems = archiveProblems(run('/usr/bin/tar', ['-tvzf', archive], { env }), linkCount(app), basename(app, '.app'));
  if (problems.length) throw new StageError(`the update archive fails its checks:\n  ${problems.slice(0, 8).join('\n  ')}`);
  return archive;
}

/**
 * Every folder Node.js looks in for a package `cliJs` requires by name, when run by `node` with HOME at `home`: a
 * `node_modules` in the folder of `cliJs`'s real path and in each folder above it (none inside another
 * `node_modules`), then the global folders — `home`/.node_modules, `home`/.node_libraries and the Node.js prefix's
 * lib/node (NODE_PATH: buildEnv passes none).
 */
export function cliLookupPaths(cliJs, home, node = process.execPath) {
  const paths = [];
  for (let d = dirname(realpathSync(cliJs)); ; d = dirname(d)) {
    if (basename(d) !== 'node_modules') paths.push(join(d, 'node_modules'));
    if (dirname(d) === d) break;
  }
  return [...paths, join(home, '.node_modules'), join(home, '.node_libraries'), resolve(node, '..', '..', 'lib', 'node')];
}

/**
 * Sign the archive (`<archive>.sig`) with the Tauri CLI, bound to `version` (`--app-version`: the apps require it),
 * the private key from TAURI_SIGNING_PRIVATE_KEY (its text, or the path of its file) and _PASSWORD — passed to this
 * one command only (every other child gets buildEnv) — then check the signature with `pubkey`. `cliRoot`: the CLI's
 * own folder (a fresh copy: `freshTauriCli`) — the CLI runs with HOME there, and is refused before it starts when any
 * folder of its module lookup path outside `cliRoot` exists (`cliLookupPaths`). Returns the .sig path; null without a
 * private key (the archive stays unsigned).
 */
export function signUpdateArchive({ cliJs, cliRoot = dirname(cliJs), archive, version, pubkey, env = process.env, node = process.execPath }) {
  let key = env.TAURI_SIGNING_PRIVATE_KEY?.trim();
  if (!key) return null;
  if (!key.includes('\n') && existsSync(key) && statSync(key).isFile()) key = readFileSync(key, 'utf8').trim();
  const home = realpathSync(cliRoot);
  const outside = cliLookupPaths(cliJs, home, node).filter((p) => !within(home, p) && lstatSync(p, { throwIfNoEntry: false }));
  if (outside.length) throw new StageError(`the Tauri CLI would look for packages in ${outside.join(', ')} (outside its own folder ${home}): remove ${outside.length > 1 ? 'them' : 'it'} — nothing was signed`);
  const signEnv = buildEnv(env, { HOME: home, TAURI_SIGNING_PRIVATE_KEY: key, ...(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined ? { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD } : {}) });
  const r = spawnSync(node, [cliJs, 'signer', 'sign', '--app-version', version, archive], { encoding: 'utf8', env: signEnv, cwd: dirname(archive) });
  if (r.error) throw new StageError(`tauri signer could not start: ${r.error.message}`);
  // The CLI's output names neither the key nor the password; only its exit status and last line are reported.
  if (r.status !== 0) throw new StageError(`tauri signer sign failed (${r.status}): ${(r.stderr || '').trim().split('\n').slice(-1)[0] ?? ''}`);
  const sig = `${archive}.sig`;
  try {
    verifyMinisign({ data: readFileSync(archive), signatureB64: readFileSync(sig, 'utf8'), pubkeyB64: pubkey, version });
  } catch (e) {
    throw new StageError(`the update archive's signature does not check against RETAKE_UPDATE_PUBKEY: ${e.message}`);
  }
  return sig;
}

/** `hdiutil create`'s arguments: `src` (the app + the Applications link) as an APFS, lzfse-compressed (ULFO) image. */
export function dmgCreateArgs({ src, dmg, volname = PRODUCT }) {
  return ['create', '-volname', volname, '-srcfolder', src, '-fs', 'APFS', '-format', 'ULFO', '-ov', dmg];
}

/** `hdiutil attach`'s arguments for an inspection: read-only, never shown in Finder nor auto-opened, at `mountpoint`. */
export function dmgAttachArgs(dmg, mountpoint) {
  return ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountpoint, dmg];
}

/**
 * Extended attributes macOS itself keeps on files and that no user can remove: com.apple.provenance — on macOS 26 every
 * file written by a process whose responsible app carries a provenance record (here the app the build was started from)
 * gets it, and `xattr -d` / `xattr -c` leave it. An opaque id with no personal data, never part of a signature; a build
 * started from another app may write files without it.
 */
export const SYSTEM_XATTRS = new Set(['com.apple.provenance']);

/** The extended attributes of `xattr -r` output (`<path>: <name>` lines) that are not SYSTEM_XATTRS. */
export function foreignXattrs(listing) {
  return String(listing)
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => !SYSTEM_XATTRS.has(l.slice(l.lastIndexOf(': ') + 2).trim()));
}

/** What a sealed app must not carry: AppleDouble `._` files, extended attributes (but SYSTEM_XATTRS). */
export function hygieneProblems(app) {
  const problems = walk(app)
    .filter((p) => p.slice(p.lastIndexOf(sep) + 1).startsWith('._'))
    .map((p) => `${relative(dirname(app), p)}: an AppleDouble file`);
  const x = foreignXattrs(run('xattr', ['-r', app]));
  if (x.length) problems.push(`extended attributes: ${x.slice(0, 3).join(' | ')}${x.length > 3 ? ` (+${x.length - 3})` : ''}`);
  return problems;
}

/**
 * Every entry under `dir` → what it is: `link <target>`, `file <size> <sha256>` (mode's executable bits too) or
 * `dir`; top-level dot entries (the stage's mark: the overlay copies none) and `skip` names left out.
 */
export function treeDigest(dir, { skip = [] } = {}) {
  const out = new Map();
  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    const top = rel.split(sep)[0];
    if (top.startsWith('.') || skip.includes(top)) continue;
    const st = lstatSync(p);
    out.set(rel, st.isSymbolicLink() ? `link ${readlinkSync(p)}` : st.isDirectory() ? 'dir' : `file ${st.size} ${st.mode & 0o111 ? 'x' : '-'} ${sha256(p)}`);
  }
  return out;
}

/** How `got` differs from `want` (two treeDigest maps), as problems (the first few of each kind, then a count). */
export function digestDiff(want, got, what = 'Contents/Resources') {
  const missing = [...want.keys()].filter((k) => !got.has(k));
  const extra = [...got.keys()].filter((k) => !want.has(k));
  const changed = [...want.keys()].filter((k) => got.has(k) && got.get(k) !== want.get(k));
  const list = (xs) => `${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ` (+${xs.length - 5})` : ''}`;
  return [
    ...(missing.length ? [`${what}: missing from the app — ${list(missing)}`] : []),
    ...(extra.length ? [`${what}: not in the signed payload — ${list(extra)}`] : []),
    ...(changed.length ? [`${what}: changed since the payload was signed — ${list(changed)}`] : []),
  ];
}

/** What Tauri adds to Contents/Resources besides the payload: the app's icon. */
export const APP_RESOURCES_OWN = ['icon.icns'];

/**
 * The checks of the laid-out, signed app beyond its signatures (review B M2): Contents/Resources holds exactly the
 * signed payload (`digest`: treeDigest of the stage right after signing — every file's bytes, every link's target,
 * nothing more; review A L6: a crate's build script runs between the payload's signing and Tauri's copy), no AppleDouble
 * file or foreign attribute (`hygieneProblems`), Info.plist's minimum macOS and local network words. Returns the
 * problems (none: []).
 */
export function appProblems(app, { digest } = {}) {
  const problems = [];
  if (digest) problems.push(...digestDiff(digest, treeDigest(join(app, 'Contents', 'Resources'), { skip: APP_RESOURCES_OWN })));
  problems.push(...hygieneProblems(app));
  const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]));
  if (info.LSMinimumSystemVersion !== MINIMUM_MACOS) problems.push(`Info.plist: LSMinimumSystemVersion ${info.LSMinimumSystemVersion}, not ${MINIMUM_MACOS}`);
  if (info.NSLocalNetworkUsageDescription !== LOCAL_NETWORK_USAGE) problems.push('Info.plist: no local network words');
  return problems;
}

/**
 * The DMG's checks: its format, then attached read-only at `mountpoint` — the app verifies, carries no AppleDouble
 * file or foreign attribute, the Applications link is there, and nothing else is at the volume's root (dot files
 * included) — detached (attach and detach tried again on "Resource busy": `hdiutil`; `retry`: its options, tests').
 */
export function verifyDmg(dmg, mountpoint, { env = childEnv, product = PRODUCT, retry = {} } = {}) {
  const problems = [];
  const info = run('hdiutil', ['imageinfo', dmg], { env });
  if (!/^Format: ULFO$/m.test(info)) problems.push(`${dmg}: not ULFO (${/^Format: (.*)$/m.exec(info)?.[1] ?? '?'})`);
  mkdirSync(mountpoint, { recursive: true });
  hdiutil(dmgAttachArgs(dmg, mountpoint), { env, ...retry });
  try {
    const app = join(mountpoint, `${product}.app`);
    const v = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8', env });
    if (v.status !== 0) problems.push(`the DMG's app: ${(v.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
    else problems.push(...hygieneProblems(app).map((p) => `the DMG's app: ${p}`));
    const link = join(mountpoint, 'Applications');
    if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() || readlinkSync(link) !== '/Applications') problems.push('the DMG has no Applications link');
    const top = readdirSync(mountpoint).sort();
    if (top.join('\n') !== ['Applications', `${product}.app`].sort().join('\n')) problems.push(`the DMG holds ${top.join(', ')}`);
  } finally {
    try {
      hdiutil(['detach', mountpoint], { env, ...retry });
    } catch {
      spawnSync('hdiutil', ['detach', '-force', mountpoint], { env });
    }
  }
  return problems;
}

/**
 * bundle.json's `paths[key]` (`m`: the manifest) as a path of `dir`: a relative path with no empty, `.` or `..` part
 * whose real path stays inside `dir` (no link out). StageError otherwise.
 */
export function manifestPath(dir, m, key) {
  const rel = m?.paths?.[key];
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  if (!parts.length || isAbsolute(rel) || parts.some((p) => !p || p === '.' || p === '..')) throw new StageError(`${join(dir, 'bundle.json')}: paths.${key} is not a relative path inside the folder (${JSON.stringify(rel)?.slice(0, 80)})`);
  const abs = join(dir, ...parts);
  let real;
  try {
    // The system's realpath (realpathSync.native): Node.js's own resolves a link's `..` against the link's name.
    real = realpathSync.native(abs);
  } catch {
    throw new StageError(`${join(dir, 'bundle.json')}: paths.${key} (${rel}) is missing`);
  }
  if (!within(realpathSync.native(dir), real)) throw new StageError(`${join(dir, 'bundle.json')}: paths.${key} (${rel}) leads out of the folder`);
  return abs;
}

/**
 * bundle.json's sha256 values (Node.js, ffmpeg and ffprobe) recomputed from the files of `dir` — after the payload is
 * signed, which rewrites them (review B M3); bundle.json itself is no Mach-O: the outer signature seals it as written
 * here. Returns the manifest.
 */
export function refreshManifestHashes(dir) {
  const file = join(dir, 'bundle.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.sha256 = { ...(m.sha256 ?? {}), node: sha256(manifestPath(dir, m, 'node')) };
  if (m.ffmpeg && m.paths.ffmpeg) m.ffmpeg.sha256 = Object.fromEntries(['ffmpeg', 'ffprobe'].map((t) => [t, sha256(join(manifestPath(dir, m, 'ffmpeg'), t))]));
  writeFileSync(file, `${JSON.stringify(m, null, 1)}\n`);
  return m;
}

/** Claim `dir` for a build: empty (or absent), or marked by an earlier build — never a folder of the person's. */
function claimOut(dir) {
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, BUILD_MARK))) {
    throw new StageError(`--out ${dir} is not empty and holds no earlier build (${BUILD_MARK}): give an empty folder of its own`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BUILD_MARK), '');
}

/**
 * The bundled app and its DMG (see the module comment), in two halves (L5.16e fixes, review e A-H1): the app laid out
 * and signed ad hoc here — stage, payload, Tauri, the shell and the app, every check — then `finishApp`
 * (apps/desktop/scripts/release.mjs, the release workflow's `sign` job runs the same on a runner of its own): the
 * update archive and the DMG, after a Developer ID signature, notarisation and stapling in a release. `mode`: 'dry'
 * (ad hoc, the default) or 'release' (`--release`: `signer` refuses first, before anything is staged or signed,
 * without the whole APPLE_* set). `appOnly` (`--app-only`, the workflow's `build` job): the ad hoc app and the pinned
 * Tauri CLI only, for `release.mjs sign`. `stage`: a stage to reuse (signed in place) instead of a new one in
 * `<out>/stage` — of the app's version (`appVersion`, tauri.conf.json's; another one in tests) when an app or a DMG
 * is made; `entries`: the signing table (sign-table.json; another one in tests); `tauriPins`: the pins the Tauri
 * CLI is checked against (tauri-cli.json; a fake store's in tests — the command line never passes it). Returns the
 * report.
 */
export function build({ out, mode = 'dry', stage: reuse, ffmpeg, env = process.env, offline = env.CARGO_NET_OFFLINE === 'true', entries, tauriPins = TAURI_CLI_PINS, updater: testUpdater, dmg: makeDmg = true, appOnly = false, appVersion = CONF.version }) {
  const child = buildEnv(env);
  // A release is refused here, before anything is staged, without the whole APPLE_* set (finishApp asks again).
  signer(mode, env, child);
  if (appOnly && mode !== 'dry') throw new StageError('--app-only lays the ad hoc app out (the release workflow\'s build job); its release signature is the next step: node apps/desktop/scripts/release.mjs sign --release');
  // The layout is always ad hoc: a release re-signs the finished app (finishApp), as the workflow's sign job does.
  const s = signer('dry', env, child);
  // L5.16d: the updater from RETAKE_UPDATE_FEED + RETAKE_UPDATE_PUBKEY (checked before anything is built); `updater`
  // (the gated test's testUpdaterOverlay) and `dmg: false` are tests' only — the command line passes neither.
  const updates = testUpdater ? { overlay: testUpdater, pubkey: testUpdater.plugins.updater.pubkey } : (() => {
    const u = updaterSettings(env);
    return u ? { overlay: updaterOverlay(u), pubkey: u.pubkey } : null;
  })();
  const table = entries ?? readTable();
  if (!out) throw new StageError('desktop:bundle needs a scratch folder: --out <dir> or RETAKE_BUNDLE_OUT (never inside the checkout)');
  const dir = checkFolder(out, '--out', env);
  const stageDir = reuse ? checkFolder(reuse, '--stage', env) : join(dir, 'stage');
  if (reuse && !existsSync(join(stageDir, STAGE_MARK))) throw new StageError(`--stage ${stageDir} is not a stage (bundle.mjs stage)`);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new StageError('the app bundle is macOS on Apple silicon only for now (BACKLOG BL-139)');
  claimOut(dir);
  useBuildEnv(child);
  const t0 = Date.now();
  const timings = {};
  let last = t0;
  const say = (step, m) => {
    timings[step] = Date.now() - last;
    last = Date.now();
    process.stderr.write(`bundle: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
  };
  const before = repoSnapshot(REPO);

  // 1. The payload: staged (or reused), then launch.json v2 and the launcher, then signed inside-out, then the manifest's
  //    hashes of the signed files and the digest the app is compared with.
  if (!reuse) stage({ out: stageDir, ffmpeg, env });
  const manifest = JSON.parse(readFileSync(join(stageDir, 'bundle.json'), 'utf8'));
  if (!existsSync(join(stageDir, GUARD))) throw new StageError(`${join(stageDir, GUARD)} is missing: a stage from before the module lookup guard — stage again`);
  // A reused stage of another version would make an app whose bundle.json and Info.plist disagree: the DMG and the
  // sign job refuse that only after Tauri's build — refused here, before it (`appVersion`: tests' only).
  if (reuse && (makeDmg || appOnly) && manifest.app !== appVersion) throw new StageError(`--stage ${stageDir} was made for version ${manifest.app}, the app is ${appVersion} (tauri.conf.json): stage again (bundle.mjs stage)`);
  writeFileSync(join(stageDir, 'launch.json'), `${JSON.stringify(launchJson(manifest, { updates: !!updates }), null, 1)}\n`);
  mkdirSync(join(stageDir, dirname(LAUNCHER)), { recursive: true });
  copyFileSync(join(APP_DIR, 'bundle', 'retake.sh'), join(stageDir, LAUNCHER));
  chmodSync(join(stageDir, LAUNCHER), 0o755);
  const { problems: stageProblems } = checkStage(stageDir);
  if (stageProblems.length) throw new StageError(`the stage fails its check:\n  ${stageProblems.join('\n  ')}`);
  say('stage', `payload ready (${stageDir})`);
  const plan = signPayload(stageDir, s, { entries: table, work: join(dir, 'entitlements') });
  refreshManifestHashes(stageDir);
  const sealed = treeDigest(stageDir);
  say('sign_payload', `payload signed (ad hoc: ${plan.items.length} signatures, ${plan.machO.length} Mach-O files)`);

  // 2. The app, laid out by Tauri (unsigned, the build's allow-listed environment); apps/desktop/gen put back after.
  const icon = join(dir, 'icon.icns');
  icns(icon, child);
  writeFileSync(join(dir, 'Info.plist'), infoPlistExtras());
  const overlay = join(dir, 'tauri.bundle.json');
  writeFileSync(overlay, `${JSON.stringify({ ...bundleOverlay({ stage: stageDir, icon, infoPlist: join(dir, 'Info.plist') }), ...(updates ? updates.overlay : {}) }, null, 1)}\n`);
  const cliJs = tauriCli(join(dir, 'tauri-cli'), pnpmStore(), tauriPins);
  const ownTarget = env.CARGO_TARGET_DIR && !within(realOf(REPO), realOf(resolve(env.CARGO_TARGET_DIR))) ? resolve(env.CARGO_TARGET_DIR) : join(dir, 'target');
  const saved = saveGenerated(REPO, dir);
  let built;
  try {
    built = tauriBuild({ cliJs, overlay, targetDir: ownTarget, env, offline, features: updates ? ['updater'] : [] });
  } finally {
    restoreGenerated(REPO, saved);
  }
  const appDir = join(dir, 'app');
  const app = join(appDir, `${PRODUCT}.app`);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  renameSync(built, app);
  say('tauri', `app laid out (${app})`);

  // 3. The shell and the app signed ad hoc, everything verified.
  run('xattr', ['-cr', app]);
  signApp(app, s);
  const problems = [...verifyApp(app, 'dry', { entries: table, env: child }), ...appProblems(app, { digest: sealed })];
  if (problems.length) throw new StageError(`the app fails its checks:\n  ${problems.join('\n  ')}`);
  const links = [...sealed.values()].filter((v) => v.startsWith('link ')).length;
  say('verify', `app signed ad hoc and verified (${links} links kept)`);

  // 4. The rest (release.mjs finishApp): a release's Developer ID signature, notarisation and stapling; the update
  //    archive; the DMG. `--app-only` stops here.
  const done = appOnly ? { dmg: null, update: null } : finishApp({ app, out: dir, mode, env, tauriCli: join(dir, 'tauri-cli'), tauriPins, pubkey: updates?.pubkey, entries: table, dmg: makeDmg, verified: true, say });

  if (repoSnapshot(REPO) !== before) throw new StageError(`the build changed the checkout (${REPO}): restore it`);
  const report = {
    mode,
    app,
    dmg: done.dmg,
    version: manifest.app,
    ...(appOnly ? { app_only: true, tauri_cli: join(dir, 'tauri-cli') } : {}),
    sizes: { app: sizeOf(app), dmg: done.dmg ? statSync(done.dmg).size : null, payload: sizeOf(stageDir) },
    updater: updates ? { feed: updates.overlay.plugins.updater.endpoints[0], archive: done.update } : null,
    signatures: plan.items.length,
    mach_o: plan.machO.length,
    links,
    timings_ms: { ...timings, total: Date.now() - t0 },
  };
  writeFileSync(join(dir, 'bundle-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  return report;
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
      const { manifest } = stage({ out, ffmpeg: flag('--ffmpeg'), env: process.env });
      process.stdout.write(`${JSON.stringify({ out: resolve(out), sizes: manifest.sizes, ffmpeg: manifest.ffmpeg, app: manifest.app }, null, 1)}\n`);
    } else if (command === 'build') {
      const report = build({ out: flag('--out') ?? process.env.RETAKE_BUNDLE_OUT, mode: rest.includes('--release') ? 'release' : 'dry', ffmpeg: flag('--ffmpeg'), stage: flag('--stage'), offline: process.env.CARGO_NET_OFFLINE === 'true' || rest.includes('--offline'), appOnly: rest.includes('--app-only') });
      process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    } else if (command === 'check-node') {
      checkNode();
      process.stdout.write(`Node.js ${NODE_PIN.version}, the pinned binary\n`);
    } else if (command === 'check-pins') {
      // The release workflow's build job, before its long steps: the Node.js running it and the browsers in Playwright's
      // cache are the pinned ones (the stage checks both again).
      checkNode();
      const pins = JSON.parse(readFileSync(join(REPO, 'packages', 'runner-web', 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')).browsers;
      const rev = (name) => pins.find((b) => b.name === name)?.revision;
      for (const folder of [`chromium-${rev('chromium')}`, `chromium_headless_shell-${rev('chromium-headless-shell')}`]) checkBrowser(join(playwrightCache(), folder), folder);
      process.stdout.write(`Node.js ${NODE_PIN.version} and the browsers are the pinned ones\n`);
    } else if (command === 'browser-digest') {
      // What apps/desktop/bundle/browsers.json records for a browser revision folder (read only).
      if (!rest[0]) throw new StageError('browser-digest <Playwright revision folder, e.g. …/ms-playwright/chromium-1194>');
      process.stdout.write(`${browserDigest(resolve(rest[0]))}\n`);
    } else if (command === 'check') {
      const { problems, machO } = checkStage(rest[0] ?? '.');
      process.stdout.write(`${JSON.stringify({ problems, machO: machO.length }, null, 1)}\n`);
      process.exit(problems.length ? 1 : 0);
    } else {
      throw new StageError('usage: bundle.mjs build --out <dir> [--ffmpeg <dir>] [--stage <dir>] [--offline] [--release | --app-only] | stage --out <dir> [--ffmpeg <dir>] | check <dir> | check-node | check-pins | browser-digest <dir>');
    }
  } catch (e) {
    process.stderr.write(`bundle: ${e instanceof StageError || e instanceof SignError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
