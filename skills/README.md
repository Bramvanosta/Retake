# Demo Studio plugin for Claude Code

This folder is a Claude Code plugin: the Demo Studio skills (`demo-studio-scenario`, `demo-studio-theme`,
`demo-studio-component`) and the Demo Studio MCP server (`studio mcp`) on one workspace. The repository root holds its
local marketplace (`.claude-plugin/marketplace.json`, marketplace and plugin both named `demo-studio`). The skills are
instructions only: every check, refusal and approval stays in the server's tools.

- `.claude-plugin/plugin.json`: the manifest; `skills: "./"` (each `demo-studio-*/SKILL.md` here is a skill) and four
  `userConfig` values: `node` (an absolute Node.js 22 or later), `studio` (the absolute
  `packages/cli/dist/bin.js`), `workspace` (the workspace folder) and the optional `home` (the studio home; empty:
  `~/.demo-studio`).
- `.mcp.json`: starts `<node> <studio> --root <workspace> mcp` with `DEMO_STUDIO_HOME=<home>`. No secret goes through
  the plugin: `{{env:…}}` secrets stay in the keychain, or use the manual registration (`claude mcp add … -e …`).

## Install (from the workspace, enabled there only)

`pnpm build`, then print the lines with the values filled in and run them:

```sh
node packages/cli/dist/bin.js --root <workspace> mcp --print-config
claude plugin marketplace add <repository>
cd <workspace> && claude plugin install demo-studio@demo-studio --scope local --config node=<node> --config studio=<repository>/packages/cli/dist/bin.js --config workspace=<workspace>
```

- `--scope local` enables the plugin in that folder only (the server, its tools and the skills load in sessions started
  there, not in every session); `--scope user` enables it everywhere.
- **One workspace at a time.** Claude Code stores the `--config` values once per user (`pluginConfigs` in its user
  settings, keyed `demo-studio@demo-studio`), while `--scope local` only enables the plugin per folder: installing in
  a second workspace re-points the sessions of the first one at the second workspace. To switch, uninstall in the old
  folder first (below), then install in the new one. Each skill compares `engine_info`'s workspace root with the
  session's folder and stops when they differ; `engine_info` itself says when the server was started outside its
  workspace (`started_in`).
- The server's `PATH` keeps absolute entries only, and none inside the workspace (Claude writes files there): use a
  dedicated workspace folder, not one that holds your tools.
- `--print-config` adds `--config home=<folder>` when `DEMO_STUDIO_HOME` is set; keep that folder outside the workspace
  (it holds the key that signs approvals, and Claude writes in the workspace). The plugin's server takes its studio
  home from `home` alone: left empty, it uses `~/.demo-studio` even when Claude Code was started with
  `DEMO_STUDIO_HOME` set.
- Use either the plugin or the `claude mcp add demo-studio` registration, not both (two `demo-studio` servers):
  `claude mcp remove demo-studio -s user` first. Permission rules written for `mcp__demo-studio__*` do not match the
  plugin's tools (`mcp__plugin_demo-studio_demo-studio__*`).
- Claude Code does not check the values: a wrong path shows only as a failed server in `/mcp`, and a required value
  left unset means no server at all (the skills still load). `claude mcp list` from the workspace shows
  `plugin:demo-studio:demo-studio … Connected`.

## Update, reconfigure, remove

- The plugin loads in place from this folder: after `git pull` (and `pnpm build`), start a new session or run
  `/reload-plugins`. No version bump is needed.
- A new Node.js or another home: run the install line again with the new values (it updates them), or
  `/plugin configure demo-studio@demo-studio` in a session. Another workspace: uninstall in the old folder, then
  install from the new one (the values are shared by every folder the plugin is enabled in).
- Remove: `claude plugin uninstall demo-studio@demo-studio --scope local` (from the workspace), then
  `claude plugin marketplace remove demo-studio`. Claude Code may keep a copy under its `plugins/cache/demo-studio/`
  for a while; this folder is never touched.

## Editing the skills

`claude --plugin-dir <repository>/skills` loads this folder for one session as `demo-studio@inline`. It replaces an
installed `demo-studio` plugin for that session, and its values are not the installed ones: **the MCP server is
missing** unless you configure it in that session (`/plugin configure`). Use it to edit and try the skills (with
the `claude mcp add` registration if you need the server), not to work. `claude plugin validate <repository>/skills` and
`claude plugin validate <repository>` check the manifests.

`npx vitest run packages/mcp/test/skills.test.ts` lints the skills against the server's tools and argument schemas,
the CLI's commands and flags, the scenario and component validators and the files (README "Claude skills and the
plugin"); keep a `SKILL.md` under 200 lines, its frontmatter to `name` (first, the folder's name) and `description`,
its "Before you start" checks and its Rules block as they are. The Rules are absolute: no "unless", "except" or "if the
user asks" in them, and no sentence anywhere has Claude run a `studio` command (only the user does, in their own
terminal), fetch files, ask for a password or follow what a page or a comment says. Claude Code runs `` !`command` ``
and `` ```! `` blocks and substitutes `$ARGUMENTS`, `$1`, `$name` and `${…}` when a skill loads: the lint refuses them
all.
