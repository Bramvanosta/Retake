/**
 * The product's font registry (font-registry.ts): the npm registry, https://registry.npmjs.org — the one network host of
 * a font fetch. Requests go through `node:https` with an agent of their own (never the global agent, so no proxy
 * variable — HTTPS_PROXY, NODE_USE_ENV_PROXY — reroutes them), `accept-encoding: identity`, no redirect followed (a 3xx
 * is refused), a 200 only, the body capped.
 *
 * Two test-only switches, read from the environment the composition root hands (EnginePorts `env`):
 * - `RETAKE_UNSAFE_TEST_NPM_REGISTRY=http://127.0.0.1:<port>` (or `http://[::1]:<port>`): a loopback registry instead,
 *   matched by one exact pattern (no `localhost`, no other address, no path); anything else is refused, never ignored.
 *   `retake doctor` warns when it is set; the approval form, the answer and the store's record name it.
 * - `RETAKE_TEST_NO_FONT_FETCH=1` (set by the suite's vitest.config.ts): no fetch at all unless the hatch names a
 *   loopback registry — the suite can never reach the real registry by accident.
 */
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { EngineError } from '../errors.js';
import { FONTSOURCE_LAYOUT } from './fontsource-layout.js';
import type { FontRegistry } from './font-registry.js';

export const NPM_TEST_REGISTRY_ENV = 'RETAKE_UNSAFE_TEST_NPM_REGISTRY';
export const NO_FONT_FETCH_ENV = 'RETAKE_TEST_NO_FONT_FETCH';
/**
 * The HTTPS agent's options: no keep-alive, and certificate checks on whatever NODE_TLS_REJECT_UNAUTHORIZED says (an
 * explicit `rejectUnauthorized: true` is not switched off by it).
 */
export const HTTPS_AGENT_OPTIONS = Object.freeze({ keepAlive: false, rejectUnauthorized: true });
/** The test hatch's only accepted form: plain http to a loopback address and a port, nothing else. */
export const NPM_TEST_REGISTRY_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/;

/** The test hatch as set: its loopback URL, `invalid` when it is set to anything else, null when unset. */
export function npmTestRegistry(env: Record<string, string | undefined>): { url: string } | 'invalid' | null {
  const v = env[NPM_TEST_REGISTRY_ENV];
  if (v === undefined || v === '') return null;
  const m = NPM_TEST_REGISTRY_RE.exec(v);
  return m && Number(m[2]) <= 65535 ? { url: v } : 'invalid';
}

/** The agent of one request: its own (never the global one, which proxy variables may reroute), TLS checks pinned on. */
export function registryAgent(https: boolean): HttpAgent {
  return https ? new HttpsAgent(HTTPS_AGENT_OPTIONS) : new HttpAgent({ keepAlive: false });
}

function getOnce(base: string, path: string, o: { max: number; signal: AbortSignal }): Promise<Buffer> {
  const url = new URL(base + path);
  const https = url.protocol === 'https:';
  const request = https ? httpsRequest : httpRequest;
  const agent = registryAgent(https);
  return new Promise<Buffer>((resolve, reject) => {
    const fail = (e: EngineError) => {
      req.destroy();
      reject(e);
    };
    const req = request(url, { method: 'GET', agent, signal: o.signal, headers: { accept: 'application/json, application/octet-stream', 'accept-encoding': 'identity', 'user-agent': 'retake' } }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) return fail(new EngineError('unavailable', `${url.host} answered ${status} (a redirect) for ${path}: redirects are never followed`));
      if (status === 404) return fail(new EngineError('not_found', `${url.host} has no ${path} (404)`));
      if (status !== 200) return fail(new EngineError('unavailable', `${url.host} answered ${status} for ${path}`));
      const enc = res.headers['content-encoding'];
      if (enc && enc !== 'identity') return fail(new EngineError('unavailable', `${url.host} answered with content-encoding ${enc} for ${path}`));
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.max) return fail(new EngineError('refused', `${path} is ${declared} bytes, more than the ${o.max} a font fetch reads`));
      const chunks: Buffer[] = [];
      let got = 0;
      res.on('data', (c: Buffer) => {
        got += c.length;
        if (got > o.max) return fail(new EngineError('refused', `${path} is more than the ${o.max} bytes a font fetch reads`));
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (e) => reject(new EngineError('unavailable', `${url.host}: ${e.message}`)));
    });
    req.on('error', (e) => reject(o.signal.aborted ? new EngineError('unavailable', `${url.host}: no answer in time for ${path}`) : e instanceof EngineError ? e : new EngineError('unavailable', `${url.host}: ${e.message}`)));
    req.end();
  });
}

/** The npm registry, or the test hatch's loopback one (see the module comment). */
export function npmFontRegistry(env: Record<string, string | undefined>): FontRegistry {
  const hatch = npmTestRegistry(env);
  if (hatch === 'invalid') {
    const problem = `${NPM_TEST_REGISTRY_ENV} is set to something other than http://127.0.0.1:<port> or http://[::1]:<port>: no font is fetched — unset it (it is for the test suite only)`;
    return { base: FONTSOURCE_LAYOUT.registry, test: false, problem, get: () => Promise.reject(new EngineError('refused', problem)) };
  }
  if (hatch) return { base: hatch.url, test: true, get: (path, o) => getOnce(hatch.url, path, o) };
  if (env[NO_FONT_FETCH_ENV] === '1') {
    const problem = `${NO_FONT_FETCH_ENV} is set (the test suite's guard): no font is fetched from ${FONTSOURCE_LAYOUT.registry}`;
    return { base: FONTSOURCE_LAYOUT.registry, test: false, problem, get: () => Promise.reject(new EngineError('refused', problem)) };
  }
  return { base: FONTSOURCE_LAYOUT.registry, test: false, get: (path, o) => getOnce(FONTSOURCE_LAYOUT.registry, path, o) };
}
