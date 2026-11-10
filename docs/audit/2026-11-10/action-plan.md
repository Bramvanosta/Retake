# Action plan (2026-11-10)

Tasks from the [findings](findings.md), for the person to schedule. The ROADMAP's MVP scope is locked: nothing here
is a lot until the person adds it. Sizes follow the ROADMAP (S ≈ 0.3–0.5 M tokens, M ≈ 0.6–1.0 M, L ≈ 1.0–1.6 M).
The table is in the proposed order; "needs" lists prerequisites. Every task keeps behaviour as it is.

| # | Task | Findings | Size | Value | Risk | Needs |
|---|---|---|---|---|---|---|
| U1 | Type-check the tests: a `tsconfig.test.json` per package (or one at the root), a `typecheck` script that covers them, a CI step; fix or mark what it finds | C1 | M | very high | low (finds real errors; no runtime change) | — |
| U2 | Close the cheap ratchet entries: the context's `queue` typed as the port, the Studio server no longer imports the MCP package (R3 → 0), the small R4 / R6 removals; add a rule "the engine imports adapters as types only", at today's count | P5, S1 (first slice), S8, P1 | S | high | low | — |
| U3 | One id module in the domain: branded types and one grammar each for run, render, job, theme; the copies removed | D3 | M | high | low–medium (wide, mechanical) | U1 |
| U4 | A pure `checks` entry for the review package and a geometry sub-path for components; a ratchet rule for it | D4 | S–M | medium | low | — |
| U5 | Run, take and render record as discriminated unions with schemas; one "usable capture" rule and one "latest run" rule, used by the CLI, the editor and the engine | D2 | M–L | high | medium (reads old files: needs fixtures of every past shape) | U3 |
| U6 | The missing ports, one slice each, with a memory fake and the engine importing the adapter as a type nowhere: `Renderer` first, then `CaptureRunner`, `Reviewer`, `HookRunner`; `ProjectStore` as an interface; `Clock`. **State: the `Renderer` slice is done (L7.1) — four ports of twelve; the others are open.** What that slice is: the port in the engine (video, stills, previews), the editor's driver and an in-memory renderer on one contract suite, every render, still, export and preview of the engine handed a renderer by a composition root, two ratchet lines (R9, `render-call`). What it is not: the engine still names the editor's types in the port (plan, record fields, progress, preview spec) and still reaches the editor's use cases for planning and the record; the CLI's `components preview` renders with the editor itself (one baseline entry); the real adapter's preview side is checked by the editor's tests, not by the contract suite | P1 / X1, P4, P10 | L, in slices of S–M | very high | medium | U2 |
| U7 | `invoke()` in the engine: an operation's schema, authorisation, admission and handler defined once, family by family; the shells keep only presentation; one name per use case | P2 / S1, S2, S7 | L, in slices | high | medium | U2 |
| U8 | The CLI's plan, hooks, sandbox, components and raw export call engine operations | S3 | M | high | medium (CLI output must not move: the snapshot covers render, not these) | U7 for the families concerned |
| U9 | Tests without a disk: engine tests on the memory ports; shared fixtures in one test-support package; the source-text guards that pin exact statements replaced by behaviour tests or ratchet rules; `files` made a required argument | P3 / C3, C4, C5, D8 | L, in slices | high (the suite's 20 minutes) | low | U1, U6 |
| U10 | The domain package split into sub-path entries per context, with a ratchet between them; the job vocabulary moved to the application; channel names replaced by a neutral confinement value | D1, D7, D6 | L | medium–high | medium (wide churn) | U3, U5 |
| U11 | The capture runner split into a runner-agnostic lifecycle and the browser driver; one wrapper for the media tools with one error type and one probe parser | X2, X3 | M–L | medium–high | medium (needs real captures to check) | U6 (`CaptureRunner`) |
| U12 | The renderer seam closed: versioned, typed props; composition ids declared once; built-in components import the kit only; one module reaches the renderer library | X4, X5, X6 | M | medium (high if the renderer ever changes) | low–medium (previews to regenerate and compare) | U6 (`Renderer`) |
| U13 | Tooling and documents: a linter and a formatter introduced with a baseline; lot ids removed from published schema descriptions; the hand-off file cut to its current state with the history moved to an archive | C2, C6, C7 | M (S + S + S–M) | medium | low (the formatter's diff is large: one commit of its own) | U1 |
| U14 | Sandbox and hooks seams: a contract suite for the two providers with the optional methods made explicit capabilities; the OS utilities moved out of the sandbox package; the hooks mirror replaced by a shared type entry; one browser-discovery module | X8, X7, X9 | M | medium | low | — |
| U15 | One event log: journal and history with the same guarantee; admission checked under the queue's lock so it holds across processes | P8, P9 | M | medium | medium | U6 |
| U16 | Function splits, one at a time: the job runner's switch into per-kind handlers, the worker record without test hooks, `draftFromRecording`, `doctor`, the record screen, `buildProgram`; the Studio front end grouped by feature | P6, P7, D9 / C8, D10, S4, S5, S6, S12 | S each | medium | low–medium | U6 for the engine ones |

## Order and grouping

- **First, small and safe (U1, U2, U4):** about one lot. They add the guard rails the rest relies on, as L6.1 did for
  the first series.
- **Then the domain's objects (U3, U5):** ids before states, because the unions carry the ids.
- **Then the application's seams (U6, U7, U8)** in slices; `Renderer` first, since U12 and any later change of
  renderer start from it.
- **U9 follows U6** slice by slice: each new port brings its fake, and the tests of that area move to it.
- **U10 – U16** in any order once their prerequisite is in; none blocks another.

T16 of the [previous plan](../action-plan.md) (the measured snapshot and its comparison) is still open: this run
measured with the rules script and greps only. The security remarks of this run are tracked in the person's private
notes, not here.
