import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiFailure extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiFailure(res.status, err?.code ?? 'http_error', err?.message ?? `${method} ${path} failed (${res.status})`, err?.details);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/**
 * Fetches `path` (null = skip) and re-fetches when it changes.
 * @returns {{ data: any, error: Error | null, loading: boolean, reload: () => Promise<void>, setData: (v: any) => void }}
 */
export function useApi(path) {
  const [state, setState] = useState({ data: undefined, error: null, loading: path !== null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (path === null) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api.get(path);
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  const setData = useCallback((data) => setState((s) => ({ ...s, data: typeof data === 'function' ? data(s.data) : data })), []);
  return { ...state, reload: load, setData };
}

/**
 * A live list (L2.11 fixture): `reload` every `ms` without a loading state; the ids that arrive after the first load
 * are "fresh" for a few seconds (pages highlight them). Returns the Set of fresh ids.
 */
export function useLiveList(reload, data, ms = 1000, freshMs = 6000) {
  const seen = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());
  useEffect(() => {
    const id = setInterval(() => reload(), ms);
    return () => clearInterval(id);
  }, [reload, ms]);
  useEffect(() => {
    if (!data) return undefined;
    const ids = data.map((q) => q.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return undefined;
    }
    const added = ids.filter((id) => !seen.current.has(id));
    for (const id of ids) seen.current.add(id);
    if (added.length === 0) return undefined;
    setFresh((f) => new Set([...f, ...added]));
    const timer = setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), freshMs);
    return () => clearTimeout(timer);
  }, [data, freshMs]);
  return fresh;
}
