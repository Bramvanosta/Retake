# Editing, rendering and export

From a capture to a video: the edit plan, tutorial overlays and story cards, rendering, variants and export, and the raw export for editing tools. Part of the [Retake guide](README.md).

## Editing: the edit plan

The editor turns a run (`capture.mp4` + `timeline.json`) into a video in two steps: `planEdit` (package
`@retake/editor`) computes an **EditPlan** — a pure, deterministic description of every output frame — and the
render pipeline (L2.4) only draws that plan with Remotion. The plan is also what the review, the Studio timeline and
frame comments read. It never re-reads the scenario: the timeline carries the edit info (`video`, scene captions,
speeds, step `camera` / `overlay` / `mark` / `hold`).

What the planner decides (SPEC §9, `docs/DESIGN-phase2.md` §2.1):

- **Segments**: intro (unless the scenario says `intro: false`) → scenes, cards and interstitials in scenario order →
  outro. Every segment carries its component, chosen by precedence: `overrides.components[<segment id>]` →
  `overrides.components[<kind>]` → the scenario → the theme → the built-in default, with its slots filled (scenario
  title and outro, theme brand and logo, scene captions, interstitial text, card slots). A component that does not
  resolve is reported and the next candidate is used; when none resolves the use is marked `missing` and the
  renderer draws a stand-in. A clip's caption resolves by kind: `overrides.components.caption` → the scenario's
  `caption_component` → the theme → the built-in default.
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
kind or segment id), `theme` (the caller loads that theme) and `music` (a file, or `false`). `variant` is
`landscape`, `vertical` or `square`.

`retake plan` prints the plan of a run (`latest` = the newest capture run, of `--scenario` when given) and writes its
JSON with `--out` (or prints it with `--json`); `--theme`, `--frame`, `--vertical` and `--square` try another theme,
frame or the 9:16 / 1:1 variant:

```
$ retake plan northfield-fixture latest --scenario catalogue
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

## Rendering

`retake render <project> <scenario>` plans the latest capture of a scenario (or `--run <id|dir|latest>`) and renders
the plan with [Remotion](https://www.remotion.dev):

```
$ retake render northfield-fixture catalogue
✓ rendered catalogue-v1 → projects/northfield-fixture/renders/catalogue-v1.mp4
  59.00 s · 1770 frames @ 30 fps · 1920×1080 · 23.6 MB · h264 VideoToolbox 8M, silent audio · checked: 59.01 s, 1920×1080, 1 audio track
  theme editorial · run 20261011-182524-catalogue · bundle built in 9.9 s · render 57.4 s (concurrency 3) on the GPU · total 1 m 8 s
  record projects/northfield-fixture/renders/catalogue-v1.json
```

- **Outputs**: `renders/<scenario>-v<N>.mp4` (`-v<N>-vertical.mp4` / `-v<N>-square.mp4` for `--vertical` /
  `--square`) and its **RenderRecord**
  `renders/<scenario>-v<N>.json`: id, project, scenario, run id and directory, theme, overrides, variant, status,
  duration, frames, fps, size, file size, encoding, the render policy (`policy`: below), what ffprobe saw in the file,
  bundle hash, browser, timings, warnings and the whole plan. N is the next free version of the scenario (both variants share the counter); `--out`
  writes elsewhere. The video is encoded under a temporary name and renamed when complete: a failed or cancelled
  render (Ctrl-C, or an `AbortSignal` through the API) leaves nothing under the final names.
- **Encoding**: H.264, `yuv420p` limited-range BT.709 (tagged), `+faststart` (moov first), and always an audio track:
  AAC silence when there is no music (checked with ffprobe after the render, added with ffmpeg if ever missing). On a
  Mac with a GPU the video is encoded by the Mac's hardware encoder (VideoToolbox, 0.13 bit per pixel per frame: 8 Mb/s
  at 1080p30, a key frame every 2 s); elsewhere, and as the fallback, libx264 CRF 16 — see
  [Renders on the GPU](#renders-on-the-gpu).
- **Options**: `--theme` (another theme, the scenario untouched), `--frame` (frame style or layout component id for
  every scene), `--vertical` (1080×1920) or `--square` (1080×1080), `--scale` (output size × the variant's size),
  `--music <file>` / `--no-music` (replace or drop the scenario's music bed), `--tutorial` / `--no-tutorial` (every
  tutorial overlay on over the scenario's switches, or none), `--no-intro`, `--no-outro`,
  `--concurrency` (frames rendered in parallel, 1–16; default 3 on the GPU path, ¾ of the CPUs (1–8) in software, or
  `render.concurrency`), `--json` (the record without the plan).
- **Stills**: `retake still <project> <scenario> --frame <n>` renders output frame n of the planned video as a PNG
  (default `renders/stills/<scenario>-f<n>.png`) — the quick way to look at one moment of an edit.
- **Review**: `--review` reviews the render right after it (see [Reviewing a render](review.md#reviewing-a-render)); with
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
  captured, its edit included, and `retake render` and `retake plan` warn first (`! the filmed part of scenario quote
  changed since run … was captured (scene send: step send.2 changed; the setup hooks): …`, naming the `retake run`
  that films it); through MCP, `plan_preview` and `render` say the same with `scenario_changed: true` and
  `filmed_changes`, and `plan_preview`'s last line then says to capture first (never "render it" on the old run); an
  edit-only change says `edit: "scenario"` with `edit_changes`. The files are compared by their data: a comment, blank
  lines, quoting, indentation or key order is no change; a link, a non-regular file or one over 2 MB is not compared;
  a run without its snapshot, or a file that does not validate, renders as captured. A render records where its edit
  came from (`edit` in `renders/<id>.json`). A render job (MCP `render`, the Studio) keeps the scenario text its edit
  was planned from in its job folder (`.retake/jobs/<job>/edit.yaml`, L4.5): it renders that version even when
  the file changes while it waits in the queue (keep editing after Render); an export that re-renders a master still
  refuses a scenario file changed since it was planned (submit again). Project-level changes (project.yaml environments
  or vars) are not compared.

How it works (`@retake/editor`, `docs/DESIGN-phase2.md` §2.2):

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
- **Bundle cache**: `<workspace>/.retake/cache/remotion-<hash>/` (git-ignored), the hash covering the composition
  sources, the kit, every bundled component folder and the Remotion version; a render rebuilds the bundle (≈ 10 s)
  only when one of them changed, and the six most recently used bundles are kept.
- **Assets**: the capture, fonts, logo, wordmark and music (`ds-asset:` URLs in the plan) are served by a local HTTP
  server on 127.0.0.1 (random port, random path token, Range requests, CORS) for the duration of the render.
- **Browser**: `$RETAKE_CHROMIUM_HEADLESS_SHELL`, else Playwright's Chromium headless shell (found through
  playwright-core's browser registry: `playwright-core install chromium-headless-shell`; the app bundle's own when
  Retake runs from it), else none: the render refuses to start and says how to install one (Remotion never downloads a
  browser of its own; an app bundle without its headless shell: reinstall it). A job of the worker (the Studio, the
  desktop app, an MCP client) refuses a render browser inside the workspace (see [Workspace](workspace.md)).
- **API**: `renderVideo({project, run, scenario?, template?, overrides?, out?, onProgress?, signal?, concurrency?,
  settings?})` → `RenderRecord` (progress stages `planning`, `bundling`, `rendering`, `retrying` — the GPU path failed
  and the video renders again in software, progress does not go back —, `encoding`, `done`; `settings`: the
  `render:` keys below, over the workspace's); `renderStill({plan,
  frame, out})` → the PNG path; `renderStills({plan, frames: [{frame, out}…]})` renders several frames in one
  browser session (≈ 0.3–0.6 s per extra frame); `listRenders(project)` → the records of `renders/`;
  `renderPlan({plan, out})` renders any plan.

Render times on the 4-CPU Linux container (no GPU, concurrency 3): ≈ 3–3.5 minutes for a 1-minute 1080p video
(≈ 8–9 output frames per second); a still takes 1–2 s once the bundle is cached. On an M4 Mac (10 cores) a 1-minute
1080p video renders in about a minute either way — on the GPU path with about 40 % of the CPU time of the software
path and a peak of about 4 cores instead of 9 (DESIGN §4r has the measurements).

### Renders on the GPU

Since L5.15 a render on a Mac with a GPU draws its frames with the GPU (Chromium's ANGLE on Metal) and encodes them
with the Mac's hardware encoder (VideoToolbox), 3 frames at a time: as fast as before, with much less CPU — what a
take filming beside it needs. Elsewhere (Linux, a container, a Mac without a GPU) renders run as they always did:
Chromium's software raster, libx264 CRF 16, ¾ of the CPUs.

- **When the GPU is used**: the render browser opens with ANGLE and says what it draws with (Chrome's own GPU report).
  No GPU there (a virtual machine, a remote session) → it is opened again in software, said once ("no GPU for this
  render: rendered in software"), at the software path's frames at a time (¾ of the CPUs, unless `concurrency` is set)
  — what `retake doctor` says. VideoToolbox is chosen before the render: only up to 4096 pixels a side (a `--scale 3`
  render, 5760×3240, is encoded with libx264, said in the warnings), and only when a 3-frame test encode with the
  ffmpeg that will encode passes.
- **One fallback**: when the GPU path itself fails mid-render (the GPU process, the GL context, the hardware encoder),
  the video is rendered once more from the start in software with libx264 — nothing half-written is kept, the progress
  says `retrying` and never goes back, Ctrl-C still cancels. Anything else (a timeout, memory, a full disk, an error of
  the plan) fails as before; a render that fails in software too says both ("render failed in software, after the GPU
  path failed (…)") and its record keeps the GPU path's story. Stills and component previews use the same GPU check
  but no fallback: a failure is said.
- **A render of the Studio, a job or MCP** (guarded: it loads only the files of its plan) runs in the one browser it
  opened, reported and guarded: when a page of it fails, the render fails ("a page of the render failed") — on the GPU
  path after the one software retry above — and never continues in a browser opened behind the guard's back.
- **The record says what happened** (`policy`): the GL asked and where it was set, what it resolved to here, what
  actually drew the video (read again at the end: Chrome can leave the GPU by itself) with the GPU's name, the encoder
  asked and used, and `fallback: {reason}` when the software path rendered it (the reason quotes the error seen — words
  a component can write —, so `render_status` gives it under `untrusted.fallback_reason` only); `encoding` names the
  encoder, its CRF or bitrate and key-frame interval. `retake render` says it on its summary ("h264 VideoToolbox 8M",
  "on the GPU", "in software after a GPU failure") and `retake doctor`'s **Renders** line says what a 1080p render would
  get here.
- **Which ffmpeg encodes the frames** (L7.3, macOS). On the GPU path: the ffmpeg of this machine (`ffmpeg:` in
  `retake.yaml`, `$RETAKE_FFMPEG`, the PATH) when it is 5.1 or later, has the `colorspace` filter and the encoder
  chosen, and runs the frame encode on three test frames first. On the software path, on Linux and inside the desktop
  app: the rendering library's own, as before — `render: {ffmpeg: own}` asks for this machine's there too (in the
  desktop app it is not verified). The library's ffmpeg always does the audio and writes the final file, and encodes
  the frames whenever ours does not qualify (the record says why). What was measured, on one Mac (Apple M4, ffmpeg
  9.0.2) under load, on one fixture render of a minute at 1080p, in two independent sets of runs: on the GPU path
  about a fifth less CPU and **no measured gain in render time**; on the software path 10–13 % less CPU, under
  the threshold set for a default — hence not the default there; files 1.5 % (GPU) to 2 % (software) larger. The
  picture is the same to the eye and not to the byte: the colour conversion is rounded differently — on that render
  the worst frame's SSIM against the library's encode is 0.9969 (GPU) and 0.9954 (software), above the 0.995
  asked, with little margin in software; streams, colour tags, frame count and audio are identical. A render that
  fails on the GPU path is rendered once more in software (the single fallback above) and follows the rule of that
  path: under `auto` the library's ffmpeg encodes it. When the failure is our ffmpeg's at the encode — or the
  hardware encoder's while ours ran it, which cannot be told apart — the second attempt takes the library's whatever
  the setting, the warnings say so, the record keeps the failure's words as `policy.ffmpeg.failed` (`render_status`:
  under `untrusted.ffmpeg_failed` only), and that ffmpeg is not taken again until the process ends. The record's
  `policy.ffmpeg` says what was asked and which ffmpeg encoded (`used: own | library`, its `version`, and a `note`
  — one of Retake's own sentences — whenever the library's encoded although the setting is not `library`).
  `render: {ffmpeg: library}` gives back the encode of before everywhere.
- **The settings** (`render:` in `retake.yaml`, or the variables; see [Workspace](workspace.md#render-settings)):
  `gl: auto | gpu | software`, `encoder: auto | videotoolbox | libx264`, `concurrency: 1–16`,
  `ffmpeg: auto | own | library`. `render: {gl: software, encoder: libx264, ffmpeg: library}` gives back the renders
  of before L5.15 exactly.
- **What changes in the files**: GPU renders are not byte-identical run to run (the GPU's antialiasing and the hardware
  encoder vary slightly: SSIM ≥ 0.995 on every frame between two renders) and are about twice as large (≈ 24 MB per
  minute of 1080p instead of ≈ 10 MB). Software renders stay reproducible frame for frame, and — the library's ffmpeg
  being what encodes them unless `ffmpeg: own` is set — byte for byte what they were (with `own`, a software render is
  byte-identical run to run on one ffmpeg, and differs from one encoded by the library's).

### Captures first: a take never waits for a render

A take films in real time, so it gets the machine first; renders, reviews, exports, previews and site extractions are
background work that can wait. On your Mac, for your user (every workspace, the Studio, Claude and the terminal alike):

- **A take never waits behind a render.** In a workspace the worker runs one take (or hooks, a sign-in, a recording)
  and, beside it, one render, review, export or preview in a process of its own.
- **Heavy work that has not started waits while a take films** — from the first filmed frame to the end of the scenes,
  not during the setup or teardown hooks, not while the take is paused. A render that is already running is **slowed**
  (macOS background priority) while the take films, and goes back to full speed after it; its frames are the same.
- **It is said everywhere**: "waiting for a take to finish (in this workspace / elsewhere on this Mac)" and "slowed
  during a take" in the Studio (the render's row and the status bar), through MCP and in `retake jobs`; `retake doctor`
  has a "Captures first" line (the takes filming now, the markers' folder, whether background priority is available).
  A take's report says whether another take filmed beside it and whether heavy work of its workspace's worker (a
  render, review or export) was slowed during it — a terminal `retake render`, which has no job, and the work of another
  workspace are not counted there.
- **In a terminal**, `retake render`, `still`, `export`, `review`, `export-capture` and `run --raw`'s export wait to
  start while a take films (one line on stderr; Ctrl-C quits with nothing written), then run at background priority
  during a later take. `--no-wait` starts at once and never slows down. `retake run` (not `--dry`) counts as a take.
- **A cap**: a take holds heavy work for at most `RETAKE_CAPTURE_HOLD_MAX_MIN` minutes (default 60) — then the work
  goes on, and that is said too. Linux and Windows only wait (no background priority).
- An update of the app waits for running jobs, a render held by a take included.

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
every click target and the cursor stay in view (tests on the real timelines). `retake review` checks it on the render:
`target-cut` (error), `cursor-outside-view` at clicks (error), `cursor-outside-reframe` and `reframe-jump` (warnings).

**4K**: a capture at `capture.scale: 2` is recorded at real device pixels (the runner launches headless Chromium with
`--force-device-scale-factor=2`: without it the screencast stays at CSS size whatever `deviceScaleFactor` says) and
renders to 3840×2160 by default, every component drawn at unit 2. `--scale 2` on a 1080p capture renders 4K too —
everything crisp except the capture, upscaled (a plan warning says so). Capturing 8 MP frames is heavy without a GPU:
on the 4-CPU Linux container the screencast delivers ≈ 9–16 fps at 4K against ≈ 45–58 fps at 1080p (2–3 fps under a
backdrop-blur dialog), so motion is choppy there; a Mac with a GPU is the place for 4K captures (L1.3 / L1.5).

### Music bed

A scenario `music: {file, volume, duck, loop}` (or `retake render --music <file>`) adds a bed under the video: at
`volume` (default 0.6) on the intro, the outro, cards and interstitials, × `duck` (default 0.5, −6 dB) while product
footage is on screen (eased over 0.5 s at each clip edge), faded in over 1 s and out over the last 2 s. The render
measures the track (ffprobe) so the planner can lay it out: a longer track is trimmed to the video; a shorter one
loops with 1 s equal-power crossfades at the seams (`loop: false`: it plays once). Tests and demos use a procedural
royalty-free track — `generateTestTrack(out, {seconds})` in `@retake/editor` (ffmpeg sine chords C–Am–F–G, no
audio file in the repository).

### Export

`retake export <project> <render|latest> --formats …` (API `exportRender({project, render, formats})`) writes delivery
files to `exports/<render-id>/` with a `manifest.json` (per file: format, method, size, duration, fps, codecs, audio
streams, time taken, the GIF window, warnings — for a re-rendered format, the render's warnings about files
upscaled, missing or blocked and about how it was drawn and encoded (no GPU, VideoToolbox's size limit, the GPU path
failing); earlier exports of other formats into the folder are kept):

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

Script and film with Retake, then edit in Final Cut Pro, Premiere Pro, DaVinci Resolve, After Effects or any
OpenTimelineIO tool: `retake export-capture <project> <run|latest>` (API `exportCapture({project, runDir, …})` in
`@retake/runner-web`) turns a capture into a package that drops into those tools; `retake run <project>
<scenario> --raw` captures and exports in one go.

```
retake export-capture northfield-fixture latest --scenario quote                       # MP4 30 fps, cursor as captured
retake export-capture northfield-fixture latest --scenario quote --format prores --fps 60 --cursor layer --selects
retake run northfield-fixture quote --raw --cursor none                                # captured without the cursor
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
  (`retake run … --raw --cursor none|layer`, or `raw.cursor` in project.yaml): the pointer still drives real input and
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
  files and counts, the files the Retake edit of this scenario uses — intro / outro videos, overlays, images — for
  reuse, notes and warnings) and a short `README.md` for people.

Package: `<project>/exports/<run-id>-raw-<format><fps>-<cursor>/` (or `--out`). The interchange files point at the
clips by absolute path (`file://` URLs in the FCPXML and OTIO): if you move the folder, relink to `clips/`.
`retake run … --raw --json` prints the RunProgress events, then one `{"type":"raw_export","dir":…,"manifest":…}` line.
project.yaml can hold the defaults:

```yaml
raw: {format: prores, fps: 60, cursor: layer, layer: prores, selects: true, cuts: true}
```

A run captured without its cursor still renders with `retake render`, with a plan warning: the video shows no cursor.

**Checking a package** (optional): `scripts/validate-raw.py <package> [...]` checks every clip and layer with ffprobe
against the manifest, the FCPXML (well-formed, frame grid, spine, timecodes, markers), reads the OTIO and the EDL back
with OpenTimelineIO and compares the marker lists. It needs Python 3 and, for the read-back, OpenTimelineIO with its
EDL / FCPXML adapters — not a dependency of this repository. Use Python 3.13 or older (OpenTimelineIO 0.18.1 fails to
load on 3.14 with `RuntimeError: bad any cast`):

```sh
python3.13 -m venv ~/.venvs/otio && ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter
~/.venvs/otio/bin/python scripts/validate-raw.py projects/northfield-fixture/exports/<run>-raw-mp430-baked
```
