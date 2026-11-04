# Upgrading from before L5.13

Retake had another name before lot L5.13. This page moves an installation of that time to the current names. Part of the [Retake guide](README.md).

<!-- old-name:begin — the upgrade from the name before L5.13 (the guard test allows this region) -->
## Upgrading from Demo Studio (before L5.13)

Retake was called Demo Studio before L5.13: command `studio`, home `~/.demo-studio`, workspace file `studio.yaml`,
tool folders `.demo-studio/`, variables `DEMO_STUDIO_*`, packages `@demo-studio/*`. Nothing reads those names any more
and nothing moves them for you: `retake doctor` lists what is left (its "Before Retake" lines, each with the command),
the CLI prints one line on stderr while the old home holds your only sign-ins, and the Studio says so in its sidebar.
In this order:

1. **Stop everything of the old build first**: the Studio and the desktop app, MCP clients (Claude Code, Claude
   desktop), the jobs worker (`studio jobs` shows its pid) and every sandbox (`studio sandbox down <project>`). A Docker
   sandbox left up keeps running under its `demo-studio-*` name until its project's tool folder is moved (step 4);
   `retake sandbox down` then takes it down. `retake ui`, `retake mcp`, a jobs worker, `retake sandbox up / reset`,
   `retake run --sandbox`, `retake env reset` and `retake record` refuse to start while a Studio or a worker of the old
   build still holds the workspace (its `.demo-studio/ui.json` or `workers/worker.lock` names a running process); when
   none runs any more, remove the file the refusal names.
2. Pull, then `pnpm install --frozen-lockfile --offline && pnpm build`.
3. **The home** (signed-in profiles and sessions, the approval key, the HTTP MCP token, the desktop app's settings):
   `mv ~/.demo-studio ~/.retake`. When `~/.retake` exists already (the tool recreated `approvals.key`,
   `mcp-http.token` or `desktop.json` by itself): `mv ~/.retake ~/.retake.after-upgrade && mv ~/.demo-studio ~/.retake`.
   A home of your own named by `DEMO_STUDIO_HOME` is named by `RETAKE_HOME` now (while only the old variable is set,
   every command says so on stderr, and the Studio and Claude's `engine_info` say it too — naming that folder, not
   `~/.demo-studio`, when it holds the only sign-ins): set `RETAKE_HOME` to it, or move it to `~/.retake`.
4. **Each workspace**: `mv studio.yaml retake.yaml` (a workspace whose only workspace file is `studio.yaml` is refused
   with that command), `mv .demo-studio .retake` at its root and in each project (pending rollback journals live there:
   `retake env reset` finds them only once moved), and `.retake/` in the workspace's `.gitignore` **and in each
   project's own `.gitignore`** (every project the tool made lists `.demo-studio/` there: moved, its `.retake/` — stills
   of your product, journals, sandbox state — would be committed): `for f in .gitignore projects/*/.gitignore; do
   grep -qx '.retake/' "$f" || printf '.retake/\n' >> "$f"; done` (doctor names each file left).
5. **Variables**: rename every `DEMO_STUDIO_*` to `RETAKE_*` where it is set (your shell profile, the `env` of an MCP
   registration). For hook shells, seed steps and sandbox services the tool still writes `DEMO_STUDIO_SANDBOX`,
   `DEMO_STUDIO_RUN_ID`, `DEMO_STUDIO_ENV`, `DEMO_STUDIO_PROJECT_DIR` and `DEMO_STUDIO_ALLOWED_HOSTS` next to the
   `RETAKE_*` ones, so a script or a product server that switches on them keeps working; move them to the new names —
   `grep -rn DEMO_STUDIO_ <your product repository> <workspace>/projects` — a later version stops writing the old ones.
6. **Your components** import `@retake/components/kit` (one importing `@demo-studio/components/kit` is refused with
   that message): `grep -rl '@demo-studio/components/kit' <workspace>/components | xargs sed -i '' 's#@demo-studio/components/kit#@retake/components/kit#'`.
7. **MCP and the plugin** (the tool never edits your Claude configuration): `claude mcp remove demo-studio` (with the
   `--scope` it was added with), `cd <workspace> && claude plugin uninstall demo-studio@demo-studio --scope local` (the
   local scope is the folder's: run it from the workspace) and `claude plugin marketplace remove demo-studio`; then
   register again from `retake mcp --print-config` (the plugin's entry-point value is `cli=` now). Permission lists
   naming `mcp__demo-studio__*` become `mcp__retake__*` (the plugin's: `mcp__plugin_retake_retake__*`). A workspace
   `.mcp.json` with a `demo-studio` server: `grep -n demo-studio <workspace>/.mcp.json`. **Claude desktop**: in
   `~/Library/Application Support/Claude/claude_desktop_config.json`, replace the `demo-studio` entry of `mcpServers`
   by the `retake` one `retake mcp --print-config` prints, then restart Claude. **Your shell**: an `alias studio=…` in
   your profile or a `~/.local/bin/studio` link from the old instructions keeps the old command alive — remove it
   (`grep -n 'studio' ~/.zshrc`, `ls -l ~/.local/bin/studio`) and make the `retake` one if you want it.
8. **The desktop app**: `pnpm desktop:build` builds `Retake.app` (identifier `local.retake.desktop`); delete the old
   `Demo Studio.app` yourself (`pnpm desktop:clean` only unregisters `Retake.app`). macOS asks again for notifications
   and for the local network; the old "Demo Studio" entries stay in System Settings until you remove them.
9. **Docker**: the first take re-seeds and re-snapshots each sandbox (the snapshot's name changed). Old objects:
   `docker ps -a --filter name=demo-studio-`, `docker volume ls --filter name=demo-studio-`,
   `docker image ls 'demo-studio*'` — remove them (`docker rm`, `docker volume rm`, `docker image rm`) once nothing
   needs them.
10. Run `retake doctor` until it shows no "Before Retake" line.

Themes the tool made before (`.demo-studio-theme.json`) and raw packages exported before
(`kind: demo-studio/raw-capture`) are still recognised as the tool's: `--replace` and a new export to the same folder
work. Renaming the folder of your clone is optional (register MCP and the plugin again and rebuild the desktop app if
you do).
<!-- old-name:end -->
