# Architecture decisions

## ADR-1 — Local-first, desktop-first (2026-10-12)

**Decision.** In V1 everything heavy runs on the user's machine: capture (Chromium + runner), editing plan, render
(Remotion), review, export and the MCP server. The product core is the local **engine** (Node), used by three
clients: the desktop app (Tauri shell around the Studio web UI), the CLI (also in the user's CI) and Claude through
MCP. No server-side capture or rendering in V1. A full cloud offer is kept in mind but out of this development phase.

**Why.**
- Server cost does not grow with users (a capture keeps a Chromium busy for minutes; rendering is CPU-heavy).
- Captures need the user's environment: private staging behind VPN/IP allow-lists, localhost, signed-in sessions.
- Customer data and sessions never leave the user's machine.
- The same engine runs headless in CI (videos regenerated on every release).

**Consequences (built into the lots).**
1. **Engine API**: one local HTTP/JSON API + an event stream (progress, logs, live preview frames) used by the Studio
   UI, the MCP server and the CLI. The UI never reads files directly; it talks to the engine (L3.1, L4.1).
2. **Job runner abstraction**: captures, renders, reviews and exports are jobs with status/progress/cancel, executed by
   a local worker; the interface allows a remote worker later without changing callers (L3.1).
3. **Media storage abstraction**: artefacts (captures, frames, renders, exports) are addressed through a storage
   interface (local paths now; object storage later), content-hashed where useful (L3.1).
4. **Comments**: one file per thread (`<project>/comments/<scenario>/<thread-id>.json`) so concurrent edits (git, a
   future sync) do not conflict (L3.6).

## ADR-2 — Flat files are the source of truth (2026-10-12)

**Decision.** Projects, scenarios (YAML), themes, components, comments (JSON) and records live as plain files in the
user's workspace folder. Large binaries (captures, frames, renders, exports) live in the workspace too but are
git-ignored. A SQLite index under `<workspace>/.demo-studio/` (runs, renders, jobs history, search) is a cache rebuilt
from the files — never the source of truth.

**Why.** Claude reads and edits files directly; git versions and reviews them (team collaboration through git in V1);
portable, offline, no lock-in, easy backup.

## Later (not V1)
- Cloud layer: shareable review links with frame comments, team sync of the workspace, component marketplace and
  licences, optional cloud render (4K, batches). The cloud stores the same file tree (object storage + index), so the
  formats and the MCP stay identical.
- Chrome extension (CDP through `chrome.debugger`) as a "no install" capture mode, if needed.
- Client-side final rendering (WebCodecs) once mature; the Studio preview is already client-side (Remotion Player).
