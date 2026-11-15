# Handoff — read this first in a new session

**Retake was called Demo Studio before L5.13** (command `studio`, home `~/.demo-studio`, workspace file `studio.yaml`, variables `DEMO_STUDIO_*`): every name in this file is the current one — entries written before L5.13 were rewritten mechanically by `scripts/rename-l513.mjs`, so commands of earlier runs read `retake …`. <!-- old-name: the history line -->

Last updated: 2026-11-12, lot **L7.36** (this file cut to what is true now; the history moved, verbatim, to
[archive/HANDOFF-history.md](archive/HANDOFF-history.md): the states of every lot before L7.35, the hotfix notes
v0.2.1 – v0.2.6, the lot log, the evidence per lot, the notes per lot and the trust rules in them, the cloud
container — under their original headings, so a reference such as HANDOFF "State (after L7.1)" is found there).

## Where things stand
- **Phases 1 – 4 are done** (phases 3 – 4 pending the user's live runs, MACOS-CHECKLIST 12c – 12j and 13a – 13j);
  **phase 5 is under way** (L5.1, L5.2, L5.2b, L5.5 – L5.18 done: the « Épure » Studio, the name Retake, the standalone
  app and its releases, captures first, renders on the GPU, the two hardening lots). The MVP scope is locked to the
  ROADMAP's lots; new ideas go to `docs/BACKLOG.md`.
- **Releases** are tagged on `main` (`vX.Y.Z` → `.github/workflows/release.yml`, `docs/RELEASING.md`): v0.2.0, then the
  hotfixes v0.2.1 – v0.2.6 (the last one on 2026-11-11, field feedback and a demo retro; their notes are in the
  archive). Playwright is still 1.56.1: RELEASING step 1 was skipped for the hotfixes — do it for the next version.
- **Branches.** `main`: the releases. `claude/arch-l6`: the architecture series L6.1 – L6.13 (the 2026-11-04 audit's
  tasks T1 – T14), its pull request waiting for the person's review. `claude/arch-l7`: the lots of the 2026-11-10
  audit's [action plan](audit/2026-11-10/action-plan.md), L7.1 onwards, on top of `claude/arch-l6`. Both carry `main`
  up to v0.2.6 (merged by hand: the hotfixes touch the same files). Code quality and architecture only: behaviour is
  kept, the few visible changes are in the CHANGELOG's [Unreleased].
- **Guards** (each also in the CI's `checks` job, `.github/workflows/ci.yml`): `pnpm typecheck` (the build, then the
  test files), `node scripts/audit/rules.mjs . --check` (the import-rules ratchet), `node scripts/requirements.mjs
  --untested 1` and `--check-cites`, `node scripts/set-version.mjs --check`, `pnpm lint` (Biome's linter held to
  `scripts/lint-baseline.json`). Not in the CI: `pnpm format:check` (Biome's formatter; `pnpm format` writes),
  `node scripts/test-guard.mjs` for migrated tests, and the test suite (on the Mac, BL-163).

## Next steps
1. **On `claude/arch-l7`:** what the [action plan](audit/2026-11-10/action-plan.md) does not mark done — U9's rest
   (C5: one test-support package for the cross-package test imports and the RETAKE_HOME save / restore; more engine
   tests on the memory ports — the hand-off is in the archive's "State (after L7.34)"), U2's rest — then the full suite
   once, and the branch's review.
2. **After the architecture series:** the 2026-11-04 plan's T15 rest and T16 (the measured snapshot,
   `scripts/audit/snapshot.mjs` against `docs/audit/2026-11-04/summary.json`) when the person asks; the desktop
   bundle's staging of stale `dist` outputs to decide (until then `rm -rf packages/*/dist && pnpm build` before a
   bundle).
3. One lot at a time; the user (in French) decides how many — see `CLAUDE.md`.

## Pending for the person
- The review of `claude/arch-l6`'s pull request, then of `claude/arch-l7`.
- The live runs (MACOS-CHECKLIST 8b, 10b, 12b, 12c – 12j, 13a; 13d: the field project with a sandbox, a hook step and
  compact results through Claude Code) and the open questions, gathered in one test document outside the repository.
- R-PRJ-02's wording (SPEC §3 vs ADR-2: the queue stays in files, the index holds a view); the open questions Q1 (first
  buyer) and Q2 (L4.7 scope).
- Open phase-1 items: R-ISS-02 and R-ISS-12 (known capture limits, L1.3) and R-RAW-06 (an import into an editing tool,
  L1.5).

## What this is
Retake: a generic, product-agnostic tool (licence-ready in a V2) that turns a written scenario into a
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
6. `README.md` — the front page; `docs/guide/` — usage, scenario language reference, CLI (the README's reference
   sections since 2026-11-04; `docs/guide/README.md` maps an old "README › section" note to its page).
7. `docs/BACKLOG.md` — everything outside the locked MVP (unprioritised), guard-rails to apply when L1.2–L5.2
   start, recorder precisions for L3.4/L4.8, open decisions; **maintained by hand** from now on (the scratch files of its
   first version are not in the repo: edit it directly, next free id BL-130); `docs/COMPETITION.md` — competitive study
   (2026-10-12).
8. `docs/ACCEPTANCE-phase2.md` — the phase-2 acceptance (renders, reviews, the theme / component switch, R-CMP-01
   audit, own media, raw export validation).

## Lots since the cut
Each lot adds its "State (after <lot>)" section here, above the previous one: newest first (the lead's register helper
inserts it above the first such heading). When this part holds more than a few lots, move the older sections verbatim to
the archive, above its "State (after L7.34)".

## State (after L7.54b)
- **L7.54b done (2026-11-15; branch `claude/arch-l7`)** — the old name's two-letter prefix is gone from generated
  names; the two stored ones are read in their earlier spelling too; one store-new entry of three is moved.
  - Code: the Studio player's virtual modules `retake:composition` / `retake:modules` (esbuild namespace `retake`) and
    its parent meta `retake-parent` (ui player/bundle-player.ts, frame-main.tsx, virtual.d.ts, server/player.ts: only
    those names); the theme's font families `retake-<theme>-display` / `-body` (components theme.ts). New core
    `plan-asset-url.ts` (base context): `PLAN_ASSET_SCHEME = 'retake-asset:'` written, the earlier spelling read
    (`isPlanAssetUrl`, `planAssetName`, `isLoadedUrl`), used by the planner, preview-plan, resolvePlanAssets,
    summarizePlan, servedFileProblems, planFileUses, the review's font check and the scenario check;
    `planTextInPresentSpelling` makes engine `planSignature` sign a render record's plan in the earlier spelling as
    today's (the Studio still counts that render as one of the same edit). Sandbox: the snapshot template is
    `<db>__retake_snap` (as long as the earlier suffix: the 50-character limit holds);
    `PostgresSnapshot.adoptEarlier` renames a template under its earlier name at the next reset (comment, so seed hash,
    kept: restored, not reseeded) or drops it when the present one exists, the state's `template` follows;
    `dropTemplate` removes both. The two readings carry `old-name:` tags; core plan-asset-url.ts and sandbox
    snapshot-postgres.ts are in old-name.test's TAGGED. Store-new: `getScenario` reads through
    `ports.stores.folder(project.dir)` (`ScenarioReadFrom {stores, seen}`; its 14 callers and the views' / board's
    contexts hand `stores`); its baseline entry removed (105 → 104). Docs: DESIGN, DESIGN-phase2, guide/editing,
    guide/sandbox, guide/development, archive/HANDOFF-history follow; CHANGELOG (Unreleased, Changed): the snapshot
    database's name and the plan's names.
  - Tests: new core plan-asset-url.test (both spellings, the scenario check), editor plan-earlier-spelling.test (an
    earlier-spelled plan previews, serves, summarises, checks its files and renders the same stills as today's: one
    real render), sandbox snapshot-earlier-name.test (Postgres: renamed, dropped, never made under the earlier name;
    in `pnpm test:pg`); engine plan-signature-memo +1 (same signature); sandbox compose.test's scaffold (Docker) restores
    a template put back under its earlier name. old-name.test: the two-letter prefix of generated names caught, the
    compositions with a camelCase prefix, the recorder globals not after a digit (planted and kept cases). Two titles
    renamed (the scheme's new spelling), see below. operations-cli fixture follows the plan's new names.
  - Mutations: earlier scheme dropped from the read list → plan-asset-url.test and plan-earlier-spelling.test red;
    planSignature without the respelling → plan-signature-memo red; the rename to a wrong name → snapshot-earlier-name
    red (3); the reset's adoption removed → compose.test's scaffold red; the new short-forms pattern cut, the camelCase
    `\b` put back, the digit let through → old-name.test's scanner red. All restored.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check` (104), test-guard
    (2 renamed titles), `--check-cites` on a scratch copy with the edits: all 0. Alone, green: test:pg (sql,
    agent-sql, snapshot-earlier-name), compose (Docker), plan-asset-url, plan-signature-memo, plan-earlier-spelling,
    components theme / kit / library / scaffolds, core sandbox / import-rules, editor preview-plan / planner-real /
    planner-rules / planner-artefacts, sandbox compose-units / snapshot-take-connections / types-entry, engine
    scenario-view / scenario-actions / timeline-view / comment-proposals, ui board-ops / player-server / timeline-ops
    / player-bundle / player-preview (Chromium), cli operations-cli / test-ci-tier, review checks; old-name green but
    for the register files (below).
  - Not done: the two other store-new entries — comments `todayText` (reached from `listComments` / `getComment` /
    `threadView` / `anchorAt`, whose callers hand only the renders port: ~25 test calls and the CLI's comment command
    would change) and index-db `readSmall` (reached from `WorkspaceIndex.open`, which the Studio server opens from the
    Engine, which hands out no ports): baseline reason rewritten. Component previews not regenerated: their source
    hashes are the components' own files (unchanged), and the stills of a plan with either font family name are
    pixel-identical (plan-earlier-spelling.test).

**Renamed test titles (test-guard's 2 items):** in editor planner-real and preview-plan, the asset scheme's name in the
title follows the new spelling; neither is cited in requirements.json.

**New test files:** packages/core/test/plan-asset-url.test.ts (CI tier), packages/editor/test/plan-earlier-spelling.test.ts
(out: ffmpeg), packages/sandbox/test/snapshot-earlier-name.test.ts (CI tier: skips without Postgres; in test-pg.mjs
PG_FILES). scripts/test-ci.json lists the three.

**For the sibling L7.51 (the Studio player):** lines touched — `packages/ui/src/player/bundle-player.ts` the header
comment line 8–9 (rewrapped), the doc comments of `modulesSource` (154) and `compositionSource` (176), the esbuild
plugin's `onResolve` / `onLoad` (255–260, biome put the onLoad object on 4 lines), `args.namespace === 'retake'` (265),
`args.importer === 'retake:composition'` (268), `args.namespace !== 'retake'` (285); `frame-main.tsx` 31–32 (the two
imports) and 405 (the meta name); `virtual.d.ts` 5 and 16; `server/player.ts` 148 (the meta); `ui/test/player-server.test.ts`
105 and the `retake-asset:` strings of 71–73, 244. Nothing else in the player or bundle.ts.

## State (after L7.51)
- **L7.51 done (2026-11-15; branch `claude/arch-l7`)** — every package entry holds what another package imports from it: the engine's main entry is its façade, the shells' in-process values are `@retake/engine/shell`, the values only other packages' tests use are `@retake/engine/testing`; the adapters' and the Studio's roots are cut to their users; no memory adapter is in a production entry; the record corpus and the Studio's op builder are shared test helpers. Closes A-S4, CC-S5, CC-S9, A-N7 (and A-N4's ui half: `@retake/ui` re-exports no engine name). **A-S10 not done** (Questions 1). R14 / R6 entries of L7.48: 2 removed, the rest justified per entry (Questions 2).
  - Code: `packages/engine/src/index.ts` = `createEngine`, `ENGINE_API_VERSION`, `agentTrust`, `EngineError`, `ENGINE_ERROR_CODES`, `toEngineError` + every type (1,160 → 483 names: 6 values, 477 types; the types stay so that the shells' inferred declarations can name them). New `packages/engine/src/shell-entry.ts` (`@retake/engine/shell`, 150 values, each imported by a cli / mcp / ui source) and `packages/engine/src/testing.ts` (`@retake/engine/testing`, 63 values only other packages' tests and `@retake/test-support` import). Roots: runner-web 418 → 36 + `export type * from './types-entry.js'`; review 131 → 9 + `export * from './checks-entry.js'`; sandbox 165 → 11 + its types entry; editor 396 → 61 + `export * from './plan-entry.js'`; hooks 85 → 17 + `export * from './describe-entry.js'`; ui 216 → 5. Components root and kit untouched (a person's components import the kit); mcp root untouched (47 names, has local code). The engine's own tests (and each package's own) import from the declaring files instead of `../src/index.js` (codemod: ~360 files' import lines rewritten, no behaviour change; tsc is the proof). New `packages/ui/src/testing.ts` (`@retake/ui/testing`: `studioTools`, `StudioToolDeps`). Each new entry has its `exports` key, vitest alias and tsconfig.test.json path; `ENGINE_LAYERS` entries list gains `shell-entry.ts`, `testing.ts`. Editor `remotion/PlanVideo.tsx` and `Preview.tsx` type their props from `@retake/components/geometry`. `docs/audit/target-architecture.md`: the entries paragraph and the engine line.
  - Moves: `packages/core/test/fixtures/records/` → `packages/test-support/src/records/` (data and builders together; `@retake/test-support/records/{build,build-renders,prune-layouts}`; build.ts takes REPO from `../repo.js`; now formatted and linted — no new diagnostic); `packages/ui/test/studio-tools.ts` → `packages/test-support/src/studio-tools.ts` (`@retake/test-support/studio-tools`, on `@retake/ui/testing`). Boy scout: `mcp/test/query-ops-characterization.test.ts` imported `../../ui/src/index.js` relatively → `@retake/ui`.
  - Baseline: 105 → 73 entries. −30 test-reach (the record corpus 26, studio-tools 4: both groups gone), −2 R14 (`PlanVideo.tsx`, `Preview.tsx` → `@retake/components` root: type-only, now the geometry entry). Reasons rewritten for R14, the shell-sources R6 group and both Studio R4 groups (each entry's real dependency named). Lint baseline unchanged (456).
  - Tests: new `packages/engine/test/engine-entries.test.ts` (9; listed in `scripts/test-ci.json` ci): the main entry's values are the façade's six; no `Memory*` name in index / shell-entry; every `/shell` value is named by a shell source that imports `@retake/engine/shell`, count ≤ 150; every `/testing` value is named by another package's test, no product source imports it, count ≤ 63; each adapter / Studio root's names are named by another package through it, and its only star is its own domain entry. Adjusted: editor `plan-entry` and review `checks-entry` "is re-exported by the package root, value for value" (the root-only name lists: `createRenderer`, `renderStill`, `probeMedia`, `ensureBundle`; `reviewRender`, `extractStill`, `thumbnailOf`, `drawMarks`); runner-web and sandbox `types-entry` "names only what the package root exports" (the root's `export type *` counts); import-rules "lists every render entry the editor exports" (`createRenderer` asserted; `renderPlan`, `REMOTION_PREVIEW_BACKEND` are driver parts not on the root; NOT_ENTRIES 7 → 4) and the test-reach pin (left reaches: none). Titles unchanged. Run alone, green: engine engine-entries, engine-facade, ports, integrations, operations, jobs, prune-keeps, pipeline; components scaffolds; editor plan-entry; review checks-entry; hooks describe-entry; runner-web and sandbox types-entry; core import-rules, test-typecheck, records-characterization, run-folder; cli test-ci-tier, app-bundle, prune-keeps; mcp authoring-ops-characterization, query-ops-characterization; ui op-table-snapshot, board-ops.
  - Mutations (each red, restored): an unused value added to shell-entry; `MemoryOutputs` added to index.ts; a ui server source importing `@retake/engine/testing`; an unused name added to the runner-web root; the runner-web root's `export type *` removed (types-entry); the editor root's plan-entry star removed (plan-entry); a test importing another package's test file (`rules.mjs --check` red).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check` (73), `test-guard` (no decrease), `requirements.mjs --check-cites` on a scratch copy with the edits applied — all exit 0.
  - Not done: A-S10 (the Studio player / server's 4 R4 entries) — see Questions 1. The R14 registry loads (editor render.ts, plan-run.ts; review review.ts) wait on a ComponentRegistry port (A-R11 entry). The mcp root (47 names) was not cut.
  - Merged over L7.54 (the lead resolved the conflicts: this lot's specifiers with L7.54's names).
  - Paths cited in docs/requirements.json evidence that changed (edits in `L7.51-requirements-edits.json`): `packages/core/test/fixtures/records/` → `packages/test-support/src/records/` (R-ARCH-19), `ui/test/studio-tools.ts` → `packages/test-support/src/studio-tools.ts` and the 30 pinned reaches (R-ARCH-49). No cited test title changed.

## State (after L7.54)
- **L7.54 done (2026-11-15; branch `claude/arch-l7`)** — the old name's short forms are gone from code, and a scanner
  keeps them out; the glossary's template rule, homonyms and missing words are written down; the doc drift is fixed.
  - Code: editor `remotion/old composition name.tsx` → `remotion/PlanVideo.tsx` (`PlanVideo`, `PlanVideoProps`); composition ids
    `old composition name` / `old composition name` / `old composition name` → `PlanVideo` / `PlanVertical` / `PlanSquare` (contract.ts; nothing
    stores them: contract.ts is hashed into every bundle key, so each cached bundle is rebuilt once); the Studio player's
    the player's composition module exports `PlanVideo` (bundle-player.ts, frame-main.tsx, virtual.d.ts). runner-web `the old recorder name` →
    `pageRecorder` (the runner-web entry names the new one; the package is private, no re-export); the recorder's
    globals `the old in-page prefix Installed / Hash / Token / Flush / Verdict` and its binding `the old in-page prefix _<hex>` → `__retakeRec…`, both
    sides at once (kit/record-script.ts, record-session.ts) and the fixture's forgery page (RecordLab.jsx). Engine
    theme-sense names: `editTemplate` → `editTheme`, `templateView` → `themeEditView` (theme-edit.ts, the façade's
    library-api.ts: renames only), raw-export's `runTemplate` → `runTheme`. Every other `Template*` name is kept and the
    glossary says why (stored format, published name, or filling in).
  - Docs: GLOSSARY — the admission line (holds across processes, under the queue lock), the template-in-code rule, the
    *record* homonym, rows for brand, site extraction, inspection, board, lease, approval · signature (and *sealed*);
    target-architecture — the port list with Outputs and HostResolver (text and diagram), what `EnginePorts` holds;
    DESIGN, DESIGN-phase2, ACCEPTANCE-phase2, guide/editing, guide/development, archive/HANDOFF-history follow the
    renames. Ratchet: the store-new reason rewritten (it was stale: the port exists; the three entries stay, see Not done).
    Lint baseline: the `old composition name.tsx` entry follows the file (same count).
  - Tests: old-name.test gains the old name's short forms (the composition, recorder and in-page prefixes, each not after a letter,
    case-sensitive: `guardsRecordings` is a kept case), planted and kept cases; record-session's page-side filters look for `__retake` (stricter: no `__retake*` name in the main world);
    two titles renamed (test-guard): export-real "old composition name renders the square variant…" → "PlanSquare renders…",
    render-real "old composition name renders the vertical variant…" → "PlanVertical renders…" (the composition's name in the
    title, nothing else changed; R-EXP-06 / R-ED-21 evidence follow in the requirement edits).
  - Mutations: the short-forms pattern removed → the scanner's planted case red; a `__retakeRec…` function planted in
    the fixture page's main world → record-session's "the page cannot see or feed the recorder" red. Both restored.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check` (105 entries),
    `test-guard` (2 renamed titles, above), `--check-cites` on a scratch copy with the edits applied: all 0. Tests run
    alone: render-units, props-contract, theme-edit, glossary, import-rules, raw-export, player-bundle, record-session
    (real recorder, Chromium), render-real (real render), old-name (green but for the register files below).
  - Not done: the store-new entries (getScenario's 14 callers, comments `todayText`, index-db `readSmall`) are not moved
    onto `ports.stores.folder(dir)` — getScenario's file holds the version ledger L7.49b is moving per engine, and the
    callers are in facade/ and views/ (L7.49b's); the other short forms of generated names went with L7.54b (the snapshot database is a name in
    people's sandboxes). The theme-sense `Template*` names in core and the façade's `templates` member stay (the
    glossary's rule says which, and why).

**The lead must apply, or old-name.test stays red** (the new pattern finds the short forms in the register files):
- `docs/requirements.json`: `.private/l7/L7.54-requirements-edits.json` (10 items), then `node scripts/requirements.mjs`.
- `docs/ROADMAP.md` lines 350, 358, 450: `old composition name` → `PlanVideo`, `old composition name` → `PlanVertical`, `old composition name` →
  `PlanSquare` (`perl -pi -e 's/\bold composition name/PlanVideo/g; s/\bold composition name\b/PlanVertical/g; s/\bold composition name\b/PlanSquare/g' docs/ROADMAP.md`).
  Checked on a scratch copy: no hit left in ROADMAP, requirements.json or the regenerated REQUIREMENTS.md.
- A fresh checkout's `packages/editor/dist/remotion/old composition name.{js,d.ts,…}` stays after `pnpm build` (tsc does not
  clean): harmless (hashed, never imported), gone on a clean build.

## State (after L7.49b)
- **L7.49b done (2026-11-15; branch `claude/arch-l7`)** — A-S6 closed: what the engine remembers between calls is one
  engine's, the CLI's commands are handed their ports, the Studio reads a job's files through the JobQueue port, and the
  ratchet's new `engine-state` check holds the engine's use cases and views to no module state (0 baseline entries).
  - Code: `facade/context.ts` `EngineCaches` / `engineCaches()` in the context — `RegistryMemo` and `TimelineMemos`
    (views/timeline-view.ts: the six memos), `RenderMemos` (renders.ts: report summaries, `planSigs` keyed as before),
    `ThemeEditMemos` (theme-edit.ts: `uses` and the template.yaml `versions` ledger), `PreviewSamplesMemo`
    (views/theme-preview.ts), `scenarioVersions` (a `VersionLedger`). Bounds and keys unchanged. Handed down:
    getScenario / saveScenarioText / editScenario / prepareScenarioEdit take `seen` (undefined: a job's own check — remembered
    nowhere, a restore refused); ScenarioViews / ProjectBoards / RecordStudioContext get `seen` (+ `renderMemos`); the
    comment-proposal chain an optional `seen`. Removed from the entry: `memoRegistry`, `clearTimelineViewMemo`,
    `knownScenarioVersion`, `knownThemeVersion`, `buildThemePreview`; added: `RegistryMemo`, `TimelineMemos`,
    `RenderMemos`, `ThemeEditMemos`, `VersionLedger`. Façade: `components.registry()`, `templates.editList()`,
    `templates.previewSpec()`, `timeline.forget()`; `Engine.jobFiles` removed (the Studio uses `components.registry()`
    and `templates.previewSpec()`). JobQueue port `eventsRange(id, offset, max)` and `liveRecord(id, max)` (JobEntries
    `readRange` / `readPrivate` on both adapters; the file one keeps live.json's private-file check); `readLiveChannel(queue,
    jobId)`; ui run-live.ts reads both through the port (`JsonlTail` reads are async now). `ToolContext.startedIn` /
    `InvokeOptions.startedIn` (required): engine_info reads it, the CLI, MCP and Studio shells hand `process.cwd()`.
    CLI: `cliPorts` gone; workspace.ts `cliEnginePorts()` (still the one `enginePorts` root), `GlobalOptions.ports`,
    `main(argv, io, ports?)` makes them on the first command; `onInterrupt(ui, ports, o)`, `workspaceQueue(ws, ports)`,
    `systemProbes(ports)`, `doctorChecks(probes, ws, { ports, … })`, `initWorkspace(dir, ports)`. Four constant Sets typed
    `ReadonlySet` (library-watch, reviews, record-studio, timeline-view). Docs: DESIGN.md (the queue's paths),
    DESIGN-phase2.md, target-architecture.md (engine-state), GLOSSARY.
  - Behaviour: an undo / redo `restore` (scenario, theme) accepts only a version *this engine* showed or wrote (was:
    this process) — the person's decision of 2026-11-15. No CHANGELOG line: the Studio server and the MCP server each
    hold one engine, so no person sees it. A job's own reads (run submit check, render submit's shown-edit check, a CLI or
    job recording's save) remember nothing now; they showed no one. With a memory queue the Studio's live picture reads
    live.json through the queue (memory entries), so a live channel written on disk beside a memory queue is not seen.
    The registry memo's failure clears only its own load (it cleared a newer one too).
  - Tests: new `packages/engine/test/engine-caches.test.ts` (3: per-engine scenario ledger, per-engine registry, memo
    classes apart; in scripts/test-ci.json `ci`); job-queue contract +1 (events by byte range, both adapters);
    plan-signature-memo +1; operations +1 (startedIn); import-rules +1 (engine-state). Pins updated: engine-facade
    SHAPE, engine.test (no jobFiles), the `startedIn` of 14 test files' invoke / ToolContext calls, readLiveChannel's
    callers (live-channel, run-live-pause, stored-formats, ids-characterization), doctor / sandbox / record / app-bundle
    / pipeline-cli (ports handed; pipeline-cli hands its ports to main), the `timeline.forget()` of three timeline
    tests, board-ops / scenario-view / scenario-actions contexts. 24 files run alone, green.
  - Mutations (each red, restored): a `let` back in renders.ts → `rules.mjs --check` red; engine-state without `let` →
    import-rules red; one ledger shared by every engine → engine-caches red; the memory readRange ignoring the offset →
    job-queue (memory) red; engine_info reading `process.cwd()` again → operations red; main() ignoring the ports it is
    handed → pipeline-cli red (2).
  - Gates: tsc -b, pnpm typecheck, lint (456, none new), format:check, rules --check (105 → 105, engine-state 0),
    test-guard (no decrease, no title renamed), check-cites on a scratch copy with the edits: exit 0.
  - Not done: the live channel's writer (worker side) still writes live.json by the file queue's path (`files.live`);
    `JobFiles` stays the file queue's, handed to the worker and the board. Process-wide state outside the use cases and
    views (adapters: jobs/captures.ts, core media probe cache, editor/components module caches) is untouched.

## State (after L7.53c)
- **L7.53c done (2026-11-15; branch `claude/arch-l7`)** — the CI tier passes shuffled with seeds 20261115 and 7. Seed 3
  found 7 more files; they are fixed, and each passes alone with seed 3, but no whole-tier run with seed 3 was left in
  the budget (see Questions). The four gated render and worker files pass shuffled (seeds 11 and 7). The weekly shuffled workflow has landed, and it can also
  be started by hand. The workspace index notices a history.jsonl rewritten in place.
  - Code:
    - Production: only `packages/engine/src/index-db/index-db.ts`, the history reader (Q1 of L7.53b, the lead's
      boy-scout fix). It keeps the sha256 of the file's first line in `meta.history_head`. With the same inode, a
      larger size and another first line, the file is now read again from the start; before, it was read from the old
      offset as if appended, and its first lines were lost. An index built before this lot has no `history_head`, so
      its history is read again once (it is a cache). There is no schema change.
    - Workflow: `.github/workflows/shuffled.yml` (new: the held one plus a `workflow_dispatch` with no inputs). It
      keeps `contents: read` and has no secret, environment or cache; it pushes, publishes and merges nothing.
    - No new dependency and no new test file. Ratchet 105 and lint 456: none new, none stale.
  - Tests:
    - ci-workflow: the held case lands. It now requires the trigger keys to be exactly `schedule, workflow_dispatch`,
      the dispatch to have no inputs (`null`), and no `pull_request`, `push:`, `workflow_run`, `workflow_call`,
      `repository_dispatch` or `inputs:` in the code.
    - Order-dependent under seed 7 (L7.53b's list), now fixed:
      - cli.test: `demo()` runs `retake new demo` once, for whichever case needs it first. The creation case asserts
        its answer, and the usage-error case needs the project to exist. The sandbox describe has a workspace of its
        own (the list holds demo alone) and `sbx()` writes its project in each case.
      - cli jobs.test: a workspace per case.
      - ui events.test: the index-ops case edits its own README and queues its own job (`editReadme()`,
        `queueDryRun()`). The library case reads the event of the component it removes inside its own stream; before,
        that event reached the next case's stream (`components: ['acme']` in the README event).
      - ui theme-ops.test: `mine()` copies editorial → mine once. The copy case asserts its answer, and the seven cases
        that read or edit mine call it.
      - engine render-snapshot.test: the submit case writes the scenario as planned first (the switch case leaves it
        switched).
    - Found by the seed-3 run of the whole tier, each order-dependent alone and now fixed:
      - core ids.test: the case that makes a ULID of time 32^10−1 does it on a module instance of its own
        (`vi.resetModules()`, then a dynamic import). `ulid()` is monotonic within a process, so that time had become
        the time of every later id.
      - cli prune.test: a workspace per case. The older capture is written by the first case (`olderCapture()`); the
        second case counted on the first having pruned.
      - hooks http.test: `api.reset()`, a new helper in hooks/test/helpers.ts. It also resets the fake API's next reply
        id, so the ids a case reads start at 42 whatever ran before.
      - hooks trusted-files.test: the data case removes gen.sh first and after (the run case writes it).
      - ui desktop-answer.test: the not-supervised case runs on a server of its own. The strict case attaches the shared
        server for good. It also asserts `desktop.written` is 0 (+1 expect).
      - ui run-ops.test: the A M2 case removes the supplier's saved session it wrote; the S7 case expects `never`.
    - setup-ops: the two cases that need no server ("Studio-only own ops…", "the shell's stdin lines…") move to a
      shuffled top-level describe. Only the server describe stays `{ shuffle: false }` (closes L7.53b-review finding 2).
    - The gated files:
      - render-own-ffmpeg: `probedAfresh()` (it calls `resetVideotoolboxProbes()`) in the two cases that count the
        probe's calls. The probes are cached per process, so a case that ran earlier had already made them.
      - render-real: `firstRender()` makes v1 once, for whichever case needs it first: the v1 case, the frames, the
        cancel (v2, renders/ = v1 only), and the still. The music case has a workspace of its own.
      - worker-process "SIGKILL mid-run": the case queues its own dry run before the capture. The queued list is held
        exactly as what was queued before plus that dry run, and every one of them must succeed. Before, the case used
        the dry run the SIGTERM case left.
      - render-worker-process: the two render-kill cases hold renders/ equal to its listing before their submit (before:
        `[]`, and the review/export describe's render was there when it ran first). They check the lock by
        `sub.render_id`, not by `synthetic-v1`, and check that the listing before their submit had none of their files.
    - index-db: new case "history.jsonl rewritten in place (the same inode), longer and with another first line…".
      It asserts the same inode, a larger size, the three new lines exactly, and then an append read once.
    - test-guard: no decrease and no retitled test. Expects added: ci-workflow +22 (1 case), index-db +6 (1 case),
      render-worker-process +3, cli +1, events +1, theme-ops +1. No expect weaker and none dropped. No
      `toEqual` → `toMatchObject`, and no timeout changed. desktop-answer adds +1 expect.
  - Runs:
    - CI tier, `pnpm test:ci -- --sequence.shuffle --sequence.seed=<n>`, all 4 runs allowed:
      - 20261115: 382 files, 5151 passed. This run started while the cli and jobs edits were being made.
      - 7: green except index-db's new case. That run read the index-db source while a mutation was in place (the
        symptom is exactly the mutation's), and the case passes alone.
      - 7 again, on the tree with every seed-7 fix: 382 files, 5153 passed, 0 failed.
      - 3, on the same tree: 8 cases in 7 files failed (listed above). They are now fixed (test files only) and pass
        alone with seeds 3, 7 and 11. The whole tier has not been run again with seed 3.
    - The other files that use the hooks fake API (security, seed, read-only, run, secrets, trust, sandbox-refs): alone,
      seeds 3 and 7, green.
    - Each fixed file alone: the default order, then seeds 7, 11, 3, 5 and 20261115 (cli also 1 and 2).
    - Gated files, alone, seeds 11 and 7: render-own-ffmpeg 8/8, render-real 7/7, worker-process 11/11,
      render-worker-process 4/4.
  - Mutations, each red and then restored:
    - index-db: without the head check, the new case is red. With the hash of nothing (every head the same), it is red
      too.
    - shuffled.yml: no dispatch, dispatch inputs, a `pull_request`, `contents: write`, or an `environment` are each red.
    - cli `demo()` made a no-op: 5 cases red.
    - theme-ops `mine()` made a no-op: 8 cases red.
    - events, without the index case's own README and job: red under seed 3. Without the library case's removal event:
      red under seed 7.
    - render-snapshot, without the rewrite first: red under seed 7.
    - jobs, a workspace for the whole file: red under seed 7.
    - hooks `api.reset()` without the id reset: http.test is red under seed 3. run-ops without the cleanup: red under
      seed 3. ids, prune, trusted-files and desktop-answer: their seed-3 failures before the fix are the evidence.
    - For the gated files, the L7.53b failures under seed 11 are the evidence. They were not mutated again (one run
      takes minutes).
  - Gates (exit 0): `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (none new), `pnpm format:check`,
    `node scripts/audit/rules.mjs --check` (105), `node scripts/test-guard.mjs` (no decrease),
    `node scripts/requirements.mjs --check-cites` (no edits).
  - Not done:
    - captures-first-acceptance is still not run (gated, about 10 min, on a quiet Mac).
    - The whole tier with seed 3 after its fixes was not run (the 4-run budget was spent). Only seeds 20261115, 7 and 3
      were tried; the weekly run will try more.
    - stdio-inspect's handlers were not moved in-process (T-10).

## State (after L7.53b)
- **L7.53b done (2026-11-15; branch `claude/arch-l7`)** — a weekly shuffled run of the CI tier, the order-dependent
  files L7.53 left, and 10 files that only a shuffled CI-tier run found, now pass in any order; record-studio's
  in-memory cases run alone.
  - Code: tests and one workflow; no production code, no new dependency. New file: `.github/workflows/shuffled.yml`
    (no new test file). `scripts/test-ci.mjs` needed no change: it already hands what follows `--` to vitest. Ratchet
    105 and lint 456: none new, none stale.
  - The weekly run, `.github/workflows/shuffled.yml`:
    - Trigger: `schedule` only, `17 4 * * 1` (Mondays 04:17 UTC). Like every schedule, it runs main's code.
    - One job, `shuffled`, on macos-15 with a 45 min timeout. It has a read-only token and no secret, environment
      or cache; it pushes, publishes and merges nothing.
    - Its steps are those of ci.yml's `checks` job up to the build, the same ones: checkout (persist-credentials
      false), the pinned Node.js, pnpm, `pnpm install --frozen-lockfile`, `pnpm build`.
    - Then it runs `SEED=$(date -u +%Y%m%d)`, prints the seed and how to replay it, and runs
      `pnpm test:ci -- --sequence.shuffle --sequence.seed="$SEED"`. That shuffles the order of the files and of the
      cases within each file; `{ shuffle: false }` describes keep their order.
    - ci-workflow.test holds all of this in one new case: the trigger, the permissions, no secret, push or publish,
      the pins, the setup equal to checks', and the exact run lines.
  - Order-dependent files fixed. Each now passes alone in the default order and shuffled with at least two seeds
    (most with 7, 11, 3 and 5; the new ones also with 20261115):
    - scenario-view: the no-snapshot case removes the run it adds.
    - prune: the first describe's project is made again for each case.
    - index-db: a workspace per case. In the reuse case, an index is built and closed first, so the next open is
      reused. The FTS case writes its own README. The 400-line history is renamed over the old one: an in-place
      rewrite is read as appended, see Questions.
    - review.test: lazy `cleanCase()` / `cleanReviewed()` fixtures.
    - review-export-jobs: a lazy "reviewed" fixture in both describes.
    - render-jobs: a workspace per case from a capture drawn once. `renderedBefore()` stands for the earlier render
      the id numbering counts. job_list submits its own four jobs, and their ids are asserted exactly.
    - Found by the shuffled CI tier (seeds 20261115 and 7):
      - operations-cli and pipeline-cli: golden tables collected case by case, pinned `{ shuffle: false }` with a
        comment.
      - run-agent-hooks: the run folders counted from the case's own start, and the marker removed first.
      - run-agent-sql-hooks: the trust case uses its own agent-written scenario.
      - mcp http: `closeAll()` first in the two cases that open sessions (the cap is 3).
      - ui library-ops: queued jobs cancelled and counted from the case's start, with ids exact. The seeded cache
        entries are removed `onTestFinished`.
      - ui scenario-edit-ops: short.yaml written back.
      - ui setup-ops: one outer describe pinned `{ shuffle: false }`. It is a chain on one Studio server and HOME:
        a one-way attach, and the link the restart case reads.
      - core helpers: lazy `realAndLink()`.
      - http-discovery: the refusal case makes `.retake/` itself.
  - Gated render and worker files: run once each, shuffled with seed 11. They are still order-dependent and were not
    fixed (see "Gated runs" and "Not done").
  - captures-first-acceptance: the fixture runs on ports 0 instead of 4941–4942 (gated: compiled, not run).
  - reset-hook-approvals "the items": the expected fingerprint's `files` is now computed by the test. It is
    `reset-marker.txt` → the sha256 of its bytes once a reset wrote it, and none before; no longer
    `packageHookRunner().approval.files`.
  - record-studio: `labOnce()` records the lab once, for the first case that needs it. The in-memory cases (Claude's
    recording, B16/B5/B9, B-M5) take the lab's events from it, before their own submit (one window at a time), so each
    runs alone with `-t`. The lab case keeps its 12 checks of what was seen while the window was open: the fixture
    returns them and the case asserts them. The outer describe stays `{ shuffle: false }`; its comment now says which
    cases run alone.
  - Tests: test-guard reports no decrease and no retitled test. Expects added:
    - ci-workflow +21 (one new case);
    - render-jobs +1 (the job ids listed);
    - review-export-jobs +1;
    - run-agent-sql-hooks +1 (the scenario refused before the trust);
    - library-ops +1.
    Expects that changed form (none weaker): run-agent-hooks' runs folder (absolute `[]` → equal to the list before the
    case); library-ops' preview jobs (`toHaveLength(2)` kept on the jobs that are new, and their ids exact); index-db
    `search('blend')` → `search('roast')` after a corrupt rebuild (the setup README's word; the same proof that the
    rebuilt index holds the project).
  - Mutations, each red and then restored:
    - review.test without the review in `cleanReviewed`: the cancel case alone is red.
    - review-export-jobs `reviewed()` skipped: review_get alone is red.
    - render-jobs `renderedBefore` a no-op: the failed-render case is red.
    - index-db without the first build: the reuse case is red.
    - record-studio `labEvents` without `labOnce`: B-M5 alone is red.
    - reset-hook-approvals' expected files forced to none: red under seeds 7, 11, 3 and 5 (the marker exists),
      green in the default order (it does not).
    - shuffled.yml: no shuffle, a `workflow_dispatch`, a different install line, `contents: write` are each red.
    - Fork's ui files: library-ops without the cleanup (seed 7) or the before-filter (seed 20261115) is red;
      scenario-edit-ops without the restore is red; setup-ops without the pin is red (4 cases).
    - helpers / http-discovery: the original failures under seed 7 are the evidence.
  - Gates (exit 0): `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (none new), `pnpm format:check`,
    `node scripts/audit/rules.mjs --check` (105), `node scripts/test-guard.mjs` (no decrease),
    `node scripts/requirements.mjs --check-cites` (no edits).
  - Not done:
    - The CI tier is not yet green shuffled. With seed 7 it still fails in 5 files, each order-dependent alone:
      - cli/test/cli.test (2 cases);
      - cli/test/jobs.test ("lists nothing at first" sees another case's job);
      - ui/test/events.test (2);
      - ui/test/theme-ops.test (5);
      - engine/test/render-snapshot.test (an edit_sha256 of an edit another case left).
    - Other seeds will find more. Until they are fixed, the weekly run will be red: that is what it is for, but it
      should be green before it is trusted. A follow-up lot should run `pnpm test:ci -- --sequence.shuffle
      --sequence.seed=<n>` for a few seeds and fix each file.
    - stdio-inspect passes shuffled (seeds 7 and 11), so nothing was needed for T-5. Moving its handlers in-process
      (T-10) was not done.
    - captures-first-acceptance was not run (gated, about 10 min, on a quiet Mac).
    - The four gated render and worker files are still order-dependent (see "Gated runs"). The usual fixes apply: a
      workspace per case, the render a case reads made by a lazy fixture.

## State (after L7.47e)
- **L7.47e done (2026-11-15; branch `claude/arch-l7`)** — `renderView` is async and reads review/<id>/report.json through the Outputs port (`reviews.readPlain`, memo keyed by `reviews.signature`, as before: lstat, no link followed, the list's 16 MB cap); reviews.ts `rebuilt`, the report check and `reviewImage` read through the port (`holds`: core insideFolder's rule on the port; `readPlain` with `oneName`: O_NOFOLLOW, never blocking, a hard link refused, 8 MB cap — the same words); the memory reviewer reads its render and writes review/ (and its frames' files) through the Outputs it is handed, so on a MemoryOutputs nothing reaches the disk; runner-web `RunOptions.runId` / `runsDir` are required (no reservation of its own: the caller's, the engine's at submit); `retake render --music` has its test (missing, a folder, a link, a link to nothing; disk and memory reads). render-frames keeps its descriptor beside the port (ffmpeg is handed an fd of this machine's disk; said in its module comment). Published surfaces unchanged (CLI / MCP / Studio output, file names, layouts).
  - Code: `outputs/outputs.ts` OutputFolder gains `readPlain(path, { max, oneName? })` (core `PlainFileRead`), `holds(dir, path)` (both real paths — the OS's spelling on a disk — a missing tail kept as spelt; `dir` itself counts; no `..`-prefix rule, unlike `within`), `move(from, to)`; RenderOutputs `named` takes `videoAlone`. `output-files.ts` OutputFs `plain`, `rename`, optional `nativeRealpath`; `realPathKept`, `holdsOf`. Disk: `readPlainFile` (verify `oneName`), `rename`, `realpath.native`. Memory: `plain` by `plainFileVerdict`, `rename` (a file or a folder, EEXIST when the target is there). `renders.ts` `reportOf(reviews, file)` / `reportSummary` / `renderView(reviews, projectDir, …)` async (no node:fs `lstatSync` / core `readPlainFile` left there); callers: `scenarioRenders` and project-board (in order, one at a time). `reviews.ts`: no `existsSync`, no `readPlainFile`; `nodeFileFacts` only for `thumbnail` (a workspace path, not an output). `review/memory-reviewer.ts`: `MemoryReviewerOptions.outputs` required; renders `named`, video `signature(follow)`, writes / `move` / `remove` / `names` / `kind` on `outputs.reviews`; frames' `thumbnailOf` reads `readPlain`, `still` / `marks` write there (their folder must be there, as before); no node:fs import. `render-frames.ts`: module comment (why the descriptor stays). runner-web `capture/options.ts` `runId: string; runsDir: string`; `capture/lifecycle.ts` refuses a missing or bad id ("is not a run id") before any folder; `reserveRunId` / `projectPath` no longer imported there. cli `commands/render.ts` `musicOverride(facts, arg)` (exported; same rule). test-support `capture.ts` `inRunsOf(o)` (runsDir = the project's runs/ unless given). docs/DESIGN.md RunOptions line.
  - Tests: outputs-contract +1 (×2 adapters: readPlain within its cap / missing / through a file / a folder, holds, move), outputs.test +1 (disk: a symbolic link refused, a hard link read unless `oneName`, holds with links in and out and a `..x` folder), reviewer-contract reads back through the case's `outputs` (disk for the package, a MemoryOutputs seeded with the renders for the memory reviewer), reviewer.test +1 (a MemoryOutputs: report, sheet and a frame's file there, no review/ on the disk; a render only on the disk not found), capture-lifecycle +1 (no id, '' and '../x' refused, no driver, no folder), cli render.test +2 (`--music`: disk and memory reads), ids-characterization (renderView awaited). 73 `runScenario(` calls: 66 in 32 runner-web test files wrapped in `inRunsOf(…)` (runsDir = the project's runs/, as the old default; every id as it was), capture-lifecycle's `opts`, auth's concurrent case (two ids reserved by core `reserveRunId` in one second; same assertions), catalogue-acceptance and engine record.test (an id reserved in their runs folder); pipeline-cli's mock unchanged. Assertions kept (test-guard: no decrease, no title changed). Run alone, green (17): engine outputs, reviewer, render-review-inline, review-export-jobs, ids-characterization, record; ui render-ops, board-ops; runner-web capture-lifecycle, run, records-characterization, auth (real browser: three); cli render, pipeline-cli; core import-rules; mcp query-ops-characterization (see Q1).
  - Mutations (each red, restored): `oneName` ignored on the disk (1); `holds` with the `..`-prefix rule (1); `holds` following no link (1); memory `rename` losing files (1); memory plain read of a folder answered (1); the memory reviewer writing report.json to the disk (1); runner-web's fallback id put back (1); `--music` always resolved (2); reviewImage without `oneName` (ui render-ops, 1); the key frames' folder check off (render-ops, 1); `rebuilt` without `holds` (review-export-jobs' tampered report, 1); reportOf's cap broken (board-ops, 2).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (456, none new or stale), `pnpm format:check`, `rules.mjs --check` (105), `requirements.mjs --check-cites` (no edits): exit 0. `test-guard`: no decrease.
  - Not done: the review package's own reads of renders/ and of the run folder and its writes of review/<id>/ (an adapter, out of the engine); renders.ts `renderForWork`'s `existsSync(record.file)` (a path the record names, checked by `recordPathProblem` first; not in this lot's scope); render-frames' descriptor (kept, justified). The memory reviewer's frames read and write through `outputs.reviews` for any path they are handed (a run's screenshot, an inspection's marked.jpg): a test that hands it MemoryOutputs must seed those there.
  - New source file: none. New test file: none.

## State (after L7.49)
- **L7.49 done (2026-11-15; branch `claude/arch-l7`)** — the engine's own layers are explicit and held by the ratchet:
  `ENGINE_LAYERS` (scripts/audit/lib.mjs) places every file of packages/engine/src in kernel · ports · adapters ·
  use-cases · jobs · views · facade · operations · entries, and three new checks hold them with **no baseline entry**:
  `engine-layer` (an import of a higher layer, types included, or a file no path places), `engine-io` (operations/,
  facade/, engine.ts: no value import of node:fs, node:fs/promises, node:child_process, @retake/core/io) and `job-files`
  (a `jobs/<kind>-job.ts` handler names no `JobFiles` / `JobFilePaths`). The host resolver is a port.
  - Code: the views moved to `views/` (scenario-view, project-board, timeline-view, site-list, theme-preview). Today's
    18 crossings fixed by moves, not rewrites: `op-chain.ts` (opChain out of admission.ts, re-exported there),
    `render-request.ts` (the render request's check / plan / latest notice out of jobs/render-job.ts, re-exported
    there), `page-url.ts` (pageOfUrl out of jobs/inspect-job.ts, re-exported), `engine-copy.ts` (engine_info's machine
    reads), the store port's `WriteResult` / `JournalWhat` into store/store.ts (re-exported by storage.ts, journal.ts),
    the doctor on `integrations/*` directly, library.ts `statSignature` / `readBuiltinPreview` and views/site-list.ts
    `stillPlainFile` (the I/O the operations did). JobQueue port: `recordBrowser` / `recordedBrowser` (browser.json,
    both adapters through queue-core); the render / export cleanups and `killRecordedBrowser` take the queue.
    `EnginePorts.hosts` (host-lookup.ts `HostResolver`, `systemHosts`; PORT_ROOTS, loader-use) replaces
    `setProtectedHostResolver` (removed); the checks take it (`checkWorkspaceProtection(ws, hosts, …)`,
    `checkNewProjectHosts`, `protectedHostOf`, `siteHostConflicts`, `createProjectFromRequest`, `extractSiteForAuthor`
    `o.hosts`); façade `templates.siteConflicts(host)` for the template_sites operation. CLI, MCP and Studio outputs and
    file formats unchanged (browser.json written byte for byte as before).
  - Boy scout: with a memory queue the worker wrote a render's browser.json on the real disk (JobFiles of the
    workspace's jobs folder); it is now the queue's, in memory.
  - Tests: import-rules +5 (the layer table, the three checks, holds today), job-queue contract +1 (a recorded browser,
    both adapters), agent-safety on the engine's `ports.hosts` (a `useHosts` stand-in instead of the global setter),
    stored-formats' bad browser.json through a FileJobQueue, review-export-jobs hands a queue; pins updated (ports
    keys + `hosts`, engine-facade `siteConflicts`, HEAVY_JOB_PORTS `hosts: true`). 17 files run alone, green.
  - Mutations: engine-layer's comparison, engine-io's core-io match, JOB_FILE_NAMES shortened → each its test red;
    renders.ts put back on jobs/render-job.js → `rules.mjs --check` red; all restored.
  - Gates: tsc -b, pnpm typecheck, lint (456, none new; 5 keys renamed to views/), format:check, rules --check (105 →
    105: 2 clock-read entries renamed to views/, 0 entries in the three new groups, 0 stale), test-guard (no decrease,
    no title renamed), check-cites on a scratch copy with the edits: exit 0.
  - Not done (A-S6 rest): EngineCaches — the process-wide memos (views/timeline-view.ts six, renders.ts reportMemo /
    planSigMemo, theme-edit.ts usesMemo, views/theme-preview.ts samplesMemo) and the two VersionLedger instances
    (scenarios.ts, theme-edit.ts: one class since earlier, still process-wide); `cliPorts` handed to the commands (still
    the CLI's module singleton); `Engine.jobFiles` still public (the Studio's live run tails events.jsonl by path).

## State (after L7.53)
- **L7.53 done (2026-11-15; branch `claude/arch-l7`)** — the order-dependent files of the audit pass in any order, and
  the slowest incidental waits are gone: −84 s on the three slow files measured alone.
  - Code: tests only. No production code, no test helper with a pin, no new file, no new dependency. No ratchet or
    lint-baseline entry went stale (baseline 106, lint 457, unchanged).
  - T-5, the order dependence: 39 of the audit's 50 order-dependent files were fixed. Each now passes alone with
    `--sequence.shuffle`, seeds 7, 11 and 3 (record-studio: 7 and 11), and in the default order. Three fixes were used:
    - Own state per test: a `beforeEach` workspace, its own engine or project, or a lazy fixture each test awaits.
    - Counts from the test's own start: `before` and the deltas, or hits sliced from the start, instead of `[]` or an
      absolute count on a shared queue or folder.
    - `describe(…, { shuffle: false })` with a comment, only where a chain on one resource is the point: the Sandboxes
      contract suite (`engine/test/sandbox-contract.ts`), the CLI sandbox life cycle (`cli/test/sandbox.test.ts`),
      `sandbox/test/process.test.ts`, `engine/test/sign-in-sandbox-jobs.test.ts`, the "frame comments" chain of
      `mcp/test/stdio-comments.test.ts` and `engine/test/record-studio.test.ts`. record-studio is wrapped in one outer
      describe because its later cases build on the lab its first case records; the file was re-indented.
    - Real causes, beyond leftovers:
      - captures: the first test made the shared folder.
      - reset-hook-approvals: "the items" compared a fingerprint without the files the hook names, which held only while
        `reset-marker.txt` did not exist yet. It now passes the port's files, so the assertion says what the sandbox
        checks.
      - inspect-jobs: a one-job worker settles a job cancelled before it started as its one job. `settle()` now runs
        workers until nothing is queued.
      - process.test: a failed take left the lock held, so later cases failed; the take is now released in a `finally`.
  - T-5, fixed ports: record-studio and ui studio-e2e-record both listened on 4551–4554, so they collided when run in
    parallel. Both now take free ports.
  - T-10, the slow files (each run alone, fresh RETAKE_HOME, before → after):
    - engine record.test: 136.2 → 82.6 s. It keeps both real round trips; the project's pacing is the tests' `FAST`.
    - cli sandbox.test: 51.4 → 31.2 s. It keeps three real takes, with `FAST` pacing and no holds.
    - core import-rules: 17.8 → 7.7 s. The repository is scanned once per file, as the entries already were.
    - Total for the three: 205.4 → 121.5 s.
  - File queue → memory queue, where the queue is incidental:
    - record.test: `MemoryJobQueue` in its RecordPorts.
    - jobs.test: the submit/status case uses its own engine on `memoryJobQueues()`.
    - Left on the file queue on purpose: the files that test the queue, the worker processes and the Studio e2e files,
      since a child-process worker cannot share a memory queue.
  - Tests: test-guard reports no decrease; no title was renamed. Expects added: captures +3, record-jobs +1,
    site-list +1, stdio-approvals +2. Expects that changed form (none weakened):
    - absolute → own-start: agent-safety job count, comments thread folder, record-jobs ×2, site-job hits, inspect-jobs
      ×2, stdio-record job ids, stdio-site hits.
    - reset-hook-approvals: marker counts as deltas.
    - stdio-approvals: the prune `${ws}` is the case's own workspace.
  - Mutations: the chains pinned with `{ shuffle: false }` were checked by running them shuffled. Before the option they
    were red; with it they are green under the same seeds.
  - Gates (exit 0): `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (none new), `pnpm format:check`, `node scripts/audit/rules.mjs --check` (106),
    `node scripts/test-guard.mjs` (no decrease), `node scripts/requirements.mjs --check-cites` (no edits).
  - Not done:
    - The weekly shuffled run of the CI tier (part of T-5): no workflow was added.
    - The remaining T-10 items: stdio-inspect's handlers in-process; review-export-jobs' export and review.test, which
      are L7.47d's area.
    - The files left to L7.47d: index-db, render-jobs, prune and scenario-view (all order-dependent); review-export-jobs
      and review.test were not checked.
    - Not checked under shuffle: render-own-ffmpeg, render-real, worker-process and render-worker-process (slow, real
      renderer or processes).
    - captures-first-acceptance keeps its fixed ports 4941–4942 (gated, not run here).
    - records-characterization: see Questions.

## State (after L7.47d)
- **L7.47d done, partly (2026-11-15; branch `claude/arch-l7`)** — no engine module outside `outputs/` spells a path into runs/, renders/, review/, exports/ or .retake/inspect/ (the `output-read` check now holds it: `projectPath(…, 'runs'|'renders'|'review'|'exports')`, `statePath(…, 'inspect')`, any `runPath(…)`); the inspect folder's mkdir, render-job's timeline hash and partial removals, export cleanup (its partials and a manifest's leftover `manifest.json.<8 hex>.tmp`), index-db's realpath of renders/ and its signatures, project-board's signatures and renders/ listing, timeline-view's timeline key, reviews.ts's report read go through the port; a run's own files (pictures, frames, videos, scenario snapshot) are read by `outputs/run-files.ts` (moved, `RunFolder`), also for the threads' and proposals' scenario.yaml; `MemoryWorkspace.ports()` hands its `MemoryOutputs`; one handed-project guard for both reviewers; `retake run` releases its listed-run reservation when the run throws; `retake render --music` checks the file through the workspace's reads (CLI render.ts: no node:fs). Published surfaces unchanged (CLI / MCP output, file names, layouts, bytes).
  - Code: `outputs/outputs.ts` `runFolderOf(projectDir, id)`; OutputFolder `removeFile` (one file, a link removed never its target, a folder refused), `makeFolder`, `within(projectDir)` (the member's folder inside the project once links are followed), `signature(path, { follow })`; RunOutputs `readBytes(dir, file)`, `signature(path, { follow })`; OutputFs `readBytes` (disk readFile, memory). `run-files.ts` → `outputs/run-files.ts` (unchanged code; importers, index.ts, DESIGN.md). render-job `removePartials(folder, dir, prefix)` (names + removeFile), `timelineBytes` (runs.readBytes: the bytes as a read sees them, a link followed as readFile followed it). export-job `MANIFEST_TEMP_RE`. inspect-job `inspectRoot` = OUTPUT_DIRS.inspections, makeFolder / remove / `readInspectReport(inspections, file)`. index-db `renders.within`, sources' signatures through the port with `follow` (stat, as before). threads `runInputs` and proposals' snapshot through `RunFolder` (core `scenarioSinceRun(project, run | { then }, …)`: the snapshot handed as text). review `types.ts` `isHandedProject` / `NOT_HANDED_PROJECT` (checks entry and root), used by load.ts `handedProject` and the memory reviewer. cli run.ts: listed run released in the run's catch. cli render.ts: `ws.reads.disk.facts.kind`. Paths only, via the port's layout: hooks journal paths (package and memory hook runners), pipeline's default still, render-frames' renders/, renders.ts's video and report paths, review-job's review dir, memory reviewer's paths.
  - Rules: `output-read` gains `outputPathHits` (scripts/audit/lib.mjs, `OUTPUT_PATH_FOLDERS`); `PORT_ROOTS.MemoryOutputs` + memory-reads.ts. Ratchet 106 → 105 (R6 `cli/src/commands/render.ts → node:fs` gone; the id-grammar entry follows run-files.ts to outputs/; R6 reason now "(ui)"). Lint 457, none new.
  - Tests: outputs-contract +2 (×2 adapters: readBytes and followed signature; makeFolder / removeFile / within), outputs.test +1 (disk: renders/ linked out not within, removeFile removes the link only, followed signature), review-export-jobs +1 (export and render cleanups: partials and manifest temp removed, files only), run-agent-hooks +1 (listed run released when the run throws), import-rules +1 (the new clause) and pinned lists (id-grammar, PORT_ROOTS.MemoryOutputs), reviewer-contract (null and an object without dir refused, ×2), workspace-reads (+1 expect: workspace.outputs is the memory's), io-characterization (+2 expects: scenarioSinceRun's text form), stored-formats and run-thumbs (paths/arguments). Run alone, green (17): core import-rules, io-characterization; engine outputs, stored-formats, workspace-reads, review-export-jobs, reviewer, engine, memory-store, run-thumbs, comments, comment-proposals, inspect-jobs, index-db, timeline-view, render-snapshot; cli run-agent-hooks; engine records-characterization (after the table fix below).
  - Mutations (each red, restored): the new clause off (import-rules); a `projectPath(…, 'review')` put back in review-job.ts (`rules.mjs --check`); removeFile recursive (2); makeFolder a no-op (2); within always true (1); followed signature ignored (1); readBytes undefined (2); manifest temp regexp never matching (1); no release in run.ts (1); guard without the dir check (2); MemoryWorkspace without outputs (1); scenarioSinceRun ignoring `then` (2).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (457), `pnpm format:check`, `rules.mjs --check` (105), `requirements.mjs --check-cites` on a scratch copy with the edits: exit 0. `test-guard`: no decrease, no title changed.
  - Not done:
    - Reads of a path the port gave, still with node:fs: renders.ts `reportOf` (review/<id>/report.json, a sync memo under `renderView`, shared by the board and the render list: async would ripple), reviews.ts `rebuilt` (sync, existsSync + insideFolder) and `reviewImage`'s file (core readPlainFile with an nlink verify), render-frames.ts's video (lstat of renders/, realpath, an O_NOFOLLOW descriptor for ffmpeg), the memory reviewer's writes of review/ (a fake on the disk). The check's title says so ("a path the port gave read with node:fs" is not seen).
    - The review package's own reads of renders/ and of the run folder and its writes of review/<id>/ (an adapter: out of the engine).
    - runner-web's `runId` / `runsDir` fallback made required: 73 `runScenario(` calls in ~38 test files — deferred to a later lot, after L7.53 lands (lead's answer to Q1).
    - `renderView` made async, with a checked plain-file read on the port (renders.ts reportOf, reviews.ts rebuilt / reviewImage, render-frames' video) — deferred to a later lot, after L7.53 lands (lead's answer to Q3).
    - No test of `--music` through the reads (existsSync and `facts.kind` both follow links and say nothing for a broken one; the pipeline-cli fixture records calls by name, a new case would change it).
  - New source file: `packages/engine/src/outputs/run-files.ts` (moved from `packages/engine/src/run-files.ts`: add it, remove the old). No new test file.

## State (after L7.50b)
- **L7.50b done (2026-11-14; branch `claude/arch-l7`)** — partly: the CLI calls operations through the engine's `invoke` (shell `cli`, caller `cli`) with `invokeOperation` (cli/src/invoke.ts); `retake jobs cancel` is the first command on it, printing from job_cancel's data, byte for byte (pinned first). Every other catalogue-served command stays on its engine call: its operation answers MCP's shape (compacted, `untrusted`, path-free, a job where the command works in process), so its text and `--json` cannot be made from that data without changing the operation (Questions). The row's smaller items are done: init reads through the ports and makes `projects/` through the store; the Studio server reads retake.yaml through its own composition root and is under workspace-read; a `doctor-exec` rule; the memory sessions stamped by a clock; contract cases for the memory probe / machine / docker places.
  - Code: cli `src/invoke.ts` (invokeOperation: invoke, a refusal thrown as the operation's EngineError), `commands/jobs.ts` (cancel through job_cancel; the job read first, so that "already X" stays: a queued job just cancelled and one cancelled before both answer `cancelled`). Engine `ProjectStore.makeFolder(ref)` (store.ts; disk: mkdir inside the store's folder, refused as a write's ref; memory: the ref checked, no folder kept — the Map holds files only); `init-workspace.ts` on `ports.reads.disk` (`facts.kind`, `list`) and `store.makeFolder('projects')` (no node:fs left; was "moved, not fixed" in L7.50 — now fixed). Studio server `ui/src/server/ports.ts` `studioPorts` (a PORT_ROOTS root of `enginePorts`), launch.ts and studio.ts read `studioPorts.reads.loadWorkspaceConfig`. `MemorySessions` takes a `clock` (default ManualClock 2026-11-11T12:00Z; `checkedAt` option removed, no user), MemoryCaptureRunner hands it its own. Memory stand-ins brought to the port's shape: the capture probe honours `browser.executable` (said `browser.executable`, not there), the render machine says `policy.ffmpeg` and `ffmpeg: {used: 'library', byRule: true}`. Rule `doctor-exec` (scripts/audit/lib.mjs `DOCTOR_PROBES_HOME`, `doctorExecHits`): node:child_process named in packages/engine/src/doctor/ outside machine-probes.ts. `WORKSPACE_READ_SHELLS` gains `packages/ui/src/server/`.
  - Tests: new `packages/cli/test/jobs-characterization.test.ts` (jobs cancel: queued, finished, running ×2, unknown, malformed — text and exit codes; made with the command before the move), `packages/engine/test/init-workspace.test.ts` (disk and MemoryWorkspace). New cases: project-store contract `makeFolder` (+ a disk-only case in project-store.test.ts), capture-runner contract "the capture browser's probe", renderer contract "the machine", sandbox contract "dockerPlaces", the sessions contract's save case stamped at the adapter's time (memory on a ManualClock away from its default), import-rules `doctor-exec` ×2 and the workspace-read shells case with the Studio server. Run alone, green: jobs-characterization, shell-characterization, doctor-characterization, jobs, init-workspace, project-store, memory-store, capture-sessions, capture-runner (real Chromium), renderer, renderer-editor (the machine case on the editor), sandboxes, import-rules, ui server.
  - Mutations (each red, restored): invoke's shell `studio` (jobs pin: "not an operation the studio serves"); disk makeFolder a no-op, memory makeFolder without its ref check (store contract); init without makeFolder and init reading the folder with node:fs (init-workspace test); init's not-empty check off (shell pin); a loader imported in launch.ts (`rules.mjs --check`); a type import of node:child_process in machine-checks.ts (`rules.mjs --check`); the memory save stamp fixed again (sessions contract); the memory machine without `ffmpeg` (renderer contract); the memory probe ignoring `executable` (capture-runner contract). Equivalent: the memory `dockerPlaces` (`[]`) passes the docker-places case whatever it checks — the case bites on the package adapter.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (457, none new), `pnpm format:check`, `rules.mjs --check` (107, unchanged: the Studio server's two loader imports were fixed in the same change that put it under the rule), `--check-cites` on a scratch requirements.json with the edits: all 0. `test-guard`: 1 title renamed (below), no decrease.
  - Renamed test title (test-guard): import-rules.test.ts > workspace-read "reads the CLI's sources too (a command reads its workspace through its ports' WorkspaceReads); the other shells and adapters are not read" → "reads the CLI's and the Studio server's sources too (a command or a route reads its workspace through its ports' WorkspaceReads); MCP, the Studio front end and the adapters are not read" — the scope grew to the Studio server; every expect kept, two added (a Studio server loader flagged, its other io names free), the "holds today" filter widened to packages/ui/. The "free" example of the first case moved from a Studio server file to a Studio front-end file (the server is read now). R-ARCH-53's evidence cites the new title.
  - New test files for scripts/test-ci.json: `packages/cli/test/jobs-characterization.test.ts`, `packages/engine/test/init-workspace.test.ts`.
  - Requirements: `.private/l7/L7.50b-requirements-edits.json` — R-ARCH-53 evidence (the renamed title, L7.50b's parts) and gap (the commands left, named); status stays `partial`.
  - Not done: invoke routing of every command but `jobs cancel` (Questions 1–3); review 5 of L7.50 (a test of `machineProbes` on memory ports) not taken; the memory store keeps no empty folder (a MemoryWorkspace has folders of its own, the store's Map does not share them). render / review / export internals untouched (L7.47c).

## State (after L7.47c)
- **L7.47c done, partly (2026-11-14; branch `claude/arch-l7`)** — a run file with another name (a hard link) is a refused link in `runs.describe` (run_status, the Studio), by the rule render-frames.ts's videos use (`oneName`, shared by those two; the other nlink checks — the Studio player, library, reviews, comment views, theme-edit, brand — keep their own, same behaviour); the review is handed a loaded project (no slug, no root, no lookup of its own); the engine reserves the run folder of every capture it hands a runner (`CaptureRequest.runId` / `runsDir` required; `retake run` reserves in `runInProcess`); an export's folder and its manifest are the engine's (`render/export-manifest.ts`), the editor's `exportRender` writes the formats where it is told and returns `ExportMade`. Published surfaces unchanged but step 1's decided change: exports/ names and layout, manifest bytes and member order, RenderRecord, CLI / MCP output (pipeline-cli fixture: only option shapes and two placeholders changed, below).
  - Code: `outputs/outputs.ts` `oneName(st)` (nlink === 1) — shared by `render-frames.ts` (both checks) and `output-files.ts` `describe` (after a followed link too); `OutputStat.nlink` (memory: always 1, said in its header); disk `hashFile` refuses a file given another name once opened (EMLINK → refused link). Review: `ReviewOptions.project: LoadedProject`, `root` gone; `load.ts` `handedProject` (refuses a slug / folder / nothing, ReviewError) replaces `openProject` (no `loadProject` in the review); MemoryReviewer refuses the same way; review job and CLI `runReview` no longer pass `root`. Capture: `CaptureRequest = Omit<RunOptions, …'runId'|'runsDir'> & { runId: string; runsDir: string }`; `ExecuteRunOptions.runId` required, `execute-run.ts` hands `runsDir: runsDirOf(project.dir)`; `runInProcess` reserves on `ws.outputs.runs.reserve(…, dateOf(clock))` when no id is given — after the sandbox take or check (`ExecuteRunOptions.runId` is a string or a reservation thunk, called inside executeRun's try) — and `unreserve`s it when the run throws; memory-run has no reservation of its own. runner-web `RunOptions.runId` / `runsDir` stay optional for the package's direct callers (73 real-capture tests), the doc says the engine always hands both. Export: editor `ExportRenderOptions.place: ExportPlace` (required; `out` gone; refused before any lookup when missing, after the project check), `exportRender(): Promise<ExportMade>` (= ExportResult without `manifest` / `created_at`); engine `render/export-manifest.ts` (`exportPlace(exports, projectDir, out)`, `writeExportManifest(exports, made, clock)`: earlier formats of the same render whose file is a file kept, formats' order, `stampOf(clock)`, written by `exports.writeJson`); `ExportWorkOptions` gains `out?` and `ws.outputs.exports`. Docs: CHANGELOG (Changed: hard link), guide/mcp.md (run_status), DESIGN.md (RunOptions), DESIGN-phase2.md (reviewRender, exportRender), guide/editing.md.
  - Rules: ratchet 107 → 106 (`workspace-read memory-reviewer.ts → loadProject` gone; import-rules' pinned list updated). Lint 457, none new.
  - Tests: new `packages/engine/test/export-manifest.test.ts` (6: place, manifest form / order / clock stamp, earlier formats kept or dropped, on disk and memory). outputs.test +2 (hard link: describe on disk, run_status); capture-runner.test +1 (a failed in-process run leaves no reserved folder), 1 retitled; reviewer-contract +1 (×2 adapters: a slug / folder refused, nothing written); render-driver +1 (no place refused). pipeline.test, pipeline-cli (fixture regenerated), records-/ids-characterization (test-support `exportsPlace`), capture-runner-contract, import-rules updated. Run alone, green (18 files): engine outputs, capture-runner, reviewer, export-manifest, pipeline, review-export-jobs, render-frame, inspect-jobs, record-jobs, render-use-case; editor render-driver, records-characterization, ids-characterization, plan-entry, export-real (real render + re-render); cli pipeline-cli; core import-rules.
  - Mutations (each red, restored): describe without the hard-link check (2 red); `oneName` always true (2); no unreserve after a failed in-process run (1); review's project guard off (1, the package reviewer); manifest keeps a missing file (2); manifest keeps another render's entries (2); manifest unsorted (4).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check` (106), `requirements.mjs --check-cites` (no edits): exit 0. `test-guard`: 2 retitled tests (below), nothing lost.
  - Not done (next lot):
    - A-M4 remainders: the review job's and reviews.ts's reads of review/ (and the review package's own write of review/<id>/: the driver writes its artefacts on the disk; `ReviewOptions.out` still defaults to review/<name>), the inspection folder's mkdir in submitInspectJob, render-job's timeline hash, index-db's realpath of renders/, project-board's `lsig` of renders/, a run's pictures / frames / videos, the threads' scenario.yaml reads, the hook journal under runs/, scenario-view's failedAt, `MemoryWorkspace.ports()` outputs; export-job's `cleanupInterruptedExport` still spells exports/<id> with projectPath.
    - The review package still reads renders/ (findNamedRender, readRendersFolder) and the run folder (readTimeline, readRunRecord) itself, and loads the component registry from the project's root when none is handed.
    - The 5 editor-root types `editor-calls.ts` hands on stay (justified): `FoundRender` is built on core io's `NamedRenderFound` (the io side, which the planner entry may not import; moving it needs `NamedRenderFound` moved to core's render entry, and FoundRender is a record-read-counted type); `RenderStillOptions` names the driver's seams of render/render.ts; `PreviewBackend`, `RenderPreviewsOptions`, `RenderLoopsOptions` are the preview driver's (render/preview.ts), which the plan-entry test keeps out of the planner entry. All five are types of the renderer adapter used in the engine's render/ home only (R11 allows type imports there).
  - New test files for `scripts/test-ci.json`: `packages/engine/test/export-manifest.test.ts`. New source file: `packages/engine/src/render/export-manifest.ts`.

## State (after L7.47b)
- **L7.47b done, partly (2026-11-14; branch `claude/arch-l7`)** — the render of a run is the engine's use case: the plan (the editor's planRun), the version reserved, the record written and the files placed on the Outputs port's renders, the video drawn by the renderer it is handed; the editor keeps the rendering (renderPlan, its driver, stills, previews, an export's transcodes) and has no `renderVideo`. Published surfaces unchanged: RenderRecord bytes and member order, renders/ names and layout, CLI output (pipeline-cli fixture: stdout / stderr / exit / history identical) and the MCP / job results.
  - Code: new `packages/engine/src/render/render-video.ts` (`renderVideoWork`, `RenderVideoOptions` with `ws: RenderPlace` — `outputs.renders` and `reads.templateFolderId` — and `clock`: the record is stamped by the Clock port); `render/versions.ts` (takenVersions, nextVersion, versionLockFile, reserveVersion, releaseVersion on `RenderOutputs`; the refusals stay the editor's RenderError, made in `editor-calls.ts` `renderErrors`). `renderWork` refuses a missing renderer before the editor loads and now also releases a reserved version's lock then. `exportWork` hands the editor's `exportRender` a required `rerender` (the engine's use case on its renderer, workspace and clock); `ExportRenderOptions.renderer` is gone. Outputs port: `RenderOutputs.lock` (exclusive create, EEXIST; `OutputFs.createExclusive` on disk and memory) and `RenderOutputs.named` (core findNamedRender on the port's file layer); `findRenderOf(renders, project, arg, scenario?)` reads through it (CLI export / review hand `ws.outputs.renders`). Core io `WorkspaceReader.templateFolderId`. Planner entry gains `RENDER_ENCODING`, `audioOf`, `sceneCaptions`, `recordPathProblem(projectDir, record, files)` (`render-fields.ts`), `themeContentHash` / `themeStatSignature` (`theme-hash.ts`, moved out of render/, on a `ThemeFiles` layer; engine `theme-files.ts` holds node's and `NODE_THEME_HASHES`), and the types `RunRef`, `PlanRunOptions`, `PlannedEdit`, `PlannedRun`, `ExportOutput`, `ExportResult`, `ExportRenderOptions`, `ExportRerender(Request)` (`work-types.ts`). `editor-calls.ts` loses nextRenderVersion / reserve / release / renderPathProblem / themeHashes; it hands on 5 editor-root types only (FoundRender, PreviewBackend, RenderLoopsOptions, RenderPreviewsOptions, RenderStillOptions). The editor loses renderVideo, nextVersion, reserveVersion, takenVersions, versionLockFile. Docs: guide/editing.md, guide/development.md, DESIGN.md, DESIGN-phase2.md state the rule that holds. CLI: `ws` passed to renderInProcess / exportInProcess, `ws.outputs.renders` to findRenderOf (render.ts, export.ts, review.ts: one or two lines each).
  - Rules: `RENDER_CALLS` without `renderVideo` (no such editor entry); the render-call cases of import-rules use `renderPlan`. New import-rules case: the render home's editor-root type re-exports are exactly the 5 above. The planner entry's packages gain `@retake/core/scenario`, `@retake/core/policy`, `@retake/core/run` (types) and `node:crypto` (plan-entry test). Ratchet unchanged (118, no new entry: the use case reads the clock and the template folder through their ports); lint baseline 463 → 461 (two entries gone with renderVideo and the old theme-hash path).
  - Tests: new `packages/engine/test/render-use-case.test.ts` (11: the renderVideo cases of editor render-driver, moved) and `packages/engine/test/render-versions.test.ts` (15: editor render-version, the versions describe of editor ids-characterization and the versions case of render-units, moved); outputs-contract +2 (lock, named; ×2 adapters); pipeline.test (the use case replaced at its module; an export's `rerender` called: the job's renderer, workspace and clock); cli pipeline-cli (the use case replaced at its module; fixture: only the options' shapes — `clock`, `ws`, `rerender` — changed); the 5 real editor tests and render-worker-process render through new helper `@retake/test-support/render-use-case` (`renderRun`, `exportRun`: the engine's in-process render / export on the editor's driver); editor ids- / records-characterization hand `noRerender` (test-support render.ts). Run alone, green (21 files): engine render-use-case, render-versions, pipeline, render-on-renderer, outputs, render-jobs, review-export-jobs, scenario-theme-take, engine-facade, ports, project-store; editor render-driver, ids-characterization, records-characterization, render-units, plan-entry, render-real (real render), export-real (real render + re-render); core import-rules; cli pipeline-cli.
  - Mutations (each red, restored): the version bound `<` → `<=` (4 red); the reserved lock not released on a missing renderer (1); the memory lock without EEXIST (1); the record not written (3); exportRender taking a missing `rerender` (1); one more editor-root type handed on (1); the own-driver options not refused (1).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (461, none new), `pnpm format:check`, `rules.mjs --check` (118), `requirements.mjs --check-cites` on a scratch copy with the edits applied: exit 0. `test-guard`: exit 1 only for 26 titles moved verbatim into the two new engine files (below); no expect or title lost.
  - Not done (next lot):
    - A-S1 review and capture parts: `review/src/load.ts` (the review's workspace lookup), runner-web `capture/lifecycle.ts`.
    - A-M4 remainders: the review job's and reviews.ts's reads of review/, the export's exports/ placement and manifest (still the editor's exportRender), the inspection folder's mkdir in submitInspectJob, render-job's timeline hash, index-db's realpath of renders/, project-board's `lsig` of renders/, a run's pictures / frames / videos, the threads' scenario.yaml reads, the hook journal under runs/, scenario-view's failedAt, `MemoryWorkspace.ports()` outputs.
    - The 5 editor-root types still handed on by `editor-calls.ts` (pinned): FoundRender needs core io's NamedRenderFound in the planner entry; the still and preview options name the driver types of render/.
  - New test files for `scripts/test-ci.json`: `packages/engine/test/render-use-case.test.ts`, `packages/engine/test/render-versions.test.ts` (remove `packages/editor/test/render-version.test.ts`, deleted). New helper (no tests): `packages/test-support/src/render-use-case.ts`.

## State (after L7.50)
- **L7.50 done (2026-11-14; branch `claude/arch-l7`)** — `retake doctor`'s checks live in the engine behind the ports, the CLI's doctor only prints and exits (1,335 → 49 lines); `auth status --check`, `validate`, `init` and the workspace lookup of `mcp` / `ui` / `worker` are engine work; the ratchet's workspace-read check reads the CLI's sources. Every output byte for byte the same (pinned by the code before the move). Closes A-S3 in part (below).
  - Code: engine `src/doctor/` (types, machine-probes `machineProbes(ports)`, machine-, app-, workspace-, project-checks, `doctorChecks` / `doctorSummary`) behind a new entry `@retake/engine/doctor` (package.json export, aliases in vitest.config.ts and tsconfig.test.json). Port members: `CaptureRunner.probe` (the capture browser), `Renderer.machine` (`path`: the render path, `browser`: the render browser; types `RenderMachine`, `RenderPathProbe`, `RenderBrowserProbe` in renderer.ts), `Sandboxes.dockerPlaces`, `CaptureSessions.save` (a check's status written) — each in its package adapter and its memory adapter. Core `resolveAuth` (moved from runner-web, which re-exports it). Engine `recheckSessions`, `ago`, `checkedText`, `loginCommandAt` (auth.ts), `validateProjectFiles` / `projectLoadReport` (validate-files.ts), `initWorkspace` / `INIT_WORKSPACE_YAML` (init-workspace.ts), `servedWorkspaceRoot` / `workspaceRootOf` (workspace.ts). CLI doctor.ts, auth.ts, validate.ts, init.ts, mcp.ts, worker.ts, project.ts thin (project/auth read through `ws.reads`). Rule: `WORKSPACE_READ_SHELLS` (`packages/cli/src/`) in scripts/audit/lib.mjs.
  - Tests: new `packages/cli/test/doctor-characterization.test.ts` (fixtures `packages/cli/test/fixtures/doctor/{text,json}.txt`), `packages/cli/test/shell-characterization.test.ts` (fixture `packages/cli/test/fixtures/shell-characterization.json`: validate, list, auth status, new, init — text, exit code, `--json`), `packages/engine/test/recheck-sessions.test.ts`; a contract case for `sessions.save` (capture-sessions-contract.ts) and a workspace-read case for the CLI (import-rules.test.ts). The pins were generated with the files of HEAD and pass after the move. Run alone, green: the 3 new files, doctor, doctor-app, doctor-captures, doctor-renders, lock-text, cli, auth (real browser), operations-cli, import-rules, capture-sessions, ports, sandbox-work, runner-web unit.
  - Mutations (each red, restored): a template report added (shell pin), a doctor detail word and `ok: true` in doctorSummary (doctor pin), the PreflightError name, the `run` field kept, an interrupt that goes on (recheck tests), the workspace-read scope back to the engine (rule test), a loader imported in a CLI command (`rules.mjs --check`). One equivalent mutant seen (dropping an OK line from the summary's count).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check` (baseline 121 → 110: the CLI's R4 group — auth, doctor ×3 —, R6 doctor ×2, init ×2, mcp, validate, the media-call group), lint baseline −4 (doctor.ts's 4, fixed in the moved code), `--check-cites` on a scratch copy with the edits: all 0. `test-guard`: 1 title renamed (below), no decrease.
  - Not done: the catalogue-served commands are not routed through `invoke` (caller `cli`, presentation from `data`) — the larger half of A-S3; the Studio server (`packages/ui/src/server`: launch.ts, studio.ts `loadWorkspaceConfig`) is not under workspace-read (2 hits: it would add baseline entries); `render.ts`'s music check (node:fs) and the render / review / export commands left to L7.47; `ui.ts` (R6, legit). Doctor's MCP line still looks ffmpeg up on the registration's PATH with the real file system (`whichOnPath`, as before; not a probe).
  - Renamed test title (test-guard): import-rules.test.ts > media-call "holds today: one exception, the doctor's exec probe; the wrapper starts them" → "holds today: no exception (the doctor's checks run programs through the exec probe they are handed); the wrapper starts them" — it pinned the one baseline entry, which is gone (Q1); the same check now pins an empty list, and the wrapper's exports as before. Also in that file (count kept): the workspace-read case's "free" example moved from a CLI file to a Studio server file, the CLI being read now (its case is the new test).
  - Requirements: `.private/l7/L7.50-requirements-edits.json` — R-ARCH-44's evidence (that title; the media-call group empty) and a new R-ARCH-53 after R-ARCH-52, `partial`, its gap the `invoke` routing and the Studio server's reads.
  - Notes: the moved doctor code keeps its words; its comments lost their lot and review ids; 4 lint findings of the old file fixed in the move, each equivalent (`b?.sealed…`, `info?.code !== 0`, `res?.code !== 0`, a typed `let`). `init`'s refusals are an EngineError `invalid` now (was a CliError): same line, exit 1 (pinned). `retake new`'s interactive pre-check is `ws.reads.planNewProject` (core's `checkNewProject` is that plan, unwritten). L7.47 overlap: renderer.ts, editor-renderer.ts, memory-renderer.ts gained `machine` (additive); the render / review / export commands untouched. A stray copy `/tmp/x/worker.ts` (a mistyped `cp` into an existing `/tmp` folder) is left there, outside my scratch folder: a copy of the CLI's worker.ts, safe to remove.

## State (after L7.47)
- **L7.47 done, partly (2026-11-14; branch `claude/arch-l7`)** — a run's status no longer follows a link out of its run folder, nor reads a run folder that is a link out of runs/; the Outputs port has members for renders, reviews, exports and inspections beside `runs`, held by one contract on disk and in memory; the engine's views, comments, jobs and index read renders/ through it (a few reads beside it go with L7.47b), and prune, the in-memory raw export, the listed reservation and the inspections' prune and read are on it; `output-read` has no baseline entry.
  - Security (the user's decision): `runs.describe` (MCP `run_status`, the Studio) follows a link only to a real path inside the run folder's real path; any other link (out of the folder, to the folder above, dangling) is `{ link: 'refused' }`: no size, no sha256. The disk's hash opens the file with O_NOFOLLOW. `StoredRef.link?: 'refused'`; the compact `run_status` does not offer a refused link's path; its text line says "a link out of the run folder, not read". CHANGELOG (Changed) and docs/guide/mcp.md state the rule.
  - Code: `outputs/outputs.ts` — `OutputFolder` (dirOf, names, kind, readText, readCapped, size, remove, write, writeJson, signature), `RenderOutputs` (+ entries, listed, byId: core's readers of renders/ on the port's file layer), `Outputs` = runs, renders, reviews, exports, inspections; `OUTPUT_DIRS`; `RunOutputs` gains names, readCapped, size, remove, unreserve. `output-files.ts` `outputsOn(fs)` (one implementation; the file layer now also answers core's RecordFs: names, text, identity; plus remove, rmdir). Disk and memory adapters build every member from it.
  - On the port: prune.ts (every read, size and removal of runs/, renders/, review/; its lenient reads through `readCapped` with follow, same caps); render-records.ts (renderEntries, readById, previousOfRender take a `RenderOutputs`), renders.ts (renderForWork, latestRenderId, readListedRecord, scenarioRenders), comments (views, threads, proposals: `renders` in their options beside `scope`; addComment takes it after the scope), index-db's readRenders, timeline-view's versionMatches, render-frames (`RenderFramesOptions.renders`), review-job, export-job, comment-screen, project-board; the capture port's raw member takes the outputs (`timeline(runDir, outputs)`, `export(o, outputs)`: the in-memory export reads its take and writes its package there; the runner-web adapter ignores them, as it does `runs`); `rawExportWork`'s ws carries `outputs`; `reserveListedRun(runs, clock, project, scenario)` reserves on the Clock port and releases with `runs.unreserve` (CLI run.ts hands both); `pruneInspections(inspections, …)` and `readInspection` on `outputs.inspections` (`inspectInProcess`'s `pruneUnlessOpenIn` is `{ queue, inspections }`); `workerPorts` refuses a worker handed its own outputs without its own capture runner.
  - Ratchet: `output-read` also holds core io's readers of renders/ (`RENDER_FOLDER_READERS`: readRendersFolder, readListedRender, readRenderById); the `output-read` group removed — 108 → 105 entries.
  - Tests: outputs-contract.ts +4 cases (runs: names / readCapped / size / remove / unreserve; generated folders: where each kind lies, the file operations of each member, renders/ through the one reader — each on disk and memory); outputs.test.ts +2 disk cases (describe of links: out, dangling, `..`, inside; `run_status` showing a refused link); worker-ports.test.ts: the outputs-without-capture refusal; import-rules: the render readers flagged, `output-read` holds no entry, the L7.6c source pins follow the new spellings. ~15 test files take the new first argument / option (`diskOutputs` or `diskOutputs.renders`). Run alone, green (21 files): outputs, import-rules, prune, prune-keeps, prune-only-keeps-more, comments, comments-studio, raw-export, inspect-jobs, job-queue, index-db, records-characterization, ids-characterization, render-frame, ports, worker-ports, reviewer, client-mistake-kinds, cli run-agent-hooks.
  - Mutations (each red, restored): describe following every link (2 red); unreserve removing a full folder (2 red); size of a file 0 (4 red); the memory text with no cap (2 red); the worker refusal off (1 red); `readRenderById` imported in renders.ts (rules --check: new violation).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (463, none new), `pnpm format:check`, `node scripts/audit/rules.mjs --check` (105), `node scripts/requirements.mjs --check-cites` (no requirement edits): exit 0. `node scripts/test-guard.mjs`: one renamed title (below), no test or expect lost (worker-ports 33 → 35 expects).
  - Not done (next lot):
    - A-S1 render use case: `renderVideo`'s version reservation, record writing and file placement still in the editor; the `editor-calls.ts` helpers that touch renders/ (versions, renderPathProblem, findRenderOf), its 12 re-exported editor-root types, recordPathProblem / theme hashes to the planner entry; the 7 editor test files that call `renderVideo` / `exportRender`.
    - A-S1 review and capture parts (`review/src/load.ts` workspace lookup, runner-web `capture/lifecycle.ts`).
    - Writes the engine still makes beside the port: the review job's and reviews.ts's own reads of review/ (review.json, sheets), the export job's exports/ placement, the inspection folder's mkdir in submitInspectJob, `readInspectReport(file)` (kept for its stored-format test), render-job's timeline hash, index-db's realpath check of renders/, the memo signatures (project-board `lsig` of renders/).
    - From L7.46: a run's pictures / frames / videos / scenario snapshot (run-files.ts, run-data.ts, run-thumbs.ts) and their memo signatures, the threads' and proposals' scenario.yaml reads, the hook journal under runs/, the editor's and review's take reads, scenario-view's failedAt read through the port's folder, `MemoryWorkspace.ports()` handing outputs.
  - New test files for `scripts/test-ci.json`: none.

## State (after L7.48)
- **L7.48 done (2026-11-14; branch `claude/arch-l7`)** — adapter→adapter imports have a rule (R14), the sandbox runs no hook itself, R6 reads every shell source, the Studio's reads share their request and are aborted, the app's id mirrors are one file, the probe cache is bounded. Closes A-S2 (+ R14), A-N2, A-N5, A-N6, A-N8; **A-S10 not done** (below).
  - Code: core `hook-run.ts` gains `HookPlace` (moved from the engine's runner.ts, re-exported there) and `SandboxHookRunner` (a capture's runner + `approval.fingerprint` + `journals.supersede`); the engine's `HookRunner` extends it, both adapters implement `journals.supersede` (package: `supersedePendingJournals`; memory: marks its pending entries). The sandbox is handed it: `openSandbox(project, env, policy, resolveSecret, hooks)`, `ProviderContext.hookRunner`; `seed.ts` runs batches, opens the journal, fingerprints approvals and supersedes through it (no `runHooks` / `Journal` / `hookFingerprint` / `supersedePendingJournals` import left). `packageSandboxes(secrets, hooks)`; `enginePorts` hands the bag's hook runner. pg's connection-string reading is the new hooks entry `@retake/hooks/db-url` (package.json export + vitest alias), used by the sandbox's seed and snapshots. `doctor.ts`'s sandbox probe opens through `cliPorts.sandboxes` (one `@retake/sandbox` import left there: `dockerPlaces`). Type-only `ComponentRegistry` / `TextFont` imports of the editor and review moved to `@retake/components/geometry` (review `fonts.ts` takes `estimateTextWidth` from there too). `scripts/audit/lib.mjs`: R14 (an adapter imports another adapter's domain entries only, types included), R6 widened to `packages/{cli,mcp,ui}/src/**`. Studio `api.ts`: `sharedRead` (identical reads in flight share one request, a caller that leaves gets `cancelled`, the request is aborted once every caller has left) behind `useCall`, which now aborts its read on reload, key change and unmount. `app/id-words.ts` gains `SCENARIO_NAME` (core SLUG_RE); `review-words.ts`, `unsaved-report.ts`, `record-words.ts` use the mirror (caps kept at the callers). core io `media.ts`: probe cache LRU, `PROBE_CACHE_MAX` = 256. `docs/audit/target-architecture.md`: R14 and the wider R6.
  - Baseline: 106 → 121 entries. +14 R14 (editor → components root/kit 11, review → components 1 (`loadComponentRegistry`), sandbox → `@retake/hooks/db-url` 2), +4 R6 (mcp `port-holder.ts` ×2, ui `bundle.ts`, ui `player/bundle-player.ts`) — new rules made visible, each group with a reason; −3 id-grammar (the Studio mirrors group gone). Lint baseline unchanged (463).
  - Tests: new `packages/ui/test/shared-read.test.ts` (3; add to `scripts/test-ci.json`), new helper `packages/sandbox/test/hook-runner.ts` (no tests). New cases: media bounded cache; hook-runner contract "supersede …" (both adapters); import-rules R6 whole-shell and R14 cases; id-words `SCENARIO_NAME` pinned to core SLUG_RE. Run alone, green: core media, import-rules; ui id-words, unsaved-report-app, ids-characterization, shared-read, feature-boundaries; engine hook-runner, ports, sandboxes, reset-hook-approvals, sign-in-sandbox-jobs; sandbox compose-units, process, reset-extras; cli operations-cli. Not run: sandbox compose / compose-env / compose-folder / provider-capabilities (only a `hookRunner` member added to their contexts, type-checked), cli sandbox / sandbox-docker (Docker), ui app-source.
  - Mutations (each red, restored): probe cache without the LRU touch / without eviction; `SCENARIO_NAME` source changed; memory and package `supersede` broken; R14 limited to roots; R6 back to the three folders; a `runHooks` import put back in `seed.ts` (`rules.mjs --check` red); `sharedRead` aborting on any caller leaving / not sharing.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check` (121), `test-guard` (no decrease, no renamed title), `requirements.mjs --check-cites` — all exit 0.
  - Not done: **A-S10** (the Studio server and player as a second render seam: the 4 R4 entries `ui/src/player/bundle-player.ts → components, editor`, `ui/src/server/ops.ts → editor`, `ui/src/server/player.ts → editor`). It needs `engine.timeline.view` to answer the held components and the preview plan, the range helpers and content types in the engine's http module, and a `Renderer.previews.bundle` (or an engine player-bundle use case): an M change in the capability-serving player (security-sensitive) that overlaps L7.47's render use case move and L7.51's narrowing of the engine "."; left for one of them. A-N5's stale-while-revalidate cache (an answer shown on a remount before it is read again) not done either: it changes what screens show at first paint, see Questions.

## State (after L7.46)
- **L7.46 done (2026-11-14; branch `claude/arch-l7`)** — the run folders are behind an `Outputs` port (`EnginePorts.outputs`, member `runs`; renders / reviews / exports / inspections join it as members in L7.47), with a disk and a memory adapter that share one implementation over a file layer (core's run-folder reader and reserveRunId on either), and one contract suite.
  - Code: `packages/engine/src/outputs/` — `outputs.ts` (port: `Outputs`, `RunOutputs` — ids, folder, named, record, readText, describe, signature, inside, reserve, write, writeJson — and `runsDirOf`), `output-files.ts` (`runOutputsOn(fs)`), `disk-outputs.ts` (`diskOutputs`), `memory-outputs.ts` (`MemoryOutputs`). It reaches the work through `OpenedWorkspace.outputs` (`WorkspaceOptions.outputs` required, as `reads`) and, for a run, `CaptureRequest.runs` (the in-memory runner writes there; the runner-web adapter strips it and writes the disk itself). On the port: runs.ts (listRuns, runStatus, takeVerdict, latestCapture, readRecord, runFolderIds — each takes the `RunOutputs`; runStatus no longer builds a LocalStorage), the façade's runs, scenario-view (run list signature, facts, failed-at read, takes), project-board (records, takes, ids), timeline-view, index-db, the Studio's live scan, run-job (reserve, queued record, lenient read, `finaliseReservedRun(runs, …)`), run-job-record, memory-run (every write), inspection and record-check replays (their runner writes through `runs`). Core: `reserveRunId(…, fs?)` (a `RunFolderMaker` seam). `HEAVY_JOB_PORTS.outputs: true`.
  - Ratchet: new check `output-read` (core io's run-folder readers and reserveRunId only in `outputs/`; `diskOutputs` at the roots, `MemoryOutputs` in its file); `outputs.ts` in PORT_FILES; baseline: `store-new runs.ts → new LocalStorage` removed, a new `output-read` group of 3 (prune, memory-raw, agent-written reserveListedRun) — 110 entries.
  - Boy scout: a job's run id was reserved on the wall clock (`reserveRunId` default `new Date()`) while its record was stamped by the Clock port: now `dateOf(ctx.clock)`, as the in-memory runner already did.
  - Tests: new `packages/engine/test/outputs-contract.ts` (7 cases) and `packages/engine/test/outputs.test.ts` (contract on disk and memory, a disk-only link case, the engine on MemoryOutputs: a run job submitted, filmed by the memory runner, listed and its status read from memory, nothing written on the disk); import-rules gains 3 `output-read` cases; ports.test.ts pins `outputs` in the bag; ~25 test files pass `outputs: diskOutputs` to `openWorkspace` / their OpenedWorkspace literals; two call sites take the new first argument (ids-characterization listRuns, records-characterization finaliseReservedRun). Run alone, green: outputs, import-rules, ports, worker-ports, capture-runner, records-characterization, ids-characterization, scenario-view, index-db, jobs, inspect-jobs, record, board-ops.
  - Mutations (each red, restored): ids without the folder filter (3 red), `inside` always true (disk link case red), the engine context on the disk's outputs instead of its port (engine-on-memory red), the memory run never finishing its record (red); the rule's home widened to prune.ts (import-rules 4 red, baseline stale), a reader imported in runs.ts (rules --check: new violation).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (463, none new), `pnpm format:check`, `node scripts/audit/rules.mjs --check` (110), `node scripts/test-guard.mjs` (no decrease, no renamed title), `node scripts/requirements.mjs --check-cites` (no requirement edits) — all exit 0.
  - Not done (L7.47 or later): prune's run reads, sizes and deletes (with renders and reviews: no delete on the port yet); the in-memory raw export's read of its take (`memory-raw.ts readNamedRun`) and the terminal run's listed reservation (`reserveListedRun`, released by rmdir); a run's pictures, frames, videos and scenario snapshot (run-files.ts RunFolder, run-data.ts, run-thumbs.ts: ffmpeg is handed descriptors, a disk thing) and the memo signatures built on them (project-board poster/pictures/current, timeline-view statKey); render-job's timeline sha, comment threads' and proposals' scenario.yaml reads, the hook journal under runs/; the editor's and the review's own reads of a take (editor/render/runs.ts, plan-run.ts, review load.ts); `MemoryWorkspace.ports()` still hands no outputs (a test composes `{ ...mw.ports(), outputs: new MemoryOutputs() }`); the real runner with MemoryOutputs is not refused (it would write the disk).
  - New test files for `scripts/test-ci.json`: `packages/engine/test/outputs.test.ts` (`outputs-contract.ts` is its helper, not a test file).

## State (after L7.45)
- **L7.45 done (2026-11-14; branch `claude/arch-l7`)** — the engine reaches the editor from its render folder only; it
  names an adapter's root (types included) in that adapter's home only; the editor finds no workspace and loads no
  project by itself.
  - Code: `LOADER_HOMES.editor = render/`; new `packages/engine/src/render/editor-calls.ts` holds the editor work the
    engine asks for outside a render (planWork, findRunOf, findRenderOf, previewThemeOf, next / reserve / release a
    render version, renderPathProblem, exportPlanning, editFilesOf, themeHashes, probeMediaFile, previewMaking,
    planTrustProblems, editorErrorOf) and re-exports the editor's option types; the 11 files outside render/
    (library-watch, components, renders, pipeline, raw-export, theme-preview, library, timeline-view, export-job,
    render-job, review-job) call it, or the planner entry for the pure values (summarizePlan, withPlan, timelineOf,
    placePins). New `packages/editor/src/work-types.ts` (types only, renderer-free: render progress, the browser
    process, PlanTrust, ExportFormat / ExportProgress, BundleComponent, the preview samples and targets, loop items),
    exported by `@retake/editor/plan`, with `ComponentPreviewSpec` and its pieces (preview-types.ts now on the
    components' geometry entry); the geometry entry exports the contract's types the engine names (ComponentInfo,
    ComponentSource, ComponentUse, ComponentFit, JsonSchemaNode, Palette, PaletteCheck). Every engine file outside
    the homes imports types from the domain entries (20 files); the renderer port file too. The editor's
    `renderPlan` / `renderStill(s)` and the driver / port requests take a required `root` (no `findWorkspaceRoot()`
    from the cwd), `renderVideo` / `exportRender` a required `LoadedProject` (no `loadProject` by slug); an untyped
    caller that hands neither is refused (`handedRoot`, `handedProject`).
  - Rules: R9 frees the planner entry's values; R11 now holds types too outside `ADAPTER_HOMES` (the folders of
    LOADER_HOMES: render/, hook-run/, review/, capture/, sandboxes/), the editor's root included, and values inside
    them; loader-use holds the editor's loader to render/. Baseline 108 → 106 (the `port-types` group: 2 entries).
    docs/audit/target-architecture.md says the rule that holds.
  - Tests: import-rules (R9, R11, loader-use and the namespace re-export cases updated; ADAPTER_HOMES pinned);
    render-driver.test.ts +2 (a slug / folder project refused by renderVideo and exportRender before any driver call;
    a still and a video with no root refused although the cwd is a workspace); renderer.test.ts hands `root`.
  - Mutations (all red, restored): homes treated as everywhere (2 tests), the editor's loader home removed (6 tests),
    the planner entry no longer free for R9 (5 tests + 3 new ratchet violations), a type import of the editor root in
    caller.ts (a new R11 violation), handedRoot / handedProject disabled (the 2 new tests).
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (463, none new), `pnpm format:check`, `rules.mjs --check`
    (106), `requirements.mjs --check-cites` on a scratch copy with the edits applied: exit 0. `test-guard`: 3 renamed
    titles (below), no expect or test lost. 14 targeted files green, each alone: core import-rules; editor
    render-driver, plan-entry; components geometry-entry; engine renderer, pipeline, timeline-view, library-cache,
    raw-export, render-jobs, review-export-jobs, render-on-renderer, editor-renderer, preview-library-job.
  - Not done: the render use case still lives in the editor (`renderVideo` reserves the version, writes the record,
    places the file; `exportRender` likewise). Moving it into `engine/render/work.ts` means moving ~200 lines plus
    `planRun`'s callers and rewriting the 7 editor test files that call `renderVideo` / `exportRender` directly
    (render-driver, render-version, render-real, render-gpu, render-media, render-own-ffmpeg, export-real) — the L part
    of A-S1, better done with the Outputs port of L7.47 (renders slice), where the record write lands. The helpers of
    `editor-calls.ts` that touch renders/ (versions, renderPathProblem, findRenderOf) are the ones that move onto that
    port then. The review's workspace lookup (`review/src/load.ts`) and runner-web's lifecycle stay L7.47's.

## State (after L7.44)
- **L7.44 done (2026-11-13; branch `claude/arch-l7`)** — CC-S1, CC-S2, CC-S3, A-S7, A-S8, A-N12 closed: a job's words,
  the small helpers, "hidden character", the stored formats' reads, "a run is finished" and the caption max-width rule
  each written once.
  - Code: engine `operations/job-words.ts` (jobWhat / jobProgress / jobOutcome brief|full, switches with an exhaustive
    `never`; jobLine and `retake jobs` compose them, the 13-deep ternary gone). Core `hidden-chars.ts` (base:
    HIDDEN_CHARS, SPACE_LOOKALIKES, BIDI_CONTROL_CHARS, INVISIBLE_FORMAT_CHARS, PICTOGRAPH_CHARS, EMOJI_CHARS) used by
    printable.ts, scenario-edit.ts, comments.ts; the Studio's mirror `ui/src/app/words/hidden-chars.ts` (R5: types only)
    used by comment-words, library-words, YamlTab. Core run-record.ts `RunViewStatus`, `RUN_VIEW_STATUSES`,
    `isRunViewStatus`, `isFinishedRunStatus` used by runs.ts, index-db/sources.ts, scenario-view.ts, prune.ts,
    project-board.ts, facade/types.ts; the Studio's `app/run-ended.ts` (TakeStrip, StatusActions). Components geometry
    `captionOverBand` + `CAPTION_BAND_MAX_WIDTH` (planner frames.ts and review checks.ts). Engine `stored-json.ts`
    (`storedJson(schema, text)`) and one zod-schema reader per format in its home: history lines (readHistoryLine,
    also index-db), journal lines (readJournalLine, also memory-store), job.json / claim / markers / events
    (queue-core.ts), worker lock, filming marker, browser.json, inspect.json, live file + frame header, Studio token,
    theme provenance. `record-read` check extended: `FORMAT_READ_HOMES` (kind 11: a parse typed as one of those formats
    outside its home, kinds 1-4). Helpers: core base `errorMessage`, `decodeOrKeep`, `sleep`; core io `realpathOr`,
    `realTarget`, `processTree` (groupTree and engine treeOf on it), `pidExists`, `lstatOrNull`, `realFolderState`;
    engine `VersionLedger` (scenarios + theme-edit); cli `interrupt.ts` `stopSignal` (mcp + ui); Studio `app/throttle.ts`
    (`throttle` + `useThrottled`: Renders, CommentsScreen). 112 `(e as Error).message` casts and 27 inline ternaries in
    89 files -> `errorMessage`; the 4 package `errorMessage`s re-export core's, execute-run's copy gone.
  - Tests: new engine job-words (53), stored-formats (13), version-ledger (2); core helpers (8), run-record +2,
    import-rules +2 (kind 11, format homes) and the index-db parse expectation updated; ui hidden-chars (199: mirror =
    core, one code-point table x five surfaces, emoji sequences), run-ended (7), throttle (2); components geometry-entry
    +1. Nearby files run alone, all green (about 60 files: jobs, queue, live-channel, discovery, captures, index-db,
    inspect-jobs, theme-create/-edit, prune, scenario-view, record-studio, comments, agent-written, run-agent-hooks,
    planner, review checks, player, run-live, compose, record-session, shell-hosts, app-source...).
  - Mutations (each caught, restored with cmp + touch, `tsc -b --force`): job words env_reset; finished set without
    interrupted (core + Studio tests); caption default 1300; Studio mirror without U+2800; showHiddenChars without
    SPACE_LOOKALIKES; scenario-edit PICTO; job.json state any text; claim fallback removed; live token regex removed;
    record-read format check off; errorMessage as a cast; processTree without descendants; VersionLedger without LRU;
    throttle without trailing run; realTarget without parent walk.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (baseline 541 -> 538: the three `noMisleadingCharacterClass`
    gone), `pnpm format:check`, `rules.mjs --check` (115 entries, none added; `hidden-chars` in CORE_CONTEXTS base),
    `test-guard` (no decrease), `requirements --check-cites`: all 0.
  - Published output: CHANGELOG [Unreleased] Changed, three bullets (job words; hidden characters written out; stored
    files read through a schema).
  - Not done (on purpose, see Questions): printableText / commentText keep their narrower strip set; the other ad-hoc
    field classes; browser-side error idioms (Studio app, runner-web kit, Remotion code: core values cannot load
    there); abortable sleeps (runner-web, memory-run, worker-loop, Studio run-live: each its own abort contract);
    project-data's store-level throttle; async `realpath().catch()` one-liners, encode-tools, config-snippet; the S2
    rows the brief did not name (fitRect, subdirs, sig/lsig, frame cache, keyTarget, inspector header); four
    `JSON.parse ... as Record<string, unknown>` that check every member by hand (record meta.json, record.json, review
    report.json, update checks).

## State (after L7.42)
- **L7.42 done (2026-11-13; branch `claude/arch-l7`)** — hygiene: dead code out and `noUnusedLocals` /
  `noUnusedParameters` on, lot ids out of runtime strings, the four non-hook `use*` renamed, client mistakes as
  refusals of their kind, swallowed rejections named (`bestEffort`) or surfaced, `ui → mcp` / `runner-web → hooks`
  as dev dependencies, the Studio's library-watch shim gone.
  - Code: `tsconfig.base.json` turns on `noUnusedLocals` / `noUnusedParameters` (the test tsconfig extends it): 38 src
    + 25 test findings fixed (underscore for an intended unused parameter; the two compile-time checks exported:
    `HookRunnerShared`, `SandboxHandleChecks`); the written-never-read `once` flag (runner-web auth.ts) gone. Dead
    exports removed (re-verified by `git grep -w` over packages, apps, scripts, skills, templates, projects, fixtures,
    docs): `loadSandboxes`, `accountsComposeEnv`, `scenarioEnvOf`, `readLottieFile`, `SHELL_ALWAYS_WRITES`,
    `RECORD_STEP_INSERTS`, `THEME_EDIT_KINDS`, `EnvironmentSpec`, `listCachedBundles`, `previewCommandLine`,
    `recordLive` (+ its `LIVE_STATES`), `APPROVAL_KEY_FILE`, `openLoginBrowser` (+ runner-web's `LoginOptions`),
    `NUDGE_HOVER_MS`, `colourDistance`, `ANCHOR_BUILTINS`, `chosenLocation`, `MARK_MAX`, and the 9 types
    (`BrandColors`, `CommentRender`, `CommentEntryKind`, `RecordInsertValues`, `RecordedEventKind`, `ScenarioEditKind`,
    `StandInKind`, `ClipTutorialFeature`, `RunLiveRequest`): 30 names; DESIGN.md's four mentions follow
    (`loadSandboxesOn`, `scenarioSourceEnv`, `shellAlwaysWrites`). `mcp/src/compact.ts` deleted (its test reads
    `@retake/engine/contract`). The inert `eslint-disable` comments deleted (12 in src, 8 in tests); `fonts.ts` /
    `modules.ts` carry a `biome-ignore` with the reason. Five runtime strings say "an older run/capture format"
    instead of L2.13 / L2.1 / L1.2. Renames: `useDuration` → `segmentSeconds`, `useScreen` → `overlayScreen`,
    `useInScenarioPlan` → `planUseInScenario`, `useRealTime` → `keepRealTime` (it keeps a page on the real time; the
    audit's `restoreRealTime` would misname it). Six plain `Error`s → `EngineError` (`invalid`: a job of another kind
    shown as a recording / inspection / site extraction, `keep_renders` < 1, a live channel for a non-run id;
    `unavailable`: `--headed` without a display). `bestEffort(p, why, fallback?)` in core base (and a copy in the
    Studio front end, which imports types only: R5) — 90 sites; the swallows that hid a failure are surfaced instead:
    doctor's project / theme listing (FAIL) and worker probe (WARN, "worker state unknown"), the heavy job's yield
    (`recordYield`, logged; worker-signals uses it), `held.json`, a job's progress write, the render browser record, the
    approvals given back at unclaim, the recovery prunes (worker log), a refused render's lock release (job event),
    the index's and the Studio's in-memory runs scan (a runs/ folder that cannot be read keeps its rows and old
    signature instead of "every run deleted"), the Postgres snapshot's `ALLOW_CONNECTIONS true` (the take fails after
    a copy that worked). `@retake/ui → @retake/mcp` and `@retake/runner-web → @retake/hooks` are devDependencies
    (lockfile updated; runner-web's tsconfig reference to hooks gone). `ui/src/server/library-watch.ts` and its
    re-export block in `ui/src/index.ts` gone (live.ts and theme-ops.test read the engine).
  - Tests: new `engine/test/client-mistake-kinds.test.ts` (4), `engine/test/worker-yield-failure.test.ts` (2),
    `sandbox/test/snapshot-take-connections.test.ts` (3); new cases in `cli/test/doctor.test.ts` (listing failures; the
    unread worker), `engine/test/render-snapshot.test.ts` (lock not removable), `engine/test/index-db.test.ts`
    (unreadable runs/), `ui/test/scenario-ops.test.ts` (same without node:sqlite); `ids-characterization` pins
    `invalid:` for the live channel; `planner-rules` the new token wording; `ui/test/feature-boundaries` lists `best-effort` among the app's foundations. 152
    touched / nearby test files run one at a time (fresh RETAKE_HOME, RETAKE_DISK_WARN=off): 1,948 passed, 54 skipped,
    one red that is not this lot's (Questions).
  - Mutations: 14, all red — each of the six `EngineError`s back to `Error`; doctor projects / themes / worker swallow
    back; `recordYield` silent; the snapshot's throw off; the render lock event off; index-db `runs = []` on failure;
    live.ts `read = []` on failure.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (baseline 541 → 466: 75 entries gone, none added),
    `pnpm format:check`, `node scripts/audit/rules.mjs --check` (115 entries, unchanged), `node scripts/test-guard.mjs`
    (no decrease), `node scripts/requirements.mjs --check-cites` — all 0.
  - Not done: the remaining uncommented `.catch(() => …)` are kit probes, CDP acks, body / client / screencast
    cleanup, stat / readdir / realpath probes (`engine/prune.ts`, `project-board.ts`, `comments/store.ts`,
    `library.ts`, `record.ts` fileSha256, `cli/commands/validate.ts`) and two in-page functions (no import there). CC-N4's three "variables" are not environment variables (`RETAKE_MCP_HTTP` a regex, `RETAKE_REPOSITORY` the
    repository URL constant, `RETAKE_VALUE` the hooks' inert placeholder): nothing to document. No dedicated tests
    for the progress-write / browser-record / recovery-prune / unclaim log lines (they only add a log line).

## State (after L7.41)
- **L7.41 done (2026-11-13; branch `claude/arch-l7`)** — the ports bag holds the job queue, the renderer, the
  environment and a Secrets port; the worker's in-process heavy mode is explicit; the Clock port has a monotonic side;
  the scenario-writes record goes through the stores port. Closes A-M2, A-M3, A-S12, A-N9, A-N10 and the lead's
  `/retake-memory` mkdir bug.
  - Code: `EnginePorts` + `queues` (JobQueues: root, cli, clock, env → `{ queue, files }`; `memoryJobQueues()` shares
    one map per root), `renderer`, `env` (env.ts `EngineEnv`, `noDisplay`), `secrets` (secrets/: port, `systemSecrets`,
    `MemorySecrets`); `portsOf`; `JobBase extends EnginePorts`; engine/worker/job process/CLI call the factory;
    `cliPorts.renderer` in the 5 CLI sites. Worker: `WorkerOptions.heavyInProcess`; `HEAVY_JOB_PORTS` is
    `Record<keyof WorkerPorts, boolean>` (reads, queues, env, secrets added); a heavy port handed without the option is
    refused before anything is opened. `Clock.monotonic()` (system: performance.now; ManualClock: moves with advance
    only); worker loop/heavy/slots/record/recovery, jobs.wait, in-process and record `ms` on it; project-lock,
    render-frames, memory-renderer, yield on `performance.now()` (append-log kept on Date.now: its test moves it). ~22 engine files read `env` from the bag
    (signing, captures, approvals used, display checks, time limits, token files, config snippet, author name, worker
    env); `Engine.envVars`. Core: no secret is filled in without a resolver (`defaultSecrets` gone), `prefetchSecrets`
    knows its refs only, runner-web `RunSecrets` and hooks `secretResolver` have no environment fallback;
    `HookContext.resolveSecret`, `CaptureRequest.resolveSecret` and `CaptureSessions.signIn` take the port's resolver.
    `ProjectStores.appendRecord` (disk: owner-only, O_NOFOLLOW, torn line closed, fsync; memory: the Map).
    Ratchet: `PORT_ROOTS` editorRenderer / FileJobQueue / systemSecrets (QUEUE_ROOTS = ports.ts + queue.ts), new rule
    `env-read` (ENV_HOMES ports.ts, worker-main.ts), `PORT_FILES` + secrets.ts, reads.ts. Baseline 115 → 108 (−12
    clock-read, +5 env-read with two reasons). Docs: DESIGN §1 (core's env defaults: two), DESIGN worker ports,
    target-architecture ports list (Secrets, WorkspaceReads; ProgressSink struck).
  - Tests: new secrets.test.ts + secrets-contract.ts (both adapters), worker-ports (typed list, refusal, runWorker
    refused with memory reads, nothing on disk), clock (monotonic; a worker's idle exit on a ManualClock), engine.test
    (createEngine entirely on the memory queue), workspace-reads (memory scenario record in the Map, no stderr, no
    `/retake-memory`), project-store-contract appendRecord, import-rules (env-read, editorRenderer roots, new queue
    roots), hooks secrets (context resolver, dry run), capture-runner (run handed the port's resolver). Migrated: 17
    files to `heavyInProcess: true` (those handing heavy ports), env/signing args in ~15 test files, 3 tests that pinned
    the old env fallback (core templating, scenario-template, runner-web secrets) now hand a resolver (titles kept).
  - Mutations: 14, all red (list below); each restored (`cmp`, `touch`), then `tsc -b --force`.
  - Gates: `tsc -b`, `pnpm typecheck`, `pnpm lint` (541, none new), `pnpm format:check`, `rules.mjs --check` (108),
    `requirements.mjs --check-cites` on a scratch copy with the edits applied: exit 0. `test-guard.mjs`: exit 1 on two
    **renamed** titles whose old wording became false (explained below); no expect count went down.
  - Goldens: `fixtures/operations-cli.json` and `fixtures/pipeline-cli.json` unchanged. Their harnesses follow the
    seams: operations-cli mocks the engine's `editor-renderer.ts` (what `cliPorts.renderer` is made of; a delegating
    renderer, since cliPorts is built at load) instead of the `@retake/engine` export; pipeline-cli takes the run's
    `resolveSecret` out of the recorded runScenario options as it already took `hookRunner` (and asserts each run was
    handed one).
  - Not done: the 47 test files on the file queue (L7.53); the scenario-writes record's reader (`hooksWrittenBy`) still reads the disk (a memory workspace
    reads "missing", as before).

## State (after L7.43)
- **L7.43 done (2026-11-13; branch `claude/arch-l7`)** — the tests run in the CI (a deterministic tier) and the test
  tooling holds without a reader's memory.
  - Code: `scripts/test-ci.json` (`ci`: 358 files; `out`: 187 under 5 reasons — Chromium, ffmpeg, either through a child
    process, the RETAKE_TEST_* gates, codesign/hdiutil) + `scripts/test-ci.mjs` (`pnpm test:ci`: PATH without the
    folders of ffmpeg/ffprobe/docker/Chromium, empty PLAYWRIGHT_BROWSERS_PATH, no RETAKE_TEST_* gate or tool variable,
    RETAKE_TEST_PG=off), run as the last step `The deterministic tests` of ci.yml's `checks` job (timeout 30 → 45 min).
    `packages/test-support/src/postgres.ts`: the SQL tests start a throwaway `retake-pg-test-<hex>` per file by default
    when Docker + `postgres:17-alpine` are here (never pulled; 15-min lifetime cap, removed with its volume), skip saying
    why otherwise; `scripts/test-pg.mjs` now checks Docker/image and runs them with RETAKE_TEST_PG_REQUIRED=1. The macOS
    kernel-sandbox case of launch-options runs by default (out of RETAKE_TEST_SLOW and of `pnpm test:slow`).
    `test-support/golden.ts` `recordGolden`: RETAKE_WRITE_SNAPSHOTS=1 writes then fails ("recorded …: review the diff
    and rerun") in the 12 golden files. `scripts/test-guard.mjs`: counts `expect.soft`, reads `it.each` / `it.for` /
    nested `skipIf(…)` titles, reports a matcher traded for a weaker one. `test-support/http.ts` `freePort()`:
    job-programs, render-isolation, cli-http no longer listen on fixed ports. `scripts/coverage.mjs` +
    `scripts/coverage-setup.mjs` (coverage on demand, no dependency; vitest.config.ts adds the setup file only when
    RETAKE_COVERAGE_RAW is set). docs/RELEASING.md step 2: the gated release tests as a checklist with their commands.
    docs/guide/development.md: test:ci, test:pg, goldens, freePort, coverage, test-guard.
  - Tests: new test-ci-tier (4), postgres-helper (4), record-golden (4), coverage-script (2); test-guard +3, review
    checks +2 (duration-mismatch / size-mismatch, one-frame caption overlap), editor timeline's 4-minute case made
    linear (8-minute model ≈ 2× the 4-minute one) with wide bounds (best of 3 < 250 ms / 500 ms; it was < 50 ms on one
    cold call), ci-workflow (the test step). Run alone with a fresh RETAKE_HOME: every touched file green (list in the
    report), except requirements-cites until the requirement edits are applied.
  - Boy scout: `mcp/test/theme-ops-characterization` failed on any day but the one its fixture was recorded (the theme
    file's header names today's date; fixture said 2026-11-12) — the date is now normalised, fixture updated (4 lines).
  - Mutations (all red, restored byte for byte): review duration tolerance 0.15 → 1.5, clip cue overlap `>` → `> +1`,
    video caption overlap `> allowed` → `> allowed + 1`, size check height dropped; test-guard: soft not counted,
    each/for not read, matcher downgrade not reported; recordGolden not throwing; test-ci.json a file dropped, ciEnv
    keeping RETAKE_TEST_*, ciEnv keeping tool folders on PATH, ci.yml without the test step; postgres helper: image
    check dropped, `off` not honoured, REQUIRED not failing.
  - Measured: `pnpm test:ci` on this Mac (another session loading it, load ≈ 5): 355 files, 4,692 tests, 232 s
    (3 min 52 s); before the last 3 files were added. The stripped run of the whole suite that chose the tier: 8 min.
  - Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `node scripts/audit/rules.mjs --check`
    exit 0; `node scripts/requirements.mjs --check-cites <scratch copy with the edits>` exit 0 (re-run after the fix pass, with the new titles cited in R-ARCH-51); `node
    scripts/test-guard.mjs`: 1 item — `ci-workflow.test.ts` title "… no test suite on the runner (BL-163)" renamed
    "… then the CI tier of the tests only (BL-163)" (the test now asserts the opposite; expects 37 → 41), cites
    updated in R-ARCH-14.
  - Not done: the CI run itself (not pushed); T-5 (order dependence, and its weekly shuffled run); T-10 (slow files onto
    memory ports); app-update-e2e keeps its configurable port 4990 (baked into the two builds it may reuse).
  - Fix pass (review W1–W6, `.private/l7/L7.43-review.md`):
    - W1: `ciEnv` sets RETAKE_FFMPEG / RETAKE_FFPROBE / RETAKE_CHROMIUM / RETAKE_CHROMIUM_HEADLESS_SHELL / RETAKE_DOCKER
      to missing paths under the empty browsers folder (read before PATH, so children that re-add Homebrew via
      clientPath find nothing). Tier rerun: no file failed; one case skipped more (editor render-policy "the work's
      ffmpeg by its path", it skipped on any RETAKE_FFMPEG) — the case now sets the shell's variable aside instead.
    - W2: `--pull never` (`containerRunArgs`), `removeOnExit` (exit, IPC disconnect, SIGINT, SIGTERM → `docker rm -f
      -v`), `stop()` in a `finally` of both SQL files' afterAll. Checked by hand: vitest SIGINT and SIGTERM mid-run →
      no container left 3 s later (before this fix it stayed; the worker only sees its channel close, hence
      `disconnect`).
    - W3: no wall-clock bound of the tier depends on machine speed any more for the cases named: agent-safety (5
      lookups shown in flight together; the timer was 400 ms each), live-channel S1 (fewer idle sockets closed than
      the cap when the first frame came), events (README event within 2 ticks of the server's own poll timer, counted
      by wrapping its setInterval), step-edits / line-diff / agent-shell / timeline (ratio of two sizes, best of 3,
      1 ms floor: < 10, < 10, < 10, < 3), plain-file FIFO (a synchronous open that waited would never return: the
      answer is the proof; asserts the fixture is a FIFO). The lower-risk deadline bounds the review lists stay.
    - W4: test-guard classes exact > partial (bounds, toContain, toMatch, toMatchObject, toHaveProperty, toThrow(x) …)
      > weak (WEAK_MATCHERS + bare toThrow() / toHaveBeenCalledWith()); a test going down a class is reported. Over
      HEAD~8/~20/~40 one new finding vs the old guard: ui/test/app-source "⚑ placeholders take the app's own colour…"
      (L7.34 changed `toBe('var(--ui-text-3)')` into `toContain` + a contrast `≥ 4.5`) — a true positive of the rule,
      deliberate at the time.
    - W5: the tier walker skips node_modules only; the test pins vitest's include text.
    - W6: coverage-script tests on a scratch git repository of their own (summary, report), the merger through a dist
      `.js.map` and an inline map (two passes add up), and a real run (setup file in the worker; `--state` kept; no
      `retake-coverage-*` left). coverage.mjs removes its work folder after the report; `createMerger(state, raw,
      root)`.
    - Mutations (all red): ciEnv tool variables not set; `--pull never` dropped; removeOnExit (each event) pinned;
      protected-host lookups made sequential; live channel room never made; event poll refreshing every 3rd tick;
      line-diff cap applied after an uncapped search (ratio 14.5); a verify that parses n/4000 times (ratio 12.1);
      test-guard BARE_MATTERS emptied, toBeGreaterThan out of PARTIAL; merger counting every range covered; work folder
      kept; vitest include narrowed. Survived (noted): a cheap O(n²) line loop in verifyEditText (ratio 7.4 < 10: the
      parse dominates); the agent-shell ratio was not mutated (its rule is in core/agent-policy.ts, L7.40's file).
    - Found in the full tier run: the coverage-script real run (vitest inside vitest) inherited this run's
      `RETAKE_TEST_*_MADE` names, so its teardown removed the parent run's captures and CFFIXED_USER_HOME folders while
      16 other files used them (ENOENT at collection). The nested run now gets an environment without them
      (`nestedEnv`), and the test asserts the parent's folders survive (mutation: the old env → red).
    - Tier after the fix pass (W1 variables set): 358 files, 4,708 tests, 237 s on the loaded Mac; 1 failure,
      requirements-cites (until the edits are applied); 32 skipped, all gates.
  - Re-review 1 (R1, R2, events caveat):
    - R1: `@retake/test-support/timing` `perCallMs` (a call repeated until a round lasts ≥ 20 ms, best of 3): every
      ratio compares real times, no 1 ms floor. step-edits 1,200 vs 9,600 steps (8.1×, bound 13), line-diff capped
      3,000 vs 12,000 lines (1.0×, bound 8), agent-shell 250× longer text (1.1×, bound 5), timeline 4 vs 16 minutes
      (≈ 3.8×, bound 8). Mutations red: the cheap O(n²) line loop in verifyEditText (ratio 29, it survived before), an
      O(steps²) loop in timelineOf (13×), line-diff cap applied after an uncapped search (17×).
    - R2: one golden switch. core io-characterization, policy-characterization, blocks and runner-web kit-page, look
      now record through `recordGolden` under RETAKE_WRITE_SNAPSHOTS (bytes for the PNGs, folder made);
      RETAKE_UPDATE_GOLDEN is read nowhere. record-golden.test fails on any `process.env.RETAKE_*GOLDEN*/*SNAPSHOT*`
      reader or a `RETAKE_UPDATE_GOLDEN` in packages or docs/guide (mutation: one put back → red), plus an image-bytes
      case. Behaviour change to note: look.test under the switch now fails once it wrote a changed PNG (Chromium's
      bytes differ run to run, so it always does: record, look, rerun without), and kit-page no longer writes a missing
      golden by itself (it fails asking for the switch). docs/guide/development.md says so.
    - Events: counts poll starts (`Live.prototype.poll`) instead of timer ticks: the change is in the answer of the
      poll running at the write or of the first one started after it (≤ 1 started after). Mutation (changes emitted a
      poll late): red (by the event's content, which also changes).

## State (after L7.40)
- **L7.40 done (2026-11-13; branch `claude/arch-l7`)** — one shell lexer in core (`shell-words.ts`: `lexCommand` / `lexShell`, `shellTokens`, `shellWords` a projection) read by the destructive-hook guard, the host scan (`shell-hosts.ts`) and the trust scan of a hook's files (`hooks/trusted-files.ts` `scriptTokens`); the guard reads a command with its quoting resolved and follows every script it makes a program run (`shellRuns`, core shell-runs.ts), under one conservative rule: whenever the script a program will run is not exactly in the command, the command counts as destructive. Closes CC-M1 (S fix and M unify), T-2, T-3, T-4, T-7, T-16, the review's V1–V9, V11 and the re-review's R1–R4 (V10, V12 left by decision).
  - **Code**: core `shell-words.ts` — the lexer (moved from shell-hosts; `LexOptions.dollar` `'keep'` or a lookup; tokens carry `computed` and `pattern` — unquoted glob / brace characters), `shellCommands` generic, `commandWordAt(args, onAssign?)` (assignments, redirections, `function NAME`, `coproc [NAME {]`, `time -p`, keywords, wrappers), `SHELLS` (sh, bash, zsh, dash, ksh, ash, mksh, yash, fish, tcsh, csh), `shellInvocation` (`-c` alone or in a cluster, after options, `-o name`, `--`; stdin; a script file; with the index of the script word) behind `nestedShellScript`. New `shell-runs.ts` (hooks context; scripts/audit/lib.mjs lists it): `shellRuns` — one linear pass over the commands outside heredoc bodies, tracking compound depth and the pipeline being read; it follows exact scripts (literal `-c` / `eval` / `trap` / `alias` / `env -S` / `watch` / `su -c` / `parallel` / `xargs sh -c` / `find -exec sh -c` strings, literal heredocs and here-strings, `cat <<'EOF' |`, an `echo` without backslashes or a `printf` with one literal format, no directive but `%%`, ANSI-C escapes only, piped directly to the shell) and sets `unreadable` for every other script a program runs: computed strings, any other pipe into a shell (after a line break, `|&`, inside a subshell or compound command), `/dev/stdin`, `/dev/fd/*`, `<&N`, `< <(…)`, `bash <(…)`, `source <(…)` / `. <(…)`, a computed script path, `su` / `sudo -s` reading a pipe, `xargs` with a shell and no exact script or with its replace string, `find -exec` with a computed command, `{}` as command or a shell given `{}`, `parallel` without a command or with `{`. A shell at a command's word is any name in SHELLS, `busybox sh`, or a name ending in one after `-` / `_` / a restricted `r` or with a version (`rbash`, `bash5.2`, `my-zsh`). `destructive.ts`: `readScript`; `shellDestructiveCommand` (names, then the scripts, then `unreadable` and computed command words) and `psqlDestructiveStatement` walk the same scripts (depth 8). `shell-hosts.ts`: `tokenize` is `lexCommand` with its scope lookup, `commandAt` is `commandWordAt` with the scope's assignments. `trusted-files.ts`: `scriptTokens` reads as the guard (`'keep'` + redirects) and `scanScript` scans each command substitution's script. `approval.ts`: `shellFileWords` follows substitutions. docs/guide/security.md (the rule in one bold sentence with the list; a person's own hook in such a form needs `confirm: true`; the trust's reading), CHANGELOG [Unreleased] Changed (the guard's rule incl. `writes: false`; approvals and trusts bind more, asked once again after the upgrade).
  - **Characterization**: before the move, 1,465 string literals of the shell test files through shellWords, shellDestructiveReason, shellHostRefs (two option sets) and scriptTokens on the built dist, re-run after each step. Host scan: unchanged on the corpus except process substitution (`<(…)` / `>(…)` now a script of its own and a word boundary: `ssh h<(…)` → `h`; `x<(…)ssh h` no ssh command; pinned in shell-hosts.test). It is not identical elsewhere: the re-review's fuzz found keyword-led input (`function` / `coproc` / `time -p` before a client) where the new scan finds more references — never fewer (114 of 100,000 inputs) —, and `fish -c` / `tcsh -c` / `ash -c` … scripts are now scanned (SHELLS is shared). Trust tokens: changed on `$'…'`, `$"…"`, substitutions (one word), by decision. Guard: changed on the targeted forms; a glob or `/*` at command position in prose strings now counts, as bash would expand it.
  - **Tests**: core `destructive.test` 14 new (quoting, substitutions / eval, computed words incl. depth, not command words, psql in every followed script, sh -c forms, stdin scripts, brace / glob / alias, keywords and builtins incl. `env 'A=1' $CMD`, linear time on 80,000 words / 5,000 nested sh -c / 2,000 substitutions under a 5 s bound, unreadable scripts — pipes in every form, fds, process substitutions, computed paths —, exact echo / printf only, su / sudo -s / xargs / parallel / find -exec / shells outside the usual list, the exact-only rule case by case), new `shell-words.test` (10), `shell-hosts.test` (process substitution), new `path-inside-win32.test`, `home-key.test`, `navigation-policy.test`, `templating.test`; hooks `secrets.test` (2), `trust.test`, `trusted-files.test` (ANSI-C, substitutions, `bash -ec`); engine `agent-safety.test`, `site-job.test`; sandbox `units.test`. No existing test changed.
  - **Mutations**: 99, all red — 25 in the first pass, 33 in the fix pass, 41 in the second (one more matched two sites and was not run); 20 were green at first and turned red once a test was added for them (4, then 16).
  - **Gates**: `npx tsc -b`, `pnpm typecheck`, `pnpm lint` (none new), `pnpm format:check`, `rules.mjs --check` (115, unchanged), `test-guard.mjs` (no decrease), `requirements.mjs --check-cites` on a scratch copy with the edits applied — all exit 0. Each file alone (fresh RETAKE_HOME, RETAKE_DISK_WARN=off), green: every hooks test file; core destructive, shell-words, shell-hosts, agent-shell, agent-policy, agent-trust, blocks, hookfile, scenario, project, import-rules, path-inside(-win32), home-key, templating, navigation-policy; engine approvals, hook-fingerprints, hook-runner, reset-hook-approvals, agent-sql-approvals, agent-written, agent-safety, site-job; cli read-only, operations-cli (fixture unchanged), run-agent-hooks; mcp approval, environment-ops-characterization; sandbox units.
  - **Requirement edits** (`.private/l7/L7.40-requirements-edits.json`): R-SEC-04 evidence (the one rule) and gap; R-SEC-40 evidence.
  - **Not done**: the full suite was not run. V10 (the lexer ends a word at `<(`, bash does not) and V12 (R-SEC-04's gap wording) left as decided.

## State (after L7.39)
- **L7.39 done (2026-11-13; branch `claude/arch-l7`)** — the rule: a person's trust in the hooks of a scenario an agent wrote (`retake hooks trust`, its line in the project's `.retake/scenario-writes.jsonl`) binds, besides the hook surface, the bytes of the files those hooks read — code strictly (sql / js files and rollbacks; in a shell command argv[0] with a slash, an interpreter's script, psql `-f`, a `<` target), data when it exists (every other file a shell command names, glued option values, env values; never under Retake's own folders or the run's) — as the hooks package's trust resolver sorts them; when that line decides, `retake run` and `retake hooks run <scenario>:setup|teardown` read the files again whatever the hook kinds, and a file not as trusted (code changed, newly run or unreadable; data changed or unreadable) makes the hooks asked again, the listing naming each file; the files that check read hold the run (each hook re-checked as it is about to run, an sql / js file checked as its bytes are read, a held file that changes refused to later readers unless the running hook names it as a plain `>` target and really wrote it, files written by hooks bound like any other; a writer whose output a later hook runs as code has its own inputs checked as code, up a chain of writers). A person's own scenario is unchanged. Closes SECURITY-open L3 (the 2026-11-12 terminal entry).
  - **Review**: a first pass and five review rounds (findings and fixes in `.private/l7/L7.39-review.md`); the rule as stated above and in docs/guide/security.md is the one that holds. 61 mutations, all red. Gates: `npx tsc -b`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `rules.mjs --check`, test-guard, `--check-cites` all 0; the 15 touched and nearby test files green on `claude/arch-l7` (371 tests).
  - **Code**: core hook-run.ts — `TrustedHookFiles` ({code, data}), `TrustFilesPlace`, `HookFileChange`, `UNREADABLE_FILE`, `trustedFileChanges` (code: unreadable / added / changed; data: only paths the trust holds, changed / unreadable; malformed trust holds nothing), `HookContext.trustedFiles`. hooks: new trusted-files.ts (`hookTrustFiles`: explicit refs as code, missing → unreadable; shell parsing — redirects split from glued words, `<` / `<>` target code, `>` / `>|` targets the hook's written files (quoted or escaped `>` a word), here-doc words skipped, leading assignments and wrappers env / exec / nohup / time / command / nice skipped (assignment values as data), cd / pushd folders accumulated (each existing candidate bound), `sh -c` followed, argv[0] with a slash code, the first non-option argument of the listed interpreters code (`-c` / `-e` / `-p` / `--eval` / `--print` / `-m` stop it; `deno run` / `bun run` skipped), psql `-f X` / `-fX` / `--file[=]X` code, `--opt=v` and `-xV` values data; vars-only rendering (`renderWithVars`), a cwd with another token binds no relative word; absolute / `~` inside project or workspace only; Retake's folders and `runDir` excluded for data; stream hashing, directory → not a file, other non-regular → unreadable; prototype-free maps; `trustedFilesProblem`, `trustedFilesMessage`); run.ts (each hook checked against `ctx.trustedFiles` before it prepares, refused as `HookSecurityError(…, 'trust')`); kinds/common.ts (`readHookFile` under `trustedFiles` reads the bytes once and refuses other bytes or an unbound file); errors.ts (reason `trust`); approval.ts (F5 map). engine: hook-run/runner.ts, package-hooks.ts, memory-hooks.ts (`approval.trustFiles`); agent-written.ts (record line `files: TrustedHookFiles`; `scenarioHookFiles` through the port with the listing's vars and the workspace root; `olderTrust` — F4: a person line keeping the surface without files falls back to an older trust of that surface; `scenarioHooksCheck` → `{ ask, bound }` — F3: when the phase has no shell / sql hook its files are still read and a trust's changed files ask with `hooks: []`; `bound` = the files read when a trust decided or when asked; `agentWrittenShellHooks` its `ask`); hooks-work.ts (`onSelected` may return `{ trustedFiles }`, set on the context); execute-run.ts and capture/memory-run.ts (`trustedHookFiles`). runner-web: capture/options.ts (`RunOptions.trustedHookFiles`), lifecycle.ts, hooks.ts (into the context). cli: commands/run.ts and commands/hooks.ts (scenarioHooksCheck, the bound files handed to the run / the hooks work), agent-hooks.ts (header / refusal / question when no hook is listed; "newly read as code"). Docs: guide/security.md (the rule, what is bound and how, what is not, the in-run hold and its moment, `{{run.dir}}` for generated files), cli.md, CHANGELOG [Unreleased] one entry.
  - **F2's remaining window** (stated): a shell hook is checked just before it starts, so the shell still reads its script a moment later; an sql / js file is checked as read (no window). F7: the trust hashes as a stream; an approval's fingerprint still hashes in one read (unchanged path).
  - **Characterizations**: none changed — operations-cli.json and pipeline-cli.json green unchanged. No CLI fixture case now asks.
  - **Requirement edits** (`.private/l7/L7.39-requirements-edits.json`): new R-SEC-40 after R-SEC-39 (rule, evidence, gap with what stays unbound); R-SEC-39's gap (its terminal sentence points at R-SEC-40).
  - **Not guaranteed (security.md / R-SEC-40's gap)**: files outside the resolver (through another script, interpreters outside the list, make / npm run inputs, non-vars templates, PATH commands, what `>>` appends to, data under Retake's folders); a data file appearing after the trust that a trusted program treats as code (except a code reader's writer chain); the moment between a shell hook's check and its read; js-only / http-only agent scenarios without a trust (R-SEC-38); an approved hook rewriting the record (F4 of L7.27). Usability: only a plain `>` / `>|` target counts as the run's own output (a file written by cp, tee, sed -i or a script and read later is asked about); a teardown run alone after its setup changed its file asks; an unreadable file stays asked after a trust. The optional `writes:` list was skipped (lead's decision).
  - **Not done.** The full suite was not run. No real terminal prompt answered by hand (scripted answers).

## State (after L7.38)
- **L7.38 done (2026-11-13; branch `claude/arch-l7`)** — the end of U9 (R-ARCH-46's and R-ARCH-49's hand-off): the engine reads a workspace through a port, `EnginePorts.reads`, and a whole workspace can live in memory; the first engine tests that needed a folder only to have a workspace to read run on it now. Code and tests only: nothing a client sees changes.
  - **Measured at 82bdfbd.** The engine imports `@retake/core/io` in 75 files. Its workspace loaders (loadWorkspaceConfig, findWorkspaceRoot / Upward, listProjects, loadProject, planNewProject, readScenarioSource, loadScenario, listTemplates, loadTemplate, loadProjectTemplate, projectTemplateFolderId) are called at 42 sites in 22 files; plus projects.ts `checkProjectFile`'s own `realpath`. The loaders reach node:fs at 25 points (readFile, readdir, existsSync, statSync, realpathSync, readPlainFile) and hand `nodeFileFacts` to two rules.
  - **Core: a disk port under the loaders** (file-facts.ts): `WorkspaceDisk` (facts, readFile, list, readPlain), `plainFileVerdict` (the plain-file rule once open: not a file, the caller's check, the cap — io readPlainFile now decides by it), io file-facts.ts `nodeWorkspaceDisk`; io memory-disk.ts `memoryDisk` over live maps (files, links followed segment by segment but readPlain's last segment, empty folders, videos; a path through a file ENOTDIR, a link loop ELOOP past 32 links, else ENOENT) and `fsError` (node's code, errno from os.constants, syscall and words for ENOENT / EISDIR / ENOTDIR / ELOOP) — in io because an errno is the machine's. The loaders of io workspace.ts, project.ts, scenario.ts, template.ts and sandbox.ts got `…On(disk, …)` forms; their public names are the same functions on nodeWorkspaceDisk (no other package changes a call). io reader.ts: `WorkspaceReader`, `workspaceReader(disk, facts)`, `nodeWorkspaceReader` (also `fileFacts(policy)` of that disk). The fake runs the loaders' own code: no refusal, word or order copied.
  - **Engine: the port** (`workspace-reads/`: reads.ts `WorkspaceReads`, disk-reads.ts `diskWorkspaceReads`, memory-reads.ts `MemoryWorkspace` — one Map shared with a `MemoryProjectStores`, whose constructor takes `files`; `seed` / `link` (refused where the Map holds files) / `folder` / `video` / `remove` / `ports()`, its limits said in its head: the store does not follow seeded links, and the app-bundle check (core io insideBundle, a node real path) is not on the disk port, so a memory test cannot exercise that refusal). `EnginePorts.reads` (enginePorts writes the default); `openWorkspace({ root, agent, reads })` requires it and `OpenedWorkspace.reads` carries it; the roots hand theirs (createEngine, worker, job process, cliPorts; the job contexts and the worker record carry `reads` like the other ports). 38 of the 42 sites switched (20 of 22 files); every `fileFacts(ws.policy)` in the engine became `ws.reads.fileFacts(ws.policy)` (on the disk the same function); checkProjectFile reads native real paths through the port's facts (as node's promises realpath did). Signatures that had only a project and a FileFacts gained the reads: validateScenarioText / saveScenarioText / editScenario / prepareScenarioEdit / draftFromScript, the comment proposal chain, selectHooks and hooksRunWork (`reads`; the CLI's hooks command hands `ws.reads`), RecordStudioContext and saveRecordedDraft, raw export's `ws`; themeForWork(ws, project, name) and themeUnusable(dir, reg, ws); sandboxWork.init(ports, …); writeNewProject(ws, …) (CLI `new` and `sandbox init` follow). Left: agent-written.ts (L7.39's file: 3 loaders) and the in-memory reviewer's loadProject (it stands for the review package, which loads the project itself) — pinned.
  - **Ratchet `workspace-read`** (lib.mjs `workspaceReadHits`, WORKSPACE_LOADERS, WORKSPACE_READS_HOME; `diskWorkspaceReads` in PORT_ROOTS): a loader of core io imported as a value in packages/engine/src outside workspace-reads/ (alias, namespace member by name or key — through parentheses, `as`, `satisfies`, `!` —, `import io = require`, re-export, `export *`, `import()` / `require()` of core io; not seen, listed in its title: a destructured member, an aliased namespace, a computed key); `MemoryWorkspace` named as a value in packages/*/src outside its own file (the fake stays out of the product's sources; its re-export from the index is no use). Baseline 111 → 115 (two groups with reasons). import-rules.test: 4 new cases (forms, namespace / re-export / dynamic, the adapter outside its roots, holds today + every `…On` the reader binds is in the list).
  - **Contract** engine/test/workspace-reads-contract.ts, 9 cases run by workspace-reads.test.ts on both adapters (a real temp folder; a MemoryWorkspace with the starter themes copied in), same expected values: the workspace config and its refusals (an EISDIR in node's words), a path through a file and a link loop (ENOTDIR / ELOOP where the loaders branch on ENOENT: a workspace under a file, projects_dir a file, a sandbox manifest under a file, retake.yaml and a README in a loop), the project list (hidden, files, a link to a folder left out), a project load and its suggestion, project.yaml's and a sandbox manifest's errors, the README's plain-file rule (link, folder, over / at the cap), a scenario's read and hash, the themes (workspace before starters, shadowing, missing assets, unknown name, folder ids), a new project's plan and refusals. Plus the memory disk's node words (code, errno, syscall, message, ENOTDIR and ELOOP included) against node's, `link()`'s refusal, the shared rule, a project created and a scenario saved through an engine on a MemoryWorkspace read back with no folder made, and the ports' default.
  - **Tests moved onto the fake** (titles unchanged, expects equal — test-guard "no decrease"): engine.test "engine: projects" — "a project that does not load…" (its own temp workspace → a MemoryWorkspace), "lists projects and reads one…" and "refuses paths…" on a memory copy of the fixture (test-support workspace.ts `memoryFixtureWorkspace`, `memoryCopy`; `MemorySeed`); "creates a project and replaces its README…" stays on the disk (the real case of the area). memory-store.test's two README cases: the workspace in memory too (its temp folder gone). Times (3 runs each, per case, ms): engine.test's three 5 / 26 / 2 → 4 / 26 / 2, memory-store's two 10–17 / 12–14 → 8–9 / 10–11: no gain worth the name — the disk was never the cost of these; the gain is that they need no folder. The test-only callers of the changed signatures (~30 files: `reads: diskWorkspaceReads` beside the `files` they passed, `openWorkspace({ …, reads })`) changed mechanically.
  - **Mutations: 20, all red** (each restored by backup + cmp + touch; `npx tsc -b --force` after): the plain-file cap `>=`; the memory disk's readPlain following a last-segment link; the README, a scenario's bytes and a sandbox manifest read by node instead of the disk (memory contract red each); subdirs counting a link as a folder (both adapters red); EISDIR's words naming the path; a starter not shadowed by a workspace folder; openWorkspace ignoring the reads handed (workspace-reads red); checkProjectFile comparing the folder with itself (storage-links red); the ratchet blind to an alias, blind to a namespace member, and `diskWorkspaceReads` dropped from PORT_ROOTS (import-rules red each). Review fix pass, 7 more, all red: a path through a file answered ENOENT, a loop answered ENOENT, readPlain reading a loop as missing, ELOOP's errno positive, `link()` accepting a path that holds files, the ratchet not unwrapping the namespace, `MemoryWorkspace` dropped from PORT_ROOTS. Also: scenario.ts calls `o.readFile(file)` / `disk.readFile(file)` (no detached method).
  - **Gates.** `npx tsc -b`, `pnpm typecheck` 0; `rules.mjs --check` holds (115); test-guard "no decrease" (exit 0); `--check-cites` 0 on the tree and on a scratch copy with the edits (a wrong title there is reported); `pnpm lint` 541, none new; `pnpm format:check` clean; no characterization fixture changed (`git diff -- '**/fixtures/**'` shows only the two engine test scripts comment-writer.mts and library-key.mts, which pass `reads`); no new hidden Unicode (the three test files that hold some held it before). Each touched or affected test file alone (fresh RETAKE_HOME, RETAKE_DISK_WARN=off, Node 22), 108 files: 1379 passed, 1 failed first — engine ports.test's list of the ports bag's keys (gains `reads`, fixed, then 10 / 10) —, 676 s; After the review fix pass, alone: workspace-reads 23 / 23, import-rules 102 / 102, core scenario 42, plain-file 5, file-facts 5, io-characterization 3, app-bundle 23 (core) / 27 (cli), engine scenario-check 9, engine 13, memory-store 13, capture-runner 24; gates again green. The full suite was not run.
  - **Not done.** The engine's other disk reads and records (run folders, renders, the queue, the index, `stage.copy`'s source, the project's record of scenario writes — a save on a MemoryWorkspace warns it could not write it), 36 `nodeFileFacts` uses in 15 files and record.ts's `fileFacts(o.policy)`; agent-written.ts (switch it once L7.39 lands: drop its baseline group); most engine test files still need a disk for those reads.

## State (after L7.37)
- **L7.37 done (2026-11-12; branch `claude/arch-l7`)** — U9's second part (audit 2026-11-10 finding C5, and P3 / C3's second half): one private package for the helpers the tests of several packages share, one helper for a test's own RETAKE_HOME, both held by the import-rules ratchet, and five more engine test files partly on the in-memory ports. Only tests and test tooling move: no change a client sees.
  - **Re-measured at 2cfdc42.** Relative imports into another package's test folder: 314 specifiers in 162 files — 268 into helpers (engine helpers 85, editor render-helpers 52, review helpers 32, editor helpers 29, core child-env 25, runner-web site-fixture 11, engine synthetic-runs 10, ui http 7, runner-web helpers 7, ui timeline-take 5, ui studio-tools 4, core helpers 3, runner-web auth-server 2; L7.34 counted 267: one dynamic `import()` more) and 42 into core's record corpus (fixtures/records build / build-renders / prune-layouts: L7.34's count left fixtures out). Hand-written RETAKE_HOME save / restore: 160 files, 304 sites (L7.34's 167 counted every file naming RETAKE_HOME save-like).
  - **(a) `packages/test-support`** (`@retake/test-support`, `private`, version 0.2.6 so set-version and app-bundle's one-version check hold, no script, no dist, no dependency, not in the root tsconfig.json references; `tsconfig.json` extends tsconfig.test.json for an editor / `npx tsc -p packages/test-support`; 14 modules, each an alias in vitest.config.ts and a path in tsconfig.test.json — test-typecheck compares them; pnpm-lock gains the empty importer `packages/test-support: {}`). Modules: repo (REPO, TEMPLATES, hasTool: two copies before), workspace (fixtureWorkspace), runs (synthetic-runs whole), render (render-helpers), timeline (synthTimeline, SceneSpec / EntrySpec, FIXTURES, realTimeline, template, fixtureProject), review (review helpers; `segmentSpans` now through `@retake/review/checks`, the same module), capture (runner-web's shared part: startServer, FAST, makeScenario, debugTemplate, execFileP, ffprobeDuration, frameAt, magentaCentroid), site (site-fixture; its data stays in runner-web/test/fixtures/brand-site, read by path), auth (the cookie sign-in app; `signInMaster` and its playwright import stay in runner-web/test/auth-server.ts), http (ui raw), take (timeline-take), child-env (testChildEnv), confinement (STUDIO_CONFINEMENT), home. Rule: what the tests of two or more packages use moved (not copied); what one package alone uses stayed (editor helpers' studioWorkspace / plan / clips, runner-web helpers' makeProject / testHookRunner / decodePng…, engine helpers' authorScope, core helpers' rest). Seven helper files gone, five split. 496 import declarations in 271 test files rewritten by an AST codemod (+1 dynamic import by hand); string and template texts of every changed test file compared with HEAD by AST: unchanged but the removed restore loops' names. Comments naming the old files updated; docs/guide/development.md (layout row, the rule, testChildEnv's path). **CLAUDE.md line "children: packages/core/test/child-env.ts" → packages/test-support/src/child-env.ts (lead).**
  - **The home helper.** `scratchHome(...others)` saves RETAKE_HOME (and the variables named with it) when made; `use(dir)` sets the home, `restore()` puts every one back, deleting one that was unset; `withHome(dir, fn)` around one call (finally). It makes no folder and picks no path: each test keeps the path it named (`join(ws, '.home')`…) and its save / restore points (made where `savedHome` was, restored where it was). vitest.config.ts gives the run one scratch home and every file starts on it; the helper puts that back. Migrated: 160 files (117 + 35 by two regex passes checked by the detector and the string comparison, 8 by hand: catalogue-acceptance, run-live-pause — two helpers, its real describe restores TMPDIR and the pause cap, the memory one the home only, as before —, mcp http, authoring-ops-characterization, http-credentials, launch-options, ui server — three in-test helpers —, studio-e2e-setup). Side effect: the restores written `process.env.RETAKE_HOME = saved` without the unset branch now delete when unset (never the case under vitest). Left as they were: 7 runner-web / cli files that set RETAKE_HOME in a beforeAll and never restore (no save existed; per-file process).
  - **(b) Ratchet** (scripts/audit/lib.mjs, in `rules.mjs --check` and import-rules.test): `test-reach` — in packages/*/test (fixtures included) and test-support/src, a relative import / re-export / `import()` / `require()` / `vi.mock` / `vi.doMock` / `vi.importActual` / `import('…')` type resolving into another package's test folder; `home-restore` — `process.env.RETAKE_HOME` kept (variable, assignment's right side, object member, array element, through `!` / `as` / parentheses) or deleted, outside `packages/test-support/src/home.ts`. TEST_SUPPORT is left out of the source scan and the layers (import-rules' layer test says so). Baseline 80 → 111 entries: test-reach 30 pinned in two groups with reasons — the record corpus (26: builders beside their data, moving them splits the corpus, moving the corpus moves the fixtures) and ui/test/studio-tools.ts (4: it builds the Studio's ops from `studioTools`, which @retake/ui does not export); home-restore 1 (the helper's own test in core retake-home.test.ts keeps the run's home by hand). New tests: import-rules "test-reach and home-restore" describe (3), retake-home "L7.37: the shared home helper …", app-bundle "the tests' shared helpers never ship (L7.37)" (private, no build / dist / deps, not referenced, no package names it, no src imports it; `pnpm --filter @retake/cli... --prod ls` lists no test-support).
  - **Made to hold (test code read as product sources):** three tests walked every `packages/*/src` and now skip test-support — app-bundle "no source names ffmpeg / ffprobe as a command…" (was red on the helpers' ffmpeg), build-ffmpeg's engine arguments, project-store's source list; retake-home's testFiles reads test-support/src too. **import-rules.test ran its whole scan 12 times (~4 s each, synchronous): past vitest's 60 s RPC timeout ("Timeout calling onTaskUpdate", exit 1) on a loaded machine** — the repository's entries are computed once per file now (a copy per caller): 65 s → 18 s, same 98 tests.
  - **(c) Engine tests on the in-memory ports** (a builder sub-agent; titles unchanged, expects up): review-export-jobs (the cancel mid re-render and the outside-project refusal on MemoryRenderer + MemoryReviewer over the real render, the tampered report on the MemoryReviewer; the real review and the real export kept) tests 43.4 → 15.0 s (before on a loaded machine; per case 2.8 → 0.9, 1.7 → 0.05, 9.0 → 0.08 s); record-studio (three cases on memoryRecord replaying the lab's events / a held check; the lab recorded for real kept) 17.5 → 10.8 s; site-job (the forged job) 7.5 → 6.5 s; journal-trust (three approval cases on one MemoryHookRunner; signed journals and the reserved run kept real) 7.2 → 7.8 s (no gain: the worker's idle exit is the cost); preview-jobs (cancel before start) 8.9 → 8.7 s. Left real, with reasons: inspect-jobs (its slow cases are the browser's: inspection, popups, the replay, the sign-in's missing secret; three already in memory), sign-in-sandbox-jobs (a worker in its own process; MemorySandboxes runs no seed step, so the shell-seed approval cannot be carried).
  - **Mutations: 17, all red.** Sub-agent 7 (engine src: browser.json removal, export's render re-check, finding-code check, siteApproved, unverified approvals, checkAgentCancel, discarded vs cancelled). Lead 10: test-reach blind to `vi.mock`; home-restore not counting `delete`; scratchHome restoring '' instead of deleting; withHome without finally; workspace.ts dry run `succeeded` (engine.test red); child-env without RETAKE_RENDER_GL (retake-home red ×2); review.ts drawing no caption bar (review.test red ×2); ui launch's home-inside refusal off and its busy words changed (server.test red each); MemoryCaptureRunner's `fail` dropped (capture-runner red, the dynamic import of capture). Each restored by backup + cmp + touch; `npx tsc -b --force` after.
  - **Gates.** `npx tsc -b`, `pnpm typecheck` (and `tsc -p packages/test-support`) 0; `rules.mjs --check` holds (111); test-guard "no decrease" (296 files; no title lost or moved, no file moved; expects up in app-bundle, import-rules, retake-home and the five engine files); `--check-cites` 0 on the tree and on a scratch copy with the edits (a wrong title there is reported); `pnpm lint` 541, none new (baseline: site-fixture's one `noShadowRestrictedNames` moved to test-support/src/site.ts, total unchanged); `pnpm format:check` clean; `set-version --check` 0; no fixture changed (`git diff -- '**/fixtures/**'` empty); no hidden Unicode. Each of the 296 touched test files alone (fresh RETAKE_HOME, RETAKE_DISK_WARN=off, Node 22): 3057 passed, 77 skipped (gated), 2 failed first — app-bundle (the ffmpeg scan, fixed above, then 27 / 27) and runner-web record-session (one real-browser case; 21 / 21 on the rerun: flaky) —, 3765 s; build-ffmpeg 13 + 2 skipped, project-store 23, old-name 4, app-update 7 after their edits. The full suite was not run.
  - **Not done.** The record corpus and studio-tools reaches (pinned); the 69 small engine files still read their workspace through core's io loaders (a workspace-read port, as L7.34 said); inspect-jobs and sign-in-sandbox-jobs on the fakes.

## State (after L7.36)
- **L7.36 done (2026-11-12; branch `claude/arch-l7`)** — U13 (audit 2026-11-10 findings C2, C6, C7): one linter and one formatter with a baseline, the published descriptions without lot ids, and this file cut to what is true now. No change a client sees but six schema descriptions and one Studio input description. Plan, measures and the commit split: `.private/l7/L7.36-plan.md`.
  - **(a) C2, Biome.** `@biomejs/biome` **2.5.15** (exact root devDependency; published 2026-09-30, the last patch of 2.5 — the 2.6 line, from 2026-10-21, had seven patches in three weeks and only 2.6.4 was two weeks old); the lockfile gains only it and its eight `@biomejs/cli-<platform>` packages. `biome.json` measured on the code: 2 spaces, single quotes (JSX double), semicolons, trailing commas, `(x) =>`, line width **200** (≈ the lines' p99; width 120 would have rewritten 140,000 lines, 200 rewrites 38,900). Scope: TS / JS of `packages/*/src`, `packages/*/test`, `scripts`, `apps/desktop/scripts` and `apps/desktop/bundle`; never `test/fixtures`, `test/golden`, `dist`, JSON / CSS / YAML / Markdown, templates, the component library and scaffolds (their hash drives preview staleness), fixtures, projects, skills, root configs, Rust; the formatter also leaves `apps/desktop/**` (the bundle / release tests read its exact text: three of them failed once it was formatted — L7.34 kept those guards on purpose). Linter: the recommended preset, eleven rules off (each with its reason in `scripts/lint-baseline.json` `off`, checked); **541 diagnostics in 39 rules** are the baseline. `scripts/lint.mjs` (mirrors `audit/rules.mjs`): counts per rule and file, a new or raised count fails, a lowered one fails until `--write-baseline`, a config problem or an unexplained rule off fails; `--list`. `pnpm lint`, `pnpm format`, `pnpm format:check`; `node scripts/lint.mjs` is the last line of the CI's guards (ci-workflow.test follows). New test core `lint-ratchet.test.ts` (5).
  - **Made format-proof first (in commit A):** test-guard reads a title by its value and `expect\n.poll(` (without it the format reads as 540 lost titles / expects; test-guard.test +1 case); app-source's real-control exceptions match the opening tag on one line and its palette mutation anchor is a pattern; build-ffmpeg reads the encode argument lists flattened; test-typecheck EXPECT_ERRORS 47 → 48 (the new test's `.mjs` import). **Boy scout:** engine run-thumbs.test failed on HEAD (L7.35 moved the policy type to `@retake/core/policy`): it follows.
  - **(b) The first format (commit B, formatting only):** `pnpm format` (a second pass fixed two files; a third is a no-op), then 29 inline JSDoc comments Biome had moved before the previous member's `;` put back above their member. **1,022 files, +38,864 −15,184.** Every file compared with the Part A tree by TypeScript's AST (kinds, names, literal values, JSX text as React reads it, every comment in order): equal but parentheses and a union's leading bar; five files differ equivalently (`a ?? (b ?? c)` → `a ?? b ?? c` twice, a JSX space as text or `{' '}` three times). Leaf-token diff of 30 sampled files: 30 equal after semicolons, parentheses, trailing commas and leading bars (one shows a JSDoc node attached once the comment is back above its member). No fixture, golden or snapshot file changed.
  - **(c) C6, published descriptions.** Lot and requirement ids out of the zod sources' `.describe()`: core schemas/project.ts (sandboxes; `render.gl` and `render.ffmpeg` reworded: "the path every render took before the GPU one", "how every frame encode ran before this setting"), scenario.ts (`target_length`), timeline.ts (seven: the page-load hold's R-ISS-08, pauses, `end_point`, artefacts, sandbox, environment, live picture), components manifest.ts (multi-page sample screens), ui server/ops.ts (the thread preview: op-table.json's one line). `project`, `scenario`, `timeline` and `component` schema files regenerated. **MCP's tool list had no lot id: `fixtures/tool-list.json` is unchanged**; the skills quote none; docs/guide/workspace.md's two `render:` rows follow the reworded descriptions. Comments (C6's 2,655 lines) untouched.
  - **(d) C7, the hand-off.** `docs/HANDOFF.md` 4,057 → 237 lines: the old-name line, where things stand (phases, releases, branches, guards), next steps, pending for the person, what this is, the read order, "Lots since the cut" with the newest State (L7.35; the register helper inserts above the first State heading, as before), Mac setup, the fixture, decisions, conventions, environment. Everything else moved **verbatim** to `docs/archive/HANDOFF-history.md` in its order under its own headings (the head of 2026-11-09, the v0.2.1 – v0.2.6 notes, the states L7.34 back to phase 1, the order of the lots, the next lot as it was, the lot log, the evidence, the notes, the cloud container) — every original line is in one of the two files (checked as a multiset); only eleven relative link targets were re-rooted (`../`). AGENTS.md's trust-rules pointer and development.md's file map follow. **CLAUDE.md** (lead's): "Read first" 1. still points right, but its description "state, Mac setup, order of the next lots, decisions, notes per lot" should read "state, next steps, Mac setup, decisions; the per-lot history in `docs/archive/HANDOFF-history.md`"; the everyday commands could gain `pnpm lint` / `pnpm format`.
  - **Gates** (Node 22, from the root, fresh RETAKE_HOME, RETAKE_DISK_WARN=off), after each part: `npx tsc -b` 0, `pnpm typecheck` 0, `rules.mjs --check` 0 (80), test-guard 0 ("no decrease"; 29,532 expects in 491 changed test files, equal), `--check-cites` 0 (and on a scratch copy with R-ARCH-48; a broken cite there is reported), `pnpm lint` 0 (541), `pnpm format:check` 0, set-version and `--untested 1` 0. Tests: Part A's touched files on the unformatted tree (6 files, 126 green); after the format, every characterization, snapshot and CLI-fixture test, every test that reads a source file, the entry walks and a sample (72 files, 882 green; then 106 more source-reading files, 1,334 green; the three desktop-script failures fixed by the formatter's exclusion, those files then 157 green); after Part C, the 30 characterization / snapshot / schema files (218 green) and old-name, lint-ratchet, ci-workflow, fixture-names (20). The full suite was not run.
  - **Not done.** `format:check` in the CI (proposed: one more guard line); lot ids in comments and docs prose; DESIGN.md (705 KB) not cut; the older State sections move to the archive by hand.

## State (after L7.35)
- **L7.35 done (2026-11-12; branch `claude/arch-l7`)** — U10 (audit 2026-11-10 findings D1, D7, D6): core is fifteen contexts with an entry each and a ratchet between them, the job vocabulary is the engine's, and the domain names no channel. No change a client sees. Each finding checked against c958aa0 first: D1 open (index.ts 64 `export *` + 21 selective lines, **1,320 names** — the audit's "about 1,080" was low —, entries `.`, `./io`, `./schema/*.json` only; 704 files import the root: 374 sources outside core, 328 tests); D7 open but its id part (comments.ts / brand.ts took the grammars from id-grammar.ts already); D6 open (`AgentChannel`, `channelWords`, `confined: 'mcp' | 'studio'`, three branches on `'studio'`). Plan, measures, the use table of every channel word: `.private/l7/L7.35-plan.md` (§7: as built).
  - **(a) D1, contexts and entries.** `scripts/audit/lib.mjs` `CORE_CONTEXTS` (the map, data; each core file in one): base, model (types.ts whole — not split —, the primitive schemas, media, the ports, render settings, the confinement, the checks' shared context), ids, language, environment, policy, hooks, project, sandbox, scenario, comments, run, render, theme, schema; each may import only those before it, a type-only import of `model` free. `packages/core/src/entries/<context>.ts` (generated once by a scratch script: a name is exported by the entry of the file that declares it — `export *` of a file when index.ts exported it whole and it holds no other context's name, an explicit list otherwise; hand-kept from now on), core package.json `exports` (`./<context>`: source / types / default). **The root is kept** — index.ts is now the fifteen `export *` — for the tests (328 files), scripts and anything outside the packages' sources: migrating the tests is the same script but doubles the diff for no boundary the ratchet reads. Root names 1,320 → **1,271** (−52 job names to the engine, −`AgentChannel` −`channelWords`, +4 of the confinement, +`TutorialSwitchSchema` that the engine's job inputs need), every other name declared by the same file (listed before / after with the compiler's API). **388 source files** of the other packages rewritten by a script to their entries (one declaration per entry, `import type` / inline `type` and aliases kept); a line-by-line check of the diff: outside core, every changed line is an import / export line but the D6 call sites below. vitest aliases and tsconfig.test paths gain the fifteen entries (test-typecheck compares them); the one `vi.mock('@retake/core')` (cli operations-cli.test, `newRunId`) now mocks `@retake/core/ids` (with the root it no longer reaches the CLI: mutation red); the entry walks (editor plan-entry, review checks-entry, hooks describe-entry) list the core entries each reaches. core/src/schema.ts (a barrel only) deleted; R-CORE-07's evidence follows.
  - **Ratchet**: two new checks — `core-context` (in core outside io/ and index.ts: an import of a later context; a file of no context, `unassigned`; an entry re-exporting outside its context; a context file importing an entry or the root) and `core-root` (in the packages' sources outside core: the root `@retake/core`, by import, re-export, `import()` or `import('…')` type, or a sub-path that is no `exports` key; `./schema/*.json` read as a pattern). Today's count with the map at c958aa0: core-context **3**; after the lot **2** (checks/scenario.ts → template-defaults.ts: the scenario's checks read the default theme's component names; script-draft.ts → inspect.ts: `inspectPathProblem`) — the third (comments.ts → scenario-edit.ts) went with comments placed above the scenario context; core-root **0**. Baseline 78 → **80** (the core-context group with its reason; jobs.ts's id-grammar entry renamed to engine jobs/job-input.ts in its group). The ratchet caught a root import the work had reverted by mistake (bundle-player.ts), fixed.
  - **(b) D7.** core jobs.ts → `packages/engine/src/jobs/job-input.ts` (verbatim but its imports and header), exported by the engine's index (`export *`); engine files import it relatively, cli / ui / tests from `@retake/engine`. The export format names (`EXPORT_FORMAT_NAMES`, `DEFAULT_EXPORT_FORMAT_NAMES`, `ExportFormatName`) stay in core as `export-formats.ts` (render context): the editor (an adapter, R2) names them. Tests: core jobs.test.ts → engine **job-input.test.ts**, core job-class.test.ts → engine **job-class.test.ts** (titles and expects unchanged: 14 / 79 and 3 / 11, compared with test-guard's own parser across the move); core ids-characterization and site-url take the job schemas from `@retake/engine` (one import line each).
  - **(c) D6.** core `confinement.ts` (model): `Confinement` {words, writesThrough?, themeList?, approval} — the words of a refusal of confined work as data —, `AGENT_CONFINEMENT` (the MCP server's words: what core says when it is given none, as before), `confinementOrDefault`, `confinementWords`; every core / adapter `via`, `hookVia` and `confined` member keeps its name and takes the value; the branches on `'studio'` (agent-trust's " through MCP" and "(template_list names them)", checks/context's words, hooks run.ts's approval clause) read its members. The engine keeps its channel: `AgentChannel` in caller.ts with `CONFINEMENTS` (mcp = core's AGENT_CONFINEMENT; studio = "from the Studio", no tool hint, "the Studio cannot approve hooks yet — run it in a terminal") and `confinementOf`, converted where the engine hands a channel down (approvals, scenarios, protected-hosts, hooks, execute-run; scenario-view / timeline-view through scenarios). Untouched on purpose: the comment author's `via` (`CommentVia`, the comments file format) and `JobClient` (`submitted_by`, moved with D7). No `via` is written anywhere.
  - **Boy scout.** `stepFingerprint` / `stepFingerprintOf` from comments.ts to steps.ts (a step's identity; filmed, step-match and comments import it there); `canonicalJson` no longer re-exported by comments.ts (filmed, edit-replan, step-edits, step-match and io/filmed.ts import canonical-json.ts; the base entry exports it). Stale dist outputs of the removed sources (core dist/jobs.*, dist/schema.*) deleted; the bundle's stale-output check still lists 72 older ones from earlier lots (ui dist/app/* of L7.32, core dist/legacy.js…): `rm -rf packages/*/dist && pnpm build` before a bundle.
  - **Differential** (c958aa0 built in a scratch worktree, offline, removed after): one script over each tree's build — agentTrustProblems (with and without the environment), navigationProblem, shellAlwaysWrites, writingHooks, secretRefsProblem, templateRefProblem, personaAuthOriginProblem, projectFileProblem and a confined parseScenario, each with no channel / MCP / the Studio; the job vocabulary's values, `JobInputSchema` as JSON Schema, five inputs parsed (issues included), jobClass — 52,694 bytes, **byte-identical** (18 Studio phrases, 36 MCP ones).
  - **Mutations: 11, 9 red, 2 not**: core-context — model's type-only exemption removed, own context counted, unassigned not reported (red); core-root — the `import('…')` type pass removed (**survived: equivalent**, the pre-processor lists those specifiers — the pass was removed); the Studio's value given `themeList` (agent-trust.test red), the hooks approval clause always MCP's (trust.test red), checks/context's words fixed (io-characterization red), the engine mapping the Studio to MCP (ui scenario-edit-ops 3 red), `writesThrough` ignored (agent-trust red), the CLI mock back on the root (operations-cli red); the preview frame's trusted list without the entries (**survived: inert** — nothing the frame bundles imports core — the change was reverted, the list is as at HEAD). Each file restored (backup, cmp, touch), `npx tsc -b --force` after.
  - **Docs**: DESIGN.md §1 (a paragraph "Contexts and their entries": the order, the entries, the root, the two checks, the job vocabulary's home, the confinement), DESIGN.md jobs paragraph and DESIGN-phase2 site job (job-input.ts), GLOSSARY (studio; caller row), target-architecture.md (principle row, the domain line), action-plan U10 state (done).
  - **Gates.** `npx tsc -b` (and `--force`) 0, `tsc -p tsconfig.test.json --noEmit` 0, `pnpm typecheck` 0, `rules.mjs --check` 0 (**80** entries), test-guard **1**: "17 item(s) to explain" — exactly the 17 titles of core/test/jobs.test.ts (14) and job-class.test.ts (3), moved whole to engine/test/job-input.test.ts and job-class.test.ts (no title, expect or id lost there); every other file "no decrease" (import-rules 90 → 95 tests, 495 → 527 expects; caller 4 → 5, 16 → 23). `--check-cites` 0 on the tree and on a scratch copy with the edits (1 with a cite altered). Fixtures: `git status` shows no fixture or golden changed. Fresh RETAKE_HOME, RETAKE_DISK_WARN=off, Node 22, from the root: **core's whole test folder** (76 files, 1,643 tests) green; alone, green: import-rules (95), test-typecheck (6), every entry walk (components geometry-entry 3, editor plan-entry 6, review checks-entry 4 and editor-entry 7, hooks describe-entry 4, runner-web types-entry 3, sandbox types-entry 3), every characterization and snapshot test outside core (cli ids 4, operations-cli 13, pipeline-cli 13, records 13; editor ids 11, records 10; engine ids 35, records 28, render-snapshot 6; mcp authoring-ops 2, comment-ops 2, environment-ops 2, job-ops 1, query-ops 1, shared-ops 1, theme-ops 1, tool-list-snapshot 1; review records 6; runner-web records 10; ui ids 10, op-table-snapshot 1, records 7), engine caller (8), job-class (3), job-input (14), capture-runner (24), admission (18), admission-processes (3), agent-safety (21), agent-sql-approvals (8), approvals (17), reset-hook-approvals (9), scenario-sessions (8), ui-client (4), worker-ports (3), pipeline (8), render-on-renderer (8), jobs (21), review-export-jobs (8), site-job (12), worker-process (11), job-queue (41), scenario-view (24), operation-catalogue (18), scenario-check (9), scenario-edit (25), scenario-value-edit (7), record-studio (22), board-theme-folder (10), hook-runner (20), operations (26), theme-edit (12), comment-proposals (12), comments-studio (8), engine-facade (2); hooks trust (21), agent-sql (14 + 2 skipped), sandbox-refs (6), step-phase (3); runner-web agent-trust (4), opens (8); mcp admission (6), site-output (2), stdio-approvals (8), captures-first (1), stdio-theme (11); ui supervise (15), run-ops (5), scenario-edit-ops (14), scenario-ops (9), scenario-run (10), studio-ops (3), run-live (9), server (19), player-bundle (6), app-source (71), feature-boundaries (4), kit-static (26); cli comment (4), run-agent-hooks (21), run-agent-sql-hooks (6); components contract (1), scaffolds (14). The app bundle (`RETAKE_TEST_BUNDLE`, gated) was not built: its staged files gain core dist/entries/* and engine dist/jobs/job-input.*, lose core dist/jobs.* and dist/schema.*; the ungated staging logic (cli app-bundle.test) is unchanged.
  - **Review fix pass (no blocker; 4 points).** (1) `coreContextHits` read relative specifiers only: a core file (outside io/) or an entry importing core's own package name — `@retake/core` or `@retake/core/<x>` — is now a hit `<spec> (an entry)` (`@retake/core/io` stays R1's); import-rules cases for the root, a sub-path from a context file, a sub-path from an entry, and io named by package / from io/ left alone; the pinned count is still 2 (no such import today). (2) Core's and the adapters' tests no longer import the engine for the Studio's words: core test/helpers.ts `STUDIO_CONFINEMENT` (a frozen literal) is used by core agent-trust, navigation-policy, scenario-edit, io-characterization, hooks trust and runner-web agent-trust (MCP's value is core's `AGENT_CONFINEMENT`); engine caller.test holds it equal to `CONFINEMENTS.studio`. Core site-url and ids-characterization keep importing the job schemas from `@retake/engine` on purpose (their cases name the job inputs' id fields: the schemas are the engine's now; splitting those characterizations would move titles). (3) Stale "core JOB_* / core's JobClient" wording fixed: engine caller.ts header, jobs/job-child.ts, pick.ts, types.ts, job-handlers.ts, worker.ts, engine worker-ports.test header, DESIGN.md (the caller paragraph, the engine client `ui` paragraph, the job classes line); R-CAP-01's requirement text in the edits (its "core JOB_CLASS"). HANDOFF's history lines left as they are. (4) **F4, noted:** core's `exports` now has both `./schema` (the JSON Schemas' entry) and `./schema/*.json` (the generated files): distinct keys, no clash in Node's resolution (an exact key and a pattern), but two meanings of one prefix; and `core-root` reads `*` in an exports key as one path segment (`[^/]+`), stricter than Node, whose `*` matches across `/` — `@retake/core/schema/a/b.json` is a hit here though Node would resolve it to schema/a/b.json (no such file exists or is imported). **Mutations 3, all red**: the package-name line removed (import-rules core-context red), io counted by package name (red), the test's Studio literal drifting from the engine's (caller.test red). Gates again: `tsc -b --force` 0, test type check 0, `pnpm typecheck` 0, rules `--check` 0 (80), test-guard 1 (the same 17 moved titles), `--check-cites` 0 on the tree and the scratch copy; alone and green: import-rules (95), test-typecheck (6), core agent-trust (11), navigation-policy (111), scenario-edit (9), io-characterization (3), hooks trust (21), runner-web agent-trust (4), engine caller (8), worker-ports (3).
  - **Requirement edits** (`.private/l7/L7.35-requirements-edits.json`): new R-ARCH-47 after R-ARCH-46 (done; gap: types.ts not split, tests on the root, the two core-context entries); evidence paths followed: R-CORE-07 (schema.ts), R-MCP-24, R-MCP-29 (core/test/jobs.test.ts), R-MCP-36, R-ARC-02 (core jobs.ts), R-CAP-01 (job-class.test.ts, core jobs.ts; its requirement text's "core JOB_CLASS").
  - **Not done.** types.ts split by context (210 names, cross-section types; all in `model` now); the tests' 328 root imports (same script, then the root could go); the two core-context entries (the default theme's component names and the page-path grammar below the scenario context). Core's site-url and ids-characterization tests import `@retake/engine` (the job schemas): a future test-support ratchet should count them. The full suite was not run.

## Mac setup
The next sessions run locally on the user's Mac with Claude Code, on the `main` branch. Steps (once; `retake doctor`
checks the result):

1. **Command line tools** — `xcode-select --install` (git, clang). The full Xcode is only needed for phase 5.
2. **Node.js ≥ 22 and pnpm** — `brew install node@22` (keg-only: `brew link --force node@22`, or put
   `$(brew --prefix node@22)/bin` on the PATH; nvm / fnm work too), then `corepack enable`: corepack provides the
   pnpm version pinned in `package.json` (`packageManager: pnpm@10.28.0`). Node 25+ no longer bundles corepack:
   `npm i -g corepack` first, or stay on 22 / 24.
3. **ffmpeg and ffprobe** — `brew install ffmpeg` (H.264, VP9 / libvpx, ProRes encoders, ffprobe). Captures encode with
   it, renders are probed with it, the review decodes with it, the raw export encodes with it. Elsewhere on disk:
   `ffmpeg:` in `retake.yaml`, `$RETAKE_FFPROBE` for ffprobe.
4. **The repository** — `git clone -b main <repository URL> retake && cd retake`, then `pnpm install` and
   `pnpm build`. The lockfile already lists the macOS binaries (`@remotion/compositor-darwin-arm64`,
   `@img/sharp-darwin-arm64`, `@esbuild/darwin-arm64`); pnpm 10 runs install scripts only for esbuild and sharp
   (`onlyBuiltDependencies` in `pnpm-workspace.yaml`, the one list).
5. **Chromium for playwright-core** — `pnpm --filter @retake/runner-web exec playwright-core install chromium`.
   This downloads the Chromium build pinned by playwright-core 1.56.1 (Chromium 141, revision 1194) **and** its
   headless shell into `~/Library/Caches/ms-playwright/`. How the browsers are found
   (`packages/runner-web/src/probe.ts`, `session.ts`; `packages/editor/src/render/browser.ts`):
   - captures (runner): `browser.executable` in project.yaml / retake.yaml, else `$RETAKE_CHROMIUM`, else
     playwright-core's own Chromium launched in new headless mode (`channel: chromium`);
   - renders (Remotion): `$RETAKE_CHROMIUM_HEADLESS_SHELL`, else playwright-core's `chromium-headless-shell`
     (looked up through its registry), else Remotion downloads its own (a warning says so);
   - `PLAYWRIGHT_BROWSERS_PATH` moves the browser cache (the cloud container used `/opt/pw-browsers`); leave it unset
     on the Mac. No other environment variable is needed.
6. **Check** — `pnpm retake doctor` (Node, Chromium launch, ffmpeg / ffprobe, display, Keychain, notifications,
   workspace, template fonts): every line `OK`. Node must be 22+ in every folder the CLI runs from: a version manager
   pins it per folder (the user's machine: Node 22 in the repository — `.nvmrc` —, 10 elsewhere; an older Node.js
   prints which version it needs). A workspace outside the repository uses the starter templates by name. ffmpeg 5.1+
   (the Mac has Homebrew's 9.0; `retake doctor` fails below 5.1).
7. **Later, not before their lot** — Docker Desktop for L1.8 (sandbox mode, docker-compose provider); the full Xcode
   (App Store) + Rust (`rustup`) for phase 5 (L5.2 Tauri shell, L5.3 iOS Simulator runner: simctl / idb).
8. **Optional** — PostgreSQL for the 6 SQL hook tests (`brew install postgresql@16`, then
   `RETAKE_TEST_PG=postgres://…`); Python 3.13 or older + OpenTimelineIO for `scripts/validate-raw.py`
   (OpenTimelineIO 0.18.1 does not load on Python 3.14: `RuntimeError: bad any cast`; Homebrew has `python@3.13`):
   `python3.13 -m venv ~/.venvs/otio && ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter`.

**macOS permissions.** Headless captures need no Screen Recording permission (frames come from Chromium's own
screencast) and the fixture and the render asset server listen on loopback only (no firewall prompt). Expect prompts
only for what the L1.5 checklist exercises: Keychain access when a hook resolves `{{keychain:service/account}}`
(through `security`), the Notification / Automation prompt the first time `osascript` posts a notification from the
terminal, and a visible window for `--headed` runs and `retake login`.

## Working with the fixture
**On a fresh clone (the Mac) none of the runs, renders, reviews or exports named in this file exist** — they are
git-ignored and stayed in the cloud container. Start the fixture, capture (`retake run`), then render / review /
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
node packages/cli/dist/bin.js render northfield-fixture own-media --music projects/northfield-fixture/.retake/test-bed.m4a --review
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
node packages/cli/dist/bin.js render northfield-fixture catalogue --music projects/northfield-fixture/.retake/test-bed.m4a
node packages/cli/dist/bin.js export northfield-fixture catalogue-v4 --formats all     # → exports/catalogue-v4/
node packages/cli/dist/bin.js plan northfield-fixture latest --scenario quote --vertical   # shows each clip's reframe
node packages/cli/dist/bin.js review northfield-fixture quote-v9-vertical
node packages/cli/dist/bin.js components preview --all --stale          # regenerate stale committed previews
node -e "import('./packages/editor/dist/index.js').then(m => m.generateTestTrack('projects/northfield-fixture/.retake/test-bed.m4a', {seconds: 16}))"
```
Render times in the cloud container (4 CPUs, no GPU, concurrency 3; L2.14: ≈ 4 m per 70 s 1080p video, own-media 46 s
≈ 2 m 50 s; a Mac should be faster): 1080p quote 56.3 s → ≈ 3 m; vertical 1080×1920 → 3 m 13 s,
square 1080×1080 → 2 m 23 s; catalogue 59 s with music → 3 m 34 s; 4K catalogue (export mp4_4k) → 8 m 04 s; WebM (VP9)
transcode of 59 s 1080p → 1 m 25 s; ≈ 8–9 output fps at 1080p; a still ≈ 1–2 s with a cached bundle.

## Decisions (do not re-litigate)
- The tool stays generic: no client/brand/person names anywhere in the repo or its history (history was squashed for
  this). Customer material lives in the user's own workspace (`RETAKE_ROOT` or a `retake.yaml`).
- Everything visual in the edit is a **component** (plugin) with a manifest; themes (templates) give tokens and pick
  components; workspace components can be created by Claude through a skill; a cloud marketplace comes in V2.
- **Frame comments** are stored as files in the workspace and exposed to Claude through MCP; anchored to the render
  frame and to the scenario (scene/step/segment/component) via the edit plan's provenance.
- **Studio app**: web UI first (`retake ui`), Tauri macOS shell later around the same UI; scenario shown as blocks /
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
  `vitest.config.ts` aliases `@retake/*` to `src/`). No new dependencies without a strong reason.
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
