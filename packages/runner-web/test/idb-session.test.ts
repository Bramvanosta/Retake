/**
 * Hotfix v0.2.2 — a product that keeps its sign-in in IndexedDB (the Firebase SDK's default): a single-page app whose
 * sign-in is a request (no navigation), stores its user in IndexedDB — no cookie, nothing in localStorage — and then
 * routes away; a signed-out page routes itself to the sign-in page. In a real Chromium, with a Retake home per test.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { resolvePersonas } from '@retake/core';
import type { LoadedProject, PersonaConfig } from '@retake/core';
import { checkSavedSession, launchTarget, readSnapshot, signIn } from '../src/index.js';
import { applyStorageState } from '../src/session.js';
import type { SignInOptions, StorageStateFile } from '../src/index.js';
import { makeProject, tempDir } from './helpers.js';

const PASSWORD = 'idb-pass-5521';
/** How long the sign-in request takes: longer than a tab that closes right after its last step. */
const SIGN_IN_MS = 700;

const APP = `<!doctype html><html><head><title>App</title></head><body><h1 id="h">…</h1>
<form id="f" hidden><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>
<script>
const open = () => new Promise((res, rej) => { const r = indexedDB.open('authDb', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('users', { keyPath: 'fbase_key' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const user = async () => { const db = await open(); return new Promise((res) => { const q = db.transaction('users').objectStore('users').get('user'); q.onsuccess = () => res(q.result); }); };
const save = async (value) => { const db = await open(); return new Promise((res) => { const t = db.transaction('users', 'readwrite'); t.objectStore('users').put({ fbase_key: 'user', value }); t.oncomplete = res; }); };
const render = async () => {
  const u = await user();
  const signIn = location.pathname === '/login';
  if (!u && !signIn) { history.replaceState({}, '', '/login'); return render(); }
  document.getElementById('f').hidden = !signIn;
  document.getElementById('h').textContent = signIn ? 'Sign in' : 'Signed in as ' + u.value.name + ' since ' + u.value.at.getFullYear();
};
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/sign-in', { method: 'POST', body: new URLSearchParams(new FormData(e.target)) });
  if (!r.ok) { document.getElementById('h').textContent = 'Wrong email or password'; return; }
  await save({ name: (await r.json()).name, at: new Date(), token: new Uint8Array([1, 2, 3]) });
  history.pushState({}, '', '/'); render();
});
render();
</script></body></html>`;

let server: Server;
let url = '';
let home = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/sign-in' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ok = new URLSearchParams(body).get('password') === PASSWORD;
        setTimeout(() => res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(ok ? '{"name":"Ada"}' : '{}'), SIGN_IN_MS);
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(APP);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  home = await tempDir('ds-idb-home-');
  process.env.RETAKE_HOME = home;
});

const ENV = 'test';
const env = () => ({ name: ENV, pages: { app: url } });

/** The login steps as a product's author writes them first: they end on the key press, with no wait. */
const steps = (password: string): PersonaConfig['login'] => [
  { open: 'app:/login' },
  { type: { into: { label: 'Email' }, text: 'ada@example.test' } },
  { type: { into: { label: 'Password' }, text: password } },
  { press: 'Enter' },
];

async function setup(persona: Partial<PersonaConfig> = {}, password = PASSWORD): Promise<{ project: LoadedProject; persona: SignInOptions['persona'] }> {
  const project = makeProject(await tempDir('ds-idb-'), { app: url });
  project.config.auth = { login_url: '/login', personas: { ada: { pages: ['app'], login: steps(password), ...persona } } };
  return { project, persona: resolvePersonas(project, ENV).find((p) => p.name === 'ada')! };
}

/** What a fresh browser with `state` applied shows on the app's home page. */
async function homeWith(state: StorageStateFile): Promise<string> {
  const t = launchTarget({}, { headless: true });
  const context = await chromium.launchPersistentContext(await tempDir('ds-idb-profile-'), { headless: true, executablePath: t.executablePath, channel: t.channel });
  try {
    await applyStorageState(context, state);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${url}/`);
    await page.waitForFunction(() => document.getElementById('h')?.textContent !== '…');
    return (await page.textContent('#h')) ?? '';
  } finally {
    await context.close();
  }
}

describe('a sign-in kept in IndexedDB (hotfix v0.2.2)', () => {
  it('auto, a profile persona without a check: the tab waits for the sign-in to finish; the saved profile is signed in', async () => {
    const { project, persona } = await setup();
    const r = await signIn({ project, env: env(), persona, mode: 'auto' });
    expect(r.check.status).toBe('unchecked');
    expect(r.cookies).toBe(0);
    // The way a run sees it (a copy of the profile): signed in.
    const seen = await checkSavedSession({ project, env: env(), persona: { ...persona, check: { url: 'app:/', expect_text: 'Signed in as Ada' } } });
    expect(seen).toMatchObject({ status: 'valid' });
  });

  it('auto, a storage_state persona: the snapshot holds the IndexedDB databases and a fresh browser restores them (a Date and bytes included)', async () => {
    const { project, persona } = await setup({ session: 'storage_state' });
    const r = await signIn({ project, env: env(), persona, mode: 'auto' });
    expect(r.profileDir).toBeUndefined();
    const snapshot = (await readSnapshot(persona.snapshot!))!;
    expect(snapshot.cookies).toEqual([]);
    const origin = snapshot.origins!.find((o) => o.origin === url)!;
    expect((origin.indexedDB as Array<{ name: string }>).map((d) => d.name)).toEqual(['authDb']);
    expect(await homeWith(snapshot)).toBe(`Signed in as Ada since ${new Date().getFullYear()}`);
    // Without its IndexedDB the same snapshot is signed out: it is what carries the session.
    expect(await homeWith({ cookies: snapshot.cookies, origins: snapshot.origins!.map(({ indexedDB: _, ...o }) => o) })).toBe('Sign in');
    expect((await checkSavedSession({ project, env: env(), persona: { ...persona, check: { url: 'app:/', expect_text: 'Signed in as Ada' } } })).status).toBe('valid');
  });

  it('auto, a sign-in that does not hold (a wrong password, no check): refused, saying where a new browser lands; nothing is left behind', async () => {
    const { project, persona } = await setup({}, 'not-the-password');
    const failure = await signIn({ project, env: env(), persona, mode: 'auto' }).catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^automated login of persona ada \(env test\): the steps ran, but a new browser with the saved session lands on the sign-in page \(http:\/\/127\.0\.0\.1:\d+\/login\) — nothing was saved \(no cookie, no localStorage\)/,
    );
    expect((failure as Error).message).toContain('retake login northfield --env test --persona ada');
    expect((failure as Error).message).not.toContain('not-the-password');
    expect(existsSync(persona.snapshot!)).toBe(false);
    expect(existsSync(persona.profileDir!)).toBe(false);
  });

  it('headed (driven), a storage_state persona: the window’s IndexedDB is read with its localStorage', async () => {
    const { project, persona } = await setup({ session: 'storage_state', login: undefined });
    const drive = async (page: Page): Promise<void> => {
      await page.fill('input[name=email]', 'ada@example.test');
      await page.fill('input[name=password]', PASSWORD);
      await page.click('button[type=submit]');
      await page.getByText('Signed in as Ada').waitFor();
      await page.waitForTimeout(2000); // one reading of the window (every 1.5 s)
      await page.close();
    };
    await signIn({ project, env: env(), persona, mode: 'headed', headless: true, url: `${url}/login`, drive });
    const snapshot = (await readSnapshot(persona.snapshot!))!;
    expect(await homeWith(snapshot)).toBe(`Signed in as Ada since ${new Date().getFullYear()}`);
  });
});
