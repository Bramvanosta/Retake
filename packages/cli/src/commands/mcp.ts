/**
 * `retake mcp`: the MCP server over stdio (L3.1), for Claude Code, Claude desktop or any MCP client. stdout carries the
 * protocol only: this command writes nothing else there (diagnostics go to stderr). `--print-config` prints the
 * registration instead. `--http` (L4.1) serves the same tools over Streamable HTTP on 127.0.0.1 (default port 47820)
 * behind the engine's gate, with the stable token of the Retake home (`--rotate-token` renews it); `--print-config
 * --http` prints that registration for Claude Code — the URL, and the token only by reference (its file, an
 * environment variable): never the token itself — and says that stdio is the safe default. A fixed port held by a
 * listener that is not this account's Retake MCP server is refused, with the advice to rotate the token.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientPath, findWorkspaceRoot } from '@retake/core/io';
import { EngineError } from '@retake/engine';
import {
  MCP_HTTP_TOKEN_ENV,
  SERVER_NAME,
  claudeCodeCommand,
  claudeCodeHttpCommand,
  mcpConfigJson,
  mcpHttpConfigJson,
  mcpHttpTokenExport,
  pluginInstallCommands,
  pluginMarketplaceRoot,
} from '@retake/engine/integrations';
import { EXIT, UsageError, errorText } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { cliPorts } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface McpCommandOptions {
  printConfig?: boolean;
  http?: boolean;
  port?: string;
  rotateToken?: boolean;
  json?: boolean;
}

function stopSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const stop = (s: NodeJS.Signals) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(s);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/** `--print-config --http` and `--http`: the registration, or the server until Ctrl-C / SIGTERM. */
async function mcpHttp(ui: Ui, root: string, opts: McpCommandOptions): Promise<ExitCode> {
  const mcp = await import('@retake/mcp');
  const { mcpHttpTokenFile, stableToken } = await import('@retake/engine');
  let port = mcp.DEFAULT_MCP_HTTP_PORT;
  if (opts.port !== undefined) {
    port = Number(opts.port);
    if (!/^\d+$/.test(opts.port) || port > 65535) throw new UsageError(`--port must be a port number from 0 to 65535, got "${opts.port}"`);
  }
  const file = mcpHttpTokenFile(cliPorts.env);
  let token;
  try {
    token = await stableToken(file, { rotate: opts.rotateToken === true });
  } catch (e) {
    if (e instanceof EngineError) {
      ui.error(`retake mcp --http: ${errorText(e)}`);
      return EXIT.failure;
    }
    throw e;
  }
  if (opts.printConfig) {
    if (port === 0) throw new UsageError('--print-config --http needs a fixed port: leave --port out (47820) or name one');
    const url = `http://127.0.0.1:${port}${mcp.MCP_HTTP_PATH}`;
    // Never the token itself (review A M1): the JSON names an environment variable, the command reads the token file.
    ui.result(JSON.stringify(mcpHttpConfigJson({ url }), null, 2));
    ui.line('');
    ui.line(
      'Claude Code, for every project of this user — instead of the stdio registration, not beside it (the shell reads the token from its file as the line runs; your history keeps $(cat …), not the token):',
    );
    ui.line(`  ${claudeCodeHttpCommand({ url, tokenFile: file })}`);
    ui.line(
      `Or the JSON above in .mcp.json at the workspace root: it holds no token (safe to commit), Claude Code reads it from $${MCP_HTTP_TOKEN_ENV} — set in the shell that starts claude (your shell profile):`,
    );
    ui.line(`  ${mcpHttpTokenExport(file)}`);
    ui.line(`Then keep the server running: retake --root ${root} mcp --http${opts.port !== undefined ? ` --port ${port}` : ''}`);
    ui.line(
      `The token (${file}, 0600) is a secret: whoever holds it drives this workspace's tools and answers their approval forms. Never paste it into a file you commit. retake mcp --http --rotate-token replaces it.`,
    );
    ui.line(
      `stdio (retake mcp --print-config, without --http) is the safe default: the client starts the server itself and nothing listens. Over HTTP, on a Mac shared with other accounts: while retake mcp --http is not running, another account's program can listen on port ${port} and receive the token your client sends — retake mcp --http refuses to start beside a listener that is not its own (stop it, then --rotate-token), but the client does not check the server it reaches.`,
    );
    if (token.rotated || token.created) ui.line(token.rotated ? 'A new token was written: register the server again.' : 'A token was created.');
    return EXIT.ok;
  }
  process.env.PATH = clientPath(process.execPath, process.env.PATH ?? '', undefined, root);
  let server;
  try {
    server = await mcp.startMcpHttpServer({ root, port, token: token.token, log: (m) => ui.line(m) });
  } catch (e) {
    if (e instanceof EngineError) {
      ui.error(`retake mcp --http: ${errorText(e)}`);
      return EXIT.failure;
    }
    throw e;
  }
  if (opts.json) ui.result(JSON.stringify({ type: 'mcp-http', url: server.url, port: server.port, pid: process.pid }));
  else {
    ui.line(`Retake MCP serves ${root} at ${server.url} — Ctrl-C stops it.`);
    if (token.rotated) ui.line('The token was replaced: register the server again (retake mcp --print-config --http).');
    else if (token.created) ui.line('A token was created: register the server with retake mcp --print-config --http.');
    else ui.line('Registered once with retake mcp --print-config --http; the token stays the same across restarts.');
  }
  const signal = await stopSignal();
  await server.close();
  if (!opts.json) ui.line(`Retake MCP stopped (${signal}).`);
  return EXIT.ok;
}

/** The built entry point (dist/bin.js), also when this runs from the sources (tests). */
export function studioBin(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // …/dist/commands or …/src/commands
  const pkg = dirname(here);
  return basename(pkg) === 'src' ? join(dirname(pkg), 'dist', 'bin.js') : join(pkg, 'bin.js');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The workspace root `retake mcp` (and `retake ui`) serves: `--root`, $RETAKE_ROOT or the retake.yaml lookup; it
 * must look like one.
 */
export function workspaceRoot(global: GlobalOptions): string | undefined {
  const root = global.root ? resolve(global.root) : findWorkspaceRoot();
  return existsSync(join(root, 'retake.yaml')) || isDir(join(root, 'projects')) ? root : undefined;
}

export async function mcpCommand(ui: Ui, global: GlobalOptions, opts: McpCommandOptions): Promise<ExitCode> {
  const root = workspaceRoot(global);
  if (!root) {
    ui.error(
      'retake mcp: no workspace here (no retake.yaml or projects/ folder): pass --root <workspace folder> or set RETAKE_ROOT (`retake mcp --root <dir> --print-config` prints the registration)',
    );
    return EXIT.usage;
  }
  if ((opts.port !== undefined || opts.rotateToken || opts.json) && !opts.http) throw new UsageError('--port, --rotate-token and --json go with --http');
  if (opts.http) return mcpHttp(ui, root, opts);
  const mcp = await import('@retake/mcp');
  if (opts.printConfig) {
    const input = { root, bin: studioBin(), env: cliPorts.env };
    ui.result(JSON.stringify(mcpConfigJson(input), null, 2));
    ui.line('');
    const repo = pluginMarketplaceRoot(input.bin);
    const either = repo ? 'Either Claude Code with the server alone' : 'Claude Code';
    ui.line(`${either}, for every project of this user (or put the JSON above in .mcp.json at the workspace root):`);
    ui.line(`  ${claudeCodeCommand(input)}`);
    if (repo) {
      ui.line(`Or the Claude Code plugin (the Retake skills and this server), enabled in this workspace folder only — not both, or Claude Code gets two ${SERVER_NAME} servers:`);
      for (const l of pluginInstallCommands({ ...input, repo })) ui.line(`  ${l}`);
      ui.line(
        `  (run the install line again to change a value; skills edited in ${join(repo, 'skills')} load at the next session. claude --plugin-dir is for editing the skills: it loads them without this server's values.)`,
      );
    }
    ui.line('Claude desktop: the JSON above in ~/Library/Application Support/Claude/claude_desktop_config.json, then restart it.');
    ui.line(
      'Secrets that {{env:…}} references need go in "env" (or the keychain): a GUI client does not read your shell profile. The plugin carries none: use the keychain, or the registration above.',
    );
    return EXIT.ok;
  }
  // A client may start the server with a bare PATH (Claude desktop, a plugin): complete it like a registration's, absolute
  // entries only and none inside the workspace (the cwd is the client's project folder, the agent writes files in the
  // workspace), so the server and the jobs worker it starts find ffmpeg & co., never a program the agent wrote.
  process.env.PATH = clientPath(process.execPath, process.env.PATH ?? '', undefined, root);
  await mcp.startMcpServer({ root, log: (m) => ui.line(m) });
  return EXIT.ok;
}
