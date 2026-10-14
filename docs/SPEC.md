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
  skills/        # Claude skills shipped with the tool (scenario, theme, component authoring)
  projects/      # user projects (see §4)
```

- Language: TypeScript (Node 22), pnpm workspace.
- Web automation: **Playwright** for orchestration + **CDP** (`Page.startScreencast` at quality 100, or `HeadlessExperimental.beginFrame` for deterministic frames when available). `deviceScaleFactor` 1 or 2 for crisp 4K. Headless new mode → any viewport, independent of the physical screen.
- Video: ffmpeg (frames → mp4, VFR → CFR 30/60 fps), Remotion for composition (React, same stack as the existing toolkit).
- iOS: `xcrun simctl io <device> recordVideo --codec h264`, input via `idb` (Facebook) or an XCUITest driver; device frame mockups.
- Desktop shell (phase 4): **Tauri** — small, native, JS front-end, Rust only for OS glue (menus, notifications, file dialogs, keychain).
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

- `project_list`, `project_create({name, readme, environments, template})`, `project_get`, `project_update_readme`
- `template_list`, `template_create_from_brand({logo, colors, fonts})`, `template_preview`
- `component_list({kind?})`, `component_create({id, kind, description})`, `component_preview({component, theme, slots?, params?})`, `component_validate`
- `comments_list({project, scenario?, render?, status?})` (each comment with its frame still, region and scenario anchor), `comment_reply`, `comment_resolve`
- `scenario_validate({project, yaml})`, `scenario_save`, `scenario_from_script({project, script_markdown})` (helper that drafts YAML from a timecoded script table)
- `page_inspect({project, url | page, selector?})` → screenshot + list of visible interactive elements with suggested targets (for authoring against any site); `scenario_record({project, url})` (headed browser: clicks/typing recorded into a draft scenario — CLI `studio record`)
- `template_from_site({url})` → draft theme from a live site (colours, fonts, logo candidates)
- `run_dry({project, scenario, until?})` → logs + screenshots of each step
- `run_capture({project, scenario})` → run id; `run_status(run_id)`; `run_cancel`
- `render({project, scenario, run_id, overrides?})` → render id; `render_status`
- `review({render_id, fps: 1|2})` → paths + base64 thumbnails of contact sheets, key frames at markers, timeline, and an automatic report (blank/loading frames, caption vs scene mismatch, duration per scene, cursor off-screen)
- `export({render_id, formats: [mp4_1080p, mp4_4k, webm, vertical_9x16, gif_preview]})`
- `hooks_run({project, hook})`, `env_reset({project})`

All long tasks are async with status polling (agents' tool calls time out). Every tool returns file paths plus a short text summary readable by Claude.

## 9. Editor (Remotion) rules

- Inputs: capture.mp4 + timeline.json + template + scenario edit hints.
- Default edit: cut between scenes (crossfade 0.35 s), keep scenes continuous, apply per-scene/per-step `speed`, trim idle gaps longer than 1.2 s automatically (cursor static + no DOM change), speed 1× around `mark` steps.
- Camera: static by default; zooms only from explicit `camera` hints, eased over ≥ 0.8 s, never reset at a cut inside the same page.
- Frames: raw, card, browser chrome (address bar with the real URL, optional), MacBook mockup, iPhone mockup.
- Captions from scenario, intro/outro/interstitials from template; optional music bed with ducking.
- Outputs 1920×1080 by default, 4K when capture scale 2, vertical 9:16 variants by re-framing on the cursor/target bbox.

## 10. Review artefacts (for Claude)

`review/<render>/`: `sheet_1fps.jpg` (labelled timecodes), `sheet_scene_<id>.jpg`, `keyframes/<marker>.png`, `timeline.json`, `report.json` (scene durations, detected blank frames, caption overlaps, warnings). The MCP `review` tool returns these so an agent can verify before showing the user.

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
  `card: {component, slots, duration}` entries, scene `frame: <component>`, step `overlay: {component, slots, duration}`.
- Sources, in resolution order: the workspace (`components/`, created by the user or by Claude through a skill), the
  tool's built-in library, and — V2 — a cloud marketplace (manifests already carry publisher/version for it).
- Authoring: a Claude skill (`demo-studio-component`) + MCP tools (`component_list`, `component_create`,
  `component_preview`, `component_validate`) scaffold, preview with a theme and validate new components.

## 12. Studio app (web UI, then the Tauri desktop shell)

A client of the same packages (the MCP keeps working without it). Served locally by `studio ui`; the Tauri app
(phase 5, macOS) wraps the same UI.
- **Projects**: list, README editor, themes & component gallery (previews rendered with the project theme).
- **Scenario as blocks** (WYSIWYG-like, two-way with the YAML — comments and formatting preserved): scenes are cards
  (page, URL, caption, speed); steps are rows with an action icon and **badges** (click, type, navigation, scroll, zoom,
  hold, mark, caption, speed, irreversible); inline editing, drag & drop reordering; each step shows the real frame from
  the last dry-run/capture.
- **Run**: dry-run with live preview of the headless browser (screencast), capture with progress.
- **Edit/verify timeline**: segments (intro, scenes, cards, outro) with their **components switchable in one click**,
  caption / camera (zoom) / speed / marker tracks, a scrubber with a live preview (Remotion Player — no render needed),
  render queue, review report and contact sheets.
- **Frame comments**: click a frame (optionally draw a region) and write a comment. Comments are anchored to the
  render frame AND to the scenario (scene, step, segment, component) through the edit plan, stored in the workspace,
  and exposed to Claude (`comments_list`, `comment_reply`, `comment_resolve`) so it can adapt the scenario and
  re-render; resolved comments stay attached to the render version they were made on.

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
   the scenario.
3. **MCP + authoring + skills**: a Claude session creates a project from a README, drafts a scenario from a timecoded
   script (or inspects/records the site), creates a theme from a brand or a site, creates a component through the skill,
   dry-runs, captures, renders, reviews, reads frame comments and iterates without human steps except approval.
4. **Studio app (web)**: projects, scenario blocks, run, edit/verify timeline with component switching and live
   preview, frame comments.
5. **macOS: Tauri desktop shell + iOS runner**.
6. **V2 — cloud marketplace, licensing / packaging** (out of scope now; the architecture must not prevent it).

Start with phase 1. The cursor overlay, click strategies, pacing defaults and the default edit (card frame, captions, intro/outro, interstitial) encode a method that was validated by hand on real product videos before this tool existed.
