# Handoff — read this first in a new session

Last updated: 2026-10-11, end of lot L2.4. Working branch: `claude/new-session-pq6jtq`.

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
- **Requirements:** 529 tracked; 273 done, 85 partial; the open ones are assigned to lots L1.2 … L6 (R-ARCH-03 moved
  to L5.3). L2.3: all done but R-ED-22 (partial: `motion.default_zoom` has no consumer — zooms only come from explicit
  hints; needs a product decision). L2.4: all 16 done; R-PROJ-10 / R-PRJ-01 (the `review/` folder) moved to L2.6,
  R-TPL-04 (style_bias has no consumer yet) to L2.5; the R-LIB-*/R-ED-10..14 items are partial (placeholders).
- **Phase 2 so far:** contracts in core (L2.1) + components package (L2.2) + edit planner (L2.3) + render pipeline
  with a placeholder library (L2.4). `packages/{review,mcp}` are otherwise empty; `studio review|export|record|mcp|ui`
  print "available in phase N".

## Next lot
**L2.5 — reference-look components** (M): replace the placeholders `studio/intro-stack`, `outro-stack`, `layout-card`,
`caption-below`, `interstitial-clock`, `transition-crossfade` with the measured values of `docs/reference/look.md`
(R-LIB-00/01/03/06/08/13/17, R-LOOK-01..22, R-THM-04/07, R-ED-11/16, R-TPL-04) — unless the user picks otherwise (L1.2
robustness, L1.3 capture smoothness, L1.5 = the user runs `docs/MACOS-CHECKLIST.md` on a Mac). See ROADMAP.

Render commands (fixture captures exist: runs 20261011-182524-catalogue and 20261011-182706-quote):
```
node packages/cli/dist/bin.js render northfield-fixture catalogue        # → renders/catalogue-v<N>.mp4 + .json
node packages/cli/dist/bin.js render northfield-fixture quote --theme motion
node packages/cli/dist/bin.js still northfield-fixture quote --frame 1409  # one frame as PNG (renders/stills/)
```
Render times here (4 CPUs, no GPU, concurrency 3, 1080p): catalogue 59.0 s → 3 m 38 s, quote 56.3 s → 2 m 59 s
(≈ 8–9 output fps; card frames are no cheaper than clip frames: Chrome software raster + JPEG capture dominate;
concurrency 4, x264 `veryfast`, multi-process Chrome or PNG frames did not help more than ±10 %); a new bundle ≈ 10 s;
a still ≈ 1–2 s with a cached bundle (≈ 12 s when the bundle must be built).

Notes for L2.5:
- Look at stills while iterating: `studio still … --frame n` (or `renderStill`) renders one frame in ~1 s once the
  bundle is cached; every edit of a component file changes the bundle hash (rebuild ≈ 10 s). Key frames worth
  checking: intro middle (frame 48), first frame after each crossfade (segment.from + transition.frames), mid-clip,
  the catalogue "Awards" zoom peak (frame 1579), the quote card (353), interstitial (1155), callout (1409), outro.
- Layout geometry is static and the planner places captions/overlays from it: if layout-card's `width` should move the
  card, teach the planner to derive geometry from params (e.g. a geometry function of params, or one geometry per
  param value) — the placeholder draws the declared 1560 × 877.5 card (exactly 16:9; the manifest geometry is
  {180, 40, 1560, 877.5}). The reference wants the card at y 40 and the caption block at y ≈ 930–1040.
- The brand mark is drawn by the composition (`Brandmark` in DemoVideo.tsx: logo `theme.brandmark.size` (30) +
  wordmark at 0.8× height, gap 10, right-aligned in the layout's `brandmark` rect, vertically centred); the reference
  values (wordmark display 24 px, y ≈ 985) can be matched there or by the geometry's brandmark rect.
- Transition contract (types.ts `direction`): a crossfade renders both segments over the overlap; a dip splits its
  frames (⌊n/2⌋ exiting, the rest entering). The crossfade placeholder eases the entering opacity with (f+1)/(n+1) so
  no frame is fully old or fully new inside the overlap.
- Captions: cues of a clip end at the clip end (overlap included): the caption fades out over the last 0.25 s, so it
  crossfades with its clip. Caption text styles come from `theme.captions` (editorial line 35 px; look.md says ≈ 38).
- `style_bias` reaches every component (`theme.style_bias`) but no component uses it yet (R-TPL-04 partial).
- Vertical: the layouts' `geometry_vertical` screens are 16:9, so the vertical "crop" is the whole capture (small
  text); real 9:16 reframing is L2.8.

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
