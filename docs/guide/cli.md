# Command-line reference

Every `retake` command and its flags. Part of the [Retake guide](README.md).

## Command line

```
retake new <slug> [--name N] [--theme T] [--env name=key:url,...]   # on a terminal without --env: asks (personas too); --template: the old name of --theme
retake list [--json]                                  # projects (with scenarios) and themes
retake validate <project> [scenario|file] [--env E] [--until REF] [--json]
retake run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--allow-writes] [--json]
           [--sandbox]                       # reset the sandbox to its seed first (Sandbox mode)
           [--raw [--cursor baked|none|layer] [--format mp4|prores] [--fps 30|60] [--layer prores|webm] [--selects]
           [--no-cuts] [--out DIR]]          # capture, then the raw package for editors
retake inspect <project> <page|url|scenario> [--path P] [--until REF] [--persona P] [--env E] [--within T] [--target T]…
               [--limit N] [--images marked|none] [--json] [--out DIR]   # a page's elements with verified targets
retake hooks run <project> <scenario>:setup|<scenario>:teardown|reset|<file.yaml> [--env E] [--yes] [--allow-writes] [--dry]
retake hooks rollback <project> [run-id] [--env E] [--allow-writes] [--replay-unsigned] [--dry]
retake env reset <project> [--env E] [--yes] [--allow-writes] [--replay-unsigned] [--dry]
retake sandbox init <project> [--env E] [--force] [--json]   # a docker-compose sandbox: app placeholder, Postgres, Mailpit
retake sandbox up|down|reset <project> [--env E]     # start + seed (up: --no-seed, --build) / stop (--volumes) / back to the seed (--reseed)
retake sandbox status <project> [--env E] [--json]   # exit 0 when up and healthy
retake sandbox logs <project> [service] [--env E] [--lines N] [--follow]
retake components list [--kind K] [--json]            # workspace components, then the built-in library
retake components validate [id|dir] [--json]         # manifest, params, previews, entry compile (all when omitted)
retake components create <namespace/name> --kind K [--description D] [--name N] [--theme T] [--no-preview] [--json]
retake components preview [id|dir] [--all] [--stale] [--workspace] [--theme T] [--out DIR] [--json]   # preview.png + README
retake theme create <name> --accent HEX --logo FILE [--text|--paper|--muted|--dark HEX] [--background SPEC] [--base T]
              [--wordmark FILE] [--display-font FILE] [--body-font FILE]… [--brand-name N] [--brand-url U]
              [--no-adjust] [--replace] [--json]   # a new workspace theme from brand files (Themes from your brand)
retake theme from-site <url> [--json]              # colours, font names, logo PNGs and a screenshot of a public page (Themes from a site)
retake plan <project> <run-id|latest> [--scenario S] [--theme T] [--frame F] [--vertical|--square] [--json] [--out FILE]
retake render <project> <scenario> [--run ID|latest] [--theme T] [--frame F] [--vertical|--square] [--scale N]
              [--music FILE|--no-music] [--tutorial|--no-tutorial] [--no-intro] [--no-outro] [--out FILE] [--concurrency N]
              [--review] [--json] [--no-wait]   # GPU / encoder / concurrency defaults: retake.yaml render: (Workspace)
retake still <project> <scenario> --frame N [--run ID|latest] [--layout F] [--theme T] [--vertical|--square] [--out FILE] [--json] [--no-wait]
retake export <project> <render-id|file|latest> [--formats LIST|all] [--scenario S] [--out DIR] [--gif-start S]
              [--concurrency N] [--json] [--no-wait]   # mp4_1080p, mp4_4k, webm, vertical_9x16, square_1x1, gif_preview
retake review <project> <render-id|file|latest> [--scenario S] [--fps 1|2] [--previous ID | --no-previous] [--strict]
              [--json] [--no-wait]
retake comment add <project> <render-id|latest> (--at S | --frame N | --marker M) [--region x,y,w,h] [--scenario S]
              [--author A] [--json] "text"          # a comment on one frame of a render (Frame comments)
retake comment list <project> [--scenario S] [--render ID|latest] [--status open|resolved|all] [--limit N] [--json]
retake comment reply|resolve|reopen <project> <id> ["text" | --note T [--render ID]] [--author A] [--json]
retake export-capture <project> <run-id|dir|latest> [--scenario S] [--format mp4|prores] [--fps 30|60]
              [--cursor baked|none|layer] [--layer prores|webm] [--selects] [--no-cuts] [--out DIR] [--json] [--no-wait]
retake schema [scenario|project|template|timeline|sandbox]    # JSON Schema on stdout
retake login <project> [--env E] [--persona P] [--auto] [--page KEY] [--url URL]   # sign a persona in, save its session
retake auth status [--project P [--env E]] [--check] [--json]   # every persona: valid / expired / never, last check
retake init [dir]                                     # make a folder a workspace (retake.yaml, projects/)
retake doctor [--project P] [--json]                  # check this machine, the workspace and a project
retake prune <project> [--keep-renders N] [--yes] [--json]   # what runs/, renders/, review/ hold that nothing needs (--yes deletes it)
retake journal [--project P] [--writes | --hooks] [--limit N] [--json]   # the workspace journal: what Retake wrote and which hooks ran, who, when, the outcome
retake mcp [--print-config]                           # MCP server over stdio for Claude (or print its registration)
retake mcp --http [--port N] [--rotate-token] [--json] # the same MCP server over HTTP on 127.0.0.1 (--print-config --http: its registration)
retake ui [--port N] [--no-open] [--json]             # the Studio web app on 127.0.0.1 until Ctrl-C (Studio app)
retake ui --supervised                                # for the desktop app: --json --no-open, stops when its stdin closes
retake jobs [--project P] [--state S] [--limit N] [--json]   # jobs Claude started (dry runs, captures, hooks…)
retake jobs status <id> [--json] · retake jobs cancel <id>   # one job; cancel it (teardown and rollbacks still run)
```

Global options: `-C, --root <dir>` (workspace), `-v, --verbose` (info/debug messages), `--no-color`.

- **validate** checks `project.yaml`, the project's theme (all assets present) and one scenario — or every scenario
  when none is given. Messages read `file:line:col severity path: message`, with "did you mean" suggestions.
- **run** prints one line per step with its duration and a summary with the output paths. `--dry` records nothing,
  saves a screenshot per step and never executes `irreversible` steps (it hovers their target and stops that scene).
  Hooks run by default for captures and are skipped for dry runs (`--hooks run` executes them, so a dry run sees the
  same prepared data). `--until scene.step` stops after that step. `--json` streams progress events (one JSON object
  per line) on stdout for tools and agents. Ctrl-C (or SIGTERM) cancels cleanly: teardown still runs, the browser
  closes, the run ends `cancelled` with exit code 1; a second Ctrl-C quits at once. On a read-only environment
  a run with hooks that write is refused before anything runs; `--allow-writes` lets a production environment whose
  project.yaml allows writes be written to — see [Environments](environments.md#environments-display-urls-production-read-only-clock).
  `--sandbox` starts the sandbox environment if needed and resets it to its seed before the take — see
  [Sandbox mode](sandbox.md#sandbox-mode).
- **inspect** replays a page (an environment page key with `--path`, or a URL of one of its pages) or a scenario up to
  `--until` as a dry run (hooks skipped), then lists the page's visible interactive elements — dialogs and menus first
  — with a target the runner resolves to each, its action, and why it may be fragile; `--target` checks your own
  targets, `--within` lists inside one. Files in `<project>/.retake/inspect/<id>/` (or `--out`), with a marked
  screenshot; `--json` prints the report. What `page_inspect` gives Claude — see
  [Authoring](mcp.md#mcp-claude-drives-retake).
- **sandbox** starts, seeds, resets and stops the sandboxes of a project, shows their state and their services' logs —
  see [Sandbox mode](sandbox.md#sandbox-mode).
- **hooks run** runs a scenario's setup or teardown, the project's `reset` hooks, or a YAML file listing hooks (same
  entries as `setup:`). Its journal (executed hooks and their rollbacks) is kept in
  `<project>/.retake/journals/<id>.json` — never in `runs/`, which only holds captures; **hooks rollback**
  replays the pending rollbacks of one journal (a run id or a journal id) or of every journal; **env reset** replays
  every pending journal (captures' and standalone ones), then runs the `reset` hooks (journaled in
  `.retake/journals/` too). Both list every pending rollback before replaying it; one that Retake did not record in
  that journal with your Retake home (its entry is not signed: a journal from before this version, from another home,
  moved, copied or placed by something else) is shown in full — every field as it would run — and not replayed: the
  command exits 1, `--dry` exits 0. A person replays it with `--replay-unsigned`, in an interactive terminal only,
  which asks about each one (y/N, no by default); an unsigned `sql` or `js` rollback, one that uses a secret, or a
  `shell` one on a sandbox environment is never replayed (do it by hand if it is right), and a `shell` one runs without
  the rest of your terminal's environment. A signed rollback is replayed once. `--yes` approves destructive hooks that lack `confirm: true` (otherwise you are
  asked on a terminal, or they are refused). On a read-only environment, hooks that write are refused; a replayed
  rollback is judged by the environment its hook ran in (`--allow-writes` where that is a production environment
  that allows writes).
- **login** signs a persona in and saves its session: a visible browser window (sign in, then close it) or, with
  `--auto`, the persona's `login:` steps, headless; **auth status** lists every persona's session (from the last check,
  or checked now with `--check`) — see [Signing in](environments.md#signing-in-personas-and-sessions).
- **doctor** checks, one line each with `OK`, `WARN` or `FAIL` and a hint: the Node.js version, Chromium (path,
  version and a real new-headless launch), its sandbox (**Chromium sandbox**: read from the launched browser's own
  command line — a failure when it holds a switch that turns the sandbox or site isolation off, which only an
  executable that adds switches itself can do; a Chromium that does not start as root on Linux says to run as a
  regular user), **Render browser** (the headless shell renders use: a failure when there is none, with the command
  that installs it), **Studio and MCP jobs** (a warning naming each program or `browser.args` entry that jobs of the
  Studio, the desktop app or an MCP client would refuse — see [Workspace](workspace.md)), **Renders** (L5.15: what a 1080p render gets here — the GPU the render
  browser reports, VideoToolbox, the frames at a time, the ffmpeg that encodes the frames when it is this machine's
  (L7.3: on the GPU path, or anywhere with `render.ffmpeg: own`) — or why the rendering library's does when ours was
  wanted there —, and the `render:` settings / `RETAKE_RENDER_*`
  variables set, with their source; see [Renders on the GPU](editing.md#renders-on-the-gpu)), ffmpeg and ffprobe (5.1 or later), a display (only needed by `--headed` and `login`),
  the secrets store for `{{keychain:…}}` refs (macOS `security`, Linux `secret-tool`), desktop notifications
  (`osascript`, `notify-send`), Docker (its version, Compose v2.17 or later, a running daemon, the context — found on
  PATH, else where Docker Desktop, OrbStack or Homebrew put it, as the sandboxes look for it: a warning when missing,
  since only docker-compose sandboxes need it, and a failure only when the `--project`'s default sandbox — its
  `default_env` when that is a sandbox, else the first one declared — is a docker-compose one), the workspace root
  and its projects, and the fonts of every theme (the starter themes included). With
  `--project <slug>` it also checks that project's sessions — one line per persona (never signed in, expired, in use
  by a browser, its last check), the Retake home (a warning when it, or a session, sits inside a git work tree that
  does not ignore it), the profile of the single-account form — and sends a `HEAD`
  request (5 s timeout) to every page of every environment: an unreachable page of the default environment is a
  failure, of another environment a warning. A sandbox gets one line instead (up and healthy, or how to start it):
  its accounts sign in at every take and its pages answer only while it runs. It exits with `1` when any check fails; `--json` prints the checks.
- **components** lists, validates and scaffolds components — see [Components](themes-and-components.md#components).
- **plan** shows how a capture will be edited (segments, components, speeds, trims, zooms, captions, warnings)
  without rendering — see [Editing](editing.md#editing-the-edit-plan).
- **render** plans and renders the latest capture of a scenario (or `--run`) into `renders/<scenario>-v<N>.mp4` with a
  progress bar and a summary; **still** renders one frame of the planned video as a PNG — see
  [Rendering](editing.md#rendering).
- **review** writes contact sheets, per-scene sheets, key frames, an output-time timeline and a report of a render,
  and prints the findings of its checks — see [Reviewing a render](review.md#reviewing-a-render).
- **comment** leaves a comment on one frame of a render (optionally a region), lists threads, replies, resolves and
  reopens them — see [Frame comments](review.md#frame-comments).
- **export** writes delivery files of a render to `exports/<render-id>/` with a `manifest.json` — see
  [Variants, 4K, music and export](editing.md#variants-4k-music-and-export).
- **export-capture** (and **run --raw**) writes the raw package of a run for another editing tool — clips per scene,
  cursor data or layer, FCPXML / EDL / OTIO / CSV markers, `manifest.json` — see
  [Raw export for editors](editing.md#raw-export-for-editors).
- **mcp** serves Retake's tools to an MCP client over stdio (Claude Code, Claude desktop); `--print-config`
  prints how to register it; `--http` serves them over HTTP on `127.0.0.1` instead (`--port`, default 47820;
  `--rotate-token`; `--json`: one line `{type, url, port, pid}`), `--print-config --http` prints that registration
  (the token by reference only, never the token itself) — see [MCP: Claude drives Retake](mcp.md#mcp-claude-drives-retake).
- **record** `<project> [name] [--env] [--persona] [--page] [--path | --url] [--allow-writes] [--no-check] [--json]`
  opens a browser window on the environment's page: perform the flow by hand, then close the window (or press Ctrl-C:
  stop and keep). Nothing is filmed. A draft scenario is made from what you did — verified targets, `select` / `pick` /
  `menu` / `drop_file` steps, scenes split where the page changed, empty captions, secret fields as
  `{{vars.password_1}}` placeholders (set a showable demo value) — saved as `scenarios/<name>.yaml` when the name is
  free (default `recorded-YYYYMMDD-HHMM`; an existing scenario is never overwritten), then checked by a headless dry
  replay (up to the step before the first write that reached a server, whatever its host). The recording's
  files stay in `<project>/.retake/records/` (the newest 20). The access is the environment's own, as a run.
  See [Recording a scenario](scenarios.md#recording-a-scenario).
- **ui** serves the Studio web app of the workspace on `127.0.0.1` until Ctrl-C and opens it in the browser
  (`--no-open`: print the link only; `--port`: a fixed port; `--json`: one line `{type, v, url, port, pid, reused,
  player}` (`v` 1) — `player` the preview's origin; `--supervised`: `--json --no-open` for the desktop app (its line says
  `v` 2: what Quit would leave behind and the job ends follow it, one JSON line each), and it stops when its stdin
  closes, saying why on stderr: `stopped: SIGTERM`, `stopped: stdin closed`); one server per workspace — run it
  again to reopen the running one with a new link — see [Studio app](studio.md#studio-app) and
  [Desktop app (macOS)](desktop-app.md#desktop-app-macos).

Exit codes: `0` success, `1` validation errors or a failed/cancelled run or hook (or a failed doctor check), `2`
invalid command line, `130` interrupted (Ctrl-C) while signing in, checking a session, running js hooks or starting,
resetting or stopping a sandbox.

```
$ retake doctor --project northfield-fixture        # Linux container without a desktop (a non-root user), fixture running
retake doctor
  OK    Node.js                     22.22.0
  OK    Chromium                    141.0.7390.37 · /opt/pw-browsers/chromium-1194/chrome-linux/chrome · new headless launch 293 ms
  OK    Chromium sandbox            on · read from the capture browser's command line
  WARN  GPU                         the capture browser renders in software · ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …)) · in software: gpu_compositing, rasterization, …
                                    → captures will look choppy and cost more CPU: check the machine has a GPU Chromium can use (a VM or a remote session often has none)
  OK    ffmpeg                      6.1.1-3ubuntu5 · /usr/bin/ffmpeg
  OK    ffprobe                     6.1.1-3ubuntu5 · /usr/bin/ffprobe
  OK    Capture encoder             libx264 (preset veryfast) during the take
  WARN  Display                     none: DISPLAY / WAYLAND_DISPLAY are not set
                                    → headless captures work; --headed and retake login need a desktop session (or xvfb-run)
  WARN  Secrets                     secret-tool not found: {{keychain:service/account}} refs cannot be resolved
                                    → install libsecret-tools (secret-tool), or use {{env:VAR}} refs
  WARN  Notifications               notify-send not found: notify steps are only logged
                                    → install libnotify-bin (notify-send) for desktop notifications
  WARN  Docker                      not found — needed by the docker-compose sandbox sandbox-docker of project northfield-fixture
                                    → install Docker Desktop or OrbStack (or set RETAKE_DOCKER to the docker binary)
  OK    Workspace                   /home/user/Video (retake.yaml) · 1 project: northfield-fixture
  OK    Template default            fonts present (4 files)
  OK    Template editorial          fonts present (4 files)
  OK    Template motion             fonts present (4 files)
  OK    Project northfield-fixture  /home/user/Video/projects/northfield-fixture
  OK    Session home                ~/.retake · outside any git work tree
  WARN  Persona signed-in·supplier  never signed in
                                    → sign in once: retake login northfield-fixture --env signed-in --persona supplier
  WARN  Persona signed-in·buyer     never signed in
                                    → sign in once: retake login northfield-fixture --env signed-in --persona buyer
  WARN  Sandbox sandbox             process · not running
                                    → retake sandbox up northfield-fixture (retake run … --sandbox starts it too)
  WARN  Sandbox sandbox-docker      docker-compose · sandbox sandbox-docker: docker-compose sandboxes need Docker with Compose v2.17 or later: `docker` was not found (install Docker Desktop or OrbStack, or set RETAKE_DOCKER)
  OK    Host local·console          http://localhost:4401 → HTTP 200 (56 ms)
  OK    Host local·shop             http://localhost:4402 → HTTP 200 (7 ms)
  OK    Host signed-in·console      http://localhost:4403 → HTTP 302 (2 ms)
  OK    Host signed-in·shop         http://localhost:4404 → HTTP 302 (1 ms)
  OK    Host production·console     http://localhost:4401 → HTTP 200 (2 ms)
  OK    Host production·shop        http://localhost:4402 → HTTP 200 (1 ms)
✓ 0 failures, 8 warnings
```
