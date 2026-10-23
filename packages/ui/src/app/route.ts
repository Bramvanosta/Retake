/**
 * Hash routes of the Studio (one document; the server never sees the fragment): `#/` projects, `#/p/<slug>` a project,
 * `#/p/<slug>/readme` its README editor. A slug is whatever the address bar holds, percent-decoded and capped — the
 * server checks it (`project_get` refuses anything but a project slug); here it is only ever a text node or an
 * argument. `hrefTo` is the only way the app builds an `href` (the source lint test enforces it).
 */
export type Route =
  | { name: 'projects' }
  | { name: 'project'; slug: string }
  | { name: 'readme'; slug: string }
  | { name: 'not-found'; path: string };

const SLUG_MAX = 200;

function decode(s: string): string | null {
  try {
    const d = decodeURIComponent(s);
    return d.length > 0 && d.length <= SLUG_MAX ? d : null;
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/') return { name: 'projects' };
  const m = /^\/p\/([^/]+)(\/readme)?\/?$/.exec(path);
  const slug = m ? decode(m[1]) : null;
  if (m && slug !== null) return m[2] ? { name: 'readme', slug } : { name: 'project', slug };
  return { name: 'not-found', path: path.slice(0, SLUG_MAX) };
}

export function hrefTo(r: Route): string {
  switch (r.name) {
    case 'projects':
    case 'not-found':
      return '#/';
    case 'project':
      return `#/p/${encodeURIComponent(r.slug)}`;
    case 'readme':
      return `#/p/${encodeURIComponent(r.slug)}/readme`;
  }
}
