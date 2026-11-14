/**
 * `auth: {persona}` of an http hook (hotfix v0.2.3): what a persona's saved session sends with a request — the cookies
 * its browser holds for the URL and, for a product signed in with Firebase Auth, the ID token of its signed-in user
 * (`Authorization: Bearer …`). Read from the persona's own browser (a run's realm, or the headless browser the hook
 * commands open on a copy of its session): never from the files of the Retake home directly.
 *
 * The Firebase SDK keeps its user in IndexedDB (`firebaseLocalStorageDb`, default persistence) or in localStorage
 * (`firebase:authUser:<api key>:<app>`), with an ID token valid one hour. The token is read on an empty document of the
 * page's origin (nothing requested from the product); when it is missing or about to expire, the product's page is
 * loaded so its SDK refreshes it, and read again.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { loginMatchers, matchLoginUrl } from '@retake/core/environment';
import { personaAuthOriginProblem } from '@retake/core/scenario';
import type { ResolvedPersona } from '@retake/core/environment';
import { RunnerError, errorMessage } from './errors.js';
import { networkIdle } from './network.js';
import { sleep, wallNow } from './util.js';

/** What a persona's session sends with a request (@retake/hooks PersonaRequestAuth). */
export interface PersonaRequestAuth {
  authorization?: string;
  cookie?: string;
}

/** A token closer than this to its expiry is refreshed first (a hook, then its rollback, may come minutes later). */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How long the product's page gets to refresh an expired token. */
const REFRESH_WAIT_MS = 10_000;

interface FirebaseUser {
  token: string;
  /** ms since the epoch; undefined when the record does not say. */
  expires?: number;
}

/* c8 ignore start */
/** Runs in the page (serialised by Playwright: self-contained): the Firebase users of its origin's storage. */
async function firebaseUsersInPage(): Promise<Array<{ token: string; expires?: number }>> {
  const out: Array<{ token: string; expires?: number }> = [];
  const take = (v: unknown) => {
    const m = v && typeof v === 'object' ? (v as { stsTokenManager?: { accessToken?: unknown; expirationTime?: unknown } }).stsTokenManager : undefined;
    if (m && typeof m.accessToken === 'string' && m.accessToken) {
      out.push({ token: m.accessToken, ...(typeof m.expirationTime === 'number' ? { expires: m.expirationTime } : {}) });
    }
  };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('firebase:authUser:')) {
        try {
          take(JSON.parse(localStorage.getItem(k) ?? 'null'));
        } catch {
          /* not JSON */
        }
      }
    }
  } catch {
    /* no localStorage on this document */
  }
  const names = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((d) => d.name) : ['firebaseLocalStorageDb'];
  if (!names.includes('firebaseLocalStorageDb')) return out;
  await new Promise<void>((done) => {
    const req = indexedDB.open('firebaseLocalStorageDb');
    req.onerror = () => done();
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
        db.close();
        return done();
      }
      const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
      all.onerror = () => {
        db.close();
        done();
      };
      all.onsuccess = () => {
        for (const r of all.result as Array<{ fbase_key?: unknown; value?: unknown }>) {
          if (typeof r?.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:')) take(r.value);
        }
        db.close();
        done();
      };
    };
  });
  return out;
}
/* c8 ignore stop */

/** The Firebase user of an origin, read on an empty document of it (nothing is requested from the product). */
async function storedUser(context: BrowserContext, origin: string): Promise<FirebaseUser | undefined> {
  const page = await context.newPage();
  try {
    await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title></title>' }));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    return pick(await page.evaluate(firebaseUsersInPage));
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** The freshest of several users (one app per origin, in practice). */
function pick(users: FirebaseUser[]): FirebaseUser | undefined {
  return users.sort((a, b) => (b.expires ?? 0) - (a.expires ?? 0))[0];
}

const fresh = (u: FirebaseUser | undefined): boolean => u !== undefined && (u.expires === undefined || u.expires - Date.now() > TOKEN_MARGIN_MS);

/**
 * Loads the product's page so its SDK refreshes the token, then reads it until it is fresh. A page that lands on the
 * persona's sign-in page means the session expired: that is said, with the command that signs in again.
 */
async function refreshedUser(context: BrowserContext, url: string, persona: ResolvedPersona, envPages: Record<string, string>, relogin: string): Promise<FirebaseUser | undefined> {
  const page: Page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await networkIdle(page, { timeoutMs: REFRESH_WAIT_MS });
    if (matchLoginUrl(page.url(), loginMatchers(persona.loginPatterns, envPages))) {
      throw new RunnerError(`persona ${persona.name}: its saved session lands on the sign-in page (${page.url().split(/[?#]/)[0]}): it expired — sign in again: ${relogin}`);
    }
    const until = wallNow() + REFRESH_WAIT_MS;
    let user = pick(await page.evaluate(firebaseUsersInPage));
    while (!fresh(user) && wallNow() < until) {
      await sleep(250);
      user = pick(await page.evaluate(firebaseUsersInPage));
    }
    return user;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export interface PersonaAuthSource {
  persona: ResolvedPersona;
  /** The persona's browser context (a run's realm, or the hook commands' browser on a copy of its session). */
  context: () => Promise<BrowserContext>;
  /** The environment's pages: the persona's first page is where its product keeps its Firebase user. */
  envPages: Record<string, string>;
  /** The command that signs the persona in again, for the messages. */
  relogin: string;
  /**
   * Trust `mcp` (core agent-trust personaAuthOriginProblem): the only origins the session is read for — the persona's
   * own pages'. A URL elsewhere is refused before its cookies or token are read. Absent: any URL (a person's own run).
   */
  origins?: readonly string[];
}

/**
 * What persona `src.persona`'s session sends with a request to `url`: its cookies for that URL (`Cookie`), and the ID
 * token of the Firebase user its product keeps in the persona's first page's origin (else the request's origin),
 * refreshed when it is about to expire. Tokens are cached per source until their margin.
 */
export function personaAuthReader(src: PersonaAuthSource): (url: string) => Promise<PersonaRequestAuth> {
  let cached: FirebaseUser | undefined;
  return async (url) => {
    if (src.origins) {
      const problem = personaAuthOriginProblem(src.persona.name, url, src.origins);
      if (problem) throw new RunnerError(problem);
    }
    const context = await src.context();
    const cookies = await context.cookies(url);
    const out: PersonaRequestAuth = {};
    if (cookies.length) out.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const first = src.persona.pages[0] ?? Object.keys(src.envPages)[0];
    const appUrl = first !== undefined ? src.envPages[first] : url;
    let origin: string;
    try {
      origin = new URL(appUrl).origin;
    } catch {
      origin = new URL(url).origin;
    }
    if (!fresh(cached)) {
      try {
        cached = await storedUser(context, origin);
        // A stale token (or none read yet, though the session has one somewhere): the product's own page refreshes it.
        if (cached && !fresh(cached)) cached = await refreshedUser(context, appUrl, src.persona, src.envPages, src.relogin);
      } catch (e) {
        if (e instanceof RunnerError) throw e;
        throw new RunnerError(`persona ${src.persona.name}: its session could not be read: ${errorMessage(e)}`);
      }
      if (cached?.expires !== undefined && cached.expires <= Date.now()) {
        throw new RunnerError(`persona ${src.persona.name}: the ID token of its session expired and its page did not refresh it — sign in again: ${src.relogin}`);
      }
    }
    if (cached) out.authorization = `Bearer ${cached.token}`;
    return out;
  };
}
