# Demo Studio — spec for a scripted product-video capture & edit tool (macOS)

> Brief for a Claude Code session. Build it in phases; every phase must be usable on its own.
> The tool is generic: it is not tied to any product or brand. Projects, templates and brand assets live in the user's workspace, never in this repository.

## 0. Product principles

Demo Studio is a **third-party, product-agnostic tool** (sold as a licence in a V2): it must work with **any web
site or product**, not one use case.

- **No client inside the tool.** No customer name, brand, URL, account, asset or data in the code, docs, templates or
  fixtures. Customer material (projects, brand themes, logos, scripts, hooks, profiles) lives in the user's own
  **workspace** folder, selected with `DEMO_STUDIO_ROOT` or a `studio.yaml` — the tool installation stays clean.
- **Everything is authored, nothing is hard-coded.** Scenarios, themes (templates), framing, captions and motion style
  are data the user (or Claude through the MCP) creates. The tool ships generic starter templates only.
- **Authoring for any site.** Besides writing YAML by hand: draft scenarios from a timecoded script, inspect a live
  page to get robust targets, record a scenario by clicking through a site, and derive a theme from a brand (logo,
  colours, fonts) or from a site URL.
- **Robust on arbitrary front-ends.** SPA and full-page navigations, inner scroll containers, portals/popovers of any UI
  library, open shadow DOM, same-origin iframes, new tabs, cookie banners (hooks), authenticated sessions via
  pre-authenticated profiles.
- **Ready for packaging.** Clean package boundaries (core / runners / editor / review / MCP / CLI / desktop), config
  over code, no absolute paths, versioned file formats (`version` fields), so licensing and a hosted offer can be
  added in V2 without re-architecture.

## 1. Goal

From a **precise scenario** (pseudo-code: open, click, type, scroll, wait, capture, zoom, caption…), produce **professional product videos** with no manual steps:

1. drive a real app (web in Chromium, iOS app in the Simulator), **headless/offscreen, at any virtual resolution** (1920×1080, 2560×1440, 4K, mobile), while the user keeps working;
2. record a clean capture with a **cursor drawn inside the page** (so clicks and screen reactions are synchronised by construction);
3. emit a **timeline of events** (each step's start/end in capture time);
4. edit automatically: framing (raw / browser mockup / laptop mockup / phone), captions, intro/outro, interstitials, speed ramps, cuts between scenes, optional slow zooms, all driven by the timeline and a project template;
5. export MP4 + **review artefacts for Claude** (contact sheets, key frames, JSON timeline) so an agent can check the result;
6. be fully drivable by an **MCP server** so a Claude session can create projects, write scenarios, run, review and iterate.

Non-goals (v1): voice-over generation, music generation, Windows/Linux UI.

## 2. Lessons that are requirements

These come from real failures; the design must make them impossible.

- **Never add the cursor or the zooms in post from guessed timestamps.** Cursor overlay lives in the page during capture; camera moves are keyed to timeline events emitted by the runner.
- Screenshot-based capture is limited by the display: use CDP screencast or a virtual display, never screen grabs of the physical monitor.
- Real clicks with tool latency produce hesitations: the scenario must execute **inside a single runner** with deterministic pacing (no round trip per action).
- UI libraries differ (Radix vs Base UI): `click` needs strategies (native click, pointer sequence, fallback when a popup did not open), "click outside" to close popovers, "last visible" element selection when several popovers are mounted.
- Synthetic clicks cannot open new tabs (`target=_blank`): runner must follow the href in a new page and keep recording.
- Products block some shots (duplicates, permissions, future dates): first-class **setup/teardown hooks** (HTTP calls, SQL, shell, JS) with automatic rollback.
- Users dislike: zoom in/out at every cut, cursor out of sync, fades on wrong frames, 30 s of uninterrupted slow action. They like: real capture + light motion design, browser/laptop mockups, intro + outro with logo, captions instead of voice-over.

## 3. Architecture (recommendation)

Do **not** start with a native Rust app. The hard parts are browser automation, capture and video composition, which are best served by the TypeScript ecosystem. Native UI comes last and stays thin.

```
demo-studio/
  packages/
    core/        # scenario parser + validator (YAML + JSON Schema), project model, timeline types
    runner-web/  # Playwright/CDP runner: offscreen Chromium, cursor overlay, actions, screencast → frames → mp4, timeline.json
    runner-ios/  # iOS Simulator runner: xcrun simctl (boot, install, openurl, io recordVideo), idb/XCUITest for taps & typing, touch overlay
    hooks/       # setup/teardown: http, sql (pg), shell, js-in-page; rollback journal
    components/  # built-in component library (intros, outros, captions, layouts, cards, overlays) + registry/loader
    editor/      # edit planner + Remotion composition that assembles components; renders from timeline + theme
    review/      # contact sheets, key frames, scene thumbnails, diff vs previous render, JSON report
    mcp/         # MCP server (stdio + HTTP) exposing the tools in §8
    cli/         # `studio run|render|review|new|ui` — everything the MCP does, for humans and CI
    ui/          # Studio web app (scenario blocks, timeline, comments) served by `studio ui`
  apps/
    desktop/     # Tauri shell (Rust) around packages/ui — macOS
  templates/     # generic starter themes (brand themes live in the user's workspace)
  skills/        # Claude skills shipped with the tool (scenario, theme, component authoring); also the Claude Code plugin root
  .claude-plugin/ # the local plugin marketplace (one plugin: skills/)
  projects/      # user projects (see §4)
```

- Language: TypeScript (Node 22), pnpm workspace.
- Web automation: **Playwright** for orchestration + **CDP** (`Page.startScreencast` at quality 100, or `HeadlessExperimental.beginFrame` for deterministic frames when available). `deviceScaleFactor` 1 or 2 for crisp 4K. Headless new mode → any viewport, independent of the physical screen.
- Video: ffmpeg (frames → mp4, VFR → CFR 30/60 fps), Remotion for composition (React, same stack as the existing toolkit).
- iOS: `xcrun simctl io <device> recordVideo --codec h264`, input via `idb` (Facebook) or an XCUITest driver; device frame mockups.
- Desktop shell (phase 5, L5.2; the Studio web app it wraps is phase 4): **Tauri** — small, native, JS front-end, Rust only for OS glue (menus, notifications, file dialogs, keychain).
- Persistence: plain files (YAML/JSON/MP4) in project folders, git-friendly. SQLite only for the render queue/history.

## 4. Project model

```
projects/<slug>/
  README.md            # what the product is, audience, goals, tone, links (staging URLs, accounts *by reference*), do/don't
  project.yaml         # defaults: viewport, fps, template, frame style, locale, environments
  template/            # or reference to templates/<name>
  scenarios/<name>.yaml
  hooks/               # sql/http/js/sh used by scenarios
  sandbox/             # optional: sandbox.yaml (+ compose.yaml, seed/) of a local, disposable copy of the product
  assets/              # logos, fonts, product images, music
  runs/<timestamp>/    # capture.mp4, frames/, timeline.json, logs, screenshots on error
  renders/<name>-vN.mp4
  review/<name>-vN/    # contact sheets, key frames, report.json
  comments/<scenario>/<thread-id>.json   # frame comments, one file per thread (committed; stills in .demo-studio/comments/)
```

`project.yaml` example:
```yaml
name: Northfield
environments:
  staging:
    console: https://console.staging.example.com
    shop: {url: https://shop.staging.example.com, display: shop.example.com}   # the URL the video shows
  production:    # long form: settings + pages; production is read-only (writes stopped or mocked, writing hooks refused)
    production: true
    pages: {console: https://console.example.com, shop: https://shop.example.com}
auth:            # personas by name: never a password, never a path (sessions stay in ~/.demo-studio, kept by `studio login`)
  staging:
    login_url: /sign-in
    personas:
      supplier: {pages: [console], check: {url: "console:/", expect_text: Maja Lindqvist}}
      buyer: {pages: [shop], check: {url: "shop:/", expect_text: Demo Café}}
capture: {width: 1920, height: 1080, scale: 1, fps: 30}
frame: browser   # raw | browser | laptop | phone | card
template: editorial
locale: en
mailbox: {provider: mailpit, url: http://localhost:8025}   # optional test mailbox for wait_for_email (host must be allowed)
sandboxes: {sandbox: sandbox/sandbox.yaml}   # L1.8: a sandbox environment (process or docker-compose), reset before each take
```

A sandbox (L1.8) is an environment Demo Studio starts, seeds and resets itself: its `sandbox.yaml` declares the
services (pages, display URLs, health), the seed, the reset strategy (reseed, or a Postgres snapshot), the databases,
the mailbox (Mailpit) and demo accounts — the personas of that environment. `studio sandbox up | down | reset | status
| logs | init`; `studio run … --sandbox` resets it before the take, so every take starts from the same data.

## 5. Template (brand & motion style)

```yaml
# templates/editorial/template.yaml
colors: {accent: "#8a2332", text: "#1f1413", muted: "#6b605d", paper: "#f3eee8"}
fonts: {display: fonts/Display.ttf, body: [fonts/Body-Regular.ttf, fonts/Body-SemiBold.ttf, fonts/Body-Bold.ttf]}
logo: logo.svg
background: {type: radial, from: "#f8f4ef", to: "#ebe4dc"}
frame: {style: card, width: 1560, radius: 18, shadow: soft}   # or browser chrome / MacBook mockup
captions: {position: below, kicker: {font: body, weight: 600, size: 15, uppercase: true, color: accent}, line: {font: display, size: 35}}
intro: {duration: 3.2, layout: logo-kicker-title}
outro: {duration: 3.0, layout: logo-wordmark-tagline-url, url: example.com}
interstitial: {style: dark-clock}
transitions: {between_scenes: crossfade, duration: 0.35}
cursor: {style: arrow-dark, ripple_color: "rgba(138,35,50,.45)"}
motion: {default_zoom: none, max_zoom: 1.4, zoom_ease: [0.45,0,0.2,1]}
style_bias: real   # real | balanced | motion — tunes how much motion design is added
```

## 6. Scenario language

YAML, validated by JSON Schema, with a strict, small vocabulary. Every step can carry `id`, `caption`, `speed`, `hold`, `camera`.

```yaml
video: catalogue
title: {kicker: For suppliers, text: Manage your catalogue}
outro: {tagline: "Your catalogue, under control."}
setup:
  - http: {method: POST, url: "{{console}}/api/..."}          # data prep, recorded for rollback
  - sql: hooks/remove-registry-refs.sql
    confirm: true
teardown:
  - sql: hooks/restore-registry-refs.sql
scenes:
  - id: import
    caption: {kicker: Catalogue import, text: "Import your entire price list in seconds, with availability by region."}
    page: console
    open: /imports
    steps:
      - wait: 1.5
      - click: {text: New import}
      - select: {combobox: "#import-organization", option: Northfield Roasters}
      - drop_file: {zone: {text: "Click to choose a file"}, name: "Northfield - Price list 2027.xlsx", fake: true}
      - hover: {text: Start import}
      - hold: 1.8
  - id: availability
    open: /availability/products/finca-lirandel-geisha
    steps:
      - scroll: {to: 560, duration: 1.5}
      - menu: {row: Iceland, item: Pause, confirm: Pause}
      - menu: {row: Sweden, item: Edit}
      - pick: {field: Bag sizes, option: 1 kg}
      - pick: {field: Grind options, option: Espresso}
      - pick: {field: Label languages, search: Swe, option: Swedish}
      - click: {text: Save, in: dialog}
      - hold: 2
    speed: 1.6          # edit-time speed for this scene
  - id: add-product
    steps:
      - click: {text: Add a coffee}
      - type: {into: {in: dialog, role: textbox}, text: Finca Quenaro, cps: 10}
      - click: {in: dialog, contains: [Finca Quenaro, "2026"]}
      - wait_for: {not_text: Enrichment in progress, timeout: 30}
        mark: reveal     # named marker usable by the editor (speed 1, optional zoom)
      - scroll: {to: {text: Awards}, offset: -140, duration: 2.2}
        camera: {zoom: 1.3, target: {text: Awards}, ease: slow}
      - hold: 3.5
  - interstitial: {text: A few hours later, duration: 2.6}
```

Actions (v1): `open`, `click`, `double_click`, `hover`, `type`, `press`, `select`, `pick` (multi-select popover), `menu` (row action menus with optional confirm), `scroll`, `drag`, `drop_file`, `wait`, `wait_for`, `hold`, `assert`, `screenshot`, `new_tab` (follow href), `switch_page`, `eval` (escape hatch JS), `notify` (macOS notification), `emit` (custom event into the timeline), `cursor: {show|hide|move}`,
`wait_for_email` (wait for a message in the project's test mailbox and capture it: from, to, subject, text, rendered HTML image; `as: <name>`),
`download` (click a link/button, capture the file — download event or a document opened in a new tab, with the session's cookies — into the run; PDFs are rasterised page by page; `as: <name>`).
Captured emails and documents are run artefacts that components reference by name (slots `email: <name>`, `document: <name>`); a document can also be a project file (`document: assets/quote.pdf`).
Target syntax: `text`, `contains`, `role` + `name`, `label`, `aria`, `css`, `in` (dialog/menu/row), `nth`, `last_visible: true`.

## 7. Runner behaviour (web)

- Launch Chromium headless (new) with a persistent, pre-authenticated profile; set viewport + scale; inject the cursor overlay at every navigation (`addInitScript`).
- Execute the scenario in-process with deterministic pacing (cursor speed scales with distance, hover before click, post-open delays), click strategies (native → pointer sequence fallback when a popup did not open), "click outside" for popovers, last-visible element selection, retries with clear errors (screenshot + DOM snippet on failure).
- Record via CDP screencast → frames with real timestamps → ffmpeg CFR mp4. Emit `timeline.json`: per step `{scene, step, action, target bbox, t_start, t_end, mark}` in capture time.
- Dry-run mode (no irreversible steps, no recording) and `--until <step>`.
- Setup/teardown hooks with a rollback journal; teardown always runs, even after failure.

## 8. MCP server (tools)

Built in L3.1 (`studio mcp`, stdio; L4.1: the same tools over Streamable HTTP too, `studio mcp --http` on 127.0.0.1; arguments as the tools publish them — every `project` is a slug, never a path):
- `engine_info`; `project_list`, `project_get({project})`, `project_create({name, slug?, readme?, environments?, template?})`, `project_update_readme({project, markdown, if_match?})` (`if_match` required once README.md exists)
- `scenario_get({project, name})` → yaml + hash, `scenario_validate({project, yaml, env?, until?, name?})` → issues with line/col, `scenario_save({project, name, yaml, if_match?})` (`if_match` required once the file exists)
- `run_dry({project, scenario, env?, until?, hooks?, wait_s?})` → the run as it is after `wait_s` (default 20 s): steps, screenshot paths, the failing step's screenshot and DOM paths
- `run_capture({project, scenario, env?, sandbox?, wait_s?})` → run id at once; `run_status({project, run_id, wait_s?})`; `run_cancel({project, run_id})`; `run_list({project, scenario?, mode?, limit?})`
- `job_list({project?, state?, limit?})`, `job_status({job_id, wait_s?})`, `job_cancel({job_id})` (every long task is a job)
- `hooks_run({project, source, env?, dry?, wait_s?})` — `source`: `reset`, `<scenario>:setup`, `<scenario>:teardown` or `hooks/<name>.yaml`; `dry` defaults to true; `env_reset({project, env?, dry?, wait_s?})`
- `auth_status({project?, env?})`; `auth_login({project, persona?, env?, mode?, wait_s?})` — `headed` (default) opens a window on the user's machine for the human to sign in; `auto` plays the persona's login steps; no credential argument exists
- `sandbox_status({project, env?})`, `sandbox_up({project, env?, wait_s?})`, `sandbox_reset({project, env?, reseed?, wait_s?})`

Built in L3.2 (renders, reviews, exports and previews are jobs of the same worker; a theme is a name, never a folder):
- `plan_preview({project, scenario, run_id?, template?, overrides?})` → the plan without rendering (segments, timings,
  warnings; L5.5: the edit comes from today's scenario file while its filmed part matches the run's snapshot,
  `scenario_changed` and `filmed_changes` when the filmed part differs — a render then shows the run as captured and
  `run_capture` films the change; L3.8 compared the whole file); `render({project, scenario, run_id?, template?,
  overrides?, wait_s?})` → render id at once;
  `render_status({project, render_id | "latest", scenario?, wait_s?})` (job first, then renders/<id>.json)
- `review({project, render_id, fps: 1|2, previous?, images?, wait_s?})` and `review_get({project, render_id, images?,
  wait_s?})` → verdict, finding codes and times, durations, diff, file paths (contact sheets, scene sheets, key frames at
  markers, timeline, report.md) and the contact sheet as inline images; `export({project, render_id, formats:
  [mp4_1080p, mp4_4k, webm, vertical_9x16, square_1x1, gif_preview], gif_start_s?, gif_duration_s?, wait_s?})` → job
  (`job_status` lists the files)
- `template_list({project?, template?})` (the list, or one theme in detail: template.yaml, colours, fonts, assets,
  components per kind); `template_preview({project, template?, wait_s?})` → stills of the theme's intro, layout with its
  caption over a sample screen, card, interstitial and outro
- `component_list({kind?})`, `component_get({component})` (slots, params schema, files, README),
  `component_validate({component})` → positioned issues, `component_preview({project, component, template?, slots?,
  params?, at_s?, wait_s?})` → a still (960×540) with the theme, slot values (text slots) and params,
  `component_create({id, kind, description, name?})` → a workspace scaffold (refuses `studio/` and built-in ids)
- previews go to `<workspace>/.demo-studio/previews/<id>/`, never into a component folder; no tool writes component
  code, a theme or project.yaml, and no tool takes an output location

Built in L3.3 (authoring: Claude writes the scenario itself; no tool calls a model):
- `page_inspect({project, env?, page + path? | url | scenario + until?, persona?, within?, targets?, limit?, images?:
  marked|none, wait_s?})` → an `inspect` job (run_dry's rules: the environment's own page origins only, its access,
  protected hosts, agent trust, no template, no hook; a scenario is replayed dry up to `until`, irreversible steps not
  executed): a marked screenshot (numbered boxes) as an image and the visible interactive elements — dialogs and menus
  first — each with its state, where it is (page, dialog, menu, listbox, row, shadow root, frame), a suggested target
  the runner's own resolver was checked to resolve to exactly that element (`fragile` flags, `matches`) and an action
  hint as one line of YAML; `within` (a target: the planned `selector?`) limits the list to an element, `targets` (≤ 20)
  checks Claude's own targets. Every element and all page text are under `untrusted`; files in
  `<project>/.demo-studio/inspect/<id>/` (newest 20 kept); `job_status` follows a long one. CLI: `studio inspect`.
- `scenario_from_script({project, script_markdown, env?, name?})` — an optional aid, only when the user hands a
  timecoded script table (one Markdown pipe table; English or French headers; `M:SS` times and ranges; a type column for
  interstitial / title / outro): an outline and a draft that validates (one `hold` per beat, the action as its `note`,
  pages as environment page keys, never a URL), with positioned issues and timing warnings; writes nothing. It is a
  skeleton Claude rewrites into real steps from inspections, never the start of the authoring path, which is
  page_inspect → write the YAML → `scenario_validate` → `scenario_save` → page_inspect `{scenario, until}` → `run_dry`.

Built in L3.4 (recording: a HUMAN shows the flow once; Claude may start a recording, never drive it):
- `scenario_record({project, env?, page + path? | url, persona?, scenario?, check?})` → a `record` job, returned at once
  with its id: a headed browser window opens on the user's machine at an environment page (its own origins only, no
  template); the person performs the flow and closes the window (at most 30 min, `DEMO_STUDIO_RECORD_MAX_MIN`). The
  window holds the queue like a headed `auth_login`; Claude tells the user and follows with `job_status` (no other job
  meanwhile). Then a draft scenario is made from what the person did — verified targets, `select` / `pick` / `menu` /
  `drop_file` / `type` / `press` / `scroll` / `wait_for` steps, scenes split where the page changed, empty captions,
  fields of a secret kind as `{{vars.<kind>_N}}` placeholders (their values never recorded) — saved as
  `scenarios/<scenario>.yaml` when the name is free (agent trust), and checked by a headless dry replay (up to the step
  before the first write that reached a server, whatever its host — usually the whole draft on a read-only
  environment, whose writes are stopped or mocked). Typed text holding a `{{…}}` template never reaches the draft. `job_status` returns counts, the saved file
  and the check as trusted fields and the draft, read from `<project>/.demo-studio/records/<rec_id>/`, under
  `untrusted` (typed text and page names). The environment's own access (production read-only, never
  `--allow-writes`), no hook, the workspace's protected hosts. `job_cancel` while the window is open discards the
  recording; a worker signal stops it and keeps it (no check replay). CLI: `studio record` (the primary path).
- `template_create_from_brand({name, base?, colors: {accent, text?, paper?, muted?, dark?}, background?, adjust?, logo,
  wordmark?, fonts?: {display?, body?[]}, brand?: {name, url}, replace?})` (L3.5) → a new folder
  `<templates_dir>/<name>/`: template.yaml over the base theme (default editorial; its components, frame, captions,
  motion and durations kept) with a deterministic palette (hex; derived colours; WCAG contrast checked, misses lifted
  and reported, the accent never changed — a suggestion instead), the logo / wordmark / fonts copied after header
  checks and a strict SVG scan, LICENSES.md and a provenance file (sha256 of each file). Files are workspace-relative,
  never in hidden, components or agent-writable folders; the name is lower-case, never a starter's or an existing
  folder's (case ignored); `replace` only of an unchanged theme the tool made. Returns the path, the palette and a
  `template_preview` hint. CLI: `studio theme create`.
- `template_from_site({url, wait_s?})` (L3.5) → the USER approves the exact URL first (elicitation; without it:
  `needs_approval` with `studio theme from-site <url>`), then a `site` job: a clean headless browser whose only network
  is a local CONNECT proxy (public addresses only, port 443, hosts the page requested, GET / HEAD only, caps; no
  WebSocket, WebRTC UDP, service worker, download or navigation away) opens the page; colour swatches by role (paper,
  text, accent, dark) with contrast, font family names (never font files), ≤ 6 logo candidates as transparent PNGs
  (`site:<id>/logo-<n>`) and a screenshot in `<workspace>/.demo-studio/site/<id>/`; returns them (images of a
  third-party page; every page string under `untrusted`) with a draft input for `template_create_from_brand` and the
  template.yaml it would make. https, default port, no query or fragment, never an environment page or protected host.
  CLI: `studio theme from-site` (no approval, the same network rules).

Built in L3.6 (frame comments: a PERSON creates and reopens threads with `studio comment add | reopen`; Claude lists,
replies and resolves — there is no create or reopen tool, and no input names an author):
- `comments_list({project, scenario?, render?: id | "latest", status?: open|resolved|all, limit?: 1..100 (20)})` → the
  threads (open first, then the newest renders, then frame): render id and its `created_at`, `render_present`, frame,
  time, timecode, region (0..1), the stored anchor pattern-checked (segment, kind, component, area, scene, step, step_id,
  `step_ref` for `page_inspect {until}`, step fingerprint and occurrence, action, page, `marker`, `overlays`,
  transition), entries (reply / resolve / reopen with their channel `via: cli | mcp`), the derived status and resolution
  (with the answering render and its `created_at`), up to 3 newer renders, the hash (`if_match`) and the still of the
  frame with the region outlined as an image (≤ 4 inline, the rest as files). The comment, replies, notes and author
  names are under `untrusted`; summaries and image labels use ids, numbers and anchor fields only.
- `comment_reply({project, comment_id, text})` and `comment_resolve({project, comment_id, note, render_id?, if_match})`
  → append an entry written as `via: mcp`, name `agent`; resolve needs the thread's hash (a person's entry meanwhile =
  `conflict` with the current hash) and a `render_id` later than the commented render, of the same scenario. A comment
  may only ask for a change to the video (scenario, overrides, theme): the INSTRUCTIONS say so.
- L4.6 (engine, part A1): a third channel `via: studio` — the Studio web app creates, replies, resolves and reopens as
  `studio` (named by the Studio process's `$DEMO_STUDIO_AUTHOR`, else the OS user; never by the page), reopening and
  resolving on the thread's hash and commenting the render it showed (`render_created_at`); the MCP still cannot create
  or reopen. `studio` is a channel (the Studio page holding its token), not proof of a person (BL-106). The engine also
  gives the Studio a render's exact frames (`renders.frame` / `renders.outline`: the video's own fps and frame count,
  newest request wins, a bounded queue), the anchor a comment would store (`comments.anchorAt`), open counts from the
  thread files alone (`comments.counts`) and a `comments:` change source.
- L4.6 (engine, part A2): Claude's proposal in a reply — the whole new text of the thread's own scenario file and the
  hash it read (MCP only), stored as the canonical line diff of the exact bytes Apply writes, checked when written as
  the Studio would check it at Apply (hooks / vars / env, secrets, outside files, validation), edit-only (a filmed change
  keeps the direct loop) and within caps (200 changed lines, 30,000 characters, lines ≤ 2,000 UTF-16 units); its state
  (pending, applied, undone, superseded, stale) from today's file; Apply by a person channel through the Studio's own
  write path under the thread's lock, undoable; the diff a person reads computed by the engine; a timeline preview of
  the proposed text planned in memory (nothing written, never a restorable version).
- L4.6 (MCP and skills, part B): `comment_reply` takes that proposal as `proposal: {scenario_yaml, scenario_hash}` and
  answers with the stored diff; `comments_list {comment_id}` reads a thread's newest proposal back, and every listing
  names each proposal's state. The INSTRUCTIONS and the scenario skill: an open Studio thread whose change is edit-only
  gets a proposal, every other thread (a terminal's, a filmed change, a theme, an override) the direct loop; people
  create, reopen and apply; Claude never reads the Studio's token file or calls its routes (pinned by the skill lint).
- L4.6 (Studio server, part C): the Studio's own comment ops — a scenario's threads and counts, one thread with its
  newest proposal and what may be offered for it (Apply; Preview change when it renders on the commented take; Apply and
  re-render only for a landscape thread rendered with the files' theme and no override), a render's frames and outline,
  the anchor a comment would store; create, reply, resolve, reopen and apply on the thread version shown — strict inputs
  (no author, channel, path or proposal from the page), path-free answers, texts under `untrusted`; Apply on the one
  chain shared with the Studio's edits and renders of that scenario; the timeline previews a proposal through the same
  workspace-component hold; the event stream names the scenarios whose threads changed.
- L4.6 (Studio app, part D1): the Comments screen of a scenario — the open / resolved list, any finished render's own
  frames made by the server (slider, frame and second steps, a typed time; one request in flight, the newest frame
  wins), a region dragged on the frame or typed in four % fields (rounded, then clamped inside the frame), the anchor
  chips before posting, the thread with reply / resolve / reopen on the version shown; the timeline's Comment at the
  playhead (a render of the version shown) and a pin's Open thread; "Comments (N open)" beside the scenario's tabs.
- L4.6 (Studio app, part D2): Claude's proposal in the thread — the diff the server computes from today's file, drawn as
  code (edge spaces, tabs, unseen characters and piled-up accents visible; byte order left to right, a right-to-left
  line marked), every row shown before the buttons, a rewrite note past 25 %; the buttons the server offers (Apply,
  Preview change on the timeline under a banner that only leads back to the diff, Apply and re-render then Resolve with
  vN), nothing offered when Apply would refuse, Undo apply in the tab that applied.
- L4.6 (fixes after the two reviews): a proposal is refused when its diff passes 600 rows, when it changes the theme or
  holds half a character; Apply checks the thread has room before writing; Studio errors are path-free; frame requests
  are admitted at arrival (newest wins, the bound before the file is opened, outlines too), a timeout is its own error
  and the page says a frame that keeps failing; a video not starting at 0 or with a variable frame rate is refused; the
  CLI prints applies and proposal states; MCP proposal rows fit the result budget.
- L4.6 (acceptance, part E): the whole loop on the fixture product in the installed Chrome (gated, own ports) — capture,
  render from the timeline, comment the total with a region from the timeline's Comment, Claude's caption proposal,
  Preview change, Apply and re-render, resolve with the new render; the viewer's frame latency measured on that render
  and a 4K copy (1080p: a frame in 150–223 ms typically, 372 ms at worst; 4K: 490–661 ms, 1.4 s at worst). Safari, Firefox and a live Claude Code session by hand (MACOS-CHECKLIST 13g).
- L4.7 (acceptance, part E): the loops of all 41 built-ins rendered by the worker in the editorial starter (80 s, 8.4 MB,
  ≈ 1.5 s a loop once the bundle is built) and in a dark copy (posters and loops, 73 s), frames of every kind looked at;
  in the Studio with the real worker (gated, the fixture on free ports): Play renders and plays a loop, Copy to edit, a
  colour dragged in the live frame then written, Use in this scenario, and a render of the existing take showing the new
  theme. Safari and Firefox by hand (MACOS-CHECKLIST 13h).

All long tasks are jobs with status polling (agents' tool calls time out): a call long-polls at most `wait_s` ≤ 25 s
with progress notifications, and `*_status` follows. Every tool returns a short text summary readable by Claude plus
structured data with file paths; text that comes from the filmed site is kept under `untrusted`. Hooks or seed steps
that are destructive or run shell commands, and setup hooks whose rollback is destructive, shell or JavaScript, need a
human approval through MCP elicitation (`confirm: true` in a file does not count), else the call is refused with the
`studio` command a human runs. Through MCP a scenario names no secret (`{{env:…}}` / `{{keychain:…}}`: only
project.yaml and hooks/ files resolve them), references no file outside its project nor runs code from a file the agent
can write, and nothing runs read-write on a host of another project's production or read-only environment.
Renders through MCP (L3.2) read only files of the project, the run and the theme folder (checked before anything is
read, then on every file the plan serves; a Lottie file counts as code), name themes by name (project.yaml's own theme
folder excepted), refuse remote images in slots, and run with the render browser's network guard: only the plan's
asset server and Remotion's bundle server are reachable — any other request is blocked and named as a warning.
Previews run with the same guard. A render (a preview, an export's re-render) records its browser: a worker killed
mid-render leaves it running until the next worker starts, marks the job interrupted and kills it (a reused pid is
never killed).

Built in L3.7 (Claude skills, `skills/`): `demo-studio-scenario` (inspect → write → `scenario_validate` →
`scenario_save` → `page_inspect {until}` → `run_dry` → capture → render → review; the recorder and the script table as
alternatives; the frame-comments loop), `demo-studio-theme` (brand files in the workspace or `template_from_site` on a
site the user named → `template_create_from_brand` → `template_preview` → render → review) and
`demo-studio-component` (an existing component first → `component_create` → code edited with the user's agreement,
renderer primitives through the kit → `component_validate` → `component_preview` in the user's theme → render). Skills
are instructions only (frontmatter `name` + `description`, no pre-approved tools): every gate stays in the tools, and
their Rules make a refusal or an approval request final and forbid running the `studio` CLI through Claude's shell for
anything a tool refused, asked approval for or does not offer. `skills/` is also a Claude Code plugin (its
`.mcp.json` starts `studio mcp` from userConfig values; a local marketplace at the repository root; installed per
workspace with `--scope local`); a deterministic lint checks the skills against the tools' schemas, the CLI's help,
the scenario and component validators and the files.

## 9. Editor (Remotion) rules

- Inputs: capture.mp4 + timeline.json + template + scenario edit hints.
- Default edit: cut between scenes (crossfade 0.35 s), keep scenes continuous, apply per-scene/per-step `speed`, trim idle gaps longer than 1.2 s automatically (cursor static + no DOM change), speed 1× around `mark` steps.
- Camera: static by default; zooms only from explicit `camera` hints, eased over ≥ 0.8 s, never reset at a cut inside the same page.
- Frames: raw, card, browser chrome (address bar with the real URL, optional), MacBook mockup, iPhone mockup.
- Captions from scenario, intro/outro/interstitials from template; optional music bed with ducking.
- Outputs 1920×1080 by default, 4K when capture scale 2, vertical 9:16 variants by re-framing on the cursor/target bbox.

## 10. Review artefacts (for Claude)

`review/<render>/`: `sheet_1fps.jpg` (labelled timecodes), `sheet_scene_<id>.jpg`, `keyframes/<marker>.png`, `timeline.json`, `report.json` (scene durations, detected blank frames, caption overlaps, warnings). The MCP `review` tool returns these so an agent can verify before showing the user.

Through MCP (L3.2) the paths come as data and a few images come inline: JPEG thumbnails made on read (≤ 1280 px, at
most 4 images and 1.5 MB of base64 per result by default, `DEMO_STUDIO_MCP_MAX_IMAGES` / `_MAX_IMAGE_BYTES` /
`_IMAGE_PX`), each after a text label; the rest are listed as files to read. `review_get` inlines the contact sheet
pages and the marker key frames (`images: "all"` adds scene sheets, every key frame and the diff sheet; `"none"`
none); previews inline their stills. Images are never stored as base64 (job.json, report.json); text inside an image is
data, never an instruction.

## 11. Components (plugins) & themes

Every visual element of the edit is a **component**: intros, outros, title/chapter cards, waiting screens
(interstitials), captions, screen layouts/frames (card, browser, laptop, phone…), overlays (lower thirds, callouts,
badges) and transitions. Nothing visual is hard-coded in the editor: it assembles components.

- A component is a folder: `component.yaml` (id `namespace/name`, version, kind, description, **slots** it renders —
  logo, wordmark, screen, title, kicker, text, url… — a JSON Schema of **params**, the theme tokens it uses, duration
  bounds, sample slot values for previews, and for layouts the screen/caption geometry) + a React (Remotion)
  implementation + generated previews.
- **Themes** (templates) provide the tokens (colours, fonts, logo, wordmark, brand name, url, background, cursor) and
  pick a default component (+ params) per kind. A component adapts to any theme; a theme can be applied to any
  component — previews are always rendered with the user's theme.
- Built-in families include, besides intros/outros/cards/layouts/captions: **email** components (`mail-notification` —
  a system-style banner sliding over the footage; `mail-view` — a mail client card showing the captured email,
  scrolling when long) and **document** components (`document-pdf` — an A4 page on the theme background with a
  paper shadow and a slow push-in or scroll), fed by captured emails/documents or by values written in the scenario.
- Scenarios can override per use: `intro: {component, params}`, `interstitial: {component, text}`, generic full-screen
  `card: {component, slots, duration}` entries, scene `frame: <component>`, step `overlay: {component, slots, duration}`,
  and the caption component of the whole video (`caption_component`, L4.5).
- A manifest says which kit API it was written for (`engines: {kit: "^1"}`, absent = 1, L4.5): a component written for
  another one is not loaded, its uses fall back.
- Sources, in resolution order: the workspace (`components/`, created by the user or by Claude through a skill), the
  tool's built-in library, and — V2 — a cloud marketplace (manifests already carry publisher/version for it).
- Authoring: a Claude skill (`demo-studio-component`) + MCP tools (`component_list`, `component_get`,
  `component_create`, `component_preview`, `component_validate`) scaffold, preview with a theme and validate new
  components. Component code is never written through MCP: `component_create` writes the tool's own scaffold (it
  refuses the `studio/` namespace and any built-in id — a workspace component of that id would replace the built-in in
  every render); the code is then edited by the user, or by Claude Code's own file tools with the user's permission
  (component code runs in the render's Chromium — the compile check's import scan can be evaded, the network guard
  still applies). MCP previews are written to `.demo-studio/previews/`, never to the committed `preview.png`.
- Themes are edited by people, in the Studio's theme editor (L4.7): each change one verified write to template.yaml
  (an allow-list of fields, the file's comments kept, undo / redo to the exact bytes), on a workspace theme only —
  starters and anything shipped with the tool are copied first. Through MCP, Claude makes new themes and never edits an
  existing one. A scenario picks a theme with `template:` (the Studio's *Use in this scenario*, or Claude through
  `scenario_save`): every existing take of it uses that theme at its next render; project.yaml's theme stays a hand edit.
- The library's previews (L4.7): a poster and a looping GIF per component and theme, rendered by the jobs worker in the
  render's guarded browser and cached in `.demo-studio/cache/previews/` by a key over every file they depend on; the
  committed `preview.png` of a built-in is its poster in the editorial starter. Measured: about 1.5 s per loop once the
  worker has its bundle; the 41 built-ins' loops in about 80 s, 8 MB. One workspace component that does not compile or
  throws as it loads fails alone (the others are rendered with their own components); its failure is asked again by
  itself once any component changes. A component imports only files its folder's content hash reads (never a dot
  folder, node_modules, previews or dist): every cache and the preview allow-list are keyed by that hash.

## 12. Studio app (web UI, then the Tauri desktop shell)

A client of the same packages (the MCP keeps working without it). Served locally by `studio ui`; the Tauri app
(phase 5, macOS) wraps the same UI.
- **Projects**: list, README editor, themes & component gallery (previews rendered with the project theme, and a short
  animated preview per component so motion can be judged without a render). Built in L4.7 part D1 (the library screen,
  `#/p/<slug>/library`): the grid by kind with each component's poster in the selected theme (a switcher), filters,
  a source badge in words (*Built-in* / *Workspace* — the tool cannot tell who wrote a component), Play swapping the
  poster for a looping GIF rendered by the worker (cards on screen only, ≤ 12 per job, Retry for a failure), a detail
  (slots, params, kit compatibility, README as text), "Set as theme default" (one verified theme write with undo; a
  starter copied first) and "Create with Claude" (a prompt to copy: the Studio calls no model). The theme screens came in L4.7
  part D2 (`#/p/<slug>/themes[/<theme>]`): the list (editable or read-only by real path, Copy to edit, New theme from
  brand files, site extractions with the command to copy for a new URL) and the editor (brand, colours with contrast
  checks, background, type pair from the theme's own fonts, motion, cursor, a component per kind; each change one
  verified write with undo / redo; a live preview of the intro, a clip with its caption and the outro; Use in a
  scenario).
- **Scenario as blocks** (WYSIWYG-like, two-way with the YAML — comments and formatting preserved): scenes are cards
  (page, URL, caption, speed); steps are rows with an action icon and **badges** (click, type, navigation, scroll, zoom,
  hold, mark, caption, speed, irreversible); inline editing, drag & drop reordering; each step shows the real frame from
  the last dry-run/capture. Built in L4.3: the YAML tab is editable, saved with the same checks as an MCP save
  (if_match, validation, agent trust) plus the Studio's own — hooks unchanged (and, while there are hooks, the vars and
  env they read), no hidden character added or moved — and a file holding a secret reference is shown read-only with
  why. Steps move (drag & drop with grips, Alt+↑/↓), duplicate and
  delete on the Blocks tab: each edit rewrites only that step's lines, is verified by re-parsing and is undoable (⌘Z,
  the exact earlier bytes). The inspector edits a step's values through a form derived from the scenario schema
  (scalars and a flat target, the empty optional fields folded; the rest in the YAML tab) and a palette of 15 actions
  adds steps: each change rewrites only its own line(s) and applies only while the field still holds what the form
  showed. Scene edits, richer forms and YAML saves in the undo history are BL-95.
- **Run**: dry-run with live preview of the headless browser (screencast), capture with progress. The scenario screen
  (L4.2) already starts a dry run or a capture of its scenario and cancels it, with the run's progress in a banner;
  what needs a person (hooks to approve) stays in the terminal, said before the click with the command. The live
  preview and the run screen are L4.4. Built in L4.4 part A (runner, engine, worker): the live picture of the acting
  page (its own screencast, ≤ 960 px, ≤ 10 fps, memory only, only while watched and only on camera) served by the worker
  on a gated loopback channel; the step list from the run's own `outline` event, each persona's preflight result as
  `session` events; a dry run paused between steps and resumed (`runs.pause`; ≤ 30 min, then stopped with its
  teardown); the sessions a scenario needs
  (`auth.forScenario`); a headed sign-in from a job closing after 30 min, and stopped only as a sign-in. Part B (Studio
  server): `POST /v1/live` — one run's steps and log tailed from its `log.jsonl` (byte offsets, a reduced view with the
  site's text marked untrusted and no path) and its live picture relayed from the worker (one upstream per job, only
  while a tab wants it, a capture's only when asked); the ops `run_pause`, `scenario_sessions`, `auth_status`,
  `auth_login` (a headed window for the person only), `sign_in_cancel`; a capture with an invalid session confirmed by
  name (`sessions_ack`). Part C (Studio app): the Run screen — `#/p/<slug>/s/<name>/run` (the preflight: the sessions
  the run signs in with Sign in for each, what would stop a run, Start dry run / Start capture, the confirmation for an
  invalid session) and `…/run/<run_id>` (any run watched: the live picture on a canvas — on for a dry run, off for a
  capture unless shown —, the steps from the run's outline with live status, the preflight's result first, the log,
  Pause / Resume, Stop with its teardown and rollbacks said, the outcome); "Watch live" from the scenario screen; the
  Sessions panel on the project page. Part D: a capture paused between steps does not film the pause (the capture
  clock stands still while its recorders are off; the video goes on at the first fresh frame after the resume; the
  page keeps running meanwhile, so what moved shows as a jump there). Part E: the whole loop accepted on the fixture
  from the built `studio ui` (dry runs watched, paused and stopped, a capture shown and paused, a capture Claude
  started through MCP watched, the Sessions panel's headed Sign in and Cancel, the confirmation with an expired
  persona); the live picture measured at ≈ +15 % Chromium CPU on a capture (DESIGN §4f), so it stays off by default
  there, and a capture filmed while it was watched says so (`perf.live_preview`); the picture letterboxed in its box.
  After the lot's review: a run signs a persona in by itself only when its login steps' variables are set for the
  worker, the confirmation says which personas are checked before filming (a `check`) and which are not, a stopped
  sign-in says what stays in the persona's browser profile, and the pause's clock stops before the recorders do (not
  a frame of the pause filmed).
- **Edit/verify timeline**: segments (intro, scenes, cards, outro) with their **components switchable in one click**,
  caption / camera (zoom) / speed / marker tracks, a scrubber with a live preview (Remotion Player — no render needed),
  render queue, review report and contact sheets. Built in L4.5 part A (core, components, editor, engine; no screen
  yet): the timeline's model of a plan (segments with their component, transition and same-page joins; captions,
  steps, camera, speed, cuts with their reasons, markers, comment pins), the engine's timeline view (path-free, the
  inspector's choices with each option usable or disabled with why — a component that drops a slot the use writes, a
  single-page layout for a two-page scene —, memoised per file version), a click's write as `scenario_edit`
  `set_field` (only the edit part's allow-listed values: layouts, transitions, speeds, components, durations, the
  intro / outro switch, the caption component — verified, undoable byte for byte, L4.3's rules unchanged), and render
  jobs that keep the scenario text they were planned from (a switch made while a render waits never changes it) and
  can review themselves in the same job. Built in L4.5 part B (Studio server; no screen yet): the preview's own origin —
  a second loopback listener of the Studio that serves only the sandboxed preview frame, its bundle (the Remotion
  Player, the render's composition and every component of the workspace, each loaded only when a plan uses it, under
  an import allow-list that checks real paths) and the plan's media under one session capability (stable file URLs, a
  file read without following a link, revoked when the Studio closes); the frame runs with no access to the Studio,
  its storage or the network beyond that capability (WebRTC removed), starts muted, says when a paused frame is
  `settled`, falls back to a system font with a warning, and talks to its page over one checked channel that stops a
  flooding component. Built in L4.5 part C (the Studio's timeline screen; no switching or rendering from it yet):
  **Open timeline** (the scenario screen, the Run screen's outcome, a step's *Show in timeline*), the tracks of the
  plan (segments with their components and transitions, captions, steps, camera zooms, speed with its cuts and their
  reasons, markers, comment pins read-only), a playhead and scrubber driving the sandboxed preview (exact to the frame
  when paused, muted at first, a loading state until the frame is drawn, keys, zoom fit and in), the take's codec and
  keyframe spacing, and a message instead of the preview in a browser that cannot play the take's video. Built in
  L4.5 part D (the inspector; no rendering from the screen yet): a segment selected on the track (click, [ / ]), the
  video's and the segment's switches as radio groups (layout, caption component, speed chips and a custom speed,
  transition, card / waiting-screen / intro / outro component, durations, the intro / outro switch; the theme's default
  removes the value), an option the use cannot take shown disabled with the reason, one click writing one line through
  `scenario_edit` `set_field` (strict schema, allow-listed edit values only) with the preview updated in the same frame
  (≈ 0.1 s in Chromium), undo / redo of the exact bytes, and another writer's change handled like L4.3 (not applied,
  "Apply it to the new version", a value they changed refused as stale). Built in L4.5 part E (render, queue,
  review): **Render** on the timeline (and the scenario screen) with pinned arguments — the capture and the file's
  version shown, the theme and options of the files, the review inline after the render; a file changed since it was
  shown, or a render of the scenario already waiting or running, refuses it —, the render queue (queued and what runs
  first, the phase, percentage and time left, reviewing; Cancel of a render or review of that project), the renders
  with their review's verdict (clean / warnings / errors) and whether they show the version on screen, and a render's
  review: its findings (a finding seeks the preview when the render is of the version shown) and its contact sheets as
  images — every answer path-free, a sheet read by name without following a link, JPEG only, capped. Accepted in L4.5
  part F from the built `studio ui` in the installed Chrome on a fixture capture (capture from the screen, timeline,
  scrub and play at ≈ 30 frames / s, seeks settled in ≈ 0.1 s, a layout and the caption component switched and undone
  to the exact bytes, render and review from the timeline); the preview matches the render frame for frame but for text
  antialiasing and the capture's colours (a few levels brighter in the preview). Cut: editing extras (BL-107), preview
  fidelity — frame-exact playback through speed changes, a proxy for browsers without H.264, colours (BL-108), watching
  a finished render and other verify extras (BL-109), isolation residues — WebKit runs the frame in the tab's process
  (BL-110). After two independent reviews: a workspace component runs in the preview only once the person allowed it
  in that Studio session (by its folder's content hash; built-in components always run), the frame refuses
  `rel="prerender"` (Chrome's prerender ignores a frame's CSP and sandbox) and parses no HTML from a string (Trusted
  Types), each project has its own preview capability revoked when its last timeline page leaves, hard links are never
  served; "from this version" means the same plan and theme files, an intro / outro with its own text is never dropped
  by a switch, and the view re-plans when a theme or project file changes.
- **Frame comments**: click a frame (optionally draw a region) and write a comment. Comments are anchored to the
  render frame AND to the scenario (scene, step, segment, component) through the edit plan, stored in the workspace,
  and exposed to Claude (`comments_list`, `comment_reply`, `comment_resolve`) so it can make the change — a scenario
  change captured again (`run_capture`), then rendered; a theme or an override only rendered; resolved comments stay
  attached to the render version they were made on. Built in L4.6: the Studio's Comments screen (a render's exact frames, a
  region, the anchor chips before posting, reply / resolve / reopen written as the channel `studio`) and Claude's
  edit-only proposals on a Studio thread — a diff of the scenario file, Preview change on the timeline, Apply (undoable)
  or Apply and re-render, then Resolve with the new render.
- **Record**: record a scenario by clicking through the site; the actions become draft steps, each with robust target
  suggestions to pick from, and quick inserts (hold, wait_for, caption, mark, camera zoom) are added while recording.
  Built in L4.8 (`#/p/<slug>/record`): the worker opens L3.4's real browser window on this Mac, full size, and the
  person clicks there; the Studio is its control panel and forwards nothing to it — the live draft, up to three
  verified alternative targets per action, a draft cursor on a row (inserts go right after that row; a caption, a mark
  or a zoom — at most the theme's max_zoom — goes on the next action), Stop and keep (then the check replay of the
  recorded draft), Save as a new scenario (never over one, only the draft on screen, never a hidden character, no YAML
  alias), Discard (a neutral *discarded*); recordings Claude or the CLI started, or whose origin or files cannot be
  verified, are read-only. Accepted with a Playwright-driven window (the quote flow recorded with every
  insert and a pick, saved, dry-run, captured and rendered with the caption, zoom and marker where placed); a person's
  headed recording is MACOS-CHECKLIST 13i. Cut: BL-118; recording through the live picture: BL-25.
- **Identity and accessibility** (L4.9): a closed palette (every colour a named token, one blue accent, status colours
  always with words, nothing from a video theme), the Geist pair named first in the font stacks (the files: BL-120);
  real controls with names, 4.5:1 text, a selected state shown by more than a tint, a focus ring on every control
  (every screen's Tab order walked), a keyboard-only path through blocks, timeline and comments. Accepted in L4.9 by an
  in-repo checker on two screen tours and that keyboard-only path in Chromium at 1280 and 1440 wide, and the
  §14.4 acceptance on the fixture in the installed Chrome (projects → blocks edit → dry run watched → capture →
  timeline switch with the live preview → render and review → frame comment → a proposal applied); Safari, Firefox and
  VoiceOver by hand (MACOS-CHECKLIST 13j). DESIGN §4i.

## 13. Security

- No passwords in scenarios; use pre-authenticated profiles or the macOS keychain via references.
- Hooks are explicit files, logged, with rollback; destructive hooks require `confirm: true` in the scenario.
- Staging/localhost allow-list per project; refuse to run setup hooks against hosts not listed.
- Production and read-only environments (L1.7): the run's browsers stop mutating requests to the environment's hosts
  (or answer them with a mock), hooks that write are refused; writing to production needs `access: read-write` in
  project.yaml and `--allow-writes`. A video never shows a local URL: pages declare display URLs.
- Sandboxes (L1.8) are local only (every URL loopback), never production; their plain demo passwords are masked like
  secrets; a reset only rewrites what the sandbox owns — a snapshot drops a database only when a container of its own
  compose project, made from its folder, publishes it and no other container publishes that port (on any address),
  connecting to the published address, never to `localhost`; a compose project of the same name from another
  checkout is never touched.

## 14. Phases & acceptance

1. **Core + web runner + CLI**: run a "catalogue" scenario (against the bundled fixture product) headless at 1920×1080, produce capture.mp4 + timeline.json with an in-page cursor. Accept: cursor and clicks in sync, no hesitations, runs while the user uses the Mac.
2. **Components + editor + review**: component system (built-in library reproducing the reference look: intro,
   outro, caption, card/browser/laptop/phone layouts, dark-clock interstitial, title card, overlays), themes picking
   components, render two videos (supplier "catalogue" and buyer "quote request") from scenarios. Accept: review report
   clean; output reviewed by Claude through contact sheets; switching a component or theme re-renders without touching
   the scenario. Accepted in `docs/ACCEPTANCE-phase2.md`.
3. **MCP + authoring + skills**: a Claude session creates a project from a README, drafts a scenario from a timecoded
   script (or inspects/records the site), creates a theme from a brand or a site, creates a component through the skill,
   dry-runs, captures, renders, reviews, reads frame comments and iterates without human steps except approval.
   Accept: the whole loop over MCP on one empty workspace, scripted by the skills, with zero approvals and a clean
   review of both renders (`docs/ACCEPTANCE-phase3.md`, `packages/mcp/test/phase3-acceptance.test.ts`); the same loop
   by Claude itself in Claude Code (`docs/MACOS-CHECKLIST.md` step 12j).
4. **Studio app (web)**: projects, scenario blocks, run, edit/verify timeline with component switching and live
   preview, frame comments.
5. **macOS: Tauri desktop shell + iOS runner**.
6. **V2 — cloud marketplace, licensing / packaging** (out of scope now; the architecture must not prevent it).

Start with phase 1. The cursor overlay, click strategies, pacing defaults and the default edit (card frame, captions, intro/outro, interstitial) encode a method that was validated by hand on real product videos before this tool existed.
