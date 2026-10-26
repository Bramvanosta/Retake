# Demo Studio

Demo Studio turns a precise, written scenario into a professional product video. It drives a real web app in a
headless browser at any virtual resolution, draws the cursor **inside the page** (so clicks and screen reactions are
in sync by construction), records the screen through the Chrome DevTools screencast, and writes a timeline of every
step. Later phases edit that capture automatically into a finished video (themes, components, captions,
intro/outro), produce review artefacts, and expose everything to an AI agent through an MCP server.

The tool is generic: it is not tied to any product or brand. Your projects, themes, logos, scripts and hooks live in
**your own workspace folder**, never in this repository; signed-in sessions stay on your computer, outside any project
(`~/.demo-studio`).

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start (bundled fixture product)](#quick-start-bundled-fixture-product)
- [Your own workspace](#your-own-workspace)
- [Command line](#command-line)
- [Project layout](#project-layout)
- [Scenario language](#scenario-language)
- [Recording a scenario](#recording-a-scenario)
- [Your own media and motion](#your-own-media-and-motion)
- [Editing: the edit plan](#editing-the-edit-plan)
- [Rendering](#rendering)
- [Signing in: personas and sessions](#signing-in-personas-and-sessions)
- [Sandbox mode](#sandbox-mode)
- [Security](#security)
- [Outputs of a run](#outputs-of-a-run)
- [Repository layout](#repository-layout)
- [Phase status](#phase-status)

## How it works

1. You describe a video in YAML: scenes, steps (`click`, `type`, `select`, `scroll`, `drop_file`…), captions and
   edit hints. `studio validate` checks it with line/column messages before anything runs.
2. `studio run` launches Chromium headless (new headless mode) with the project's viewport, injects a small in-page
   kit (cursor overlay + element resolver) into every document, and executes the whole scenario in one process with
   deterministic pacing: eased cursor moves at ~60 Hz with the real mouse, hover before click, popup-aware click
   strategies, typing at a natural speed, animated scrolls.
3. Setup hooks prepare the data first (HTTP, SQL, shell, in-page JS) and are journaled with their rollback;
   teardown hooks always run, then pending rollbacks are replayed.
4. The run produces `capture.mp4` (constant frame rate, H.264) and `timeline.json` (every scene and step with its
   start/end/click times in capture time, target boxes, markers, page/URL segments, the cursor track, idle intervals
   and the page loads the capture held) — the inputs of the editor. The capture never shows a page that has not
   painted yet: during a full page load it keeps the previous picture until the new page has painted content of its
   own.

Because the browser is headless and offscreen, a capture does not take over your screen: keep working while it runs.

## Requirements

- macOS or Linux, Node.js 22+ (an older Node.js gets a message saying so; `.nvmrc` pins 22 for nvm, and for mise when `idiomatic_version_file_enable_tools` includes `node`), pnpm 10
- ffmpeg and ffprobe 5.1+ on `PATH` (or `ffmpeg:` in `studio.yaml`); used with 6.1 (Linux) and 9.0 (macOS, Homebrew)
- Chromium for Playwright: `pnpm --filter @demo-studio/runner-web exec playwright-core install chromium`
  (or point `$DEMO_STUDIO_CHROMIUM` / `browser.executable` at a Chromium or Chrome binary)
- Optional: PostgreSQL client access for `sql` hooks
- Optional: Docker with Compose v2.17+ (Docker Desktop or OrbStack) for docker-compose sandboxes (Sandbox mode)

`studio doctor` checks all of this in one go (see [Command line](#command-line)).

Smooth 30 fps captures need GPU-accelerated rendering, which desktop machines provide (an Apple M4 captures ≈ 60
frames/s while the cursor moves, blurred dialogs included); `studio doctor` checks it (Chromium's own GPU report: the
capture browser's new headless mode uses the GPU, `browser.channel: headless-shell` does not). Without a GPU the
browser renders in software: pages with heavy effects (for example `backdrop-filter` blur behind dialogs) are then
captured at a lower frame rate, and the run warns with the measured cause (no GPU, a busy machine, a page whose
renderer stayed busy…). The run also warns when the capture froze 150 ms or more while the cursor moved or a click
ripple played. A known one: closing a dialog whose overlay has a `backdrop-filter` (a blur) can freeze the picture
≈ 0.26 s during the click ripple — the recorder asks for fresh frames while a ripple plays and the edit cuts what is
left of a freeze, so Chromium's frame-rate limiter stays on. `browser: {frame_rate_limit: false}` still turns it off,
at a measured cost (fixture `quote`: ×2.8 Chromium's CPU, its GPU and renderer processes ×7; `requestAnimationFrame`
runs at thousands of Hz while anything animates, so an animation that steps once per frame plays too fast): a run
with it warns. After a scroll the cursor waits, still, until the new content is painted before it moves on. A capture
is smoothest on a quiet machine: heavy background work (indexing, updates, another project's tests) shows up as
slower, choppier motion — every take reports what it cost (`perf` in run.json, see [Outputs of a run](#outputs-of-a-run)).

## Quick start (bundled fixture product)

The repository ships a fictional product to film: **Northfield**, a B2B specialty-coffee wholesale platform with a
supplier console and a buyer shop, built with real Radix UI and Base UI components (`fixtures/wholesale`), and a
project that films it (`projects/northfield-fixture`).

```sh
pnpm install
pnpm build
pnpm studio doctor                                               # is this machine ready?

# terminal 1 — the fixture product (supplier console on :4401, buyer shop on :4402)
pnpm fixture

# terminal 2
pnpm studio list
pnpm studio validate northfield-fixture catalogue
pnpm studio run northfield-fixture catalogue --dry --hooks run   # screenshots of every step, no recording
pnpm studio run northfield-fixture catalogue                     # capture.mp4 + timeline.json
pnpm studio run northfield-fixture quote
pnpm studio run northfield-fixture signup                        # sign-up email, phone cards, tap-open
```

`pnpm studio …` runs `node packages/cli/dist/bin.js …` from the repository root, whose `studio.yaml` makes the
repository a workspace holding the fixture project and the starter templates. To call `studio` from anywhere, alias
it: `alias studio="node /path/to/demo-studio/packages/cli/dist/bin.js"`.

## Your own workspace

Keep your material in a folder of your own, for example:

```
~/demo-workspace/
  studio.yaml          # marks the workspace (all keys optional)
  projects/<slug>/     # one folder per product
  templates/<name>/    # your themes (copy a starter from this repository's templates/ to begin)
  components/<ns>/<name>/  # your own components (studio components create)
```

```yaml
# studio.yaml
version: 1                 # format version: optional (see File formats and versions)
projects_dir: projects     # default "projects"
templates_dir: templates   # default "templates"
components_dir: components # default "components": your own components (see Components)
ffmpeg: /opt/homebrew/bin/ffmpeg
browser: {locale: en-GB, timezone: Europe/Stockholm}   # defaults for every project (project.yaml wins)
```

The CLI finds the workspace in this order: `--root <dir>` (`-C`), then `$DEMO_STUDIO_ROOT`, then the nearest folder
above the current directory that contains `studio.yaml`, then the nearest one containing `projects/` or
`templates/`. So either run `studio` from inside your folder, or `export DEMO_STUDIO_ROOT=~/demo-workspace`.

```sh
studio new acme-demo --name "Acme demo" --env "staging=app:https://app.staging.example.com,admin:https://admin.staging.example.com"
studio validate acme-demo
```

`studio new` writes `README.md` (a skeleton to describe the product, audience, goals, tone and accounts — by
reference, never passwords), `project.yaml`, `scenarios/`, `hooks/`, `assets/` and a `.gitignore` for generated
folders. On a terminal, `studio new <slug>` without `--env` asks instead: the environments, then whether each one
needs a sign-in and the accounts the videos are filmed as, and offers to sign each one in (see
[Signing in](#signing-in-personas-and-sessions)).

## Command line

```
studio new <slug> [--name N] [--template T] [--env name=key:url,...]   # on a terminal without --env: asks (personas too)
studio list [--json]                                  # projects (with scenarios) and templates
studio validate <project> [scenario|file] [--env E] [--until REF] [--json]
studio run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--allow-writes] [--json]
           [--sandbox]                       # reset the sandbox to its seed first (Sandbox mode)
           [--raw [--cursor baked|none|layer] [--format mp4|prores] [--fps 30|60] [--layer prores|webm] [--selects]
           [--no-cuts] [--out DIR]]          # capture, then the raw package for editors
studio inspect <project> <page|url|scenario> [--path P] [--until REF] [--persona P] [--env E] [--within T] [--target T]…
               [--limit N] [--images marked|none] [--json] [--out DIR]   # a page's elements with verified targets
studio hooks run <project> <scenario>:setup|<scenario>:teardown|reset|<file.yaml> [--env E] [--yes] [--allow-writes] [--dry]
studio hooks rollback <project> [run-id] [--env E] [--allow-writes] [--dry]
studio env reset <project> [--env E] [--yes] [--allow-writes] [--dry]
studio sandbox init <project> [--env E] [--force] [--json]   # a docker-compose sandbox: app placeholder, Postgres, Mailpit
studio sandbox up|down|reset <project> [--env E]     # start + seed (up: --no-seed, --build) / stop (--volumes) / back to the seed (--reseed)
studio sandbox status <project> [--env E] [--json]   # exit 0 when up and healthy
studio sandbox logs <project> [service] [--env E] [--lines N] [--follow]
studio components list [--kind K] [--json]            # workspace components, then the built-in library
studio components validate [id|dir] [--json]         # manifest, params, previews, entry compile (all when omitted)
studio components create <namespace/name> --kind K [--description D] [--name N] [--theme T] [--no-preview] [--json]
studio components preview [id|dir] [--all] [--stale] [--workspace] [--theme T] [--out DIR] [--json]   # preview.png + README
studio theme create <name> --accent HEX --logo FILE [--text|--paper|--muted|--dark HEX] [--background SPEC] [--base T]
              [--wordmark FILE] [--display-font FILE] [--body-font FILE]… [--brand-name N] [--brand-url U]
              [--no-adjust] [--replace] [--json]   # a new workspace theme from brand files (Themes from your brand)
studio theme from-site <url> [--json]              # colours, font names, logo PNGs and a screenshot of a public page (Themes from a site)
studio plan <project> <run-id|latest> [--scenario S] [--theme T] [--frame F] [--vertical|--square] [--json] [--out FILE]
studio render <project> <scenario> [--run ID|latest] [--theme T] [--frame F] [--vertical|--square] [--scale N]
              [--music FILE|--no-music] [--tutorial|--no-tutorial] [--no-intro] [--no-outro] [--out FILE] [--concurrency N]
              [--review] [--json]
studio still <project> <scenario> --frame N [--run ID|latest] [--layout F] [--theme T] [--vertical|--square] [--out FILE] [--json]
studio export <project> <render-id|file|latest> [--formats LIST|all] [--scenario S] [--out DIR] [--gif-start S]
              [--concurrency N] [--json]   # mp4_1080p, mp4_4k, webm, vertical_9x16, square_1x1, gif_preview
studio review <project> <render-id|file|latest> [--scenario S] [--fps 1|2] [--previous ID | --no-previous] [--strict]
              [--json]
studio comment add <project> <render-id|latest> (--at S | --frame N | --marker M) [--region x,y,w,h] [--scenario S]
              [--author A] [--json] "text"          # a comment on one frame of a render (Frame comments)
studio comment list <project> [--scenario S] [--render ID|latest] [--status open|resolved|all] [--limit N] [--json]
studio comment reply|resolve|reopen <project> <id> ["text" | --note T [--render ID]] [--author A] [--json]
studio export-capture <project> <run-id|dir|latest> [--scenario S] [--format mp4|prores] [--fps 30|60]
              [--cursor baked|none|layer] [--layer prores|webm] [--selects] [--no-cuts] [--out DIR] [--json]
studio schema [scenario|project|template|timeline|sandbox]    # JSON Schema on stdout
studio login <project> [--env E] [--persona P] [--auto] [--page KEY] [--url URL]   # sign a persona in, save its session
studio auth status [--project P [--env E]] [--check] [--json]   # every persona: valid / expired / never, last check
studio doctor [--project P] [--json]                  # check this machine, the workspace and a project
studio prune <project> [--keep-renders N] [--yes] [--json]   # what runs/, renders/, review/ hold that nothing needs (--yes deletes it)
studio mcp [--print-config]                           # MCP server over stdio for Claude (or print its registration)
studio mcp --http [--port N] [--rotate-token] [--json] # the same MCP server over HTTP on 127.0.0.1 (--print-config --http: its registration)
studio ui [--port N] [--no-open] [--json]             # the Studio web app on 127.0.0.1 until Ctrl-C (Studio app)
studio jobs [--project P] [--state S] [--limit N] [--json]   # jobs Claude started (dry runs, captures, hooks…)
studio jobs status <id> [--json] · studio jobs cancel <id>   # one job; cancel it (teardown and rollbacks still run)
```

Global options: `-C, --root <dir>` (workspace), `-v, --verbose` (info/debug messages), `--no-color`.

- **validate** checks `project.yaml`, the project template (all assets present) and one scenario — or every scenario
  when none is given. Messages read `file:line:col severity path: message`, with "did you mean" suggestions.
- **run** prints one line per step with its duration and a summary with the output paths. `--dry` records nothing,
  saves a screenshot per step and never executes `irreversible` steps (it hovers their target and stops that scene).
  Hooks run by default for captures and are skipped for dry runs (`--hooks run` executes them, so a dry run sees the
  same prepared data). `--until scene.step` stops after that step. `--json` streams progress events (one JSON object
  per line) on stdout for tools and agents. Ctrl-C (or SIGTERM) cancels cleanly: teardown still runs, the browser
  closes, the run ends `cancelled` with exit code 1; a second Ctrl-C quits at once. On a read-only environment
  a run with hooks that write is refused before anything runs; `--allow-writes` lets a production environment whose
  project.yaml allows writes be written to — see [Environments](#environments-display-urls-production-read-only-clock).
  `--sandbox` starts the sandbox environment if needed and resets it to its seed before the take — see
  [Sandbox mode](#sandbox-mode).
- **inspect** replays a page (an environment page key with `--path`, or a URL of one of its pages) or a scenario up to
  `--until` as a dry run (hooks skipped), then lists the page's visible interactive elements — dialogs and menus first
  — with a target the runner resolves to each, its action, and why it may be fragile; `--target` checks your own
  targets, `--within` lists inside one. Files in `<project>/.demo-studio/inspect/<id>/` (or `--out`), with a marked
  screenshot; `--json` prints the report. What `page_inspect` gives Claude — see
  [Authoring](#mcp-claude-drives-demo-studio).
- **sandbox** starts, seeds, resets and stops the sandboxes of a project, shows their state and their services' logs —
  see [Sandbox mode](#sandbox-mode).
- **hooks run** runs a scenario's setup or teardown, the project's `reset` hooks, or a YAML file listing hooks (same
  entries as `setup:`). Its journal (executed hooks and their rollbacks) is kept in
  `<project>/.demo-studio/journals/<id>.json` — never in `runs/`, which only holds captures; **hooks rollback**
  replays the pending rollbacks of one journal (a run id or a journal id) or of every journal; **env reset** replays
  every pending journal (captures' and standalone ones), then runs the `reset` hooks (journaled in
  `.demo-studio/journals/` too). `--yes` approves destructive hooks that lack `confirm: true` (otherwise you are
  asked on a terminal, or they are refused). On a read-only environment, hooks that write are refused; a replayed
  rollback is judged by the environment its hook ran in (`--allow-writes` where that is a production environment
  that allows writes).
- **login** signs a persona in and saves its session: a visible browser window (sign in, then close it) or, with
  `--auto`, the persona's `login:` steps, headless; **auth status** lists every persona's session (from the last check,
  or checked now with `--check`) — see [Signing in](#signing-in-personas-and-sessions).
- **doctor** checks, one line each with `OK`, `WARN` or `FAIL` and a hint: the Node.js version, Chromium (path,
  version and a real new-headless launch), ffmpeg and ffprobe (5.1 or later), a display (only needed by `--headed` and `login`),
  the secrets store for `{{keychain:…}}` refs (macOS `security`, Linux `secret-tool`), desktop notifications
  (`osascript`, `notify-send`), Docker (its version, Compose v2.17 or later, a running daemon, the context — found on
  PATH, else where Docker Desktop, OrbStack or Homebrew put it, as the sandboxes look for it: a warning when missing,
  since only docker-compose sandboxes need it, and a failure only when the `--project`'s default sandbox — its
  `default_env` when that is a sandbox, else the first one declared — is a docker-compose one), the workspace root
  and its projects, and the fonts of every template (the starter templates included). With
  `--project <slug>` it also checks that project's sessions — one line per persona (never signed in, expired, in use
  by a browser, its last check), the studio home (a warning when it, or a session, sits inside a git work tree that
  does not ignore it), the profile of the single-account form — and sends a `HEAD`
  request (5 s timeout) to every page of every environment: an unreachable page of the default environment is a
  failure, of another environment a warning. A sandbox gets one line instead (up and healthy, or how to start it):
  its accounts sign in at every take and its pages answer only while it runs. It exits with `1` when any check fails; `--json` prints the checks.
- **components** lists, validates and scaffolds components — see [Components](#components).
- **plan** shows how a capture will be edited (segments, components, speeds, trims, zooms, captions, warnings)
  without rendering — see [Editing](#editing-the-edit-plan).
- **render** plans and renders the latest capture of a scenario (or `--run`) into `renders/<scenario>-v<N>.mp4` with a
  progress bar and a summary; **still** renders one frame of the planned video as a PNG — see
  [Rendering](#rendering).
- **review** writes contact sheets, per-scene sheets, key frames, an output-time timeline and a report of a render,
  and prints the findings of its checks — see [Reviewing a render](#reviewing-a-render).
- **comment** leaves a comment on one frame of a render (optionally a region), lists threads, replies, resolves and
  reopens them — see [Frame comments](#frame-comments).
- **export** writes delivery files of a render to `exports/<render-id>/` with a `manifest.json` — see
  [Variants, 4K, music and export](#variants-4k-music-and-export).
- **export-capture** (and **run --raw**) writes the raw package of a run for another editing tool — clips per scene,
  cursor data or layer, FCPXML / EDL / OTIO / CSV markers, `manifest.json` — see
  [Raw export for editors](#raw-export-for-editors).
- **mcp** serves Demo Studio's tools to an MCP client over stdio (Claude Code, Claude desktop); `--print-config`
  prints how to register it; `--http` serves them over HTTP on `127.0.0.1` instead (`--port`, default 47820;
  `--rotate-token`; `--json`: one line `{type, url, port, pid}`), `--print-config --http` prints that registration
  (the token by reference only, never the token itself) — see [MCP: Claude drives Demo Studio](#mcp-claude-drives-demo-studio).
- **record** `<project> [name] [--env] [--persona] [--page] [--path | --url] [--allow-writes] [--no-check] [--json]`
  opens a browser window on the environment's page: perform the flow by hand, then close the window (or press Ctrl-C:
  stop and keep). Nothing is filmed. A draft scenario is made from what you did — verified targets, `select` / `pick` /
  `menu` / `drop_file` steps, scenes split where the page changed, empty captions, secret fields as
  `{{vars.password_1}}` placeholders (set a showable demo value) — saved as `scenarios/<name>.yaml` when the name is
  free (default `recorded-YYYYMMDD-HHMM`; an existing scenario is never overwritten), then checked by a headless dry
  replay (up to the step before the first write that reached a server, whatever its host). The recording's
  files stay in `<project>/.demo-studio/records/` (the newest 20). The access is the environment's own, as a run.
  See [Recording a scenario](#recording-a-scenario).
- **ui** serves the Studio web app of the workspace on `127.0.0.1` until Ctrl-C and opens it in the browser
  (`--no-open`: print the link only; `--port`: a fixed port; `--json`: one line `{type, url, port, pid, reused}`); one
  server per workspace — run it again to reopen the running one with a new link — see [Studio app](#studio-app).

Exit codes: `0` success, `1` validation errors or a failed/cancelled run or hook (or a failed doctor check), `2`
invalid command line, `130` interrupted (Ctrl-C) while signing in, checking a session, running js hooks or starting,
resetting or stopping a sandbox.

```
$ studio doctor --project northfield-fixture        # Linux container without a desktop, fixture running
studio doctor
  OK    Node.js                     22.22.0
  OK    Chromium                    141.0.7390.37 · /opt/pw-browsers/chromium-1194/chrome-linux/chrome · new headless launch 293 ms
  WARN  GPU                         the capture browser renders in software · ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …)) · in software: gpu_compositing, rasterization, …
                                    → captures will look choppy and cost more CPU: check the machine has a GPU Chromium can use (a VM or a remote session often has none)
  OK    ffmpeg                      6.1.1-3ubuntu5 · /usr/bin/ffmpeg
  OK    ffprobe                     6.1.1-3ubuntu5 · /usr/bin/ffprobe
  OK    Capture encoder             libx264 (preset veryfast) during the take
  WARN  Display                     none: DISPLAY / WAYLAND_DISPLAY are not set
                                    → headless captures work; --headed and studio login need a desktop session (or xvfb-run)
  WARN  Secrets                     secret-tool not found: {{keychain:service/account}} refs cannot be resolved
                                    → install libsecret-tools (secret-tool), or use {{env:VAR}} refs
  WARN  Notifications               notify-send not found: notify steps are only logged
                                    → install libnotify-bin (notify-send) for desktop notifications
  WARN  Docker                      not found — needed by the docker-compose sandbox sandbox-docker of project northfield-fixture
                                    → install Docker Desktop or OrbStack (or set DEMO_STUDIO_DOCKER to the docker binary)
  OK    Workspace                   /home/user/Video (studio.yaml) · 1 project: northfield-fixture
  OK    Template default            fonts present (4 files)
  OK    Template editorial          fonts present (4 files)
  OK    Template motion             fonts present (4 files)
  OK    Project northfield-fixture  /home/user/Video/projects/northfield-fixture
  OK    Session home                ~/.demo-studio · outside any git work tree
  WARN  Persona signed-in·supplier  never signed in
                                    → sign in once: studio login northfield-fixture --env signed-in --persona supplier
  WARN  Persona signed-in·buyer     never signed in
                                    → sign in once: studio login northfield-fixture --env signed-in --persona buyer
  WARN  Sandbox sandbox             process · not running
                                    → studio sandbox up northfield-fixture (studio run … --sandbox starts it too)
  WARN  Sandbox sandbox-docker      docker-compose · sandbox sandbox-docker: docker-compose sandboxes need Docker with Compose v2.17 or later: `docker` was not found (install Docker Desktop or OrbStack, or set DEMO_STUDIO_DOCKER)
  OK    Host local·console          http://localhost:4401 → HTTP 200 (56 ms)
  OK    Host local·shop             http://localhost:4402 → HTTP 200 (7 ms)
  OK    Host signed-in·console      http://localhost:4403 → HTTP 302 (2 ms)
  OK    Host signed-in·shop         http://localhost:4404 → HTTP 302 (1 ms)
  OK    Host production·console     http://localhost:4401 → HTTP 200 (2 ms)
  OK    Host production·shop        http://localhost:4402 → HTTP 200 (1 ms)
✓ 0 failures, 8 warnings
```

## Project layout

```
projects/<slug>/
  README.md            # the product, audience, goals, tone, links, accounts by reference, do/don't
  project.yaml         # environments, capture size, template, personas, hooks allow-list, reset hooks
  scenarios/<name>.yaml
  hooks/               # sql / http / js / sh files used by hooks
  assets/              # files used by scenarios (drop_file, eval, music…)
  runs/<run-id>/       # generated: capture.mp4, timeline.json, run.json, frames/, screenshots/, journal
  renders/             # generated: <scenario>-v<N>.mp4 + .json (render records), stills/
  review/<render-id>/  # generated by `studio review`: contact sheets, key frames, timeline.json, report.json/.md
  comments/<scenario>/ # frame comments, one c_<id>.json per thread (committed: your review; `studio comment`)
  sandbox/             # optional: sandbox.yaml of a sandbox environment, its seed/ and compose files (Sandbox mode)
  .demo-studio/        # generated tool state: journals/<id>.json of `studio hooks run` / `studio env reset`, sandbox state,
                       # comments/<id>.jpg (the frame still of each comment thread: machine-local, never committed)
```

```yaml
# project.yaml
version: 1                     # format version: optional, absent = 1 (see File formats and versions)
name: Acme demo
environments:                  # environment → page key → base URL ({{app}} in templates)
  staging:
    app: https://app.staging.example.com
    admin: {url: https://admin.staging.example.com, display: admin.example.com}   # the URL the video shows
  production:                  # the long form: settings next to `pages` (see Environments below)
    production: true           # read-only: hooks that write are refused, the browser's writes are stopped
    pages: {app: https://app.example.com}
default_env: staging
auth:                          # the accounts videos are filmed as: never a password, never a path (see Signing in)
  staging:                     # global, or keyed by environment name
    login_url: /login
    personas:
      admin: {pages: [admin, app], check: {url: "app:/", expect_text: Jane Example}}
capture: {width: 1920, height: 1080, scale: 1, fps: 30}   # scale 2 → real 3840×2160 frames from a 1080p viewport (4K)
frame: card                    # raw | card | browser | laptop | phone | tablet (| split | pip: multi-page scenes), or a layout component id
template: default              # a workspace template, a starter (default, editorial, motion), or a path like ./theme
locale: en-GB                  # browser locale (navigator.language, Accept-Language) unless browser.locale is set
allow_hosts: [api.staging.example.com]                    # extra hosts hooks (every kind) may reach
databases:
  main: {url: "postgres://demo@db.staging.example.com/app?password={{keychain:acme/db}}"}
vars: {customer: Northfield Roasters}
pacing: {type_cps: 12}                                    # override field-tested pacing defaults
defaults: {timeout_s: 30}                                 # every step's timeout when it sets none (a scenario's `defaults` win)
browser: {timezone: Europe/London, color_scheme: light}  # browser.locale would override `locale`; frame_rate_limit: false, see Requirements
reset:                         # run by `studio env reset`
  - http: {method: POST, url: "{{admin}}/api/demo/reset"}
hooks:                         # named hooks a scenario's `hook: <name>` steps run during the take (see below)
  mark-paid: {http: {method: POST, url: "{{admin}}/api/invoices/latest/paid"}}
clock: 2026-11-02T10:24:00     # the product's browser clock when the capture starts (a scenario's `clock` wins)
mailbox: {provider: mailpit, url: "http://localhost:8025"}   # test mailbox read by wait_for_email (see below)
sandboxes: {sandbox: sandbox/sandbox.yaml}                  # sandbox environments (see Sandbox mode)
```

`capture` also accepts `format` (`jpeg`/`png`), `quality` (the screencast's JPEG quality, default 90: small text
measured indistinguishable from 100 at 0.4× the bytes), `encoder` (`auto`, the default: capture.mp4 is encoded
**during the take** with the Mac's hardware H.264 encoder through ffmpeg — VideoToolbox, `-q:v 85` — else
`libx264` preset veryfast at `crf`), `crf`, `keep_frames` (default `false`: no screencast frame is written; `true`
keeps them in `runs/<id>/frames/` with their real timing, which the raw export uses for 60 fps), `prewarm` (`true`:
every page the scenario opens is visited once off camera before the take, in the browser that films it, so its first
visit is not filmed cold — a page that changes data when it loads does it then too) and `step_shots` (`true`: a
capture keeps one picture per step in `runs/<id>/screenshots/`, as a dry run does — the frame of the video at the end
of each step (of the kept frames with `keep_frames`), named `<scene>-<nn>-<action>.jpg`; nothing is taken during the
take). The browser locale is
`browser.locale` when set, else the project `locale`, else the `studio.yaml` `browser.locale` default.
Run `studio schema project` for the full schema (also in `packages/core/schema/` for editor autocompletion).

**Pacing** (`pacing:` in project.yaml or a scenario; every key optional, the defaults follow the field notes of
`docs/reference/choreography.md`):

| Key | Default | Meaning |
|---|---|---|
| `scene_start_still` | 1.6 | Seconds still at a scene start |
| `move_base_ms`, `move_ms_per_px`, `move_min_ms`, `move_max_ms` | 0, 0.9, 450, 1100 | Cursor travel: clamp(base + d·per_px, min, max) ms — clamp(0.9·d, 450, 1100) |
| `nudge_px`, `nudge_ms`, `nudge_hover_ms` | 60, 250, 120 | Moves shorter than `nudge_px` (repeated clicks on almost the same spot) take 60–100 % of `nudge_ms` (150–250 ms) and hover `nudge_hover_ms`; a zero-length move takes 0 ms |
| `hover_ms`, `press_ms` | 200, 90 | Hover before pressing; mousedown → mouseup |
| `after_click_ms`, `after_popup_ms` | 350, 800 | Pause after a click; after a click that opened a menu/popover/dialog |
| `after_navigation_ms` | 1500 | Minimum time between a click that changed the page (document navigation or new URL) and the next step; a page load the capture held (cut by the edit) does not count, the request before it does |
| `page_switch_ms` | 500 | Multi-page scenes: the pause when the next step acts on another page than the previous one (the eye moves), before that page's cursor glides |
| `popup_fallback_ms` | 300 | How long a click gets to show that an expected popup opened (`aria-expanded="true"` or a new popup, polled every 40 ms) before the next strategy (DOM click, then pointer sequence) is tried |
| `popup_timeout_ms` | 700 | How long the last strategy waits for the popup before the step reports it missing; also how long after the press of a plain click the next step waits for a popup that opens late, while that step's target is not on screen yet |
| `type_cps` | 14 | Typing speed. A `type` step without `cps` adapts it to the field: a search field (type=search, searchbox, combobox, autocomplete, inside a search form or an open popover, or named like one) at most 10, long free text (over 40 characters) up to 24 at 120 characters; ±30 % per character |
| `park_hold`, `park_scroll_hold` | 2, 3.2 | Seconds a step's `park: true` holds the cursor still on the result; after a scroll to a target |
| `scroll_duration`, `scroll_offset` | 1.6, −140 | Scroll animation seconds; default `scroll.offset` with a target (it ends 140 px below the top) |
| `jitter`, `settle_ms` | 0.08, 3000 | Deterministic ±jitter on durations; network-idle wait after a navigation |

`popup_fallback_ms` is 300 ms because the Radix and Base UI widgets of the bundled fixture show their popup (or
`aria-expanded="true"`) 110–135 ms after the press of a real click, press time included, even under software
rendering: 300 ms never misfires on them, while a trigger that ignores real input is retried after a short stall
instead of 700 ms.

## Scenario language

```yaml
# yaml-language-server: $schema=../../../packages/core/schema/scenario.schema.json
version: 1                     # format version: optional, absent = 1 (see File formats and versions)
video: catalogue
title: {kicker: For suppliers, text: Manage your catalogue}
outro: {tagline: "Your catalogue, under control."}
setup:
  - http: {method: POST, url: "{{console}}/api/reset"}
teardown:
  - http: {method: POST, url: "{{console}}/api/reset"}
scenes:
  - id: import
    caption: {kicker: Catalogue import, text: "Import your entire price list in seconds."}
    page: console              # environment page key
    open: /imports             # path on that page, or a full URL
    steps:
      - click: {text: New import}
      - select: {combobox: "#import-organization", option: Northfield Roasters}
      - drop_file: {zone: {text: Click to choose a file}, name: Price list 2027.xlsx, fake: true}
      - click: {text: Start import, in: dialog}
      - wait_for: {text: 921 offers created, timeout: 10}
        mark: import-done
      - hold: 2
  - interstitial: {text: A few hours later, duration: 2.6}
```

**Scenario keys:** `video`, `title`, `intro` (`false` or `{component, params, duration}`), `outro` (`false` or
`{component, params, tagline, url, duration}`), `env`, `vars`, `setup`, `teardown`, `hooks` (named hooks `hook:` steps run
during the take, see [Hooks during the take](#hooks-during-the-take)), `capture`, `frame` (default for
every scene, see [frames](#components-in-scenarios)), `template`, `pacing`, `music` (`{file, volume, duck, loop}`, see
[the music bed](#music-bed)), `target_length` (`{min_s, max_s}`: the length this video aims at — the review's
`video-length` rule uses it instead of the reference 60–120 s), `scenes`.

**Scene keys:** `id`, `caption` (string or `{kicker, text}`), `page`, `open`, `persona` (the account the page is
signed in as, `none` for none: see [Signing in](#signing-in-personas-and-sessions)), `steps`, `speed` (edit-time),
`still` (seconds still at the start, default 1.6), `cursor` (where the cursor rests at the start, see below),
`transition` (`crossfade`, `cut`, `fade-black`), `frame` (a frame style or a layout component id), `irreversible`,
`skip`, `offscreen` (played during the take but left out of the video: a scene that only brings the product to the
state the next one films — an edit value, a render on the same take can toggle it), `note`. A scene without `page` continues on the previous scene's page; a scene without `open` continues from
the current state. Two other entries take no capture time (the editor shows them between the clips around them):
`interstitial: {text, kicker, duration, component, params}` (a "time passes" card; `style` is the legacy template
style override) and `card: {component, params, slots, duration}` (a full-screen title / chapter / quote card), each
with an optional `id` (default `interstitial-<n>` / `card-<n>`, `n` = position in `scenes`). Ids are unique across
scenes, cards and interstitials. A card or an interstitial without a `duration` stays long enough to read its text
(L5.5): about 250 words a minute plus 1.5 s for its entry and exit, never less than its component's default and
within its min / max (`studio/card-title` 2.5 s, 1–10 s); the review warns (`card-too-short`) when a card is shorter
than its text needs.

**Scene-start cursor** (`cursor:` on a scene):

| Value | Where the cursor rests during the still |
|---|---|
| `auto` (default) | A neutral spot next to the scene's first pointer target (the element the first click, hover, select… travels to; its position after leading `scroll` steps is predicted), next to where it will be clicked, never covering it, inside the viewport and inside the dialog that holds it, preferably over a non-interactive area. Without such a target: the right-centre of the screen. A scene that continues from the current state keeps the cursor where it is when it is already clear of that target and within 240 px of where it will be clicked; otherwise it glides next to it |
| `keep` | Where the previous scene left it |
| `{x: 1500, y: 540}` | That viewport point (CSS px) |
| a target, e.g. `{text: New import}` | On that element, as a hover would (`{text: auto}` for an element whose text is "auto") |

The capture never shows the cursor jump: a scene that opens a page places it while the page loads (the editor cuts
that part); a scene that continues from the current state glides there, eased, during its still. The choice is
recorded as `data.cursor` of the scene's `scene_still` event.

**Full page loads.** A navigation to another document — a link, a form, `open`, a new tab, a redirect — shows nothing
of the new page until it has painted content of its own (text, an image or an SVG: its first contentful paint). The
capture keeps the previous picture meanwhile, so a blank page, an app's empty shell or a skeleton without text is
never filmed; a drawn cursor appears with the first painted picture. The runner waits for that paint before the next
step and before a scene's still (in a multi-page scene, for every page it films): a step that navigated — a click,
an Enter, `open` (also with `wait_until: commit`), a new tab — ends with the new page painted, so its `hold`, its
`park` and a `wait_for` right after it start on the painted page. A page that never paints content (only solid
colours) is shown 3 s after its network went idle (a PDF: 0.5 s); one that paints nothing within 10 s is shown as it
is from then on, with a run warning. A new tab or page still blank (nothing opened in it yet) is not waited for — the
step that opens a page there is what fills it —; it is not shown until that page paints (a run warning after 10 s).
Ctrl-C does not wait for a held load. Each held load is in `timeline.loading`; the edit and the raw export cut it
(a multi-page scene's pages share their timing: a load held on one page is not cut while another page acts — that
page keeps its previous picture meanwhile). What the app shows once it has painted — a spinner with a label, a table
filling in — is the product: wait for its result with `wait_for`.

### Actions

Every step has exactly one action; shorthand forms are shown first.

| Action | Example | What it does |
|---|---|---|
| `open` | `open: /settings` · `{url, page, wait_until}` | Navigate the current (or given) page |
| `click` | `click: Save` · `{text: Save, in: dialog}` | Cursor travels, hovers, presses; popup-aware fallbacks. A click that changes nothing within about a second — no request, DOM change, navigation, dialog, new tab, download, nor a field taking the focus — is reported at once with a screenshot (see [When a take goes wrong](#when-a-take-goes-wrong)); `retry_click: true` clicks once more |
| `click` (outside) | `click: {outside: true}` | Close the open popover by clicking the dialog title or a blank area; with a listbox open over a floating popover, the listbox closes first (a click on the popover's title), the popover on the next one |
| `double_click` | `double_click: {text: Report.pdf}` | Double click |
| `hover` | `hover: {text: Pricing, ms: 900}` | Move onto an element and rest |
| `type` | `type: {into: {label: Email}, text: hi@example.com, cps: 12, clear: true, enter: true}` | Type character by character; without `cps` the rate adapts to the field (search ≤ 10, long text up to 24; `data.rate`); `clear` selects all + deletes, and when the field still holds text (select-all blocked, a React input that restored its value) uses the native value setter + an `input` event (`data.clear`); an editor the runner cannot read (in a frame from another origin, or typing into a hidden input: CodeMirror 5, Monaco) gets the keys only, unchecked. With `into`, the field is brought into view inside its own scrolling containers (a scrolling dialog included) and clicked once its box stopped moving; the step fails before typing anything when the focus did not land in the field (the error names what got it), and warns when the field's value does not hold the text typed afterwards |
| `press` | `press: Enter` · `{key: ArrowDown, times: 3}` | Press a key (Playwright key names) |
| `select` | `select: {field: Country, option: Sweden, search: Swe}` · `{combobox: "#country", option: …}` | Native select or combobox listbox |
| `pick` | `pick: {field: Bag sizes, option: [1 kg, 5 kg], search: kg, close: outside}` | Multi-select popover, closed without Escape; only what the step opened is closed (a popover holding the field stays open) |
| `menu` | `menu: {row: Iceland, item: Pause, confirm: Pause}` · `{trigger: …, item: …}` | Row action menu, optional confirmation. The trigger: an `aria-haspopup` element, a button named like a menu, else the row's last button; actions shown on hover are revealed by hovering the row's right end; a row without any button: the clickable element at its right end, else its top-right corner (warned: give `trigger:`) |
| `date` | `date: {field: Delivery window, day: [10 January 2027, 24 January 2027]}` · `date: 14 March 2027` · `{next, previous, close}` | Date picker: waits for a previous date popover to close, opens the field, pages months with the calendar's **last visible** month button — a button or an element classed next / prev above or beside the days, never one below them nor a form's submit (a wizard's Next) — (the first click ordinary, the next ones quick presses ~110 ms apart, each with its ripple; runs of 5+ play at up to 3× in the edit), clicks each day by its aria-label or date attribute (ISO or English dates with a year, compared as dates: "1 January 2027" never picks "11 January 2027"; a day without a year or written another way — `10/01/2027`, another language — is matched as words of the labels, so `1 January` does not match "January 1st", and is warned at validation), then closes what it opened (`close: auto` waits for it to close by itself, else clicks outside). A native `<input type=date>` is filled in place (a day outside its `min` / `max` fails the step) |
| `scroll` | `scroll: 560` · `{to: {text: Awards}, offset: -140, duration: 2.2, in: …}` · `{by: 400}` | Animated scroll of the page or a container (a target ends 140 px below the top by default) |
| `drag` | `drag: {from: {text: Card A}, to: {text: Done}, duration: 1.2}` | Press, eased move, release |
| `drop_file` | `drop_file: {zone: {text: Drop files}, path: assets/list.xlsx, from: right}` | The cursor fetches the file at the screen edge, a file "ghost" travels to the zone, then a real drop (or the hidden file input) |
| `wait` | `wait: 0.8` | Sleep (may be trimmed by the editor) |
| `wait_for` | `wait_for: Saved` · `{not_text, target, gone, url, network_idle, timeout}` | Wait until a condition holds (checked every 100 ms; `url`: a substring or a `/regex/`). `network_idle: true` waits until the page has had no request in flight for 0.5 s, counted from the step — so a request the previous click started is waited for; a page that never goes quiet (long polling, a request that hangs) times out, naming what is still loading. The requests of a document that went away (a navigation, a removed frame) are not waited for, nor a response body still open 1 s after its headers (a fire-and-forget call whose answer the page never reads); a worker request of a removed iframe still is (BACKLOG BL-71) |
| `hold` | `hold: 2` | Stay still; never trimmed by the editor |
| `assert` | `assert: {text: €720.00}` · `{url, title, gone, count: {target, equals}}` | Fail with a screenshot unless true |
| `screenshot` | `screenshot: proposal` · `{name, full_page: true}` | PNG in `runs/<id>/screenshots/` |
| `new_tab` | `new_tab: {target: {text: Download PDF}, as: pdf}` · `{href: /report}` | Follow a link into a new tab and keep recording |
| `switch_page` | `switch_page: previous` · `{to: admin, close_current: true}` | Change the recorded page: `previous`, `main` (the environment's first page), an environment page key or a `new_tab` `as` id; `close_current` closes the page left |
| `eval` | `eval: "document.body.classList.add('demo')"` · `{file: hooks/setup.js, arg: …}` | JavaScript in the page (function body) |
| `notify` | `notify: Capture finished` · `{title, message}` | Desktop notification |
| `emit` | `emit: {name: chapter, data: {n: 2}}` | Custom event in the timeline |
| `cursor` | `cursor: hide` · `{move: {x: 1500, y: 540}, duration: 0.8}` · `{set: {x: 0, y: 0}}` | Show, hide, move or teleport the cursor |
| `wait_for_email` | `wait_for_email: {to: noa@cafe.example, subject: Confirm, timeout: 20, as: welcome}` · `{to: persona:buyer, …}` | Wait for a new message in the project's test mailbox and capture it (artefact `email: welcome`); `persona:<name>` is that persona's `email` — see [Mails, documents and notifications](#mails-documents-and-notifications) |
| `download` | `download: {click: {text: Download quote PDF}, as: quote, timeout: 30}` | Real click, then capture the file it produces — a download, or a document opened in a new tab (fetched with the session) — as artefact `document: quote`; PDFs are rasterised page by page. A transfer that breaks on the network (socket hang up, reset, timeout, 502 / 503 / 504) is fetched again, 3 attempts in all; a real error (another HTTP error) fails at once |
| `hook` | `hook: mark-paid` · `{name: mark-paid}` | Run a named hook of the scenario's `hooks:` (else project.yaml's) now, during the take and off camera: the page stays as it is and the edit cuts the step's span — see [Hooks during the take](#hooks-during-the-take) |
| `capture_text` | `capture_text: {target: {testid: proposal-total}, as: total, pattern: "/(€\\s?[\\d.,]+)/"}` | Read the element's visible text (a field's value) — or the part the pattern's first group selects — as artefact `capture: total` for a key-figure card; polled until the pattern matches (up to the step timeout); no cursor move — see [Tutorial overlays and story cards](#tutorial-overlays-and-story-cards) |

**Step modifiers** (on any step): `id` (for `--until` and references), `caption`, `speed` (edit-time),
`hold` (seconds still after the step), `mark` (named marker), `camera` (zoom hint:
`{zoom: 1.3, target: {text: Awards}, ease: slow, duration: 1.2, until: scene_end}`), `overlay` (an overlay component
over the clip: `{component, slots, params, duration, target}`, see below), `tutorial` (this step's tutorial overlays,
e.g. `{spotlight: false}` or `false`, see [Tutorial overlays](#tutorial-overlays-and-story-cards)), `timeout` (seconds;
default: the scenario's `defaults.timeout_s`, else the project's, else 15 — 30 for `wait_for_email` and `download`),
`optional` (a failure does not abort; it is listed in run.json `optional_failures`), `retry_click` (`click` /
`double_click`: a click that did nothing is made once more, and a second dead click fails the step), `irreversible`
(never executed in dry runs), `park`, `note`. The runner
measures the `camera` and `overlay` targets at the **end** of the step — after a `scroll`, the box is where the
element ended up.

`park: true` (or a number of seconds) parks the cursor after the step, then holds it still: after a `scroll` to a
target, next to the target and clear of its text (`pacing.park_scroll_hold`, 3.2 s); after any other step, away
from what changed on the page since the last action started — added, removed or restyled elements, and the element
the action used — (`pacing.park_hold`, 2 s; the step's `hold` when given). On a `hold` step the cursor parks first,
then the hold runs. A park never leaves an open menu or listbox the step opened (by a click or by hovering). Off unless a step asks for it.

When a select, pick or menu trigger opened nothing (no popup, not `aria-expanded`), the runner clicks it once more
after 3 s; a popup that opened but is still filling is left alone, and a search is typed once, as soon as there is a
field to type into.

**Click options:** `strategy` (`auto` · `real` · `dom` · `pointer`), `expect_popup`, `outside`, `hover_ms`,
`after_ms` (also replaces the `after_navigation_ms` minimum), `move_ms`, `button`, `modifiers` (`[Shift]`), `offset`
(`{x, y}` from the element's top-left).

**Step defaults:** `defaults: {timeout_s: 30}` in project.yaml or a scenario (the scenario's win) sets the timeout of
every step that has none of its own — the targets of every action, `wait_for`, `wait_for_email`, `download`, the
commit of a navigation a click starts (at least 15 s) — for a product whose actions take long (a PDF generated on the
server). `assert` keeps its 2 s grace unless the step sets `timeout`.

### When a take goes wrong

A take fails early, loudly and completely rather than "succeeding" with a wrong video:

- **Every missing target of the scene at once.** When a step's target is not found, the error also lists the targets
  of the scene's later steps (up to the first step that opens another page) that are not on the page either — looked
  up without acting — each with the closest visible elements (role, name, text): five renamed labels show in one
  failed take. In run.json: `error.missing_targets[]` (`{scene, step, action, target, near: [{role, name, text}]}`);
  some may only appear after the steps before them (a dialog the next click opens).
- **Targets behind a modal dialog are not used.** While a modal dialog is open (`:modal`, `aria-modal`, or the rest of
  the page `aria-hidden` / `inert` as dialog libraries leave it), a target that also matches inside the dialog — or in a
  listbox or menu above it — is never taken from the page behind it (`in: page` searches the whole page).
- **`type` into the right field, or not at all.** `type {into}` scrolls the field into view inside its own scrolling
  container, waits until its box stops moving (a smooth scroll, a dialog still opening, a layout shift), scrolls a field
  a sticky header or footer covers towards the middle, then clicks; when the focus did not land in the field, the step
  fails before typing, with a screenshot, naming the element that got the focus. After typing, a field whose value
  does not hold the typed text warns (`after typing "300" into spinbutton "Quantity", the field holds "3"`); a value
  that only differs by the page's formatting (thousands separators, a phone mask) passes, a password field's value is
  never shown (lengths only), native date / time inputs are not compared.
- **Dead clicks are reported at once.** A plain `click` / `double_click` is watched from its press: a request, a DOM
  change (in every frame and shadow root; the cursor overlay ignored), a navigation, a dialog, a new tab, a download, an
  `input` / `change` / `submit` / `scroll` / `toggle` event or a field taking the focus counts as an effect. Nothing
  within 1 s: a warning right away (the next steps go on — a `wait_for` that follows is not the one that reports it)
  with `screenshots/dead-click-<scene>-<step>.png`. `retry_click: true` on the step clicks once more instead and fails
  the step when the second click did nothing either. A click that opened a popup or changed the page is never dead;
  the next acting step starts once the check of the previous click is over (at most 1 s after its press).
- **Transient download failures are retried** (above); a mail that never came lists what did come (below).
- **Failed `optional` steps are listed** in run.json `optional_failures` (`{scene, step, action, error, screenshot}`),
  by `studio run` under the summary and by `run_status` over MCP — not only among the warnings.

### Components in scenarios

Everything visual in the edit is a **component** with an id `namespace/name` (lower-case letters, digits and `-`,
e.g. `studio/intro-stack`): the built-in library uses the `studio/` namespace, your workspace `components/` folder
your own. The theme picks a default per kind (see [Templates](#templates-themes)); a scenario overrides it per use:

```yaml
intro: {component: studio/intro-minimal, duration: 2.4}
outro: {component: studio/outro-stack, tagline: "Your catalogue, under control.", url: example.com}
frame: browser                       # every scene; a scene can set its own `frame`
scenes:
  - card: {slots: {kicker: Step two, title: Ask the roaster for a quote}, duration: 2.2}
    id: chapter-request              # cards and interstitials take no capture time
  - id: proposal
    frame: acme/tablet-frame         # a layout component of the workspace
    steps:
      - wait_for: {text: "€720.00"}
        overlay:                     # shown from the end of the step, at most 30 s
          component: studio/overlay-callout
          slots: {text: "Total incl. VAT, ready to accept"}
          duration: 2.5
          target: {testid: proposal-total}   # default: the step's own target, else the cursor
  - interstitial: {text: A few hours later, component: studio/interstitial-plain, params: {tone: dark}}
```

| Key | Where | Value |
|---|---|---|
| `frame` | project, scenario, scene | `raw`, `card`, `browser`, `laptop`, `phone`, `tablet` (= `studio/layout-<style>`), `split`, `pip` (multi-page scenes: `studio/layout-split`, `studio/layout-pip`, see [several pages at once](#several-pages-at-once)) or a layout component id; default `card` (project) |
| `intro` / `outro` | scenario | `false`, or `{component, params, duration}` (+ `tagline`, `url` for the outro), or **your file**: `{video \| image \| lottie, from, to, fit, background, volume, duration}` ([your own media](#your-own-media-and-motion)) |
| `interstitial` | scene entry | `{text, kicker, duration, component, params}`, or your file (as the intro) |
| `card` | scene entry | `{component, params, slots, duration, transition}`; needs `component`, `slots.title` (the theme's card component shows a title) or your file (`video`, `image`, `lottie`) |
| `overlay` | step modifier | `{component, slots, params, duration (0 < s ≤ 30), target}`, or your file over the capture: `{video \| image \| lottie, at, anchor \| rect, scale, duration, loop}` |
| `transition` | scene, card | the transition INTO it: `crossfade` · `cut` · `fade-black` (the theme's of that kind) or a transition component — `studio/transition-tap-open` or `{component, params}` |

No component is ever mandatory: a file given as `video`, `image` or `lottie` is drawn by the built-in `studio/media` /
`studio/lottie` components — see [your own media and motion](#your-own-media-and-motion).

Slots are the texts a component shows (`title`, `kicker`, `text`…); params tune it (see the component's params
schema). The run records cards in `timeline.json` (`kind: card`), each overlay on its step event
(`overlay: {component, slots, params, duration, target, bbox | point}`) and the scenario's `title`, `intro`, `outro`,
effective `frame`, `template` and `music` under `video`, so the editor never re-reads the scenario.

### Targets

A plain string is visible text — or a CSS selector when it looks like one (`#id`, `.class`, `[attr]`,
`li.active`, `nav > a`).

| Key | Example | Matches |
|---|---|---|
| `text` | `{text: Save}` | Visible text: exact first, then case-insensitive substring (the page's own matches decide the tier: an exact match inside a frame does not beat a partial one on the page) |
| `contains` | `{contains: [Finca Quenaro, "2026"]}` | Innermost element containing every string |
| `role` + `name` | `{role: button, name: Request a quote}` | ARIA role (explicit or implicit) and accessible name |
| `label` | `{label: Delivery window}` | Form control by its label (`for`, wrapping label, `aria-labelledby`) |
| `aria` | `{aria: Notifications}` | `aria-label` |
| `placeholder` | `{placeholder: Search coffees}` | Placeholder attribute |
| `testid` | `{testid: save-button}` | `data-testid` |
| `css` | `{css: "table tr:nth-child(2) button"}` | Raw CSS selector |
| `in` | `{text: Save, in: dialog}` · `in: {row: Sweden}` · `in: {css: aside}` | Scope: `dialog`, `menu`, `listbox`, `popover`, `page`, a row, or a target |
| `nth` | `{text: Edit, nth: -1}` | Index among visible matches (negative from the end) |
| `last_visible` | `{role: listbox, last_visible: true}` | The most recently mounted visible match (calendars: a popover's month buttons come after the page's — prefer `date`, or `{aria: Next month, last_visible: true}` with plain clicks) |
| `exact` | `{text: Save, exact: true}` | No substring fallback |

Only visible elements count (not hidden, transparent, clipped or off-page); a match is promoted to its clickable
ancestor. When a target is not found, the error lists the nearest visible texts and saves a screenshot and a DOM
snippet next to the run.

Web components and iframes count as part of the page: targets are found inside **open shadow roots** and inside
**same-origin iframes** (nested ones too), and the cursor, its icon, clicks, typing, `select` on a native `<select>`
and scrolling (inside the frame first, then the page) work there as anywhere else. Matches are counted in visual
order: a component's content right after its host, a frame's content where the frame sits — so `nth` and
`last_visible` see them too. A `css` selector is matched inside each tree on its own and never crosses a component
or frame boundary; to search only inside one, scope it: `in: {css: my-widget}` or
`in: {css: 'iframe[title="Shipping estimate"]'}`, and `scroll: {in: {css: iframe}}` scrolls inside the frame.
Out of reach: **closed** shadow roots and **cross-origin** iframes (payment or chat widgets) — the not-found error
says how many cross-origin frames it could not search. `drop_file` onto a zone inside a frame delivers the file
through the zone's `<input type=file>` (no drag events into frames). See the fixture's `embedded` scenario.

### Templating and hooks

Strings in scenarios and hooks accept `{{page}}` (an environment page base URL, e.g. `{{console}}`), `{{vars.x}}` or
`{{x}}`, `{{env:VAR}}`, `{{keychain:service/account}}` (macOS Keychain, Linux `secret-tool`), `{{run.id}}` /
`{{run.dir}}` (the run folder: hooks of `studio hooks run` have no run folder, only `{{run.id}}`),
`{{hooks.<save_as>.json.id}}` (an earlier setup hook's response) and, inside an http rollback, `{{response.json.id}}`.

**Every string of a scene is templated** — typed text, targets (`click: "Open {{vars.customer}}"`), `wait_for` /
`assert` texts and URLs, `open`, `new_tab`, `select` / `menu` options, `notify`, `emit` data, `wait_for_email`
filters, captions, overlays, page labels, cards, interstitials — and so are the video's `title`, `intro`, `outro` and
`tutorial`. A scene is templated when the run reaches it, after the setup hooks (so `{{hooks.…}}` works in steps and
captions; a dry run skips the hooks: add `--hooks run`, else the run stops on the first `{{hooks.…}}` with that
hint). The timeline records the values, never the tokens. Not templated: names (ids, marks, `on`, `as`, page keys, an
`emit` name, a `screenshot` name) and `note`s; `eval` is templated when it runs, its `file` included. Values are
inserted as they are (not URL-encoded in a URL, not escaped in a `/…/` pattern); a string target is read after
templating, so a value that looks like CSS (`#row-1`) is a CSS target. An unknown key is a validation error, and so
is a `{{…}}` inside a `vars` value (vars values are not templated: they would be inserted as written).

```yaml
setup:
  - name: seed-customer
    http:
      method: POST
      url: "{{admin}}/api/customers"
      json: {name: "{{vars.customer}}"}
      headers: {authorization: "Bearer {{env:STAGING_TOKEN}}"}
      expect: 201
      save_as: customer
      rollback: {method: DELETE, url: "{{admin}}/api/customers/{{response.json.id}}"}
  - sql: hooks/unlock-registry.sql             # *.sql = a file of the project; anything else is inline SQL
    confirm: true                              # required: the file contains UPDATE
  - shell: {run: "pnpm run seed --small", cwd: ../app, timeout: 120}
  - js: {code: "localStorage.setItem('tour-done', '1')", page: app}
teardown:
  - http: {method: POST, url: "{{admin}}/api/demo/reset"}
```

Hook kinds: `http` (`method`, `url`, `headers`, `json` or `body`, `expect`, `save_as`, `rollback`), `sql` (`file` or
`query`, `db`, `rollback`), `shell` (`run`, `cwd`, `env`, `timeout`, `rollback`), `js` (`code` or `file`, `page`,
`rollback`). A SQL or JS hook file that does not exist in the project is a validation error. Common keys: `name`, `confirm`, `destructive`, `optional`, and `writes: false` on a shell hook that only reads (it may then run on a read-only environment). Setup stops at the first failure and rolls
back what it did; teardown hooks always run (even after a failure — of a step or of the setup itself — or Ctrl-C),
then the pending setup rollbacks are replayed, most recent first. Ctrl-C (or SIGTERM) during the setup stops it at
once: a shell hook's process group gets SIGTERM (SIGKILL 2 s later; an http, sql or js hook running then ends first),
the next hooks do not run, the completed ones are rolled back (rollbacks are never interrupted), then the teardown
runs. A second Ctrl-C quits at once and kills the shell hooks still running; what was not rolled back stays in the
run's journal for `studio hooks rollback`.

A `js` hook runs in a **tab of its own** in the run's browser, opened on its environment page (`page`, default the
first one): cookies, localStorage and IndexedDB are shared with the capture, sessionStorage and page state are not,
and the capture never shows that tab — so a scene must `open` its page (a setup hook no longer leaves the capture on
it, and a teardown hook does not see the scenario's last page). The tab stays open for the whole run and later `js`
hooks on the same page key reuse it: an app left running there keeps working in the background (the fixture's
`quote` scenario keeps its console open that way, polling for the web notification the capture records). Every hook
kind is held to the project's allow-list (see [Security](#security)).

#### Hooks during the take

What the product must do at a precise moment of the take without being filmed — a payment marked through its API, a
period moved into the past in SQL, a queue job pushed — is a **named hook** run by a `hook:` step, instead of a side
script polling the database (L5.8):

```yaml
hooks:                         # name → one hook entry, or a list run in order (project.yaml may declare shared ones)
  cafe-requests-a-quote:
    - name: request
      http: {method: POST, url: "{{console}}/api/quotes", json: {product_slug: selowa-ridge, bags: 4}}
    - name: queue
      writes: false
      shell: "sleep 1.5"       # stands for a job queue picking the request up
scenes:
  - id: to-the-list
    offscreen: true            # played, not shown: the video opens on the quote list
    page: console
    open: /products
    steps:
      - click: {role: link, name: Quote requests}
  - id: requests
    steps:
      - hold: 0.8
      - hook: cafe-requests-a-quote    # runs now; the edit cuts this step
      - wait_for: {text: New}
```

- **The same hooks as setup and teardown**: `http`, `sql`, `shell`, `js` entries with their keys, the allow-list, the
  read-only refusals (a read-only run refuses a named hook that writes before anything runs), destructive entries need
  `confirm: true`, and through MCP or the Studio every shell or destructive entry needs a person's approval — bound to
  the entry, its phase (`step`) and its position, asked once whatever the number of steps that run it. A scenario's
  name wins over project.yaml's; validation refuses a step naming a hook neither declares and warns about a named hook
  no step runs, and about a `caption`, `mark`, `overlay`, `camera`, `speed` or `tutorial` on a hook step (the edit
  cuts it).
- **In the take**: the hook runs in the setup's context — `{{hooks.<save_as>…}}` of a setup hook works in it, and its
  own `save_as` in the steps after it —, with the run's cancel (a running shell command is stopped). An entry that
  fails fails the step (an `optional: true` entry is tolerated; the step's own `optional` tolerates the whole hook);
  its rollbacks are journaled like a setup hook's and undone after the teardown. run.json `hooks.steps` says `ok`,
  `failed` or `skipped`; the timeline event's `data` lists each entry's outcome. A dry run skips them unless
  `--hooks run` (`data.skipped`).
- **In the edit**: the step's span (not its `hold`) is cut whole — idle trimming on or off, a mark window included;
  the page may change across the cut (what the hook did shows at once). The raw export cuts it too (reason `hook`)
  and gives an offscreen scene no clip.
- **The filmed part** (L5.5): a `hook:` step is a step like any other, and the named hooks are filmed: a change needs a
  new capture. `offscreen` is edit.

#### Secrets in steps

`{{env:…}}` and `{{keychain:…}}` are secrets: the run resolves every one it will use **before the browser opens**
(a keychain prompt never stalls the capture; a missing variable or item fails the run up front, naming the scene)
and writes `***` instead of their values — raw, URL-encoded (also as the browser writes them in a URL's path or query
and as a GET form submits them), JSON- or HTML-escaped — in `log.jsonl`, `run.json`, `timeline.json` (a URL with a
secret shows `token=***`, in the browser frame of the edit too), `error-*.html` and the terminal (values under 3
characters are not masked). Target descriptions, camera targets, `emit` data and `eval` values are masked wherever
they appear; ids, names, file paths and timestamps are kept as written, so a short secret (a PIN `2026`) never
corrupts them. Captured artefacts (an email, a document, a text) are kept as the app produced them — the description
of the element a `capture_text` read is masked. A secret is a validation error where the video would show it:
captions, overlays, cards, interstitials, scene transitions, page labels, the title.

```yaml
vars: {customer: Harbour Coffee Co., demo_email: agent@northfield.example}
scenes:
  - id: sign-in
    caption: "Signing in to {{vars.customer}}"
    open: /login
    steps:
      - type: {into: {label: Work email}, text: "{{vars.demo_email}}"}      # shown in the video: a var
      - type: {into: {label: Password}, text: "{{keychain:northfield-demo/agent}}"}   # bullets on screen, *** in the files
      - click: Sign in
      - wait_for: "Welcome, {{vars.customer}}"
```

A password field shows bullets; any other field shows what is typed, so typing a secret there warns
(`types the value of a secret reference into a visible field`). For real credentials prefer signing in beforehand —
personas, `studio login`, or their automated `login:` steps off camera (see
[Signing in](#signing-in-personas-and-sessions)); put values the video may show in `vars`.

## Recording a scenario

Instead of writing a scenario, a person can **show the flow once**: `studio record` opens a browser window on an
environment page, you click and type through the flow as you would for a colleague, then close the window. A draft
scenario comes out of it, with targets the runner verified at the moment you pressed. Nothing is filmed while
recording: the draft is a starting point you edit, dry-run and capture like any scenario.

```sh
node packages/cli/dist/bin.js record northfield-fixture my-quote --page shop            # opens the shop's home
node packages/cli/dist/bin.js record northfield-fixture --url http://localhost:4401/imports
node packages/cli/dist/bin.js run northfield-fixture my-quote --dry                     # then check it
```

- **Controls.** Close the window (the last tab) to finish, or press Ctrl-C in the terminal: both stop and **keep**
  what was recorded (a Ctrl-C during the check replay that follows stops the check). The longest recording is 30 min
  (`DEMO_STUDIO_RECORD_MAX_MIN`): it then stops and keeps. There is no in-page control: nothing is added to the page.
  The window opens at its own size (maximised); a window narrower than the capture is warned and the check replay
  runs at the capture size.
- **What is recorded.** Presses (by mouse or by keyboard) on interactive elements, typing per field (committed when
  you leave the field or press Enter), a few keys (Escape, Enter, arrows, Page Up / Down, shortcuts), selects, file
  choices and drops, scrolls, and page changes. A press is resolved to the target a step would use (`click: Save`,
  `{role: button, name: Increase}`, `{label: Message}`); a dropdown becomes `select` or `pick`, a row's menu `menu
  {row, item, confirm?}`, a file zone `drop_file` (a fake file of the same name: set your own), the typed text a
  `type`, an element you waited for a `wait_for`. Scenes split where the page changed; an address-bar visit opens its
  page (`open:`). Captions are empty and nothing is held: add them.
- **What is never recorded.** Anything typed into a field of a secret kind — passwords, card numbers and codes,
  one-time codes, IBANs, PINs, API keys, a long pasted token, or a value autofill put in — becomes a placeholder
  `type: {into: …, text: "{{vars.password_1}}"}` with `vars: {password_1: CHANGE-ME}` (a project.yaml var of that name
  is used instead): set a **showable demo value**, never the real one (a real secret only as `{{env:…}}`, by hand,
  which makes the scenario CLI-only). A long token pasted **or dropped** into any field makes it secret too. Such a
  value never leaves the page: the recorder remembers the values a secret field was left with (6 characters or more —
  not what it held half-way through typing, so a word a password starts with is not masked elsewhere) and masks them
  everywhere else (a password revealed on screen, pasted elsewhere, a re-mounted field). Also never: query strings
  (except one you typed in the address bar, filtered: keys like `token` and values that look like a token or an
  e-mail address dropped), path segments that look like a token or an e-mail address (masked `•••`, in the paths kept
  and the write labels; an `open:` holding one is warned: put a demo value back), coordinates, frames, pages of other
  sites or sign-in pages (their stretch is left out, with a warning), other tabs or pop-ups, and Space / Backspace /
  Delete pressed in a field the page hides in a closed shadow root. A field's initial value is never recorded on its
  own: text you add at its end is recorded alone, but after an edit inside a prefilled field the step types its whole
  final value (`clear: true`), which includes what you kept of the initial text. Text you typed that holds a `{{…}}`
  template (which a scenario would resolve: a var, an environment variable) is left out, with an issue at its place.
  The recorder runs in an isolated world: the page cannot see it or feed it events.
- **Writes.** The window is a real session with the environment's own access, as a run: on a production / read-only
  environment writes are stopped or answered by a mock (as in a dry run); on a read-write one (local, staging) your
  writes reach the product — each is listed after the recording, whatever its host (an API on another host, a form
  post, a beacon), attached to the step that caused it within 2 s (`note: sends POST shop:/api/quotes`), with the
  advice to add a setup or reset hook so each take starts from the same data.
  `--allow-writes` as for `studio run`. Hooks never run while recording.
- **Signed in.** The window uses the page's persona (or `--persona`, `none` signed out): a session that expired signs
  in again off camera when the persona has `login:` steps, otherwise the recording is refused before any window opens,
  with the `studio login` command.
- **After recording.** The summary lists scenes and steps, issues in the order they came, each at its place
  (`scene.step: …`, the step it is about or the one that came next: a target only found by its text, a secret field, a
  fake file, a page opened from the address bar, a write no action caused…), writes, and the **check replay**: a
  headless dry run of the draft at the capture viewport, up to the step before the first one a write that reached a
  server followed — whatever its host and however long after (nothing is written twice; on a read-only environment the
  writes stopped or mocked do not count, so it usually replays the whole draft); it starts from the state the
  recording left the product in. The draft is validated with the project before it is saved or checked. The draft is
  saved as `scenarios/<name>.yaml` when that name is free (default `recorded-YYYYMMDD-HHMM`; an existing scenario is
  never overwritten), and always kept with the recording in `<project>/.demo-studio/records/<id>/` (`draft.yaml`,
  `record.json`, `events.jsonl`; private files; the newest 20). Exit 1 when nothing was recorded, the draft does not
  validate or the check failed. `--json` prints the outcome; `--no-check` skips the replay.
- **Through Claude.** `scenario_record` (MCP) starts the same recording as a job: the window opens on the machine the
  worker runs on and **you** perform the flow — Claude never drives the window, types in it or sees keystrokes live.
  It tells you what to do, waits on the job (the window holds the job queue, so it starts nothing else meanwhile), then
  reads the draft: what you typed and the page's names come back to the conversation as untrusted data, counts and the
  check as trusted fields; a value typed into a secret field never does. Claude then inspects flagged steps, fixes,
  validates and dry-runs. Cancelling the job while the window is open discards the recording; stopping the worker
  keeps it (without its check replay).
- **Limits** (BACKLOG BL-74): tabs, pop-ups and frames are not recorded (a new tab is warned); a date picker, a drag
  or a hover-to-reveal is recorded as plain clicks (or not at all for hover); no alternative targets are offered; on a
  page with ~10,000 controls a press takes ≈ 0.2 s to resolve, then falls back to its text. Typing not yet committed
  when the window closes is best effort.

## Your own media and motion

Templates never lock you in: the intro, the outro, a card, an interstitial and an overlay can each be **your own file**
instead of a provided component — the full guide, with export settings for motion tools, Remotion, Lottie, your own
components and the output of Claude motion / design skills, is
**[docs/BRING-YOUR-OWN-MOTION.md](docs/BRING-YOUR-OWN-MOTION.md)**.

```yaml
intro: {video: assets/intro.mp4}                     # with its own sound; the music bed ducks under it
outro: {image: assets/end-card.png, duration: 3}
scenes:
  - card: {lottie: assets/cup-steam.json, params: {colors: {"#ff5a1f": accent}}}   # theme colours replace the file's
  - id: send
    steps:
      - click: {text: Send request}
        overlay: {video: assets/sparkle-burst.webm, at: click, anchor: target, scale: 0.9}   # VP9 or ProRes 4444 alpha
```

| Field | Value |
|---|---|
| `video` · `image` · `lottie` | one file per use: `.mp4` `.mov` `.webm` `.m4v` (H.264, HEVC, VP8, VP9, AV1, ProRes) · `.png` `.jpg` `.jpeg` `.webp` `.svg` · a Lottie `.json` |
| `from`, `to` | video only: the part of the file to play (s); its length is the segment's unless `duration` is set (a shorter file holds its last frame, an overlay can `loop`) |
| `fit`, `background` | `cover` or `contain` (default: cover when the file has about the frame's shape, else contain — a 16:9 intro shows whole in the vertical variant), and what shows around a contained or transparent file: `theme` (the theme background, default), a theme colour key (`paper`, `dark`, `accent`…), a CSS colour or `none` |
| `volume` | video only, 0–1 (default 1): the file's own sound; a silent file stays silent and the music bed ducks only under files that play sound |
| `at` (overlay) | `step` / `end` (the end of the step, default) · `start` · `click` (the click of a pointer step) · `mark:<name>` (a marked step) · seconds after the step starts |
| `anchor` · `rect` (overlay) | `target` (default when the step has one), `cursor`, `screen`, `center`, `top-left` … `bottom-right` · or a page rect `{x, y, w, h}` in CSS px; `scale` sizes an anchored file relative to its own size in page px; the box follows the camera, zooms and vertical / square reframing (which keeps a target / cursor / rect box in view while it shows); a corner or side moves to the nearest free one when, in a variant's framing, it would cover the step's target (plan note) |

Validation is positioned (line:column) and says what to do: a missing file, a wrong extension or container, a codec
outside the list, `from` / `to` past the end of the file, an overlay video without alpha. Files are drawn by the
built-in **`studio/media`** (video, image) and **`studio/lottie`** components, usable as intro, outro, card,
interstitial and overlay; a theme can name files too (`components: {intro: {video: intro.mp4}}`, relative to the
template folder).

## Templates (themes)

`templates/<name>/template.yaml` gives the brand and motion style (colours, fonts, logo, wordmark, background, cursor,
captions, timings) and picks a default **component per kind**. Every section is optional and merged over the
defaults; start from a starter template (`templates/README.md`). The starter templates `default`, `editorial` and
`motion` are always available by name, also in a workspace without a `templates/` folder (`studio list` marks them
"starter"); a workspace template of the same name takes precedence.

```yaml
# yaml-language-server: $schema=../../packages/core/schema/template.schema.json
brand: {name: Atelier, url: example.com}      # wordmark drawn as text, outro url
components:                                    # an id, or {id, params}; null = none
  intro: studio/intro-stack
  outro: studio/outro-stack
  interstitial: studio/interstitial-clock
  card: studio/card-title
  layout: {id: studio/layout-card, params: {width: 1560, radius: 18, shadow: soft}}
  caption: studio/caption-below                # caption: null → no captions
  overlay: studio/overlay-callout
  transition: {id: studio/transition-crossfade, params: {duration: 0.35}}   # transition: null → cuts
```

A kind that `components` does not set is mapped from the legacy fields:

| Legacy field | Value → component |
|---|---|
| `frame.style` | `card` → `studio/layout-card {width, radius, shadow}` (from `frame`); `browser`, `laptop`, `phone`, `tablet`, `raw` → `studio/layout-<style>` |
| `intro.layout` | `logo-kicker-title` → `studio/intro-stack`; `kicker-title` → `studio/intro-minimal`; `logo-only` → `studio/intro-minimal {logo_only: true}` |
| `outro.layout` | `logo-wordmark-tagline-url` → `studio/outro-stack`; `logo-tagline` → `studio/outro-minimal`; `logo-only` → `studio/outro-minimal {logo_only: true}` |
| `interstitial.style` | `dark-clock` → `studio/interstitial-clock`; `paper`, `dark` → `studio/interstitial-plain {tone}` |
| `captions.position` | `below` → `studio/caption-below`; `above` → `studio/caption-below {position: above}`; `overlay` → `studio/caption-overlay`; `none` → no caption |
| `transitions.between_scenes` | `crossfade` → `studio/transition-crossfade {duration}`; `fade-black` → `studio/transition-fade-black {duration}`; `cut` → none |
| (none) | `card` → `studio/card-title`; `overlay` → `studio/overlay-callout` |

An explicit `components` entry is taken as written (legacy params are not merged into it); validation warns when it
contradicts a legacy field written in the same file. `resolveThemeComponents(template)` (core) returns the resolved
choice per kind with its source (`theme`, `legacy` or `default`). The starter templates declare both, consistently.

### Themes from your brand

Put the brand's files in the workspace — a `brand/` folder is the convention: a logo (`.svg`, `.png`, `.jpg`, `.webp`),
optionally a wordmark and font files (`.ttf`, `.otf`, `.woff`, `.woff2`) — and make a theme from them and the brand's
colours:

```sh
studio theme create acme --accent '#0e7c66' --logo brand/logo.svg --wordmark brand/wordmark.svg \
  --display-font brand/AcmeSerif-Regular.ttf --body-font brand/AcmeSans-Regular.ttf --body-font brand/AcmeSans-SemiBold.ttf \
  --brand-name Acme --brand-url acme.example
```

or ask Claude (MCP `template_create_from_brand`, same inputs, the files named relative to the workspace root). It writes
one **new** folder `templates/acme/`: `template.yaml` over a base theme (`--base`, default `editorial`: its components,
frame, captions, motion and durations are kept), the logo and wordmark copied as `logo.<ext>` / `wordmark.<ext>`, the
fonts as `fonts/display-<Weight>.<ext>` / `fonts/body-<Weight>[Italic].<ext>` (the renderer reads a face's weight from
its file name; no fonts given: the base's are copied), `LICENSES.md` (where each file came from, what each font
declares about its licence) and `.demo-studio-theme.json` (inputs and the sha256 of every file written).

- **Colours** are hex. Only the accent is required; text, muted, paper, a night tone (`dark`) and the background are
  derived from it when omitted (a dark paper makes a dark theme; base `motion` suits it). Contrast is checked (WCAG:
  text 7:1 on the paper and the background, muted 4.5:1, the paper 7:1 on the night tone, the accent 3:1 on the paper);
  a colour that misses its threshold — derived or given — is lifted towards black / white and every change is listed
  (`--no-adjust` keeps them, with warnings). The accent is never changed: when it reads poorly on the paper you get a
  suggested value to pass instead. The same inputs always give the same theme.
- **Files are checked before they are copied:** raster images by their header (format matching the extension, 64 px
  high at least, 8192 px at most), SVGs by a strict scan — UTF-8 only (an XML declaration of another encoding or a
  control character is refused), no script, event handler, `foreignObject`, external link or `url()`, `@import`, CSS
  escape, DOCTYPE or entity under any namespace prefix (a font embedded as `data:font/woff2`, as in the starters'
  wordmarks, is fine) — refused, never cleaned: export a plain SVG or a PNG. Fonts by their header (TrueType /
  OpenType tables, WOFF / WOFF2 header); a font whose embedding bits say "restricted" or "preview & print" is copied
  with a warning — check that its licence allows videos. A WOFF / WOFF2 keeps its weight compressed: it is read from
  the style word after the file name's last `-` or `_` (`Brand-SemiBold.woff2` → 600; none → 400), with a warning —
  give `{file, weight}` to set it. What a font says about itself (family, copyright, licence) is printed without
  control or bidirectional characters and escaped in `LICENSES.md` (never a link or an image there).
- **Names**: lower-case letters, digits and `-`; never a starter's name (`default`, `editorial`, `motion`, in any case)
  nor a folder that already exists in `templates/`. `--replace` (MCP `replace: true`) replaces a theme Demo Studio made
  only while none of its files changed and none was added — once you edit it, it is yours; through MCP only a theme
  made through MCP is replaced (never one you made with `studio theme create`). Refused when the
  workspace's templates folder lies inside the Demo Studio folder (the repository is not a workspace for your brand:
  set `DEMO_STUDIO_ROOT` or a `studio.yaml`).
- Through MCP the files must be files of the workspace that no tool writes: never in a hidden folder (`.demo-studio/`),
  `components/`, or a project's `scenarios/`, `runs/`, `renders/`, `review/`, `exports/` (case ignored), never through
  a link leaving the workspace. A human typing `studio theme create` names any file. These rules hold against what
  Demo Studio's MCP tools write; an agent's own file tools (Claude Code's Write, under your permissions) can still put
  a file in `brand/` — the content checks above apply to it all the same.


### Themes from a site

No brand kit at hand? Read the brand's public site:

```sh
studio theme from-site https://www.brand.example/
```

or ask Claude (MCP `template_from_site {url}`: **you are asked to approve the exact URL first**, in your MCP client).
A clean headless Chromium on your machine opens the page once and writes to `.demo-studio/site/<id>/`: `site.json`
(colour swatches with their share of the page and contrast ratios, roles — paper, text, accent, dark —, the font
family names the page uses, the logo candidates, network counts), `screenshot.jpg` and up to six logo candidates
`logo-<n>.png` (the header's logo images and inline SVGs, the icons, the og:image — converted to transparent PNGs by
the browser with JavaScript off and no network; the site's own bytes are never kept, nor its font files). The answer
ends with a draft for `studio theme create` / `template_create_from_brand` — the colours, `logo: site:<id>/logo-1`, the
host as the brand URL — and the template.yaml it would make (not written). Choose, change what you like, give the
brand's font files yourself (a site's fonts are not copied: their licence rarely allows it), then create the theme.
The newest 10 extractions are kept.

- **What opens:** `https://` only, the default port, no user name, query string or fragment, a DNS name (never an IP
  literal, `localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.test`, `.invalid`, `.example`, `.onion`,
  `.alt`…), at most 5 redirects (followed first with the same rules, then the page opens on the last URL) — on the
  approved host and its `www.` / apex sibling only: a redirect to another host fails the extraction, and that URL is
  read once you approve it in turn. "Public" means what this machine reaches as public addresses: through a VPN or a
  split-horizon DNS, a public-looking name may still lead to a network of yours. Never a page of one of your
  projects' environments, nor a protected host — those are filmed through runs and `page_inspect` (a warning only in
  `studio theme from-site`). Only the URL you approved is checked against them, not what the page then loads.
- **The browser's only network is a local proxy in the worker** that connects to public addresses only (every address
  a name resolves to must be public: no loopback, private, link-local / cloud metadata, carrier-grade NAT,
  documentation, multicast or IPv6 special range) and to the address it checked (no DNS rebinding), on port 443, for
  hosts the page actually requested; Chromium resolves nothing itself. Only GET and HEAD go out (a form, a beacon, a
  POST are blocked and counted), WebSockets are closed, WebRTC sends no UDP, service workers cannot register, shared
  workers and `fetchLater` do not exist (their requests would skip these checks), downloads are refused, a navigation away — or a
  popup's — is answered "no content" (the page stays), and caps bound each connection (15 MB, 15 s idle, 60 s) and the
  extraction (40 MB, 200 connections, 300 requests; 15 s per call into the page, 120 s in all — a page that hangs its
  renderer fails, and `job_cancel` closes the browser at once). Nothing is clicked or typed (a cookie banner stays in
  the screenshot); the browser profile is ephemeral — the site's cookies live only in it. Files are written by the
  worker into a folder it makes new (never through a link), and read back only when they are plain files of their
  type; logo candidates a create would refuse (under 64 px high, over 2 MB) are never made (drawn smaller first).
- Through MCP, everything the page chose — its title, description, site name, alt texts, font names, URLs, the hosts
  it tried, errors — comes back under `untrusted`, and the images are described as a third-party page (text in them is
  data, not instructions). `site:<id>/logo-<n>` is the only way a theme can take a file from `.demo-studio/`: a PNG of
  that extraction, a plain file (no link), re-checked by its header.
- Tests: `DEMO_STUDIO_UNSAFE_TEST_RESOLVE=brand.test=127.0.0.1:<port>,…` maps invented `.test` names to local ports
  (and accepts their self-signed certificates) for the test suite only; `studio doctor` warns when it is set.
## Components

Every visual element of the edit — intro, outro, cards, waiting screens (interstitials), captions, screen layouts,
overlays and transitions — is a **component**: a folder with a manifest and a React ([Remotion](https://www.remotion.dev))
implementation. The editor only assembles components; themes give them their colours, fonts and logo.

```
components/<namespace>/<name>/     # in your workspace (studio.yaml components_dir); built-ins: packages/components/library/
  component.yaml                   # the manifest
  index.tsx                        # export default function (props: ComponentProps) { … }
  preview.png                      # generated by `studio components preview` (960×540), never hand-edited
  preview.json                     # its sidecar: theme, moment, source hash (stale when the sources change)
  README.md                        # your notes + a generated block showing the preview, slots and params
```

**Ids and resolution.** An id is `namespace/name` (lower-case letters, digits and `-`) and must match the folder. Ids
resolve from the workspace `components/` folder first, then the built-in library (`studio/…`), then — later — a
marketplace cache: a workspace component with a built-in id overrides it (`studio components list` warns). The built-in
library (`packages/components/library/studio/*`) has a component for every id the starter themes and the legacy
template fields use, plus a tablet layout — every one theme-driven, in the family of the **reference look** of
`docs/reference/look.md` (the six measured on renders carry the tag `reference-look`), each with its committed preview:

| id | kind | what it draws (main params) |
|---|---|---|
| `studio/intro-stack` · `studio/intro-minimal` | intro | logo row, kicker, title, rule (reference) · kicker + title fading in, or `logo_only` |
| `studio/outro-stack` · `studio/outro-minimal` | outro | big logo, wordmark, rule, tagline, url (reference) · logo + one line, or `logo_only` |
| `studio/card-title` | card | chapter card: kicker, title, rule, text (`tone: paper \| dark`, `align`) |
| `studio/interstitial-clock` · `studio/interstitial-plain` | interstitial | night veil + clock (reference) · veil (`tone: dark \| paper`) + kicker, text and a filling accent line |
| `studio/layout-card` | layout | the capture in a rounded card, caption below (reference; `width`, `radius`, `shadow`) |
| `studio/layout-browser` | layout | macOS-style window: traffic lights, an address bar with the clip's **display URL** (changes with navigation; a local URL without one is never drawn: README "Environments"), optional `tabs`; `width`, `chrome: auto \| light \| dark`, `controls: color \| theme` |
| `studio/layout-laptop` | layout | MacBook-style laptop drawn in CSS (bezel + camera, hinge, base with thumb notch); `width`, `finish: light \| dark` |
| `studio/layout-phone` | layout | iPhone-style phone (status bar, Dynamic Island, side buttons) for mobile captures, the caption beside it; `height`, `finish`, `island`, `status_bar` |
| `studio/layout-tablet` | layout | iPad-style tablet: upright with the caption beside it for portrait captures, lying with the caption below for landscape ones; `height`, `width`, `finish` |
| `studio/layout-raw` | layout | the capture edge to edge, the caption over its bottom |
| `studio/layout-split` · `studio/layout-pip` | layout | two pages of a multi-page scene side by side (stacked in vertical) with their labels · the main page with the other floating over a corner (a phone around a mobile page) — see [several pages at once](#several-pages-at-once) |
| `studio/caption-below` · `studio/caption-overlay` | caption | rule + kicker + line under the card (reference) · a translucent band over the capture (`position: over \| area`) |
| `studio/overlay-callout` · `studio/overlay-lower-third` | overlay | a ring on the target + a pill pointing at it, never off-screen · a paper lower third inside the capture |
| `studio/transition-crossfade` · `studio/transition-fade-black` | transition | crossfade (reference) · dip through black or the theme's night tone |
| `studio/media` · `studio/lottie` | card (also intro, outro, interstitial, overlay) | **your file** (slot `file`): a video (alpha composited, own sound) or an image · a Lottie animation with theme colours replacing its own (`colors`) — see [your own media](#your-own-media-and-motion) |

Layouts size their screen from the **capture's aspect** (geometry expressions below): the browser and laptop keep it
exactly, the phone and the tablet within device proportions (0.42–0.62, 0.62–1.6) — a capture outside them is
letterboxed / pillarboxed in the device screen with the theme background (`rects.display`), as is a capture of another
aspect in `raw`. `frame: tablet` (scenario, project, `--frame`) is the tablet layout, like `card`, `browser`, `laptop`,
`phone` and `raw`. `packages/components/scaffolds/<kind>/` holds one valid, theme-driven template per kind
(`studio components create` copies it; the renderer draws it as the stand-in of a missing component).

**How a theme picks components.** A template's `components:` map (or its legacy fields, see
[Templates](#templates-themes)) names the default component and params of each kind; a scenario overrides it per use
([Components in scenarios](#components-in-scenarios)). Params given by the theme or the scenario are merged over the
component's defaults and validated against its params schema (`registry.resolve`); a typo or an out-of-range value is
an error naming the param.

### component.yaml

```yaml
# yaml-language-server: $schema=<path to packages/components/schema/component.schema.json>
id: acme/intro-split              # = folder <namespace>/<name>
version: 1.0.0                    # semver
kind: intro                       # intro | outro | card | interstitial | caption | layout | overlay | transition
name: Split intro
description: Logo on the left, title on the right, sliding in.
publisher: Acme                   # optional marketplace metadata: publisher, license, tags
entry: index.tsx                  # default
slots:                            # the values it renders
  title: {type: text, required: true, default_from: scenario.title.text, max_chars: 60}
  kicker: {type: text, default_from: scenario.title.kicker}
  logo: {type: image, default_from: theme.logo}
params:                           # JSON Schema (object) with defaults
  type: object
  properties:
    align: {type: string, enum: [center, left], default: center}
    stagger: {type: number, minimum: 0, maximum: 0.5, default: 0.12}
tokens: [colors.accent, colors.text, fonts.display, logo]   # theme tokens it reads
duration: {default: 3.2, min: 1.5, max: 8}                  # seconds (not for layouts and captions)
variants: [landscape, vertical, square]
preview:                          # sample values: previews render with any theme, without a scenario
  slots: {title: Quotes in two clicks, kicker: Product tour}
  at: [0.4, 1.6]
```

| Key | Notes |
|---|---|
| `slots.<name>` | `type`: `text`, `image` (URL), `url` (shown as text), `color`, `screen` (the capture: layouts, interstitials, transitions); `required`; `default_from`: `theme.logo`, `theme.wordmark`, `theme.brand.name`, `theme.brand.url`, `theme.outro.tagline`, `theme.outro.url`, `scenario.title.text`, `scenario.title.kicker`, `scenario.outro.tagline`, `scenario.outro.url`, `scene.caption.text`, `scene.caption.kicker`, `interstitial.text`, `interstitial.kicker`; `max_chars` (text and url) |
| `params` | JSON Schema subset: `type`, `properties`, `required`, `additionalProperties`, `default`, `enum`, `const`, `minimum`/`maximum` (+ exclusive), `multipleOf`, `minLength`/`maxLength`, `pattern`, `items`, `minItems`/`maxItems`, `uniqueItems`, `anyOf`, `oneOf` (+ annotations such as `description`). Objects are **closed** unless they set `additionalProperties`. Every `default` must match its schema |
| `geometry`, `geometry_vertical`, `geometry_square` | layouts only: `screen` (+ `frame`, `chrome`, `caption`, `brandmark`) rects `{x, y, w, h}` in the 1920×1080 (vertical: 1080×1920, square: 1080×1080) design space, and `radius` — the planner and the review reason on them without rendering. `geometry` is required, the others when `variants` lists `vertical` / `square`. Every value may be an **expression** over the numeric params (see below). In the vertical and square variants a screen rect with another aspect than the capture **reframes** it (see [Variants](#variants-4k-music-and-export)) |
| `preview` | `slots` must give a sample for every required slot that is not filled from the theme; `params` are validated; `at` = seconds of the preview stills (preview.png shows the last one); `screen`: `desktop` (default), `tablet` or `phone` — the sample screen a layout, caption, overlay or transition preview shows |

**Geometry that follows params.** A layout's geometry values are numbers or arithmetic expressions over its numeric
(or boolean: 1 / 0) params, the geometry's own `vars` (computed in order) and `aspect` (the capture's width / height;
16:9 in previews): `+ - * / %`, parentheses, `min()`, `max()`, `round()`, `floor()`, `ceil()`, `abs()` — nothing else,
so a manifest stays data. The planner evaluates the geometry with the params of each use (theme `components` entry,
legacy `frame.width`, scenario, overrides) and the capture aspect; captions, overlays and the brand mark are placed from
the evaluated rects, and the composition hands the same rects to the layout component (`props.rects`, output px), so
the card is drawn exactly where the captions expect it. `studio components validate` parses every expression, rejects
unknown names (did you mean) and string params, and checks the geometry evaluated with the param defaults stays inside
the design space; at plan time a use whose geometry cannot be evaluated or leaves the frame is a plan warning. The
built-in card layout:

```yaml
geometry:
  vars:
    h: min(round(width / aspect), 878)          # the capture's aspect; the caption block must fit below
    w: min(width, floor(878 * aspect))
    x: round((1920 - w) / 2)
    y: round((958 - h) / 2)                     # card + 12 px + 110 px caption block, centred
  screen: {x: x, y: y, w: w, h: h}
  frame: {x: x, y: y, w: w, h: h}
  caption: {x: x, y: y + h + 12, w: w - 340, h: 110}
  brandmark: {x: x + w - 320, y: y + h + 47, w: 320, h: 40}
  radius: radius
```

(width 1560, 16:9 → the reference card {180, 40, 1560 × 878}; width 1400 → {260, 85, 1400 × 788} with the caption and
the brand mark under it.)

### Implementation

```tsx
import { Background, FitText, Logo, rise, stagger, useCurrentFrame } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { align: 'center' | 'left'; stagger: number };

export default function SplitIntro({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();                       // relative to the component's segment
  const enter = (i: number) => rise(frame, fps, { delay: stagger(i, { step: params.stagger }), unit });
  return (
    <Background theme={theme}>
      <div style={enter(0)}><Logo theme={theme} size={64} unit={unit} /></div>
      <div style={enter(1)}>
        <FitText text={slots.title ?? ''} width={width * 0.6} maxFontSize={96 * unit} maxLines={2}
                 fontFamily={theme.fonts.display} color={theme.colors.text} />
      </div>
    </Background>
  );
}
```

Rules, checked by `studio components validate`: read every colour, font and logo from `props.theme` (never a brand);
size everything in 1920-wide design px times `props.unit` (2 for 4K, 0.5 for previews); animate from
`useCurrentFrame()` only — no `Math.random()` (use `random(seed)` from the kit; `random(null)` and `random()` are
refused too), `Date`, timers or network; import
only `react`, `remotion`, `@demo-studio/components/kit` and the component's own files — the renderer primitives
(`useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`, `random`) through the kit, like the scaffolds,
and `remotion` directly only for what the kit does not re-export (`interpolate`, `spring`…). Props: `theme`, `slots`,
`params` (defaults applied), `unit`, `width`, `height`, `fps`, `durationInFrames`, `variant`, and per kind `screen`
(layout: the capture; interstitial: the last frame; transition: the wrapped segment), `rects` (layout: its evaluated
geometry in output px — `screen` = where the capture pixels go, `frame`, `display` = the declared screen rect when the
capture is letterboxed in it, `caption`, `brandmark`, `chrome`, `radius`; absent outside a plan — and, for captions
and overlays, the rects of the clip's layout, so they can sit over the capture), `url` (browser chrome: the page URL at
this frame as the video shows it — its display URL; absent for a local URL without one), `cues` + `area` (caption: cues in segment frames, the layout's caption rect), `anchor` (overlay: the
target box in output px) and `direction` (transition: rendered around the outgoing segment, `exiting`, and the
incoming one, `entering`, on top). `theme.style_bias` (`real` | `balanced` | `motion`) says how lively the
motion should be: `biasMotion(bias)` gives the factors the built-ins use (`real` = the subtle reference motion).

**Theme tokens** (`props.theme`, built by `themeTokens(template, urls)`): `colors` (accent, text, muted, paper +
custom keys — e.g. `dark`, the night tone of dark cards, else the darker of text / paper), `background` (solid /
radial / linear), `fonts.display` / `fonts.body` (CSS family names the renderer
registers from the template font files), `logo`, `wordmark` (image and/or the brand name as text), `brand` (name,
url), `cursor.ripple_color`, `style_bias`, `captions` (kicker and line text styles), `brandmark`, `motion.zoom_ease`.

### The kit (`@demo-studio/components/kit`)

| Helper | What it does |
|---|---|
| `useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`, `random` | the renderer primitives, re-exported from remotion (`kit/renderer.ts`, the one place a renderer change touches for your components; remotion's attribution and licence terms unchanged) |
| `easing(name \| bezier \| fn)`, `EASINGS`, `cubicBezier`, `themeEasing(theme)` | curves: `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `standard`, `entrance`, `exit`, `gentle`; the template's `zoom_ease` |
| `progress`, `fadeIn`, `fadeOut`, `fade`, `rise`, `stagger`, `activeIndex` | frame-driven animation (frame + fps, seconds, design px × unit) |
| `fitText`, `wrapText`, `balanceLines`, `measureText`, `<FitText>` | the largest font size ≤ max that fits a width (and height / line count), balanced lines, cut with "…" below the minimum: text never overflows. Measured with a canvas in the browser, a deterministic estimate in Node |
| `fontMetrics`, `capOffset`, `capTextLayout`, `<CapText>` | text placed by its **cap band** (reference positions are cap centres): the font's ascent / descent / cap height measured with a canvas in the browser (estimated in Node), `capTextLayout` fits the text (fitText) and says where its line box goes so the first cap top lands at the wanted y, whatever the font |
| `<Background>`, `<Logo>`, `<Wordmark>`, `<SafeArea>` | theme background; logo image (monogram of the brand without one); wordmark at a VISUAL height: the image that tall, or the brand name in the display font at height × `WORDMARK_TEXT_SCALE` (1.3) with its baseline on the bottom edge; title-safe box |
| `backgroundCss`, `backgroundSample`, `isDarkBackground`, `cssFontFamily`, `textStyleCss`, `withAlpha`, `mixColors`, `darkLight`, `nightTone`, `contrastRatio`, `readableOn`, `safeAreaRect`, `scaleRect`, `roundTo` | CSS from tokens, colour helpers (a representative background colour, mixes, the night tone `colors.dark` or the darker of text / paper), rects |
| `biasMotion(style_bias)` | `{travel, settle, tracking, pace}`: how much livelier than the reference a component may move (`real` = 1, 0, 0, 1) |
| `cardShadow`, `deviceTones`, `SYSTEM_COLORS`, `addressParts`, `captionBandBox` | frames around a capture: the reference soft shadow tinted with the theme; device metals and glass derived from the theme (`dark` / `light` finish); the classic window-control colours (system UI, not brand) and pure white / black for masks and QR codes; a URL split for an address bar; where an overlay caption band goes (shared with the review) |
| `formatMetrics(variant, unit)`, `FORMAT_SCALE`, `captionMaxLines(variant, max, width)` | laying out for the output format: full-frame components (intros, outros, cards, interstitials) take `u` (type ×1.2 in vertical, ×1.05 in square) and `inset(m)` (side margins halved in the 1080-wide formats); caption lines may wrap to 2 lines in vertical / square, 3 in a narrow column (shared with the review) |
| `parseShortcut(keys, platform)`, `shortcutText`, `KEY_GLYPHS` | key caps of a Playwright key combination: macOS symbols as line glyphs (⌘ ⌥ ⇧ ⌃ ↩ ⇥ ⌫ arrows) in the conventional order, or Windows / Linux words |
| `parseFigure`, `formatFigure`, `figureAt`, `parseNumber` | figures as written ("€1,240.50", "12,5 %"): prefix, suffix, separators, decimals; a counter's text at a progress, ending on the exact text |
| `qrEncode(text, {level, version, mask})`, `qrMatrix`, `qrPath` | a dependency-free QR Code encoder (byte mode, versions 1–40, L/M/Q/H, penalty-scored masks) and an SVG path of its modules |
| `<Icon name>`, `ICON_NAMES` | the built-in line icon set of feature lists |
| `<Picture media>`, `pictureAspect` | a `PictureMedia`: an image, or a frame of the capture video frozen at its time |
| `placeBeside({target, w, h, bounds, gap, order})` | a box beside a target, inside bounds, never over it (badges, the loupe) |

### Creating, checking and previewing components

```
$ studio components create acme/intro-split --kind intro --description "Logo left, title right."
✓ created intro component acme/intro-split in components/acme/intro-split (validated)
  preview.png     generated preview (editorial theme, at 2.8 s): components/acme/intro-split/preview.png
$ studio components validate acme/intro-split
✓ component acme/intro-split components/acme/intro-split
$ studio components preview acme/intro-split --theme ./my-theme
✓ acme/intro-split components/acme/intro-split/preview.png 41 KB · at 2.8 s
$ studio components preview --all --stale          # every component whose preview is missing or out of date
$ studio components list --kind intro
```

`create` copies the scaffold of the kind (a tasteful, theme-driven placeholder that imports only react and the kit)
with your id, name and description, validates it and renders its preview (`--no-preview` skips it; without a browser
it warns and you run `studio components preview` later). `validate` checks the manifest (strict keys with "did you mean", semver, slots and their sources,
params schema and defaults, preview samples, layout geometry inside the design space, id = folder), the entry file,
and compiles the entry with esbuild: syntax errors, imports other than react / remotion / the kit (named), misspelt
named imports (`"remotion" has no export named "useCurrentFrme" (did you mean "useCurrentFrame"?)`), and
non-deterministic or networked APIs — every message as `file:line:col`. Without an argument it validates every
workspace component (exit 1 on any error). In code: `loadComponentRegistry({root})` (`list(kind?)`, `get(id)`,
`resolve(ref, kind)`, `resolveTheme(template)`), `validateComponent(dir)`, `createComponent(root, {id, kind,
description})`, `themeTokens(template, urls)` from `@demo-studio/components`.

**Previews.** `studio components preview [<id|dir>] [--all] [--stale] [--workspace] [--theme <name>] [--out <dir>]
[--json]` renders each component with its manifest's preview samples, in context: an intro, outro or card alone; a
layout with a neutral **sample screen** (`packages/components/preview/`, generated once from the fixture shop by
`scripts/preview-samples.mjs`: desktop, tablet, phone) as its capture, the brand mark and the theme's caption; a caption,
overlay or transition over the theme's layout with that screen (a transition into the theme's card); an interstitial
over it as its backdrop — at the manifest's last `preview.at` second, with the theme of `--theme` (default the
`editorial` starter; previews are never hand-edited and always follow the theme you pass). It writes
`<component>/preview.png` (960×540: the 1920×1080 frame at half scale, palette-quantised when needed to stay ≤ 200 KB),
`preview.json` (component, version, theme, moment, sample screen, the files it depends on — manifest, entry and its
local imports — and their hash) and the generated block of `README.md` (name, id, kind, the image, slots, params; your
own text around it is kept). `--out <dir>` writes only the images (`<dir>/<namespace>/<name>.png`). `--all` covers the
workspace components, the built-in library and the scaffolds; `--stale` only those whose preview is missing, rendered
with another theme or older than their sources. One bundle and one browser serve every preview (≈ 30 s for the 27
built-ins). The built-in previews are committed and a test fails when one is missing or stale. In code:
`renderComponentPreviews({root, targets, template, outDir?})` and `buildComponentPreview` (the pure spec) from
`@demo-studio/editor`; `previewStatus(dir)`, `componentSourceHash(dir)` from `@demo-studio/components`.

## Mails, documents and notifications

A video often needs what happens **outside** the page: the confirmation email that lands, the PDF the product
generates, the notification the app shows. The runner captures them as **artefacts** of the run; components show them,
fed by their name.

**Test mailbox.** `mailbox: {provider, url, poll_ms?, headers?}` in project.yaml points at a test mailbox; its host
must be allowed like a hook's (localhost, an environment host or `allow_hosts`). `provider: mailpit` reads the
[Mailpit](https://mailpit.axllent.org) API (`GET <url>/api/v1/messages`, `GET <url>/api/v1/message/<ID>`, inline
`cid:` images from `…/part/<PartID>`); `provider: http` reads a generic JSON API:

```
GET <url>/messages        → [{id, from, to, subject, date}]   (or {messages: [...]})
GET <url>/messages/<id>   → {id, from, to, cc?, subject, date, text, html}
```

where `from` is `"Name <address>"`, an address or `{name, address}` and `to` a string, a list of those or of objects.
`headers` (e.g. an API token, `{{env:VAR}}` expanded) are sent with every request. The bundled fixture serves a
Mailpit-compatible mailbox at `http://localhost:4401/mailbox` (the fixture project uses it).

**`wait_for_email: {to?, from?, subject?, timeout?, as}`** polls the mailbox (every `poll_ms`, default 500) until a
**new** message matches — one that was not there when the run started (the runner lists the mailbox before the setup
hooks) and that no earlier `wait_for_email` of the run took; the oldest match wins. `to` / `from` match a substring of
the address or the display name (case-insensitive), `subject` a substring or a `/regex/flags`; `timeout` defaults to 30
s (or `defaults.timeout_s`). `to: persona:<name>` is that persona's `email` (`auth.personas.<name>.email`; a sandbox
account signed in with its mail address as `username` has it already), matched as the whole address — validation
fails on a persona without one — and the captured mail remembers the persona: `studio/mail-view` labels its mailbox
after it ("Inbox · Buyer"). When no message matches in time, the error lists the messages that came during the wait
and the earlier ones not captured (subject, sender, recipients) — the mail that went to another address shows there —
or says that nothing came at all. When several new messages match (the same subject sent to several people), a
warning names them and the oldest is taken: narrow the filter. The message is written to `runs/<id>/artefacts/emails/<as>.json` (`{from, to, cc, subject, date, text, html}`,
inline images as data: URLs) and, after the capture, its HTML is rendered in a clean browser — JavaScript off,
offline, a CSP blocking scripts and remote loads — at 600 px layout width, full height, 2× (`<as>.png`).

**`download: {click, as, timeout?}`** clicks the target for real (the cursor travels and clicks) and captures what the
click produces: the browser's download event, or a document opened in a new tab — fetched with the page's request
context (the session's cookies), the tab then closed so the recording stays on the page. The file lands in
`artefacts/documents/<as>.<ext>` (type sniffed from its bytes, else the server's type, else its name); a PDF is
rasterised after the capture with **pdf.js inside Chromium** (no system tool), page by page, at 2× (an A4 page →
1587 × 2245 px) into `artefacts/documents/<as>/page-<n>.png`. A project file works as a document too: a slot
`document: assets/terms.pdf` (PDF, PNG or JPEG) is rasterised by the run that names it.

**Web notifications.** The runner grants the notification permission and the in-page kit reports every
`new Notification(…)` and `ServiceWorkerRegistration#showNotification(…)` called by a page (the page's call goes on
unchanged): title, body, tag, icon (fetched with the session and rendered to a 192 px PNG) and time become
`artefacts/notifications/<name>.json` — `<name>` is the notification's `tag` (else `notification-<n>`) — and a timeline
event `{action: notification, step: -1, data: {name, index, title, body, …}}` in the scene running at that moment.
Notifications a service worker shows on its own (push events) are not seen.

**Artefacts in the timeline.** `timeline.json` lists them under `artefacts` (`kind`, `name`, capture time `t`, scene,
step, file, and per kind: email `from`, `to`, `subject`, `date`, `preview`, `image`; document `mime`, `file_name`, `via`
download | tab | project, `url`, `bytes`, `pages` with their size in points; notification `index`, `title`, `body`,
`tag`, `icon`, `origin`, `via`, `time`), so the editor never reads the artefact files.

**Using them in the edit.** Slots of type `email`, `document` and `notification` name an artefact; the planner hands
the component the captured data as `props.media[<slot>]` (images served like every asset) and scenario values still
win over captured ones:

```yaml
steps:
  - click: {text: Create account}
  - wait_for_email: {to: noa@cafe-lumen.example, subject: Confirm, as: welcome}
    overlay: {component: studio/mail-notification, slots: {email: welcome}, duration: 4.5}
  - download: {click: {text: Download quote PDF}, as: quote}
  - hold: 3
    overlay: {component: studio/notification, slots: {notification: quote-request}, params: {style: macos}}
…
- card: {component: studio/mail-view, slots: {email: welcome}, transition: studio/transition-tap-open}
- card: {component: studio/document-pdf, slots: {document: quote, title: "A real PDF"}, params: {motion: zoom}}
- card: {component: studio/document-pdf, slots: {document: assets/terms.pdf}}
```

`notification:` takes a name (the tag) or a 1-based index. Validation checks every `email:` against the scenario's
`wait_for_email` names and every `document:` against its `download` names or the project files (with a suggestion);
the planner warns when the run did not capture a name. An overlay with a `notification` slot starts when that
notification showed (when it is inside the clip), not at the end of its step. An overlay the clip's end cuts short
stays on screen to the last frame (no exit animation), so a **tap-open** transition can open from it.

**Components** (built-in, theme-driven, with committed previews):

| id | kind | what it draws (main params) |
|---|---|---|
| `studio/notification` | overlay | a system notification — `style: macos \| windows \| ios-banner \| android \| in-app` (the last in the theme's own look) — with icon, app, title, body, time; macOS / Windows in the frame corner, the others over the capture (`place: auto \| frame \| screen`), `appearance: auto \| light \| dark`; slides / rises / drops in like the real one. Slots `notification` (captured), `app`, `title`, `body`, `time`, `icon` |
| `studio/mail-notification` | overlay | the same styles fed by an email: sender, subject, first line, a mail glyph on the accent. Slots `email`, `from`, `subject`, `preview`, `app`, `time`, `icon` |
| `studio/mail-view` | card | a mail client window (toolbar, inbox column with the message selected, header with the sender's initials, date) over the rendered email, shown from its top (`scroll: none`, the default since L5.5; `auto` scrolls a tall one slowly), `width`, `sidebar`). Slots `email`, `from`, `address`, `subject`, `date`, `body`, `mailbox` |
| `studio/document-pdf` | card | A4 page(s) with a paper shadow on the theme background — `motion: zoom` (slow push-in to `focus`), `scroll` (pages scroll by) or `static` (a page, or two side by side); `pages: auto \| 2 \| 1-3 \| 1,3 \| all`. Slots `document`, `kicker`, `title` (a column beside the page) |
| `studio/phone-lockscreen` | card | a phone (wallpaper from the theme), date and big time, notifications arriving one by one — newest on top, grouped by app; `notifications: [{app, title, body, time?, icon?}]`, `time`, `date`, `start`, `interval`, `layout: center \| left`. Slots `email`, `notification` (arrive last), `kicker`, `title` |
| `studio/phone-home-badge` | card | a phone home screen whose app icon gets a badge counting up (`from`, `to`, `interval`, `row`, `col`, `badge: system \| accent`). Slots `app`, `icon`, `kicker`, `title` |
| `studio/transition-tap-open` | transition | a touch on the outgoing tap target, then the next segment zooms out of it to the full frame (`duration` 0.8 s, `radius`, `touch`) |

**Tap targets.** A component may declare where its tap target is at the end of its segment — manifest `anchor` (and
`anchor_vertical` / `anchor_square`), `{vars?, x, y, w, h}` in design px, each value an expression over its numeric
params, its string params as one-hot names (`style_ios_banner` is 1 when `style` is `ios-banner`), `frame_w` /
`frame_h` (the format), `screen_x/y/w/h` (the clip's capture rect, for overlays) and `aspect`. The planner evaluates the
outgoing segment's anchor — or that of an overlay still showing at the end of the outgoing clip — and hands it to the
transition (`PlanTransition.anchor`, `props.anchor`): the lock screen's newest notification, the home screen's app icon,
a notification banner. Without one, `studio/transition-tap-open` opens from the centre.

## Tutorial overlays and story cards

**Tutorial overlays** are drawn automatically from the timeline — no extra step in the scenario, just switches:

```yaml
tutorial: {shortcuts: true, spotlight: steps, steps: true, loupe: true, progress: scenes}   # scenario (or `true`: all on)
scenes:
  - id: signup
    tutorial: {loupe: false}             # a scene overrides the scenario's switches (`false`: none in this scene)
    steps:
      - type: {into: {label: Café name}, text: Café Lumen}
      - press: Tab                       # key caps ⇥, timed on the real key press
      - type: {text: Noa Brandt}         # the loupe and the spotlight follow the focused field
      - click: {text: Create account}
        tutorial: {spotlight: false}     # a step overrides both (most specific wins)
```

| Switch | Component | What it draws |
|---|---|---|
| `shortcuts` | `studio/overlay-shortcut` | key caps of every `press` step (and the Enter of `type: {enter: true}`) at the bottom of the capture (above a caption band drawn over it — the overlays receive it as `avoid`; in the top row when the bottom one would cover the current or next click target), going down on the **real key press** (the planner starts the overlay 0.3 s before it and hands the press frame as `moment`); macOS symbols ⌘ ⌥ ⇧ ⌃ ↩ ⇥ drawn as line glyphs, or `params: {platform: windows \| linux}` → Ctrl / Alt / Shift words; `press: {times: 3}` → a "× 3" chip |
| `spotlight` | `studio/overlay-spotlight` | dims the capture (theme night tone) except a soft rounded cut-out around the step's target, mapped through layout, camera and reframe; `steps` (= `true`): every step with a target (click, type, select, pick, menu, date, hover, drag, drop_file, download) over the step — a click ends it soon after the click, one overlay per run of steps whose cut-out **glides** from target to target (a click that takes the page to another URL ends the run: the next step's spotlight comes in on the new page); `clicks`: around each click only. Drawn under the caption and the other overlays |
| `steps` | `studio/overlay-steps` | numbered badges (1, 2, 3… per scene, `params: {numbering: video}` across the video) beside each clicked target, never over it nor over the next click target (left, above, right or below, inside the capture), popping as the cursor arrives, a ring pulsing at the click, ~1 s after it |
| `loupe` | `studio/overlay-loupe` | during `type` steps, a magnified **live** view of the field — the capture region around it rendered again at the capture's own resolution (crisp), at least 1.5 design px per CSS px so it reads in vertical / square — beside the field with a pointer (clear of a caption band over the screen and of the key caps' row; a lens gliding over several fields keeps one side of them); consecutive fields (type, Tab, type) are one lens moving from field to field — it cross-fades the two fields instead of panning over what lies between them. A `type` without `into` uses the focused field the runner measured |
| `progress` | `studio/overlay-progress` | a thin chapter bar across the top of the frame over everything between the intro and the outro; `scenes` (= `true`): every scene and card is a chapter, `cards`: each card opens one; the current chapter fills in the accent (`params: {position: bottom, labels: true}`). Scenario level only |

Each switch is `true`, `false`, a mode (`spotlight: clicks`, `progress: cards`) or `{component?, params?}` (another
overlay component, params of the built-in one — `spotlight: {on: clicks, params: {dim: 0.6}}`). The runner copies the
switches into the timeline (`video.tutorial`, `scene.tutorial`, `event.tutorial`); at render time `--tutorial` turns
every overlay on over the scenario's switches and `--no-tutorial` removes them (`overrides.tutorial`), and
`overrides.components["tutorial-shortcuts" | "tutorial-spotlight" | …]` swaps one component. What cannot be shown — a
spotlight or a badge on a step whose target box was not recorded, a loupe without a field — is a plan warning and a
`tutorial-skipped` review warning; a target the zoom or the reframe cuts is `tutorial-target-cut`; a spotlight or a
badge still on its target more than 0.6 s after its page went to another URL is `tutorial-stale-target` (a badge
leaves with the page after a click that navigates). Key caps, badges
and the loupe keep clear of the current step's target and of the next click targets (the planner hands their output
boxes in `avoid`, `kind: target`); when one still covers a click target of the current or next step, the review says
`overlay-covers-target`. In a multi-page scene each overlay belongs to the pane of its event's page.

**Story cards** tell the product's story between the scenes (cards take no capture time):

```yaml
- id: proposal
  steps:
    - capture_text: {target: {testid: proposal-total}, as: total, pattern: "/(€\\s?[\\d.,]+)/"}
      mark: proposal-open
- card: {component: studio/card-figure, slots: {capture: total, kicker: Accepted proposal, label: for 10 kg, delivered}}
- card: {component: studio/card-before-after, slots: {before: start:quotes, after: proposal-open, title: One click}}
- card:
    component: studio/card-features
    slots: {kicker: Why cafés switch, title: Everything a quote needs}
    params: {items: [{title: Prices for every bag size, icon: tag}, {title: Proposals in hours, icon: bell}, {title: One PDF, icon: document}]}
- card: {component: studio/card-chart, slots: {title: Quote requests per month, data: data/quotes-per-month.csv}, params: {y: quote requests}}
- card: {component: studio/card-testimonial, slots: {quote: "…", name: Ilse Varnström, role: Head barista, company: Café Tallmora, logo: assets/logo.svg}}
- card: {component: studio/card-cta, slots: {title: Open your account today, button: Create an account, url: shop.example.com/signup}}
```

| id | what it draws (main slots / params) |
|---|---|
| `studio/card-figure` | kicker, a big **counter** in the display font counting up (`from`, `count` seconds) to the value written as given — `€720.00`, `1 240 bags`, `12,5 %`: prefix, suffix, separators, decimals kept, tabular digits —, accent rule, label, text. Value: slot `value`, or `capture` (a `capture_text` artefact; the captured value wins) |
| `studio/card-features` | kicker, title and rule beside (above, in vertical / square) 3–5 items appearing one by one (`stagger`): an icon of the kit's built-in set (`check`, `bolt`, `clock`, `chart`, `trend`, `shield`, `globe`, `users`, `truck`, `receipt`, `bell`, `star`, `sparkles`, `lock`, `heart`, `leaf`, `cup`, `mail`, `search`, `calendar`, `cart`, `document`, `sliders`, `link`, `phone`, `tag`) or the item's number, title and text — `params.items: [{title, text?, icon?}]` |
| `studio/card-before-after` | two pictures in one card, the after wiping over the before behind a divider with a handle (`wipe_at`, `wipe`, `direction`, `end_at`), labels (`before_label`, `after_label`). Slots `before` / `after` of type **frame**: `<mark>` or `mark:<mark>` (the screen once the marked step is done: within its hold, else just after it), `start:<scene>` / `end:<scene>`, a capture time `12.5s`, or an image file of the project |
| `studio/card-testimonial` | a large quotation mark, the quote in the display font (balanced, ≤ 4 lines), rule, avatar (`avatar` image, else the initials), name, role · company, `logo` image |
| `studio/card-cta` | kicker, title, text, an accent **button**, the `url` under it and a **QR code** of the url (or of `qr`; `https://` added when there is no scheme) generated locally by the kit's encoder (byte mode, versions 1–40, `qr_level` L/M/Q/H, tested module for module against the `qrcode` package): dark modules on white whatever the theme, so phones read it |
| `studio/card-chart` | an animated **bar** or **line** chart (`type`) from inline `params.data: [{label, value}]` or a CSV / TSV file of the project (slot `data`; `x` / `y` name the columns, default the first and the first numeric one), the highlighted category in the accent (`highlight`, default the last), values formatted with `prefix`, `suffix`, `decimals`, the last `max_points`; a `note` line |

All are theme-driven (paper or night `tone`), in the family of the title card, sized for landscape, vertical and
square, with committed previews. Slot types behind them: `capture` (a `capture_text` `as`), `frame`, `data`, and
`image` slots that name an image file of the project (served as a plan asset). Validation checks every `capture:`
against the scenario's `capture_text` names, `before:` / `after:` frames against its marks, scenes and files, `data:`
and image files against the project; the run records texts as `artefacts/texts/<as>.json` and in `timeline.artefacts`
(`kind: text`, `value`, `text`, `target`, `bbox`); the renderer reads the project files a plan needs (CSV text, image
sizes — `planInputFiles`) and the planner turns them into `props.media` (`TextMedia`, `PictureMedia` — a capture frame
is the capture video frozen at its time —, `TableMedia`). A name the run did not capture is a plan warning and a
`media-missing` review warning.

## Several pages at once

A scene can film **two pages at the same time** — the buyer's shop and the supplier's console, the same account on a
desktop and on a phone — on one clock, each page with its own recording, viewport and cursor. The video shows them
side by side (`studio/layout-split`) or one over the other (`studio/layout-pip`), both playing from the same source
time: an action on one page is visible on the other as it happens.

```yaml
frame: split                                   # or pip; a single-pane frame picks split / pip from the pages' shapes
scenes:
  - id: request
    pages:                                     # a map: page id → where it opens and how it is filmed
      buyer: {open: "shop:/products/selowa-ridge", viewport: laptop, label: Café · shop}
      supplier: {open: "console:/quotes", viewport: laptop, label: Roaster · console}
    steps:
      - click: {role: button, name: Request a quote}   # acts on the first page (buyer)…
      - on: supplier                                   # …unless the step says which one
        wait_for: {text: New}
  - id: proposal
    pages: [buyer, supplier]                   # a list: the pages of an earlier scene go on (same viewport, label)
    steps:
      - on: supplier
        click: {text: Send proposal, in: {row: New}}

# Lists can also declare pages: the same environment page twice, one of them on a phone.
pages:
  - {id: desk, page: shop, open: /quotes, label: Desktop}
  - {id: phone, page: shop, open: /products/selowa-ridge, viewport: mobile, label: Phone}
```

| Key | Where | Value |
|---|---|---|
| `pages` | scene | a map `id → {page?, open?, viewport?, label?, cursor?}` (`null`: an earlier declaration as it was) or a list of ids (pages an earlier scene declared, else environment pages) and `{id?, page?, open?, viewport?, label?, cursor?}`. Two pages per scene |
| `page` | page | the environment page it starts from (`environments.<env>.<page>`); default the id, or the `x:` of `open: "x:/path"` |
| `open` | page | `"/path"` (on `page`), `"<env page>:/path"` or an absolute URL; omitted for a page an earlier scene already opened |
| `viewport` | page | `desktop` (the capture size, the default), `laptop` 1440×900, `tablet` 820×1180 (mobile, touch), `mobile` 390×844 (mobile, touch, mobile user agent), or `{width, height, mobile?, touch?}`; a page keeps one viewport for the whole run |
| `label` | page | shown above its pane by `studio/layout-split` |
| `cursor` | page | that page's scene-start cursor (as a scene's `cursor`) |
| `persona` | page | the account it is signed in as (default: the persona whose `pages` list its environment page; `none`: none) — one browser per persona, so the supplier and the buyer of one site film side by side ([Signing in](#signing-in-personas-and-sessions)); a page keeps one persona for the whole run |
| `on` | step | the page the step acts on (default the scene's first page); only inside a multi-page scene |

Validation is positioned (line:column): unknown page ids (with a suggestion), `on:` outside a multi-page scene or
naming a page the scene does not film, a scene with `page` / `open` and `pages`, more or fewer than two pages,
duplicate ids, unknown viewport presets, `new_tab` / `switch_page` inside a multi-page scene, a page id asked at
another viewport than the one it was first filmed at, and a single-page scene that would film a page whose viewport is
not the capture size (its `page`, a `switch_page` / `open` to it, or — without `page` — the first page of the
multi-page scene before it); a page filmed for the first time without `open` is a warning.

**Capture.** The runner opens every page of the scene, emulates its viewport (Chrome DevTools device metrics, touch
and a mobile user agent for `mobile` / `tablet`) and records **one screencast per page**, all on the run's clock; each
is encoded on the shared constant-frame-rate grid as `capture-<page>.mp4` (`frames-<page>/`, `frames-<page>.jsonl`) —
same frame count as `capture.mp4`, so one source frame index addresses every track. A page records only while a scene
films it (it holds its last frame otherwise); single-page scenes record `capture.mp4` exactly as before. Each page has
its **own in-page cursor**: only the acting page's moves; when a step acts on the other page, the runner pauses
`pacing.page_switch_ms` (the eye moves) and that page's cursor glides from where it rests — no cursor ever jumps. A
page with no step of its own in a scene rests its cursor near its centre (a PiP inset sits in a corner: a cursor
resting there would come out from under it). A relative `open` step on a page id resolves against the environment
page that id was declared on, base path included, like the page's own `open`. The
timeline lists the scene's pages (`scenes[].pages`: id, environment page, label, viewport, URL, track), one track per
page (`tracks[]`: file, size, viewport, recorded spans, URL segments, its cursor samples) and tags every event and
marker with its `page`. A single-page scene after a multi-page one continues on its first page (a page with a phone
viewport cannot be filmed by a single-page scene).

**Layouts.**

| id | what it draws (params) |
|---|---|
| `studio/layout-split` | the two pages side by side — stacked top / bottom in vertical, narrow side by side in square (a page wider than its pane is reframed around what it acts on) — each in a rounded card with the reference shadow, or a compact browser window with the page's display URL (`chrome`, on for themes whose layout is a browser window); each page's label above it, the acting page's in the accent colour; the caption below the pair. `margin`, `gap`, `radius`, `shadow`, `chrome`, `labels`, `emphasis: auto \| none \| dim` (auto: the idle page dims a little for balanced / motion themes) |
| `studio/layout-pip` | the main page in a card (or browser window), the other page floating over one of its corners — inside a phone drawn in CSS when it is a mobile page, else a smaller card. The planner picks the corner so the inset **never covers what the main page acts on now or next** (it glides to another corner, at most every 1.2 s, never while its own page acts: a corner the next main-page step needs is reached once the inset's step is over), and keeps it clear of a caption band over the screen; with `emphasis: auto \| grow` (auto: balanced / motion themes) the inset grows ×1.18 while its page acts — less, or not at all, when growing would reach a caption band over the screen (a plan note says so). `width`, `radius`, `shadow`, `chrome`, `inset_height`, `inset_width`, `margin` |

The main page of a PiP is the landscape one (the first page when both are). A scene filmed on two pages with a
single-pane frame (`card`, `browser`…) gets split when the pages have the same shape, else PiP (a plan note says so);
`split` / `pip` asked for single-page scenes falls back to the theme's layout. Each pane has its own camera (the theme's
zoom and the steps' zooms, on their page), reframe and URL; captions, cards, intro and outro are unchanged — except
that a caption band drawn over the screen (`studio/caption-overlay`, `position: over`) goes to the layout's caption
area below a split, where it does not straddle both pages (a plan note says so); the tutorial overlays sit on the pane
of their event's page (an inset's spotlight and step badges stay inside the inset; its key caps and lens, too large
for it, use the main page's room and keep clear of the main page's current and next targets too), the step badges of
a scene are numbered in time order over both pages, and the main page's overlays pass under a PiP inset (clipped
around it). The acting page (label accent, dimmed idle page, grown inset) is the page of the scene's opening still from
the clip's start — a clip joined to the previous one eases from that clip's acting page.
Layout geometry for multi-page layouts declares `panes:` (two rects) or `inset:` beside `screen`, with `aspect2` (the
second page's aspect) next to `aspect` in the expressions — see `packages/components/library/studio/layout-*/component.yaml`.
Contiguous multi-page scenes with the same pages are joined like same-page scenes (the camera and the inset go on).

**Review.** Clicks are placed on their page's pane; the cursor, reframe and tutorial checks run per pane; the still
and freeze comparisons read each page's own track; `overlay-covers-target` warns when key caps, a badge, the loupe or
the PiP inset (bezel included) covers a click target of the current or next step.

The fixture shows both: `projects/northfield-fixture/scenarios/live-quote.yaml` (the café's shop sends a quote request,
the roaster's console — a live list polling every second — shows it arrive, the roaster sends a proposal, the café's
bell — the shop polls its notifications every second — rings with it a second later; `split`) and `phone-and-desktop.yaml` (the request sent from a phone shows up in the desktop's quote list;
`pip`).

## Editing: the edit plan

The editor turns a run (`capture.mp4` + `timeline.json`) into a video in two steps: `planEdit` (package
`@demo-studio/editor`) computes an **EditPlan** — a pure, deterministic description of every output frame — and the
render pipeline (L2.4) only draws that plan with Remotion. The plan is also what the review, the Studio timeline and
frame comments read. It never re-reads the scenario: the timeline carries the edit info (`video`, scene captions,
speeds, step `camera` / `overlay` / `mark` / `hold`).

What the planner decides (SPEC §9, `docs/DESIGN-phase2.md` §2.1):

- **Segments**: intro (unless the scenario says `intro: false`) → scenes, cards and interstitials in scenario order →
  outro. Every segment carries its component, chosen by precedence: `overrides.components[<segment id>]` →
  `overrides.components[<kind>]` → the scenario → the theme → the built-in default, with its slots filled (scenario
  title and outro, theme brand and logo, scene captions, interstitial text, card slots). A component that does not
  resolve is reported and the next candidate is used; when none resolves the use is marked `missing` and the
  renderer draws a stand-in.
- **Clips** show a scene from the end of its page load (`scene_still` start, else `scene_open` end) to its end,
  trailing holds included: page loads are never shown. `srcFrames` gives the exact capture frame of every output
  frame. A scene played with `offscreen: true` has no clip (noted).
- **Off camera** (L5.8): a `hook:` step's span — the hook running, before its `hold` — is cut whole, whatever
  `overrides.trim_idle` says, a mark window included (noted with the step).
- **Transitions**: scenes that are not contiguous in the capture (a page load or any gap), cards, interstitials, the
  intro and the outro are joined with the theme transition (crossfade: the outgoing clip holds its last frame while
  the incoming one fades in; fade-black: fade out then in; cut). A scene that continues the previous one on the same
  page is joined with **no** transition: only the caption changes and the camera continues. Interstitials are drawn
  over the last frame of the previous clip.
- **Speed**: the scene `speed` (`overrides.speeds` wins), a step `speed` for its own span; always 1× during the
  opening still, every hold (`hold` steps and the `hold` modifier) and ±0.6 s around a `mark` step through its hold
  (a marked `wait_for` / `wait_for_email`: around the moment its state appears, not the waiting). Speed changes are
  ramped over 0.3 s of output, inside the unprotected side.
- **Waiting**: the time a `wait_for` / `wait_for_email` step waits — and the pause after a page change before a wait
  that really waited (the page was loading) — is a loading state: its first 0.5 s plays at 1×, the rest at up to 4×
  (a step `speed` wins; `overrides.trim_idle: false` keeps it at 1× — and a marked wait step's whole span at 1× again). A slow back end never shows as a long frozen
  spinner; the plan notes each span.
- **Page loads**: a full page load the capture held (`timeline.loading`: the previous picture frozen from the new
  document's commit until it painted) is cut whole when it lasts 0.15 s or more — also inside a mark window or a hold
  (a frozen frame is never what they show); the cut sits on the page change, the plan notes each one. In a multi-page
  clip only where no other page acts (a step through its hold, a mark window, the opening still): the other pages'
  actions are never cut. `overrides.trim_idle: false` keeps them. The waiting after such a load counts from its end
  (the painted page).
  Since L1.2 the time a page took to paint is in the step that navigated (held, then cut), no longer in the
  `wait_for` after it: that wait is sped up only for what the page shows once painted.
- **Idle trims**: the part of a `timeline.idle` gap outside those protected spans and held page loads, when longer
  than 1.2 s (`idle_threshold`), is cut down to 0.4 s (0.2 s on each side of an invisible cut — nothing changes on
  screen).
- **Freezes and waits** (L5.7): a freeze of the capture while the cursor moved or a click ripple played
  (`timeline.stalls`: the dialog-close freeze of the frame-rate limiter, a loaded machine) is cut whole but its first
  frame, like a held load; a wait the screen showed after a click (`timeline.busy`: near-identical frames — a
  skeleton, a spinner, a blank panel — until the content appeared) keeps its first 0.3 s and the 0.1 s before the
  content, outside protected spans. The plan notes each one; `overrides.trim_idle: false` keeps them.
- **Camera**: static unless a step has a `camera` hint, or the theme has a **default zoom** (below). The zoom is clamped to the theme `max_zoom` (noted), focused on
  the target box measured at the end of the step (else the hint's point, else the cursor), eased with the hint's
  `ease` (else the theme `zoom_ease`) over `max(0.8 s, duration)` of output time — `duration` defaults to the step's
  own length, so a zoom lands when its step ends — held until `step_end`, `scene_end` (default) or N seconds, then
  eased out the same way. The view is clamped so the capture always fills its rect; at a same-page join the zoom
  carries on into the next scene instead of resetting. **Theme default zoom** (`motion.default_zoom`, R-ED-22): only
  with `style_bias: balanced` or `motion` — at most one very slow zoom per scene, on the target of the scene's first
  marked step (`mark:`), eased in over up to 4 s from that step and back out to the full view so that the scene's last
  frame is at 1× (never across a cut or a same-page join); a scene with its own `camera` hint keeps it, a scene with
  too little room after its mark gets none (a note says so). `style_bias: real` keeps a static camera (the starter
  `motion` theme sets `default_zoom: 1.12`).
- **Captions**: the scene caption from the clip's first visible frame; a step caption replaces it from that step's
  output start; cues never overlap. **Overlays** (step `overlay`) start when their step ends, last their `duration`
  (else the component's), and keep their anchor in capture pixels; `mapSourceRect` maps it through the layout and the
  camera of any frame.
- **Layout and size**: the layout component's `geometry` (scaled by `unit`, the capture fitted to its aspect ratio);
  1920×1080 × scale (a scale-2 capture gives 4K; a larger scale than the capture's is a warning: the capture is
  upscaled); the vertical (1080×1920) and square (1080×1080) variants use `geometry_vertical` / `geometry_square` and
  **reframe** the capture (see [Variants](#variants-4k-music-and-export)). Music comes from the scenario `music`
  (volume, ducking, loop).
- **Provenance**: each clip lists which step produced which output frames, its speeds, trims and zooms; the plan keeps
  the markers and an output → capture time map. Every decision worth knowing (cut page loads, joins, trims, clamped
  zooms, missing components…) is in `notes` / `warnings`.

`EditOverrides` change the edit without touching the scenario: `frame`, `variant`, `fps`, `scale`, `intro`, `outro`,
`captions`, `trim_idle`, `idle_threshold`, `speeds`, `transition`, `transition_duration`, `camera`, `components` (by
kind or segment id), `theme` (the caller loads that template) and `music` (a file, or `false`). `variant` is
`landscape`, `vertical` or `square`.

`studio plan` prints the plan of a run (`latest` = the newest capture run, of `--scenario` when given) and writes its
JSON with `--out` (or prints it with `--json`); `--theme`, `--frame`, `--vertical` and `--square` try another theme,
frame or the 9:16 / 1:1 variant:

```
$ studio plan northfield-fixture latest --scenario catalogue
catalogue (run 20261011-182524-catalogue) — landscape 1920×1080 @ 30 fps — 59.00 s (1770 frames) — theme editorial — frame card

Segments
      from    length  segment       kind          transition in     component
    0.00 s    3.20 s  intro         intro         —                 studio/intro-stack (theme)
                      title: "Manage your catalogue", kicker: "For suppliers"
    2.83 s   15.17 s  import        clip          crossfade 0.37 s  studio/layout-card (theme)
                      source 1.03–15.83 s of the capture → 14.80 s + 0.37 s held
                      speed 1× 14.80 s (1× kept 6.41 s: still, holds, marks)
   17.63 s   20.33 s  availability  clip          crossfade 0.37 s  studio/layout-card (theme)
                      source 16.80–46.37 s of the capture → 19.97 s + 0.37 s held
                      speed 1× 3.60 s, 1.6× 15.74 s (1× kept 3.60 s: still, holds, marks), 2 ramps
   37.60 s   18.77 s  add-product   clip          crossfade 0.37 s  studio/layout-card (theme)
                      zoom 1.3× step 5: from 12.70 s over 2.23 s on (409, 635) → view (738, 635), held to the end of the clip
   …
```

A component that resolves nowhere is marked `MISSING` in the summary (the warnings list its uses) and rendered with
the scaffold of its kind as a stand-in.

## Rendering

`studio render <project> <scenario>` plans the latest capture of a scenario (or `--run <id|dir|latest>`) and renders
the plan with [Remotion](https://www.remotion.dev):

```
$ studio render northfield-fixture catalogue
✓ rendered catalogue-v1 → projects/northfield-fixture/renders/catalogue-v1.mp4
  59.00 s · 1770 frames @ 30 fps · 1920×1080 · 8.5 MB · h264 crf 16, silent audio · checked: 59.01 s, 1920×1080, 1 audio track
  theme editorial · run 20261011-182524-catalogue · bundle built in 9.9 s · render 3 m 27 s (concurrency 3) · total 3 m 38 s
  record projects/northfield-fixture/renders/catalogue-v1.json
```

- **Outputs**: `renders/<scenario>-v<N>.mp4` (`-v<N>-vertical.mp4` / `-v<N>-square.mp4` for `--vertical` /
  `--square`) and its **RenderRecord**
  `renders/<scenario>-v<N>.json`: id, project, scenario, run id and directory, theme, overrides, variant, status,
  duration, frames, fps, size, file size, encoding, what ffprobe saw in the file, bundle hash, browser, timings,
  warnings and the whole plan. N is the next free version of the scenario (both variants share the counter); `--out`
  writes elsewhere. The video is encoded under a temporary name and renamed when complete: a failed or cancelled
  render (Ctrl-C, or an `AbortSignal` through the API) leaves nothing under the final names.
- **Encoding**: H.264 CRF 16, `yuv420p` limited-range BT.709 (tagged), `+faststart` (moov first), and always an audio
  track: AAC silence when there is no music (checked with ffprobe after the render, added with ffmpeg if ever missing).
- **Options**: `--theme` (another template, the scenario untouched), `--frame` (frame style or layout component id for
  every scene), `--vertical` (1080×1920) or `--square` (1080×1080), `--scale` (output size × the variant's size),
  `--music <file>` / `--no-music` (replace or drop the scenario's music bed), `--tutorial` / `--no-tutorial` (every
  tutorial overlay on over the scenario's switches, or none), `--no-intro`, `--no-outro`,
  `--concurrency` (frames rendered in parallel; default ¾ of the CPUs, 1–8), `--json` (the record without the plan).
- **Stills**: `studio still <project> <scenario> --frame <n>` renders output frame n of the planned video as a PNG
  (default `renders/stills/<scenario>-f<n>.png`) — the quick way to look at one moment of an edit.
- **Review**: `--review` reviews the render right after it (see [Reviewing a render](#reviewing-a-render)); with
  `--json` the review result is added to the record under `review`.
- **Edit without re-capture (L5.5).** A render takes the capture from the run and the edit from today's scenario file,
  as long as the **filmed part** of the scenario is unchanged since the capture. Filmed: `env`, the `setup` /
  `teardown` hooks, `capture`, `pacing`, `clock`, `mocks`, the vars a filmed part uses, the capture scenes (ids,
  order, `skip`), each scene's `page`, `open`, `pages` (labels left out), `persona`, `still`, `cursor`, and each
  step's action and arguments with `hold`, `park` and `on`. Everything else is edit and renders on the same take:
  title, intro / outro, frame, template, music, tutorial switches, `target_length`; cards and interstitials (text,
  duration, place between the scenes); a scene's caption, speed, transition, frame, tutorial and page labels; a step's
  caption, speed, camera, mark, overlay, tutorial and id (`timeout`, `optional` and `irreversible` change nothing a
  take filmed). The capture times, the cursor, the target boxes and the captured mails and documents stay the take's:
  an overlay or a zoom added since anchors to its step's target box (else the cursor at the end of the step); one that
  names an element the take never measured falls back to the step's target with a plan warning. A changed text with
  a token only the take knew (`{{hooks.…}}`) keeps the captured text, with a warning. The plan notes say `edit
  re-planned from today's scenario … (changed: caption of open.0, cards and interstitials, …)`.
- **A change to the filmed part needs a new capture.** When it changed since the run, the render shows that run as
  captured, its edit included, and `studio render` and `studio plan` warn first (`! the filmed part of scenario quote
  changed since run … was captured (scene send: step send.2 changed; the setup hooks): …`, naming the `studio run`
  that films it); through MCP, `plan_preview` and `render` say the same with `scenario_changed: true` and
  `filmed_changes`, and `plan_preview`'s last line then says to capture first (never "render it" on the old run); an
  edit-only change says `edit: "scenario"` with `edit_changes`. The files are compared by their data: a comment, blank
  lines, quoting, indentation or key order is no change; a link, a non-regular file or one over 2 MB is not compared;
  a run without its snapshot, or a file that does not validate, renders as captured. A render records where its edit
  came from (`edit` in `renders/<id>.json`); a queued render job and an export that re-renders a master refuse a
  scenario file changed since they were planned (submit again). Project-level changes (project.yaml environments or
  vars) are not compared.

How it works (`@demo-studio/editor`, `docs/DESIGN-phase2.md` §2.2):

- **Compositions** `DemoVideo` (landscape), `DemoVertical` and `DemoSquare` take `{ plan }` and draw only the plan: the theme
  background; one `Sequence` per segment with its transition component (rendered around the end of the outgoing
  segment and the start of the incoming one: a crossfade overlaps them, a dip splits its frames) or its plain fade
  envelope; the segment's component with its slots and params; for clips, the layout component whose `screen` is the
  capture — the plan's source frame of every output frame (`OffthreadVideo` shifted by a `Sequence` to that frame:
  `Freeze` cannot be used because Remotion clamps a frozen position to the composition's length, which would show the
  wrong frame for captures longer than the edit), letterboxed to its aspect ratio and moved by the per-frame camera
  (zoom + centre mapped into the layout's screen rect) —, the caption component with the clip's cues in the layout's
  caption area, the overlays placed from their capture-pixel anchor through layout and camera, the brand mark in the
  layout's `brandmark` rect (layouts never draw it), and the music bed (its planned plays: loops with crossfaded
  seams, or one trimmed play; fades; ducked under clips). Interstitials get
  the previous clip's last frame (layout, capture, brand mark) as their `screen`. Theme fonts are registered with
  `FontFace` before anything is drawn (text fitting measures with the real fonts). A component the plan marks
  `missing` is drawn by the scaffold of its kind.
- **Generated registry module**: each render bundles a generated entry and registry module that import the
  implementation of every component the plan uses — built-in or from your workspace `components/` — plus the
  scaffolds, so your own components are bundled exactly like the built-in ones.
- **Bundle cache**: `<workspace>/.demo-studio/cache/remotion-<hash>/` (git-ignored), the hash covering the composition
  sources, the kit, every bundled component folder and the Remotion version; a render rebuilds the bundle (≈ 10 s)
  only when one of them changed, and the six most recently used bundles are kept.
- **Assets**: the capture, fonts, logo, wordmark and music (`ds-asset:` URLs in the plan) are served by a local HTTP
  server on 127.0.0.1 (random port, random path token, Range requests, CORS) for the duration of the render.
- **Browser**: `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL`, else Playwright's Chromium headless shell (found through
  playwright-core's browser registry: `playwright-core install chromium-headless-shell`), else Remotion's own.
- **API**: `renderVideo({project, run, scenario?, template?, overrides?, out?, onProgress?, signal?, concurrency?})`
  → `RenderRecord` (progress stages `planning`, `bundling`, `rendering`, `encoding`, `done`); `renderStill({plan,
  frame, out})` → the PNG path; `renderStills({plan, frames: [{frame, out}…]})` renders several frames in one
  browser session (≈ 0.3–0.6 s per extra frame); `listRenders(project)` → the records of `renders/`;
  `renderPlan({plan, out})` renders any plan.

Render times on the 4-CPU Linux container (no GPU, concurrency 3): ≈ 3–3.5 minutes for a 1-minute 1080p video
(≈ 8–9 output frames per second); a still takes 1–2 s once the bundle is cached.

## Variants, 4K, music and export

**Vertical 9:16 and square 1:1** (`--vertical`, `--square`, `overrides.variant`): the same run, theme and scenario,
re-planned for a 1080×1920 or 1080×1080 frame (× `--scale`). Each layout declares its geometry for the format
(`geometry_vertical`, `geometry_square`): the card and the browser window are as tall as the format allows (4:5 in
vertical, ≈ 4:3 in square) and a wider capture is **reframed** — the screen rect shows the region of the capture with
its aspect (narrowed so the page shows at ≥ 0.9 design px per CSS px: readable on a phone) and that region follows the
action; device mockups (laptop, phone, tablet) keep the whole capture. Captions wrap to two lines (three in a narrow
column beside a phone); intros, outros, cards and interstitials use larger type (×1.2 in vertical) and narrower margins.
The reframe track (`ClipSegment.reframe`, `camera.ts reframeTrack`):

- **what must be seen**: the cursor (its arrow and ripple), where it goes in the next 0.4 s, the active step's target
  from 0.5 s before the step starts (look-ahead), every click's target around the click (widgets: each click of a
  select or a date pick) and overlay anchors while the overlay shows — their union while it fits, else the clicked
  target and the cursor; a target wider than the view (a whole table row) counts by its **leading part** (where its
  text starts: the row's id and label), as much of it as fits with the cursor;
- **no jitter**: the target centre only moves when that region leaves the view inset by 15 % (dead zone), then
  re-centres — except for a cursor resting alone once its step is over (a closing hold), which is only brought back
  inside; a run starts framed on its first step's region as far toward the page's top-left (its heading) as that
  region allows, and the idle page of a multi-page scene settles the same way at the start of a scene where it only
  rests;
- **critically damped smoothing** (two first-order lags forward and backward: no lag, no overshoot, moves start a
  little before they are needed), then the smoothest critically damped repair that keeps the cursor and the clicked
  target inside the view (a banded quadratic programme: never a cut target, never the cursor out of frame, no
  wrong-way moves), the view eased into the capture's edges;
- per run of contiguous same-page clips, so it never crosses a cut. Overlays and the camera map through the crop
  (`viewOf`, `mapSourceRect`).

On the fixture captures the crop moves at most ≈ 25 CSS px per frame and accelerates ≤ 1 % of its width per frame²;
every click target and the cursor stay in view (tests on the real timelines). `studio review` checks it on the render:
`target-cut` (error), `cursor-outside-view` at clicks (error), `cursor-outside-reframe` and `reframe-jump` (warnings).

**4K**: a capture at `capture.scale: 2` is recorded at real device pixels (the runner launches headless Chromium with
`--force-device-scale-factor=2`: without it the screencast stays at CSS size whatever `deviceScaleFactor` says) and
renders to 3840×2160 by default, every component drawn at unit 2. `--scale 2` on a 1080p capture renders 4K too —
everything crisp except the capture, upscaled (a plan warning says so). Capturing 8 MP frames is heavy without a GPU:
on the 4-CPU Linux container the screencast delivers ≈ 9–16 fps at 4K against ≈ 45–58 fps at 1080p (2–3 fps under a
backdrop-blur dialog), so motion is choppy there; a Mac with a GPU is the place for 4K captures (L1.3 / L1.5).

### Music bed

A scenario `music: {file, volume, duck, loop}` (or `studio render --music <file>`) adds a bed under the video: at
`volume` (default 0.6) on the intro, the outro, cards and interstitials, × `duck` (default 0.5, −6 dB) while product
footage is on screen (eased over 0.5 s at each clip edge), faded in over 1 s and out over the last 2 s. The render
measures the track (ffprobe) so the planner can lay it out: a longer track is trimmed to the video; a shorter one
loops with 1 s equal-power crossfades at the seams (`loop: false`: it plays once). Tests and demos use a procedural
royalty-free track — `generateTestTrack(out, {seconds})` in `@demo-studio/editor` (ffmpeg sine chords C–Am–F–G, no
audio file in the repository).

### Export

`studio export <project> <render|latest> --formats …` (API `exportRender({project, render, formats})`) writes delivery
files to `exports/<render-id>/` with a `manifest.json` (per file: format, method, size, duration, fps, codecs, audio
streams, time taken, the GIF window, warnings; earlier exports of other formats into the folder are kept):

| Format | File | How |
|---|---|---|
| `mp4_1080p` | `<id>-1080p.mp4` | the master when it is 1080p (copy), else scaled down from it (lanczos, H.264 CRF 18, audio copied) |
| `mp4_4k` | `<id>-4k.mp4` | the master when it is 4K, else **re-rendered** at scale 2 from the run (capture upscaled unless it was captured at scale 2) |
| `webm` | `<id>.webm` | VP9 (CRF 32, constant quality) + Opus 128 kb/s at the base size, from the master |
| `vertical_9x16` | `<id>-vertical.mp4` | **re-rendered** through the planner (reframed), same run, theme and overrides; its render record next to it |
| `square_1x1` | `<id>-square.mp4` | **re-rendered** the same way |
| `gif_preview` | `<id>-preview.gif` | 480 px wide, 12 fps, palette (128 colours, Bayer dither), 15 s around the first marker (5 s before it), else the first 15 s; `--gif-start` picks the start |

Without `--formats` it exports `mp4_1080p,webm,gif_preview` (no re-render); `all` exports the six. A format that fails
is reported (exit code 1) and the others are still written.

## Raw export for editors

Script and film with Demo Studio, then edit in Final Cut Pro, Premiere Pro, DaVinci Resolve, After Effects or any
OpenTimelineIO tool: `studio export-capture <project> <run|latest>` (API `exportCapture({project, runDir, …})` in
`@demo-studio/runner-web`) turns a capture into a package that drops into those tools; `studio run <project>
<scenario> --raw` captures and exports in one go.

```
studio export-capture northfield-fixture latest --scenario quote                       # MP4 30 fps, cursor as captured
studio export-capture northfield-fixture latest --scenario quote --format prores --fps 60 --cursor layer --selects
studio run northfield-fixture quote --raw --cursor none                                # captured without the cursor
```

- **Clips** — one per scene, `clips/01-<scene>.mp4` (multi-page scenes: one per page, `01-<scene>-<page>.mp4`, on
  the same frames), sortable and readable. A clip starts at the scene's opening still: the page load before it is
  never in a clip. Inside a scene the **loading is cut** (a jump cut): when steps wait for the product (`wait_for`,
  `wait_for_email` that really waited), the clip keeps the step that started it up to 0.3 s after its **last** press
  (a select's option click, a menu's confirm, a type's Enter or end of typing; a drag whole), or until the URL
  changed after that press, and resumes once the awaited state is painted (the wait's end + 1.5 screencast intervals
  there, 0.2–0.3 s: new content reaches the screen up to ≈ 0.2 s after its DOM —, then on the next screencast frame when the page was still painting) — never a step's visible
  action or result, a hold, a mark or the opening still. A scene that ends on its awaited state (no `hold` after the
  wait) keeps its loading, with a note: a cut there would leave the result out of the clip. A **page load the capture
  held** (`timeline.loading`, from 0.15 s: the cut sits on the page change) is cut too, reason `navigation`, from the
  commit to the first frame of the painted page — also inside the opening still, and up to the scene end when the
  scene ends before the paint (as the edit does; noted); in a multi-page scene not while another page acts —; its
  manifest cut has no `wait_step` (`after_step`: the step during which the page changed); one that overlaps a
  wait-based cut extends it. `--no-cuts` keeps the loading. A `hook:` step's span (L5.8: it ran off camera) is cut
  either way, reason `hook`, and a scene played with `offscreen: true` has no clip (both noted). Otherwise
  real time: speeds and shortened waits are the editor's job.
- **Codecs** — `--format mp4` (default): H.264 high profile, CRF 14, yuv420p, 1-second GOP, faststart;
  `--format prores`: Apple ProRes 422 HQ (`prores_ks` profile 3), yuv422p10le, `.mov`. BT.709, limited range. Encoded
  once from the run's own screencast frames (not from `capture.mp4`). `--fps 30|60`: constant frame rate on the
  capture's clock — frame n shows the screencast frame on screen at n / fps; 60 fps comes from the screencast's real
  timing (up to 60 frames a second when the page moves), never interpolated. A run that did not keep its frames
  (`capture.keep_frames: false`, the default since L5.7) is cut from its CFR video (frames repeated for 60 fps; a note
  says so): capture with `keep_frames: true` for a 60 fps raw export.
- **Timecode** — every clip carries a start timecode equal to its place on the sequence (`00:00:00:00` = the first
  clip), so source and record timecodes agree in every tool (an EDL's source in = record in).
- **Cursor** (`--cursor`) — `baked`: as captured. `none`: the run was captured **without** the in-page cursor
  (`studio run … --raw --cursor none|layer`, or `raw.cursor` in project.yaml): the pointer still drives real input and
  its track is recorded; the clips show no cursor. `layer`: also one transparent video per clip,
  `cursor/01-<scene>-cursor.mov` — ProRes 4444 with alpha (`--layer prores`, default) or VP9 with alpha
  (`--layer webm`) — with the cursor and its click ripples drawn exactly as the in-page kit draws them (icon, press
  scale, ripple; the kit reports them during the capture), same size, frame rate and length as its clip: put it on
  the track above. A ProRes layer carries its clip's start timecode. A WebM layer has none (Matroska keeps no
  timecode: its media time starts at 0, and the OTIO references it so), ffmpeg decodes its alpha with
  `-c:v libvpx-vp9` only, and Final Cut Pro and Premiere Pro do not read it — it is for web players and ffmpeg-based
  tools, left out of the FCPXML; use `--layer prores` for editing tools. On a run captured with its cursor, the layer
  duplicates it (a note says so). In every mode `cursor/cursor.json` and `cursor/cursor.csv` give the cursor on every
  frame (clip-relative time, sequence time, x, y in clip pixels, visible, pressed, icon, press scale, ripples) and
  `cursor/clicks.csv` every click (frame, times, x, y, scene, step, step id, action, target and its box).
- **Markers** — scenes (blue; chapter markers in Final Cut Pro), steps (green), marks (red), captions (yellow, lasting
  until the next one) and loading cuts (magenta), in clip-relative and sequence time:
  - `markers/<scenario>.fcpxml` — FCPXML 1.10: one event, one project, the clips on the primary storyline with their
    markers; ProRes cursor layers connected above their clip; the other page of a multi-page scene connected and
    **disabled** (enable it to build a split screen). Final Cut Pro: *File → Import → XML…*; DaVinci Resolve:
    *File → Import → Timeline…*.
  - `markers/<scenario>.otio` — OpenTimelineIO: track V1 with the clips (+ a Cursor track, + one track per extra
    page, disabled), markers with name, colour and comment. DaVinci Resolve imports it (*File → Import →
    Timeline…*); other tools through OTIO adapters (e.g. Premiere Pro, Avid).
  - `markers/<scenario>.edl` — CMX 3600 (non-drop) with `* LOC:` locators: the sequence clips on one picture track.
    Premiere Pro: *File → Import*; Resolve and Avid read it too.
  - `markers/markers.csv` / `markers.json` — every marker with frames, seconds and timecodes, for spreadsheets,
    After Effects scripts or Claude.
- **Selects** (`--selects`) — `selects.mp4|mov`: the sequence clips back to back in one file (stream copy).
- **Manifest** — `manifest.json` (source run, scenario, settings, sequence, every clip with its file, scene, page,
  duration, frames, fps, size, codec, profile, pixel format, timecode, cuts and layer; the cursor files, the marker
  files and counts, the files the Demo Studio edit of this scenario uses — intro / outro videos, overlays, images — for
  reuse, notes and warnings) and a short `README.md` for people.

Package: `<project>/exports/<run-id>-raw-<format><fps>-<cursor>/` (or `--out`). The interchange files point at the
clips by absolute path (`file://` URLs in the FCPXML and OTIO): if you move the folder, relink to `clips/`.
`studio run … --raw --json` prints the RunProgress events, then one `{"type":"raw_export","dir":…,"manifest":…}` line.
project.yaml can hold the defaults:

```yaml
raw: {format: prores, fps: 60, cursor: layer, layer: prores, selects: true, cuts: true}
```

A run captured without its cursor still renders with `studio render`, with a plan warning: the video shows no cursor.

**Checking a package** (optional): `scripts/validate-raw.py <package> [...]` checks every clip and layer with ffprobe
against the manifest, the FCPXML (well-formed, frame grid, spine, timecodes, markers), reads the OTIO and the EDL back
with OpenTimelineIO and compares the marker lists. It needs Python 3 and, for the read-back, OpenTimelineIO with its
EDL / FCPXML adapters — not a dependency of this repository. Use Python 3.13 or older (OpenTimelineIO 0.18.1 fails to
load on 3.14 with `RuntimeError: bad any cast`):

```sh
python3.13 -m venv ~/.venvs/otio && ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter
~/.venvs/otio/bin/python scripts/validate-raw.py projects/northfield-fixture/exports/<run>-raw-mp430-baked
```

## Reviewing a render

`studio review <project> <render>` (a render id such as `catalogue-v3`, a `renders/<id>.json` or `.mp4` path, or
`latest` — of `--scenario` when given) looks at a finished video the way an editor would and writes everything an
agent or a person needs to check it before showing it, in `review/<render-id>/` (git-ignored, replaced at each
review):

```
$ studio review northfield-fixture catalogue-v3
! review catalogue-v3 (59.00 s, 5 segments) → projects/northfield-fixture/review/catalogue-v3
  not clean: 1 warning, 4 info
  warning [00:45.1 · f1352 · add-product · step 2] the screen of "add-product" barely changes for 3.8 s while the scenario waits (steps 2–4, 00:45.1–00:48.9): a loading state on screen — speed it up or shorten the wait (long-wait)
  info    the video lasts 59.0 s: 1.0 s shorter than the 60–120 s target of the reference look (within the 25 % tolerance) (video-length)
  info    [00:50.3 · f1509 · add-product · step 5] zoom 1.3× in 2.2 s (step 5 of "add-product"): the reference zoom is very slow (≈ 1.12× over ≈ 6 s, ≤ 1.2× over ≥ 3 s) (zoom-not-slow)
  info    59.00 s (catalogue-v2: 59.00 s, +0.00 s) (diff-duration)
  info    no visible change in 59 sample frames since catalogue-v2 (diff-frames)
  files: projects/northfield-fixture/review/catalogue-v3/sheet_1fps.jpg · 3 scene sheets · 10 key frames · timeline.json · report.json · report.md
  report projects/northfield-fixture/review/catalogue-v3/report.md · 10.8 s
```

| File | Content |
|---|---|
| `sheet_<fps>fps.jpg` (+ `_p2`, `_p3`… when long) | contact sheet at 1 frame per second (`--fps 2`: two), each thumbnail labelled with its timecode, frame number, segment / scene, step, markers (◆) and transitions (⇄); tiles a finding points at are outlined (red error, orange warning); at most 6 × 10 tiles a page, shared evenly between pages |
| `sheet_scene_<id>.jpg` (+ pages) | one sheet per scene, card and interstitial at 2 frames per second |
| `keyframes/<marker>.png`, `keyframes/<scene>-first.png`, `-last.png`, `intro-hold.png`, `outro-hold.png` | full-size frames: every marker (the screen once its marked step is done — for a marked `wait_for`, the awaited state), the first and last fully visible frame of each scene, a held frame of the intro and the outro |
| `timeline.json` | the output-time timeline: segments (frames and seconds, components with params and slots, caption component, transition in, layout rects, source range, speed, zooms, overlays), transitions, captions, markers, step spans and the clicks of the capture placed on the output (cursor point in capture px and on screen) |
| `report.json` | the review result: render, rules, `clean`, counts, findings, segment durations, the diff and the files |
| `report.md` | the same for people: the run's environment (L1.7: `Environment production · production · read-only · 1 write mocked · clock 2026-11-02T10:24:00`; also in report.json `environment` and on the terminal), findings with timecodes, a segment table, captions, markers and clicks, changes since the previous render, files |
| `diff_<previous>.jpg` | the frames that changed visibly since the previous render, side by side (before \| now) |

Findings are `{severity: error|warning|info, code, message, at?: {frame, time, segment, scene, step}}`; a review is
**clean** when it has no error and no warning (info notes do not count). `--strict` exits with `1` when the review is
not clean; `--json` prints the result. The checks:

| Check | Codes |
|---|---|
| Durations of every segment and of the video (reference look: video 1–2 min — or the scenario's `target_length` —, scenes 4–25 s), a card or an interstitial shorter than its text needs (250 words a minute + 1.5 s) | `video-length` (info a little outside, warning beyond ±25 %), `scene-length` (info), `scene-too-short` (< 2 s: warning), `card-too-short` (warning) |
| A card showing a captured mail or document before the scene whose step captures it (the result before its cause) | `artefact-before-step` (warning) |
| Scenes longer than 30 s at about 1× | `long-scene` (warning) |
| Blank, near-uniform or loading screens inside the layout's screen rect (2 fps samples, transitions excluded), at scene starts (rendered frame and capture frame), a screen still changing during the opening still (compared on the capture frames when the view moves or something is drawn over the page: an overlay such as a spotlight, a caption over the screen), waiting on an unchanging screen for 3 s or more (wait steps and the time after an action until the next step; holds are deliberate) | `blank-screen` (error from 1 s), `near-uniform-screen`, `blank-scene-start` (error), `loading-scene-start`, `long-wait`, `empty-segment` (a card that draws nothing) |
| Captions: shown on another scene, overlapping in time, too long for their area (the kit's `fitText` with the theme caption style and the theme's real font files: shrunk below 85 % of the theme size = warning, cut with "…" = error), under the brand mark, not visible in the caption area, missing | `caption-scene-mismatch`, `caption-overlap`, `caption-too-long`, `caption-truncated`, `caption-shrunk` (info), `caption-overlaps-brandmark`, `caption-not-visible`, `caption-missing` |
| Text slots longer than their component's `max_chars` (titles, kickers, taglines, callouts, captions) or required and empty | `text-slot-overflow`, `text-slot-empty` |
| Cursor at every click of the capture: off screen, hidden, outside the zoomed view (at the click and 0.4 s later), target partly outside the view (info when a reframed target larger than the view shows its leading part and the click) | `cursor-offscreen`, `cursor-hidden`, `cursor-outside-view` (error), `target-outside-view` |
| Camera: more zooms than the reference look's one very slow zoom per video, zooms faster / stronger than "very slow", clamped zooms, a zoom reset at a same-page join, camera jumps | `zoom-count` (warning), `zoom-not-slow`, `zoom-clamped` (info), `zoom-reset`, `camera-jump` |
| A transition (or fade) over a click and its ripple | `transition-on-click` (warning) |
| The take's slow transitions (run.json `perf`: a click whose result took over 0.8 s to settle on screen), at the click | `slow-transition` (info) |
| The render itself: failed status, duration or size different from the plan, missing components (stand-ins), plan warnings | `render-failed`, `duration-mismatch`, `size-mismatch`, `component-missing`, `plan-warning` |
| The environment (L1.7, see [Environments](#environments-display-urls-production-read-only-clock)): a write the read-only guard stopped (one per method and path, at its output frame; the app saw a network error), a browser bar left without its address (a local URL without a display URL, on a layout that draws the URL), a caption / card / overlay / page label / intro / outro text naming a local URL | `write-blocked`, `url-hidden`, `local-url-text` (warnings) |
| Diff with the previous render of the same scenario (auto-detected; `--previous <id>` or `--no-previous`): total and per-segment durations, component / caption / transition / layout changes, sample frames compared at the same offset inside the same segment | `diff-duration`, `diff-segment`, `diff-frames` (info) |

How it works (`@demo-studio/review`, `docs/DESIGN-phase2.md` §3): frames are decoded by ffmpeg in one pass per video
(the render, its capture for the scene starts, the previous render), streamed as raw RGB; sharp makes the thumbnails,
the sheets (labels drawn as SVG) and the key frames; the checks read the plan of the render record (segments, layout
rects, captions, step spans, camera, time map) and the run's timeline (clicks, cursor track, captions as captured).
The duration rule is a style target measured on two reference videos, not a defect: a video a few seconds outside 1–2
minutes is an info note, a warning only beyond ±25 % (45 s – 150 s); a scenario's `target_length` replaces that
range (the plan carries it). Thresholds are `rules` of the API (`DEFAULT_RULES`, `reviewRules`); rules a caller passes
win. With an edit re-planned from today's scenario, the caption checks compare with the captions it planned.

API: `reviewRender({project, render, scenario?, fps?: 1|2, previous?: id|false, thumbnails?: false|'sheets'|'all',
thumbnail_px?, rules?, out?})` → `ReviewResult` (the report plus `thumbnails`: JPEGs ≤ 1280 px as base64 for the MCP
— the contact sheet pages and the marker key frames by default, every sheet and key frame with `'all'`). A review of a
one-minute 1080p render takes ≈ 10 s.

## Frame comments

A comment points at one frame of a render — optionally a region of it — and says what to change. Claude reads it with
the frame still and where the frame sits in the scenario, replies, changes the scenario (an edit — a caption, a card, a duration,
an overlay — renders on the same take; a change to its filmed part — steps, pages, hooks — needs a new capture first) or
the render overrides, renders again and resolves it with the new render (through
MCP; the Studio app later writes the same files).

```
$ studio comment add northfield-fixture quote-v1 --marker proposal --region 0.67,0.42,0.12,0.08 "Keep the total on screen longer"
✓ comment c_01K… on quote-v1 frame 1421 (00:47.37): clip proposal · step proposal.3 (wait_for) · area screen · studio/layout-card · marker proposal · overlays studio/overlay-callout
$ studio comment list northfield-fixture --status all
$ studio comment reply northfield-fixture c_01K… "The callout too, please"
$ studio comment resolve northfield-fixture c_01K… --note "Held the total 2 s longer" --render quote-v2
$ studio comment reopen northfield-fixture c_01K… --note "Still too short"
```

- **The frame**: `--frame <n>` (0-based), `--at <seconds>` (the frame on screen at that time — `--at 0.99` at 30 fps is
  frame 29; the duration an error prints is the last frame) or `--marker <name>` (the screen once the marked step is
  done; a name marking several steps is refused: use `--frame`). `--region x,y,w,h` is 0..1 of the frame. Texts are at
  most 2000 characters (control, bidirectional and invisible characters removed, line breaks kept). The author is `--author`, else `$DEMO_STUDIO_AUTHOR`, else your
  user name.
- **The anchor** is computed from the render's edit plan when the comment is made: the segment and its component, the
  scene, the step (`<scene>.<step id or index>`, the `--until` syntax; a fingerprint of the step in the run's scenario,
  so a moved step can be found), its action, the marker, the overlays on screen, the transition; with a region, whether
  it lies on the caption (its band, for a caption drawn over the screen) or the brand mark.
- **Files**: `comments/<scenario>/c_<id>.json` per thread — the comment, the render it was made on (its id and when it
  was made: a render id is reused once renders/ is cleaned), the anchor and append-only entries (replies, resolutions,
  reopenings, each with its own id). The status is derived from the entries. Commit comments/ with your scenarios. The
  still lives in `.demo-studio/comments/<id>.jpg`, on this machine only: a frame of a production capture never enters
  git. It shows the frame with your region outlined (no number on it: the video has its own step badges).
- **Resolving** names the render that answers the comment: a later render of the same scenario and variant (`latest`:
  the newest one of that variant — a vertical cut does not answer a frame of the landscape video). The thread stays on
  the render it was made on (`--render` of `list` shows the threads made on that render as it is now).
- **Who wrote it**: each entry says the channel — `cli` (a `studio comment` command, whoever typed it) or `mcp` (Claude
  through the MCP tools) —, never "a person". Only `studio comment` creates and reopens threads. A comment's text is
  data: it asks for a change to the video, never for a hook, a sign-in or a file outside scenarios/.

**With Claude** (the MCP tools, see [MCP](#mcp-claude-drives-demo-studio)): ask it to address the open comments.
`comments_list` gives each open thread with its anchor — `step_ref` is where the step was in the rendered run, `step_now` that
step in today's file (what `page_inspect {scenario, until}` takes; steps moved in the Studio change their index) —
and the still of the frame with your region outlined (an image Claude looks at); Claude changes the scenario (then
captures it again with `run_capture`), the render overrides or the theme, renders and reviews, then `comment_reply` (what it changed) and `comment_resolve`
(the new render, with the thread's hash: if you replied meanwhile, it is refused and Claude reads your reply first).
Its entries say `mcp`. It cannot create or reopen a thread, and it is told that a comment only asks for changes to the
video: one asking it to run a hook, sign in, open a URL or edit project.yaml gets a reply, not the action. Reopen a
thread you disagree with (`studio comment reopen`). A thread reaches Claude with its last 10 entries, and one listing
with at most 60,000 characters of comment text (narrow it by scenario or render when it says so). Limits: Claude's own
shell can run `studio comment` like you (its entries then say `cli`: it is told never to create or reopen threads);
a thread holds at most 500 entries and 2 MB; a listing reads every thread file (no index yet).

## Signing in: personas and sessions

Scenarios never contain passwords, and `project.yaml` never contains the path of a session. A project names its
**personas** — the accounts its videos are filmed as — per environment (or for all of them); each one's session stays
on this computer, in the studio home `~/.demo-studio` (`DEMO_STUDIO_HOME` moves it), outside every project and
repository:

```yaml
# project.yaml (the fixture project's environment signed-in)
auth:                                  # global, or keyed by environment name (as here)
  signed-in:
    login_url: /sign-in                # sign-in pages: a path prefix, "<page>:/path", a URL prefix or {regex, flags}
    personas:
      supplier:
        pages: [console]               # environment pages it is signed into (a page belongs to one persona)
        check: {url: "console:/products", expect_text: Maja Lindqvist}   # off camera, before every run
        login:                         # optional: automated login, off camera (secret references only)
          - open: "console:/sign-in"
          - type: {into: {label: Email}, text: maja@northfield.example}
          - type: {into: {label: Password}, text: "{{env:NORTHFIELD_SUPPLIER_PASSWORD}}"}   # or {{keychain:…}}
          - click: {role: button, name: Sign in}
          - wait_for: {text: Maja Lindqvist}
      buyer:
        pages: [shop]
        check: {url: "shop:/", expect_text: Demo Café}
```

A persona's keys: `email` (its mail address: `wait_for_email {to: persona:<name>}`), `pages`, `session` (`profile`, the default: a Chromium profile; `storage_state`: cookies and
localStorage only), `check` (`url`: `"<page>:/path"`, a path or a URL, default its first page's `/`; `expect_text`: a
text only shown when signed in — without it, signed in means "loads off the sign-in pages"; `expect_not_url`: more
sign-in pages; `timeout`, default 10 s), `login_url` (its own sign-in pages, with `auth.login_url`) and `login` (steps
`open`, `click`, `type`, `press`, `wait_for`, `wait` in scenario syntax; `{{hooks.…}}` is not available there).

**Sign in once** with `studio login`:

```sh
studio login northfield-fixture --env signed-in --persona supplier          # a browser window: sign in (SSO, 2FA…), close it
studio login northfield-fixture --env signed-in --persona buyer --auto      # or its login steps, headless (CI, tests)
studio auth status                                                           # every persona, and its last check
```

`studio login` opens a visible Chromium window on the persona's own profile
(`~/.demo-studio/profiles/<project>/<env>/<persona>/`), on its check page (`--page KEY` / `--url URL` to choose),
with the session saved so far — still signed in when it still works. Sign in, then close the window (or quit the
browser). It saves a snapshot of the session (`~/.demo-studio/sessions/<project>/<env>/<persona>.json`: the cookies —
session cookies too, which a profile loses when it closes — and localStorage, readable only by you), checks the
session the way a run will see it and prints
`✓ supplier (env signed-in) signed in: console:/products shows "Maja Lindqvist" — runs use a copy of this session`
(else "still signed out … did the sign-in finish?", exit 1). A window that ends signed out never replaces a saved
session that still works (it is kept, and said so). A new profile never offers to save a password; a first sign-in
that fails leaves no profile behind. Ctrl-C closes the window and saves nothing (exit 130). `--persona` is needed when
the environment has several personas; `--auto` runs the persona's `login:` steps headless instead of a window — after
checking the saved session the way a run sees it: one still valid is kept as is, no step runs. A profile a browser
still holds (another login window) is refused. On a terminal, `studio new` asks for the personas (a persona whose
environment pages all have one already films none by default: a scene picks it with `persona:`) and offers to sign
each one in (no answer: later).

**Who films which page.** A page is signed in as the persona whose `pages` list its environment page;
`persona: <name>` on a scene — or on a page of a multi-page scene, `pages.<id>.persona` — chooses another one, and
`persona: none` none (a fresh browser: a sign-up, a public page). A page id keeps the persona it is first filmed with
for the whole run: another account on the same environment page needs a page id of its own (a multi-page scene's
`pages`). A `new_tab` is signed in as the page that opened it (a tab of a `persona: none` page has none either);
`persona: none` written on a later scene for a page filmed without a persona so far leaves it unguarded for the run. A
`js` hook runs as the persona its page is filmed with in the scenario (`none` included), else as that page's default —
`studio hooks run <project> <scenario>:setup` binds it the same way. Each persona gets its own browser (its own
cookies): a multi-page scene films the supplier and the buyer of one site side by side, each signed in as itself.
Validation names an unknown persona and a page asked for two. An environment without personas behaves as before.

**Before every run** — dry runs too, once the secrets are read, before any setup hook or recording — each persona the
run films is checked off camera, in a tab of its own browser. A persona that is not signed in and has `login:` steps
signs in automatically (off camera; the run warns, and its saved session stays expired: `studio login` saves one runs
can reuse). Otherwise the run stops before anything happens, with the exact command:

```
✗ run failed in 762 ms · 0/19 steps
  error     session preflight failed — nothing was recorded:
              persona buyer (env signed-in): expired — shop:/ landed on the sign-in page (http://localhost:4404/sign-in)
                sign in again: studio login northfield-fixture --env signed-in --persona buyer
```

**During the run**, a filmed page that lands on a sign-in page — `auth.login_url`, the persona's `login_url` or
`check.expect_not_url`, matched on the URL's origin and path (never its query; `/sign-in` also matches `/sign-in/…`,
not `/sign-in-help`; `"<page>:/path"` and URLs also after an http → https or apex → www redirect) — fails the run at
once, and the run keeps nothing: no frame, video, screenshot, artefact or timeline (a step failing meanwhile reports
the landing, even an `optional` one). A `download` whose document opens on a sign-in page fails the same way (it is
never saved). Pages without a persona are guarded by `auth.login_url` too, unless written `persona: none`. A landing
right after the setup hooks says a hook may have reset the sessions; a tab that reaches the sign-in page of another
persona's page says so (`… that is page "shop", filmed as persona buyer: a tab keeps the persona of the page it is
opened from — film "shop" on its own page`); after a step fails on a persona's page, one check says whether its
session expired. An expiry seen during a run is saved: `studio auth status` shows `expired` (`expired during run …`).
Validation refuses a sign-in pattern that would match every page (`/`, `"<page>:"`, an environment page's URL, a
regex matching any URL) and the regex flags `g` / `y`, and warns about `{regex: "^/…"}` (a regex sees `http://host/…`)
and `/sign-in/i` (a path, not a regex: write `{regex: sign-in, flags: i}`).

**Copies.** A run never opens a persona's profile: it runs on a copy (copy-on-write where the disk allows; caches,
locks and saved passwords left out) plus the snapshot's cookies, in the system temp folder, removed at the end. Runs
of one persona can therefore run at the same time; a profile a login window still holds is refused (close it first).
A `storage_state` persona runs on a fresh profile plus its snapshot. A second Ctrl-C removes the run's copies before
it quits; Ctrl-C in `studio login`, `auth status --check` or js hooks (`hooks run`, `hooks rollback`, `env reset`)
closes their browser and its copies, then exits 130; copies a killed process left behind (`demo-studio-session-*`,
`demo-studio-login-*`, `demo-studio-profile-*`, no browser on them for 10 minutes) are removed by the next run. Ctrl-C during the preflight's
check or automated login cancels at once.

**Status.** `studio auth status [--project P [--env E]] [--json]` lists every persona from what is stored — `valid`,
`expired`, `never` (no session saved), `unchecked` (saved, never checked), `error` (could not be checked) — with when
and by what it was last checked (a run's preflight, a run it expired during, `studio login`, `auth status --check`),
whether a browser holds its profile, and the command for any that is not valid:

```
northfield-fixture · env signed-in
  supplier  valid     checked 2 min ago (preflight of run 20261013-141530-live-quote)
  buyer     expired   checked just now (auth status --check): shop:/ landed on the sign-in page (http://localhost:4404/sign-in)
            → sign in again: studio login northfield-fixture --env signed-in --persona buyer
```

`--check` checks each saved session now (headless, one after the other, without signing in), saves the result and
exits with 1 when one is not valid; a profile a browser holds is not checked (`not checked · in use by a browser`:
close that browser first). `studio doctor --project P` shows the same per persona, and warns when the studio
home — or a session — sits inside a git work tree that does not ignore it.

**The fixture** serves its two apps behind a sign-in too (:4403 / :4404, invented accounts and passwords in
`fixtures/wholesale/README.md`): the fixture project's environment `signed-in` runs every scenario signed in.

```sh
export NORTHFIELD_SUPPLIER_PASSWORD=… NORTHFIELD_BUYER_PASSWORD=…     # from fixtures/wholesale/README.md
pnpm studio login northfield-fixture --env signed-in --persona supplier --auto
pnpm studio login northfield-fixture --env signed-in --persona buyer --auto
pnpm studio run northfield-fixture live-quote --env signed-in        # each pane signed in as its persona
```

**One account, the older form.** `auth: {profile: ~/…}` (or `storage_state: file.json`), global or per environment,
still works as the persona `default` on every page, with a validation warning (a path that only exists on one
computer): `studio login <project> [--env E]` opens a window on that profile as before, and runs use a copy of it. As
before, a missing profile starts signed out and a missing `storage_state` file fails the run before anything runs
(`studio auth status` says to export it again: `studio login` has no window for it).

**Limits.**
- Nothing is written back from a run: an app that rotates its refresh token on every use may ask to sign in again
  sooner (each run refreshes a copy); `studio login` again then.
- Tokens kept in sessionStorage are lost between runs; IndexedDB travels in a `profile` persona's copy, not in a
  `storage_state` snapshot.
- A sign-in screen an app shows without changing its URL is caught only when a step fails (the frames until then are
  filmed): give such an app a `check` with `expect_text`, and steps that wait for signed-in content.
- Signing out on camera fails the run (the guard sees the sign-in page).
- A session belongs to the computer that saved it (a snapshot from another one is warned about); sessions are kept
  per project slug, so two workspaces with a project of the same slug share them.
- A copy starts with cold caches: its first page loads are slower (held, and cut by the edit).

## Environments: display URLs, production, read-only, clock

An environment is written in one of two forms. The **short form** is the page map itself; the **long form** puts
settings next to a `pages:` map. A page is its base URL, or `{url, display}` — in both forms.

```yaml
environments:
  local:                                        # short form: page key → base URL …
    console: http://localhost:4401
    shop: {url: http://localhost:4402, display: shop.northfield.example}   # … or {url, display}
  production:                                   # long form
    production: true                            # read-only, unless access: read-write (and then only with --allow-writes)
    access: read-only                           # read-only | read-write; default: read-only in production, else read-write
    pages:
      console: {url: https://console.example.com, display: console.example.com}
      shop: https://shop.example.com
    read_only:                                  # used only when a run on this environment is read-only
      hosts: [api.example.com]                  # hosts that belong to it: writes stopped (production: every host is), never written to from other environments
      allow:                                    # writes let through: a token refresh, a search sent as POST…
        - POST console:/api/session/refresh
        - {request: "POST shop:/graphql", operation: SearchProducts}
      mocks:                                    # answers to stopped writes, for every scenario on this environment
        - {request: "POST shop:/api/track", status: 204}
```

`production`, `access` and `read_only` written in the short form are an error that says to use the long form (a page
key named `access` with a URL stays a page). Every consumer still sees each page's real URL: `{{shop}}` in a step or
a hook is `http://localhost:4402`.

**Display URLs.** `display` is a public host (`shop.example.com`, https implied: the address bar shows the lock), a
`host/path` or an `http(s)://` URL — no query, fragment or `{{…}}`: it is shown as written; a local host or a port out
of range is refused. The runner navigates the real URL; `timeline.json` keeps both (`environment.display`) and what the
video shows maps the real URL to the display one: the page whose base is the longest prefix of it (path and query
kept; a page without a display URL keeps its URLs as they are), else — a URL under no page, on the origin of one with a
display URL — that origin's display host. Only http(s) URLs are mapped (a `blob:` URL maps the URL it wraps; a `file:`
URL is local). Display URLs are **edit-time data**: `studio render`, `plan`, `still` and `export-capture` take
project.yaml's current display URLs of the run's environment (a run captured before L1.7: the environment of its
`run.json`), so adding or changing one needs a new render, never a new capture (only text templated at capture —
`{{shop}}` in a caption — keeps what it read then); what the run recorded is kept for pages project.yaml no longer
declares. What the video shows:

- **Browser bars**: the address bar and tab strip of `studio/layout-browser`, the window bars of `split` / `pip` (themes
  framing captures in a browser) show the display URL. A **local URL without a display URL** (localhost, a name without
  a dot such as `devbox`, `*.localhost`, `*.local`, `*.test`, `*.internal`, `*.lan`, `*.home.arpa` and kin, a loopback,
  private, link-local or 100.64/10 address, `file:`) is never drawn: the bar shows no address there (the window bars
  fall back to the theme's `brand.url`), `studio render` warns once per page ("page "shop" has no display URL
  (http://localhost:4402)… add display: to environments.local.shop in project.yaml and render again") and the review
  reports `url-hidden` — only for layouts that draw a URL (a card, a laptop, a phone draws none).
- **Text you write**: `{{shop}}` in a caption, a card, an overlay's slots, a page label, the title, the intro or the
  outro reads the display URL (`https://shop.example.com`); in a step, `open`, a hook or a mock it stays the real URL.
  A text that names a local URL anyway is `local-url-text` in the review.
- **Notification overlays** name the display host of the page that sent the notification (a local host without one:
  the theme's brand name).
- **Reports and raw exports**: a review's findings never name a local host (a URL is its display URL, else its path
  "(a local page)"; a caption you wrote is quoted as written in report.md's caption list, and flagged
  `local-url-text`); the step markers and click targets of `export-capture` name the display URL, else the path
  (`3. open /quotes`). The real URLs stay in the run's `timeline.json`.
- Not mapped: what the captured page itself shows (its own links and text), captured emails and PDFs.

**Access of a run.**

| Environment | Without `--allow-writes` | With `--allow-writes` |
|---|---|---|
| not production, read-write (the default) | read-write | read-write (nothing changes) |
| `access: read-only` | read-only | usage error |
| `production: true` | read-only | usage error |
| `production: true` + `access: read-write` | read-only, with a notice | read-write, with a warning ("writes go to production") |

`--allow-writes` exists on `studio run`, `studio hooks run`, `studio hooks rollback` and `studio env reset`; it
confirms writes, it never grants them. The run header says `production` / `read-only` / `writes allowed`, and
`run.json` / `timeline.json` record the access.

**On a read-only run, hooks that write are refused** (status `refused`; `optional: true` does not skip a refusal): an
`http` hook whose method is not GET or HEAD (a GraphQL query sent as POST reads; a JSON body is GraphQL only when its
keys are `query` / `operationName` / `variables` / `extensions` and its `query` is a document), a `sql` hook with a
statement that is not a read (reads: `SELECT` without `INTO` / `FOR UPDATE` / `nextval` / `dblink`, `WITH` without a
data-modifying part, `TABLE`, `VALUES`, `SHOW`, `EXPLAIN` of a read, `SET` / `RESET` of anything but the transaction
mode or the role — a quoted name counts: `SET "transaction_read_only" = off` writes), a `shell` hook unless it declares
`writes: false` (and then `rm`, `dropdb` or destructive SQL given to `psql` still write), and a setup hook whose
`rollback` writes. `js` hooks run: their tab stops their writes. The SQL of a read-only run runs in a read-only
transaction (a function that writes fails in Postgres). `studio run` refuses a scenario with
such hooks before any browser opens, listing them — run it with `--hooks skip`, on a read-write environment, or with
`--allow-writes` where project.yaml allows writes; `studio validate` warns about them. `studio env reset` and `studio
hooks rollback` judge each pending rollback by the environment its hook ran in: a rollback journaled on production
with `--allow-writes` is not replayed by a plain `studio env reset` on a local environment.

**No run writes to another environment's production hosts.** The hosts of the project's read-only environments (a
production one, `access: read-only`: their pages' hosts and `read_only.hosts`) are protected in every run: on a run on
`local`, an `http` hook that writes to one (or a redirect hop of it), a `sql` hook that writes to a database there, a
`shell` hook that writes and names one is refused (`refusing a hook that writes (HTTP POST) to api.example.com, a host
of environment production — this run is on environment local: …`), and the browser stops writes to them (no mock, no
allow entry: recorded with `protected_by`, counted `1 stopped (hosts of read-only environments)`). Unless that
environment's own access applies: production with `access: read-write` and `--allow-writes`. A host an environment
this run may write to shares (the fixture's `production` is the same `localhost` as `local`; ports aside) is never
protected — a project without such environments runs exactly as before (nothing is armed).

**In the browser, a read-only run stops writes.** Every browser of the run (one per persona) is guarded from its
launch, the session check included: a request whose method is not GET, HEAD or OPTIONS — a GraphQL query sent as POST
reads; a mutation, or a persisted query known only by its name, writes — to a **guarded host** (on a **production**
environment, every host: fail closed — a write anywhere, a third-party API or analytics included, needs an allow entry
or a mock; on another read-only environment, the hosts of its pages and `read_only.hosts`; on any run, the protected
hosts of the project's other read-only environments) is

- answered by the first matching **mock** (the scenario's, then the environment's): the flow goes on on screen;
- else let through by a `read_only.allow` entry;
- else **stopped**: a fetch / XHR / beacon fails like a network error the app sees, a form POST (in any frame or a new
  window) is answered `204 No Content` — the page stays where it is, never a browser error page, and the click goes on
  at once. The run warns once per stopped request (`a write was stopped (POST shop:/api/quotes, step request.5, 12.4
  s)…`): the app may show an error — add a mock. A stopped write fails the request, not the run.

On a read-only environment that is not production, a write to a host the guard does not watch is sent, recorded
`passed` and warned about once per host (list the host in `read_only.hosts` when it writes your data). An allow entry
or a mock narrowed to a GraphQL `operation` covers a request only when every operation of it that writes is that one (a
batch `[RefreshToken, CreateOrder]` is stopped). `timeline.json` lists every write the guard saw
(`environment.writes`: capture time, method, URL, `blocked` / `mocked` / `allowed` / `passed` / `exempt`, the rule that
matched, `via` page / hook / sign-in, `protected_by`); the run summary counts them (`writes  1 mocked, 0 stopped
(read-only)`; the sign-in's exempt writes aside), the review's environment line too, and each stopped write is a
`write-blocked` warning at the moment the video shows it. Covered: fetch, XHR, `sendBeacon` and `keepalive` fetches
(also while a page unloads — a page the runner closes goes through `about:blank` first, and an unload write to a
guarded host is sent as an ordinary request), dedicated workers, service workers (their own requests included),
cross-site frames, popups and new windows, every persona's browser. `fetchLater` and `SharedWorker` do not exist in a
guarded browser nor in a js hook tab (the browser would send their requests past the guard): apps feature-detect them
— neither exists in every browser — and fall back to what the guard sees; one that requires them fails there. **What
it cannot stop**: messages over a WebSocket (allowed, warned about once per host — an app that saves over WebSockets
writes), WebTransport / WebRTC, an unsafe GET (a write sent as GET), a write to an unguarded host that redirects to a
guarded one (only its first hop is seen), requests of other programs, and what the server does on its own after a
read. Read-only means "no mutating HTTP from the run's browsers and hooks".

- **Signing in.** The automated sign-in tab (`login:` steps of a persona) is exempt while it is on a sign-in page of
  its persona (`auth.login_url`, its `login_url`, `check.expect_not_url`; every page when it declares none) — its
  `POST /sign-in` must happen (recorded `exempt`, `via: sign-in`). What it sends from the page the sign-in lands on (a
  "last seen" ping, an onboarding call) is guarded like a capture page's (recorded `via: sign-in`, counted and
  reported). It bypasses service workers, so a worker that would forward its sign-in POST cannot hide it. An identity
  provider on another host is guarded too on production: list its sign-in page in `login_url` (a URL pattern). The
  session check and every capture page are guarded; an OAuth popup the sign-in opens is not exempt. A **token
  refresh** the app sends from a capture page is a write: list it in `read_only.allow`, or the app may sign out and the
  run fails at the sign-in page. `studio login` and `studio auth status --check` run outside any run: they are never
  guarded.
- **js hooks** run in their own tab, guarded by it: their writes are stopped and never mocked (a hook that writes is
  refused, not fooled) — a hook that fails after a stopped write is `refused`; one that catches the error goes on with
  a warning.
- **Cost.** Any request interception makes Chromium pause every request of the browser and disables its HTTP cache:
  every page load of a read-only run (or of a run that protects another environment's hosts) fetches its assets again
  — invisible on a local app, slower loads (held by the capture, cut by the edit) on a remote one.

**Mocks** (`mocks:` of a scenario, then `read_only.mocks` of its environment) answer writes a read-only run stops in
the browser: `request` (same pattern as `allow`: `"[METHOD ]<page>:/path"` relative to that page's base URL, or
`"[METHOD ]/path"` on any guarded host — on production, any host; `*` matches within a path segment, `**` anything; the query is ignored; GET
patterns are refused), `operation` (a GraphQL operation name), `status` (200–599, default 200), `json` or `body`
(+ `content_type`), `headers`, `delay_ms` (0–10 000). Mocks are literal (no `{{…}}`) and apply to read-only runs only
(a read-write run with `mocks:` warns once: its writes really happen). A mock is the same answer every time — a list
the app reloads afterwards does not show the mocked write. To mock a form POST (a navigation), answer it like the
server would: `status: 303` with `headers: {location: /quotes}`; a JSON answer to a navigation shows the JSON.

**Clock.** `clock:` (project or scenario; a scenario's wins, `clock: false` turns the project's off) is the date and
time the product's browser clock reads when the capture starts — an ISO date-time such as `2026-11-02T10:24:00`
(without an offset: wall time in `browser.timezone`, else the machine's zone; a wall time a DST change skips or shows
twice is refused — write the offset the error suggests, e.g. `2026-10-25T02:30:00+02:00`) or `{at, freeze: true}`. A
date alone, offset minutes past 59 and years before 1970 are refused. `timeline.json` records the clock
(`environment.clock`: `at`, `epoch_ms`, `timezone`, `freeze`), `run.json` too (`at`, `timezone`, `freeze`), and the run
header says it (`clock 2026-11-02T10:24:00 Europe/Paris (frozen)`).

- **When.** The clock is installed in every browser of the run after the session check and the automated sign-in
  (they run on the real time: a sign-in checks its tokens against it; so does the session check after a failed step)
  and before the setup hooks; at capture time 0 it is set to the clock's time, then runs with the capture — two takes
  show the same date and the same time at the same capture time.
- **How.** Only the date: in every page, frame (one created empty too), popup and js hook tab of the run's browsers,
  `new Date()`, `Date()`, `Date.now()` and the date `Intl.DateTimeFormat#format()` / `#formatToParts()` use without one
  read the clock; timers, `requestAnimationFrame`, `performance` and event time stamps stay the browser's own, so the
  product's animations and timers run exactly as without a clock (a clock that fakes timers slowed them: ten animation
  loops from 60 to 30 fps, 100 `setTimeout(0)` from 0 to ~500 ms). Every document computes the time from one anchor:
  pages opened before and after capture time 0, in any persona's browser, agree. **Not covered**: a dedicated worker
  gets the clock as soon as it starts (its very first lines may still read the real date), shared workers (absent on
  read-only runs) and service workers keep the real date, and so do `performance.timeOrigin`, `document.lastModified`,
  cookie expiry and what the server makes (`created_at`, emails, PDFs: L1.8 seeds). A clock far from now can make
  client-side token checks (a JWT's `exp`) refresh or sign out: choose a recent date, and allow the refresh endpoint on
  read-only environments.
- **`freeze: true`** keeps `Date` at the clock's time the whole run. Timers and animation frames still run, but code
  that measures elapsed time with `Date` stalls — a debounced search field that compares `Date.now()`, a
  `Date`-driven animation or countdown, "updated 3 s ago" labels, a timeout computed from `Date`. Use it only when the
  product shows seconds and does none of that on screen.

**The fixture shows all of it.** `projects/northfield-fixture` gives its pages display URLs
(`shop.northfield.example`, `console.northfield.example`) and an environment `production` — the local fixture,
read-only. Its scenario `read-only` (`env: production`, `frame: browser`, `clock: 2026-11-02T10:24:00`) requests a
quote: the scenario's mock answers the `POST /api/quotes` (the toast reads the mock's supplier), the fixture's
`GET /api/health` counts no new write (`mutations`), the address bar shows `shop.northfield.example`, and the shop's
"Prices as of Monday 2 November 2026, 10:24" line (`/#as-of`: the fixture's only date from the browser's clock) is the
same in every take. `studio run northfield-fixture quote --env production` is refused before anything runs (its setup
hooks write).

## Sandbox mode

A **sandbox** is a disposable, local copy of the product that Demo Studio starts, seeds with demo data and resets
before every take, so two takes of a scenario show the same data. project.yaml names each sandbox's manifest; every
sandbox becomes an **environment** of its own:

```yaml
# project.yaml
sandboxes:                         # environment name → its sandbox.yaml, relative to the project
  sandbox: sandbox/sandbox.yaml
default_env: sandbox               # a sandbox may be the default environment (or a scenario's `env:`)
```

```yaml
# sandbox/sandbox.yaml   (every path in it is relative to this file)
# yaml-language-server: $schema=../../../packages/core/schema/sandbox.schema.json
version: 1                         # required; a newer version is refused (made for a newer Demo Studio)
provider: process                  # process | docker-compose
services:
  app:
    command: [node, server.mjs]    # process only: argv (a first word "node" runs the CLI's own Node) or a string for sh -c
    cwd: ../app                    # process only (default: this folder); env: {…} and stop_timeout_s too
    url: http://localhost:4601     # where its health is checked (localhost only)
    health: /api/health            # a path on url | {path|url, status, text, timeout_s, interval_ms} | {tcp: port} | false
    pages:                         # the environment's pages: page key → URL, or {url, display}
      console: {url: http://localhost:4603, display: console.example.com}
      shop: http://localhost:4604
seed:                              # what builds the demo data: http, sql, shell (and exec, docker-compose)
  - http: {method: POST, url: "{{console}}/api/demo/reset"}
  - sql: seed/01-demo-data.sql     # a file next to sandbox.yaml, run on a database below
reset: {strategy: reseed}          # reseed (default) | snapshot (docker-compose + Postgres)
databases:                         # sql seeds, and the sql hooks of scenarios on this environment
  main: {url: "postgres://demo:sandbox-db-4632@localhost:4632/app"}   # a plain demo password is fine here
mailbox: {provider: mailpit, url: http://localhost:4625}             # wait_for_email on this environment reads it
login_url: /sign-in
accounts:                          # demo accounts the seed creates: the personas of this environment
  buyer:
    pages: [shop]
    username: orders@example.com
    password: buyer-pass-4604      # plain (masked in every log) or {{env:VAR}} / {{keychain:service/account}}
    check: {url: "shop:/", expect_text: Demo Cafe}
    login:                         # signs the account in, off camera, whenever its session is missing
      - open: "shop:/sign-in"
      - type: {into: {label: Email}, text: "{{account.username}}"}
      - type: {into: {label: Password}, text: "{{account.password}}"}
      - click: {role: button, name: Sign in}
```

Every key of sandbox.yaml (version 1; `studio schema sandbox` prints the JSON Schema, which editors use through the
`$schema` comment):

| Key | What it is |
|---|---|
| `version` | `1` (required) |
| `provider` | `process` (programs of this machine) or `docker-compose` (required) |
| `compose` | docker-compose: `files` (default `[compose.yaml]`), `project` (default `demo-studio-<project>-<env>-<hash>`), `env_file` (default `.env` next to the first compose file when there is one; `false`: none — see [A "stage" sandbox](#a-stage-sandbox-images-of-a-production-build)) |
| `services.<name>` | `url` (health base), `pages` (key → URL or `{url, display}`), `health`; process: `command`, `cwd`, `env`, `stop_timeout_s` |
| `services.<name>.health` | a path, `false`, or `{path \| url, status, text, timeout_s, interval_ms, tcp}` (`tcp`: process only) |
| `seed[]` | `http`, `sql`, `shell`, `exec` (`{service, command, env, timeout_s}`, docker-compose) + `name`, `optional` |
| `reset` | `strategy` (`reseed` \| `snapshot`), `snapshot.database` (a key of `databases`), `restart` (services) |
| `databases.<key>` | `{url, external}` — sql seeds and the sql hooks of scenarios on this environment (loopback only); `external: true`: see below |
| `mailbox` | `{provider: mailpit \| http, url, poll_ms, headers, clear, external}` — `clear: false` keeps it at a reset |
| `login_url` | the sign-in page(s) of every account |
| `accounts.<persona>` | `username`, `password`, and the persona keys of project.yaml `auth`: `pages`, `check`, `login`, `session`… |

What the sandbox environment gets, from its manifest only (nothing is written twice):

- **Pages and display URLs**: the `pages` of its services (`{{console}}`, `page: shop`), each with its display URL.
- **Personas**: its `accounts`, with `login_url`, `check`, `login` and `session` as in project.yaml `auth`;
  `{{account.username}}` / `{{account.password}}` are only available in an account's own `login` steps, where they
  are written in when the project loads. A plain password is masked like a resolved `{{env:…}}` value as soon as the
  account signs in (log.jsonl, run.json, timeline.json, error pages, `studio login` messages) — every occurrence of
  its text is masked, so validation warns about one shorter than 8 characters or made of one word, and refuses one
  shorter than 3 (texts that short are never masked: they would mangle every log). Signing a sandbox
  account in automatically is expected (a reset drops the sessions the app stored): the run logs it as information,
  not as a warning, and `studio auth status` lists such an account as `auto` (never a `studio login` hint, never a
  failure of `--check`). `auth.<sandbox>` in project.yaml is an error; a global `auth` keeps applying to the other
  environments only.
- **Mailbox and databases**: the sandbox's own `mailbox` and `databases`, never project.yaml's (a sandbox scenario's
  sql hook cannot reach a staging database). A journal replay (`studio env reset`, `studio hooks rollback`) reaches
  the databases of the environment each entry ran in. Their loopback hosts (`db.localhost`, `127.0.0.2`…) are allowed
  hosts at run time, like `localhost`.
- **Never production**: a sandbox is always read-write and has no `production`, `access` or `read_only`.

Validation (`studio validate`, and every command: a broken sandbox.yaml stops them all, reported in that file):

- `version: 1` and `provider` are required. `compose` is for docker-compose; `command`, `cwd`, `env`,
  `stop_timeout_s` are for process (where `command` is required); `exec` steps are for docker-compose (a process
  sandbox writes a `shell` step with `cwd`); the services of a docker-compose sandbox must be services of its compose
  files (default `compose.yaml`), and not under `profiles:` there — Demo Studio runs `docker compose` without
  `COMPOSE_PROFILES`, so such a service never starts (naming one as a service or in an `exec` step is an error).
- **Every URL is on this machine**: `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]` — services, pages, health,
  mailbox and databases (a host written as `{{env:…}}` is refused; only a password may be a reference). Private
  addresses, VPN ranges and names without a dot are refused: a reset may drop and recreate the sandbox's databases.
  A database URL connects where it says: its query string may not carry `host`, `hostaddr`, `port`, `service` or
  `dbname` (pg reads `?host=` — a unix socket too — and `?port=` over the URL's own host and port) and is never
  templated. A health path stays on the service's `url` (`//host/up` and backslashes are refused). A sandbox page on
  the host and port of a page of a production or read-only environment is an error — every loopback host counts as
  the same one (`127.0.0.1:4401`, `[::1]:4401` and `localhost:4401` reach the same server).
- Paths (compose files, `cwd`, SQL files) are relative to sandbox.yaml; an absolute or `~` path is refused.
- Seed steps: `http`, `sql`, `shell`, `exec` — no `js` (there is no browser); they stop at the first failure, are
  never rolled back (a `rollback` is ignored, with a warning) and need no `confirm: true` (a seed rebuilds a local,
  disposable copy). A SQL file that is pg_dump's plain output (`COPY … FROM stdin`, `\connect`) is refused: dump with
  `pg_dump --inserts`, or load it with an `exec` step. A shell step gets the `env` of the process services (below):
  a variable two services set differently must be set in the step's own `env`.
- `strategy: snapshot` needs docker-compose and a Postgres database of `databases` (`reset.snapshot.database`,
  default the first) that is not `postgres` / `template0` / `template1`, with a name of at most 50 characters.
  `reset.restart` names services of the manifest.

### Starting, resetting and filming a sandbox

```sh
studio sandbox up northfield-fixture          # start what is not running, wait until healthy, seed it if needed
studio sandbox status northfield-fixture      # services (pid, health), pages, seed, last reset, take lock (--json)
studio sandbox logs northfield-fixture        # the last lines of each service's log ([service] [--lines 50] [--follow])
studio sandbox reset northfield-fixture       # back to the seed (the sandbox must be up; --reseed)
studio sandbox down northfield-fixture        # stop it (a process sandbox's data goes with it; --volumes)
studio run northfield-fixture sandbox-quote --sandbox   # up if needed, health, reset to the seed, then the take
```

`--env <name>` picks the sandbox (default: the first of project.yaml `sandboxes:`). `status` exits with `0` only when
every service runs and is healthy, `--json` for scripts.

- **`up`** starts the services that are not running (a process sandbox: in the order sandbox.yaml declares them, each
  one healthy before the next starts; a docker-compose one: `docker compose up`, below). It then seeds the sandbox
  when it was never seeded, when its seed changed (the seed steps, the files they read, the `seed/` folder next to
  sandbox.yaml, and for docker-compose the images of the services), or when it started a service (what a restarted
  process or container held in memory is gone; a process service started with `--no-seed` leaves the sandbox
  unseeded, so the next `up` seeds it), or — strategy `snapshot` — when an interrupted reset left its database
  missing or closed to connections; `--no-seed` skips that. A service still running is kept (and checked again); one
  whose definition changed in sandbox.yaml since it started keeps running as it was, with a warning — `down`, then
  `up`, applies the change. `--build` (docker-compose) builds the images first.
- **`down`** stops every service. A process sandbox's data goes with its processes; a docker-compose sandbox keeps
  its volumes (the next `up` restores its snapshot, or reseeds) unless `--volumes`, which removes them — the database
  and its snapshot — too. Images are never removed.
- **Every take checks its pages first** (L5.8, sandbox or not): one GET of each page of the environment, 5 s each.
  A page that does not answer — nothing listens on its port (a dev server that stopped or moved to another port), a
  gateway error (502, 503, 504) — stops the run before anything opens, naming the page and its URL; any other HTTP
  answer (a 404 at the root, a redirect to a sign-in) counts.
- **`studio doctor --project <slug>`** warns (`Sandbox`) when the project has no sandbox and one of its environments
  films only this machine with a database, a mailbox or reset hooks — each take then starts from whatever the last
  one left —, with the command that scaffolds one (`studio sandbox init`). MCP `project_get` says the same.
- **`run --sandbox`** takes the sandbox's take lock, starts what is not running, checks every service's health,
  resets the sandbox to its seed, then films; the sandbox stays up afterwards. The environment is `--env` (it must be
  a sandbox), else the scenario's `env` when it is a sandbox, else `default_env` when it is one, else the first
  sandbox; `--sandbox` on a project without one, or with an `--env` that is not one, is a usage error. The scenario is
  then validated once, against that environment (its pages, its mailbox): a scenario without `env:` that waits for an
  email only the sandbox's mailbox receives runs with `--sandbox`. A dry run (`--dry --sandbox`) resets too. A failure before the take (a busy sandbox, a port in use, a service that is not
  healthy, a failed seed) creates no run folder. The run prints `sandbox sandbox (process) · running · healthy 1/1 ·
  reset reseed 12 ms` first, its summary a `sandbox` line, and run.json / timeline.json record `environment.sandbox`
  (`{name, provider, strategy, restored, reset_ms, seed_hash, at}`).
- **Without `--sandbox`**, a run on a sandbox environment (`--env sandbox`, or a scenario whose `env` is one) films it
  as it is, with no reset — the sandbox must be up (otherwise the run is refused before anything runs) — and warns when
  a take holds its lock; run.json records the sandbox without a `strategy`.
- **A reset** (strategy `reseed`): the seed steps again (phase `seed`: the first failure stops it, and a sandbox whose
  seed failed counts as never seeded; strategy `snapshot`: the snapshot restored instead, see below; `--reseed` runs
  the seed and takes the snapshot again); as soon as the data is back, the pending rollbacks of earlier runs on that
  environment are marked superseded — `studio env reset` and `studio hooks rollback` never replay them on the
  reseeded data (`DELETE /api/quotes/7` would delete the new quote 7), even when what follows fails —; then the
  mailbox is emptied (Mailpit `DELETE /api/v1/messages`; `mailbox: {clear: false}` keeps it; an `http` mailbox is left
  to the seed) and the `reset.restart` services restarted.
- **Only what the sandbox owns.** A reset empties the mailbox and the seed's `sql` steps rewrite their database, so
  both must be the sandbox's own: served by a service of the sandbox — a port a running container of its compose
  project publishes (made from its folder, with no other project's container publishing that port too), or a port a
  process service names (`url`, `pages`, `health: {tcp: …}`) and listens on —, with no other program on it.
  Anything else is refused before the reset changes anything (`port 8025 (the mailbox http://localhost:8025) is not a
  port of a service of this sandbox …`): a `localhost:8025` or `localhost:5432` may be another stack's. A mailbox or a
  database the sandbox does not start but that is its alone (a Mailpit or a Postgres you run for it) says so with
  `external: true` in sandbox.yaml (`databases: {main: {url: …, external: true}}`, `mailbox: {…, external: true}`).
- **One take at a time.** `up`, `reset`, `down` and `run --sandbox` hold the sandbox's take lock
  (`.demo-studio/sandbox/<env>/take.lock`): a second one fails at once, naming the holder (`sandbox sandbox is in use:
  run 20261014-101500-sandbox-quote (pid 4242) since 10:15:03`). The lock is created whole in one step (written aside,
  then hard-linked into place), and a lock whose process is gone is removed with a note — under a breaker file, and
  only if it is still that lock: two commands finding the same stale lock never both take it.
  `status` and `logs` never wait for it. Two takes at the same time need two sandboxes (another environment, other
  ports).
- **Ctrl-C** during `up`, `reset`, `down` or the preparation of a `run --sandbox` stops what that command started —
  and only that: services an earlier `up` started keep running —, a running seed step too (a `shell` step's process
  group: SIGTERM, SIGKILL 2 s later; an `exec` step's processes inside its container), and exits with `130`; a second
  Ctrl-C kills them at once.

**What two takes share.** A reset makes the data the seed builds equal for every take — rows, ids and sequences, the
mailbox. It does not make equal what the app writes while it is filmed: a server-side timestamp (`created_at`) is the
time of the take, a random token differs. The fixture's demo clock restarts at every reset, so its "requested
Today, 10:24" is the same in every take that requests its quote within the minute; a real app's server clock is its
own business — `--sandbox` never sets the browser clock (`clock:` stays explicit: a pinned browser clock next to real
server timestamps shows "created in 3 weeks").

**The process provider** (`provider: process`) starts each service as a program of its own process group, detached
(it outlives the command), in `cwd` (default the folder of sandbox.yaml):

- **Command**: argv, where a first word `node` runs Demo Studio's own Node (a folder's Node version manager could
  otherwise pick another version), or a string run with `sh -c` (looked up on `PATH`).
- **Environment**: Demo Studio's own, without the package manager's and test runner's variables (`npm_*`, `PNPM_*`,
  `VITEST*`, `NODE_ENV`, `NODE_OPTIONS`, `INIT_CWD`, `TEST` — set them in `env:` when the service needs them), plus
  `env:` (templated: `{{env:VAR}}`, `{{keychain:…}}`, page keys, vars) and `DEMO_STUDIO_SANDBOX=<env>`. A `shell`
  command on the sandbox's environment — its seed steps, and the shell hooks of scenarios run there — gets the same
  `env:` of every process service and `DEMO_STUDIO_SANDBOX` on top of Demo Studio's own environment (its own `env:`
  wins): a seed's `npm run db:reset` reaches the sandbox's `DATABASE_URL`, never the one your shell or a `.env` file
  points at. A variable the services do not set comes from Demo Studio's environment as usual.
- **Logs**: `.demo-studio/sandbox/<env>/logs/<service>.log` (git-ignored), the previous start's kept as `.log.1`, cut
  at 20 MB before a take (a sandbox may stay up for days). A service that exits while it starts fails `up` at once
  with its exit code and the last 20 lines of its log.
- **Health**: the service's `health` (default a `GET` of its `url`: 200–399; or `{path|url, status, text,
  timeout_s, interval_ms}`, or `{tcp: port}`; `false`: none), then every page it serves must answer HTTP (any status:
  a sign-in redirect is fine; `health: false` keeps this). 60 s by default; every `run --sandbox` checks it again.
  Errors name the check, its last failure and the number of tries: `sandbox sandbox: service fixture is not healthy
  after 60 s — GET
  http://localhost:4501/api/health: connection refused (238 tries) — last lines of …/fixture.log: …`.
- **Ports**: before a service starts, every port of its `url`, `pages` and `health` must be free — `port 4501
  (service fixture, url) is in use by another program (node, pid 81234) — stop it or change the port in
  sandbox.yaml` (lsof names it) —, and once it is healthy its own processes must listen on each of them (it waits for
  that until the health timeout: a service binds a port when it is ready; `nothing listens on port 4702 (service web,
  url) after 60 s` otherwise) and no other program may: another one would answer part of the traffic, health checks
  included. The mailbox's and the databases' ports are checked by the reset (only what the sandbox owns, above).
- **Identity**: a service is its pid, its start time and the machine's boot time (`state.json` next to the logs; it
  is written as soon as the process exists, before anything is awaited), so a pid the system gave to another program
  is never signalled, and after a reboot nothing recorded is ours. A service whose first process exited while its
  children run (a dev server's wrapper) is still running when one of those children is a process recorded in its
  group once it was healthy (each `up` records them again): a group of that id with none of them may be another
  program's after a pid reuse, and is left alone (`down` says nothing ran; its ports, if held, are named).
- **Stop** (`down`, a restart): `SIGTERM` to the whole group, `SIGKILL` after `stop_timeout_s` (default 10), then the
  processes it started outside its group (a browser launched detached, as Playwright does) are stopped too; a port
  still held afterwards is named in a warning. Services sandbox.yaml no longer declares are stopped by the next `up`
  or `down`.
- macOS and Linux only (process groups).

**The fixture's sandbox.** `projects/northfield-fixture/sandbox/sandbox.yaml` (environment `sandbox`) starts the
fixture server on ports of its own — 4501 / 4502 (open console and shop: the health API) and 4503 / 4504 (the
signed-in side: its pages, shown as `console.northfield.example` / `shop.northfield.example`) — so it never meets a
fixture started by hand on 4401–4404. Its seed is the fixture's reset API (seed data, demo clock at 2 Nov 2026 10:24,
mailbox emptied), its mailbox the fixture's Mailpit-compatible API, its accounts the fixture's supplier and buyer
(their invented passwords written in plain: masked in every log). The scenario `sandbox-quote` has no setup or
teardown hook on purpose: the buyer opens the quotes list, requests a quote and opens it — two takes with
`--sandbox` capture the same latest quote and the same `Q-1043 · requested Today, 10:24` even when the sandbox was
used in between; with `--env sandbox` instead (no reset) the reference moves on.

**The docker-compose provider** (`provider: docker-compose`) runs the services of the compose files (`compose.files`,
default `compose.yaml` next to sandbox.yaml) with the `docker` CLI (Docker Desktop, OrbStack or Docker Engine, with
Compose v2.17 or later; `$DEMO_STUDIO_DOCKER` names another binary). The services of sandbox.yaml are the compose
services that serve pages (their `url`, `pages`, `health`); every other compose service (a database, Mailpit, a
worker) counts too, judged by its own healthcheck.

- **A project of its own**: `compose.project`, else `demo-studio-<project>-<environment>-<8 hex of the folder's path>`
  (two checkouts of a project never share containers or volumes). Every command — `up`, `down`, `status`, `reset`,
  `logs`, an `exec` step, a restart — reads the project's containers first: containers of that name made from another
  folder (another checkout given the same `compose.project`) refuse it, never read, reset or touched. Every call names
  the project, its folder and its files, and runs without the shell's `COMPOSE_*` variables (a `COMPOSE_PROFILES`
  would change what starts).
- **A renamed `compose.project`**: the name an earlier `up` used stays in the state until nothing of it is left. While
  its containers run, `up` refuses (`compose project … — the name an earlier up of this sandbox used (compose.project
  changed since) — is still running: studio sandbox down …`); `status` says what it left (containers, volumes);
  `down` takes it down too, from its folder, and `down --volumes` removes its volumes — only then is it forgotten.
- **`up`**: no container of another compose project (or none of compose) may publish a port the compose files
  publish, on any address (`docker ps --filter publish=<port>`: OrbStack lets a container publish `[::1]:4601` or
  `[::]:4601` next to the sandbox's `127.0.0.1:4601`, and `localhost` reaches `::1` first — `port 4601 (service db,
  published) is also published by container other-db-1 of compose project other (on [::])`); every port the compose
  files publish must be free — any listener refuses it, named (`port 4601 (service db, published) is in use by another
  program (postgres, pid 812)`): Docker on macOS lets a container publish a port another program holds, and that
  program then answers part of the traffic — except those this project's running containers hold; every port of
  sandbox.yaml's services must be one the compose files publish. Then `docker compose up
  -d --wait --wait-timeout <s> --remove-orphans` (`<s>`: the longest `health.timeout_s` of sandbox.yaml, default 120;
  its output in `.demo-studio/sandbox/<env>/logs/compose-up.log`, and on the terminal with `--verbose`). Its exit code
  is not trusted (`--wait` can exit 0 when it times out): every container must then run, healthy or without a
  healthcheck, or `up` fails with each one's state and the last 30 lines of its logs (`db: running, health starting
  (not healthy yet)`). Then the container runtime alone must listen on the published ports and no other project's
  container may publish them (checked again: one may have started meanwhile), every service of sandbox.yaml must pass
  its health check (120 s by default; a `{tcp: …}` check is refused here: a published port always accepts a
  connection), and the server of every Postgres database of `databases` must answer `SELECT 1` on it (a database that
  does not exist yet — the seed creates it, or an interrupted restore dropped it — or that is closed to connections
  counts: its server answers, and the reset repairs it). pg is given the host and port explicitly, never the URL.
- **The address Docker publishes on**: the health checks, pg (`SELECT 1`, the snapshot), the seed's `sql` steps and
  the mailbox's emptying connect to the address a port is published on — `127.0.0.1` (or `::1` for an IPv6-only
  publish) — instead of resolving a host name such as `localhost` (an address written in the URL is used as it is);
  an http check keeps its URL and `Host` header. What the take itself
  opens — the browser's pages, `wait_for_email`, an `http` seed step — connects where its URL says: the checks above
  run right before every take (`run --sandbox` goes through `up`).
- **`exec` seed steps** run a command inside a running service (`docker compose exec -T`): a string with `sh -c`, or
  argv; `env` values are passed through docker's environment, never its command line; `timeout_s` (default 300); the
  output goes to `logs/seed.log`, secrets masked (the values it resolved, the sandbox's plain passwords). The hosts its
  rendered command and `env` name are checked like a shell hook's: a service of the compose files, localhost, a page
  or `allow_hosts` host — never a host of a production or read-only environment (a host computed inside the container
  is not seen). Every process it starts carries `DEMO_STUDIO_EXEC=<token>`: Ctrl-C or the timeout stops them inside
  the container too (SIGTERM, SIGKILL 3 s later, through `sh` and `/proc`; an image without them gets a warning naming
  `docker compose restart <service>`), and Ctrl-C stays an interrupt (exit 130). Migrations and an application's own
  seed belong here: a one-shot container in the compose file fails `up --wait` when it exits.
- **`status`** shows every compose service with its container, docker's status and its health; **`logs`** reads
  `docker compose logs --tail` per service (`--follow` keeps reading until Ctrl-C); **`down`** is `docker compose down
  --remove-orphans`, plus `--volumes` when asked, never `--rmi`.
- A failed or interrupted `up` (or take) stops the containers that command started (`docker compose stop`: their
  logs stay readable); a second Ctrl-C kills them.
- Tips for the compose file: publish on `127.0.0.1` (`"127.0.0.1:4600:8080"`); give every service a healthcheck that
  checks `127.0.0.1` (small images resolve `localhost` to `::1` first); for Postgres, `pg_isready -h 127.0.0.1` (without
  `-h` it says ready while the init scripts still run); `init: true` for a program that runs as PID 1 and ignores
  SIGTERM; a `logging: {options: {max-size: 10m}}` (docker's default log never rotates).

### `studio sandbox init`

```sh
studio sandbox init my-product                 # sandbox/ + `sandboxes: {sandbox: sandbox/sandbox.yaml}` in project.yaml
studio sandbox init my-product --env demo      # another one: sandbox/demo/, its own ports
studio sandbox up my-product                   # it comes up as written: a placeholder page, seeded, snapshot taken
```

It writes a docker-compose sandbox that validates and comes up as it is: `sandbox.yaml` (strategy `snapshot`, the
page `app`, a sql seed step, the database and the mailbox), `compose.yaml` (`app`: a placeholder page served by busybox
`httpd`; `db`: `postgres:17-alpine` with a named volume and a `pg_isready -h 127.0.0.1` healthcheck; `mailpit`:
`axllent/mailpit` pinned to an exact version, its version check off), `seed/01-demo-data.sql` (an invented table),
`app/index.html` and a `README.md` saying how to put the application in it (its `build:` or `image:`, the database
and SMTP settings, migrations and seed as `exec` steps, accounts, `reset.restart`). Ports are picked free from 4600
upward, skipping the ports of the project's environments and other sandboxes, all published on 127.0.0.1; the demo
database password is `pg-sandbox-<port>` (a one-word password would be masked wherever that word appears in the logs).
project.yaml gets its `sandboxes:` entry as a text edit — nothing else of the file changes: appended (before a `...`
document end), after the last entry of a block `sandboxes:`, or inside a one-line `sandboxes: {…}`; its line endings
are kept (a flow mapping over several lines goes through the YAML library, comments kept, lines never folded). A file
the scaffold would write that already exists (`sandbox.yaml`, `compose.yaml`, `README.md`, `seed/…`, `app/…`) stops
it, named, before anything is written; `--force` writes the scaffold over them (project.yaml is left as it is);
`--json` prints the files and ports.

### Snapshot reset (Postgres)

With `reset: {strategy: snapshot}` (docker-compose only), the sandbox's database (`reset.snapshot.database`, a key of
`databases`, default the first) is copied as a template database `<db>__ds_snapshot` right after the seed, and every
reset drops the database and creates it again from that copy — a file-level copy inside Postgres, with no `pg_dump`
on this machine:

```sql
-- after the seed (take)
ALTER DATABASE "app" WITH ALLOW_CONNECTIONS false;            -- the app's pool cannot reconnect during the copy
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app' AND pid <> pg_backend_pid();
ALTER DATABASE "app__ds_snapshot" WITH IS_TEMPLATE false;     -- a retake only, when it exists
DROP DATABASE IF EXISTS "app__ds_snapshot" WITH (FORCE);
CREATE DATABASE "app__ds_snapshot" TEMPLATE "app";            -- STRATEGY left to the server (WAL_LOG from 15)
ALTER DATABASE "app" WITH ALLOW_CONNECTIONS true;
ALTER DATABASE "app__ds_snapshot" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true;
COMMENT ON DATABASE "app__ds_snapshot" IS 'demo-studio snapshot <seed hash>';
-- before every take (restore)
ALTER DATABASE "app" WITH ALLOW_CONNECTIONS false;
DROP DATABASE IF EXISTS "app" WITH (FORCE);                   -- its sessions are terminated
CREATE DATABASE "app" TEMPLATE "app__ds_snapshot" OWNER "<owner at the take>";
```

- **Only the sandbox's own database**: the database's port must be published by a running service of the sandbox's
  compose project, made from its folder, nothing else may listen on it and no other project's container may publish
  it — a `localhost:5432` that is another stack's Postgres is refused; pg connects to the address the port is
  published on (`127.0.0.1`), never to `localhost`. Postgres 13 or later (`DROP DATABASE … WITH (FORCE)`). The role of the URL needs to drop and create
  databases and terminate the app's sessions: the compose image's `POSTGRES_USER` (a superuser) can.
- **When the snapshot is stale** it is taken again, after the seed: the seed hash (seed steps, the files they read,
  `seed/`, the images of the compose services — `up --build` with new migrations makes it stale) differs from the one
  in the state file or in the template's comment, the template is gone (`down --volumes`), or `reset --reseed` asks.
  After a change the hash cannot see (a script outside `seed/`, data an `exec` step fetches), run `studio sandbox
  reset <project> --reseed`.
- **Robust to interruptions**: every reset first lets connections in again when an interrupted reset left them
  blocked, recreates the database when an interrupted restore dropped it, and nothing between `DROP` and `CREATE`
  stops for Ctrl-C; `up` resets a sandbox whose database an interrupted reset left missing or closed, even when its
  seed is current.
- **What a restore keeps**: rows, sequences, indexes, extensions, large objects. Not copied: `ALTER DATABASE … SET`
  settings (set them in the compose file's `command` or per role) and the database's comment.
- **The app's connections**: the restore terminates them. Many pools reconnect on the next query (node-postgres,
  Rails 7.1+); others fail the first query after a restore (older Rails, a connection held open). An idle
  node-postgres client emits an `'error'` on its `Pool` — without a handler the process crashes —, and a client held
  in an open transaction stays broken. If the first page of a take fails, add
  `reset: {restart: [app]}` (the app restarts after every reset) and make its health path read the database.
- **Seeds start from a clean state**: a seed runs on the database as it is (after a take, with its changes), so it
  drops or truncates what it creates (the scaffold's drops its table first). A plain `pg_dump` file (`COPY … FROM
  stdin`, `\connect`) is refused by sql steps: dump with `pg_dump --inserts`, or load it with an `exec` step (`exec:
  {service: db, command: "psql -v ON_ERROR_STOP=1 -U demo -d app -f /seed/dump.sql"}`, the file mounted in the db
  service).
- **How fast** (Postgres 17 in OrbStack on an Apple M4, measured with the init scaffold): the scaffold's 5-row seed
  takes 20–30 ms to run and its snapshot restores in 40–300 ms, so `reseed` is as fast there. With a realistic seed —
  600 000 rows and two indexes, a 114 MB database — the seed takes 1.3–1.9 s (`reseed`: a 1.5–2.1 s reset) and the
  snapshot restores in 230–300 ms (the first one after a take ≈ 0.7 s): a 0.5–0.6 s reset, docker checks included.
  The take after the seed costs 0.45–0.75 s. `studio sandbox reset` prints both times.

### The fixture's Docker sandbox (Mailpit)

`projects/northfield-fixture/sandbox/docker/` (environment `sandbox-docker`, provider docker-compose) is the same
sandbox in Docker, the example of a docker-compose sandbox that runs a real product: the fixture server in a
container built from `fixtures/wholesale/Dockerfile`, and **Mailpit** (`axllent/mailpit:v1.29.4`) receiving its mails
over SMTP. Same pages (signed-in side), seed (`POST {{console}}/api/reset`) and accounts as `sandbox`; ports 4511–4514
for the fixture (the same numbers inside the container, so the links in its mails stay right) and 4525 for Mailpit —
its API is the sandbox's mailbox, and http://localhost:4525 shows what the fixture sent.

```sh
node fixtures/wholesale/build.mjs        # the UI bundle the image copies (again after a UI change, then up --build)
studio sandbox up northfield-fixture --env sandbox-docker       # builds the image the first time, starts, seeds
studio run northfield-fixture sandbox-quote --env sandbox-docker --sandbox
studio run northfield-fixture signup --env sandbox-docker --sandbox    # wait_for_email reads the real Mailpit
studio sandbox down northfield-fixture --env sandbox-docker
docker image rm $(docker images -q --filter 'reference=demo-studio-northfield-fixture-*')   # the image (down keeps it)
```

- **The image**: `node:22-alpine` (≈ 160 MB, pulled once) plus the server and the bundle (≈ 4 MB): no `npm install` —
  the server needs no npm package at run time (esbuild is loaded only to build the bundle, playwright-core only to
  print a PDF) — and the build context is `fixtures/wholesale` with a `.dockerignore` that keeps only what the server
  reads. A missing bundle stops the build with the command to run. It runs as `node` (not root), on every interface
  of the container, with a `HEALTHCHECK` on `http://127.0.0.1:<console port>/api/health`; the compose file adds
  `init: true` and publishes every port on 127.0.0.1. No `image:` in the compose file: the image is named after the
  compose project (`demo-studio-northfield-fixture-sandbox-docker-<hash>-fixture`).
- **No Chromium in the image**: the quote PDF (`/quotes/<id>/quote.pdf`) answers 500 there. `sandbox-quote` and
  `signup` do not open it; film `quote` (its "Download quote PDF") on the process sandbox or on `local`.
- **Mail**: with `NORTHFIELD_SMTP=mailpit:1025` the fixture delivers every mail it sends to Mailpit too (a small SMTP
  client on `node:net`, fixtures/wholesale/README.md), next to its own Mailpit-compatible mailbox. Each reset empties
  Mailpit (`DELETE /api/v1/messages`) and the fixture's mailbox (its reset API).
- Measured on this Mac (OrbStack): the first `up` 8.5–12 s with the image build, a reset 100–150 ms; two takes of
  `sandbox-quote` with a quote and a sign-up made between them captured the same `Q-1042` and `Q-1043 · requested
  Today, 10:24`; `signup`'s confirmation mail came from the real Mailpit in 0.5 s, its inline logo included.

### Recipes

```yaml
# A dev server on this machine (process): a string runs with sh -c and PATH (argv [node, …] runs Demo Studio's Node).
# Its database is one of its own (a Postgres you run for the sandbox alone, on 4702) — never your development one.
services:
  web:
    command: "npm run dev -- --port 4701"
    cwd: ../..
    env: {DATABASE_URL: "postgres://demo:sandbox-db-4702@localhost:4702/app"}
    url: http://localhost:4701
    health: {path: /api/health, timeout_s: 120}     # a path that reads the database
    pages: {app: {url: http://localhost:4701, display: app.example.com}}
seed:
  # Gets web's DATABASE_URL (and DEMO_STUDIO_SANDBOX), not the one of your shell or .env: it resets the sandbox's data.
  - shell: {run: "npm run db:reset && npm run db:seed", cwd: ../..}
databases:                    # for sql steps and scenario sql hooks: that Postgres is not started by the sandbox
  main: {url: "postgres://demo:sandbox-db-4702@localhost:4702/app", external: true}
```

```yaml
# An application in compose (docker-compose): migrations and its own seed inside its container, then a snapshot.
seed:
  - exec: {service: app, command: "bin/rails db:prepare db:seed", timeout_s: 600}
  - exec: {service: redis, command: [redis-cli, FLUSHALL]}   # state outside Postgres: emptied by the seed
reset:
  strategy: snapshot
  restart: [app]              # a service of sandbox.yaml: its pool starts fresh after each restore
```

- **Mail**: point the app's SMTP settings at `mailpit:1025` inside the compose network and declare `mailbox:
  {provider: mailpit, url: http://localhost:<published 8025>}`; `wait_for_email` then reads it, and every reset empties
  it.
- **Two takes at the same time**: a second sandbox (`studio sandbox init <project> --env demo-2`, its own ports and
  compose project).
- **A sign-in that survives the reset**: none — a reset drops the sessions the app stored, so the accounts sign in
  again off camera before every take (`accounts`, above).

### A "stage" sandbox: images of a production build

A product shipped as images (a registry's builds) is filmed from the same build every take with a docker-compose
sandbox whose versions and settings live in a `.env` next to its compose file — the stage of the product, on this
machine, with demo data:

```yaml
# sandbox/stage/compose.yaml — the product's images, published on 127.0.0.1 only
services:
  app:
    image: registry.example.com/acme/app:${APP_VERSION}
    environment: {DATABASE_URL: "postgres://demo:stage-db-4932@db:5432/app", SMTP_URL: "smtp://mailpit:1025", FEATURE_FLAGS: "${FEATURE_FLAGS}"}
    ports: ["127.0.0.1:4901:3000"]
    depends_on: [db]
  worker:
    image: registry.example.com/acme/worker:${APP_VERSION}
    environment: {DATABASE_URL: "postgres://demo:stage-db-4932@db:5432/app"}
  db:
    image: postgres:${POSTGRES_VERSION}
    environment: {POSTGRES_USER: demo, POSTGRES_PASSWORD: stage-db-4932, POSTGRES_DB: app}
    ports: ["127.0.0.1:4932:5432"]
  mailpit:
    image: axllent/mailpit:v1.29.4
    ports: ["127.0.0.1:4925:8025"]
```

```sh
# sandbox/stage/.env — what docker compose reads for the ${…} above
APP_VERSION=2.14.0
POSTGRES_VERSION=17-alpine
FEATURE_FLAGS=new-invoices
```

```yaml
# sandbox/stage/sandbox.yaml
version: 1
provider: docker-compose
services:
  app: {url: http://localhost:4901, health: /up, pages: {app: {url: http://localhost:4901, display: app.example.com}}}
  mailpit: {url: http://localhost:4925, health: /api/v1/info}
seed:
  - exec: {service: app, command: "bin/setup-demo-data", timeout_s: 600}
reset: {strategy: snapshot, restart: [app, worker]}
databases:
  main: {url: "postgres://demo:stage-db-4932@localhost:4932/app"}
mailbox: {provider: mailpit, url: http://localhost:4925}
```

- **The env file reaches every compose command** (`--env-file`): `.env` next to the first compose file, or
  `compose.env_file` (relative to sandbox.yaml; `false`: none). The names it sets are left out of the environment
  docker runs with, like every `COMPOSE_*` variable of the shell: an `APP_VERSION` exported in your shell never
  changes the build a take films. A `COMPOSE_PROFILES` in it is refused (it would start other services than
  sandbox.yaml says). Checked against the real `docker compose config`: the file's tag wins over the shell's
  (`packages/sandbox/test/compose-env.test.ts`).
- **Another version** is another product: the env file's hash is part of the seed's inputs (with the images' ids), so
  the next `up` seeds again and a snapshot taken with the previous one is stale.
- `studio sandbox up <project> --env stage` pulls the images the first time (`docker login` to a private registry
  first, in your terminal); `studio run <project> <scenario> --env stage --sandbox` resets it before each take.

### Limits

- **Determinism.** A reset makes equal what the seed builds; not what the app does while it is filmed or between the
  reset and the take:
  - server-side timestamps (`created_at = now()`) are the time of the take — the fixture's demo clock restarts at each
    reset, a real app's clock does not;
  - UUIDs and random tokens differ between takes (it matters only when one is on screen);
  - state outside the reset database — Redis, a search index, uploaded files in a volume, an in-memory cache — stays
    as the last take left it unless a seed step or `reset.restart` clears it; background workers may act between the
    reset and the capture;
  - the first request after a snapshot restore may fail on a pooled connection the restore cut (`reset.restart`, a
    health path that reads the database).
- **No implied clock.** `--sandbox` never sets the browser clock: `clock:` stays explicit (project or scenario). A
  pinned browser clock next to real server timestamps shows "created in 3 weeks"; giving the server a clock is the
  app's business (BACKLOG BL-68: the project clock passed to the sandbox's services).
- **Local only**: every sandbox URL is loopback; a sandbox never runs on another machine (BACKLOG BL-69: remote and
  CI sandboxes).
- **What a take connects to** (docker-compose): the browser's pages, `wait_for_email` and `http` seed steps use their
  URL as written (`localhost` reaches `::1` first). The checks that no other container publishes the sandbox's ports
  run right before every take; one started during the take is not noticed — keep a sandbox's ports apart from other
  stacks' and publish them on `127.0.0.1` (BACKLOG BL-69: pinning those too).
- **Snapshots**: Postgres only, in the sandbox's own compose project; MySQL, SQLite and external databases use
  `reseed` (BACKLOG BL-67).
- **Process provider**: macOS and Linux; a program that leaves the service's process tree (a daemon re-parented to
  init) can keep running after `down` — a warning names whoever still holds the service's ports.
- **Disk**: `down` never removes images, and builds leave Docker's build cache; `docker image rm` and the usual Docker
  tools reclaim them.

## MCP: Claude drives Demo Studio

`studio mcp` is an [MCP](https://modelcontextprotocol.io) server over stdio: a Claude session (Claude Code, Claude
desktop, any MCP client) lists the projects, reads a README, writes and validates scenarios and reads runs, sessions
and sandboxes through tools, dry-runs and captures scenarios, runs hooks and resets environments, and the CLI and the
server share one engine (`@demo-studio/engine`): a dry run, a capture or hooks started here run the same code as
`studio run` / `studio hooks run` / `studio env reset`. Hooks that need a human are approved by the user through an
approval form the client shows (MCP elicitation). Sign-ins (a window for the human) and sandbox start / reset are jobs
too, and so are renders: Claude previews the plan of a capture, renders it with another theme or edit overrides (no
scenario change) and follows the render — the render runs guarded (only files of the project, no network) —, reviews
it (the contact sheet comes back as images Claude looks at) and exports it to delivery formats. To write a scenario,
Claude inspects the product's pages (`page_inspect`: a marked screenshot and the visible elements with targets the
runner resolves) and writes the YAML itself — no tool writes a scenario for it or calls a model (`scenario_from_script`
only turns a timecoded table the user hands into a skeleton), or the **user** shows the flow once in a window
(`scenario_record`: Claude starts the recording and reads the draft, never drives it). Claude also lists and
previews themes and components (stills come back as images), checks components and scaffolds new ones, and makes a
new theme from the brand files the user put in the workspace, or from a draft read off a public site whose URL the
user approves (`template_from_site`) — component code, existing themes and project.yaml are
never written through the server. People comment frames of a render (`studio comment add`); Claude lists the comments
with their anchor and still, adapts the video, replies and resolves them with the new render (see
[Frame comments](#frame-comments)).

**Registering it.** `studio mcp --print-config` (from your workspace, or with `--root <workspace>`) prints the JSON
block and the `claude mcp add` command with absolute paths (in this repository run `node packages/cli/dist/bin.js mcp
--print-config`: `pnpm studio …` prints a banner before the JSON). An extra `-e NAME=value` goes **before** the `--`.
It also prints the lines that install the **Claude Code plugin** instead (the Demo Studio skills and this server, from
the repository's local marketplace; see [`skills/README.md`](skills/README.md)) — use one or the other, not both, or
Claude Code gets two `demo-studio` servers:

```sh
# Either: Claude Code, for every project of this user (what --print-config prints, shortened):
claude mcp add demo-studio --scope user -e PATH=<…> -- <node ≥ 22> <repo>/packages/cli/dist/bin.js --root <workspace> mcp
# Or: the plugin, enabled in the workspace folder only (+ --config home=<…> when DEMO_STUDIO_HOME is set):
claude plugin marketplace add <repo>
cd <workspace> && claude plugin install demo-studio@demo-studio --scope local --config node=<node ≥ 22> --config studio=<repo>/packages/cli/dist/bin.js --config workspace=<workspace>
```

```json
{ "mcpServers": { "demo-studio": {
    "command": "/Users/you/.local/share/mise/installs/node/22/bin/node",
    "args": ["<repo>/packages/cli/dist/bin.js", "--root", "<workspace>", "mcp"],
    "env": { "PATH": "<node's folder>:…:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "DEMO_STUDIO_HOME": "<only when you set it>" } } } }
```

- Claude Code: the `claude mcp add` line (per user), or the JSON in a `.mcp.json` at the workspace root (per project);
  `/mcp` in a session shows it connected.
- Claude desktop: the JSON in `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart it
  (not tested yet).
- The command is an **absolute Node.js ≥ 22**: GUI apps do not see mise / nvm shims and the default `node` may be
  older. `--print-config` names a path that survives patch upgrades where there is one (mise's `installs/node/22`,
  an nvm `node/22` alias folder, Homebrew's `opt/node@22`). After a Node.js major upgrade, print it again.
- `env.PATH` is your current PATH plus Homebrew's folders (a GUI client's PATH lacks them; the engine runs ffmpeg,
  docker and psql), without the folders a package manager adds for the script it runs (`node_modules/.bin`,
  corepack) and without relative entries (`.`, `bin`: they would resolve in the client's project folder). `studio
  mcp` completes the PATH it is started with the same way, so a client that passes none (the plugin, Claude desktop)
  still finds those tools. Secrets the `{{env:…}}` references of project.yaml need go in `env` too (or in the
  keychain): a GUI client does not read your shell profile; the plugin carries none. `DEMO_STUDIO_HOME` is carried
  over when set (the plugin: its `home` value, which replaces an inherited `DEMO_STUDIO_HOME`; empty: `~/.demo-studio`).
- The plugin loads in place from `skills/`: `git pull` + a new session (or `/reload-plugins`) updates the skills; run
  the install line again to change a value. `claude --plugin-dir skills` is for editing the skills: that session loads
  the plugin as `demo-studio@inline`, which hides an installed one and has none of its values, so **its MCP server is
  missing** (`/plugin configure` in that session, or the `claude mcp add` registration).
- Without a workspace (`--root`, `DEMO_STUDIO_ROOT` or a `studio.yaml` above the folder it starts in) it refuses to
  start, on stderr, exit 2. stdout carries the protocol only.

**Over HTTP.** `studio mcp --http` serves the same tools, instructions and approval forms as Streamable HTTP at
`http://127.0.0.1:47820/mcp` (`--port N` for another port; `0`: a free one) until Ctrl-C, for a client that registers
a URL rather than a command. The server checks a bearer token: a stable one, created once in the studio home
(`~/.demo-studio/mcp-http.token`, mode 600), so the registration survives restarts; `--rotate-token` replaces it (then
register again). `studio mcp --print-config --http` prints the registration, and never the token itself:

```sh
# Claude Code, for every project of this user: the shell reads the token from its file as the line runs
# (your shell history keeps "$(cat …)", not the token; Claude Code keeps the header in its own user settings)
claude mcp add --transport http demo-studio http://127.0.0.1:47820/mcp --scope user --header "Authorization: Bearer $(cat ~/.demo-studio/mcp-http.token)"
# Or the JSON it prints in .mcp.json at the workspace root — "Authorization": "Bearer ${DEMO_STUDIO_MCP_TOKEN}", no
# token in the file (safe to commit) — with the variable set where claude starts (your shell profile):
export DEMO_STUDIO_MCP_TOKEN="$(cat ~/.demo-studio/mcp-http.token)"
```

Use it **instead of** the stdio registration, not beside it, and keep `studio mcp --http` running (a terminal, a login
item). While `claude mcp add` runs, the token is in its command line (visible to your own account's `ps`). Each MCP
session keeps its server, so an approval form reaches the client that asked. At most 8 sessions: a session in use (a
call running, or the client's event stream open) never expires and is never closed for another; one not in use is
closed after 30 min, or at once when a new client needs its place (a Claude Code that restarted without saying
goodbye). The token is a secret: whoever holds it drives this workspace's tools and answers their approval forms — as
the client that spawns `studio mcp` over stdio does; never paste it into a file you commit. See [Security](#security)
for what the server refuses.

**Tools.**

| Tool | Does | Writes |
|---|---|---|
| `engine_info` | version, workspace root, features; `started_in` (the folder the client started the server in) and whether it is outside the workspace | — |
| `project_list` | projects: slug, name, folder, scenarios, environments (a broken one with its error) | — |
| `project_get` | README + `readme_hash`, scenarios, environments (pages, display URLs, production / access, sandbox, persona names) and project.yaml with its defaults | — |
| `project_create` | a project folder (README, project.yaml, scenarios/, hooks/, assets/, .gitignore); refuses an existing slug | new files only |
| `project_update_readme` | replaces README.md; `if_match` = `readme_hash` once it exists | README.md |
| `project_prune` | what `runs/`, `renders/` and `review/` hold that nothing needs (failed takes, dry runs, older captures and renders: `studio prune`), with the bytes it frees; `dry_run` (default true) only lists, `dry_run: false` deletes (annotated destructive) — only when the user asked to free space | `runs/`, `renders/`, `review/` (deleted) |
| `scenario_get` | a scenario's YAML and its sha256 `hash` | — |
| `scenario_validate` | issues of YAML text (line / col), nothing saved | — |
| `scenario_save` | validates, then writes `scenarios/<name>.yaml`; refuses errors; overwriting needs `if_match` (the hash `scenario_get` gave; a conflict names the current one); a new one takes `if_match: null` | the scenario |
| `page_inspect` | what a page shows, for writing steps (see *Authoring* below): `page` (+ `path`) or `url` (an origin of the environment's pages only), or `scenario` + `until` (a dry replay up to that step; a failing step is inspected where it failed); `persona`, `within` (list only inside a target), `targets` (≤ 20 of your own, checked), `limit` (default 80, ≤ 300), `images` (`marked` default, or `none`), `detail` (`compact` default, or `full`); a job, waits up to `wait_s` (default 25). Returns counts, open popups and the marked screenshot as an image; compact (L5.8): the elements in view or in a dialog, menu or popover, each as its mark, context, action and step hint as one line of YAML (`matches`, `fragile` and state flags only when set), page text under `untrusted`; `full`: every element with its box, state, texts, verified target, and the scroll containers | `.demo-studio/inspect/<id>/` |
| `scenario_record` | a recording the **user** performs (see [Recording a scenario](#recording-a-scenario)): `page` (+ `path`) or `url` (an origin of the environment's pages only), `persona`, `scenario` (the draft's name; saved only when free), `check` (default true); a job returned at once — a browser window opens on the user's machine, the user performs the flow and closes it (Claude never drives it), the window holds the queue (≤ 30 min); `job_status` then returns counts, the saved file and hash, the check replay, issue counts, and the draft (`draft_lines`), its scene ids and issues under `untrusted`; `job_cancel` while the window is open discards it | `.demo-studio/records/<id>/`; `scenarios/<name>.yaml` when free; the environment, through what the user does in the window (read-write environments) |
| `scenario_from_script` | an optional aid, only when the user hands a timecoded script table (see *Authoring*): an outline and a skeleton draft (one `hold` per beat, the action as its `note`) validated against the project, the script's issues with line / col, timing warnings; `env` (page keys of that environment), `name` (the draft's `video`) | — |
| `run_list` / `run_status` | runs of a project; one run's status, step, hooks, where it failed, the take's cost in one line, the paths of capture.mp4, timeline.json and the screenshots folder, and the state of its job (queued and its place, interrupted…); `detail: "full"` adds every output with its sha256, each dry-run screenshot and the take's measurements; `wait_s` (≤ 25) waits for it to finish | — |
| `run_dry` | dry-runs a scenario (`until`, `env`, `hooks`) as a job and waits up to `wait_s` (default 20): one screenshot per step, where it failed | runs/ (the run) |
| `run_capture` | captures a scenario as a job (`env`, `sandbox`) and returns at once with the run id | runs/ (the run); the environment through its setup / teardown hooks |
| `run_cancel` | cancels a run started here: queued, it never starts; running, it stops at its next step and its teardown and rollbacks still run | — |
| `plan_preview` | plans a render of a capture without rendering it (`run_id` default: the scenario's latest capture; `template`: a theme name; `overrides`: frame, variant, fps, scale, intro / outro / captions / camera / trim_idle, speeds, transition, components by kind or segment, music, tutorial): variant, size, duration, theme, segments with their component and timing, music, the id the next render would get, `edit` (`scenario`: today's scenario file re-planned on the run's take, with `edit_changes`; `run`: the run as captured), `scenario_changed` (the filmed part of the scenario changed since the run, listed in `filmed_changes`: a line in the summary names the `run_capture` that films the change, and the last line says to capture first instead of offering the render); captions, warnings and the text summary under `untrusted` | — |
| `render` | the same arguments: planned and checked, then rendered as a job; returns the reserved `render_id` at once (`<scenario>-v<N>`, `-vertical` / `-square`), the `run_id` it renders (`latest`: the newest capture whose folder name is a run id, dated ids first) and `edit`, `scenario_changed`, `filmed_changes`, `edit_changes` as `plan_preview`'s; `wait_s` waits for it | `renders/<render_id>.mp4` + `.json` |
| `render_status` | a render by id (or `latest`, of a scenario): its job first — queued (with the job it waits behind, its stage and time left), running (stage, percent, frames, time left), failed / cancelled / interrupted — then its record (paths, duration, size, fps, theme, variant, overrides, timings, ffprobe); warnings and a failure's message under `untrusted`; `wait_s` long-polls | — |
| `review` | reviews a render (`render_id` or `latest` of a `scenario`; `fps` 1 or 2; `previous`: a render id or `false`) as a job and waits up to `wait_s` (default 20): finished in time, it answers as `review_get` | `review/<render_id>/` |
| `review_get` | a render's review: its newest review job (state, stage, percent), then the review — clean or not, counts, the findings that are not notes (severity, code, time, segment, scene; their messages under `untrusted`; at most 30 warnings besides every error), the diff with the previous render, the paths of the sheets and `report.md` (`detail: "full"`: the notes, durations per segment, every key frame and scene sheet) — and **images**: `images: "sheets"` (default: contact sheet pages and marker key frames), `"all"` or `"none"`; `wait_s` long-polls | — |
| `export` | exports a render as a job (`formats`, default `mp4_1080p`, `webm`, `gif_preview`; `vertical_9x16` / `square_1x1` / a 4K from a smaller master are re-rendered; `gif_start_s` / `gif_duration_s` ≤ 30 s) and returns at once; `job_status` follows it and lists the files | `exports/<render_id>/` + `manifest.json` |
| `comments_list` | the frame comments of a project (see [Frame comments](#frame-comments)): `scenario`, `render` (an id or `latest`: threads made on that render as it is now), `status` (`open` default, `resolved`, `all`), `limit` (default 20, ≤ 100); each thread's render (and whether it is still on disk), frame, time, region, anchor (segment, component, scene, step, `step_ref`, step fingerprint, action, page, marker, overlays, transition), `step_now` (that step in today's file, by id else fingerprint; null when gone), its last 10 entries with their channel (`entries_total` counts them all), the resolution, newer renders and its `hash`; the stills (region outlined) as images; the comment, replies, notes and author names under `untrusted` (at most 60,000 characters per result: the next threads are left out, `left_out_for_size`) | — |
| `comment_reply` | appends a reply to a thread (`comment_id`, `text` ≤ 2000 characters), written as `mcp`; returns the entry id and the new hash | `comments/<scenario>/<id>.json` (an entry) |
| `comment_resolve` | resolves an open thread: `note` (what changed), `render_id` (a later render of the same scenario and variant, or `latest` of that variant), `if_match` (required: the hash `comments_list` or `comment_reply` gave; a person's entry meanwhile = `conflict` with the current hash); written as `mcp`, reopened only by a person | `comments/<scenario>/<id>.json` (an entry) |
| `template_list` | the themes by name (the workspace's `templates/`, then the starters): source, the component each picks per kind, issues; `project` marks the project's own (and lists its own theme folder); `template` returns one theme in detail — template.yaml and its sha256, colours, fonts, brand, assets, each kind's component with its params | — |
| `template_preview` | stills of a theme (default the project's): its intro, its layout with its caption over a neutral sample screen, a card, an interstitial and its outro, 960×540, rendered as a job; waits up to `wait_s` (default 20) and returns them as images (4 inline, the 5th as a file) | `.demo-studio/previews/<id>/` |
| `template_from_site` | asks the user to approve the URL (elicitation; without it: `needs_approval` with the `studio theme from-site` command), then extracts a public page as a job (see [Themes from a site](#themes-from-a-site)): colour roles and swatches with contrast, logo candidates as `site:<id>/logo-<n>` PNGs, the screenshot and logos as images (a third-party page), the font names and every page string under `untrusted`, a draft brand input and the template.yaml it would make; waits up to `wait_s` (default 25) | `.demo-studio/site/<id>/` |
| `template_create_from_brand` | a **new** theme from the user's brand files (see [Themes from your brand](#themes-from-your-brand)): `name`, `base`, `colors` (hex; `accent` required), `background`, `adjust`, `logo`, `wordmark`, `fonts {display, body[]}` (files relative to the workspace root, outside hidden, `components/` and agent-writable folders; a logo or wordmark may be `site:<id>/logo-<n>` of `template_from_site`), `brand {name, url}`, `replace` (only an unchanged theme this tool made); returns the folder, template.yaml, the palette with every ratio and change, the fonts (their name strings under `untrusted`) and warnings; then `template_preview` | `templates/<name>/` (a new folder) |
| `component_list` | components by id (workspace first, then the built-in `studio/…`; `kind` filters): kind, version, source, description, slot names, the committed preview and whether it is fresh; registry notices (invalid, overriding) | — |
| `component_get` | one component: manifest (slots and their types, params JSON Schema with defaults, duration, geometry, preview samples), params with defaults, source files, README | — |
| `component_validate` | a component's issues (component.yaml, id vs folder, entry, the esbuild compile allowing react / remotion / the kit; nothing executed), positioned | — |
| `component_preview` | a still of one component with a theme (default the project's), the manifest's samples or your `slots` (text, url, color slots) and `params` (checked against its schema), `at_s`; a job, returned as an image like `template_preview`; never written into the component's folder | `.demo-studio/previews/<id>/` |
| `component_create` | scaffolds `components/<namespace>/<name>/` from its kind's template (component.yaml, index.tsx, README.md; `description` and `name` written as text), validated, no preview; refuses the `studio/` namespace and any built-in id | the new component folder |
| `job_list` / `job_status` / `job_cancel` | the jobs of the workspace (any session's), one job's state, progress and result (a preview's stills as images; an inspection as `page_inspect` returns it, marked screenshot included; a recording's draft), a cancel; `job_status {wait_s}` waits up to 600 s (a capture or a render followed in one call, a progress notification at least every 15 s); a run, render, preview, review, export, inspect or record job's error message is under `untrusted.error` | — |
| `hooks_run` | hooks outside a capture as a job: `reset`, `<scenario>:setup`, `<scenario>:teardown` or `hooks/<name>.yaml`, on `env`; **dry by default** (templated and security-checked, nothing executed, nobody asked: the result marks the hooks a real run needs approved); `dry: false` runs them, setup-like ones with a journal of rollbacks | the environment, through the hooks; `.demo-studio/journals/` |
| `env_reset` | as a job: replays every pending rollback (captures' and hook runs' journals, an interrupted job's too), then the project's `reset` hooks; dry by default | the environment; the journals |
| `auth_status` | each persona's last known session state and the `studio login` command a human runs (no live check, no browser) | — |
| `auth_login` | signs a persona in, as a job: `headed` (default) opens a browser window **on the user's machine** — the user signs in there and closes it, Claude is told to ask them and never sees a password; `auto` plays the persona's `login:` steps (their secrets come from the server's environment or the keychain). The result says whether the session works now (no path, no cookie). The window holds the queue until it is closed | the session, in `~/.demo-studio` |
| `sandbox_status` | a sandbox's services, health, seed, last reset, take lock (starts nothing) | — |
| `sandbox_up` | as a job: starts what is not running, checks health, seeds when it never was or the seed changed | the sandbox (its processes or containers, its data) |
| `sandbox_reset` | as a job: back to the seed (`reseed: true` runs the seed even when a snapshot could be restored); the sandbox must be up | the sandbox's own data |

Every result starts with a short summary for Claude, then the data as JSON (also as `structuredContent`) with local
paths it can read; an error is a tool error with a code (`not_found`, `invalid`, `conflict`, `refused`,
`needs_approval`, `busy`, `unavailable`, `cancelled`, `internal`), a message and, where one exists, the `fix`.

**Authoring: Claude writes the scenario.** The loop the server's instructions give: `project_get` (the README, the
environments and their page keys) → `page_inspect` each page the video shows → Claude writes the YAML itself, copying
the suggested targets and step hints → `scenario_validate` → `scenario_save` → `page_inspect {scenario, until: <the
step that opens a dialog or a menu>}` to see what that step shows, and write the next steps → `run_dry` → fix →
`run_capture`. No tool writes a scenario from a description and none calls a model: the client's model is the author.
- **What an inspection gives.** The visible interactive elements (labels merged into their field; inside open shadow
  roots and same-origin frames; cross-origin frames counted, closed shadow roots invisible), the open popup first, each
  with a number drawn on the screenshot, its box, state (disabled, expanded, checked, selected, covered by something
  drawn over it), context (page, dialog, menu, listbox, popover, row) and a **suggested target checked with the
  runner's own resolver**: it resolves to exactly that element (`matches: 1`), or to it by position (`nth`, flagged),
  and its YAML reads back as the same target. `fragile` says why it may break later: `nth`, `broader` (a looser text
  also matches), `dynamic_text` (digits, dates, prices), `css` (a stable id only). The action hint (`click`, `type
  {into}`, `select {field}` / `{combobox}`, `menu {row}`, `drop_file {zone}`) is checked through the runner's helper for
  that action, else marked unverified. `targets` checks Claude's own targets (how many elements, which one a step
  would use); `within` (R-MCP-23's selector, a target) lists only inside an element. Never a field's value — not even
  inside a label or a name (a `<label>Notes <textarea>` is "Notes").
- **A replay.** `scenario` + `until` replays a saved scenario as `run_dry` does (the environment's own access,
  production read-only), fast (cursor travel and holds capped at 0.2 s; navigation and popup waits kept), hooks never
  run (`replay.hooks: skipped`: data they prepare is missing) and irreversible steps shown but not executed
  (`replay.skipped_irreversible`). A step that fails is inspected where it failed (`at: failed_step`). Signed-in pages
  use their persona (`persona` overrides it for a page): a session that expired signs in again off camera when the
  persona has `login:` steps; otherwise nothing is inspected and the result names `auth_login` for the user.
- **Where it may go.** Only environment pages: a `url` must have the exact origin of one of the environment's pages
  (another port of localhost is another app: refused), no `{{…}}` template in anything given, no credentials in a URL.
  A page that ends on another origin (a redirect, a sign-in provider) is reported by its host alone
  (`landed_elsewhere`): no screenshot, no element — also when it leaves while it is inspected (each in-page read
  checks the document it read; a page script's own navigation elsewhere is stopped meanwhile). The page's URL is
  reported without its query or fragment. A host another project protects (production / read-only) is refused
  as for `run_dry`, and so is a scenario agent trust refuses. The checks run when the call is made and again in the
  worker (the scenario's bytes are pinned by their sha256).
- **Files.** `<project>/.demo-studio/inspect/<id>/`: `inspect.json` (the whole report), `screenshot.png` (the viewport,
  cursor hidden, at the capture scale), `marked.jpg` (numbered boxes of the elements in view, except those something
  is drawn over), and the dry replay's run.json, log and step-failure screenshot; the newest 20 inspections are kept
  (never one whose job is queued or running; `job_status` says when a finished one was pruned since). Never in `runs/`: `run_list`,
  `latest` and reviews do not see them. A result over 80 kB drops elements from its end (`truncated`; inspect.json has
  them all). An inspection counts nothing in the history. `studio inspect` does the same from a terminal (no queue;
  `--json` prints the report).
- **An aid when the user hands a timecoded table: `scenario_from_script`.** Not the start of the loop, a skeleton to
  rewrite through it. It reads the first Markdown pipe table of `script_markdown` (≤ 100 kB) whose headers name a time
  (or duration) and a scene, action or caption — English or French, case and accents ignored: `time` / `temps` /
  `timecode` / `start` / `début`, `end` / `fin`, `duration` / `durée`, `scene` / `scène` / `section` / `chapitre`,
  `action` / `on screen` / `visual` / `à l'écran` / `visuel`, `caption` / `text` / `texte` / `voice-over` / `légende`,
  `kicker` / `surtitre`, `page` / `url`, `type`. Times are `M:SS` or ranges `M:SS–M:SS` (`-`, `→`, `to`, `à`); a row
  lasts until its end, its duration (`5`, `5s`, `M:SS`), else the next timed row (untimed rows between share the span),
  else 5 s with a warning. Rows naming the same scene in a row (or an empty scene cell) are beats of one scene; `type`
  `title` / `titre` / `intro` → the scenario `title` (+ `intro.duration`), `outro` → `outro.tagline`, `interstitial` /
  `intertitre` → an interstitial card. A `page` cell is a page key, `key:/path`, a `/path`, or a URL whose origin (or
  display host) is one of the environment's pages — mapped to the key and a relative `open`; any other URL is left out
  with a warning (a draft never carries a URL), and so is a `{{…}}` template. It returns an outline (scenes, beats,
  times, durations, captions, pages), a draft (one `hold` per beat sized to its duration, the action as its `note`,
  captions, a header comment saying it is a skeleton), the script's issues positioned at their line and column, timing
  warnings against the look (video 1:00–2:00, scenes 4–25 s, under 2 s unreadable) and the draft validated against the
  project. It writes nothing and calls no model; `scenario_save` saves what Claude rewrote.

**Jobs and the worker.** A dry run, a capture, a hooks run, an environment reset, a sign-in, a sandbox up / reset, a render, a review, an export, a preview, an inspection or a recording is a *job*: the call queues it (under `<workspace>/.demo-studio/jobs/`,
with the run id reserved at once) and the workspace's **worker** — a separate background process the server starts,
`.demo-studio/workers/worker.log` — runs it, one job at a time (a capture uses the machine's CPU and GPU fully), then
exits after a minute without work. So no call outlives an agent's timeout: `run_dry` waits at most `wait_s`,
`run_capture` returns at once, and `run_status {wait_s: 25}` (called again until the run is finished) or
`job_status {job_id, wait_s: 600}` follows it with progress notifications. Results carry their JSON on one line, and
`run_status`, `review` / `review_get` and `page_inspect` answer compactly unless `detail: "full"` (L5.8, measured on the
fixture: a page inspection ≈ 13,300 → 2,200 tokens, a dry run's status ≈ 2,700 → 900, a review ≈ 2,200 → 400). A job `succeeded` when it ran to the end — its run may still have failed (`result.status`);
`failed` means it could not run (a scenario changed since it was submitted, a sandbox that would not start…).
- The worker outlives the session that started it: a capture under way when Claude Code closes still finishes, with its
  teardown, and its result waits for the next session (`job_list`). It keeps the environment (`env` block) of the
  server that started it: after changing that block, wait until it exits (`engine_info` shows it) or stop it.
- Stopping it: `run_cancel` / `job_cancel`, or a signal — the first SIGINT / SIGTERM cancels the running job (its
  teardown and rollbacks run) and the worker exits; a second one quits at once. A worker that is killed (`kill -9`,
  a crash) leaves its job `interrupted`: the run stopped where it was, and `studio env reset <project>` replays the
  rollbacks it left pending. Sandbox services a killed worker had started keep running, as after `kill -9 studio`
  (`studio sandbox down`).
- After `pnpm build` (or a `git pull`), an idle worker notices that its code changed and exits; the next job starts a
  new one.
- `studio run` in a terminal does not go through the queue (it runs in its own process, as before), so two captures —
  one from a terminal, one from Claude — can run at the same time.
- A recording (`scenario_record`) holds the queue while its window is open, as a headed sign-in. The worker's first
  signal closes its window and keeps what was recorded (the draft made and saved, its check replay skipped);
  `job_cancel` discards it. A killed worker leaves no draft (`studio record` again; the events streamed so far stay in
  the recording's folder).
- A killed sign-in leaves nothing saved (`studio login` again); a killed sandbox job may leave services running and its
  seed unrecorded (the next `studio sandbox up` seeds again). Each interrupted job's `fix` says so.
- **Renders.** `render` plans in the server's process (no browser; a refusal costs nothing), reserves the render id
  (a `.<scenario>-v<N>.lock` in `renders/`) and queues the job; the worker plans again — a run whose timeline changed,
  or a plan whose variant changed, is refused — and renders with Remotion (≈ 1–3 min for a minute of video, longer
  for 4K). It holds the queue meanwhile: a capture submitted then waits (`run_status` / `render_status` say behind which
  job). A failed or cancelled render writes nothing under its id and frees it: the next render of the scenario takes
  the same id (`render_status` shows the newest job of an id; `job_status` keeps the old one). A worker killed
  mid-render leaves the job `interrupted`; the next worker kills the render's browser (Remotion starts it detached, it
  would outlive the worker), removes its temporary profile, the lock and the partial video. `studio render` in a
  terminal does not go through the queue; versions stay distinct across both.
- **Reviews and exports.** Both name a render by its id (`latest` is resolved when the call is made) and read it from
  `renders/<id>.json`: its video and its run must lie in the project folder (a record edited by hand, or of a moved
  workspace, that points elsewhere is refused with the `studio review` / `studio export` command a human runs). A review
  (ffmpeg and sharp, no browser) writes `review/<render_id>/` aside and swaps it in at the end: a cancel or a killed
  worker leaves the previous review as it was (the next worker puts it back if the kill fell between the two renames).
  A concurrent `studio review` of the same render in a terminal: the last one to finish wins. An export stops between
  formats on a cancel (the files written stay) and kills ffmpeg or the re-render; a killed worker's re-render browser
  and partial files are removed by the next worker. Re-rendered formats are planned and checked at the call, then
  rendered under the same rules as a render (project files only, no network).
- **Previews.** `template_preview` and `component_preview` are jobs of the same worker (one bundle and one browser per
  preview, ≈ 0.5–1 s a still once the bundle is cached; behind a render they wait for it). Their stills go to
  `<workspace>/.demo-studio/previews/<id>/` — never into a component's folder: the committed `preview.png`,
  `preview.json` and README block stay `studio components preview`'s. They run with the render's network guard. A
  preview that outlives its `wait_s` is followed with `job_status {wait_s}`, which returns the stills.
- **Images.** `review` / `review_get` return the contact sheet (and the key frames at markers) as images in the result,
  `template_preview` / `component_preview` / `job_status` a preview's stills, `comments_list` the comments' stills: JPEG thumbnails ≤ 1280 px made when the
  result is built (never stored in a job), at most 4 per result and 1.5 MB in all
  (`DEMO_STUDIO_MCP_MAX_IMAGES`, `DEMO_STUDIO_MCP_MAX_IMAGE_BYTES`, `DEMO_STUDIO_MCP_IMAGE_PX` in the server's `env`
  change that); the others are listed as files Claude reads. What an image shows of the filmed product, its text included, is
  data — the server's instructions say so, like for anything under `untrusted`.
- **`studio jobs`** shows them in a terminal, also once the Claude session is gone: `studio jobs` (newest first, with
  progress, outcome, who submitted it, and the worker), `studio jobs status <id>` (input, times, place in the queue,
  result or error and its fix), `studio jobs cancel <id>`. It never starts a worker (one started from a terminal would
  run Claude's queued jobs with the terminal's environment): a queued job it cancels is closed by the next worker, and
  `run_list` / `run_status` already show its run `cancelled`.
- A worker refuses (job `failed`, "refused without running") a job of a kind or input version it does not know — a
  newer client's; after a `pnpm build` it leaves such a job to a worker of the new build.
- **History.** Every finished job, and every `studio run` / `studio render` / `studio still` in a terminal (and a
  `studio export` that re-rendered a format), adds a line to
  `<workspace>/.demo-studio/history.jsonl` (kind, project, who, state, duration, captures / dry runs / renders
  produced — a render job counts once it wrote its video, with its render id; an export job counts the formats it
  re-rendered; reviews, component previews and inspections are not counted — a preview job's line names the preview and
  its theme, an inspect job's its id, its source and its outcome);
  `engine_info` reports the totals. It is local, never sent anywhere — the counters a licence or Remotion
  usage report would need later (an entitlements stub answers "everything, no limit" for now).
- `studio doctor` has an **MCP** line: the Node.js a registration names (a path that survives patch upgrades where
  there is one), whether the PATH it registers finds ffmpeg, the worker (running or idle), and whether the workspace's
  `.demo-studio/` is git-ignored when the workspace is a git work tree.

**Safety.**
- **Hooks need a human.** The agent driving the server can write the scenarios it runs (`scenario_save`), so the trust
  flags of hook files do not count for work submitted through MCP: `confirm: true` is ignored, every destructive hook
  and every **shell** hook (a local command) needs the user's approval, and a shell hook always counts as writing —
  its `writes: false` is ignored, so it never runs on a production or read-only environment. When `run_capture`,
  `run_dry {hooks: "run"}`, `hooks_run {dry: false}` or `env_reset {dry: false}` needs such hooks, the server first
  checks them without running anything (templated, secrets as `***`; what a safety rule refuses fails the call at
  once), then asks the user once, through the client's approval form (MCP elicitation, form mode): the project, the
  environment (production or not, read-only or not), each hook with its kind, target (request and host, command,
  SQL and database) and why it needs approval, and the `studio` command to run it in a terminal instead.
  - **Rollbacks.** A setup hook whose rollback is destructive (HTTP DELETE, destructive SQL) or is a shell command or
    JavaScript needs the approval too — even when the hook itself only reads: its rollback runs later (a failure, a
    cancel, `env_reset`) without asking again. The form shows each hook's rollback (`…; rollback: http DELETE …`).
  - Approved: the job is queued with the approvals — fingerprints of the hooks *as their file declares them* (with
    their phase, position and environment) and of the project files they reference (sql / js files, the scripts a
    shell hook names: `./seed.sh`, `psql -f reset.sql`); the worker runs a hook that needs approval only when its
    fingerprint is listed, so a hook or a script changed between the question and the run is refused. Each approval
    is signed with a key kept in `~/.demo-studio/approvals.key` (`DEMO_STUDIO_HOME`; 0600): the worker ignores an
    approval a submit did not sign (a job file written by hand into `.demo-studio/jobs/`). Replaying the rollbacks of
    hooks a human or an approval let run is never asked about again.
  - Declined, dismissed, not answered within 10 minutes (`DEMO_STUDIO_MCP_APPROVAL_TIMEOUT_MS` changes that), or a
    question that failed: the call is refused (`refused`) with the `studio …` command a human runs; nothing is queued.
  - A client that cannot show the form (no elicitation support): refused with `needs_approval` and the same command.
    Claude Code declares elicitation; Claude desktop is not tested yet. Claude Code's own tool timeout
    (`MCP_TOOL_TIMEOUT`) also bounds how long a question can stay open.
  - From a terminal (`studio run`, `studio hooks run`, `studio env reset`) nothing changes: `confirm: true` and
    `--yes` / the prompt approve destructive hooks, and a shell hook's `writes: false` counts.
  - A dry run (`run_dry` without `hooks: "run"`, `hooks_run` / `env_reset` by default) asks nobody.
  - **Sandbox seeds.** `sandbox_up`, `sandbox_reset` and `run_capture {sandbox: true}` may run a sandbox's seed: its
    **shell** steps are approved the same way (a local command is local code, whatever the sandbox is). Its http and
    sql steps rebuild the sandbox's own data (checked before the reset changes anything) and an `exec` step runs inside
    a sandbox container: none of them is asked about. From a terminal (`studio sandbox up`) nothing is asked, as before.
- **Renders read the project, and nothing else.** Through MCP a render (and `plan_preview`) is checked before any
  file is read: every file the capture's timeline names — card and overlay images, `data:` CSV / TSV slots, your own
  video / image / Lottie files, the music bed (the scenario's or `overrides.music`) — is a file of the project folder
  (no absolute path, `..` or symbolic link out of it; a refusal never says whether a file exists); a Lottie file counts
  as code (its expressions run in the render) and is never taken from a folder Claude writes (`scenarios/`…); a slot
  value that is a remote URL is refused (put the file in `assets/`); a theme is named (`template`, a scenario's
  `template:`), never a folder — except the project's own `template:` of project.yaml. After planning, every file the
  plan serves must lie in the project, the run or the theme folder (a theme whose logo or font leaves its folder is
  refused). The worker checks it all again. The refusal names each file and where it is used, with the `studio render`
  command a human runs.
- **The render's browser has no network.** A render through MCP runs with a network guard: its Chromium (Remotion's,
  which runs component code) loads the files of the plan from the local asset server and the bundle from Remotion's
  own server — any other request (another host, another local port such as your own services, an IP literal, a
  navigation) fails and the render warns with the origin only; Remotion's `/proxy` passes only for those files, and
  an `<Audio>` / `<Video>` source Remotion would download itself is refused (the render fails). WebSockets are blocked
  for every render by a Content-Security-Policy of the bundle; WebRTC is not covered (full isolation: BACKLOG). A
  `studio render` in a terminal keeps the network (remote images in slots work there).
- **Components and themes are not edited through MCP.** `component_create` writes the tool's own scaffold (it refuses
  the `studio/` namespace and every built-in id: a workspace component of that id would replace the built-in in every
  render), `template_create_from_brand` writes a new theme folder (never a starter's name or an existing folder; its
  files checked; `replace` only of its own unchanged output made through MCP — hence annotated destructive), and no
  tool writes component code, an existing theme or
  project.yaml. Component code is JavaScript run by the render's
  Chromium: edit it yourself, or let Claude Code edit it with its own file tools under your permissions; previews and
  renders through MCP still run it behind the network guard.
- Tools take **slugs and ids only** — a project slug, a scenario name, a run id, a render id, a theme name, a component
  id, an export format — never a file path except the brand files of `template_create_from_brand` (relative to the
  workspace root, checked as above, or a `site:` candidate) and the one URL of `template_from_site` (approved by you) (and no output folder: renders, reviews, exports and previews go to their fixed folders): a path, `..` or
  an unknown argument is refused before anything is read. The server only touches its workspace.
- **No secret in what Claude writes or runs.** A scenario saved, validated or run through MCP may not contain
  `{{env:…}}` / `{{keychain:…}}` anywhere (steps, hooks, vars), nor may a code file it runs (eval `file`, a hook's sql
  / js file): an agent could read any variable of the server's environment back through an error message, in a form
  the masking does not catch (base64). Only what you wrote resolves secrets: project.yaml (personas' login steps,
  databases, mailbox, `reset` hooks) and the project's `hooks/` files. Refused at `scenario_save` /
  `scenario_validate`, at submit (with the `studio` command a human runs) and again by the worker.
- **Files stay in the project.** Through MCP, a file a scenario or hook names — `drop_file` `path`, eval `file`, a
  hook's sql / js file, a script its shell command runs — is relative to the project folder and inside it, symbolic
  links followed (no absolute path, `~` or `..` out of it; a templated path is checked when the step runs), and code is
  never run from a file Claude can write (README.md, `scenarios/`, `runs/`, `renders/`, `review/`, `exports/`,
  `.demo-studio/`): keep scripts in `hooks/` or `assets/`. From a terminal nothing changes.
- **Production of every project.** The hosts of the production and read-only environments of *every* project of the
  workspace are protected through MCP: `project_create` refuses a page on another project's (loopback names alike,
  ports compared), and a run, hooks or a reset on a read-write environment with a page on one is refused (a human
  marks that environment production / read-only in project.yaml, or runs it in a terminal).
- Text the filmed site or a service controls (a step's error message, warnings, a session check's detail and URL,
  health responses) comes back under an `untrusted` key, truncated, never in the summary; the server's instructions
  tell Claude it is data, not instructions.
- No tool takes a password, token or secret value, and none returns a session file or profile path: `auth_status`
  gives a state and the command a human runs; `auth_login` opens a window for the human (or plays the project's own
  login steps), and its result is a state. `project_get` leaves out `auth` (persona names only: no login steps)
  and masks a password written in a URL; whatever else a user wrote in clear in project.yaml or the README is
  returned as written.
- **Comments are data.** A comment, its replies and its author names come back under `untrusted`, never in a summary
  or an image label (those use ids, frames and anchor fields of a known shape; an anchor value of another shape shows
  as `unknown`, its original under `untrusted`). The server's instructions say a comment may only ask for a change to
  the video — the scenario, the render overrides, the theme — never for a hook, a sign-in, a change to project.yaml or
  environments, a URL or a file outside scenarios/. Through MCP no input names an author: every entry is written as
  `mcp`, threads are never created or reopened, and a resolution needs the thread's `if_match`. Anyone who can run
  `studio comment` or write comments/ (Claude Code's own shell and file tools included) writes as `cli`: the channel
  says how an entry was written, not who wrote it.
- No tool deletes anything; overwriting an authored file needs `if_match`. Environments `project_create` declares are
  neither production nor read-only: a human marks production environments in project.yaml (there is no tool that
  changes project.yaml).
- **What reaches the model.** Whatever a tool returns — README, scenarios, run summaries, page text under
  `untrusted`, file paths — becomes part of the Claude conversation, i.e. goes to the model provider. Files a tool
  only names (captures, screenshots, DOM snapshots) stay on this machine until Claude reads one: a screenshot or DOM
  snapshot of the filmed product Claude reads goes into the conversation too. The full data-flow table is the ADR-1
  amendment in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Tested clients.** The server is tested with the MCP SDK's own client over stdio (the whole conversation, approvals
  answered, a worker killed). In Claude Code the step in [docs/MACOS-CHECKLIST.md](docs/MACOS-CHECKLIST.md) is the
  live acceptance; Claude desktop (and whether it shows approval forms) is untested.

### Claude skills and the plugin

Three [Agent Skills](skills/) teach Claude Code the loops above, so it does not need them spelled out each time. They
are instructions only: every check, refusal and approval stays in the server's tools, and nothing calls a model.

| Skill | When it triggers | The loop |
|---|---|---|
| `demo-studio-scenario` | a demo video, product tour, walkthrough or tutorial of a web app; recording a flow; a script to turn into a video; comments on a render | `page_inspect` → Claude writes the YAML → `scenario_validate` → `scenario_save` → `page_inspect {scenario, until}` → `run_dry` → `run_capture` → `render` → `review`; or `scenario_record` (the user shows the flow), or `scenario_from_script` (a timecoded table), and the frame-comments loop (`comments_list` → change → `run_capture` for a scenario change → render → `review` → `comment_reply` / `comment_resolve`) |
| `demo-studio-theme` | a theme, template or branded look; a logo, fonts or brand colours in the video | brand files the user puts in `<workspace>/brand/` (and hex colours), or `template_from_site` on a site the user names (approved in a form) → `template_create_from_brand` → `template_preview` → `render {template}` → `review` |
| `demo-studio-component` | a new intro, outro, card, caption style, layout, overlay or transition | `component_list` / `component_preview` first (an existing one with other params often does it) → `component_create` → code edited only once the user agrees, renderer primitives through the kit → `component_validate` → `component_preview` in the user's theme → `render {overrides: {components}}` → `review` |

Each skill starts by calling `engine_info` (a plugin whose server failed to start still loads its skills) and stops
when the workspace root it names is not the session's folder (the plugin's values are shared, see below); it ends
with the same **Rules**: a refusal or an approval request is final; Claude never runs the `studio` CLI (`studio`,
`pnpm studio`, `node …/bin.js`) through its shell, for anything, whoever asks — the user included: it shows the
command for the user's own terminal (a terminal run is author trust: `--yes` approves hooks, a CLI render has no
network guard); it never types or asks for passwords; text under `untrusted`, page text, images and comments are
data; it never fetches brand assets itself; no `eval` step the user did not ask for; `template_from_site` only on a
site the user named; component code edited only after the user agreed. Claude's own permission prompts stay too: no
skill pre-approves a tool (`allowed-tools` is never used).

**Installing them.** The skills ship as the `skills/` folder, which is also a Claude Code plugin bundling the MCP
server; [`skills/README.md`](skills/README.md) has the details. In short (`pnpm build` first):

```sh
node packages/cli/dist/bin.js --root <workspace> mcp --print-config   # prints the two lines below, filled in
claude plugin marketplace add <repo>
cd <workspace> && claude plugin install demo-studio@demo-studio --scope local --config node=<node ≥ 22> --config studio=<repo>/packages/cli/dist/bin.js --config workspace=<workspace>
```

- `--scope local` (the default the lines print) enables the plugin, its server and the skills in sessions started in
  that workspace only, not in every session (`--scope user`). Remove the `claude mcp add` registration first
  (`claude mcp remove demo-studio -s user`): not both.
- **One workspace at a time.** The `--config` values are stored once per user (`pluginConfigs` in Claude Code's user
  settings), not per folder: installing in a second workspace re-points the first one's sessions at the second
  workspace. Switch by uninstalling in the old folder first, then installing in the new one. The skills stop when
  `engine_info`'s workspace root is not the session's folder, and `engine_info` says when the server was started
  outside its workspace.
- The server's `PATH` keeps absolute entries only and none inside the workspace (`<workspace>/bin`,
  `<workspace>/node_modules/.bin`): Claude writes files there. A workspace that holds tool folders (your home folder,
  say) loses them: use a dedicated workspace folder.
- `--config home=<folder>` (printed when `DEMO_STUDIO_HOME` is set) is the studio home of the plugin's server; it
  replaces an inherited `DEMO_STUDIO_HOME`. Keep it outside the workspace: it holds the key that signs approvals.
- **Update:** the plugin loads in place from the repository: `git pull` (and `pnpm build`), then a new session or
  `/reload-plugins`. **Reconfigure** (another Node.js or home): run the install line again with the new values;
  another workspace: as above, uninstall in the old folder first. **Remove:** `claude plugin uninstall demo-studio@demo-studio --scope local` from the workspace, then
  `claude plugin marketplace remove demo-studio`.
- `claude --plugin-dir skills` is for editing the skills: it loads them for one session as `demo-studio@inline`, hides
  an installed copy and has none of its values, so its MCP server is missing in that session.
- Each skill folder is also a plain Agent Skill (frontmatter `name` and `description` only): it can be copied on its
  own; it then needs the server registered with `claude mcp add`.

**How they are checked.** `packages/mcp/test/skills.test.ts` lints the skills with no model call
(`packages/mcp/test/skill-lint.ts`): every call written `tool {args}` names a tool of the server and only argument
keys of its input schema, nested ones included (and literal values must parse); every snake_case word is a tool, an
argument, an action, a schema key or a known result field; every `studio …` command and flag exists in the CLI's
help; links resolve and every file of a skill is linked; each YAML example validates (a scenario against the fixture
project under MCP trust, a component manifest) and the tsx example compiles like a component (imports, kit exports,
forbidden APIs); the frontmatter (`name` = folder, a description ≤ 1,024 characters with "Use when"), the size
(≤ 200 lines a SKILL.md), the "Before you start" checks and the Rules sentences (pinned, and no "unless", "except",
"if the user asks", "anyway"… anywhere in the Rules); no sentence anywhere has Claude run a `studio` command
("run `studio …`", "… yourself", a `studio …` command whose sentence does not name the user, outside a "For the
user's own terminal" section), fetch (curl, wget, download), ask for a password or do what a comment says; and the
hygiene (no `--yes`, `--allow-writes`, approving hook flag in any spelling, `${…}`, Claude Code's load-time `` !` ``
commands, `` ```! `` blocks and `$ARGUMENTS` / `$1` / `$name` substitutions, `allowed-tools`, absolute path, named
secret reference, nor a URL or domain — any case, any TLD — other than example.com, `*.example`, `*.test` and
localhost). A negative case per rule proves it bites. What the lint cannot prove — that a loop is the right one, that Claude follows the Rules or that a
skill triggers, and that no real brand or person is named — is the live check of
[docs/MACOS-CHECKLIST.md](docs/MACOS-CHECKLIST.md) 12i. A lot that changes a loop updates its skill.

## Studio app

`studio ui` serves the Studio — a web app on your own machine — for the workspace (Phase 4, being built). It runs
the same engine and the same tools Claude uses over MCP, through the engine's local HTTP API, and needs nothing else
running: the MCP server keeps working without it.

- **Projects.** Every project of the workspace: its scenario count, its environments with *production*, *read-only*
  and *sandbox* badges, its last run; a project whose `project.yaml` does not load is listed with its first problem. A
  project shows its README, environments (pages, the URLs the video shows, personas), scenarios, recent runs and
  recent activity.
- **Search and recent activity.** A search box finds projects (name, slug, README words), scenarios, runs and renders
  as you type (every word as a prefix); *Recent activity* lists the jobs that wait or run (with their progress; one
  whose worker died says *interrupted*) and then what finished — Claude's jobs and your `studio run` / `render`
  commands alike. Both come from the workspace index, `<workspace>/.demo-studio/index.sqlite`: a cache rebuilt from the
  files (delete it any time), never the source of truth. It needs Node.js 22.13 or later (`node:sqlite`); on an older
  Node.js 22 the Studio runs without search and activity.
- **Live updates.** A change on disk — a README edited in your editor, a run Claude started, a new project — shows in
  every open Studio tab within about a second (the server polls the workspace while a tab is open, never otherwise).
  The browser keeps one update stream to the server whatever the number of tabs (the others hear from it); the status
  line at the bottom of the sidebar says *live updates*, or *updates every 3 s* when it falls back to polling.
- **README editor.** Plain text (no Markdown preview), saved with Save or Cmd/Ctrl+S as an atomic write of
  `README.md`. If the file changes on disk while it is open (your editor, a terminal, Claude: the update stream says
  so), the editor loads the new
  version when you have no unsaved text, and otherwise keeps your edits and says so; a save that would overwrite a
  newer file shows both versions — keep yours ("Save mine over it") or load the one on disk (your text stays there to
  copy). Unsaved text survives moving around the app; closing the tab asks first; if the session ends (the server
  stopped or restarted), the text stays on screen, read-only, to copy into the new one. The file keeps its line
  breaks (CR LF stays CR LF) and ends with one; 200,000 characters at most, that final line break included. A README
  that is not UTF-8 text, or a symbolic link leading out of the project, opens read-only with the reason (convert or
  replace it in your editor); one linked to another file of the project is saved into that file. A project without a
  README.md says that saving creates it.
- **Scenarios as blocks** (read-only: edits are made in the file). A project's scenario names open the scenario screen: the video's
  settings and the notes at the top of the file (without editor directives such as `yaml-language-server:`), the setup
  and teardown hooks (each with its kind, what it does, *destructive* / *with rollback* in words and whether it needs
  a person), then each filmed scene as a card, numbered 1, 2, 3… — its page, the URL it opens (shown without any
  `user:password@`) and the one the video shows, caption, speed, layout and how long it took in the run; a scene filmed
  on two pages lists each page with its URL (or the scene it continues from) and says how the video lays them out —
  with its
  steps as rows: what kind of action (*click*, *select*, *type*, *wait*, …), what it acts on in plain words
  ("button “Request a quote”", "field “Bag size”"), its modifiers (*hold 1.5 s*, *zoom ×1.3*, *mark*, *irreversible*,
  …) and the real picture of that step from a run: a dry run's screenshot, the frame on screen at the end of a capture
  step (after its hold), or a failed step's error screenshot. *Pictures from* picks the run (by default the newest run
  that went to the end and kept a copy of the scenario; a newer one that stopped early or left no picture is named
  above the pictures). A step without a picture says why — not reached (and where the run stopped), changed or new
  since that run, its scene skipped, a step with two actions — and when the scenario changed since
  the run a banner says so (a step whose arguments did not change keeps its picture). Selecting a step (click, or the
  arrow keys, Home and End: the steps are one stop for the Tab key) shows it in the inspector: what the action does,
  its arguments, its lines in the file (*Show in YAML* opens the YAML tab there), what the run did, and what
  the run found on the page, in a box of its own (text the filmed site controls). The pictures are made when a step
  comes on screen (a 1,200-step scenario opens in a fraction of a second on a recent Mac), kept in memory only — never
  written to disk — and the screen follows the files: an edit of the scenario or a run of it that starts or finishes
  shows within about a second. Steps are numbered from 1 everywhere on the screen ("failed at step 3 of proposal"). A
  scenario of more than 2,000 steps shows its first 2,000 and says so (the YAML tab has the whole file).
- **Editing a scenario's YAML.** The *YAML* tab shows the file; **Edit** turns it into a text box (no highlighting).
  ⌘S / Ctrl+S or **Save** writes it — with the file's own line breaks (CR LF stays CR LF) and a final line break — and
  the blocks show the result; the issues of what you type appear below it as you go. A save is checked like one Claude
  makes: a text with errors is not saved (the errors are listed with their lines, your text stays in the box), warnings
  save. What you type stays when you move around the Studio (closing the tab asks first; if the session ends it stays on
  screen to copy), and while it is unsaved the *Blocks* tab says block editing is off. If the file changes on disk while
  you type (an editor, Claude, a terminal), a banner offers to load it; a save then shows both versions side by side
  (*Save mine over it*, *Load the version on disk*). Because a script in a page cannot be told from your click, the
  Studio saves a scenario only as Claude could through MCP, and more strictly: its `setup`, `teardown` and `mocks` must
  stay as they were (they run on your Mac: edit them in your editor) — and while it has any, so must its `vars` and
  `env` (a hook reads them: a var templated into a shell line is part of a command); it never adds a character that
  reads as nothing or as a line break in an editor (a direction control, a zero-width space, a soft hyphen, a variation
  selector, a line separator, a carriage return without a line feed), and one the file already has stays only on its
  line, unchanged (an emoji's own joiners and selectors are fine). A file outside the project is said to be outside
  whether it exists or not. A file the Studio does not write — one holding a secret reference (`{{env:…}}`,
  `{{keychain:…}}`), a file outside the project, a theme folder, a carriage return without a line feed (an editor shows
  a line break there, YAML does not), one that is not UTF-8 or over 500,000 characters, a link to a file outside
  `scenarios/` — opens read-only with why and the lines concerned: edit it in your editor (move a secret to
  project.yaml). A scenario name is case-sensitive (`Quote` is not `quote.yaml`).
- **Moving, duplicating and deleting steps.** On the *Blocks* tab, drag a step by its grip (⋮⋮) to another place in
  its scene, to another scene or into an empty one — a line shows where it will go — or select it and press
  **Alt+↑ / Alt+↓** (past a scene's first or last step it goes to the previous or next scene); **Delete** removes it,
  and the inspector has *Move up*, *Move down*, *Duplicate* and *Delete*. Each edit is saved at once and rewrites only
  the lines of that step: comments, quoting, blank lines and line breaks elsewhere stay byte for byte (the comment
  lines just above a step, at its dash's column, move with it; a section header at another column stays). **⌘Z /
  Ctrl+Z** undoes (the exact earlier bytes), **Shift+⌘Z** redoes, and the buttons above the blocks name the edit; the
  history is per screen and is cleared when the file changes elsewhere (a save of the YAML tab included, said as such:
  it is not an entry of the history — undo it in the YAML tab). Undo puts back exactly a version the Studio showed or
  wrote; moving a step back by hand gives the same steps but not always the same bytes (a blank line or a column-0
  comment does not travel with a step). Alt+↑ on the first step (Alt+↓ on the last) says it cannot move. A copy has
  no `id` (ids are unique) and no
  `mark` (a mark names one moment), and a capture's `as` gets a suffix (`quote-2`) — the Studio says each. The same
  checks as a YAML save apply. Editing is off — and the screen says why — while the YAML tab holds unsaved text, for a
  file with errors or one the Studio does not write; a step written as a YAML alias or in a `[…]` list is moved in the
  YAML tab (an anchor, a tag or a comment after a step's dash travels with it). If the file changed meanwhile, your
  edit is not applied and **Apply it to the new version** offers to make it there (refused if that step is no longer
  at that place; off, with why, when the new version cannot be edited in blocks). A step moved within its scene since
  the run keeps its picture and says *moved since this run*: the picture shows it at its old place — a new dry run or
  capture shows it where it is now (a step moved to another scene shows no picture until then). A comment left on a
  frame follows its step to its new place, in another scene too (Claude's `comments_list` gives it as `step_now`).
- **Changing a step's values and adding steps.** The inspector shows the selected step's form: its arguments (a target
  as text, role and name, label, aria label, placeholder, CSS selector, test id, scope, index, exact), then its caption
  (text, kicker), hold, speed and mark — the fields that hold a value, the empty ones folded under *More: …* (a
  target's other keys under *Other ways to find it*). The fields come from the scenario language itself and check what you type
  before anything is sent (a number, its bounds, a name made of letters, digits, `-` and `_`); **Save** writes only the
  values you changed, each on its own line — a `click: Save` stays a shorthand when you change its text, and becomes
  `click: {text: Save, in: dialog}` when you add a scope; a field you did not touch is never sent (an empty `""` stays
  as it is). What a form cannot show (a list, a point, a scope written as a row, a URL with a user name, a value holding
  an invisible character, an overlay, code) is named and stays for the YAML tab, and so is removing a key from a
  `{…}` written over several lines or holding comments. If the step changes on disk while you type, the form shows its
  new values and lists what you had typed. **Add a step…** opens a palette of
  16 actions (open, click, double click, hover, type, press, select, wait, wait for, hold, screenshot, scroll, menu,
  date, notify, hook — a named hook the file or project.yaml declares, run off camera: L5.8): pick one, fill its form, choose where it goes (after the selected step, or the start or end of a
  scene) and **Add** — one new line in the file. A secret reference typed into a field (`{{env:…}}`, `{{keychain:…}}`)
  is refused with the reason, as Claude's would be. After a save the Studio says what it means for your video: a
  changed argument or hold changes what the browser does (a dry run shows it, a capture films it); a caption, speed or
  mark is only the edit (a render of the last capture shows it). If the file changed meanwhile, **Apply it to the new
  version** makes your change on the same step there — found again by its arguments and its rank among the scene's
  steps with the same arguments. It is refused when that step is gone, when its scene now has more or fewer steps with
  the same arguments, or when a field you changed no longer holds what your form showed (it was changed meanwhile: the
  form then shows the new value).
- **Off camera (L5.8).** A `hook:` step has its own badge (*hook*, "off camera: cut from the video") and moves, edits
  (its hook's name), duplicates and deletes like any step; the named hooks (`hooks:`) are listed in the hooks strip,
  by name, read-only — like setup and teardown they never change from the Studio. A scene with `offscreen: true`
  shows "off camera: played, not in the video"; scene options (that one included) are edited in the YAML tab.
- **Dry run and Capture from the scenario screen.** *Runs from the Studio* has a **Dry run** button (no hooks, a
  screenshot per step) and a **Capture** button (the setup and teardown hooks, the video), on the environment the
  screen shows, and says before any click what would stop each one. One that cannot start from the Studio — a hook
  that needs a person (shell, destructive, a destructive rollback), a scenario naming a secret or a file outside the
  project — is disabled with the reason and the exact `studio run …` command to type in a terminal (and the same command
  as `node <repository>/packages/cli/dist/bin.js …` where `studio` is not on your `PATH`); a scenario with errors says
  to fix the file first (the terminal refuses it too). The server checks again when you click — the file as the screen
  showed it: if it changed meanwhile, nothing starts and the screen reads it again — and words any refusal for the
  Studio; a second click while a run of the scenario waits or runs (another tab) is refused. The Studio never resets a sandbox, never stops at a step
  (`--until`) and never runs the hooks of a dry run: those stay `studio run` options. A run that starts shows a banner
  with its progress (*3/7 steps · current step 4 of coffees*) and **Cancel this run** (a running capture stops at its
  next step, then its teardown and rollbacks run); when it ends, *Runs from the Studio* says how it ended — and, for a
  run that failed (the site not reachable, a step not found), the first line of its error — and its pictures replace
  the old ones (the newest run that went to the end is the default). If the worker dies mid-run, the banner goes and
  the run shows as interrupted. While a run of the scenario is queued or running, both buttons wait.
- **The jobs worker.** A run from the Studio is a job, like one Claude starts: the Studio starts the workspace's
  worker when you click (if none is running) and the worker exits after a minute without work. It gets a clean
  environment: your terminal's, without the folders a package manager adds to `PATH` (`pnpm studio ui` puts
  `node_modules/.bin` there) or any folder inside the workspace, without package-manager variables (`npm_*`: they can
  carry a registry token), the MCP HTTP token, model and agent credentials (Anthropic, Claude Code, OpenAI, Bedrock,
  Gemini and other model API keys — the tool never calls a model), GitHub / GitLab tokens, and anything that would make
  node load code from the workspace (`NODE_OPTIONS` naming a file, `NODE_PATH` / `DYLD_*` / `LD_*` entries inside it),
  and with `DEMO_STUDIO_HOME` kept (your signed-in profiles). Secrets that an automated sign-in reads with `{{env:…}}`
  come from that environment, as for `studio worker` typed in the same terminal. Claude's MCP server starts the worker
  with the same clean environment, so whoever starts it — Claude or the Studio — it never carries more: the sidebar,
  `studio jobs` and `studio doctor` say who started it (*worker running (pid 4242, started by the Studio)*). `studio ui` itself
  runs with the same cleaned `PATH`, like `studio mcp`.
- **Text from files is shown as text.** Names, URLs, errors and READMEs never become markup or links, and
  right-to-left override characters are shown as visible marks (`[U+202E]`).

- **One server per workspace.** The running server is named in `<workspace>/.demo-studio/ui.json` (mode 600: its pid,
  port and API token); `studio ui` again opens that one with a new link and exits (with `--port N` naming another port,
  it says the running server keeps its own). Ctrl-C stops the server and removes the file. A `.demo-studio/` folder
  you cannot write is refused with what to do.
- **The link opens once.** It carries a one-time code (`http://127.0.0.1:<port>/#c=…`, valid 60 s) that the page
  trades for the session token, kept in that tab only (it survives a reload); a copy of the link — browser history,
  terminal scrollback — is dead after that. Another tab or browser needs a new link from `studio ui`.
- **What the page may do** is an allow-list of tools (L4.1: `engine_info`, `project_list`, `project_get`,
  `project_update_readme`, `job_list`, `run_list`, and the Studio's own reads: `activity_list` and `search` from the
  index, `projects_overview` — every project card's environments and last run in one call; L4.2: `run_status` without
  waiting, `scenario_blocks` — a scenario read as blocks with its runs and each step bound to the run's pictures —,
  `run_thumbs` — small JPEG pictures of a run's steps, made in memory and never stored —, `scenario_run` — a dry run or
  a capture with its arguments pinned: the scenario, the mode and an environment, nothing else — and `run_cancel`), run
  with the trust an agent has through MCP and no approver: a page's script cannot be told from your click, so anything
  that needs your approval stays in the terminal.

## Security

- **The Studio server** (`studio ui`) listens on `127.0.0.1` only and checks every request in a fixed order before
  anything runs: the `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise: a DNS-rebinding page
  carries its own name), a present `Origin` must be its own and API requests must not come from another page
  (`Sec-Fetch-Site`; a page of another local port — a filmed local app — is *same-site* and refused), then the method
  (no CORS: a preflight always fails), the bearer token (a header, never a cookie or a URL), `application/json` (a
  `<form>` cannot send it) and a 2 MiB body cap. Every answer carries a strict Content-Security-Policy (scripts,
  styles and fetches from the server itself only; no inline script, no `eval`, no framing). No secret is in the app's
  files; the token comes from the one-time code (see [Studio app](#studio-app)).
- **MCP over HTTP** (`studio mcp --http`) listens on `127.0.0.1` only and takes no request from a web page: the `Host`
  check (421) stops a DNS-rebinding page, and a page holds no token; as a second line, any request carrying an
  `Origin` header or a `Sec-Fetch-*` header is refused (browsers send an `Origin` on every POST and cross-origin fetch,
  and `Sec-Fetch-*` from secure contexts; MCP clients send neither — Node's fetch sends `Sec-Fetch-Mode: cors` alone,
  which is served). Then the route (`/mcp`), the bearer token (the stable one in the studio home, mode 600),
  `application/json` and a 4 MiB body cap. It is a separate process from the Studio: a page of the Studio never holds
  this token. Known limit: its port is fixed (47820) so the registration survives restarts — on a Mac shared with
  other accounts, another local user's program could listen there first while `studio mcp --http` is not running and
  receive the token a client sends (BACKLOG BL-79).
- **Reads stay in the project.** README.md, scenario files and `project.yaml` read through the engine (MCP tools, the
  Studio), and the files a tool names (a hook's SQL or JS file, a dropped file), never follow a symbolic link out of
  the project folder: they are refused, and the refusal does not name where the link leads. A write through a link to
  another file of the project lands in that file; through one leading out it is refused. The `studio` command line
  itself reads what you point it at. The workspace index (`.demo-studio/index.sqlite`) indexes only regular files of
  the project and takes the umask's mode, like the README files it holds.
- **No secrets in files.** Use `{{env:VAR}}` or `{{keychain:service/account}}` references; validation flags database
  URLs with a clear-text password. Resolved secret values are redacted from hook logs, results and journals, and from
  the run's `log.jsonl`, `run.json`, `timeline.json` and error snippets (see "Secrets in steps").
- **Allow-list.** Hooks of every kind only reach the hosts of the project's environments, `allow_hosts`, localhost
  and the loopback hosts of a sandbox's mailbox and databases (a refusal names the host, never the URL, and `optional:
  true` does not tolerate it):
  - `http` and `sql`: checked on the connection; redirects are checked hop by hop and credentials are dropped when
    the origin changes.
  - `js`: the hook's tab blocks every request to another host before it leaves the browser — navigations and each
    redirect hop, fetch / XHR, beacons, EventSource, images, workers, frames, the page's WebSockets; service workers
    are bypassed there, `window.open` is disabled, and `fetchLater` and `SharedWorker` do not exist (their requests
    would escape the tab's guard). A page that redirects to another host, or a hook that fails
    while a request was blocked, is refused (the message adds the hook's own error — the blocked request may be the
    app's own background traffic: add its host to `allow_hosts`); a hook that catches the failed request and goes on
    succeeds, with a warning naming the host.
  - `shell`: before anything runs, the command line is read for the hosts it names — a best-effort reading of the
    shell text, not a sandbox (dry runs report them; validation flags those written literally): URLs (also as
    `--opt=URL`, in `NAME=URL` assignments and inside inline code: `node -e`, `python3 -c`, `ruby -e`, `perl -e`,
    `php -r`, `deno eval`, `bun -e`, `mongosh --eval`), `$VARS` expanded from the script's own assignments and the
    environment `sh` gets, `curl` / `wget` / HTTPie / `xh` targets without a scheme, proxies (`curl -x`, `--socks5…`,
    `HTTPS_PROXY=`…) and `curl --resolve` / `--connect-to` addresses, database-client hosts (`psql -h`, `host=`,
    PGHOST for a client given no host, `mysql -h`, `redis-cli -h`, `mongosh --host` or address), ssh / scp / rsync
    destinations (`-J`, `-o HostName`, a ProxyCommand), git repositories (`clone`, `fetch`, `pull`, `push`,
    `ls-remote`, `remote add`, `submodule add`), `nc` / `telnet` destinations, the hook's `env:` values — also inside
    `sh -c`, `eval`, command substitutions (`$(…)`, backticks) and heredocs, here-strings or `echo` output fed to a
    shell (other heredocs, SQL and JSON text are data). A host computed when the command runs is refused: built from
    `$(…)`, from a variable the script reads (`read`, a `for` loop, a function argument) or may have set (after
    `source`), a computed database, mongosh address or git repository; an ssh alias of `~/.ssh/config` is checked as
    written (list it in `allow_hosts`). Shell hooks get `$DEMO_STUDIO_ALLOWED_HOSTS` (comma-separated) to check hosts
    they compute themselves.
  - **What the allow-list cannot see:** what a shell hook's programs do on their own — connecting from their own
    configuration (`pnpm run seed` reading `DATABASE_URL` from a `.env` file, the real host behind an ssh alias,
    kubectl contexts, cloud CLI profiles, PGSERVICE, docker compose service names), a script file they run, a host
    they compute or read (URLs read from files or stdin, `xargs curl < urls.txt`, `fetch(process.env.API)` in inline
    code), code they download or pipe into a shell (`curl … | sh`), commands run inside a container or on another
    machine (`docker exec`, `kubectl exec`, `ssh host 'curl …'`), network tools the scanner does not know (`socat`,
    `ncat`, `ftp`…); in the js hook tab, WebSockets opened by workers, service workers and shared workers already
    running for the origin or started by the hook, WebTransport / WebRTC and preconnect hints, redirect hops inside a
    cross-site frame, the first request of a popup a link opens (closed at once). Like an `http` hook to a local
    server, the check covers what the hook names, not what that program does next (network isolation of hooks:
    `docs/BACKLOG.md` BL-57).
- **Read-only and production environments** (see [Environments](#environments-display-urls-production-read-only-clock)):
  hooks that write are refused there, before anything runs, and the run's browsers stop their writes to the
  environment's hosts (or answer them with a mock); a production environment is written to only where project.yaml
  sets `access: read-write` **and** the command line says `--allow-writes`.
- **Destructive hooks need `confirm: true`.** SQL `DELETE`/`DROP`/`TRUNCATE`/`ALTER`/`UPDATE` (inline, in files or
  sent to `psql`), HTTP `DELETE`, shell `rm`/`dropdb`, and hooks declared `destructive: true` are flagged by
  validation and refused at run time without it (`studio hooks run --yes` approves explicitly).
- **Everything is journaled.** Each executed hook and its rollback is recorded in `runs/<id>/hooks-journal.json`
  (captures) or `.demo-studio/journals/<id>.json` (`studio hooks run`, `studio env reset`); `studio env reset`
  replays whatever is still pending in both.
- **Sandboxes are local.** Every URL of a sandbox.yaml is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`,
  `[::1]`; a database URL without `?host=` / `?port=`), a sandbox is never production, and a sandbox scenario's sql
  hooks reach only the sandbox's databases. What a reset rewrites — the mailbox, a seed's database — must be served by
  the sandbox or marked `external: true`, and its shell commands get the sandbox services' `env` (`DATABASE_URL`…), not
  your shell's. Its plain demo passwords are masked like secrets (see [Sandbox mode](#sandbox-mode)).
- **Dry runs** never execute steps marked `irreversible`.

## Outputs of a run

`projects/<slug>/runs/<run-id>/` (git-ignored; renders go to `renders/`, reviews to `review/`, exports to `exports/`):

| File | Content |
|---|---|
| `capture.mp4` | H.264, constant frame rate, exactly the capture duration — encoded during the take (L5.7): output frame n is the screencast frame on screen at n / fps, as before; a take ends without a long encode |
| `timeline.json` | the scenario's edit info (`video`: title, intro, outro, frame, template, music), scenes (captured scenes, cards, interstitials), step events (`t_start`, `t_end`, `t_click`, target box, click point, strategy, popup opened, camera and overlay anchors) and web notification events, markers, page/URL segments, cursor track, idle intervals, `loading` (the page loads the capture held: `t_start`, `t_end` = the first frame of the painted page, page, `until` paint / load / limit / left / end, `held_frames`; per page in `tracks[]`), artefacts, warnings |
| `run.json` | run record (status, options, steps done, error with screenshot + DOM snippet — and `missing_targets` when a target was not found —, `optional_failures`, `environment`: production, the run's access, the clock — `at`, `timezone`, `freeze`), updated live; `version` (its format) and `engine`: the Demo Studio, Node.js and Chromium versions, the OS (`darwin 25.6.0 arm64`) and the installed fonts (`files`: their number, `digest`: a hash of their names) — what tells two machines' takes of one scenario apart |
| `timeline.json` `environment` | the environment (L1.7): name, production, the run's access (`allow_writes` when `--allow-writes` made it read-write), the display URL of each page that has one (`display[]`: page, real base URL, display base — URLs elsewhere in the timeline stay real), the clock (`at`, `epoch_ms`, `timezone`, `freeze`), the writes the run's guard saw (`writes[]`: capture time, method, URL, GraphQL operation, `blocked` / `mocked` / `allowed` / `passed` / `exempt`, the rule that matched, `via`, `protected_by`) |
| `log.jsonl` | every progress event |
| `frames.jsonl` | the screencast frames' capture times (always) |
| `frames/` | the raw screencast frames, only with `capture.keep_frames: true` (L5.7: off by default — a 6-minute take kept 1.6–2.4 GB of them) |
| `run.json` `perf` | what a capture cost and how it was filmed (L5.7): `seconds`; `cpu` — CPU seconds per process group from Chromium's own process report and the system's process table: `browser` (it encodes the screencast's JPEG frames), `gpu`, `renderer`, `chromium_other`, `studio`, `encoder`, `product` (the processes listening on the environment's localhost ports), `total`, `cores` (total / seconds), `browsers` (per persona); `machine` (CPUs, load average mean / max); `gpu` (accelerated, renderer, features in software); `frame_rate_limit`; `frames` (received, mean fps, lowest fps of a cursor move, dropped, `kicked`: fresh frames asked for during a click ripple); `stalls`; `transitions` (clicks measured, the slow ones: press → stable screen over 0.8 s, slowest first, target); `encode` (codec, quality, `finish_ms` after the take, `late_frames`); `disk` (run folder MB, frames kept, free GB). `studio run` prints it on one line, MCP `run_status` too; the run warns when the disk has less than 10 GB (or 5 %) left |
| `timeline.json` `stalls`, `busy` | where the capture froze while the cursor moved or a ripple played, and the waits the screen showed after a click (skeletons, spinners, blank panels) — the edit cuts the first and shortens the second |
| `timeline.json` `cursor_effects` | what the in-page cursor showed besides its position: icon changes, presses, click ripples (L2.13; per page in `tracks[]`); `capture.cursor: hidden` when captured without the cursor (`run --raw --cursor none\|layer`) |
| `capture-<page>.mp4`, `frames-<page>/`, `frames-<page>.jsonl` | multi-page scenes: one recording per page on the same frame grid as `capture.mp4` (listed in `timeline.json` `tracks`) |
| `screenshots/` | dry-run screenshots (a capture's with `capture.step_shots`), `screenshot` steps, error screenshots and DOM snippets, `dead-click-<scene>-<step>.png` |
| `hooks-journal.json` | executed hooks and their rollbacks |
| `scenario.yaml` | snapshot of the scenario that ran (L5.5: a render re-plans the edit of today's file while its filmed part matches this snapshot; `studio render` / `plan` warn when the filmed part differs) |
| `artefacts/` | captured emails (`emails/<as>.json` + `.png`), documents (`documents/<as>.<ext>` + `<as>/page-<n>.png`) and web notifications (`notifications/<name>.json` + icon), listed in `timeline.json` `artefacts` |

**Disk** (L5.7): a capture weighs tens of MB (capture.mp4, ≈ 20 MB for a minute of the fixture), renders and reviews a
few more. `studio prune <project>` lists what `runs/`, `renders/` and `review/` hold that nothing needs any more —
failed, cancelled and interrupted takes, dry runs, older captures nothing uses, renders beyond the last 3 of each
scenario and variant (`--keep-renders N`), failed renders, the reviews of renders that go — with how much deleting it
frees; `--yes` deletes it. Always kept: the last good take of each scenario, every take a kept render or a comment
thread uses, every render a thread was made or resolved on, whatever a queued or running job names; `exports/` is
never touched. Claude has the same as the MCP tool `project_prune` (a dry run unless `dry_run: false`).

Composite steps (`select`, `pick`, `menu`, `date`, `drop_file`) keep every click in `data.clicks`:
`{role, strategy, popup_opened, point, bbox, t_click, desc, popup_ms?}` with `role` one of `trigger`, `option`,
`item`, `confirm`, `outside` (a click that closes a popover), `search` (a click into a popover's search field), `nav`
(a calendar's month button) or `day`; the event's own `t_click`, `point`, `target`, `strategy` and `popup_opened`
describe the trigger click (`data.retried` when it was clicked twice). A click that changed the page records
`data.navigation` (`{kind: document|url, url}`). A `type` step records `data.rate` and `data.clear`, a `date` step
`data.days`, `data.quick_runs` and `data.waited_close_ms`, a parked step `data.park`. DOM snippets saved next to error
screenshots are capped at 64 KB. `studio schema timeline` prints the timeline schema.

## File formats and versions

Every file Demo Studio reads says which version of its format it is, in a top-level `version` key:

- **Optional** in the files you write — scenarios, `project.yaml`, `template.yaml`, `studio.yaml` — and in `run.json`:
  `version: 1`, or nothing (a file without it is version 1, so every file written before the key existed still
  loads). `studio new` and the runner write it; the starter templates and the fixture's files carry it.
- **Required** in `sandbox.yaml` and in the files Demo Studio writes for itself (`timeline.json`, the hooks journals,
  render and review records, raw export manifests).
- **None** in hook files (`hooks/*.yaml`: a top-level list of hooks has no room for a key) — their hooks are checked
  like a scenario's. A component's `version` (`component.yaml`) is the component's own version, not a format.

A file of a higher version than this Demo Studio reads (a newer Demo Studio wrote it) is refused with one error at its
`version` key — `this project.yaml is version 2: it was made for a newer Demo Studio (this one reads version 1) —
update Demo Studio` — instead of a list of keys this one does not know; `render`, `plan` and `export-capture` refuse a run
whose `run.json` is newer the same way. Demo Studio never rewrites your files: a future incompatible change raises the
format's version and keeps reading the older ones (a `studio migrate` command is in docs/BACKLOG.md).

## Repository layout

```
packages/core         scenario parser and validator, project/template/sandbox model, templating, JSON Schemas
packages/hooks        setup/teardown hooks (http, sql, shell, js), rollback journal, allow-list, secrets
packages/sandbox      sandboxes: start, seed, reset and stop them (process and docker-compose providers), Postgres
                      snapshots, `studio sandbox init` scaffold, take lock, health, ports
packages/runner-web   headless Chromium runner: in-page kit (cursor, resolver), actions, screencast, encoder, timeline
packages/cli          the `studio` command
packages/components   components: manifest schema, registry, validation, scaffolds, theme tokens, kit (L2.2)
packages/editor       edit planner (planEdit → EditPlan, reframing), the Remotion compositions (src/remotion) and the
                      render pipeline (bundle cache, asset server, renderVideo / renderStill / listRenders, exportRender)
packages/review       review of a render: contact sheets, key frames, output-time timeline, checks, report, diff
packages/engine       the engine API the CLI and the MCP server share: workspace / project loading, project, scenario
                      (if_match saves), run, persona-session and sandbox reads, local storage refs, EngineError codes,
                      the run executor of `studio run`, the job queue and its worker (worker-main.ts), the local
                      HTTP servers' gate, 127.0.0.1 listener, tokens and discovery file (src/http/), the workspace
                      index (src/index-db/: node:sqlite, the stat poll, the job watch)
packages/mcp          the MCP server (`studio mcp`): tools over stdio and Streamable HTTP (src/http.ts), zod schemas,
                      results, --print-config, the SDK-free tool layer (callTool) the Studio shares
packages/ui           the Studio web app (`studio ui`): a React app bundled in memory by esbuild and its server — the
                      engine's /v1 HTTP API behind the engine's gate (engine src/http/), an allow-list of the MCP tools,
                      the event stream and the index reads (src/server/live.ts, ops.ts); the scenario screen
                      (src/app/ScenarioScreen.tsx, Inspector.tsx, YamlView.tsx, Thumb.tsx, thumbs.ts)
skills/               the Claude Code plugin: Claude skills + the MCP server from userConfig values (skills/README.md)
.claude-plugin/       the local plugin marketplace (`claude plugin marketplace add <repo>`)
fixtures/wholesale    the fictional "Northfield" product used for end-to-end tests (and its Dockerfile)
projects/             the fixture project and its sandboxes (your projects live in your workspace)
templates/            starter themes: default, editorial, motion
scripts/              requirements.mjs (docs/REQUIREMENTS.md; `--check-cites`: quoted test titles exist), fixture media
                      and preview samples, validate-raw.py,
                      test-pg.mjs (`pnpm test:pg`)
docs/                 SPEC.md (product brief), DESIGN.md and DESIGN-phase2.md (package contracts), HANDOFF.md,
                      ROADMAP.md, BACKLOG.md, ACCEPTANCE-phase2.md, MACOS-CHECKLIST.md
CLAUDE.md             notes for Claude Code sessions (read order, working agreement, commands)
```

Development: `pnpm build` (TypeScript project references), `pnpm test` (vitest; the end-to-end tests start the
fixture on free ports and skip themselves when Chromium or ffmpeg is missing; some CLI tests run `packages/cli/dist`,
so build first). Gated tests:

| Command | What it runs |
|---|---|
| `pnpm test:pg` | the 7 SQL hook tests against a real Postgres (`packages/hooks/test/sql.test.ts`): `scripts/test-pg.mjs` starts a throwaway container `demo-studio-pg-test-<hex>` from `postgres:17-alpine` (never pulled for you: it prints the `docker pull` when the image is missing) on a loopback port Docker picks, with a random password, sets `DEMO_STUDIO_TEST_PG`, and removes that container — only that one — with its anonymous data volume at the end, on an error or on Ctrl-C. A container a killed run left (label `demo-studio.test=pg`) is listed with the command that removes it, never removed. A few seconds; needs a running Docker (or OrbStack) |
| `pnpm test:pg --all` | the whole suite with Postgres, `DEMO_STUDIO_TEST_DOCKER=1` and `DEMO_STUDIO_TEST_SLOW=1`: everything this machine can run |
| `pnpm test:slow` | `DEMO_STUDIO_TEST_SLOW=1`: the committed `catalogue` scenario captured on the fixture (free ports) at 1920×1080 with the debug cursor and its real hooks — duration, every frame's size, the run folder's files, the scroll durations, the drawn hotspot ≤ 3 px from every click point and inside its target, `popup_opened`, no hesitation between steps, the setup rollback (`packages/cli/test/catalogue-acceptance.test.ts`, about 1.5 min); then the MCP acceptances over stdio on a copy of the fixture project — capture → render → review → theme switch → export (`packages/mcp/test/fixture-acceptance.test.ts`), authoring from inspections (`authoring-acceptance.test.ts`), recording (`record-acceptance.test.ts`) and a theme made from the brand-site fixture and brand files, previewed, filmed and reviewed (`theme-acceptance.test.ts`); and the phase 3 acceptance on one empty workspace — a project from a README, a scenario from a script and inspections, a theme from brand files, a workspace component, capture → render → review, a person's comment → scenario fix → re-capture → render → resolve, about 7 min (`phase3-acceptance.test.ts`) |

Set `DEMO_STUDIO_TEST_PG` yourself to a PostgreSQL URL (a role that may create tables) to run the SQL hook tests
without the script, `DEMO_STUDIO_TEST_OLD_NODE` to an older `node` binary (e.g. a
Node.js 10) to check the CLI's version message on it, and `DEMO_STUDIO_TEST_DOCKER=1` to run the docker-compose
sandbox tests (a running Docker; `packages/sandbox/test/compose.test.ts` uses busybox:1.38.0, postgres:17-alpine and
axllent/mailpit:v1.29.4, `packages/cli/test/sandbox-docker.test.ts` builds the fixture's image on node:22-alpine). They
name their compose projects and images `demo-studio-test-*` and remove them before and after; base images stay.
`packages/runner-web/test/look.test.ts` compares the drawn cursor and the file chip with golden images
(`packages/runner-web/test/golden/`, with a tolerance; the chip's only on macOS: its text uses the system font) next
to structural checks; after an intended change of the look (or a Chromium update that moves it), rewrite them with
`DEMO_STUDIO_UPDATE_GOLDEN=1 npx vitest run packages/runner-web/test/look.test.ts` and look at the PNGs before
committing them.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core, hooks, web runner, CLI, fixture product, starter templates | **Done** — the `catalogue` and `quote` fixture scenarios capture headless at 1920×1080 |
| 2 | Components, themes, editor (Remotion), review artefacts | **Done** (2026-10-12; acceptance in [docs/ACCEPTANCE-phase2.md](docs/ACCEPTANCE-phase2.md): `catalogue` and `quote` rendered with the editorial theme and reviewed clean, then re-rendered with the motion theme and with another layout component without touching the scenario, a video with your own intro file and alpha overlay, a raw export validated) — contracts in core (L2.1), the components package (L2.2: manifests, registry, validation, scaffolds, kit, `studio components`), the edit planner (L2.3: `planEdit`, `studio plan`), the render pipeline (L2.4: placeholder library, `DemoVideo`, `studio render` / `still`), the reference-look components (L2.5: intro, outro, card layout with geometry following params, captions, clock interstitial, crossfade — measured on renders), the review (L2.6: `studio review`, contact sheets, key frames, checks, report, diff) and the full library with previews (L2.7: browser / laptop / phone / tablet / raw layouts, overlay caption, cards, minimal intro/outro, plain interstitial, callout, lower third, fade-black; committed previews, `studio components preview`) and variants & export (L2.8: vertical and square reframed on the cursor and the targets, real 4K captures, music bed, theme default zoom, `studio export`) and mails, notifications & documents (L2.9: `mailbox`, `wait_for_email`, `download` with PDFs rasterised by pdf.js, web notifications captured, artefacts in components, notification / mail / document / phone cards, tap-open transition), tutorial overlays & story cards (L2.10: key caps, spotlight, step badges, loupe, progress bar, figure / features / before-after / testimonial / CTA / chart cards) and several pages at once (L2.11: multi-page scenes filmed on one clock, `studio/layout-split`, `studio/layout-pip`, per-pane camera and overlays) and your own media & motion (L2.12: video / image / Lottie segments, alpha overlay videos, Lottie overlays, `studio/media`, `studio/lottie`, [docs/BRING-YOUR-OWN-MOTION.md](docs/BRING-YOUR-OWN-MOTION.md); waits shown as short loading states) and the raw export for editors (L2.13: `studio export-capture` / `run --raw`, clips per scene with loads cut, MP4 / ProRes at 30 / 60 fps, cursor baked / absent / transparent layer, FCPXML / EDL / OTIO / CSV markers, manifest) |
| 3 | MCP server, authoring (script → scenario, page inspection, recording), skills | **Done, pending the live run** (automated acceptance in [docs/ACCEPTANCE-phase3.md](docs/ACCEPTANCE-phase3.md): on one empty workspace, a project from a README, a scenario from a script and page inspections, a theme from brand files, a workspace component, capture → render → review clean, a person's frame comment → scenario fix → re-capture → render → resolve, zero approvals; the same loop by Claude itself in Claude Code is `docs/MACOS-CHECKLIST.md` step 12j) — L3.1: `studio mcp` with the read side (projects, scenarios with `if_match` saves, runs, sessions, sandboxes), dry runs, captures, hooks, environment resets, sign-ins and sandbox up / reset as jobs run by a background worker (`studio jobs`), human approval of hooks and shell seed steps through elicitation; L3.2: renders (guarded: project files only, no network), reviews with the contact sheet as images, exports, and themes / components (list, detail, previews as images, validate, scaffold) through MCP; L3.3: page inspections and a script-table skeleton for Claude's authoring; L3.4: recording a scenario a person performs (`studio record`, `scenario_record`); L3.5: themes from brand inputs and from a site URL (`template_create_from_brand`, `template_from_site`, contrast checked); L3.6: frame comments (`studio comment`, anchors on the plan's steps and markers, `comments_list` / `comment_reply` / `comment_resolve`); L3.7: the Claude skills (scenario, theme, component) and the Claude Code plugin that bundles them with the server; L3.8: the phase 3 acceptance, and a warning when the scenario changed since the run was captured (a render shows the run as captured) |
| 4 | Studio web app (scenario blocks, timeline, frame comments) | In progress — L4.1: `studio ui` serves the Studio on 127.0.0.1 behind the engine's HTTP gate (one-time link, token, allow-list of the MCP tools): the Projects screen with search and recent activity (the workspace index), the README editor, live updates; `studio mcp --http` |
| 5 | macOS desktop shell, iOS Simulator runner | Planned |
| 6 | Licensing, packaging, component marketplace | Out of scope for now |

The macOS verification pass and its fixes are done (lots L1.5 and L5.1, results at the end of
`docs/MACOS-CHECKLIST.md`). Next: capture smoothness (L1.3), then L1.2, L1.6, L1.7, L1.8 and L1.4 before phase 3 — in local Claude Code sessions on a Mac, on the `main` branch (see
`CLAUDE.md` and `docs/HANDOFF.md`).

Planning lives in the repo: `docs/ROADMAP.md` (small lots and their status), `docs/REQUIREMENTS.md` (every requirement
of the brief with its status, generated by `pnpm req` from `docs/requirements.json`) and `docs/HANDOFF.md` (where to
start in a new session).
