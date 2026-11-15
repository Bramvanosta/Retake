/** Which page of an environment a URL is on: what an inspection and a recording start from (`url`). */
import { isPageOrigin, pageOrigins } from '@retake/core/run';
import { EngineError } from './errors.js';

/**
 * The page key and path of a URL on the exact origin of one of the environment's pages: the page whose base path is the
 * longest prefix of the URL's path. EngineError refused / invalid otherwise.
 */
export function pageOfUrl(url: string, pages: Record<string, string>, envName: string): { page: string; path: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EngineError('invalid', `url: not an absolute URL (give a page key and a path, or an http(s) URL of environment ${envName})`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EngineError('refused', `url: only http(s) URLs of environment ${envName}'s pages are inspected (not ${u.protocol})`);
  if (u.username || u.password) throw new EngineError('refused', 'url: a URL with credentials is never opened through an inspection');
  if (!isPageOrigin(url, pages)) {
    throw new EngineError(
      'refused',
      `url: its origin is not one of environment ${envName}'s pages (${pageOrigins(pages).join(', ') || 'none'}): an inspection opens only the environment's own origins — another port of localhost is another app`,
    );
  }
  let best: { page: string; base: string } | null = null;
  for (const [page, base] of Object.entries(pages)) {
    let b: URL;
    try {
      b = new URL(base);
    } catch {
      continue;
    }
    if (b.origin !== u.origin) continue;
    const prefix = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
    const under = u.pathname === b.pathname || u.pathname.startsWith(prefix);
    if (under && (!best || b.pathname.length > best.base.length)) best = { page, base: b.pathname.replace(/\/$/, '') };
  }
  if (!best) throw new EngineError('refused', `url: its path is under none of environment ${envName}'s pages`);
  const rest = u.pathname.slice(best.base.length);
  const path = `${rest.startsWith('/') ? rest : `/${rest}`}${u.search}${u.hash}`;
  return { page: best.page, path };
}
