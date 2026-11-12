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
| Layers as crates, enforced by the compiler plus a test | **Adapted** | Packages and `exports` sub-paths (no new packages needed at first), plus an import-rules ratchet test built from `scripts/audit/rules.mjs`; inside the domain, since L7.35, fifteen contexts each an entry `@retake/core/<context>`, ordered so that a context imports only those before it (`core-context`, the map `CORE_CONTEXTS`), and the packages' sources on the entries, never the root (`core-root`) |
| A pure domain with no I/O | **Adapted** | `@retake/core` does no I/O and reads no environment but three listed defaults (`defaultSecrets`, `expandHome`, `unsafeTestResolve`: DESIGN §1); the clock and ids are allowed (L6.9): its readers, the app bundle, the media tools and the home key are its `@retake/core/io` entry, disk facts and video probes go behind the `FileFacts` and `VideoProber` ports core declares (the Node implementations in `core/io`, which also gives the PATH and the file system's case rule), the agent policy is a `WorkPolicy` value the engine passes on, `app-setup.ts` left core (L6.8) |
| An application layer with ports | **Adapted** | `@retake/engine` holds the operations and the ports: JobQueue, ProjectStore, CaptureRunner, Renderer, Reviewer, SandboxProvider, HookRunner, SecretStore, Clock, ProgressSink, Approver, FileFacts (declared in core, see above). Four are interfaces today: JobQueue, Approver, FileFacts and — since L7.1 — Renderer (video, stills, previews; an in-memory adapter and a contract suite; the CLI's `components preview` and the port's borrowed editor types are left); and since L7.10 Clock (the engine's stamps; a manual clock for tests) and ProjectStore (`ProjectStores`, carried with the clock in each `StoreScope`), both chosen at the composition roots through one ports bag (`EnginePorts`, `enginePorts`: `createEngine`'s `ports`, the worker's, the job process, the CLI's `cliPorts`) and held there by the ratchet's `clock-read` and `store-new` checks; and since L7.11 HookRunner and Reviewer (the hooks and review packages behind them, each loaded in its port's folder only: the `loader-use` check; the port files name no adapter but through a domain entry: `port-types`); and since L7.12 CaptureRunner (`EnginePorts.capture`: the runner package behind it, loaded in capture/ only; its vocabulary through the runner's type-only entry `@retake/runner-web/types`; the jobs worker, the job process and the CLI load it before they listen to signals, whose cancel and session-copy removal are its two synchronous members); and since L7.25 SandboxProvider, named `Sandboxes` (core's `SandboxProvider` is a provider's kind: `EnginePorts.sandboxes`, the sandbox package behind it, loaded in sandboxes/ only, its vocabulary the type-only entry `@retake/sandbox/types`; the OS utilities the engine took from the sandbox package — process table, lock file, listeners — are core/io's) |
| One catalogue of operations, as data, held by tests against each shell | **Applies** | One `catalogue.ts` in the engine: name, kind (read / write / job / runs code), the shells that serve it (CLI, MCP, Studio) with the reason when one does not, argument narrowing, admission rules; tests compare MCP `TOOLS`, Studio ops and CLI commands with it. One use case under each shell's own name is linked by a shared `useCase` key, one name per shell, never renamed (published names: 18 groups, L7.20); the Studio's three narrowings of an MCP tool say why they stay apart (`narrows`) |
| Shells translate the protocol and call the same operation | **Applies** | `invoke(op, args, caller)` behind the MCP tools, the Studio's `/v1/call` and the CLI commands; the contract (`ToolDef`, `callTool`) moves from `@retake/mcp` into the engine |
| One write pipeline: authorize → act → record | **Adapted** | No queue writes here; the pipeline covers operations (parse → authorize the caller → admit → act → record → map errors), authored file writes (through one ProjectStore with `if_match` and its lock) and hook executions |
| Backends are a port with declared capabilities and a contract suite | **Adapted** | Two adapters exist for one port today (process and compose sandbox providers), the job queue will get a second (L5.14); both get a shared contract suite. Done for the sandbox providers in L7.25: `ProviderCapabilities` (every method on every provider, the flags saying which do the work) and one contract suite of the engine's Sandboxes port on both providers and its in-memory fake. Capability flags for capture runners wait for a second one (iOS, L5.3) |
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
domain        @retake/core (pure; an entry per context) · @retake/components/geometry · @retake/editor/plan · @retake/review/checks
                                         no I/O, no environment read (core's three listed defaults aside),
                                         no adapter, no shell; the clock and ids allowed
```

Rules (each a line of the ratchet test): the domain imports nothing above it and no I/O module; adapters
import the domain and the engine's ports only; shells import the engine's façade and contract only, and never another
shell; the Studio app imports types only; nothing but the composition roots (CLI entry, MCP entry, Studio server
entry, worker entry) wires adapters to ports. A shell may be typed against a *domain entry* of an adapter package
(`@retake/components/geometry`, `@retake/editor/plan`, `@retake/review/checks`, `@retake/hooks/describe`, and the type-only `@retake/runner-web/types` and `@retake/sandbox/types`: pure, no adapter code) — its types
only: a value of one is a hit like any adapter import, since a shell that plans or checks by itself is a second
orchestration — and never imports the package behind it (R4). The engine imports the adapter packages as types only
outside its loader (R11: a value import, a re-export or `import()` of runner-web, review, sandbox, hooks or components
is a hit, pinned at the 1 file → specifier pair of 2026-11-12 (L7.11: hooks and review/thumbs through their ports; L7.12: the runner package through the capture runner's; L7.25: the sandbox package through the Sandboxes port; components 1 left)
until each has its port; the values of the domain entries are free there, all but the editor's, which R9 holds whole;
a value reached through another engine file is not
seen, and the loader itself holds no static import). A relative import never leaves its package (R13, no entry): another
package is reached by its name, which is what these rules read. The rules read every import and export declaration of a
file, a namespace re-export (`export * as ns from`) included, and `.cts` sources. The review's pure modules — what `@retake/review/checks` reaches — import the components
through their geometry entry only, types included (R12, no entry; R7 keeps the same files free of I/O and renderer
imports; both read one file at a time, the entry's walk test is the transitive proof). For the renderer the ratchet holds two lines of it: the engine loads the
editor's code in its loader only (R9: a value import, a re-export, `import()` or a made `require` anywhere else is a
hit, the port's types are free), and the editor's render entries are named in the engine's `render/` folder only, never
elsewhere in the engine nor in a shell (`render-call`, read from the syntax tree; no entry left in the baseline since
L7.2). What the check cannot read is a key only known at run time (`ed[name]`). Under the adapter, the rendering
library itself is named in five seam files only, each with the packages it may name (R10, no entry; the built-in
components and the scaffolds are read too; a seam file that hands the library on is imported from its own folder
only): it cannot see a specifier computed at run time nor the library's name in a data string, and it reads no test,
script, fixture or app. This fixes where the library is *named*, not an interface over it: the node side's seam is
one loader, the library's API is still called in the editor's `render/{render,preview,policy,bundle}.ts`, and the
Studio player's frame also reads a global the library sets.

The ids of the domain — run, render, the ULID ids, theme names — have one grammar each in core (`id-grammar.ts`,
`ids.ts`; the Studio front end keeps one pinned mirror), and the ratchet's `id-grammar` check counts a pattern written
by hand anywhere else in `packages/*/src`: a date stamp, a version suffix, the ULID class or alphabet, a template that
builds or tests an id, a second suffix table, the run-folder or a theme-name grammar spelt whole (as a regular
expression or as a string), a capped grammar tested without its cap or handed to a schema (10 files in the baseline,
in four groups, each with its reason: other names of the same shape at their definition — 5 files —, the mirrors of
the scenario name and the project slug in the Studio front end — 3 —, the export formats' file suffixes — 1 —, one
deliberate use — 1). It cannot see a grammar spelt another way, a pattern put together
from pieces, a parser written with string methods, a grammar reached under another name, nor anything outside
`packages/*/src`.

A run's record and a capture's timeline are read in one place in core (`run-record.ts`: the pure parse boundary;
`io/run-folder.ts`: the files — a value or a typed problem), the run record is a union of states (`run-record.ts`) and
"can this capture be edited" and "which run is `latest`" are two pure rules (`take.ts`). The ratchet's `record-read`
check counts, in `packages/*/src` outside those two files, a value given the type of a run record or a timeline: the
result of `JSON.parse` or `readJson` cast, typed by a type argument, by its variable's annotation or by its
function's return type; any other cast to one of those types; a type guard or an assertion function that says a value
is one; a generic call that names one as its type argument; a parse through a record's or a timeline's schema itself;
an interface that extends one. Two files read a run folder's file on their own, on purpose, into a shape of their own
— `engine/src/prune.ts` (until what prune keeps is decided) and `engine/src/jobs/run-job.ts` (a reserved run is closed
on a lenient read: a record the reader refuses must still be closed) —: each `JSON.parse` there is an entry of the
baseline with its reason. The check cannot see a type under an alias or an own interface of the same members anywhere
else, a file's own bytes handed to the reader's parsers (the engine's confined run folder and the comments' anchor do:
the type is the reader's, the link and size rules are theirs), an untyped parse result that reaches a record without a
cast, nor anything outside `packages/*/src`.

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
