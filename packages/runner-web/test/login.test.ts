/**
 * `retake login`'s engine (L1.6, R-AUTH-06): signIn in a real Chromium against the cookie sign-in app of auth-server.ts.
 * The headed window is played by `drive` (a headless window here; a visible one with RETAKE_TEST_HEADED=1 — the
 * only proof of the real window without a person), the automated login with an injected secret reader. Every test has
 * its own Retake home (RETAKE_HOME): nothing touches ~/.retake, nothing reads the real Keychain.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { personaPaths, resolvePersonas } from '@retake/core';
import type { AuthConfig, LoadedProject, PersonaConfig } from '@retake/core';
import { checkSavedSession, readSnapshot, readStatus, signIn } from '../src/index.js';
import type { SignInOptions } from '../src/index.js';
import { ACCOUNTS, startAuthServer } from './auth-server.js';
import type { AuthServer } from './auth-server.js';
import { makeProject, tempDir } from './helpers.js';

let srv: AuthServer;
let home = '';

beforeAll(async () => {
  srv = await startAuthServer();
});

afterAll(async () => {
  await srv.close();
});

beforeEach(async () => {
  home = await tempDir('ds-login-home-');
  process.env.RETAKE_HOME = home;
});

const ENV = 'test';

const loginSteps = (persona: 'supplier' | 'buyer', password: string): PersonaConfig['login'] => [
  { open: `${persona === 'supplier' ? 'app' : 'store'}:/sign-in` },
  { type: { into: { label: 'Email' }, text: ACCOUNTS[persona].email } },
  { type: { into: { label: 'Password' }, text: password } },
  { click: { role: 'button', name: 'Sign in' } },
  { wait_for: { text: ACCOUNTS[persona].name, timeout: 5 } },
];

async function setup(over: Partial<Record<'supplier' | 'buyer', Partial<PersonaConfig>>> = {}): Promise<{ project: LoadedProject; persona: (name: string) => SignInOptions['persona'] }> {
  const project = makeProject(await tempDir('ds-login-'), { app: srv.url, store: srv.url });
  const auth: AuthConfig = {
    login_url: '/sign-in',
    personas: {
      supplier: { pages: ['app'], check: { url: 'app:/home', expect_text: ACCOUNTS.supplier.name }, login: loginSteps('supplier', '{{keychain:demo-test/supplier}}'), ...over.supplier },
      buyer: { pages: ['store'], check: { url: 'store:/home', expect_text: ACCOUNTS.buyer.name }, login: loginSteps('buyer', '{{env:DS_TEST_BUYER_PASSWORD}}'), ...over.buyer },
    },
  };
  project.config.auth = auth;
  return { project, persona: (name) => resolvePersonas(project, ENV).find((p) => p.name === name)! };
}

const env = () => ({ name: ENV, pages: { app: srv.url, store: srv.url } });

/** Plays the person at the window: fills the form, waits until signed in, then closes the page (or quits the browser). */
function person(persona: 'supplier' | 'buyer', close: 'page' | 'browser') {
  return async (page: Page): Promise<void> => {
    const a = ACCOUNTS[persona];
    await page.waitForURL(/\/sign-in/);
    await page.fill('input[name=email]', a.email);
    await page.fill('input[name=password]', a.password);
    await Promise.all([page.waitForURL(`${srv.url}/home`), page.click('button[type=submit]')]);
    await page.getByText(a.name).first().waitFor();
    if (close === 'page') await page.close();
    else {
      // Cmd-Q: nothing can be read once the browser is gone — the 1.5 s polling has the session by then.
      await page.waitForTimeout(2000);
      await page.context().close();
    }
  };
}

describe('retake login (R-AUTH-06): signIn', () => {
  it('headed (driven): the master profile and the snapshot (the session cookie included) are saved, checked the way a run sees them', async () => {
    const { project, persona } = await setup();
    let opened = '';
    const r = await signIn({ project, env: env(), persona: persona('supplier'), mode: 'headed', drive: person('supplier', 'page'), headless: true, onOpen: (u) => (opened = u) });
    expect(opened).toBe(`${srv.url}/home`);
    expect(r.check).toMatchObject({ status: 'valid', detail: `app:/home shows "${ACCOUNTS.supplier.name}"` });
    const f = persona('supplier');
    expect(r.profileDir).toBe(f.profileDir);
    // The session cookie (no expiry) is lost when the profile closes: only the snapshot keeps it.
    const snap = await readSnapshot(f.snapshot!);
    expect(snap?.cookies?.find((c) => c.name === 'sid')).toMatchObject({ expires: -1 });
    expect(snap?.retake).toMatchObject({ version: 1, project: 'northfield', env: ENV, persona: 'supplier', how: 'manual' });
    expect(statSync(f.snapshot!).mode & 0o777).toBe(0o600);
    expect(statSync(f.profileDir!).mode & 0o777).toBe(0o700);
    expect(await readStatus(f.statusFile)).toMatchObject({ status: 'valid', by: 'login', at: `${srv.url}/home` });
    // A new master never offers to save passwords (they would be kept in the clear under Playwright's mock keychain).
    const prefs = JSON.parse(await readFile(join(f.profileDir!, 'Default', 'Preferences'), 'utf8')) as { credentials_enable_service?: boolean; profile?: { password_manager_enabled?: boolean } };
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile?.password_manager_enabled).toBe(false);
    expect(existsSync(join(f.profileDir!, 'SingletonLock'))).toBe(false);
  });

  it('headed (driven), the browser quit instead of closing the page: the last reading of the session is kept', async () => {
    const { project, persona } = await setup();
    const r = await signIn({ project, env: env(), persona: persona('buyer'), mode: 'headed', drive: person('buyer', 'browser'), headless: true });
    expect(r.check.status).toBe('valid');
    expect(r.cookies).toBeGreaterThan(0);
  });

  it('auto: the login steps with an injected secret reader (never the real Keychain); a second time, the still-valid session is kept', async () => {
    const { project, persona } = await setup();
    const asked: string[] = [];
    const resolveSecret = async (ref: string) => {
      asked.push(ref);
      return ACCOUNTS.supplier.password;
    };
    const r = await signIn({ project, env: env(), persona: persona('supplier'), mode: 'auto', resolveSecret });
    expect(r.check.status).toBe('valid');
    expect(r.alreadySignedIn).toBeUndefined();
    expect(asked).toEqual(['keychain:demo-test/supplier']);
    expect((await readSnapshot(persona('supplier').snapshot!))?.retake?.how).toBe('auto');
    // No password anywhere in the persona's files.
    for (const file of [persona('supplier').snapshot!, persona('supplier').statusFile]) expect(await readFile(file, 'utf8')).not.toContain(ACCOUNTS.supplier.password);
    // The buyer's cookie persists in the master: the second login finds the session still valid and runs no step.
    process.env.DS_TEST_BUYER_PASSWORD = ACCOUNTS.buyer.password;
    try {
      expect((await signIn({ project, env: env(), persona: persona('buyer'), mode: 'auto' })).alreadySignedIn).toBeUndefined();
      const again = await signIn({ project, env: env(), persona: persona('buyer'), mode: 'auto' });
      expect(again).toMatchObject({ alreadySignedIn: true, check: { status: 'valid' } });
    } finally {
      delete process.env.DS_TEST_BUYER_PASSWORD;
    }
    // Expired on the server: the saved session is checked as expired (a live check, nothing signed in).
    srv.expire('buyer');
    expect((await checkSavedSession({ project, env: env(), persona: persona('buyer') })).status).toBe('expired');
  });

  it('over a saved session (U3): --auto keeps a session-cookie persona without a step; the window opens signed in; closing it signed out keeps the valid snapshot', async () => {
    const { project, persona } = await setup();
    let asked = 0;
    const resolveSecret = async () => {
      asked++;
      return ACCOUNTS.supplier.password;
    };
    // The supplier's cookie is a session cookie: the master alone never holds it, the snapshot does.
    expect((await signIn({ project, env: env(), persona: persona('supplier'), mode: 'auto', resolveSecret })).check.status).toBe('valid');
    const saved = await readFile(persona('supplier').snapshot!, 'utf8');
    const again = await signIn({ project, env: env(), persona: persona('supplier'), mode: 'auto', resolveSecret });
    expect(again).toMatchObject({ alreadySignedIn: true, check: { status: 'valid' } });
    expect(again.cookies).toBeGreaterThan(0);
    expect(asked).toBe(1);
    // Kept as it is.
    expect(await readFile(persona('supplier').snapshot!, 'utf8')).toBe(saved);
    // The window shows the saved session (no form to fill)…
    let shown = '';
    const look = await signIn({
      project,
      env: env(),
      persona: persona('supplier'),
      mode: 'headed',
      headless: true,
      drive: async (page) => {
        shown = (await page.textContent('h1')) ?? '';
        await page.close();
      },
    });
    expect(shown).toBe(`Signed in as ${ACCOUNTS.supplier.name}`);
    expect(look).toMatchObject({ check: { status: 'valid' } });
    expect(look.kept).toBeUndefined();
    // …and a window that ends signed out (its cookies cleared) never replaces a snapshot that still works.
    const before = await readFile(persona('supplier').snapshot!, 'utf8');
    const out = await signIn({
      project,
      env: env(),
      persona: persona('supplier'),
      mode: 'headed',
      headless: true,
      drive: async (page) => {
        await page.context().clearCookies();
        await page.close();
      },
    });
    expect(out).toMatchObject({ kept: true, check: { status: 'valid' } });
    expect(await readFile(persona('supplier').snapshot!, 'utf8')).toBe(before);
    expect(existsSync(`${persona('supplier').snapshot!}.new`)).toBe(false);
    expect(await readStatus(persona('supplier').statusFile)).toMatchObject({ status: 'valid', by: 'login' });
    // Once the server forgot the session, the signed-out window is what is saved.
    srv.expire('supplier');
    const gone = await signIn({ project, env: env(), persona: persona('supplier'), mode: 'headed', headless: true, drive: async (page) => void (await page.close()) });
    expect(gone.check.status).toBe('expired');
    expect(gone.kept).toBeUndefined();
    expect(await readStatus(persona('supplier').statusFile)).toMatchObject({ status: 'expired', by: 'login' });
  });

  it('a first login that fails leaves no profile behind (U7); a cancelled one saves nothing (U4)', async () => {
    const { project, persona } = await setup();
    const f = persona('supplier');
    await expect(signIn({ project, env: env(), persona: f, mode: 'auto', resolveSecret: async () => 'wrong-secret-12' })).rejects.toThrow(/automated login of persona supplier/);
    expect(existsSync(f.profileDir!)).toBe(false);
    expect(existsSync(f.snapshot!)).toBe(false);
    // Cancelled while the window is open: the window closes, nothing is written.
    const controller = new AbortController();
    await expect(
      signIn({
        project,
        env: env(),
        persona: f,
        mode: 'headed',
        headless: true,
        signal: controller.signal,
        drive: async () => controller.abort(),
      }),
    ).rejects.toThrow(/cancelled|aborted/);
    expect(existsSync(f.snapshot!)).toBe(false);
    expect(existsSync(f.profileDir!)).toBe(false);
    expect(existsSync(join(f.profileDir!, 'SingletonLock'))).toBe(false);
  });

  it('auto: a failing login names the step, never the password; a storage_state persona keeps a snapshot and no profile', async () => {
    const { project, persona } = await setup({ buyer: { session: 'storage_state' } });
    await expect(signIn({ project, env: env(), persona: persona('supplier'), mode: 'auto', resolveSecret: async () => 'wrong-secret-77' })).rejects.toThrow(
      /^automated login of persona supplier \(env test\) failed: login step 5 \(wait_for text "Ada Supplier"\): timed out/,
    );
    process.env.DS_TEST_BUYER_PASSWORD = ACCOUNTS.buyer.password;
    try {
      const r = await signIn({ project, env: env(), persona: persona('buyer'), mode: 'auto' });
      expect(r.check.status).toBe('valid');
      expect(r.profileDir).toBeUndefined();
      expect(existsSync(personaPaths(home, 'northfield', ENV, 'buyer').profileDir)).toBe(false);
      expect((await readSnapshot(persona('buyer').snapshot!))?.cookies?.length).toBeGreaterThan(0);
    } finally {
      delete process.env.DS_TEST_BUYER_PASSWORD;
    }
  });

  it('refuses a master profile held by a running browser, and --auto without login steps', async () => {
    const { project, persona } = await setup({ buyer: { login: undefined } });
    const master = persona('supplier').profileDir!;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(master, { recursive: true });
    await writeFile(join(master, 'SingletonLock'), '');
    await expect(signIn({ project, env: env(), persona: persona('supplier'), mode: 'auto', resolveSecret: async () => 'x' })).rejects.toThrow(/is open in another browser/);
    await expect(signIn({ project, env: env(), persona: persona('buyer'), mode: 'auto' })).rejects.toThrow(/declares no login steps/);
  });
});

// The real window (a person's `retake login`, minus the person): only on a desktop, on demand.
describe.skipIf(process.env.RETAKE_TEST_HEADED !== '1')('retake login, a visible window (RETAKE_TEST_HEADED=1)', () => {
  it('a visible window, the page closed then the browser quit: both save a session a run can use', async () => {
    const { project, persona } = await setup();
    const a = await signIn({ project, env: env(), persona: persona('supplier'), mode: 'headed', drive: person('supplier', 'page') });
    expect(a.check.status).toBe('valid');
    const b = await signIn({ project, env: env(), persona: persona('buyer'), mode: 'headed', drive: person('buyer', 'browser') });
    expect(b.check.status).toBe('valid');
  }, 60_000);
});
