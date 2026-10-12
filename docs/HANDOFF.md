# Handoff — read this first in a new session

Last updated: 2026-10-12, end of lot L2.10. Working branch: `claude/new-session-pq6jtq`.

## What this is
Demo Studio: a generic, product-agnostic tool (licence-ready in a V2) that turns a written scenario into a
professional product video — drive a real web app headless with an in-page cursor, capture it cleanly, then edit it
automatically with themeable components, and let Claude operate everything through an MCP server.

## Read in this order
1. `docs/SPEC.md` — the brief, especially §0 (product principles), §11 (components), §12 (Studio app), §14 (phases).
2. `docs/ROADMAP.md` — lots, sizes, status, working agreement. **Work one lot at a time; the user decides how many.**
3. The lot's requirements: `node scripts/requirements.mjs --lot <id>` (source of truth: `docs/requirements.json`).
4. Contracts: `docs/DESIGN.md` (phase 1 packages), `docs/DESIGN-phase2.md` (components, editor, review, comments),
   `packages/core/src/types.ts`, `packages/components/src/types.ts`, `packages/editor/src/plan-types.ts`.
5. References: `docs/reference/look.md` (measured target look), `docs/reference/choreography.md` (field-tested
   cursor/click/typing rules), `docs/design-brief.md` + the mock-up canvas (Studio screens 1–7 and video frames in two
   themes): https://claude.ai/artifact/CEa9o9do5hr9AcLBajLRye (private to the owner).
6. `README.md` — usage, scenario language reference, CLI.

## State
- **Phase 1 done** (commit `0df4a29`): core (scenario language, strict schemas, positioned errors), runner-web
  (headless capture, in-page cursor on real input, click strategies, widgets, screencast → CFR mp4, timeline.json),
  hooks (http/sql/shell/js + rollback journal + allow-list), CLI (`studio …`), fixture product
  `fixtures/wholesale` ("Northfield", fictional, real Radix + Base UI), project `projects/northfield-fixture`,
  starter templates `default`, `editorial`, `motion`. 275 tests pass (6 Postgres tests need `DEMO_STUDIO_TEST_PG`).
- **L1.1 done** (phase-1 polish + `studio doctor`): invented fixture names (test-guarded), ripple ring visible on
  same-colour buttons, field-notes ripple/motion curves, scene `cursor` key (auto rest point next to the first
  target, no visible jump), every widget click in `data.clicks`, standalone hook journals in
  `<project>/.demo-studio/journals/`, pacing `nudge_*`, `after_navigation_ms`, `popup_fallback_ms`, `scroll_offset`,
  64 KB DOM snippets, project `locale` → browser locale, missing hook files are errors, `studio doctor`,
  `docs/MACOS-CHECKLIST.md` (the steps of L1.5). 301 tests pass (6 Postgres tests skipped).
- **L2.1 done** (phase-2 contracts in core): `ComponentKind`, `COMPONENT_KINDS`, `ComponentRef`, `ComponentId`,
  `COMPONENT_ID_RE` and `FrameSpec` live in `packages/core` (`@demo-studio/components` re-exports the first three);
  template `brand` + `components` (id or `{id, params}`, `null` = none) with `resolveThemeComponents()` (legacy field
  mapping, `source: theme|legacy|default`) and a validation warning when an entry contradicts a legacy field; scenario
  `intro`/`outro`/`interstitial` take `component` + `params`, new `card:` entries (no capture time, `card-<n>` default
  id), `frame` = FrameStyle or layout id on project/scenario/scene, step `overlay` (≤ 30 s); the runner records card
  scenes, `event.overlay` with the anchor measured at the END of the step (camera too) and `timeline.video` (title,
  intro, outro, effective frame, template, music; `timelineVideo()` in core). Starter templates declare brand +
  components; the quote fixture has a card and an overlay (run `20261011-172942-quote`: overlay bbox on the €720.00
  total). JSON Schemas regenerated. 345 tests pass (6 Postgres tests skipped).
- **L2.2 done** (components package, `@demo-studio/components`): `component.yaml` strict zod schema + `parseManifest`
  (positioned issues; id = folder; semver; slots + `default_from` sources; params = JSON-Schema subset with defaults,
  objects closed; preview samples fill required slots; layout `geometry`/`geometry_vertical` inside 1920×1080 /
  1080×1920) and `schema/component.schema.json` (`pnpm -F @demo-studio/components gen:schema`, test-guarded);
  `loadComponentRegistry({root})` (studio.yaml `components_dir` → `packages/components/library/` — empty until L2.5;
  override warning; invalid folders as `notices`; `list`/`has`/`get` (did you mean)/`resolve(ref, kind)` (defaults
  merged, validated, kind checked)/`resolveTheme(template)`); `validateComponent(dir)` (esbuild in-memory compile:
  only react, remotion, `@demo-studio/components/kit` and own files; react/remotion/kit named imports checked against
  their real exports; Math.random/Date/fetch/timers scan); 8 per-kind scaffolds `packages/components/scaffolds/<kind>/`
  (valid components `scaffolds/<kind>`, theme-driven, unit-sized, deterministic; stand-ins for the render pipeline)
  + `createComponent`; `themeTokens(template, urls)` (font family names `ds-<template>-display|body` + `font_faces`);
  `fillSlots` (default_from sources, for the planner); the kit (easing incl. theme zoom_ease, frame-driven
  fade/rise/stagger, `fitText` with balanced lines + ellipsis, Background/Logo/Wordmark/SafeArea/FitText, colour
  helpers); `ComponentProps` gained `area` (caption), `anchor` (overlay), `direction` (transition); CLI
  `studio components list|validate|create` (+ `--json`); `FrameComment` type + `COMMENTS_DIR` in core; README section
  "Components". 427 tests pass (6 Postgres tests skipped).
- **L2.3 done** (edit planner, `@demo-studio/editor`): `planEdit({timeline, template, project, registry, captureFile,
  scenario?, overrides?})` pure + deterministic (src/plan.ts; time maps in src/timing.ts, camera/reframe in
  src/camera.ts, geometry + `mapSourceRect` in src/layout.ts, component precedence in src/resolve.ts, `summarizePlan`
  + `resolvePlanAssets` in src/summary.ts). Contiguous same-page clips are planned as one *run* (one continuous time
  map: speeds, ramps, trims and camera continue across the join, then split back into clips). `srcFrames` are exact
  CFR frame indices (frame n = capture time n/fps; `timeline.capture.frames` is the screencast frame count, the CFR
  count is round(duration·fps)). Plan types extended additively (PlanTransition on segments; clip cues/layout/src/
  speeds/trims/zooms/heldFrames; OverlayUse.anchor in source px; PlanLayout.crop/fallback; ResolvedComponent.missing;
  `plan.assets` maps `ds-asset:<name>` URLs → files and `plan.meta`). `studio plan <project> <run|latest>` (summary,
  `--json`, `--out`, `--theme`, `--frame`, `--vertical`, `--scenario`); README "Editing". Tests: real timelines
  `packages/editor/test/fixtures/{catalogue,quote}.timeline.json` (runs 20261011-182524-catalogue /
  20261011-182706-quote) + synthetic timelines; a temp workspace scaffolds `components/studio/*` with
  `createComponent` (helpers add the params the starter themes pass: layout-card `width`, transitions `duration`,
  caption-below `position`, *-minimal `logo_only`). Plans: catalogue 59.0 s, quote 56.3 s (no page loads, crossfades
  at every non-contiguous join, card + interstitial + €720.00 callout in the quote). 476 tests pass (6 Postgres tests
  skipped).
- **L2.4 done** (render pipeline): placeholder built-in library `packages/components/library/studio/*` — the 18 ids the
  starter themes and the legacy mapping use (intro-stack/-minimal, outro-stack/-minimal, card-title,
  interstitial-clock/-plain, layout-card/-browser/-laptop/-phone/-raw, caption-below/-overlay, overlay-callout/
  -lower-third, transition-crossfade/-fade-black), theme-driven, tag `placeholder`, accepting the params the themes
  pass; layouts draw exactly their declared geometry (layout-card accepts `width` but draws 1560 × 877.5 until geometry
  follows params) and no longer draw the brand mark (the composition does; scaffold layout changed accordingly).
  Compositions `DemoVideo`/`DemoVertical` in `packages/editor/src/remotion/` (Root.tsx, DemoVideo.tsx, frames.ts pure
  helpers, fonts.ts, modules.ts). Render pipeline in `packages/editor/src/render/`: generated entry + registry module
  and bundle cache (bundle.ts, `<root>/.demo-studio/cache/remotion-<hash>/`, ≈ 10 s per bundle), asset server
  (asset-server.ts), browser choice (browser.ts, playwright-core registry), `renderVideo`/`renderPlan`/`renderStill`
  (render.ts), runs/versions/`listRenders` (runs.ts), RenderRecord types (types.ts). CLI `studio render` and
  `studio still` (packages/cli/src/commands/render.ts); README "Rendering"; DESIGN-phase2 §2.2 updated. 513 tests pass
  (6 Postgres tests skipped); new: components/test/library.test.ts, editor/test/render-units.test.ts,
  editor/test/render-real.test.ts (colour-coded synthetic capture: every sampled output frame shows the plan's source
  frame), cli/test/render.test.ts. Fixture renders `projects/northfield-fixture/renders/{catalogue,quote}-v1.mp4`
  (runs 20261011-182524-catalogue / 20261011-182706-quote) checked frame by frame.
- **L2.5 done** (reference-look components): `studio/intro-stack`, `outro-stack`, `layout-card`, `caption-below`,
  `interstitial-clock`, `transition-crossfade` rewritten (tag `reference-look`, 1.0.0; the 12 other ids stay
  placeholders until L2.7). Every colour/font/logo/wordmark from the theme; text placed by its CAP BAND (look.md
  positions are cap centres) with the new kit `fontMetrics` / `capTextLayout` / `<CapText>` (canvas metrics in the
  browser, estimate in Node); intro/outro = bands + measured gaps, whole stack centred; wordmark = a visual height
  (image, or the brand name in the display font × 1.3 — kit `Wordmark` semantics changed accordingly); night tone =
  `colors.dark` else the darker of text/paper; readability guard (`readableOn`); `biasMotion(style_bias)` (real = the
  reference motion; balanced/motion: more rise, scale/tracking settles, self-drawing caption rule and clock ring,
  1–2 % crossfade scale). **Geometry expressions**: layout manifests may write every geometry value as an expression
  over numeric params, `vars` and `aspect` (packages/components/src/geometry.ts; parseManifest checks them; JSON schema
  `GeometryValue`); `planEdit` evaluates them per use with the capture aspect (warning + fallback when they fail or
  leave the frame); the composition passes the evaluated rects to the layout as `props.rects`. layout-card: width 1560
  → card {180, 40, 1560 × 878}, caption {180, 930, 1220 × 110}, brand mark {1420, 965, 320 × 40}; width 1400 →
  {260, 85, 1400 × 788}; height follows the capture aspect (≤ 878). Caption-below: kicker row centred 28 px and line
  cap-centred 65.5 px under the caption area top; a caption enters 0.15 s after the clip start and leaves 0.15 s
  before its end (no double exposure in crossfades). Interstitial veil: ease-in over 0.6 s (matches the reference at
  ≈ 0.4 s better than look.md's 0.5 s). Kit radial background refitted to the reference (lighter at the top).
  Editorial caption line 35 → 38 px. `renderStills` (several frames in one browser session). interstitial-plain
  `tone: paper` now uses the theme paper (was light on the dark motion theme). Tests: components/test/geometry.test.ts,
  editor/test/planner-geometry.test.ts, editor/test/render-look.test.ts (pixel analysis of real stills: rule, card
  edges, caption, brand mark, logo rows, clock, texts within ≤ 3 px; motion at 0.4/1.0/1.3 s; width 1400 on screen;
  half size; determinism), library.test.ts rewritten for the reference look. 540 tests pass (6 Postgres tests
  skipped). Fixture renders `renders/{catalogue,quote}-v3.mp4` compared side by side with the reference stills.
- **L2.6 done** (review package, `@demo-studio/review`): `reviewRender({project, render: id|path|'latest', scenario?,
  fps?: 1|2, previous?: id|false, thumbnails?: false|'sheets'|'all', thumbnail_px?, rules?, sheet?, out?})` →
  `ReviewResult` (src/review.ts; contract in src/types.ts with `DEFAULT_RULES`). Writes `review/<render-id>/` aside and
  swaps it in: `sheet_<fps>fps.jpg` (+ `_p2`… pages, ≤ 6×10 tiles shared evenly; labels timecode · frame, segment ·
  step · ◆ marker · ⇄ transition; tiles outlined red/orange where a finding points), `sheet_scene_<id>.jpg` (2 fps,
  scenes/cards/interstitials), `keyframes/<marker>.png` + `<seg>-first/-last.png` (first/last fully visible frame) +
  `intro-hold`/`outro-hold`, `timeline.json` (output time: segments + components/caption/transition/layout/speed/zooms/
  overlays, transitions, captions, markers, step spans, clicks placed on the output — src/timeline.ts), `report.json`,
  `report.md`, `diff_<previous>.jpg`; returns JPEG thumbnails ≤ 1280 px as base64 (sheet pages + marker key frames by
  default). Frames: one ffmpeg `select` pass per video (render, capture, previous render), raw RGB streamed with
  back-pressure (src/ffmpeg.ts); sharp tiles/sheets/key frames (src/sheets.ts); stats in JS (src/pixels.ts: share near
  the median colour, luminance sd, 96×54 signatures; also `readImage`/`bbox` for tests). Spans (src/spans.ts): visible
  `[from, next.from)`, `clearFrom/clearTo` outside transition windows. Checks: src/checks.ts (no pixels: durations,
  long scenes, captions — mismatch, overlaps, `fitText` with the theme's REAL font files via src/fonts.ts (cmap/hmtx
  reader; `fitText`/`estimateTextWidth` now exported from `@demo-studio/components`), brand mark —, text slots vs
  `max_chars`, cursor at clicks with `viewOf`, camera, transitions over clicks, render status/probe/missing components)
  and src/pixel-checks.ts (blank/near-uniform screen runs with the capture frame consulted, blank/loading scene starts,
  screen changing during the opening still, `long-wait` = unchanging screen ≥ 3 s while the scenario waits — wait
  steps + time after an action until the next step, holds excluded —, caption not visible, empty cards); src/diff.ts
  (per-segment durations and plan changes, sample frames compared at the same segment offset). CLI `studio review
  <project> <render|latest> [--scenario] [--fps 1|2] [--previous ID|--no-previous] [--strict] [--json]` and `studio
  render --review` (packages/cli/src/commands/review.ts); README "Reviewing a render"; DESIGN-phase2 §3 notes. Tests:
  review/test/review.test.ts (synthetic renders drawn with ffmpeg from real plans of synthetic runs at quarter size:
  clean case, blank screen + blank scene start, overlapping / wrong-scene captions, too-long captions, cursor outside
  the zoom + off screen + two zooms, transition on a click, 35 s scene + long wait + empty cards + pagination, video
  length warning/info, diff, lookup errors), review/test/checks.test.ts (fixture plans pass the plan checks; caption
  width with the real font = 1079 px vs 1072 px of ink on the render), cli/test/review.test.ts, render.test.ts
  `--review`. 572 tests: 566 pass, 6 Postgres tests skipped (one timing flake in runner-web scene-cursor passed on
  rerun). A 1-min 1080p review takes ≈ 10 s.
- **L2.7 done** (layouts & previews): the whole built-in library is final (19 components, all 1.0.0, no placeholder
  left): layout-browser (macOS window: traffic lights, optional tab strip, address bar showing the REAL url of the
  capture at the frame's time from the timeline's urls track, chrome auto/light/dark), layout-laptop, layout-phone
  (dynamic island, status bar strip above the capture so the island hides nothing), NEW layout-tablet (portrait/
  landscape chosen by the capture aspect; frame style `tablet` in core), layout-raw (full frame, caption area for
  caption-overlay), caption-overlay (translucent night band, kicker lifted to contrast in the accent's hue), card-title,
  intro-/outro-minimal (`logo_only`), interstitial-plain (`tone` dark|paper), overlay-callout (pill + pointer toward
  the anchor bbox, clamped inside the screen or the safe area — exported `placeCallout`), overlay-lower-third,
  transition-fade-black (`through` black|night, `color`). Device geometry is written as expressions over params and the
  capture `aspect` (0/1 switches with `min/max/ceil`, no comparisons); a capture whose aspect is outside the device's
  proportions is letterboxed/pillarboxed on the theme background (`PlanLayout.display` / `LayoutRects.display`).
  Kit: `devices.ts` (deviceTones, SYSTEM_COLORS, addressParts, cardShadow), `liftToContrast`, `captionBandBox` (shared
  with review: `captionRegion(plan, clip)` → caption band over the capture for `position: over`). caption-below paints a
  paper band when its area overlaps the capture (raw layout). **Previews** (R-CMP-12/13/14): composition
  `ComponentPreview` (packages/editor/src/remotion/Preview.tsx; spec built by `buildComponentPreview` in
  src/preview.ts: layouts with sample screens of the fixture shipped in `packages/components/preview/` — desktop
  1280×720, tablet 820×1180, phone 390×844, generated once by `scripts/preview-samples.mjs`; captions/overlays/
  transitions inside the theme's own layout; transitions mid-way into a card-title), `renderComponentPreviews`
  (render/preview.ts: one bundle + browser, still at half scale = 960×540, ffmpeg palette quantisation when > 200 KB),
  `studio components preview [id|--all [--workspace]] [--stale] [--theme <name>] [--out <dir>] [--json]` → `<dir>/preview.png` +
  `preview.json` (format, component, version, theme, moment, source hash of manifest + entry + local imports) + the
  generated block of README.md (markers; author text kept); `studio components create` renders the preview
  (`--theme`, `--no-preview`; a warning, not a failure, without a browser); `components list --json` reports preview
  state. Committed previews for the 19 library components and the 8 scaffolds (editorial; 17–195 KB);
  packages/components/test/previews.test.ts fails on a missing/stale/oversized preview. `studio still --layout <id>`.
  **Flake fix** (runner-web scene-cursor): the cursor glide advanced on wall-clock time, so a stalled tick (GC, CDP
  backlog) made the cursor jump most of the way at once; it now advances on a motion clock capped at 2 ticks
  (`MAX_TICK_ADVANCE_MS`; `PointerHost.clock` injectable) and the test asserts the glide on the recorded samples
  (≥ 8 samples, no step > 0.3 × distance, monotonic approach, lands < 1 px); unit tests with a fake slow host. A capture
  that records no frame now fails (`EncodeError`) instead of producing an empty "successful" run. **Fixture shop**
  responsive at 390×844 and 820×1180 (tabs row, single-column hero/PDP, bottom-sheet dialogs, one-month date picker,
  full-width toasts); scenario `mobile-quote` (capture 390×844 scale 1, frame phone; run 20261011-222856-mobile-quote).
  `runIdMatchesScenario` (core): `latest` for `quote` no longer picks a `mobile-quote` run. 600 tests: 594 pass,
  6 Postgres tests skipped (full suite run twice, green both times).
- **L2.8 done** (variants & export): **square 1:1** variant next to vertical 9:16 (`PlanVariant` `square`, manifest
  `geometry_square` + JSON schema, `variants: [landscape, vertical, square]`, composition `DemoSquare`, `--square` on
  plan/render/still, renders `<scenario>-v<N>-square.mp4`); every layout + the layout scaffold declare both formats
  (card / browser as tall as the format allows: a capture wider than 4:5 (vertical) / ≈ 4:3 (square) is **reframed**,
  narrower ones shown whole; devices keep their proportions; caption block below, or beside a phone / portrait tablet in
  square). **Reframing** (camera.ts `reframeTrack`, plan.ts `reframeTargets`): region of interest = cursor box (+ where
  it goes in 0.4 s), step targets (0.5 s look-ahead), hard boxes (every click ± 0.35/0.5 s — widgets: each
  `data.clicks` —, overlay anchors while shown); dead zone 15 % + re-centring; calm start (framed on the first step,
  nothing moves during the opening still); `dampedSmooth` (two first-order lags τ 0.2 s forward + backward: critically
  damped, zero phase); `corridorSmooth` (banded QP Σd² + 2L²Σ(Δd)² + L⁴Σ(Δ²x)², L 0.3 s, ADMM: the smoothest critically
  damped repair keeping the cursor and hard boxes in view — no ringing); view inside the capture; per run. Crop ≥ 0.9
  design px per CSS px (`REFRAME_MIN_SCALE`). The composition draws the crop with `object-fit: fill` (it was
  letterboxed). Kit `formatMetrics` (full-frame type ×1.2 vertical / ×1.05 square, margins halved) used by intro/outro/
  card/interstitial components, `captionMaxLines` (≥ 2 lines vertical/square, ≥ 3 in a narrow column; review too),
  `captionBandBox` puts caption-overlay bands below the card in vertical/square. **4K** (spike numbers below):
  `--force-device-scale-factor=<scale>` at launch for headless scale ≠ 1 (runner-web `scaleArgs`) → real 3840×2160
  frames; 4K render of a 1080p capture works with an upscaling plan warning. **Music bed**: `music: {file, volume, duck,
  loop}` (core types/schemas) / `--music` / `--no-music`; renderVideo measures the track (ffprobe) → `planEdit({…,
  musicDuration_s})` plans `PlanMusic.plays` (trim, or loops with 1 s equal-power seams), `musicVolumeAt` (smoothstep
  fades and ducking ×0.5 under clips, base volume on intro/outro/cards), `musicPlayGain`; MusicBed = one Html5Audio per
  play; `generateTestTrack` (ffmpeg sine chords, nothing committed). **Theme default zoom** (R-ED-22 decision):
  `DEFAULT_ZOOM` rules in plan.ts, `ZoomMove/ZoomSpan.source 'theme'`, asymmetric ease-out (`outFrames`), the motion
  starter sets `default_zoom: 1.12`. **Export**: `exportRender` (editor render/export.ts) + `studio export` (cli
  commands/export.ts) → `exports/<render-id>/` + manifest.json; formats mp4_1080p (copy / lanczos scale, CRF 18),
  mp4_4k (copy / re-render scale 2), webm (VP9 CRF 32 + Opus), vertical_9x16 / square_1x1 (re-rendered with the
  master's run, theme and overrides), gif_preview (480 px, 12 fps, palette, 15 s around the first marker). **Review**:
  widget clicks placed one by one with their bbox, `target-cut` (error), `cursor-outside-reframe`, `reframe-jump`
  (rules `reframe_max_step` 6 %, `reframe_max_accel` 1.5 %), theme zooms outside the `max_zooms` budget with
  `theme-zoom-count|cut|real`, the opening-still check compares the capture frames when the view moves. `studio plan`
  shows the reframe travel and theme zooms. Previews regenerated (15 + caption-overlay; landscape look unchanged).
  Tests: editor reframe.test.ts, planner-motion-music.test.ts, export-real.test.ts (DemoSquare frame, test track loops
  and ducking measured, export of 4 formats + manifest), planner-rules (vertical/square/music), review checks
  (variants, theme zooms, widget clicks), components library/scaffolds (square geometry = defaultRects, nothing over the
  device), runner scale-2 capture, CLI export/square. 630 tests: 624 pass, 6 Postgres tests skipped (full suite run
  twice, green both times).
- **L2.9 done** (mails, notifications & documents): **core** `mailbox: {provider: mailpit | http, url, poll_ms?,
  headers?}` (host must be allowed: allow-list helpers moved from hooks to core `hosts.ts`, hooks re-exports them),
  actions `wait_for_email {to?, from?, subject?, timeout?, as}` and `download {click, as, timeout?}`, `SceneTransition`
  (a scene / card `transition` may be a component id), timeline `artefacts` (email | document | notification, files
  relative to the run) and the `notification` event; checks: unknown `email:` / `document:` names (with a suggestion),
  project documents (`.pdf/.png/.jpg/.jpeg`, file exists), `notification:` name or 1-based index, duplicate `as`,
  `wait_for_email` without a project mailbox. **Runner** (`packages/runner-web/src/artefacts/`): `MailboxClient`
  (Mailpit `/api/v1/messages` + `/api/v1/message/{ID}`; `http`: the generic JSON shape in the README), baseline at run
  start, oldest new unclaimed match; `download` (real click; download event or new tab polled until its URL leaves
  about:blank, fetched with `context.request` = session cookies; tab closed; `watchNavigation` ignores a navigation that
  became a download); `ArtefactStore` + `ArtefactRenderer` after the capture (clean Chromium): email HTML sandboxed (JS
  off, offline, CSP, cid: inlined) at 600 px × 2 full height, PDFs with pdfjs-dist 5.4.296 (served from node_modules
  via `ctx.route`) at 2 × 96/72 (A4 ≈ 1587×2245) → `documents/<as>/page-<n>.png` + page sizes, notification icons →
  192 px PNG. **Web notifications**: the kit patches `new Notification` / `ServiceWorkerRegistration.prototype.
  showNotification` once per window; the session grants `notifications` and exposes `__demoStudioNotification`;
  `watchNotifications` records artefact + event (step −1 of the current scene). **Planner**: artefact slots →
  serialisable `props.media` (images as `ds-asset:` plan assets; warnings naming what the run captured), notification
  overlays start when the notification showed (inside the clip), `OverlayUse.componentFrames` when cut, tap anchors:
  manifest `anchor` / `anchor_vertical` / `anchor_square` expressions (builtins `frame_w/h`, `screen_x/y/w/h`, `aspect`,
  one-hot `style_<value>` params; `evalAnchor`, `checkAnchor`) evaluated on the outgoing overlay (last second) or card
  → `PlanTransition.anchor`. **Components** (kit `notifications.tsx`: 5 styles, sizes, placement, motion, tones,
  `AppIcon`; kit `phone.tsx`: `PhoneDevice`, `phoneCardGeometry`, wallpapers; `SYSTEM_COLORS.badge/page`):
  `studio/notification`, `studio/mail-notification`, `studio/mail-view`, `studio/document-pdf`,
  `studio/phone-lockscreen`, `studio/phone-home-badge`, `studio/transition-tap-open`; previews committed (media samples
  in `packages/components/preview/` from `scripts/preview-media-samples.mjs`), `Preview.tsx` passes media + a sample
  anchor. **Fixture**: `/signup` + `/signup/confirm` (token `latest`), confirmation email with a cid: logo into the
  built-in Mailpit-compatible API (`/mailbox/api/v1/…` on both ports, cleared by `/api/reset`), real quote PDF
  (`/quotes/:id/quote.pdf`, Chromium `page.pdf`, cached; compact print CSS fits one A4 page), console web notification
  for each new quote request (polls every 1 s), `/app-icon.svg`; smoke script checks the PDF and the mail. Project
  `mailbox`; scenario **`signup`** (new: sign-up → mail notification overlay → tap-open into the mail-view card →
  lock screen → home badge → tap-open into the confirmed account → first product) and **`quote`** (setup hook
  `open-console` opens the console tab; the captured notification overlaid when it showed; `download` of the quote PDF
  + `quote-pdf` document card; the request scene split into `request` + `delivery`, see notes). Tests: core
  artefacts.test.ts, runner artefacts.test.ts (8: mailbox baseline, cid, sandbox, download event 2 pages, new tab with
  the session cookie, Notification + service worker, project document), components library-l29.test.ts (anchors vs
  layout, media rendering, page selection, grouping, badge, tap-open, dark theme and all formats), editor
  planner-artefacts.test.ts (frozen timelines `signup.timeline.json`, `quote-artefacts.timeline.json`). 671 tests:
  665 pass, 6 Postgres tests skipped (full suite run twice, green both times).
- **L2.10 done** (tutorial overlays & story cards): **core** `tutorial` switches on the scenario, a scene or a step
  (`true` / `false` / a mode — `spotlight: steps | clicks`, `progress: scenes | cards` — / `{component?, params?}`;
  `resolveTutorial`: most specific wins; `progress` is scenario-only, a warning elsewhere; a step switch that cannot
  apply to its action is a warning), `TUTORIAL_FEATURES` / `TUTORIAL_COMPONENTS`, `parseFrameRef` (`mark:` / name,
  `start:` / `end:` scene, `12.5s`, image file), action `capture_text: {target, as, pattern?}` → `text` artefact
  (checks: target, regex, duplicate `as`), slot checks for `capture:` (capture_text names), `before:` / `after:`
  (marks, scenes, files), `data:` (.csv / .tsv) and image slots (`logo`, `avatar`, `image`). **Runner**: switches
  copied into the timeline (`video.tutorial`, `scene.tutorial`, `event.tutorial` — the editor never reads the
  scenario); `capture_text` polls the kit's `visibleText` until the pattern matches → `artefacts/texts/<as>.json`;
  `type` records `data: {chars, cps, t_type, t_typed, t_enter?}` and, without `into`, the focused field (kit
  `focused()`) as its target; `press` records `{key, times}`. **Planner** (`packages/editor/src/tutorial.ts`, pure,
  `TUTORIAL_TIMING`): shortcut caps per `press` and per Enter of `type`, starting 0.3 s before the real press
  (`moment`), trimmed by the next; spotlight = one overlay per run of targeted steps on the `screen` layer whose box
  glides (`OverlayUse.track`, `trackBoxAt`, smoothstep over `TRACK_GLIDE_S` 0.45 s), a click ends it 0.45 s later;
  badges beside clicked targets (per scene or video); one loupe per run of typed fields, gliding, `OverlayUse.region`
  rendered from the capture itself; `plan.tutorial = {uses, skipped, progress}` (chapter bar between intro and
  outro); tutorial targets join the reframe targets; skipped → plan warning. Story-card media: `frame` → `PictureMedia`
  (capture frozen at the time, or an image file as plan asset), `data` → `TableMedia` (`parseCsv`), `capture` →
  `TextMedia`; project files read before planning by `planInputFiles` (CSV text, image sizes; wired in render, still
  and `studio plan`); `planComponentIds` includes the progress component. **Composition**: screen layer drawn before
  the brand mark and caption, `moment` / `region` / `chapters` props, the progress bar at the top level, `avoid`
  (the caption band of a caption over the screen; for the loupe and badges also the key caps' row — `overlayAvoid`,
  `shortcutRow`, kit `shortcutPlateBox`) and one side for a loupe gliding over several fields (`loupePlacement`, kit
  `loupeLens`). **Components**
  (kit `keys.ts`, `figures.ts`, `qr.ts`, `icons.tsx`, `picture.tsx`, `place.ts`; slot types `capture`, `frame`,
  `data`; manifest `preview.target: button | field`): `studio/overlay-shortcut`, `overlay-spotlight`, `overlay-steps`,
  `overlay-loupe`, `overlay-progress`, `card-figure`, `card-features`, `card-before-after`, `card-testimonial`,
  `card-cta` (QR from the kit's encoder — byte mode, v1–40, L/M/Q/H — equal module for module to the `qrcode`
  package, a devDependency of components used by the tests only), `card-chart`; previews committed (sample frames
  `preview/frame-before.jpg` / `frame-after.jpg` from `scripts/preview-frame-samples.mjs`, sample field box).
  **Review**: `tutorial-skipped`, `tutorial-target-cut` (box centre outside the visible capture at the overlay's start,
  middle, end), `media-missing` (capture / frame / data slots that did not resolve); the opening-still check compares
  capture frames when an overlay or a caption over the screen comes in during the still (it flagged the spotlight fade
  and the motion theme's caption entrance). **CLI**: `render --tutorial | --no-tutorial`. **Fixture**: shop search
  focus shortcut (⌘K / Ctrl+K or "/", `⌘K` hint); `signup` with every tutorial overlay (Tab between fields, a `type`
  without `into`, ⌘K → type Selowa ↵ → result); new `highlights` (coffees, quotes with `capture_text` of the proposal
  total + `mark: proposal-open`, then figure, before/after, features, chart from `data/quotes-per-month.csv`,
  testimonial, CTA cards). Tests: core tutorial.test.ts, runner tutorial.test.ts, components qr.test.ts +
  library-l210.test.ts, editor planner-tutorial.test.ts (frozen timelines `signup-tutorial.timeline.json`,
  `highlights.timeline.json`), review tutorial.test.ts; library / registry / previews / CLI counts now 37 built-in
  components. `SYSTEM_COLORS.white` / `.black` (mask, QR plate and modules, last-resort ink) keep the sources free of
  colour literals (test-guarded). 757 tests: 751 pass, 6 Postgres tests skipped (full suite run twice, green both
  times).
- **Requirements:** 598 tracked; 386 done, 50 partial, 147 todo, 15 n/a-here; the open ones are assigned to lots
  L1.2 … L6 (R-ARCH-03 moved to L5.3). L2.1–L2.10 all done (L2.10: R-TUT-01…05, R-STO-01…06). From L1.4, R-ARCH-06 (crisp scale-2 frames) is done too and R-GOAL-01 records the real scale-2 capture
  (2560×1440 still untested).
- **Phase 2 so far:** contracts in core (L2.1) + components package (L2.2) + edit planner (L2.3) + render pipeline
  (L2.4) + reference-look components with geometry expressions (L2.5) + review (L2.6) + final library, device layouts
  and previews (L2.7) + variants, 4K, music and export (L2.8) + mails, notifications & documents (L2.9) + tutorial
  overlays & story cards (L2.10).
  `packages/mcp` is empty; `studio record|mcp|ui` print "available in phase N".

## Next lot
**L2.11 — Multi-page capture: split screen & picture in picture** (M): the runner records two pages on one clock
(e.g. supplier + buyer, or desktop + mobile viewport); timeline tracks per page; scenario syntax for parallel pages;
layouts `studio/layout-split` and `studio/layout-pip` planned and rendered in sync (R-MPC-*). Then L2.12 (bring your
own media & motion), L2.13 (raw capture export), L2.14 (phase 2 acceptance + Mac handoff); after phase 2 the work
moves to a local session on the user's Mac starting with L1.5 (see ROADMAP).

Render, review, export and preview commands (fixture captures: runs 20261011-182524-catalogue, 20261011-182706-quote
(before L2.9), 20261012-022141-quote (L2.9: notification + PDF), 20261012-022315-signup (L2.9),
20261012-034207-signup (L2.10: tutorial overlays), 20261012-034247-highlights (L2.10: story cards), 20261011-222856-mobile-quote,
and the 4K run 20261011-234009-quote-4k of a scale-2 copy of the quote scenario). Captures need the fixture server
(`node fixtures/wholesale/server.mjs`; stop it with `kill <pid>` — `pkill -f` with its path also matches the shell
that runs it):
```
node packages/cli/dist/bin.js run northfield-fixture signup              # mail, phone cards, tap-open, tutorial overlays (≈ 45 s)
node packages/cli/dist/bin.js run northfield-fixture highlights          # capture_text + every story card (≈ 46 s)
node packages/cli/dist/bin.js render northfield-fixture signup && node packages/cli/dist/bin.js review northfield-fixture signup-v12
node packages/cli/dist/bin.js render northfield-fixture signup --no-tutorial   # the same video without the overlays
node packages/cli/dist/bin.js render northfield-fixture highlights --theme motion
node packages/cli/dist/bin.js render northfield-fixture catalogue        # → renders/catalogue-v<N>.mp4 + .json
node packages/cli/dist/bin.js render northfield-fixture quote --vertical # 1080×1920, reframed → quote-v<N>-vertical.mp4
node packages/cli/dist/bin.js render northfield-fixture quote --square --theme motion   # 1080×1080 + theme zoom
node packages/cli/dist/bin.js render northfield-fixture catalogue --music projects/northfield-fixture/.demo-studio/test-bed.m4a
node packages/cli/dist/bin.js export northfield-fixture catalogue-v4 --formats all     # → exports/catalogue-v4/
node packages/cli/dist/bin.js plan northfield-fixture latest --scenario quote --vertical   # shows each clip's reframe
node packages/cli/dist/bin.js review northfield-fixture quote-v9-vertical
node packages/cli/dist/bin.js components preview --all --stale          # regenerate stale committed previews
node -e "import('./packages/editor/dist/index.js').then(m => m.generateTestTrack('projects/northfield-fixture/.demo-studio/test-bed.m4a', {seconds: 16}))"
```
Render times here (4 CPUs, no GPU, concurrency 3): 1080p quote 56.3 s → ≈ 3 m; vertical 1080×1920 → 3 m 13 s,
square 1080×1080 → 2 m 23 s; catalogue 59 s with music → 3 m 34 s; 4K catalogue (export mp4_4k) → 8 m 04 s; WebM (VP9)
transcode of 59 s 1080p → 1 m 25 s; ≈ 8–9 output fps at 1080p; a still ≈ 1–2 s with a cached bundle.

**4K findings (spike, measured here — headless Chromium 141, 4 CPUs, no GPU, JPEG q 90):**
- Without help, scale 2 gives CSS-size images on every path: the CDP screencast (new headless and the headless shell
  alike), `Emulation.setDeviceMetricsOverride` re-sent on the recorder's session with screencast maxWidth/maxHeight at
  device pixels, and `Page.captureScreenshot` (with or without `clip`, `fromSurface`, `optimizeForSpeed`) — all
  1920×1080 for a 1920×1080 viewport at DPR 2 (the page reports DPR 2).
- `--force-device-scale-factor=2` at launch makes all of them 3840×2160, text rasterised at 2× (crops compared with a
  Playwright DPR-2 screenshot: identical sharpness). Kept: the runner adds it for headless captures with scale ≠ 1.
- Frame rate (animated element on the fixture pages): screencast 9.5 fps on the shop, 13.6 on the console, 16 on a
  blank page at 4K vs 44–58 fps at 1080p; `captureScreenshot` in a loop 5.6 fps at 4K (13 at 1080p) → the screencast
  stays the path. JPEG quality 60–95 changes nothing (raster / readback bound).
- Real capture `quote` at scale 2 (run 20261011-234009-quote-4k): 3840×2160 capture.mp4, 338 frames over 110.9 s of
  capture (48.4 s at scale 1): 6–9 fps on the shop pages, 2–3 fps under the request dialog (backdrop blur); the cursor
  glides on its motion clock, so the run itself slows down (4 m 53 s) and motion stays smooth but slow. Usable for
  stills and slow scenes here; a Mac with a GPU should be much faster (L1.3 / L1.5).
- 4K output: a scale-2 capture renders 3840×2160 with every component at unit 2 (crisp, stills compared with a 4K
  render of the 1080p capture: visibly sharper text); `--scale 2` / export `mp4_4k` of a 1080p capture works with the
  plan warning "the capture is 1920×1080 px (scale 1): it is upscaled …".

Renders of L2.8, looked at frame by frame (frames extracted with ffmpeg at every click and the 5 frames around the
largest reframe move of each clip) and reviewed with `studio review`: **quote-v9-vertical** (editorial, 56.3 s;
review clean, 1 info) — every clicked target (Selowa Ridge, Request a quote, Increase ×2, the size and grind
dropdowns and their options, Delivery window, Next month at the right edge, 10 Jan, 24 Jan, Message, Send request, the
notification bell and item, Download quote PDF) and the cursor in view, the callout on €720.00 mapped through the
crop, captions on one line under the card, consecutive frames of the largest pans move ≈ 11 px a frame, nothing moves
during the opening stills; **quote-v10-square** (motion theme, 57.2 s; review clean, 1 info): the same, caption bands
under the card, the theme zoom 1.12× on the marked proposal (in 3.8 s, back to 1× before the outro); **catalogue-v4**
(editorial + the 16 s test track, 59.0 s): music RMS ≈ −25 dB on the intro, ≈ −31/−33 dB under footage (−6 dB
ducking), −27.6 dB on the outro, no dip at the loop seams (15.5 s, 30.5 s, 45.5 s), faded out to silence at 59 s.
**Export of catalogue-v4, all six formats** (`studio export … --formats all`, 15 m 37 s; every file ffprobed):
mp4_1080p copy 1920×1080 h264 + aac 59.01 s 8.8 MB; mp4_4k re-rendered 3840×2160 h264 + aac 59.01 s 17.4 MB (8 m 04 s,
the upscaling warning); webm 1920×1080 vp9 + opus 59.02 s 4.6 MB (1 m 25 s); vertical_9x16 re-rendered 1080×1920
h264 + aac 59.01 s 11.5 MB (3 m 17 s); square_1x1 re-rendered 1080×1080 h264 + aac 59.01 s 9.1 MB (2 m 49 s);
gif_preview 480×270 12 fps 15.0 s 0.77 MB (8.4–23.4 s around the first marker, 1.5 s). Every file with sound carries
the music (mean −31.1 dB, the master's level). Frames of the exported vertical and square looked at (every click of
import / availability / add-product: targets and cursor in view; the file chip dragged in from the capture's right
edge followed smoothly), the exported vertical reviewed: the known `long-wait` warning only.
Earlier: quote-v7-vertical / quote-v8-square (before the calm start and the caption bands below the card),
catalogue-v3 one `long-wait` warning (registry delay of the fixture, 00:45.1–00:48.9) — to fix for L2.12.

Renders of L2.9, reviewed with `studio review` and looked at frame by frame (ffmpeg frames of every new component,
the tap-open transitions frame by frame, crops at full size): **signup-v4** (editorial, 46.4 s, run
20261012-022315-signup; review clean, 5 info — video length within the tolerance): the mail notification slides in
at the top right when the mail was captured (sender, subject, two-line preview, mail glyph), the tap ring on it, the
mail-view card grows from the banner's box and scrolls the real rendered email (date from the `date` slot), the lock
screen (theme wallpaper, 9:41) receives the scenario notification then the captured email on top, the home screen badge
counts 0 → 2 on the theme app icon, tap-open from that icon into the confirmed-account clip, then Browse coffees →
Selowa Ridge → hover on Request a quote. **quote-v13** (editorial, 70.7 s, run 20261012-022141-quote; review clean,
8 info): the console's real web notification ("New quote request — Demo Café asks for Selowa Ridge · 3 × 5 kg", the
app icon fetched from the product) overlaid in macOS style at the moment it showed, with the "Instantly" caption; the
download click on "Download quote PDF" with no flash of the PDF tab; the `quote-pdf` card zooming slowly into the real
one-page PDF (no overlap since the print CSS was compacted). Previews of the 7 new components (regenerated after the
last source edits) and variant sheets (windows / ios-banner / android / in-app, motion theme, document scroll, mail and
lock-screen motion) looked at. Earlier: signup-v1…v3 (35.8 / 41.6 s: `video-length` warning), quote-v11 (PDF footer
over the signature), quote-v12 (request scene 34.1 s: `long-scene` warning) — fixed by the changes above.

Renders of L2.10, reviewed with `studio review` and looked at frame by frame (ffmpeg frames at every overlay's start,
moment and glide, contact sheets): runs 20261012-034207-signup and 20261012-034247-highlights. **signup-v7**
(editorial, 45.47 s; review clean, 3 info): spotlight on Café name gliding to Your name, Work email and Create account,
badges 1 and 2, the loupe gliding from field to field (Tab between them shows ⇥ caps), ⌘K then the lens on the search
field and ↩, badge 1 on the Selowa Ridge result, the chapter bar at the top. **signup-v8-vertical** (45.47 s; clean,
1 info): the same reframed; the typed email reads in the lens; between two fields the lens glides for 0.45 s and shows
the label in between (accepted). **signup-v9** (motion, 45.97 s): the key caps sat over the caption band of
caption-overlay → overlays now receive `avoid`; **signup-v10**: the caps moved above the band but then covered the
lens → the loupe also avoids the caps' row and keeps one side for its whole glide; **signup-v11** (motion, 45.97 s;
clean, 3 info): caps above the band, the lens above the fields, nothing overlapping; **signup-v12** (editorial again
after these changes, 45.47 s; clean): unchanged look (caps at the bottom of the capture, lens below the fields).
After these renders only test-guard fixes touched the components (colour literals → `SYSTEM_COLORS.white/black`, the
spotlight and progress fades read `style_bias`: ×1.1 in motion); previews re-rendered, identical to the eye.
**highlights-v1** (editorial, 45.80 s; clean, 1 info) and **highlights-v2** (motion, dark night tone, 47.97 s; clean
after the still fix, 13 info): €465.00 counted up from the proposal, the before/after wipe from the quotes list to the
open proposal, four features staggered, the bar chart with Nov in the accent, the testimonial with initials, the CTA
with its QR (sampled from the frame: version 3, 29 × 29 modules, 9.1 px each at 1080p, 0 modules different from the
encoder). Previews of the 11 new components looked at (re-rendered after the last kit edits: byte-identical).
Render times here: signup 1080p ≈ 2 m 40 s, vertical ≈ 3 m 20 s, highlights ≈ 2 m 10 s.

Notes for L2.11:
- Tutorial overlays assume one capture per clip: `mapSourceRect(plan, clip, frame, box)` maps source CSS px through
  the clip's single layout capture rect + camera + reframe; the spotlight dims `rects.screen`; the loupe's `region`
  renders `CaptureScreen` of the clip's one capture video. With two pages, events need their page and each mapping /
  region / spotlight must use that page's rect and video (spotlight: dim only the page of the step).
- Story cards that show capture frames (`PictureMedia.video.time_s`, `frame` slots) point at the clip capture file:
  a second page needs its own file in the plan (asset) and `start:` / `end:` / `mark:` refs resolved per page.
- `trackBoxAt` / `TRACK_GLIDE_S` (a box gliding between keyed boxes) can drive a picture-in-picture window move.
- Overlays get `avoid` (output px) for a caption band over the screen (`overlayAvoid`): a split layout with captions
  over each half would extend that list.
- Review: the opening still is compared on capture frames when the view moves, an overlay is on or a caption over
  the screen is on (`stillFromSource`); with two pages, compare each page's capture.
- `capture_text` reads the kit's `visibleText` (innerText, whitespace collapsed): inline children without spaces come
  out joined (the fixture's total reads "€465.00incl. VAT"; the pattern picks the value).
- The runner records a `type` without `into` against the focused field (kit `focused()`), and `type` / `press` timing
  in `data` — reusable for per-page events.
- Preview samples: `scripts/preview-frame-samples.mjs` (needs the fixture running) writes the before/after sample
  frames; `preview/samples.json` has a sample `field` box (manifest `preview.target: field`).
- Dependencies added by L2.10: `qrcode@1.5.4` as a devDependency of components (tests only; the encoder is the kit's).
- Carried over: capture under dialogs is slow (backdrop blur; L1.3); `download` of a file that is neither a PDF nor an
  image keeps the file with a warning; `mail-view` shows the captured `date` unless the
  slot stages one; components drawn over the capture (notification banners) are not known to the reframe;
  `preview.json.source_hash` does not cover the kit (`components preview --all` after a kit change that alters a
  look); still open from L2.8: caption bands over a reframed capture with `layout-raw`, the reframe release jolt
  (≈ 1 %/frame², under the 1.5 % threshold), 4K export ≈ 4× the 1080p time, the interstitial caption fade.
- The fixture videos are ≈ 45–48 s: `video-length` info (the reference look targets 60–120 s, 25 % tolerance).

## Decisions (do not re-litigate)
- The tool stays generic: no client/brand/person names anywhere in the repo or its history (history was squashed for
  this). Customer material lives in the user's own workspace (`DEMO_STUDIO_ROOT` or a `studio.yaml`).
- Everything visual in the edit is a **component** (plugin) with a manifest; themes (templates) give tokens and pick
  components; workspace components can be created by Claude through a skill; a cloud marketplace comes in V2.
- **Frame comments** are stored as files in the workspace and exposed to Claude through MCP; anchored to the render
  frame and to the scenario (scene/step/segment/component) via the edit plan's provenance.
- **Studio app**: web UI first (`studio ui`), Tauri macOS shell later around the same UI; scenario shown as blocks /
  cards / badges, two-way with YAML; timeline with live Remotion Player preview and one-click component switching;
  Run and Record screens as in the canvas.
- Backlog lives **only in the repo** (no Linear). Small lots; each lot is committed and pushed; consumption reported.
- The user allowed force-pushes on this working branch (used to squash WIP checkpoints into one commit per phase/lot).
- App UI language: English. Conversation with the user: French.

- (2026-10-11) Autonomy granted through the end of phase 4: chain lots without asking, one clean commit per lot,
  short report per phase. Phase 5 needs a Mac.
- (2026-10-11) Phase 2 now ends with L2.9 mails/notifications/documents, L2.10 tutorial overlays & story cards,
  L2.11 multi-page capture (split screen, picture in picture), L2.12 acceptance (see ROADMAP). Backlog for the
  marketplace: terminal, code, chat/SMS, Dynamic Island, calendar, sounds, webcam, SRT subtitles.
- (2026-10-11) Theme `motion.default_zoom` (L2.8): only for style_bias balanced/motion — at most one slow zoom per
  scene on a marked step target, never across a cut; `real` keeps a static camera.
- (2026-10-11, L2.6) Review severities for the look targets: video length outside 1–2 min = **info** within ±25 %
  (45–150 s), warning beyond (the range is a style target measured on two reference videos, not a defect: the 59 s /
  56 s fixtures are fine); scenes outside 4–25 s = info, < 2 s = warning; more than one zoom per video = warning, a zoom
  that is not "very slow" = info. Thresholds live in `DEFAULT_RULES` and can be overridden per call (`rules`).
- Risk to review before V2: Remotion's licence for a redistributed commercial tool (keep the renderer swappable
  behind the EditPlan/component contract).

- (2026-10-12) **Architecture: local-first, desktop-first, flat files** — see docs/ARCHITECTURE.md (ADR-1, ADR-2).
  V1 stays simple: no server-side capture/render; full cloud later, outside this development phase.

## Conventions
- TypeScript ESM/NodeNext, relative imports end in `.js`; `pnpm build` (= `tsc -b`), `pnpm test` (= `vitest run`;
  `vitest.config.ts` aliases `@demo-studio/*` to `src/`). No new dependencies without a strong reason.
- Commit messages end with the session attribution lines given by the harness. Never commit `runs/`, `renders/`,
  `review/`, frames or videos (git-ignored).
- At the end of a lot: update `docs/requirements.json` (status/evidence/gap), run `node scripts/requirements.mjs`,
  update this file and ROADMAP's status table, commit, push, report.

## Environment notes (Linux cloud container)
- Chromium 141 via playwright-core 1.56.1 (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); new headless
  (`channel: 'chromium'`). Remotion renders with
  `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` (found through playwright-core's
  registry; `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL` overrides).
- ffmpeg 6.1 on PATH. Postgres 16 installed (`pg_ctlcluster 16 main start`, run as the postgres user).
- No GPU: pages with heavy effects (backdrop blur) are captured at 6–10 fps during cursor motion (L1.3). No display and
  no macOS: login, `--headed`, Keychain and notifications are verified by the user on a Mac (L1.5).
- Fixture: `node fixtures/wholesale/server.mjs` (console :4401, shop :4402), then
  `node packages/cli/dist/bin.js run northfield-fixture catalogue` (add `--dry` for a rehearsal).
