/**
 * The Studio server's requests (studio.ts builds the server): the ops it allows and their HTTP statuses, its routes and
 * body caps, its answers (headers, JSON, errors), and each request's handling — the gate, then a static asset, a fixed
 * `/v1` route or `POST /v1/call/<op>`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BodyTooLargeError, ENGINE_HTTP_API, ERROR_STATUS, checkRequest, drainBody, readBody, securityHeaders } from '@retake/engine/shell';
import type { BootstrapCodes } from '@retake/engine/shell';
import { ENGINE_ERROR_CODES } from '@retake/engine';
import type { Engine, EngineErrorCode, RouteSpec } from '@retake/engine';
import { servedNames, studioStatus } from '@retake/engine/catalogue';
import type { OperationName } from '@retake/engine/catalogue';
import { capUntrusted, invoke } from '@retake/engine/contract';
import type { ToolDef } from '@retake/engine/contract';
import type { UiAsset } from '../bundle.js';
import type { Live } from './live.js';
import type { PlayerServer } from './player.js';
import { pathFree } from './comment-ops.js';
import type { RunLive } from './run-live.js';

/**
 * The ops the Studio may call, in catalogue order: the operations the catalogue (@retake/engine/catalogue) says the
 * Studio serves — the engine's operations it serves as they are or with pinned arguments, and its own ops (ops.ts and
 * the other *-ops.ts modules). The catalogue also says why the Studio serves none of the other MCP tools; an op that is not
 * listed answers 404 `unknown op`.
 */
export const UI_OPS: readonly UiOp[] = Object.freeze(servedNames('studio'));
/** An op's name: an operation of the catalogue (which of them the Studio serves is UI_OPS). */
export type UiOp = OperationName;

/**
 * Each op's own HTTP status for an engine error code (the catalogue's `studio.status`, read with studioStatus): a frame
 * request past the server's queue is 429 with Retry-After — the page backs off and asks for its newest frame again. Its
 * timeout is `unavailable` (503, reason `timeout`), which the page says after one more try.
 */
export const OP_STATUS: Partial<Record<UiOp, Partial<Record<EngineErrorCode, number>>>> = Object.fromEntries(
  UI_OPS.flatMap((op) => {
    const status = Object.fromEntries(
      ENGINE_ERROR_CODES.flatMap((code) => {
        const s = studioStatus(op, code);
        return s === undefined ? [] : [[code, s]];
      }),
    );
    return Object.keys(status).length ? [[op, status]] : [];
  }),
);

/** Every string of an error's details made path-free (pathFree), at most 8 levels deep (deeper values are dropped). */
export function withoutPathsDeep(v: unknown, root: string, depth = 0): unknown {
  if (typeof v === 'string') return pathFree(v, root);
  if (depth >= 8 || v === null || typeof v !== 'object') return depth >= 8 && v !== null && typeof v === 'object' ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => withoutPathsDeep(x, root, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, withoutPathsDeep(x, root, depth + 1)]));
}

/** A call's body cap: above the worst case of an accepted README (200,000 characters, control characters escaped). */
export const CALL_BODY_MAX = 2 * 1024 * 1024;
/** The body cap of the session and bootstrap routes. */
export const SMALL_BODY_MAX = 4096;

export const STATIC: RouteSpec = { methods: ['GET', 'HEAD'], token: false, api: false };
const ROUTES: Record<string, RouteSpec> = {
  '/v1/info': { methods: ['GET'], token: true, api: true },
  '/v1/session': { methods: ['POST'], token: false, api: true, maxBody: SMALL_BODY_MAX },
  '/v1/bootstrap': { methods: ['POST'], token: true, api: true, maxBody: SMALL_BODY_MAX },
  '/v1/events': { methods: ['GET'], token: true, api: true },
  '/v1/live': { methods: ['POST'], token: true, api: true, maxBody: SMALL_BODY_MAX },
};
/** Ops that write but never nudge the job watch: the tabs' unsaved reports, the page's word to the desktop shell. */
const NO_NUDGE = new Set<string>([
  'unsaved_report',
  'desktop_answer',
  'desktop_menu',
  'setup_status',
  'setup_cli_install',
  'setup_cli_choose',
  'setup_cli_remove',
  'setup_claude_code_run',
  'setup_claude_desktop_add',
  'setup_notifications',
  'setup_done',
  'desktop_update',
]);
const CALL: RouteSpec = { methods: ['POST'], token: true, api: true, maxBody: CALL_BODY_MAX };
export const CALL_PREFIX = '/v1/call/';

export function route(path: string, assets: Map<string, UiAsset>): RouteSpec | undefined {
  if (assets.has(path)) return STATIC;
  if (path.startsWith(CALL_PREFIX)) return /^[a-z][a-z_]{0,63}$/.test(path.slice(CALL_PREFIX.length)) ? CALL : undefined;
  return ROUTES[path];
}

/** The server's port and counts (the StudioServer getters read them). */
export interface Counters {
  port: number;
  calls: number;
  crossSite: number;
  sessions: number;
}

/** The answers of one server: its headers (the player origin in `frame-src` once it listens), JSON, errors, bodies. */
export interface Replies {
  headers(kind: 'api' | 'static'): Record<string, string>;
  send(res: ServerResponse, status: number, body: unknown, kind?: 'api' | 'static', extra?: Record<string, string>): void;
  fail(res: ServerResponse, status: number, code: string, message: string, extra?: Record<string, string>): void;
  /** The JSON object of a body (an empty body is `{}`); undefined after answering 400 / 413. */
  jsonBody(req: IncomingMessage, res: ServerResponse, max: number): Promise<Record<string, unknown> | undefined>;
}

export function replies(frameSrc: () => string | undefined): Replies {
  const headers = (kind: 'api' | 'static') => {
    const src = frameSrc();
    return securityHeaders(kind, src ? { frameSrc: src } : {});
  };
  const send = (res: ServerResponse, status: number, body: unknown, kind: 'api' | 'static' = 'api', extra: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...headers(kind), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...extra });
    res.end(text);
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}) => send(res, status, { ok: false, error: { code, message } }, 'api', extra);
  const jsonBody = async (req: IncomingMessage, res: ServerResponse, max: number): Promise<Record<string, unknown> | undefined> => {
    let buf: Buffer;
    try {
      buf = await readBody(req, max);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        fail(res, 413, 'too_large', e.message, { Connection: 'close' });
        return undefined;
      }
      throw e;
    }
    if (buf.length === 0) return {};
    let v: unknown;
    try {
      v = JSON.parse(buf.toString('utf8'));
    } catch {
      fail(res, 400, 'invalid', 'the body is not JSON');
      return undefined;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      fail(res, 400, 'invalid', 'the body must be a JSON object (the arguments)');
      return undefined;
    }
    return v as Record<string, unknown>;
  };
  return { headers, send, fail, jsonBody };
}

/** What a request's handler reads: the server's parts, built once by startStudioServer. */
export interface RequestContext {
  assets: Map<string, UiAsset>;
  engine: Engine;
  getEngine: () => Promise<Engine>;
  live: Live;
  runLive: RunLive;
  tools: Map<string, ToolDef>;
  token: string;
  codes: BootstrapCodes;
  counters: Counters;
  writeListeners: Set<() => void>;
  player: () => PlayerServer;
  r: Replies;
}

/** A static asset (from memory, with its ETag): true when `path` is one. */
function serveAsset(c: RequestContext, req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const a = c.assets.get(path);
  if (!a) return false;
  const h = { ...c.r.headers('static'), 'Content-Type': a.type, 'Content-Length': String(a.bytes.length), ETag: a.etag };
  if (req.headers['if-none-match'] === a.etag) {
    res.writeHead(304, h).end();
    return true;
  }
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : a.bytes);
  return true;
}

/** The fixed `/v1` routes (info, events, live, session, bootstrap): true when `path` is one of them. */
async function serveRoute(c: RequestContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const { send, fail, jsonBody } = c.r;
  if (path === '/v1/info') {
    const p = c.player();
    const counters = { sessions: c.counters.sessions, streams: c.live.streamCount, player_media_bytes_read: p.mediaBytesRead, player_range_requests: p.rangeRequests };
    send(res, 200, { ok: true, data: { ...c.engine.info(), http_api: ENGINE_HTTP_API, ops: UI_OPS, counters } });
    return true;
  }
  if (path === '/v1/events') {
    c.live.open(req, res, (status, code, message) => fail(res, status, code, message));
    return true;
  }
  if (path === '/v1/live') {
    const body = await jsonBody(req, res, SMALL_BODY_MAX);
    if (!body) return true;
    await c.runLive.open(res, body, (status, code, message) => fail(res, status, code, message));
    return true;
  }
  if (path === '/v1/session') {
    const body = await jsonBody(req, res, SMALL_BODY_MAX);
    if (!body) return true;
    if (typeof body.code === 'string' && c.codes.redeem(body.code)) {
      c.counters.sessions++;
      send(res, 200, { ok: true, token: c.token });
    } else fail(res, 401, 'unauthorized', 'this link was already used or has expired: run retake ui again');
    return true;
  }
  if (path === '/v1/bootstrap') {
    if (!(await jsonBody(req, res, SMALL_BODY_MAX))) return true;
    const code = c.codes.mint();
    // The player origin: a desktop shell attaching to this server allows navigations to it (no secret: the
    // capabilities under it are).
    send(res, 200, { ok: true, code, url: `http://127.0.0.1:${c.counters.port}/#c=${code}`, player: c.player().origin });
    return true;
  }
  return false;
}

/** An op's error as the page gets it: path-free words, its fix, docs and details. */
function callError(e: { code: EngineErrorCode; message: string; fix?: string; docs?: string; details?: unknown }, root: string) {
  // Every error's words are path-free: the workspace's part cut off, any other absolute path shortened —
  // in the message and every string of the details (an engine or scenario error may quote a file's absolute path).
  // The `fix` is kept as it is: a command the person copies into a terminal (`retake -C <workspace> …`), the same
  // one the screen already shows before the click.
  return {
    code: e.code,
    message: pathFree(e.message, root),
    ...(e.fix ? { fix: e.fix } : {}),
    ...(e.docs ? { docs: e.docs } : {}),
    ...(e.details ? { details: withoutPathsDeep(e.details, root) } : {}),
  };
}

/** `POST /v1/call/<op>`: the op of that name run through `invoke`, its answer, then the write listeners. */
async function serveCall(c: RequestContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const { send, fail, jsonBody } = c.r;
  const op = path.slice(CALL_PREFIX.length);
  const tool = c.tools.get(op);
  if (!tool) {
    await drainBody(req);
    fail(res, 404, 'not_found', `unknown op ${op}: this Studio allows ${UI_OPS.join(', ')}`);
    return;
  }
  const args = await jsonBody(req, res, CALL_BODY_MAX);
  if (!args) return;
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  c.counters.calls++;
  const r = await invoke(tool, c.getEngine, args, { shell: 'studio', startedIn: process.cwd(), signal: ac.signal });
  if (!r.ok) {
    const e = r.error;
    const status = OP_STATUS[op as UiOp]?.[e.code] ?? ERROR_STATUS[e.code];
    send(res, status, { ok: false, error: callError(e, c.engine.workspace.root) }, 'api', status === 429 ? { 'Retry-After': '1' } : {});
    return;
  }
  send(res, 200, { ok: true, summary: r.output.summary, data: capUntrusted(r.output.data), ...(r.output.images?.length ? { images: r.output.images } : {}) });
  if (!tool.annotations.readOnlyHint && !NO_NUDGE.has(op)) for (const f of c.writeListeners) f();
}

/** One request: the gate, then a static asset, a fixed route or an op. */
export async function handleRequest(c: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const site = req.headers['sec-fetch-site'];
  if (req.headers.origin === 'null' || site === 'cross-site' || site === 'same-site') c.counters.crossSite++;
  const g = checkRequest(req, { port: c.counters.port, token: c.token, route: (p) => route(p, c.assets) });
  if (!g.ok) {
    // The body is never used: drained (bounded) so the client reads the answer; the connection closes after it.
    if (await drainBody(req)) c.r.fail(res, g.status, g.code, g.message, { ...(g.allow ? { Allow: g.allow } : {}), Connection: 'close' });
    return;
  }
  if (serveAsset(c, req, res, g.path)) return;
  if (await serveRoute(c, req, res, g.path)) return;
  // POST /v1/call/<op>
  await serveCall(c, req, res, g.path);
}
