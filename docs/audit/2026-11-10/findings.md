# Findings (2026-11-10)

Branch `claude/arch-l6` at `b09d8f0`. Prefixes: **D** domain (`packages/core`, the planner, the checks), **P**
application (`packages/engine`), **X** adapters (runner-web, editor's renderer, review, hooks, sandbox, components),
**S** shells (cli, mcp, ui, desktop), **C** cross-cutting (tests, tooling, docs). Size: S / M / L as in the ROADMAP.

Every High and Medium finding was re-checked against the cited file after the reviewers reported. None was dropped;
six numbers were corrected (noted "corrected" below). Counts marked "as reported" were not counted a second time.
Findings that two reviewers reached from two sides are merged and keep both ids.

## High

| Id | Finding | Evidence | Size |
|---|---|---|---|
| C1 | **Tests are never type-checked.** Each package compiles `src` only; the root `typecheck` script is the build; the CI runs no type check on tests. 460 test files, about 129,500 lines; 221 type escapes as reported. | `packages/*/tsconfig.json` (`"include": ["src"]`, 10 of 11), `package.json:16-18`, `.github/workflows/ci.yml` | M |
| P1 / X1 | **Three of twelve ports exist.** `JobQueue`, `Approver`, `FileFacts` are interfaces; there is no `CaptureRunner`, `Renderer`, `Reviewer`, `HookRunner`, `SecretStore`, `Clock` or `ProgressSink`. 55 of the engine's 131 source files name an adapter package (corrected: one reviewer counted 43); the worker holds module namespaces; the pipeline re-exports adapter option types. No ratchet rule covers engine → adapter. No fake exists for capture, render or review. | `engine/src/jobs/job-queue.ts:139`, `engine/src/approvals.ts:156`, `core/src/file-facts.ts:17`; `engine/src/jobs/worker-record.ts:107-108,152-153`, `engine/src/jobs/run-job-record.ts:50`, `engine/src/record.ts:567`, `engine/src/pipeline.ts:80-87` | L, in slices |
| P2 / S1 | **No single `invoke`: operations are defined in the shells.** The catalogue lists them; their input schemas and handlers are 45 `defineTool` in the MCP package (corrected: one reviewer counted 46) and 65 in the Studio server. `callTool` is reached from two places; authorise and admit are placed by hand in the façade builders. The Studio server imports the MCP package: the last R3 entry. | `mcp/src/tools/`, `ui/src/server/`, `mcp/src/tool-set.ts:84`, `ui/src/server/studio.ts:52-53,437` | L; first slice S |
| P3 / C3 | **The application is tested through the disk.** 79 engine test files, three of them without a temp folder; `MemoryJobQueue` is used by two test files, `new FileJobQueue` by 44; 203 test files call `mkdtemp(`; 38 engine test files start child processes as reported. | `engine/test/job-queue.test.ts`, `engine/test/site-job.test.ts` | L, in slices |
| D2 | **Run, timeline and render record are status fields with optional members.** A dry timeline still requires `capture`; a render record has no schema and is accepted on three fields; there is no `Take`. "Usable capture" is decided in five places and "latest run" in two, with the same helper written twice. | `core/src/types.ts:2080,2263`, `editor/src/render-record.ts:40,102-105`, `editor/src/render/runs.ts:21,65`, `cli/src/commands/plan.ts:37,61`, `engine/src/scenario-view.ts:410`, `engine/src/prune.ts:165` | M–L |
| D3 | **Ids are plain strings with several grammars.** The run id is written in five places with three grammars (any folder name, a dated id, a dated prefix); the render id is built in four places and parsed again in six as reported; the theme name has two aliases; the job id regex is repeated outside its module. | `core/src/jobs.ts:70-96`, `engine/src/refs.ts:9`, `engine/src/prune.ts:87`, `editor/src/render/runs.ts:30,117`, `core/src/brand.ts:15`, `engine/src/jobs/signing.ts` | M |
| D1 | **The domain package's root is one flat namespace.** `index.ts` is 63 `export *` (57 on 2026-11-04), about 1,080 names as reported; `types.ts` is 2,558 lines; the package exposes `.`, `./io` and the schemas only, so nine contexts (scenario, timeline, jobs, comments, brand, recording, inspect, site, policy) cannot be imported or ratcheted apart. | `core/src/index.ts`, `core/src/types.ts`, `core/package.json` | L |
| X2 | **The capture runner is one function.** `runScenario` is 844 lines; `RunOptions` has 28 members as reported. The lifecycle any runner needs (hooks, sandbox, write guard, journal, run record) is fused with the browser driver, so a second runner would copy it. | `runner-web/src/run.ts:77,341-1184` | L |
| S3 | **A second orchestration lives in the CLI.** `plan` loads the run, the theme and the registry and calls the planner itself, next to the engine's `planWork`; the hooks and sandbox commands drive their adapters directly; so do components, the raw export, auth and interrupt. 24 of the 50 R4 entries as reported. | `cli/src/commands/plan.ts:94-125`, `engine/src/pipeline.ts`, `cli/src/commands/hooks.ts:58,142,188,231,265`, `cli/src/commands/sandbox.ts:38` | M |

## Medium

| Id | Finding | Evidence | Size |
|---|---|---|---|
| D4 | The pure checks have no entry of their own: the review package exports `.` and `./thumbs`; `checks.ts` value-imports the components package's root; `pixel-checks.ts` imports the module that starts the media tools. | `review/package.json`, `review/src/checks.ts:8`, `review/src/pixel-checks.ts:12`, `review/src/pixels.ts:6` | S–M |
| D5 | The `Step` type allows zero or several actions (a mapped type of optionals under a comment that says "exactly one"); types and schemas are kept as twins by hand. | `core/src/types.ts:655-656` | M |
| D6 | Channel names sit in the domain: the agent policy and the validation context know `'mcp' \| 'studio'` and word their messages by channel. | `core/src/agent-policy.ts:57`, `core/src/checks/context.ts:18,70` | M |
| D7 | `core/src/jobs.ts` (548 lines) is application vocabulary (job inputs, their limits) inside the domain, and the id grammars other contexts need are imported from it. | `core/src/jobs.ts:7-12`, `core/src/comments.ts:22`, `core/src/brand.ts:12` | M |
| D8 | The `FileFacts` port is optional (`files?:`, 11 signatures; corrected from 10), so the default is the disk; 39 of core's 64 test files import `node:fs` (corrected from 38); the memory implementation is used by one test file. | `core/src/` (grep `files?:`), `core/test/` | M |
| D9 / C8 | Long pure functions: `draftFromRecording` 905 lines, `planSegments` and `planRunTiming` about 250 each as reported, `checks.ts` 1,140 lines. Repository-wide, 12 files over 1,000 lines (13 before) and 128 functions of 100+ lines, 57 in the Studio, as reported. | `core/src/recording.ts:572-1476`, `editor/src/planner/segments.ts:34`, `editor/src/timing.ts:210`, `review/src/checks.ts` | M |
| D10 | `PlanScope` is an intersection of six bags (about 45 fields as reported) handed to every planner stage; pure planning code also lives under the renderer's folder. | `editor/src/planner/scope.ts:96`, `editor/src/remotion/frames.ts` | M |
| P4 | `ProjectStore` is a concrete class built at 8 sites (corrected from "10+"), beside 7 `new LocalStorage(`; no interface, no memory store. | `engine/src/store/project-store.ts:61` | M |
| P5 | `createEngine` builds the file queue itself and the context types its `queue` as the concrete class, not the port. | `engine/src/engine.ts:16,63`, `engine/src/facade/context.ts:14,50,76` | S |
| P6 | The worker record carries test hooks (`recordTest`, `previewTest`, `jobProcessTest`, `inlineHeavy`) beside production state. | `engine/src/jobs/worker-record.ts:42-110` | M |
| P7 | `createJobRunner` / `runJob` is one closure with a switch over every job kind (13 `case` lines). | `engine/src/jobs/run-job-record.ts:128,174` | M |
| P8 | Two logs with two guarantees: the journal is synced before the reply, the history is appended best effort (errors swallowed); neither is a domain event. | `engine/src/history.ts:68-69`, `engine/src/in-process.ts` | M |
| P9 | Admission rules hold within one process only; two servers each check, then submit. The module's own comment says so. | `engine/src/admission.ts:10,23-24` | S–M |
| X3 | The media tools are started from 18 sites, with several error classes and parsers of the probe's output as reported. | `runner-web/src/`, `editor/src/render/`, `review/src/`, `core/src/io/` | M |
| X4 | The renderer library is reached at four sites plus one internal call; composition ids are declared twice. | `editor/src/render/render.ts:56,154`, `editor/src/render/preview.ts:335`, `editor/src/render/policy.ts:209,449`, `editor/src/remotion/Root.tsx:17` | M |
| X5 | The edit plan is handed to the compositions as untyped, unversioned props. | `editor/src/render/render.ts:375,833` | S |
| X6 | 33 of the 41 built-in components import the renderer library directly; the kit's seam re-exports six primitives and says the rest "stays importable". | `components/library/studio/`, `components/src/kit/renderer.ts` | M |
| X7 | The runner keeps a hand-written mirror of the hooks package's types and loads it by a computed specifier; the engine takes OS utilities (locks, process table, signals) from the sandbox package. | `runner-web/src/hooks-bridge.ts:93-97`, `engine/src/jobs/lock.ts:133`, `engine/src/jobs/proc.ts:20-36`, `engine/src/jobs/signal.ts:9,79` | M |
| X8 | The sandbox `Provider` has six optional methods and no contract suite shared by the process and compose providers. | `sandbox/src/provider.ts:138-166`, `sandbox/test/` | M |
| X9 | Browser discovery reads the browser library's private registry from two packages (corrected from three). | `runner-web/src/launch.ts:53`, `editor/src/render/browser.ts:37` | S |
| S2 | One use case under two or three names by shell (`run_capture` / `scenario_run`, `comment_reply` / `thread_reply`, `template_list` / `theme_list`). | `engine/src/catalogue.ts:161,170,172,215,237,245` | M |
| S4 | `doctor` is one 1,168-line command file. | `cli/src/commands/doctor.ts` | M |
| S5 | The Studio front end is 82 flat files at its root; the record screen is 1,766 lines. | `ui/src/app/`, `ui/src/app/RecordScreen.tsx` | M |
| S6 | 21 functions of 150+ lines in the shells (31 before) as reported; the Studio's data hook refetches on mount, key change and window focus with no cache or de-duplication. | `ui/src/app/api.ts:175-200` | M |
| S7 | The Studio server's `ops.ts` (873 lines) mixes schemas, rules and views. | `ui/src/server/ops.ts` | M |
| C2 | No linter and no formatter: no configuration file, no script, no CI step. | repository root, `package.json` | M |
| C4 | About 9,900 lines of tests assert on source text as reported, some on exact statements; the largest is 2,708 lines. They hold real rules, but break on a rename. | `ui/test/app-source.test.ts`, `engine/test/project-store.test.ts:182-190` | M |
| C5 | Test fixtures are copied: the home-folder save / restore in 102 files (corrected from 95+); 76 test files reach into another package's helpers by relative path. | `packages/*/test/` | M |
| C6 | Lot ids in comments (2,655 lines as reported) and, more visibly, in schema descriptions that are published as JSON schemas (five in the timeline schema alone). | `core/src/schemas/timeline.ts:116,169,272,304,320`, `core/schema/timeline.schema.json` | S for the schemas |
| C7 | The hand-off file is 2,986 lines / 319 KB and the design file 705 KB: past what a reader or an agent can load. | `docs/HANDOFF.md`, `docs/DESIGN.md` | S–M |

## Low

D11 – D13, P10 – P13, X10 – X13, S8 – S14, C9 – C14 are kept in the private working notes in full. The ones worth a
line: no `Clock` (dates taken in place, P10); the engine's barrel exports about 900 names, most unused through it
(P11); cheap ratchet removals bring R6 from 27 to about 21 and R4 from 50 to about 43 (S8); `buildProgram` is one
540-line function (S12); helpers copied between shells (S9).

## State of the 2026-11-04 findings

| Id | 2026-11-04 | Now |
|---|---|---|
| A1 The domain package is not I/O-free | 36 imports, a cycle | **Resolved** for I/O (R1 0) and the cycle; the flat root remains (D1) |
| A2 No application layer with ports | none | **Partly**: three ports of twelve (P1 / X1) |
| A3 Operations are listed three times | three lists | **Resolved** as a list; the definitions stay in the shells (P2 / S1) |
| A4 Domain rules in a shell | admission in the Studio server | **Resolved**; a few rules remain in `ops.ts` (S7) |
| A5 The CLI bypasses the application | render, review, export | **Partly**: those go through the pipeline; plan, hooks, sandbox do not (S3) |
| A6 Containment and layout many times | 16+ copies | **Resolved** |
| A7 Write path half unified, not audited | — | **Largely resolved**: one store, one journal; two logs remain (P8) |
| A8 The language is not ubiquitous | homonyms | **Partly**: the glossary exists; shell-specific operation names remain (S2) |
| A9 Error kinds by name matching | — | **Resolved** |
| A10 Size and cohesion | 13 files > 1,000 lines, 57 functions ≥ 150 | **Partly**: 12 files; the largest functions were split, others remain (D9 / C8, X2) |
| A11 Tests | 368 files, 49 without I/O | **Open**: 460 files, 67 without I/O as reported; the queue has a contract suite, the sandbox providers do not (P3 / C3, X8); the layer rules are now tested |
