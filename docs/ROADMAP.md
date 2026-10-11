# Roadmap — small lots

Every requirement of the brief is tracked in `docs/requirements.json` (source of truth) and rendered in
`docs/REQUIREMENTS.md`; each one belongs to exactly one lot below. `node scripts/requirements.mjs --lot L2.3` lists the
requirements of a lot with their gaps.

## Working agreement
- **One lot at a time**, sized to stay readable and cheap: S ≈ 0.3–0.5 M tokens, M ≈ 0.6–1.0 M, L ≈ 1.0–1.6 M
  (reference: phase 1 took ≈ 2.5 M across 6 agents; the spec audit ≈ 0.65 M).
- A lot ends with: build + full test suite green, the lot's acceptance checked (tests, real runs, frames looked at),
  `docs/requirements.json` statuses/evidence updated (`node scripts/requirements.mjs`), `docs/HANDOFF.md` updated,
  one commit pushed to the working branch, and a short report (what was done, verification, consumption, next lot).
- The user picks how many lots to chain. Never start the next lot without that go.
- The tool stays generic: no client/brand/person names in code, docs, fixtures, templates or test data.

## Status

| Lot | Title | Size | Status |
|---|---|---|---|
| P1 | Phase 1 — core, runner-web, hooks, CLI, fixture, starter templates | — | **done** (commit `0df4a29`) |
| L1.1 | Phase 1 polish + `studio doctor` | S | **done** |
| L1.2 | Runner robustness for any site | M | todo |
| L1.3 | Capture smoothness under load (spike) | M | todo |
| L1.4 | Coverage of untested options + automated fixture acceptance | M | todo |
| L1.5 | macOS verification pass (run by the user on a Mac) | S | todo |
| L2.1 | Phase-2 contracts in core (themes pick components, scenario additions) | S | **done** |
| L2.2 | Components package: registry, validation, scaffolding, kit helpers | M | next |
| L2.3 | Edit planner (pure, unit-tested) | M | todo |
| L2.4 | Render pipeline (Remotion bundle, asset server, `studio render`) | M | todo |
| L2.5 | Reference-look components (intro, outro, card layout, caption, clock, crossfade) | M | todo |
| L2.6 | Review package + `studio review` | M | todo |
| L2.7 | Library completion (browser/laptop/phone/raw, cards, overlays, previews per theme) | M | todo |
| L2.8 | Variants & export (vertical 9:16, 4K, music bed, export formats) | M | todo |
| L2.9 | Phase 2 acceptance (two videos, clean review, theme/component switch) | S | todo |
| L3.1 | MCP server skeleton, job runner, project/scenario/run/hooks tools | M | todo |
| L3.2 | MCP render/review/export + theme & component tools | M | todo |
| L3.3 | Authoring: scenario_from_script + page_inspect | M | todo |
| L3.4 | Recorder (`studio record`, scenario_record) | M | todo |
| L3.5 | Themes from brand inputs and from a site URL | M | todo |
| L3.6 | Frame comments API (store, anchors, MCP tools) | S | todo |
| L3.7 | Claude skills (scenario, theme, component) + plugin packaging | S | todo |
| L3.8 | Phase 3 acceptance (Claude drives the whole loop through MCP) | M | todo |
| L4.1 | Studio app shell + local API (`studio ui`), projects, README editor | M | todo |
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
| L6 | V2 — marketplace, licensing, packaging | — | later |

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

### L2.3 — Edit planner (M)
- **Scope:** `planEdit` pure + deterministic: segment order and component precedence, scene source ranges, transitions
  vs contiguous joins, interstitial backdrop, speeds with ramps, 1× protected spans, idle trims, camera zooms (clamp,
  focus, easing, no reset at same-page joins, view clamping), captions, overlays positioning, provenance StepSpans,
  time map, overrides, notes/warnings (R-PLN-*, R-ED-02..09/15/22, R-THM-05).
- **Acceptance:** unit tests on the two real fixture timelines (copied as test fixtures) + synthetic edge cases.

### L2.4 — Render pipeline (M)
- **Scope:** `DemoVideo` composition rendering a plan (segments, fades, Freeze+OffthreadVideo, camera transform,
  captions/overlays/brandmark slots), generated component registry module, bundle cache, local asset server,
  `renderVideo` / `renderStill` / `listRenders`, RenderRecord + versioned names, silent audio, progress/abort/
  concurrency, `studio render` (R-RND-*, R-ED-01/18/19/23/24/25, R-CLI2-01, R-PRJ-01, R-PROJ-10, R-TPL-04).
- **Acceptance:** catalogue fixture rendered end to end with placeholder components; frames inspected.

### L2.5 — Reference-look components (M)
- **Scope:** studio/intro-stack, outro-stack, layout-card, caption-below, interstitial-clock, transition-crossfade with
  the measured values of `docs/reference/look.md` (R-LIB-00/01/03/06/08/13/17, R-LOOK-01..22, R-THM-04/07,
  R-ED-11/16).
- **Acceptance:** stills compared with the reference measurements (positions within a few px); both themes
  (editorial, motion) render natively; Claude reviews the stills.

### L2.6 — Review package (M)
- **Scope:** `reviewRender`: contact sheets (paginated), per-scene sheets, key frames, output-time timeline, report.json
  + report.md, base64 thumbnails, every check of DESIGN-phase2 §3, diff vs previous render; `studio review`
  (R-REV-*, R-CLI2-02, R-GOAL-06).
- **Acceptance:** review of the L2.5 render; synthetic bad renders trigger each check.

### L2.7 — Library completion (M)
- **Scope:** layout-browser (real URL), laptop, phone, raw; caption-overlay; card-title; intro/outro-minimal;
  interstitial-plain; overlay-callout, lower-third; transition-fade-black; previews generated per theme
  (R-LIB-02/04/05/07/09..12/14..16/18, R-ED-10/12/13/14, R-CMP-12/13).

### L2.8 — Variants & export (M)
- **Scope:** vertical 9:16 with smoothed reframing, 4K from scale-2 captures, music bed with ducking, export formats
  mp4_1080p / mp4_4k / webm / vertical_9x16 / gif_preview, `studio export` (R-ED-17/20/21, R-EXP-*, R-CLI2-03).

### L2.9 — Phase 2 acceptance (S)
- **Scope:** render catalogue + quote with the editorial theme, clean review, contact-sheet review by Claude, switch a
  component and the theme without touching the scenario (R-ACC2-*, R-GOAL-05, R-LES-10, R-CMP-01); README update.

### L3.1 – L3.8, L4.1 – L4.9, L5.x, L6
Scopes are listed per requirement in REQUIREMENTS.md (`--lot`); they will be detailed here when phase 2 is done, with
the same structure (goal, scope, acceptance, packages, size). Key contracts already written: SPEC §8 (MCP tools),
§11 (components), §12 (Studio app), DESIGN-phase2 §4 (frame comments), the canvas mock-ups (screens 1–7) and
`docs/design-brief.md`.
