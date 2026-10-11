// Tiny History-API router: deep links work on full page loads (the server falls back to the
// app shell for every path), in-app links use pushState.

import { useSyncExternalStore } from 'react';

const listeners = new Set();

function subscribe(cb) {
  listeners.add(cb);
  window.addEventListener('popstate', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('popstate', cb);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.searchParams, href };
}

export function navigate(to, { replace = false, scroll = true } = {}) {
  if (to === snapshot()) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
  for (const l of listeners) l();
  if (scroll) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

/** "/products/:slug" vs "/products/halo-beriti" → { slug: "halo-beriti" } | null */
export function matchPath(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** Renders the first route whose pattern matches; `fallback` otherwise. */
export function Routes({ routes, fallback: Fallback }) {
  const { pathname } = useLocation();
  for (const [pattern, Component] of routes) {
    const params = matchPath(pattern, pathname);
    if (params) return <Component params={params} key={pattern} />;
  }
  return Fallback ? <Fallback /> : null;
}

export function Link({ to, onClick, target, children, ...rest }) {
  return (
    <a
      href={to}
      target={target}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || target || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
