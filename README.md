# Demo Studio

Demo Studio turns a precise, written scenario into a professional product video. It drives a real web app in a
headless browser at any virtual resolution, draws the cursor **inside the page** (so clicks and screen reactions are
in sync by construction), records the screen through the Chrome DevTools screencast, and writes a timeline of every
step. Later phases edit that capture automatically into a finished video (themes, components, captions,
intro/outro), produce review artefacts, and expose everything to an AI agent through an MCP server.

The tool is generic: it is not tied to any product or brand. Your projects, themes, logos, scripts, hooks and browser
profiles live in **your own workspace folder**, never in this repository.

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start (bundled fixture product)](#quick-start-bundled-fixture-product)
- [Your own workspace](#your-own-workspace)
- [Command line](#command-line)
- [Project layout](#project-layout)
- [Scenario language](#scenario-language)
- [Your own media and motion](#your-own-media-and-motion)
- [Editing: the edit plan](#editing-the-edit-plan)
- [Rendering](#rendering)
- [Signing in once: pre-authenticated profiles](#signing-in-once-pre-authenticated-profiles)
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
   start/end/click times in capture time, target boxes, markers, page/URL segments, the cursor track and idle
   intervals) — the inputs of the editor.

Because the browser is headless and offscreen, a capture does not take over your screen: keep working while it runs.

## Requirements

- macOS or Linux, Node.js 22+, pnpm 10
- ffmpeg and ffprobe on `PATH` (or `ffmpeg:` in `studio.yaml`)
- Chromium for Playwright: `pnpm --filter @demo-studio/runner-web exec playwright-core install chromium`
  (or point `$DEMO_STUDIO_CHROMIUM` / `browser.executable` at a Chromium or Chrome binary)
- Optional: PostgreSQL client access for `sql` hooks

`studio doctor` checks all of this in one go (see [Command line](#command-line)).

Smooth 30 fps captures need GPU-accelerated rendering, which desktop machines provide. In containers without a GPU
the browser renders in software: pages with heavy effects (for example `backdrop-filter` blur behind dialogs) are
then captured at a lower frame rate, and the run reports it as a warning.

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
folders.

## Command line

```
studio new <slug> [--name N] [--template T] [--env name=key:url,...]
studio list [--json]                                  # projects (with scenarios) and templates
studio validate <project> [scenario|file] [--env E] [--until REF] [--json]
studio run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--json]
studio hooks run <project> <scenario>:setup|<scenario>:teardown|reset|<file.yaml> [--env E] [--yes] [--dry]
studio hooks rollback <project> [run-id] [--env E] [--dry]
studio env reset <project> [--env E] [--yes] [--dry]
studio components list [--kind K] [--json]            # workspace components, then the built-in library
studio components validate [id|dir] [--json]         # manifest, params, previews, entry compile (all when omitted)
studio components create <namespace/name> --kind K [--description D] [--name N] [--theme T] [--no-preview] [--json]
studio components preview [id|dir] [--all] [--stale] [--workspace] [--theme T] [--out DIR] [--json]   # preview.png + README
studio plan <project> <run-id|latest> [--scenario S] [--theme T] [--frame F] [--vertical|--square] [--json] [--out FILE]
studio render <project> <scenario> [--run ID|latest] [--theme T] [--frame F] [--vertical|--square] [--scale N]
              [--music FILE|--no-music] [--tutorial|--no-tutorial] [--no-intro] [--no-outro] [--out FILE] [--concurrency N]
              [--review] [--json]
studio still <project> <scenario> --frame N [--run ID|latest] [--layout F] [--theme T] [--vertical|--square] [--out FILE] [--json]
studio export <project> <render-id|file|latest> [--formats LIST|all] [--scenario S] [--out DIR] [--gif-start S]
              [--concurrency N] [--json]   # mp4_1080p, mp4_4k, webm, vertical_9x16, square_1x1, gif_preview
studio review <project> <render-id|file|latest> [--scenario S] [--fps 1|2] [--previous ID | --no-previous] [--strict]
              [--json]
studio schema [scenario|project|template|timeline]    # JSON Schema on stdout
studio login <project> [--env E] [--page KEY] [--url URL]
studio doctor [--project P] [--json]                  # check this machine, the workspace and a project
```

Global options: `-C, --root <dir>` (workspace), `-v, --verbose` (info/debug messages), `--no-color`.

- **validate** checks `project.yaml`, the project template (all assets present) and one scenario — or every scenario
  when none is given. Messages read `file:line:col severity path: message`, with "did you mean" suggestions.
- **run** prints one line per step with its duration and a summary with the output paths. `--dry` records nothing,
  saves a screenshot per step and never executes `irreversible` steps (it hovers their target and stops that scene).
  Hooks run by default for captures and are skipped for dry runs (`--hooks run` executes them, so a dry run sees the
  same prepared data). `--until scene.step` stops after that step. `--json` streams progress events (one JSON object
  per line) on stdout for tools and agents. Ctrl-C cancels cleanly: teardown still runs.
- **hooks run** runs a scenario's setup or teardown, the project's `reset` hooks, or a YAML file listing hooks (same
  entries as `setup:`). Its journal (executed hooks and their rollbacks) is kept in
  `<project>/.demo-studio/journals/<id>.json` — never in `runs/`, which only holds captures; **hooks rollback**
  replays the pending rollbacks of one journal (a run id or a journal id) or of every journal; **env reset** replays
  every pending journal (captures' and standalone ones), then runs the `reset` hooks (journaled in
  `.demo-studio/journals/` too). `--yes` approves destructive hooks that lack `confirm: true` (otherwise you are
  asked on a terminal, or they are refused).
- **doctor** checks, one line each with `OK`, `WARN` or `FAIL` and a hint: the Node.js version, Chromium (path,
  version and a real new-headless launch), ffmpeg and ffprobe, a display (only needed by `--headed` and `login`),
  the secrets store for `{{keychain:…}}` refs (macOS `security`, Linux `secret-tool`), desktop notifications
  (`osascript`, `notify-send`), the workspace root and its projects, and the fonts of every template. With
  `--project <slug>` it also checks that project's browser profile(s) (present, not in use) and sends a `HEAD`
  request (5 s timeout) to every page of every environment: an unreachable page of the default environment is a
  failure, of another environment a warning. It exits with `1` when any check fails; `--json` prints the checks.
- **components** lists, validates and scaffolds components — see [Components](#components).
- **plan** shows how a capture will be edited (segments, components, speeds, trims, zooms, captions, warnings)
  without rendering — see [Editing](#editing-the-edit-plan).
- **render** plans and renders the latest capture of a scenario (or `--run`) into `renders/<scenario>-v<N>.mp4` with a
  progress bar and a summary; **still** renders one frame of the planned video as a PNG — see
  [Rendering](#rendering).
- **review** writes contact sheets, per-scene sheets, key frames, an output-time timeline and a report of a render,
  and prints the findings of its checks — see [Reviewing a render](#reviewing-a-render).
- **export** writes delivery files of a render to `exports/<render-id>/` with a `manifest.json` — see
  [Variants, 4K, music and export](#variants-4k-music-and-export).
- **record**, **mcp** (phase 3) and **ui** (phase 4) are listed and say when they arrive.

Exit codes: `0` success, `1` validation errors or a failed/cancelled run or hook (or a failed doctor check), `2`
invalid command line.

```
$ studio doctor --project northfield-fixture        # Linux container without a desktop, fixture running
studio doctor
  OK    Node.js                     22.22.0
  OK    Chromium                    141.0.7390.37 · /opt/pw-browsers/chromium-1194/chrome-linux/chrome · new headless launch 293 ms
  OK    ffmpeg                      6.1.1-3ubuntu5 · /usr/bin/ffmpeg
  OK    ffprobe                     6.1.1-3ubuntu5 · /usr/bin/ffprobe
  WARN  Display                     none: DISPLAY / WAYLAND_DISPLAY are not set
                                    → headless captures work; --headed and studio login need a desktop session (or xvfb-run)
  WARN  Secrets                     secret-tool not found: {{keychain:service/account}} refs cannot be resolved
                                    → install libsecret-tools (secret-tool), or use {{env:VAR}} refs
  WARN  Notifications               notify-send not found: notify steps are only logged
                                    → install libnotify-bin (notify-send) for desktop notifications
  OK    Workspace                   /home/user/Video (studio.yaml) · 1 project: northfield-fixture
  OK    Template default            fonts present (4 files)
  OK    Template editorial          fonts present (4 files)
  OK    Template motion             fonts present (4 files)
  OK    Project northfield-fixture  /home/user/Video/projects/northfield-fixture
  OK    Profile                     none configured (a fresh temporary profile per run)
  OK    Host local·console          http://localhost:4401 → HTTP 200 (56 ms)
  OK    Host local·shop             http://localhost:4402 → HTTP 200 (7 ms)
✓ 0 failures, 3 warnings
```

## Project layout

```
projects/<slug>/
  README.md            # the product, audience, goals, tone, links, accounts by reference, do/don't
  project.yaml         # environments, capture size, template, auth profile, hooks allow-list, reset hooks
  scenarios/<name>.yaml
  hooks/               # sql / http / js / sh files used by hooks
  assets/              # files used by scenarios (drop_file, eval, music…)
  runs/<run-id>/       # generated: capture.mp4, timeline.json, run.json, frames/, screenshots/, journal
  renders/             # generated: <scenario>-v<N>.mp4 + .json (render records), stills/
  review/<render-id>/  # generated by `studio review`: contact sheets, key frames, timeline.json, report.json/.md
  .demo-studio/        # generated tool state: journals/<id>.json of `studio hooks run` / `studio env reset`
```

```yaml
# project.yaml
name: Acme demo
environments:                  # environment → page key → base URL ({{app}} in templates)
  staging:
    app: https://app.staging.example.com
    admin: https://admin.staging.example.com
default_env: staging
auth:                          # never passwords; global, or keyed by environment name
  profile: ~/.demo-studio/profiles/acme-staging
capture: {width: 1920, height: 1080, scale: 1, fps: 30}   # scale 2 → real 3840×2160 frames from a 1080p viewport (4K)
frame: card                    # raw | card | browser | laptop | phone | tablet (| split | pip: multi-page scenes), or a layout component id
template: default              # a name in the workspace templates, or a path like ./theme
locale: en-GB                  # browser locale (navigator.language, Accept-Language) unless browser.locale is set
allow_hosts: [api.staging.example.com]                    # extra hosts hooks may call
databases:
  main: {url: "postgres://demo@db.staging.example.com/app?password={{keychain:acme/db}}"}
vars: {customer: Northfield Roasters}
pacing: {type_cps: 12}                                    # override field-tested pacing defaults
browser: {timezone: Europe/London, color_scheme: light}  # browser.locale would override `locale`
reset:                         # run by `studio env reset`
  - http: {method: POST, url: "{{admin}}/api/demo/reset"}
mailbox: {provider: mailpit, url: "http://localhost:8025"}   # test mailbox read by wait_for_email (see below)
```

`capture` also accepts `format` (`jpeg`/`png`), `quality`, `crf` and `keep_frames`. The browser locale is
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
| `after_navigation_ms` | 1500 | Minimum time between a click that changed the page (document navigation or new URL) and the next step |
| `page_switch_ms` | 500 | Multi-page scenes: the pause when the next step acts on another page than the previous one (the eye moves), before that page's cursor glides |
| `popup_fallback_ms` | 300 | How long a click gets to show that an expected popup opened (`aria-expanded="true"` or a new popup, polled every 40 ms) before the next strategy (DOM click, then pointer sequence) is tried |
| `popup_timeout_ms` | 700 | How long the last strategy waits for the popup before the step reports it missing |
| `type_cps` | 14 | Typing speed (search fields are capped at 10) |
| `scroll_duration`, `scroll_offset` | 1.6, −140 | Scroll animation seconds; default `scroll.offset` with a target (it ends 140 px below the top) |
| `jitter`, `settle_ms` | 0.08, 3000 | Deterministic ±jitter on durations; network-idle wait after a navigation |

`popup_fallback_ms` is 300 ms because the Radix and Base UI widgets of the bundled fixture show their popup (or
`aria-expanded="true"`) 110–135 ms after the press of a real click, press time included, even under software
rendering: 300 ms never misfires on them, while a trigger that ignores real input is retried after a short stall
instead of 700 ms.

## Scenario language

```yaml
# yaml-language-server: $schema=../../../packages/core/schema/scenario.schema.json
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
`{component, params, tagline, url, duration}`), `env`, `vars`, `setup`, `teardown`, `capture`, `frame` (default for
every scene, see [frames](#components-in-scenarios)), `template`, `pacing`, `music` (`{file, volume, duck, loop}`, see
[the music bed](#music-bed)), `scenes`.

**Scene keys:** `id`, `caption` (string or `{kicker, text}`), `page`, `open`, `steps`, `speed` (edit-time),
`still` (seconds still at the start, default 1.6), `cursor` (where the cursor rests at the start, see below),
`transition` (`crossfade`, `cut`, `fade-black`), `frame` (a frame style or a layout component id), `irreversible`,
`skip`, `note`. A scene without `page` continues on the previous scene's page; a scene without `open` continues from
the current state. Two other entries take no capture time (the editor shows them between the clips around them):
`interstitial: {text, kicker, duration, component, params}` (a "time passes" card; `style` is the legacy template
style override) and `card: {component, params, slots, duration}` (a full-screen title / chapter / quote card), each
with an optional `id` (default `interstitial-<n>` / `card-<n>`, `n` = position in `scenes`). Ids are unique across
scenes, cards and interstitials.

**Scene-start cursor** (`cursor:` on a scene):

| Value | Where the cursor rests during the still |
|---|---|
| `auto` (default) | A neutral spot next to the scene's first pointer target (the element the first click, hover, select… travels to; its position after leading `scroll` steps is predicted), never covering it, inside the viewport, preferably over a non-interactive area. Without such a target: the right-centre of the screen. A scene that continues from the current state keeps the cursor where it is when it is already clear of that target |
| `keep` | Where the previous scene left it |
| `{x: 1500, y: 540}` | That viewport point (CSS px) |
| a target, e.g. `{text: New import}` | On that element, as a hover would (`{text: auto}` for an element whose text is "auto") |

The capture never shows the cursor jump: a scene that opens a page places it while the page loads (the editor cuts
that part); a scene that continues from the current state glides there, eased, during its still. The choice is
recorded as `data.cursor` of the scene's `scene_still` event.

### Actions

Every step has exactly one action; shorthand forms are shown first.

| Action | Example | What it does |
|---|---|---|
| `open` | `open: /settings` · `{url, page, wait_until}` | Navigate the current (or given) page |
| `click` | `click: Save` · `{text: Save, in: dialog}` | Cursor travels, hovers, presses; popup-aware fallbacks |
| `click` (outside) | `click: {outside: true}` | Close the open popover by clicking the dialog title or a blank area |
| `double_click` | `double_click: {text: Report.pdf}` | Double click |
| `hover` | `hover: {text: Pricing, ms: 900}` | Move onto an element and rest |
| `type` | `type: {into: {label: Email}, text: hi@example.com, cps: 12, clear: true, enter: true}` | Type character by character |
| `press` | `press: Enter` · `{key: ArrowDown, times: 3}` | Press a key (Playwright key names) |
| `select` | `select: {field: Country, option: Sweden, search: Swe}` · `{combobox: "#country", option: …}` | Native select or combobox listbox |
| `pick` | `pick: {field: Bag sizes, option: [1 kg, 5 kg], search: kg, close: outside}` | Multi-select popover, closed without Escape |
| `menu` | `menu: {row: Iceland, item: Pause, confirm: Pause}` · `{trigger: …, item: …}` | Row action menu, optional confirmation |
| `scroll` | `scroll: 560` · `{to: {text: Awards}, offset: -140, duration: 2.2, in: …}` · `{by: 400}` | Animated scroll of the page or a container (a target ends 140 px below the top by default) |
| `drag` | `drag: {from: {text: Card A}, to: {text: Done}, duration: 1.2}` | Press, eased move, release |
| `drop_file` | `drop_file: {zone: {text: Drop files}, path: assets/list.xlsx, from: right}` | The cursor fetches the file at the screen edge, a file "ghost" travels to the zone, then a real drop (or the hidden file input) |
| `wait` | `wait: 0.8` | Sleep (may be trimmed by the editor) |
| `wait_for` | `wait_for: Saved` · `{not_text, target, gone, url, network_idle, timeout}` | Wait until a condition holds |
| `hold` | `hold: 2` | Stay still; never trimmed by the editor |
| `assert` | `assert: {text: €720.00}` · `{url, title, gone, count: {target, equals}}` | Fail with a screenshot unless true |
| `screenshot` | `screenshot: proposal` · `{name, full_page: true}` | PNG in `runs/<id>/screenshots/` |
| `new_tab` | `new_tab: {target: {text: Download PDF}, as: pdf}` · `{href: /report}` | Follow a link into a new tab and keep recording |
| `switch_page` | `switch_page: previous` · `{to: admin, close_current: true}` | Change the recorded page |
| `eval` | `eval: "document.body.classList.add('demo')"` · `{file: hooks/setup.js, arg: …}` | JavaScript in the page (function body) |
| `notify` | `notify: Capture finished` · `{title, message}` | Desktop notification |
| `emit` | `emit: {name: chapter, data: {n: 2}}` | Custom event in the timeline |
| `cursor` | `cursor: hide` · `{move: {x: 1500, y: 540}, duration: 0.8}` · `{set: {x: 0, y: 0}}` | Show, hide, move or teleport the cursor |
| `wait_for_email` | `wait_for_email: {to: noa@cafe.example, subject: Confirm, timeout: 20, as: welcome}` | Wait for a new message in the project's test mailbox and capture it (artefact `email: welcome`) — see [Mails, documents and notifications](#mails-documents-and-notifications) |
| `download` | `download: {click: {text: Download quote PDF}, as: quote, timeout: 30}` | Real click, then capture the file it produces — a download, or a document opened in a new tab (fetched with the session) — as artefact `document: quote`; PDFs are rasterised page by page |
| `capture_text` | `capture_text: {target: {testid: proposal-total}, as: total, pattern: "/(€\\s?[\\d.,]+)/"}` | Read the element's visible text (a field's value) — or the part the pattern's first group selects — as artefact `capture: total` for a key-figure card; polled until the pattern matches (up to the step timeout); no cursor move — see [Tutorial overlays and story cards](#tutorial-overlays-and-story-cards) |

**Step modifiers** (on any step): `id` (for `--until` and references), `caption`, `speed` (edit-time),
`hold` (seconds still after the step), `mark` (named marker), `camera` (zoom hint:
`{zoom: 1.3, target: {text: Awards}, ease: slow, duration: 1.2, until: scene_end}`), `overlay` (an overlay component
over the clip: `{component, slots, params, duration, target}`, see below), `tutorial` (this step's tutorial overlays,
e.g. `{spotlight: false}` or `false`, see [Tutorial overlays](#tutorial-overlays-and-story-cards)), `timeout` (seconds, default 15),
`optional` (a failure does not abort), `irreversible` (never executed in dry runs), `note`. The runner measures the
`camera` and `overlay` targets at the **end** of the step — after a `scroll`, the box is where the element ended up.

**Click options:** `strategy` (`auto` · `real` · `dom` · `pointer`), `expect_popup`, `outside`, `hover_ms`,
`after_ms` (also replaces the `after_navigation_ms` minimum), `move_ms`, `button`, `modifiers` (`[Shift]`), `offset`
(`{x, y}` from the element's top-left).

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
| `text` | `{text: Save}` | Visible text: exact first, then case-insensitive substring |
| `contains` | `{contains: [Finca Quenaro, "2026"]}` | Innermost element containing every string |
| `role` + `name` | `{role: button, name: Request a quote}` | ARIA role (explicit or implicit) and accessible name |
| `label` | `{label: Delivery window}` | Form control by its label (`for`, wrapping label, `aria-labelledby`) |
| `aria` | `{aria: Notifications}` | `aria-label` |
| `placeholder` | `{placeholder: Search coffees}` | Placeholder attribute |
| `testid` | `{testid: save-button}` | `data-testid` |
| `css` | `{css: "table tr:nth-child(2) button"}` | Raw CSS selector |
| `in` | `{text: Save, in: dialog}` · `in: {row: Sweden}` · `in: {css: aside}` | Scope: `dialog`, `menu`, `listbox`, `popover`, `page`, a row, or a target |
| `nth` | `{text: Edit, nth: -1}` | Index among visible matches (negative from the end) |
| `last_visible` | `{role: listbox, last_visible: true}` | The most recently mounted visible match |
| `exact` | `{text: Save, exact: true}` | No substring fallback |

Only visible elements count (not hidden, transparent, clipped or off-page); a match is promoted to its clickable
ancestor. When a target is not found, the error lists the nearest visible texts and saves a screenshot and a DOM
snippet next to the run.

### Templating and hooks

Strings in scenarios and hooks accept `{{page}}` (an environment page base URL, e.g. `{{console}}`), `{{vars.x}}` or
`{{x}}`, `{{env:VAR}}`, `{{keychain:service/account}}` (macOS Keychain, Linux `secret-tool`), `{{run.id}}`, and in
hooks `{{hooks.<save_as>.json.id}}` (an earlier hook's response) or `{{response.json.id}}` (inside an http rollback).

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
`rollback`). A SQL or JS hook file that does not exist in the project is a validation error. Common keys: `name`, `confirm`, `destructive`, `optional`. Setup stops at the first failure and rolls
back what it did; teardown hooks always run (even after a failure or Ctrl-C), then the pending setup rollbacks are
replayed, most recent first.

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
defaults; start from a starter template (`templates/README.md`).

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
| `studio/layout-browser` | layout | macOS-style window: traffic lights, an address bar with the clip's **real URL** (changes with navigation), optional `tabs`; `width`, `chrome: auto \| light \| dark`, `controls: color \| theme` |
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
import { useCurrentFrame } from 'remotion';
import { Background, FitText, Logo, rise, stagger } from '@demo-studio/components/kit';
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
`useCurrentFrame()` only — no `Math.random()` (use `random(seed)` from remotion), `Date`, timers or network; import
only `react`, `remotion`, `@demo-studio/components/kit` and the component's own files. Props: `theme`, `slots`,
`params` (defaults applied), `unit`, `width`, `height`, `fps`, `durationInFrames`, `variant`, and per kind `screen`
(layout: the capture; interstitial: the last frame; transition: the wrapped segment), `rects` (layout: its evaluated
geometry in output px — `screen` = where the capture pixels go, `frame`, `display` = the declared screen rect when the
capture is letterboxed in it, `caption`, `brandmark`, `chrome`, `radius`; absent outside a plan — and, for captions
and overlays, the rects of the clip's layout, so they can sit over the capture), `url` (browser chrome: the page URL at
this frame), `cues` + `area` (caption: cues in segment frames, the layout's caption rect), `anchor` (overlay: the
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

`create` copies the scaffold of the kind (a tasteful, theme-driven placeholder) with your id, name and description,
validates it and renders its preview (`--no-preview` skips it; without a browser it warns and you run `studio
components preview` later). `validate` checks the manifest (strict keys with "did you mean", semver, slots and their sources,
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
s. The message is written to `runs/<id>/artefacts/emails/<as>.json` (`{from, to, cc, subject, date, text, html}`,
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
| `studio/mail-view` | card | a mail client window (toolbar, inbox column with the message selected, header with the sender's initials, date) over the rendered email, which scrolls slowly when tall (`scroll: auto \| none`, `width`, `sidebar`). Slots `email`, `from`, `address`, `subject`, `date`, `body`, `mailbox` |
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
| `spotlight` | `studio/overlay-spotlight` | dims the capture (theme night tone) except a soft rounded cut-out around the step's target, mapped through layout, camera and reframe; `steps` (= `true`): every step with a target (click, type, select, pick, menu, hover, drag, drop_file, download) over the step — a click ends it soon after the click, one overlay per run of steps whose cut-out **glides** from target to target (a click that takes the page to another URL ends the run: the next step's spotlight comes in on the new page); `clicks`: around each click only. Drawn under the caption and the other overlays |
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
| `studio/layout-split` | the two pages side by side — stacked top / bottom in vertical, narrow side by side in square (a page wider than its pane is reframed around what it acts on) — each in a rounded card with the reference shadow, or a compact browser window with the page's real URL (`chrome`, on for themes whose layout is a browser window); each page's label above it, the acting page's in the accent colour; the caption below the pair. `margin`, `gap`, `radius`, `shadow`, `chrome`, `labels`, `emphasis: auto \| none \| dim` (auto: the idle page dims a little for balanced / motion themes) |
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
  frame.
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
- **Idle trims**: the part of a `timeline.idle` gap outside those protected spans, when longer than 1.2 s
  (`idle_threshold`), is cut down to 0.4 s (0.2 s on each side of an invisible cut — nothing changes on screen).
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
| `keyframes/<marker>.png`, `keyframes/<scene>-first.png`, `-last.png`, `intro-hold.png`, `outro-hold.png` | full-size frames: every marker, the first and last fully visible frame of each scene, a held frame of the intro and the outro |
| `timeline.json` | the output-time timeline: segments (frames and seconds, components with params and slots, caption component, transition in, layout rects, source range, speed, zooms, overlays), transitions, captions, markers, step spans and the clicks of the capture placed on the output (cursor point in capture px and on screen) |
| `report.json` | the review result: render, rules, `clean`, counts, findings, segment durations, the diff and the files |
| `report.md` | the same for people: findings with timecodes, a segment table, captions, markers and clicks, changes since the previous render, files |
| `diff_<previous>.jpg` | the frames that changed visibly since the previous render, side by side (before \| now) |

Findings are `{severity: error|warning|info, code, message, at?: {frame, time, segment, scene, step}}`; a review is
**clean** when it has no error and no warning (info notes do not count). `--strict` exits with `1` when the review is
not clean; `--json` prints the result. The checks:

| Check | Codes |
|---|---|
| Durations of every segment and of the video (reference look: video 1–2 min, scenes 4–25 s) | `video-length` (info a little outside, warning beyond ±25 %), `scene-length` (info), `scene-too-short` (< 2 s: warning) |
| Scenes longer than 30 s at about 1× | `long-scene` (warning) |
| Blank, near-uniform or loading screens inside the layout's screen rect (2 fps samples, transitions excluded), at scene starts (rendered frame and capture frame), a screen still changing during the opening still (compared on the capture frames when the view moves or something is drawn over the page: an overlay such as a spotlight, a caption over the screen), waiting on an unchanging screen for 3 s or more (wait steps and the time after an action until the next step; holds are deliberate) | `blank-screen` (error from 1 s), `near-uniform-screen`, `blank-scene-start` (error), `loading-scene-start`, `long-wait`, `empty-segment` (a card that draws nothing) |
| Captions: shown on another scene, overlapping in time, too long for their area (the kit's `fitText` with the theme caption style and the theme's real font files: shrunk below 85 % of the theme size = warning, cut with "…" = error), under the brand mark, not visible in the caption area, missing | `caption-scene-mismatch`, `caption-overlap`, `caption-too-long`, `caption-truncated`, `caption-shrunk` (info), `caption-overlaps-brandmark`, `caption-not-visible`, `caption-missing` |
| Text slots longer than their component's `max_chars` (titles, kickers, taglines, callouts, captions) or required and empty | `text-slot-overflow`, `text-slot-empty` |
| Cursor at every click of the capture: off screen, hidden, outside the zoomed view (at the click and 0.4 s later), target partly outside the view (info when a reframed target larger than the view shows its leading part and the click) | `cursor-offscreen`, `cursor-hidden`, `cursor-outside-view` (error), `target-outside-view` |
| Camera: more zooms than the reference look's one very slow zoom per video, zooms faster / stronger than "very slow", clamped zooms, a zoom reset at a same-page join, camera jumps | `zoom-count` (warning), `zoom-not-slow`, `zoom-clamped` (info), `zoom-reset`, `camera-jump` |
| A transition (or fade) over a click and its ripple | `transition-on-click` (warning) |
| The render itself: failed status, duration or size different from the plan, missing components (stand-ins), plan warnings | `render-failed`, `duration-mismatch`, `size-mismatch`, `component-missing`, `plan-warning` |
| Diff with the previous render of the same scenario (auto-detected; `--previous <id>` or `--no-previous`): total and per-segment durations, component / caption / transition / layout changes, sample frames compared at the same offset inside the same segment | `diff-duration`, `diff-segment`, `diff-frames` (info) |

How it works (`@demo-studio/review`, `docs/DESIGN-phase2.md` §3): frames are decoded by ffmpeg in one pass per video
(the render, its capture for the scene starts, the previous render), streamed as raw RGB; sharp makes the thumbnails,
the sheets (labels drawn as SVG) and the key frames; the checks read the plan of the render record (segments, layout
rects, captions, step spans, camera, time map) and the run's timeline (clicks, cursor track, captions as captured).
The duration rule is a style target measured on two reference videos, not a defect: a video a few seconds outside 1–2
minutes is an info note, a warning only beyond ±25 % (45 s – 150 s). Thresholds are `rules` of the API
(`DEFAULT_RULES`).

API: `reviewRender({project, render, scenario?, fps?: 1|2, previous?: id|false, thumbnails?: false|'sheets'|'all',
thumbnail_px?, rules?, out?})` → `ReviewResult` (the report plus `thumbnails`: JPEGs ≤ 1280 px as base64 for the MCP
— the contact sheet pages and the marker key frames by default, every sheet and key frame with `'all'`). A review of a
one-minute 1080p render takes ≈ 10 s.

## Signing in once: pre-authenticated profiles

Scenarios never contain passwords. Give the project a persistent browser profile and sign in by hand once:

```yaml
# project.yaml
auth:
  staging: {profile: ~/.demo-studio/profiles/acme-staging}   # or one global {profile: …}
```

```sh
studio login acme-demo --env staging     # opens a visible browser on that profile; sign in, then close the window
studio run acme-demo onboarding          # later runs reuse the signed-in profile, headless
```

A profile can be used by one browser at a time: close the login window before running. `auth.storage_state`
(a Playwright storage-state JSON with cookies and local storage) is an alternative to a profile.

## Security

- **No secrets in files.** Use `{{env:VAR}}` or `{{keychain:service/account}}` references; validation flags database
  URLs with a clear-text password. Resolved secret values are redacted from logs, results and journals.
- **Allow-list.** `http` and `sql` hooks only reach the hosts of the project's environments, `allow_hosts` and
  localhost; redirects are checked hop by hop and credentials are dropped when the origin changes.
- **Destructive hooks need `confirm: true`.** SQL `DELETE`/`DROP`/`TRUNCATE`/`ALTER`/`UPDATE` (inline, in files or
  sent to `psql`), HTTP `DELETE`, shell `rm`/`dropdb`, and hooks declared `destructive: true` are flagged by
  validation and refused at run time without it (`studio hooks run --yes` approves explicitly).
- **Everything is journaled.** Each executed hook and its rollback is recorded in `runs/<id>/hooks-journal.json`
  (captures) or `.demo-studio/journals/<id>.json` (`studio hooks run`, `studio env reset`); `studio env reset`
  replays whatever is still pending in both.
- **Dry runs** never execute steps marked `irreversible`.

## Outputs of a run

`projects/<slug>/runs/<run-id>/` (git-ignored; renders go to `renders/`, reviews to `review/`, exports to `exports/`):

| File | Content |
|---|---|
| `capture.mp4` | H.264, constant frame rate, exactly the capture duration |
| `timeline.json` | the scenario's edit info (`video`: title, intro, outro, frame, template, music), scenes (captured scenes, cards, interstitials), step events (`t_start`, `t_end`, `t_click`, target box, click point, strategy, popup opened, camera and overlay anchors) and web notification events, markers, page/URL segments, cursor track, idle intervals, artefacts, warnings |
| `run.json` | run record (status, options, steps done, error with screenshot + DOM snippet), updated live |
| `log.jsonl` | every progress event |
| `frames/`, `frames.jsonl` | raw screencast frames with their capture times (`capture.keep_frames`) |
| `capture-<page>.mp4`, `frames-<page>/`, `frames-<page>.jsonl` | multi-page scenes: one recording per page on the same frame grid as `capture.mp4` (listed in `timeline.json` `tracks`) |
| `screenshots/` | dry-run screenshots, `screenshot` steps, error screenshots and DOM snippets |
| `hooks-journal.json` | executed hooks and their rollbacks |
| `scenario.yaml` | snapshot of the scenario that ran |
| `artefacts/` | captured emails (`emails/<as>.json` + `.png`), documents (`documents/<as>.<ext>` + `<as>/page-<n>.png`) and web notifications (`notifications/<name>.json` + icon), listed in `timeline.json` `artefacts` |

Composite steps (`select`, `pick`, `menu`, `drop_file`) keep every click in `data.clicks`:
`{role, strategy, popup_opened, point, bbox, t_click, desc, popup_ms?}` with `role` one of `trigger`, `option`,
`item`, `confirm`, `outside` (a click that closes a popover) or `search` (a click into a popover's search field); the
event's own `t_click`, `point`, `target`, `strategy` and `popup_opened` describe the trigger click. A click that
changed the page records `data.navigation` (`{kind: document|url, url}`). DOM snippets saved next to error
screenshots are capped at 64 KB. `studio schema timeline` prints the timeline schema.

## Repository layout

```
packages/core         scenario parser and validator, project/template model, templating, JSON Schemas
packages/hooks        setup/teardown hooks (http, sql, shell, js), rollback journal, allow-list, secrets
packages/runner-web   headless Chromium runner: in-page kit (cursor, resolver), actions, screencast, encoder, timeline
packages/cli          the `studio` command
packages/components   components: manifest schema, registry, validation, scaffolds, theme tokens, kit (L2.2)
packages/editor       edit planner (planEdit → EditPlan, reframing), the Remotion compositions (src/remotion) and the
                      render pipeline (bundle cache, asset server, renderVideo / renderStill / listRenders, exportRender)
packages/review       review of a render: contact sheets, key frames, output-time timeline, checks, report, diff
packages/mcp          phase 3
fixtures/wholesale    the fictional "Northfield" product used for end-to-end tests
projects/             the fixture project (your projects live in your workspace)
templates/            starter themes: default, editorial, motion
docs/                 SPEC.md (product brief), DESIGN.md and DESIGN-phase2.md (package contracts)
```

Development: `pnpm build` (TypeScript project references), `pnpm test` (vitest; the end-to-end tests start the
fixture on free ports and skip themselves when Chromium or ffmpeg is missing). Set `DEMO_STUDIO_TEST_PG` to a
PostgreSQL URL to include the SQL hook tests.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core, hooks, web runner, CLI, fixture product, starter templates | **Done** — the `catalogue` and `quote` fixture scenarios capture headless at 1920×1080 |
| 2 | Components, themes, editor (Remotion), review artefacts | Contracts in core (L2.1), the components package (L2.2: manifests, registry, validation, scaffolds, kit, `studio components`), the edit planner (L2.3: `planEdit`, `studio plan`), the render pipeline (L2.4: placeholder library, `DemoVideo`, `studio render` / `still`), the reference-look components (L2.5: intro, outro, card layout with geometry following params, captions, clock interstitial, crossfade — measured on renders), the review (L2.6: `studio review`, contact sheets, key frames, checks, report, diff) and the full library with previews (L2.7: browser / laptop / phone / tablet / raw layouts, overlay caption, cards, minimal intro/outro, plain interstitial, callout, lower third, fade-black; committed previews, `studio components preview`) and variants & export (L2.8: vertical and square reframed on the cursor and the targets, real 4K captures, music bed, theme default zoom, `studio export`) and mails, notifications & documents (L2.9: `mailbox`, `wait_for_email`, `download` with PDFs rasterised by pdf.js, web notifications captured, artefacts in components, notification / mail / document / phone cards, tap-open transition), tutorial overlays & story cards (L2.10: key caps, spotlight, step badges, loupe, progress bar, figure / features / before-after / testimonial / CTA / chart cards) and several pages at once (L2.11: multi-page scenes filmed on one clock, `studio/layout-split`, `studio/layout-pip`, per-pane camera and overlays) and your own media & motion (L2.12: video / image / Lottie segments, alpha overlay videos, Lottie overlays, `studio/media`, `studio/lottie`, [docs/BRING-YOUR-OWN-MOTION.md](docs/BRING-YOUR-OWN-MOTION.md); waits shown as short loading states) done; L2.13 next |
| 3 | MCP server, authoring (script → scenario, page inspection, recording), skills | Planned |
| 4 | Studio web app (scenario blocks, timeline, frame comments) | Planned |
| 5 | macOS desktop shell, iOS Simulator runner | Planned |
| 6 | Licensing, packaging, component marketplace | Out of scope for now |

Planning lives in the repo: `docs/ROADMAP.md` (small lots and their status), `docs/REQUIREMENTS.md` (every requirement
of the brief with its status, generated by `pnpm req` from `docs/requirements.json`) and `docs/HANDOFF.md` (where to
start in a new session).
