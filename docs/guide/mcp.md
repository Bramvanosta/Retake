# Claude and MCP

The MCP server that lets Claude drive Retake, and the Claude skills and plugin. Part of the [Retake guide](README.md).

## MCP: Claude drives Retake

`retake mcp` is an [MCP](https://modelcontextprotocol.io) server over stdio: a Claude session (Claude Code, Claude
desktop, any MCP client) lists the projects, reads a README, writes and validates scenarios and reads runs, sessions
and sandboxes through tools, dry-runs and captures scenarios, runs hooks and resets environments, and the CLI and the
server share one engine (`@retake/engine`): a dry run, a capture or hooks started here run the same code as
`retake run` / `retake hooks run` / `retake env reset`. Hooks that need a human are approved by the user through an
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
never written through the server. People comment frames of a render (`retake comment add`); Claude lists the comments
with their anchor and still, adapts the video, replies and resolves them with the new render (see
[Frame comments](review.md#frame-comments)).

**Registering it.** `retake mcp --print-config` (from your workspace, or with `--root <workspace>`) prints the JSON
block and the `claude mcp add` command with absolute paths (in this repository run `node packages/cli/dist/bin.js mcp
--print-config`: `pnpm retake …` prints a banner before the JSON). An extra `-e NAME=value` goes **before** the `--`.
It also prints the lines that install the **Claude Code plugin** instead (the Retake skills and this server, from
the repository's local marketplace; see [`skills/README.md`](../../skills/README.md)) — use one or the other, not both, or
Claude Code gets two `retake` servers:

```sh
# Either: Claude Code, for every project of this user (what --print-config prints, shortened):
claude mcp add retake --scope user -e PATH=<…> -- <node ≥ 22> <repo>/packages/cli/dist/bin.js --root <workspace> mcp
# Or: the plugin, enabled in the workspace folder only (+ --config home=<…> when RETAKE_HOME is set):
claude plugin marketplace add <repo>
cd <workspace> && claude plugin install retake@retake --scope local --config node=<node ≥ 22> --config cli=<repo>/packages/cli/dist/bin.js --config workspace=<workspace>
```

```json
{ "mcpServers": { "retake": {
    "command": "/Users/you/.local/share/mise/installs/node/22/bin/node",
    "args": ["<repo>/packages/cli/dist/bin.js", "--root", "<workspace>", "mcp"],
    "env": { "PATH": "<node's folder>:…:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "RETAKE_HOME": "<only when you set it>" } } } }
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
  corepack) and without relative entries (`.`, `bin`: they would resolve in the client's project folder). `retake
  mcp` completes the PATH it is started with the same way, so a client that passes none (the plugin, Claude desktop)
  still finds those tools. Secrets the `{{env:…}}` references of project.yaml need go in `env` too (or in the
  keychain): a GUI client does not read your shell profile; the plugin carries none. `RETAKE_HOME` is carried
  over when set (the plugin: its `home` value, which replaces an inherited `RETAKE_HOME`; empty: `~/.retake`).
- The plugin loads in place from `skills/`: `git pull` + a new session (or `/reload-plugins`) updates the skills; run
  the install line again to change a value. `claude --plugin-dir skills` is for editing the skills: that session loads
  the plugin as `retake@inline`, which hides an installed one and has none of its values, so **its MCP server is
  missing** (`/plugin configure` in that session, or the `claude mcp add` registration).
- Without a workspace (`--root`, `RETAKE_ROOT` or a `retake.yaml` above the folder it starts in) it refuses to
  start, on stderr, exit 2. stdout carries the protocol only.

**Over HTTP.** `retake mcp --http` serves the same tools, instructions and approval forms as Streamable HTTP at
`http://127.0.0.1:47820/mcp` (`--port N` for another port; `0`: a free one) until Ctrl-C, for a client that registers
a URL rather than a command. The server checks a bearer token: a stable one, created once in the Retake home
(`~/.retake/mcp-http.token`, mode 600), so the registration survives restarts; `--rotate-token` replaces it (then
register again). `retake mcp --print-config --http` prints the registration, and never the token itself:

```sh
# Claude Code, for every project of this user: the shell reads the token from its file as the line runs
# (your shell history keeps "$(cat …)", not the token; Claude Code keeps the header in its own user settings)
claude mcp add --transport http retake http://127.0.0.1:47820/mcp --scope user --header "Authorization: Bearer $(cat ~/.retake/mcp-http.token)"
# Or the JSON it prints in .mcp.json at the workspace root — "Authorization": "Bearer ${RETAKE_MCP_TOKEN}", no
# token in the file (safe to commit) — with the variable set where claude starts (your shell profile):
export RETAKE_MCP_TOKEN="$(cat ~/.retake/mcp-http.token)"
```

Use it **instead of** the stdio registration, not beside it, and keep `retake mcp --http` running (a terminal, a login
item). While `claude mcp add` runs, the token is in its command line (visible to your own account's `ps`). Each MCP
session keeps its server, so an approval form reaches the client that asked. At most 8 sessions: a session in use (a
call running, or the client's event stream open) never expires and is never closed for another; one not in use is
closed after 30 min, or at once when a new client needs its place (a Claude Code that restarted without saying
goodbye). The token is a secret: whoever holds it drives this workspace's tools and answers their approval forms — as
the client that spawns `retake mcp` over stdio does; never paste it into a file you commit. See [Security](security.md#security)
for what the server refuses.

**Tools.**

| Tool | Does | Writes |
|---|---|---|
| `engine_info` | version, workspace root, features; `started_in` (the folder the client started the server in) and whether it is outside the workspace | — |
| `project_list` | projects: slug, name, folder, scenarios, environments (a broken one with its error) | — |
| `project_get` | README + `readme_hash`, scenarios, environments (pages, display URLs, production / access, sandbox, persona names) and project.yaml with its defaults | — |
| `project_create` | a project folder (README, project.yaml, scenarios/, hooks/, assets/, .gitignore); refuses an existing slug | new files only |
| `project_update_readme` | replaces README.md; `if_match` = `readme_hash` once it exists | README.md |
| `project_prune` | what `runs/`, `renders/` and `review/` hold that nothing needs (failed takes, dry runs, older captures and renders: `retake prune`), with the bytes it frees; `dry_run` (default true) only lists, `dry_run: false` deletes (annotated destructive) — only when the user asked to free space | `runs/`, `renders/`, `review/` (deleted) |
| `scenario_get` | a scenario's YAML and its sha256 `hash` | — |
| `scenario_validate` | issues of YAML text (line / col), nothing saved | — |
| `scenario_save` | validates, then writes `scenarios/<name>.yaml`; refuses errors; overwriting needs `if_match` (the hash `scenario_get` gave; a conflict names the current one); a new one takes `if_match: null` | the scenario |
| `page_inspect` | what a page shows, for writing steps (see *Authoring* below): `page` (+ `path`) or `url` (an origin of the environment's pages only), or `scenario` + `until` (a dry replay up to that step; a failing step is inspected where it failed); `persona`, `within` (list only inside a target), `targets` (≤ 20 of your own, checked), `limit` (default 80, ≤ 300), `images` (`marked` default, or `none`), `detail` (`compact` default, or `full`); a job, waits up to `wait_s` (default 25). Returns counts, open popups and the marked screenshot as an image; compact (L5.8): the elements in view or in a dialog, menu or popover, each as its mark, context, action and step hint as one line of YAML (`matches`, `fragile` and state flags only when set), page text under `untrusted`; `full`: every element with its box, state, texts, verified target, and the scroll containers | `.retake/inspect/<id>/` |
| `scenario_record` | a recording the **user** performs (see [Recording a scenario](scenarios.md#recording-a-scenario)): `page` (+ `path`) or `url` (an origin of the environment's pages only), `persona`, `scenario` (the draft's name; saved only when free), `check` (default true); a job returned at once — a browser window opens on the user's machine, the user performs the flow and closes it (Claude never drives it), the window holds the queue (≤ 30 min); `job_status` then returns counts, the saved file and hash, the check replay, issue counts, and the draft (`draft_lines`), its scene ids and issues under `untrusted`; `job_cancel` while the window is open discards it | `.retake/records/<id>/`; `scenarios/<name>.yaml` when free; the environment, through what the user does in the window (read-write environments) |
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
| `comments_list` | the frame comments of a project (see [Frame comments](review.md#frame-comments)): `scenario`, `render` (an id or `latest`: threads made on that render as it is now), `status` (`open` default, `resolved`, `all`), `limit` (default 20, ≤ 100); each thread's render (and whether it is still on disk), frame, time, region, anchor (segment, component, scene, step, `step_ref`, step fingerprint, action, page, marker, overlays, transition), `step_now` (that step in today's file, by id else fingerprint; null when gone), its last 10 entries with their channel (`entries_total` counts them all), the resolution, newer renders and its `hash`; the stills (region outlined) as images; the comment, replies, notes and author names under `untrusted` (at most 60,000 characters per result: the next threads are left out, `left_out_for_size`) | — |
| `comment_reply` | appends a reply to a thread (`comment_id`, `text` ≤ 2000 characters), written as `mcp`; returns the entry id and the new hash | `comments/<scenario>/<id>.json` (an entry) |
| `comment_resolve` | resolves an open thread: `note` (what changed), `render_id` (a later render of the same scenario and variant, or `latest` of that variant), `if_match` (required: the hash `comments_list` or `comment_reply` gave; a person's entry meanwhile = `conflict` with the current hash); written as `mcp`, reopened only by a person | `comments/<scenario>/<id>.json` (an entry) |
| `template_list` | the themes by name (the workspace's `templates/`, then the starters): source, the component each picks per kind, issues; `project` marks the project's own (and lists its own theme folder); `template` returns one theme in detail — template.yaml and its sha256, colours, fonts, brand, assets, each kind's component with its params | — |
| `template_preview` | stills of a theme (default the project's): its intro, its layout with its caption over a neutral sample screen, a card, an interstitial and its outro, 960×540, rendered as a job; waits up to `wait_s` (default 20) and returns them as images (4 inline, the 5th as a file) | `.retake/previews/<id>/` |
| `template_from_site` | asks the user to approve the URL (elicitation; without it: `needs_approval` with the `retake theme from-site` command), then extracts a public page as a job (see [Themes from a site](themes-and-components.md#themes-from-a-site)): colour roles and swatches with contrast, logo candidates as `site:<id>/logo-<n>` PNGs, the screenshot and logos as images (a third-party page), the font names and every page string under `untrusted`, a draft brand input and the template.yaml it would make; waits up to `wait_s` (default 25) | `.retake/site/<id>/` |
| `template_create_from_brand` | a **new** theme from the user's brand files (see [Themes from your brand](themes-and-components.md#themes-from-your-brand)): `name`, `base`, `colors` (hex; `accent` required), `background`, `adjust`, `logo`, `wordmark`, `fonts {display, body[]}` (files relative to the workspace root, outside hidden, `components/` and agent-writable folders; a logo or wordmark may be `site:<id>/logo-<n>` of `template_from_site`), `brand {name, url}`, `replace` (only an unchanged theme this tool made); returns the folder, template.yaml, the palette with every ratio and change, the fonts (their name strings under `untrusted`) and warnings; then `template_preview` | `templates/<name>/` (a new folder) |
| `component_list` | components by id (workspace first, then the built-in `studio/…`; `kind` filters): kind, version, source, description, slot names, the committed preview and whether it is fresh; registry notices (invalid, overriding) | — |
| `component_get` | one component: manifest (slots and their types, params JSON Schema with defaults, duration, geometry, preview samples), params with defaults, source files, README | — |
| `component_validate` | a component's issues (component.yaml, id vs folder, entry, the esbuild compile allowing react / remotion / the kit; nothing executed), positioned | — |
| `component_preview` | a still of one component with a theme (default the project's), the manifest's samples or your `slots` (text, url, color slots) and `params` (checked against its schema), `at_s`; a job, returned as an image like `template_preview`; never written into the component's folder | `.retake/previews/<id>/` |
| `component_create` | scaffolds `components/<namespace>/<name>/` from its kind's template (component.yaml, index.tsx, README.md; `description` and `name` written as text), validated, no preview; refuses the `studio/` namespace and any built-in id | the new component folder |
| `job_list` / `job_status` / `job_cancel` | the jobs of the workspace (any session's), one job's state, progress and result (a preview's stills as images; an inspection as `page_inspect` returns it, marked screenshot included; a recording's draft), a cancel; `job_status {wait_s}` waits up to 600 s (a capture or a render followed in one call, a progress notification at least every 15 s); a run, render, preview, review, export, inspect or record job's error message is under `untrusted.error` | — |
| `hooks_run` | hooks outside a capture as a job: `reset`, `<scenario>:setup`, `<scenario>:teardown` or `hooks/<name>.yaml`, on `env`; **dry by default** (templated and security-checked, nothing executed, nobody asked: the result marks the hooks a real run needs approved); `dry: false` runs them, setup-like ones with a journal of rollbacks | the environment, through the hooks; `.retake/journals/` |
| `env_reset` | as a job: replays every pending rollback (captures' and hook runs' journals, an interrupted job's too), then the project's `reset` hooks; dry by default | the environment; the journals |
| `auth_status` | each persona's last known session state and the `retake login` command a human runs (no live check, no browser) | — |
| `auth_login` | signs a persona in, as a job: `headed` (default) opens a browser window **on the user's machine** — the user signs in there and closes it, Claude is told to ask them and never sees a password; `auto` plays the persona's `login:` steps (their secrets come from the server's environment or the keychain). The result says whether the session works now (no path, no cookie). The window holds the queue until it is closed, at most 30 minutes (`RETAKE_SIGNIN_MAX_MIN`; then it closes, nothing saved) | the session, in `~/.retake` |
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
- **Files.** `<project>/.retake/inspect/<id>/`: `inspect.json` (the whole report), `screenshot.png` (the viewport,
  cursor hidden, at the capture scale), `marked.jpg` (numbered boxes of the elements in view, except those something
  is drawn over), and the dry replay's run.json, log and step-failure screenshot; the newest 20 inspections are kept
  (never one whose job is queued or running; `job_status` says when a finished one was pruned since). Never in `runs/`: `run_list`,
  `latest` and reviews do not see them. A result over 80 kB drops elements from its end (`truncated`; inspect.json has
  them all). An inspection counts nothing in the history. `retake inspect` does the same from a terminal (no queue;
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

**Jobs and the worker.** A dry run, a capture, a hooks run, an environment reset, a sign-in, a sandbox up / reset, a render, a review, an export, a preview, an inspection or a recording is a *job*: the call queues it (under `<workspace>/.retake/jobs/`,
with the run id reserved at once) and the workspace's **worker** — a separate background process the server starts,
`.retake/workers/worker.log` — runs it: one capture-side job at a time (a take, hooks, a sign-in, a recording, an
inspection) and, beside it, one render, review, export, preview or site extraction in a job process of its own that waits
while a take films on this Mac and yields during one (a capture uses the machine's CPU and GPU fully); it
exits after a minute without work. So no call outlives an agent's timeout: `run_dry` waits at most `wait_s`,
`run_capture` returns at once, and `run_status {wait_s: 25}` (called again until the run is finished) or
`job_status {job_id, wait_s: 600}` follows it with progress notifications. Results carry their JSON on one line, and
`run_status`, `review` / `review_get` and `page_inspect` answer compactly unless `detail: "full"` (L5.8, measured on the
fixture: a page inspection ≈ 13,300 → 2,200 tokens, a dry run's status ≈ 2,700 → 900, a review ≈ 2,200 → 400). A job `succeeded` when it ran to the end — its run may still have failed (`result.status`);
`failed` means it could not run (a scenario changed since it was submitted — a run, an inspection or a scenario's
hooks: submit it again —, a sandbox that would not start…).
- The worker outlives the session that started it: a capture under way when Claude Code closes still finishes, with its
  teardown, and its result waits for the next session (`job_list`). It keeps the environment (`env` block) of the
  server that started it: after changing that block, wait until it exits (`engine_info` shows it) or stop it.
- Stopping it: `run_cancel` / `job_cancel`, or a signal — the first SIGINT / SIGTERM cancels the running job (its
  teardown and rollbacks run) and the worker exits; a second one quits at once. A worker that is killed (`kill -9`,
  a crash) leaves its job `interrupted`: the run stopped where it was, and `retake env reset <project>` replays the
  rollbacks it left pending. Sandbox services a killed worker had started keep running, as after `kill -9 studio`
  (`retake sandbox down`).
- After `pnpm build` (or a `git pull`), an idle worker notices that its code changed and exits; the next job starts a
  new one.
- `retake run` in a terminal does not go through the queue (it runs in its own process, as before), so two captures —
  one from a terminal, one from Claude — can run at the same time.
- A recording (`scenario_record`) holds the queue while its window is open, as a headed sign-in. The worker's first
  signal closes its window and keeps what was recorded (the draft made and saved, its check replay skipped);
  `job_cancel` discards it — except a recording you started from the Studio, which only the Studio stops or discards
  (Claude's `job_cancel` is refused while it runs; a `retake jobs cancel` typed in a terminal, or a `cancel` file
  written in the job's folder, still discards it — the BL-76 class). Claude can still read a Studio recording's draft
  (its job's result names the folder): it holds what you typed, as any recording does. A killed worker leaves no draft
  (`retake record` again; the events streamed so far stay in the recording's folder).
- A killed sign-in leaves nothing saved (`retake login` again); a killed sandbox job may leave services running and its
  seed unrecorded (the next `retake sandbox up` seeds again). Each interrupted job's `fix` says so.
- **Renders.** `render` plans in the server's process (no browser; a refusal costs nothing), reserves the render id
  (a `.<scenario>-v<N>.lock` in `renders/`) and queues the job; the worker plans again — a run whose timeline changed,
  or a plan whose variant changed, is refused — and renders with Remotion (≈ 1–3 min for a minute of video, longer
  for 4K). It holds the queue meanwhile: a capture submitted then waits (`run_status` / `render_status` say behind which
  job). A failed or cancelled render writes nothing under its id and frees it: the next render of the scenario takes
  the same id (`render_status` shows the newest job of an id; `job_status` keeps the old one). A worker killed
  mid-render leaves the job `interrupted`; the next worker kills the render's browser (Remotion starts it detached, it
  would outlive the worker), removes its temporary profile, the lock and the partial video. `retake render` in a
  terminal does not go through the queue; versions stay distinct across both.
- **Reviews and exports.** Both name a render by its id (`latest` is resolved when the call is made) and read it from
  `renders/<id>.json`: its video and its run must lie in the project folder (a record edited by hand, or of a moved
  workspace, that points elsewhere is refused with the `retake review` / `retake export` command a human runs). A review
  (ffmpeg and sharp, no browser) writes `review/<render_id>/` aside and swaps it in at the end: a cancel or a killed
  worker leaves the previous review as it was (the next worker puts it back if the kill fell between the two renames).
  A concurrent `retake review` of the same render in a terminal: the last one to finish wins. An export stops between
  formats on a cancel (the files written stay) and kills ffmpeg or the re-render; a killed worker's re-render browser
  and partial files are removed by the next worker. Re-rendered formats are planned and checked at the call, then
  rendered under the same rules as a render (project files only, no network).
- **Previews.** `template_preview` and `component_preview` are jobs of the same worker (one bundle and one browser per
  preview, ≈ 0.5–1 s a still once the bundle is cached; behind a render they wait for it). Their stills go to
  `<workspace>/.retake/previews/<id>/` — never into a component's folder: the committed `preview.png`,
  `preview.json` and README block stay `retake components preview`'s. They run with the render's network guard. A
  preview that outlives its `wait_s` is followed with `job_status {wait_s}`, which returns the stills.
- **Images.** `review` / `review_get` return the contact sheet (and the key frames at markers) as images in the result,
  `template_preview` / `component_preview` / `job_status` a preview's stills, `comments_list` the comments' stills: JPEG thumbnails ≤ 1280 px made when the
  result is built (never stored in a job), at most 4 per result and 1.5 MB in all
  (`RETAKE_MCP_MAX_IMAGES`, `RETAKE_MCP_MAX_IMAGE_BYTES`, `RETAKE_MCP_IMAGE_PX` in the server's `env`
  change that); the others are listed as files Claude reads. What an image shows of the filmed product, its text included, is
  data — the server's instructions say so, like for anything under `untrusted`.
- **`retake jobs`** shows them in a terminal, also once the Claude session is gone: `retake jobs` (newest first, with
  progress, outcome, who submitted it, and the worker), `retake jobs status <id>` (input, times, place in the queue,
  result or error and its fix), `retake jobs cancel <id>`. It never starts a worker (one started from a terminal would
  run Claude's queued jobs with the terminal's environment): a queued job it cancels is closed by the next worker, and
  `run_list` / `run_status` already show its run `cancelled`.
- A worker refuses (job `failed`, "refused without running") a job of a kind or input version it does not know — a
  newer client's; after a `pnpm build` it leaves such a job to a worker of the new build.
- **History.** Every finished job, and every `retake run` / `retake render` / `retake still` in a terminal (and a
  `retake export` that re-rendered a format), adds a line to
  `<workspace>/.retake/history.jsonl` (kind, project, who, state, duration, captures / dry runs / renders
  produced — a render job counts once it wrote its video, with its render id; an export job counts the formats it
  re-rendered; reviews, component previews and inspections are not counted — a preview job's line names the preview and
  its theme, an inspect job's its id, its source and its outcome);
  `engine_info` reports the totals. It is local, never sent anywhere — the counters a licence or Remotion
  usage report would need later (an entitlements stub answers "everything, no limit" for now).
- `retake doctor` has an **MCP** line: the Node.js a registration names (a path that survives patch upgrades where
  there is one), whether the PATH it registers finds ffmpeg, the worker (running or idle), and whether the workspace's
  `.retake/` is git-ignored when the workspace is a git work tree.

**Safety.**
- **Hooks need a human.** The agent driving the server can write the scenarios it runs (`scenario_save`), so the trust
  flags of hook files do not count for work submitted through MCP: `confirm: true` is ignored, every destructive hook
  and every **shell** hook (a local command) needs the user's approval, and a shell hook always counts as writing —
  its `writes: false` is ignored, so it never runs on a production or read-only environment. When `run_capture`,
  `run_dry {hooks: "run"}`, `hooks_run {dry: false}` or `env_reset {dry: false}` needs such hooks, the server first
  checks them without running anything (templated, secrets as `***`; what a safety rule refuses fails the call at
  once), then asks the user once, through the client's approval form (MCP elicitation, form mode): the project, the
  environment (production or not, read-only or not), each hook in full and why it needs approval, and the `retake`
  command to run it in a terminal instead.
  - **In full.** Each hook is shown as it will run, its name once in its heading, then every field on a line of its
    own, templated and never cut: a shell hook's `run`, `cwd` and each `env` entry; a sql hook's statement (or its
    file) and database; a js hook's code (or its file) and page; an http hook's method, URL, headers and body. Secrets
    are `***`; control, bidirectional and invisible characters are written out (`\u{202e}`), and a value of several
    lines continues on lines starting with `|`, so it never reads as another field or hook. A hook longer than 4,000
    characters, or a form longer than 16,000, is refused before anyone is asked: run it in a terminal (the fix).
  - **Loader variables.** A shell hook the agent wrote — the scenario's `setup`, `teardown` and own `hooks:`, and a
    project.yaml hook whose templates use the scenario's `vars` — may not set a loader variable (`PATH`, `HOME`,
    `NODE_OPTIONS`, `LD_*` / `DYLD_*`, `GIT_*`, `PYTHON*`, `npm_config_*` and the like: they change what a program loads
    or the shell it starts), neither in its `env` nor in the command (`NAME=…` before any command of it, `env` /
    `export NAME=…`, `for NAME in`, `read NAME`…, after `;`, `&&`, `||`, `|`, inside `( )`, `$( )` or backticks).
    Such a hook is refused before anyone is asked, and again when the job runs. A hook of your own files —
    project.yaml with its own `vars`, `hooks/<name>.yaml`, a sandbox's seed — is shown in full and asked about, not
    refused: move such a hook there, or run it in a terminal.
  - **Rollbacks.** A setup hook whose rollback is destructive (HTTP DELETE, destructive SQL) or is a shell command or
    JavaScript needs the approval too — even when the hook itself only reads: its rollback runs later (a failure, a
    cancel, `env_reset`) without asking again. The form shows each rollback in full the same way, after its hook
    (`rollback run: …`, `rollback method: DELETE`, `rollback url: …`).
  - Approved: the job is queued with the approvals — fingerprints of the hooks *as their file declares them* (with
    their phase, position and environment) and of the project files they reference (sql / js files, the scripts a
    shell hook names: `./seed.sh`, `psql -f reset.sql`); the worker runs a hook that needs approval only when its
    fingerprint is listed, so a hook or a script changed between the question and the run is refused. A scenario's
    hooks (`<scenario>:setup` / `:teardown`, and a capture's) run from the scenario bytes the form was built from:
    the job carries their sha256, and a scenario changed since — its `vars` included — fails it as `conflict`
    (submit it again). Each approval
    is signed with a key kept in `~/.retake/approvals.key` (`RETAKE_HOME`; 0600): the worker ignores an
    approval a submit did not sign (a job file written by hand into `.retake/jobs/`). Replaying the rollbacks of
    hooks a human or an approval let run is never asked about again.
  - Declined, dismissed, not answered within 10 minutes (`RETAKE_MCP_APPROVAL_TIMEOUT_MS` changes that), or a
    question that failed: the call is refused (`refused`) with the `retake …` command a human runs; nothing is queued.
  - A client that cannot show the form (no elicitation support): refused with `needs_approval` and the same command.
    Claude Code declares elicitation; Claude desktop is not tested yet. Claude Code's own tool timeout
    (`MCP_TOOL_TIMEOUT`) also bounds how long a question can stay open.
  - From a terminal (`retake run`, `retake hooks run`, `retake env reset`) nothing changes: `confirm: true` and
    `--yes` / the prompt approve destructive hooks, and a shell hook's `writes: false` counts.
  - A dry run (`run_dry` without `hooks: "run"`, `hooks_run` / `env_reset` by default) asks nobody.
  - **Sandbox seeds.** `sandbox_up`, `sandbox_reset` and `run_capture {sandbox: true}` may run a sandbox's seed: its
    **shell** steps are approved the same way, each shown in full as sandbox.yaml declares it (a local command is local
    code, whatever the sandbox is). Its http and
    sql steps rebuild the sandbox's own data (checked before the reset changes anything) and an `exec` step runs inside
    a sandbox container: none of them is asked about. From a terminal (`retake sandbox up`) nothing is asked, as before.
- **Renders read the project, and nothing else.** Through MCP a render (and `plan_preview`) is checked before any
  file is read: every file the capture's timeline names — card and overlay images, `data:` CSV / TSV slots, your own
  video / image / Lottie files, the music bed (the scenario's or `overrides.music`) — is a file of the project folder
  (no absolute path, `..` or symbolic link out of it; a refusal never says whether a file exists); a Lottie file counts
  as code (its expressions run in the render) and is never taken from a folder Claude writes (`scenarios/`…); a slot
  value that is a remote URL is refused (put the file in `assets/`); a theme is named (`template`, a scenario's
  `template:`), never a folder — except the project's own `template:` of project.yaml. After planning, every file the
  plan serves must lie in the project, the run or the theme folder (a theme whose logo or font leaves its folder is
  refused). The worker checks it all again. The refusal names each file and where it is used, with the `retake render`
  command a human runs.
- **The render's browser has no network.** A render through MCP runs with a network guard: its Chromium (Remotion's,
  which runs component code) loads the files of the plan from the local asset server and the bundle from Remotion's
  own server — any other request (another host, another local port such as your own services, an IP literal, a
  navigation) fails and the render warns with the origin only; Remotion's `/proxy` passes only for those files, and
  an `<Audio>` / `<Video>` source Remotion would download itself is refused (the render fails). WebSockets are blocked
  for every render by a Content-Security-Policy of the bundle; WebRTC is not covered (full isolation: BACKLOG). A
  `retake render` in a terminal keeps the network (remote images in slots work there).
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
  `scenario_validate`, at submit (with the `retake` command a human runs) and again by the worker.
- **Files stay in the project.** Through MCP, a file a scenario or hook names — `drop_file` `path`, eval `file`, a
  hook's sql / js file, a script its shell command runs — is relative to the project folder and inside it, symbolic
  links followed (no absolute path, `~` or `..` out of it; a templated path is checked when the step runs), and code is
  never run from a file Claude can write (README.md, `scenarios/`, `runs/`, `renders/`, `review/`, `exports/`,
  `.retake/`): keep scripts in `hooks/` or `assets/`. From a terminal nothing changes.
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
  `retake comment` or write comments/ (Claude Code's own shell and file tools included) writes as `cli`: the channel
  says how an entry was written, not who wrote it.
- No tool deletes anything; overwriting an authored file needs `if_match`. Environments `project_create` declares are
  neither production nor read-only: a human marks production environments in project.yaml (there is no tool that
  changes project.yaml).
- **What reaches the model.** Whatever a tool returns — README, scenarios, run summaries, page text under
  `untrusted`, file paths — becomes part of the Claude conversation, i.e. goes to the model provider. Files a tool
  only names (captures, screenshots, DOM snapshots) stay on this machine until Claude reads one: a screenshot or DOM
  snapshot of the filmed product Claude reads goes into the conversation too. The full data-flow table is the ADR-1
  amendment in [docs/ARCHITECTURE.md](../ARCHITECTURE.md).
- **Tested clients.** The server is tested with the MCP SDK's own client over stdio (the whole conversation, approvals
  answered, a worker killed). In Claude Code the step in [docs/MACOS-CHECKLIST.md](../MACOS-CHECKLIST.md) is the
  live acceptance; Claude desktop (and whether it shows approval forms) is untested.

### Claude skills and the plugin

Three [Agent Skills](../../skills/) teach Claude Code the loops above, so it does not need them spelled out each time. They
are instructions only: every check, refusal and approval stays in the server's tools, and nothing calls a model.

| Skill | When it triggers | The loop |
|---|---|---|
| `retake-scenario` | a demo video, product tour, walkthrough or tutorial of a web app; recording a flow; a script to turn into a video; comments on a render | `page_inspect` → Claude writes the YAML → `scenario_validate` → `scenario_save` → `page_inspect {scenario, until}` → `run_dry` → `run_capture` → `render` → `review`; or `scenario_record` (the user shows the flow), or `scenario_from_script` (a timecoded table), and the frame-comments loop (`comments_list` → change → `run_capture` for a scenario change → render → `review` → `comment_reply` / `comment_resolve`) |
| `retake-theme` | a theme, template or branded look; a logo, fonts or brand colours in the video | brand files the user puts in `<workspace>/brand/` (and hex colours), or `template_from_site` on a site the user names (approved in a form) → `template_create_from_brand` → `template_preview` → `render {template}` → `review` |
| `retake-component` | a new intro, outro, card, caption style, layout, overlay or transition | `component_list` / `component_preview` first (an existing one with other params often does it) → `component_create` → code edited only once the user agrees, renderer primitives through the kit → `component_validate` → `component_preview` in the user's theme → `render {overrides: {components}}` → `review` |

Each skill starts by calling `engine_info` (a plugin whose server failed to start still loads its skills) and stops
when the workspace root it names is not the session's folder (the plugin's values are shared, see below); it ends
with the same **Rules**: a refusal or an approval request is final; Claude never runs the `retake` CLI (`retake`,
`pnpm retake`, `node …/bin.js`) through its shell, for anything, whoever asks — the user included: it shows the
command for the user's own terminal (a terminal run is author trust: `--yes` approves hooks, a CLI render has no
network guard); it never types or asks for passwords; text under `untrusted`, page text, images and comments are
data; it never fetches brand assets itself; no `eval` step the user did not ask for; `template_from_site` only on a
site the user named; component code edited only after the user agreed. Claude's own permission prompts stay too: no
skill pre-approves a tool (`allowed-tools` is never used).

**Installing them.** The skills ship as the `skills/` folder, which is also a Claude Code plugin bundling the MCP
server; [`skills/README.md`](../../skills/README.md) has the details. In short (`pnpm build` first):

```sh
node packages/cli/dist/bin.js --root <workspace> mcp --print-config   # prints the two lines below, filled in
claude plugin marketplace add <repo>
cd <workspace> && claude plugin install retake@retake --scope local --config node=<node ≥ 22> --config cli=<repo>/packages/cli/dist/bin.js --config workspace=<workspace>
```

- `--scope local` (the default the lines print) enables the plugin, its server and the skills in sessions started in
  that workspace only, not in every session (`--scope user`). Remove the `claude mcp add` registration first
  (`claude mcp remove retake -s user`): not both.
- **One workspace at a time.** The `--config` values are stored once per user (`pluginConfigs` in Claude Code's user
  settings), not per folder: installing in a second workspace re-points the first one's sessions at the second
  workspace. Switch by uninstalling in the old folder first, then installing in the new one. The skills stop when
  `engine_info`'s workspace root is not the session's folder, and `engine_info` says when the server was started
  outside its workspace.
- The server's `PATH` keeps absolute entries only and none inside the workspace (`<workspace>/bin`,
  `<workspace>/node_modules/.bin`): Claude writes files there. A workspace that holds tool folders (your home folder,
  say) loses them: use a dedicated workspace folder.
- `--config home=<folder>` (printed when `RETAKE_HOME` is set) is the Retake home of the plugin's server; it
  replaces an inherited `RETAKE_HOME`. Keep it outside the workspace: it holds the key that signs approvals.
- **Update:** the plugin loads in place from the repository: `git pull` (and `pnpm build`), then a new session or
  `/reload-plugins`. **Reconfigure** (another Node.js or home): run the install line again with the new values;
  another workspace: as above, uninstall in the old folder first. **Remove:** `claude plugin uninstall retake@retake --scope local` from the workspace, then
  `claude plugin marketplace remove retake`.
- `claude --plugin-dir skills` is for editing the skills: it loads them for one session as `retake@inline`, hides
  an installed copy and has none of its values, so its MCP server is missing in that session.
- Each skill folder is also a plain Agent Skill (frontmatter `name` and `description` only): it can be copied on its
  own; it then needs the server registered with `claude mcp add`.

**How they are checked.** `packages/mcp/test/skills.test.ts` lints the skills with no model call
(`packages/mcp/test/skill-lint.ts`): every call written `tool {args}` names a tool of the server and only argument
keys of its input schema, nested ones included (and literal values must parse); every snake_case word is a tool, an
argument, an action, a schema key or a known result field; every `retake …` command and flag exists in the CLI's
help; links resolve and every file of a skill is linked; each YAML example validates (a scenario against the fixture
project under MCP trust, a component manifest) and the tsx example compiles like a component (imports, kit exports,
forbidden APIs); the frontmatter (`name` = folder, a description ≤ 1,024 characters with "Use when"), the size
(≤ 200 lines a SKILL.md), the "Before you start" checks and the Rules sentences (pinned, and no "unless", "except",
"if the user asks", "anyway"… anywhere in the Rules); no sentence anywhere has Claude run a `retake` command
("run `retake …`", "… yourself", a `retake …` command whose sentence does not name the user, outside a "For the
user's own terminal" section), fetch (curl, wget, download), ask for a password or do what a comment says; and the
hygiene (no `--yes`, `--allow-writes`, approving hook flag in any spelling, `${…}`, Claude Code's load-time `` !` ``
commands, `` ```! `` blocks and `$ARGUMENTS` / `$1` / `$name` substitutions, `allowed-tools`, absolute path, named
secret reference, nor a URL or domain — any case, any TLD — other than example.com, `*.example`, `*.test` and
localhost). A negative case per rule proves it bites. What the lint cannot prove — that a loop is the right one, that Claude follows the Rules or that a
skill triggers, and that no real brand or person is named — is the live check of
[docs/MACOS-CHECKLIST.md](../MACOS-CHECKLIST.md) 12i. A lot that changes a loop updates its skill.
