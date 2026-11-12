# Development

The repository's layout, the test suites and the phase status. How to contribute: [CONTRIBUTING.md](../../CONTRIBUTING.md). Part of the [Retake guide](README.md).

## Repository layout

```
packages/core         scenario parser and validator, project/template/sandbox model, templating, JSON Schemas
packages/hooks        setup/teardown hooks (http, sql, shell, js), rollback journal, allow-list, secrets
packages/sandbox      sandboxes: start, seed, reset and stop them (process and docker-compose providers), Postgres
                      snapshots, `retake sandbox init` scaffold, take lock, health, ports
packages/runner-web   headless Chromium runner: in-page kit (cursor, resolver), actions, screencast, encoder, timeline
packages/cli          the `retake` command
packages/components   components: manifest schema, registry, validation, scaffolds, theme tokens, kit (L2.2)
packages/editor       edit planner (planEdit → EditPlan, reframing), the Remotion compositions (src/remotion) and the
                      render pipeline (bundle cache, asset server, renderVideo / renderStill / listRenders, exportRender)
packages/review       review of a render: contact sheets, key frames, output-time timeline, checks, report, diff
packages/engine       the engine API the CLI and the MCP server share: workspace / project loading, project, scenario
                      (if_match saves), run, persona-session and sandbox reads, local storage refs, EngineError codes,
                      the run executor of `retake run`, the job queue and its worker (worker-main.ts), the local
                      HTTP servers' gate, 127.0.0.1 listener, tokens and discovery file (src/http/), the workspace
                      index (src/index-db/: node:sqlite, the stat poll, the job watch); `@retake/engine/contract`:
                      the operation contract (ToolDef, the SDK-free invoke the MCP server and the Studio share) and
                      the operation catalogue (catalogue.ts: every operation, its kind and the shells that serve it)
packages/mcp          the MCP server (`retake mcp`): tools over stdio and Streamable HTTP (src/http.ts), zod schemas,
                      results, --print-config
apps/desktop          the macOS app (L5.2): a Tauri shell (Rust, Cargo; not a pnpm package) running `retake ui
                      --supervised` and showing it; core/ holds its rules (no dependency); scripts/desktop.mjs
packages/ui           the Studio web app (`retake ui`): a React app bundled in memory by esbuild and its server — the
                      engine's /v1 HTTP API behind the engine's gate (engine src/http/), an allow-list of the MCP tools,
                      the event stream and the index reads (src/server/live.ts, ops.ts); the screens in a folder
                      per feature (src/app/record/, script/, shoot/, edit/, review/, library/, themes/, project/;
                      the scenario screen: src/app/script/ScenarioScreen.tsx, ScenarioInspector.tsx, YamlView.tsx),
                      the shared words in src/app/words/, the foundations at src/app/ (Thumb.tsx, thumbs.ts, …)
skills/               the Claude Code plugin: Claude skills + the MCP server from userConfig values (skills/README.md)
.claude-plugin/       the local plugin marketplace (`claude plugin marketplace add <repo>`)
fixtures/wholesale    the fictional "Northfield" product used for end-to-end tests (and its Dockerfile)
projects/             the fixture project and its sandboxes (your projects live in your workspace)
templates/            starter themes: default, editorial, motion
scripts/              requirements.mjs (docs/REQUIREMENTS.md; `--check-cites`: quoted test titles exist), fixture media
                      and preview samples, validate-raw.py,
                      test-pg.mjs (`pnpm test:pg`)
docs/                 SPEC.md (product brief), DESIGN.md and DESIGN-phase2.md (package contracts), HANDOFF.md,
                      ROADMAP.md, BACKLOG.md, ACCEPTANCE-phase2.md, MACOS-CHECKLIST.md, RELEASING.md; guide/ (the
                      user guide: the reference the README links)
CLAUDE.md             notes for Claude Code sessions (read order, working agreement, commands)
```

Development: `pnpm build` (TypeScript project references), `pnpm typecheck` (the build, then the files under
`packages/*/test` type-checked with `tsconfig.test.json`: the build does not read them, the CI does), `pnpm test` (vitest; the end-to-end tests start the
fixture on free ports and skip themselves when Chromium or ffmpeg is missing; some CLI tests run `packages/cli/dist`,
so build first). Gated tests:

| Command | What it runs |
|---|---|
| `pnpm test:pg` | the 7 SQL hook tests against a real Postgres (`packages/hooks/test/sql.test.ts`): `scripts/test-pg.mjs` starts a throwaway container `retake-pg-test-<hex>` from `postgres:17-alpine` (never pulled for you: it prints the `docker pull` when the image is missing) on a loopback port Docker picks, with a random password, sets `RETAKE_TEST_PG`, and removes that container — only that one — with its anonymous data volume at the end, on an error or on Ctrl-C. A container a killed run left (label `retake.test=pg`) is listed with the command that removes it, never removed. A few seconds; needs a running Docker (or OrbStack) |
| `pnpm test:pg --all` | the whole suite with Postgres, `RETAKE_TEST_DOCKER=1` and `RETAKE_TEST_SLOW=1`: everything this machine can run |
| `pnpm test:slow` | `RETAKE_TEST_SLOW=1`: the committed `catalogue` scenario captured on the fixture (free ports) at 1920×1080 with the debug cursor and its real hooks — duration, every frame's size, the run folder's files, the scroll durations, the drawn hotspot ≤ 3 px from every click point and inside its target, `popup_opened`, no hesitation between steps, the setup rollback (`packages/cli/test/catalogue-acceptance.test.ts`, about 1.5 min); then the MCP acceptances over stdio on a copy of the fixture project — capture → render → review → theme switch → export (`packages/mcp/test/fixture-acceptance.test.ts`), authoring from inspections (`authoring-acceptance.test.ts`), recording (`record-acceptance.test.ts`) and a theme made from the brand-site fixture and brand files, previewed, filmed and reviewed (`theme-acceptance.test.ts`); and the phase 3 acceptance on one empty workspace — a project from a README, a scenario from a script and inspections, a theme from brand files, a workspace component, capture → render → review, a person's comment → scenario fix → re-capture → render → resolve, about 7 min (`phase3-acceptance.test.ts`) |

Set `RETAKE_TEST_PG` yourself to a PostgreSQL URL (a role that may create tables) to run the SQL hook tests
without the script, `RETAKE_TEST_OLD_NODE` to an older `node` binary (e.g. a
Node.js 10) to check the CLI's version message on it, and `RETAKE_TEST_DOCKER=1` to run the docker-compose
sandbox tests (a running Docker; `packages/sandbox/test/compose.test.ts` uses busybox:1.38.0, postgres:17-alpine and
axllent/mailpit:v1.29.4, `packages/cli/test/sandbox-docker.test.ts` builds the fixture's image on node:22-alpine). They
name their compose projects and images `retake-test-*` and remove them before and after; base images stay.
`packages/runner-web/test/look.test.ts` compares the drawn cursor and the file chip with golden images
(`packages/runner-web/test/golden/`, with a tolerance; the chip's only on macOS: its text uses the system font) next
to structural checks; after an intended change of the look (or a Chromium update that moves it), rewrite them with
`RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/runner-web/test/look.test.ts` and look at the PNGs before
committing them.

Renders in tests run on the software path (L5.15): `vitest.setup.ts` sets `RETAKE_RENDER_GL=software` and
`RETAKE_RENDER_ENCODER=libx264` for every test file, so a render is frame-identical run to run (as on Linux) and the
suite keeps its times. A test of the GPU path opts in — it passes `settings: {gl: 'auto', encoder: 'auto'}` to the render
or sets the variables back itself — and compares SSIM (≥ 0.995 on every frame) or structure, **never bytes**: ANGLE and
VideoToolbox are not frame-identical run to run (`packages/editor/test/render-gpu.test.ts`, darwin only).
`RETAKE_TEST_RENDER_POLICY=keep` leaves the shell's values (a whole run on the default policy, by hand). Since L7.3
`RETAKE_RENDER_FFMPEG=library` is pinned with them: the suite's frames are encoded by the rendering library's own
ffmpeg whatever ffmpeg the machine has (the pinned bytes do not depend on it); a test of this machine's ffmpeg at the
encode passes `settings: {ffmpeg: 'own'}` (`packages/editor/test/render-own-ffmpeg.test.ts`, darwin only). Exactly
these three variables are pinned (`RETAKE_RENDER_CONCURRENCY` is not). A process a test starts with an environment of its own
(an MCP server, a CLI command) gets them through `testChildEnv()` (`packages/core/test/child-env.ts`, with the scratch
`CFFIXED_USER_HOME` and the file's `RETAKE_CAPTURES_DIR`), so the worker and job processes behind it render on the
software path too; `packages/core/test/retake-home.test.ts` fails on such an environment that lacks them. The app's own
acceptances (`app-bundle-acceptance`, `app-update-e2e`) run the shipped default on purpose.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core, hooks, web runner, CLI, fixture product, starter templates | **Done** — the `catalogue` and `quote` fixture scenarios capture headless at 1920×1080 |
| 2 | Components, themes, editor (Remotion), review artefacts | **Done** (2026-10-12; acceptance in [docs/ACCEPTANCE-phase2.md](../ACCEPTANCE-phase2.md): `catalogue` and `quote` rendered with the editorial theme and reviewed clean, then re-rendered with the motion theme and with another layout component without touching the scenario, a video with your own intro file and alpha overlay, a raw export validated) — contracts in core (L2.1), the components package (L2.2: manifests, registry, validation, scaffolds, kit, `retake components`), the edit planner (L2.3: `planEdit`, `retake plan`), the render pipeline (L2.4: placeholder library, `DemoVideo`, `retake render` / `still`), the reference-look components (L2.5: intro, outro, card layout with geometry following params, captions, clock interstitial, crossfade — measured on renders), the review (L2.6: `retake review`, contact sheets, key frames, checks, report, diff) and the full library with previews (L2.7: browser / laptop / phone / tablet / raw layouts, overlay caption, cards, minimal intro/outro, plain interstitial, callout, lower third, fade-black; committed previews, `retake components preview`) and variants & export (L2.8: vertical and square reframed on the cursor and the targets, real 4K captures, music bed, theme default zoom, `retake export`) and mails, notifications & documents (L2.9: `mailbox`, `wait_for_email`, `download` with PDFs rasterised by pdf.js, web notifications captured, artefacts in components, notification / mail / document / phone cards, tap-open transition), tutorial overlays & story cards (L2.10: key caps, spotlight, step badges, loupe, progress bar, figure / features / before-after / testimonial / CTA / chart cards) and several pages at once (L2.11: multi-page scenes filmed on one clock, `studio/layout-split`, `studio/layout-pip`, per-pane camera and overlays) and your own media & motion (L2.12: video / image / Lottie segments, alpha overlay videos, Lottie overlays, `studio/media`, `studio/lottie`, [docs/BRING-YOUR-OWN-MOTION.md](../BRING-YOUR-OWN-MOTION.md); waits shown as short loading states) and the raw export for editors (L2.13: `retake export-capture` / `run --raw`, clips per scene with loads cut, MP4 / ProRes at 30 / 60 fps, cursor baked / absent / transparent layer, FCPXML / EDL / OTIO / CSV markers, manifest) |
| 3 | MCP server, authoring (script → scenario, page inspection, recording), skills | **Done, pending the live run** (automated acceptance in [docs/ACCEPTANCE-phase3.md](../ACCEPTANCE-phase3.md): on one empty workspace, a project from a README, a scenario from a script and page inspections, a theme from brand files, a workspace component, capture → render → review clean, a person's frame comment → scenario fix → re-capture → render → resolve, zero approvals; the same loop by Claude itself in Claude Code is `docs/MACOS-CHECKLIST.md` step 12j) — L3.1: `retake mcp` with the read side (projects, scenarios with `if_match` saves, runs, sessions, sandboxes), dry runs, captures, hooks, environment resets, sign-ins and sandbox up / reset as jobs run by a background worker (`retake jobs`), human approval of hooks and shell seed steps through elicitation; L3.2: renders (guarded: project files only, no network), reviews with the contact sheet as images, exports, and themes / components (list, detail, previews as images, validate, scaffold) through MCP; L3.3: page inspections and a script-table skeleton for Claude's authoring; L3.4: recording a scenario a person performs (`retake record`, `scenario_record`); L3.5: themes from brand inputs and from a site URL (`template_create_from_brand`, `template_from_site`, contrast checked); L3.6: frame comments (`retake comment`, anchors on the plan's steps and markers, `comments_list` / `comment_reply` / `comment_resolve`); L3.7: the Claude skills (scenario, theme, component) and the Claude Code plugin that bundles them with the server; L3.8: the phase 3 acceptance, and a warning when the scenario changed since the run was captured (a render shows the run as captured) |
| 4 | Studio web app (scenario blocks, timeline, frame comments) | In progress — L4.1: `retake ui` serves the Studio on 127.0.0.1 behind the engine's HTTP gate (one-time link, token, allow-list of the MCP tools): the Projects screen with search and recent activity (the workspace index), the README editor, live updates; `retake mcp --http` |
| 5 | macOS desktop shell, iOS Simulator runner | In progress — L5.2: the desktop app (`pnpm desktop:build`, [Desktop app (macOS)](desktop-app.md#desktop-app-macos)) |
| 6 | Licensing, packaging, component marketplace | Out of scope for now |

The macOS verification pass and its fixes are done (lots L1.5 and L5.1, results at the end of
`docs/MACOS-CHECKLIST.md`). Next: capture smoothness (L1.3), then L1.2, L1.6, L1.7, L1.8 and L1.4 before phase 3 — in local Claude Code sessions on a Mac, on the `main` branch (see
`CLAUDE.md` and `docs/HANDOFF.md`).

Planning lives in the repo: `docs/ROADMAP.md` (small lots and their status), `docs/REQUIREMENTS.md` (every requirement
of the brief with its status, generated by `pnpm req` from `docs/requirements.json`) and `docs/HANDOFF.md` (where to
start in a new session).
