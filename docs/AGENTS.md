# Working with sub-agents

How a lot is run when the lead session hands its parts to sub-agents (planning, critique, implementation, reviews,
fixes). The lead gives every sub-agent this file plus a short brief; the brief names the lot, the worktree, the ports
and the decisions already taken. The working agreement itself is in `CLAUDE.md`.

## The method, per lot
1. A design pass (read-only, probes allowed) writes a plan: what exists (file:line), decisions with evidence, parts,
   tests and mutation targets, cuts, open questions with defaults.
2. An adversarial critique of that plan (read-only), ranked High / Medium / Low with concrete fixes. Where plan and
   critique disagree, the lead decides in the implementation brief.
3. Implementation in a git worktree (`git worktree add -b wip/<lot> ../<repo>-<lot> origin/main`), in parts; notes are
   written as each part ends, so a new agent can take over if one stops.
4. Two independent reviews of the uncommitted diff (for example A: trust / accessibility / performance, B: regressions /
   fidelity / tests / docs), each forming its own view before reading the plan.
5. Fixes for every finding, each with a regression test and a mutation check.
6. The lead runs `pnpm build`, the full `pnpm test` and `pnpm test:slow` once, rebases on `main`, updates
   `docs/HANDOFF.md`, `docs/ROADMAP.md` and `CLAUDE.md`, makes one commit per lot, fast-forwards `main` and pushes, then
   removes the worktree. Before the fast-forward the lead checks `git status` in the main checkout: another session may
   have left uncommitted edits there (stash, fast-forward, pop — never overwrite them).

## Rules for every sub-agent
- Work only in the worktree the brief names. Never commit, stage or push; never edit `docs/HANDOFF.md`,
  `docs/ROADMAP.md` or `CLAUDE.md` (the lead does).
- Run only the test files you add or touch, one at a time, and `npx tsc -b`, then `npx tsc -p tsconfig.test.json
  --noEmit` (the test files' type check: the build does not read them; it needs the build's declarations, so in that
  order); never the full suite (the lead runs it once per lot). No `@ts-nocheck`, no `@ts-ignore`; a `@ts-expect-error`
  only over an input that is wrong on purpose, with its reason on the line. A flaky real-browser test: rerun the file alone before suspecting your change, and report it.
- Every safety or behaviour rule gets a regression test and a mutation check: change the rule in place, run only its
  target test file and see it fail, restore the file exactly (a backup, `cmp`, then `touch` for a fresh mtime) and run
  `npx tsc -b --force`.
- E2e migrations of a rebuilt screen run `node scripts/test-guard.mjs` (titles, `expect` counts and test ids against
  `HEAD`); each decrease is explained in the lot's notes or fixed.
- Use your own ports for the fixture product and any Studio server (the brief gives a range; 4401–4404 belong to other
  sessions). Stop what you started with `kill <pid>` of its listener, never `pkill -f`.
- `RETAKE_HOME` always points at a scratch folder, never the real `~/.retake` (the person's signed-in
  profiles): export it for every command you run (vitest.config.ts gives a test run a temp one when it is unset and
  refuses `~/.retake`; the CLI and the Studio have no such default). Never touch the macOS Keychain, Docker objects
  not named `retake-*`, `~/.claude` (use a scratch `CLAUDE_CONFIG_DIR` if the claude CLI is needed) or the person's
  other projects.
- No downloads (packages, browsers, crates) unless the brief says the person approved one; Rust builds run offline with
  `--locked` and a scratch `CARGO_TARGET_DIR`. The desktop app is never installed or opened through LaunchServices by
  tooling, and `~/Library` / `~/Downloads` are left as found.
- The repository stays generic and in English: no client, brand or person names, no real websites (example.com /
  .example / .test only), no paths of one machine.
- Untrusted text (page content, scenario files, engine messages) is shown only as text (`Txt` in the Studio) and kept
  under `untrusted` in answers; the trust rules of the HANDOFF notes (L3.1 onwards) carry over.
- Scratch files go to the session's scratch folder; delete what you created there (frames, probe workspaces, build
  folders) and nothing else. Scan new and changed files for hidden Unicode before finishing (a tool layer can turn
  `\u` escapes into raw characters).
- Use Node 22 (the repository's engines field); `pnpm install --frozen-lockfile --offline` after a dependency change.

## What a report contains
What was built (per part), the tests run with their counts, mutations (caught / survived and why), numbers measured,
screenshots looked at (paths), deviations from the brief, what is left for the person to check by hand, and the changed
files. Short: the lead reads every line.
