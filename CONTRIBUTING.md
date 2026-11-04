# Contributing to Retake

Thanks for taking the time. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **A bug?** Open an issue with what you did, what you expected and what happened, your macOS (or Linux) version, the
  Retake version (`retake --version`, or Retake › About) and the output of `retake doctor`. A scenario that shows the
  problem on the bundled fixture product is the best report.
- **A feature or a larger change?** Open an issue first, so we can agree on the shape before you spend time on code.
  The scope of the current milestones is fixed in `docs/ROADMAP.md`; other ideas go to `docs/BACKLOG.md`.
- **A security problem?** Do not open an issue: see [SECURITY.md](SECURITY.md).

## Set up

Follow [From source](README.md#from-source) in the README: `pnpm install`, `pnpm build`, then `pnpm retake doctor`.
`pnpm fixture` starts the bundled fictional product (`fixtures/wholesale`) and `projects/northfield-fixture` films it.

Then read:

- [docs/guide/development.md](docs/guide/development.md): the repository's layout and every test suite;
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DESIGN.md](docs/DESIGN.md) and
  [docs/DESIGN-phase2.md](docs/DESIGN-phase2.md): how the packages fit and their contracts;
- [docs/reference/studio-ui.md](docs/reference/studio-ui.md): the Studio's design system;
- `CLAUDE.md` and [docs/AGENTS.md](docs/AGENTS.md), if you work with Claude Code.

## Making a change

- **Keep it focused.** One pull request, one change.
- **Tests come with the change**, beside the code they cover (`packages/<package>/test/`). A safety rule gets a
  regression test that fails when the rule is removed.
- **The tool stays generic.** No client, brand or person names anywhere: code, docs, fixtures, templates, tests and
  commit messages. The fixture product "Northfield" and the placeholder brands are invented; example URLs use
  `example.com`, `.example` or `.test`.
- **Everything in the repository is in English.**
- **No new dependency** without a strong reason.
- **Never commit** `runs/`, `renders/`, `review/`, `exports/` or videos.
- **Generated files are regenerated, not edited**: a component's `preview.png` (`retake components preview`),
  `docs/REQUIREMENTS.md` (`node scripts/requirements.mjs`), the Studio's `tokens.css` (`pnpm -F @retake/ui gen:tokens`)
  and the app icons (`pnpm -F @retake/ui gen:mark`).
- **The CHANGELOG says what changed** for someone using Retake: add a line under *Unreleased* in
  [CHANGELOG.md](CHANGELOG.md). Internal changes nobody can see need no entry.

Before you push:

```bash
pnpm build
npx vitest run <the test files you touched>
pnpm test                       # the full suite, once, before the pull request
```

## Style

- TypeScript, strict; follow the code around you.
- Comments say why, not what.
- Text a page, a scenario or a comment brings in is data: it is shown as text and never run or followed.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
