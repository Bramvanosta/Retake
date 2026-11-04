# Security — scope, checklist, what holds

Findings that describe an open weakness are kept in the person's private notes until fixed (the repository is
public). This file holds what can be public: the scope, the checklist the next audit reruns, the defences found
sound, and hygiene points.

## Who the attacker can be
The agent driving MCP or the Studio; the filmed or visited page (site, PDF, mail); another process of the same user;
another local account; a compromised dependency in the release build; anyone with write access to the GitHub
repository.

## Checklist, per surface
| Surface | Questions |
|---|---|
| Scenario language, hooks, sandboxes | Can text an agent may write become code that runs, or reach a secret? Is every approval bound to exactly what runs, and does the form show all of it? Are paths contained after links are followed? |
| Headless browser and render | Which URLs can a scenario open? Is Chromium's OS sandbox on? What does a page reach through exposed bindings? Which local servers listen during a render, and where? |
| Local HTTP servers | Binding address, tokens, Host and Origin checks, body limits, which operations each server allows |
| MCP tools | Inventory (read / write / job / runs code), parity with the Studio and the CLI, nothing that widens an agent's rights, untrusted text marked as such |
| Shared state | Every file or record several processes read (job queue, approvals, journals, locks, index): who can write it, and does the reader verify it? |
| Secrets | Where refs resolve, what child processes inherit, what logs and errors may carry, file modes |
| Desktop app | IPC exposure, navigation rules, the supervised pipe, setup operations, the updater |
| Release pipeline | Triggers, permissions per job, pins, what the signing job executes, caches, GitHub settings matching docs/RELEASING.md |
| Supply chain | Lockfiles, install scripts, pinned runtimes, runtime downloads |

## Defences checked and found sound (2026-11-04)
- Path containment of referenced files (links, `..`, absolute paths, macOS case) at submit and at run time.
- Secret refs refused in agent-written scenarios; secrets never in job payloads; Keychain read through `execFile`.
- Approvals signed with HMAC (canonical JSON, constant-time compare, key 0600); unsigned ones ignored by the worker.
- The worker re-validates every job file: schema, scenario hash, agent trust, protected hosts, signatures.
- Studio gate: loopback only, foreign Host refused, foreign or `null` Origin refused, no CORS, body limits, no
  cookies, strict CSP, token compared in constant time, one-time bootstrap code in the URL fragment.
- The player origin is capability-scoped; MCP over HTTP refuses requests from web pages.
- Desktop shell: no IPC from the page, exact-origin navigation, a strict line protocol on the pipe, setup paths only
  from the native panel, https-only signed updates that never go back a version.
- Release pipeline: tag triggers only, minimal permissions, actions pinned by SHA, no expression interpolated into
  shell steps, a build job without secrets, pinned Node.js, browsers, Tauri CLI and ffmpeg sources.
- Secret files 0600, written atomically; no secret or machine path in the tree or its history.

## Hygiene (public, low risk)
- No `SECURITY.md` at the root; GitHub's private vulnerability reporting, secret scanning and push protection are off.
- No CI on pull requests (BL-144); no `rust-toolchain.toml` (CI pins the toolchain itself).
- `packageManager` pins pnpm without its `+sha512` hash; `onlyBuiltDependencies` is declared twice with different lists
  (`package.json`, `pnpm-workspace.yaml`); no pnpm 10 supply-chain settings (minimum release age, trust policy).
- `.gitignore` has no patterns for signing material (`*.p12`, `*.p8`, `*.key`).
- The bundled Chromium should move with each release (its pins make that a deliberate step).
