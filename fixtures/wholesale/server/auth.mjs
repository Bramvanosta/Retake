// Sign-in for the fixture's signed-in side (Demo Studio L1.6): the same console and shop served on two more ports
// (:4403 / :4404 by default) where every page needs an account. Invented accounts on `.example` domains, in-memory
// sessions, one cookie name on both apps (so a browser holds one account per host at a time: two personas need two
// browsers), and a helper to expire sessions on purpose (`POST /api/auth/expire`).

import { randomBytes } from 'node:crypto';
import { sendText } from './http.mjs';

/** The accounts (invented; passwords documented in the fixture README — the fixture project reads them from env). */
export const ACCOUNTS = {
  supplier: { app: 'console', email: 'maja@northfield.example', password: 'roast-lot-2026', name: 'Maja Lindqvist' },
  buyer: { app: 'shop', email: 'orders@demo-cafe.example', password: 'filter-bloom-2026', name: 'Demo Café' },
};

export const SESSION_COOKIE = 'northfield_session';
/** The shop remembers its café for a week; the console's cookie lasts as long as the browser (no expiry). */
const SHOP_MAX_AGE_S = 7 * 24 * 3600;

const APP_LOOK = {
  console: { title: 'Northfield · Supplier console', heading: 'Sign in to the supplier console', ink: '#6e1f2b', paper: '#f7f3ee' },
  shop: { title: 'Northfield · Specialty coffee for cafés', heading: 'Sign in to your café account', ink: '#6e1f2b', paper: '#f7f3ee' },
};

/** In-memory sessions, shared by both sides of the fixture (a restart signs everyone out). */
export class Sessions {
  #byToken = new Map();

  create(persona) {
    const token = randomBytes(18).toString('base64url');
    this.#byToken.set(token, { persona, app: ACCOUNTS[persona].app, created: Date.now() });
    return token;
  }

  get(token) {
    return token ? (this.#byToken.get(token) ?? null) : null;
  }

  delete(token) {
    this.#byToken.delete(token);
  }

  /** Sign every account out, or one persona's; returns how many sessions ended. */
  expire(persona) {
    let n = 0;
    for (const [token, s] of this.#byToken) {
      if (!persona || s.persona === persona) {
        this.#byToken.delete(token);
        n++;
      }
    }
    return n;
  }
}

function cookieOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}

/** The persona signed in to `app` by this request's cookie, else null. */
export function signedIn(req, sessions, app) {
  const s = sessions.get(cookieOf(req));
  return s && s.app === app ? s.persona : null;
}

/** A path to come back to after signing in: same-site paths only (never `//host`). */
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderSignIn(app, { error, next = '/', email = '' } = {}) {
  const look = APP_LOOK[app];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${esc(look.title)}</title>
<link rel="icon" href="/favicon.svg">
<style>
  html,body{margin:0;background:${look.paper};font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#2b2420}
  main{max-width:380px;margin:12vh auto 0;padding:36px 40px;background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(43,36,32,.12)}
  h1{font-size:22px;margin:0 0 4px;color:${look.ink}} p.sub{margin:0 0 24px;color:#6f6259;font-size:14px}
  label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
  input{box-sizing:border-box;width:100%;font:inherit;padding:10px 12px;border:1px solid #d8cfc7;border-radius:8px}
  button{margin-top:22px;width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:8px;background:${look.ink};color:#fff;cursor:pointer}
  .error{background:#fbe9e7;color:#8a2a1c;padding:10px 12px;border-radius:8px;font-size:14px;margin-bottom:8px}
</style>
</head>
<body>
<main>
  <h1>${esc(look.heading)}</h1>
  <p class="sub">Northfield</p>
  ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/sign-in">
    <input type="hidden" name="next" value="${esc(safeNext(next))}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" value="${esc(email)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) break;
    chunks.push(c);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * `/sign-in` (GET the form, POST the credentials → 303 to `next` with the session cookie, or the form again with an
 * error) and `/sign-out`. Returns false for other paths.
 */
export async function handleSignIn(req, res, url, sessions, app) {
  const html = (status, body, headers = {}) => sendText(res, status, 'text/html; charset=utf-8', body, { 'cache-control': 'no-store', ...headers });
  if (url.pathname === '/sign-in' && req.method === 'POST') {
    const form = await readForm(req);
    const email = (form.get('email') ?? '').trim().toLowerCase();
    const persona = Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].app === app && ACCOUNTS[k].email === email && ACCOUNTS[k].password === form.get('password'));
    if (!persona) return html(401, renderSignIn(app, { error: 'Wrong email or password.', next: form.get('next') ?? '/', email })), true;
    const token = sessions.create(persona);
    const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${app === 'shop' ? `; Max-Age=${SHOP_MAX_AGE_S}` : ''}`;
    res.writeHead(303, { location: safeNext(form.get('next')), 'set-cookie': cookie, 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
    return true;
  }
  if (url.pathname === '/sign-in' && (req.method === 'GET' || req.method === 'HEAD')) {
    html(200, renderSignIn(app, { next: url.searchParams.get('next') ?? '/' }));
    return true;
  }
  if (url.pathname === '/sign-out') {
    sessions.delete(cookieOf(req));
    res.writeHead(302, { location: '/sign-in', 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0`, 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
    return true;
  }
  return false;
}

/** A page of the signed-in side without a session of its app: to the sign-in page, back here afterwards. */
export function redirectToSignIn(res, url) {
  res.writeHead(302, { location: `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store', 'content-length': 0 });
  res.end();
}
