/**
 * The only module that imports the MCP SDK (@modelcontextprotocol/sdk, pinned at 1.32.1): an SDK upgrade touches this
 * file alone. The low-level `Server` is used (not `McpServer.registerTool`): tool input schemas are our own JSON
 * Schemas, generated from zod, and argument errors keep our positioned wording.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface CallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Progress {
  progress: number;
  total?: number;
  message?: string;
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

export interface ServeOptions {
  name: string;
  version: string;
  /** Shown to the client at initialize: how to use the tools, and the safety rules. */
  instructions: string;
  tools: readonly ProtocolTool[];
  stdin?: Readable;
  stdout?: Writable;
  /** Protocol-level problems (unparseable input…): diagnostics on stderr, never on stdout. */
  onError?: (e: Error) => void;
}

/**
 * Serve `tools` over stdio until the client goes away (stdin ends or closes, or stdout breaks). Resolves then; stdout
 * carries nothing but JSON-RPC messages.
 */
export async function serveStdio(o: ServeOptions): Promise<void> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
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
  stdin.once('close', () => void drainThenClose());
  stdout.once('error', close);
  await closed;
}
