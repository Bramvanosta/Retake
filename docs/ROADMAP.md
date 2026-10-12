# Roadmap — small lots

Every requirement of the brief is tracked in `docs/requirements.json` (source of truth) and rendered in
`docs/REQUIREMENTS.md`; each one belongs to exactly one lot below. `node scripts/requirements.mjs --lot L2.3` lists the
requirements of a lot with their gaps.

Architecture decisions (local-first, desktop-first; flat files as source of truth): `docs/ARCHITECTURE.md`.

## Working agreement
- **One lot at a time**, sized to stay readable and cheap: S ≈ 0.3–0.5 M tokens, M ≈ 0.6–1.0 M, L ≈ 1.0–1.6 M
  (reference: phase 1 took ≈ 2.5 M across 6 agents; the spec audit ≈ 0.65 M).
- A lot ends with: build + full test suite green, the lot's acceptance checked (tests, real runs, frames looked at),
  `docs/requirements.json` statuses/evidence updated (`node scripts/requirements.mjs`), `docs/HANDOFF.md` updated,
  one commit pushed to the working branch, and a short report (what was done, verification, consumption, next lot).
- The user picks how many lots to chain. Current go (2026-10-12): autonomous through the end of phase 2 (L2.14) in
  the cloud session, one clean commit per lot. The work then moves to a local Claude Code session on the user's Mac,
  which starts with L1.5 (macOS verification, decides L1.3), then L1.6–L1.8 and phase 3.
- **MVP scope is locked** (2026-10-12) to the lots in this file. Any new idea goes to `docs/BACKLOG.md` (unprioritised)
  instead of a lot.
- **Goal for now: a local tool for our own use** (2026-10-12). Commercialisation (plans, licences, cloud, marketplace)
  is a future topic, parked in `docs/BACKLOG.md`; voice-over is an evolution there too (the MVP keeps a silent track).
- The tool stays generic: no client/brand/person names in code, docs, fixtures, templates or test data. The market
  docs (`docs/COMPETITION.md`, `docs/BACKLOG.md`) name third-party products for analysis only.
- Every lot that adds or changes a component regenerates its committed `preview.png` (`studio components preview`).

## Status

| Lot | Title | Size | Status |
|---|---|---|---|
| P1 | Phase 1 — core, runner-web, hooks, CLI, fixture, starter templates | — | **done** (commit `0df4a29`) |
| L1.1 | Phase 1 polish + `studio doctor` | S | **done** |
| L1.2 | Runner robustness for any site | M | todo |
| L1.3 | Capture smoothness under load (spike) | M | todo |
| L1.4 | Coverage of untested options + automated fixture acceptance | M | todo |
| L1.5 | macOS verification pass (run by the user on a Mac) | S | todo |
| L1.6 | Sessions & personas (profiles, preflight, auth status, optional automated login, onboarding) — after phase 2, before L3.1 | M | todo |
| L1.7 | Display URLs, read-only & production safety, frozen clock — after L1.6 | M | todo |
| L1.8 | Sandbox mode (manifest, docker-compose & process providers, seed/reset/snapshot) — after L1.7, before L3.1 | L | todo |
| L2.1 | Phase-2 contracts in core (themes pick components, scenario additions) | S | **done** |
| L2.2 | Components package: registry, validation, scaffolding, kit helpers | M | **done** |
| L2.3 | Edit planner (pure, unit-tested) | M | **done** |
| L2.4 | Render pipeline (Remotion bundle, asset server, `studio render`) | M | **done** |
| L2.5 | Reference-look components (intro, outro, card layout, caption, clock, crossfade) | M | **done** |
| L2.6 | Review package + `studio review` | M | **done** |
| L2.7 | Layouts & previews (browser, laptop, phone, tablet, raw; caption-overlay, card-title, lower-third…) | M | **done** |
| L2.8 | Variants & export (vertical 9:16, square 1:1, 4K, music bed, formats; theme default zoom) | M | **done** |
| L2.9 | Mails, notifications & documents (wait_for_email, download, PDF, lock screen, tap to open, badge) | L | **done** |
| L2.10 | Tutorial overlays & story cards (shortcut, spotlight, steps, loupe, progress; figure, features, before/after, testimonial, CTA+QR, chart) | L | **done** |
| L2.11 | Multi-page capture: split screen & picture in picture | M | next |
| L2.12 | Bring your own media & motion (video/image segments, alpha overlays, Lottie, docs) | M | todo |
| L2.13 | Raw capture export for editors (clips per scene, ProRes, cursor data/layer, FCPXML/EDL/OTIO markers) | M | todo |
| L2.14 | Phase 2 acceptance (videos, clean review, theme/component switch, own media, raw export) | S | todo |
| L3.1 | Engine API + job runner + storage abstraction (ADR-1), MCP server skeleton, project/scenario/run/hooks/auth tools | L | todo |
| L3.2 | MCP render/review/export + theme & component tools | M | todo |
| L3.3 | Authoring: scenario_from_script + page_inspect | M | todo |
| L3.4 | Recorder (`studio record`, scenario_record) | M | todo |
| L3.5 | Themes from brand inputs and from a site URL | M | todo |
| L3.6 | Frame comments API (store, anchors, MCP tools) | S | todo |
| L3.7 | Claude skills (scenario, theme, component) + plugin packaging | S | todo |
| L3.8 | Phase 3 acceptance (Claude drives the whole loop through MCP) | M | todo |
| L4.1 | Studio app shell on the engine API (`studio ui`), projects, README editor | M | todo |
| L4.2 | Scenario as blocks (read) with run thumbnails | M | todo |
| L4.3 | Blocks editing, two-way YAML, drag & drop | M | todo |
| L4.4 | Run screen: live headless preview, steps, log, pause/stop | M | todo |
| L4.5 | Edit/verify timeline: tracks, component switching, Remotion Player | L | todo |
| L4.6 | Frame comments UI | M | todo |
| L4.7 | Component library + theme editor screens | M | todo |
| L4.8 | Record screen | M | todo |
| L4.9 | Studio acceptance, accessibility pass | S | todo |
| L5.1 | (see L1.5) macOS fixes found by the verification pass | S | todo |
| L5.2 | Tauri desktop shell (macOS) | M | todo |
| L5.3 | iOS Simulator runner (simctl, idb/XCUITest, touch overlay) | L | todo |
| L5.4 | Phase 5 acceptance | S | todo |
| L6 | V2 and later — everything outside the locked MVP is in `docs/BACKLOG.md` (unprioritised: collaboration, cloud runners, AI, marketplace, outputs, component candidates, licensing, packaging) | — | later |

## Lots

### L1.1 — Phase 1 polish + `studio doctor` (S)
- **Goal:** close the small phase-1 gaps found by the audit and give the user a way to check a Mac quickly.
- **Scope:** invented names in the fixture seed/scenarios/tests/README (R-ISS-10, R-PRIN-01); ripple always visible
  (contrasting ring + derived colour, R-ISS-03); scene-start cursor position configurable (`still: {seconds, cursor}`
  or a target) and auto rest point away from the first target, no visible teleport (R-ISS-04); widget events keep
  strategy/popup/bbox of every click (R-ISS-05); hook/env-reset journals move out of `runs/` (R-ISS-06); motion and
  ripple curves aligned with the field notes, popup fallback delay tuned (R-CHO-03/05/07/09/17); DOM snippet cap
  (R-KIT-10); project `locale` drives the browser locale (R-PROJ-08); missing hook files are errors when a project is
  known (R-VAL-06); new `studio doctor` (Chromium, ffmpeg, display, keychain, notifications, profile, fonts) + a
  `docs/MACOS-CHECKLIST.md` for L1.5.
- **Acceptance:** tests for each item; catalogue + quote re-captured and checked frame by frame (ripple visible on red
  buttons, no cursor jump at scene start); `studio doctor` output in the README.
- **Packages:** runner-web, core, cli, fixtures/wholesale, projects/northfield-fixture.

### L1.2 — Runner robustness for any site (M)
- **Goal:** make the runner work on arbitrary front-ends (SPEC §0).
- **Scope:** resolver pierces open shadow roots and same-origin iframes (R-ISS-07); full-page navigations never show
  loading frames: the recorder holds the last good frame and the timeline marks `loading` intervals (R-ISS-08);
  templating + secrets everywhere in steps with redaction in timeline/log/run.json (R-RUN-16/17); host policy for
  shell/js hooks decided and documented (R-SEC-06); choreography helpers: optional auto-park of the cursor after
  scrolls/results, calendar helpers (last-visible nav buttons, wait previous popover gone), adaptive typing rate,
  React-safe clear, menu trigger re-click and positional last resort (R-CHO-10/13/14/15/18/21/24).
- **Acceptance:** new fixture pages (web component with shadow DOM, iframe widget, full-page navigation) captured
  cleanly; tests per item.

### L1.3 — Capture smoothness under load (M, spike)
- **Goal:** smooth cursor motion even when the page renders slowly (R-ISS-01) and an exact cursor track (R-ISS-02).
- **Scope:** measure on the fixture; try (a) time-dilated capture — slow page animations (CDP Animation playback
  rate), runner motion ×k, encode ×k; (b) per-project "reduce heavy effects during capture" option; (c) beginFrame
  where available (R-ARCH-05); record the drawn cursor position from the overlay (paint time) instead of the dispatch
  time. Keep the option that gives ≥ 24 fps cursor motion without changing what the product looks like.
- **Acceptance:** catalogue capture with ≥ 24 fps during every cursor move (or a documented limit), cursor track
  within 2 px of the drawn cursor during motion (R-ACC-02).

### L1.4 — Coverage of untested options + automated fixture acceptance (M)
- **Goal:** every option of the scenario language is exercised by a test (R-ACT-*, R-CLK-*, R-TGT-07, R-MOD-*,
  R-KIT-06/11, R-REC-06, R-RUN-08 signals, R-CLI-05), scale 2 / 2560×1440 / mobile captures (R-GOAL-01, R-ARCH-06),
  `version` fields in persisted formats (R-PRIN-13), golden-image checks of the cursor and file chip (R-LOOK-23/24),
  Postgres tests run in CI-like conditions (R-LES-09, R-HOOK-07), and a slow-suite automated catalogue capture on the
  fixture (R-ACC-05).
- **Acceptance:** coverage table in REQUIREMENTS.md shows no "never exercised" item for phase 1.

### L1.5 — macOS verification pass (S, run by the user)
- **Goal:** verify what this Linux container cannot: headless capture while working, `studio login`, `--headed`,
  Keychain secrets, notifications, capture smoothness with a GPU (R-ISS-09, R-GOAL-08, R-ACC-04, R-CLI-09/10, R-ACT-28,
  R-SEC-02, R-PRIN-10).
- **How:** `pnpm i && pnpm build`, `studio doctor`, then the steps of `docs/MACOS-CHECKLIST.md`; findings go to L5.1.

### L1.6 — Sessions & personas (M) — scheduled after phase 2, before L3.1
- **Goal:** never film a login page and support several accounts (two-sided demos, split screen).
- **Scope:** `auth.personas` per environment (profile or storage state, `check`, optional `login` steps), pages/scenes
  bound to a persona, profiles outside git (~/.demo-studio/profiles/…), session preflight before every dry run and
  capture with the exact fix command, login-page detection during runs, optional automated off-camera login with
  redacted secret refs, `studio login --persona`, `studio auth status`, per-run session copies (parallel-safe),
  onboarding in `studio new` (R-AUTH-01..08).
- **Acceptance:** fixture gets a sign-in (two personas: supplier, buyer); an expired session is caught by the preflight;
  a run lands on login → explicit error; concurrent runs on one persona work.

### L1.7 — Display URLs, read-only & production safety, frozen clock (M) — after L1.6
- **Scope:** environment pages `{url, display}` (never localhost on screen); `production` + `access: read-only |
  read-write`; read-only enforced by request interception (block or mock mutating requests to the environment hosts,
  allow-list); writing hooks refused; writes in production need project opt-in + `--allow-writes`; access mode recorded
  and shown by review; frozen clock option (R-ENV-01..05).
- **Acceptance:** fixture run in read-only shows the flow with mocked writes and no data change on the server; the
  browser layout shows the display URL; two takes with a frozen clock show identical dates.

### L1.8 — Sandbox mode (L) — after L1.7, before L3.1
- **Scope:** `sandbox.yaml` manifest (docker-compose | process), `studio sandbox init|up|down|reset|status|logs`,
  health checks, seed and snapshot reset, demo accounts bound to personas (automated login), mailbox, sandbox exposed
  as an environment with display URLs, `studio run --sandbox`; the fixture shipped as a sandbox example
  (R-SBX-01..06).
- **Acceptance:** two consecutive `studio run --sandbox` takes produce the same data on screen; docker-compose path
  verified where a Docker daemon is available (else on the Mac).

### L2.1 — Phase-2 contracts in core (S)
- **Scope:** template `brand` + `components` map with legacy mapping (R-THM-01..03); scenario additions — intro/outro/
  interstitial component refs, `card` entries, `frame` as a layout id, step `overlay` (R-SCN2-01..06, R-SCN-07/08);
  overlay target bbox recorded by the runner; title/intro/outro carried into timeline.json (R-SCN-03); project frame
  default (R-PROJ-06); JSON Schemas regenerated.
- **Acceptance:** schema/validation tests with line numbers; fixture scenarios still valid; runner test for overlay bbox.
- **Done:** `ComponentKind`/`COMPONENT_KINDS`/`ComponentRef` live in core (re-exported by components); template `brand`
  + `components` and `resolveThemeComponents` (legacy mapping, warning on contradictions); scenario intro/outro/
  interstitial components, `card` entries, `frame` ids (`FrameSpec`), step `overlay`; runner records cards, overlay
  anchors measured at the end of the step (camera too, tested on the SPEC scroll example) and `timeline.video`;
  starter templates declare brand + components; quote fixture shows a card and an overlay (captured, bbox checked on
  the frame); JSON Schemas regenerated. 345 tests pass (6 Postgres tests skipped).

### L2.2 — Components package foundation (M)
- **Scope:** `@demo-studio/components`: manifest schema + validation, registry (workspace → built-in, did-you-mean,
  resolve with params defaults), `validateComponent` (schema, entry, params schema, preview samples, esbuild compile),
  `createComponent` scaffolds per kind, `themeTokens`, `kit` helpers (fades/rises/stagger, easing presets, fitText,
  Logo, Wordmark, background) (R-CMP-02..11, R-REG-01..12, R-DEC-03, R-CMT-01 type).
- **Acceptance:** unit tests; a scaffolded component validates and compiles.
- **Done:** `component.yaml` strict zod schema + `parseManifest` (positioned issues, id = folder, semver, slot
  sources, params JSON-Schema subset + defaults, preview samples, layout geometry in the design space) and
  `schema/component.schema.json` (`gen:schema`); `loadComponentRegistry` (studio.yaml `components_dir` → built-in
  `library/`, override warning, invalid folders as notices; `list`/`get` with did-you-mean/`resolve` with params
  defaults + validation/`resolveTheme`); `validateComponent` (manifest, entry, esbuild in-memory compile with an
  import allow-list, misspelt named imports of react/remotion/kit, Math.random/Date/network scan); 8 per-kind
  scaffolds (`scaffolds/<kind>/`, theme-driven, unit-sized, deterministic — rendered with Remotion in the editorial
  and motion themes and inspected) + `createComponent`; `themeTokens`; `fillSlots`; the kit
  (`@demo-studio/components/kit`: easing, frame-driven motion, fitText with balanced lines and ellipsis, Background,
  Logo, Wordmark, SafeArea, FitText, colour helpers); `studio components list|validate|create`; FrameComment type in
  core. R-ARCH-03 (remaining packages) moved to L5.3, the last lot that adds one.

### L2.3 — Edit planner (M)
- **Scope:** `planEdit` pure + deterministic: segment order and component precedence, scene source ranges, transitions
  vs contiguous joins, interstitial backdrop, speeds with ramps, 1× protected spans, idle trims, camera zooms (clamp,
  focus, easing, no reset at same-page joins, view clamping), captions, overlays positioning, provenance StepSpans,
  time map, overrides, notes/warnings (R-PLN-*, R-ED-02..09/15/22, R-THM-05).
- **Acceptance:** unit tests on the two real fixture timelines (copied as test fixtures) + synthetic edge cases.
- **Done:** `planEdit` (packages/editor/src/plan.ts, exported by `src/index.ts`), pure and deterministic: segments
  intro → scenes/cards/interstitials → outro; components by precedence (segment id override → kind override →
  scenario → theme via `registry.resolveTheme` → built-in default; unresolvable → next candidate with a warning, none →
  `missing` stand-in) with `fillSlots`; clips from the end of the page load (exact CFR `srcFrames`); contiguous
  same-page scenes planned as one "run" (no transition, camera continues); theme transitions elsewhere (crossfade with
  held last frame, fade-black halves, cut); interstitial backdrop; speeds (scene, `overrides.speeds`, step) with 1×
  protected spans (still, holds, ±0.6 s marks) and 0.3 s ramps; idle trims outside protected spans (> 1.2 s → 0.4 s);
  camera zooms from step hints (max_zoom clamp + note, bbox → point → cursor focus, hint ease else theme zoom_ease
  over max(0.8 s, duration) of output, step_end/scene_end/N s hold, view clamped); captions (scene, step, cues never
  overlap); overlays with source-px anchors + `mapSourceRect`; StepSpans, markers, time map; layout geometry from the
  manifest fitted to the capture; 1920×1080 × scale and the 1080×1920 vertical variant with a smoothed reframe track;
  music; every EditOverrides field; notes/warnings. Additive plan-type fields (PlanTransition, clip cues/layout/src/
  speeds/trims/zooms/heldFrames, OverlayUse.anchor, PlanLayout.crop, `missing`, `assets` with `ds-asset:` URLs +
  `resolvePlanAssets`, `meta`). `studio plan <project> <run|latest>` (summary, `--json`, `--out`, `--theme`,
  `--frame`, `--vertical`); README "Editing". 49 new tests (45 planner on the real catalogue/quote timelines in
  `packages/editor/test/fixtures/` + synthetic cases, 4 CLI); 476 tests pass (6 Postgres tests skipped). R-ED-22 stays
  partial (`motion.default_zoom` unused: zooms only from explicit hints).

### L2.4 — Render pipeline (M)
- **Scope:** `DemoVideo` composition rendering a plan (segments, fades, Freeze+OffthreadVideo, camera transform,
  captions/overlays/brandmark slots), generated component registry module, bundle cache, local asset server,
  `renderVideo` / `renderStill` / `listRenders`, RenderRecord + versioned names, silent audio, progress/abort/
  concurrency, `studio render` (R-RND-*, R-ED-01/18/19/23/24/25, R-CLI2-01, R-PRJ-01, R-PROJ-10, R-TPL-04).
- **Acceptance:** catalogue fixture rendered end to end with placeholder components; frames inspected.
- **Done:** placeholder built-in library `packages/components/library/studio/*` (the 18 ids of the starter themes and
  the legacy mapping, theme-driven, tag `placeholder`, params the themes pass, layouts draw exactly their declared
  geometry; validated + rendered in both themes by `packages/components/test/library.test.ts`); compositions
  `DemoVideo` / `DemoVertical` (`packages/editor/src/remotion/`: segments, transition windows — crossfade overlap, dip
  split ⌊n/2⌋ —, fade envelope fallback, layout with the capture under the camera, captions in the caption area,
  overlays through layout + camera, brand mark drawn by the composition, interstitial backdrop, music bed, FontFace +
  delayRender, scaffold stand-ins for `missing`); the capture frame is an `OffthreadVideo` in a shifted `Sequence`, not
  `Freeze` (Remotion clamps a frozen position to the composition length — the first catalogue render showed a frame 3 s
  early at the "Awards" zoom; regression-tested with a colour-coded capture); generated registry module + bundle cache
  (`.demo-studio/cache/remotion-<hash>/`); asset server (Range, CORS); `renderVideo` / `renderPlan` / `renderStill` /
  `listRenders` (RenderRecord, versions with locks, H.264 CRF 16 yuv420p BT.709 faststart, silent AAC, progress,
  AbortSignal, concurrency); `studio render` / `studio still`; README "Rendering". 513 tests pass (6 Postgres tests
  skipped). Fixture renders: catalogue 59.00 s in 3 m 38 s, quote 56.27 s in 2 m 59 s (concurrency 3, 4 CPUs); key
  frames inspected; R-PROJ-10 / R-PRJ-01 (review/ folder) moved to L2.6, R-TPL-04 (style_bias) to L2.5.

### L2.5 — Reference-look components (M)
- **Scope:** studio/intro-stack, outro-stack, layout-card, caption-below, interstitial-clock, transition-crossfade with
  the measured values of `docs/reference/look.md` (R-LIB-00/01/03/06/08/13/17, R-LOOK-01..22, R-THM-04/07,
  R-ED-11/16).
- **Acceptance:** stills compared with the reference measurements (positions within a few px); both themes
  (editorial, motion) render natively; Claude reviews the stills.
- **Done:** the six components rewritten (tag `reference-look`, 1.0.0; theme tokens only; text placed by its cap band
  with the new kit `fontMetrics` / `capTextLayout` / `<CapText>`; `biasMotion(style_bias)` for balanced/motion;
  wordmark = brand name in the display font without an image); layout geometry follows params through **geometry
  expressions** in component.yaml (params, `vars`, `aspect`; validated, evaluated by the planner per use, passed to the
  layout as `props.rects`) — layout-card width moves card + caption + brand mark; kit background "lighter at the top"
  fitted to the reference; editorial caption line 38 px; `renderStills` (one browser session); interstitial-plain
  `tone: paper` fixed for dark themes. Measured on real renders (`packages/editor/test/render-look.test.ts`: rule,
  card edges, caption, brand mark, logo rows, clock, texts within ≤ 3 px of look.md, motion at 0.4/1.0/1.3 s, width
  1400 on screen, half-size render, determinism); 540 tests pass (6 Postgres tests skipped). Fixture renders
  catalogue-v3 (59.00 s in 3 m 37 s) and quote-v3 (56.27 s in 2 m 58 s), compared side by side with the reference
  stills (notes in HANDOFF); R-LOOK-03/05 (review checks) moved to L2.6, R-LIB-00 to L2.7.

### L2.6 — Review package (M)
- **Scope:** `reviewRender`: contact sheets (paginated), per-scene sheets, key frames, output-time timeline, report.json
  + report.md, base64 thumbnails, every check of DESIGN-phase2 §3, diff vs previous render; `studio review`
  (R-REV-*, R-CLI2-02, R-GOAL-06); the look checks moved from L2.5: video 1–2 min / scenes 4–25 s, at most one slow
  zoom per video (R-LOOK-03/05).
- **Acceptance:** review of the L2.5 render; synthetic bad renders trigger each check.
- **Done:** `@demo-studio/review` — `reviewRender({project, render: id|path|latest, scenario?, fps?, previous?,
  thumbnails?, thumbnail_px?, rules?, out?})` → ReviewResult; writes `review/<render-id>/` (swapped in atomically):
  `sheet_<fps>fps.jpg` (+ pages shared evenly, ≤ 6×10 tiles; timecode, frame, segment/step/marker/transition labels;
  tiles outlined where a finding points), `sheet_scene_<id>.jpg` (2 fps, scenes/cards/interstitials), key frames
  (markers, scene first/last fully visible frame, intro/outro hold), output-time `timeline.json` (segments with
  components, captions, markers, step spans, transitions, zooms, overlays, clicks on the output), `report.json`,
  `report.md`, `diff_<previous>.jpg`; JPEG thumbnails ≤ 1280 px as base64. One ffmpeg pass per video (render, capture,
  previous render), sharp for tiles/sheets/key frames. Checks: durations (video 1–2 min: info within ±25 %, warning
  beyond; scenes 4–25 s info, < 2 s warning), long scenes at ~1×, blank / near-uniform screens (screen rect, transitions
  excluded, capture frame consulted), blank / loading scene starts, screen changing during the opening still,
  `long-wait` (unchanging screen ≥ 3 s while the scenario waits), empty cards, caption/scene mismatch, caption overlaps,
  captions too long (kit `fitText` + the theme's real font files), caption under the brand mark / not visible / missing,
  text slots over `max_chars`, cursor off screen / hidden / outside the zoomed view at clicks, zoom count, slow zooms,
  zoom resets at same-page joins, camera jumps, transitions over clicks, render status / probe / missing components,
  diff with the previous render (durations, plan changes, visibly changed frames at the same segment offset).
  `studio review` (+ `--fps`, `--previous`/`--no-previous`, `--scenario`, `--strict`, `--json`) and `studio render
  --review`; README "Reviewing a render". Fixture reviews: quote-v3 clean (info: 56.3 s), catalogue-v3 one warning
  (`long-wait`: 3.8 s of skeleton placeholders in add-product) + info (59.0 s; zoom 1.3× in 2.2 s not "very slow").
  572 tests (566 pass, 6 Postgres tests skipped).

### L2.7 — Layouts & previews (M)
- **Scope:** layout-browser (real URL from the timeline), laptop, phone, **tablet**, raw; caption-overlay; card-title;
  intro/outro-minimal; interstitial-plain; overlay-callout, lower-third; transition-fade-black — replacing the L2.4
  placeholders; their geometry as expressions over their params where it should follow them (the mechanism exists
  since L2.5: layout-card); previews generated per theme
  (R-LIB-02/04/05/07/09..12/14..16/18/19, R-ED-10/12/13/14, R-CMP-12/13/14); committed `preview.png` + README per
  component (all 18 existing included), `studio components preview`, staleness test.
- **Done:** the thirteen components rewritten in the reference family (1.0.0, no placeholder left; R-LIB-00): layouts
  browser (macOS window, real URL per frame from the clip's URL track, optional tabs, light/dark chrome), laptop
  (MacBook-style, CSS only), phone (iPhone-style: status bar + Dynamic Island above the capture, side buttons, caption
  beside), **tablet** (new: iPad-style, portrait with the caption beside / landscape with the caption below, from the
  capture aspect; frame style `tablet`), raw (edge to edge, caption over the bottom); caption-overlay (night-tone band
  over the capture, kicker + line, kit `captionBandBox` shared with the review), card-title, intro-/outro-minimal
  (`logo_only`), interstitial-plain (`tone`), overlay-callout (ring + pill + pointer, never off-screen: `placeCallout`
  property-tested), overlay-lower-third (inside the capture), transition-fade-black (black or night tone). Geometry
  expressions over params and `aspect` for every layout (device proportions clamped; a capture outside them is
  letterboxed with the theme background: `PlanLayout.display` / `LayoutRects.display`); captions and overlays receive
  the clip layout's `rects`; kit `cardShadow`, `deviceTones`, `SYSTEM_COLORS`, `addressParts`. Previews:
  `ComponentPreview` composition + `buildComponentPreview` (pure) + `renderComponentPreviews` (one bundle and browser,
  half-scale stills, ffmpeg palette when > 200 KB), neutral sample screens generated once from the fixture
  (`packages/components/preview/`, `scripts/preview-samples.mjs`), `studio components preview [id|--all] [--stale]
  [--workspace] [--theme] [--out]`, `create` renders the preview (`--no-preview`), committed preview.png +
  preview.json + README block for the 19 library components and 8 scaffolds, staleness test (source hash of manifest +
  entry + local imports). Also: the scene-cursor flake fixed at the root (the glide runs on a motion clock capped per
  tick: a loaded machine pauses the cursor, never makes it jump; fake-clock stall tests), the fixture shop made
  responsive (tablet 820 × 1180, phone 390 × 844: tabs nav, bottom-sheet dialogs, one-month calendar) with a
  `mobile-quote` scenario captured at phone size, `studio still --layout`, run lookup by exact scenario
  (`mobile-quote` is not a run of `quote`), a capture with zero frames now fails. Renders checked frame by frame:
  quote with browser / laptop / raw, mobile-quote with phone / tablet. 600 tests (594 pass, 6 Postgres tests skipped;
  the full suite green twice in a row).

### L2.8 — Variants & export (M)
- **Scope:** vertical 9:16 and square 1:1 with smoothed reframing on the cursor/targets, 4K from scale-2 captures,
  music bed with ducking, export formats mp4_1080p / mp4_4k / webm / vertical_9x16 / square / gif_preview,
  `studio export`; theme `default_zoom` for balanced/motion styles (R-ED-17/20/21/22, R-EXP-*, R-CLI2-03).
- **Done:** **square** variant (`geometry_square` manifest key + JSON schema, `variants: [landscape, vertical, square]`,
  `DemoSquare`, `--square`) next to vertical; every layout + the layout scaffold declare both formats (card / browser as
  tall as the format allows, a wider capture reframed to 4:5 / ≈ 4:3; devices keep their proportions; captions below or
  beside); **real reframing** (`camera.ts reframeTrack`): cursor (+ 0.4 s ahead) and step targets (0.5 s look-ahead),
  hard boxes for every click (widgets: each `data.clicks`) and overlay anchors, dead zone + re-centring, a calm start on
  the first step, critically damped zero-phase smoothing, then `corridorSmooth` (banded QP, critically damped repair:
  no ringing) so the cursor and the clicked target are never cut; crop ≥ 0.9 design px per CSS px; per run (never across
  a cut); the composition draws the crop (`object-fit: fill`), overlays map through it. Full-frame components use the
  kit `formatMetrics` (type ×1.2 in vertical) and captions wrap (`captionMaxLines`); caption-overlay bands go below the
  card in vertical / square. **4K**: the CDP screencast of headless Chromium (new and shell) and `captureScreenshot`
  stay at CSS size at deviceScaleFactor 2 (also with Emulation on the recorder session); `--force-device-scale-factor`
  at launch gives real 3840×2160 frames — kept (`scaleArgs`), measured ≈ 9.5–16 fps at 4K vs ≈ 45–58 fps at 1080p
  (captureScreenshot fallback: 5.6 fps), 2–3 fps under a backdrop-blur dialog; 4K render of a 1080p capture works
  with an upscaling warning. **Music bed**: `music: {file, volume, duck, loop}` / `--music`, planned plays (trim, or
  loops with equal-power 1 s seams; the track measured by renderVideo), smoothstep fades and ducking (× 0.5 under
  footage, base volume on intro/outro/cards), procedural test track `generateTestTrack`. **Export**: `exportRender` /
  `studio export` → `exports/<render-id>/` + manifest.json (1080p copy/scale, 4K copy/re-render, WebM VP9+Opus, GIF
  480 px 12 fps palette around the first marker, vertical / square re-rendered). **Theme default zoom** (R-ED-22,
  decision applied; the motion starter sets 1.12). Review: widget clicks one by one, `target-cut`,
  `cursor-outside-reframe`, `reframe-jump`, theme-zoom checks, a moving still compared on the capture. Previews
  regenerated. Tests: reframe.test.ts, planner-motion-music.test.ts, export-real.test.ts, review checks, runner scale-2
  capture, CLI export. Fixture renders quote-v9-vertical, quote-v10-square (motion theme), catalogue-v4 (music) and
  its six exports, frames inspected and reviewed (HANDOFF).

### L2.9 — Mails, notifications & documents (L)
- **Scope:** project `mailbox` (Mailpit or HTTP), `wait_for_email` capturing the message and an image of its HTML;
  `download` capturing files from download events or new-tab documents with the session, PDFs rasterised with pdf.js
  in Chromium; captured artefacts referenced by components (`email: <name>`, `document: <name>` or a project file);
  components `studio/notification` (5 styles, scenario-filled), `studio/mail-notification`, `studio/mail-view`,
  `studio/document-pdf`, `studio/phone-lockscreen` (stacked notifications), `studio/phone-home-badge`; capture of the
  product's web notifications; "tap to open" transition; fixture: sign-up with a confirmation email, a real quote PDF
  and a web notification (R-MAIL-*, R-DOC-*, R-NTF-*).
- **Acceptance:** a fixture scenario captures an email, a PDF and a web notification and renders each component;
  frames reviewed.
- **Done:** core `mailbox` (Mailpit or generic HTTP JSON, host in the allow-list — helpers moved to core `hosts.ts`),
  actions `wait_for_email` (baseline at run start, oldest new matching message, `artefacts/emails/<as>.json` + the HTML
  rendered sandboxed at 600 px × 2) and `download` (real click; download event or new tab fetched with the session;
  `artefacts/documents/<as>.<ext>`, PDFs rasterised with pdfjs-dist 5.4.296 in a clean Chromium at 2× A4 →
  `documents/<as>/page-<n>.png`); project files as documents; **web notifications** captured by the kit
  (`new Notification`, `showNotification`; permission granted, binding) → artefact + timeline event; `timeline.artefacts`.
  Slots `email:` / `document:` / `notification:` checked (unknown names with a suggestion) and resolved by the planner
  into a serialisable `media` prop (images as plan assets; warnings when a run lacks them). Components (kit
  `notifications.tsx`, `phone.tsx`): `studio/notification` (macos | windows | ios-banner | android | in-app),
  `studio/mail-notification`, `studio/mail-view`, `studio/document-pdf`, `studio/phone-lockscreen`,
  `studio/phone-home-badge`, `studio/transition-tap-open` (scene/card `transition: <component>`, anchor from the
  outgoing overlay or card via manifest `anchor` expressions) — previews committed. Fixture: sign-up + confirmation
  email in a built-in Mailpit-compatible API, real quote PDF (Chromium `page.pdf`), console web notification; scenario
  `signup` (new) and `quote` (download + document card + captured notification). Renders signup-v4 and quote-v13
  reviewed, frames of every new component inspected (HANDOFF).

### L2.10 — Tutorial overlays & story cards (L)
- **Scope:** automatic overlays from the timeline — keyboard shortcut, spotlight, numbered steps, typing loupe,
  chapter progress bar — and cards — key figure (animated counter; `capture_text` action), feature list, before/after
  wipe, testimonial, final CTA with QR code, animated chart from data/CSV (R-TUT-*, R-STO-*).
- **Acceptance:** each enabled on the fixture videos and reviewed in both themes.
- **Done:** core `tutorial` switches on scenario / scene / step (`true`, `false`, a mode, `{component?, params?}`; most
  specific wins; `progress` scenario-only), copied by the runner into the timeline (the editor never reads the
  scenario); action `capture_text: {target, as, pattern?}` → `text` artefact; runner records `type` timing + the
  focused field of a `type` without `into`, `press` keys. Planner (editor `tutorial.ts`, pure, `TUTORIAL_TIMING`):
  shortcut caps on the real key press, a spotlight per run of steps gliding from target to target (screen layer, under
  caption and overlays), badges beside clicked targets, one loupe gliding from field to field (rendered from the
  capture itself, ≥ 1.5 px per CSS px), a chapter bar between intro and outro; reframe keeps tutorial targets in view;
  what cannot be shown → plan warning + review `tutorial-skipped`. Story-card slot types `capture`, `frame` (mark,
  scene start / end, time, image file), `data` (CSV / TSV) and image files, read before planning (`planInputFiles`)
  and resolved into `media`. Components (kit `keys`, `figures`, `qr`, `icons`, `picture`, `place`):
  `studio/overlay-shortcut`, `overlay-spotlight`, `overlay-steps`, `overlay-loupe`, `overlay-progress`, `card-figure`,
  `card-features`, `card-before-after`, `card-testimonial`, `card-cta` (local QR encoder, module-for-module equal to
  the `qrcode` package, dev-only), `card-chart` — previews committed. Review: `tutorial-skipped`,
  `tutorial-target-cut`, `media-missing`; the opening still is compared on capture frames under an overlay or a caption
  over the screen. CLI `render --tutorial | --no-tutorial`. Fixture: `signup` with every tutorial overlay (⌘K search
  added to the shop), new `highlights` (every story card, `capture_text` of the proposal total, a CSV). Renders
  signup-v7 / v12 (editorial), signup-v8-vertical, signup-v11 (motion; v9–v10 had the key caps over the caption band,
  then over the lens → overlays get `avoid`, the loupe keeps one side), highlights-v1 (editorial), highlights-v2
  (motion): reviews clean, frames of every overlay and card looked at (HANDOFF).

### L2.11 — Multi-page capture: split screen & picture in picture (M)
- **Scope:** the runner records two pages on one clock (e.g. supplier + buyer, or desktop + mobile viewport); timeline
  tracks per page; scenario syntax for parallel pages; layouts `studio/layout-split` and `studio/layout-pip` planned
  and rendered in sync (R-MPC-*).

### L2.12 — Bring your own media & motion (M)
- **Scope:** any segment can be a user video/image file; transparent overlay videos (ProRes 4444 / WebM alpha); Lottie
  component (card/overlay); "bring your own motion" docs (files, Lottie, custom Remotion components, output of any
  Claude motion skill) (R-OWN-*). Templates are never mandatory.

### L2.13 — Raw capture export for editors (M)
- **Scope:** `studio export-capture` / `run --raw`: clean clip per scene (loads cut), MP4 HQ or ProRes 422 HQ, 30/60 fps;
  cursor baked / absent + cursor & clicks as data / separate transparent cursor layer; markers as FCPXML, EDL, OTIO,
  CSV/JSON; package manifest (R-RAW-*). Use case: script and film with Demo Studio, edit in another tool.

### L2.14 — Phase 2 acceptance (S)
- **Scope:** render catalogue + quote with the editorial theme, clean review, contact-sheet review by Claude, switch a
  component and the theme without touching the scenario (R-ACC2-*, R-GOAL-05, R-LES-10, R-CMP-01); one video with a user intro file and an alpha overlay; one raw export
  imported checks (FCPXML/OTIO validate); README update.
- **Mac handoff:** root `CLAUDE.md` (points to `docs/HANDOFF.md`, working agreement, commands); HANDOFF gains
  "Mac setup" (Node ≥ 22, pnpm, ffmpeg, Chromium for playwright-core, Docker later, Xcode for phase 5) and "First
  local session" (L1.5 checklist first); every helper used in the cloud session lives in the repo; branch ready to
  merge.

### L3.1 – L3.8, L4.1 – L4.9, L5.x, L6
Scopes are listed per requirement in REQUIREMENTS.md (`--lot`); they will be detailed here when phase 2 is done, with
the same structure (goal, scope, acceptance, packages, size). Key contracts already written: SPEC §8 (MCP tools),
§11 (components), §12 (Studio app), DESIGN-phase2 §4 (frame comments), the canvas mock-ups (screens 1–7) and
`docs/design-brief.md`.
