# Audit — architecture and code, after the architecture series (2026-11-10)

A read-only audit of branch `claude/arch-l6` at `b09d8f0` (after L6.1 – L6.13 and T15, before the merge of the pull
request). Six reviewers read the code in parallel, one per area (domain, application, adapters, shells, cross-cutting,
and the cost of leaving the current renderer); every High and Medium finding was then checked again against the cited
file. Nothing was installed, built, tested or rendered: the numbers come from `scripts/audit/rules.mjs`, `git grep`
and line counts. `scripts/audit/snapshot.mjs` was not run (T16 of the previous plan stays open).

The reference is the same as on 2026-11-04: [../target-architecture.md](../target-architecture.md) (a pure domain, an
application layer with ports, adapters, shells).

| File | What it holds |
|---|---|
| [findings.md](findings.md) | The findings D (domain), P (application), X (adapters), S (shells), C (cross-cutting), by severity, with `file:line` evidence, and the state of the 2026-11-04 findings A1 – A11 |
| [action-plan.md](action-plan.md) | The tasks U1 – U16: size, value, risk, prerequisites, order |

**Not in the repository.** The security remarks of this run (seven, none of them rated; all local) and the analysis
of what leaving the current renderer would cost are in the person's private notes, as the
[audit's rule](../README.md) says for an unfixed weakness.

## In one page

**The series did what it set out to do.** The imports the layer rules flag went from 123 to 79 (59 baseline entries); only R6 grew, by three:

| Rule | 2026-11-04 | 2026-11-10 |
|---|---|---|
| R1 I/O in the domain package | 36 | 0 |
| R2 adapters importing application or shells | 0 | 0 |
| R3 a shell importing another shell | 12 | 2 (1 file) |
| R4 shells importing an adapter directly | 51 | 50 (15 files) |
| R5 Studio front end importing values | — | 0 |
| R6 shells touching files / processes | 24 | 27 (21 files) |
| R7, R8 planner and review renderer-free | — | 0 |
| File import cycles | 6 | 0 |

The job queue is a real port with a contract suite, the operation catalogue is one list, the admission rules and the
caller live in the engine, authored writes go through one store with a journal, the planner and the checks are
renderer-free, and error kinds are carried by their classes. A3, A4, A6 and A9 are closed.

**What is left is the second half of the same moves.** Five themes, in the order they matter:

1. **The tests are never type-checked, and most of them need a disk** (C1, P3, C3). Every package's `tsconfig.json`
   includes `src` only; 460 test files (about 129,500 lines) are compiled by the test runner without a type check, and
   the CI has none either. Of the engine's 79 test files, three run without a temp folder; the memory queue built for
   that purpose is used by two files, the file queue by 44.
2. **Three of the twelve ports exist** (P1, X1). `JobQueue`, `Approver` and `FileFacts` are interfaces; capture,
   render, review, hooks, secrets, clock and progress are not. 55 of the engine's 131 source files name an adapter
   package, the worker carries module namespaces (`typeof import(...)`), and no rule stops a new one.
3. **An operation is listed once but still defined in the shells** (P2, S1, S2, S3). The catalogue names about 100
   use cases; their schemas and handlers are 45 tool definitions in the MCP package and 65 in the Studio server, with
   authorisation and admission placed by hand in each. The Studio server still imports the MCP package (the last R3
   entry), and the CLI keeps a second orchestration of plan, hooks and sandbox next to the engine's pipeline.
4. **The domain's central objects are loose** (D1, D2, D3). The core package's root re-exports 63 modules as one flat
   namespace; a run, a timeline and a render record are status fields with optional members, so "is this capture
   usable" is decided in five places; ids are plain strings with their grammar written in five places and three
   variants.
5. **The capture runner is one 844-line function** (X2) in which the runner-agnostic lifecycle (hooks, sandbox,
   journal, record) is fused with the browser driver, behind an options bag of 28 members.

Everything else is Medium or Low: media-tool wrappers written several times, the renderer reached at four sites
without a seam, long functions (128 of 100+ lines, 57 of them in the Studio), no linter, lot ids in published schema
descriptions, a 319 KB hand-off file.

**Nothing here is urgent or blocks the merge.** No finding is a defect in behaviour; all are about the cost of the
next change. The plan starts with three small tasks (type-check the tests, close the cheap ratchet entries, add an
engine → adapter rule) that make the larger ones safe.
