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

# terminal 1 — the fixture product (supplier console on :4401, buyer shop on :4402)
pnpm fixture

# terminal 2
pnpm studio list
pnpm studio validate northfield-fixture catalogue
pnpm studio run northfield-fixture catalogue --dry --hooks run   # screenshots of every step, no recording
pnpm studio run northfield-fixture catalogue                     # capture.mp4 + timeline.json
pnpm studio run northfield-fixture quote
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
```

```yaml
# studio.yaml
projects_dir: projects     # default "projects"
templates_dir: templates   # default "templates"
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
studio schema [scenario|project|template|timeline]    # JSON Schema on stdout
studio login <project> [--env E] [--page KEY] [--url URL]
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
  entries as `setup:`). Setup-like runs keep a rollback journal under `runs/`; **hooks rollback** replays pending
  rollbacks of one run or of every run; **env reset** replays every pending journal, then runs the `reset` hooks.
  `--yes` approves destructive hooks that lack `confirm: true` (otherwise you are asked on a terminal, or they are
  refused).
- **render**, **review**, **export** (phase 2), **record**, **mcp** (phase 3) and **ui** (phase 4) are listed and
  say when they arrive.

Exit codes: `0` success, `1` validation errors or a failed/cancelled run or hook, `2` invalid command line.

## Project layout

```
projects/<slug>/
  README.md            # the product, audience, goals, tone, links, accounts by reference, do/don't
  project.yaml         # environments, capture size, template, auth profile, hooks allow-list, reset hooks
  scenarios/<name>.yaml
  hooks/               # sql / http / js / sh files used by hooks
  assets/              # files used by scenarios (drop_file, eval, music…)
  runs/<run-id>/       # generated: capture.mp4, timeline.json, run.json, frames/, screenshots/, journal
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
capture: {width: 1920, height: 1080, scale: 1, fps: 30}   # scale 2 → 4K frames from a 1080p viewport
frame: card
template: default              # a name in the workspace templates, or a path like ./theme
locale: en
allow_hosts: [api.staging.example.com]                    # extra hosts hooks may call
databases:
  main: {url: "postgres://demo@db.staging.example.com/app?password={{keychain:acme/db}}"}
vars: {customer: Northfield Roasters}
pacing: {type_cps: 12}                                    # override field-tested pacing defaults
browser: {locale: en-GB, timezone: Europe/London, color_scheme: light}
reset:                         # run by `studio env reset`
  - http: {method: POST, url: "{{admin}}/api/demo/reset"}
```

`capture` also accepts `format` (`jpeg`/`png`), `quality`, `crf` and `keep_frames`. Pacing keys:
`scene_start_still`, `move_base_ms`, `move_ms_per_px`, `move_min_ms`, `move_max_ms`, `hover_ms`, `press_ms`,
`after_click_ms`, `after_popup_ms`, `popup_timeout_ms`, `type_cps`, `scroll_duration`, `jitter`, `settle_ms`.
Run `studio schema project` for the full schema (also in `packages/core/schema/` for editor autocompletion).

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

**Scenario keys:** `video`, `title`, `intro` (`false` or `{duration}`), `outro` (`false` or
`{tagline, url, duration}`), `env`, `vars`, `setup`, `teardown`, `capture`, `frame`, `template`, `pacing`,
`music` (`{file, volume, duck}`), `scenes`.

**Scene keys:** `id`, `caption` (string or `{kicker, text}`), `page`, `open`, `steps`, `speed` (edit-time),
`still` (seconds still at the start, default 1.6), `transition` (`crossfade`, `cut`, `fade-black`), `frame`,
`irreversible`, `skip`, `note`. A scene without `page` continues on the previous scene's page; a scene without
`open` continues from the current state. An `interstitial: {text, kicker, duration, style}` entry is a "time
passes" card that takes no capture time.

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
| `scroll` | `scroll: 560` · `{to: {text: Awards}, offset: -140, duration: 2.2, in: …}` · `{by: 400}` | Animated scroll of the page or a container |
| `drag` | `drag: {from: {text: Card A}, to: {text: Done}, duration: 1.2}` | Press, eased move, release |
| `drop_file` | `drop_file: {zone: {text: Drop files}, path: assets/list.xlsx, from: right}` | File "ghost" dragged in, then a real drop (or the hidden file input) |
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

**Step modifiers** (on any step): `id` (for `--until` and references), `caption`, `speed` (edit-time),
`hold` (seconds still after the step), `mark` (named marker), `camera` (zoom hint:
`{zoom: 1.3, target: {text: Awards}, ease: slow, duration: 1.2, until: scene_end}`), `timeout` (seconds, default
15), `optional` (a failure does not abort), `irreversible` (never executed in dry runs), `note`.

**Click options:** `strategy` (`auto` · `real` · `dom` · `pointer`), `expect_popup`, `outside`, `hover_ms`,
`after_ms`, `move_ms`, `button`, `modifiers` (`[Shift]`), `offset` (`{x, y}` from the element's top-left).

### Targets

A plain string is visible text — or a CSS selector when it looks like one (`#id`, `.class`, `[attr]`,
`li.active`, `nav > a`).

| Key | Example | Matches |
|---|---|---|
| `text` | `{text: Save}` | Visible text: exact first, then case-insensitive substring |
| `contains` | `{contains: [Finca La Esperanza, "2026"]}` | Innermost element containing every string |
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
`rollback`). Common keys: `name`, `confirm`, `destructive`, `optional`. Setup stops at the first failure and rolls
back what it did; teardown hooks always run (even after a failure or Ctrl-C), then the pending setup rollbacks are
replayed, most recent first.

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
- **Everything is journaled.** Each executed hook and its rollback is recorded in `runs/<id>/hooks-journal.json`;
  `studio env reset` replays whatever is still pending.
- **Dry runs** never execute steps marked `irreversible`.

## Outputs of a run

`projects/<slug>/runs/<run-id>/` (git-ignored):

| File | Content |
|---|---|
| `capture.mp4` | H.264, constant frame rate, exactly the capture duration |
| `timeline.json` | scenes, step events (`t_start`, `t_end`, `t_click`, target box, click point, strategy, popup opened), markers, page/URL segments, cursor track, idle intervals, warnings |
| `run.json` | run record (status, options, steps done, error with screenshot + DOM snippet), updated live |
| `log.jsonl` | every progress event |
| `frames/`, `frames.jsonl` | raw screencast frames with their capture times (`capture.keep_frames`) |
| `screenshots/` | dry-run screenshots, `screenshot` steps, error screenshots and DOM snippets |
| `hooks-journal.json` | executed hooks and their rollbacks |
| `scenario.yaml` | snapshot of the scenario that ran |

`studio schema timeline` prints the timeline schema.

## Repository layout

```
packages/core         scenario parser and validator, project/template model, templating, JSON Schemas
packages/hooks        setup/teardown hooks (http, sql, shell, js), rollback journal, allow-list, secrets
packages/runner-web   headless Chromium runner: in-page kit (cursor, resolver), actions, screencast, encoder, timeline
packages/cli          the `studio` command
packages/components   component contract (phase 2)
packages/editor       edit plan contract (phase 2)
packages/review, mcp  phase 2 and 3
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
| 2 | Components, themes, editor (Remotion), review artefacts | Contracts drafted (`packages/components`, `packages/editor`) |
| 3 | MCP server, authoring (script → scenario, page inspection, recording), skills | Planned |
| 4 | Studio web app (scenario blocks, timeline, frame comments) | Planned |
| 5 | macOS desktop shell, iOS Simulator runner | Planned |
| 6 | Licensing, packaging, component marketplace | Out of scope for now |

Planning lives in the repo: `docs/ROADMAP.md` (small lots and their status), `docs/REQUIREMENTS.md` (every requirement
of the brief with its status, generated by `pnpm req` from `docs/requirements.json`) and `docs/HANDOFF.md` (where to
start in a new session).
