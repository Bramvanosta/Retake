/**
 * The Studio server (L4.1): the app and the engine's `/v1` HTTP API of one workspace, on 127.0.0.1 behind the engine's
 * gate (Host → Origin / Sec-Fetch-Site → route / method → token → content type / size), every answer with the strict
 * CSP and no CORS header.
 *
 * Routes: `/`, `/app.js`, `/app.css` (static, from memory, no token); `POST /v1/session` (a one-time bootstrap code →
 * the session token); `GET /v1/info` (engine info + `http_api` + the allowed ops); `POST /v1/bootstrap` (a new code,
 * for a second `studio ui`); `GET /v1/events` (the event stream: live.ts); `POST /v1/live` (L4.4: one run's steps, log
 * and live picture: run-live.ts); `POST /v1/call/<op>` — the MCP tool of
 * that name, or one of the Studio's own reads (ops.ts: activity_list, search, projects_overview), run through the
 * same SDK-free `callTool` the MCP server uses (zod parse, trust, untrusted caps, typed errors), for the ops of
 * `UI_OPS` only.
 *
 * Trust: the engine client is `ui` — the ops L4.1 allows run under the agent's trust, with no approver (a page's
 * script cannot be told from a person's click): a run whose hooks need a person is refused with the `studio run …`
 * command to type in a terminal, and the scenario screen shows that before any click (scenario_blocks `run_blockers`).
 * Nothing here logs a token, a body or a README.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  BodyTooLargeError,
  BootstrapCodes,
  ENGINE_HTTP_API,
  ERROR_STATUS,
  checkRequest,
  createEngine,
  drainBody,
  listenLoopback,
  newSecret,
  readBody,
  securityHeaders,
} from '@demo-studio/engine';
import type { Engine, RouteSpec, SqliteLoader, WorkerSpawnFn } from '@demo-studio/engine';
import { TOOLS, callTool, capUntrusted } from '@demo-studio/mcp';
import type { ToolDef } from '@demo-studio/mcp';
import { buildUi } from '../bundle.js';
import type { UiAsset } from '../bundle.js';
import { Live } from './live.js';
import { OWN_OPS, editOps, indexOps, liveOps, overviewOp, runOps, scenarioOps } from './ops.js';
import { RunLive } from './run-live.js';
import { studioWorkerEnv } from './worker-env.js';
import { z } from 'zod';

/**
 * The ops the Studio may call — L4.1: read the engine and the projects, write a README (if_match), list jobs, list a
 * project's runs: MCP tools; and the Studio's own reads (ops.ts): the workspace index (activity_list, search) and the
 * Projects screen's cards in one call (projects_overview). L4.2: a run's status (`run_status`, without its long-poll:
 * the running banner's progress), the scenario screen's reads (scenario_blocks, run_thumbs), its Dry run / Capture
 * (`scenario_run`, an own op with pinned arguments: no sandbox, no until, no wait — critique B11) and Cancel
 * (`run_cancel`). L4.3: the YAML tab's live check (`scenario_validate`, read-only) and the scenario write path
 * (`scenario_edit`, an own op — `scenario_save` stays out: one Studio write path) and the step forms (`scenario_forms`).
 * L4.4: the Run screen's Pause / Resume (`run_pause`) and preflight panel (`scenario_sessions`), the Sessions panel
 * (`auth_status`, read-only; `auth_login` NARROWED to a headed window for the person, never a wait; `sign_in_cancel`).
 * Each later lot adds the ops its screen needs; a tool that is not listed answers 404 `unknown op`.
 */
export const UI_OPS = ['engine_info', 'project_list', 'project_get', 'project_update_readme', 'job_list', 'run_list', 'run_status', 'run_cancel', 'scenario_validate', 'auth_status', 'auth_login', ...OWN_OPS] as const;
export type UiOp = (typeof UI_OPS)[number];

/**
 * MCP tools the Studio calls with fewer arguments than Claude (critique B11: pin what a page can ask): `run_status`
 * never long-polls from a page (`wait_s` absent or 0 — a page waiting 25 s holds one of the browser's 6 connections).
 * `auth_login` (L4.4) opens only the headed window where the PERSON signs in (`mode: 'headed'`; `auto` is what every
 * run's preflight does by itself) and never waits (`wait_s` 0: the Sessions panel follows the job): a page script can
 * do no more than open a window the person sees (it closes by itself after DEMO_STUDIO_SIGNIN_MAX_MIN).
 */
const NARROWED: Partial<Record<UiOp, (t: ToolDef) => ToolDef>> = {
  run_status: (t) => ({ ...t, input: (t.input as z.ZodObject).extend({ wait_s: z.literal(0).optional().describe('Always 0 from the Studio (no long-poll).') }) }),
  auth_login: (t) => ({
    ...t,
    input: (t.input as z.ZodObject).extend({
      mode: z.literal('headed').default('headed').describe('Always headed from the Studio: a window where the person signs in.'),
      wait_s: z.literal(0).default(0).describe('Always 0 from the Studio (the panel follows the job).'),
    }),
  }),
};

/** A call's body cap: above the worst case of an accepted README (200,000 characters, control characters escaped). */
export const CALL_BODY_MAX = 2 * 1024 * 1024;
/** The body cap of the session and bootstrap routes. */
export const SMALL_BODY_MAX = 4096;

const STATIC: RouteSpec = { methods: ['GET', 'HEAD'], token: false, api: false };
const ROUTES: Record<string, RouteSpec> = {
  '/v1/info': { methods: ['GET'], token: true, api: true },
  '/v1/session': { methods: ['POST'], token: false, api: true, maxBody: SMALL_BODY_MAX },
  '/v1/bootstrap': { methods: ['POST'], token: true, api: true, maxBody: SMALL_BODY_MAX },
  '/v1/events': { methods: ['GET'], token: true, api: true },
  '/v1/live': { methods: ['POST'], token: true, api: true, maxBody: SMALL_BODY_MAX },
};
const CALL: RouteSpec = { methods: ['POST'], token: true, api: true, maxBody: CALL_BODY_MAX };
const CALL_PREFIX = '/v1/call/';

export interface StudioServerOptions {
  /** Workspace root (absolute). */
  root: string;
  /** 0 or absent: a free port. */
  port?: number;
  /** Diagnostics (never a token, a body or a README). */
  log?: (message: string) => void;
  /** node:sqlite (tests inject a Node.js without it). */
  sqlite?: SqliteLoader;
  /** The stat poll's period while an event stream is open (ms; default 1 s). */
  pollMs?: number;
  /**
   * Start the workspace's jobs worker when a run is submitted (default true; L4.2): with a clean environment
   * (studioWorkerEnv). Tests turn it off to keep a submitted job queued, or inject `workerSpawn`.
   */
  startWorker?: boolean;
  /** Tests: starts the worker process instead of node's spawn (sees its command and environment). */
  workerSpawn?: WorkerSpawnFn;
  /** The idle exit of a worker the Studio starts (ms; default the worker's 60 s). */
  workerIdleExitMs?: number;
  /** How often a run stream reads the run's files (ms; default 300). */
  runPollMs?: number;
}

export interface StudioServer {
  /** `http://127.0.0.1:<port>/` — no secret. */
  url: string;
  port: number;
  /** The bearer token of `/v1` (the discovery file holds it; the page gets it for a bootstrap code). */
  token: string;
  /** A new one-time bootstrap code (valid 60 s). */
  mintCode(): string;
  /** The URL to open: `url` + `#c=<a new code>`. */
  launchUrl(): string;
  /** Ops actually run (a refused request never counts; an event stream is not an op): tests assert a hostile page ran none. */
  readonly calls: number;
  /** Event streams open now (at most EVENT_STREAMS_MAX). */
  readonly streams: number;
  /** The workspace index and the event streams. */
  live: Live;
  /** The run streams (`POST /v1/live`). */
  runLive: RunLive;
  engine: Engine;
  close(): Promise<void>;
}

/**
 * The ops of the allow-list: the MCP server's tool of each name, or one of `own` (the Studio's reads of the index —
 * which never take an MCP tool's name).
 */
export function uiTools(own: readonly ToolDef[] = []): Map<string, ToolDef> {
  const mcp = new Map(TOOLS.map((t) => [t.name, t]));
  const mine = new Map(own.map((t) => [t.name, t]));
  for (const name of mine.keys()) if (mcp.has(name)) throw new Error(`UI op ${name} would shadow the MCP tool of that name`);
  return new Map(UI_OPS.map((op) => {
    const t = mcp.get(op) ?? mine.get(op);
    if (!t) throw new Error(`UI op ${op} is not a tool`);
    return [op, NARROWED[op]?.(t) ?? t];
  }));
}

function route(path: string, assets: Map<string, UiAsset>): RouteSpec | undefined {
  if (assets.has(path)) return STATIC;
  if (path.startsWith(CALL_PREFIX)) return /^[a-z][a-z_]{0,63}$/.test(path.slice(CALL_PREFIX.length)) ? CALL : undefined;
  return ROUTES[path];
}

export async function startStudioServer(o: StudioServerOptions): Promise<StudioServer> {
  const log = o.log ?? (() => undefined);
  const assets = await buildUi();
  // The Studio starts the worker when a run is submitted (L4.2), with a clean environment (critique B5).
  const engine = await createEngine({
    root: o.root,
    client: 'ui',
    autoStartWorker: o.startWorker !== false,
    workerEnv: studioWorkerEnv(process.env, resolve(o.root)),
    ...(o.workerSpawn ? { workerSpawn: o.workerSpawn } : {}),
    ...(o.workerIdleExitMs !== undefined ? { workerIdleExitMs: o.workerIdleExitMs } : {}),
  });
  const getEngine = async () => engine;
  const live = await Live.start({ ws: engine.workspace, ...(o.sqlite ? { sqlite: o.sqlite } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}), log });
  const tools = uiTools([...indexOps(live), overviewOp(), ...scenarioOps(), ...runOps(), ...editOps(), ...liveOps()]);
  const runLive = new RunLive({ engine, ws: engine.workspace, log, ...(o.runPollMs ? { pollMs: o.runPollMs } : {}) });
  const token = newSecret();
  const codes = new BootstrapCodes();
  let port = 0;
  let calls = 0;

  const send = (res: ServerResponse, status: number, body: unknown, kind: 'api' | 'static' = 'api', extra: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...securityHeaders(kind), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...extra });
    res.end(text);
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}) => send(res, status, { ok: false, error: { code, message } }, 'api', extra);

  /** The JSON object of a body (an empty body is `{}`); undefined after answering 400 / 413. */
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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const g = checkRequest(req, { port, token, route: (p) => route(p, assets) });
    if (!g.ok) {
      // The body is never used: drained (bounded) so the client reads the answer; the connection closes after it.
      if (await drainBody(req)) fail(res, g.status, g.code, g.message, { ...(g.allow ? { Allow: g.allow } : {}), Connection: 'close' });
      return;
    }
    const a = assets.get(g.path);
    if (a) {
      const headers = { ...securityHeaders('static'), 'Content-Type': a.type, 'Content-Length': String(a.bytes.length), ETag: a.etag };
      if (req.headers['if-none-match'] === a.etag) {
        res.writeHead(304, headers).end();
        return;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : a.bytes);
      return;
    }
    if (g.path === '/v1/info') {
      send(res, 200, { ok: true, data: { ...engine.info(), http_api: ENGINE_HTTP_API, ops: UI_OPS } });
      return;
    }
    if (g.path === '/v1/events') {
      live.open(req, res, (status, code, message) => fail(res, status, code, message));
      return;
    }
    if (g.path === '/v1/live') {
      const body = await jsonBody(req, res, SMALL_BODY_MAX);
      if (!body) return;
      await runLive.open(res, body, (status, code, message) => fail(res, status, code, message));
      return;
    }
    if (g.path === '/v1/session') {
      const body = await jsonBody(req, res, SMALL_BODY_MAX);
      if (!body) return;
      if (typeof body.code === 'string' && codes.redeem(body.code)) send(res, 200, { ok: true, token });
      else fail(res, 401, 'unauthorized', 'this link was already used or has expired: run studio ui again');
      return;
    }
    if (g.path === '/v1/bootstrap') {
      if (!(await jsonBody(req, res, SMALL_BODY_MAX))) return;
      const code = codes.mint();
      send(res, 200, { ok: true, code, url: `http://127.0.0.1:${port}/#c=${code}` });
      return;
    }
    // POST /v1/call/<op>
    const op = g.path.slice(CALL_PREFIX.length);
    const tool = tools.get(op);
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
    calls++;
    const r = await callTool(tool, getEngine, args, { signal: ac.signal });
    if (!r.ok) {
      const e = r.error;
      send(res, ERROR_STATUS[e.code], { ok: false, error: { code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}), ...(e.details ? { details: e.details } : {}) } });
      return;
    }
    send(res, 200, { ok: true, summary: r.output.summary, data: capUntrusted(r.output.data), ...(r.output.images?.length ? { images: r.output.images } : {}) });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`studio ui: ${req.method ?? ''} ${(req.url ?? '').split('?')[0]} failed: ${e instanceof Error ? e.name : 'error'}`);
      if (!res.headersSent) fail(res, 500, 'internal', 'internal error');
      else res.destroy();
    });
  });
  try {
    port = await listenLoopback(server, o.port ?? 0);
  } catch (e) {
    runLive.close();
    await live.close();
    throw e;
  }
  const url = `http://127.0.0.1:${port}/`;
  let closed: Promise<void> | undefined;
  return {
    url,
    port,
    token,
    mintCode: () => codes.mint(),
    launchUrl: () => `${url}#c=${codes.mint()}`,
    get calls() {
      return calls;
    },
    get streams() {
      return live.streamCount;
    },
    live,
    runLive,
    engine,
    close: () =>
      (closed ??= (runLive.close(), live.close()).then(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      )),
  };
}
