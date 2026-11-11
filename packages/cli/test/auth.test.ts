/**
 * Sessions & personas from the command line (L1.6): `retake login --auto`, `retake auth status [--check]`, runs on the
 * saved sessions, the preflight message as printed, js hooks signed in as their page's persona, and the onboarding of
 * `retake new` on a (scripted) terminal — against the bundled fixture's signed-in side on free ports. The Retake home is
 * a temp folder (RETAKE_HOME): nothing touches ~/.retake; passwords come from env variables set here.
 * Skipped when Chromium is not available.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personaPaths } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { PreflightError, LoginPageError } from '@retake/runner-web';
import { EXIT, main, memoryIo } from '../src/index.js';
import { isKnownError } from '../src/errors.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(REPO, 'packages/cli/dist/bin.js');
const PROJECT = 'northfield-test';
const LONG = 120_000;

function chromiumAvailable(): boolean {
  if (process.env.RETAKE_CHROMIUM) return existsSync(process.env.RETAKE_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

interface Fixture {
  urls: { console: string; shop: string; signedIn: { console: string; shop: string } };
  expireSessions(persona?: string): number;
  close(): Promise<void>;
}

let fx: Fixture;
let ws = '';
let home = '';
let accounts: Record<'supplier' | 'buyer', { email: string; password: string; name: string }>;

async function retake(args: string[], io = memoryIo()) {
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr(), io };
}

const files = (persona: string) => personaPaths(home, PROJECT, 'signed-in', persona);

/** The passwords the login steps read ({{env:…}}), set only while `fn` runs. */
async function withPasswords<T>(fn: () => Promise<T>): Promise<T> {
  process.env.NF_TEST_SUPPLIER = accounts.supplier.password;
  process.env.NF_TEST_BUYER = accounts.buyer.password;
  try {
    return await fn();
  } finally {
    delete process.env.NF_TEST_SUPPLIER;
    delete process.env.NF_TEST_BUYER;
  }
}

const login = (persona: 'supplier' | 'buyer', page: string) => [
  `          - open: "${page}:/sign-in"`,
  `          - type: {into: {label: Email}, text: ${accounts[persona].email}}`,
  `          - type: {into: {label: Password}, text: "{{env:NF_TEST_${persona.toUpperCase()}}}"}`,
  '          - click: {role: button, name: Sign in}',
  `          - wait_for: {text: ${accounts[persona].name}}`,
];

describe.skipIf(!chromiumAvailable())('sessions & personas on the command line (fixture, signed-in side)', () => {
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'studio-auth-home-'));
    process.env.RETAKE_HOME = home;
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: object): Promise<Fixture>;
    };
    fx = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
    accounts = ((await import(join(REPO, 'fixtures/wholesale/server/auth.mjs'))) as { ACCOUNTS: typeof accounts }).ACCOUNTS;
    ws = await mkdtemp(join(tmpdir(), 'studio-auth-'));
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const dir = join(ws, 'projects', PROJECT);
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'project.yaml'),
      [
        'name: Northfield test',
        'environments:',
        `  local: {console: "${fx.urls.console}", shop: "${fx.urls.shop}"}`,
        `  signed-in: {console: "${fx.urls.signedIn.console}", shop: "${fx.urls.signedIn.shop}"}`,
        `  manual: {console: "${fx.urls.signedIn.console}"}`,
        `  legacy: {console: "${fx.urls.signedIn.console}"}`,
        'default_env: local',
        'auth:',
        '  signed-in:',
        '    login_url: /sign-in',
        '    personas:',
        '      supplier:',
        '        pages: [console]',
        `        check: {url: "console:/products", expect_text: ${accounts.supplier.name}}`,
        '        login:',
        ...login('supplier', 'console'),
        '      buyer:',
        '        pages: [shop]',
        `        check: {url: "shop:/", expect_text: ${accounts.buyer.name}}`,
        '        login:',
        ...login('buyer', 'shop'),
        '  manual:',
        '    login_url: /sign-in',
        '    personas:',
        `      viewer: {pages: [console], check: {url: "console:/products", expect_text: ${accounts.supplier.name}}}`,
        `  legacy: {profile: ${JSON.stringify(join(home, 'legacy-profile'))}}`,
        'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
        'template: default',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'scenarios', 'both.yaml'),
      [
        'video: both',
        'pacing: {scene_start_still: 0.1, settle_ms: 300}',
        'scenes:',
        '  - id: console',
        '    page: console',
        '    open: /products',
        `    steps: [{assert: {text: ${accounts.supplier.name}}}]`,
        '  - id: shop',
        '    page: shop',
        '    open: /',
        `    steps: [{assert: {text: ${accounts.buyer.name}}}]`,
        '',
      ].join('\n'),
    );
    // Films the console signed out (`persona: none`): its js hook runs signed out too.
    await writeFile(
      join(dir, 'scenarios', 'guest.yaml'),
      [
        'video: guest',
        'setup:',
        '  - name: where',
        '    js: {page: console, code: "return location.pathname"}',
        'scenes:',
        '  - id: a',
        '    page: console',
        '    persona: none',
        '    open: /sign-in',
        '    steps: [{wait: 0.1}]',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'hooks', 'whoami.yaml'),
      [
        '- name: whoami',
        '  js:',
        '    page: console',
        '    code: |',
        `      for (let i = 0; i < 80 && !document.body.innerText.includes(${JSON.stringify(accounts.supplier.name)}); i++) await new Promise((r) => setTimeout(r, 100));`,
        `      if (!document.body.innerText.includes(${JSON.stringify(accounts.supplier.name)})) throw new Error('not signed in');`,
        "      return 'signed in'",
        '',
      ].join('\n'),
    );
  }, LONG);

  afterAll(async () => {
    await fx?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('retake login --auto signs each persona in; auth status lists them; a run uses the saved sessions (no login step)', async () => {
    const before = await retake(['auth', 'status', '--project', PROJECT, '--env', 'signed-in']);
    expect(before.code).toBe(EXIT.ok);
    expect(before.out).toContain(`${PROJECT} · env signed-in\n  supplier  never     never signed in\n            → sign in once: retake -C ${ws} login ${PROJECT} --env signed-in --persona supplier`);
    for (const persona of ['supplier', 'buyer'] as const) {
      const r = await withPasswords(() => retake(['login', PROJECT, '--env', 'signed-in', '--persona', persona, '--auto']));
      expect(r.code, r.err).toBe(EXIT.ok);
      const page = persona === 'supplier' ? 'console:/products' : 'shop:/';
      expect(r.err).toContain(`✓ ${persona} (env signed-in) signed in: ${page} shows "${accounts[persona].name}" — runs use a copy of this session`);
      expect(statSync(files(persona).snapshot).mode & 0o777).toBe(0o600);
      expect(statSync(files(persona).profileDir).mode & 0o777).toBe(0o700);
      expect(await readFile(files(persona).snapshot, 'utf8')).not.toContain(accounts[persona].password);
    }
    const status = await retake(['auth', 'status', '--json']);
    const list = (JSON.parse(status.out) as { personas: Array<{ project: string; env: string; persona: string; status: string; by?: string }> }).personas;
    expect(list.map((p) => `${p.env}/${p.persona}: ${p.status}${p.by ? ` (${p.by})` : ''}`)).toEqual([
      'signed-in/supplier: valid (login)',
      'signed-in/buyer: valid (login)',
      'manual/viewer: never',
      'legacy/default: never',
    ]);
    // No password in the environment: the run can only be signed in through the saved sessions.
    const run = await retake(['run', PROJECT, 'both', '--env', 'signed-in', '--dry']);
    expect(run.code, run.err).toBe(EXIT.ok);
    expect(run.err).not.toContain('signed in automatically');
    const text = await retake(['auth', 'status', '--project', PROJECT]);
    expect(text.out).toMatch(/ {2}supplier {2}valid {5}checked (just now|\d+ s ago) \(preflight of run \d{8}-\d{6}-both\)/);
  }, LONG);

  it('an expired session: the stored status until --check; the run stops with the exact command, its lines aligned; with the passwords it signs in', async () => {
    fx.expireSessions('buyer');
    const stored = await retake(['auth', 'status', '--project', PROJECT, '--env', 'signed-in']);
    expect(stored.out).toMatch(/ {2}buyer {5}valid/);
    const checked = await retake(['auth', 'status', '--project', PROJECT, '--env', 'signed-in', '--check']);
    expect(checked.code).toBe(EXIT.failure);
    expect(checked.out).toMatch(/ {2}supplier {2}valid {5}checked just now \(auth status --check\)\n/);
    expect(checked.out).toContain(
      `  buyer     expired   checked just now (auth status --check): shop:/ landed on the sign-in page (${fx.urls.signedIn.shop}/sign-in)\n` +
        `            → sign in again: retake -C ${ws} login ${PROJECT} --env signed-in --persona buyer\n`,
    );
    const run = await retake(['run', PROJECT, 'both', '--env', 'signed-in', '--dry']);
    expect(run.code).toBe(EXIT.failure);
    const pad = ' '.repeat(12);
    expect(run.err).toContain(
      [
        '  error     session preflight failed — nothing was recorded:',
        `${pad}  persona buyer (env signed-in): expired — shop:/ landed on the sign-in page (${fx.urls.signedIn.shop}/sign-in); its automated login cannot run: environment variable NF_TEST_BUYER is not set`,
        `${pad}    sign in again: retake -C ${ws} login ${PROJECT} --env signed-in --persona buyer`,
      ].join('\n'),
    );
    const auto = await withPasswords(() => retake(['run', PROJECT, 'both', '--env', 'signed-in', '--dry']));
    expect(auto.code, auto.err).toBe(EXIT.ok);
    expect(auto.err).toContain('! persona buyer (env signed-in): signed in automatically, off camera');
    // The saved session is still expired (nothing is written back from a run).
    expect((await retake(['auth', 'status', '--project', PROJECT, '--env', 'signed-in'])).out).toMatch(/ {2}buyer {5}expired/);
  }, LONG);

  it("js hooks run signed in as their page's persona; a hook tab landing on the sign-in page fails with the command", async () => {
    const ok = await withPasswords(() => retake(['login', PROJECT, '--env', 'signed-in', '--persona', 'supplier', '--auto']));
    expect(ok.code, ok.err).toBe(EXIT.ok);
    const hook = await retake(['hooks', 'run', PROJECT, 'hooks/whoami.yaml', '--env', 'signed-in']);
    expect(hook.code, hook.err).toBe(EXIT.ok);
    expect(hook.err).toMatch(/✓ whoami/);
    fx.expireSessions('supplier');
    const out = await retake(['hooks', 'run', PROJECT, 'hooks/whoami.yaml', '--env', 'signed-in']);
    expect(out.code).toBe(EXIT.failure);
    expect(out.err).toContain(`js hook page "console" (persona supplier) landed on the sign-in page (${fx.urls.signedIn.console}/sign-in): its session expired — sign in again: retake -C ${ws} login ${PROJECT} --env signed-in --persona supplier`);
    // A scenario's hooks bind their tabs as its run does: the console filmed `persona: none` → the hook runs signed out.
    const guest = await retake(['hooks', 'run', PROJECT, 'guest:setup', '--env', 'signed-in']);
    expect(guest.code, guest.err).toBe(EXIT.ok);
    expect(guest.err).toMatch(/✓ where: .* returned "\/sign-in"/);
  }, LONG);

  it('login: the persona to pick, --auto without login steps, an environment without personas, a master in use', async () => {
    const pick = await retake(['login', PROJECT, '--env', 'signed-in']);
    expect(pick.code).toBe(EXIT.usage);
    expect(pick.err).toContain('environment "signed-in" has 2 personas: pick one with --persona supplier | buyer');
    const manual = await retake(['login', PROJECT, '--env', 'manual', '--persona', 'viewer', '--auto']);
    expect(manual.code).toBe(EXIT.failure);
    expect(manual.err).toContain('persona "viewer" declares no login steps (auth.personas.viewer.login): sign in by hand — leave --auto out');
    const local = await retake(['login', PROJECT]);
    expect(local.code).toBe(EXIT.failure);
    expect(local.err).toContain(`environment "local" of ${PROJECT} has no personas: pick an environment that has some with --env (signed-in, manual, legacy)`);
    // The single-account form (auth.profile) keeps its window on that profile: no --auto, no other persona.
    const legacyAuto = await retake(['login', PROJECT, '--env', 'legacy', '--auto']);
    expect(legacyAuto.code).toBe(EXIT.usage);
    expect(legacyAuto.err).toContain("--auto runs a persona's login steps");
    expect((await retake(['login', PROJECT, '--env', 'legacy', '--persona', 'supplier'])).code).toBe(EXIT.usage);
    // A master held by a browser (a plain lock file stands for a live one): refused, and listed as in use.
    const lock = join(files('supplier').profileDir, 'SingletonLock');
    await writeFile(lock, '');
    try {
      const busy = await withPasswords(() => retake(['login', PROJECT, '--env', 'signed-in', '--persona', 'supplier', '--auto']));
      expect(busy.code).toBe(EXIT.failure);
      expect(busy.err).toContain('the profile of persona supplier (env signed-in) is open in another browser');
      expect((await retake(['auth', 'status', '--project', PROJECT, '--env', 'signed-in'])).out).toMatch(/ {2}supplier .* · in use by a browser/);
    } finally {
      await rm(lock, { force: true });
    }
  }, LONG);

  it('retake new on a terminal asks for environments and personas and offers to sign each one in (R-AUTH-08)', async () => {
    const io = memoryIo({
      answers: [
        'personas', // refused: a word of `auth`
        'staging',
        'app https://app.staging.example.com', // refused: not key:url
        'app:https://app.staging.example.com,admin:https://admin.staging.example.com',
        '', // no other environment
        'y', // staging needs a sign-in
        '/login',
        'editor',
        '', // pages: the default (app)
        'Jane Example',
        'reviewer',
        'app', // refused: app is the editor's
        'admin',
        '', // no signed-in text
        '', // no other persona
        'n', // sign editor in now? later
        'n',
      ],
    });
    const r = await retake(['new', 'acme-demo'], io);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(io.questions()).toEqual([
      '  Environment name (e.g. staging; empty to skip)',
      '  Environment name (e.g. staging; empty to skip)',
      '  Pages of staging (e.g. app:https://app.staging.example.com)',
      '  Pages of staging (e.g. app:https://app.staging.example.com)',
      '  Another environment (empty to finish)',
      '  Does staging need a sign-in?',
      '  Its sign-in page (a path such as /login; empty if you do not know)',
      '  Persona name (the account, e.g. admin; empty to skip)',
      '  Pages editor is signed into (app, admin)',
      '  A text only visible when editor is signed in (the account name…; empty to skip)',
      '  Another persona (empty to finish)',
      '  Pages reviewer is signed into (app, admin)',
      '  Pages reviewer is signed into (app, admin)',
      '  A text only visible when reviewer is signed in (the account name…; empty to skip)',
      '  Another persona (empty to finish)',
      'Sign editor in on staging now? A browser window opens',
      'Sign reviewer in on staging now? A browser window opens',
    ]);
    expect(r.err).toContain('"personas" is a word of `auth`: pick another name');
    expect(r.err).toContain('"app https://app.staging.example.com" is not key:url');
    expect(r.err).toContain('app is already signed in as editor: a page belongs to one persona');
    expect(r.err).toContain(`sign in later: retake -C ${ws} login acme-demo --env staging --persona editor`);
    expect((await loadProject('acme-demo', ws)).config.auth).toEqual({
      staging: {
        login_url: '/login',
        personas: {
          editor: { pages: ['app'], check: { url: 'app:/', expect_text: 'Jane Example' } },
          reviewer: { pages: ['admin'], check: { url: 'admin:/' } },
        },
      },
    });
    const valid = await retake(['validate', 'acme-demo']);
    expect(valid.code, valid.err).toBe(EXIT.ok);
    expect(valid.err).not.toMatch(/warning|error/);
    // Without a terminal (or with --env), nothing is asked: the personas form is a comment.
    const plain = await retake(['new', 'plain-demo', '--env', 'prod=app:https://app.example.com']);
    expect(plain.code).toBe(EXIT.ok);
    expect(await readFile(join(ws, 'projects', 'plain-demo', 'project.yaml'), 'utf8')).toContain('#   personas:');
  }, LONG);

  it('retake new: a persona when every page has one already (U1); the workspace browser for its sign-in (U2); no answer = later (U11)', async () => {
    const io = memoryIo({
      answers: [
        'prod',
        'app:http://127.0.0.1:9',
        '',
        'y',
        '',
        'admin',
        '', // app
        'Admin',
        'viewer',
        '', // every page has a persona: none
        '',
        '',
        'n', // admin later
      ],
    });
    // Out of answers at "Sign viewer in now?" (Ctrl-C at the question reads the same): later, and the next lines.
    const r = await retake(['new', 'edge-demo'], io);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(io.questions()).toContain('  Pages viewer is signed into (app; each has a persona already: empty for none)');
    expect(r.err).toContain('viewer films no page by default: a scene picks it with `persona: viewer`');
    expect(r.err).toContain(`sign in later: retake -C ${ws} login edge-demo --env prod --persona viewer`);
    expect(r.err).toContain('next: write scenarios/<name>.yaml');
    expect((await loadProject('edge-demo', ws)).config.auth).toEqual({
      prod: { personas: { admin: { pages: ['app'], check: { url: 'app:/', expect_text: 'Admin' } }, viewer: { check: { url: 'app:/' } } } },
    });
    expect((await retake(['validate', 'edge-demo'])).code).toBe(EXIT.ok);
    // A bad slug or an existing project is refused before the first question.
    const early = memoryIo({ answers: [] });
    expect((await retake(['new', 'edge-demo'], early)).code).toBe(EXIT.failure);
    expect(early.questions()).toEqual([]);
    expect(early.stderr()).toContain('project "edge-demo" already exists');
  }, LONG);

  it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)('retake new signs in with the browser of retake.yaml (U2)', async () => {
    const ws2 = await mkdtemp(join(tmpdir(), 'studio-auth-ws2-'));
    const before = process.env.RETAKE_CHROMIUM;
    // A browser that does not exist, in retake.yaml and in the environment: the error says which one was launched.
    await writeFile(join(ws2, 'retake.yaml'), `projects_dir: projects\nbrowser: {executable: ${JSON.stringify(join(ws2, 'no-such-browser-of-studio-yaml'))}}\n`);
    process.env.RETAKE_CHROMIUM = join(ws2, 'no-such-browser-of-the-environment');
    try {
      const io = memoryIo({ answers: ['prod', 'app:http://127.0.0.1:9', '', 'y', '', 'me', '', '', '', 'y'] });
      const code = await main(['node', 'retake', '--root', ws2, 'new', 'browser-demo'], io);
      expect(code, io.stderr()).toBe(EXIT.ok);
      expect(io.stderr()).toContain('no-such-browser-of-studio-yaml');
      expect(io.stderr()).not.toContain('no-such-browser-of-the-environment');
      expect(io.stderr()).toContain(`sign in later: retake -C ${ws2} login browser-demo --env prod --persona me`);
    } finally {
      if (before === undefined) delete process.env.RETAKE_CHROMIUM;
      else process.env.RETAKE_CHROMIUM = before;
      await rm(ws2, { recursive: true, force: true });
    }
  }, LONG);

  describe('a second project: an app that never answers, the older storage_state form', () => {
    const EDGE = 'northfield-edge';
    let hang: { url: string; hits: () => number; close(): Promise<void> };
    let tmp = '';
    const waiter = () => personaPaths(home, EDGE, 'slow', 'waiter');
    /** What a killed or interrupted command left in its temp folder (`TMPDIR`). */
    const copies = async () => (await readdir(tmp)).filter((n) => /^retake-(session|login)-/.test(n));
    /** The CLI as a process (its own TMPDIR), interrupted with SIGINT once the app got `hits` requests. */
    async function interrupted(args: string[], hits: number): Promise<{ code: number | null; err: string; copiesThen: string[] }> {
      const child = spawn(process.execPath, [BIN, '--root', ws, ...args], { env: { ...process.env, RETAKE_HOME: home, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.stdout.on('data', (d: Buffer) => (err += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      const deadline = Date.now() + 60_000;
      while (hang.hits() < hits && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const copiesThen = await copies();
      child.kill('SIGINT');
      return { code: await exited, err, copiesThen };
    }

    beforeAll(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'studio-auth-tmp-'));
      let n = 0;
      const server = createServer(() => void n++); // never answers
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      hang = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits: () => n,
        close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
      };
      const dir = join(ws, 'projects', EDGE);
      await mkdir(join(dir, 'scenarios'), { recursive: true });
      await mkdir(join(dir, 'hooks'), { recursive: true });
      await writeFile(
        join(dir, 'project.yaml'),
        [
          'name: Northfield edge',
          'environments:',
          `  slow: {app: "${hang.url}"}`,
          `  oldstate: {app: "${hang.url}"}`,
          'auth:',
          '  slow:',
          '    login_url: /sign-in',
          '    personas:',
          '      waiter:',
          '        pages: [app]',
          '        check: {url: "app:/", expect_text: Waiter}',
          '        login: [{open: "app:/sign-in"}, {wait_for: {text: Waiter}}]',
          `  oldstate: {storage_state: ${JSON.stringify(join(home, 'exported-state.json'))}}`,
          'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
          '',
        ].join('\n'),
      );
      await writeFile(join(dir, 'hooks', 'wait.yaml'), ['- name: wait', '  js: {page: app, code: "return 1"}', ''].join('\n'));
    }, LONG);

    afterAll(async () => {
      await hang?.close();
      await rm(join(ws, 'projects', EDGE), { recursive: true, force: true });
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32' || !existsSync(BIN))('Ctrl-C in retake login, auth status --check and js hooks (U4): the browser closes, no session copy is left, exit 130', async () => {
      // retake login --auto, interrupted while it checks the saved session: nothing saved, no profile left (a first login).
      const login = await interrupted(['login', EDGE, '--env', 'slow', '--auto'], 1);
      expect(login.code, login.err).toBe(EXIT.interrupted);
      expect(login.err).toContain('interrupted: closing the browser');
      expect(existsSync(waiter().profileDir)).toBe(false);
      expect(existsSync(waiter().snapshot)).toBe(false);
      expect(await copies()).toEqual([]);
      // A saved session (a master profile and a snapshot): auth status --check and a js hook run on a copy of it.
      await mkdir(waiter().profileDir, { recursive: true, mode: 0o700 });
      await writeFile(join(waiter().profileDir, 'Local State'), '{}');
      await mkdir(join(waiter().snapshot, '..'), { recursive: true, mode: 0o700 });
      await writeFile(waiter().snapshot, '{"cookies":[],"origins":[]}', { mode: 0o600 });
      const check = await interrupted(['auth', 'status', '--project', EDGE, '--env', 'slow', '--check'], hang.hits() + 1);
      expect(check.code, check.err).toBe(EXIT.interrupted);
      expect(check.copiesThen).toEqual([expect.stringMatching(/^retake-session-check-/)]);
      expect(await copies()).toEqual([]);
      expect(existsSync(waiter().statusFile)).toBe(false);
      const hook = await interrupted(['hooks', 'run', EDGE, 'hooks/wait.yaml', '--env', 'slow'], hang.hits() + 1);
      expect(hook.code, hook.err).toBe(EXIT.interrupted);
      expect(hook.copiesThen).toEqual([expect.stringMatching(/^retake-session-.*-waiter-/)]);
      expect(await copies()).toEqual([]);
    }, LONG);

    it('a profile a browser holds: --check says so without a stale check, the js hooks say why (U8, U9); the older storage_state form is exported again (U5)', async () => {
      await mkdir(waiter().profileDir, { recursive: true, mode: 0o700 });
      await writeFile(join(waiter().profileDir, 'Local State'), '{}');
      await writeFile(waiter().snapshot, '{"cookies":[],"origins":[]}', { mode: 0o600 });
      await mkdir(join(waiter().statusFile, '..'), { recursive: true });
      await writeFile(waiter().statusFile, JSON.stringify({ version: 1, status: 'expired', checked_at: new Date().toISOString(), by: 'preflight', run: '20261013-101010-x', at: `${hang.url}/sign-in`, detail: 'old' }));
      const lock = join(waiter().profileDir, 'SingletonLock');
      await writeFile(lock, ''); // a plain lock file stands for a live browser
      try {
        const text = await retake(['auth', 'status', '--project', EDGE, '--env', 'slow', '--check']);
        expect(text.code).toBe(EXIT.failure);
        expect(text.out).toContain(
          `  waiter  error     not checked · in use by a browser\n          → close that browser first, then check it now: retake -C ${ws} auth status --project ${EDGE} --check\n`,
        );
        const json = await retake(['auth', 'status', '--project', EDGE, '--env', 'slow', '--check', '--json']);
        const [state] = (JSON.parse(json.out) as { personas: Array<Record<string, unknown>> }).personas;
        expect(state).toMatchObject({ status: 'error', detail: 'not checked', in_use: {} });
        for (const k of ['checked_at', 'by', 'run', 'at']) expect(state).not.toHaveProperty(k);
        const hook = await retake(['hooks', 'run', EDGE, 'hooks/wait.yaml', '--env', 'slow']);
        expect(hook.code).toBe(EXIT.failure);
        expect(hook.err).toMatch(/✗ wait: .* js hooks cannot use the saved session of persona waiter: \S+ m?s\n {8}persona waiter \(env slow\): its profile is open in another browser — the `retake login` window\? Close it, then try again\n {10}profile: /);
        expect(hook.err).not.toContain('nothing was recorded');
      } finally {
        await rm(lock, { force: true });
      }
      // The older auth.storage_state form: its file is exported again (retake login has no window for it).
      const old = await retake(['auth', 'status', '--project', EDGE, '--env', 'oldstate']);
      expect(old.out).toContain(
        `  default  never     its auth.storage_state file does not exist\n           → export ${join(home, 'exported-state.json')} again (or name the account in auth.personas, then retake login)\n`,
      );
      const oldJson = (JSON.parse((await retake(['auth', 'status', '--project', EDGE, '--env', 'oldstate', '--json'])).out) as { personas: Array<Record<string, unknown>> }).personas[0];
      expect(oldJson).not.toHaveProperty('command');
      expect(oldJson.fix).toContain('again');
      // Errors of the session code are reported as messages, never as "unexpected error" with a stack.
      expect(isKnownError(new PreflightError('x'))).toBe(true);
      expect(isKnownError(new LoginPageError('x'))).toBe(true);
    }, LONG);
  });
});
