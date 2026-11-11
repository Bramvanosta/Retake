/**
 * The only module that imports the MCP SDK (@modelcontextprotocol/sdk, pinned at 1.32.1): an SDK upgrade touches this
 * file alone. The low-level `Server` is used (not `McpServer.registerTool`): tool input schemas are our own JSON
 * Schemas, generated from zod, and argument errors keep our positioned wording. Two transports serve the same tools
 * through one wiring (`wireServer`): stdio (`serveStdio`) and Streamable HTTP with stateful sessions
 * (`mcpHttpHandler`, L4.1) — a session keeps its server, so an approval form (elicitation) goes out on the session's
 * stream and its answer comes back to the call that asked. The SDK's own Host / Origin options are deprecated and
 * left off: the engine's gate runs before any request reaches the handler (http.ts).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';

/** A tool's annotations and a call's progress are the operation contract's (@retake/engine/contract). */
import type { Progress, ToolAnnotations } from '@retake/engine/contract';
export type { Progress, ToolAnnotations };

/** A text block, or an image (base64 data: a JPEG thumbnail the server made; the SDK's ImageContent). */
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/jpeg' | 'image/png' };

export interface CallResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A form a human fills in through the client (MCP elicitation, form mode): a message and a flat JSON Schema. */
export interface ElicitForm {
  message: string;
  requestedSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] };
}

export interface ElicitAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface CallContext {
  /** Aborted when the client cancels the request (notifications/cancelled) or the connection closes. */
  signal: AbortSignal;
  /**
   * Ask the client's user (elicitation/create, form mode, tied to this call), when the client declared form
   * elicitation; undefined otherwise. `timeoutMs` is explicit: a human may take longer than the SDK's 60 s default.
   * Throws on a timeout (isTimeoutError), a closed connection or an invalid answer.
   */
  elicit?: (form: ElicitForm, o: { timeoutMs: number }) => Promise<ElicitAnswer>;
  /**
   * Report progress while a call waits (notifications/progress), when the client asked for it (a progressToken):
   * increasing values only, at most two a second (others are dropped, the last one of a total always goes).
   */
  progress?: (p: Progress) => void;
}

/** The request (an elicitation) timed out. */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof McpError && e.code === ErrorCode.RequestTimeout;
}

/** Throttle MCP progress notifications: strictly increasing values, at most one per `minMs`. */
export function progressReporter(send: (p: Progress) => void, minMs = 500): (p: Progress) => void {
  let last = -Infinity;
  let at = 0;
  return (p) => {
    if (!(p.progress > last)) return;
    const final = p.total !== undefined && p.progress >= p.total;
    if (!final && Date.now() - at < minMs) return;
    last = p.progress;
    at = Date.now();
    send(p);
  };
}

/** A tool as the protocol sees it: its JSON Schema and a handler that never throws for tool-level failures. */
export interface ProtocolTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  call(args: Record<string, unknown>, ctx: CallContext): Promise<CallResult>;
}

export interface WireOptions {
  name: string;
  version: string;
  /** Shown to the client at initialize: how to use the tools, and the safety rules. */
  instructions: string;
  tools: readonly ProtocolTool[];
  /** Protocol-level problems (unparseable input…): diagnostics on stderr, never on stdout. */
  onError?: (e: Error) => void;
}

export interface ServeOptions extends WireOptions {
  stdin?: Readable;
  stdout?: Writable;
  /** Resolves when the server must stop (an engine updated under it): the calls under way are answered, then it ends. */
  stop?: Promise<void>;
}

/**
 * A low-level server with the tools wired (tools/list; tools/call with progress notifications and form elicitation
 * when the client declared it), and the calls still running.
 */
function wireServer(o: WireOptions): { server: Server; inFlight: Set<Promise<unknown>> } {
  const server = new Server(
    { name: o.name, version: o.version },
    { capabilities: { tools: { listChanged: false }, logging: {} }, instructions: o.instructions },
  );
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  /** Calls still running: the end of the input waits for their answers before closing. */
  const inFlight = new Set<Promise<unknown>>();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: o.tools.map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
      ...(t.annotations ? { annotations: { ...(t.title ? { title: t.title } : {}), ...t.annotations } } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = byName.get(req.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool "${req.params.name}" (tools: ${[...byName.keys()].join(', ')})`);
    const token = req.params._meta?.progressToken;
    const progress =
      token === undefined
        ? undefined
        : progressReporter((p) => {
            void extra
              .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}), ...(p.message ? { message: p.message } : {}) } })
              .catch(() => undefined);
          });
    // Form elicitation, when the client declared it (`elicitation: {}` is normalised to `{form: {}}` by the SDK).
    const elicit = server.getClientCapabilities()?.elicitation?.form
      ? async (form: ElicitForm, eo: { timeoutMs: number }): Promise<ElicitAnswer> => {
          const r = await server.elicitInput({ mode: 'form', message: form.message, requestedSchema: form.requestedSchema as never }, { relatedRequestId: extra.requestId, timeout: eo.timeoutMs, signal: extra.signal });
          return { action: r.action, ...(r.content ? { content: r.content as Record<string, unknown> } : {}) };
        }
      : undefined;
    const call = tool.call((req.params.arguments ?? {}) as Record<string, unknown>, { signal: extra.signal, ...(progress ? { progress } : {}), ...(elicit ? { elicit } : {}) });
    inFlight.add(call);
    try {
      return (await call) as unknown as Record<string, unknown> & { content: CallResult['content'] };
    } finally {
      inFlight.delete(call);
    }
  });

  server.onerror = (e) => o.onError?.(e);
  return { server, inFlight };
}

/**
 * Serve `tools` over stdio until the client goes away (stdin ends or closes, or stdout breaks). Resolves then; stdout
 * carries nothing but JSON-RPC messages.
 */
export async function serveStdio(o: ServeOptions): Promise<void> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const { server, inFlight } = wireServer(o);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport(stdin, stdout));
  // The SDK's stdio transport does not notice the end of its input: the client closing stdin ends the server, once the
  // calls it already sent are answered (their responses are written first). A broken stdout ends it at once.
  let closing = false;
  const close = () => void server.close().catch(() => undefined);
  const drainThenClose = async () => {
    if (closing) return;
    closing = true;
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    await new Promise<void>((r) => setImmediate(r));
    close();
  };
  stdin.once('end', () => void drainThenClose());
  // After the answer that said why is written (drainThenClose waits for the calls under way).
  void o.stop?.then(() => setTimeout(() => void drainThenClose(), 50));
  stdin.once('close', () => void drainThenClose());
  stdout.once('error', close);
  await closed;
}

/**
 * MCP sessions served at once over HTTP, at most. At the cap, a new client takes the place of the least recently seen
 * session with no call running and no open event stream (a client that went away without DELETE: Claude Code
 * restarted); only when every session is in use is it refused (503).
 */
export const MCP_HTTP_SESSIONS_MAX = 8;
/** An HTTP session with no request for this long, no call running and no open event stream is closed (ms). */
export const MCP_HTTP_IDLE_MS = 30 * 60_000;

export interface HttpHandlerOptions extends WireOptions {
  maxSessions?: number;
  idleMs?: number;
}

export interface McpHttpHandler {
  /**
   * One request of the MCP endpoint, after the gate: `body` is the parsed JSON of a POST. A request naming no session
   * must be an `initialize` (it opens one); a session id the server does not know is 404 (the client starts over).
   */
  handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
  /** Sessions open now. */
  readonly sessions: number;
  /** Sessions closed to make room for a new one (at the cap). */
  readonly evicted: number;
  /** Close every session. */
  close(): Promise<void>;
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  const text = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) }).end(text);
}

/**
 * Streamable HTTP with stateful sessions (one wired server per session), a session cap and an idle expiry. A session is
 * in use while a call runs or its event stream (the GET the client keeps open for the server's requests: approval
 * forms) is open: such a session never expires and is never evicted.
 */
export function mcpHttpHandler(o: HttpHandlerOptions): McpHttpHandler {
  interface Session {
    transport: StreamableHTTPServerTransport;
    server: Server;
    inFlight: Set<Promise<unknown>>;
    /** The last request, or the end of the last event stream. */
    seen: number;
    /** Event streams (GET) open now. */
    streams: number;
  }
  const sessions = new Map<string, Session>();
  const max = o.maxSessions ?? MCP_HTTP_SESSIONS_MAX;
  const idleMs = o.idleMs ?? MCP_HTTP_IDLE_MS;
  let evicted = 0;
  const unused = (s: Session) => s.inFlight.size === 0 && s.streams === 0;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) if (unused(s) && now - s.seen > idleMs) void s.transport.close().catch(() => undefined);
  }, Math.min(60_000, Math.max(1000, Math.floor(idleMs / 2))));
  sweep.unref();
  /** Close the least recently seen session not in use; false when every session is in use. */
  const evictOne = (): boolean => {
    let oldest: [string, Session] | undefined;
    for (const e of sessions) if (unused(e[1]) && (!oldest || e[1].seen < oldest[1].seen)) oldest = e;
    if (!oldest) return false;
    sessions.delete(oldest[0]);
    evicted++;
    void oldest[1].transport.close().catch(() => undefined);
    return true;
  };
  return {
    get sessions() {
      return sessions.size;
    },
    get evicted() {
      return evicted;
    },
    async handle(req, res, body) {
      const sid = req.headers['mcp-session-id'];
      if (typeof sid === 'string') {
        const s = sessions.get(sid);
        if (!s) return rpcError(res, 404, -32001, 'session not found: initialize a new session');
        s.seen = Date.now();
        if (req.method === 'GET') {
          s.streams++;
          res.once('close', () => {
            s.streams--;
            s.seen = Date.now();
          });
        }
        return s.transport.handleRequest(req, res, body);
      }
      if (req.method !== 'POST' || !isInitializeRequest(body)) return rpcError(res, 400, -32000, 'no session: send initialize first (without an Mcp-Session-Id header)');
      if (sessions.size >= max && !evictOne()) return rpcError(res, 503, -32000, `this server holds ${max} sessions, each running a call or holding its event stream: close one (DELETE) or try again later`);
      const { server, inFlight } = wireServer(o);
      let entry: Session | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          entry = { transport, server, inFlight, seen: Date.now(), streams: 0 };
          sessions.set(id, entry);
        },
      });
      // Chained by connect() before the server's own close handling (no server.close() here: it would close the
      // transport again).
      transport.onclose = () => {
        if (transport.sessionId && sessions.get(transport.sessionId) === entry) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },
    async close() {
      clearInterval(sweep);
      await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
    },
  };
}
