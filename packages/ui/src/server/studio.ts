/**
 * The Studio server: the app and the engine's `/v1` HTTP API of one workspace, on 127.0.0.1 behind the engine's
 * gate (Host → Origin / Sec-Fetch-Site → route / method → token → content type / size), every answer with the strict
 * CSP and no CORS header.
 *
 * Routes: `/`, `/app.js`, `/app.css`, `/fonts/<file>` (the bundled Geist pair) (static, from memory, no token); `POST
 * /v1/session` (a one-time bootstrap code → the session token); `GET /v1/info` (engine info + `http_api` + the allowed
 * ops + `counters`: sessions redeemed, event streams open, player media bytes read and range requests — numbers only,
 * what the desktop shell's acceptance asserts); `POST /v1/bootstrap` (a new code, for a second `retake ui`, with the
 * player origin); `GET /v1/events` (the event stream: live.ts); `POST /v1/live` (one run's steps, log and live picture:
 * run-live.ts); `POST /v1/call/<op>` — the engine's operation of that name (@retake/engine/contract OPERATIONS: the
 * ones MCP serves too), or one of the Studio's own ops (ops.ts and the other *-ops.ts modules), run through the same
 * SDK-free `invoke` the MCP server uses (served by the shell, zod parse, trust, untrusted caps, typed errors), for the
 * ops of `UI_OPS` only.
 *
 * Trust: the engine client is `ui` — the allowed ops run under the agent's trust, with no approver (a page's
 * script cannot be told from a person's click): a run whose hooks need a person is refused with the `retake run …`
 * command to type in a terminal, and the scenario screen shows that before any click (scenario_blocks `run_blockers`).
 * A second loopback listener in the same process, the player origin (player.ts), serves the sandboxed preview
 * frame; the Studio's CSP names it in `frame-src` (the one origin a Studio page may frame). The timeline screen's read
 * (`timeline_view`) publishes each view's plan there and answers its capability URLs.
 *
 * Nothing here logs a token, a body or a README.
 */
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { workspaceFolders } from '@retake/core/policy';
import { BootstrapCodes, listenLoopback, newSecret } from '@retake/engine/shell';
import { createEngine } from '@retake/engine';
import type { Engine, SqliteLoader, WorkerSpawnFn } from '@retake/engine';
import { catalogueOperation, servedBy, studioPins } from '@retake/engine/catalogue';
import type { StudioOpName, StudioPinsOf } from '@retake/engine/catalogue';
import { OPERATIONS, pinArguments } from '@retake/engine/contract';
import type { OperationsByName, PinnedTool, ToolDef, ToolsByName } from '@retake/engine/contract';
import type { z } from 'zod';
import { buildUi } from '../bundle.js';
import { PlayerBundles } from '../player/bundle-player.js';
import { Live } from './live.js';
import { startPlayerServer } from './player.js';
import { PreviewAllowList } from './preview-allow.js';
import type { PlayerServer } from './player.js';
import { indexOps, timelineOps } from './ops.js';
import { PreviewLeases } from './preview-leases.js';
import { themeOps } from './theme-ops.js';
import { RunLive } from './run-live.js';
import { studioWorkerEnv } from './worker-env.js';
import { UnsavedBoard, unsavedOps } from './unsaved.js';
import { DesktopPipe, desktopOps } from './desktop.js';
import { SetupState, setupOps, systemSetupContext } from './setup-ops.js';
import { UpdateState, updateOps } from './update-ops.js';
import { studioPorts } from './ports.js';
import type { SetupContext } from './setup-ops.js';
import { UI_OPS, handleRequest, replies } from './studio-requests.js';
import type { Counters, RequestContext } from './studio-requests.js';

export { CALL_BODY_MAX, OP_STATUS, SMALL_BODY_MAX, UI_OPS, withoutPathsDeep } from './studio-requests.js';
export type { UiOp } from './studio-requests.js';

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
   * Start the workspace's jobs worker when a run is submitted (default true): with a clean environment
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
  /** Tests: what the setup ops read from the machine (default: the machine itself, systemSetupContext). */
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
  /** One-time codes redeemed for the token (`POST /v1/session` answered 200). */
  readonly sessions: number;
  /**
   * Requests that came from another site (Sec-Fetch-Site cross-site / same-site, or Origin `null`): the gate refuses
   * them; tests assert the preview frame sent none.
   */
  readonly crossSite: number;
  /** The player origin: the preview frame, its bundle, the preview plans and media under one capability. */
  player: PlayerServer;
  /** The preview bundles (memo). */
  bundles: PlayerBundles;
  /** The workspace components the person allowed in the preview this session (memory only). */
  previewAllow: PreviewAllowList;
  /** The workspace index and the event streams. */
  live: Live;
  /** The run streams (`POST /v1/live`). */
  runLive: RunLive;
  /** What the tabs hold unsaved (`unsaved_report`). */
  unsaved: UnsavedBoard;
  /** The window page's word to the desktop shell (`desktop_answer`; attached by startSupervisor). */
  desktop: DesktopPipe;
  /** The Set-up sheet's state (the folder the shell's panel gave, the notification state it said). */
  setup: { state: SetupState; context(): SetupContext; pipe: DesktopPipe };
  /** The desktop app's update state, as its shell said it (desktop_update_status). */
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
 * The ops of the allow-list: the engine's operation of each name (the operations MCP serves too: the Studio's read-only
 * queries among them), or one of `own` (the Studio's own ops — which never take an engine operation's or an MCP tool's
 * name).
 */
export function uiTools(own: readonly ToolDef[] = []): Map<string, ToolDef> {
  const shared = new Map<string, ToolDef>(OPERATIONS.map((t) => [t.name, t]));
  const mine = new Map<string, ToolDef>(own.map((t) => [t.name, t]));
  for (const name of mine.keys()) {
    if (shared.has(name)) throw new Error(`UI op ${name} would shadow the engine's operation of that name`);
    // Nor an MCP tool's name (the catalogue's: one name, one operation), even one the Studio does not serve.
    const op = catalogueOperation(name);
    if (op && servedBy(op, 'mcp')) throw new Error(`UI op ${name} would shadow the MCP tool of that name`);
  }
  return new Map(
    UI_OPS.map((op) => {
      const t = shared.get(op) ?? mine.get(op);
      if (!t) throw new Error(`UI op ${op} is not a tool`);
      const pins = studioPins(op);
      return [op, pins.length ? pinArguments(t as ToolDef<z.ZodObject>, pins) : t];
    }),
  );
}

/** What the Studio's own ops close over: the server's live state, built once per server. */
export interface StudioToolDeps {
  live: Live;
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

/** The ops of one Studio server: the engine's operations of the allow-list and the Studio's own ops, each by name (uiTools). */
export function studioTools(d: StudioToolDeps): Map<string, ToolDef> {
  return uiTools(ownOps(d));
}

/** The Studio's own ops (ops.ts and the other *-ops.ts modules), each with its types (OwnOps). */
function ownOps(d: StudioToolDeps) {
  const { leases } = d;
  return [
    ...indexOps(d.live),
    ...timelineOps({ player: d.player, forbid: d.forbid, allow: d.allow, registry: d.registry, leases }),
    ...themeOps({ player: d.player, forbid: d.forbid, allow: d.allow, leases }),
    ...unsavedOps(d.unsaved),
    ...desktopOps(d.desktop),
    ...setupOps({ pipe: d.desktop, state: d.setupState, ctx: d.setupContext, workspace: d.workspace }),
    ...updateOps({ pipe: d.desktop, state: d.updateState }),
  ] as const;
}

/** The Studio's own ops by name, as types. */
type OwnOps = ToolsByName<ReturnType<typeof ownOps>[number]>;
/** The definition of an op the Studio serves: the engine's operation of that name, else its own op. */
type ToolOf<K extends StudioOpName> = K extends keyof OperationsByName ? OperationsByName[K] : K extends keyof OwnOps ? OwnOps[K] : never;
/**
 * Every op the Studio serves as `/v1/call/<op>` runs it — the engine's operation or its own op, the Studio's pinned arguments
 * applied (as uiTools builds them) — by name, as types: the app's StudioOps (src/app/data/ops.ts) is derived from it
 * (each op's arguments `ToolArgs`, its answer `ToolData`). Types only: the server's table is studioTools.
 */
export type StudioTools = { [K in StudioOpName]: PinnedTool<ToolOf<K>, StudioPinsOf<K>> };
/** An op the catalogue says the Studio serves without a tool of that name: none (a compile-time check, as uiTools's at start). */
type Toolless = { [K in StudioOpName]: [ToolOf<K>] extends [never] ? K : never }[StudioOpName];
export type EveryStudioOpHasATool = NoneOf<Toolless>;
type NoneOf<T extends never> = T;

/** The engine of a Studio server: its worker started on a submit, with a clean environment. */
async function studioEngine(o: StudioServerOptions): Promise<Engine> {
  // The Studio starts the worker when a run is submitted, with a clean environment — cleaned of every folder of the workspace (its projects, templates and components folders may lie outside the root).
  const root = resolve(o.root);
  const folders = await studioPorts.reads.loadWorkspaceConfig(root).then(workspaceFolders, () => [root]);
  return createEngine({
    root: o.root,
    client: 'ui',
    ports: studioPorts,
    autoStartWorker: o.startWorker !== false,
    workerEnv: studioWorkerEnv(process.env, root, process.execPath, undefined, folders),
    ...(o.workerSpawn ? { workerSpawn: o.workerSpawn } : {}),
    ...(o.workerIdleExitMs !== undefined ? { workerIdleExitMs: o.workerIdleExitMs } : {}),
  });
}

/** The parts the StudioServer handle exposes beside its counters. */
interface ServerParts {
  server: Server;
  url: string;
  codes: BootstrapCodes;
  counters: Counters;
  token: string;
  started: PlayerServer;
  writeListeners: Set<() => void>;
  rest: Pick<StudioServer, 'bundles' | 'previewAllow' | 'live' | 'runLive' | 'unsaved' | 'desktop' | 'setup' | 'update' | 'engine'>;
}

function serverHandle(p: ServerParts): StudioServer {
  const { server, url, codes, counters, started, writeListeners } = p;
  const { live, runLive } = p.rest;
  let closed: Promise<void> | undefined;
  return {
    url,
    port: counters.port,
    token: p.token,
    mintCode: () => codes.mint(),
    launchUrl: () => `${url}#c=${codes.mint()}`,
    get calls() {
      return counters.calls;
    },
    get streams() {
      return live.streamCount;
    },
    get sessions() {
      return counters.sessions;
    },
    get crossSite() {
      return counters.crossSite;
    },
    player: started,
    bundles: p.rest.bundles,
    previewAllow: p.rest.previewAllow,
    live,
    runLive,
    unsaved: p.rest.unsaved,
    desktop: p.rest.desktop,
    setup: p.rest.setup,
    update: p.rest.update,
    onWrite: (f) => {
      writeListeners.add(f);
      return () => writeListeners.delete(f);
    },
    engine: p.rest.engine,
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

export async function startStudioServer(o: StudioServerOptions): Promise<StudioServer> {
  const log = o.log ?? (() => undefined);
  const assets = await buildUi();
  const engine = await studioEngine(o);
  const getEngine = async () => engine;
  const live = await Live.start({ ws: engine.workspace, queue: engine.queue, folder: engine.folder, ...(o.sqlite ? { sqlite: o.sqlite } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}), log });
  // The player origin starts after the Studio's listener (it must know the Studio's port): the timeline op reads it
  // when called, which is only ever after startStudioServer returned.
  let player: PlayerServer | undefined;
  const previewAllow = new PreviewAllowList();
  const playerNow = (): PlayerServer => {
    if (!player) throw new Error('the preview server is not started');
    return player;
  };
  // The preview pages' leases — timeline pages and theme preview pages — and the forbidden folders of a preview.
  const leases = new PreviewLeases((p) => playerNow().release(p));
  const forbid = () => [engine.workspace.root, homedir()];
  const unsaved = new UnsavedBoard(engine.workspace.projectsDir);
  const desktop = new DesktopPipe();
  const setupState = new SetupState();
  const updateState = new UpdateState();
  const setupContext = o.setup ?? (() => systemSetupContext());
  const tools = studioTools({
    live,
    player: playerNow,
    forbid,
    allow: previewAllow,
    registry: () => engine.components.registry(),
    leases,
    unsaved,
    desktop,
    setupState,
    updateState,
    setupContext,
    workspace: engine.workspace.root,
  });
  const writeListeners = new Set<() => void>();
  const runLive = new RunLive({ engine, ws: engine.workspace, log, ...(o.runPollMs ? { pollMs: o.runPollMs } : {}) });
  const token = newSecret();
  const codes = new BootstrapCodes();
  const counters: Counters = { port: 0, calls: 0, crossSite: 0, sessions: 0 };
  /** The player origin, once it listens: the one origin a Studio page may frame. */
  let frameSrc: string | undefined;
  const r = replies(() => frameSrc);
  const c: RequestContext = { assets, engine, getEngine, live, runLive, tools, token, codes, counters, writeListeners, player: playerNow, r };

  const server: Server = createServer((req, res) => {
    handleRequest(c, req, res).catch((e: unknown) => {
      log(`retake ui: ${req.method ?? ''} ${(req.url ?? '').split('?')[0]} failed: ${e instanceof Error ? e.name : 'error'}`);
      if (!res.headersSent) r.fail(res, 500, 'internal', 'internal error');
      else res.destroy();
    });
  });
  const bundles = new PlayerBundles();
  try {
    counters.port = await listenLoopback(server, o.port ?? 0);
    player = await startPlayerServer({
      studioPort: counters.port,
      // Built-in components, and the workspace components the person allowed (by content) in this session.
      bundle: async () => bundles.get(await engine.components.registry(), (id, hash) => previewAllow.has(id, hash)),
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
  const rest = { bundles, previewAllow, live, runLive, unsaved, desktop, setup: { state: setupState, context: setupContext, pipe: desktop }, update: updateState, engine };
  return serverHandle({ server, url: `http://127.0.0.1:${counters.port}/`, codes, counters, token, started: player, writeListeners, rest });
}
