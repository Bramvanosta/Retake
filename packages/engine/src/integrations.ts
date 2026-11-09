/**
 * @retake/engine/integrations — how Retake registers itself with the agents and the shell around it: the MCP
 * registration a client starts the server with (config-snippet.ts: the JSON block, the `claude mcp add` lines, the
 * Claude Code plugin route, a stable Node.js path), and the installed app's set-up (app-setup.ts: where the app runs
 * from, the `retake` command's link, the Claude Code plugin run, the Claude Desktop entry and its backups, the app's
 * own settings). The CLI (`retake mcp --print-config`, doctor) and the Studio's Set-up sheet (ui setup-ops.ts) import
 * it; the engine's operations do not. Reaches @retake/core only.
 */
export * from './integrations/app-setup.js';
export * from './integrations/config-snippet.js';
