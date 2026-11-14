/**
 * @retake/mcp — the MCP server (L3.1, R-MCP-01): Retake's engine as MCP tools over stdio, started by
 * `retake mcp`. The read side (engine, projects, scenarios, runs, auth and sandbox status), the authored files
 * (project_create, project_update_readme, scenario_save with if_match), and dry runs and captures as jobs (run_dry,
 * run_capture, run_status with wait_s, run_cancel, job_*), hooks and environment resets as jobs (hooks_run, env_reset), and
 * human approval of hooks through elicitation (approval.ts), sign-ins (auth_login: a window for the human) and sandbox
 * up / reset as jobs, renders as jobs (L3.2: plan_preview, render, render_status), reviews and exports as jobs (review, review_get with
 * images inline, export), themes and components (template_list, template_preview, component_list / get / validate /
 * preview / create — a scaffold only: no tool writes component code, an existing theme or project.yaml), page inspections for authoring (L3.3:
 * page_inspect as a job; Claude writes the scenario, no tool calls a model; scenario_from_script, a deterministic aid
 * that turns a timecoded script table into a skeleton), and recordings (L3.4: scenario_record — a window where the USER
 * performs a flow, never driven by Claude; the draft comes back through job_status), and new themes (L3.5:
 * template_create_from_brand from the user's files; template_from_site — a draft read off a public page whose URL the
 * user approves, as a job), and frame comments (L3.6: comments_list with each thread's anchor and still, comment_reply,
 * comment_resolve with if_match — people create and reopen threads with `retake comment` or in the Studio, never through
 * this server; L4.6: comment_reply {proposal} for an edit-only change on a Studio thread, applied by the person there).
 * Nothing here opens a browser or runs a capture in this process: the workspace's jobs worker, a
 * separate process, runs them. L4.1: the same tools over Streamable HTTP too (`retake mcp --http`, http.ts: 127.0.0.1,
 * the engine's gate refusing any request a browser could send, a stable token in the Retake home).
 */
import { RETAKE_VERSION } from '@retake/core/base';
import { staleEngine } from '@retake/core/io';
import type { StaleEngine } from '@retake/core/io';
import { createEngine } from '@retake/engine';
import type { Engine } from '@retake/engine';
import type { Readable, Writable } from 'node:stream';
import { serveStdio } from './server.js';
import { INSTRUCTIONS, TOOLS, protocolTool, staleWords } from './tool-set.js';

export { INSTRUCTIONS, TOOLS, protocolTool, staleWords } from './tool-set.js';
export type { McpTools } from './tool-set.js';
export { DEFAULT_MCP_HTTP_PORT, MCP_HTTP_BODY_MAX, MCP_HTTP_PATH, startMcpHttpServer } from './http.js';
export type { McpHttpOptions, McpHttpServer } from './http.js';
export { PORT_LOOKUP_TIMEOUT_MS, listenersAreOurs, lsofPortListeners, portHolder } from './port-holder.js';
export type { PortHolderVerdict, PortListener, PortListenerLookup } from './port-holder.js';
export { MCP_HTTP_IDLE_MS, MCP_HTTP_SESSIONS_MAX } from './server.js';
export { UNTRUSTED_MAX, capUntrusted, errorResult, imageCaps, imageResult, okResult } from './result.js';
export {
  APPROVAL_TIMEOUT_MS,
  approvalForm,
  approvalMessage,
  approvalTimeoutMs,
  elicitationApprover,
  pruneApprovalForm,
  pruneApprovalMessage,
  siteApprovalForm,
  siteApprovalMessage,
} from './approval.js';
export type { ImageCaps, Thumbnailer, ToolImage, ToolOutput } from './result.js';
export type { ToolDef, ToolContext } from './tools/define.js';
/**
 * One call of an operation, SDK-free: the operation contract's (`invoke`, which the Studio's server runs its ops
 * through too). Its deprecated alias `callTool` (L7.13) was removed in L7.21.
 */
export { invoke } from '@retake/engine/contract';
export type { ToolCallOutcome } from '@retake/engine/contract';
export { COMMENTS_LIST_UNTRUSTED_MAX, COMMENT_ENTRIES_SHOWN } from './tools/comments.js';

export interface McpServerOptions {
  /** Workspace root (absolute). */
  root: string;
  stdin?: Readable;
  stdout?: Writable;
  /** Diagnostics (stderr by default): never the protocol stream. */
  log?: (message: string) => void;
  /** Whether the installed engine is newer than this process's (default: core `staleEngine`; tests set it). */
  stale?: () => StaleEngine | null;
}

/**
 * Serve the tools over stdio until the client disconnects. stdout belongs to the protocol: console.log / info / debug
 * of anything loaded in this process go to stderr from here on.
 */
export async function startMcpServer(o: McpServerOptions): Promise<void> {
  const log = o.log ?? ((m: string) => void process.stderr.write(`${m}\n`));
  if (!o.stdout || o.stdout === process.stdout) {
    const toStderr = (...args: unknown[]) => log(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
  }
  let engine: Promise<Engine> | undefined;
  const getEngine = () => (engine ??= createEngine({ root: o.root, client: 'mcp' }));
  await getEngine();
  // Hotfix v0.2.5: the installed engine is read again at each call; an update under this process stops it once the
  // call that saw it is answered.
  let stopNow: () => void = () => undefined;
  const stop = new Promise<void>((r) => (stopNow = r));
  const stale = o.stale ?? (() => staleEngine(RETAKE_VERSION));
  const onStale = (s: StaleEngine) => {
    log(`retake mcp: ${staleWords(s)}`);
    stopNow();
  };
  await serveStdio({
    name: 'retake',
    version: RETAKE_VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS.map((t) => protocolTool(t, getEngine, { stale, onStale })),
    stop,
    ...(o.stdin ? { stdin: o.stdin } : {}),
    ...(o.stdout ? { stdout: o.stdout } : {}),
    onError: (e) => log(`retake mcp: ${e.message}`),
  });
}
