# Architecture and code — findings (2026-11-04, `1c8fc23`)

Numbers come from `scripts/audit/` ([METHOD.md](METHOD.md)); paths are relative to the repository root.

## What is already right (keep it)
- **An acyclic package graph**, enforced by pnpm and `tsc -b`: declared dependencies match the tsconfig references
  in all 11 packages.
- **One call path for MCP and the Studio**: `callTool` (`packages/mcp/src/index.ts`) parses, calls the handler and maps
  errors for both (`packages/ui/src/server/studio.ts:420`); MCP tools are thin.
- **Trust decisions live in the engine** (every `client ===` branch), and `executeRun` is shared by the CLI and the
  worker (`packages/engine/src/execute-run.ts:197`, `jobs/run-job.ts:421`).
- **One error shape** (`EngineError {code, message, fix, details}`, `packages/engine/src/errors.ts:6-44`) crosses MCP,
  HTTP and the Studio app.
- **Pure islands**: the planner (`packages/editor/src/plan.ts` and 21 sibling files) and the review checks; the
  desktop app's rules crate (`apps/desktop/core`) has no dependency.
- **Very low copy-paste**: 30 blocks, 287 lines (about 0.2 %), 34 of them across packages.
- **A strong guard-test culture** (old names, fixture names, the kit ratchet, source rules of the Studio app).

## Findings

### A1 — The domain package is not I/O-free
`@retake/core` holds the scenario language and rules, but 26 of its 92 files do I/O (36 imports): loaders and
writers (`project`, `scenario`, `template`, `workspace`, `sandbox`), rules that probe the disk inline
(`checks/scenario`, `checks/sandbox`, `checks/context`, `checks/media`, `destructive.ts`, `filmed.ts`,
`agent-trust.ts`), process calls (`templating.ts`, `media.ts`, `h264.ts`) and an installer (`app-setup.ts`, 682
lines). `index.ts` re-exports 57 modules. Ten core modules form one import cycle (brand, comments, field-edits, jobs,
map-edits, record-annotations, recording, scenario-edit, step-edits, step-forms).

### A2 — No application layer with ports
The engine imports every adapter directly (runner-web, editor, review, sandbox, hooks, components). Its only ports are
progress callbacks (`RunPorts`, `RecordPorts`, `Approver`…), so none of its 56 test files runs without I/O. The job
queue has no interface; the Studio's server builds `FileJobQueue` itself (`packages/ui/src/server/live.ts:91`,
`run-live.ts:698`, `supervise.ts:252`) and uses about 50 engine internals beyond the `Engine` façade.

### A3 — Operations are listed three times
MCP `TOOLS` (45 tools), the Studio's `UI_OPS` / `NARROWED` / `OP_STATUS` (`studio.ts:103-126`, about 75 own ops) and
the CLI's commander tree. The reasons for each exposure are a prose comment (`studio.ts:67-102`); no test ties the
lists together. The operation contract (`ToolDef`, `TOOLS`, `callTool`) lives in the MCP shell, so the Studio depends
on `@retake/mcp` (12 imports).

### A4 — Domain rules in a shell
Admission rules exist only in the Studio's server (`packages/ui/src/server/ops.ts`): one run per scenario at a time
(`:416-421`, list-then-submit), one render per scenario (`:878`), export caps (`:970-971`), the sessions
acknowledgement (`:423`). The same requests through MCP skip them. (The one-recording rule is correctly in the engine,
`engine.ts:1031`.)

### A5 — The CLI bypasses the application
32 direct adapter imports in `packages/cli`; render, review and export are orchestrated in the CLI (`render.ts`,
`review.ts`, `export.ts`) and again in `packages/engine/src/jobs/*-job.ts`; the CLI appends the history itself. CLI
captures and renders never pass through the queue — relevant to L5.14.

### A6 — Containment and layout implemented many times
Path containment, a security rule, has 16+ implementations with four semantics (lexical vs real path, the folder
itself inside or not, case folding): `core/src/agent-trust.ts:77`, `core/src/client-path.ts:34`, `core/src/bundle.ts`,
and `isInside` copies in engine (`comments.ts`, `storage.ts`, `project-lock.ts`, `scenarios.ts`, `record-studio.ts`),
components, ui, mcp and editor. The project folder layout (`runs`, `renders`, `review`, `exports`, `comments`,
`.retake`, `scenarios`) is joined by hand about 110 times across 8 packages. Canonical JSON exists three times.

### A7 — The write path is half unified, and writes are not audited
`LocalStorage.writeText` (`packages/engine/src/storage.ts:38-62`: `if_match` and a lock) serves scenarios, the README,
comments and theme edits; project creation, `saveScenario` in core, theme create / copy, the component scaffold,
`init` and persona sessions write around it. `history.jsonl` records production (runs, renders), not authored writes
or hook executions.

### A8 — The language is not ubiquitous
| Concept | Names in use |
|---|---|
| Dry run | dry, `run_dry`, `--dry`, "Rehearse" in the Studio |
| Capture | run, capture, take, "Shoot" |
| Scenario | scenario, "Production" in the Studio |
| Theme | template (files, MCP `template_*`, `--template` on `new`), theme (`--theme`, Studio) |
| Environment | env, "Location" |
| Persona | persona, "Cast"; three models (`core/src/types.ts:1237`, `auth.ts:89`, `engine/src/auth.ts:21`) |
| Comment | comment (MCP, CLI), thread (Studio, core) |
Homonyms: *session* (browser state, Studio session, MCP HTTP session, recording session, render session), *check* (six
meanings; `CheckContext` defined twice), *export* (video and raw capture), *studio* (the app, a component namespace,
a comment channel, a module). Six vocabularies name the caller (`EngineClient`, `JobClient`, `AgentChannel`,
`HookTrust`, `PlanTrust`, a boolean `agent`). 68 exported names are declared in more than one package. There is no
glossary.

### A9 — Error kinds by name matching
`toEngineError` maps about 50 error classes by class name and message pattern (`errors.ts:47-100`); 24 fall through
to `internal`. The CLI keeps its own list of 27 known names (`packages/cli/src/errors.ts:34`); classes missing from it
print a stack. `EngineError` has no documentation link.

### A10 — Size and cohesion
13 files over 1,000 lines; 57 functions of 150+ lines (31 in the Studio app). The largest: `demoKit` (3,496 lines,
serialised into the page with `toString`; an esbuild bundle could build it from modules), `planEdit` (1,700, pure),
`createEngine` (564, a closure holding the whole API), `runWorker` (505). `engine/src/comments.ts` mixes storage,
views, locks and proposals; the Studio's `ops.ts` mixes contracts, rules and views. `review` depends on `editor` for
the edit-plan model and geometry, which live in the Remotion package.

### A11 — Tests
368 files, about 3,600 cases; test lines sit in the shells (cli 1.98× source, mcp 1.83×) more than in the domain
(core 0.52×, review 0.48×). 95 files are gated, 49 do no I/O. No contract suite is shared by the two sandbox
providers or by a queue; no test checks the layer rules.

## Where L5.14 and L5.15 touch this
- **L5.14** changes `packages/engine/src/jobs/` (queue order, captures first). A queue interface with a shared
  contract suite (A2) is cheapest as its first step; the CLI's in-process runs (A5) decide whether captures from a
  terminal take part in "captures first".
- **L5.15** changes the render options (`packages/editor/src/render/`). The planner / renderer split (A10) should wait
  for it.
