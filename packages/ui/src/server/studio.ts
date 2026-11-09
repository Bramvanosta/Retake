/**
 * The Studio server (L4.1): the app and the engine's `/v1` HTTP API of one workspace, on 127.0.0.1 behind the engine's
 * gate (Host → Origin / Sec-Fetch-Site → route / method → token → content type / size), every answer with the strict
 * CSP and no CORS header.
 *
 * Routes: `/`, `/app.js`, `/app.css`, `/fonts/<file>` (L5.9: the bundled Geist pair) (static, from memory, no token); `POST /v1/session` (a one-time bootstrap code →
 * the session token); `GET /v1/info` (engine info + `http_api` + the allowed ops + L5.2's `counters`: sessions
 * redeemed, event streams open, player media bytes read and range requests — numbers only, what the desktop shell's
 * acceptance asserts); `POST /v1/bootstrap` (a new code, for a second `retake ui`, with the player origin: L5.2); `GET /v1/events` (the event stream: live.ts); `POST /v1/live` (L4.4: one run's steps, log
 * and live picture: run-live.ts); `POST /v1/call/<op>` — the MCP tool of
 * that name, or one of the Studio's own reads (ops.ts: activity_list, search, projects_overview), run through the
 * same SDK-free `callTool` the MCP server uses (zod parse, trust, untrusted caps, typed errors), for the ops of
 * `UI_OPS` only.
 *
 * Trust: the engine client is `ui` — the ops L4.1 allows run under the agent's trust, with no approver (a page's
 * script cannot be told from a person's click): a run whose hooks need a person is refused with the `retake run …`
 * command to type in a terminal, and the scenario screen shows that before any click (scenario_blocks `run_blockers`).
 * L4.5: a second loopback listener in the same process, the player origin (player.ts), serves the sandboxed preview
 * frame; the Studio's CSP names it in `frame-src` (the one origin a Studio page may frame). The timeline screen's read
 * (`timeline_view`) publishes each view's plan there and answers its capability URLs.
 *
 * Nothing here logs a token, a body or a README.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { loadWorkspaceConfig, workspaceFolders } from '@retake/core';
import {
  BodyTooLargeError,
  BootstrapCodes,
  ENGINE_ERROR_CODES,
  ENGINE_HTTP_API,
  ERROR_STATUS,
  checkRequest,
  createEngine,
  drainBody,
  listenLoopback,
  memoRegistry,
  newSecret,
  readBody,
  securityHeaders,
} from '@retake/engine';
import type { Engine, EngineErrorCode, RouteSpec, SqliteLoader, WorkerSpawnFn } from '@retake/engine';
import { servedNames, studioPins, studioStatus } from '@retake/engine/catalogue';
import type { OperationName } from '@retake/engine/catalogue';
import { callTool, capUntrusted, pinArguments } from '@retake/engine/contract';
import type { ToolDef } from '@retake/engine/contract';
import { TOOLS } from '@retake/mcp';
import { buildUi } from '../bundle.js';
import type { UiAsset } from '../bundle.js';
import { PlayerBundles } from '../player/bundle-player.js';
import { Live } from './live.js';
import { startPlayerServer } from './player.js';
import { PreviewAllowList } from './preview-allow.js';
import type { PlayerServer } from './player.js';
import { OWN_OPS, PreviewLeases, boardOp, editOps, indexOps, liveOps, overviewOp, renderOps, runOps, scenarioOps, timelineOps } from './ops.js';
import { libraryOps } from './library-ops.js';
import { themeOps } from './theme-ops.js';
import { recordOps } from './record-ops.js';
import { commentOps, pathFree } from './comment-ops.js';
import { opChain } from './op-chain.js';
import type { OpChain } from './op-chain.js';
import { RunLive } from './run-live.js';
import { studioWorkerEnv } from './worker-env.js';
import { UnsavedBoard, unsavedOps } from './unsaved.js';
import { DesktopPipe, desktopOps } from './desktop.js';
import { SetupState, setupOps, systemSetupContext } from './setup-ops.js';
import { UpdateState, updateOps } from './update-ops.js';
import type { SetupContext } from './setup-ops.js';

/**
 * The ops the Studio may call, in catalogue order: the operations the catalogue (@retake/engine/catalogue) says the
 * Studio serves — MCP tools it serves as they are or with pinned arguments, and its own ops (ops.ts and the other
 * *-ops.ts modules). The catalogue also says why the Studio serves none of the other MCP tools; an op that is not
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
    const status = Object.fromEntries(ENGINE_ERROR_CODES.flatMap((code) => {
      const s = studioStatus(op, code);
      return s === undefined ? [] : [[code, s]];
    }));
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

const STATIC: RouteSpec = { methods: ['GET', 'HEAD'], token: false, api: false };
const ROUTES: Record<string, RouteSpec> = {
  '/v1/info': { methods: ['GET'], token: true, api: true },
  '/v1/session': { methods: ['POST'], token: false, api: true, maxBody: SMALL_BODY_MAX },
  '/v1/bootstrap': { methods: ['POST'], token: true, api: true, maxBody: SMALL_BODY_MAX },
  '/v1/events': { methods: ['GET'], token: true, api: true },
  '/v1/live': { methods: ['POST'], token: true, api: true, maxBody: SMALL_BODY_MAX },
};
/** Ops that write but never nudge the job watch: the tabs' unsaved reports, the page's word to the desktop shell. */
const NO_NUDGE = new Set<string>(['unsaved_report', 'desktop_answer', 'setup_status', 'setup_cli_install', 'setup_cli_choose', 'setup_cli_remove', 'setup_claude_code_run', 'setup_claude_desktop_add', 'setup_notifications', 'setup_done', 'desktop_update']);
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
  /** The player origin's port (0 or absent: a free port). */
  playerPort?: number;
  /** L5.16c, tests: what the setup ops read from the machine (default: the machine itself, systemSetupContext). */
  setup?: () => SetupContext;
}

export interface StudioServer {
  /** `http://127.0.0.1:<port>/` — no secret. */
  url: string;
  port: number;
  /** The bearer token of `/v1` (its record in the Retake home holds it, never the workspace; the page gets it for a bootstrap code). */
  token: string;
  /** A new one-time bootstrap code (valid 60 s). */
  mintCode(): string;
  /** The URL to open: `url` + `#c=<a new code>`. */
  launchUrl(): string;
  /** Ops actually run (a refused request never counts; an event stream is not an op): tests assert a hostile page ran none. */
  readonly calls: number;
  /** Event streams open now (at most EVENT_STREAMS_MAX). */
  readonly streams: number;
  /** One-time codes redeemed for the token (`POST /v1/session` answered 200; L5.2). */
  readonly sessions: number;
  /**
   * Requests that came from another site (Sec-Fetch-Site cross-site / same-site, or Origin `null`): the gate refuses
   * them; tests assert the preview frame sent none.
   */
  readonly crossSite: number;
  /** The player origin (L4.5): the preview frame, its bundle, the preview plans and media under one capability. */
  player: PlayerServer;
  /** The preview bundles (memo). */
  bundles: PlayerBundles;
  /** The workspace components the person allowed in the preview this session (memory only). */
  previewAllow: PreviewAllowList;
  /** The workspace index and the event streams. */
  live: Live;
  /** The run streams (`POST /v1/live`). */
  runLive: RunLive;
  /** What the tabs hold unsaved (L5.2b: `unsaved_report`). */
  unsaved: UnsavedBoard;
  /** The window page's word to the desktop shell (L5.12d: `desktop_answer`; attached by startSupervisor). */
  desktop: DesktopPipe;
  /** L5.16c: the Set-up sheet's state (the folder the shell's panel gave, the notification state it said). */
  setup: { state: SetupState; context(): SetupContext };
  /** L5.16d: the desktop app's update state, as its shell said it (desktop_update_status). */
  update: UpdateState;
  /**
   * `f` runs after each op that succeeded and is not read-only (NO_NUDGE excepted): the supervised server's job
   * watch polls at once (a Studio submit shows in the desktop shell without waiting). Returns the unsubscribe.
   */
  onWrite(f: () => void): () => void;
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
    const pins = studioPins(op);
    return [op, pins.length ? pinArguments(t, pins) : t];
  }));
}

/** What the Studio's own ops close over: the server's live state, built once per server. */
export interface StudioToolDeps {
  live: Live;
  chain: OpChain;
  player: () => PlayerServer;
  forbid: () => readonly string[];
  allow: PreviewAllowList;
  registry: NonNullable<Parameters<typeof timelineOps>[0]['registry']>;
  leases: PreviewLeases;
  unsaved: UnsavedBoard;
  desktop: DesktopPipe;
  setupState: SetupState;
  updateState: UpdateState;
  setupContext: () => SetupContext;
  workspace: string;
}

/** The ops of one Studio server: the MCP tools of the allow-list and the Studio's own ops, each by name (uiTools). */
export function studioTools(d: StudioToolDeps): Map<string, ToolDef> {
  const { chain, leases } = d;
  return uiTools([
    ...indexOps(d.live),
    overviewOp(),
    boardOp(),
    ...scenarioOps(),
    ...runOps(),
    ...editOps(chain),
    ...liveOps(),
    ...timelineOps({ player: d.player, forbid: d.forbid, allow: d.allow, registry: d.registry, leases }),
    ...renderOps(chain),
    ...commentOps({ chain }),
    ...libraryOps({ chain }),
    ...themeOps({ chain, player: d.player, forbid: d.forbid, allow: d.allow, leases }),
    ...recordOps({ chain }),
    ...unsavedOps(d.unsaved),
    ...desktopOps(d.desktop),
    ...setupOps({ pipe: d.desktop, state: d.setupState, ctx: d.setupContext, workspace: d.workspace }),
    ...updateOps({ pipe: d.desktop, state: d.updateState }),
  ]);
}

function route(path: string, assets: Map<string, UiAsset>): RouteSpec | undefined {
  if (assets.has(path)) return STATIC;
  if (path.startsWith(CALL_PREFIX)) return /^[a-z][a-z_]{0,63}$/.test(path.slice(CALL_PREFIX.length)) ? CALL : undefined;
  return ROUTES[path];
}

export async function startStudioServer(o: StudioServerOptions): Promise<StudioServer> {
  const log = o.log ?? (() => undefined);
  const assets = await buildUi();
  // The Studio starts the worker when a run is submitted, with a clean environment — cleaned of every folder of the workspace (its projects, templates and components folders may lie outside the root).
  const root = resolve(o.root);
  const folders = await loadWorkspaceConfig(root).then(workspaceFolders, () => [root]);
  const engine = await createEngine({
    root: o.root,
    client: 'ui',
    autoStartWorker: o.startWorker !== false,
    workerEnv: studioWorkerEnv(process.env, root, process.execPath, existsSync, folders),
    ...(o.workerSpawn ? { workerSpawn: o.workerSpawn } : {}),
    ...(o.workerIdleExitMs !== undefined ? { workerIdleExitMs: o.workerIdleExitMs } : {}),
  });
  const getEngine = async () => engine;
  const live = await Live.start({ ws: engine.workspace, queue: engine.queue, ...(o.sqlite ? { sqlite: o.sqlite } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}), log });
  // The player origin starts after the Studio's listener (it must know the Studio's port): the timeline op reads it
  // when called, which is only ever after startStudioServer returned.
  let player: PlayerServer | undefined;
  const previewAllow = new PreviewAllowList();
  const playerNow = (): PlayerServer => {
    if (!player) throw new Error('the preview server is not started');
    return player;
  };
  // One chain for the writes of a scenario: scenario_edit, scenario_render and thread_apply.
  const chain = opChain();
  // L4.7: the preview pages' leases — timeline pages and theme preview pages — and the forbidden folders of a preview.
  const leases = new PreviewLeases((p) => playerNow().release(p));
  const forbid = () => [engine.workspace.root, homedir()];
  const unsaved = new UnsavedBoard(engine.workspace.projectsDir);
  const desktop = new DesktopPipe();
  const setupState = new SetupState();
  const updateState = new UpdateState();
  const setupContext = o.setup ?? (() => systemSetupContext());
  const tools = studioTools({ live, chain, player: playerNow, forbid, allow: previewAllow, registry: async () => (await memoRegistry(engine.workspace)).registry, leases, unsaved, desktop, setupState, updateState, setupContext, workspace: engine.workspace.root });
  const writeListeners = new Set<() => void>();
  const runLive = new RunLive({ engine, ws: engine.workspace, log, ...(o.runPollMs ? { pollMs: o.runPollMs } : {}) });
  const token = newSecret();
  const codes = new BootstrapCodes();
  let port = 0;
  let calls = 0;
  let crossSite = 0;
  let sessions = 0;
  /** The player origin, once it listens: the one origin a Studio page may frame. */
  let frameSrc: string | undefined;
  const headers = (kind: 'api' | 'static') => securityHeaders(kind, frameSrc ? { frameSrc } : {});

  const send = (res: ServerResponse, status: number, body: unknown, kind: 'api' | 'static' = 'api', extra: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...headers(kind), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...extra });
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
    const site = req.headers['sec-fetch-site'];
    if (req.headers.origin === 'null' || site === 'cross-site' || site === 'same-site') crossSite++;
    const g = checkRequest(req, { port, token, route: (p) => route(p, assets) });
    if (!g.ok) {
      // The body is never used: drained (bounded) so the client reads the answer; the connection closes after it.
      if (await drainBody(req)) fail(res, g.status, g.code, g.message, { ...(g.allow ? { Allow: g.allow } : {}), Connection: 'close' });
      return;
    }
    const a = assets.get(g.path);
    if (a) {
      const h = { ...headers('static'), 'Content-Type': a.type, 'Content-Length': String(a.bytes.length), ETag: a.etag };
      if (req.headers['if-none-match'] === a.etag) {
        res.writeHead(304, h).end();
        return;
      }
      res.writeHead(200, h);
      res.end(req.method === 'HEAD' ? undefined : a.bytes);
      return;
    }
    if (g.path === '/v1/info') {
      const p = playerNow();
      const counters = { sessions, streams: live.streamCount, player_media_bytes_read: p.mediaBytesRead, player_range_requests: p.rangeRequests };
      send(res, 200, { ok: true, data: { ...engine.info(), http_api: ENGINE_HTTP_API, ops: UI_OPS, counters } });
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
      if (typeof body.code === 'string' && codes.redeem(body.code)) {
        sessions++;
        send(res, 200, { ok: true, token });
      }
      else fail(res, 401, 'unauthorized', 'this link was already used or has expired: run retake ui again');
      return;
    }
    if (g.path === '/v1/bootstrap') {
      if (!(await jsonBody(req, res, SMALL_BODY_MAX))) return;
      const code = codes.mint();
      // The player origin (L5.2): a desktop shell attaching to this server allows navigations to it (no secret: the
      // capabilities under it are).
      send(res, 200, { ok: true, code, url: `http://127.0.0.1:${port}/#c=${code}`, player: playerNow().origin });
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
      const status = OP_STATUS[op as UiOp]?.[e.code] ?? ERROR_STATUS[e.code];
      // Every error's words are path-free: the workspace's part cut off, any other absolute path shortened —
      // in the message and every string of the details (an engine or scenario error may quote a file's absolute path).
      // The `fix` is kept as it is: a command the person copies into a terminal (`retake -C <workspace> …`), the same
      // one the screen already shows before the click.
      const root = engine.workspace.root;
      const error = { code: e.code, message: pathFree(e.message, root), ...(e.fix ? { fix: e.fix } : {}), ...(e.docs ? { docs: e.docs } : {}), ...(e.details ? { details: withoutPathsDeep(e.details, root) } : {}) };
      send(res, status, { ok: false, error }, 'api', status === 429 ? { 'Retry-After': '1' } : {});
      return;
    }
    send(res, 200, { ok: true, summary: r.output.summary, data: capUntrusted(r.output.data), ...(r.output.images?.length ? { images: r.output.images } : {}) });
    if (!tool.annotations.readOnlyHint && !NO_NUDGE.has(op)) for (const f of writeListeners) f();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`retake ui: ${req.method ?? ''} ${(req.url ?? '').split('?')[0]} failed: ${e instanceof Error ? e.name : 'error'}`);
      if (!res.headersSent) fail(res, 500, 'internal', 'internal error');
      else res.destroy();
    });
  });
  const bundles = new PlayerBundles();
  try {
    port = await listenLoopback(server, o.port ?? 0);
    player = await startPlayerServer({
      studioPort: port,
      // Built-in components, and the workspace components the person allowed (by content) in this session.
      bundle: async () => bundles.get((await memoRegistry(engine.workspace)).registry, (id, hash) => previewAllow.has(id, hash)),
      log,
      ...(o.playerPort ? { port: o.playerPort } : {}),
    });
  } catch (e) {
    runLive.close();
    await live.close();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    throw e;
  }
  frameSrc = player.origin;
  const started: PlayerServer = player;
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
    get sessions() {
      return sessions;
    },
    get crossSite() {
      return crossSite;
    },
    player: started,
    bundles,
    previewAllow,
    live,
    runLive,
    unsaved,
    desktop,
    setup: { state: setupState, context: setupContext },
    update: updateState,
    onWrite: (f) => {
      writeListeners.add(f);
      return () => writeListeners.delete(f);
    },
    engine,
    close: () =>
      (closed ??= (runLive.close(), Promise.all([live.close(), started.close()])).then(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      )),
  };
}
