# Handoff — read this first in a new session

Last updated: 2026-10-11, end of lot L2.7. Working branch: `claude/new-session-pq6jtq`.

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
- **Requirements:** 572 tracked; 350 done, 55 partial, 152 todo, 15 n/a-here; the open ones are assigned to lots
  L1.2 … L6 (R-ARCH-03 moved to L5.3). L2.3: all done but R-ED-22 (partial: `motion.default_zoom` has no consumer —
  decided: L2.8). L2.4: all 16 done. L2.5: all done. L2.6: all 25 done (incl. R-LOOK-03/05). L2.7: all 21 done
  (R-LIB-00…, R-ED-10/12/13/14, R-CMP-12/13/14).
- **Phase 2 so far:** contracts in core (L2.1) + components package (L2.2) + edit planner (L2.3) + render pipeline
  (L2.4) + reference-look components with geometry expressions (L2.5) + review (L2.6) + final library, device layouts
  and previews (L2.7). `packages/mcp` is empty; `studio export|record|mcp|ui` print "available in phase N".

## Next lot
**L2.8 — Variants & export** (M): vertical 9:16 and square 1:1 with smoothed reframing on the cursor/targets, 4K from
scale-2 captures, music bed with ducking, export formats mp4_1080p / mp4_4k / webm / vertical_9x16 / square /
gif_preview, `studio export`; theme `default_zoom` for balanced/motion styles (R-ED-17/20/21/22, R-EXP-*, R-CLI2-03) —
unless the user picks otherwise (L1.2 robustness, L1.3 capture smoothness, L1.5 = the user runs
`docs/MACOS-CHECKLIST.md` on a Mac). See ROADMAP.

Render, review and preview commands (fixture captures exist: runs 20261011-182524-catalogue, 20261011-182706-quote,
20261011-222856-mobile-quote):
```
node packages/cli/dist/bin.js render northfield-fixture catalogue        # → renders/catalogue-v<N>.mp4 + .json
node packages/cli/dist/bin.js render northfield-fixture quote --theme motion --review
node packages/cli/dist/bin.js render northfield-fixture quote --frame browser   # laptop | phone | tablet | raw | card
node packages/cli/dist/bin.js render northfield-fixture mobile-quote             # frame: phone (scenario)
node packages/cli/dist/bin.js still northfield-fixture quote --frame 1409 --layout studio/layout-laptop
node packages/cli/dist/bin.js review northfield-fixture catalogue-v3     # → review/catalogue-v3/ (≈ 10 s)
node packages/cli/dist/bin.js components preview --all --stale          # regenerate stale committed previews
node packages/cli/dist/bin.js components preview --all --theme motion --out /tmp/previews   # look in another theme
```
Render times here (4 CPUs, no GPU, concurrency 3, 1080p): quote 56.3 s → 3 m 10–30 s with the L2.7 layouts (browser
3 m 11 s, laptop 3 m 30 s, raw 3 m 09 s; a new bundle ≈ 10 s each), mobile-quote 33.3 s → ≈ 1 m 20 s (phone 1 m 23 s,
tablet 1 m 19 s); catalogue 59.0 s → 3 m 37 s (L2.5). ≈ 8–9 output fps (Chrome software raster + JPEG capture
dominate); a still ≈ 1–2 s with a cached bundle; `renderStills` ≈ 0.3–0.6 s per extra frame; all 27 previews ≈ 1 min.

Renders of L2.7, looked at frame by frame (frames extracted with ffmpeg) and reviewed with `studio review`:
**quote-v4** (`--frame browser`: the address bar follows the capture — localhost:4402 → /products/selowa-ridge in
the shop, / → /quotes/1043 → /quotes/1043/pdf in the console; callout on the €720.00 total), **quote-v5** (laptop),
**quote-v6** (raw + caption-overlay) — all three clean (info: 56.3 s); **mobile-quote-v1** (phone) and
**mobile-quote-v2** (`--frame tablet`: the phone capture pillarboxed in a portrait tablet) — one warning each,
`video-length` 33.3 s (the scenario is short on purpose). Earlier reviews: quote-v3 clean; catalogue-v3 one
`long-wait` warning (registry delay of the fixture, 00:45.1–00:48.9) — to fix for L2.12.

Notes for L2.8:
- Scale-2 capture is impossible with the current capture path: new-headless Chromium's CDP screencast ignores
  `deviceScaleFactor: 2` and sends frames at CSS size (tried for mobile-quote: every frame was dropped as the wrong
  size, and the run "succeeded" with no frame — it now fails with an EncodeError). 4K output (R-ED-20) needs another
  capture path (old headless, `Page.captureScreenshot` per frame, or a `--headed` capture on the Mac) — L1.4/L2.8.
- Vertical (DemoVertical): the device layouts have `geometry_vertical` (phone/tablet/laptop/browser/raw) evaluated
  with the capture aspect; real 9:16 reframing on the cursor/targets is still to do.
- Device layouts letterbox a capture outside their proportions: phone screen aspect clamped to 0.42–0.62, tablet
  portrait/landscape picked by a 0/1 switch on the aspect; `plan.layout.display` is then the device screen rect (the
  layout paints the bars there) and `capture` stays the fitted image rect — overlays and camera keep mapping into
  `capture`.
- Captions: `captionRegion(plan, clip)` (review) and `captionBandBox` (components) share the band of caption-overlay
  (`position: over`); caption-below over a layout without a caption area paints a paper band. A new caption component
  drawn elsewhere needs `captionRegion` extended.
- Previews: `preview.json.source_hash` covers the manifest, the entry and its relative imports — not the kit. A kit
  change that alters a look needs `components preview --all` (not `--stale`). Sample screens are regenerated with
  `node scripts/preview-samples.mjs` (fixture server running) and are not part of the hash either.
- Remaining look differences vs the reference are brand-related (editorial display face lighter than the reference's
  serif; the placeholder brand's wordmark is shorter); the reference fades the clip caption during the interstitial
  dim, ours has already left.

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
