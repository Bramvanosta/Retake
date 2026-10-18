# Handoff — read this first in a new session

Last updated: 2026-10-18, end of lot **L3.4 (recorder)** — phases 1 and 2 are done, phase 3 is under way. **Next:
L3.5 (themes from brand inputs and from a site URL), when the user asks.** Branch: **`main`**. The work continues in local Claude Code sessions on the user's Mac (see
"Mac setup" below; the root `CLAUDE.md` sums up the working agreement and the everyday commands). The cloud working
branch `claude/new-session-pq6jtq`, where phases 1–2 were built, is history.

## What this is
Demo Studio: a generic, product-agnostic tool (licence-ready in a V2) that turns a written scenario into a
professional product video — drive a real web app headless with an in-page cursor, capture it cleanly, then edit it
automatically with themeable components, and let Claude operate everything through an MCP server.

## Read in this order
0. `CLAUDE.md` (root) — the short version: working agreement, commands, where things live.
1. `docs/SPEC.md` — the brief, especially §0 (product principles), §11 (components), §12 (Studio app), §14 (phases).
2. `docs/ROADMAP.md` — lots, sizes, status, working agreement. **Work one lot at a time; the user decides how many.**
3. The lot's requirements: `node scripts/requirements.mjs --lot <id>` (source of truth: `docs/requirements.json`).
4. Contracts: `docs/DESIGN.md` (phase 1 packages), `docs/DESIGN-phase2.md` (components, editor, review, comments),
   `packages/core/src/types.ts`, `packages/components/src/types.ts`, `packages/editor/src/plan-types.ts`.
5. References: `docs/reference/look.md` (measured target look), `docs/reference/choreography.md` (field-tested
   cursor/click/typing rules), `docs/design-brief.md` + the mock-up canvas (Studio screens 1–7 and video frames in two
   themes): https://claude.ai/artifact/CEa9o9do5hr9AcLBajLRye (private to the owner).
6. `README.md` — usage, scenario language reference, CLI.
7. `docs/BACKLOG.md` — everything outside the locked MVP (unprioritised), guard-rails to apply when L1.2–L5.2
   start, recorder precisions for L3.4/L4.8, open decisions; **maintained by hand** from now on (the scratch files of its
   first version are not in the repo: edit it directly, next free id BL-70); `docs/COMPETITION.md` — competitive study
   (2026-10-12).
8. `docs/ACCEPTANCE-phase2.md` — the phase-2 acceptance (renders, reviews, the theme / component switch, R-CMP-01
   audit, own media, raw export validation).

## State (after L3.4)
- **L3.4 done (2026-10-18)**: `studio record` opens a real window where the person performs the flow; it becomes a
  scenario draft (verified targets, scenes, waits, secrets replaced by placeholders) that is saved, checked by a replay
  up to the first write and dry-runs. Claude can start one with `scenario_record` but never drives it. Tests on the
  Mac: **1967 — 1934 pass, 33 skipped (≈ 10 min)**. Requirements: 619 tracked — 529 done, 15 partial, 67 todo, 8 n/a-here. Live checks for the user:
  MACOS-CHECKLIST 12c–12f (12f: record a flow yourself, CLI first).
- **L3.3 done (2026-10-18)**: Claude authors scenarios through MCP — `page_inspect` gives it verified targets and a
  numbered screenshot of real pages (signed in, read-only, the environment's origins only), it writes the YAML,
  validates, saves, inspects again mid-scenario and dry-runs; `scenario_from_script` drafts from a timecoded table. The
  tool never calls a model. Tests on the Mac: **1887 — 1855 pass, 32 skipped (≈ 9 min)**. Requirements: 619 tracked — 528 done, 15 partial, 68
  todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 12c, 12d, 12e.
- **L3.2 done (2026-10-17)**: through MCP Claude can now plan, render (guarded: no network, project files only),
  review with contact sheets as images, export, and browse / preview themes and components (36 tools). Tests on the
  Mac: **1819 — 1791 pass, 28 skipped** (≈ 8 min); `pnpm test:slow` includes the whole MCP loop on the fixture.
  Requirements: 618 tracked — 525 done, 14 partial, 71 todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 12c
  (L3.1) and 12d (L3.2).
- **L3.1 done (2026-10-17)**: `studio mcp` (23 tools over stdio) lets Claude list and edit scenarios, run dry runs and
  captures through a job queue and a separate worker, follow progress, cancel, run hooks and env resets, sign in (the
  human types) and start sandboxes; every risky action asks the human through an approval form. Tests on the Mac:
  **1738 — 1714 pass, 24 skipped (≈ 7 min)**. Requirements: 618 tracked — 514 done, 15 partial, 81 todo, 8 n/a-here. Register it with
  `node packages/cli/dist/bin.js mcp --print-config` (MACOS-CHECKLIST 12c).
- **L1.4 done (2026-10-17)**: every scenario-language option has a test that fails if the option is ignored; captures
  at 2560×1440, 4K and phone sizes; cursor and file-chip look checks with goldens; Ctrl-C / SIGTERM on the built CLI;
  `version: 1` on the persisted formats and the engine in run.json; `pnpm test:pg` (the Postgres tests, first run on
  the Mac) and `pnpm test:slow` (automated catalogue capture); the tests found and fixed `wait_for: {network_idle}`
  and four cancel / teardown bugs. Tests on the Mac: **1632 — 1608 pass, 24 skipped (≈ 6 m 35 s; 7 Postgres, 7 Docker, 8 slow, 1 old Node, 1 headed); `pnpm test:pg` 7/7, `pnpm test:slow` 8/8, Docker-gated 7/7**. Requirements: 618 tracked — 498 done, 9 partial,
  103 todo, 8 n/a-here; never exercised in phase 1: 0.
- **L1.8 done (2026-10-14)**: sandboxes — a `sandbox.yaml` per sandbox environment (process or docker-compose
  services, seed, reset by reseed or Postgres snapshot, demo accounts as personas, mailbox), `studio sandbox init | up
  | down | reset | status | logs`, `studio run --sandbox` (every take from the same state), the fixture shipped as a
  process and a Docker sandbox. Tests on the Mac: **1583 — 1567 pass, 16 skipped (≈ 6 m; 7 Postgres, 7 Docker without DEMO_STUDIO_TEST_DOCKER, 1 old Node, 1 headed sign-in); the gated Docker tests pass 7/7 on OrbStack**. Requirements: 618 tracked — 467 done, 40 partial, 103
  todo, 8 n/a-here.
- **L1.7 done (2026-10-13)**: environment pages take a display URL (never localhost on screen or in a report),
  production / read-only environments (browser writes mocked or stopped, writing hooks refused, production writes only
  with `access: read-write` + `--allow-writes`, access mode in run.json / timeline / review), and a product clock
  (`clock:`, Date-only, timers and animations real). Tests on the Mac: **1455 — 1446 pass, 9 skipped (≈ 5 m 20 s; 7 Postgres without DEMO_STUDIO_TEST_PG, 1 old Node, 1 headed sign-in)**.
- **L1.6 done (2026-10-13)**: personas per environment (`auth.personas`), one browser per persona on a per-run copy of
  its signed-in profile, a session preflight before every dry run and capture (automated off-camera login when
  `login:` steps exist, else the exact `studio login` command), a sign-in guard that fails a run and keeps nothing,
  `studio login --persona [--auto]`, `studio auth status`, interactive `studio new`, doctor persona lines; the fixture
  has a signed-in side (env `signed-in`, personas supplier and buyer). Tests on the Mac: **1212 — 1204 pass, 8 skipped (≈ 4 m 40 s; the 8th: the headed sign-in test without DEMO_STUDIO_TEST_HEADED)**.
- **L1.2 done (2026-10-13)**: the runner finds targets in open shadow roots and same-origin iframes, never films a
  loading page (frames held until the new page paints, `timeline.loading`, cut in the edit), templates every scenario
  string with secrets resolved up front and redacted from every run file, checks the hosts of shell and js hooks, and
  gained choreography helpers (`date`, `park`, adaptive typing, robust `clear`, menu re-click). Tests on the Mac:
  **1142 — 1135 pass, 7 skipped (≈ 4 m)**.
- **L1.3 done (2026-10-12)**: the cursor waits for flowing frames after a scroll (stalls after scrolls gone) and
  before a press, the motion check warns on stalls ≥ 150 ms. Two limits stay partial: closing a dialog with a blurred
  overlay still freezes ≈ 0.26 s during the click ripple (R-ISS-12; `browser.frame_rate_limit: false` avoids it, not
  the default: rAF at thousands of Hz, 2–6× CPU), and hover-effect hitches (100–400 ms, now and then; R-ISS-02).
  Tests on the Mac: **896 — 889 pass, 7 skipped** (≈ 2 m 35 s).
- **L5.1 done (2026-10-12)**: the CLI tells an old Node.js which version it needs, a new workspace uses the starter
  templates, one-line keychain errors (printed once), `doctor` checks ffmpeg ≥ 5.1, scene rest points next to the
  click point and inside the target's dialog, continuing scenes glide next to a far first target, late popups caught
  by the next step. Tests on the Mac: **893 — 886 pass, 7 skipped** (6 Postgres without `DEMO_STUDIO_TEST_PG`, 1
  without `DEMO_STUDIO_TEST_OLD_NODE`), ≈ 2 m 45 s. Requirements: 618 tracked — 431 done, 50 partial, 129 todo,
  8 n/a-here.
- **L1.5 done (2026-10-12, on the Mac)**: every step of `docs/MACOS-CHECKLIST.md` ran on an Apple M4 (results table
  at its end); step 7 found stalls after scrolls and at dialog close (→ L1.3) and scene-start defects (→ L5.1); the
  imports into editing tools were skipped (none installed; R-RAW-06 partial). It fixed the Mac blockers of
  the test suite (ffmpeg 9, symbolic-link paths, a case-insensitive fixture, a font-sensitive look test), **narrowed
  L1.3** to the stalls a GPU Mac still shows and filled **L5.1** (`--lot L5.1`). Tests on the Mac: **878 — 872 pass,
  6 Postgres skipped, 2 m 28 s** for the full suite. Requirements: 618 tracked — 424 done, 50 partial, 136 todo,
  8 n/a-here.
- **Phases 1 and 2 are done**: phase 1 (core, runner-web, hooks, CLI, fixture product, starter templates) + L1.1, and
  phase 2 L2.1–L2.14 — contracts, components package, edit planner, Remotion render pipeline, reference-look
  components, review, layouts & previews, variants / 4K / music / export, mails / notifications / documents, tutorial
  overlays & story cards, multi-page capture (split, PiP), your own media & motion, raw capture export for editors,
  and the phase-2 acceptance (`docs/ACCEPTANCE-phase2.md`).
- **Acceptance (L2.14)**: fresh captures `20261012-144004-catalogue` / `20261012-144221-quote`; catalogue-v7 and
  quote-v17 (editorial) review clean; quote-v18 (`--theme motion`) and quote-v19 (`--frame studio/layout-laptop`)
  re-render the same capture with no scenario change and review clean; own-media-v9 (user intro video, alpha overlay,
  Lottie, image outro, music) clean; the raw export of the quote run validates (`scripts/validate-raw.py`).
- **Tests (end of phase 2, cloud)**: 875 — 869 pass, 6 Postgres tests skipped without `DEMO_STUDIO_TEST_PG` (≈ 5–7 min
  in the cloud container); 878 after L1.5 (see above).
- **Not built yet**: phase 3 after L3.1 (MCP, authoring, recorder, skills), phase 4 (Studio app), phase 5 (macOS shell, iOS runner). `packages/mcp`
  is empty; `studio record|mcp|ui` print "available in phase N".

## Mac setup
The next sessions run locally on the user's Mac with Claude Code, on the `main` branch. Steps (once; `studio doctor`
checks the result):

1. **Command line tools** — `xcode-select --install` (git, clang). The full Xcode is only needed for phase 5.
2. **Node.js ≥ 22 and pnpm** — `brew install node@22` (keg-only: `brew link --force node@22`, or put
   `$(brew --prefix node@22)/bin` on the PATH; nvm / fnm work too), then `corepack enable`: corepack provides the
   pnpm version pinned in `package.json` (`packageManager: pnpm@10.28.0`). Node 25+ no longer bundles corepack:
   `npm i -g corepack` first, or stay on 22 / 24.
3. **ffmpeg and ffprobe** — `brew install ffmpeg` (H.264, VP9 / libvpx, ProRes encoders, ffprobe). Captures encode with
   it, renders are probed with it, the review decodes with it, the raw export encodes with it. Elsewhere on disk:
   `ffmpeg:` in `studio.yaml`, `$DEMO_STUDIO_FFPROBE` for ffprobe.
4. **The repository** — `git clone -b main <repository URL> demo-studio && cd demo-studio`, then `pnpm install` and
   `pnpm build`. The lockfile already lists the macOS binaries (`@remotion/compositor-darwin-arm64`,
   `@img/sharp-darwin-arm64`, `@esbuild/darwin-arm64`); pnpm 10 runs install scripts only for esbuild and sharp
   (`onlyBuiltDependencies` in `pnpm-workspace.yaml` / `package.json`).
5. **Chromium for playwright-core** — `pnpm --filter @demo-studio/runner-web exec playwright-core install chromium`.
   This downloads the Chromium build pinned by playwright-core 1.56.1 (Chromium 141, revision 1194) **and** its
   headless shell into `~/Library/Caches/ms-playwright/`. How the browsers are found
   (`packages/runner-web/src/probe.ts`, `session.ts`; `packages/editor/src/render/browser.ts`):
   - captures (runner): `browser.executable` in project.yaml / studio.yaml, else `$DEMO_STUDIO_CHROMIUM`, else
     playwright-core's own Chromium launched in new headless mode (`channel: chromium`);
   - renders (Remotion): `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL`, else playwright-core's `chromium-headless-shell`
     (looked up through its registry), else Remotion downloads its own (a warning says so);
   - `PLAYWRIGHT_BROWSERS_PATH` moves the browser cache (the cloud container used `/opt/pw-browsers`); leave it unset
     on the Mac. No other environment variable is needed.
6. **Check** — `pnpm studio doctor` (Node, Chromium launch, ffmpeg / ffprobe, display, Keychain, notifications,
   workspace, template fonts): every line `OK`. Node must be 22+ in every folder the CLI runs from: a version manager
   pins it per folder (the user's machine: Node 22 in the repository — `.nvmrc` —, 10 elsewhere; an older Node.js
   prints which version it needs). A workspace outside the repository uses the starter templates by name. ffmpeg 5.1+
   (the Mac has Homebrew's 9.0; `studio doctor` fails below 5.1).
7. **Later, not before their lot** — Docker Desktop for L1.8 (sandbox mode, docker-compose provider); the full Xcode
   (App Store) + Rust (`rustup`) for phase 5 (L5.2 Tauri shell, L5.3 iOS Simulator runner: simctl / idb).
8. **Optional** — PostgreSQL for the 6 SQL hook tests (`brew install postgresql@16`, then
   `DEMO_STUDIO_TEST_PG=postgres://…`); Python 3.13 or older + OpenTimelineIO for `scripts/validate-raw.py`
   (OpenTimelineIO 0.18.1 does not load on Python 3.14: `RuntimeError: bad any cast`; Homebrew has `python@3.13`):
   `python3.13 -m venv ~/.venvs/otio && ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter`.

**macOS permissions.** Headless captures need no Screen Recording permission (frames come from Chromium's own
screencast) and the fixture and the render asset server listen on loopback only (no firewall prompt). Expect prompts
only for what the L1.5 checklist exercises: Keychain access when a hook resolves `{{keychain:service/account}}`
(through `security`), the Notification / Automation prompt the first time `osascript` posts a notification from the
terminal, and a visible window for `--headed` runs and `studio login`.

## Order of the next lots
1. ~~L1.5 = `docs/MACOS-CHECKLIST.md` with the user~~ — done 2026-10-12 (narrowed L1.3, filled L5.1).
2. ~~L5.1~~, ~~L1.3~~ — done 2026-10-12, ~~L1.2~~, ~~L1.6~~, ~~L1.7~~ — done 2026-10-13, ~~L1.8~~ — done 2026-10-14,
   ~~L1.4~~ — done 2026-10-17: the chain is complete.
   Chain asked by the user (2026-10-12): L1.3 (stalls) → L1.2 (runner robustness) → L1.6 (sessions & personas) → **L1.7** (display URLs, read-only & production safety, frozen clock)
   → **L1.8** (sandbox mode) → **L1.4** (coverage, last so it covers the rest), then stop before phase 3 (**L3.1**).
3. One lot at a time; the user (in French) decides how many — see `CLAUDE.md`.

## Next lot
**L3.5 — Themes from brand inputs and from a site URL** — only when the user asks for it. Open phase-1 items left: R-ISS-02 and R-ISS-12 (known capture limits, L1.3) and R-RAW-06 (an import
into an editing tool, L1.5). User checks pending in docs/MACOS-CHECKLIST.md: step 8b (a headed `studio login
--persona` typed by hand), 10b (a real Keychain item in a step), 12b (a sandbox).

## Lot log (what each lot built — details for whoever touches that code)
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
- **L2.11 done** (multi-page capture: split screen & picture in picture): **core** scene `pages:` (map `id →
  {page?, open?, viewport?, label?, cursor?} | null`, or a list of ids continuing earlier declarations / objects),
  `open: "<env page>:/path"`, viewport presets (`desktop` = capture size, `laptop` 1440×900, `tablet` 820×1180,
  `mobile` 390×844 with touch + mobile UA, or `{width, height, mobile?, touch?}`), step `on: <page>`, `pacing.
  page_switch_ms` (500), `frame: split | pip`; `pages.ts` (`resolveScenePages`, `scenePageEntries`, `splitPageOpen`,
  `stepPageOf`), positioned checks (unknown pages with suggestions, `on:` outside / unknown, page/open beside pages, not
  two pages, duplicates, new_tab / switch_page inside, a page id asked at another viewport, a single-page scene filming
  a page whose viewport is not the capture size — explicit, via switch_page / open, or by continuation), timeline
  `tracks[]`, `scenes[].pages`, `events[].page`, `markers[].page`; schemas regenerated. **Runner** (`runtime.enterPages / leavePages / act`, `scenes.ts
  runPagesScene`): one screencast + `TrackBuilder` per page id for the whole run, on the shared clock, encoded on the
  CFR grid of `capture.mp4` as `capture-<page>.mp4` (same frame count); viewport by a persistent CDP emulation session
  per page (detaching reverts it); one `Pointer` per page (only the acting one moves; switch = `page_switch_ms` pause
  then a glide from its rest; a page with no step of its own in the scene rests near its centre — never under a PiP
  inset); the main recorder pauses during multi-page scenes (not created when every scene is multi-page: `capture.mp4`
  is then a copy of the first track); a mobile page in a single-page scene or a page whose viewport changes is a
  StepError (also caught by the validation now); `rt.resolveUrl` resolves a page id of `pages` against the environment
  page it was declared on (base path kept). **Planner** (`editor/src/panes.ts`): `plan.tracks`, clip `panes` (fit
  top-aligned in the layout's panes, per-page camera / reframe / URLs) on one `srcFrames`, `acting` (the opening still's page from
  the clip's start; a joined clip eases from the previous one's), PiP `inset` (`planInsetTrack`: corners kept off the
  main page's current and next targets — `stepBoxes`: `focusBox` ±180×110 CSS px around the acted point + the
  `leadingBox` of a wide target, clearance, caption band soft —, glides `INSET_LEAD_S` before, ≥ `INSET_MIN_HOLD_S`
  apart, never while its page acts (a corner the next main-page step needs is reached after the inset's step; ties go
  to the corner the next steps leave free), continues across joined clips; grows ×1.18 while its page acts with
  emphasis — `growClearOf` lowers it, to 1 under 1.04, so it never reaches a caption band over the screen), automatic
  split / pip for a single-pane frame, fallback for single-page scenes, theme-dressed (radius, shadow, chrome), geometry keys `panes` /
  `inset` and the `aspect2` variable; tutorial per pane (`OverlayUse.pane`; badges numbered once per clip in time order
  over both pages, `planBadgeNumbers`; an inset's spotlight and badges stay inside it, `staysInInset`, its caps / lens
  use the main page's room and keep clear of its targets — `clear[].pane`); a caption band
  over the screen goes below a split (note); story-card frames of a page read its track. **Composition**: one
  `CaptureScreen` per pane (`source`), `rects.panes` (`layoutPaneRectsAt`, eased acting weights), overlays mapped per
  pane, main-page overlays clipped around the inset (`insetHole`). **Components** `studio/layout-split`,
  `studio/layout-pip` (kit `panes.tsx`: `WindowBar`, `PaneLabel`, `InsetCard`, `InsetPhone`, `insetPhoneEdge`),
  previews committed; manifest `preview.screens`. **Polish carried over from L2.10**: `OverlayUse.clear` (current
  target + click targets of the next `CLEAR_LOOKAHEAD_S` 1.2 s) → `avoid` (`kind: 'target'`), key caps take the other row
  (`shortcutSlot`), kit `stepBadgeBox` / `shortcutPlateLayout` shared with the review (`drawnOverlayBox`), the loupe
  cross-fades two fixed regions instead of panning (`trackKeysAt`). **Review**: clicks per pane (`OutputClick.page /
  pane`, `cursorAt(…, page)`), cursor / reframe / tutorial checks per pane, capture-frame keys `<track>:<frame>`,
  `overlay-covers-target` (caps, badge, loupe, PiP inset over > 15 % of a click target of the current / next step),
  `tutorial-stale-target` (a spotlight or badge still on its target > 0.6 s after its page changed URL; the planner
  ends a spotlight run and a badge after a click that navigates, `stepNavigates`), `target-outside-view` is an info
  when a reframed target larger than the view shows its leading part and the click. **Reframe** (all vertical /
  square plans): a wide target counts by its leading part (`leadingPart`), a run starts framed toward the page's
  top-left, a cursor resting alone after its step is only brought back inside the dead zone, an idle pane settles on
  its page's heading at the start of a scene where it only rests (`reframeTrack({settle})`). **Fixture**: live lists
  (`useLiveList`, 1 s poll, "New" pill) in the console's quote requests and the shop's quotes, and the shop's
  notifications bell polls every second (unread badge + ring a second after the console's proposal); scenarios
  `live-quote` (split, step badges) and `phone-and-desktop` (pip, step badges; the send scene holds 1.2 s so the
  request reaches the desk's list before the desk's opening still). Bundle hash covers
  `COMPOSITION_DEPS` = layout, util, plan-types, panes. Tests: core multipage.test.ts, runner-web multipage.test.ts,
  editor planner-panes.test.ts (frozen timelines `live-quote.timeline.json` = run 20261012-073840-live-quote,
  `phone-and-desktop.timeline.json` = run 20261012-080444-phone-and-desktop), review multipage.test.ts, components
  library.test.ts (multi-page layouts); review-fix tests in the same files plus editor reframe.test.ts (leading part,
  leading start, settle), planner-tutorial.test.ts (navigation ends the spotlight run and the badge), review
  tutorial.test.ts (`tutorial-stale-target`); counts now 39 built-in components. 792 tests: 786 pass, 6 Postgres
  tests skipped (full suite run twice after the review fixes, green both times). No dependency added.
- **L2.12 done** (bring your own media & motion; R-OWN-01…05): `intro`, `outro`, `card`, `interstitial` take
  `{video | image | lottie, from, to, fit, background, volume, duration}` and a template's `components.intro / outro /
  interstitial` may be a file (relative to the template folder) — no component is mandatory. **Core**: `types.ts`
  (`MediaFileFields`, `OverlaySpec`, `OverlayAt`, `OVERLAY_ANCHORS`, `MEDIA_COMPONENTS`, `TemplateMediaRef`),
  `media.ts` (`mediaSegmentUse`, `overlayUseOf`, `probeVideoFile` = sync ffprobe cached by path / size / mtime,
  `readLottieMeta`), `checks/media.ts` (positioned: one file per use, extension per kind with hints, existence, image
  signature, Lottie JSON, codec / container / alpha / from-to / volume via ffprobe). **Components**: `studio/media`
  (video, image; `fit: auto` default = cover when covering keeps ≥ 80 % of each side, else contain) and
  `studio/lottie` (`@remotion/lottie` 4.0.534 + `lottie-web` 5.13.0 — the only dependencies added; `colors` maps the
  file's colours to theme keys), both kind `card` with `kinds: [intro, outro, interstitial, overlay]` (new manifest
  field; the registry resolves an id for any of its kinds, the component gets `props.as`); slot types `media` /
  `lottie` → `props.media.file` (`VideoMedia` with size, length, fps, audio, alpha, codec; `LottieMedia`); kit
  `media.tsx` (`VideoFile` with `transparent` for alpha, plays once then holds its last frame, or loops; `ImageFile`,
  `LottieFile`, `recolorLottie`, `autoFit`, `mediaBackground`); previews committed. **Editor**: `inputs.ts`
  `planInputFiles` reads every file before planning (the planner stays pure); the scenario file → theme file → theme
  component chain; durations from the file (note `"<where>": your file … for N s`, and a note when `fit: auto`
  contains); file overlays: `at` (step / end, start, click, `mark:<name>`, seconds), `box` (`rect`, or target /
  cursor / screen / a corner or side: the file's own size × `scale` in page px), layer `screen`, mapped per frame by
  `overlayBoxAt` (layout, camera, reframe; `insetHole` around a PiP inset); music ducks under clips and under files
  that play sound (`duckSpans`, `playsSound`); render record `encoding.audio`: `silent | music | files |
  music+files`. **Catalogue long-wait, root cause** (R-OWN-05, `timing.ts` `waitingSpans`): a marked wait protected
  its whole waiting at 1× — now a marked wait protects only the moment its state appears (around its end), and the
  waiting itself (wait steps + the load pause before a wait that really waited) plays at up to 4× after its first
  0.5 s (`WAIT_SPEED`, `WAIT_KEEP_S`; step speed wins; off with `overrides.trim_idle: false`). **Review**:
  `media-missing` covers files ("could not be read — nothing is shown"), `empty-segment` names the file. **CLI**:
  `studio components new` (alias of `create`), plan / render pass the template (theme files). **Docs**:
  `docs/BRING-YOUR-OWN-MOTION.md` (linked from the README; export settings for motion tools, Remotion, Lottie,
  workspace components, the output of Claude motion / design skills), README section "Your own media and motion",
  DESIGN-phase2 §1.9. **Fixture**: `scripts/fixture-media.mjs` renders the media with Remotion
  (`fixtures/own-media/src`: intro 1920×1080 3.6 s with a chime made by ffmpeg, end card, a 480×480 VP9-alpha burst;
  `--prores` also writes a ProRes 4444 burst to `.demo-studio/`) and `fixtures/own-media/lottie.mjs` writes two
  hand-written Lottie files → `projects/northfield-fixture/assets/` (each < 300 KB; `.gitignore` lets
  `projects/*/assets/*.mp4|webm` in); scenario `own-media` (46 s). Tests: core media.test.ts, components media.test.ts,
  editor planner-media.test.ts and render-media.test.ts (real render: the intro's tone, VP9 and ProRes alpha pixel
  checks with a halo scan), review tutorial.test.ts case; planner-real / planner-rules / review tests updated for the
  waits; counts now 41 built-in components. Dependencies added: `@remotion/lottie@4.0.534` and `lottie-web@5.13.0`
  (components). **Review fixes** (two reviewers, code + video editor): (1) a file's own sound dipped and clicked where
  the transition after it began and never got its end ramp — `VideoFile` took its 4-frame ramps from the frame
  Remotion passes to a `volume` callback, which restarts at 0 inside TransitionRender's `<Sequence from={-shift}>`;
  the gain now comes from the video element's own frame (kit `filePartGain`, a number per frame); render test with an
  intro leaving and an outro entering by crossfade (per-frame RMS within 1 dB, end ramp; fails on the old callback).
  (2) the vertical / square reframe kept a step overlay over [step end, +2.5 s] and its target — now over the capture
  time it really shows (`overlayStartAt`: `at` incl. click / marks / seconds, its own length through the run's time
  map) and its real box (a file's box on the target / cursor, a `rect`): `stepOverlayOf` resolves each step overlay
  once for the reframe and the clip. (3) a file at a corner / side moves to the nearest free corner (side) when, in the
  variant's framing, it would cover its step's or the coming steps' `stepBoxes` (`SCREEN_POSITION_CHOICES`, plan
  note), and the review's `overlay-covers-target` measures user file overlays at screen positions (hover targets too).
  (4) a kind-wide `overrides.components.overlay` no longer replaces user files (note). (5) a missing / unreadable file
  is no longer a plan asset (the render refused the plan). (6) with `overrides.trim_idle: false` a marked wait step is
  protected whole again (`protectedSpans(…, waitsFaster)`). New tests in render-media, planner-media (4) and review
  tutorial (1). 833 tests: 827 pass, 6 Postgres tests skipped (full suite run twice after the fixes, green both
  times).
- **L2.13 done** (raw capture export for editors; R-RAW-01…06): `studio export-capture <project> <run|latest>
  [--scenario] [--format mp4|prores] [--fps 30|60] [--cursor baked|none|layer] [--layer prores|webm] [--selects]
  [--no-cuts] [--out] [--json]` and `studio run … --raw [same flags]` (packages/cli/src/commands/export-capture.ts;
  engine `exportCapture` in **runner-web `src/raw/`**: plan.ts, encode.ts, cursor.ts, layer.ts, markers.ts, export.ts)
  → `<project>/exports/<run>-raw-<format><fps>-<cursor>/` = `clips/NN-<scene>[-<page>].mp4|mov`, `cursor/`
  (cursor.json, cursor.csv, clicks.csv, `NN-<scene>-cursor.mov|webm` layers), `markers/<scenario>.fcpxml|.edl|.otio`
  + markers.csv/json, optional `selects.*`, `manifest.json`, `README.md`. **Clips**: one per scene (per page of a
  multi-page scene, same frames; the page of the opening still is on the sequence), from the still (page loads never
  in), real time; **loading cuts** (`loadingCuts`): a run of `wait_for` / `wait_for_email` that waited ≥ 0.3 s is cut
  from 0.3 s after the LAST press of the step before (`actionMoment`: its option / item / confirm click, its Enter, the
  end of its typing; a drag or repeated keys whole) — or that press's URL change — to the awaited state painted (wait
  end + 1.5 local screencast intervals, 0.05–0.3 s, then the next screencast frame when the page was still painting —
  the catalogue import dialog paints a frame behind its DOM at ≈ 8 fps); not made when the scene ends < 0.2 s after
  it (loading kept, note: add a `hold`); `--no-cuts` keeps them. Frames: `cfrSchedule` at the export rate over `frames.jsonl` (60 fps = real screencast
  timing, never interpolated), encoded once from the JPEGs (MP4 libx264 high CRF 14 GOP 1 s yuv420p faststart;
  ProRes 422 HQ prores_ks profile 3 yuv422p10le), BT.709 tv; each clip's tmcd timecode = its sequence position (source
  TC = record TC); runs without kept frames fall back to the CFR video (tag-aware decode, frames repeated, note).
  **Cursor**: runner option `hideCursor` (kit `cursor.hidden` → `.c,.rps{display:none}`; `timeline.capture.cursor:
  hidden`, `run.json options.cursor`; the cursor-motion fps warning is skipped then); the kit now reports icon / press /
  release / ripple through the binding `__demoStudioCursor` → `timeline.cursor_effects` (+ `tracks[].cursor_effects`,
  current icon when a page starts being filmed); `api.cursorLook` exposes the overlay's CSS + markup. Layer:
  `renderCursorAtlas` draws the kit's look in Chromium (icons × 11 press scales, ripple every 1/120 s), Node composites
  per frame, ffmpeg `prores_aw` profile 4 (5× faster than prores_ks here, alpha within 1/255) or VP9-alpha WebM; runs
  before L2.13 get approximated icons / presses / ripples (`approximateEffects`, noted). **Markers**: scene (chapter),
  step, mark, caption (until the next), cut — FCPXML 1.10 (assets with media-rep and start = timecode, one project,
  spine, ProRes layers lane 1, other pages connected `enabled="0"`; WebM layers left out), CMX 3600 (reel CLIP<nnn>,
  `* LOC:`), OTIO JSON (V1, Cursor, Page n tracks; `file://` target URLs; WebM layers from media time 0), CSV / JSON;
  a marker at a scene's very end sits on the clip's last frame. project.yaml `raw` defaults (core `RawSettings`, schema regenerated). Output
  folders are replaced only when new, empty or an earlier raw package. Editor: a hidden-cursor run plans with a
  warning. Tests: runner-web raw-units.test.ts (21: cuts, plans on frozen catalogue / quote / live-quote timelines,
  writers, cursor model, kit CSS drift, settings), raw-real.test.ts (two real captures with the debug cursor — hidden /
  baked —: effects recorded, no cursor pixel, no loading frame, green first frame after the cut, layer dot on the baked
  dot and on the samples ±1.5 px, ripple ring, refusals, folder guard), cli export-capture.test.ts (colour-coded run:
  each capture frame twice at 60 fps, load out, video fallback; usage errors), editor planner-rules (hidden-cursor
  warning). No dependency added (OpenTimelineIO only in a scratch venv to validate). 865 tests: 859 pass, 6 Postgres
  tests skipped (full suite run twice, green both times).
  **Review fixes (after two reviews — code and an editor receiving the package):** the cut no longer starts inside
  the step before the waits (it used `t_click`, the first press: a type's field click, a select's trigger — it cut the
  typing, the Enter, the open popup and the option click); the resume snaps to the next screencast frame when the page
  was still painting (at 60 fps the catalogue import resumed on a half-drawn dialog, frame 1005); a scene that ends on
  its awaited state keeps its loading (the cut ran to the clip's end: the result, the wait's step marker and its mark
  were in no clip) and markers at a scene's very end land on its last frame (live-quote "delivery" step 6 was dropped
  even without a cut); WebM layers have no timecode — the FCPXML / OTIO declared them at their clip's timecode: now
  OTIO from 0, not in the FCPXML, README and a note say Final Cut Pro / Premiere need `--layer prores`; OTIO
  target_url is a `file://` URL (Premiere via otio-fcp-adapter then gets `file://` pathurls); layer codec labels name
  no pixel format (the manifest said yuva444p10le next to ffprobe's yuva444p12le); `run --raw --json` prints one
  `raw_export` JSON line instead of a pretty manifest in the JSON-lines stream. Tests added: raw-units (last press for
  type / select / menu / drag / keys, URL rewritten while typing, scene ending on a wait with / without mark, paint
  snap at 30 / 60 fps through `cfrSchedule`, idle page, WebM interchange, ProRes layer at a later sequence start),
  raw-real (WebM package: no timecode, OTIO from 0, README; manifest pix_fmt = ffprobe), cli e2e (`run --raw --cursor
  none --json`: every stdout line is JSON, last = raw_export). 873 tests: 867 pass, 6 Postgres tests skipped (full
  suite run twice after the review fixes, green both times).
- **L2.14 done** (phase-2 acceptance + Mac handoff; R-ACC2-01…06, R-GOAL-05, R-LES-10, R-CMP-01): fresh captures of
  catalogue and quote, renders and reviews listed in `docs/ACCEPTANCE-phase2.md`. **Fixes found by the review**:
  (1) marker key frames showed the start of the marked step (a marked wait's spinner / skeleton): plan markers gain
  `done` (`markDoneAt` in plan.ts — the screen once the step is done, the rule `frame: mark:` already used) and the
  review's `keyframes/<marker>.png` is that frame (`timeline.json` markers: `done_frame` / `done_time`);
  (2) **R-CMP-01**: the composition drew a component-less fade itself (opacity envelope + `#000000` veil) — removed;
  `transitionWindows` gives such a fade the transition stand-in (`standInTransition`), review spans lost the `fade`
  kind; justified exceptions (theme background token, brand mark) documented in DESIGN-phase2 §2.2; guards in
  editor render-units.test.ts (no component-less non-cut transition in real plans, stand-in, no colour literal in
  `src/remotion/`). Renders unchanged by (2) (reviews of catalogue-v7 / quote-v17 vs v6 / v14: no visible change).
  **Helpers in the repo**: `scripts/validate-raw.py` (raw-package validator, optional, OpenTimelineIO). **Docs**:
  root `CLAUDE.md`, this file's "Mac setup" / "First local session", `docs/ACCEPTANCE-phase2.md`, BL-54 (layouts keep
  an empty caption block under an overlay caption), README phase status + validator, MACOS-CHECKLIST (clone `main`,
  validator), ROADMAP (phase 2 done, L1.5 next). 875 tests: 869 pass, 6 Postgres tests skipped (full suite run twice,
  green both times).
- **L1.5 done** (macOS verification pass, 2026-10-12, a local Claude Code session with the user at an Apple M4 /
  macOS 26.6.2 / ffmpeg 9.0.2; R-GOAL-08, R-ACC-04, R-CLI-09/10, R-SEC-02, R-ACT-28, R-PRIN-10, R-ISS-09 done, R-RAW-06
  partial): `docs/MACOS-CHECKLIST.md` steps 1–13, results table at its end. **Fixes made in the lot** (the suite was
  red on the Mac: 28 failures): ffmpeg 9 removed `-vsync` → `-fps_mode passthrough` (review `ffmpeg.ts` / `pixels.ts`,
  editor test helper) and refuses `select` expressions nested > 100 deep → `selectExpr` builds a balanced sum (log2
  depth) for the review's one-pass extraction (new review/test/ffmpeg.test.ts: 250 frames of a lossless ramp);
  `checkComponentEntry` resolves the component folder, entry and kit to real paths (esbuild reports `/private/var/…`
  for `/var/…`: a component's own imports were "leaving the folder"; validate.test.ts symlink case, fails without the
  fix on Linux too); registry test fixture `Zeta/Bad` (APFS ignores case: `Acme/` merged with `acme/`); render-look
  measures the intro kicker by its cap band (`capBand`: modal column top/bottom) — the bbox included the É accent,
  which macOS rasterises darker (the cap band is 2.5 px off target, the whole intro stack ≈ 3 px higher than on Linux,
  within tolerance). README: ffmpeg 5.1+, the validator venv on Python ≤ 3.13; checklist notes (Node per folder,
  `templates_dir`, Python). **Measured** (step 7, two captures analysed frame by frame by a workflow with an
  independent re-check of every defect): ≈ 60 frames/s while the cursor moves (cloud 15–20), 42 of 43 moves ≥ 24 fps,
  drawn cursor within 2 px of the track in 94 % of moving frames; stalls after scripted scrolls (R-ISS-11), at every
  animated dialog close (R-ISS-12) and invisible to the runner's averaged check (R-ISS-13) → **L1.3 narrowed** (ROADMAP);
  scene-start rest points (R-MAC-06 detour out of a dialog, R-MAC-07 keep vs field rule), Node guard (R-MAC-03),
  starter templates in a new workspace (R-MAC-04), keychain error formatting (R-MAC-05), late unannounced popup under
  load (R-MAC-08), doctor ffmpeg version (R-MAC-09) → **L5.1**. 878 tests: 872 pass, 6 Postgres tests skipped (full
  suite green on the Mac after the fixes, 2 m 28 s to 2 m 44 s). The diff was reviewed by a second workflow (code,
  numbers against the measurements, repository rules; each finding re-checked): `selectExpr([])` guard, the entry's
  real path taken through its folder, and wording / numbers in these docs fixed. No dependency added.
- **L5.1 done** (fixes found by the macOS pass; R-MAC-03…09): **Node guard** — `cli/src/bin.ts` is readable by any
  Node.js up to its version check (no import / export / import.meta / top-level await, ES2017; the CLI is loaded with
  a dynamic import built at run time; the cli tsconfig sets `moduleDetection: legacy` so tsc emits no `export {}`):
  "studio needs Node.js 22 or later; this is vX (path)…" (cli/test/bin.test.ts: syntax scan, a faked Node 18,
  `DEMO_STUDIO_TEST_OLD_NODE` for a real one); `.nvmrc` = 22. **Starter templates** — core `STARTER_TEMPLATES_DIR`;
  `listTemplates` returns the workspace's templates plus the starters no workspace folder shadows, sorted by name (`source`; a same-named folder without a template.yaml is an error, not a silent fallback), `loadTemplate`
  falls back to the starter of that name (editor previews reuse it; doctor and `studio list` mark starters).
  **Keychain** — one line "keychain item S/A not found (reason)"; the CLI hook context logs hook errors at debug level
  (the results list prints them once). **doctor** — ffmpeg / ffprobe below 5.1 fail (`MIN_FFMPEG`; snapshot builds not
  judged). **Scene rest points** (kit `restNear(box, {point, ref})`) — candidates around the click point (±80 px of a
  wide target), inside the dialog that holds the element, neutral; else the nearest neutral gap around the click point
  (`near-<side>`; `<label>`s count as interactive). **Continuing scenes** — keep the cursor only when it is clear of
  the first target and within `KEEP_NEAR_PX` 240 px of its click point, else glide next to it during the still
  (decision recorded in DESIGN §3.3 / README). **Late popups** — a plain click that showed nothing within
  after_click_ms leaves `Runtime.pendingPopup`; the next step, when its target is not on screen yet, waits up to
  popup_timeout_ms after the press for a new popup, then marks the click `popup_opened` and keeps after_popup_ms in
  the click's step (`settleLatePopup`). Tests: kit.test.ts (dialog edge, wide field, dense form), scene-cursor.test.ts
  (far → glide, near → keep, dialog scenes), pacing.test.ts (dialog 450 ms late), core template / templating tests,
  cli doctor / bin tests. Mac re-captures: quote 20261012-191149 and 20261012-191556 (request rests 152 px from
  "Request a quote" in both; delivery at (960,458) between two selects inside the dialog in 191556 — 191149 predates
  the near-scan and rested on the Message field's edge), catalogue 20261012-191245 (scene
  starts unchanged; its known stall after the scroll stays for L1.3). **Review fixes** (a review workflow, each finding
  re-checked): bin.js resolves `main.js` next to the real file (a symlinked `studio` broke) and exits 13 when main()
  never settles; a same-named workspace folder without template.yaml shadows the starter (error, not a silent
  fallback); an out-of-view anchor is judged at its box centre (the kit's point is clipped to the viewport); a clear
  cursor is kept when no spot next to a huge target exists; the late-popup wait ends when the target shows without a
  popup; the scene-start glide's end is recorded (`t_settled`) and the review compares the opening still from 0.3 s
  after it (`stillGlideEnd`, `stillPair(span, fps, timeline)`): no false "screen changes during the opening still".
  893 tests: 886 pass, 7 skipped (full suite green on the Mac, 2 m 43 s). No dependency added.
- **L1.3 done** (capture smoothness on the Mac; R-ISS-01, R-ISS-11, R-ISS-13, R-ACC-02 done, R-ISS-02 and R-ISS-12
  partial): **diagnosis** (a temporary in-recorder trace, removed: every screencast frame, page long tasks and rAF
  gaps) — during the stalls the page had no long task, rAF ran steadily and no frame was dropped: Chromium's frame
  production stopped. Dialog close: 263–266 ms every time an element with a `backdrop-filter` goes away (none without
  the blur, also with animations off; unchanged by Graphite off, GPU raster off, zero-copy, partial raster, SwiftShader,
  CALayer overlays off, `--disable-gpu-vsync`); `--disable-frame-rate-limit` removes it (a web search found related
  backdrop-filter issues on Chrome Mac, not this one). In a standalone page it reproduces only with the kit injected
  and a real hover / press sequence — and none of the kit's parts alone (bindings, kind detection, session save,
  ripple, press state, move handlers, drop-shadow, will-change, top-layer popover, host size, hidden cursor) causes
  it: the next bisect step is in R-ISS-12's gap. After a scroll: a one-time render of newly exposed content (a 0.4 s pause after the first
  scroll removes it; later scrolls do not stall). Hover: 100–400 ms now and then as the cursor enters an element with a
  hover effect (CheckerImaging off, raster threads, low-res tiling: no reliable change). **Decision**: the flag was the
  default during the lot, then a review found that without the limiter a page's rAF runs at ≈ 24,000 Hz while any CSS
  animation is on screen (2–6× CPU; animations stepping per frame play too fast) → the limiter stays, the flag is an
  option. **Changes**: session.ts `frameRateArgs` (core `browser.frame_rate_limit: false` →
  `--disable-frame-rate-limit`, not added twice; schema regenerated); recorder
  `waitFrameAfter` / `lastFrameAt`; Runtime `filming`, `awaitFreshFrame` (after `scroll` and `ensureInView`: 1 px probes
  until 3 frames in a row within 50 ms, ≤ 0.9 s, a probe unanswered for 0.45 s ends it; skipped when the cursor is
  hidden) and `awaitCaughtUp` (Pointer `beforePress` hook + `lastMoveAt`: before a press, wait until a captured frame
  shows the last move, at most until 0.45 s after it; a cancelled run does not press); click.ts (the late-popup
  window counted from the press; the popup re-checked once the next target is found); timeline `motionCapture`
  (motion-only fps, `stalls` ≥ `STALL_MIN_S` 0.15 s in a motion or a ripple, page changes and 1 px probes ignored) +
  run.ts `motionWarnings` (a hint to `browser.frame_rate_limit` when a ripple froze); raw/plan.ts
  `RAW_CUT.result_margin_s` 0.05 → 0.2 s (the catalogue import paints 0.16 s after its DOM). Tried and dropped: dating the cursor
  track by the page's rAF after each move (lands a frame late half the time). Tests: unit (stalls, nudges, page
  changes, warnings, launch args), raw-units (new margin), raw-real (60/30 fps frame tolerance 3, every resting frame
  compared), pacing (late popup: a target found in the same tick as its dialog). Acceptance with the flag (under
  another project's test load, load 4–24): quote 20261012-211506 / -211729, catalogue 20261012-211610 / -211826 — no
  dialog-close stall, one 192 ms hover hitch; quote rendered (quote-v1, 60.0 s, 2 m 09 s) and reviewed clean.
  Acceptance with the defaults: quote 20261012-221656 / -221911, catalogue 20261012-221752 / -222005 — no stall after a
  scroll or in a move, 84 of 84 moves ≥ 24 fps (lowest 51.4), dialog closes 186–264 ms during the ripple, warned with
  the hint (the post-scroll pauses, up to 319 ms, fall in the probes: frames differ only by the 1 px probe).
  896 tests: 889 pass, 7 skipped (the e2e capture test now tolerates a freeze during a click ripple only, R-ISS-12). A review workflow checked the lot (fixed: the default flag, useless 0.9 s press waits,
  the click-time skew of the late-popup window, a press after cancel, nudges counted as motion, the raw-real flakes,
  a stale doc comment). No dependency added.
- **L1.2 done** (runner robustness for any site; R-ISS-07, R-ISS-08, R-RUN-16, R-RUN-17, R-SEC-06, R-CHO-10/13/14/15/18/
  21/24 done, R-KIT-11 closed on the way). Built in five areas, each by a subagent from a design plan and its
  adversarial critique (design workflow), then reviewed by four independent reviewers (≈ 40 findings, one high: shell
  hosts inside `$(…)` were never checked) and fixed in three passes, each finding with a regression test.
  **A — shadow DOM and frames (R-ISS-07)**: everything in the top kit (kit.ts "trees" section: winOf / styleOf / isA /
  deepHit / deepActive / composed order); boxes and points cross the kit boundary in top-level CSS px both ways; refs
  may point into same-origin frames (stale after the frame navigates); ensureInView 6 layers; a missing target behind
  cross-origin frames says "N cross-origin frame(s) not searched"; the text tier is chosen in the searched document
  first (a same-origin widget frame no longer steals a page match). Fixture: "Before you order" at the bottom of every
  product page (`<nf-brew-guide>` with an open shadow root, `/embed/shipping` iframe), scenario `embedded`; tests
  kit.test (shadow, frames, R-KIT-11 forwarding), deep.test (real capture). **B — full-page loads (R-ISS-08)**:
  hold.ts `LoadHold` + recorder (frameNavigated / lifecycle events): frames of a loading document are held until the
  page's own first contentful paint (or load + grace, or the 10 s limit, warned), released frames stamped at the
  release; `timeline.loading` / `tracks[].loading` (`until`, `held_frames`); the kit draws the cursor on a new document
  only after the page's first paint (the cursor faking the first paint was the cause of the blank catalogue shell);
  Runtime `awaitLoaded` / `awaitShownLoaded` before and right after every step (all panes of a multi-page scene), a
  fresh tab's blank hold never awaited; the recorder restarts the screencast when Chromium stops sending frames after
  a paint and asks for a fresh frame after one dropped by the size check (the navigation-test flake); the edit cuts
  held loads ≥ 0.15 s whole (`LOADING_CUT_MIN_S`) except where another page acts, the raw export makes them
  `navigation` cuts. Fixture: "Sales reports" (plain links, a slow report), scenario `reports`. **C — templating and
  secrets (R-RUN-16/17)**: core scenario-template.ts templates each scene / card / interstitial once when reached
  (steps before normalizeStep; the video block after the setup hooks; emit and screenshot names stay literal; a token
  in a `vars` value is a validation error until BL-56); every `{{env:…}}` / `{{keychain:…}}` is a secret, resolved
  before the browser opens; runner-web secrets.ts redacts by path policy (timeline, run record, progress events:
  ids, enums, files and timestamps kept at known positions, everything else masked, incl. URL-encoded forms as Chrome
  serialises them); step descriptions from a fully redacted copy; typing a secret into a visible field warns; hooks
  get `{{run.dir}}`. **D — hook host policy (R-SEC-06)**: js hooks run in a guarded tab per page key (CDP Fetch +
  page.route + routeWebSocket + service-worker bypass + no popups), kept for the session; shell hooks: core
  shell-hosts.ts reads the script command by command (its own assignments, `$(…)` / backticks / heredocs scanned as
  scripts, inline interpreter code, curl / wget / HTTPie / database clients / ssh / git remotes, proxies) at validation
  and again at run time with the real env; a host computed at run time is refused; what it cannot see is listed in the
  README and BL-57. **E — choreography (R-CHO-*)**: re-click of a menu trigger when nothing opened in 3 s, row-action
  trigger fallbacks (hover reveal, positional last resort), adaptive typing rate (search ≈ 10, default 14, long text
  24 cps), `clear` with keys / native setter / editor fallbacks (frames included), new `date` action (last visible
  month buttons inside the calendar, days compared as dates, quick month runs played up to 3× in the edit), opt-in
  `park` modifier (after a scroll or a result, away from what changed, never away from a menu the step opened).
  Acceptance (Mac): embedded 20261012-225230 (14/14, no warning, worst 54.5 fps); reports 20261013-120620 (5 held
  loads, 1.38 s mid-scene, 1.36 s at scene open), live-quote -120643, phone-and-desktop -120721, catalogue -120752,
  quote -120904 — no frame under 20 KB (the old catalogue 20261012-211826 had 4 blank ones), no frame inside a held
  load, durations within 0.25 s of earlier runs, only the known R-ISS-12 ripple warnings; signup 20261013-001611 typed
  its `vars`; a scratch env-secret run kept the secret out of log.jsonl / run.json / timeline.json (except captured
  email artefacts, by design); quote's js hook tab still fires the captured notification; scratch calendar / clear /
  park captures looked at frame by frame; renders reports-v2, live-quote-v1, catalogue-v1, embedded-v1 and
  choreo-check-v1 reviewed clean of blank / loading findings. 1142 tests: 1135 pass, 7 skipped. No dependency added.
- **L1.6 done** (sessions & personas; R-AUTH-01..08 done). Planned by a design agent, criticised by an adversarial
  review (14 defects, ≈ 20 % cut), built in two parts (runtime, then user-facing), reviewed by three independent
  reviewers (25 findings) and fixed in three passes (runtime, CLI, a temp-profile sweep). **Model**: `auth.personas`
  per environment (`session: profile | storage_state`, `check`, `login_url` patterns, `login:` steps, `pages`);
  scenes and multi-page specs take `persona:` (`none` for a public page); core `planPersonas` binds every page,
  tab and js hook tab (explicit, then already bound, then the persona's pages, then the legacy `default`); no paths
  in project.yaml — masters under `~/.demo-studio/profiles/<project>/<env>/<persona>/`, snapshots and statuses under
  `~/.demo-studio/sessions/…` (0600 files, 0700 folders; `DEMO_STUDIO_HOME` moves the root). **Runtime**
  (runner-web auth.ts): one browser per persona; each run works on a copy of the master (caches, `Singleton*`,
  `Login Data*`, `Web Data*` skipped; ≈ 20–60 ms for 10 MB) plus the snapshot's cookies — a session cookie without
  expiry survives only in the snapshot; a locked master is refused (a copy of an open profile carries no cookie);
  nothing is written back (BL-59). Preflight after the secrets prefetch, before setup hooks and the recorder:
  every persona the scenario uses is checked off camera; on failure the `login:` steps sign in automatically (secret
  refs resolved lazily, redacted), else `PreflightError` with the exact `studio login … --env … --persona …`. Login
  guard: any filmed page (tabs, downloads, hook tabs, panes) landing on a sign-in pattern fails the run and keeps
  nothing (frames, capture, timeline, screenshots, artefacts, error files); a tab landing on another persona's
  sign-in says so; the status file becomes `expired` (`by: run`). Copies are registered, removed on close, on a second
  Ctrl-C (sync) and by a sweep of stale `demo-studio-session-*` / `-login-*` / `-profile-*` folders. **CLI**: `studio
  login <p> [--env] [--persona] [--auto]` (headed window opened with the saved cookies; closing it signed out never
  replaces a valid snapshot; `--auto` checks first and keeps a valid session), `studio auth status [--project]
  [--check] [--json]`, interactive `studio new` (environments, personas, sign in now or later; validated before the
  questions), `doctor` persona lines (never / expired / in use / git-tracked), SIGINT handling (exit 130, copies
  removed) in every command that opens a session. **Fixture**: sign-in listeners :4403 (console) / :4404 (shop) in the
  same process, cookie `northfield_session` (console: no expiry), invented accounts, `POST /api/auth/expire`; the
  project's env `signed-in` (personas supplier, buyer; passwords from `NORTHFIELD_SUPPLIER_PASSWORD` /
  `NORTHFIELD_BUYER_PASSWORD`); env `local` and every scenario unchanged. Acceptance (Mac, scratch DEMO_STUDIO_HOME):
  `studio login --auto` for both personas (1.6–1.7 s), live-quote signed in 20261013-133904 / -141530 / -152036
  (frames: buyer pane as Demo Café, supplier as Maja Lindqvist; no sign-in URL in any timeline; track frames within
  3 % of env local, the same two ripple warnings), quote signed in 20261013-134020 / -152115 / -155049 (the js hook
  tab ran as supplier and fired the captured notification; PDF fetched as buyer); expired sessions → catalogue
  20261013-134239 failed in 520 ms at 0/21 before any hook with the command; a session expired mid-run →
  20261013-134306 failed at step 3 with nothing kept; reports twice in parallel on one persona + embedded at once all
  succeeded, master untouched; env local quote / catalogue unchanged; `auth status --check` after `curl expire`
  showed both expired (exit 1); `studio new` through a pseudo-terminal. Not proven by a person: a headed `studio login`
  typed by hand (MACOS-CHECKLIST step 8b; the gated `DEMO_STUDIO_TEST_HEADED=1` test drives it by code). 1212 tests: 1204 pass, 8 skipped.
  No dependency added.
- **L1.7 done** (display URLs, read-only & production safety, frozen clock; R-ENV-01..05 done). Planned, criticised
  (11 defects; the clock probe proved the kit had to keep real timers), built in three parts (core + hooks, browser,
  edit side + review + fixture), reviewed by three independent reviewers (23 findings, two high: `fetchLater` and
  SharedWorker writes bypassed the guard) and fixed in two passes. **Environments**: the short form is unchanged
  (`page: url` or `page: {url, display}`); a long form adds `{production, access, pages, read_only: {hosts, allow,
  mocks}}` (keyed union on `pages`); `ProjectConfig.environments` keeps real URLs, settings live in the derived
  `environment_settings`; production is read-only by default; writing there needs `access: read-write` AND
  `--allow-writes` (on run, hooks run / rollback, env reset), else the run is read-only with a notice. **Hooks**
  (core access.ts / hook-writes.ts): writing hooks refused on read-only environments before any browser opens (http by
  method, SQL by a classifier + `BEGIN READ ONLY`, shell unless `writes: false`, rollbacks with their hook, journal
  replays judged by their own environment); hosts that belong only to read-only / production environments are protected
  in every run (`crossEnvironmentHosts`). **Browser guard** (runner-web write-guard.ts): `context.route` in every
  persona realm armed at launch; reads pass, writes are mocked / allowed / stopped (a navigation gets 204, the rest is
  aborted), production guards every host (fail-closed), a non-production read-only environment its page hosts +
  `read_only.hosts`; GraphQL mutations (batches judged whole), keepalive / beacon writes rewritten by an init script,
  `fetchLater` and `SharedWorker` removed, service-worker traffic routed, pages closed through `about:blank`; the
  sign-in tab is exempt only on its sign-in page; js hook tabs stop writes and never mock them; every write lands in
  `timeline.environment.writes`, the run summary and the review. **Display URLs**: edit-time data (project.yaml's current
  table for the run's environment wins, also for runs captured before L1.7); the address bar, `{{page}}` in edit text,
  notifications, raw markers show the display URL; a local URL without one is never drawn (`hidden` urls entry,
  warnings only for layouts that draw a URL); reports never name a local host. **Clock** (runner-web product-clock.ts):
  `clock:` on project / scenario patches only `Date` and Intl's "now" in every document, frame, popup, hook tab and
  dedicated worker, anchored at capture start; timers, rAF and `performance` stay real (Playwright's clock slowed the
  product's own animations to 30 fps with ten rAF loops — dropped); `freeze` opt-in; never on sign-in / check tabs;
  non-existent or ambiguous DST wall times refused. Fixture: display URLs `console. / shop.northfield.example`, env
  `production` (same local server: the refusal demo), `/api/health` `mutations` counter, `/#as-of` price-date line,
  scenario `read-only` (mocked quote POST, clock, browser frame). Acceptance (Mac): read-only takes
  20261013-205843 / -205930 — one mocked POST, `mutations` 0 → 0, "Monday 2 November 2026, 10:24" pixel-identical in
  both; read-only-v4 shows `shop.northfield.example` in the bar and reviews clean; no localhost in report.md /
  report.json / the review timeline / the raw export; `quote --env production` refused before the browser (3 writing
  hooks); env local quote / catalogue / live-quote capture and render as before; an old run re-rendered with `--frame
  browser` (quote-v6) shows the project's display URL; product rAF / timers at full rate with the clock (60 fps, 100
  ticks/s, a burst of 100 timeouts in 0 ms). 1455 tests: 1446 pass, 9 skipped. No dependency added.
- **L1.8 done** (sandbox mode; R-SBX-01..06 done). Planned, criticised (10 must-fix points measured on the Mac:
  loopback-only URLs, snapshots only of a database the sandbox's own compose project publishes, OrbStack accepting a
  busy host port, `up --wait` exiting 0 on timeout…), built in four parts (core manifest + hooks plumbing; the
  `@demo-studio/sandbox` package + process provider + CLI + `run --sandbox`; docker-compose + Postgres snapshot + `init`;
  the fixture's Docker sandbox + SMTP relay + docs), reviewed by three independent reviewers (≈ 30 findings, several
  of data-loss class: `?host=` / `?port=` in database URLs, a second checkout sharing `compose.project`, another
  container on `[::1]` of the same port, a stale-lock race, pid reuse) and fixed in two passes. **Manifest**
  (`sandbox.yaml`, `version: 1`, declared by `sandboxes: {<env>: <file>}` in project.yaml): provider process |
  docker-compose, services with `pages` (url, display) and health, seed steps (http / sql / shell / compose `exec`; no
  js; never rolled back), reset reseed | snapshot, `accounts` → personas with automated login (plain demo passwords
  allowed, masked; under 3 characters refused), mailbox, databases (`external: true` to touch what the sandbox does
  not serve); every URL loopback; a sandbox is never production, always read-write. **Engine** (packages/sandbox):
  state under `<project>/.demo-studio/sandbox/<env>/` (state.json with boot time and process-tree members, an atomic
  take lock with a stale-lock breaker, logs with rotation), process provider (detached groups identified by pid +
  start time, ownership of every port by our own tree via lsof, SIGTERM → SIGKILL, Ctrl-C stops only what the call
  started, seed steps abortable), compose provider (`demo-studio-<slug>-<env>-<path hash>`, folder check on every
  command, `ps` verification after `up --wait`, `docker ps --filter publish` so no other container shares a port,
  connections pinned to the published address), Postgres template-clone snapshot (PG ≥ 13; owned database only; stale
  on seed or image change; ≈ 0.3 s restore vs 1.5–2 s reseed at 114 MB), mailbox cleared and supersede of pending
  rollbacks after each reset. **CLI**: `studio sandbox init | up | down | reset | status | logs`, `studio run --sandbox`
  (up if needed, health, reset, capture; stays up; busy → fail fast), doctor Sandbox / Docker lines (Docker a FAIL only
  when the default sandbox needs it). **Fixture**: process sandbox (env `sandbox`, 4501–4504) and Docker sandbox (env
  `sandbox-docker`, 4511–4514 + Mailpit v1.29.4 on 4525; host-built bundle, no Chromium so no PDFs), SMTP relay
  (`NORTHFIELD_SMTP`), scenario `sandbox-quote`. Acceptance (Mac): two `run --sandbox` takes of `sandbox-quote` with
  a quote POSTed between them read the same data (`Q-1042`, `Q-1043 · requested Today, 10:24`, identical boxes;
  frames at the marks identical up to encoder noise) on the process sandbox (20261014-021102 / -021133) and the
  Docker one (-021243 / -021311); a control take without reset shows the new row; `signup --env sandbox-docker
  --sandbox` got its email from the real Mailpit; `init` scaffold up / seed / snapshot / restore on Postgres; Ctrl-C
  leaves nothing running; the user's own Docker containers, images, volumes and networks identical before and after
  every step; env local quote unchanged. 1583 tests: 1567 pass, 16 skipped; gated Docker tests 7/7. No new npm dependency (`pg` reused; the lockfile gained the new
  package's importer lines).
- **L1.4 done** (coverage of untested options + automated fixture acceptance; 33 requirements done, "never
  exercised" 0 for phase 1). Planned, built in three parts (scenario-language options; captures, look and run
  lifecycle; formats, Postgres, catalogue capture and close-out — part C was paused on 2026-10-14 and finished on
  2026-10-17), then reviewed by three reviewers whose findings were each adversarially verified (6 of 12 confirmed,
  all fixed). **Tests added**: every scenario option exercised by a test that fails when the option is ignored
  (runner-web widgets.test "options of the scenario language (L1.4)", run.test, kit.test); captures at 2560×1440, 4K
  (scale 2, `keep_frames: false`) and phone (scale 2) (capture-sizes.test); the cursor and file-chip look with
  structural checks + tolerance goldens (look.test, test/golden/; chip golden darwin only; rewrite with
  `DEMO_STUDIO_UPDATE_GOLDEN=1`); SIGINT / SIGTERM / AbortSignal on the built CLI (cli e2e.test); `studio hooks run`
  forms; the 7 Postgres tests through `pnpm test:pg` (throwaway `demo-studio-pg-test-*` container with its anonymous
  volume removed — first run on the Mac: 7/7); the committed catalogue scenario captured on the fixture with the debug
  cursor (`pnpm test:slow`, 8 tests, ≈ 75 s: hotspot ≤ 0.5 px from every click). **Code fixes found by the tests**:
  `wait_for: {network_idle}` never waited for a request started after the page's first idle (runner-web network.ts:
  a per-page in-flight tracker, re-armed on every call, forgetting a frame's requests when it commits a new document,
  a response body still open 1 s after its headers no longer counted — a fire-and-forget fetch of a `no-store` answer
  is never reported as ended; also used by login steps, where a network-idle timeout now fails the step); a cancel
  during a setup hook waited for it (up to 30 s) and a cancel between or during non-shell hooks skipped the rollback;
  teardown skipped after a failed setup; a second signal left shell hooks running; `drop_file` read a file before its
  size check; `studio plan` accepted a newer run.json. **Formats**: optional `version: 1` on scenario / project /
  template / studio YAML and run.json (core formats.ts; missing = 1, newer = one positioned error; hook files have
  none; `studio migrate` is BL-70); run.json `engine` (Demo Studio, Node, Chromium, OS, font digest; runner-web
  engine.ts). **Requirements**: a generated "Never exercised" section in REQUIREMENTS.md and `node
  scripts/requirements.mjs --untested 1` (exits non-zero while phase 1 has one); R-RUN-17's real-Keychain check is
  MACOS-CHECKLIST step 10b for the user. 1632 tests: 1608 pass, 24 skipped; test:pg 7/7, test:slow 8/8, Docker-gated 7/7. No dependency added.
- **L3.1 done** (engine API, jobs, MCP server; 16 requirements done, 6 partial — R-MCP-01, R-MCP-03, R-ARC-01,
  R-ARC-02, R-ARC-03, R-GOAL-07, finished by L3.2 / L4.1 / L3.8; R-MCP-02 and R-ARC-05 moved to L4.1). Planned,
  criticised (the critique found shell hooks written by the agent could run arbitrary code on production), built in
  four parts (engine read side + MCP skeleton; jobs + worker; hooks / approvals; sign-in, sandboxes, docs), reviewed
  by two reviewers (16 findings, five safety holes) and fixed with mutation-checked tests. **Engine**
  (packages/engine): workspace / project loading, `executeRun`, hooks context, sign-in and sandbox jobs moved out of
  the CLI, which keeps its options, output and exit codes. **Jobs**: `<workspace>/.demo-studio/jobs/` (job.json written
  once by the submitter then only by the claiming worker; claim and cancel O_EXCL markers; `interrupted` derived from a
  dead worker), `worker.lock` (pid + start + build stamp of every runtime package), a detached `studio worker` that
  stops claiming at the first signal, exits on the next, outlives the MCP session and exits after 60 s idle; core
  `reserveRunId`; `history.jsonl` (runs, renders, stills, export re-renders). **MCP** (packages/mcp; SDK 1.32.1 imported
  only in server.ts): 23 tools, schemas from zod, slugs only, page / mail / hook text under `untrusted`, no Chromium in
  the server process, progress notifications, long-poll `wait_s` ≤ 25 s, `studio mcp --print-config` (stable Node path,
  PATH without pnpm folders). **Safety under trust `mcp`**: `confirm: true` does not count; every shell hook, shell
  seed, destructive hook and destructive / shell / js rollback needs a human approval through elicitation (form lists
  each hook and its rollback), fingerprinted on the raw hook + referenced files and HMAC-signed (key in
  DEMO_STUDIO_HOME), else refused with the `studio …` command; no `allow_writes`; production / read-only hosts of every
  project protected; no `{{env:}}` / `{{keychain:}}` in agent-written text; no file reference outside the project or
  into agent-writable folders; no credential ever passes through a tool (`auth_login` opens a window for the human).
  ARCHITECTURE: ADR-1 amended (engine location vs UI delivery, job input contract, data-flow table: tool results,
  screenshots and page text Claude reads go into the conversation). Acceptance: the whole loop automated with the SDK
  client over stdio on a copy of the fixture (dry run, quote and catalogue captures with frames looked at, an approval
  answered, cancel, `kill -9` of the worker → interrupted, env reset, auth_login auto, sandbox up / reset); `claude mcp
  add` registration checked ("Connected"). Not done: a live Claude Code conversation (the Mac's `claude` was signed
  out) — MACOS-CHECKLIST step 12c for the user; Claude desktop untested. 1738 tests: 1714 pass, 24 skipped. No new dependency (the MCP SDK was
  already declared).
- **L3.2 done** (MCP render / review / export, previews, themes and components; R-MCP-09/11/13–16/29–32 and R-ARC-02
  done; R-MCP-01 / R-MCP-03 stay partial — authoring and record are L3.3 / L3.4). Planned, criticised (network-guard
  spike; two bypasses found: Remotion's `/proxy` and Node-side media downloads), built in three parts, reviewed (5
  findings, the worst a case-insensitive path trick letting a captured download run as Lottie code) and fixed with
  mutation-checked tests. Engine: `planRun` (editor) with two gates under trust `mcp`, render id reserved at submit,
  browser pid recorded and killed by the next worker after a SIGKILL, review folder swapped atomically, history counts;
  engine now depends on editor, review and components (lazy imports). MCP: 36 tools, image blocks (sharp thumbnails made
  on read), every report key / id / code re-derived or moved under `untrusted`, job error messages under
  `untrusted.error`. Acceptance: `pnpm test:slow` now includes the full MCP loop on the fixture (capture quote → render
  editorial → review clean → render motion + laptop → export mp4 / gif / vertical) with frames looked at. 1819 tests: 1791 pass, 28 skipped; test:slow green. No new dependency.
- **L3.3 done** (authoring; R-MCP-22, R-MCP-23, new R-MCP-36 done; R-PRIN-04 partial). User decision: Claude writes
  the scenario, the tool makes no model call. Planned, criticised (ladder cost measured: 48 s per page without a
  per-call cache), built in three parts (kit inventory + runner inspect; inspect job + page_inspect + `studio inspect`;
  scenario_from_script aid + authoring acceptance + docs), reviewed (9 findings, the worst a late JS navigation getting
  a foreign page inspected as `ok`) and fixed with mutation-checked tests. Kit 1.4.0: per-call memo, `inventory`,
  verified suggestions, `checkTargets`, `nameText` (never field contents). Runner: `inspectPage`, `RunOptions.inspect`,
  `KitClient.callOnce`, a main-frame route stopping foreign navigations during an inspection. Engine: `inspect` job
  (pruned to 20, never a queued / running one), `markBoxes` + review `drawMarks`. MCP: `page_inspect`,
  `scenario_from_script` (38 tools), INSTRUCTIONS give the authoring loop. Fixture: `/inspect-lab`. Also fixed: the
  sandbox P6 test flake (a race in the test's fake ps). 1887 tests: 1855 pass, 32 skipped; test:slow green. No new dependency.
- **L3.4 done** (recorder; R-MCP-24 done). Planned, criticised (the binding of `exposeBinding` is visible and forgeable
  by the page — replaced by an isolated world over CDP; a field switched from password to text leaked; a GET form put a
  password in the URL), built in three parts (capture; draft generator + engine + `studio record`; job + MCP + docs),
  reviewed (10 findings: the worst, a write to an API on another host was not seen, so the check replay would repeat it;
  partial passwords masking common words; dropped tokens; tokens in typed URLs; `{{` in typed text) and fixed with
  mutation-checked tests. Files: runner-web `record-session.ts`, `kit/record-script.ts` (kit 1.5.0: `passive`,
  `suggestFor`, `secretField`), core `recording.ts` (event schema + pure generator), engine `record.ts` +
  `jobs/record-job.ts`, cli `record.ts`, mcp `scenario_record`; fixture `/record-lab`. Acceptance in `test:slow`: the
  quote flow recorded through the job by a Playwright driver standing in for the person → draft → validate → run_dry
  15/15, a sentinel password nowhere. 1967 tests: 1934 pass, 33 skipped; test:slow green. No new dependency.

## Working with the fixture
**On a fresh clone (the Mac) none of the runs, renders, reviews or exports named in this file exist** — they are
git-ignored and stayed in the cloud container. Start the fixture, capture (`studio run`), then render / review /
export `latest`; generate the music test bed once with the `generateTestTrack` line below. The fixture's own media
(`projects/northfield-fixture/assets/`) and the frozen test timelines (`packages/*/test/fixtures/`) are committed.

Render, review, export and preview commands (cloud fixture captures: L2.14 acceptance runs 20261012-144004-catalogue and
20261012-144221-quote; earlier runs 20261011-182524-catalogue, 20261011-182706-quote
(before L2.9), 20261012-022141-quote (L2.9: notification + PDF), 20261012-022315-signup (L2.9),
20261012-034207-signup (L2.10: tutorial overlays), 20261012-034247-highlights (L2.10: story cards),
20261012-073840-live-quote and 20261012-080444-phone-and-desktop (L2.11: two pages on one clock),
20261012-093815-own-media (L2.12: your own files) and 20261012-093047-catalogue (L2.12: waits), 20261012-123617-quote (L2.13: quote
captured without the cursor, `run --raw --cursor none`), 20261011-222856-mobile-quote,
and the 4K run 20261011-234009-quote-4k of a scale-2 copy of the quote scenario). Captures need the fixture server
(`node fixtures/wholesale/server.mjs`; stop it with `kill <pid>` — `pkill -f` with its path also matches the shell
that runs it):
```
node packages/cli/dist/bin.js run northfield-fixture signup              # mail, phone cards, tap-open, tutorial overlays (≈ 45 s)
node packages/cli/dist/bin.js run northfield-fixture embedded            # shadow DOM widget + iframe on a product page (≈ 25 s)
node packages/cli/dist/bin.js run northfield-fixture reports             # full-page loads, a slow report held until painted (≈ 20 s)
node packages/cli/dist/bin.js run northfield-fixture highlights          # capture_text + every story card (≈ 46 s)
node packages/cli/dist/bin.js run northfield-fixture live-quote          # shop + console at once (split, ≈ 1 m 15 s)
node packages/cli/dist/bin.js run northfield-fixture phone-and-desktop   # desktop + phone at once (pip, ≈ 50 s)
node packages/cli/dist/bin.js render northfield-fixture live-quote --theme motion --review
node scripts/fixture-media.mjs [--prores]                                # regenerate the fixture's own media (Remotion + ffmpeg)
node packages/cli/dist/bin.js run northfield-fixture own-media           # intro video, outro image, alpha burst, Lottie card + overlay (≈ 45 s)
node packages/cli/dist/bin.js render northfield-fixture own-media --music projects/northfield-fixture/.demo-studio/test-bed.m4a --review
node packages/cli/dist/bin.js render northfield-fixture phone-and-desktop --vertical --review
node packages/cli/dist/bin.js still northfield-fixture live-quote --square --frame 880
node packages/cli/dist/bin.js run northfield-fixture quote --raw --cursor none --selects            # capture without the cursor + raw package (≈ 2 m)
node packages/cli/dist/bin.js export-capture northfield-fixture latest --scenario quote --format prores --fps 60 --cursor layer
node packages/cli/dist/bin.js export-capture northfield-fixture 20261012-073840-live-quote --cursor layer --layer webm
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
Render times in the cloud container (4 CPUs, no GPU, concurrency 3; L2.14: ≈ 4 m per 70 s 1080p video, own-media 46 s
≈ 2 m 50 s; a Mac should be faster): 1080p quote 56.3 s → ≈ 3 m; vertical 1080×1920 → 3 m 13 s,
square 1080×1080 → 2 m 23 s; catalogue 59 s with music → 3 m 34 s; 4K catalogue (export mp4_4k) → 8 m 04 s; WebM (VP9)
transcode of 59 s 1080p → 1 m 25 s; ≈ 8–9 output fps at 1080p; a still ≈ 1–2 s with a cached bundle.

## Evidence per lot (measured in the cloud container)
The renders and packages below are git-ignored (they stay in the cloud container); the acceptance of phase 2 is in
`docs/ACCEPTANCE-phase2.md`.

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

Renders of L2.11 after the code and video review fixes, reviewed with `studio review` and looked at frame by frame
(ffmpeg frames at every click of each page, every acting-page switch and both hand-offs; the café's bell cropped at
10 fps; pane luminance measured across the switches): run **20261012-073840-live-quote** — **live-quote-v7**
(editorial, 42.33 s): the two pages side by side with their labels, the roaster's label takes the accent within
0.3 s of its scene's start (the new Q-1043 row with its "New" pill already in its list), badges on each page's pane;
the roaster sends the proposal (output 29.93 s) and the café's bell shows its unread badge 0.8 s later and rings —
both hand-offs live; **live-quote-v8** (motion, 42.10 s): idle page dimmed, measured — the café pane brightens within
0.37 s of the proposal scene's start (was ≈ 1.3 s late); **live-quote-v9-vertical** (stacked): the idle roaster pane
shows its page from the top-left ("Quote requests" and its subtitle whole, was cut mid-word), pans right only for the
Send-proposal click and settles back at the café's scene. Run **20261012-080444-phone-and-desktop** —
**phone-and-desktop-v9** (editorial, 31.93 s): the desk's cursor rests visible at the centre of the desk page through
the phone scenes (was hidden under the phone, coming out of it), the phone's badges 1–5 inside the phone, the request
arrives in the desk's list during the send scene's hold (live, behind the phone) and the desk scene opens on a still
list; **phone-and-desktop-v10** (motion, 31.70 s): the phone does not grow (growing would reach the caption band; plan
note), the band clear of the phone, the desk dimmed while the phone acts and bright from its scene's start;
**phone-and-desktop-v11-vertical**: the clicked row framed by its leading part (Q-1043, "New", Selowa Ridge) with the
click, and the closing hold on the detail page's title (was the right half of the page). **signup-v14** (motion,
45.97 s, run 20261012-034207-signup; review clean): after the click on the search result the spotlight ring and badge
fade within 0.45 s of the click (were 1.4 s on the gone card), the next spotlight comes in on Request a quote. Reviews:
only the `video-length` warning (32–42 s videos, short on purpose); in the vertical pip the 1342 px row is an info
(`target-outside-view`: its leading part and the click are shown). A first pd capture (20261012-073952, renders
phone-and-desktop-v6/v7/v8-vertical) had the request arrive during the desk's opening still (`loading-scene-start`)
→ the scenario's send scene holds 1.2 s. Superseded: live-quote-v1…v6, phone-and-desktop-v1…v8, signup-v13.
Capture fps per page (the runner's own measure, cursor moves below 18 fps): live-quote buyer 11 of 14 (lowest 9 fps,
the request dialog's backdrop blur), supplier 1 of 2 (lowest 13); phone-and-desktop phone 1 of 12 (lowest 18), desk
none. General capture speed stays L1.3. Render times: ≈ 3 m per 1080p video (42 s), vertical ≈ 3 m 30 s, pip ≈ 2 m 30 s.

Renders of L2.12, reviewed with `studio review` and looked at frame by frame (ffmpeg frames at every segment boundary,
inside the intro and the outro, through the alpha burst — full-resolution crops of its edges over the white dialog and
the dimmed page —, the Lottie card and the Lottie check overlay; audio measured sample by sample against the source
intro). Run **20261012-093815-own-media** — **own-media-v6** (editorial + the test bed, 46.03 s; review clean, 9 info
— the diff against v3 counts as info): the intro is the user's video (coffee bean, "Northfield", tagline) crossfading
into the shop; the burst (VP9 alpha) bursts on the Send request button from the click, rays clean over the dialog and
the dimmed page (no halo, no black fringe); the Lottie cup recoloured in the theme's accent (burgundy) on the paper
card; the check badge Lottie at the top-right of the screen over empty space right of the quotes list; the end-card
image as the outro; record `audio: music+files`. Music (measured on v2, same plan): bass −46.8 dB under the intro ≈
−47.5 dB under footage vs −40.0 / −41.2 dB on the silent Lottie card and the image outro → ducked ≈ 6–7 dB under the
file with sound only. **own-media-v7** (motion + music, 47.17 s; clean, 9 info): fade-black transitions around the
files, the cup in the motion accent (orange) on the night background. **own-media-v8-vertical** (46.03 s; clean,
4 info): the 16:9 intro and outro shown whole on the theme background (`fit: auto` → contain, plan notes), the whole
burst kept in the reframe while it plays, the check badge placed at the bottom-right of the crop (asked top-right: it
would cover the hovered Selowa Ridge row there — plan note) clear of the row and the cursor; record `audio: files`.
Intro audio after the fix: in v8-vertical the intro's gain against `assets/intro.mp4` (least squares per frame) is
1.000 on frames 3–104 then 0.68 / 0.49 / 0.25 (its end ramp; v5-vertical: 0.27 at frame 97 where the crossfade
starts, and no end ramp); v6 − v7 bit-identical over the intro although the crossfade starts at 97 and the
fade-black at 102; v6 vs v2 and v7 vs v3 differ only on frames 96–108 (pictures identical: PSNR ≥ 58 dB); the click
at 3.22 s (sample jump 0.0388) is gone (0.0037, as in the source). The new `overlay-covers-target` on the old plans
flags v5-vertical's badge, not v6 / v7 / v8-vertical. Superseded: own-media-v2 / v3 / v5-vertical (the intro's sound
dipped with a click where the transition began, no end ramp; v5-vertical's badge over the hovered row),
own-media-v1 (run 20261012-090240, 42.7 s: `video-length` warning → the scenario holds longer),
own-media-v4-vertical (16:9 intro and outro cropped by cover → `fit: auto`; its record still says `audio: silent`,
before the `files` label); earlier own-media runs 20261012-085959 / 090124 (the burst first on the cursor, then on a
toast that the cut hid). Run **20261012-093047-catalogue** — **catalogue-v5** (editorial, 70.13 s; review clean,
7 info): the add-product registry spinner is on screen ≈ 2.2 s (was 3.8 s at 1× → `long-wait` warning in
catalogue-v3/v4), frames 58.2–60.4 s looked at; the video is longer than catalogue-v4 (59 s) because this capture ran
slower here (steps took longer; capture fps), not because of the waits (none of the review fixes changes its plan).
Render times: ≈ 2 m 35 s–2 m 55 s per own-media render (1080p and vertical).

Raw packages of L2.13 (`projects/northfield-fixture/exports/`, git-ignored), all re-exported after the review fixes
and each checked: every clip and layer ffprobe'd with `-count_frames` (codec, profile, pix_fmt, fps, frames,
duration, timecode) against `manifest.json`, every cut strictly inside its clip, the FCPXML (well-formed; spine
offsets, durations, asset starts on the frame grid and equal to the clips' timecodes; a ProRes layer's asset start =
its own file's timecode; no WebM layer; markers inside their clips), the OTIO (read by OpenTimelineIO 0.18.1: V1
clips at their sequence position, available range = timecode, `file://` URLs; every other track's clip against its
media — start = its timecode or 0 for WebM, frame count — and its sequence position; markers inside), the EDL (read by
OTIO's cmx_3600 adapter at the package rate: events and LOC locators), the FCPXML again through OTIO's fcpx_xml
adapter, markers.csv = markers.json — script `validate.py` (scratch, not in the repo; L2.14 can add a repo helper if
wanted). The OTIOs of the catalogue and live-quote packages converted with otio-fcp-adapter (FCP 7 XML, Premiere's
route): `file://` pathurls, markers kept (31, 29):
- `20261012-022141-quote-raw-mp430-baked` — 4 clips, H.264 High yuv420p 30 fps, 1700 frames (56.67 s), 35 markers;
  starts / ends looked at (loaded pages, cursor in place).
- `20261012-022141-quote-raw-prores60-layer` — ProRes 422 HQ 60 fps + ProRes 4444 layers + selects (3398 frames);
  each layer composited over its own baked clip (ffmpeg overlay, crops ×2 at the clicks): the drawn cursor covers the
  captured one exactly (hand on "Request a quote"); the baked ripple starts later where the screencast ran at ≈ 9 fps
  (the layer draws the frame's true time).
- `20261012-123617-quote-raw-mp430-none` — `run --raw --cursor none --selects`: no cursor or ripple anywhere (crops at every
  click), effects recorded (icons hand / ibeam / arrow, 17 presses and ripples).
- `20261012-123617-quote-raw-prores60-layer` — its ProRes 60 clips + layers: composited, the kit's hand, ripple and arrow at
  the click points, the same look as the baked captures; the icon switches to the arrow as the request dialog takes
  the pointer (recorded by the kit).
- `20261012-073840-live-quote-raw-mp430-baked` — 8 clips (4 scenes × buyer / supplier, 1440×900, same frames per
  scene; the supplier is on the sequence for "arrives"), 1092 frames, 29 markers (28 before the review: "delivery"
  ends on a 6 ms wait whose step marker fell one frame past the clip and was dropped); both pages' first / last frames
  looked at. `…-raw-mp430-layer` — the same with VP9-alpha WebM layers: no timecode, so out of the FCPXML and from
  media time 0 in the OTIO (the validator checks each against its file); composited with libvpx-vp9 over its baked
  clip at "Send request": the layer's hand on the captured hand.
- `20261012-093047-catalogue-raw-mp430-baked` — 3 clips + selects, cuts: import 2.24 s of loading (17.807–20.051 s:
  the press on "Start import" with its ripple → "921 offers created" fully painted; the resume is now the arrival of
  the first painted frame, 20.051 s) and add-product 4.36 s of page loading (from the URL change after the option
  click → the product page's reveal starting, no skeleton frame); frames 502–504 and 270–272 looked at.

Scratch checks of the review fixes (scratchpad, not in the repo): the catalogue at 60 fps (frame 1005 after the import
cut = the full "Import complete" dialog, was its title only; the navigation cut clean at 542); a copy of signup run
20261012-034207 whose search wait lasts 1 s (the cut starts at the URL change after Enter: "Selo" → "Selowa" typed and
kept, then the results page — the old plan cut from 16.13 s, mid-typing); a copy of the catalogue run whose import
scene ends on its wait (no cut, the 2.24 s of loading kept to the clip's end, a note, mark "import-done" on the last
frame).

## Notes
Notes from L3.4:
- The recorder never uses `exposeBinding` (its binding is visible to the page in Playwright 1.56): everything runs in
  a CDP isolated world (`Runtime.addBinding` scoped to it); the isolated world reports origin "://", so the origin is
  read from the main-world context.
- Secrets: masked in the page (memory of committed / current secret values, ≥ 6 characters) and again on the runner
  side (salted hashes, never written); typed URLs mask token-like path segments and drop token-like query values.
- Writes: on read-write environments any non-GET request from the window counts (whatever its host) to bound the check
  replay; telemetry POSTs cut it early (safe side). A recording holds the single worker as long as the person takes
  (≤ 30 min, `DEMO_STUDIO_RECORD_MAX_MIN`); a worker signal stops and keeps, `job_cancel` discards.
- Playwright `setInputFiles` with buffers fires untrusted events: tests choose files by path through the file chooser.

Notes from L3.3:
- The authoring loop (INSTRUCTIONS): page_inspect → Claude writes the YAML → scenario_validate → scenario_save →
  page_inspect {scenario, until} → run_dry. `scenario_from_script` is an optional deterministic aid.
- Inspections: dry-run semantics (no hooks, writes only as a dry run would), inspection pacing, outputs in
  `<project>/.demo-studio/inspect/<id>/` (never runs/), origin checked on every kit read (`callOnce`, no retry across
  documents) and foreign main-frame navigations answered 204; an automated sign-in refreshes the persona's session like
  any run. Page text only under `untrusted`; labels never include field contents (`nameText`).
- Kit budget: per-call memo; an unscoped nth is not looked up among more than 10,000 matches (`NTH_MAX`).

Notes from L3.2:
- Worker renders are guarded (editor render/network-guard.ts: CDP Fetch on the browser connection, `/proxy` src check,
  `onDownload`, CSP meta; bundle format 2); `studio render` stays open (https: slots work). Remotion binds its bundle
  server on all interfaces (BL-72). The worker ignores EPIPE rejections only (a refused guarded download).
- Trust `mcp` render rules: `planRun` gate 1 (before any read) and gate 2 (every plan asset inside project / run /
  theme); agent-writable folders matched case-insensitively on the on-disk path (macOS); `video.template` a name or the
  project's own; export and review read renders by id with containment checks; `review_get` never trusts report.json
  (keys, codes and ids re-derived, the rest under `untrusted`).
- Images reach the model as MCP image blocks (≤ 4 / 1.5 MB / 1280 px per result, env-overridable); how Claude Code
  counts them against its output limit is unverified (12d).
- New job kinds: core `JOB_KINDS` + the worker's exhaustive switch; failed-job messages of product-facing kinds go
  under `untrusted.error`.

Notes from L3.1:
- Register the MCP server with `node packages/cli/dist/bin.js mcp --print-config` (never `pnpm studio …`: pnpm's banner
  breaks the JSON and its folders end up in PATH); secrets for automated sign-ins go as `-e NAME=…` before the `--` of
  `claude mcp add`; remove the user-scope registration after a test (`claude mcp remove demo-studio -s user`).
- All SDK imports live in packages/mcp/src/server.ts. The MCP process never launches Chromium: everything that opens a
  browser is a job for the worker. Worker log: `<workspace>/.demo-studio/workers/worker.log`; queue:
  `.demo-studio/jobs/`; history: `.demo-studio/history.jsonl`; `DEMO_STUDIO_WORKER_IDLE_MS` sets the idle exit.
- A worker keeps the environment of the MCP server that spawned it; `studio jobs` never starts one. A headed
  `auth_login` holds the queue (concurrency 1) until its window closes. `studio run` in a terminal does not go through
  the queue (it can overlap an MCP capture).
- Trust `mcp` rules (engine approvals.ts, core agent-trust.ts, engine protected-hosts.ts, jobs/signing.ts) must
  survive refactors: no `confirm: true`, approvals for shell / destructive hooks, seeds and rollbacks, fingerprints on
  raw hooks + referenced files, HMAC-signed approvals, no secrets refs, no outside files, protected hosts across
  projects. The CLI (trust `author`) is unchanged.
- New job kinds: add them to core `JOB_KINDS` and the worker's exhaustive switch; untrusted text from the filmed product
  goes under `untrusted` in tool results.

Notes from L1.4:
- Run `pnpm build` before `pnpm test`: the signal tests spawn packages/cli/dist/bin.js (they skip without it). The
  gated suites, one at a time: `pnpm test:pg` (≈ 5 s), `pnpm test:slow` (≈ 75 s), the Docker sandboxes (≈ 65 s);
  `node scripts/test-pg.mjs --all` runs everything this Mac can. Run them after any change to the runner, hooks or
  sandbox, and `node scripts/requirements.mjs --untested 1` at every lot end.
- Goldens (runner-web test/golden/) change with Chromium, GPU and fonts: rewrite them only with
  `DEMO_STUDIO_UPDATE_GOLDEN=1 npx vitest run packages/runner-web/test/look.test.ts`, then look at the PNGs; the
  structural checks carry the assertion.
- `wait_for: {network_idle}` (runner-web network.ts) is re-armed on every call: a page that never goes quiet (long
  polling, a hanging request) now times out and fails the step — and a login step. A response body still open 1 s
  after its headers stops counting. Limit (BL-71): a worker request of an iframe that went away.
- Cancel semantics: a cancel during setup stops a running shell hook (its group), lets an http / sql / js hook end,
  rolls back what ran, then teardown always runs; a second signal SIGKILLs shell hook groups. A cancelled `studio run`
  exits 1 (others: 130) — by design so far.
- Earlier `pnpm test:pg` runs (2026-10-14 / -16) left anonymous Postgres data volumes in Docker (fixed since: `docker
  rm -f -v`); removing them needs the user's OK. `packages/core/test/helpers.ts` `specProjectDir()` leaves tiny
  `$TMPDIR/demo-studio-spec-*` folders (cosmetic).
- The catalogue's two scroll steps take ≈ 0.56 s longer than set (the post-scroll fresh-frame probe, L1.3); the slow
  test allows +1 s.

Notes from L1.8:
- DOCKER: the user runs other compose stacks on this Mac (ports 8025, 1025, 5432, 3000… are theirs). Never stop,
  remove or prune anything not named `demo-studio-*`; no `docker system/volume/image prune`, no `--rmi all`. Gated
  Docker tests (`DEMO_STUDIO_TEST_DOCKER=1 npx vitest run packages/sandbox/test/compose.test.ts
  packages/cli/test/sandbox-docker.test.ts`, ≈ 75 s) create `demo-studio-test-<run token>-*` resources and sweep only
  their own; they need busybox:1.38.0, postgres:17-alpine and axllent/mailpit:v1.29.4 present.
- Diagnose a sandbox: `studio sandbox status [--json]` / `logs <service>`, then `lsof -nP -iTCP:<port> -sTCP:LISTEN`;
  state in `<project>/.demo-studio/sandbox/<env>/` (state.json, take.lock, seed-journal.json, logs/). Fixture ports:
  process 4501–4504, Docker 4511–4514 + Mailpit 4525 (http://localhost:4525 shows the mails); tests copy the manifests
  to free ports.
- Safety rules that must survive refactors: every sandbox URL is loopback; database URLs refuse `host` / `hostaddr`
  / `port` / `service` / `dbname` query parameters and `pg.Client` gets explicit host and port; a snapshot, a mailbox
  clear or a reseed SQL touches only what the sandbox serves (`servedBy`) unless sandbox.yaml says `external: true`;
  compose commands check the project's folder; `up --wait`'s exit code is never trusted; another container on the same
  port (OrbStack accepts `[::1]` next to `127.0.0.1`) is refused; process identity is pid + start time + boot time.
- Seed shell steps (and hooks on a sandbox env) get the process services' `env` plus `DEMO_STUDIO_SANDBOX`, layered
  over the CLI's environment — a recipe never touches the developer's own database. Seeds must drop / truncate what
  they create (a seed runs on the data as the last take left it).
- `--sandbox` does not imply a clock: the server writes real timestamps (BL-68). What still differs between takes:
  server timestamps, UUIDs, caches outside Postgres, the first request after a restore.
- A new workspace package: hand-add its importer lines to pnpm-lock.yaml, then `pnpm install --frozen-lockfile
  --offline` (a plain offline install prunes other-platform entries).
- The fixture's Docker image copies the host-built bundle: after a UI change run `node fixtures/wholesale/build.mjs`,
  then `sandbox up --env sandbox-docker --build`. Clean up after use: `sandbox down --env sandbox-docker`, then remove
  the `demo-studio-northfield-fixture-*` images.

Notes from L1.7:
- `ProjectConfig.environments` always holds the real URLs (both forms); settings only in `environment_settings`
  (absent for short-form projects, so their configs are as before L1.7). Code reading project.yaml raw uses
  `rawEnvironments` / `rawEnvironmentPages`. The schema's keyed union (`misplaced`) turns production / access /
  read_only written in the short form into one targeted error.
- Refusal order in hooks `runOne`: prepare (template) → read-only / protected-host check → destructive confirm → dry; a
  refusal never prompts. Journal replays use `ctx.accessOf(entry.env)`; a refused replay stays pending. The runner
  refuses statically (`writingHooks`) before secrets, sessions or the browser; `runOne` stays authoritative.
- The browser guard is armed only when `guardsWrites(policy)`: read-write runs of projects without production /
  read-only environments are byte-for-byte unchanged. Any context route disables Chromium's HTTP cache and pauses every
  request (invisible locally, slower on remote sites). Pages of a guarded context close through `closePage` /
  `unloadPages`, never `page.close()`. A stopped form POST gets 204 and the page stays; mock one with 303 + location.
- On production every host is guarded: a third-party write (analytics, an identity provider) needs an `allow` rule or a
  mock; an identity provider's sign-in page belongs in `login_url` (the sign-in tab is exempt only on sign-in pages).
- Diagnose writes with `timeline.environment.writes` (outcome blocked / mocked / allowed / passed / exempt, `t`, `via`,
  `protected_by`) and the log line "read-only run: writes to … are stopped (N mocks)". Fixture proof of "no change on
  the server": `curl localhost:4402/api/health` → `mutations` (never reset).
- Display URLs are edit-time data: change `display:` in project.yaml and render again (no re-capture). Hidden local
  entries stay in `urls` (the `tutorial-stale-target` check needs them). `drawsUrl` decides the warnings (browser layout
  unless show_url and tabs are off; split / pip only with `chrome`; device and custom layouts draw nothing).
- The product clock patches only `Date` / Intl "now" (runner-web product-clock.ts): shared and service workers keep the
  real date, a dedicated worker's first lines may too; server-made dates are untouched (BL-65). The kit keeps its own
  real timers anyway (kit 1.3.0: never use page globals for timing in kit code, use `RT`). Session checks and the
  automated sign-in always run on real time.
- SQL hooks on read-only environments run in `BEGIN READ ONLY`; Postgres cases need `DEMO_STUDIO_TEST_PG` (no server
  on the Mac: the classifier is unit-tested, the execution was not).

Notes from L1.6:
- Tests and probes ALWAYS set `DEMO_STUDIO_HOME` to a temp folder: the real `~/.demo-studio` holds the user's own
  signed-in profile (from L1.5). Never launch a browser on it, never touch the Keychain.
- Sign in the fixture personas for a signed-in capture: start the fixture, then
  `NORTHFIELD_SUPPLIER_PASSWORD=… NORTHFIELD_BUYER_PASSWORD=… studio login northfield-fixture --env signed-in
  --persona supplier --auto` (and `buyer`; values in fixtures/wholesale/README.md), then `run … --env signed-in`.
  Expire sessions with `curl -X POST localhost:4403/api/auth/expire` (`/api/reset` does not touch them).
- The lock check relies on Chromium taking a `SingletonLock`: runs launch with channel chromium (`launchTarget`);
  Playwright's default headless shell takes none. `signIn` waits for the browser pid to exit before copying a master
  (Chromium keeps writing the profile after its lock is gone).
- A run that signed in automatically leaves the stored status `expired` with a warning ("signed in automatically for
  run X") — by design: the master was not refreshed. A sign-in screen shown without a URL change is caught only when
  a step fails (then the check re-runs off camera and the message says the session expired). Tokens kept in
  sessionStorage are lost between runs; rotating refresh tokens are not written back (BL-59).
- Bindings: a tab keeps its opener's persona (film another persona's app on its own page); a page id keeps one persona
  per run; `persona: none` pages and their tabs are never guarded; js hook tabs take the persona their page is filmed
  with. Diagnose: persona debug lines in log.jsonl (copy time, check result), statuses in
  `$DEMO_STUDIO_HOME/sessions/<project>/<env>/`, leftover copies `$TMPDIR/demo-studio-session-*`.
- A legacy `auth.profile` (persona `default`) never fails the preflight and is now copied per run (rolling refreshes
  are no longer saved back); a missing legacy `storage_state` file still fails the run. The user's own workspace uses
  the legacy form: it keeps working, signed in through the copy.
- Two runs started in the same second get distinct folders (the later one takes the next free second).

Notes from L1.2:
- Kit, cross-realm rule: no `instanceof`, bare `getComputedStyle` or top-realm constructors on elements that may live
  in a frame — `isA`, `styleOf`, `winOf`. Composed order: a host or frame before what it holds, shadow content before
  slotted content; on pages with components or frames, counts / `nth` / `last_visible` include deep matches. Run the
  `embedded` scenario after any kit change touching frames or shadow DOM.
- `topDialog`, `popupState` and the menu / listbox scopes are deep: a visible role=dialog inside a same-origin iframe
  can win `in: dialog` when nothing is `:modal`. `blankAt` refuses points over frames. A move inside a frame reaches
  the overlay one postMessage later per nesting level.
- Never draw contentful overlay content on a new document before the page's own first paint (kit `revealed` gate):
  Chromium counts it as the page's first paint. Diagnose a hold with `timeline.loading` / `tracks[].loading`
  (`until`: paint / load / limit / left / end; `held_frames`): no frame lies in [t_start, t_end). Chromium can stop
  sending frames after a page paints until the next input; the recorder restarts the screencast. Constants: hold.ts
  8 / 40 / 120 ms, 3 s / 0.5 s grace, 10 s limit; kit reveal fallback 10 s.
- Timing shift: a navigation's paint wait is inside the click (or the step that navigated) — a `wait_for` right after
  it waits ≈ 0 s, so fewer wait-based raw cuts and less wait compression; the held-load cut replaces them. In a
  multi-page scene no step starts while any of its pages is held; a page's held load is cut only beside the other
  pages' inactivity. Known gaps (R-ISS-08): an iframe's own navigation is not held, an app's loading UI after its first
  paint is not (use `wait_for`), a navigation whose request starts after the step returns is awaited at the next step.
- Secrets: every `{{env:…}}` / `{{keychain:…}}` is a secret; values the video may show go in `vars` (literal values:
  a token inside a `vars` value is refused until BL-56). A new timeline or RunRecord string field must be added to the
  path policy in runner-web/src/secrets.ts, or it is redacted. Grep the run folder for a value to check; captured
  email artefacts keep theirs by design. No real Keychain item was used in a step (agents cannot write to the
  Keychain): the user can try one with `security add-generic-password` and a `{{keychain:…}}` step.
- js hooks run in their own guarded tab per page key (not in `session.pages`, never recorded): scenes must `open`
  their page; sessionStorage and page state do not carry over; teardown js hooks do not see the last page. New
  `context.on('page')` / `context.route` code (L1.7) must ignore `session.hookPages`. Shell hooks: a variable in a host
  position after `source`, `read`, `for` or `eval` of computed text is refused as computed; an ssh alias is checked as
  written (list it in `allow_hosts`). Refusals say how the host was reached and name hosts, never URLs.
- `park` is opt-in per step; the change record (MutationObserver, top document, last 500 elements) runs only when a
  step of the scenario parks. `type` without `cps` adapts its rate (fixture scenarios all set `cps`). `date`: English
  and ISO days, the native `input[type=date]` path, no time of day; `kit.calendar()` lists the days it reads.
  `menuTrigger` returns `{ref, hover}`. Kit VERSION 1.2.0.
- Disk: `keep_frames` defaults to true and a capture keeps ≈ 300–400 MB of JPEGs; the Mac's disk filled up during
  L1.2 (29 GB of runs) and the frames of the 2026-10-12/13 runs were deleted with the user's OK. Prune `runs/*/frames`
  now and then.

Notes from L1.3:
- Heavy background work (another project's tests, Spotlight, updaters: load averages of 15–27 seen) slows a capture
  (the catalogue took 1 m 37 s instead of 1 m 12 s) and its motion; the run warns when the capture froze ≥ 150 ms.
  Capture on a quiet machine when it matters.
- A "click ripple" freeze of ≈ 0.26 s at a dialog close is R-ISS-12 (blurred overlay going away). For a capture that
  matters: `browser: {frame_rate_limit: false}` in the project or scenario — check the page's own animations look
  right (rAF unthrottled) and expect 2–6× the CPU.
- Diagnose a stall: `motionCapture` on the run's frames.jsonl + timeline.json (run warnings list them); a frame gap with
  no page long task and steady rAF is Chromium's frame production, not the page's JavaScript.

Notes from L1.5 (the Mac):
- Runs of the pass (git-ignored, on the Mac): catalogue `20261012-181152-catalogue`, quote `20261012-181304-quote`
  (both captured while the user worked), `20261012-181929-quote` (`--headed`), `20261012-182250-quote` (`--raw --cursor
  layer --format prores --fps 60` → `exports/20261012-182250-quote-raw-prores60-layer/`, validated). The step-7 frame
  analyses (tables, crops, scripts) stayed in the session scratchpad; the numbers are in the checklist results and the
  requirements' evidence.
- A capture with `--cursor layer` (or `none`) hides the cursor, so the screen does not change while it moves: fewer
  screencast frames (825 vs 1538 for quote) and no fps check — expected.
- The runner's motion fps (`motionCapture`) averages a move with the rest before its click (the cursor dispatch rate
  caps it near 30–40 fps on the Mac); the motion itself runs at ≈ 60 frames/s. Stalls hide in that average (R-ISS-13).
- Agents may not write to the macOS Keychain (the harness refuses `security add-generic-password`): the user runs that
  line of checklist step 10 themselves.
- Full-suite load (all test files in parallel, many Chromium) once delayed a fixture dialog past `after_click_ms` and
  failed the e2e `popup_opened` assertion (R-MAC-08). Since L5.1 the next step waits up to `popup_timeout_ms` after
  the press for such a late popup (`settleLatePopup`); a failure there now means the dialog took longer than that —
  rerun the file alone before suspecting the runner.
- OpenTimelineIO 0.18.1 does not load on Python 3.14 (`bad any cast`): `~/.venvs/otio` is made with Homebrew's
  `python3.13` on the Mac.

Notes from L2.14:
- Plan markers: `frame` = the marked step's start (the timeline marker, DESIGN §timeline — the raw export's mark
  markers too), `done` = the screen once the step is done. Use `done` when you need "the moment the mark names".
- The composition draws nothing of its own except the theme background and the brand mark (R-CMP-01, DESIGN-phase2
  §2.2); `render-units.test.ts` fails on a colour literal in `src/remotion/`. A new visual = a component.
- To show what a switch changed, review against an explicit render: `studio review <project> <render> --previous
  <id>` (the default previous is the scenario's latest earlier render).
- The CLI switches only the layout (`--frame <style|layout id>`) and the theme (`--theme`); other kinds go through
  `renderVideo({overrides: {components: {...}}})` until L3.2 (MCP) / L4.5 (timeline UI).
- Motion theme + project `frame: card`: an empty caption block stays under the card (BL-54).
- Reproduce the raw validation: `scripts/validate-raw.py` (see README "Raw export for editors").

Notes from L2.13 (raw export):
- The raw export lives in runner-web (`src/raw/`): capture-side (frames, CFR schedule, the kit's look). Its CLI is
  `packages/cli/src/commands/export-capture.ts` (+ `run --raw`). Real imports into Final Cut Pro / Premiere / Resolve
  are R-RAW-06 (Mac, MACOS-CHECKLIST step 12).
- Encoding speed here (4 CPUs, no hardware encoder): MP4 30 fps ≈ 30–40 s per minute of clips; ProRes 422 HQ
  (prores_ks) ≈ 17 fps → ≈ 3 min for 50 s at 60 fps; layers (prores_aw 4444) ≈ 90 fps. VideoToolbox on the Mac would be
  much faster (not wired: the brief names prores_ks; BACKLOG open decision on encoders).
- Runs before L2.13 have no `cursor_effects`: their cursor data / layers use approximated icons, presses and ripples
  (hand over a running step's clickable target); new runs record what the kit drew. A run captured without the cursor
  renders with a plan warning (no cursor in the edited video) — use it for raw exports only.
- Loading cuts only follow wait steps that really waited (≥ 0.3 s); a load the scenario does not wait for stays in the
  clip at real time (the editor's 4× wait speed-up is edit-only). Marked waits keep their moment; `--no-cuts` keeps
  everything; cut markers (magenta) show where the jump cuts are. A cut starts after the step's last recorded press
  (`actionMoment`); an action that runs past what it records (drag, repeated keys, typing in runs before `t_typed`)
  is kept whole. A scene whose last step is a long wait keeps its loading (a note asks for a `hold`): the result after
  it was never filmed in that scene. No fixture run has a type / select right before a long wait — the checks used
  edited copies of real runs (scratch) and unit cases.
- WebM cursor layers are for web players and ffmpeg tools: no timecode (OTIO from 0, not in the FCPXML), alpha only
  through libvpx-vp9 in ffmpeg. Editing tools want `--layer prores` (the default). Whether Resolve takes the WebM
  layers from the OTIO is an optional MACOS-CHECKLIST step 12 item.
- `studio run --raw --json`: RunProgress lines, then `{"type":"raw_export","dir","manifest"}`; `export-capture
  --json` prints the manifest as one document.
- Interchange files reference the clips by absolute path (relink after moving the folder). The EDL has one picture
  track: other pages and layers are in the FCPXML / OTIO only. Clips of different sizes in one sequence (a phone page
  on the sequence of a multi-page scene) skip the selects file with a warning; FCPXML gives each size its own format.
- `exportCapture` refuses to replace a folder that is not empty and not an earlier raw package (`--out` safety).

Notes from L2.12 for L2.13 (kept for reference):
- The run already has what a raw export needs: `capture.mp4` (+ `capture-<page>.mp4` per page of a multi-page scene),
  the CFR frame grid, `timeline.json` (scenes, events with t_start / t_end, markers, cursor samples, clicks with
  target boxes, page segments, idle) — the planner's source ranges (`ClipSegment.source` / `srcFrames`) cut page
  loads; a per-scene clip = the scene's source range (opening still → scene end) without the edit's speed changes.
- Waits now play faster in the edit (R-OWN-05): a raw export should keep real time (1×) — the editor's job.
- User files (`studio/media`, `studio/lottie`) belong to the edit, not to the capture: a raw export can list them in
  its manifest (`planFileRefs`, `themeFileRefs`) so an editor can re-use them.
- The composition bundle's hash covers `COMPOSITION_DEPS` (editor files the composition imports besides
  `remotion/`): add any new module the composition imports (a Lottie player…), or a stale bundle is reused.
- `ClipSegment` stays capture-based; multi-page clips add `panes` / `acting` / `inset`. Overlays carry `pane`;
  `overlayRects` / `mapUseRect` / `useScreen` route them (`staysInInset`: an inset's spotlight and badges stay in it,
  its other free-standing overlays use the main page's room — decide for a new overlay kind, e.g. a Lottie callout).
  An overlay video with alpha drawn over a PiP main page should be clipped around the inset like the others
  (`insetHole`); a `clear` entry may carry the `pane` its box belongs to.
- The reframe changed for every vertical / square plan (leading part of wide targets, leading-edge start, no pan for a
  resting cursor, `settle` for idle panes): earlier vertical / square renders of other scenarios (quote-v9-vertical,
  signup-v8-vertical, catalogue exports) would frame differently if re-rendered — not re-rendered here.
- Known limits of L2.12: ffprobe on PATH (or `$DEMO_STUDIO_FFPROBE`) is needed to check and plan video files (without
  it: a validation warning and the file is planned as unreadable); GIF and dotLottie (`.lottie`) are not read (the
  validation says how to convert); a Lottie with external images or expressions is drawn as `lottie-web` can (warning
  for external images); an overlay file is clipped to the capture screen (never over the caption or the frame); an
  overlay video plays its own length (the fixture's burst outlives the closing dialog by ≈ 0.6 s — 18 frames: the
  dialog closes at frame 892 of own-media-v6, the burst runs 874–909; `duration` shortens it — cut, not faded); a file
  at a screen position picks its corner once for its whole span (it does not move while it shows) and `center` never
  moves (a note when it covers a target); `fit: auto` uses an 80 % threshold (a 4:3 image in a 16:9 video is
  contained; write `fit: cover`); the 4-frame ramps of a file's sound are steps per frame (Remotion's volume is per
  frame) — far below a click (sample jumps 0.0039 at the intro's end vs 0.037 in its chime); renders and reviews made
  before `encoding.audio: files` say `silent` / `music` for videos with an intro's own sound.
- A `wait_for` records no box for what it waited for, so the vertical / square reframe does not aim at it: in
  own-media-v8-vertical the "Quote request sent" toast at the page's bottom-right is cut by the crop's right edge
  during the send scene's last second (it was cut in v5-vertical too; a little more now, because the reframe keeps the
  whole burst in view while it plays). Recording the awaited element's box (runner) and making it a soft reframe
  target would fix it — a candidate for L2.14 or the backlog.
- The overlay keep of the reframe changed for every vertical / square plan with a step overlay (its real start and
  length, its real box): earlier vertical / square renders with callouts (quote-v9-vertical, quote-v10-square) would
  frame slightly differently if re-rendered — not re-rendered here.
- Known limits (L2.11): two pages per scene (`MAX_SCENE_PAGES`); a step badge outlives a target that disappears right after
  its click without a URL change (a closing dialog) by ≈ 1 s (after a navigating click it leaves with the page, the
  spotlight fades within 0.45 s); "leading" means top-left (left-to-right pages); in a stacked vertical split a click
  at a page's far right still cuts the page's left edge (the crop keeps ≥ 0.9 design px per CSS px) — the idle pane
  settles back afterwards; a motion PiP whose caption band is over the screen does not grow its inset (no room); the
  caption band in a split's caption area is centred in that area (not the frame); an idle page's cursor rests near its
  centre whatever the layout; renders killed mid-way leave `renders/.<id>.lock` (removed by hand once here).
- The fixture's shop polls its notifications every second now (the bell rings live): a scenario that expects the bell
  to change only on reload (none here) would see it earlier.

Carried over (from L2.10 notes, still true):
- `capture_text` reads the kit's `visibleText` (innerText, whitespace collapsed): inline children without spaces come
  out joined (the fixture's total reads "€465.00incl. VAT"; the pattern picks the value).
- Preview samples: `scripts/preview-frame-samples.mjs` (needs the fixture running) writes the before/after sample
  frames; `preview/samples.json` has a sample `field` box (manifest `preview.target: field`).
- Dependencies added by L2.10: `qrcode@1.5.4` as a devDependency of components (tests only; the encoder is the kit's).
- Carried over: capture under dialogs is slow (backdrop blur; L1.3); `download` of a file that is neither a PDF nor an
  image keeps the file with a warning; `mail-view` shows the captured `date` unless the
  slot stages one; components drawn over the capture (notification banners) are not known to the reframe;
  `preview.json.source_hash` does not cover the kit (`components preview --all` after a kit change that alters a
  look); still open from L2.8: caption bands over a reframed capture with `layout-raw`, the reframe release jolt
  (≈ 1 %/frame², under the 1.5 % threshold), 4K export ≈ 4× the 1080p time, the interstitial caption fade.
- The fixture videos are ≈ 45–48 s: `video-length` info (the reference look targets 60–120 s, 25 % tolerance); the
  L2.11 ones (31–44 s) get the `video-length` warning — short on purpose (brief: < 60 s each).

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
- (History) The user allowed force-pushes on the cloud working branch `claude/new-session-pq6jtq` to squash WIP
  checkpoints into one commit per phase / lot. On `main`, ask before rewriting history.
- App UI language: English. Conversation with the user: French.

- (2026-10-11) Autonomy granted through the end of phase 4 — superseded on 2026-10-12: autonomy through phase 2 in the
  cloud, then the user decides how many lots to chain (ROADMAP working agreement).
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
- (2026-10-12, L2.14) **Phase 2 done; the work moves to the Mac.** At the end of L2.14 the work is pushed to a new
  `main` branch (no pull request); local Claude Code sessions clone / pull `main` and commit each lot there. The user
  writes in French and gets answers in French; the repository stays in English.

## Conventions
- TypeScript ESM/NodeNext, relative imports end in `.js`; `pnpm build` (= `tsc -b`), `pnpm test` (= `vitest run`;
  `vitest.config.ts` aliases `@demo-studio/*` to `src/`). No new dependencies without a strong reason.
- Commit messages end with the session attribution lines given by the harness. Never commit `runs/`, `renders/`,
  `review/`, frames or videos (git-ignored).
- At the end of a lot: update `docs/requirements.json` (status/evidence/gap), run `node scripts/requirements.mjs`,
  update this file and ROADMAP's status table, commit on `main`, push, report.
- `docs/BACKLOG.md` is maintained by hand (new ideas get the next `BL-` id; nothing there is scheduled).
- Helpers live in the repo (`scripts/`): nothing a later session needs may stay in a scratch folder.

## Environment
On the Mac: see "Mac setup" above (Homebrew ffmpeg, playwright-core's Chromium and headless shell in
`~/Library/Caches/ms-playwright/`, no environment variable needed). The user's Mac (L1.5): Apple M4, 10 cores, 24 GB,
macOS 26.6.2, Node 22.16 pinned in the repository folder by mise (an untracked `mise.toml`; Node 10 elsewhere), pnpm
10.28, ffmpeg 9.0.2, Chromium 141 (+ a newer playwright build in the cache, unused), Python 3.14 by default (3.13 from
Homebrew for OpenTimelineIO), no Final Cut Pro / Premiere Pro / DaVinci Resolve. Full test suite ≈ 2.5 min.

### Cloud container (Linux) — specific to the cloud sessions of phases 1–2
- Chromium 141 via playwright-core 1.56.1 (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); new headless
  (`channel: 'chromium'`). Remotion renders with
  `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` (found through playwright-core's
  registry; `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL` overrides).
- ffmpeg 6.1 on PATH. Postgres 16 installed (`pg_ctlcluster 16 main start`, run as the postgres user).
- No GPU: pages with heavy effects (backdrop blur) are captured at 6–10 fps during cursor motion (L1.3). No display and
  no macOS: login, `--headed`, Keychain and notifications are verified by the user on a Mac (L1.5).
- Python 3.13 without OpenTimelineIO: the raw validation used a scratch venv (`pip install opentimelineio
  otio-cmx3600-adapter otio-fcpx-xml-adapter`).
- Fixture: `node fixtures/wholesale/server.mjs` (console :4401, shop :4402), then
  `node packages/cli/dist/bin.js run northfield-fixture catalogue` (add `--dry` for a rehearsal).
