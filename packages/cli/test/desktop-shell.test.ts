/**
 * L5.2 — the desktop shell, black box (gated: DEMO_STUDIO_TEST_DESKTOP=1, macOS, cargo on PATH, `pnpm build` first;
 * WKWebView has no WebDriver on macOS, so the proofs are the server's own counters, process tables and lsof).
 *
 * One release build (`desktop.mjs build --id local.demo-studio.desktop.test --out <scratch>`, cargo --offline when
 * CARGO_NET_OFFLINE=true), launched by its binary inside the .app — never `open`, never a Launch Services lookup —
 * with a scratch DEMO_STUDIO_HOME and workspace and DEMO_STUDIO_DESKTOP_TEST=1 (no modal dialog):
 * - it owns the workspace's server: the `ui.json` holder is its child, whose command line holds no secret; the child
 *   listens on 127.0.0.1 only (two listeners: the Studio and the player);
 * - the page loaded: the server counted a redeemed code and an open event stream (`/v1/info` counters, read with the
 *   token of ui.json — the owner's file); a window screenshot is kept for a person to look at;
 * - SIGTERM quits through the graceful path (`quit: SIGTERM`, the child's `stopped: SIGTERM`, ui.json removed);
 *   SIGKILL (a crash) leaves no orphan (the child's stdin EOF); a server already running is attached to and survives;
 * - File › Open Workspace… (SIGUSR1 in test mode) on a folder that is no workspace changes nothing: the app, its
 *   server and its page stay (review B M1);
 * - a hostile launch (review A M1 / M2 / L2 / L4): a copy of the app whose launch.json runs a fake `studio ui
 *   --supervised` serving an adversarial page, a "player" framed `sandbox="allow-scripts"` as the timeline frames it,
 *   and a foreign port — the foreign port gets no request (iframe, redirect, srcdoc frame, octal host, target=_blank,
 *   window.open, top-level location), data: / blob: / custom-scheme navigations are refused, no download lands in
 *   ~/Downloads (files named with a unique token; only those are ever deleted), every IPC call is refused, no capture
 *   device is reachable, and the fake server never sees NODE_OPTIONS;
 * - nothing printed holds the one-time code, the token, a capability or any secret-shaped run;
 * - ~/Library gains nothing named after the test bundle id or the binary (WebKit, Caches, HTTPStorages, Saved
 *   Application State, Preferences, Application Support, Cookies, Logs); Launch Services, which records a bundle even
 *   when its binary is started directly, keeps no record once the test unregisters it (`lsregister -u`).
 * With DEMO_STUDIO_TEST_SLOW=1 too (and Chromium): a capture of the fixture, then the app on its timeline (`--route`):
 * the player served the frame its media (bytes counted) — that the Player paints it is the screenshot, looked at by a
 * person (playing needs a click: MACOS-CHECKLIST 14a). DEMO_STUDIO_TEST_SHOTS=<folder> keeps the screenshots there.
 * A screenshot is honest about itself (review B): a locked screen skips it, and a capture without Screen Recording
 * permission or a blank picture is reported "unverified" (printed with the timings) — never a silent pass.
 * L5.2b (job notifications, quit guard; SIGUSR2 is Quit through `terminate:` in test mode — the ⌘Q path):
 * - nothing pending: SIGUSR2 quits at once, no question, the server stopped gracefully;
 * - a running job (its worker: this process) holds Quit and Open Workspace… (test mode answers Cancel: the app and its
 *   server stay); once it ended, SIGUSR2 quits;
 * - unsaved text a tab reports (the op, with ui.json's token as a tab would hold it) is named in the question — never a
 *   name that does not exist, never a field the op refuses; an empty report clears it;
 * - job ends become notifications by the no-storm rule (test mode logs them): window not in front → one at once and one
 *   summary 5 s later; in front → none;
 * - an attached server: no guard, no notifications (said), SIGUSR2 quits at once and leaves it running with its job;
 * - the real alert (DEMO_STUDIO_DESKTOP_TEST_MODAL_MS): a second window of the app while it is up, gone after; a second
 *   SIGUSR2 meanwhile is ignored (critique H2); SIGTERM while it is up quits (M1). Screenshots of the question with a job
 *   and with unsaved text are kept (DEMO_STUDIO_TEST_SHOTS);
 * - the owned server killed with unsaved text in the window: the restart alert names it, Not Now (its default: Restart
 *   and Quit have no key, review B M4) keeps the window, and Quit then asks about the text only — the dead server's
 *   jobs are history (critique L2).
 * Review fixes: Quit Anyway and Open Anyway end to end (ANSWERS, review B M5: the app exits 0, the owned server stopped
 * gracefully, the picked workspace served, the job left running); SIGTERM ends every question of the shell, not only
 * the quit question (review B M1: Open Workspace…'s, "not a workspace", the restart alert — each up for real with
 * MODAL_MS, the app gone well before its abort); a Quit while the restart alert is up is answered Cancel by the hook or
 * not delivered by AppKit — never a nested question (B L13); the picker never opens inside the quit question (B L10);
 * the second Quit of H2 sent only once the question is up (B L2); the notification summary polled for (B L3).
 * Notifications themselves (the permission prompt, a banner, the click) are a person's check: MACOS-CHECKLIST 14a.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selfIdentity } from '@demo-studio/engine';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const SCRIPT = join(REPO, 'apps', 'desktop', 'scripts', 'desktop.mjs');
const TEST_ID = 'local.demo-studio.desktop.test';
// The binary's name: Cargo.toml `name`, its one place (review B L12).
const BIN_NAME = /^name = "([^"]+)"/m.exec(readFileSync(join(REPO, 'apps', 'desktop', 'Cargo.toml'), 'utf8'))![1];
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const LIBRARY_DIRS = ['WebKit', 'Caches', 'HTTPStorages', 'Saved Application State', 'Preferences', 'Application Support', 'Cookies', 'Logs'];
const WANTED = process.env.DEMO_STUDIO_TEST_DESKTOP === '1' && process.platform === 'darwin';
// Probed only when asked for (review B M4: the default suite never runs cargo for this file).
const ENABLED = WANTED && existsSync(CLI) && spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;
const SLOW = ENABLED && process.env.DEMO_STUDIO_TEST_SLOW === '1';
const SHOTS = process.env.DEMO_STUDIO_TEST_SHOTS;

let base: string;
let ws: string;
let home: string;
let binary: string;
let app: string;
let hostileApp: string | undefined;
const launched: ChildProcess[] = [];
const outputs: string[] = [];
const timings: Record<string, number> = {};
const shots: Record<string, string> = {};
/** Names a download of the hostile page would get: unique to this run (the only ~/Downloads entries ever deleted). */
const TOKEN = `studio-desktop-test-${process.pid}-${Date.now()}`;
const DOWNLOADS = join(homedir(), 'Downloads');

/** Entries of ~/Library named after the test app (bundle id or binary name). */
function libraryEntries(): string[] {
  const found: string[] = [];
  for (const d of LIBRARY_DIRS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(homedir(), 'Library', d));
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith(TEST_ID) || n === BIN_NAME || n.startsWith(`${BIN_NAME}.`)) found.push(join(d, n));
  }
  return found;
}

const lsRecords = () => spawnSync('/bin/sh', ['-c', `${LSREGISTER} -dump 2>/dev/null | grep -c ${TEST_ID}`], { encoding: 'utf8' }).stdout.trim();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

interface Record_ {
  pid: number;
  port: number;
  token: string;
}
const uiJson = (root = ws) => join(root, '.demo-studio', 'ui.json');
async function record(root = ws): Promise<Record_ | undefined> {
  try {
    return JSON.parse(await readFile(uiJson(root), 'utf8')) as Record_;
  } catch {
    return undefined;
  }
}

interface Counters {
  sessions: number;
  streams: number;
  player_media_bytes_read: number;
  player_range_requests: number;
}
async function counters(r: Record_): Promise<Counters> {
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/info`, { headers: { authorization: `Bearer ${r.token}` } });
  return ((await res.json()) as { data: { counters: Counters } }).data.counters;
}

interface App {
  child: ChildProcess;
  err: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
function launch(args: string[], o: { bin?: string; env?: NodeJS.ProcessEnv } = {}): App {
  const child = spawn(o.bin ?? binary, ['--root', ws, ...args], {
    env: { ...process.env, DEMO_STUDIO_HOME: home, DEMO_STUDIO_ROOT: '', DEMO_STUDIO_DESKTOP_TEST: '1', ...o.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launched.push(child);
  let out = '';
  child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.on('exit', (code, signal) => {
      outputs.push(out);
      r({ code, signal });
    }),
  );
  return { child, err: () => out, exit };
}

/** What a shell's output must never hold: the one-time code, the token, a capability path, any secret-shaped run. */
function expectClean(out: string, token: string): void {
  expect(out).not.toContain('#c=');
  expect(out).not.toContain(token);
  expect(out).not.toMatch(/\/[sm]\/[A-Za-z0-9_-]{43}/);
  expect(out).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  expect(out).not.toMatch(/__TAURI_INVOKE_KEY__/);
}

/**
 * The window of `pid` into a PNG (JXA: CGWindowListCopyWindowInfo, no dependency), with a verdict on the picture: a
 * locked screen (or no window-server session) skips it; without Screen Recording permission (CGPreflightScreenCapture
 * Access, which never prompts) or when the picture is one flat colour, it is "unverified" — said, never passed silently.
 */
async function screenshot(pid: number, name: string, top = false): Promise<string> {
  const js = join(base, 'window.js');
  await writeFile(
    js,
    `ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
function run(argv) {
  const session = $.CGSessionCopyCurrentDictionary();
  if (!session) return JSON.stringify({ skip: 'no window-server session' });
  if (ObjC.unwrap(ObjC.castRefToObject(session).objectForKey('CGSSessionScreenIsLocked'))) return JSON.stringify({ skip: 'the screen is locked' });
  const allowed = $.CGPreflightScreenCaptureAccess();
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  let best = null;
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')) !== Number(argv[0])) continue;
    const layer = ObjC.unwrap(w.objectForKey('kCGWindowLayer'));
    const n = String(ObjC.unwrap(w.objectForKey('kCGWindowNumber')));
    if (argv[1] === 'top' ? layer > 0 && (!best || layer > best.layer) : layer === 0 && !best) best = { n, layer };
  }
  return JSON.stringify({ allowed, window: best ? best.n : '' });
}`,
  );
  const probe = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', js, String(pid), top ? 'top' : 'main'], { encoding: 'utf8' })) as { skip?: string; allowed?: boolean; window?: string };
  const w = await until(() => {
    const r = probe();
    return r.skip || r.window ? r : undefined;
  }, 10_000, 'the window');
  if (w.skip) return (shots[name] = `skipped: ${w.skip}`);
  const dir = SHOTS ?? join(base, 'shots');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  execFileSync('screencapture', ['-x', '-o', `-l${w.window}`, file]);
  expect(statSync(file).size).toBeGreaterThan(1000);
  if (!w.allowed) return (shots[name] = 'unverified: no Screen Recording permission (the picture shows no window content)');
  const sharp = createRequire(join(REPO, 'packages', 'review', 'package.json'))('sharp') as (f: string) => { stats(): Promise<{ channels: { stdev: number }[] }> };
  const { channels } = await sharp(file).stats();
  const flat = Math.max(...channels.slice(0, 3).map((c) => c.stdev)) < 2;
  return (shots[name] = flat ? `unverified: a blank picture (${file})` : `ok (${file})`);
}

/**
 * The app's on-screen windows (any layer: the main window, an alert panel), counted with CGWindowListCopyWindowInfo —
 * owner pid, number and layer only, no window name: no Screen Recording permission needed. -1 when the screen is locked.
 */
async function windowCount(pid: number): Promise<number> {
  const js = join(base, 'windows.js');
  if (!existsSync(js)) {
    await writeFile(
      js,
      `ObjC.import('CoreGraphics');
function run(argv) {
  const session = $.CGSessionCopyCurrentDictionary();
  if (!session || ObjC.unwrap(ObjC.castRefToObject(session).objectForKey('CGSSessionScreenIsLocked'))) return '-1';
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  let n = 0;
  for (let i = 0; i < list.count; i++) if (ObjC.unwrap(list.objectAtIndex(i).objectForKey('kCGWindowOwnerPID')) === Number(argv[0])) n++;
  return String(n);
}`,
    );
  }
  return Number(execFileSync('osascript', ['-l', 'JavaScript', js, String(pid)], { encoding: 'utf8' }).trim());
}

let jobN = 0;
const RENDER = { version: 1, kind: 'render', project: 'northfield-fixture', scenario: 'quote', render_id: 'quote-v1', submitted_by: 'test' };
/** A job folder written as a worker would (L5.2b): `running` names this process as its worker (alive: it holds Quit). */
async function writeJob(root: string, state: string, at?: string): Promise<string> {
  const id = at ?? `j_${String(Date.now()).padStart(13, '0')}${String(++jobN).padStart(13, '0')}`;
  const dir = join(root, '.demo-studio', 'jobs', id);
  await mkdir(dir, { recursive: true });
  const rec = { version: 1, id, kind: 'render', input: RENDER, state, created_at: new Date().toISOString(), ...(state === 'running' ? { worker: { ...(await selfIdentity()), host: 'test' } } : {}) };
  await writeFile(join(dir, 'job.json'), JSON.stringify(rec));
  return id;
}

/** `unsaved_report` as a tab session would send it (ui.json's token: the test may read it; the shell never does). */
async function report(r: Record_, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/call/unsaved_report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${r.port}` },
    body: JSON.stringify(body),
  });
  return res.status;
}
const TAB = 'desktopTestTab00000000';
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** ~/Downloads entries named with this run's token; undefined when the folder cannot be listed (no access). */
function tokenDownloads(): string[] | undefined {
  try {
    return readdirSync(DOWNLOADS).filter((n) => n.includes(TOKEN));
  } catch {
    return undefined;
  }
}

/**
 * The fake `studio ui --supervised` of the hostile launch (review A M2): three loopback listeners on free ports — the
 * "Studio" serving an adversarial page, a "player" the page frames `sandbox="allow-scripts"`, a foreign port — every
 * request logged to log.txt next to it; it prints the supervised line and stops on stdin's end or SIGTERM.
 */
function hostileCli(token: string): string {
  return `import http from 'node:http';
import { appendFileSync } from 'node:fs';
const LOG = new URL('./log.txt', import.meta.url).pathname;
const log = (s) => appendFileSync(LOG, s + '\\n');
log('env NODE_OPTIONS ' + ('NODE_OPTIONS' in process.env ? 'present' : 'absent'));
const servers = { studio: http.createServer(), player: http.createServer(), FOREIGN: http.createServer() };
const port = {};
const studioPage = () => \`<!doctype html><meta charset=utf-8><title>hostile</title><body><script>
const R = (k, v) => navigator.sendBeacon('/report?k=' + encodeURIComponent(k) + '&v=' + encodeURIComponent(String(v).slice(0, 300)));
const F = 'http://127.0.0.1:\${port.FOREIGN}';
(async () => {
  for (const cmd of ['plugin:app|version', 'plugin:window|title', 'plugin:webview|print', 'plugin:event|emit', 'plugin:path|resolve_directory']) {
    try { const r = await window.__TAURI_INTERNALS__.invoke(cmd, {}); R('invoke', 'OK ' + cmd); } catch (e) { R('invoke', 'refused ' + cmd + ': ' + (e && e.message || e)); }
  }
  R('main.open', String(window.open(F + '/popup')));
  R('main.gum', navigator.mediaDevices ? 'mediaDevices present' : 'no mediaDevices');
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia({ audio: true }).then(() => R('main.gum', 'GRANTED'), (e) => R('main.gum', 'denied ' + e.name));
  const frame = (name, src, extra) => { const f = document.createElement('iframe'); f.name = name; if (extra) extra(f); f.src = src; document.body.appendChild(f); return f; };
  frame('foreign', F + '/iframe');
  frame('redirect', '/redir');
  frame('data', 'data:text/html,<script>parent.postMessage("data-ran","*")<\\\\/script>');
  frame('blob', URL.createObjectURL(new Blob(['<script>parent.postMessage("blob-ran","*")<\\\\/script>'], { type: 'text/html' })));
  frame('scheme', 'x-studio-probe:hello');
  frame('srcdoc', 'about:blank', (f) => { f.srcdoc = '<script>location = "' + F + '/srcdoc"<\\\\/script>'; });
  frame('octal', 'http://0177.0.0.1:\${port.FOREIGN}/octal');
  frame('download', '/${token}-frame.bin');
  frame('player', 'http://127.0.0.1:\${port.player}/frame', (f) => f.setAttribute('sandbox', 'allow-scripts'));
  addEventListener('message', (e) => R('msg', e.data));
  const a = document.createElement('a'); a.href = '/${token}-link.bin'; a.download = '${token}-link.bin'; document.body.appendChild(a); a.click();
  const t = document.createElement('a'); t.href = F + '/blank'; t.target = '_blank'; document.body.appendChild(t); t.click();
  setTimeout(() => { R('main.top', 'leaving'); location.href = F + '/top'; }, 4000);
  setTimeout(() => R('main.done', 'still here'), 6000);
})();
</script>\`;
const playerPage = () => \`<!doctype html><meta charset=utf-8><body><script>
const R = (k, v) => navigator.sendBeacon('/report?k=' + encodeURIComponent(k) + '&v=' + encodeURIComponent(String(v).slice(0, 300)));
R('p.internals', typeof window.__TAURI_INTERNALS__);
try { window.webkit.messageHandlers.ipc.postMessage(JSON.stringify({ cmd: 'plugin:app|version', callback: 1, error: 2, payload: {}, options: {}, __TAURI_INVOKE_KEY__: 'guess' })); R('p.post', 'sent'); } catch (e) { R('p.post', 'throw ' + e); }
fetch('ipc://localhost/plugin%3Aapp%7Cversion', { method: 'POST', body: '{}' }).then((r) => R('p.ipc', 'status ' + r.status), (e) => R('p.ipc', 'error'));
R('p.open', String(window.open('http://127.0.0.1:\${port.FOREIGN}/p-popup')));
R('p.gum', navigator.mediaDevices ? 'mediaDevices present' : 'no mediaDevices');
</script>\`;
const handler = (name) => (req, res) => {
  log(name + ' ' + req.method + ' ' + req.url);
  if (name === 'studio' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(studioPage()); }
  if (name === 'player' && req.url === '/frame') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(playerPage()); }
  if (req.url === '/redir') { res.writeHead(302, { location: 'http://127.0.0.1:' + port.FOREIGN + '/after-redirect' }); return res.end(); }
  if (req.url.endsWith('.bin')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="${token}.bin"' }); return res.end('probe'); }
  if (req.method === 'POST') { req.resume(); res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>' + name + '</p>');
};
let up = 0;
for (const [name, srv] of Object.entries(servers)) {
  srv.on('request', handler(name));
  srv.listen(0, '127.0.0.1', () => {
    port[name] = srv.address().port;
    if (++up < 3) return;
    log('ports ' + JSON.stringify(port));
    const code = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';
    process.stdout.write(JSON.stringify({ type: 'ui', v: 2, url: 'http://127.0.0.1:' + port.studio + '/#c=' + code, port: port.studio, pid: process.pid, reused: false, player: 'http://127.0.0.1:' + port.player }) + '\\n');
  });
}
process.stdin.on('data', () => {});
process.stdin.on('end', () => { log('stdin EOF'); process.exit(0); });
process.stdin.resume();
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
`;
}

describe.skipIf(!ENABLED)('the desktop shell, black box (DEMO_STUDIO_TEST_DESKTOP=1)', () => {
  const libraryBefore: string[] = [];
  let lsBefore = '';

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-desktop-'));
    home = join(base, 'home');
    ws = join(base, 'ws');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    libraryBefore.push(...libraryEntries());
    lsBefore = lsRecords();
    const t0 = Date.now();
    const out = execFileSync(process.execPath, [SCRIPT, 'build', '--out', join(base, 'app'), '--id', TEST_ID], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 });
    timings.build_ms = Date.now() - t0;
    app = out.trim().split('\n').pop()!;
    binary = join(app, 'Contents', 'MacOS', BIN_NAME);
  }, 660_000);

  afterAll(async () => {
    for (const c of launched) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    await sleep(500);
    const r = await record();
    if (r && alive(r.pid)) process.kill(r.pid, 'SIGTERM');
    for (const a of [app, hostileApp]) if (a && existsSync(LSREGISTER)) spawnSync(LSREGISTER, ['-u', a], { stdio: 'ignore' });
    // Only the files this run named (a download that landed despite the shell: the test failed on it).
    for (const n of tokenDownloads() ?? []) await rm(join(DOWNLOADS, n), { force: true });
    // Only what is named after the TEST bundle id (never another app's folder).
    for (const e of libraryEntries()) if (e.split('/').pop()!.startsWith(TEST_ID)) await rm(join(homedir(), 'Library', e), { recursive: true, force: true });
    if (base) await rm(base, { recursive: true, force: true });
    console.log(`desktop shell timings: ${JSON.stringify(timings)}`);
    console.log(`desktop shell screenshots: ${JSON.stringify(shots)}`);
    for (const [k, v] of Object.entries(shots)) if (!v.startsWith('ok')) console.warn(`desktop shell screenshot ${k}: ${v}`);
  });

  it('owns the server: the ui.json holder is its child, listening on 127.0.0.1 only; the page loaded (a code redeemed, an event stream open)', async () => {
    const t0 = Date.now();
    const a = launch([]);
    const r = await until(() => record(), 20_000, 'ui.json');
    timings.serving_ms = Date.now() - t0;
    expect(execFileSync('ps', ['-o', 'ppid=', '-p', String(r.pid)], { encoding: 'utf8' }).trim()).toBe(String(a.child.pid));
    // Its command line holds no secret: the workspace and the flag only (the code comes back on its stdout).
    const argv = execFileSync('ps', ['-o', 'command=', '-p', String(r.pid)], { encoding: 'utf8' }).trim();
    expect(argv.includes(`${CLI} --root `) && argv.endsWith(`${ws.split('/').slice(-2).join('/')} ui --supervised`), argv).toBe(true);
    expect(argv).not.toMatch(/#c=|[A-Za-z0-9_-]{40,}/);
    const listen = execFileSync('lsof', ['-nP', '-a', '-p', String(r.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.startsWith('n'));
    expect(listen).toHaveLength(2);
    for (const l of listen) expect(l).toMatch(/^n127\.0\.0\.1:\d+$/);
    const c = await until(async () => {
      const x = await counters(r);
      return x.sessions >= 1 && x.streams >= 1 ? x : undefined;
    }, 20_000, 'a redeemed code and an open event stream');
    timings.page_live_ms = Date.now() - t0;
    expect(c.sessions).toBe(1);
    await screenshot(a.child.pid!, 'desktop-home');
    expect(a.err()).toContain(`the Studio server serves http://127.0.0.1:${r.port} (pid ${r.pid}, owned: Quit stops it)`);

    // SIGTERM: the graceful path — the shell's quit, the child's own reason, ui.json released.
    const t1 = Date.now();
    a.child.kill('SIGTERM');
    expect(await a.exit).toEqual({ code: 0, signal: null });
    await until(() => !alive(r.pid) && !existsSync(uiJson()), 5000, 'the server stopped');
    timings.quit_ms = Date.now() - t1;
    expect(a.err()).toContain('demo-studio-desktop: quit: SIGTERM');
    expect(a.err()).toContain('studio: stopped: SIGTERM');
    expect(a.err()).toMatch(new RegExp(`stopped the Studio server \\(pid ${r.pid}, quit\\): exit status: 0 after \\d+ ms`));
    expectClean(a.err(), r.token);
  }, 60_000);

  it('a crash (SIGKILL) leaves no orphan: the child sees its stdin close and stops, ui.json removed', async () => {
    const a = launch([]);
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(async () => (await counters(r)).streams >= 1, 20_000, 'the page');
    const t0 = Date.now();
    a.child.kill('SIGKILL');
    expect((await a.exit).signal).toBe('SIGKILL');
    await until(() => !alive(r.pid) && !existsSync(uiJson()), 5000, 'the orphan rule');
    timings.orphan_stop_ms = Date.now() - t0;
    expect(a.err()).not.toContain('stopped the Studio server');
    expectClean(a.err(), r.token);
  }, 60_000);

  it('a server already running: the app attaches (its page loads there), no guard and no notifications (said); Quit (SIGUSR2) at once leaves that server and its job running', async () => {
    const term = spawn(process.execPath, [CLI, '--root', ws, 'ui', '--no-open', '--json'], { env: { ...process.env, DEMO_STUDIO_HOME: home, DEMO_STUDIO_ROOT: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
    launched.push(term);
    const r = await until(() => record(), 20_000, 'the terminal server');
    expect(r.pid).toBe(term.pid);
    const job = await writeJob(ws, 'running');
    const a = launch([]);
    await until(async () => (await counters(r)).sessions >= 1, 20_000, 'the page on the attached server');
    expect(a.err()).toContain(`attached to the Studio server of pid ${r.pid}`);
    expect(a.err()).toContain('attached: no notifications and no quit guard');
    const t0 = Date.now();
    a.child.kill('SIGUSR2');
    expect((await a.exit).code).toBe(0);
    timings.attached_quit_ms = Date.now() - t0;
    expect(timings.attached_quit_ms).toBeLessThan(3000);
    expect(a.err()).not.toContain('(test mode) alert:');
    expect(a.err()).toContain(`quit: the attached Studio server (pid ${r.pid}) keeps running`);
    await sleep(500);
    expect(alive(r.pid)).toBe(true);
    expect((await record())?.pid).toBe(r.pid);
    expect((await fetch(`http://127.0.0.1:${r.port}/`)).status).toBe(200);
    expect(JSON.parse(await readFile(join(ws, '.demo-studio', 'jobs', job, 'job.json'), 'utf8')).state).toBe('running');
    expectClean(a.err(), r.token);
    term.kill('SIGTERM');
    await until(() => !existsSync(uiJson()), 5000, 'the terminal server stopped');
    await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
  }, 60_000);

  it('L5.2b: nothing pending — Quit (SIGUSR2, the terminate: path of ⌘Q) is instant: no question, the server stopped gracefully', async () => {
    const a = launch([]);
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(async () => (await counters(r)).streams >= 1, 20_000, 'the page');
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 10_000, 'the first pending snapshot');
    expect(a.err()).toContain('quit guard on');
    const t0 = Date.now();
    a.child.kill('SIGUSR2');
    expect(await a.exit).toEqual({ code: 0, signal: null });
    timings.quit_nothing_pending_ms = Date.now() - t0;
    expect(timings.quit_nothing_pending_ms).toBeLessThan(3000);
    await until(() => !alive(r.pid) && !existsSync(uiJson()), 5000, 'the server stopped');
    expect(a.err()).toContain('(test mode) SIGUSR2: Quit (terminate:)');
    expect(a.err()).not.toContain('(test mode) alert:');
    expect(a.err()).toContain('studio: stopped: SIGTERM');
    expect(a.err()).toMatch(new RegExp(`stopped the Studio server \\(pid ${r.pid}, quit\\)`));
    expectClean(a.err(), r.token);
  }, 60_000);

  it('L5.2b: a running job holds Quit and Open Workspace… (answered Cancel: app and server stay); once it ended, Quit is instant', async () => {
    const other = join(base, 'other-ws');
    await mkdir(join(other, 'projects'), { recursive: true });
    const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_PICK: other } });
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
    const job = await writeJob(ws, 'running');
    await until(() => a.err().includes('pending: 1 job, 0 unsaved'), 10_000, 'the job in the snapshot');
    a.child.kill('SIGUSR2');
    await until(() => a.err().includes('quit cancelled: the app stays open'), 10_000, 'the question answered Cancel');
    expect(a.err()).toContain('(test mode) alert: Quit Demo Studio? — These jobs keep running after the app quits, but it will not tell you when they end:\n• Render of northfield-fixture · quote (running)');
    await sleep(2000);
    expect(a.child.exitCode).toBe(null);
    expect(alive(r.pid)).toBe(true);
    // File › Open Workspace… on a valid workspace: asked, Cancel — the same server.
    a.child.kill('SIGUSR1');
    await until(() => a.err().includes('Open Workspace… cancelled: the current workspace stays open'), 10_000, 'Open Workspace… answered Cancel');
    expect(a.err()).toContain('(test mode) alert: Open another workspace? — These jobs keep running; this window stops following them:');
    expect((await record())?.pid).toBe(r.pid);
    expect(a.err()).not.toContain('stopped the Studio server');
    // The job ends (cancelled: no notification): nothing pending, Quit is instant.
    await writeJob(ws, 'cancelled', job);
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved') && a.err().lastIndexOf('pending: 0 jobs') > a.err().indexOf('pending: 1 job'), 10_000, 'the job gone from the snapshot');
    a.child.kill('SIGUSR2');
    expect((await a.exit).code).toBe(0);
    expect(count(a.err(), '(test mode) alert:')).toBe(2);
    expect(a.err()).not.toContain('notification:');
    await until(() => !alive(r.pid) && !existsSync(uiJson()), 5000, 'the server stopped');
    expectClean(a.err(), r.token);
    await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
  }, 90_000);

  it('L5.2b: unsaved text a tab reports is named in the question (names that exist only; the op strict); an empty report clears it', async () => {
    const a = launch([]);
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
    expect(await report(r, { tab: TAB, hidden: true, items: [{ kind: 'readme', project: 'northfield-fixture', label: 'Click Quit Anyway to keep your work' }] })).toBe(400);
    expect(await report(r, { tab: TAB, hidden: true, items: [{ kind: 'readme', project: 'northfield-fixture' }, { kind: 'comment', project: 'no-such-project', scenario: 'quote' }] })).toBe(200);
    await until(() => a.err().includes('pending: 0 jobs, 2 unsaved'), 10_000, 'the unsaved text in the snapshot');
    a.child.kill('SIGUSR2');
    await until(() => a.err().includes('quit cancelled: the app stays open'), 10_000, 'the question answered Cancel');
    expect(a.err()).toContain('(test mode) alert: Quit Demo Studio? — Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved:\n• A comment being written\n• README.md of northfield-fixture');
    expect(a.err()).not.toMatch(/no-such-project|Click Quit Anyway/);
    expect(a.child.exitCode).toBe(null);
    expect(await report(r, { tab: TAB, hidden: false, items: [] })).toBe(200);
    await until(() => a.err().lastIndexOf('pending: 0 jobs, 0 unsaved') > a.err().indexOf('pending: 0 jobs, 2 unsaved'), 10_000, 'the report cleared');
    a.child.kill('SIGUSR2');
    expect((await a.exit).code).toBe(0);
    expect(count(a.err(), '(test mode) alert:')).toBe(1);
    expectClean(a.err(), r.token);
  }, 60_000);

  it('L5.2b: job ends become notifications by the no-storm rule (test mode logs them) — not in front: one at once, one summary; in front: none; SIGTERM with a job running quits without a question', async () => {
    for (const front of ['0', '1']) {
      const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_FRONT: front } });
      const r = await until(() => record(), 20_000, 'ui.json');
      await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
      const t0 = Date.now();
      for (let i = 0; i < 3; i++) await writeJob(ws, 'failed');
      const notes = () => a.err().split('\n').filter((l) => l.includes('(test mode) notification'));
      // Review B L3: polled for (the summary comes 5–6 s after the first post), then no more within a second.
      await until(() => notes().length >= (front === '0' ? 2 : 3), 10_000, 'the notifications');
      if (front === '0') timings.notifications_window_ms = Date.now() - t0;
      await sleep(1000);
      if (front === '0') {
        expect(notes()).toEqual([
          'demo-studio-desktop: (test mode) notification: Render failed — northfield-fixture · quote',
          'demo-studio-desktop: (test mode) notification: 2 jobs ended — 2 failed / northfield-fixture · quote',
        ]);
      } else {
        expect(notes()).toEqual(Array(3).fill('demo-studio-desktop: (test mode) notification dropped (window in front): 1'));
      }
      // SIGTERM with a job running: quits now, no question (signals never meet the guard).
      await writeJob(ws, 'running');
      await until(() => a.err().includes('pending: 1 job, 0 unsaved'), 10_000, 'the job in the snapshot');
      a.child.kill('SIGTERM');
      expect((await a.exit).code).toBe(0);
      expect(a.err()).toContain('quit: SIGTERM');
      expect(a.err()).not.toContain('(test mode) alert:');
      expectClean(a.err(), r.token);
      await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
    }
  }, 90_000);

  it('L5.2b: the real question (MODAL_MS): a second window while it is up, gone after; a second Quit meanwhile ignored (H2); no picker inside it (B L10); SIGTERM while it is up quits (M1)', async () => {
    const other = join(base, 'other-ws-l10');
    await mkdir(join(other, 'projects'), { recursive: true });
    const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_MODAL_MS: '3000', DEMO_STUDIO_DESKTOP_TEST_PICK: other } });
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(async () => (await counters(r)).streams >= 1, 20_000, 'the page');
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
    await writeJob(ws, 'running');
    await until(() => a.err().includes('pending: 1 job, 0 unsaved'), 10_000, 'the job in the snapshot');
    const pid = a.child.pid!;
    const locked = (await windowCount(pid)) < 0;
    if (!locked) expect(await windowCount(pid)).toBe(1);
    a.child.kill('SIGUSR2');
    // Review B L2: the second Quit only once the question is up (its line is printed with GUARD_OPEN set).
    await until(() => a.err().includes('(test mode) alert: Quit'), 5000, 'the question up');
    a.child.kill('SIGUSR2');
    await until(() => a.err().includes('(test mode) SIGUSR2 ignored: a question is open'), 5000, 'the second Quit ignored');
    // Review B L10: File › Open Workspace… meanwhile opens no picker inside the question.
    a.child.kill('SIGUSR1');
    await until(() => a.err().includes('Open Workspace…: another question is open — answer it first'), 5000, 'Open Workspace… refused');
    expect(a.err()).not.toContain('(test mode) folder picker:');
    if (!locked) {
      await until(async () => (await windowCount(pid)) === 2, 5000, 'the alert window');
      await screenshot(pid, 'desktop-quit-alert-job', true);
    }
    await until(() => a.err().includes('(test mode) alert closed: no button (stopped or aborted)'), 10_000, 'the alert aborted');
    await until(() => a.err().includes('quit cancelled: the app stays open'), 5000, 'Cancel');
    if (!locked) await until(async () => (await windowCount(pid)) === 1, 5000, 'the alert gone');
    expect(count(a.err(), '(test mode) alert: Quit')).toBe(1);
    // Jobs only: Quit Anyway takes Return (nothing is lost), Cancel Escape.
    expect(a.err()).toContain('(test mode) alert keys: Quit Anyway=return, Cancel=escape');
    expect(a.child.exitCode).toBe(null);
    // Unsaved text too, then SIGTERM while the question is up: the app quits now, the server stopped gracefully.
    expect(await report(r, { tab: TAB, hidden: true, items: [{ kind: 'readme', project: 'northfield-fixture' }] })).toBe(200);
    await until(() => a.err().includes('pending: 1 job, 1 unsaved'), 10_000, 'the unsaved text in the snapshot');
    a.child.kill('SIGUSR2');
    await until(() => count(a.err(), '(test mode) alert: Quit') === 2, 5000, 'the second question');
    if (!locked) {
      await until(async () => (await windowCount(pid)) === 2, 5000, 'the alert window');
      await screenshot(pid, 'desktop-quit-alert-unsaved', true);
    }
    // Unsaved text: Return never quits (critique M3) — Quit Anyway has no key; Cancel comes first and takes Escape
    // (review B L4: AppKit gives a button titled Cancel Escape, even the first; Return then does nothing).
    const keys = a.err().split('\n').filter((l) => l.includes('(test mode) alert keys:'));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(/alert keys: Cancel=escape, Quit Anyway=none$/);
    const t0 = Date.now();
    a.child.kill('SIGTERM');
    expect((await a.exit).code).toBe(0);
    timings.sigterm_during_question_ms = Date.now() - t0;
    expect(timings.sigterm_during_question_ms).toBeLessThan(3000);
    expect(a.err()).toContain('quit: SIGTERM');
    expect(a.err()).toContain('studio: stopped: SIGTERM');
    await until(() => !alive(r.pid) && !existsSync(uiJson()), 5000, 'the server stopped');
    if (locked) shots.quit_alert = 'skipped: the screen is locked (window counts not checked)';
    expectClean(a.err(), r.token);
    await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
  }, 90_000);

  it('L5.2b: the owned server dies with unsaved text in the window — the restart alert names it, Not Now (its default) keeps the window, Quit then asks about the text only (its jobs are history)', async () => {
    const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_ANSWERS: '0' } });
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
    await writeJob(ws, 'running');
    expect(await report(r, { tab: TAB, hidden: true, items: [{ kind: 'readme', project: 'northfield-fixture' }] })).toBe(200);
    await until(() => a.err().includes('pending: 1 job, 1 unsaved'), 10_000, 'the snapshot');
    process.kill(r.pid, 'SIGKILL');
    await until(() => a.err().includes('not now: the window stays as it is'), 10_000, 'the restart alert answered Not Now (ANSWERS 0)');
    expect(a.err()).toMatch(/\(test mode\) alert: The Studio server stopped — It exited \(signal: 9/);
    expect(a.err()).toContain('Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved; Restart or Quit loses what this window holds:\n• README.md of northfield-fixture\n\nCopy it first: Not Now keeps the window as it is.');
    // Review B M4: Not Now takes Return; Restart and Quit, which lose the text, have no key.
    expect(a.err()).toContain('(test mode) alert keys: Not Now=return, Restart=none, Quit=none');
    await sleep(500);
    expect(a.child.exitCode).toBe(null);
    a.child.kill('SIGUSR2');
    await until(() => a.err().includes('quit cancelled: the app stays open'), 10_000, 'the quit question');
    const q = a.err().slice(a.err().lastIndexOf('(test mode) alert: Quit Demo Studio?'));
    expect(q).toContain('Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved:\n• README.md of northfield-fixture');
    expect(q.split('quit cancelled')[0]).not.toContain('jobs keep running');
    a.child.kill('SIGTERM');
    expect((await a.exit).code).toBe(0);
    expect(a.err()).toContain(`the Studio server (pid ${r.pid}) had already exited`);
    expectClean(a.err(), r.token);
    await rm(uiJson(), { force: true });
    await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
  }, 60_000);

  it('review B M5: Open Anyway and Quit Anyway end to end — the owned server stopped gracefully, the picked workspace served, the app exits 0, the jobs left running', async () => {
    const other = join(base, 'other-ws-m5');
    await mkdir(join(other, 'projects'), { recursive: true });
    const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_PICK: other, DEMO_STUDIO_DESKTOP_TEST_ANSWERS: '0,0' } });
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
    const job = await writeJob(ws, 'running');
    await until(() => a.err().includes('pending: 1 job, 0 unsaved'), 10_000, 'the job in the snapshot');
    // File › Open Workspace…: Open Anyway (ANSWERS 0) — the owned server stops, the picked workspace gets a server.
    a.child.kill('SIGUSR1');
    await until(() => a.err().includes('Open Workspace…: the owned server stops, the picked workspace opens'), 10_000, 'Open Anyway');
    expect(a.err()).toContain('(test mode) alert keys: Open Anyway=return, Cancel=escape');
    await until(() => !alive(r.pid) && !existsSync(uiJson()), 10_000, 'the first server stopped');
    expect(a.err()).toMatch(new RegExp(`stopped the Studio server \\(pid ${r.pid}, another workspace opened\\): exit status: 0`));
    const r2 = await until(() => record(other), 20_000, 'the picked workspace served');
    expect(r2.pid).not.toBe(r.pid);
    expect(JSON.parse(await readFile(join(ws, '.demo-studio', 'jobs', job, 'job.json'), 'utf8')).state).toBe('running');
    // A job there, then Quit: Quit Anyway (ANSWERS 0) — the app exits 0, its server stopped gracefully, the job runs on.
    await until(() => count(a.err(), 'pending: 0 jobs, 0 unsaved') >= 2, 20_000, 'the new server\'s first snapshot');
    const job2 = await writeJob(other, 'running');
    await until(() => count(a.err(), 'pending: 1 job, 0 unsaved') >= 2, 10_000, 'the job in the new snapshot');
    const t0 = Date.now();
    a.child.kill('SIGUSR2');
    expect(await a.exit).toEqual({ code: 0, signal: null });
    timings.quit_anyway_ms = Date.now() - t0;
    expect(a.err()).toContain('(test mode) alert: Quit Demo Studio? — These jobs keep running after the app quits, but it will not tell you when they end:\n• Render (running)');
    expect(a.err()).toContain('quit: Quit Anyway');
    await until(() => !alive(r2.pid) && !existsSync(uiJson(other)), 5000, 'the second server stopped');
    expect(a.err()).toMatch(new RegExp(`stopped the Studio server \\(pid ${r2.pid}, quit\\): exit status: 0`));
    expect(JSON.parse(await readFile(join(other, '.demo-studio', 'jobs', job2, 'job.json'), 'utf8')).state).toBe('running');
    expectClean(a.err(), r.token);
    expectClean(a.err(), r2.token);
    await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }, 90_000);

  it('review B M1 / L13: SIGTERM ends every question of the shell — Open Workspace…, "not a workspace", the restart alert (each up for real) — well before its abort; a Quit during the restart alert is never a nested question', async () => {
    const notWs = join(base, 'not-a-workspace-m1');
    const other = join(base, 'other-ws-m1');
    await mkdir(notWs, { recursive: true });
    await mkdir(join(other, 'projects'), { recursive: true });
    const ABORT_MS = '20000';
    for (const kind of ['open', 'not-a-workspace', 'restart'] as const) {
      const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_MODAL_MS: ABORT_MS, DEMO_STUDIO_DESKTOP_TEST_PICK: kind === 'open' ? other : notWs } });
      const r = await until(() => record(), 20_000, 'ui.json');
      await until(() => a.err().includes('pending: 0 jobs, 0 unsaved'), 20_000, 'the first pending snapshot');
      if (kind === 'open') {
        await writeJob(ws, 'running');
        await until(() => a.err().includes('pending: 1 job, 0 unsaved'), 10_000, 'the job in the snapshot');
        a.child.kill('SIGUSR1');
        await until(() => a.err().includes('(test mode) alert: Open another workspace?'), 10_000, 'the Open Workspace… question');
      } else if (kind === 'not-a-workspace') {
        a.child.kill('SIGUSR1');
        await until(() => a.err().includes('(test mode) alert: Not a Demo Studio workspace'), 10_000, 'the "not a workspace" alert');
      } else {
        expect(await report(r, { tab: TAB, hidden: true, items: [{ kind: 'readme', project: 'northfield-fixture' }] })).toBe(200);
        await until(() => a.err().includes('pending: 0 jobs, 1 unsaved'), 10_000, 'the unsaved text in the snapshot');
        process.kill(r.pid, 'SIGKILL');
        await until(() => a.err().includes('(test mode) alert: The Studio server stopped'), 10_000, 'the restart alert');
        // L13: a Quit (terminate:) while the restart alert — a modal of a Tauri callback — is up: never a question.
        await sleep(300);
        a.child.kill('SIGUSR2');
        await sleep(1500);
        expect(count(a.err(), '(test mode) alert: Quit')).toBe(0);
        expect(a.child.exitCode).toBe(null);
        timings.l13_quit_during_restart_alert = a.err().includes('quit: another question is open — answer it first') ? 1 : 0;
      }
      await sleep(300);
      const t0 = Date.now();
      a.child.kill('SIGTERM');
      expect(await a.exit).toEqual({ code: 0, signal: null });
      timings[`sigterm_during_${kind}_ms`] = Date.now() - t0;
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(a.err()).toContain('quit: ending the open question');
      // Ended by the signal (the test's own abort comes after 20 s).
      expect(a.err()).toContain('(test mode) alert closed: no button (stopped or aborted)');
      expect(a.err()).not.toMatch(/Open Workspace…: the owned server stops|not now: the window stays|back to /);
      if (kind !== 'restart') {
        await until(() => !alive(r.pid) && !existsSync(uiJson()), 5000, 'the server stopped');
        expect(a.err()).toMatch(new RegExp(`stopped the Studio server \\(pid ${r.pid}, quit\\)`));
      } else {
        // No restart: no server started after the alert.
        expect(count(a.err(), 'the Studio server serves')).toBe(1);
        await rm(uiJson(), { force: true });
      }
      expect(existsSync(uiJson(other))).toBe(false);
      expectClean(a.err(), r.token);
      await rm(join(ws, '.demo-studio', 'jobs'), { recursive: true, force: true });
    }
  }, 120_000);

  it('File › Open Workspace…: a folder that is no workspace changes nothing; a workspace that fails to start reopens the previous one — never a quit', async () => {
    const notWs = join(base, 'not-a-workspace');
    const badWs = join(base, 'bad-workspace');
    await mkdir(notWs, { recursive: true });
    await mkdir(badWs, { recursive: true });
    // A workspace by the CLI's rule whose server refuses to start (a newer studio.yaml version: exit 1).
    await writeFile(join(badWs, 'studio.yaml'), 'version: 99\n');
    const a = launch([], { env: { DEMO_STUDIO_DESKTOP_TEST_PICK: `${notWs}:${badWs}` } });
    const r = await until(() => record(), 20_000, 'ui.json');
    await until(async () => (await counters(r)).streams >= 1, 20_000, 'the page');
    a.child.kill('SIGUSR1');
    await until(() => a.err().includes('is not a workspace: the current one stays open'), 10_000, 'the refusal');
    await sleep(1000);
    expect(a.child.exitCode).toBe(null);
    expect(alive(r.pid)).toBe(true);
    expect((await record())?.pid).toBe(r.pid);
    expect((await counters(r)).streams).toBeGreaterThanOrEqual(1);
    expect(a.err()).not.toContain('stopped the Studio server');
    // The second pick: the old server stops, the new one fails, the previous workspace opens again (a new server, the
    // page live on it), and the app runs on.
    a.child.kill('SIGUSR1');
    await until(() => a.err().includes(`back to ${ws}`) || a.err().includes('back to /private' + ws), 20_000, 'the previous workspace again');
    const r2 = await until(async () => {
      const x = await record();
      return x && x.pid !== r.pid ? x : undefined;
    }, 20_000, 'a new server for the previous workspace');
    await until(async () => (await counters(r2)).streams >= 1, 20_000, 'the page on the new server');
    expect(a.err()).toContain(`stopped the Studio server (pid ${r.pid}, another workspace opened)`);
    expect(a.err()).toContain('The Studio could not start');
    expect(a.child.exitCode).toBe(null);
    a.child.kill('SIGTERM');
    expect((await a.exit).code).toBe(0);
    await until(() => !alive(r2.pid) && !existsSync(uiJson()), 5000, 'the server stopped');
    expectClean(a.err(), r.token);
    expectClean(a.err(), r2.token);
  }, 90_000);

  it('a hostile page: no request reaches a foreign port, no download lands, no IPC, no capture device; the child has no NODE_OPTIONS', async () => {
    // A copy of the app whose launch.json runs the fake CLI (a release build reads no DEMO_STUDIO_NODE / _CLI).
    const dir = join(base, 'hostile');
    await mkdir(dir, { recursive: true });
    hostileApp = join(dir, 'Hostile.app');
    execFileSync('cp', ['-R', app, hostileApp]);
    const fake = join(dir, 'fake-cli.mjs');
    await writeFile(fake, hostileCli(TOKEN));
    await writeFile(join(hostileApp, 'Contents', 'Resources', 'launch.json'), `${JSON.stringify({ version: 1, node: process.execPath, cli: fake })}\n`);
    const downloadsBefore = tokenDownloads();
    const t0 = Date.now();
    const a = launch([], { bin: join(hostileApp, 'Contents', 'MacOS', BIN_NAME), env: { NODE_OPTIONS: '--no-deprecation' } });
    try {
      await hostileRun(a, dir, t0, downloadsBefore);
    } finally {
      if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL');
      spawnSync(LSREGISTER, ['-u', hostileApp], { stdio: 'ignore' });
    }
  }, 90_000);

  async function hostileRun(a: App, dir: string, t0: number, downloadsBefore: string[] | undefined): Promise<void> {
    const logText = () => (existsSync(join(dir, 'log.txt')) ? readFileSync(join(dir, 'log.txt'), 'utf8') : '');
    // Done: the page's last report — or the page gone to the foreign port (then the assertions below say so).
    await until(() => /main\.done|\nFOREIGN GET \/top/.test(logText()), 30_000, 'the hostile page to finish');
    await sleep(1500);
    timings.hostile_ms = Date.now() - t0;
    a.child.kill('SIGTERM');
    expect((await a.exit).code).toBe(0);
    const log = logText();
    const reports = [...log.matchAll(/POST \/report\?k=([^&]+)&v=(\S*)/g)].map((m) => `${decodeURIComponent(m[1])}=${decodeURIComponent(m[2])}`);
    const err = a.err();
    // The page ran, in the app (the fake saw the window's requests).
    expect(log).toContain('studio GET /');
    expect(log).toContain('player GET /frame');
    // M2: not one request on the foreign port, whatever the route.
    expect(log.split('\n').filter((l) => l.startsWith('FOREIGN')), log).toEqual([]);
    const port = (JSON.parse(/ports (\{.*\})/.exec(log)![1]) as { FOREIGN: number }).FOREIGN;
    for (const refused of [`http://127.0.0.1:${port}`, 'data:', 'blob:http://127.0.0.1:', 'x-studio-probe:']) expect(err, refused).toContain(`refused a navigation to ${refused}`);
    expect(reports.filter((x) => /^msg=(data|blob)-ran/.test(x)), reports.join('\n')).toEqual([]);
    expect(reports).toContain('main.open=null');
    expect(reports).toContain('p.open=null');
    expect(reports).toContain('main.done=still here');
    // M1: the link and the attachment frame reached the server; nothing landed; both downloads were cancelled.
    expect(log).toContain(`studio GET /${TOKEN}-link.bin`);
    expect(log).toContain(`studio GET /${TOKEN}-frame.bin`);
    await sleep(500);
    const downloadsAfter = tokenDownloads();
    if (downloadsBefore === undefined || downloadsAfter === undefined) shots.downloads = 'unverified: ~/Downloads could not be listed';
    else expect(downloadsAfter, 'a download landed in ~/Downloads').toEqual([]);
    expect(err.match(/refused a download of http:\/\/127\.0\.0\.1:\d+/g)?.length ?? 0, err).toBeGreaterThanOrEqual(2);
    // No IPC: every invoke refused in the page, the player frame's message dropped, ipc:// not served.
    const invokes = reports.filter((x) => x.startsWith('invoke='));
    expect(invokes).toHaveLength(5);
    for (const i of invokes) expect(i).toMatch(/^invoke=refused .*not allowed/);
    expect(reports).toContain('p.internals=undefined');
    expect(err).toMatch(/refused 1 IPC message\(s\) from a page frame/);
    expect(reports.find((x) => x.startsWith('p.ipc='))).not.toBe('p.ipc=status 200');
    // L2: no capture device, nothing granted.
    expect(reports.filter((x) => /gum=/.test(x))).toEqual(expect.arrayContaining(['main.gum=no mediaDevices', 'p.gum=no mediaDevices']));
    expect(reports.join('\n')).not.toContain('GRANTED');
    // L4: the release build dropped NODE_OPTIONS from the child's environment.
    expect(log).toContain('env NODE_OPTIONS absent');
    expectClean(err, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456');
  }

  it.skipIf(!SLOW)('acceptance (DEMO_STUDIO_TEST_SLOW=1): a fixture capture on its timeline — the player served the frame its media (bytes counted)', async () => {
    type Fixture = { urls: { console: string; shop: string }; close(): Promise<void> };
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    const fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    const root = join(base, 'ws-capture');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'studio.yaml'), `version: 1\nprojects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
      const project = join(root, 'projects', 'northfield-fixture');
      const src = join(REPO, 'projects', 'northfield-fixture');
      const skip = new Set(['runs', 'renders', 'review', 'exports', '.demo-studio', 'frames', 'comments']);
      await cp(src, project, { recursive: true, filter: (s) => !skip.has(s.slice(src.length + 1).split('/')[0]) });
      const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
      await writeFile(join(project, 'project.yaml'), yaml.replaceAll('http://localhost:4401', fixture.urls.console).replaceAll('http://localhost:4402', fixture.urls.shop));
      await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
      const t0 = Date.now();
      // Asynchronous: the fixture answers from this process.
      const cap = spawn(process.execPath, [CLI, '--root', root, 'run', 'northfield-fixture', 'reports'], { env: { ...process.env, DEMO_STUDIO_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
      launched.push(cap);
      let capErr = '';
      cap.stderr!.on('data', (c: Buffer) => (capErr += c.toString('utf8')));
      const capCode = await new Promise<number | null>((r) => cap.on('exit', (code) => r(code)));
      expect(capCode, capErr).toBe(0);
      timings.capture_ms = Date.now() - t0;
      const t1 = Date.now();
      const child = spawn(binary, ['--root', root, '--route', '#/p/northfield-fixture/s/reports/timeline'], {
        env: { ...process.env, DEMO_STUDIO_HOME: home, DEMO_STUDIO_ROOT: '', DEMO_STUDIO_DESKTOP_TEST: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      launched.push(child);
      let out = '';
      child.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      const r = await until(() => record(root), 20_000, 'ui.json');
      const c = await until(async () => {
        const x = await counters(r);
        // WKWebView may fetch a short capture whole (no Range request): bytes read for its requests are the proof, ranges are noted.
        return x.player_media_bytes_read > 0 ? x : undefined;
      }, 45_000, 'the player serving media to the frame');
      timings.timeline_media_ms = Date.now() - t1;
      expect(out).toContain('route set');
      // Let the Player paint a few frames, then keep the picture for a person to look at.
      await sleep(4000);
      await screenshot(child.pid!, 'desktop-timeline');
      timings.media_bytes = c.player_media_bytes_read;
      timings.range_requests = c.player_range_requests;
      child.kill('SIGTERM');
      await until(() => child.exitCode !== null && !existsSync(uiJson(root)), 8000, 'the app quit');
      expectClean(out, r.token);
    } finally {
      await fixture.close();
    }
  }, 360_000);

  it('left nothing in ~/Library (ephemeral WebKit store) and, once unregistered, no Launch Services record', async () => {
    expect(libraryBefore).toEqual([]);
    expect(libraryEntries()).toEqual([]);
    timings.ls_records_while_built = Number(lsRecords());
    spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
    expect(lsRecords()).toBe(lsBefore);
    for (const o of outputs) expect(o).not.toMatch(/panicked|\[\d+m/);
  });
});
