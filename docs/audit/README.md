# Audit — technical, security, architecture (2026-11-04)

An audit of `main` at `1c8fc23` (after L5.16f, before L5.14 and L5.15), run read-only with offline tools. It has two
axes: security (the threat surfaces Retake really has) and architecture / code (clean architecture, clean code, DDD).
Its lens for the architecture is a reference project of the same author, built on a pure domain, an application
layer with ports, a single operation catalogue and one write pipeline; what applies to Retake, what is adapted and
what is left out is in [target-architecture.md](target-architecture.md).

| File | What it holds |
|---|---|
| [METHOD.md](METHOD.md) | How the audit was run and how to replay it: the commands, scripts and greps, what was measured, how to compare with this run |
| [security.md](security.md) | The security scope, the threat model, the defences checked and found sound, the hygiene points. Findings with an attack path are not here (see below) |
| [architecture.md](architecture.md) | The architecture and code findings, with numbers and `file:line` evidence |
| [target-architecture.md](target-architecture.md) | The target architecture, principle by principle (applies / adapted / not), and the incremental path |
| [action-plan.md](action-plan.md) | The tasks to schedule after L5.14 and L5.15: size, value, risk, prerequisites, and how they could become lots or backlog items |
| [2026-11-04/summary.json](2026-11-04/summary.json) | This run's measured numbers (`scripts/audit/snapshot.mjs`), the baseline the next audit compares with |

**Security findings and a public repository.** The repository is public. Findings that describe an unfixed weakness
are kept outside the repository, in the person's private notes, until they are fixed; a fixed one moves into
[security.md](security.md) with its fix. The action plan names them only by their private ids.

## In one page

**Security.** The trust model of ADR-1 (agents never handed a secret, a worker that re-validates every job, signed
human approvals, loopback servers behind tokens with Host / Origin checks, a desktop shell with no IPC from the page,
a release pipeline whose build job holds no secret) is real and largely holds in the code: most probes against it
failed. Where it does not hold, the cause is the same in each case: **some state that several processes share, or
that an agent can write, is trusted without a seal or a check**, and some approval texts do not show everything that
runs. The fixes are local; none needs a redesign. The private report ranks them and proposes to fix the most serious
ones before the first public release (v0.2.0).

**Architecture.** The package graph is acyclic and enforced by pnpm and `tsc -b`; copy-paste duplication is very low
(about 0.2 %); trust decisions live in the engine; MCP and the Studio share one tool call path and one error shape;
the planner and the review checks are pure. What is missing is the layer inside the packages and one source of truth
per concept:
- `@retake/core` is the domain but 26 of its 92 files do I/O;
- the operations are listed three times by hand (MCP tools, Studio ops, CLI commands), and some queue rules exist only
  in the Studio's server;
- the CLI orchestrates render, review and export itself, beside the engine's jobs;
- path containment, a security rule, has 16+ implementations with four semantics;
- the vocabulary has synonyms across layers (dry run / rehearsal, run / take / shoot, template / theme, environment /
  location, persona / cast) and homonyms (session ×5, check ×6, studio ×4), with no glossary;
- the engine has no ports beyond progress callbacks, so none of its 56 test files runs without I/O.

**Plan.** Guard rails first (an import-rules ratchet test, a glossary, one containment function, typed error kinds),
then, after L5.14, one operation catalogue and pipeline in the engine; after L5.15, one project store with an audited
write path and the CLI on the engine's operations. No big-bang rewrite: every step keeps the suite green and can be a
part of a lot. Details and sizes in [action-plan.md](action-plan.md).
