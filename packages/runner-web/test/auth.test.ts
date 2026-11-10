/**
 * Sessions & personas at run time (L1.6), in a real Chromium against a small cookie sign-in app (auth-server.ts): the
 * preflight before anything runs (R-AUTH-03), the guard that fails a run landing on a sign-in page and keeps nothing of
 * it (R-AUTH-04), the automated login with injected secrets (R-AUTH-05), per-run copies of a persona's session —
 * concurrent runs, a held master (R-AUTH-07) — and one browser per persona (R-AUTH-01). Every test has its own Retake
 * home (RETAKE_HOME, a temp folder): nothing touches ~/.retake, and no secret comes from the real Keychain.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { personaPaths, PERSON_POLICY } from '@retake/core';
import type { AuthConfig, LoadedProject, RunProgress, RunRecord, Scenario } from '@retake/core';
import {
  copyProfile,
  kitConfigFor,
  launchTarget,
  openSession,
  profileLock,
  readStatus,
  registerSessionCopy,
  removeSessionCopiesSync,
  runScenario,
  skippedInCopy,
  sweepStaleSessionCopies,
} from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { ACCOUNTS, signInMaster, startAuthServer } from './auth-server.js';
import type { AuthServer } from './auth-server.js';
import { FAST, makeProject, makeScenario, tempDir } from './helpers.js';

let srv: AuthServer;
let home = '';

beforeAll(async () => {
  srv = await startAuthServer();
});

afterAll(async () => {
  await srv.close();
});

beforeEach(async () => {
  home = await tempDir('ds-home-');
  process.env.RETAKE_HOME = home;
});

const ENV = 'test';
const files = (persona: string) => personaPaths(home, 'northfield', ENV, persona);

/** Personas on one host (same cookie name): supplier on page `app`, buyer on page `store`. */
function authConfig(over: Partial<Record<'supplier' | 'buyer', object>> = {}): AuthConfig {
  return {
    login_url: '/sign-in',
    personas: {
      supplier: { pages: ['app'], check: { url: 'app:/home', expect_text: ACCOUNTS.supplier.name }, ...over.supplier },
      buyer: { pages: ['store'], check: { url: 'store:/home', expect_text: ACCOUNTS.buyer.name }, ...over.buyer },
    },
  };
}

async function project(auth: AuthConfig | undefined = authConfig()): Promise<LoadedProject> {
  const p = makeProject(await tempDir('ds-auth-run-'), { app: srv.url, store: srv.url });
  if (auth) p.config.auth = auth;
  return p;
}

async function master(persona: 'supplier' | 'buyer', opts: { profile?: boolean } = {}): Promise<void> {
  const f = files(persona);
  if (opts.profile !== false) await mkdir(f.profileDir, { recursive: true });
  await signInMaster({ url: srv.url, persona, ...(opts.profile !== false ? { profileDir: f.profileDir } : {}), snapshot: f.snapshot, project: 'northfield', env: ENV });
}

async function run(p: LoadedProject, name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> = {}): Promise<{ rec: RunRecord; events: RunProgress[]; dir: string }> {
  const events: RunProgress[] = [];
  const rec = await runScenario({ policy: PERSON_POLICY,
    project: p,
    scenario: makeScenario(name, { pacing: FAST, ...scenario }),
    mode: 'dry',
    env: ENV,
    runId: `${name}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    onProgress: (e) => events.push(e),
    ...opts,
  });
  return { rec, events, dir: rec.dir };
}

const logs = (events: RunProgress[]) => events.flatMap((e) => (e.type === 'log' ? [`${e.level}: ${e.message}`] : []));

/** Session copies of a run still in the system temp folder. */
async function copiesOf(runId: string): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith(`retake-session-${runId}`));
}

describe('preflight (R-AUTH-03) and per-run copies (R-AUTH-07)', () => {
  it('a valid session: the run films each persona signed in, on a copy (the master is never opened); the status is saved', async () => {
    await master('supplier');
    await master('buyer');
    const mtime = statSync(join(files('supplier').profileDir, 'Default', 'Cookies')).mtimeMs;
    const p = await project();
    const { rec, events } = await run(p, 'valid', {
      scenes: [
        { id: 'a', page: 'app', open: '/home', steps: [{ assert: { text: `Signed in as ${ACCOUNTS.supplier.name}` } }] },
        { id: 'b', page: 'store', open: '/home', steps: [{ assert: { text: `Signed in as ${ACCOUNTS.buyer.name}` } }] },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(logs(events).filter((l) => l.includes('signed in ('))).toHaveLength(2);
    const st = await readStatus(files('supplier').statusFile);
    expect(st).toMatchObject({ version: 1, status: 'valid', by: 'preflight', run: rec.id, at: `${srv.url}/home` });
    expect(statSync(files('supplier').statusFile).mode & 0o777).toBe(0o600);
    expect(statSync(files('supplier').snapshot).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'sessions', 'northfield', ENV)).mode & 0o777).toBe(0o700);
    // The master: never locked or written by the run; the copy is gone.
    expect(existsSync(join(files('supplier').profileDir, 'SingletonLock'))).toBe(false);
    expect(statSync(join(files('supplier').profileDir, 'Default', 'Cookies')).mtimeMs).toBe(mtime);
    expect(await copiesOf(rec.id)).toEqual([]);
  });

  it('an expired session stops the run before any hook with the exact command; a never-signed-in persona says "sign in once"', async () => {
    await master('supplier');
    srv.expire();
    const p = await project();
    const before = srv.pings();
    const { rec, dir } = await run(
      p,
      'expired',
      {
        setup: [{ name: 'ping', http: { method: 'POST', url: '{{app}}/api/ping' } }],
        scenes: [
          { id: 'a', page: 'app', open: '/home', steps: [{ wait: 0.1 }] },
          { id: 'b', page: 'store', open: '/home', steps: [{ wait: 0.1 }] },
        ],
      },
      { mode: 'capture' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe(
      [
        'session preflight failed — nothing was recorded:',
        `  persona supplier (env test): expired — app:/home landed on the sign-in page (${srv.url}/sign-in)`,
        '    sign in again: retake login northfield --env test --persona supplier',
        '  persona buyer (env test): never signed in',
        '    sign in once: retake login northfield --env test --persona buyer',
      ].join('\n'),
    );
    expect(srv.pings()).toBe(before);
    expect(rec.hooks.setup).toBe('none');
    expect(rec.steps_done).toBe(0);
    const left = await readdir(dir);
    expect(left.filter((n) => /^frames|capture|timeline/.test(n))).toEqual([]);
    expect(await readdir(join(dir, 'screenshots'))).toEqual([]);
    expect(await readStatus(files('supplier').statusFile)).toMatchObject({ status: 'expired', by: 'preflight', at: `${srv.url}/sign-in` });
    // "never" is not stored: no status for the buyer.
    expect(await readStatus(files('buyer').statusFile)).toBeNull();
  });

  it('a session cookie survives only in the snapshot: the copy alone is signed out, copy + snapshot cookies are signed in', async () => {
    await master('supplier'); // the supplier's cookie has no expiry: the closed master profile lost it
    const p = await project();
    const scenario = { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ assert: { text: ACCOUNTS.supplier.name } }] }] };
    const ok = await run(p, 'session-cookie', scenario);
    expect(ok.rec.status).toBe('succeeded');
    await rm(files('supplier').snapshot);
    const without = await run(p, 'session-cookie-2', scenario);
    expect(without.rec.status).toBe('failed');
    expect(without.rec.error?.message).toContain('persona supplier (env test): expired — app:/home landed on the sign-in page');
  });

  it('concurrent runs on one persona: both succeed, no "profile in use", the master untouched, no copy left', async () => {
    await master('buyer');
    const mtime = statSync(join(files('buyer').profileDir, 'Default', 'Cookies')).mtimeMs;
    const p = await project();
    const scenario = { scenes: [{ id: 'a', page: 'store', open: '/home', steps: [{ assert: { text: ACCOUNTS.buyer.name } }, { wait: 0.5 }] }] };
    // No run id given: two runs of one scenario started in the same second get their own folders.
    const [a, b] = await Promise.all([run(p, 'par', scenario, { runId: undefined }), run(p, 'par', scenario, { runId: undefined })]);
    expect(a.rec.id).not.toBe(b.rec.id);
    expect([a.rec.status, b.rec.status, a.rec.error?.message, b.rec.error?.message]).toEqual(['succeeded', 'succeeded', undefined, undefined]);
    expect(existsSync(join(files('buyer').profileDir, 'SingletonLock'))).toBe(false);
    expect(statSync(join(files('buyer').profileDir, 'Default', 'Cookies')).mtimeMs).toBe(mtime);
    expect([...(await copiesOf(a.rec.id)), ...(await copiesOf(b.rec.id))]).toEqual([]);
  });

  it('a master held by a running browser (the login window) is refused before anything runs; its lock is seen as live', async () => {
    await master('buyer');
    const held = await chromium.launchPersistentContext(files('buyer').profileDir, { headless: true, ...launchTarget({}, { policy: PERSON_POLICY }) });
    try {
      // Chromium's lock is a dangling symbolic link "<host>-<pid>": existsSync says false, lstat sees it.
      expect(existsSync(join(files('buyer').profileDir, 'SingletonLock'))).toBe(false);
      expect(await profileLock(files('buyer').profileDir)).toMatchObject({ state: 'live' });
      const p = await project();
      const { rec } = await run(p, 'held', { scenes: [{ id: 'a', page: 'store', open: '/home', steps: [{ wait: 0.1 }] }] });
      expect(rec.status).toBe('failed');
      expect(rec.error?.message).toMatch(/^session preflight failed — nothing was recorded:\n {2}persona buyer \(env test\): its profile is open in another browser \(pid \d+\) — the `retake login` window\? Close it, then run again\n {4}profile: /);
      expect(await copiesOf(rec.id)).toEqual([]);
    } finally {
      await held.close();
    }
    expect(await profileLock(files('buyer').profileDir)).toEqual({ state: 'none' });
  });

  it('the legacy auth.profile still works (persona "default", on a copy); a missing one runs signed out with a log warning', async () => {
    const legacyDir = join(home, 'legacy-profile');
    await signInMaster({ url: srv.url, persona: 'buyer', profileDir: legacyDir, snapshot: join(home, 'legacy.json'), project: 'northfield', env: ENV });
    const p = await project({ profile: legacyDir });
    const ok = await run(p, 'legacy', { scenes: [{ id: 'a', page: 'store', open: '/home', steps: [{ assert: { text: ACCOUNTS.buyer.name } }] }] });
    expect(ok.rec.status).toBe('succeeded');
    expect(existsSync(join(legacyDir, 'SingletonLock'))).toBe(false);
    const missing = await project({ profile: join(home, 'not-there') });
    const signedOut = await run(missing, 'legacy-missing', { scenes: [{ id: 'a', page: 'store', open: '/public', steps: [{ assert: { text: 'Public page' } }] }] });
    expect(signedOut.rec.status).toBe('succeeded');
    expect(logs(signedOut.events)).toContain('warn: persona default (env test): no saved session yet (auth.profile): the run starts signed out');
  });

  it('a missing legacy auth.storage_state file fails the run before anything runs (as before L1.6)', async () => {
    const file = join(home, 'typo.json');
    const { rec } = await run(await project({ storage_state: file }), 'legacy-state', { scenes: [{ id: 'a', page: 'store', open: '/public', steps: [{ wait: 0.1 }] }] }, { mode: 'capture' });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe(
      [
        'session preflight failed — nothing was recorded:',
        `  persona default (env test): its auth.storage_state file does not exist: ${file}`,
        '    export it again, or name the account in auth.personas and sign it in with `retake login`',
      ].join('\n'),
    );
  });

  it('a profile folder that is a symbolic link (moved to another disk) is copied from its target', async () => {
    await master('buyer');
    const moved = join(home, 'elsewhere', 'buyer');
    await mkdir(join(home, 'elsewhere'));
    await rename(files('buyer').profileDir, moved);
    await symlink(moved, files('buyer').profileDir);
    const { rec } = await run(await project(), 'symlinked', { scenes: [{ id: 'a', page: 'store', open: '/home', steps: [{ assert: { text: ACCOUNTS.buyer.name } }] }] });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(await copiesOf(rec.id)).toEqual([]);
  });

  it('Ctrl-C during a check that hangs, or during an automated login, cancels the run at once (no status written, no copy left)', async () => {
    await master('supplier');
    const cancelled = async (name: string, auth: AuthConfig, scene: string) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('user cancel')), 1000);
      const t = Date.now();
      const { rec } = await run(await project(auth), name, { scenes: [{ id: 'a', page: scene, open: '/home', steps: [{ wait: 0.1 }] }] }, { signal: ac.signal });
      return { rec, ms: Date.now() - t };
    };
    const hang = await cancelled('cancel-check', authConfig({ supplier: { check: { url: 'app:/hang', expect_text: ACCOUNTS.supplier.name } } }), 'app');
    expect([hang.rec.status, hang.rec.error?.message]).toEqual(['cancelled', 'user cancel']);
    expect(hang.ms).toBeLessThan(6000);
    expect(await copiesOf(hang.rec.id)).toEqual([]);
    const slow = await cancelled(
      'cancel-login',
      authConfig({ buyer: { login: [{ open: 'store:/sign-in' }, { wait: 8 }, { type: { into: { label: 'Email' }, text: ACCOUNTS.buyer.email } }] } }),
      'store',
    );
    expect([slow.rec.status, slow.rec.error?.message]).toEqual(['cancelled', 'user cancel']);
    expect(slow.ms).toBeLessThan(6000);
    expect(await readStatus(files('buyer').statusFile)).toBeNull();
  });
});

describe('automated login (R-AUTH-05)', () => {
  const login = (password: string) => ({
    login: [
      { open: 'app:/sign-in' },
      { type: { into: { label: 'Email' }, text: ACCOUNTS.supplier.email } },
      { type: { into: { label: 'Password' }, text: password } },
      { click: { role: 'button', name: 'Sign in' } },
      { wait_for: { text: ACCOUNTS.supplier.name, timeout: 3 } },
    ],
  });

  it('signs in off camera with a keychain secret (injected reader): never recorded, never written; the saved session stays expired', async () => {
    const asked: string[] = [];
    const p = await project(authConfig({ supplier: login('{{keychain:demo-test/supplier}}') }));
    const { rec, events, dir } = await run(
      p,
      'auto',
      { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ assert: { text: `Signed in as ${ACCOUNTS.supplier.name}` } }, { hold: 0.3 }] }] },
      {
        mode: 'capture',
        resolveSecret: async (ref) => {
          asked.push(ref);
          return ACCOUNTS.supplier.password;
        },
      },
    );
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(asked).toEqual(['keychain:demo-test/supplier']);
    expect(logs(events).find((l) => l.includes('signed in automatically'))).toBe(
      'warn: persona supplier (env test): signed in automatically, off camera (never signed in) — `retake login northfield --env test --persona supplier` saves a session runs can reuse',
    );
    expect(existsSync(join(dir, 'capture.mp4'))).toBe(true);
    const status = await readStatus(files('supplier').statusFile);
    expect(status).toMatchObject({ status: 'expired', detail: `never signed in; signed in automatically for run ${rec.id}` });
    // The capture starts on the signed-in page: the timeline never shows the sign-in page, the password is nowhere.
    const timeline = await readFile(join(dir, 'timeline.json'), 'utf8');
    expect(timeline).not.toContain('/sign-in');
    for (const f of ['run.json', 'log.jsonl', 'timeline.json']) expect(await readFile(join(dir, f), 'utf8')).not.toContain(ACCOUNTS.supplier.password);
    expect(await readFile(files('supplier').statusFile, 'utf8')).not.toContain(ACCOUNTS.supplier.password);
    expect(existsSync(files('supplier').profileDir)).toBe(false);
  });

  it('a failing login names the step as written, never the typed value (a literal password included)', async () => {
    const p = await project(authConfig({ supplier: login('wrong-literal-pw-77') }));
    const { rec, dir } = await run(p, 'auto-fail', { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ wait: 0.1 }] }] });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe(
      [
        'session preflight failed — nothing was recorded:',
        `  persona supplier (env test): never signed in; automated login failed: login step 5 (wait_for text ${JSON.stringify(ACCOUNTS.supplier.name)}): timed out after 3.0 s: text ${JSON.stringify(ACCOUNTS.supplier.name)} is not visible`,
        '    sign in once: retake login northfield --env test --persona supplier',
      ].join('\n'),
    );
    for (const f of ['run.json', 'log.jsonl']) expect(await readFile(join(dir, f), 'utf8')).not.toContain('wrong-literal-pw-77');
    const missing = await run(await project(authConfig({ supplier: login('{{env:RETAKE_TEST_UNSET_PW}}') })), 'auto-missing', {
      scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ wait: 0.1 }] }],
    });
    expect(missing.rec.error?.message).toContain('persona supplier (env test): never signed in; its automated login cannot run: environment variable RETAKE_TEST_UNSET_PW is not set');
  });

  it('a sandbox account (L1.8): its plain password is a secret once its login runs (masked everywhere); signing in is info, not a warning', async () => {
    // As loadProject builds it from a sandbox.yaml: the password substituted into the login steps, listed as a secret.
    const p = await project({ test: authConfig({ supplier: login(ACCOUNTS.supplier.password) }) } as unknown as AuthConfig);
    p.sandboxes = {
      test: { env: 'test', file: join(p.dir, 'sandbox.yaml'), dir: p.dir, manifest: { version: 1, provider: 'process', services: {} }, issues: [], secrets: { supplier: [ACCOUNTS.supplier.password] } },
    };
    const { rec, events, dir } = await run(p, 'sandbox-account', {
      // A step whose description holds the password's text: the run masks it.
      scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ assert: { not_text: ACCOUNTS.supplier.password } }, { hold: 0.2 }] }],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(logs(events).find((l) => l.includes('signed in automatically'))).toBe('info: persona supplier (env test): signed in automatically, off camera (never signed in; a sandbox account)');
    expect(logs(events).filter((l) => l.startsWith('warn:'))).toEqual([]);
    const log = await readFile(join(dir, 'log.jsonl'), 'utf8');
    expect(log).toContain('not_text');
    expect(log).toContain('***');
    for (const f of ['run.json', 'log.jsonl']) expect(await readFile(join(dir, f), 'utf8')).not.toContain(ACCOUNTS.supplier.password);
  });

  it('nothing a run writes or emits holds a secret (L4.4: outline, session, pause events included) — a sandbox account signed in by the run or by a saved session, and a secret written as is in a step', async () => {
    const VAR = 'RETAKE_TEST_L44_SECRET';
    const literal = 'l44-literal-secret-5531';
    process.env[VAR] = literal;
    /**
     * Every text file the run writes under its folder (run.json, log.jsonl, timeline.json…) — but scenario.yaml, the
     * scenario's own text copied as the author wrote it (a value written as is there stays as is, since L1).
     */
    const textFiles = async (d: string): Promise<string[]> =>
      (await readdir(d, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile() && /\.(json|jsonl|txt|md|log|ya?ml)$/.test(e.name))
        .map((e) => join(e.parentPath, e.name))
        .filter((f) => f !== join(d, 'scenario.yaml'));
    try {
      for (const signedIn of [false, true]) {
        if (signedIn) await master('supplier');
        const p = await project({ test: authConfig({ supplier: login(ACCOUNTS.supplier.password) }) } as unknown as AuthConfig);
        p.sandboxes = {
          test: { env: 'test', file: join(p.dir, 'sandbox.yaml'), dir: p.dir, manifest: { version: 1, provider: 'process', services: {} }, issues: [], secrets: { supplier: [ACCOUNTS.supplier.password] } },
        };
        const gate = { requested: false };
        const events: RunProgress[] = [];
        const { rec, dir } = await run(
          p,
          `secrets-everywhere-${signedIn ? 'saved' : 'login'}`,
          {
            scenes: [
              {
                id: 'a',
                page: 'app',
                open: '/home',
                steps: [{ assert: { not_text: ACCOUNTS.supplier.password } }, { assert: { not_text: `{{env:${VAR}}}` } }, { assert: { not_text: literal } }, { hold: 0.2 }],
              },
            ],
          },
          {
            mode: 'capture',
            pause: gate,
            onProgress: (e) => {
              events.push(e);
              if (e.type === 'step_end' && e.step === 0) gate.requested = true;
              if (e.type === 'pause' && e.state === 'paused') setTimeout(() => (gate.requested = false), 300);
            },
          },
        );
        expect(rec.error?.message).toBeUndefined();
        expect(rec.status).toBe('succeeded');
        expect(logs(events).some((l) => l.includes('signed in automatically')), JSON.stringify(logs(events))).toBe(!signedIn);
        // The L4.4 events are there — and masked.
        const outline = events.find((e) => e.type === 'outline');
        expect(outline).toBeDefined();
        expect(JSON.stringify(outline)).toContain('***');
        expect(events.some((e) => e.type === 'session')).toBe(true);
        expect(events.some((e) => e.type === 'pause' && e.state === 'paused')).toBe(true);
        for (const e of events) for (const s of [ACCOUNTS.supplier.password, literal]) expect(JSON.stringify(e), e.type).not.toContain(s);
        const written = await textFiles(dir);
        expect(written.map((f) => f.slice(dir.length + 1))).toEqual(expect.arrayContaining(['run.json', 'log.jsonl', 'timeline.json']));
        for (const f of written) {
          const text = await readFile(f, 'utf8');
          for (const s of [ACCOUNTS.supplier.password, literal]) expect(text, f).not.toContain(s);
        }
        for (const line of (await readFile(join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      delete process.env[VAR];
    }
  });
});

describe('read-only environments and the product clock with personas (L1.7)', () => {
  const login = {
    login: [
      { open: 'app:/sign-in' },
      { type: { into: { label: 'Email' }, text: ACCOUNTS.supplier.email } },
      { type: { into: { label: 'Password' }, text: ACCOUNTS.supplier.password } },
      { click: { role: 'button', name: 'Sign in' } },
      { wait_for: { text: ACCOUNTS.supplier.name, timeout: 3 } },
    ],
  };

  it('the automated sign-in posts from its sign-in page (exempt, recorded `via: sign-in`); what the page it lands on sends, the check page and the capture pages are guarded', async () => {
    const before = srv.apiWrites().length;
    const p = await project(authConfig({ supplier: { login: [{ open: 'app:/sign-in?next=/welcome' }, ...login.login.slice(1)] } }));
    p.config.environment_settings = { [ENV]: { production: true } };
    const { rec, events } = await run(p, 'ro-login', {
      scenes: [
        // The app's "Expire" button posts /expire: stopped — the session survives it.
        { id: 'a', page: 'app', open: '/home', steps: [{ assert: { text: `Signed in as ${ACCOUNTS.supplier.name}` } }, { click: 'Expire' }, { wait: 0.3 }] },
        { id: 'b', page: 'app', open: '/quotes', steps: [{ assert: { text: `Signed in as ${ACCOUNTS.supplier.name}` } }] },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(logs(events).some((l) => l.includes('signed in automatically'))).toBe(true);
    const tl = JSON.parse(await readFile(join(rec.dir, 'timeline.json'), 'utf8')) as { environment: { access: string; writes: Array<{ t?: number; method: string; url: string; outcome: string; via: string }> } };
    expect(tl.environment.access).toBe('read-only');
    // The sign-in POST passed; the landing page's writes (a fetch and a beacon) were stopped and recorded from the tab.
    const writes = tl.environment.writes.map((w) => [w.method, new URL(w.url).pathname, w.outcome, w.via, w.t === undefined ? 'before t0' : 'captured']);
    expect(writes[0]).toEqual(['POST', '/sign-in', 'exempt', 'sign-in', 'before t0']);
    expect(writes.slice(1).sort()).toEqual(
      [
        ['POST', '/api/onboarding', 'blocked', 'sign-in', 'before t0'],
        ['PUT', '/api/last-seen', 'blocked', 'sign-in', 'before t0'],
        ['POST', '/expire', 'blocked', 'page', 'captured'],
      ].sort(),
    );
    expect(srv.apiWrites().slice(before)).toEqual([]);
    expect(logs(events).some((l) => /a write was stopped \(PUT app:\/api\/last-seen, the automated sign-in, before the capture started\)/.test(l))).toBe(true);
  });

  it('the preflight checks on the real clock; the capture reads the clock (installed after the preflight, D8)', async () => {
    await master('supplier');
    const year = new Date().getFullYear();
    const p = await project(authConfig({ supplier: { check: { url: 'app:/clock', expect_text: `Year ${year}` } } }));
    const { rec } = await run(p, 'clock-preflight', {
      clock: '2020-01-01T09:00:00Z',
      scenes: [{ id: 'a', page: 'app', open: '/clock', steps: [{ assert: { text: 'Year 2020' } }] }],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(rec.environment?.clock).toEqual({ at: '2020-01-01T09:00:00Z' });
  });

  it('the session check after a failed step runs on the real time, not the product clock (T5)', async () => {
    await master('supplier');
    const year = new Date().getFullYear();
    const p = await project(authConfig({ supplier: { check: { url: 'app:/clock', expect_text: `Year ${year}`, timeout: 2 } } }));
    const { rec } = await run(p, 'clock-diagnose', {
      clock: '2020-01-01T09:00:00Z',
      scenes: [{ id: 'a', page: 'app', open: '/clock', steps: [{ assert: { text: 'Year 2020' } }, { click: 'Nothing here', timeout: 1 }] }],
    });
    expect(rec.status).toBe('failed');
    // Checked under the clock, the page would read 2020 and the session would be called expired.
    expect(rec.error?.message).toMatch(/click text="Nothing here"/);
    expect(rec.error?.message).not.toMatch(/no longer valid/);
    expect(await readStatus(files('supplier').statusFile)).not.toMatchObject({ status: 'expired' });
  });
});

describe('two personas on one host: one browser each (R-AUTH-01)', () => {
  it('a multi-page scene films the supplier and the buyer side by side, each signed in as itself; a js hook runs as its page\'s persona', async () => {
    await master('supplier');
    await master('buyer');
    const p = await project();
    const { rec, events } = await run(
      p,
      'two',
      {
        setup: [{ name: 'whoami', js: { page: 'store', code: "const r = await fetch('/api/whoami'); const t = await r.text(); if (t !== 'Ben Buyer') throw new Error('hook tab is ' + t); return t" } }],
        scenes: [
          {
            id: 'both',
            pages: { seller: { open: 'app:/home' }, customer: { open: 'store:/home' } },
            steps: [{ assert: { text: `Signed in as ${ACCOUNTS.supplier.name}` } }, { on: 'customer', assert: { text: `Signed in as ${ACCOUNTS.buyer.name}` } }],
          },
          { id: 'guest', pages: { visitor: { open: 'app:/public', persona: 'none' }, seller: {} }, steps: [{ assert: { text: 'Public page' } }] },
        ],
      },
      { hooks: 'run' },
    );
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(rec.hooks.setup).toBe('ok');
    expect(logs(events).filter((l) => l.startsWith('warn: page '))).toEqual([]);
  });
});

describe('pages and hook tabs without a persona (R-AUTH-01)', () => {
  it('a js hook on a page filmed `persona: none` runs signed out, in the browser that films it; the unused persona is not checked', async () => {
    await master('buyer');
    const { rec, events } = await run(
      await project(),
      'hook-none',
      {
        setup: [{ name: 'whoami', js: { page: 'store', code: "localStorage.setItem('probe', 'hook'); const t = await (await fetch('/api/whoami')).text(); if (t !== 'signed out') throw new Error('hook tab is ' + t); return t" } }],
        scenes: [{ id: 'guest', page: 'store', persona: 'none', open: '/public', steps: [{ eval: { js: "if (localStorage.getItem('probe') !== 'hook') throw new Error('not the hook browser'); return 1" } }] }],
      },
      { hooks: 'run' },
    );
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(logs(events).filter((l) => l.includes('persona buyer'))).toEqual([]);
  });

  it('`persona: none` holds for the tabs a none page opens and for a later scene on a tab filmed without a persona', async () => {
    const p = await project({ login_url: '/sign-in', personas: { supplier: { pages: ['app'], check: { url: 'app:/home', expect_text: ACCOUNTS.supplier.name } } } });
    const { rec } = await run(p, 'none-tabs', {
      scenes: [
        { id: 'a', page: 'store', persona: 'none', open: '/public', steps: [{ new_tab: { href: '/sign-in', as: 'help' } }, { assert: { text: 'Sign in' } }, { new_tab: { href: '/sign-in?next=/x' } }] },
        { id: 'b', page: 'store', steps: [{ new_tab: { href: '/public', as: 'later' } }] },
        { id: 'c', page: 'later', persona: 'none', open: '/sign-in', steps: [{ assert: { text: 'Sign in' } }] },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
  });
});

describe('the sign-in guard (R-AUTH-04): a run that lands on a sign-in page fails and keeps nothing', () => {
  beforeEach(async () => {
    await master('supplier');
  });

  /** What a failed run left in its folder that shows pictures. */
  async function pictures(dir: string): Promise<string[]> {
    const top = (await readdir(dir)).filter((n) => /^(frames|capture|timeline)/.test(n));
    const shots = existsSync(join(dir, 'screenshots')) ? await readdir(join(dir, 'screenshots')) : [];
    return [...top, ...shots];
  }

  const landing = (url: string) => `page "app" (persona supplier) landed on the sign-in page (${url})`;

  it('a click that lands there mid-capture: the run fails with the landing, no frame, no video, no error screenshot', async () => {
    const { rec, dir } = await run(
      await project(),
      'land-click',
      { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ hold: 0.4 }, { click: 'Expire' }, { wait_for: 'expired' }, { click: 'Quotes' }, { click: 'Home' }] }] },
      { mode: 'capture' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe(
      `${landing(`${srv.url}/sign-in`)} — the session expired during the run; nothing of the capture was kept. Sign in again: retake login northfield --env test --persona supplier`,
    );
    // It did film (three steps ran) before the landing; nothing of it is left.
    expect(rec.steps_done).toBeGreaterThanOrEqual(4);
    expect(await pictures(dir)).toEqual([]);
    expect(rec.capture).toBeUndefined();
    expect(rec.timeline).toBeUndefined();
    // `retake auth status` says so: the session expired during this run.
    expect(await readStatus(files('supplier').statusFile)).toMatchObject({ status: 'expired', by: 'run', run: rec.id, at: `${srv.url}/sign-in`, detail: `page app landed on the sign-in page during run ${rec.id}` });
  });

  it('a document a download opens on the sign-in page fails the run: never saved, no artefact kept', async () => {
    const { rec, dir } = await run(
      await project(),
      'land-download',
      { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ click: 'Expire' }, { wait_for: 'expired' }, { download: { click: 'Document', as: 'doc' } }, { hold: 0.3 }] }] },
      { mode: 'capture' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe(
      `the document of download "doc" on ${landing(`${srv.url}/sign-in`)} — the session expired during the run; nothing of the capture was kept. Sign in again: retake login northfield --env test --persona supplier`,
    );
    expect(await pictures(dir)).toEqual([]);
    expect(existsSync(join(dir, 'artefacts'))).toBe(false);
  });

  it("a tab that reaches another persona's sign-in page says so (not an expired session); the session's status is untouched", async () => {
    const other = await startAuthServer();
    try {
      const p = makeProject(await tempDir('ds-auth-run-'), { app: srv.url, store: other.url });
      p.config.auth = authConfig();
      const { rec } = await run(p, 'land-foreign', { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ new_tab: { href: `${other.url}/home`, as: 'other' } }, { hold: 0.2 }] }] });
      expect(rec.status).toBe('failed');
      expect(rec.error?.message).toBe(
        `page "other" (persona supplier, opened from page "app") landed on the sign-in page (${other.url}/sign-in) — that is page "store", filmed as persona buyer: ` +
          'a tab keeps the persona of the page it is opened from — film "store" on its own page (`page: store`, or `switch_page: store`); nothing of the capture was kept',
      );
      expect(await readStatus(files('supplier').statusFile)).toMatchObject({ status: 'valid', by: 'preflight' });
    } finally {
      await other.close();
    }
  });

  it('an optional step failing on the sign-in page is not tolerated; a dry run keeps no screenshot of it', async () => {
    const { rec, dir } = await run(await project(), 'land-optional', {
      scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ click: 'Expire' }, { wait_for: 'expired' }, { click: 'Quotes', optional: true }, { click: 'Nowhere', optional: true }] }],
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain(landing(`${srv.url}/sign-in`));
    expect(rec.warnings.filter((w) => w.includes('optional'))).toEqual([]);
    expect(await pictures(dir)).toEqual([]);
    expect(rec.screenshots).toEqual([]);
  });

  it('a scene that opens on the sign-in page fails at its start; a setup hook that ran just before is named', async () => {
    const { rec, dir } = await run(
      await project(),
      'land-scene',
      {
        setup: [{ name: 'reset-sessions', http: { method: 'POST', url: '{{app}}/expire' } }],
        scenes: [{ id: 'a', page: 'app', open: '/quotes', steps: [{ wait: 0.2 }] }],
      },
      { mode: 'capture' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain(`${landing(`${srv.url}/sign-in`)} — the session expired during the run (a setup hook ran just before: it may have reset the sessions)`);
    expect(rec.steps_done).toBe(0);
    expect(await pictures(dir)).toEqual([]);
  });

  it('a same-document route to the sign-in page (pushState) is caught too', async () => {
    const { rec, dir } = await run(
      await project(),
      'land-spa',
      { scenes: [{ id: 'a', page: 'app', open: '/spa', steps: [{ click: 'Leave' }, { hold: 1 }] }] },
      { mode: 'capture' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain(landing(`${srv.url}/sign-in`));
    expect(await pictures(dir)).toEqual([]);
  });

  it('a page that lands on the sign-in page while the run is paused: the run fails with the landing, the next step never starts', async () => {
    const gate = { requested: false };
    const events: RunProgress[] = [];
    const { rec } = await run(
      await project(),
      'land-paused',
      { scenes: [{ id: 'a', page: 'app', open: '/later?ms=900', steps: [{ hold: 0.1 }, { hold: 0.1 }, { hold: 0.1 }] }] },
      {
        mode: 'capture',
        pause: gate,
        onProgress: (e) => {
          events.push(e);
          if (e.type === 'step_end' && e.step === 0) gate.requested = true;
          if (e.type === 'pause' && e.state === 'paused') setTimeout(() => (gate.requested = false), 2500);
        },
      },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain(landing(`${srv.url}/sign-in`));
    expect(events.filter((e) => e.type === 'step_start').map((e) => (e as { step: number }).step)).toEqual([0]);
    expect(events.some((e) => e.type === 'pause' && e.state === 'paused')).toBe(true);
    expect(rec.capture).toBeUndefined();
  });

  it('a page without a persona is guarded by auth.login_url unless written `persona: none`', async () => {
    const p = await project({ login_url: '/sign-in', personas: { supplier: { pages: ['app'], check: { url: 'app:/home', expect_text: ACCOUNTS.supplier.name } } } });
    const guarded = await run(p, 'land-default', { scenes: [{ id: 'a', page: 'store', open: '/home', steps: [{ wait: 0.1 }] }, { id: 'b', page: 'app', open: '/home', steps: [{ wait: 0.1 }] }] });
    expect(guarded.rec.error?.message).toBe(
      `page "store" landed on the sign-in page (${srv.url}/sign-in) — this page has no persona: bind it to one (auth.personas.<name>.pages, or \`persona:\` on the scene); nothing of the capture was kept`,
    );
    const open = await run(p, 'land-none', { scenes: [{ id: 'a', page: 'store', persona: 'none', open: '/home', steps: [{ assert: { text: 'Sign in' } }] }, { id: 'b', page: 'app', open: '/home', steps: [{ wait: 0.1 }] }] });
    expect(open.rec.error?.message).toBeUndefined();
    expect(open.rec.status).toBe('succeeded');
  });

  it('a step failing on a persona page whose session is gone says so', async () => {
    // No sign-in pattern catches this app's sign-in page: the step fails on a missing target, then the session is checked.
    const q = await project({ personas: { supplier: { pages: ['app'], check: { url: 'app:/home', expect_text: ACCOUNTS.supplier.name, timeout: 2 } } } });
    const { rec } = await run(q, 'diagnose', { scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ click: 'Expire' }, { wait_for: 'expired' }, { click: 'Quotes' }, { click: 'Quotes', timeout: 1 }] }] });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toMatch(
      /^scene a, step 3 \(click text="Quotes"\): no visible element matches .* — the session of persona supplier is no longer valid \(app:\/home does not show "Ada Supplier" within 2 s \(at http:\/\/127\.0\.0\.1:\d+\/sign-in\)\): sign in again: retake login northfield --env test --persona supplier$/,
    );
    expect(await readStatus(files('supplier').statusFile)).toMatchObject({ status: 'expired', by: 'run', run: rec.id, at: `${srv.url}/sign-in` });
  });

  it('a js hook tab that lands on its persona\'s sign-in page is refused with the command', async () => {
    const { rec } = await run(
      await project(),
      'land-hook',
      {
        setup: [
          { name: 'reset-sessions', http: { method: 'POST', url: '{{app}}/expire' } },
          { name: 'in-app', js: { page: 'app', code: 'return 1' } },
        ],
        scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ wait: 0.1 }] }],
      },
      { hooks: 'run' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain(`js hook page "app" (persona supplier) landed on the sign-in page (${srv.url}/sign-in): its session expired — sign in again: retake login northfield --env test --persona supplier`);
  });

  it('a later js hook reusing a tab left on the sign-in page is refused too', async () => {
    const { rec } = await run(
      await project(),
      'land-hook-reuse',
      {
        setup: [
          { name: 'leave', js: { page: 'app', code: "await fetch('/expire', { method: 'POST' }); history.pushState({}, '', '/sign-in'); return 1" } },
          { name: 'again', js: { page: 'app', code: 'return 2' } },
        ],
        scenes: [{ id: 'a', page: 'app', open: '/home', steps: [{ wait: 0.1 }] }],
      },
      { hooks: 'run' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain(`(again: js hook page "app" (persona supplier) landed on the sign-in page (${srv.url}/sign-in): its session expired`);
  });
});

describe('session copies (R-AUTH-07, units)', () => {
  it('leave out locks, caches, crash reports and saved passwords; keep cookies, storage and service-worker caches', () => {
    for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'GraphiteDawnCache', 'ShaderCache', 'Crashpad', 'BrowserMetrics-spare.pma', 'Login Data', 'Login Data-journal', 'Login Data For Account', 'Web Data', 'Web Data-journal', 'component_crx_cache']) {
      expect(skippedInCopy(n), n).toBe(true);
    }
    for (const n of ['Cookies', 'Cookies-journal', 'Local Storage', 'IndexedDB', 'Session Storage', 'Service Worker', 'CacheStorage', 'ScriptCache', 'Preferences', 'Local State', 'Default']) {
      expect(skippedInCopy(n), n).toBe(false);
    }
  });

  it('a launch that fails for one persona closes the others and removes every copy (no leak)', async () => {
    const dir = await tempDir('ds-partial-');
    const copy = join(dir, 'copy');
    const other = join(dir, 'other');
    await mkdir(copy);
    await mkdir(other);
    await expect(
      openSession({ policy: PERSON_POLICY,
        width: 400,
        height: 300,
        scale: 1,
        kit: kitConfigFor(undefined),
        realms: [
          { name: 'a', userDataDir: copy, cleanup: [copy] },
          // Launched, then its session cannot be applied: the launch fails after Chromium started.
          { name: 'b', userDataDir: other, cleanup: [other], storageState: join(dir, 'missing.json') },
        ],
      }),
    ).rejects.toThrow(/cannot read storage_state/);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(other)).toBe(false);
  });

  it('stale copies a killed process left are swept: old, no browser on them, ours only; this process removes its own on a hard interrupt', async () => {
    const { hostname } = await import('node:os');
    const dir = await tempDir('ds-sweep-');
    const old = Date.now() / 1000 - 3600;
    const make = async (name: string, age: 'old' | 'new', live = false) => {
      await mkdir(join(dir, name, 'Default'), { recursive: true });
      await writeFile(join(dir, name, 'Default', 'Cookies'), 'x');
      if (live) await symlink(`${hostname()}-${process.pid}`, join(dir, name, 'SingletonLock'));
      if (age === 'old') await utimes(join(dir, name), old, old);
    };
    await make('retake-session-r1-supplier-aaaa', 'old');
    await make('retake-session-check-1-buyer-bbbb', 'old');
    await make('retake-login-cccc', 'old');
    await make('retake-session-r2-supplier-dddd', 'new');
    await make('retake-session-r3-buyer-eeee', 'old', true);
    await make('retake-profile-ffff', 'old');
    await make('other-gggg', 'old');
    const removed = await sweepStaleSessionCopies({ dir });
    // A throwaway profile (no persona profile: a storage_state persona's cookies end up there) is swept too.
    expect(removed.map((d) => d.slice(dir.length + 1)).sort()).toEqual([
      'retake-login-cccc',
      'retake-profile-ffff',
      'retake-session-check-1-buyer-bbbb',
      'retake-session-r1-supplier-aaaa',
    ]);
    expect((await readdir(dir)).sort()).toEqual(['other-gggg', 'retake-session-r2-supplier-dddd', 'retake-session-r3-buyer-eeee']);
    // A copy of this process is never swept; removeSessionCopiesSync (a second Ctrl-C) removes it at once.
    const mine = join(dir, 'retake-session-r4-buyer-hhhh');
    await make('retake-session-r4-buyer-hhhh', 'old');
    registerSessionCopy(mine);
    expect(await sweepStaleSessionCopies({ dir })).toEqual([]);
    expect(removeSessionCopiesSync()).toBe(1);
    expect(existsSync(mine)).toBe(false);
    expect(removeSessionCopiesSync()).toBe(0);
  });

  it('copyProfile follows a profile path that is a symbolic link', async () => {
    const dir = await tempDir('ds-cp-');
    await mkdir(join(dir, 'real', 'Default'), { recursive: true });
    await writeFile(join(dir, 'real', 'Default', 'Cookies'), 'x');
    await writeFile(join(dir, 'real', 'SingletonLock'), '');
    await symlink(join(dir, 'real'), join(dir, 'link'));
    await mkdir(join(dir, 'dest'));
    await copyProfile(join(dir, 'link'), join(dir, 'dest'));
    expect((await readdir(join(dir, 'dest'), { recursive: true })).sort()).toEqual(['Default', 'Default/Cookies']);
  });

  it('a lock: none, live (this process), stale (a gone pid), live (a plain file: cannot tell)', async () => {
    const { hostname } = await import('node:os');
    const { symlink } = await import('node:fs/promises');
    const dir = await tempDir('ds-lock-');
    expect(await profileLock(dir)).toEqual({ state: 'none' });
    await symlink(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
    expect(await profileLock(dir)).toEqual({ state: 'live', pid: process.pid, host: hostname() });
    await rm(join(dir, 'SingletonLock'));
    await symlink(`${hostname()}-999999`, join(dir, 'SingletonLock'));
    expect(await profileLock(dir)).toMatchObject({ state: 'stale', pid: 999999 });
    await rm(join(dir, 'SingletonLock'));
    await writeFile(join(dir, 'SingletonLock'), '');
    expect(await profileLock(dir)).toEqual({ state: 'live' });
  });
});
