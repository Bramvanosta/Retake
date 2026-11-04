# Audit method

How this audit was run, so the next one can follow the same steps and compare its numbers with this run.

## Steps
1. **Pick a commit.** Work in a fresh worktree of one commit and note its sha. This run: `1c8fc23`.
2. **Isolate.** Point `RETAKE_HOME`, `TMPDIR` and `CFFIXED_USER_HOME` at a scratch folder, set `RETAKE_DISK_WARN=off`
   and `COREPACK_ENABLE_NETWORK=0`. Offline tools only; ask before any download.
3. **Measure** with `scripts/audit/` (below) and keep the summary.
4. **Read each surface** with the checklist of [security.md](security.md) and the questions of
   [architecture.md](architecture.md); record evidence as `file:line`, severity and confidence.
5. **Sort the findings.** Fixed or hygiene points go into the repository. Anything describing an open weakness goes to
   the person's private notes first.
6. **Compare** with the previous summary and update [action-plan.md](action-plan.md).

## Scripts (`scripts/audit/`, Node.js and the TypeScript compiler from `node_modules`, read-only)

| Script | Measures |
|---|---|
| `imports.mjs <root> [--json f]` | Package graph from real imports, declared vs actual dependencies, `node:` built-ins, I/O vs pure files, package and file cycles |
| `rules.mjs <root> [--imports f] [--json f] [--list]` | The proposed layer rules R1–R7 and their violation counts (the ratchet baseline) |
| `sizes.mjs <root> [--json f]` | Largest files, functions of 150 lines or more, test lines and kinds per package |
| `dupes.mjs <root> [--json f]` | Duplicated blocks (8 normalised lines), within and across packages |
| `terms.mjs <root>` | Domain terms per package and in the docs; exported names declared more than once |
| `snapshot.mjs [--out dir]` | Runs all of the above plus lockfile and workflow counts; writes `summary.json` |
| `compare.mjs <old> <new>` | Every number and dependency edge that changed between two summaries |

```sh
node scripts/audit/snapshot.mjs --out "$SCRATCH/audit"
node scripts/audit/compare.mjs docs/audit/2026-11-04/summary.json "$SCRATCH/audit/summary.json"
```

Commit the new `summary.json` as `docs/audit/<date>/summary.json`; the raw outputs stay in the scratch folder.

## Other read-only checks
- Supply chain: counts from `pnpm-lock.yaml` and `apps/desktop/Cargo.lock` (in the summary), `pnpm list --prod
  --depth Infinity --parseable` per package, `cargo tree --offline --locked` with and without the `updater` feature,
  the pins of `apps/desktop/bundle/*.json` and `scripts/ffmpeg-sources.json`.
- Committed secrets and machine paths: `git grep` for key and token patterns and for home-folder paths, over the tree
  and `git log --all -p`.
- GitHub settings (read-only `gh api`): repository security features, rulesets, the `release` environment, Actions
  permissions.
- Network checks, only with the person's OK: `pnpm audit --prod`, `cargo audit` or `cargo deny`, `osv-scanner` on both
  lockfiles, a workflow linter.

## Measured on 2026-11-04 (baseline)
150,936 source lines in 576 files across 11 packages, 111,641 test lines in 368 files; 0 package cycles, 6 file
cycles; layer rules R1 36, R2 0, R3 12, R4 51, R5 0, R6 24, R7 0; 57 functions of 150+ lines; 287 duplicated lines
(34 across packages); 556 npm packages (all sha512, none from git), 451 crates (none from git), 16 action uses, all
pinned by SHA. Full numbers: [2026-11-04/summary.json](2026-11-04/summary.json).
