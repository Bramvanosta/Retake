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
  one commit pushed to `main`, and a short report (what was done, verification, consumption, next lot).
- The user picks how many lots to chain. Phases 1 and 2 were built autonomously in a cloud session (through L2.14,
  2026-10-12). The work now continues in a local Claude Code session on the user's Mac, on the `main` branch (root
  `CLAUDE.md`, `docs/HANDOFF.md` "Mac setup" / "Order of the next lots"): L1.5 done (2026-10-12: macOS verification;
  it narrowed L1.3 and filled L5.1), L5.1 done (2026-10-12); then, as the user asked: L1.3 (done 2026-10-12) → L1.2
  (done 2026-10-13) → L1.6 (done 2026-10-13) → L1.7 (done 2026-10-13) → L1.8 (done 2026-10-14) → L1.4 (done 2026-10-17), stopping before phase 3 (L3.1).
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
| L1.2 | Runner robustness for any site | M | **done** |
| L1.3 | Capture smoothness: stalls after scrolls and at dialog close (narrowed by L1.5) | M | **done** (2 partial: dialog close with a blur — an option fixes it —, hover hitches) |
| L1.4 | Coverage of untested options + automated fixture acceptance | M | **done** |
| L1.5 | macOS verification pass (run by the user on a Mac) | S | **done** (1 open: R-RAW-06, no editing tool on the Mac) |
| L1.6 | Sessions & personas (profiles, preflight, auth status, optional automated login, onboarding) — after phase 2, before L3.1 | M | **done** |
| L1.7 | Display URLs, read-only & production safety, frozen clock — after L1.6 | M | **done** |
| L1.8 | Sandbox mode (manifest, docker-compose & process providers, seed/reset/snapshot) — after L1.7, before L3.1 | L | **done** |
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
| L2.11 | Multi-page capture: split screen & picture in picture | M | **done** |
| L2.12 | Bring your own media & motion (video/image segments, alpha overlays, Lottie, docs) | M | **done** |
| L2.13 | Raw capture export for editors (clips per scene, ProRes, cursor data/layer, FCPXML/EDL/OTIO markers) | M | **done** |
| L2.14 | Phase 2 acceptance (videos, clean review, theme/component switch, own media, raw export) + Mac handoff | S | **done** — phase 2 done |
| L3.1 | Engine API + job runner + storage abstraction (ADR-1), MCP server skeleton, project/scenario/run/hooks/auth tools | L | **done** (live Claude Code run: MACOS-CHECKLIST 12c) |
| L3.2 | MCP render/review/export + theme & component tools | M | **done** (live run: MACOS-CHECKLIST 12d) |
| L3.3 | Authoring: scenario_from_script + page_inspect | M | **next** |
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
| L5.1 | Fixes found by the macOS verification pass (L1.5): Node guard, starter templates, scene rest points… | S | **done** |
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
- **Done (2026-10-13):** targets in open shadow roots and same-origin iframes (all in the top kit, top-level px);
  full-page loads held until the new page paints (`timeline.loading`, cut in the edit, `navigation` cuts in the raw
  export; no blank frame left in the fixture captures); every scenario string templated, `{{env:…}}` /
  `{{keychain:…}}` secrets resolved before the browser opens and redacted by path policy from every run file; shell
  and js hooks host-checked (js in a guarded tab, shell scripts read command by command, the unseen cases listed in the
  README / BL-57); `date` action, opt-in `park`, adaptive typing rate, robust `clear`, menu re-click and trigger
  fallbacks. Auto-park is opt-in per step (a scenario-wide switch went to BL-58). Fixture: `embedded`, `reports`
  scenarios. Reviewed by four independent reviewers, ≈ 40 findings fixed with regression tests.

### L1.3 — Capture smoothness under load (M, spike)
- **Goal:** smooth cursor motion even when the page renders slowly (R-ISS-01) and an exact cursor track (R-ISS-02).
- **Scope:** measure on the fixture; try (a) time-dilated capture — slow page animations (CDP Animation playback
  rate), runner motion ×k, encode ×k; (b) per-project "reduce heavy effects during capture" option; (c) beginFrame
  where available (R-ARCH-05); record the drawn cursor position from the overlay (paint time) instead of the dispatch
  time. Keep the option that gives ≥ 24 fps cursor motion without changing what the product looks like.
- **Acceptance:** catalogue capture with ≥ 24 fps during every cursor move (or a documented limit), cursor track
  within 2 px of the drawn cursor during motion (R-ACC-02).
- **Decision after L1.5 (2026-10-12):** on a GPU Mac the slow rendering this spike was written for is gone (≈ 60
  frames/s while the cursor moves, 57–75 over blurred dialogs, 42 of 43 moves ≥ 24 fps, the drawn cursor within 2 px
  of the track in 94 % of moving frames). Time dilation, the reduce-effects option and beginFrame are dropped for the
  local tool (R-ARCH-05 moved to L6). **Narrowed scope:** the stalls the Mac still shows — scripted scrolls and the
  first move after them (R-ISS-11: 0.14–0.43 s frozen, then a jump of up to 329 px), every animated dialog close
  (R-ISS-12: ≈ 0.26 s, the ripple freezes then vanishes), a motion check that sees them (R-ISS-13: longest frame gap during the motion), and the renderer pause on a
  hover-in (R-ISS-02). Acceptance: catalogue and quote on the Mac with no stall over 100 ms during motion or a ripple.
- **Done (2026-10-12):** after a scroll the resting cursor probes the capture with 1 px nudges until frames flow
  again (no stall after a scroll left); before a press the runner waits until a captured frame shows the cursor's last
  move; the motion check judges the motion itself and warns on stalls ≥ 150 ms (shorter hitches are noise). The
  dialog-close stall (≈ 0.26 s when a `backdrop-filter` element goes away, Chromium's frame rate limiter on) stays by
  default: `browser.frame_rate_limit: false` removes it but runs the page's rAF at thousands of Hz (2–6× CPU), so it
  is an option the warning points to (R-ISS-12 partial). Acceptance with the defaults: quote and catalogue twice —
  84 of 84 moves ≥ 24 fps, no stall in a move or after a scroll, dialog closes 186–264 ms during the ripple (warned);
  with the option: no dialog-close stall, one 192 ms hover hitch (R-ISS-02, a documented limit). The raw export's cut
  resume got a 0.2 s floor (new content reaches the screen up to ≈ 0.2 s after its DOM).

### L1.4 — Coverage of untested options + automated fixture acceptance (M)
- **Goal:** every option of the scenario language is exercised by a test (R-ACT-*, R-CLK-*, R-TGT-07, R-MOD-*,
  R-KIT-06/11, R-REC-06, R-RUN-08 signals, R-CLI-05), scale 2 / 2560×1440 / mobile captures (R-GOAL-01, R-ARCH-06),
  `version` fields in persisted formats (R-PRIN-13), golden-image checks of the cursor and file chip (R-LOOK-23/24),
  Postgres tests run in CI-like conditions (R-LES-09, R-HOOK-07), and a slow-suite automated catalogue capture on the
  fixture (R-ACC-05).
- **Acceptance:** coverage table in REQUIREMENTS.md shows no "never exercised" item for phase 1.
- **Done (2026-10-17):** every listed option exercised by a test that fails when it is ignored; 2560×1440, 4K and
  mobile captures; cursor and file-chip goldens with structural checks; signals on the built CLI; `version: 1` on the
  persisted formats (+ run.json engine); `pnpm test:pg` and `pnpm test:slow` (automated catalogue capture); the
  generated "Never exercised" section is empty for phase 1 (`node scripts/requirements.mjs --untested 1`). Fixed on the
  way: `wait_for: {network_idle}` after the first idle, and four cancel / teardown bugs.

### L1.5 — macOS verification pass (S, run by the user)
- **Goal:** verify what this Linux container cannot: headless capture while working, `studio login`, `--headed`,
  Keychain secrets, notifications, capture smoothness with a GPU (R-ISS-09, R-GOAL-08, R-ACC-04, R-CLI-09/10, R-ACT-28,
  R-SEC-02, R-PRIN-10).
- **How:** `pnpm i && pnpm build`, `studio doctor`, then the steps of `docs/MACOS-CHECKLIST.md`; findings go to L5.1.
- **Done (2026-10-12):** every step ran on an Apple M4 (results table at the end of `docs/MACOS-CHECKLIST.md`); step 7
  found stalls after scrolls and at dialog close (→ L1.3) and scene-start defects (→ L5.1); the imports into editing
  tools were skipped (none installed: R-RAW-06 stays partial; the package validates with OpenTimelineIO). Blocking Mac issues fixed in the lot (ffmpeg 9, symbolic-link paths, case-insensitive test fixture,
  a font-sensitive look test; R-MAC-01/02); the rest went to L1.3 (narrowed) and L5.1.

### L1.6 — Sessions & personas (M) — scheduled after phase 2, before L3.1
- **Goal:** never film a login page and support several accounts (two-sided demos, split screen).
- **Scope:** `auth.personas` per environment (profile or storage state, `check`, optional `login` steps), pages/scenes
  bound to a persona, profiles outside git (~/.demo-studio/profiles/…), session preflight before every dry run and
  capture with the exact fix command, login-page detection during runs, optional automated off-camera login with
  redacted secret refs, `studio login --persona`, `studio auth status`, per-run session copies (parallel-safe),
  onboarding in `studio new` (R-AUTH-01..08).
- **Acceptance:** fixture gets a sign-in (two personas: supplier, buyer); an expired session is caught by the preflight;
  a run lands on login → explicit error; concurrent runs on one persona work.
- **Done (2026-10-13):** `auth.personas` per environment (profile or storage_state, check, sign-in patterns, optional
  `login:` steps), pages / scenes bound to a persona (`none` for public pages), masters and snapshots under
  `~/.demo-studio` (never in project.yaml or git; doctor warns), one browser per persona on a per-run copy (parallel
  runs safe, nothing written back — BL-59), preflight before every dry run and capture (automated off-camera login,
  else the exact `studio login` command), a sign-in guard that fails the run and keeps nothing, `studio login --persona
  [--auto]`, `studio auth status [--check]`, interactive `studio new`. Fixture: signed-in side (:4403 / :4404, env
  `signed-in`, personas supplier and buyer); every acceptance item checked on the Mac. A headed sign-in typed by a
  person is the user's MACOS-CHECKLIST step 8b.

### L1.7 — Display URLs, read-only & production safety, frozen clock (M) — after L1.6
- **Scope:** environment pages `{url, display}` (never localhost on screen); `production` + `access: read-only |
  read-write`; read-only enforced by request interception (block or mock mutating requests to the environment hosts,
  allow-list); writing hooks refused; writes in production need project opt-in + `--allow-writes`; access mode recorded
  and shown by review; frozen clock option (R-ENV-01..05).
- **Acceptance:** fixture run in read-only shows the flow with mocked writes and no data change on the server; the
  browser layout shows the display URL; two takes with a frozen clock show identical dates.
- **Done (2026-10-13):** environment pages `{url, display}` (display URLs are edit-time data; a local URL is never
  drawn, reports never name one); long-form environments with `production`, `access`, `read_only: {hosts, allow,
  mocks}`; read-only enforced in every persona context (writes mocked or stopped, production fail-closed on every host,
  keepalive / beacon / fetchLater / SharedWorker / service-worker paths covered), writing hooks refused, production
  writes only with `access: read-write` + `--allow-writes`, hosts of read-only environments protected from any run;
  access mode and writes in run.json / timeline / run summary / review; `clock:` (Date-only: the product's timers and
  animations stay real — a deviation from "Playwright clock API", whose fake timers slowed product animations). The
  Studio app confirmation is phase 4 (BL-66). Every acceptance item checked on the Mac.

### L1.8 — Sandbox mode (L) — after L1.7, before L3.1
- **Scope:** `sandbox.yaml` manifest (docker-compose | process), `studio sandbox init|up|down|reset|status|logs`,
  health checks, seed and snapshot reset, demo accounts bound to personas (automated login), mailbox, sandbox exposed
  as an environment with display URLs, `studio run --sandbox`; the fixture shipped as a sandbox example
  (R-SBX-01..06).
- **Acceptance:** two consecutive `studio run --sandbox` takes produce the same data on screen; docker-compose path
  verified where a Docker daemon is available (else on the Mac).
- **Done (2026-10-14):** `sandbox.yaml` (version 1; process | docker-compose services with pages, display URLs and
  health; seed steps; reset by reseed or Postgres template-clone snapshot; demo accounts as personas with automated
  login; mailbox; databases), declared per environment in project.yaml; new package `@demo-studio/sandbox`; `studio
  sandbox init | up | down | reset | status | logs`; `studio run --sandbox` (every take from the same state); the
  fixture as a process and a Docker sandbox (Mailpit through an SMTP relay). Two takes with a mutation between them
  read the same data on both providers (Mac, OrbStack). Data-safety rules (loopback only, owned databases and
  mailboxes, compose folder and port ownership, pid + start + boot identity) reviewed and tested.

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
- **Done:** scenario `pages:` (map or list; environment pages, `open: "page:/path"`, viewport presets desktop / laptop /
  tablet / mobile or `{width, height, mobile?, touch?}`, labels, per-page `cursor`) and step `on: <page>`, validated
  with positions (core `pages.ts`, checks, schemas). Runner: every page of the scene recorded at the same time — one
  CDP screencast per page on the run's clock, each encoded on the shared CFR grid as `capture-<page>.mp4` (same frame
  count as `capture.mp4`); viewports emulated per page (persistent CDP session: device metrics, touch, mobile UA); one
  in-page cursor per page (only the acting page's moves; `pacing.page_switch_ms` pause, then a glide — no teleport);
  timeline `tracks[]`, `scenes[].pages`, `events[].page`; single-page scenes unchanged. Planner (`panes.ts`):
  `plan.tracks`, clip `panes` (per-pane fit, camera, reframe, URLs) on one time map, `acting`, PiP `inset` track
  (never over the main page's current or next target, glides between corners, grows while its page acts with the
  theme's emphasis), automatic split / pip, theme-dressed layouts, layout geometry `panes` / `inset` / `aspect2`;
  tutorial overlays on their page's pane; a caption band over the screen goes below a split; main-page overlays pass
  under the inset. Components `studio/layout-split`, `studio/layout-pip` (+ kit `panes.tsx`), previews committed.
  Carry-over polish: overlays keep clear of the current and next click targets (`clear` → `avoid`, caps' other row),
  the loupe cross-fades between fields instead of panning, review `overlay-covers-target`; per-pane review checks.
  Fixture: live list in the console and the shop's quotes (1 s poll, "New" pill), scenarios `live-quote` (split) and
  `phone-and-desktop` (pip) with step badges. **Review fixes** (code + video review): badges numbered in time order
  over both pages; the acting page from the scene's start; the inset glides after its own step, keeps its badges
  inside it, its caps / lens clear of the main page's targets, never grows into a caption band; an idle page's cursor
  rests near its centre (never under an inset); viewport mismatches validated with positions; `open` on a page id keeps
  the environment's base path; reframe: a wide target by its leading part, a leading-edge start, no pan for a resting
  cursor, idle panes settle on their page's heading; a click that navigates ends its spotlight run and badge (review
  `tutorial-stale-target`); the fixture shop's bell polls (both hand-offs live). Renders (runs
  20261012-073840-live-quote, 20261012-080444-phone-and-desktop): live-quote-v7 (editorial), v8 (motion),
  v9-vertical; phone-and-desktop-v9 (editorial), v10 (motion), v11-vertical; signup-v14 (motion) — reviewed (only the
  `video-length` warning; signup-v14 clean), frames at every acting switch, click, hand-off and overlay looked at
  (HANDOFF).

### L2.12 — Bring your own media & motion (M)
- **Scope:** any segment can be a user video/image file; transparent overlay videos (ProRes 4444 / WebM alpha); Lottie
  component (card/overlay); "bring your own motion" docs (files, Lottie, custom Remotion components, output of any
  Claude motion skill) (R-OWN-*). Templates are never mandatory.
- **Done:** `intro`, `outro`, `card`, `interstitial` take your own file — `{video | image | lottie, from, to, fit,
  background, volume, duration}` — and a theme can name files for its intro / outro / interstitial (no component is
  mandatory). Files are drawn by two built-in components usable as several kinds (manifest `kinds`, `props.as`):
  `studio/media` (video, image; `fit: auto` keeps a 16:9 file whole in the vertical variant) and `studio/lottie`
  (`@remotion/lottie` 4.0.534 + `lottie-web`, theme colours replacing the file's via `colors`), previews committed.
  Step `overlay` takes a file over the capture — `{video | image | lottie, at: step | start | click | mark:<name> |
  seconds, anchor: target | cursor | screen | corner… | rect, scale, duration, loop}` — mapped through layout, camera
  and reframe; ProRes 4444 and VP9-alpha videos composite (pixel test: no halo). Positioned validation with ffprobe
  (missing file, extension / container, codec, `from` / `to` past the end, overlay without alpha, volume on a silent
  file). Audio: the file's own sound at `volume`, a silent file stays silent, the music bed ducks under files with
  sound; the render record says `audio: files | music+files`. Docs `docs/BRING-YOUR-OWN-MOTION.md` (export settings
  for motion tools and Remotion, Lottie, workspace components — `studio components new` —, output of Claude motion /
  design skills), linked from the README. Fixture: generated media (`scripts/fixture-media.mjs`: Remotion renders,
  hand-written Lottie JSON, each < 300 KB) and scenario `own-media` (user intro video with sound, outro image, alpha
  burst on the clicked button, Lottie card, Lottie check overlay; 46 s). **Catalogue `long-wait` fixed at the root
  cause:** waiting (wait steps and the load pause before them) plays at up to 4× after its first 0.5 s, marked waits
  protect only the moment the state appears (R-OWN-05) — catalogue-v5 reviews clean. **Review fixes:** a file's own
  sound no longer dips and clicks where the next transition begins (its ramps from the video element's own frame, end
  ramp applied); the vertical / square reframe keeps a step overlay's real box over the time it really shows (`at`,
  its own length); a file at a corner moves to the nearest free corner when a variant's framing would put it over the
  step's target (plan note; the review's `overlay-covers-target` now measures user files); a kind-wide overlay
  override keeps user files; a missing file is not a plan asset; `trim_idle: false` restores a marked wait's whole
  1× window. Renders (run 20261012-093815-own-media): own-media-v6 (editorial + music), v7 (motion + music),
  v8-vertical; catalogue-v5 (run 20261012-093047-catalogue) — all reviewed clean; frames at every segment boundary,
  inside the intro / outro, during the alpha burst (full-resolution crops) and the Lottie card / overlay looked at,
  intro audio measured sample by sample against the source (HANDOFF).

### L2.13 — Raw capture export for editors (M)
- **Scope:** `studio export-capture` / `run --raw`: clean clip per scene (loads cut), MP4 HQ or ProRes 422 HQ, 30/60 fps;
  cursor baked / absent + cursor & clicks as data / separate transparent cursor layer; markers as FCPXML, EDL, OTIO,
  CSV/JSON; package manifest (R-RAW-*). Use case: script and film with Demo Studio, edit in another tool.
- **Done:** `studio export-capture <project> <run|latest>` and `studio run … --raw` (runner-web `src/raw/`,
  `exportCapture`) → `exports/<run>-raw-<format><fps>-<cursor>/`: one clip per scene (per page of a multi-page scene,
  on the same frames), from the scene's still (page loads never in a clip), the loading inside scenes cut (a run of
  waits that really waited, from just after the press — or its URL change — to the awaited state painted, paced on the
  capture's own frame interval; never a result, hold, mark or still), real time otherwise; MP4 (H.264 high, CRF 14,
  yuv420p, faststart) or ProRes 422 HQ (prores_ks profile 3, yuv422p10le), 30 or 60 fps CFR from the screencast's own
  frame timing (never interpolated), encoded once from the captured frames, each clip's start timecode = its place on
  the sequence; optional `selects` file. Cursor: `baked`; `none` (new runner option `hideCursor` / `run --raw --cursor
  none|layer`: the kit draws nothing, real input and the track unchanged, `capture.cursor: hidden`); `layer` (a
  transparent ProRes 4444 / VP9-alpha video per clip drawn from an atlas the kit's own look renders in Chromium, frame
  by frame from the cursor track). The kit now reports what its cursor draws (icon, press, ripple → timeline
  `cursor_effects`); cursor and clicks as JSON / CSV in every mode. Markers (scenes, steps, marks, captions, cuts) as
  FCPXML 1.10, CMX 3600 with locators, OpenTimelineIO and CSV / JSON; `manifest.json` + `README.md`. project.yaml
  `raw` defaults. Packages checked with ffprobe (counted frames, codec, profile, pix_fmt, fps, timecode) against the
  manifest and every marker file, with OpenTimelineIO 0.18.1 (otio_json, cmx_3600, fcpx_xml adapters) and frames
  looked at (clip starts / ends, both sides of every cut, the layer composited over the cursorless and the baked
  clips) — HANDOFF lists the runs and packages. Real-NLE imports are for the Mac (L1.5 / R-RAW-06). **Review
  fixes:** a cut starts after the step's last press (a type's typing and Enter, a select's option click are never
  cut), resumes on a frame painted after the awaited state at any export rate, and is not made when the scene ends on
  that state (loading kept, note); markers at a scene's very end are kept; WebM cursor layers (no timecode) are
  referenced from 0 in the OTIO and left out of the FCPXML; OTIO media URLs are `file://`; `run --raw --json` stays
  JSON lines; all packages re-exported and re-validated.

### L2.14 — Phase 2 acceptance (S)
- **Scope:** render catalogue + quote with the editorial theme, clean review, contact-sheet review by Claude, switch a
  component and the theme without touching the scenario (R-ACC2-*, R-GOAL-05, R-LES-10, R-CMP-01); one video with a user intro file and an alpha overlay; one raw export
  imported checks (FCPXML/OTIO validate); README update.
- **Mac handoff:** root `CLAUDE.md` (points to `docs/HANDOFF.md`, working agreement, commands); HANDOFF gains
  "Mac setup" (Node ≥ 22, pnpm, ffmpeg, Chromium for playwright-core, Docker later, Xcode for phase 5) and "First
  local session" (L1.5 checklist first); every helper used in the cloud session lives in the repo; branch ready to
  merge.
- **Done** (`docs/ACCEPTANCE-phase2.md`): fresh captures of catalogue and quote; catalogue-v7 and quote-v17 (editorial)
  review clean; the same quote capture re-rendered with `--theme motion` (quote-v18) and with one component switched,
  `--frame studio/layout-laptop` (quote-v19, the review's diff names only the layout), both clean, no scenario,
  project or template edited; contact sheets, scene sheets and key frames read by Claude against the reference look —
  two fixes: marker key frames now show the marked step done (plan markers `done`, `markDoneAt`), and the
  composition's own fade envelope with a hard-coded black veil is gone (every fade is a transition component; R-CMP-01
  audit with the theme background and the brand mark as documented exceptions); own-media-v9 (user intro video,
  alpha overlay, Lottie, music) clean; the raw export of the fresh quote run validated by the new
  `scripts/validate-raw.py` (OpenTimelineIO read-back). Mac handoff: root `CLAUDE.md`, HANDOFF "State" / "Mac setup" /
  "First local session" / cloud notes as a subsection, MACOS-CHECKLIST on `main`, BACKLOG maintained by hand (BL-54
  from the review), README phase status. **Phase 2 is done**; next: L1.5 on the Mac.

### L5.1 — Fixes found by the macOS verification pass (S)
- **Goal:** fix what the L1.5 pass found outside capture smoothness (that part is L1.3).
- **Scope** (`node scripts/requirements.mjs --lot L5.1`): the CLI refuses Node < 22 with a clear message (R-MAC-03:
  from a folder whose default Node was 10 it failed with a syntax error); a new workspace finds the starter templates
  (R-MAC-04); an unresolved keychain reference fails with one clean line (R-MAC-05); the automatic scene rest point stays
  inside the first target's dialog and near its click point (R-MAC-06: the quote delivery scene glides out of its
  dialog and back); decide how a continuing scene starts — keep the cursor or glide next to the first target —
  and align DESIGN §3.3 with the field rule (R-MAC-07); an unannounced popup is still detected when it opens late under
  load (R-MAC-08); `studio doctor` checks ffmpeg ≥ 5.1 (R-MAC-09).
- **Acceptance:** tests per item; quote re-captured on the Mac with the delivery scene's cursor resting beside the
  field inside the dialog; the CLI run from a folder on Node 18 prints the version message.
- **Packages:** cli, core, runner-web (kit restNear, scene-cursor, click), hooks.
- **Done (2026-10-12):** all seven items, with tests; quote and catalogue re-captured on the Mac (the request scene
  now glides to rest next to "Request a quote", the delivery scene rests between two selects inside its dialog, 72 px
  from the field's click point); the CLI's message checked on real Node.js 10, 16, 18 and 20.

### L3.1 — Engine API, job runner, storage abstraction, MCP server skeleton (L)
- **Goal:** Claude drives the capture half of the loop through MCP; the CLI and the MCP server call one engine API.
- **Scope:** new package `@demo-studio/engine` (workspace / project loading, run execution, hooks, sign-in and sandbox
  code moved out of the CLI; typed `EngineError` at the MCP / worker boundary; a local storage interface); jobs
  (serialisable zod payloads with slugs, refs and sha256 — never secrets or paths — in
  `<workspace>/.demo-studio/jobs/`, one writer per file, cancel markers, `interrupted` derived; a detached `studio
  worker` per workspace under one `worker.lock`, one job at a time); `studio mcp` over stdio with the official SDK
  (pinned, one module) and `--print-config`; 23 tools (engine, projects, scenarios, runs, jobs, hooks / env reset, auth,
  sandbox); human approvals by MCP elicitation, fingerprinted and signed; `studio jobs`; history; the ADR-1 amendment.
  Moved out: MCP HTTP transport and the engine's HTTP API, the SQLite index (L4.1); render / review / export tools
  (L3.2).
- **Acceptance:** an MCP client runs the loop on the fixture (list, validate, dry run, capture, capture with an approval,
  cancel, a killed worker → `interrupted`, env reset); nothing destructive, shell, secret, outside-project file or
  production write happens through MCP without a human; a live Claude Code session (MACOS-CHECKLIST 12c, the user).
- **Done (2026-10-17):** all of the above, automated with the SDK client over stdio on a copy of the fixture (quote
  and catalogue captured, approval answered, cancel, `kill -9` of the worker, env reset, auth_login auto, sandbox up /
  reset). Two reviewers found 16 issues, five of them safety holes (secrets through `{{env:}}` in agent-written
  scenarios, files outside the project, production bypassed by a cloned project, unapproved destructive rollbacks, a
  form hiding rollbacks) — all fixed and mutation-tested. The live Claude Code run is the user's checklist step 12c.

### L3.2 — MCP render / review / export + theme & component tools (M)
- **Goal:** Claude finishes the loop through MCP: plan, render, review with images, export, browse and preview themes
  and components — every long task a job of the L3.1 worker, nothing that lets an agent run code or read files outside
  the project.
- **Done (2026-10-17):** job kinds render / review / export / preview; 36 tools (plan_preview, render, render_status,
  review, review_get with contact sheets as image blocks — at most 4 images / 1.5 MB, text in images is data —,
  export, template_list / template_preview, component_list / get / validate / preview / create scaffold-only);
  `planRun` gates under trust `mcp` (every file a render reads is a project, run or theme file, checked before reading;
  Lottie from agent-writable folders refused as code; theme by name); a network guard for worker renders and previews
  (CDP Fetch allow-list, Remotion `/proxy` and media downloads checked, a CSP against WebSocket — 20 bypass vectors
  tested); previews only into `.demo-studio/previews/`. No tool writes component code, themes or project.yaml (L3.5 /
  L3.7). Acceptance automated over the MCP client on the fixture (capture, editorial render, clean review, motion +
  laptop layout, export to three formats); a reviewer's 5 findings fixed (a case trick on macOS paths, report text
  outside `untrusted`). Live Claude Code run: MACOS-CHECKLIST 12d (the user). Cut to BL-72: `still` tool, `render_list`,
  image-cap tuning, a guard for CLI renders, Remotion's bundle server bound on all interfaces.

### L3.3 – L3.8, L4.1 – L4.9, L5.2 – L5.4, L6
Scopes are listed per requirement in REQUIREMENTS.md (`--lot`); they will be detailed here when phase 2 is done, with
the same structure (goal, scope, acceptance, packages, size). Key contracts already written: SPEC §8 (MCP tools),
§11 (components), §12 (Studio app), DESIGN-phase2 §4 (frame comments), the canvas mock-ups (screens 1–7) and
`docs/design-brief.md`.
