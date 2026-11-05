# Workspaces and projects

Where your material lives: the workspace, a project's files, what a run writes, and the versions of the file formats. Part of the [Retake guide](README.md).

## Your own workspace

Keep your material in a folder of your own: `retake init ~/demo-workspace` makes one (a commented `retake.yaml`,
`projects/` and a `.gitignore` naming `.retake/`; an existing workspace is left as it is, a non-empty folder without
`retake.yaml` is refused). For example:

```
~/demo-workspace/
  retake.yaml          # marks the workspace (all keys optional)
  projects/<slug>/     # one folder per product
  templates/<name>/    # your themes (copy a starter from this repository's templates/ to begin)
  components/<ns>/<name>/  # your own components (retake components create)
```

```yaml
# retake.yaml
version: 1                 # format version: optional (see File formats and versions)
projects_dir: projects     # default "projects"
templates_dir: templates   # default "templates"
components_dir: components # default "components": your own components (see Components)
ffmpeg: /opt/homebrew/bin/ffmpeg
browser: {locale: en-GB, timezone: Europe/Stockholm}   # defaults for every project (project.yaml wins)
render: {gl: auto, encoder: auto}                     # how this machine renders (below); every key optional
```

`browser.args` (here or in project.yaml) adds Chromium switches to every browser a run launches. Chromium always
runs with its OS sandbox and site isolation on: a switch that turns either off — `--no-sandbox`,
`--disable-setuid-sandbox`, `--disable-gpu-sandbox`, `--disable-namespace-sandbox`, `--disable-seccomp-filter-sandbox`,
`--no-zygote`, `--no-zygote-sandbox`, `--single-process`, `--in-process-gpu`, `--disable-site-isolation-trials`, or
`--disable-features=` naming `IsolateOrigins` or `SitePerProcess` — is a validation error at its line, however it is
spelled (`-name`, any case, a value after `=`).

### Render settings

`render:` says how this machine renders (a GPU is a property of the machine, not of the product: it is not in
`project.yaml`). Each key is optional; see [Renders on the GPU](editing.md#renders-on-the-gpu).

| Key | Values | Default |
|---|---|---|
| `gl` | `auto` (the GPU on macOS — ANGLE on Metal —, software elsewhere; software when the render browser finds no GPU), `gpu` (ANGLE always, even without a GPU: a warning), `software` (Chromium's software raster: the renders of before L5.15) | `$RETAKE_RENDER_GL`, else `auto` |
| `encoder` | `auto` (VideoToolbox with the GPU path when it works at the render's size, else libx264), `videotoolbox` (macOS only: an error elsewhere, and when it cannot encode the render), `libx264` (CRF 16) | `$RETAKE_RENDER_ENCODER`, else `auto` |
| `concurrency` | frames rendered at a time, 1–16 | `$RETAKE_RENDER_CONCURRENCY`, else 3 on the GPU path and ¾ of the CPUs (1–8) in software |

The order is the one of `ffmpeg:`: `retake render --concurrency` for its command, then `retake.yaml`, then the
variable, then the default. So **a key set in `retake.yaml` wins over its variable**: to try another value for one
command with `RETAKE_RENDER_GL=software retake render …`, leave that key out of `retake.yaml`. A variable with a value
that does not exist (`RETAKE_RENDER_GL=swangle`) makes renders fail with a message naming it; `retake doctor` shows the
settings in use and where each one comes from on its **Renders** line. The Studio, its jobs and MCP renders read the
same settings (the workspace's `retake.yaml`, and the variables of the process that started them: the jobs worker gets
the variables of the Studio, MCP server or command that started it). To pin a setting for everything that renders in a
workspace — the Studio, its worker, MCP — put it in `retake.yaml`: a variable set in one terminal only reaches what
that terminal starts (a worker already running from another client keeps its own, and the Library then renders its
previews again for it).

The CLI finds the workspace in this order: `--root <dir>` (`-C`), then `$RETAKE_ROOT`, then the nearest folder
above the current directory that contains `retake.yaml`, then the nearest one containing `projects/` or
`templates/`. So either run `retake` from inside your folder, or `export RETAKE_ROOT=~/demo-workspace`.

```sh
retake new acme-demo --name "Acme demo" --env "staging=app:https://app.staging.example.com,admin:https://admin.staging.example.com"
retake validate acme-demo
```

`retake new` writes `README.md` (a skeleton to describe the product, audience, goals, tone and accounts — by
reference, never passwords), `project.yaml`, `scenarios/`, `hooks/`, `assets/` and a `.gitignore` for generated
folders. On a terminal, `retake new <slug>` without `--env` asks instead: the environments, then whether each one
needs a sign-in and the accounts the videos are filmed as, and offers to sign each one in (see
[Signing in](environments.md#signing-in-personas-and-sessions)).

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
  review/<render-id>/  # generated by `retake review`: contact sheets, key frames, timeline.json, report.json/.md
  comments/<scenario>/ # frame comments, one c_<id>.json per thread (committed: your review; `retake comment`)
  sandbox/             # optional: sandbox.yaml of a sandbox environment, its seed/ and compose files (Sandbox mode)
  .retake/        # generated tool state: journals/<id>.json of `retake hooks run` / `retake env reset`, sandbox state,
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
reset:                         # run by `retake env reset`
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
`browser.locale` when set, else the project `locale`, else the `retake.yaml` `browser.locale` default.
Run `retake schema project` for the full schema (also in `packages/core/schema/` for editor autocompletion).

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

## Outputs of a run

`projects/<slug>/runs/<run-id>/` (git-ignored; renders go to `renders/`, reviews to `review/`, exports to `exports/`):

| File | Content |
|---|---|
| `capture.mp4` | H.264, constant frame rate, exactly the capture duration — encoded during the take (L5.7): output frame n is the screencast frame on screen at n / fps, as before; a take ends without a long encode |
| `timeline.json` | the scenario's edit info (`video`: title, intro, outro, frame, template, music), scenes (captured scenes, cards, interstitials), step events (`t_start`, `t_end`, `t_click`, target box, click point, strategy, popup opened, camera and overlay anchors) and web notification events, markers, page/URL segments, cursor track, idle intervals, `loading` (the page loads the capture held: `t_start`, `t_end` = the first frame of the painted page, page, `until` paint / load / limit / left / end, `held_frames`; per page in `tracks[]`), artefacts, warnings |
| `run.json` | run record (status, options, steps done, error with screenshot + DOM snippet — and `missing_targets` when a target was not found —, `optional_failures`, `environment`: production, the run's access, the clock — `at`, `timezone`, `freeze`), updated live; `version` (its format) and `engine`: the Retake, Node.js and Chromium versions, the OS (`darwin 25.6.0 arm64`) and the installed fonts (`files`: their number, `digest`: a hash of their names) — what tells two machines' takes of one scenario apart |
| `timeline.json` `environment` | the environment (L1.7): name, production, the run's access (`allow_writes` when `--allow-writes` made it read-write), the display URL of each page that has one (`display[]`: page, real base URL, display base — URLs elsewhere in the timeline stay real), the clock (`at`, `epoch_ms`, `timezone`, `freeze`), the writes the run's guard saw (`writes[]`: capture time, method, URL, GraphQL operation, `blocked` / `mocked` / `allowed` / `passed` / `exempt`, the rule that matched, `via`, `protected_by`) |
| `log.jsonl` | every progress event |
| `frames.jsonl` | the screencast frames' capture times (always) |
| `frames/` | the raw screencast frames, only with `capture.keep_frames: true` (L5.7: off by default — a 6-minute take kept 1.6–2.4 GB of them) |
| `run.json` `perf` | what a capture cost and how it was filmed (L5.7): `seconds`; `cpu` — CPU seconds per process group from Chromium's own process report and the system's process table: `browser` (it encodes the screencast's JPEG frames), `gpu`, `renderer`, `chromium_other`, `studio`, `encoder`, `product` (the processes listening on the environment's localhost ports), `total`, `cores` (total / seconds), `browsers` (per persona); `machine` (CPUs, load average mean / max); `gpu` (accelerated, renderer, features in software); `frame_rate_limit`; `frames` (received, mean fps, lowest fps of a cursor move, dropped, `kicked`: fresh frames asked for during a click ripple); `stalls`; `transitions` (clicks measured, the slow ones: press → stable screen over 0.8 s, slowest first, target); `encode` (codec, quality, `finish_ms` after the take, `late_frames`); `disk` (run folder MB, frames kept, free GB). `retake run` prints it on one line, MCP `run_status` too; the run warns when the disk has less than 10 GB (or 5 %) left |
| `timeline.json` `stalls`, `busy` | where the capture froze while the cursor moved or a ripple played, and the waits the screen showed after a click (skeletons, spinners, blank panels) — the edit cuts the first and shortens the second |
| `timeline.json` `cursor_effects` | what the in-page cursor showed besides its position: icon changes, presses, click ripples (L2.13; per page in `tracks[]`); `capture.cursor: hidden` when captured without the cursor (`run --raw --cursor none\|layer`) |
| `capture-<page>.mp4`, `frames-<page>/`, `frames-<page>.jsonl` | multi-page scenes: one recording per page on the same frame grid as `capture.mp4` (listed in `timeline.json` `tracks`) |
| `screenshots/` | dry-run screenshots (a capture's with `capture.step_shots`), `screenshot` steps, error screenshots and DOM snippets, `dead-click-<scene>-<step>.png` |
| `hooks-journal.json` | executed hooks and their rollbacks |
| `scenario.yaml` | snapshot of the scenario that ran (L5.5: a render re-plans the edit of today's file while its filmed part matches this snapshot; `retake render` / `plan` warn when the filmed part differs) |
| `artefacts/` | captured emails (`emails/<as>.json` + `.png`), documents (`documents/<as>.<ext>` + `<as>/page-<n>.png`) and web notifications (`notifications/<name>.json` + icon), listed in `timeline.json` `artefacts` |

**Disk** (L5.7): a capture weighs tens of MB (capture.mp4, ≈ 20 MB for a minute of the fixture), renders and reviews a
few more. `retake prune <project>` lists what `runs/`, `renders/` and `review/` hold that nothing needs any more —
failed, cancelled and interrupted takes, dry runs, older captures nothing uses, renders beyond the last 3 of each
scenario and variant (`--keep-renders N`), failed renders, the reviews of renders that go — with how much deleting it
frees; `--yes` deletes it. Always kept: the last good take of each scenario, every take a kept render or a comment
thread uses, every render a thread was made or resolved on, whatever a queued or running job names; `exports/` is
never touched. Claude has the same as the MCP tool `project_prune`: a dry run unless `dry_run: false`, and then it
asks you first in an approval form (how many items, how much, the first 20 and how many more) and deletes the items of
that approval — all of them — that can still go at that moment — nothing when you decline or the client cannot ask
([MCP: Safety](mcp.md)).

Composite steps (`select`, `pick`, `menu`, `date`, `drop_file`) keep every click in `data.clicks`:
`{role, strategy, popup_opened, point, bbox, t_click, desc, popup_ms?}` with `role` one of `trigger`, `option`,
`item`, `confirm`, `outside` (a click that closes a popover), `search` (a click into a popover's search field), `nav`
(a calendar's month button) or `day`; the event's own `t_click`, `point`, `target`, `strategy` and `popup_opened`
describe the trigger click (`data.retried` when it was clicked twice). A click that changed the page records
`data.navigation` (`{kind: document|url, url}`). A `type` step records `data.rate` and `data.clear`, a `date` step
`data.days`, `data.quick_runs` and `data.waited_close_ms`, a parked step `data.park`. DOM snippets saved next to error
screenshots are capped at 64 KB. `retake schema timeline` prints the timeline schema.

## File formats and versions

Every file Retake reads says which version of its format it is, in a top-level `version` key:

- **Optional** in the files you write — scenarios, `project.yaml`, `template.yaml`, `retake.yaml` — and in `run.json`:
  `version: 1`, or nothing (a file without it is version 1, so every file written before the key existed still
  loads). `retake new` and the runner write it; the starter templates and the fixture's files carry it.
- **Required** in `sandbox.yaml` and in the files Retake writes for itself (`timeline.json`, the hooks journals,
  render and review records, raw export manifests).
- **None** in hook files (`hooks/*.yaml`: a top-level list of hooks has no room for a key) — their hooks are checked
  like a scenario's. A component's `version` (`component.yaml`) is the component's own version, not a format.

A file of a higher version than this Retake reads (a newer Retake wrote it) is refused with one error at its
`version` key — `this project.yaml is version 2: it was made for a newer Retake (this one reads version 1) —
update Retake` — instead of a list of keys this one does not know; `render`, `plan` and `export-capture` refuse a run
whose `run.json` is newer the same way. Retake never rewrites your files: a future incompatible change raises the
format's version and keeps reading the older ones (a `retake migrate` command is in docs/BACKLOG.md).
