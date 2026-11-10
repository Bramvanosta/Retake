# Glossary

One word per concept. The code, the `retake` command, the MCP tools and the docs use the **canonical word**; the
Studio shows a few concepts under a **product label** of its own (a film-set vocabulary: *Productions*, *Shoot*,
*Rehearse*, *Cast*, *Locations*), on its screens only. A name that predates this glossary and is part of a format or an
interface (a file or folder name, a YAML key, a command flag, an MCP tool or argument name) stays as it is: the last
column says where. A word with several meanings is qualified each time it is used (see [Homonyms](#homonyms)).

Back to the [guide](guide/README.md) · the layers these words live in: [target architecture](audit/target-architecture.md).

## Concepts

| Canonical word | Studio label | What it is | Older names that stay |
|---|---|---|---|
| workspace | Workspace | the folder with `retake.yaml`: projects, themes, components | — |
| Retake home | — | the folder of this machine's own state (`RETAKE_HOME`, default `~/.retake`): signed-in sessions, the signing key | — |
| project | Project | one product: `projects/<slug>/` with `project.yaml`, `README.md`, `scenarios/`, `hooks/`, `assets/` | — |
| scenario | Productions (the project's list; a scenario's own screen: Scenario) | the script of one video: `scenarios/<name>.yaml`, scenes of steps | — |
| scene · step | Scene · step (the Script mode's blocks) | a part of a scenario · one action in it (open, click, type, wait…) | — |
| environment | Location | a named set of the product's pages (URLs) a scenario is filmed on, with its access (read-only or read-write) | `env` (`--env`, `default_env`, `env_reset`, `retake env`) |
| persona | Cast (the sidebar group; its rows and fields: Persona) | an account a video is filmed as, signed in once; its saved browser state is its **session** | — |
| dry run | Rehearse | a scenario played without video: a screenshot per step, irreversible steps not executed, hooks skipped by default | `--dry`, `run_dry`, the run mode `dry` |
| capture | Capture (in the Shoot mode) | a scenario played and filmed, with its setup and teardown hooks: `capture.mp4` + `timeline.json` | `run_capture`, `retake run` |
| run | Run (in the Shoot mode) | the record of one dry run or capture: `runs/<id>/` with its `run.json`, named by its run id (the folder's name; the grammars of the run id, the render id, the job id and theme names are in core `id-grammar.ts`) | — |
| take | Take (*Prepare a take*) | the filming moment of a capture: the time the browser films on this Mac; one take at a time per Mac, renders wait for it | — |
| edit plan | Edit | the planned cut of a capture (segments, components, captions, speeds, zooms) that a render follows | — |
| render | Render | a finished video made from a capture with a theme: `renders/<scenario>-v<N>.mp4` + `.json` | — |
| review | Review | the contact sheets, key frames, checks and report of a render: `review/<render>/` | — |
| export | Export | a render in delivery formats (1080p, 4K, vertical, square, GIF…): `exports/<render>/` | — |
| raw export | — | a run's footage for another editing tool: clips per scene, cursor data, markers (`retake export-capture`) | — |
| pipeline | — | the making of a video's outputs from a run: plan, render (and stills), review, export — in the engine one function per part (`packages/engine/src/pipeline.ts`: `planWork`, `renderWork`, `stillWork`, `exportWork`, `reviewWork`), shared by the worker's jobs and the CLI's commands; the parts that render are handed a *renderer* by their caller and refuse to work without one; never a *production* (an environment) nor a *step* (an action of a scene) | — |
| theme | Themes (the Library) | the look of a video: colours, fonts, logo and the styling of its components; a workspace theme or a starter (default, editorial, motion) | `template`: the `templates/` folder, `template.yaml`, the `template:` key of `project.yaml`, a scenario's `video.template`, `retake schema template`, the MCP `template_*` tools and their `template` argument, the check names `Templates` and `Template <name>` of `retake doctor` (its `--json` output) |
| component | Components (the Library) | a reusable piece of a video (title card, caption, callout…): `components/<namespace>/<name>/` | — |
| thread | Thread | a conversation anchored on a moment (and optionally a region) of a render, open or resolved: `comments/<scenario>/<id>.json` | `retake comment …` and the MCP `comment_*` / `comments_list` tools act on threads |
| comment | Comment | one message of a thread: its first one or a reply | — |
| recording | Recording | a flow performed by hand in a browser window that becomes a draft scenario (`retake record`, `scenario_record`); never the filmed video | — |
| hook | — | a setup or teardown file (sql, http, js, sh) run around a capture; its rollbacks undo what it did | — |
| sandbox | Sandbox | a disposable, local copy of the product (`sandbox.yaml`), reset to its seed before a take | — |
| job · worker | — | work queued for the workspace's jobs worker (dry runs, captures, renders, reviews, exports, hooks, sign-ins) · the background process that runs them | — |
| operation | — | one thing Retake does for a client, served by the `retake` command, the MCP server and / or the Studio (a dry run, a render, reading a project…); named by the MCP tool or Studio op that serves it, else by its command | `op` (the Studio server's ops, `UI_OPS`); `ToolDef` / `callTool` (an operation's definition and call, in `@retake/engine/contract`) |
| operation catalogue | — | every operation once, with its facets and which shells serve it, and why not (`packages/engine/src/catalogue.ts`, `@retake/engine/catalogue`) | — |
| facet · effect | — | what the catalogue says an operation does: its **effect** (`read`, `write` or `destructive`: removes or replaces data as its purpose, or in one of its cases, without an `if_match` on the version read — and says what, `removes`; a run's hooks or sandbox reset are its code, not its effect), whether it is queued as a job, whose code it runs (`project`: hooks, sandbox commands; `workspace`: components and themes rendered), whether it serves other operations (a server, the worker); the MCP tools' read-only and destructive hints are its effect | `kind` (the catalogue's single field before the facets) |
| admission rule | — | a check the engine makes before it queues a job for the Studio or MCP: one run of a scenario at a time, one render of a scenario at a time, the acknowledgement of personas whose session is not valid, at most one export of a render and two of the workspace at once; each holds within one process, and its refusal is worded for the channel (the Studio's words, else the glossary's) | — |
| caller | — | who drives the engine — its client (`cli`, `mcp`, `ui` for the Studio, `test`), the channel it speaks through (`cli`, `studio`, `mcp`) and the trust its work gets (`author`: a person at a terminal; `mcp`: an agent or a page); every decision the engine and the Studio's server take from who calls or who submitted a job is in one policy module (`packages/engine/src/caller.ts`) | `EngineClient`, `JobClient` (`submitted_by`), `AgentChannel`, `HookTrust`, `PlanTrust`, `BrandTrust` |
| work policy · agent policy · a person's policy | — | what a piece of work runs under (core `WorkPolicy`): the workspace's retake.yaml `ffmpeg` and `render:`, and whether the **agent policy** is on — on (its `agentFolders`: the workspace's folders) for work an agent can shape, which serves trust `mcp` (the jobs worker and its job processes, the MCP server, the Studio server): no program from inside the workspace or by a relative path, `browser.args` from an allow-list only, an allow-list of the worker's environment; off in **a person's policy**, a command a person types (trust `author`: `PERSON_POLICY`, `workPolicyFrom(null, …)`). The engine builds it when it opens a workspace (`OpenedWorkspace.policy`) and passes it to every adapter (option `policy`; `workPolicy` in the editor's render options); no module holds one | — |
| FileFacts · VideoProber | — | the two ports through which core's rules learn about the machine (`packages/core/src/file-facts.ts`): **FileFacts**, the disk (what is at a path, its real path, its text or first bytes, whether it runs, whether the file system ignores case); **VideoProber**, what a video file holds (ffprobe, under a work's policy). `nodeFileFacts` is the disk only, `fileFacts(policy)` both (a `WorkFileFacts`, what the loaders take); a check that needs one and is given none throws, never reads as "no file" | — |
| renderer · Renderer | — | what turns an edit plan into pictures: a video file, still frames, the posters and loops of component previews — the engine's port `Renderer` (`packages/engine/src/render/renderer.ts`: `video`, `stills`, `previews`). Around it, and not the renderer's: planning, the version reserved, the render record, where files go (the editor's use cases, reached by the engine in `render/work.ts` only). Under it: the bundle, the render browser, the encoder, the probe of the file written. Two adapters pass one contract suite: the editor's driver (`editorRenderer()`, made by the composition roots: the job process, the jobs worker, the CLI's render / export commands) and an in-memory one for tests. Work is handed exactly one renderer: none is refused, and so are the editor's own driver options beside one. Every caller is on the port since L7.2 (the CLI's `components preview` too); the port's types still borrow the editor's (plan, record fields, progress, preview spec) as types. Under the adapter, the rendering library is named in its seam files only (ratchet rule R10); the node side's seam is one loader of the library, not an interface: the library's API is still called in the editor's render, preview, policy and bundle files, and the Studio player's frame also reads a global the library sets | the editor's `RenderDriver` (the same shape, declared where it is implemented); `rendererTest` (the worker option that hands a test's renderer) |
| workspace journal | — | `<workspace>/.retake/journal.jsonl`: every authored write Retake made and every hook run, who made it, when, the outcome (`retake journal`) | — |
| project store · authored write | — | the one writer of what a person authors (scenarios, the README, threads, themes, components, new projects, the workspace's files, sandbox scaffolds): each write states the version it was made on (`if_match`: a hash, or none for a new file), takes its lock and is journaled (`packages/engine/src/store/project-store.ts`, `ProjectStore`); generated outputs (runs, renders, reviews, exports) and machine state (`.retake/`) are not authored writes | — |
| the Studio | — | the web app of a workspace (`retake ui`) and the desktop app around it | — |

## Homonyms

Each of these words has several meanings: say which one (the qualified form on the left of each item).

- **session** — a *session* alone is a persona's saved, signed-in browser state. The others are always qualified: a
  *Studio session* (one launch of the Studio's server, with its token), an *MCP session* (one client connection over
  HTTP), a *Claude session* (the conversation of the agent driving Retake), a *recording in progress* (not a session).
- **check** — always qualified: *validation* (the issues `retake validate` and `scenario_validate` report), *review
  checks* (the checks of a render's report), *doctor checks* (is this machine ready), *the hooks' security check*,
  *take checks* (what *Prepare a take* verifies before the browser opens), a sandbox's *health check*.
- **export** — an *export* alone is a render in delivery formats; the footage of a run for an editing tool is a *raw
  export*.
- **studio** — *the Studio* is the app; `studio/*` is the namespace of the built-in components; `studio` is also the
  name of the channel a request came through (from the Studio, as opposed to MCP).
- **template** — the old name of a theme, kept only in the names listed above; a *scaffold* is the starting files a
  command copies (`retake components create`); *filling in* (templating) is replacing `{{…}}` values in
  scenarios and hooks.
- **journal** — always qualified: the *workspace journal* (`.retake/journal.jsonl`: who wrote what, which hooks ran),
  a *hooks journal* (the rollbacks a run's hooks left to replay: `runs/<id>/hooks-journal.json`,
  `.retake/journals/<id>.json`). The job *history* (`history.jsonl`) is neither: it counts what was produced. `retake
  journal` reads the workspace journal; no command is named after the history.
- **kind** — always qualified: a *job kind* (`run`, `render`, `export`…: `JobRecord.kind`), a *component kind*
  (`overlay`, `transition`…), an *error kind* (`invalid`, `conflict`…: what a client outside the CLI is told), a
  *blocker kind* (which gate refuses a run). An operation has no kind: it has facets (its effect, job, code).
- **catalogue** — the *operation catalogue* is always called that; `catalogue` alone is the fixture project's
  scenario of that name (`scenarios/catalogue.yaml`, the product catalogue it films).
- **policy** — always qualified: the *work policy* (core `WorkPolicy`: what a piece of work runs under, the agent
  policy in it), the *render policy* (editor `RenderPolicy`: the GL backend, encoder and concurrency of a render, from
  the work policy's `render:`), the *write policy* of a run (core `WritePolicy`: the writes its browser guard stops).
- **production** — a *production environment* (`production: true`: read-only unless its access says otherwise); the
  Studio's *Productions* are scenarios. Outside the Studio, *production* only ever means the environment.

## Retired words

The help of the `retake` command, the MCP tools (titles, descriptions, argument descriptions, validation messages) and
the descriptions of the YAML schemas (`packages/core/schema`) and the engine's admission refusals through MCP never use
these words; `packages/cli/test/glossary.test.ts` reads this table. Other texts (other error messages, the Studio, the
docs) are not checked. Keep it short and exact: a row is
a word (its inflections too: -s, -es, -ed, -ing) or a phrase (its plural too).

<!-- retired-words:start -->
| Retired | Say instead | Why |
|---|---|---|
| rehearsal | dry run | *Rehearse* is the Studio's button for a dry run |
| rehearse | dry run | as above |
| shoot | capture | *Shoot* is the Studio's mode |
| cast | personas | the Studio's label |
| location | environment | the Studio's label |
| productions | scenarios | the Studio's label; *production* is an environment |
| template name | theme name | a theme is not a template |
<!-- retired-words:end -->
