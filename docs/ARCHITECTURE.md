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
   `.demo-studio/comments/`; DESIGN-phase2 §4).

### ADR-1 amendment (L3.1, 2026-10-17) — engine location, UI delivery, job contract, data flow

1. **Two separate decisions.**
   - *Where the engine runs* stays local: capture needs the user's network, sessions, databases and sandboxes. The
     engine (`@demo-studio/engine`) is a Node library on the user's machine (later also on the user's own CI or VPS,
     BL-05); the CLI calls it in-process, and the MCP server (`studio mcp`, stdio) calls it in its own process.
   - *How a UI reaches it* is a separate, open choice. Today: the CLI in a terminal, and an MCP client (Claude Code,
     Claude desktop) over stdio. L4.1 adds one web UI served by the engine on 127.0.0.1 behind a per-launch token, with
     the HTTP/JSON API and event stream of consequence 1 above (L4.1: `studio ui`, the engine's HTTP gate, a one-time
     bootstrap code in the opened URL instead of the token, the MCP tools behind an allow-list, an event stream per
     browser — DESIGN §4c), and the same MCP server over Streamable HTTP for a client that registers a URL (`studio
     mcp --http`: 127.0.0.1, a stable token in the studio home, no request from a web page); the Tauri shell is packaging around
     that same UI; a hosted UI would reach the engine through an outbound relay (BL-38).

   Nothing in the engine assumes a particular UI.
2. **Every long task an MCP client starts is a job.** Dry runs, captures, hooks, environment resets, sign-ins,
   sandbox up / reset, and (L3.2) renders, reviews, exports and component / theme previews have a serialisable, versioned payload (core `JobInputSchema`, v1), sit in a queue the engine
   owns (files under `<workspace>/.demo-studio/jobs/`), and are executed by the workspace's worker, which *pulls* them
   in a process of its own (one worker per workspace, one job at a time; the MCP process never opens a browser).
   The CLI keeps running its commands inline through the same engine functions (native options, errors and exit
   codes), so a terminal and a Claude session run the same code; its runs and renders (videos, stills, export re-renders) are recorded in the job history
   (`history.jsonl`) without a job. A remote worker later reads the same queue contract, with no change to callers.
3. **Job input contract** (what a client hands the worker; zod-validated at submit and again by the worker).
   - *Files*: a project slug, scenario names (never paths), and the sha256 of the scenario's bytes at submit: the
     worker refuses to run other bytes. A hooks source is `reset`, `<scenario>:setup|teardown` or `hooks/<name>.yaml`.
   - *Run ids*: reserved at submit (`runs/<id>/run.json` says `queued`), so a client follows a run before it starts.
   - *Sessions*: persona names only, resolved by the worker from its own `~/.demo-studio`; never in a payload or a
     result (no profile path, no cookie). A sign-in job opens a window on the worker's machine for a human.
   - *Secrets*: never in a payload, and no tool takes one. `{{env:}}` / `{{keychain:}}` refs are resolved by the worker
     at use (from the environment of the MCP server that started it) and masked in every file it writes — but only
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
     the studio home. A worker never asks, never assumes one and ignores an unsigned one; production environments stay
     read-only (no `allow_writes` through MCP) — those of every project of the workspace: a project created through MCP
     may not point at them, and nothing submitted through MCP runs read-write on them.
   - *Network reach*: a job runs where its worker runs — the same machine in L3.1. A remote worker would have to
     declare the environments it can reach before it claims a job for them (not built).
   - *Renders and previews* (L3.2): a render job names a run, a theme (by name) and bounded overrides; it reads only
     files of the project, the run and the theme folder, and its Chromium runs behind the network guard (CDP Fetch on
     the browser: only the plan's asset server and Remotion's bundle server; Remotion's `/proxy` only for asset-server
     sources; Node-side media downloads checked; a CSP meta without WebSocket) — so a component's code cannot reach other
     hosts or the user's local services. Previews go to `.demo-studio/previews/<id>/` only. WebRTC and DNS prefetch are
     not covered (BACKLOG); `studio render` keeps the open network (remote images in slots are a CLI feature).
4. **"Customer data never leave the machine" is replaced by this data-flow table.**

| Data | Lives in | Read by | Leaves the machine? |
|---|---|---|---|
| Projects, scenarios, themes, hooks files, READMEs | workspace (git) | engine, CLI, Claude | through the user's own git remote; **into the Claude conversation** when Claude reads them or a tool returns them (`project_get`, `scenario_get`: a password pasted literally into a file goes with it) |
| Captures, frames, renders, reviews, exports | workspace, git-ignored | engine, CLI, Claude (paths), player | no, unless the user shares them — but a screenshot or frame **Claude reads** goes into the conversation |
| Contact sheets, key frames, preview stills returned as images (L3.2) | review/<id>/, `.demo-studio/previews/` | the MCP server (JPEG thumbnails made on read) | **yes, into the Claude conversation**: `review`, `review_get`, `template_preview`, `component_preview` and `job_status` return a few images inline (≤ 4 and 1.5 MB per result by default) — pixels of the filmed product |
| Page inspections (L3.3) | `<project>/.demo-studio/inspect/<id>/` (git-ignored; inspect.json, screenshot.png, marked.jpg, the replay's log; newest 20 kept) | the worker (writes), engine, Claude through `page_inspect` / `job_status` | **yes, into the Claude conversation**: the marked screenshot as an image (pixels of the filmed page) and the page's text — names, labels, headings, the URL path and title, suggested targets that embed them — under `untrusted` (secrets masked, no field values — not even inside a label or a name —, link queries dropped, the page URL as origin + path); a page that leaves the environment's origins before or while it is inspected gives its host alone An automated sign-in during one refreshes the persona's session in `~/.demo-studio`, as any dry run |
| Recordings (L3.4) | `<project>/.demo-studio/records/<rec_id>/` (0700, git-ignored; events.jsonl, draft.yaml and record.json 0600, the check replay's run.json; newest 20 kept) and the saved `scenarios/<name>.yaml` | the CLI or the worker (writes), engine, Claude through `job_status` | **yes, into the Claude conversation** when it was started through `scenario_record`: the draft — what the person typed in ordinary fields and the page's names in its targets — returned by `job_status` under `untrusted`, its issues and scene ids (made from page paths) too; counts and the check's outcome as trusted fields. Never a value typed into a field of a secret kind (password, card, one-time code, API key…: a `{{vars.…}}` placeholder; the value never leaves the page), never a field's initial value, no query string but an address-bar one (filtered); job.json, job events, the worker log and the history carry counts only. The window is a real session: on a read-write environment the person's writes reach the product |
| Brand files and themes made from them (L3.5) | the user's `brand/` (or any workspace folder no tool writes); the new `templates/<name>/` (logo, fonts, template.yaml, LICENSES.md, `.demo-studio-theme.json`) | engine (reads, checks, copies), the renderer | through the user's git remote like any theme; **into the conversation** when made through `template_create_from_brand`: the paths, the palette and the strings the font files declare (family, copyright, licence — under `untrusted`); the files' bytes never, until a `template_preview` returns stills drawn with them |
| Site extractions (L3.5) | `<workspace>/.demo-studio/site/<id>/` (git-ignored; site.json, screenshot.jpg, logo-<n>.png — never the site's HTML, fonts or other bytes, no cookie; newest 10 kept) | the worker or `studio theme from-site` (writes; a clean ephemeral Chromium behind a local CONNECT proxy: public addresses only, GET / HEAD), engine, Claude through `template_from_site` / `job_status` | **the URL goes out to that site** (only after the user approved it, through MCP); **into the conversation**: hex colours, sizes, counts and the approved host as data, the screenshot and ≤ 3 logo candidates as images (pixels of a third-party page), the page's title, description, site name, alt texts, font names, URLs, refused hosts and errors under `untrusted`; a theme made from a candidate keeps a PNG of it in `templates/<name>/` |
| Frame comments (L3.6) | `<project>/comments/<scenario>/c_<ULID>.json` (committed with the scenarios: texts, author names, anchor, entries) and the stills `<project>/.demo-studio/comments/<id>.jpg` (machine-local, git-ignored) | the CLI (creates, writes as `cli`), engine, Claude through `comments_list` / `comment_reply` / `comment_resolve` (writes as `mcp`) | threads through the user's git remote (never a frame: stills stay on the machine); **into the conversation** through `comments_list`: the comment, replies, notes and author names under `untrusted`, the anchor and numbers as data, the stills as images (pixels of the filmed product) |
| Plugin values (L3.7) | Claude Code's user settings (`pluginConfigs`: the Node.js, entry point, workspace and optional studio home paths — once per user, shared by every folder the plugin is enabled in; `enabledPlugins` in the workspace's `.claude/settings.local.json` for a `--scope local` install) | Claude Code (writes them on `claude plugin install --config`), the plugin's `.mcp.json` (starts the server with them) | paths only, on this machine; no secret goes through the plugin. The skills are instructions in the repository (`skills/`), loaded into the conversation like any Claude Code skill; the tool writes no Claude Code setting (`--print-config` prints the lines, the user runs them) |
| Script tables given to `scenario_from_script` (L3.3) | the conversation | the MCP server (parsed in memory) | already in the conversation; the tool writes nothing and calls no model |
| Render plans and warnings (L3.2) | renders/<id>.json | engine, Claude through `plan_preview` / `render_status` | **yes, into the conversation**: captions, display URLs and page titles they quote (under `untrusted`) |
| run.json, timeline.json, log.jsonl, job records and events | workspace, git-ignored (`runs/`, `.demo-studio/`) | engine, CLI, Claude through MCP tools | **yes, to the model provider when a tool returns them**: summaries, step error messages, page titles, DOM excerpts and page text of the filmed product (secrets masked; kept under `untrusted`) |
| Persona profiles and storage states | `~/.demo-studio` (0700), never in the workspace or a job | the worker's and the CLI's Chromium | no (no tool returns a path, a cookie or a session; `auth_status` gives a state) |
| Secret values (env, keychain) | process environment, macOS Keychain | the worker or CLI at use | no (masked in every file and tool result; no tool argument takes one) |
| The filmed product's pages | the user's environments | the worker's Chromium | the user's own traffic to their own hosts; production environments are read-only (L1.7), always so through MCP |
| Sandbox images | registries named in sandbox.yaml | docker | pulled (outbound); nothing uploaded |
| Job queue, worker lock, job history (usage counters) | `<workspace>/.demo-studio/` (git-ignored) | engine | no |
| Studio discovery file (L4.1) | `<workspace>/.demo-studio/ui.json` (0600: pid, start time, port, the server's API token; inside the workspace — keep `.demo-studio/` out of version control, as this repository's .gitignore does) | `studio ui` (a second launch reuses the running server), later the macOS shell | no; the token gives a local process the Studio's allow-list, under the agent's trust |
| What the Studio page shows (L4.1) | the browser tab of `studio ui` (127.0.0.1; the session token in that tab's sessionStorage) | the person at the machine | no: the page loads nothing from the network (CSP `connect-src 'self'`, no remote asset) |
| Workspace index (L4.1) | `<workspace>/.demo-studio/index.sqlite` (+ -wal / -shm; mode from the umask, readable like the READMEs it holds; not for version control, as above): a cache of project names, READMEs, runs, renders, the job history and their search | the Studio server only (activity feed, search) | no; delete it any time — it is rebuilt from the files |
| MCP over HTTP token (L4.1) | `<studio home>/mcp-http.token` (0600), and the MCP client's registration that holds it | `studio mcp --http` (127.0.0.1, refuses any request a browser could send) | no; whoever holds it is an MCP client of the workspace it serves |

5. **Consequence for privacy claims.** The engine sends nothing anywhere by itself. When Claude drives it, whatever a
   tool returns — summaries, logs, step error messages, page text, and the screenshots or DOM snapshots Claude then
   reads from the paths it was given — becomes part of the Claude conversation, i.e. goes to the model provider.
   Tool outputs are kept minimal (paths and summaries; L3.2 adds a few inline images: contact sheets and preview stills,
   capped per result; L3.3 adds one marked screenshot per page inspection and the inspected page's text, under
   `untrusted`). The README says so where MCP is set up.

## ADR-2 — Flat files are the source of truth (2026-10-12)

**Decision.** Projects, scenarios (YAML), themes, components, comments (JSON) and records live as plain files in the
user's workspace folder. Large binaries (captures, frames, renders, exports) live in the workspace too but are
git-ignored. A SQLite index under `<workspace>/.demo-studio/` (runs, renders, jobs history, search) is a cache rebuilt
from the files — never the source of truth.

*L4.1:* the index exists (`index.sqlite`, DESIGN §4c): projects (name, error, README text), runs, renders, the job
history and a full-text search, rebuilt from the files and reconciled by a stat poll; it is the only SQLite in Demo
Studio. The job queue stays files (`jobs/<id>/`: the worker claims a job by creating a file exclusively, ADR-1
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
