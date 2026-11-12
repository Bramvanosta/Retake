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
