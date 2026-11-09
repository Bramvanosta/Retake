/**
 * MCP over HTTP (L4.1, R-MCP-02): `retake mcp --http` serves the same 45 tools as stdio — same engine client (`mcp`),
 * same instructions, same approvals (elicitation over the session) — as Streamable HTTP at
 * `http://127.0.0.1:<port>/mcp`, for an MCP client that registers a URL (Claude Code: `--transport http`).
 *
 * Every request passes the engine's gate first, in its fixed order, with `refuseBrowsers`: Host must be this server's
 * (421: what stops a DNS-rebinding page, which carries its own name); then any request carrying an Origin header or a
 * Sec-Fetch-* header (but the lone `Sec-Fetch-Mode: cors` of Node's fetch) is refused (403) — a second line against web
 * pages: a browser sends an Origin on every POST and cross-origin fetch, and Sec-Fetch-* from secure contexts (a page of
 * a plain-http site sends none, and its no-cors GET carries neither — it still holds no token); MCP clients send
 * neither. Then the route (`/mcp` only, GET / POST / DELETE; OPTIONS never: no CORS preflight passes), the bearer token
 * (the stable one in the Retake home: token-file.ts), JSON bodies only, at most 4 MiB. 127.0.0.1 only, never another
 * interface.
 *
 * The port is fixed: when it is taken, the listener is looked up first (port-holder.ts) — this account's own Retake
 * MCP server keeps the "port busy" answer (use it, or stop it first); any other listener is refused with the advice to
 * stop it and rotate the token (a client may already have sent the token there); one that cannot be identified is
 * refused with how to look and the same advice if it is not this account's server.
 *
 * Whoever holds the token is an MCP client of this workspace — the agent's trust, and the approver of its own forms
 * (as with stdio, where the client that spawns `retake mcp` answers them).
 */
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { RETAKE_VERSION } from '@retake/core';
import { BodyTooLargeError, EngineError, LOOPBACK, checkRequest, createEngine, drainBody, listenLoopback, readBody, securityHeaders } from '@retake/engine';
import type { Engine, RouteSpec } from '@retake/engine';
import { INSTRUCTIONS, TOOLS, protocolTool } from './tool-set.js';
import { portHolder } from './port-holder.js';
import type { PortListenerLookup } from './port-holder.js';
import { mcpHttpHandler } from './server.js';

/** The default port of `retake mcp --http` (fixed, so a registration survives restarts). */
export const DEFAULT_MCP_HTTP_PORT = 47820;
export const MCP_HTTP_PATH = '/mcp';
/** A POST's body cap (a tool call's arguments: a scenario, a README, a comment…). */
export const MCP_HTTP_BODY_MAX = 4 * 1024 * 1024;

const ROUTE: RouteSpec = { methods: ['GET', 'POST', 'DELETE'], token: true, api: true, maxBody: MCP_HTTP_BODY_MAX };

export interface McpHttpOptions {
  /** Workspace root (absolute). */
  root: string;
  /** 0: a free port; default DEFAULT_MCP_HTTP_PORT. */
  port?: number;
  /** The bearer token (the stable one: engine stableToken). */
  token: string;
  /** Diagnostics (never a token or a body). */
  log?: (message: string) => void;
  /** Sessions at once (default 8) and their idle expiry (ms, default 30 min). */
  maxSessions?: number;
  idleMs?: number;
  /** Who listens on a port that is taken (a seam for tests; default: lsof + ps). */
  portListeners?: PortListenerLookup;
}

export interface McpHttpServer {
  /** `http://127.0.0.1:<port>/mcp` — no secret. */
  url: string;
  port: number;
  /** MCP sessions open now. */
  readonly sessions: number;
  /** Sessions closed to make room for a new client (at the cap: one not in use, least recently seen). */
  readonly evicted: number;
  close(): Promise<void>;
}

export async function startMcpHttpServer(o: McpHttpOptions): Promise<McpHttpServer> {
  const log = o.log ?? (() => undefined);
  let engine: Promise<Engine> | undefined;
  const getEngine = () => (engine ??= createEngine({ root: o.root, client: 'mcp' }));
  await getEngine();
  const handler = mcpHttpHandler({
    name: 'retake',
    version: RETAKE_VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS.map((t) => protocolTool(t, getEngine)),
    onError: (e) => log(`retake mcp --http: ${e.message}`),
    ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : {}),
    ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
  });
  let port = 0;
  const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}) => {
    const text = JSON.stringify({ ok: false, error: { code, message } });
    res.writeHead(status, { ...securityHeaders('api'), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...extra }).end(text);
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const g = checkRequest(req, { port, token: o.token, route: (p) => (p === MCP_HTTP_PATH ? ROUTE : undefined), refuseBrowsers: true });
      if (!g.ok) {
        if (await drainBody(req)) fail(res, g.status, g.code, g.message, { ...(g.allow ? { Allow: g.allow } : {}), Connection: 'close' });
        return;
      }
      for (const [k, v] of Object.entries(securityHeaders('api'))) res.setHeader(k, v);
      let body: unknown;
      if (req.method === 'POST') {
        let buf: Buffer;
        try {
          buf = await readBody(req, MCP_HTTP_BODY_MAX);
        } catch (e) {
          if (e instanceof BodyTooLargeError) return fail(res, 413, 'too_large', e.message, { Connection: 'close' });
          throw e;
        }
        try {
          body = JSON.parse(buf.toString('utf8'));
        } catch {
          const text = JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error: the body is not JSON' }, id: null });
          return void res.writeHead(400, { 'Content-Type': 'application/json' }).end(text);
        }
      }
      await handler.handle(req, res, body);
    })().catch((e: unknown) => {
      log(`retake mcp --http: ${req.method ?? ''} ${(req.url ?? '').split('?')[0]} failed: ${e instanceof Error ? e.message : 'error'}`);
      if (!res.headersSent) fail(res, 500, 'internal', 'internal error');
      else res.destroy();
    });
  });
  const want = o.port ?? DEFAULT_MCP_HTTP_PORT;
  try {
    port = await listenLoopback(server, want);
  } catch (e) {
    await handler.close();
    if (e instanceof EngineError && e.code === 'busy' && want !== 0) {
      const holder = await portHolder(want, o.portListeners);
      if (!holder.ours && holder.unidentified) {
        throw new EngineError('refused', `${LOOPBACK}:${want} is taken and ${holder.why}`, {
          fix: `see what listens there (lsof -nP -iTCP:${want} -sTCP:LISTEN): if it is your own retake mcp --http, use it or stop it first; if not, stop that program (or pass another --port and register again), then run retake mcp --http --rotate-token: an MCP client may already have sent the token to it`,
          details: { port: want },
        });
      }
      if (!holder.ours) {
        throw new EngineError('refused', `${LOOPBACK}:${want} is taken and not by a Retake MCP server of this account: ${holder.why}`, {
          fix: `stop that program (or pass another --port and register again), then run retake mcp --http --rotate-token: an MCP client may already have sent the token to it`,
          details: { port: want },
        });
      }
      throw new EngineError('busy', `${e.message}: a Retake MCP server of this account already serves on it`, {
        fix: 'use that server (its clients reach it already), or stop it before starting another — or pass another --port and register again',
        details: { port: want },
      });
    }
    throw e;
  }
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}${MCP_HTTP_PATH}`,
    port,
    get sessions() {
      return handler.sessions;
    },
    get evicted() {
      return handler.evicted;
    },
    close: () =>
      (closed ??= handler.close().then(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      )),
  };
}
