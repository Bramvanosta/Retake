/**
 * L5.16d — the updater end to end (gated: RETAKE_TEST_UPDATE=1, macOS on Apple silicon; slow: two app builds, ≈ 3 GB
 * in a temp folder, removed after). Offline, on this Mac only:
 * - a TEST key made here by the pinned Tauri CLI (`signer generate`, never committed);
 * - the app built twice by bundle.mjs with the e2e overlay (testUpdaterOverlay: the feed on http://127.0.0.1:<port>,
 *   the one place the plugin's insecure-transport flag is set) — 0.2.0, then 0.2.1 from the same stage and cargo
 *   target; the second build makes the update archive (Retake.app.tar.gz, our tar) and signs it with the test key;
 * - a local feed server: latest.json (publish-update.mjs `buildManifest`) and the archive, each answered as GitHub
 *   answers a release's file (L5.16f): a redirect to another host — here a second server on the next port — which
 *   serves it (the client follows it, https-only aside: update_flow `https_only` is off for the e2e build alone);
 * - a scratch copy of the 0.2.0 app, run directly (test mode, never through LaunchServices) on a scratch workspace with
 *   a scratch HOME / Retake home / TMPDIR / CFFIXED_USER_HOME; RETAKE_DESKTOP_TEST_UPDATE=install clicks Install and
 *   Restart once the launch check finds the update.
 * First a feed whose signature is for other bytes: the download is refused, nothing is installed, the app keeps
 * running at 0.2.0. Then the real one: the owned server stops gracefully, the bundle is swapped, the app restarts at
 * 0.2.1 by itself (critique H3) — its signature verifies (`codesign --verify --deep --strict`), every link of the build
 * is there, no AppleDouble file, Chromium and the headless shell launch from it.
 * RETAKE_TEST_UPDATE_PORT=<port> (default 4990; the storage stand-in takes the next one).
 * RETAKE_TEST_BUNDLE_FFMPEG=<dir> (optional) bundles that ffmpeg; RETAKE_TEST_UPDATE_REPORT=<file> writes the numbers;
 * RETAKE_TEST_KEEP=1 keeps the temp folder, RETAKE_TEST_UPDATE_REUSE=<that folder> runs again on its builds (each run's
 * app log is written there: app-<n>.log).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENABLED = process.env.RETAKE_TEST_UPDATE === '1' && process.platform === 'darwin' && process.arch === 'arm64';
const PORT = Number(process.env.RETAKE_TEST_UPDATE_PORT ?? 4990);
const BIN_NAME = /^name = "([^"]+)"/m.exec(readFileSync(join(REPO, 'apps', 'desktop', 'Cargo.toml'), 'utf8'))![1];
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
/* eslint-disable @typescript-eslint/no-explicit-any */

let base: string;
let feed: Server | undefined;
let storage: Server | undefined;
/** Every request the two servers got: `feed <url>` / `storage <url>`. */
const hits: string[] = [];
let served: { manifest: string; archive: string } = { manifest: '{}', archive: '' };
let copy: string;
let built: { v1: Record<string, any>; v2: Record<string, any> };
let runEnv: Record<string, string>;
const report: Record<string, unknown> = {};
const kids: ChildProcess[] = [];
const reuse = process.env.RETAKE_TEST_UPDATE_REUSE;
let runs = 0;
const pids = new Set<number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plist = (app: string) => JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout) as Record<string, string>;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, out);
  }
  return out;
};
const links = (app: string) => walk(app).filter((p) => lstatSync(p).isSymbolicLink()).length;
/** The update archives kept in the app's cache folder (scratch HOME: tauri's app_cache_dir, update_flow ARCHIVE_DIR). */
const kept = () => {
  const d = join(runEnv.HOME, 'Library', 'Caches', 'local.retake.desktop', 'updates');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.tar.gz')) : [];
};

/** The app copy run directly; its log lines (the shell's stderr, and its restarted self's: the same pipe). */
function launch(): { proc: ChildProcess; lines: string[]; wait: (re: RegExp, ms: number) => Promise<string> } {
  const proc = spawn(join(copy, 'Contents', 'MacOS', BIN_NAME), [], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = join(base, `app-${++runs}.log`);
  kids.push(proc);
  if (proc.pid) pids.add(proc.pid);
  const lines: string[] = [];
  let buf = '';
  const take = (b: Buffer) => {
    buf += b.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(l);
      appendFileSync(log, `${l}\n`);
      const m = /restarted the app directly \(pid (\d+)\)/.exec(l);
      if (m) pids.add(Number(m[1]));
    }
  };
  proc.stdout!.on('data', take);
  proc.stderr!.on('data', take);
  /** The `n`-th line matching `re` (the first by default), once it is there. */
  const wait = async (re: RegExp, ms: number, n = 1) => {
    const end = Date.now() + ms;
    for (;;) {
      const hits = lines.filter((l) => re.test(l));
      if (hits.length >= n) return hits[n - 1]!;
      if (Date.now() > end) throw new Error(`timed out waiting for ${re} (#${n}):\n${lines.slice(-40).join('\n')}`);
      await sleep(200);
    }
  };
  return { proc, lines, wait };
}

async function stopAll(): Promise<void> {
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
  const end = Date.now() + 20_000;
  while ([...pids].some(alive) && Date.now() < end) await sleep(200);
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
}

describe.skipIf(!ENABLED)('the updater, end to end (L5.16d, gated: RETAKE_TEST_UPDATE=1)', () => {
  beforeAll(async () => {
    base = reuse ? realpathSync(reuse) : realpathSync(mkdtempSync(join(tmpdir(), 'retake-update-e2e-')));
    const t0 = Date.now();
    const bundle = (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs')).href)) as any;
    if (reuse) {
      // An earlier run's builds (RETAKE_TEST_KEEP=1): a fresh copy and a fresh scratch world below.
      built = { v1: JSON.parse(readFileSync(join(base, 'v1', 'bundle-report.json'), 'utf8')), v2: JSON.parse(readFileSync(join(base, 'v2', 'bundle-report.json'), 'utf8')) };
      for (const d of ['apps', 'home', 'retake-home', 'tmp', 'ws']) rmSync(join(base, d), { recursive: true, force: true });
    } else {
      // The build's toolchain: the account's HOME finds the pnpm store (corepack's pnpm) and rustup — the build starts no
      // browser and no app.
      const toolEnv = { ...process.env, HOME: userInfo().homedir, CARGO_TARGET_DIR: join(base, 'target') };
      bundle.useBuildEnv(bundle.buildEnv(toolEnv));
      // The test key (scratch only), made by the pinned CLI.
      const cliJs: string = bundle.tauriCli(join(base, 'tauri-cli'));
      const keyDir = join(base, 'key');
      mkdirSync(keyDir);
      const g = spawnSync(process.execPath, [cliJs, 'signer', 'generate', '--ci', '-p', 'e2e-test-password', '-w', join(keyDir, 'test.key')], { encoding: 'utf8', cwd: keyDir, env: { PATH: process.env.PATH ?? '', HOME: keyDir, CI: 'true' } });
      if (g.status !== 0) throw new Error(`signer generate: ${g.stderr}`);
      const pubkey = readFileSync(join(keyDir, 'test.key.pub'), 'utf8').trim();
      // The test key for the archive's signature (bundle.mjs gives it to the signer only).
      const buildEnv = { ...toolEnv, TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(keyDir, 'test.key'), 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'e2e-test-password' };
      const ffmpeg = process.env.RETAKE_TEST_BUNDLE_FFMPEG;
      const v1 = bundle.build({ out: join(base, 'v1'), env: buildEnv, offline: true, dmg: false, updater: bundle.testUpdaterOverlay({ port: PORT, pubkey, version: '0.2.0' }), ...(ffmpeg ? { ffmpeg } : {}) });
      const v2 = bundle.build({ out: join(base, 'v2'), env: buildEnv, offline: true, dmg: false, stage: join(base, 'v1', 'stage'), updater: bundle.testUpdaterOverlay({ port: PORT, pubkey, version: '0.2.1' }) });
      built = { v1, v2 };
      report.build = { v1: { timings_ms: v1.timings_ms, sizes: v1.sizes }, v2: { timings_ms: v2.timings_ms, sizes: v2.sizes, archive: v2.updater?.archive } };
      report.build_ms = Date.now() - t0;
    }
    // The feed as GitHub serves a release's files: the release's address answers with a redirect to another host (the
    // storage, on the next port), which serves the file.
    feed = createServer((req, res) => {
      hits.push(`feed ${req.url}`);
      const to = { '/retake/latest.json': 'latest.json', '/releases/download/v0.2.1/Retake.app.tar.gz': 'Retake.app.tar.gz' }[req.url ?? ''];
      if (to) return void res.writeHead(302, { location: `http://127.0.0.1:${PORT + 1}/storage/${to}?signed=1` }).end();
      res.writeHead(404).end();
    });
    storage = createServer((req, res) => {
      hits.push(`storage ${req.url}`);
      if (req.url === '/storage/latest.json?signed=1') return void res.writeHead(200, { 'content-type': 'application/json' }).end(served.manifest);
      if (req.url === '/storage/Retake.app.tar.gz?signed=1' && served.archive) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(statSync(served.archive).size) });
        return void createReadStream(served.archive).pipe(res);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => feed!.listen(PORT, '127.0.0.1', () => r()));
    await new Promise<void>((r) => storage!.listen(PORT + 1, '127.0.0.1', () => r()));
    // The 0.2.0 app's scratch copy (ditto keeps links, modes and signatures) and the scratch world it runs in.
    copy = join(base, 'apps', `${built.v1.app.split('/').pop()}`);
    mkdirSync(dirname(copy), { recursive: true });
    expect(spawnSync('ditto', [built.v1.app, copy]).status).toBe(0);
    for (const d of ['home', 'retake-home', 'tmp', 'ws/projects']) mkdirSync(join(base, d), { recursive: true });
    runEnv = { HOME: join(base, 'home'), CFFIXED_USER_HOME: join(base, 'home'), RETAKE_HOME: join(base, 'retake-home'), TMPDIR: `${join(base, 'tmp')}/`, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', RETAKE_DISK_WARN: 'off', RETAKE_ROOT: join(base, 'ws'), RETAKE_DESKTOP_TEST: '1', RETAKE_DESKTOP_TEST_UPDATE: 'install' };
  }, 30 * 60_000);

  afterAll(async () => {
    await stopAll();
    for (const k of kids) k.kill('SIGKILL');
    await new Promise<void>((r) => (feed ? feed.close(() => r()) : r()));
    await new Promise<void>((r) => (storage ? storage.close(() => r()) : r()));
    if (copy && existsSync(LSREGISTER)) spawnSync(LSREGISTER, ['-u', copy], { stdio: 'ignore' });
    if (process.env.RETAKE_TEST_UPDATE_REPORT) writeFileSync(process.env.RETAKE_TEST_UPDATE_REPORT, `${JSON.stringify(report, null, 1)}\n`);
    process.stdout.write(`update e2e: ${JSON.stringify(report)}\n`);
    if (base && !reuse && !process.env.RETAKE_TEST_KEEP) rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('the builds: 0.2.0 and 0.2.1 with the updater; the archive keeps every link, has no AppleDouble entry, and is signed for 0.2.1', () => {
    expect(plist(built.v1.app).CFBundleShortVersionString).toBe('0.2.0');
    expect(plist(built.v2.app).CFBundleShortVersionString).toBe('0.2.1');
    const a = built.v2.updater.archive;
    expect(a.version).toBe('0.2.1');
    expect(a.signature).toBe(`${a.archive}.sig`);
    expect(a.links).toBe(links(built.v2.app));
    const listing = spawnSync('/usr/bin/tar', ['-tvzf', a.archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;
    expect(listing.split('\n').filter((l) => l.startsWith('l')).length).toBe(a.links);
    expect(listing).not.toMatch(/(?:^|\/)\._/m);
    // The release overlay of the same bundle.mjs never carries the insecure flag; this build's (the e2e one) does.
    expect(JSON.stringify(readFileSync(join(base, 'v2', 'tauri.bundle.json'), 'utf8'))).toContain(`http://127.0.0.1:${PORT}/retake/latest.json`);
  });

  it('a signature for other bytes: the download is refused, nothing installed, the app keeps running at 0.2.0', async () => {
    const pub = (await import(pathToFileURL(join(REPO, 'scripts', 'publish-update.mjs')).href)) as any;
    const a = built.v2.updater.archive;
    // A real signature of this key, for version 0.2.1 — but of another file.
    const other = join(base, 'other.tar.gz');
    writeFileSync(other, 'not the archive');
    const keyDir = join(base, 'key');
    const s = spawnSync(process.execPath, [join(base, 'tauri-cli', 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'signer', 'sign', '--app-version', '0.2.1', other], { encoding: 'utf8', cwd: base, env: { PATH: process.env.PATH ?? '', HOME: keyDir, TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(keyDir, 'test.key'), 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'e2e-test-password' } });
    expect(s.status, s.stderr).toBe(0);
    served = { archive: a.archive, manifest: JSON.stringify(pub.buildManifest({ version: '0.2.1', notes: 'Retake 0.2.1', pubDate: new Date().toISOString(), platforms: { 'darwin-aarch64': { signature: readFileSync(`${other}.sig`, 'utf8').trim(), url: `http://127.0.0.1:${PORT}/releases/download/v0.2.1/Retake.app.tar.gz` } } })) };
    const run = launch();
    await run.wait(/version 0\.2\.0 \(updates on\)/, 60_000);
    await run.wait(/updates: Retake 0\.2\.1 is available/, 60_000);
    await run.wait(/updates: downloading 0\.2\.1/, 30_000);
    await run.wait(/updates: the download failed/, 180_000);
    await sleep(1000);
    expect(alive(run.proc.pid!)).toBe(true);
    expect(run.lines.some((l) => /quitting to install|installing 0\.2\.1/.test(l))).toBe(false);
    expect(plist(copy).CFBundleShortVersionString).toBe('0.2.0');
    // Review d A-M4: nothing was kept (only a verified archive is written to the cache folder).
    expect(kept()).toEqual([]);
    run.proc.kill('SIGTERM');
    await new Promise((r) => run.proc.once('exit', r));
    report.bad_signature = 'refused';
  }, 10 * 60_000);

  it('the real update: the server stops gracefully, the bundle is swapped, the app restarts at 0.2.1 by itself — signed, whole, and Chromium launches from it', async () => {
    const pub = (await import(pathToFileURL(join(REPO, 'scripts', 'publish-update.mjs')).href)) as any;
    const a = built.v2.updater.archive;
    served = { archive: a.archive, manifest: JSON.stringify(pub.buildManifest({ version: '0.2.1', notes: 'Retake 0.2.1', pubDate: new Date().toISOString(), platforms: { 'darwin-aarch64': { signature: readFileSync(a.signature, 'utf8').trim(), url: `http://127.0.0.1:${PORT}/releases/download/v0.2.1/Retake.app.tar.gz` } } })) };
    // The check of the first run is remembered (at most once a day): forget it.
    rmSync(join(base, 'retake-home', 'desktop-updates.json'), { force: true });
    hits.length = 0;
    const t0 = Date.now();
    const run = launch();
    await run.wait(/version 0\.2\.0 \(updates on\)/, 60_000);
    // Review d A-M4: the verified archive is kept in a 0600 file of the app's cache folder (not in memory)…
    await run.wait(/updates: 0\.2\.1 downloaded and verified \(\d+ MB\), kept in the cache folder/, 300_000);
    await run.wait(/updates: quitting to install 0\.2\.1/, 300_000);
    await run.wait(/updates: 0\.2\.1 installed — restarting/, 300_000);
    await run.wait(/restarted the app directly \(pid \d+\)/, 30_000);
    await run.wait(/version 0\.2\.1 \(updates on\)/, 60_000);
    report.update_ms = Date.now() - t0;
    // L5.16f: the check and the download each followed the redirect to the other host, as with GitHub's releases.
    expect(hits).toEqual(expect.arrayContaining(['feed /retake/latest.json', 'storage /storage/latest.json?signed=1', 'feed /releases/download/v0.2.1/Retake.app.tar.gz', 'storage /storage/Retake.app.tar.gz?signed=1']));
    report.redirects = hits;
    const at = (re: RegExp) => run.lines.findIndex((l) => re.test(l));
    // The owned server stopped (gracefully: its exit, not a kill) before the swap.
    const stopped = at(/stopped the Studio server \(pid \d+, quit\)/);
    expect(stopped, run.lines.join('\n')).toBeGreaterThan(0);
    expect(run.lines[stopped]).not.toMatch(/killed/);
    expect(stopped).toBeLessThan(at(/updates: installing 0\.2\.1/));
    // The restarted app serves the workspace again (its own server: the first one was stopped).
    await run.wait(/the Studio server serves http:\/\/127\.0\.0\.1:\d+/, 60_000, 2);
    expect(run.lines.filter((l) => /attached to the Studio server/.test(l))).toEqual([]);
    // The swapped bundle: 0.2.1, its signature whole, every link there, no AppleDouble file.
    expect(plist(copy).CFBundleShortVersionString).toBe('0.2.1');
    const v = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', copy], { encoding: 'utf8' });
    expect(v.status, v.stderr).toBe(0);
    expect(links(copy)).toBe(links(built.v2.app));
    expect(walk(copy).filter((p) => p.split('/').pop()!.startsWith('._'))).toEqual([]);
    // Chromium (new headless) and the headless shell launch from the swapped app, with its own Node.js and engine.
    const res = join(copy, 'Contents', 'Resources');
    const probe = join(base, 'probe.cjs');
    writeFileSync(probe, `const { chromium } = require(${JSON.stringify(join(res, 'engine', 'node_modules', 'playwright-core'))});\n(async () => {\n  for (const o of [{ channel: 'chromium' }, {}]) {\n    const b = await chromium.launch({ headless: true, ...o });\n    const p = await b.newPage();\n    await p.setContent('<p>ok</p>');\n    process.stdout.write((await p.textContent('p')) + ' ' + b.version() + '\\n');\n    await b.close();\n  }\n})().catch((e) => { console.error(e); process.exit(1); });\n`);
    const c = spawnSync(join(res, 'node', 'bin', 'node'), [probe], { encoding: 'utf8', env: { ...runEnv, PLAYWRIGHT_BROWSERS_PATH: join(res, 'browsers') }, timeout: 120_000 });
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout.trim().split('\n')).toHaveLength(2);
    for (const l of c.stdout.trim().split('\n')) expect(l).toMatch(/^ok \d+\./);
    report.browsers = c.stdout.trim().split('\n');
    // …and removed once installed.
    expect(kept()).toEqual([]);
    // The previous app is gone from the scratch temp folder (the plugin's temp dirs are removed on drop).
    expect(readdirSync(join(base, 'tmp')).filter((n) => n.startsWith('tauri_'))).toEqual([]);
    await stopAll();
    expect([...pids].filter(alive)).toEqual([]);
    expect(homedir()).not.toBe(runEnv.HOME);
  }, 15 * 60_000);
});
