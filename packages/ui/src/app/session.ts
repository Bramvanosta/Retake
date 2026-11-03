/**
 * The page's session (L4.1, critique B9): the URL `retake ui` opens carries a one-time bootstrap code in its fragment
 * (`#c=…`, never sent to a server, a referrer or a log). The page removes it from the address bar and history at once,
 * exchanges it over a same-origin `POST /v1/session` for the session token, and keeps the token in sessionStorage (this
 * tab only; it survives a reload). A tab without a token — or whose token the server no longer knows — shows that the
 * session ended: no input ever asks for a token.
 */
const KEY = 'retake.token';

export class SessionEnded extends Error {
  constructor() {
    super('This Studio session ended: run `retake ui` again.');
    this.name = 'SessionEnded';
  }
}

function stored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * The bootstrap code of the URL, removed from the address bar (and so from history) before anything else runs. Any
 * `#c=` fragment goes, well-formed or not; a route (`#/p/…`) stays, so a reload keeps the screen.
 */
export function takeCodeFromUrl(): string | null {
  if (!location.hash.startsWith('#c=')) return null;
  const m = /^#c=([A-Za-z0-9_-]{16,128})$/.exec(location.hash);
  history.replaceState(null, '', location.pathname);
  return m ? m[1] : null;
}

/** The session token: a fresh code exchanged once, else the one this tab already holds; SessionEnded otherwise. */
export async function openSession(code: string | null): Promise<string> {
  if (code) {
    const res = await fetch('/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), credentials: 'omit', cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token === 'string') {
        try {
          sessionStorage.setItem(KEY, body.token);
        } catch {
          // Storage refused (private mode): the token lives as long as the page.
        }
        return body.token;
      }
    }
  }
  const token = stored();
  if (!token) throw new SessionEnded();
  return token;
}

export function endSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}
