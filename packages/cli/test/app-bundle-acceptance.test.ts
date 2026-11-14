/**
 * L5.16b — the bundled app, end to end (gated: RETAKE_TEST_BUNDLE=1, macOS on Apple silicon, `pnpm build` first,
 * cargo offline; slow — a build is ≈ 2–5 min, the capture and render ≈ 3 min — and ≈ 3 GB of scratch, removed after).
 *
 * The app: RETAKE_TEST_BUNDLE_APP=<…/Retake.app> takes a built one; otherwise `pnpm desktop:bundle` runs here
 * (bundle.mjs build) into RETAKE_TEST_BUNDLE_OUT or a scratch folder, with the ffmpeg of RETAKE_TEST_BUNDLE_FFMPEG
 * (a folder with ffmpeg + ffprobe: scripts/build-ffmpeg.mjs's output) — required, every tool must be the app's own.
 * Then, from the built app only — no repository on PATH (/usr/bin:/bin:/usr/sbin:/sbin), a scratch HOME, RETAKE_HOME
 * and TMPDIR, nothing else in the environment:
 * - the launcher (Contents/Resources/bin/retake, directly and through a link): `--version` names the app bundle;
 *   `doctor --json`: Node.js, Chromium, the render browser, ffmpeg and ffprobe are the app's (`bundled`); L5.16d: its
 *   `App updates` line says "updates are off in this build" (no feed given to this build: launch.json `updates`);
 * - `retake init` makes a workspace, the fixture project is copied in (its hosts on ports 4970–4973, where this test
 *   serves the fixture product), `run northfield-fixture quote` captures it and `render … --review` renders it with the
 *   app's headless shell (the render record says `bundled`; L5.15: ANGLE + VideoToolbox, and doctor's Renders line says
 *   so), the review passes;
 * - the shell binary started directly (Contents/MacOS, test mode — never `open` / Launch Services) serves the Studio
 *   from the app's own Node.js and engine (the server's command line), the page redeems its code, SIGTERM stops it;
 * - L5.16c: the first run — no workspace, test mode answers Create ~/Retake: the app's own `retake init` makes it in the
 *   scratch HOME and the Studio serves it; then the Set-up sheet's ops on that server: the command linked into the scratch
 *   HOME's ~/.local/bin and run through the link, the folder panel (test mode's pick) answering on the server's stdin,
 *   the notification request reaching the shell, Claude Desktop refused (no folder: nothing created), Done remembered;
 *   L5.16c fixes: one command per app (installing elsewhere waits for Uninstall), a panel that gives nothing is said
 *   (`cancelled`); the first run's Choose a Folder… — a folder that is not empty refused by `retake init`, the question
 *   asked again with the reason, then an empty folder made the workspace (review c B-L5);
 * - module lookups never leave the app (review A H1): canary packages — every bare specifier the engine's JavaScript
 *   names that the engine does not hold, bufferutil and utf-8-validate among them — planted in the node_modules folders
 *   above the app (this test's folders only) and in the scratch home's ~/node_modules and ~/.node_modules never run
 *   during doctor, the capture, the render and the Studio, and none is in the render bundle; a clone of the app (cp -c) with canaries above Resources
 *   (Contents/node_modules, Retake.app/node_modules) runs doctor without loading them either;
 * - bundle.json's sha256 values are the app's files' (review B M3);
 * - afterwards the app still verifies (`codesign --verify --deep --strict`), nothing inside it is newer than the start
 *   of the runs, and ~/Library's entries named after the bundle id are unchanged — names, sizes and mtimes (Launch
 *   Services' record of the scratch app is removed with `lsregister -u`) — and Chromium's crash reporter settings there
 *   too (every child runs with CFFIXED_USER_HOME at the scratch home: L5.16c fixes). The numbers (sizes, timings) are printed and
 *   written to RETAKE_TEST_BUNDLE_REPORT when set.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WANTED = process.env.RETAKE_TEST_BUNDLE === '1' && process.platform === 'darwin' && process.arch === 'arm64';
const ENABLED = WANTED && existsSync(join(REPO, 'packages', 'cli', 'dist', 'bin.js'));
const PORTS = { console: 4970, shop: 4971, authConsole: 4972, authShop: 4973 };
const BUNDLE_ID = JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'tauri.conf.json'), 'utf8')).identifier as string;
const BIN_NAME = /^name = "([^"]+)"/m.exec(readFileSync(join(REPO, 'apps', 'desktop', 'Cargo.toml'), 'utf8'))![1];
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const LIBRARY_DIRS = ['WebKit', 'Caches', 'HTTPStorages', 'Saved Application State', 'Preferences', 'Application Support', 'Cookies', 'Logs'];

let base: string;
let app: string;
let builtOut: string | undefined;
let env: Record<string, string>;

/**
 * The Studio server of `root` as the app's CLI records it: ui.json (pid and port, no secret) and the token record in
 * `retakeHome` (`ui/<sha256 of the workspace's real path, 16 hex>.token`); undefined until both name the same server.
 */
function studioRecord(root: string, retakeHome: string): { pid: number; port: number; token: string } | undefined {
  try {
    const rec = JSON.parse(readFileSync(join(root, '.retake', 'ui.json'), 'utf8')) as { pid: number; port: number; token?: unknown };
    const key = createHash('sha256').update(realpathSync(root), 'utf8').digest('hex').slice(0, 16);
    const held = JSON.parse(readFileSync(join(retakeHome, 'ui', `${key}.token`), 'utf8')) as { pid: number; port: number; token: string };
    if (rec.token !== undefined) throw new Error(`${root}/.retake/ui.json holds a token`);
    return held.pid === rec.pid && held.port === rec.port ? { pid: rec.pid, port: rec.port, token: held.token } : undefined;
  } catch (e) {
    if (e instanceof Error && e.message.endsWith('holds a token')) throw e;
    return undefined;
  }
}
let launcher: string;
let ws: string;
let fixture: ChildProcess | undefined;
let shell: ChildProcess | undefined;
let marker: string;
let libraryBefore: string[] = [];
let canaryLog: string;
let canaries: string[] = [];
const report: Record<string, unknown> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(200);
  }
}
const du = (p: string) => Number(spawnSync('du', ['-sk', p], { encoding: 'utf8' }).stdout.split(/\s/)[0]) * 1024;

/**
 * ~/Library entries named after the bundle id or the binary, and everything under them with its size and mtime (read
 * only: never deleted — a developer app may share the id, so a write into its existing folders must show too).
 */
function libraryEntries(): string[] {
  // The account's home (not $HOME: a scratch HOME must not hide a write into the real ~/Library).
  const homedir = () => userInfo().homedir;
  const found: string[] = [];
  const visit = (abs: string, rel: string) => {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    found.push(`${rel} ${st.isDirectory() ? 'dir' : st.size} ${st.mtimeMs}`);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of readdirSync(abs)) visit(join(abs, n), join(rel, n));
  };
  for (const d of LIBRARY_DIRS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(homedir(), 'Library', d));
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith(BUNDLE_ID) || n === BIN_NAME || n.startsWith(`${BIN_NAME}.`)) visit(join(homedir(), 'Library', d, n), join(d, n));
  }
  // Chromium's crash reporter settings (its browsers find ~/Library through NSHomeDirectory, not $HOME).
  visit(join(homedir(), 'Library', 'Application Support', 'Chromium', 'Crashpad', 'settings.dat'), 'Application Support/Chromium/Crashpad/settings.dat');
  return found.sort();
}

/**
 * The bare specifiers the engine's JavaScript names (require / import / from '…') whose package the engine does not
 * hold at its top level — what Node.js would look for above the app — plus ws's optional addons. Package names only.
 */
function canaryNames(engine: string): string[] {
  const held = new Set<string>();
  for (const e of readdirSync(join(engine, 'node_modules'))) {
    if (e.startsWith('@')) for (const x of readdirSync(join(engine, 'node_modules', e))) held.add(`${e}/${x}`);
    else held.add(e);
  }
  const builtin = new Set(builtinModules);
  const names = new Set<string>(['bufferutil', 'utf-8-validate']);
  const re = /(?:\brequire|\bimport)\(\s*['"]([^'"./][^'"]*)['"]\s*\)|\bfrom\s*['"]([^'"./][^'"]*)['"]/g;
  const walkJs = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walkJs(p);
      else if (e.isFile() && /\.(?:c|m)?js$/.test(e.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(re)) {
          const spec = (m[1] ?? m[2])!;
          if (spec.startsWith('node:') || spec.startsWith('#')) continue;
          const parts = spec.split('/');
          const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
          if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || builtin.has(name) || held.has(name)) continue;
          names.add(name);
        }
      }
    }
  };
  walkJs(engine);
  return [...names].sort();
}

/**
 * A canary package `name` in `<nm>`: when Node.js runs it, it appends its name and place to `log`; it carries
 * CANARY_MARK, so a render bundle that took it (webpack walks up like Node.js) shows it too. Bundleable as it is (the
 * fs require is hidden from the bundler).
 */
const CANARY_MARK = 'retake-acceptance-canary';
function plantCanary(nm: string, name: string, log: string): void {
  const dir = join(nm, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }));
  writeFileSync(
    join(dir, 'index.js'),
    `/* ${CANARY_MARK} */\nif (typeof process === 'object' && process.versions && process.versions.node) eval('require')('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + __filename + '\\n');\nmodule.exports = {};\n`,
  );
}

/** Files under `dir` whose text holds CANARY_MARK. */
function canaryMarked(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile() && /\.(?:m?js|html|map)$/.test(e.name) && readFileSync(p, 'utf8').includes(CANARY_MARK)) out.push(p);
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

/** The launcher, in the scratch environment only; its output and how long it took. */
function retake(args: string[], o: { timeout?: number; via?: string } = {}) {
  const t0 = Date.now();
  const r = spawnSync(o.via ?? launcher, args, { cwd: ws && existsSync(ws) ? ws : base, env, encoding: 'utf8', timeout: o.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout, ms: Date.now() - t0 };
}

describe.skipIf(!ENABLED)('the bundled app, built and run from itself (L5.16b, gated: RETAKE_TEST_BUNDLE=1)', () => {
  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'retake-bundle-acc-')));
    const t0 = Date.now();
    if (process.env.RETAKE_TEST_BUNDLE_APP) {
      app = realpathSync(process.env.RETAKE_TEST_BUNDLE_APP);
    } else {
      const ffmpeg = process.env.RETAKE_TEST_BUNDLE_FFMPEG;
      if (!ffmpeg) throw new Error('RETAKE_TEST_BUNDLE_FFMPEG=<folder with ffmpeg + ffprobe> (or RETAKE_TEST_BUNDLE_APP=<Retake.app>)');
      builtOut = process.env.RETAKE_TEST_BUNDLE_OUT ? join(process.env.RETAKE_TEST_BUNDLE_OUT) : join(base, 'out');
      const { build } = (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs')).href)) as { build: (o: object) => Record<string, any> };
      const r = build({ out: builtOut, ffmpeg, env: process.env, offline: true });
      app = r.app;
      report.build = { timings_ms: r.timings_ms, sizes: r.sizes, signatures: r.signatures, mach_o: r.mach_o, links: r.links, dmg: r.dmg };
    }
    report.build_ms = Date.now() - t0;
    const home = join(base, 'home');
    for (const d of ['home', 'retake-home', 'tmp', 'bin']) mkdirSync(join(base, d), { recursive: true });
    env = {
      HOME: home,
      CFFIXED_USER_HOME: home,
      RETAKE_CAPTURES_DIR: process.env.RETAKE_CAPTURES_DIR ?? '',
      RETAKE_HOME: join(base, 'retake-home'),
      TMPDIR: `${join(base, 'tmp')}/`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      RETAKE_DISK_WARN: 'off',
    };
    launcher = join(app, 'Contents', 'Resources', 'bin', 'retake');
    symlinkSync(launcher, join(base, 'bin', 'retake'));
    libraryBefore = libraryEntries();
    // Canaries in every node_modules folder above the app this test owns (never in <out>/app: the DMG's source), and
    // in the scratch home's global folders.
    canaryLog = join(base, 'canaries.log');
    canaries = canaryNames(join(app, 'Contents', 'Resources', 'engine'));
    const above: string[] = [join(base, 'node_modules'), join(home, 'node_modules'), join(home, '.node_modules')];
    if (builtOut) above.push(join(builtOut, 'node_modules'));
    for (const nm of above) for (const name of canaries) plantCanary(nm, name, canaryLog);
    report.canaries = { names: canaries.length, folders: above.length };
    report.sizes = {
      app: du(app),
      ...(builtOut
        ? {
            dmg: statSync(
              readdirSync(builtOut)
                .filter((f) => f.endsWith('.dmg'))
                .map((f) => join(builtOut!, f))[0]!,
            ).size,
          }
        : {}),
    };
    // The fixture product (the filmed web app, from the repository) on this test's ports.
    fixture = spawn(
      process.execPath,
      [
        'fixtures/wholesale/server.mjs',
        '--console-port',
        String(PORTS.console),
        '--shop-port',
        String(PORTS.shop),
        '--auth-console-port',
        String(PORTS.authConsole),
        '--auth-shop-port',
        String(PORTS.authShop),
      ],
      { cwd: REPO, stdio: 'ignore' },
    );
    await until(
      async () =>
        await fetch(`http://127.0.0.1:${PORTS.shop}/`)
          .then((r) => r.ok)
          .catch(() => false),
      60_000,
      'the fixture product',
    );
    marker = join(base, 'marker');
    writeFileSync(marker, '');
    await sleep(1100); // mtimes have a second's grain on some file systems: anything written later is newer
  }, 20 * 60_000);

  afterAll(async () => {
    shell?.kill('SIGKILL');
    fixture?.kill('SIGTERM');
    if (app && existsSync(LSREGISTER)) spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
    if (process.env.RETAKE_TEST_BUNDLE_REPORT) writeFileSync(process.env.RETAKE_TEST_BUNDLE_REPORT, `${JSON.stringify(report, null, 1)}\n`);
    process.stdout.write(`bundle acceptance: ${JSON.stringify(report)}\n`);
    if (base && !process.env.RETAKE_TEST_KEEP) rmSync(base, { recursive: true, force: true });
  });

  it("the launcher: --version names the app (directly and through a link); doctor: every tool is the app's own", () => {
    for (const via of [launcher, join(base, 'bin', 'retake')]) {
      const v = retake(['--version'], { via });
      expect(v.status, v.out).toBe(0);
      expect(v.stdout.trim()).toBe(`${JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'bundle.json'), 'utf8')).app} (app bundle: ${app})`);
    }
    const d = retake(['doctor', '--json']);
    report.doctor_ms = d.ms;
    const doc = JSON.parse(d.stdout) as { failures: number; checks: Array<{ status: string; name: string; detail: string }> };
    const check = (name: string) => doc.checks.find((c) => c.name === name)!;
    expect(doc.failures, d.out).toBe(0);
    const manifest = JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'bundle.json'), 'utf8')) as { node: string };
    expect(check('Node.js').detail).toBe(manifest.node);
    for (const name of ['Chromium', 'Render browser', 'ffmpeg', 'ffprobe']) {
      expect(check(name).status, `${name}: ${check(name).detail}`).toBe('ok');
      expect(check(name).detail, name).toContain(join(app, 'Contents', 'Resources'));
      expect(check(name).detail, name).toMatch(/bundled/);
    }
    expect(check('MCP').detail).toContain(join(app, 'Contents', 'Resources', 'node', 'bin', 'node'));
    // L5.15: the app's renders run on the GPU — its relinked compositor's ffmpeg passes the VideoToolbox probe.
    expect(check('Renders'), JSON.stringify(check('Renders'))).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^GPU \(.*\) · VideoToolbox H\.264 · 3 frames at a time$/) });
    // L5.16d (review d A-L9): a bundle built without an update feed says so (its launch.json `updates: "off"`).
    expect(JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'launch.json'), 'utf8')).updates).toBe('off');
    expect(check('App updates').detail).toMatch(/^updates are off in this build/);
  });

  it(
    'a workspace by retake init, then a capture and a render of the fixture quote through the launcher',
    async () => {
      ws = join(base, 'ws');
      const init = retake(['init', ws]);
      expect(init.status, init.out).toBe(0);
      expect(existsSync(join(ws, 'retake.yaml'))).toBe(true);
      const project = join(ws, 'projects', 'northfield-fixture');
      const from = join(REPO, 'projects', 'northfield-fixture');
      cpSync(from, project, { recursive: true, filter: (src) => !['runs', 'renders', 'review', 'exports'].includes(src.slice(from.length + 1).split('/')[0]!) });
      // This test's ports; no sandboxes (they start the fixture from the repository).
      const yaml = readFileSync(join(project, 'project.yaml'), 'utf8')
        .replace(/localhost:4401/g, `localhost:${PORTS.console}`)
        .replace(/localhost:4402/g, `localhost:${PORTS.shop}`)
        .replace(/localhost:4403/g, `localhost:${PORTS.authConsole}`)
        .replace(/localhost:4404/g, `localhost:${PORTS.authShop}`)
        .replace(/^sandboxes:\n(?: {2}.*\n)+/m, '');
      expect(yaml).not.toMatch(/sandboxes:|localhost:440\d/);
      writeFileSync(join(project, 'project.yaml'), yaml);
      rmSync(join(project, 'sandbox'), { recursive: true, force: true });

      const run = retake(['--root', ws, 'run', 'northfield-fixture', 'quote'], { timeout: 10 * 60_000 });
      report.capture_ms = run.ms;
      expect(run.status, run.out.slice(-3000)).toBe(0);
      const runs = readdirSync(join(project, 'runs')).filter((r) => r.endsWith('-quote'));
      expect(runs).toHaveLength(1);
      const rec = JSON.parse(readFileSync(join(project, 'runs', runs[0]!, 'run.json'), 'utf8')) as { status: string; steps_done: number; steps_total: number };
      expect(rec.status).toBe('succeeded');
      expect(rec.steps_done).toBe(rec.steps_total);
      report.capture = { steps: rec.steps_total, size: statSync(join(project, 'runs', runs[0]!, 'capture.mp4')).size };

      const render = retake(['--root', ws, 'render', 'northfield-fixture', 'quote', '--review', '--json'], { timeout: 15 * 60_000 });
      report.render_ms = render.ms;
      expect(render.status, render.out.slice(-3000)).toBe(0);
      const r = JSON.parse(render.stdout) as {
        status: string;
        file: string;
        frames: number;
        duration_s: number;
        size_bytes: number;
        timings: unknown;
        browser: { path: string; source: string };
        review: { clean: boolean; counts: Record<string, number> };
        policy?: { gl: { used: string; renderer?: string }; encoder: { used: string }; fallback?: unknown };
        encoding: { encoder?: string };
      };
      expect(r.status).toBe('succeeded');
      // L5.15: the signed app's path (its relinked compositor, hardened runtime) draws with ANGLE and encodes with
      // VideoToolbox — the only check of that path (render-gpu.test.ts checks the repository's and a relinked copy's probe).
      expect(r.policy, JSON.stringify(r.policy)).toMatchObject({ gl: { used: 'angle', renderer: expect.stringMatching(/Metal/) }, encoder: { used: 'h264_videotoolbox' } });
      expect(r.policy?.fallback).toBeUndefined();
      expect(r.encoding.encoder).toBe('h264_videotoolbox');
      expect(r.browser.source).toBe('bundled');
      expect(r.browser.path).toContain(join(app, 'Contents', 'Resources', 'browsers'));
      expect(statSync(r.file).size).toBe(r.size_bytes);
      expect(r.review.counts.error ?? 0, JSON.stringify(r.review.counts)).toBe(0);
      report.render = { frames: r.frames, duration_s: r.duration_s, size_bytes: r.size_bytes, timings: r.timings, review: r.review.counts, clean: r.review.clean, policy: r.policy };
      // The render bundle took no canary either (renderBundleRestriction: the app, the workspace, the cache).
      expect(canaryMarked(join(ws, '.retake'))).toEqual([]);
    },
    30 * 60_000,
  );

  it(
    "the shell binary started directly serves the Studio from the app's own Node.js and engine",
    async () => {
      const t0 = Date.now();
      let out = '';
      // Outside the repository, as from Finder (review B L2): a cwd-relative lookup into the checkout would fail here.
      shell = spawn(join(app, 'Contents', 'MacOS', BIN_NAME), ['--root', ws], { cwd: base, env: { ...env, RETAKE_ROOT: '', RETAKE_DESKTOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      shell.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      shell.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      const exited = new Promise<number | null>((r) => shell!.on('exit', (code) => r(code)));
      const uiJson = join(ws, '.retake', 'ui.json');
      const rec = await until(() => studioRecord(ws, env.RETAKE_HOME), 60_000, `the Studio server (${out.slice(-500)})`);
      expect(readFileSync(uiJson, 'utf8')).not.toContain(rec.token);
      report.studio_start_ms = Date.now() - t0;
      const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(rec.pid)], { encoding: 'utf8' }).stdout.trim();
      const res = join(app, 'Contents', 'Resources');
      expect(cmd.startsWith(`${res}/node/bin/node --require ${res}/node/guard.cjs ${res}/engine/dist/bin.js --root ${ws} ui --supervised`), cmd).toBe(true);
      expect(cmd).not.toContain(REPO);
      const info = async () =>
        (await (await fetch(`http://127.0.0.1:${rec.port}/v1/info`, { headers: { authorization: `Bearer ${rec.token}` } })).json()) as { ok: boolean; data: { counters: { sessions: number } } };
      expect((await info()).ok).toBe(true);
      await until(async () => (await info()).data.counters.sessions >= 1, 30_000, 'the page redeeming its code');
      shell.kill('SIGTERM');
      expect(await exited).toBe(0);
      shell = undefined;
      expect(existsSync(uiJson)).toBe(false);
      expect(out).toMatch(/quit: SIGTERM/);
    },
    3 * 60_000,
  );

  it(
    "L5.16c: the first run (no workspace: test mode answers Create ~/Retake), then the Set-up sheet's ops on the app's own server: the command linked into the scratch HOME and run through the link, the folder panel and the notification request through the pipe",
    async () => {
      const t0 = Date.now();
      let out = '';
      const home2 = join(base, 'home-first-run');
      const pick = join(home2, 'tools');
      mkdirSync(pick, { recursive: true });
      shell = spawn(join(app, 'Contents', 'MacOS', BIN_NAME), [], {
        cwd: base,
        env: {
          ...env,
          HOME: home2,
          CFFIXED_USER_HOME: home2,
          RETAKE_HOME: join(base, 'retake-home-first-run'),
          RETAKE_ROOT: '',
          RETAKE_DESKTOP_TEST: '1',
          RETAKE_DESKTOP_TEST_ANSWERS: '0',
          RETAKE_DESKTOP_TEST_PICK: pick,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      shell.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      shell.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      const exited = new Promise<number | null>((r) => shell!.on('exit', (code) => r(code)));
      const made = join(home2, 'Retake');
      const rec = await until(() => studioRecord(made, join(base, 'retake-home-first-run')), 60_000, `the first run's Studio server (${out.slice(-800)})`);
      report.first_run_ms = Date.now() - t0;
      expect(out).toContain('(test mode) alert: Welcome to Retake');
      expect(out).toContain(`first run: retake init ${made}`);
      expect(existsSync(join(made, 'retake.yaml'))).toBe(true);
      expect(existsSync(join(made, 'projects'))).toBe(true);
      const call = async (op: string, args: object = {}) => {
        const r = await fetch(`http://127.0.0.1:${rec.port}/v1/call/${op}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${rec.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
        return { status: r.status, body: (await r.json()) as { data: Record<string, any>; error?: { details?: { reason?: string } } } };
      };
      const st = (await call('setup_status')).body.data;
      expect(st).toMatchObject({ available: true, location: 'ok', seen: false, app, workspace: made });
      expect(st.cli).toMatchObject({ dir: join(home2, '.local', 'bin'), state: 'absent' });
      const inst = await call('setup_cli_install', { folder: 'default' });
      expect(inst.body.data, JSON.stringify(inst.body)).toMatchObject({ result: 'created' });
      const link = join(home2, '.local', 'bin', 'retake');
      const v = retake(['--version'], { via: link });
      expect(v.stdout.trim()).toContain(`(app bundle: ${app})`);
      // The folder panel (test mode: RETAKE_DESKTOP_TEST_PICK) answers on the server's stdin; then the command goes there
      // — once the one in ~/.local/bin is uninstalled (one command per app: review c B-M1).
      expect((await call('setup_cli_choose')).status).toBe(200);
      await until(async () => (await call('setup_status')).body.data.cli.chosen === true, 15_000, `the panel's answer (${out.slice(-500)})`);
      expect((await call('setup_cli_install', { folder: 'chosen' })).body.error?.details?.reason).toBe('installed_elsewhere');
      expect((await call('setup_cli_remove')).body.data).toMatchObject({ result: 'removed', path: link });
      expect((await call('setup_cli_install', { folder: 'chosen' })).body.data).toMatchObject({ result: 'created', path: join(pick, 'retake') });
      // A second panel gives nothing (test mode's picks are used up): said as cancelled, the chosen link kept.
      expect((await call('setup_cli_choose')).status).toBe(200);
      await until(async () => (await call('setup_status')).body.data.cli.panel === 'cancelled', 15_000, `the cancelled panel (${out.slice(-500)})`);
      expect((await call('setup_status')).body.data.cli).toMatchObject({ installed: join(pick, 'retake'), state: 'ours' });
      // The notification request reaches the shell (test mode: logged, never UN) and its answer comes back.
      expect((await call('setup_notifications')).status).toBe(200);
      await until(() => out.includes('(test mode) notifications: the permission would be asked now'), 15_000, 'the notification request');
      // Claude Desktop has no folder in the scratch HOME: refused, nothing created under its Library.
      expect((await call('setup_claude_desktop_add')).body.error?.details?.reason).toMatch(/no_claude|claude_running/);
      expect(existsSync(join(home2, 'Library', 'Application Support', 'Claude'))).toBe(false);
      expect((await call('setup_cli_remove')).body.data).toMatchObject({ result: 'removed', path: join(pick, 'retake') });
      expect(existsSync(join(pick, 'retake'))).toBe(false);
      expect((await call('setup_done')).status).toBe(200);
      shell.kill('SIGTERM');
      expect(await exited).toBe(0);
      shell = undefined;
      // Remembered: the next start opens it with no question.
      expect(readFileSync(join(base, 'retake-home-first-run', 'desktop.json'), 'utf8')).toContain(made);
    },
    3 * 60_000,
  );

  it(
    "L5.16c fixes (review c B-L5): the first run's Choose a Folder… — a folder that is not empty is refused by retake init and the question comes back with the reason; then an empty folder becomes the workspace",
    async () => {
      const t0 = Date.now();
      let out = '';
      const home3 = join(base, 'home-first-run-choose');
      const full = join(home3, 'Documents');
      const empty = join(home3, 'Videos');
      mkdirSync(full, { recursive: true });
      mkdirSync(empty, { recursive: true });
      writeFileSync(join(full, 'notes.txt'), "the person's file\n");
      shell = spawn(join(app, 'Contents', 'MacOS', BIN_NAME), [], {
        cwd: base,
        env: {
          ...env,
          HOME: home3,
          CFFIXED_USER_HOME: home3,
          RETAKE_HOME: join(base, 'retake-home-choose'),
          RETAKE_ROOT: '',
          RETAKE_DESKTOP_TEST: '1',
          RETAKE_DESKTOP_TEST_ANSWERS: '1,1',
          RETAKE_DESKTOP_TEST_PICK: `${full}:${empty}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      shell.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      shell.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      const exited = new Promise<number | null>((r) => shell!.on('exit', (code) => r(code)));
      const uiJson = join(empty, '.retake', 'ui.json');
      await until(() => existsSync(uiJson), 60_000, `the chosen folder's Studio server (${out.slice(-800)})`);
      report.first_run_choose_ms = Date.now() - t0;
      expect(out).toContain(`first run: retake init ${full}`);
      expect(out).toContain('first run: retake init failed');
      expect(out).toContain(`first run: retake init ${empty}`);
      // Asked twice (the second time with the reason), the person's folder left as it was.
      expect(out.split('(test mode) alert: Welcome to Retake').length - 1).toBe(2);
      expect(readdirSync(full)).toEqual(['notes.txt']);
      expect(existsSync(join(empty, 'retake.yaml'))).toBe(true);
      shell.kill('SIGTERM');
      expect(await exited).toBe(0);
      shell = undefined;
      expect(readFileSync(join(base, 'retake-home-choose', 'desktop.json'), 'utf8')).toContain(empty);
    },
    3 * 60_000,
  );

  it('above Resources: a clone of the app with canaries in Contents/node_modules and Retake.app/node_modules runs doctor without loading them', () => {
    const clone = join(base, 'clone', 'Retake.app');
    mkdirSync(dirname(clone), { recursive: true });
    expect(spawnSync('cp', ['-cR', app, clone]).status).toBe(0);
    for (const nm of [join(clone, 'Contents', 'node_modules'), join(clone, 'node_modules')]) for (const name of canaries) plantCanary(nm, name, canaryLog);
    const d = retake(['doctor', '--json'], { via: join(clone, 'Contents', 'Resources', 'bin', 'retake') });
    expect(JSON.parse(d.stdout).failures, d.out).toBe(0);
    rmSync(join(base, 'clone'), { recursive: true, force: true });
  });

  it("bundle.json's sha256 values are the app's signed files' (review B M3)", () => {
    const res = join(app, 'Contents', 'Resources');
    const m = JSON.parse(readFileSync(join(res, 'bundle.json'), 'utf8')) as {
      paths: { node: string; ffmpeg: string | null };
      sha256: { node: string };
      ffmpeg: { sha256: Record<string, string> } | null;
    };
    const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(m.sha256.node).toBe(sha(join(res, m.paths.node)));
    if (m.ffmpeg && m.paths.ffmpeg) for (const t of ['ffmpeg', 'ffprobe']) expect(m.ffmpeg.sha256[t], t).toBe(sha(join(res, m.paths.ffmpeg, t)));
  });

  it('afterwards: no canary ran, the app still verifies, nothing inside it changed, ~/Library is as it was', () => {
    expect(existsSync(canaryLog) ? readFileSync(canaryLog, 'utf8') : '').toBe('');
    const v = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8' });
    expect(v.status, v.stderr).toBe(0);
    const newer = spawnSync('find', [app, '-newer', marker], { encoding: 'utf8' }).stdout.trim();
    expect(newer).toBe('');
    expect(libraryEntries()).toEqual(libraryBefore);
  });
});
