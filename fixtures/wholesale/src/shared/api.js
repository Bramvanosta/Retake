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
