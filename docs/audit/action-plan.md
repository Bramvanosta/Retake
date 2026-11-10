# Action plan (after L5.14 and L5.15)

Tasks from the 2026-11-04 audit, for the person to schedule. The ROADMAP's MVP scope is locked: nothing here is a lot
until the person adds it. Sizes follow the ROADMAP (S ≈ 0.3–0.5 M tokens, M ≈ 0.6–1.0 M, L ≈ 1.0–1.6 M). Order is by
value and risk; "needs" lists prerequisites.

**Status (2026-11-10):** T-SEC done (L5.17, L5.18); T1 – T14 done in the architecture series L6.1 – L6.13 (branch `claude/arch-l6`, HANDOFF "State (after the architecture series)"); open: T15's rest (a CI on pull requests, `rust-toolchain.toml`, one `onlyBuiltDependencies` list, `.gitignore` patterns for signing material) and T16.

## Tasks

| # | Task | Size | Value | Risk | Needs | When |
|---|---|---|---|---|---|---|
| T-SEC | The security fixes of the private report (ids SEC-01 – SEC-24), most serious first | M | very high | low–medium | — | **before the v0.2.0 tag**; parts fit inside L5.14 (the worker and the queue) and L5.15 (the render browser's options) |
| T1 | An import-rules ratchet test at today's counts (R1 36, R3 12, R4 51, R6 24, 6 file cycles), from `scripts/audit/rules.mjs` | S | high | low | — | first |
| T2 | `docs/GLOSSARY.md`: one name per concept across CLI, MCP, Studio and code; the homonyms resolved; `--template` on `new` gets `--theme` (old flag kept as an alias) | S | medium | low | — | with T1 |
| T3 | One path-containment function (real path, whether the folder itself counts, case folding as options) with a property test, replacing the 16+ copies; one canonical JSON | S | high | low–medium | T1 | with T1 |
| T4 | Error classes carry their kind (no mapping by class name or message); the CLI's known list derived from them; a documentation link on `EngineError` | S | medium | low | — | with T1 |
| T5 | A JobQueue port with a contract suite shared by the file queue and any new store; the Studio's server stops building the queue itself | M | very high | low if first | — | **as L5.14's first step**, or right after it |
| T6 | One operation catalogue in the engine (kind, shells, reasons, narrowing, admission rules) with tests tying MCP tools, Studio ops and CLI commands to it; the tool contract moves out of `@retake/mcp` | M | high | low–medium | T1 | after L5.14 |
| T7 | The admission rules (one run or render per scenario at a time, export caps, the sessions acknowledgement) move from the Studio's server into the engine, for every caller | M | high | medium (MCP behaviour changes) | T6, L5.14 | after L5.14 |
| T8 | One caller type; the six caller vocabularies derived from it in one policy module | M | medium–high | medium | T6 | after L5.14 |
| T9 | One ProjectStore (the folder layout in one module); every authored write through it with `if_match` and its lock; one append-only journal of writes, runs and hook executions | M | high | medium | T6 | after L5.15 |
| T10 | The CLI calls the engine's operations for render, review and export; the journal is written by the pipeline only | M | high | medium | T6, T9 | after L5.14 and L5.15 |
| T11 | `@retake/core` split into a pure domain and `core/io`; disk probes behind a `FileFacts` port; the installer leaves core; core's import cycle broken | M | high | medium (wide churn) | T1, T3 | any time after T1 |
| T12 | The editor split into planner and renderer entry points; review imports the planner only; `planEdit` decomposed | M | medium–high | medium | T1 | after L5.15 |
| T13 | A typed operation client for the Studio generated from the catalogue; only a `data/` layer calls it; feature boundaries checked by a test | M–L, in slices | medium | low | T6 | any time after T6 |
| T14 | Big-function splits: `createEngine`, `engine/src/comments.ts`, `runWorker`; the in-page kit built from modules | S each | medium | low–medium | T5, T9 | `runWorker` after L5.14 |
| T15 | Hygiene: `SECURITY.md`, GitHub's private vulnerability reporting, secret scanning and push protection; a CI on pull requests (BL-144); `rust-toolchain.toml`; one `onlyBuiltDependencies` list; `packageManager` with its hash; `.gitignore` patterns for signing material | S | medium | low | — | any time; the GitHub settings before v0.2.0 |
| T16 | The next audit: `scripts/audit/snapshot.mjs`, then `compare.mjs` against `docs/audit/2026-11-04/summary.json`; the network checks of METHOD.md if the person agrees | S | medium | low | — | after T6–T10, or before a sale |

## Proposed lots and backlog items
Propose, then let the person decide:

- **A security lot before the first release** (T-SEC, plus T15's GitHub settings): size M. Parts may move into L5.14
  and L5.15 if those lots are still open; the private report says which.
- **L6.1 — Guard rails** (T1, T2, T3, T4): size S–M. Cheap, and it stops new drift before the bigger moves.
- **L6.2 — Operations in the engine** (T6, T7, T8): size M–L, after L5.14.
- **L6.3 — One project store and its journal** (T9, T10): size M–L, after L5.15.
- **Backlog** (next free id BL-146): T11 (core's domain split), T12 (planner / renderer), T13 (the Studio's data
  layer), T14 (big-function splits), T16 (the next audit). T5 belongs inside L5.14 rather than the backlog.

## What should not wait
T-SEC before the v0.2.0 tag: an app that updates itself spreads what it ships. T5 is cheapest as L5.14's first step,
since L5.14 rewrites `packages/engine/src/jobs/` anyway.
