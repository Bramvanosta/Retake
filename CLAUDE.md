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
pnpm test                            # = vitest run, full suite (~2.5 min on the Mac, 5–10 in the cloud; 7 skip by default: 6 Postgres without DEMO_STUDIO_TEST_PG, 1 without DEMO_STUDIO_TEST_OLD_NODE)
npx vitest run packages/editor/test/planner-real.test.ts    # one file
node fixtures/wholesale/server.mjs & # fixture product (console :4401, shop :4402); stop it with kill <its pid>
                                     # (`kill $!`; not `pkill -f`: it also matches the shell running it)
node packages/cli/dist/bin.js doctor                         # = pnpm studio doctor: is this machine ready?
node packages/cli/dist/bin.js run northfield-fixture quote   # capture (fixture running)
node packages/cli/dist/bin.js render northfield-fixture quote --review   # edit + review → renders/, review/
node packages/cli/dist/bin.js review northfield-fixture latest --scenario quote
node packages/cli/dist/bin.js export-capture northfield-fixture latest --scenario quote   # raw package for editors
node packages/cli/dist/bin.js components preview --all --stale     # regenerate stale component previews
node scripts/requirements.mjs [--lot L1.5]                    # regenerate docs/REQUIREMENTS.md / list a lot
python3 scripts/validate-raw.py <exports/package>             # optional: check a raw package (opentimelineio)
```

## Where things live
- `packages/core` scenario language, schemas, validation · `packages/runner-web` headless capture, in-page kit, raw
  export (`src/raw/`) · `packages/hooks` setup/teardown hooks · `packages/components` component system, kit,
  built-in library (`library/studio/*`), scaffolds · `packages/editor` planner (`planEdit`), Remotion compositions
  (`src/remotion/`), render / export · `packages/review` contact sheets, checks, report · `packages/cli` the `studio`
  command · `packages/mcp` phase 3 (empty).
- `fixtures/wholesale` the fictional product filmed by the tests; `projects/northfield-fixture` its project
  (scenarios, hooks, assets; generated `runs/`, `renders/`, `review/`, `exports/` are git-ignored);
  `templates/` starter themes (default, editorial, motion); `scripts/` helpers; `docs/` everything else.
- A user's own material lives in their own workspace folder (`DEMO_STUDIO_ROOT` or a `studio.yaml`), never here.
