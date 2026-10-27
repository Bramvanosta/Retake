/**
 * The security gate of the engine's local HTTP servers (L4.1; BACKLOG guard-rail "engine API security contract"),
 * applied to every request before any routing, in a fixed order (critique B3), each layer answering on its own:
 *
 * 1. Host — exactly `127.0.0.1:<port>` or `localhost:<port>`, else 421 (DNS rebinding: a name an attacker resolves to
 *    127.0.0.1 carries its own Host; this check is what stops it). A server that takes no request from a web page at
 *    all (`refuseBrowsers`: MCP over HTTP) then refuses, 403, any request carrying an Origin header or a Sec-Fetch-*
 *    header — save `Sec-Fetch-Mode: cors` alone, which Node's fetch (the MCP SDK's client, Claude Code) sends on every
 *    request. A second line, not the first: browsers send an Origin on every POST and cross-origin fetch, and their
 *    Sec-Fetch-Site / -Mode / -Dest set from secure contexts only (a plain-http page sends no Sec-Fetch-*; its no-cors
 *    GET carries neither header — and no token: layer 4).
 * 2. Origin / Sec-Fetch-Site — a present Origin must be this server's own (`http://127.0.0.1:<port>` or
 *    `http://localhost:<port>`) — or `null` on a server that takes `allowNullOrigin` (L4.5: the Studio's player origin,
 *    whose only client is the sandboxed preview frame, an opaque origin) — and on API routes a present Sec-Fetch-Site
 *    must be `same-origin` or `none`, else 403.
 *    Pages of another port of 127.0.0.1 (a filmed local app) are *same-site* with this server: the Sec-Fetch-Site
 *    check is what stops their `no-cors` fetches and `<form>` posts, which do reach the server.
 * 3. Route and method — an unknown path 404; OPTIONS and any method the route does not take 405 (no CORS preflight
 *    ever succeeds: there is never an `Access-Control-Allow-*` header).
 * 4. Token — `Authorization: Bearer <token>` on the routes that need it, compared in constant time, else 401.
 * 5. Content type and size — a POST must be `application/json` (a `<form>` cannot send it), else 415; a declared
 *    Content-Length above the route's cap 413 (`readBody` enforces the cap on the bytes too).
 *
 * Nothing here logs a token, a header or a body.
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { bearerToken, secretEquals } from './token.js';

/** Version of the engine's HTTP API (`/v1`). */
export const ENGINE_HTTP_API = 1;

/** What a route accepts. */
export interface RouteSpec {
  /** Methods it answers (never OPTIONS). */
  methods: ReadonlyArray<'GET' | 'HEAD' | 'POST' | 'DELETE'>;
  /** The bearer token is required. */
  token: boolean;
  /** An API route (not a static document): a present Sec-Fetch-Site must be same-origin or none. */
  api: boolean;
  /** A POST's body cap in bytes (its Content-Type must be application/json). */
  maxBody?: number;
}

export interface GateRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

export type GateStatus = 400 | 401 | 403 | 404 | 405 | 413 | 415 | 421;

export type GateResult =
  | { ok: true; path: string; route: RouteSpec }
  | { ok: false; status: GateStatus; code: string; message: string; allow?: string };

export interface GateOptions {
  /** The port the server listens on. */
  port: number;
  /** The bearer token of this server. */
  token: string;
  /** The route of a path (no query string), undefined when there is none. */
  route(path: string): RouteSpec | undefined;
  /** Refuse every request a browser could send (fromBrowser): 403. */
  refuseBrowsers?: boolean;
  /**
   * Accept `Origin: null` too (L4.5: the player origin — its pages are the sandboxed preview frame, whose fetches carry
   * `Origin: null`; what proves a right there is the capability in the path, never the Origin).
   */
  allowNullOrigin?: boolean;
}

/**
 * A request that says a browser sent it: it carries an Origin header, or a Sec-Fetch-* header other than
 * `Sec-Fetch-Mode: cors` — the one metadata header Node's fetch (undici) adds to every request, alone. Browsers send an
 * Origin on every POST and cross-origin fetch, and Sec-Fetch-Site, -Mode and -Dest together from secure contexts; a
 * page of a plain-http site sends no Sec-Fetch-* (its no-cors GET carries neither header): the Host check and the token
 * are what keep such a page out, this one is a second line.
 */
export function fromBrowser(headers: IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((k) => k === 'origin' || (k.startsWith('sec-fetch-') && !(k === 'sec-fetch-mode' && headers[k] === 'cors')));
}

/** The Host values this server answers. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** The Origin values this server accepts. */
export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((h) => `http://${h}`);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function refuse(status: GateStatus, code: string, message: string, allow?: string): GateResult {
  return { ok: false, status, code, message, ...(allow ? { allow } : {}) };
}

/** `application/json`, with or without parameters (charset). */
export function isJsonType(value: string | undefined): boolean {
  return /^application\/json\s*(;.*)?$/i.test(value ?? '');
}

/** The gate: what to answer before any handler runs (see the module comment for the order). */
export function checkRequest(req: GateRequest, o: GateOptions): GateResult {
  const host = header(req.headers, 'host')?.toLowerCase();
  if (!host || !allowedHosts(o.port).includes(host)) return refuse(421, 'misdirected', `this server answers only http://127.0.0.1:${o.port}/`);
  if (o.refuseBrowsers && fromBrowser(req.headers)) return refuse(403, 'browser', 'this server takes no request from a web page');

  const origin = header(req.headers, 'origin');
  if (origin !== undefined && !(o.allowNullOrigin && origin === 'null') && !allowedOrigins(o.port).includes(origin)) return refuse(403, 'cross_origin', 'a request from another page is refused');
  const url = req.url ?? '';
  if (!url.startsWith('/')) return refuse(400, 'bad_request', 'the request target must be a path');
  const path = url.split('?')[0];
  const route = o.route(path);
  const site = header(req.headers, 'sec-fetch-site');
  if ((route === undefined || route.api) && site !== undefined && site !== 'same-origin' && site !== 'none') {
    return refuse(403, 'cross_site', 'a request from another page is refused');
  }

  if (!route) return refuse(404, 'not_found', 'no such route');
  const method = (req.method ?? '').toUpperCase();
  if (!(route.methods as readonly string[]).includes(method)) return refuse(405, 'method', `${method || 'this method'} is not accepted here`, route.methods.join(', '));

  if (route.token) {
    const token = bearerToken(header(req.headers, 'authorization'));
    if (token === undefined || !secretEquals(token, o.token)) return refuse(401, 'unauthorized', 'this Studio session ended or the request carries no valid token');
  }

  if (method === 'POST') {
    if (!isJsonType(header(req.headers, 'content-type'))) return refuse(415, 'content_type', 'the body must be application/json');
    const length = Number(header(req.headers, 'content-length') ?? 0);
    if (route.maxBody !== undefined && Number.isFinite(length) && length > route.maxBody) return refuse(413, 'too_large', `the body is over ${route.maxBody} bytes`);
  }
  return { ok: true, path, route };
}

/** A body over its cap (413). */
export class BodyTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`the body is over ${max} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Bytes of an unwanted body a server still reads before answering, so the client reads the answer instead of a
 * connection reset; beyond, the connection is dropped.
 */
export const BODY_DRAIN_MAX = 8 * 1024 * 1024;

/** Read and discard the rest of a body (up to `limit` bytes): true once it ended, false when the request was dropped. */
export function drainBody(req: IncomingMessage, limit = BODY_DRAIN_MAX): Promise<boolean> {
  if (req.complete) return Promise.resolve(true);
  return new Promise((resolve) => {
    let seen = 0;
    req.on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > limit) {
        req.destroy();
        resolve(false);
      }
    });
    req.on('end', () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('close', () => resolve(req.complete));
  });
}

/**
 * The request body, at most `max` bytes. Beyond, the rest is drained (`drainBody`) and BodyTooLargeError thrown once
 * the request ended — the caller then answers 413 to a client that is listening.
 */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= max) {
        chunks.push(c);
        return;
      }
      req.off('data', onData);
      req.off('end', onEnd);
      chunks.length = 0;
      void drainBody(req).then(() => reject(new BodyTooLargeError(max)));
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

/**
 * The Studio's Content-Security-Policy: scripts, styles, fonts and fetches from this server only, no inline script or
 * style, no eval, no frame around it, no form target, no base URL.
 */
export const STUDIO_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A loopback origin a Studio page may frame (L4.5: the player origin) — nothing else is ever put in `frame-src`. */
export const FRAME_SRC_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/**
 * The Studio CSP, with `frame-src <frameSrc>` when the Studio frames its player origin (L4.5): the one origin a Studio
 * page may embed, which is also what stops the frame from navigating itself anywhere else (CSP has no `navigate-to`:
 * the parent's `frame-src` covers its child's navigations). Throws on anything but `http://127.0.0.1:<port>`.
 */
export function studioCsp(frameSrc?: string): string {
  if (frameSrc === undefined) return STUDIO_CSP;
  if (!FRAME_SRC_RE.test(frameSrc)) throw new Error('frame-src must be http://127.0.0.1:<port>');
  return STUDIO_CSP.replace("font-src 'self';", `font-src 'self'; frame-src ${frameSrc};`);
}

/**
 * Headers of every response: the CSP and its companions; API answers are never cached, static ones revalidated.
 * `frameSrc`: the player origin a Studio page may frame (studioCsp).
 */
export function securityHeaders(kind: 'api' | 'static', o: { frameSrc?: string } = {}): Record<string, string> {
  return {
    'Content-Security-Policy': studioCsp(o.frameSrc),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': kind === 'api' ? 'no-store' : 'no-cache',
  };
}
