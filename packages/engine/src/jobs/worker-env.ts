/**
 * The environment of a jobs worker a client starts (L4.2, critique B5; review A #3, B L5). A dry run or a capture runs
 * in the worker, which keeps the environment it was started with and serves every later job of the workspace — so any
 * client but the CLI (the Studio, an MCP client, a test) hands it a clean one, never more than a worker started from a
 * terminal (`retake worker`) needs:
 *
 * - PATH sanitised like `retake mcp`'s (core clientPath): absolute entries only, none a package manager added for the
 *   script it runs (`node_modules/.bin`, corepack), none inside the workspace under any spelling (an agent writes files
 *   there), the node that runs the client first, Homebrew / system folders completed;
 * - no variable a package manager sets for a script (`npm_*`, `pnpm_*`, `INIT_CWD`: `npm_config_*` may carry a
 *   registry token), no MCP HTTP token (the worker never calls the MCP server), no credential of a model or of the
 *   tools around an agent (ANTHROPIC_*, CLAUDE_* / CLAUDECODE, OPENAI_*, AWS_BEARER_TOKEN_BEDROCK, Gemini / Mistral /
 *   … keys, GitHub / npm tokens): the tool never calls a model nor a registry;
 * - nothing that makes node or the system load code from the workspace: NODE_OPTIONS naming a file to load
 *   (`--require`, `--import`, `--loader`…: a relative one resolves in the worker's cwd, the workspace), NODE_PATH /
 *   DYLD_* / LD_PRELOAD / LD_LIBRARY_PATH holding a relative entry or one inside a folder of the workspace (its root,
 *   projects, templates or components folder: `folders`);
 * - the tool variables (`RETAKE_FFMPEG`, `RETAKE_FFPROBE`, `RETAKE_CHROMIUM`, `RETAKE_CHROMIUM_HEADLESS_SHELL`,
 *   `RETAKE_DOCKER`, `PLAYWRIGHT_BROWSERS_PATH`) are kept as they are: the worker serves trust `mcp` (core
 *   agent-policy.ts), so a job whose program one of them names by a relative path or inside the workspace fails before
 *   that program starts and says what to change — rather than running another program than the person named;
 * - RETAKE_HOME kept, made absolute (the signed-in profiles live there; the worker's cwd is the workspace).
 *
 * Everything else stays: an automated sign-in's `{{env:NAME}}` secrets (project.yaml) are read by the worker from its
 * environment, as for a worker started in a terminal.
 */
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { LOAD_PATH_ENV, NODE_OPTIONS_LOADS, clientPath, isUnder, loadPathSeparator, retakeHome } from '@retake/core';

/** Variables a worker started by a client never gets. */
export const WORKER_ENV_DROPPED: readonly RegExp[] = [
  // package managers (a registry token may be in npm_config_*)
  /^npm_/i,
  /^pnpm_/i,
  /^INIT_CWD$/,
  /^COREPACK_/,
  /^(?:NPM|NODE_AUTH|YARN_NPM_AUTH)_TOKEN$/,
  // the MCP server's HTTP token
  /^RETAKE_MCP_TOKEN$/,
  // models and the agent around them
  /^ANTHROPIC_/,
  /^CLAUDE/,
  /^OPENAI_/,
  /^AZURE_OPENAI_/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^(?:GEMINI|GOOGLE_GENERATIVE_AI|GOOGLE_AI|VERTEX_AI)_/,
  /^GOOGLE_API_KEY$/,
  /^(?:MISTRAL|COHERE|CO|GROQ|XAI|DEEPSEEK|OPENROUTER|PERPLEXITY|TOGETHER|FIREWORKS|REPLICATE|VOYAGE)_API_(?:KEY|TOKEN)$/,
  /^(?:HF|HUGGING_FACE_HUB|HUGGINGFACE)_TOKEN$/,
  // code hosts
  /^(?:GH|GITHUB|GITLAB)_TOKEN$/,
  /^GH_ENTERPRISE_TOKEN$/,
];

/** Whether a path-list variable has an entry that is relative or inside one of the workspace folders. */
function loadsFromWorkspace(value: string, folders: readonly string[], sepRe: RegExp): boolean {
  return value
    .split(sepRe)
    .filter((p) => p !== '')
    .some((p) => !isAbsolute(p) || folders.some((f) => isUnder(p, f)));
}

export interface WorkerEnvOptions {
  /** The node the worker runs with (its folder goes first on the PATH). */
  node?: string;
  exists?: (p: string) => boolean;
  /**
   * All the folders of the workspace (core workspaceFolders: its root, projects, templates and components folders,
   * which may lie outside the root); default the root alone.
   */
  folders?: readonly string[];
}

/** The environment of a worker a client (anything but the CLI) starts for the workspace `root`. */
export function cleanWorkerEnv(env: NodeJS.ProcessEnv, root: string, o: WorkerEnvOptions = {}): NodeJS.ProcessEnv {
  const folders = [...new Set([root, ...(o.folders ?? [])])];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || WORKER_ENV_DROPPED.some((re) => re.test(k))) continue;
    // The NODE_OPTIONS flags and path lists of core agent-policy.ts (its loader variables).
    if (k === 'NODE_OPTIONS' && NODE_OPTIONS_LOADS.test(v)) continue;
    if (LOAD_PATH_ENV.test(k) && loadsFromWorkspace(v, folders, loadPathSeparator(k, delimiter))) continue;
    out[k] = v;
  }
  out.PATH = clientPath(o.node ?? process.execPath, env.PATH ?? '', o.exists ?? existsSync, folders);
  if (env.RETAKE_HOME?.trim()) out.RETAKE_HOME = retakeHome(env);
  return out;
}
