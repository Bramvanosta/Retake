# Target architecture

The lens is a reference project of the same author (a desktop app, an MCP server and an HTTP server over one Rust
workspace, built on a pure domain, an application layer with ports, one operation catalogue and one write pipeline).
Retake keeps what serves it, adapts the rest to a TypeScript monorepo, and leaves out what has no counterpart here.
The steps to get there are in [action-plan.md](action-plan.md); the words for the concepts are in the
[glossary](../GLOSSARY.md), and the layer rules below are held by an import-rules ratchet
(`packages/core/test/import-rules.test.ts`, baseline `scripts/audit/baseline.json`).

## Principles: applies, adapted, or not

| Principle in the reference project | Here | One line |
|---|---|---|
| Layers as crates, enforced by the compiler plus a test | **Adapted** | Packages and `exports` sub-paths (no new packages needed at first), plus an import-rules ratchet test built from `scripts/audit/rules.mjs` |
| A pure domain with no I/O | **Adapted** | `@retake/core` does no I/O and reads no environment but three listed defaults (`defaultSecrets`, `expandHome`, `unsafeTestResolve`: DESIGN §1); the clock and ids are allowed (L6.9): its readers, the app bundle, the media tools and the home key are its `@retake/core/io` entry, disk facts and video probes go behind the `FileFacts` and `VideoProber` ports core declares (the Node implementations in `core/io`, which also gives the PATH and the file system's case rule), the agent policy is a `WorkPolicy` value the engine passes on, `app-setup.ts` left core (L6.8) |
| An application layer with ports | **Adapted** | `@retake/engine` holds the operations and the ports: JobQueue, ProjectStore, CaptureRunner, Renderer, Reviewer, SandboxProvider, HookRunner, SecretStore, Clock, ProgressSink, Approver, FileFacts (declared in core, see above) |
| One catalogue of operations, as data, held by tests against each shell | **Applies** | One `catalogue.ts` in the engine: name, kind (read / write / job / runs code), the shells that serve it (CLI, MCP, Studio) with the reason when one does not, argument narrowing, admission rules; tests compare MCP `TOOLS`, Studio ops and CLI commands with it |
| Shells translate the protocol and call the same operation | **Applies** | `invoke(op, args, caller)` behind the MCP tools, the Studio's `/v1/call` and the CLI commands; the contract (`ToolDef`, `callTool`) moves from `@retake/mcp` into the engine |
| One write pipeline: authorize → act → record | **Adapted** | No queue writes here; the pipeline covers operations (parse → authorize the caller → admit → act → record → map errors), authored file writes (through one ProjectStore with `if_match` and its lock) and hook executions |
| Backends are a port with declared capabilities and a contract suite | **Adapted** | Two adapters exist for one port today (process and compose sandbox providers), the job queue will get a second (L5.14); both get a shared contract suite. Capability flags wait for a second capture runner (iOS, L5.3) |
| One actor per connection | **Not** | No persistent remote connection to own; the nearest thing (one worker per workspace, one job at a time) exists |
| Writes are ports of the queue system's own scripts | **Not** | No external queue system to stay compatible with |
| Agents never do more than the UI | **Adapted** | Retake is agent-first: Claude drives the loop, and some tools have no Studio screen (hooks, sandboxes, project creation). The rule becomes: every operation an agent may call is in the catalogue with its reason, no agent operation can widen an agent's own rights, and an agent passes more checks than a person, never fewer |
| Fail closed | **Applies** | A missing, unreadable or wrong seal, approval or signature means the strictest reading; already the rule for approvals, extended to every record the worker acts on |
| Production locked and read-only for agents | **Applies** (holds) | Production environments are read-only through MCP and a project made through MCP may not point at them; keep it as a domain rule with its tests |
| Approval gate with modes, a heartbeat and an AI switch | **Adapted** | The MCP client asks its own user (elicitation) and the approval is signed by the engine; no heartbeat is needed. A workspace setting "agents may run hooks: never / ask" could replace the AI switch if wanted (backlog) |
| Approvals traded once against a sealed record | **Adapted** | Approvals are already HMAC-signed over the job input; the target rule is bound to one job and consumed once, for every job kind |
| Seals over shared state, made inside the stores | **Applies** | The CLI, the MCP server, the Studio's server and the worker share files any process of the user can write. Records that decide what runs are sealed by the store that writes them and verified by the store that reads them |
| Seal key in the OS keychain; a lost key resets to the strictest | **Adapted** | The key stays a 0600 file in the Retake home (a headless worker cannot answer keychain prompts); a lost key makes every sealed record unverified, so nothing approved runs until a person approves again. Documented limit: a seal protects against an agent that can write workspace files, not against one with a shell that reads the home |
| Secrets never in the database or the renderer; keychain or encrypted file | **Applies** (holds) | `{{env:}}` / `{{keychain:}}` refs resolved by the worker at use, never in payloads, results or the Studio; keep it |
| A saved password returned only on the same route; SSH host keys pinned | **Not** / adapted | No saved passwords or SSH; the counterpart is that a resolved secret only goes to hosts on the allow-list, which exists |
| Database files 0600 | **Applies** | Done for the Retake home; extend to the workspace's `.retake/` state and the index database |
| Audit log: one writer, synced before replying, no delete path | **Adapted** | `history.jsonl` becomes one append-only journal written by the pipeline only: production (runs, renders, exports), authored writes, hook executions and approvals used, the caller and the outcome |
| HTTP server authentication (Basic / OIDC, session cookies, CSRF header, rate limits) | **Not** (today) | The Studio and MCP over HTTP are loopback-only with per-launch or stable tokens, no cookies and Host / Origin checks, which fits a local tool; a hosted UI (BL-38) would need the full set |
| Data robustness: immediate transactions, nothing fallible after commit, never edit a shipped migration, backup before migrating, the agent process never migrates | **Applies** to the index database and to L5.14's queue store | Check `packages/engine/src/index-db/` against it; make it a requirement of L5.14 if the queue gets a database |
| A startup failure explained in a native dialog, a rotated log | **To check** | Not audited here (desktop app); worth a look when the app's first-run path changes |
| Front end: features expose `index.ts`, one `data/` layer calls the backend, generated bindings, the URL as the source of truth, one command registry | **Adapted** | The Studio already has one command table (menus, ⌘K, shortcuts) and hash routes; missing are a typed operation client generated from the catalogue's zod schemas (37 app files call the API today) and feature boundaries checked by a test |
| Tests: pure domain tests, in-memory ports, contract suites, live suites, tool-schema snapshot, boundary tests | **Adapted** | In-memory adapters for the new ports; contract suites for sandbox providers and the job queue; the import-rules ratchet; an MCP tool-schema snapshot if not already covered |
| CI: lints as errors, `--locked`, a pinned toolchain, images pinned by digest, release only from a green `main`, drafts until a final publish, signed updates | **Adapted** | The release side is done (pins, drafts, signed updates); missing are a CI on pull requests (BL-144) and a `rust-toolchain.toml` |

## Target layers

```text
shells        cli · mcp · ui/server · ui/app · apps/desktop          protocol only: parse, call invoke(), render the answer
                 │
application   @retake/engine  (. façade + invoke, ./contract, catalogue, pipeline, policy, ports)
                 │  ports: JobQueue ProjectStore CaptureRunner Renderer Reviewer SandboxProvider HookRunner
                 │         SecretStore Clock ProgressSink Approver FileFacts
                 ▼
adapters      runner-web · editor/render · review (media) · sandbox · hooks · components (compile)
              file queue (then L5.14's store) · index-db · integrations (Claude registrations: @retake/engine/integrations)
                 │
domain        @retake/core (pure) · @retake/components/geometry · @retake/editor/plan · @retake/review/checks
                                         no I/O, no environment read (core's three listed defaults aside),
                                         no adapter, no shell; the clock and ids allowed
```

Rules (each a line of the ratchet test): the domain imports nothing above it and no I/O module; adapters
import the domain and the engine's ports only; shells import the engine's façade and contract only, and never another
shell; the Studio app imports types only; nothing but the composition roots (CLI entry, MCP entry, Studio server
entry, worker entry) wires adapters to ports.

## Path (no big-bang)
1. **Guard rails** — the ratchet test at today's counts, a glossary, one containment function, error kinds carried by
   the error classes. Small, safe, and they stop new drift.
2. **During L5.14** — a JobQueue port with a contract suite, as the lot's first step; the Studio's server stops building
   the file queue itself.
3. **After L5.14** — the catalogue and `invoke` in the engine; the admission rules move from the Studio into the
   pipeline; one caller type.
4. **After L5.15** — the ProjectStore with every authored write through it and the journal; the CLI on the engine's
   operations; the planner / renderer split.
5. **Any time after step 1** — core's domain / I/O split, the Studio's typed data layer, the big-function splits.

Each step keeps the full suite green and lowers a ratchet count; the counts in
[2026-11-04/summary.json](2026-11-04/summary.json) are the starting point.
