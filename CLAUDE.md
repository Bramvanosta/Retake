# Demo Studio — notes for Claude Code

Demo Studio turns a written scenario (YAML) into a finished product video: it drives a real web app headless with an
in-page cursor, captures it, edits it automatically with themeable components (Remotion), reviews the result (contact
sheets, checks) and exports it — or exports the raw capture for an editing tool. TypeScript pnpm monorepo, Node ≥ 22.
The current goal is **a local tool for our own use**; selling it is a later topic (`docs/BACKLOG.md`).

## Read first
1. `docs/HANDOFF.md` — state, Mac setup, order of the next lots, decisions, notes per lot. **Always start here.**
2. `docs/ROADMAP.md` — lots, status, working agreement; `node scripts/requirements.mjs --lot <id>` lists a lot's
   requirements (source of truth: `docs/requirements.json`).
3. `docs/SPEC.md` (brief), `docs/DESIGN.md` + `docs/DESIGN-phase2.md` (contracts), `docs/reference/look.md`
   (target look), `README.md` (usage, scenario language, CLI).
4. `docs/AGENTS.md` — how a lot is run with sub-agents (plan, critique, worktree, reviews, fixes) and the rules every
   sub-agent follows.

## Working agreement
- **One lot at a time**; the user decides how many lots to chain. Don't start the next lot unasked.
- A lot is done when: `pnpm build` and the **full** test suite are green, the lot's acceptance is checked (real runs,
  renders reviewed, frames looked at), `docs/requirements.json` is updated (status / evidence / gap, then
  `node scripts/requirements.mjs`), `docs/HANDOFF.md` and the ROADMAP status are updated — then **one clean commit
  per lot** on `main`, pushed, and a short report.
- A lot that adds or changes a component regenerates its committed `preview.png` (`studio components preview`).
- **The tool stays generic**: no client, brand or person names anywhere (code, docs, fixtures, templates, tests,
  commit messages). The fixture product "Northfield" and the placeholder brands are invented.
- **MVP scope is locked** to the lots in the ROADMAP. A new idea goes to `docs/BACKLOG.md` (maintained by hand,
  unprioritised), not into a lot.
- No new dependency without a strong reason; never commit `runs/`, `renders/`, `review/`, `exports/` or videos.

## Language
Everything in the repository is in English. The user writes in French: **answer the user in French.**

## Git
Work on `main` (clone / pull `main`). The cloud working branch `claude/new-session-pq6jtq` is history only.
Commit messages end with the attribution lines the harness gives.

## Everyday commands (from the repository root)
```sh
pnpm install                         # once, and after a dependency change
pnpm build                           # = tsc -b (typecheck + dist/)
pnpm test                            # = vitest run, full suite (~14 min on the Mac; run `pnpm build` first; 81 skip by default: 42 slow (incl. 3 Claude CLI), 8 installed Chrome, 15 desktop app, 7 Postgres, 7 Docker, 1 old Node, 1 headed)
pnpm test:pg                         # the 7 Postgres tests on a throwaway demo-studio-pg-test-* container (~5 s; --all: whole suite with Postgres, Docker and slow tests)
pnpm test:slow                       # catalogue capture, MCP loops, theme, plugin, phase-3 and Studio acceptances (~13 min)
DEMO_STUDIO_TEST_DOCKER=1 npx vitest run packages/sandbox/test/compose.test.ts packages/cli/test/sandbox-docker.test.ts   # Docker sandboxes (~65 s)
npx vitest run packages/editor/test/planner-real.test.ts    # one file
node fixtures/wholesale/server.mjs & # fixture product (console :4401, shop :4402; signed in: :4403, :4404); stop it with kill <its pid>
                                     # (`kill $!`; not `pkill -f`: it also matches the shell running it)
node packages/cli/dist/bin.js doctor                         # = pnpm studio doctor: is this machine ready?
node packages/cli/dist/bin.js run northfield-fixture quote   # capture (fixture running)
node packages/cli/dist/bin.js render northfield-fixture quote --review   # edit + review → renders/, review/
node packages/cli/dist/bin.js review northfield-fixture latest --scenario quote
node packages/cli/dist/bin.js export-capture northfield-fixture latest --scenario quote   # raw package for editors
node packages/cli/dist/bin.js components preview --all --stale     # regenerate stale component previews
node scripts/requirements.mjs [--lot L1.5]                    # regenerate docs/REQUIREMENTS.md / list a lot
node scripts/requirements.mjs --untested 1                    # fails while a phase-1 requirement has no test
node scripts/requirements.mjs --check-cites                   # fails when an evidence string quotes a missing test title
node scripts/test-guard.mjs [--base <ref>] [<path>]            # migrated tests: no lost title, expect or test id vs a git ref
python3 scripts/validate-raw.py <exports/package>             # optional: check a raw package (opentimelineio)
node packages/cli/dist/bin.js mcp --print-config               # MCP server registration for Claude Code / desktop (--http: over HTTP)
node packages/cli/dist/bin.js ui                               # the Studio web app on 127.0.0.1 (one server per workspace)
pnpm -F @demo-studio/ui gen:tokens                             # regenerate the Studio's tokens.css from tokens.ts (dark + light); `ratchet` lowers the kit-only counts
pnpm desktop:build                                             # the macOS app (apps/desktop, Rust + Tauri, offline: CARGO_NET_OFFLINE=true); desktop:dev / desktop:test / desktop:clean
```

## Where things live
- `packages/core` scenario language, schemas, validation · `packages/runner-web` headless capture, in-page kit, raw
  export (`src/raw/`) · `packages/hooks` setup/teardown hooks · `packages/components` component system, kit,
  built-in library (`library/studio/*`), scaffolds · `packages/editor` planner (`planEdit`), Remotion compositions
  (`src/remotion/`), render / export · `packages/review` contact sheets, checks, report · `packages/cli` the `studio`
  command · `packages/sandbox` sandbox engine (process and docker-compose providers, Postgres snapshots, `init`
  scaffold) · `packages/engine` engine API shared by the CLI and MCP, job queue and worker · `packages/mcp` the MCP
  server (`studio mcp`, stdio and HTTP, SDK imported only in `src/server.ts`) · `packages/ui` the Studio web app and its
  server (`studio ui`; design system in `src/app/ui-kit` + `tokens.ts`, reference `docs/reference/studio-ui.md`) · `apps/desktop` the macOS app (Tauri shell around `studio ui --supervised`) · `skills/` the Claude skills and plugin root.
- `fixtures/wholesale` the fictional product filmed by the tests; `projects/northfield-fixture` its project
  (scenarios, hooks, assets; generated `runs/`, `renders/`, `review/`, `exports/` are git-ignored);
  `templates/` starter themes (default, editorial, motion); `scripts/` helpers; `docs/` everything else.
- A user's own material lives in their own workspace folder (`DEMO_STUDIO_ROOT` or a `studio.yaml`), never here.
