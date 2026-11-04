# Architecture decisions

## ADR-1 — Local-first, desktop-first (2026-10-12)

**Decision.** In V1 everything heavy runs on the user's machine: capture (Chromium + runner), editing plan, render
(Remotion), review, export and the MCP server. The product core is the local **engine** (Node), used by three
clients: the desktop app (Tauri shell around the Studio web UI), the CLI (also in the user's CI) and Claude through
MCP. No server-side capture or rendering in V1. A full cloud offer is kept in mind but out of this development phase.

**Why.**
- Server cost does not grow with users (a capture keeps a Chromium busy for minutes; rendering is CPU-heavy).
- Captures need the user's environment: private staging behind VPN/IP allow-lists, localhost, signed-in sessions.
- Customer data and sessions never leave the user's machine.
- The same engine runs headless in CI (videos regenerated on every release).

**Consequences (built into the lots).**
1. **Engine API**: one local HTTP/JSON API + an event stream (progress, logs, live preview frames) used by the Studio
   UI, the MCP server and the CLI. The UI never reads files directly; it talks to the engine (L3.1, L4.1).
2. **Job runner abstraction**: captures, renders, reviews and exports are jobs with status/progress/cancel, executed by
   a local worker; the interface allows a remote worker later without changing callers (L3.1).
3. **Media storage abstraction**: artefacts (captures, frames, renders, exports) are addressed through a storage
   interface (local paths now; object storage later), content-hashed where useful (L3.1).
4. **Comments**: one file per thread (`<project>/comments/<scenario>/<thread-id>.json`) so concurrent edits (git, a
   future sync) do not conflict (L3.6: `c_<ULID>` threads, append-only `r_<ULID>` entries written under a per-thread
   lock with an atomic write, status derived from the entries; the frame still kept machine-local in
   `.retake/comments/`; DESIGN-phase2 §4).

### ADR-1 amendment (L3.1, 2026-10-17) — engine location, UI delivery, job contract, data flow

1. **Two separate decisions.**
   - *Where the engine runs* stays local: capture needs the user's network, sessions, databases and sandboxes. The
     engine (`@retake/engine`) is a Node library on the user's machine (later also on the user's own CI or VPS,
     BL-05); the CLI calls it in-process, and the MCP server (`retake mcp`, stdio) calls it in its own process.
   - *How a UI reaches it* is a separate, open choice. Today: the CLI in a terminal, and an MCP client (Claude Code,
     Claude desktop) over stdio. L4.1 adds one web UI served by the engine on 127.0.0.1 behind a per-launch token, with
     the HTTP/JSON API and event stream of consequence 1 above (L4.1: `retake ui`, the engine's HTTP gate, a one-time
     bootstrap code in the opened URL instead of the token, the MCP tools behind an allow-list, an event stream per
     browser — DESIGN §4c), and the same MCP server over Streamable HTTP for a client that registers a URL (`retake
     mcp --http`: 127.0.0.1, a stable token in the Retake home, no request from a web page); the Tauri shell is packaging around
     that same UI (L5.2: the macOS app runs `retake ui --supervised` — the server stops when the app's pipe closes, so
     an app crash leaves no orphan — opens its one-time URL in a WKWebView and holds no token; DESIGN §4j); a hosted UI
     would reach the engine through an outbound relay (BL-38).

   Nothing in the engine assumes a particular UI.
2. **Every long task an MCP client (or, since L4.2, the Studio) starts is a job.** Dry runs, captures, hooks, environment resets, sign-ins,
   sandbox up / reset, and (L3.2) renders, reviews, exports and component / theme previews have a serialisable, versioned payload (core `JobInputSchema`, v1), sit in a queue the engine
   owns (files under `<workspace>/.retake/jobs/`), and are executed by the workspace's worker, which *pulls* them
   in a process of its own (one worker per workspace; one capture at a time, and beside it one heavy job in a job
   process of its own that waits and yields while a take films — L5.14, DESIGN §4q; the MCP process never opens a browser).
   The CLI keeps running its commands inline through the same engine functions (native options, errors and exit
   codes), so a terminal and a Claude session run the same code; its runs and renders (videos, stills, export re-renders) are recorded in the job history
   (`history.jsonl`) without a job. A remote worker later reads the same queue contract, with no change to callers.
3. **Job input contract** (what a client hands the worker; zod-validated at submit and again by the worker).
   - *Files*: a project slug, scenario names (never paths), and the sha256 of the scenario's bytes at submit: the
     worker refuses to run other bytes. A hooks source is `reset`, `<scenario>:setup|teardown` or `hooks/<name>.yaml`.
   - *Run ids*: reserved at submit (`runs/<id>/run.json` says `queued`), so a client follows a run before it starts.
   - *Sessions*: persona names only, resolved by the worker from its own `~/.retake`; never in a payload or a
     result (no profile path, no cookie). A sign-in job opens a window on the worker's machine for a human.
   - *Secrets*: never in a payload, and no tool takes one. `{{env:}}` / `{{keychain:}}` refs are resolved by the worker
     at use (from the environment of the client that started it — the MCP server or the Studio both hand it a clean
     one, engine `cleanWorkerEnv`, L4.2: PATH sanitised like `retake mcp`'s, no package-manager variables, MCP token,
     model / agent / code-host credentials, nothing that loads code from the workspace (NODE_OPTIONS files, NODE_PATH /
     DYLD_* / LD_* entries inside it), RETAKE_HOME kept; `retake worker` in a terminal keeps that terminal's; one
     worker per workspace, so the first client's environment serves every job until it idles out — the lock records
     `started_by`) and masked in every file it writes — but only
     refs a human wrote: project.yaml (personas' login steps, databases, mailbox, reset hooks) and the project's
     `hooks/` files. A scenario written or run through MCP names no secret, nor does a code file it runs (refused at
     save, at submit and by the worker): the agent could otherwise read any variable of that environment back through
     an error message (masking catches a value as is, not base64 of it).
   - *Local files*: a file a scenario or hook references through MCP (drop_file, eval.file, sql / js files, the
     scripts a shell hook names) is inside the project folder, symbolic links followed; code is never run from a file
     the agent can write (README.md, `scenarios/`, `runs/`…).
   - *Approvals*: through MCP the files' trust flags do not count (the agent can write them): destructive hooks,
     every shell hook or shell seed step, and a setup hook whose rollback is destructive, shell or JavaScript need a
     human, asked by the client at submit (MCP elicitation; the form shows each hook and its rollback) and carried as
     fingerprints of the raw hooks and of the project files they reference, each approval signed (HMAC) with a key of
     the Retake home. A worker never asks, never assumes one and ignores an unsigned one; production environments stay
     read-only (no `allow_writes` through MCP) — those of every project of the workspace: a project created through MCP
     may not point at them, and nothing submitted through MCP runs read-write on them.
   - *Network reach*: a job runs where its worker runs — the same machine in L3.1. A remote worker would have to
     declare the environments it can reach before it claims a job for them (not built).
   - *Renders and previews* (L3.2): a render job names a run, a theme (by name) and bounded overrides; it reads only
     files of the project, the run and the theme folder, and its Chromium runs behind the network guard (CDP Fetch on
     the browser: only the plan's asset server and Remotion's bundle server; Remotion's `/proxy` only for asset-server
     sources; Node-side media downloads checked; a CSP meta without WebSocket) — so a component's code cannot reach other
     hosts or the user's local services. Previews go to `.retake/previews/<id>/` only. WebRTC and DNS prefetch are
     not covered (BACKLOG BL-72); `retake render` keeps the open network (remote images in slots are a CLI feature).
4. **"Customer data never leave the machine" is replaced by this data-flow table.**

| Data | Lives in | Read by | Leaves the machine? |
|---|---|---|---|
| Projects, scenarios, themes, hooks files, READMEs | workspace (git) | engine, CLI, Claude | through the user's own git remote; **into the Claude conversation** when Claude reads them or a tool returns them (`project_get`, `scenario_get`: a password pasted literally into a file goes with it) |
| Captures, frames, renders, reviews, exports | workspace, git-ignored | engine, CLI, Claude (paths), player | no, unless the user shares them — but a screenshot or frame **Claude reads** goes into the conversation |
| Contact sheets, key frames, preview stills returned as images (L3.2) | review/<id>/, `.retake/previews/` | the MCP server (JPEG thumbnails made on read) | **yes, into the Claude conversation**: `review`, `review_get`, `template_preview`, `component_preview` and `job_status` return a few images inline (≤ 4 and 1.5 MB per result by default) — pixels of the filmed product |
| Page inspections (L3.3) | `<project>/.retake/inspect/<id>/` (git-ignored; inspect.json, screenshot.png, marked.jpg, the replay's log; newest 20 kept) | the worker (writes), engine, Claude through `page_inspect` / `job_status` | **yes, into the Claude conversation**: the marked screenshot as an image (pixels of the filmed page) and the page's text — names, labels, headings, the URL path and title, suggested targets that embed them — under `untrusted` (secrets masked, no field values — not even inside a label or a name —, link queries dropped, the page URL as origin + path); a page that leaves the environment's origins before or while it is inspected gives its host alone An automated sign-in during one refreshes the persona's session in `~/.retake`, as any dry run |
| Recordings (L3.4) | `<project>/.retake/records/<rec_id>/` (0700, git-ignored; events.jsonl, draft.yaml and record.json 0600, the check replay's run.json; newest 20 kept) and the saved `scenarios/<name>.yaml` | the CLI or the worker (writes), engine, Claude through `job_status` | **yes, into the Claude conversation** when it was started through `scenario_record`: the draft — what the person typed in ordinary fields and the page's names in its targets — returned by `job_status` under `untrusted`, its issues and scene ids (made from page paths) too; counts and the check's outcome as trusted fields. Never a value typed into a field of a secret kind (password, card, one-time code, API key…: a `{{vars.…}}` placeholder; the value never leaves the page), never a field's initial value, no query string but an address-bar one (filtered); job.json, job events, the worker log and the history carry counts only. The window is a real session: on a read-write environment the person's writes reach the product |
| Brand files and themes made from them (L3.5) | the user's `brand/` (or any workspace folder no tool writes); the new `templates/<name>/` (logo, fonts, template.yaml, LICENSES.md, `.retake-theme.json`) | engine (reads, checks, copies), the renderer | through the user's git remote like any theme; **into the conversation** when made through `template_create_from_brand`: the paths, the palette and the strings the font files declare (family, copyright, licence — under `untrusted`); the files' bytes never, until a `template_preview` returns stills drawn with them |
| Site extractions (L3.5) | `<workspace>/.retake/site/<id>/` (git-ignored; site.json, screenshot.jpg, logo-<n>.png — never the site's HTML, fonts or other bytes, no cookie; newest 10 kept) | the worker or `retake theme from-site` (writes; a clean ephemeral Chromium behind a local CONNECT proxy: public addresses only, GET / HEAD), engine, Claude through `template_from_site` / `job_status` | **the URL goes out to that site** (only after the user approved it, through MCP); **into the conversation**: hex colours, sizes, counts and the approved host as data, the screenshot and ≤ 3 logo candidates as images (pixels of a third-party page), the page's title, description, site name, alt texts, font names, URLs, refused hosts and errors under `untrusted`; a theme made from a candidate keeps a PNG of it in `templates/<name>/` |
| Frame comments (L3.6) | `<project>/comments/<scenario>/c_<ULID>.json` (committed with the scenarios: texts, author names, anchor, entries) and the stills `<project>/.retake/comments/<id>.jpg` (machine-local, git-ignored) | the CLI (creates, writes as `cli`), engine, Claude through `comments_list` / `comment_reply` / `comment_resolve` (writes as `mcp`) | threads through the user's git remote (never a frame: stills stay on the machine); **into the conversation** through `comments_list`: the comment, replies, notes and author names under `untrusted`, the anchor and numbers as data, the stills as images (pixels of the filmed product) |
| Plugin values (L3.7) | Claude Code's user settings (`pluginConfigs`: the Node.js, entry point, workspace and optional Retake home paths — once per user, shared by every folder the plugin is enabled in; `enabledPlugins` in the workspace's `.claude/settings.local.json` for a `--scope local` install) | Claude Code (writes them on `claude plugin install --config`), the plugin's `.mcp.json` (starts the server with them) | paths only, on this machine; no secret goes through the plugin. The skills are instructions in the repository (`skills/`), loaded into the conversation like any Claude Code skill; the tool writes no Claude Code setting (`--print-config` prints the lines, the user runs them) |
| Script tables given to `scenario_from_script` (L3.3) | the conversation | the MCP server (parsed in memory) | already in the conversation; the tool writes nothing and calls no model |
| Render plans and warnings (L3.2) | renders/<id>.json | engine, Claude through `plan_preview` / `render_status` | **yes, into the conversation**: captions, display URLs and page titles they quote (under `untrusted`) |
| run.json, timeline.json, log.jsonl, job records and events | workspace, git-ignored (`runs/`, `.retake/`) | engine, CLI, Claude through MCP tools | **yes, to the model provider when a tool returns them**: summaries, step error messages, page titles, DOM excerpts and page text of the filmed product (secrets masked; kept under `untrusted`) |
| Persona profiles and storage states | `~/.retake` (0700), never in the workspace or a job | the worker's and the CLI's Chromium | no (no tool returns a path, a cookie or a session; `auth_status` gives a state) |
| Secret values (env, keychain) | process environment, macOS Keychain | the worker or CLI at use | no (masked in every file and tool result; no tool argument takes one) |
| The filmed product's pages | the user's environments | the worker's Chromium | the user's own traffic to their own hosts; production environments are read-only (L1.7), always so through MCP |
| Sandbox images | registries named in sandbox.yaml | docker | pulled (outbound); nothing uploaded |
| Job queue, worker lock, job history (usage counters) | `<workspace>/.retake/` (git-ignored) | engine | no |
| Render job edit snapshot (L4.5) | `<workspace>/.retake/jobs/<job>/edit.yaml` (0600, written before job.json: the scenario text a render job's edit was planned from, its sha256 the job's `edit_sha256`) | the submit (writes), the worker (reads it without following a link, checks the sha256, plans from it) | no: never in a job record or a tool result |
| Studio discovery file (L4.1) | `<workspace>/.retake/ui.json` (0600: pid, start time, port, the server's API token; inside the workspace — keep `.retake/` out of version control, as this repository's .gitignore does) | `retake ui` (a second launch reuses the running server; the macOS app's `retake ui --supervised` too — the app itself never reads it, L5.2) | no; the token gives a local process the Studio's allow-list, under the agent's trust |
| What the Studio page shows (L4.1) | the browser tab of `retake ui` (127.0.0.1; the session token in that tab's sessionStorage) | the person at the machine | no: the page loads nothing from the network (CSP `connect-src 'self'`, no remote asset) |
| The desktop app (L5.2) | the app bundle (`launch.json`: the paths of the Node.js and the CLI it runs, no secret) and `<Retake home>/desktop.json` (0600: the last workspace opened); the window's WebKit store is ephemeral (nothing in ~/Library: no cache of capture media, no per-port storage) | the app (runs `retake ui --supervised`, holds the one-time URL in memory only, never the token; prints origins only) | no: the window loads only the Studio's and the player's loopback origins (every frame's navigation checked), the page has no IPC command |
| Runs started from the Studio (L4.2) | the job queue and `runs/` as any job (`submitted_by: ui`) | the Studio's Dry run / Capture (`scenario_run`: the scenario, the mode, an environment and the hash of the file as shown — never a sandbox reset, `until` or hooks of a dry run; one run of a scenario at a time; L4.4: a capture names the personas with an invalid session it was confirmed for, `sessions_ack`), Cancel (`run_cancel`), Pause / Resume of a run (`run_pause`: the job's `pause` marker; a capture does not film the pause) and a headed sign-in for the person (`auth_login`, headed only; `sign_in_cancel`), under the agent's trust with no approver (a hook that needs a person is refused with the `retake run …` command, shown before the click) | as any run: the user's own traffic to their own hosts; production read-only |
| Scenario edits from the Studio (L4.3) | the scenario file itself (`scenarios/<name>.yaml` or `.yml`, written in place, mode kept) | the Studio's YAML tab, the Blocks tab's step moves / duplicates / deletes, a form's field changes and the palette's new steps, the timeline inspector's switches (L4.5 `set_field`: only allow-listed edit values — layouts, transitions, speeds, components, durations, the intro / outro switch, the caption component; never a step, hook, var or the environment) (text splices and CST scalar edits, refused unless the result re-parses to exactly the intended value) and undo / redo (`scenario_edit`, a Studio op — not an MCP tool), under the agent's trust worded "from the Studio": the hash of the file as shown (409 otherwise), validated (errors refuse), hooks and mocks unchanged, no hidden character added, a file holding a secret reference or an outside file never written (read-only with why); every `if_match` write of a project file (also MCP `scenario_save`, the README) holds `.retake/locks/write-*.lock` from the check to the rename; an MCP `scenario_save` can still add a hook agent trust does not refuse (a residue: BL-95, an approval from the UI: BL-106); while a file has a hook or a mock its `vars` and `env` are frozen from the Studio too (a hook reads them); a link to a file outside `scenarios/` is never written through; undo restores only a version the Studio showed or wrote; whether a file exists outside the project is never told to the page | no |
| Step thumbnails of the scenario screen (L4.2) | the Studio server's memory only (≤ 32 MiB, JPEG ≤ 480 px made from the run's screenshots, kept frames or video) and the tab's memory (≤ 600 pictures, asked for the rows on screen, shown as `data:image/jpeg` URLs); never written to disk | the person at the machine (`run_thumbs`, a Studio op — not an MCP tool) | no: served to the Studio's own page over the gated call route, `Cache-Control: no-store` |
| Workspace index (L4.1) | `<workspace>/.retake/index.sqlite` (+ -wal / -shm; mode from the umask, readable like the READMEs it holds; not for version control, as above): a cache of project names, READMEs, runs, renders, the job history and their search | the Studio server only (activity feed, search) | no; delete it any time — it is rebuilt from the files |
| MCP over HTTP token (L4.1) | `<Retake home>/mcp-http.token` (0600), and the MCP client's registration that holds it | `retake mcp --http` (127.0.0.1, refuses any request a browser could send) | no; whoever holds it is an MCP client of the workspace it serves |
| Timeline preview (L4.5) | the Studio server's memory (the player origin: a capability per project, the preview bundle — built-in components and the workspace components the person allowed this session (PreviewAllowList, by folder content hash; never persisted) —, preview plans: product text the take filmed, display URLs, capability URLs, no path) and a sandboxed frame of the Studio tab (the page itself holds only the frame and plan URLs `timeline_view` answers, never the plan) | the preview frame only: `http://127.0.0.1:<Q>/s/<cap>/…` and `/m/<cap>/…` (a second loopback listener of the Studio process; Host 127.0.0.1 / localhost only, GET / HEAD, Origin absent / null; media = the capture, page tracks, fonts, logo, music, card media and artefact pages of the plan, registered only inside the project, the run or the theme, one name only (no hard link), read without following a link; CORS `null` only); a project's capability is revoked when its last timeline page leaves (`timeline_leave`) or the Studio closes, never logged, never in a Referer | no: an opaque `sandbox="allow-scripts"` frame under a CSP whose sources are that capability's paths (`connect-src`, `img-src`, `media-src`, `font-src`) and that requires Trusted Types with no policy, WebRTC and sendBeacon removed, `rel="prerender"` and child frames refused (Chrome's prerender ignores CSP and sandbox), no storage; a workspace component runs there only once the person allowed it (`preview_allow`, not an MCP tool); it talks to its page over one MessageChannel (schema, flood budget) and reaches neither the Studio's API nor any other host (a Chromium test with a positive control checks 36 channels and 3 navigations); residues BL-110 — in Safari / WebKit the frame shares the tab's process (a busy component freezes the tab, a flood is still stopped), DNS prefetch, the capability readable by local processes while the Studio runs; accepted in the installed Chrome on a fixture capture (DESIGN §4g, part F) |
| Render queue and review in the Studio (L4.5 part E) | the workspace's job records, renders/<id>.json, review/<id>/ (report.json, contact sheets) — read by the Studio server, never written by the page | `scenario_render` (pinned: project, scenario, capture, the file's hash as shown — no theme, option or path; the review inline), `scenario_renders` (the queue and renders, path-free), `render_cancel` (a render or review job of that project only), `render_review` (no `dir`, `files`, environment or path; finding messages under `untrusted`), `review_image` (a sheet by NAME, the review folder inside the project, O_NOFOLLOW, regular, ≤ 8 MB, JPEG magic, scaled ≤ 1600 px / ≤ 2,000,000 base64 characters) — Studio ops, not MCP tools | no: the page gets ids, numbers, verdicts and a sheet's base64 JPEG (shown as a checked `data:image/jpeg` URL through the app's one `<img>`); finding and failure messages are untrusted text |
| Live picture of a run (L4.4) | memory only: the worker (one frame cache per running `run` job, dropped when it ends), the Studio server (the current frame of a job's one upstream while a tab watches, dropped when it closes) and the watching tab (the Run screen decodes each frame from bytes in memory onto a canvas — no image address, no blob: URL; a hidden tab closes its stream); `<job>/live.json` (0600: the job's loopback port, a per-job 32-byte token, the worker's pid and start time; removed when the job ends) | the worker's live channel (127.0.0.1, refuses any request a browser could send, ≤ 2 streams), read by a local process that trusts live.json (the Studio server: one upstream per job, only while a tab's run stream wants frames — a capture's only when the tab asked, the picture costing ≈ 15 % more Chromium CPU during a take — relayed latest-only over the gated `POST /v1/live`, `Cache-Control: no-store`; sockets without a stream closed after 2 s, so idle connections never lock it) | no: JPEG frames (≤ 960 px, ≤ 10 a second) of the page the run acts on, from capture time 0 to the end of its scenes, only while someone watches — never written, logged or indexed (a test scans the run, `.retake`, the Retake home and the worker's TMPDIR for their bytes); a capture watched records only how long and how many (`perf.live_preview`) |

5. **Consequence for privacy claims.** The engine sends nothing anywhere by itself. When Claude drives it, whatever a
   tool returns — summaries, logs, step error messages, page text, and the screenshots or DOM snapshots Claude then
   reads from the paths it was given — becomes part of the Claude conversation, i.e. goes to the model provider.
   Tool outputs are kept minimal (paths and summaries; L3.2 adds a few inline images: contact sheets and preview stills,
   capped per result; L3.3 adds one marked screenshot per page inspection and the inspected page's text, under
   `untrusted`). [Claude and MCP](guide/mcp.md) says so where MCP is set up.

## ADR-2 — Flat files are the source of truth (2026-10-12)

**Decision.** Projects, scenarios (YAML), themes, components, comments (JSON) and records live as plain files in the
user's workspace folder. Large binaries (captures, frames, renders, exports) live in the workspace too but are
git-ignored. A SQLite index under `<workspace>/.retake/` (runs, renders, jobs history, search) is a cache rebuilt
from the files — never the source of truth.

*L4.1:* the index exists (`index.sqlite`, DESIGN §4c): projects (name, error, README text), runs, renders, the job
history and a full-text search, rebuilt from the files and reconciled by a stat poll; it is the only SQLite in Retake.
The job queue stays files (`jobs/<id>/`: the worker claims a job by creating a file exclusively, ADR-1
amendment), and an unfinished job's state is never read from the index (it is derived from process liveness, which no
file records). SPEC §3's "SQLite only for the render queue/history" (R-PRJ-02) reads, under this ADR, "SQLite only as
a rebuildable index; plain files are the source of truth, the job queue included" — a rewording that awaits the user.

**Why.** Claude reads and edits files directly; git versions and reviews them (team collaboration through git in V1);
portable, offline, no lock-in, easy backup.

## Later (not V1)

Not planned: a browser extension (decision 2026-10-12 — capture stays in the local engine).

- Cloud layer: shareable review links with frame comments, team sync of the workspace, component marketplace and
  licences, optional cloud render (4K, batches). The cloud stores the same file tree (object storage + index), so the
  formats and the MCP stay identical.
- Client-side final rendering (WebCodecs) once mature; the Studio preview is already client-side (Remotion Player).
