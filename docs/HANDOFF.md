# Handoff — read this first in a new session

**Retake was called Demo Studio before L5.13** (command `studio`, home `~/.demo-studio`, workspace file `studio.yaml`, variables `DEMO_STUDIO_*`): every name in this file is the current one — entries written before L5.13 were rewritten mechanically by `scripts/rename-l513.mjs`, so commands of earlier runs read `retake …`. <!-- old-name: the history line -->

Last updated: 2026-11-09, end of lot **L5.18 (hardening before the first release, the rest; pending the person's
review of the pull request)** — phases 1–4 are done (phases 3–4 pending the user's live runs, MACOS-CHECKLIST 12c–12j
and 13a–13j), phase 5 is under way (L5.1, L5.2, L5.2b, L5.5 – L5.18 done: the « Épure » Studio, the name Retake, the
standalone app and its releases, captures first, renders on the GPU, the two hardening lots). **Next: the first
release v0.2.0 (the person tags) — only when the user asks.** Branch: **`main`**. The work continues in local Claude Code sessions on the user's Mac (see
"Mac setup" below; the root `CLAUDE.md` sums up the working agreement and the everyday commands). The cloud working
branch `claude/new-session-pq6jtq`, where phases 1–2 were built, is history.

## What this is
Retake: a generic, product-agnostic tool (licence-ready in a V2) that turns a written scenario into a
professional product video — drive a real web app headless with an in-page cursor, capture it cleanly, then edit it
automatically with themeable components, and let Claude operate everything through an MCP server.

## Read in this order
0. `CLAUDE.md` (root) — the short version: working agreement, commands, where things live.
1. `docs/SPEC.md` — the brief, especially §0 (product principles), §11 (components), §12 (Studio app), §14 (phases).
2. `docs/ROADMAP.md` — lots, sizes, status, working agreement. **Work one lot at a time; the user decides how many.**
3. The lot's requirements: `node scripts/requirements.mjs --lot <id>` (source of truth: `docs/requirements.json`).
4. Contracts: `docs/DESIGN.md` (phase 1 packages), `docs/DESIGN-phase2.md` (components, editor, review, comments),
   `packages/core/src/types.ts`, `packages/components/src/types.ts`, `packages/editor/src/plan-types.ts`.
5. References: `docs/reference/look.md` (measured target look), `docs/reference/choreography.md` (field-tested
   cursor/click/typing rules), `docs/design-brief.md` + the mock-up canvas (Studio screens 1–7 and video frames in two
   themes): https://claude.ai/artifact/CEa9o9do5hr9AcLBajLRye (private to the owner).
6. `README.md` — the front page; `docs/guide/` — usage, scenario language reference, CLI (the README's reference
   sections since 2026-11-04; `docs/guide/README.md` maps an old "README › section" note to its page).
7. `docs/BACKLOG.md` — everything outside the locked MVP (unprioritised), guard-rails to apply when L1.2–L5.2
   start, recorder precisions for L3.4/L4.8, open decisions; **maintained by hand** from now on (the scratch files of its
   first version are not in the repo: edit it directly, next free id BL-130); `docs/COMPETITION.md` — competitive study
   (2026-10-12).
8. `docs/ACCEPTANCE-phase2.md` — the phase-2 acceptance (renders, reviews, the theme / component switch, R-CMP-01
   audit, own media, raw export validation).

## State (after the architecture series L6.1 – L6.13)
- **The architecture series done (2026-11-10; pending the person's review of the pull request)** — the tasks T1 – T14
  of the 2026-11-04 audit's [action plan](audit/action-plan.md), on branch `claude/arch-l6` (one commit per lot, then
  its review fixes). Code quality and architecture only: the existing behaviour is kept (the few visible changes are in
  the CHANGELOG's [Unreleased]); nothing was measured. The target is [audit/target-architecture.md](audit/target-architecture.md),
  the words are in [GLOSSARY.md](GLOSSARY.md).
  - **Guard rails (L6.1 – L6.2).** The import-rules ratchet (`scripts/audit/lib.mjs`, `rules.mjs --check |
    --write-baseline`, `packages/core/test/import-rules.test.ts`, baseline `scripts/audit/baseline.json`: one entry
    per (rule, file, import), each group with a reason; fails on new and on stale entries) — 99 entries after L6.8, 59
    now, R1 (I/O in the pure core) at 0, no import cycle. The glossary; `retake new --theme`; one path containment
    (`pathInside`), one canonical JSON, error kinds carried by the error classes.
  - **Engine (L6.3 – L6.6).** The job queue is a port (`JobQueueView` / `JobQueue`, `FileJobQueue`, `MemoryJobQueue`,
    one contract suite); one operation catalogue (`packages/engine/src/catalogue.ts`, facets effect / job / code /
    serves / removes / admission; `@retake/engine/catalogue` browser-safe) drives the CLI, MCP and the Studio; the
    admission rules (admission.ts) hold for the Studio and MCP (the CLI is exempt); one `Caller`; one project layout
    (layout.ts) and one `ProjectStore` for every authored write, with the workspace journal (`.retake/journal.jsonl`,
    `retake journal`).
  - **CLI and engine façade (L6.7).** The CLI's render / still / export / run / inspect call the engine's pipeline
    (`packages/engine/src/pipeline.ts`: planWork, renderWork, stillWork, exportWork, reviewWork; `in-process.ts`: the
    work then its history line); `createEngine` split by sub-API (`packages/engine/src/facade/`); four history writers,
    listed by a test; a CLI snapshot of 40 cases (`packages/cli/test/pipeline-cli.test.ts`).
  - **Core (L6.8 – L6.9).** App set-up and the MCP config snippet in `@retake/engine/integrations`; `@retake/core/io`
    (packages/core/src/io/) holds the readers, the Retake home and its key, secrets, file writers, bundle discovery and
    the media tools; the root of `@retake/core` does no I/O and reads three environment values only (named, pinned by
    a test). Disk facts through `FileFacts`, video probes through `VideoProber`. The work policy (`WorkPolicy`: agent
    folders, ffmpeg, render settings; `PERSON_POLICY`, `workPolicyFrom`) replaces the module-level policy state: the
    engine's opened workspace carries it (`agent` required when opening one) and every adapter receives it (`policy`,
    `workPolicy` in the editor's render options).
  - **Editor (L6.10).** `@retake/editor/plan` (the planner, its types, the frame geometry, the render records' reader)
    loads no renderer (a test traces it); `planEdit` is an orchestration of steps in `src/planner/`; the pure frame
    geometry is `@retake/components/geometry`; review imports the editor only through the plan entry and shares one
    ffprobe summary parser (core).
  - **In-page kit (L6.11).** `window.__retake` is built by esbuild (once per process, in memory) from
    `packages/runner-web/src/kit/page/*.ts`; every page module only declares (held by kit-build.test.ts), `main.ts` acts
    in the original order; the modules are type-checked with the DOM types and no Node types and not emitted; a golden
    of what the page receives, recorded from the kit as it was before.
  - **Studio data layer (L6.12 – L6.13).** A typed tool contract (`ToolDef<S, D, N>`, `defineTool` keeps the answer
    type); `StudioOps` derived from the Studio's tools (arguments as `/v1/call` parses them, results the tools' own; one
    narrowed result listed); only `src/app/data/` calls the API; `packages/ui/test/feature-boundaries.test.ts` holds
    the app's import boundaries.
  - **Worker (T14).** `runWorker` orchestrates named parts (`packages/engine/src/jobs/worker-*.ts`).
  - **Two full suites** at the end of the series: the first caught one regression of L6.9 (a run's shell hooks got
    no policy, through a structural type tsc could not check — fixed in `55cdcb4`, the mirrors now checked at compile
    time) and tests that L6.9 adapted without running; the second (2026-11-10, load average 25–38 on 10 cores): 5179 passed, 104 skipped, 1 failed — `mcp/test/stdio-theme.test.ts`'s refused agent-writable logo answered `not_found` (the file was missing when it was read; the order of the checks in `engine/src/brand/files.ts` is the one on `main`; the file passes 6 times in 6 alone) — and 1 unhandled rejection in the Studio e2e library-budget test's route handler at teardown; both noted, not fixed.
  - **Small behaviour notes:** a still's and an inspection's history `ms` leave out the status line and the gate's
    release (a few ms shorter); a run's history line is written before the capture marker is closed; the MCP stdio
    test's `job_cancel` destructive hint had been stale since L6.5; render bundles and the Studio player's bundle
    rebuild once (the geometry files joined their hash); a component README that is a symbolic link out of the
    components folder is refused (CHANGELOG).
  - **T15's rest (2026-11-10, after the series):** a CI on pull requests and main (`.github/workflows/ci.yml`: the
    build, the guards — one version, the import-rules ratchet, requirements tested and cited — and the default suite
    on macOS 15; the shell's rules on the pinned Rust; no secret, no cache, actions pinned like release.yml's;
    `packages/cli/test/ci-workflow.test.ts`) — the release does not wait for it yet (BL-144). On the runner (3 cores, no
    GPU) the tests calibrated on the Mac (capture frame rates, freezes, paint and wait timings) skip:
    `RETAKE_TEST_SHARED_RUNNER=1`, honoured in the ten files ci-workflow.test.ts lists (they run with the full suite on
    the Mac). Its first runs also found a focus race of the Studio's Set-up sheet (the focus was placed on the status
    before the reload: now after it) and three tests tied to the host (the appearance with no preference follows the
    host in Chromium; the take lock test now checks that no two holds overlap; the AppleDouble refusal may name any
    `._` member); the shell's Rust pinned in
    `apps/desktop/rust-toolchain.toml` (cargo runs from apps/desktop for the shell, from the repository root for the
    rules crate, which keeps any Rust 1.70+; the release workflow's version held equal by its test); one
    `onlyBuiltDependencies` list (pnpm-workspace.yaml: pnpm 10 never read package.json's); `.gitignore` patterns for
    signing material (`.p12`, `.p8`, `.key`, `.pem`, keychains, profiles, `.env.*`). The app bundle refuses a build
    output with no source (`staleBuildOutputs`: a `.js` in a package's `dist/` whose `src/` file is gone — `tsc -b`
    never removes it and `pnpm deploy` would ship it; nine such files sat in this checkout after the series' moves).
  - **Open:** T16 (the next audit's measures, not run: the person asked for no measuring in this series). The read-only
    audit of this branch, with its findings and action plan (U1 – U16):
    [audit/2026-11-10/](audit/2026-11-10/README.md).

## State (after L5.18)
- **L5.18 done (2026-11-09; pending the person's review of the pull request)** — hardening before the first release,
  the second of two lots (branch `claude/t-sec-2`, 7 commits on L5.17's `55b0da5`; requirements R-SEC-29 – R-SEC-37).
  - **One flag for the processes that serve agents.** core `useAgentPolicy(workspaceFolders)`, set or cleared by engine
    `openWorkspace`: on in the jobs worker and its job processes (they run every job alike, the Studio's and the
    desktop app's too), the MCP server and the Studio server; off in the CLI, whose behaviour is unchanged. The folders
    are the workspace's root and its projects, templates and components folders. core `bundle.ts` gets the policy's
    program check handed in (`setBundleProgramCheck`) and still imports nothing but `node:`. `retake doctor` warns
    about each workspace or project setting such a job would refuse.
  - **Programs.** Under the policy `browser.executable`, `$RETAKE_CHROMIUM`, the browser Playwright picks for a
    channel (its cache or `$PLAYWRIGHT_BROWSERS_PATH`), the render browser, ffmpeg / ffprobe (retake.yaml,
    `$RETAKE_FFMPEG`, `$RETAKE_FFPROBE`) and docker (`$RETAKE_DOCKER`, PATH) are refused when relative or inside the
    workspace folders (any spelling, links followed; a bare name PATH finds there too), and a program that passes is
    started by the real path that was checked (core `agentProgramProblem`, `policyProgram`). The worker a client starts
    keeps the tool variables as they are and fails a job that would use one inside the workspace, saying what to
    change. No render downloads a browser: without a headless shell no render starts (editor `assertRenderBrowser`),
    the message and doctor's Render browser line give the install command.
  - **Browser switches.** Under the policy `browser.args` hold switches only, from an allow-list (core
    `AGENT_ALLOWED_SWITCHES`; features that take the network service out of its sandbox refused,
    `AGENT_REFUSED_FEATURES`), checked at launch; the always-refused switches of L5.17 apply to everyone; the CLI
    keeps every other switch. The allowed list is in docs/guide/workspace.md.
  - **Environment.** Under the policy shell hooks and their rollbacks, docker / compose and process-sandbox services
    get core `childEnv`: `CHILD_ENV_BASE` (PATH cleaned of relative and workspace entries, HOME, user, shell, locale,
    time zone, proxy and certificate variables), project.yaml `pass_env:` (new; a loader variable is a validation
    error) and, for docker, `DOCKER_CHILD_ENV` by name; an unsigned rollback gets the base only. The worker keeps its
    own environment for `{{env:}}`. A failed hook names the variables it saw (never values) and how to pass one.
  - **Another project's production hosts.** The guard of MCP / Studio work compares the server a host reaches (core
    `canonicalIp`, `canonicalAddress`; engine `protected-hosts.ts`): loopback names and addresses as one, an
    IPv4-mapped address as its IPv4 form, a name beside an address resolved (one 2 s deadline per check), a name that
    does not resolve in time counted as a match.
  - **The Studio's token and link.** `.retake/ui.json` (version 2) holds no secret; the token is in
    `<RETAKE_HOME>/ui/<hash>.token` (0600, replaced by rename, links and loose modes refused) with its port; a reuse
    goes through that record only; a server of another Retake home or an older record is told, nothing sent to its
    port; `retake ui` refuses a Retake home inside the workspace. On macOS the one-time link reaches the browser through
    `/usr/bin/osascript`'s standard input, else a private 0600 `.webloc` opened by `/usr/bin/open`, never a program's
    arguments.
  - **MCP over HTTP.** `retake mcp --http` on a taken port looks up the listener (`lsof`, `ps`, absolute paths, short
    timeouts, retried once): this account's own server gets the port-busy answer, any other or unidentified listener
    is refused with the advice to stop it and `--rotate-token`; `--print-config --http` and the guide say stdio is the
    safe default. The rest (a check per connection, clients that verify the server) is BL-162.
  - **The person's decisions (2026-11-05):** the defaults proposed for each choice, L5.18 before the v0.2.0 tag.
  - **After the upgrade:** stop every Studio of the older build (a terminal's `retake ui`, the desktop app) before
    starting the new one — an older build reads a version-2 ui.json as broken and would start a second server on the
    workspace (docs/guide/upgrading.md); the new build tells an older server apart and opens nothing until it stops.
    A Studio or MCP job whose workspace names a program inside it, a `browser.args` switch outside the list, or relies
    on an exported variable a hook or a compose file reads, now fails with what to change (`pass_env:`, move the
    program out); `retake doctor` lists them first.
  - **Tests on the Mac:** `tsc -b` green; the full suite on c6 **4919 — 4810 pass, 104 skipped, 5 failures**: core
    app-bundle's damaged-manifest import (fixed by c7, 22/22 after), engine brand-files with TMPDIR at a scratch link
    (75/75 with the default TMPDIR), capture-pause's two frame-timing tests under load, and app-bundle's
    renderBundleRestriction failing the same before this lot (webpack not resolvable from packages/editor); the files
    this lot touched 476/476 (22 skipped: Docker, desktop) after c7; `pnpm test:slow` 85/85; `pnpm test:pg` 20/20. The
    gated bundle acceptance did not run offline (corepack wanted to download pnpm; tauri's crates not all in the cargo
    cache). Not run: `desktop:test`, the Docker sandboxes, the update end to end. Requirements: 733 tracked — 689 done,
    30 partial, 8 todo, 6 n/a-here.
  - **For the person, by hand:** a Studio and an MCP client on the new build after stopping the old one; a docker
    sandbox from the Studio (DOCKER_* by name, `pass_env:` for what its compose file reads); the bundle acceptance with a
    network. Cut: BL-162. Next: the first release v0.2.0 (the person tags).

## State (after L5.17)
- **L5.17 done (2026-11-05; pending the person's review of the pull request)** — hardening before the first release,
  the first of two lots (branch `claude/t-sec`, 17 commits on `632f2d8`; requirements R-SEC-11 – R-SEC-28). One home
  for the rules of agent work: core `agent-policy.ts` (loader variables, the shell grammar and its rules per word, the
  URL rule, the Chromium switches; the worker's environment cleaning reuses it).
  - **Approvals and hooks.** A job runs the scenario bytes it was submitted with (core `readScenarioSource` /
    `loadScenario` with `expectSha256`, `ScenarioChangedError`; a scenario hooks job carries `scenario_sha256`, signed
    with its approvals; the worker refuses a missing or different hash as a conflict). The approval form shows every
    hook in full — each kind's fields and its rollback, templated, secrets as ***, hidden characters written out, names
    and keys escaped (hooks `describe.ts`, `shown.ts`; built once in engine `approvals.ts` for MCP and the Studio); a
    hook over 4,000 characters or a form over 16,000 is refused before anyone is asked (run it in a terminal). Under
    trust mcp a hook the agent wrote (a scenario's own, or a project.yaml hook rendered with the scenario's vars) sets
    no loader variable, and its shell run and rollback are **plain words** (letters, digits and `. / : = @ % + , _ -`)
    separated by single spaces and joined by ` && ` only — a length check, then one linear pass — then rules per word
    (cd and its kin, eval / exec, inline interpreter code, package runners, git -c, paths through a folder an agent can
    write, files an agent writes), no secret and no saved response value; its cwd is one plain word, its env names
    identifiers. Checked at submit and again by the worker; a rollback recorded from such a hook carries the mark under
    the entry's signature and is checked again when replayed. The refusal says: put the hook in `hooks/<name>.yaml` or
    run it in a terminal; a person's hooks and the CLI are unchanged. An agent's `project_prune {dry_run: false}` asks
    the person in the approval form (count, size, kinds, at most 20 items) and deletes only what they saw that can
    still go; no form, a decline or no answer deletes nothing.
  - **URLs and browsers.** A scenario opens http:, https: or exactly about:blank, without sign-in details (core
    `navigationProblem`; a validation error at the field otherwise, for every client); under agent trust, once the
    environment is known (validate, submit, the worker), an absolute URL needs the exact origin of an environment page
    (`canonicalOrigin`; "add the origin as a page in project.yaml"; the Studio's blocker "opens another site"). The
    runner checks every URL it opens once templated and resolved (runner-web `opens.ts`; prewarm leaves a refused one
    out), and every capture, rehearsal and inspection realm arms a CDP Fetch guard that fails file: (the HTTP cache
    kept). Every capture browser runs in Chromium's OS sandbox with site isolation asked for (runner-web `launch.ts`
    `launchOptions` at every launch site, kept by a source scan; each launch reads the running browser's command line
    and refuses one without its sandbox; doctor says whether it is sandboxed and tells a root user to run as a regular
    user); `browser.args` refuses the switches that turn the sandbox or site isolation off or open the browser to other
    code. The notification and cursor bindings answer the main frame only, within limits (50 notifications and 20
    icons per run; an icon a data: URL or an allowed origin's, ≤ 1 MiB, no redirect followed; 60 cursor effects a
    second). Sign-in details in an environment page URL are taken out of it and given to the capture, sign-in and
    recording browsers as HTTP credentials for that origin only (core `environmentHttpCredentials`; one origin, one
    set), never in what a run writes.
  - **Renders.** A pnpm patch of `@remotion/renderer` 4.0.534 (`patches/`, its CommonJS and ESM builds): on macOS the
    render browser runs in Chromium's OS sandbox with `--site-per-process`, checked on its command line at every launch
    (editor `render/policy.ts`); the bundle server listens on 127.0.0.1 and ::1 only, fails closed when ::1 is taken,
    answers 421 to another Host and 403 to a cross-origin request. `apps/desktop/scripts/bundle.mjs` refuses a stage
    whose renderer lacks the patch and scrubs the deployed engine's pnpm settings (its manifest names no file of the
    build machine). docs/RELEASING.md "A Remotion upgrade" says how to port the patch; BACKLOG notes its licence terms
    before a sale. Linux renders run as Remotion starts them (BL-161).
  - **Release workflow.** No cache anywhere; Node.js in every job from its official tarball, checked against
    `apps/desktop/bundle/node.json` before anything of it runs (`apps/desktop/scripts/ci-node.sh`, darwin-arm64 and
    linux-x64; no setup-node); `packageManager` with pnpm's sha512 (corepack checks it); the sign job reads the build
    archive's tar members itself and unpacks only `app/Retake.app` and `tauri-cli` (release.mjs `unpack`), signs the
    update archive with a fresh temporary copy of the pinned Tauri CLI, and checks bundle.json's version against
    Info.plist and `--app-version` before anything is signed; a reused stage of another version is refused.
  - **The person's decisions (2026-11-05):** two lots before the release (L5.17, then L5.18 for the rest); the defaults
    proposed accepted; the plain-word grammar for agent-written shell hooks (anything richer lives in
    `hooks/<name>.yaml`, a person's file, shown and asked about); the Remotion patch (ported at each Remotion upgrade);
    sign-in details in a page URL kept working, as HTTP credentials.
  - **After the upgrade:** a scenario hooks job queued before it carries no `scenario_sha256`: the worker refuses it once
    ("submit it again").
  - **Tests on the Mac:** `tsc -b` green; the full suite **4851 — 4735 pass, 104 skipped, 12 failures, each re-run
    alone**: stdio-site, stdio-inspect and stdio-runs green with the real HOME (with HOME at a scratch folder the worker
    found no browser), run-live 9/9 with the default TMPDIR (a long scratch TMPDIR pushed a hook name past its
    200-character limit), app-bundle-build a real regression fixed (its stand-in stage lacked the patched renderer;
    33/33), app-bundle's renderBundleRestriction failing the same on main at `632f2d8` (webpack not resolvable from
    packages/editor: not this lot); `pnpm test:slow` 82/83 (now with `launch-options.test.ts`; the catalogue acceptance
    froze under a load of ~30, 8/8 alone); `pnpm test:pg` 20/20; the gated bundle acceptance 8/8 (352 s; its first run
    found the deployed manifest naming build-machine paths, fixed). Not run: `desktop:test`, the Docker sandboxes and the
    update end to end (nothing of theirs changed). Requirements: 724 tracked — 680 done, 30 partial, 8 todo, 6 n/a-here.
  - **For the person, by hand:** a headed `retake login` and `retake record` with the sandbox (the tests run those
    windows headless); a staging site behind basic auth, its details in the environment page URL; the first tagged run
    of the release workflow (or a run on a fork) — Node.js downloaded and checked on GitHub's runners; the GitHub
    settings checklist in their private notes. Cuts: BL-160 (the bundled Chromium bumped in one command), BL-161
    (sandboxed browsers on Linux, as root and in containers). Next: L5.18, then the first release v0.2.0 (the person
    tags).

## State (after L5.15)
- **L5.15 done (2026-11-05)** — renders on the GPU (BL-114). One policy for every Remotion browser (editor
  `render/policy.ts`, `openRenderBrowser`; core `render-settings.ts`, `gpu.ts`): `render: {gl: auto|gpu|software,
  encoder: auto|videotoolbox|libx264, concurrency}` in retake.yaml, then `RETAKE_RENDER_GL / _ENCODER / _CONCURRENCY`,
  then auto (the CLI's `--concurrency` wins for its command). On a Mac with a GPU (CDP SystemInfo when the browser
  opens): ANGLE + VideoToolbox at concurrency 3; without one: today's software path at today's concurrency (never
  swangle: 10× slower). VideoToolbox only after a probe through the compositor's own ffmpeg (`callFf`, nullsrc, at the
  render's size, cached per process) and each side ≤ 4096 (above: libx264, said); `hardwareAcceleration: 'required'`,
  0.13 bit per pixel per frame (8 Mb/s at 1080p30, 32.5 at 4K), `gopSize` 2 × fps. A GPU-path failure classified
  narrowly re-renders once in software + libx264, guarded and reported again, progress never going back. A guarded
  render never lets Remotion open a browser of its own (`browserExecutable: '/dev/null'`, network-guard.ts): a frame
  whose page fails ends the render plainly (after the one guarded software retry on the GPU path). `guardEncoderPipe`:
  no process crashes on a broken encoder pipe. The record's `policy` (asked / resolved / used, GPU name, fallback) and
  `encoding`; doctor's "Renders" line; the Library key carries the resolved GL. **Tests pin the software path**
  (vitest.setup.ts and `packages/core/test/child-env.ts` for children with an explicit env;
  `RETAKE_TEST_RENDER_POLICY=keep` lifts it); GPU tests opt in and compare SSIM. Measured (DESIGN §4r): 1080p 454 →
  186 cpu-s, 77 → 64 s, p95 7.3 → 3.8 cores, 10.5 → 24.4 MB; 4K 1 380 → 438 cpu-s, 210 → 103 s; SSIM vs today ≥ 0.9936.
  **The captures-first acceptance on the GPU path did not pass** (beside takes 57.6 / 57.7 / 55.1 against 56.7, dropped
  median 5 against 4; the render still slowed 30 → 6.5 frames/s during takes); the person chose to commit and re-run it
  on an idle Mac (R-CAP-03). Tests on the Mac: the last full run 4585 — 4480 pass, 102 skipped, 3 failures (one real,
  fixed: the ffmpeg needs scan now knows the probe runs the compositor's ffmpeg; two load flakes green alone);
  `pnpm test:slow` 65/65; `pnpm test:pg` 20/20; the gated bundle acceptance 8/8 (the signed app renders with ANGLE +
  VideoToolbox); Docker 6/7 (K6, as before); **the gated desktop shell 9/19 — the same 10 tests fail on main 4d87a93
  too** (they wait for the page's pending snapshot; environment of that night, the display possibly asleep — re-run
  with the display awake). Requirements: 706 tracked — 662 done, 30 partial, 8 todo, 6 n/a-here. Cuts: BL-152 – BL-159.
  Next: the audit (docs/audit/), then the first release v0.2.0 (the person tags).

## State (after L5.14)
- **L5.14 done (2026-11-04)** — captures first, on the file queue (the person's decision: no new dependency; BL-117 is
  parked). **L5.14a**: core `JOB_CLASS` / `jobClass` / `isFilming` (the class from the worker's view, never a job field);
  `packages/engine/src/jobs/` — `pick.ts` (pure claim order: captures first), `captures.ts` (per-user filming markers in
  `getconf DARWIN_USER_TEMP_DIR`/retake-captures, 0700, `RETAKE_CAPTURES_DIR` to override, a heartbeat, a cap of
  `RETAKE_CAPTURE_HOLD_MAX_MIN` = 60 keyed on pid + start time, a random workspace id), `yield.ts` (background QoS by
  `taskpolicy -b/-B` on a held heavy job's whole tree, new pids only, the QoS before kept), `job-child.ts` + `worker-main
  --job` (a heavy job in its own process group), `signal.ts` (one guard for every signal: never -1, 0, 1, the worker or
  its group), the worker's two slots, recovery that proves a job process (host, start time, command line) before
  signalling it; the CLI's `heavy-gate.ts` (`render`, `still`, `export`, `review`, `export-capture`, `run --raw`'s export
  wait, then yield; `--no-wait`); `vitest.setup.ts` gives every test file its own markers folder (**never export
  `RETAKE_CAPTURES_DIR` for a whole suite**: the files then share one folder and hold each other). **L5.14b**: a held job's
  `yield` derived on read (`jobs/held.ts`: waiting / background / past_cap, "in this workspace" / "elsewhere on this
  Mac", never another workspace's name) in MCP (`job_status`, `job_list`, `render_status`, `engine_info.held`), `retake
  jobs`, the Studio's render rows, Lately and status bar, doctor's "Captures first" line; the take's sampler reads the
  worker's own hold (`.retake/workers/held.json` for a terminal take), never the job folders; a take's report
  `perf.machine.takes_beside` / `heavy_slowed`. Trust: core `home-key.ts` (the home key created atomically, the home
  0700); rollback-journal entries signed with it for where their journal stands (project, runs/ vs .retake/journals/,
  relative path, seq) and replayed once (`<RETAKE_HOME>/rollbacks-done/`); work submitted through MCP or the Studio
  replays only signed entries; a terminal lists first and replays an unsigned entry only with `--replay-unsigned` on a
  TTY, per entry, never a sql / js one, one with secrets or a shell one on a sandbox; approvals signed for the job id and
  workspace (payload v3) and used once at claim (`<RETAKE_HOME>/approvals-used/`, given back on unclaim); the job process
  refuses a claimed record whose digest differs (`--digest`, exit 4). **Journals from before L5.14 or another home** need a
  person in a terminal (`--replay-unsigned`). Measured spike and acceptance in DESIGN §4q; the gated acceptance
  (`RETAKE_TEST_CAPTURES_FIRST=1 npx vitest run packages/ui/test/captures-first-acceptance.test.ts`, ~10 min) concludes
  only on a quiet Mac. Tests on the Mac: the last full run **4538 — 4435 pass, 102 skipped, 1 failure** (capture-pause B1,
  a load flake: 3/3 green alone; the first full run's failures came from a shared markers folder, see above, plus one
  real one fixed — an unstyled class name); `pnpm test:slow` 65/65; `pnpm test:pg` 20/20; the gated desktop shell 19/19;
  Docker 6/7 (K6, the environment as before). Requirements: 700 tracked — 657 done, 29 partial, 8 todo, 6 n/a-here.
  **The measured acceptance has not concluded with its final rule**: three runs on 2026-11-04 refused ("machine not
  quiet" — other sessions' load; one alone take at 24.5 fps), the quiet gate's alone spread then set to the spike's
  (10 fps); the person chose to commit and run it with L5.15 (R-CAP-03's gap). Run 3 under the first rule: beside takes
  57.7 / 58.6 / 56.5 fps against alone 58.5 / 57.7 / 58.7, the render slowed to ~6 frames/s and back to ~27, frames
  identical.
  Cuts: BL-146 – BL-151 (one take at a time per Mac, Linux / Windows, one heavy job per machine, other workspaces' queued
  takes, adoption of a held job, SIGSTOP with its numbers). Next: L5.15 (it re-runs the spike's S4 for QoS with BL-114's
  settings), then the first release.

## State (after L5.16)
- **L5.16f done (2026-11-04)** — the update feed moved to GitHub (the person's decision: no self-hosted host): a fixed
  `update-feed` pre-release holds `latest.json` / `rc.json`, each tag's release its archive, `.sig` and
  `platform-darwin-aarch64.json`; `scripts/publish-update.mjs` publishes through the GitHub REST API with the workflow's
  own token (checks before any request; the version's release must be public and hold the same bits; a channel replaced
  through a temporary asset, re-read before each delete, never moved back, never left missing by our side; request
  timeouts and retries), the feed URL from the workflow's context (`scripts/release.mjs feed`), the repository's
  visibility checked in the preflight, the app's updater client https-only on every redirect. No `UPDATES_*` setting
  any more: the person sets the seven Apple secrets, the two updater secrets and `RETAKE_UPDATE_PUBKEY`
  (docs/RELEASING.md, which also asks for a ruleset on the `update-feed` tag and immutable releases OFF). Tests: the last
  full run 4436 — 4335 pass, 101 skipped, 0 failures; the gated update end to end 3/3 through redirects. Next: L5.14,
  then L5.15, then the first release (the person tags v0.2.0).
- **L5.16 done (2026-11-04)** — the standalone app, in five parts. **L5.16a**: a relocatable engine — one resolver
  order for every tool (retake.yaml → RETAKE_FFMPEG / FFPROBE → the app's own → PATH, `bundle.json` beside core), every
  ffmpeg spawn through it, the H.264 fallback to VideoToolbox, `retake init`, version 0.2.0 everywhere, the staged tree
  (`apps/desktop/scripts/bundle.mjs stage|check`: hoisted offline pnpm deploy, the app's own Node.js, the browsers,
  Remotion's compositor relinked, our own GPL ffmpeg from `scripts/build-ffmpeg.mjs` with x264 / libvpx / opus,
  licences in `apps/desktop/licenses/`). **L5.16b**: `pnpm desktop:bundle` builds Retake.app + an hdiutil DMG offline —
  launch.json v2, the launcher `Contents/Resources/bin/retake`, the module-lookup guard (`apps/desktop/bundle/guard.cjs`:
  no package resolved from a node_modules above the app, render bundler included), inside-out signing from one table,
  an allow-listed build environment, the Tauri CLI pinned file by file, a deep verify; `pnpm desktop:release` signs
  with a Developer ID, notarises (zip, then the DMG) and staples, credentials never on a command line. **L5.16c**: the
  first run (Create ~/Retake · Choose a Folder… · Quit), where the app runs from (translocated / read-only refused), the
  Set-up sheet (`#/setup`: the `retake` command link, Claude Code on a click, Claude Desktop merged after a preview with
  a backup, notifications), Studio-only setup ops (never MCP tools), two copies of Retake said, the Chromium-major
  profile guard. **L5.16d**: the updater modelled on a static feed on the person's own host (`<app>/latest.json`,
  `rc.json`, `<tag>/…`): tauri-plugin-updater behind a cargo `updater` feature, on only in a build given
  RETAKE_UPDATE_FEED + RETAKE_UPDATE_PUBKEY, a check at most once a day, "Update available · vX" → Install and Restart
  through the quit guard after the jobs, our own signed tar archive, `scripts/publish-update.mjs`,
  `scripts/set-version.mjs`, CHANGELOG.md. **L5.16e**: releases by GitHub Actions on `v*` tags (the repository is public
  since 2026-11-04, the person's decision): `.github/workflows/release.yml` — `release` (checks, draft) → `build`
  (macos-15, no secret) → `sign` (a fresh runner in the `release` environment that runs only our scripts: Developer ID
  from a temporary keychain, notarisation by App Store Connect API key, the DMG, the update archive) → `attach` (draft
  only) → `publish`; action pins, Node.js and browser digests pinned in the repo (`apps/desktop/bundle/node.json`,
  `browsers.json`); docs/RELEASING.md lists the secrets, variables and GitHub settings. The DMG is distributed publicly
  with BL-138's licence risk accepted for own use (resolve before a sale). Tests no longer write into ~/Library
  (CFFIXED_USER_HOME for every child; a teardown warning, `RETAKE_TEST_LIBRARY=strict` fails). Tests on the Mac: the
  last full run **4422 — 4321 pass, 101 skipped, 0 failures** (the earlier full run's 3 failures: one test outdated by
  part a, fixed; two load flakes green alone); `pnpm test:slow` 65/65; `pnpm test:pg` 20/20; the gated desktop shell
  19/19; the gated bundle acceptance 8/8 (`RETAKE_TEST_BUNDLE=1`, app ≈ 990 MB, DMG ≈ 425 MB) and the update end to end
  3/3 (`RETAKE_TEST_UPDATE=1`); Docker 6/7 (the K6 exec-seed interrupt test, environment as in L5.13). Requirements: 692
  tracked — 649 done (R-APP-01 – 18), 29 partial, 8 todo, 6 n/a-here. **For the person:** the GitHub settings and
  secrets (docs/RELEASING.md), then the first tagged run (MACOS-CHECKLIST 15b — its digests may need a refresh), the
  installed app by hand (15a, 15c), an update against their feed (15d).

## State (after L5.13)
- **L5.13 done (2026-11-03)** — the rename to Retake, everything at once with no alias (L5.13a), and the "two takes"
  mark (L5.13b). **L5.13a**: the command `retake`, packages `@retake/*`, variables `RETAKE_*`, the home `~/.retake`, the
  workspace file `retake.yaml`, the tool folders `.retake/`, the MCP server / plugin / skills `retake` (`retake@retake`,
  `retake-scenario` / `-theme` / `-component`, plugin key `cli`), the desktop app `Retake.app` (`local.retake.desktop`),
  Docker objects `retake-*` (approved by the user), all done by a committed, deterministic script
  (`scripts/rename-l513.mjs`, tracked files only, idempotent) plus hand changes. An existing installation is told, never
  migrated: the old names the code still knows live only in `packages/core/src/legacy.ts` and `packages/engine/src/legacy.ts`
  — a stderr line at CLI start, `engine_info.legacy` (MCP summary + a Studio sidebar note), the preflight hint and doctor's
  "Before Retake" group (old home or the folder an old home variable names, old variables, the workspace file, old tool
  folders with pending journals, project `.gitignore`s), each with the exact command; an old workspace file is refused
  only when it is the tool's; nothing starts beside a live old Studio / worker (lock.ts's pid + start-time rule). Safety
  lists keep the old names on purpose (the old tool folder stays agent-writable = never run as code; the worker drops the
  old MCP token; outgoing hook / sandbox variables are written under both names for the person's product code). A guard
  test (`core/test/old-name.test.ts`) keeps old names out of every tracked file and path except tagged lines / regions in
  listed files; vitest gives every run a temp `RETAKE_HOME` and refuses the real homes. Kept, not old names: the built-in
  `studio/` component namespace, the `studio` comment channel, `studio:*` page events, "the Studio" (the web app).
  **L5.13b**: the mark "Nette" as validated (full with the play triangle; small and tiny without), one source
  `packages/ui/src/mark.ts`, colours in tokens.ts, the kit `AppMark` in the title bar / Welcome / gallery, the favicon as a
  data: URL (CSP unchanged), `pnpm -F @retake/ui gen:mark` → `apps/desktop/icons` (svg, 1024 png, the 16 / 32 pt iconset
  slots drawn from the small variants, icon.json), the icns step requiring them; tests compare every committed PNG with
  its SVG rasterised again. Tests on the Mac: **4144 — 4052 pass, 88 skipped, 4 failures in the one full run**: two
  mechanical leftovers fixed after (an alphabetical order, a Rust test name), two load flakes green alone (capture-perf,
  run cancellation); `pnpm test:slow` 63/65 then 65/65 (the plugin test's userConfig key fixed; the catalogue's freeze
  check green alone); `pnpm test:pg` 20/20; the gated desktop shell 19/19 (Retake.app); Docker 6/7 — the K6 exec-seed
  interrupt test times out on this Mac's Docker on the pre-rename main too (environment, not this lot). Requirements: 674
  tracked — 633 done (R-REN-01 – 04 added), 27 partial, 8 todo, 6 n/a-here. Live checks for the user: README's upgrade
  section on their own installation, MACOS-CHECKLIST 14f (the renamed app: notifications and Local Network asked again)
  and 14g (Dock / Finder icon).

## State (after L5.12d)
- **L5.12d done (2026-11-03)** — L5.12 is complete and the Studio has no legacy layer left. **The desktop quit question
  is a kit Sheet in the window's page**: the shell builds the words (`words.rs`), dispatches `studio:quit` to the Studio
  origin only, the page acks once the sheet is painted and visible and answers through a new Studio-only op
  `desktop_answer` (strict, supervised only, an answer never dropped) written on the server's pipe; a pure state machine
  (`core/src/guard_flow.rs`) holds the rules — ids used once, APPROVED tied to the answer and expiring, every exit closes
  the page sheet, no ack in 1.5 s → the native alert, a second ⌘Q after 10 s → native, logout / restart / shut down stay
  native. The buttons sit in the alert's order and keys (Return never quits). **The end of legacy**: bits.tsx's Badge /
  Notice / Loading gone, main.tsx's Connecting / start error / Ended / not-found on the kit, app.css deleted (base.css:
  element defaults on --ui-* tokens; body text 13/18), the legacy tokens removed, legacy-controls.json `{}` (the ratchet
  asserts zero findings everywhere); a reduced-motion lint (cascade order checked, scroll calls `behavior: 'auto'`) and an
  "every className word is defined" lint. Tests on the Mac: **4079 — 3990 pass, 88 skipped, 1 failure in the one full run** (a runner-web capture-size check, a cursor box
  1 px over under load, untouched by this lot: green alone); `pnpm test:slow` 65/65; the gated desktop shell 19/19 (the
  sheet shown in ~100 ms, the native fallback after ~1.6 s). Requirements: 670 tracked — 629 done (R-DSK-04 / R-UI-50 added), 27 partial, 8 todo, 6 n/a-here. Live checks for the user:
  MACOS-CHECKLIST 14e items 12–13 (the sheet with VoiceOver, a minimised window or another Space, a hung page, logout
  keeping the native alert, Reduce Motion, the Ended screen in the app).
- **L5.12c done (2026-11-03)** — **the Library** in the shell from R4-Library: the browser's Library group and the
  project's themes, the title-bar Theme select, Source · Kind · search, sections of poster cards (one tab stop with
  arrow keys; Play a one-name toggle; the selection ring over the whole card), the selected card's inspector (facts,
  Play in the theme, Open the details, Create with Claude…, Set as default…, About — rendered once, so a starter's
  copy-and-set keeps its result after moving to the copy), the detail route with kit DataTables; Create with Claude,
  Set as default and copy-first as kit Sheets (Return runs the default from a name field). **The Themes list and the
  theme editor**: the theme's sections in the browser, ONE live preview with an Intro · Clip · Outro switch, ThemeFields
  in the inspector on a new kit ColorField (drafts while dragging, writes on release; a `version` reset so a refused
  colour is never re-sent), Copy to edit as a Sheet, the New theme form on kit fields. Write rules: LIBRARY_OPS per
  file, every theme_edit carries if_match, and no aliased / namespace import of the api's `call` anywhere in the app
  (`apiImportFindings`). Ratchet −603 (LibraryScreen, ThemesScreen, ThemeEditor → 0; bits 5 and main 10 left for d).
  Tests on the Mac: **4058 — 3974 pass, 84 skipped, 0 failures in the one full run**; `pnpm test:slow` 65/65; the gated themes acceptance green once. Requirements: 668 tracked — 627 done (R-UI-49 added), 27 partial, 8 todo, 6 n/a-here. Live checks for the user: MACOS-CHECKLIST 14e (the system colour
  picker, VoiceOver on the cards and the "not set" words, a real loop playing, 900 px).
- **L5.12b done (2026-11-02)** — the Review mode's **Comments** view in the shell from R4-Comments: the thread list in
  the browser pane (Open · Resolved · All, "This render only", rows as links), the frame in the centre (FrameViewer:
  region drawing with the x / y / w / h fields as its keyboard alternative, the scrubber, marks and pins, typed time),
  the Composer, the thread and Claude's proposal in the inspector (ThreadPanel, ProposalCard on a new kit DiffTable —
  code-safe as before: `[U+…]` marks, `dir=ltr`, RTL lines labelled, every row shown), the proposal banner on Edit
  (never applies). ProposalPanel.tsx and CommentsTab.tsx deleted; both Review views share one status line ("Rendered ·
  when · vN · n open · n resolved · Open in Edit · Render"). **The README editor** on the kit. **The ⌘K palette** per
  R4-Palette (640 px, an icon per row, Commands · Go to · Scenes · Themes · Scenarios · Projects through a
  `paletteGroup` registry, the report row in review words, a footer legend; it never writes). The write rules of the
  comments side are structural (an allowed-ops list per file, an import graph for the proposal's writer, `if_match`
  read on each write's arguments, the palette's handlers traced to no writer); the a11y checker skips what a modal
  dialog makes inert. Ratchet −339 (CommentsScreen, CommentsTab, ProposalPanel, ReadmeEditor → 0). Tests on the Mac:
  **4034 — 3950 pass, 84 skipped, 0 failures in the one full run**; `pnpm test:slow` 65/65; the gated comments Chrome acceptance green once. Requirements: 667 tracked — 626 done (R-UI-47 / R-UI-48 added), 27 partial, 8 todo, 6 n/a-here. Live checks for the user: MACOS-CHECKLIST 14e (VoiceOver on the diff and the
  frame line, the palette by keyboard and its footnote in the app, WebKit's composition Enter, the README at 900 px).
- **L5.12a done (2026-11-02)** — L5.12 is split in four (the plan sized it L+: a Edit and the Review report, b comments /
  proposal / README / ⌘K, c Library and the theme editor, d the quit sheet and the end of the legacy layer). **Edit** in
  the shell from R4-Edit: the pinned PreviewFrame (the Player on its own origin, unchanged) with EditPreview / EditStatus
  / EditNotes, the tracks on new kit pieces (Track / TrackItem / Scrubber / Playhead; the playhead never re-renders the
  tracks: 0 track renders over 10 seeks on a 1,200-step scenario), the inspector on kit ChoiceChips (the selected segment
  first and announced; ⌘Z while a switch is written is queued and said, dropped and said if that write fails), the
  browser pane collapsed. Edit owns Render at screen priority through `useRenders` (refused on a proposal route in every
  state — never renders the file on disk; a 409 re-reads), Cancel render and the latest render's version note in its
  status bar. **The Review report** (`#/…/review[/<render id>]`, a malformed id is not found; Report first, the View
  switch Report · Comments in the title bar): counts in words, never "passed"; contact sheets one at a time; checks
  grouped by family (a `role=group` each in one listbox); the selected check's frame and Show in Edit (seeks only on the
  same version); the renders list (newest first, links); Render again; **Export video (MP4)** through a new Studio-only
  op `review_export` (the existing engine export job, MP4 1080p into the fixed `exports/<render id>/`, path-free, one per
  render and at most 2 open across the workspace); the raw capture stays a copied command. The scenario's renders card is
  on the kit. Ratchet −294 (Timeline*, PreviewFrame, Renders → 0), their legacy CSS and 12 legacy tokens removed. Tests
  on the Mac: **4023 — 3936 pass, 84 skipped, 3 failures in the one full run** (the op allow-list test missing
  `review_export`; the keyboard-only path, real: a Player frame left a delayRender handle open when two loads came in a
  row and never said "settled" — fixed in `player/frame-main.tsx`; a scenario-screen read count that passed alone, under
  load); every failed file green again alone; `pnpm test:slow` 65/65; the gated Chrome timeline / comments, themes and
  R-ACC4-01 acceptances green once each. Requirements: 665 tracked — 624 done (R-UI-45 / R-UI-46 added), 27 partial, 8 todo, 6
  n/a-here. Live checks for the user: MACOS-CHECKLIST 14e (the H.264 preview, ⌘B from the menu, VoiceOver, an export
  landing in exports/).
- **L5.11b done (2026-11-02)** — L5.11 is complete. The Record screen rebuilt on the kit inside the shell from
  R4-Record: the start form in the centre (Location / Page / Persona selects, Path / Name fields), the Recordings group in
  the Shoot browser (live state, location, step count, Open the saved scenario); the live recording — the draft as one
  tab stop (a listbox per scene with arrow / Home / End / PgUp / PgDn keys, Enter selects = moves the insert point), the
  selected row's alternatives as a kit RadioGroup (the requested choice shows at once; one change in flight, the newest
  pick queued), the Insert toolbar (Hold 2 s, Wait for…, Caption…, Mark, Zoom… with the theme's factors, Back to the
  end; a typed form survives the block moving), the inspector (Started with + Name, the selected step, Stop recording,
  Save as new scenario with why it waits, Discard through a kit Sheet whose default is "Keep it", Check / To look at /
  Secret fields / Writes / Warnings). The status bar is claimed on the Record route while a Studio recording is live
  ("Recording · browser window open · n actions · n inserts · draft updated …"); ⌘. stops the recording (never a run,
  after a reload too), Rehearse / Capture / Render say why and send nothing; the ⌘K palette offers Stop recording /
  Discard… named after the recording. One Stop (in the inspector; in the head beside the time when the inspector is
  hidden). RecordScreen left the kit ratchet (274 → 0); about 265 lines of legacy CSS removed. Tests on the Mac: **4000
  — 3916 pass, 84 skipped, 0 failures in the one full run**; `pnpm test:slow` 65/65; the gated record and Chrome
  acceptances green once each. Requirements: 663 tracked — 622 done (R-UI-44 added), 27 partial, 8 todo, 6 n/a-here.
  Live checks for the user: MACOS-CHECKLIST 14d (item 9: the real window, ⌘. while typing, VoiceOver, 900 px).
- **L5.11a done (2026-11-02)** — L5.11 is split in two (the plan sized it L): Shoot without the Record screen, from
  R4-ShootPrep / R4-ShootLive / R4-Confirm. **Prepare a take**: a checklist (location, sessions this run signs in with,
  what would stop a run, the live picture switch), each blocker a state word + one line + its Copy command (the command
  wraps in full: what is copied is what is shown), Start rehearsal / Start capture in a sticky footer. **The live
  rehearsal or capture** (L4.4's picture, steps, log, Pause on L5.7's clock, Stop) and its outcome. **The status bar's
  actions on every screen** (Rehearse · Capture · Render · Stop, the blocker in one line with a "Command…" popover)
  through a command bus with explicit priorities (defaults 0, a screen 10, a live recording 20); the desktop Scenario
  menu (⌘R ⇧⌘R ⌘B ⌘.) on the same command table; in a browser tab the keys stay unbound and the ⌘K palette offers them.
  **The Cast** on the kit with the Sessions panel; **the confirmation sheet** (a capture with a session that may not
  work: Cancel / "Sign in … first…" (default) / "Capture anyway", never on Return). A new Studio READ op
  `scenario_actions` (its own 64-entry memo, single flight, never in the scenario view's cache; blockers carry a `kind`
  and `count` from each engine gate, the words key on `kind`). "Dry run" became "Rehearse" in the UI only (CLI / MCP
  keep `--dry` / `run_dry`, one mapping line on Prepare). RunScreen.tsx deleted; the take strip shrank; ratchet −192
  (RunScreen, LiveView and Sessions left it; the Record screen's 274 stay for L5.11b). Tests on the Mac: **3980 — 3894 pass, 84
  skipped, 2 failures in the one full run** (the op allow-list test missing `scenario_actions`, and Prepare's sticky
  footer covering a focused switch — both real, fixed: a `scroll-padding-bottom` on the centre pane; both files green
  again); `pnpm test:slow` 65/65; the gated run, scenario-run and Chrome acceptances green once each. Read counts: a
  24-step take re-reads `scenario_actions` 0 times during progress; 10 quick arrow keys on the poster grid: 1 read.
  Requirements: 662 tracked — 621 done (R-UI-40 – R-UI-43 added), 27 partial, 8 todo, 6 n/a-here. Live checks for the
  user: MACOS-CHECKLIST 14d.
- **L5.10b done (2026-11-02)** — L5.10 is complete. The scenario side of Épure 2 from B32-Scenario / R4-Source: the
  storyboard (frames of the latest take three a row on a container-query board — 3 / 2 / 1 columns —, step number, verb
  and target, state word, durations labelled, cards and Before / After filming as row cards, the step count), one
  resolved selection driving the board, the scenes browser and the inspectors (step: picture, form with field labels in
  words, "Other ways to find it", modifiers as switches, then the actions; scene, card, hooks, video) — a step that
  disappears is never replaced by another; a minimal take strip (Pictures from, Dry run · Capture with folded reasons
  and commands, Open timeline, the location line, the comments count) with the running run above the Board · YAML
  switch on both views; Board · YAML and Location in the title bar (`env` sent only when it differs from the file's,
  a stale remembered location dropped once the project is read); the YAML source with a File inspector. The write path
  is unchanged (every edit through `scenario_edit` with the hash, tested); the 1,200-step budget holds (interactive with
  its first picture in ≈ 0.2–0.4 s, one blocks read, 2 of 1,200 frames re-rendered per selection). Inspector.tsx
  deleted; 8 files left the kit ratchet (494 legacy controls). Tests on the Mac: **3948 — 3859 pass, 84 skipped, 5
  failures in the one full run under a machine load average of 12–14** (run-thumbs abort, capture-pause, choreography
  date pickers, the keyboard path, timeline-switch 409 — all timing; each green alone straight after); `pnpm test:slow`
  65/65; the gated acceptances (Chrome, run, record, themes, scenario-run) green once each. Requirements: 658 tracked —
  617 done (R-UI-38, R-UI-39 added), 27 partial, 8 todo, 6 n/a-here. Live checks for the user: MACOS-CHECKLIST 14c (b).
- **L5.10a done (2026-10-30)** — L5.10 is split in two (the critique sized it L): the project side first. A Studio-only
  READ op `project_board` (engine `project-board.ts`: one pass over the runs grouped by scenario, its own stat-keyed
  caches with a 60 s TTL that also re-stat the files the checks read, one renders read and one memoised queue pass per
  call, never through `scenarios.view`; path-free, titles under `untrusted`; 40 scenarios ≈ 0.2 s cold / 4 ms warm,
  3000 jobs 13–15 ms warm). State words and smart groups from a pure table (`board-words.ts`, always a shape and a
  word, consistent with the scenario screen's `sameVersion`). The project's browser: Productions with Ready to render /
  Needs a shoot / Failed, Library, Locations, Cast (session state), Project (README, Record); the project list moved to a
  title-bar menu and the Welcome screen (R4 layout). The Productions screen (B32): a poster-grid listbox (arrows, Enter
  opens, one tab stop, auto-fill — readable at 900 px), search and sort, New scenario, inspectors for the project, a
  production (Open / Render, Lately) and a location. One shared store (`project-data.ts`): one read of each op per
  project open, re-reads on events only (a 24-step terminal dry run: 4 board reads; a broken project.yaml: 2 reads in
  5 s). ProjectsScreen / ProjectPage deleted. Two product bugs found and fixed on the way: the kit's Sheet / palette
  gave focus back on a late native `close` event (Enter could reopen the previous dialog — the L5.9 kit e2e flake), and
  the jobs watch marked a job folder listed before its job.json as known and never read it again (a job could stay
  "queued" for good in the Studio — the studio-e2e-render flake under load). Tests on the Mac: **3921 — 3836 pass, 84
  skipped, 1 failure in the one full run** (that jobs-watch miss, then fixed with a deterministic regression test; the
  file 10/10 and 5/5 under load); `pnpm test:slow` 65/65; the gated acceptances (Chrome, run, record, themes,
  scenario-run) run once each, green. Requirements: 656 tracked — 615 done (R-UI-35 – R-UI-37 added), 27 partial, 8
  todo, 6 n/a-here. Live checks for the user: MACOS-CHECKLIST 14c.
- **L5.9 done (2026-10-29)**: the Studio's design system and new shell (BL-124, first lot). One token file
  (`packages/ui/src/app/tokens.ts` → generated, committed `tokens.css`, kept in sync by a test): the kit's `--ui-*` set
  from the canvas in dark and light, and the legacy palette (light identical to L4.9 — 0 computed-style differences —,
  dark mapped; `--accent-fill`, `--accent-strong-fill`, `--tooltip-bg` split from roles one value could not serve).
  **Dark by default, following the system**; every existing screen passes the L4.9 checker in dark through the
  mapping alone (no route left light). Geist and Geist Mono bundled (`packages/ui/fonts`, OFL licence beside them,
  served from memory at `/fonts/*`, preloaded; BL-120 done). The kit (`src/app/ui-kit/`, 23 components, no new
  dependency: native `<select>`, modal `<dialog>` for Sheet and the ⌘K palette, `popover` for Menu): every piece of
  text it did not write goes through `Txt` / `visibleControls` (a hostile SSR test over 50 slots), text inputs require
  `unsaved` (L5.2b's mark). The shell (`src/app/shell/`): a title bar with the mode switch Script · Shoot · Edit ·
  Review centred on the window (disabled with no scenario), a left browser, an inspector slot, a status bar with an
  actions slot (filled in L5.11); the centre pane is the only scroller (`--main-h`). The gallery `#/ui` shows every
  component in both appearances. Lints: kit-only ratchet (`test/legacy-controls.json`, per-file counts only go down;
  `pnpm -F @retake/ui ratchet` lowers them), contrast in both appearances, the name only in `brand.ts`, no vh in
  sizes. The desktop app's View menu gains ⌘K, ⌘1–4, ⌥⌘I (one table shared with the page, parity-tested); ⌘R, ⇧⌘R, ⌘B
  stay free for L5.11; the overlay title bar is not shipped (its probe needs a hand drag: BL-126, the page-side contract
  is). Tests on the Mac: **3842 — 3757 pass, 84 skipped, 1 failure in the one full run** (a sandbox lint that read
  `src/app` non-recursively hit the new folders — made recursive, so it covers the kit too, mutation-checked);
  `pnpm test:slow` 65/65. Requirements: 653 tracked — 612 done, 27 partial, 8 todo, 6 n/a-here (R-UI-02 done as
  amended, R-UI-30 – R-UI-34 done, R-DSK-03 partial: the overlay). Live checks for the user: MACOS-CHECKLIST 14b.
- **L5.2b done (2026-10-29, asked by the user after L5.2)**: the desktop app asks before quitting and tells when jobs
  end. The page reports unsaved text to its own server (token-gated op `unsaved_report`: README, YAML drafts, step
  forms, comment composer / replies / notes, the Library's component brief, the new-theme form, theme colour drafts;
  per-tab call numbers so a report never outlives its tab; cleared on `pagehide`); the server pushes `pending`
  snapshots (queued / running worker jobs — Studio or MCP; the CLI's in-process runs are not counted — and unsaved
  items) and `job_end` lines on the supervised pipe (`v:2`; plain `--json` stays `v:1`), enums and checked slugs only.
  The shell catches every quit (`applicationShouldTerminate:` added to tao's delegate: ⌘Q, menu, Dock, a quit Apple
  event, logout) and asks in an app-modal alert worded by the shell (names cut at 40 characters; with unsaved text
  Cancel / Escape is the default and Quit Anyway has no key); at a restart / shutdown jobs alone ask nothing; Quit with
  nothing pending stays instant (17–29 ms); SIGTERM / SIGINT end every shell question (14–43 ms; the folder picker by
  hand). Notifications through UNUserNotificationCenter (permission asked at the first one shown, never by tests or dev
  builds), only when the window is not in front, at most one every 5 s with a summary, a click shows the window.
  Attached servers get neither (documented). Tests on the Mac: **3804 — 3720 pass, 84 skipped, 0 failures**; `pnpm
  test:slow` 65/65; the gated desktop file 15/15 three times in a row (≈ 101 s). Live checks for the user:
  MACOS-CHECKLIST 14a steps 10–11 (the permission prompt, a delivered banner and its click, the permission after a
  rebuild, logout / restart, the picker with SIGTERM).
- **L5.2 done (2026-10-29)**: the macOS desktop app (`apps/desktop`, Tauri 2.12.5, built offline from the local crate
  cache with `--locked`; `pnpm desktop:dev|build|test|clean`). The shell spawns `retake ui --supervised` (= `--json
  --no-open`; stops when its stdin closes, so an app crash leaves no orphan; its JSON line gains `v` and `player`) and
  opens the one-time URL in a WKWebView window: incognito (nothing written to ~/Library), Tauri's drag & drop handler
  off (block drag & drop works), navigation held to the Studio and Player origins (redirects, window.open, _blank,
  data: / blob: / custom schemes refused), downloads cancelled, every permission request denied, no IPC capability for
  the page. The shell never reads the token; capability URLs are redacted from every log; Quit stops only a server the
  app started (SIGTERM, stdin closed at 1 s, SIGKILL at 5 s), never an attached one nor the shared worker. Workspace:
  `--root`, RETAKE_ROOT, `desktop.json`, the current folder, then a folder picker; Node / CLI pinned at build in
  `launch.json` (env overrides in debug builds only; release scrubs NODE_OPTIONS / DYLD_*). Menu from one table (Edit
  items, File › Open Workspace…, Window › Show Studio Window ⌘0; ⌘R, ⇧⌘R, ⌘B, ⌘., ⌘S, ⌘Enter left to the page),
  `TITLE_BAR` one switch (Standard now, Overlay ready for L5.9), no forced theme (the window chrome follows the page's
  `color-scheme`, light today). The security rules live in a zero-dependency crate (`apps/desktop/core`, 21 tests in
  ≈ 1.5 s, run by vitest when cargo and the Xcode tools are there, skipped otherwise). The gated acceptance
  (`RETAKE_TEST_DESKTOP=1 RETAKE_TEST_SLOW=1 npx vitest run packages/cli/test/desktop-shell.test.ts`) builds
  the .app, checks owned vs attached servers, a hostile page and Player, graceful quit vs crash, a capture and the
  timeline's media in the window, and ~/Library / ~/Downloads / LaunchServices left as found: 10/10 green after a
  product fix — the preview frame dropped a plan answered before its first React effects (WKWebView fires the frame's
  load first): the timeline preview stayed on "Loading the preview…" in about half the app's launches; now a store read
  with `useSyncExternalStore`, with a Chromium regression test in the default suite. Tests on the Mac: **3763 — 3686
  pass, 76 skipped, 1 failure in the one full run** (studio-e2e-render's "a newer failure shows in the Render bar", an
  L4.5 test that enqueues a job then overwrites it while a worker may claim it — green 2/2 alone); `pnpm test:slow`
  65/65. Requirements: 647 tracked — 606 done, 27 partial, 8 todo, 6 n/a-here (R-DSK-02 partial: notifications,
  native pickers for the Studio's path fields, keychain glue → BL-125). Live checks for the user: MACOS-CHECKLIST 14a.
- **L4.9 done (2026-10-29)** — phase 4 is done. The Studio's identity and accessibility pass: one closed palette (every
  app.css colour a `:root` token, same values; one blue accent, the violet kept as a categorical token), Geist / Geist
  Mono named first by local family name (bundled since L5.9: BL-120 done; a machine without them got the old
  stacks). Fixes: the theme editor's sideways scroll (`.chips legend` beat `.sr-only`), placeholder contrast (2.35:1 in
  WebKit), `.pd-mark` contrast, a selected state carried by colour alone (a 3 px accent bar on the selected step, the
  current run step and thread row; an accent edge on chips and pressed buttons), the timeline's selected segment and
  stacked comment pins hiding the focus ring. An in-repo checker (`packages/ui/test/a11y.ts`, no new dependency) over
  Chromium: contrast incl. text over media and translucent layers, names (CDP), reachability, a real focus ring, the
  selected rule, colour-only cues, headings, overflow, dialogs (focus in, Escape, focus back); app-source lints
  (colours only in `:root`, every `var()` defined and every token used, token-pair contrast, placeholder, outline,
  real controls via the TypeScript parser). Two tours (23 states at 1280 and 1440, a keyboard-only path with zero
  pointer events) in the default suite; the R-ACC4-01 acceptance in the installed Chrome (projects → blocks edit → dry
  run watched → capture → timeline layout switch with the preview verified → render + review → comment → Claude's
  proposal applied → resolve; 3/3 in ≈ 78 s, 17 audits, 0 findings). One scratch WebKit-2370 run: 14 screens, 0
  contrast failures. Tests on the Mac: **3740 — 3671 pass, 69 skipped, 0 failures** (≈ 17 min); `pnpm test:slow`
  65/65. Requirements: 647 tracked — 603 done, 27 partial, 9 todo, 8 n/a-here (R-UI-02 partial: Geist sans not
  bundled). Live checks for the user: MACOS-CHECKLIST 13j (Safari, Firefox, VoiceOver, greyscale).
- **L4.8 done (2026-10-28)**: the Studio's Record screen (`#/p/<slug>/record[/<rec_id>]`, "Record a scenario" on the
  project and scenario screens). The person clicks through the site in a **real headed browser window** opened by the
  worker (full size, Cmd-Tab between it and the Studio); the Studio is the control panel — no input forwarding (why not:
  BL-25). Start form (environment, page, path, persona with Sign in, name), a live draft polled from the recording
  (≈ 0.7 s), per action the recorder's suggestion plus up to 3 verified alternative targets (kit 1.6.0, never
  position-based, a 10 ms budget per press; ≈ 71 % of fixture controls get one), quick inserts (hold 2 s, wait for,
  caption, mark, zoom up to the theme's max_zoom) placed by row identity ("after this step" = exactly after that row,
  incl. the recorder's own scroll / wait rows), Stop (a `stop` marker the worker polls for record jobs), the check
  replay (labelled honestly: the recorded draft, without picks and inserts), Save (a new `scenarios/<name>.yaml` only,
  refused with a 409 when the draft changed since it was shown), Discard, read-only for recordings Claude or the CLI
  started. Picks and inserts live in the recording's `studio.json` (engine-only writes, revision-checked); the
  recording's `meta.json` and `events_sha256` let the engine refuse a forged or tampered recording (state `tampered`);
  hidden / bidi characters never reach a saved draft. Studio recordings never auto-save. Tests on the Mac: **3697 —
  3628 pass, 66 skipped, 3 failures in the one full run** (the secrets sentinel test hit a lab button whose name
  contained "Reveal" — the new lab buttons were renamed, green; two L4.6 e2e load timeouts, green alone); `pnpm
  test:slow` 65/65 (incl. the Studio-to-render Record acceptance, ≈ 100 s). Requirements: 647 tracked — 601 done, 26
  partial, 12 todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 13i.
- **L4.7 done (2026-10-27)**: the Studio's component library (`#/p/<slug>/library[/<theme>[/<ns>/<name>]]`): a grid by
  kind with posters in the selected / project theme, filters (kind, source, words), "Built-in" / "Workspace" badges,
  Play / Pause of an animated GIF loop per component (rendered on demand by the worker's `library` preview job in
  chunks of ≤ 12, cached content-keyed in `.retake/cache/previews/`; ≈ 1.5 s per loop warm, 41 built-in loops in
  80 s, 8.4 MB; transitions in a motion mode; one broken component never blocks the others), a detail (slots, params,
  kit compatibility, README as untrusted text), "Set as theme default" and "Create with Claude" (a copyable prompt; the
  Studio calls no model). The theme editor (`#/p/<slug>/themes[/<theme>]`): brand, colours with contrast checks, type
  pair from the theme's own fonts, motion bias, zoom, cursor, component per kind, a live Intro / Clip / Outro frame in
  the L4.5 sandboxed Player (drafts ≤ 5/s, written on release), undo / redo, Copy to edit for starters, New theme, the
  site extractions listed with the `retake theme from-site` command to copy (no Studio op queues a site job), and "Use
  in this scenario" — a new scenario `template` field that re-themes existing takes at their next render (no new
  capture). One verified write path for themes (`templates.edit`: allow-list, if_match, re-parse, lock, restore of
  served versions; MCP never edits themes). Tests on the Mac: **3583 — 3517 pass, 64 skipped, 2
  failures in the one full run** (load timing: a new theme e2e spacing check — loosened, still kills an unthrottled
  drag; the YAML-alias time bound at 470 ms > 400 — green alone); `pnpm test:slow` 63/63 (incl. the Studio-to-render
  acceptance). Requirements: 647 tracked — 598 done, 26
  partial, 15 todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 13h.
- **L4.6 done (2026-10-27)**: frame comments in the Studio (`#/p/<slug>/s/<name>/comments[/<id>]`): the Comments
  screen shows a render's exact frames as server-made JPEGs (an input seek to (F − 0.5)/fps, checked equal to an exact
  frame select on real renders with B-frames and audio; fps / start time / frame rate probed from the video, never the
  record; ≈ 150 ms per frame in 1080p, ≈ 0.25–0.7 s in 4K), a region drawn by dragging or typed in four % fields,
  anchor chips (frame / segment / step / component) from the engine, Open / Resolved / All lists, a count on the
  scenario screen, pins on the timeline linking to their threads and a Comment button there. A new `via: 'studio'`
  channel creates, replies, resolves, reopens and applies (author from the Studio process: `$RETAKE_AUTHOR`, else
  the OS user; a channel, not proof of a person — BL-106). Claude answers a Studio thread with a **proposal** on
  `comment_reply` (the whole new scenario text + its base hash; edit-only changes to the thread's own scenario, never a
  filmed / theme / override change; ≤ 200 changed lines, 600 diff rows; every L4.3 write check run without writing),
  stored as a canonical line diff with states pending / stale / superseded / applied / undone. The Studio shows the
  server's diff as code (whitespace, hidden and right-to-left characters made visible, byte order kept, never cut);
  Apply / Apply and re-render sit under the whole diff and go through the verified scenario_edit path (thread lock held
  across the write; Undo per tab); Preview change plans the timeline in memory (never a restorable version, workspace
  components still held). Tests on the Mac: **3404 — 3342 pass, 59 skipped, 3 failures in the one full run**
  (two captures and the CLI e2e failing only on the low-disk warning — 16 GB free, below 5 % of the disk; multipage
  timing under load, green alone); `pnpm test:slow` 56/58 (the catalogue on the same disk warning; the phase-3 Claude CLI
  acceptance once, green alone 20/20); the gated installed-Chrome acceptance 3/3. Requirements: 647 tracked — 596 done, 25 partial, 18 todo, 8
  n/a-here. Live checks for the user: MACOS-CHECKLIST 13g (Safari / Firefox / Chrome by hand, a live Claude Code
  proposal loop; an MCP server started before L4.6 must be restarted).
- **L4.5 done (2026-10-27)**: the Studio's timeline (`#/p/<slug>/s/<name>/timeline[/<run>[/<step>]]`): the segment
  track and the caption / steps / camera / speed / marker / comment tracks from the EditPlan, a playhead and scrubber
  driving a live preview — the Remotion Player in a sandboxed iframe on a second loopback origin (session capability per
  project, strict CSP with Trusted Types, WebRTC removed, a MessageChannel protocol with a flood budget; workspace
  components run in the preview only once the person allows them in this Studio session) — seeking exact (≈ 109 ms) and
  playing ≈ 30 fps in Chrome on H.264 (a browser without H.264 gets a message); a segment inspector switching layout,
  caption component, speed and transition in one click (a verified `set_field` edit, ≈ 100–130 ms to a settled preview,
  ⌘Z to the exact bytes); Render from the timeline with the review inline (verdict, report, contact sheets in the UI).
  The preview matches the render (mean difference 0.6–7 / 255; captured colours read slightly brighter by the browser's
  decoder: BL-108). Tests on the Mac: **3289 — 3229 pass, 56 skipped, 4 failures in the one full run** (3 tests expecting
  the old cut shape — updated; a real layout regression on the scenario screen — fixed); `pnpm test:slow` 58/58.
  Requirements: 647 tracked — 593 done, 25 partial, 21 todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 13f
  (Safari, Firefox; WebKit keeps sandboxed frames in-process).
- **L4.4 done (2026-10-27)**: the Studio's Run screen (`#/p/<slug>/s/<name>/run[/<id>]`): the live picture of the page
  the run acts on (its own CDP screencast in the worker, ≤ 10 fps keeping the last frame, a loopback channel behind the
  engine gate, relayed by the Studio only while a tab watches; never on disk; on for dry runs, off by default for
  captures — +15.6 % Chromium CPU measured, the video unaffected; a watched capture is noted in `perf.live_preview`),
  the steps from the run's outline with live status, the log (redacted, paths scrubbed, URLs masked, untrusted text),
  Pause / Resume between steps for dry runs **and captures** (the capture clock keeps a list of pauses: the pause is not
  filmed, measured 0–1 ms), Stop (teardown and rollbacks), the Sessions panel (status per persona, headed Sign in with
  a time limit and Cancel) and an honest confirmation before capturing with invalid sessions. Tests on the Mac: **3160 —
  3104 pass, 54 skipped, 2 failures** in the one full run (load 3–9): a real leak (a sandbox password written in the
  outline before it was registered — fixed with a scan of every event and run file) and a test artefact (frames.jsonl
  lines land out of order under load — the test now sorts); runner-web 454/454 after the fix; `pnpm test:slow` 58/58.
  Requirements: 647 tracked — 588 done, 26 partial, 25 todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 13e.
- **L5.8 done (2026-10-26)** — environment, off-camera actions, MCP ergonomics (R-FLD-30 – R-FLD-34, all done): no
  hand-made reset script, no side script polling the database. **Off camera** (R-FLD-31): named hooks — `hooks: {<name>:
  hook | [hooks]}` in a scenario or project.yaml (core `named-hooks.ts`; the scenario's name wins; each entry named
  after the hook unless it has its own) — run by a `hook: <name>` step during the take (runner `stepHookRunner`: the
  setup's context, journal and saved results, the run's cancel). Hooks phase **`step`**: stops at its first failure,
  journals rollbacks like setup (undone after the teardown), rolls nothing back itself; approvals bound to phase `step`
  and the entry's position, asked once per named hook at submit (engine run gates; checked end to end through the
  worker). Read-only runs refuse writing named hooks up front; agent trust covers their files and secrets; run.json
  `hooks.steps`; a dry run skips them unless `--hooks run`. Scene **`offscreen: true`**: played, not shown (timeline
  scene `offscreen`). The edit cuts a hook step's span whole (timing `offcamera`, reason `hook`, trimming on or off;
  its `hold` stays); the raw export too, and gives an offscreen scene no clip. L5.5: `hooks` is filmed, a hook step is
  a step, `offscreen` is edit (replanEdit). L4.3: badge `hook`, palette 16 actions, named hooks read-only in the hooks
  strip (`hooks` joins HOOK_SECTIONS), the offscreen badge; scene options stay in the YAML tab (BL-101). **Pre-flight**
  (R-FLD-33, runner `page-preflight.ts`): one GET per page of the environment before anything opens; a refused
  connection, a timeout or a 502/503/504 stops the run naming the page and URL. **Sandboxes** (R-FLD-30, R-FLD-32):
  core `sandboxAdvice` → `doctor --project` WARN `Sandbox`, `project_get`, the MCP instructions, the scenario skill
  (step 4 + `reference/sandbox.md`, process and docker-compose examples; the skill lint validates sandbox.yaml); a
  docker-compose sandbox's env file (`compose.env_file`, default `.env` next to the first compose file) passed as
  `--env-file` to every compose command, its names left out of docker's environment (a shell's value would win), its
  hash in the seed inputs, COMPOSE_PROFILES in it refused — checked on the real `docker compose config`; README "A
  stage sandbox". **MCP** (R-FLD-34, `packages/mcp/src/compact.ts`): `run_status`, `review` / `review_get`,
  `page_inspect` (and job_status of an inspection) compact by default, `detail: "full"` as before; one-line JSON in
  every result; `job_status {wait_s}` up to 600 s with a progress heartbeat every 15 s. Measured through `retake mcp`
  on the fixture (characters / 4): page_inspect 13,260 → 2,174 tokens, a dry run's run_status 2,715 → 933, review_get
  2,155 → 408 (FIELD-FEEDBACK-1 "After L5.8"). Fixture scenario **`off-camera`** (15 fixture scenarios). Acceptance on
  the Mac (final build): capture 20261026-211008-off-camera (the café's request posted by the hook during the take,
  its 1.53 s span cut, the new row "Q-1043 New" appearing across the cut), render off-camera-v2 and review (one
  warning: the 17 s video is under the reference length), frames on both sides of the cut and the first clip (the
  quote list, not the offscreen products page) looked at; the same
  capture through the MCP worker with its shell entry approved at submit; `retake doctor --project` on a copy without
  sandboxes. Tests on the Mac: **3093 — 3040 pass, 51 skipped, 2 failures that were label updates (the palette's 16
  actions over HTTP, the seed's rollback wording), green alone (≈ 18 min under another session's load 6–11)**;
  `pnpm test:slow` 58/58 (≈ 14 min, load up to 23). Requirements: 647 tracked — 583 done, 26 partial, 30 todo, 8 n/a-here. Follow-ups BL-101 – BL-104 (next free id BL-105). Live
  checks for the user: MACOS-CHECKLIST 13d.
- **L5.7 done (2026-10-26)** — capture performance and disk (R-FLD-20 – R-FLD-24, R-FLD-26 – R-FLD-28 done, R-FLD-25
  partial; R-ISS-12 done): a take costs under a core with the limiter on, ends without a long encode and weighs tens of
  MB. **Encode during the take** (runner-web `stream.ts`): `CfrStream` (the CFR schedule as frames arrive — exactly
  `cfrSchedule`; ticks 0.5 s behind the clock, never past a held load's start) feeds ffmpeg through a pipe —
  VideoToolbox H.264 `-q:v 85` where ffmpeg has it, else libx264 veryfast; page tracks get their own encoders
  (Runtime `encoderFor`). `capture.keep_frames` defaults to **false** (frames.jsonl still written; the raw export needs
  `keep_frames: true` for 60 fps), `capture.quality` to **90** (small text checked), `capture.encoder`,
  `capture.prewarm` (pages visited once off camera, `prewarm.ts`). `capture.step_shots` reads the video when no frame
  is kept. **R-ISS-12 with the limiter on**: after a press the recorder restarts the screencast whenever no frame came
  for 90 ms (`pressed()`, Pointer `afterPress`; a byte-identical frame is dropped, so idle gaps stay whole), the edit
  cuts a freeze left (`timeline.stalls`, timing `frozen` — also a cursor-move freeze, more of them on a loaded machine:
  the phase-3 acceptance now checks that no cut or speed-up touches the new take's 3 s hold instead of comparing two takes' clip lengths);
  `frame_rate_limit: false` warns. **Perf report** (`perf.ts`, run.json `perf`): CPU per group from Chromium's
  SystemInfo.getProcessInfo per persona + `ps -p` of encoders and of the localhost servers + Node, the machine load,
  the GPU (SystemInfo.getInfo), frames, stalls, transitions (`activity.ts`: 96×54 grey thumbnails from the encoder,
  changed cells outside the cursor; slow = click → stable over 0.8 s), encode, disk; printed by `retake run`, MCP
  run_status, review `slow-transition` (info). **Waits after a click** (`timeline.busy`: near-identical frames ending
  with the content) shortened by the edit (timing `busy`). `retake doctor`: `GPU` and `Capture encoder` lines.
  **Disk**: engine `pruneProject` → `retake prune <project> [--keep-renders N] [--yes]` and MCP `project_prune` (45
  tools); a capture warns under 10 GB / 5 % free. Fixture: `two-personas` scenario, `NORTHFIELD_QUOTES_MS` (skeleton rows
  on the console's Quote requests). Measured before/after, alternated on a quiet Mac (FIELD-FEEDBACK-1 "After L5.7"):
  `quote` 72 → 40 cpu-s (ffmpeg 29 → 7, node 12 → 7, Chromium 31 → 26), run folder 570 → 20 MB, ripple freezes 5 in 5
  takes → 0 in 5; `two-personas` 55 → 37 cpu-s; the unfilmed persona's browser ≈ 0.02 core (not throttled: BL-97).
  Acceptance: take 20261026-154105-quote rendered (quote-v1) and reviewed clean, frames looked at (marker, zoom,
  cursor); a `two-personas` take's skeleton cut looked at. Tests on the Mac (rebased on L4.3): **3054 — 3004 pass, 50 skipped (≈ 15 min; the 2 L4.3 golden counts rerun alone)**; `pnpm test:slow` 57/58 then phase3-acceptance 20/20 alone (load 7–18) — the phase-3 acceptance compared two takes' delivery clips, which differ by everything else a take does (idle gaps near the threshold, the freezes a loaded machine adds and the edit now cuts) — it now checks the new hold whole in the plan; the catalogue acceptance read `frames/` (now off by default), the fixture-scenario counts were 13 (blocks, scenario-check, L4.3's step-edits / step-values goldens). Requirements: 647 tracked — 578 done, 26 partial, 35 todo, 8 n/a-here. Follow-ups BL-97 – BL-100 (next free id BL-101). Note for L5.8: a `hook:`
  step mid-take must not break the encoder's clock (ticks follow the capture clock, a paused recorder holds the frame).
- **L4.3 done (2026-10-26)**: the Studio's scenario screen edits a scenario. Blocks and YAML are two-way: every save is
  a minimal text splice (or a yaml CST scalar edit) that keeps comments, quoting, blank lines and line endings, and is
  verified by re-parsing (the new value must equal the intended one). Steps move (drag & drop or Alt+↑/↓, across
  scenes), are duplicated, deleted, edited in inspector forms (scalar fields + a flat target, empty optional fields
  folded) or added from a palette of 15 actions; undo / redo restore the exact bytes; the YAML tab is editable with
  conflict and changed-on-disk flows. One write path (`scenario_edit`, agent trust worded "from the Studio"): hooks,
  and `vars` / `env` when the file has hooks or mocks, never change from the Studio; every `if_match` write (MCP,
  README, Studio) holds a cross-process lock. Also fixed: `job_status` of a preview job now returns its `stills` like
  the preview tools (a slow preview broke the phase-3 acceptance under load). Tests on the Mac: **3019 — 2966 pass, 50
  skipped, 3 timing failures under load 15–32** (two pass alone; run.test's "an AbortSignal cancels the run" fails the
  same way on main 2f1813a at that load — see Notes from L4.3); `pnpm test:slow` 56/58 then the two phase-3 preview
  failures explained and fixed (phase3-acceptance 20/20 alone). Requirements: 647 tracked — 569 done, 26 partial, 44
  todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 13c.
- **L5.6 done (2026-10-26)** — capture reliability (R-FLD-10 – R-FLD-16, all done): a take fails early, loudly and
  completely. The field's silent wrong `type` was reproduced on a new fixture page (console `/proforma`, "Pro forma
  invoices") with the old runner: `{label: Quantity (kg)}` resolved to the page's filter field **behind the modal
  dialog**, warned "covered", clicked the overlay, closed the dialog and the take succeeded. Now: the kit drops matches
  behind an open modal dialog (`:modal`, aria-modal, or the rest of the page aria-hidden / inert) when some are inside
  it or in a floating layer (`in: page` searches the whole page); `type {into}` scrolls the field in its own containers,
  takes its point once its box stopped moving (resolve.ts `settledPoint`), scrolls a covered field towards the middle,
  checks after the click that the focus is in the field (else the step fails before typing, naming what got it) and
  after typing that the value holds the text (warning). A missing target lists the scene's later targets missing too,
  with their closest elements (`missing.ts`, run.json `error.missing_targets`). Plain clicks are watched for an effect
  from the press (`actions/effects.ts`, kit `effectWatch`: requests except the page's polling, DOM in every tree,
  navigation, dialog, tab, download, input / change / submit / scroll / toggle, a field taking the focus): nothing
  within 1 s → a warning at once with `screenshots/dead-click-<scene>-<step>.png`; `retry_click: true` clicks once more
  and fails on a second dead click. `download` retries transient failures (3 attempts, 1 s / 2 s; a broken browser
  download is fetched again with the session) and fails at once on a real HTTP error. `defaults: {timeout_s}` in
  project.yaml / a scenario. Personas take `email` (a sandbox account's mail `username` too); `wait_for_email {to:
  persona:<name>}`; no match lists the messages that came, several matches warn; mail-view labels the mailbox
  "Inbox · <Persona>". run.json `optional_failures` (CLI summary, MCP run_status); `capture.step_shots` copies the
  captured frame at the end of each step (no screenshot during the take). Fixture: the Pro forma page and its API, the
  `proforma` scenario (`--env signed-in`, persona emails in project.yaml), variants in
  `packages/cli/test/reliability-fixture.test.ts`. Acceptance on the Mac (own fixture on 5401–5404, scratch workspace):
  capture 20261026-101402-proforma (the PDF's broken second transfer fetched again) and render proforma-v1 looked at —
  the dialog's fields typed below the fold, "Inbox · Supplier" on the copy card; dead-click and covered-field
  screenshots looked at. Tests on the Mac (on top of L5.5): **2836 — 2786 pass, 50 skipped (≈ 15 min)**; one test failed under another
  project's load (1-min load 21) and passes alone (the kit's debug-cursor style); `pnpm test:slow` 58/58 (≈ 18 min). The
  filmed-part fingerprint of L5.5 counts `retry_click` and leaves out `defaults` and `capture.step_shots`.
  Requirements: 646 tracked — 567 done, 26 partial, 45 todo, 8 n/a-here. Follow-ups BL-92 – BL-94 (then BL-95 / BL-96 for L4.3; next free id BL-97). For L5.7: step pictures come from `frames/` (copied before
  `keep_frames: false` removes them).
- **Field feedback 1 (2026-10-26)**: the first real use of the tool (three internal videos of a real two-sided B2B
  product, about four minutes each, filmed in two languages) was triaged in `docs/FIELD-FEEDBACK-1.md`: four lots
  L5.5 – L5.8 (edit without re-capture; capture reliability; capture performance and disk; sandboxes, off-camera hook
  steps and compact MCP outputs), 27 requirements R-FLD-01 – R-FLD-34, and BL-81 – BL-89 for the rest. Performance
  measured on the fixture: GPU active, `frame_rate_limit: false` ×2.8 Chromium CPU, frames at JPEG 100 = 99 % of a
  run's size and read only by the raw export and the L4.2 pictures.
- **L5.5 done (2026-10-26)**: edit without re-capture. A render re-plans the edit from today's scenario file on an
  existing take while the scenario's **filmed part** is unchanged (core `filmedChanges`: env, hooks, capture, pacing,
  clock, mocks, the vars the take uses, capture scenes, each scene's page / open / pages / persona / still / cursor,
  each step's fingerprint with hold / park / on); everything else — cards and their order, durations, captions,
  overlays, camera hints, marks, speeds, title, intro / outro, template, target length — comes from today's file
  (core `replanEdit` rewrites the run's timeline on its measurements; the runner now records `end_point` on every
  step). `scenario_changed` (CLI plan / render, MCP plan_preview / render, the Studio scenario view) only for a filmed
  change, with `filmed_changes`; an edit-only change says `edit: "scenario"` and `edit_changes`; render records and
  render jobs carry the edit's sha256 (a file changed while a job waited is refused; an export re-renders the
  master's edit). Also: card and interstitial durations from their text (250 words a minute + 1.5 s) and review
  `card-too-short`; `studio/mail-view` without scroll by default; scenario `target_length` for the review's length
  rule; review `artefact-before-step`. Fixture acceptance on one take of `quote` (caption, card text / duration /
  order, an overlay, target_length → render v2 on the same run, review clean, frames looked at; a step's hold → the
  filmed change reported). Tests on the Mac: **2809 — 2757 pass, 50 skipped (≈ 17 min); 2 failed under another project's load (1-min load up to 17.8 on 10 cores) and pass alone** (a Studio e2e worker-death test, the kit's debug-cursor style); `pnpm test:slow` 58/58 (≈ 14 min). Requirements: 646 tracked — 560 done, 26 partial, 52 todo,
  8 n/a-here. Follow-ups: BL-90 (project.yaml changes not compared; overlay targets the take never measured), BL-91.
- **L4.2 done (2026-10-24)**: the Studio's scenario screen shows a scenario as blocks (scenes as cards with pages, URLs,
  caption, speed, layout, duration; steps as rows with an action badge, the target in plain words and chips; hooks strip;
  a read-only inspector and YAML tab) with each step's real picture from the last dry run or capture (from kept frames
  or the video, in memory only, matched to today's steps by step identity when the file changed). Dry run, Capture and
  Cancel run from the screen; what would stop them (hooks needing a person, agent-trust rules, file errors) shows before
  any click with the terminal command. The Studio starts the worker with a cleaned environment (as every non-CLI client
  now does). Tests on the Mac: **2794 — 2744 pass, 50 skipped (≈ 13 min), 3 full runs in a row green**; `pnpm test:slow`
  58/58. Requirements: 619 tracked — 554 done, 26 partial, 31 todo, 8 n/a-here. Live checks for the user:
  MACOS-CHECKLIST 13b.
- **L4.1 done (2026-10-23)**: `retake ui` serves the Studio web app on 127.0.0.1 (new package `packages/ui`, React
  bundled in memory by esbuild, strict CSP): the Projects screen, a project page and a README editor (if_match,
  conflict and changed-on-disk flows, line endings kept, non-UTF-8 read-only), an activity feed and a search on a
  SQLite index (`.retake/index.sqlite`, node:sqlite, rebuilt from files), live updates over one event stream per
  browser. Every request passes one gate (Host → Origin / Sec-Fetch-Site → route → token → body); the URL carries a
  one-time code, never the token. `retake mcp --http` serves the same 44 tools over Streamable HTTP (stable token in
  the Retake home, browsers refused, approvals work). Tests on the Mac: **2593 — 2545 pass, 48 skipped (≈ 14 min),
  3 full runs in a row green**; `pnpm test:slow` 56/56. Requirements: 619 tracked — 549 done, 25 partial, 37 todo, 8
  n/a-here. Live checks for the user: MACOS-CHECKLIST 13a (Safari / Firefox, Claude Code over HTTP).
- **L3.8 done (2026-10-20) — phase 3 done**: the phase-3 acceptance in `test:slow`
  (`packages/mcp/test/phase3-acceptance.test.ts`, docs/ACCEPTANCE-phase3.md): over MCP on an empty workspace, a scripted
  client following the skills creates a project from a README, drafts a scenario from a timecoded script and page
  inspections (dry run with no write to the product), makes a theme from brand files and an intro component (two code
  iterations), captures, renders (64 s) and reviews clean, then handles a person's frame comment (scenario change →
  re-capture → render → review → reply → resolve) with zero approval requests. A render shows the run as captured: a
  scenario change now warns (`scenario_changed`, MCP and CLI) and the wording everywhere says re-capture. Tests on the
  Mac: **2484 — 2436 pass, 48 skipped (≈ 12 min), 3 full runs in a row green**; `pnpm test:slow` 56/56 (≈ 11.5 min).
  Requirements: 619 tracked — 543 done, 23 partial, 45 todo, 8 n/a-here. Live check for the user: MACOS-CHECKLIST 12j
  (the whole phase-3 loop in one Claude Code conversation).
- **L3.7 done (2026-10-20)**: three Claude skills (`skills/retake-scenario`, `retake-theme`,
  `retake-component`) packaged as a Claude Code plugin with the MCP server (`skills/.claude-plugin/plugin.json`,
  `skills/.mcp.json`, local marketplace `.claude-plugin/marketplace.json`); `mcp --print-config` prints the two install
  lines (`--scope local`, values: node, cli, workspace, home). Every skill opens by checking `engine_info`'s root and
  never runs the `retake` CLI through the shell. Component scaffolds import renderer primitives through the kit. Tests
  on the Mac: **2445 — 2403 pass, 42 skipped (≈ 12 min)**; `pnpm test:slow` 36/36. Requirements: 619 tracked — 543
  done, 17 partial, 51 todo, 8 n/a-here. Live check for the user: MACOS-CHECKLIST 12i.
- **L3.6 done (2026-10-19)**: frame comments. A person comments a frame of a render (`retake comment add --at |
  --frame | --marker [--region]`); the thread is anchored to the edit (segment, scene, step and its fingerprint,
  marker, overlays, caption / screen / brand-mark area) with a still of the frame; Claude reads them over MCP
  (`comments_list`, the still as an image), adapts the scenario, re-captures and re-renders, replies (`comment_reply`) and resolves
  with the new render (`comment_resolve`). Only people create or reopen threads. 44 MCP tools. Tests on the Mac:
  **2355 — 2316 pass, 39 skipped (≈ 13 min)**; `pnpm test:slow` 23/23. Requirements: 619 tracked — 540 done, 16 partial, 55 todo, 8 n/a-here.
  Live check for the user: MACOS-CHECKLIST 12h.
- **L3.5 done (2026-10-19)**: Claude makes a new workspace theme from the user's brand files
  (`template_create_from_brand`: logo, colours, fonts in `<workspace>/brand/`; deterministic palette with contrast
  checks, strict SVG scan, font sniff, licence notes) or drafts one from a public website the user approves
  (`template_from_site`: a worker job behind a local CONNECT proxy, public addresses only, signed approval of the exact
  URL; colours by role, font names, logo candidates as PNG, a screenshot), then previews and renders with it. CLI:
  `retake theme create | from-site`. 41 MCP tools. Tests on the Mac: **2294 — 2257 pass, 37 skipped (≈ 13 min)**;
  `pnpm test:slow` 21/21. Requirements: 619 tracked — 531 done, 16 partial, 64 todo, 8 n/a-here. Live check for the
  user: MACOS-CHECKLIST 12g (a brand kit, then a public site you pick).
- **L3.4 done (2026-10-18)**: `retake record` opens a real window where the person performs the flow; it becomes a
  scenario draft (verified targets, scenes, waits, secrets replaced by placeholders) that is saved, checked by a replay
  up to the first write and dry-runs. Claude can start one with `scenario_record` but never drives it. Tests on the
  Mac: **1967 — 1934 pass, 33 skipped (≈ 10 min)**. Requirements: 619 tracked — 529 done, 15 partial, 67 todo, 8 n/a-here. Live checks for the user:
  MACOS-CHECKLIST 12c–12f (12f: record a flow yourself, CLI first).
- **L3.3 done (2026-10-18)**: Claude authors scenarios through MCP — `page_inspect` gives it verified targets and a
  numbered screenshot of real pages (signed in, read-only, the environment's origins only), it writes the YAML,
  validates, saves, inspects again mid-scenario and dry-runs; `scenario_from_script` drafts from a timecoded table. The
  tool never calls a model. Tests on the Mac: **1887 — 1855 pass, 32 skipped (≈ 9 min)**. Requirements: 619 tracked — 528 done, 15 partial, 68
  todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 12c, 12d, 12e.
- **L3.2 done (2026-10-17)**: through MCP Claude can now plan, render (guarded: no network, project files only),
  review with contact sheets as images, export, and browse / preview themes and components (36 tools). Tests on the
  Mac: **1819 — 1791 pass, 28 skipped** (≈ 8 min); `pnpm test:slow` includes the whole MCP loop on the fixture.
  Requirements: 618 tracked — 525 done, 14 partial, 71 todo, 8 n/a-here. Live checks for the user: MACOS-CHECKLIST 12c
  (L3.1) and 12d (L3.2).
- **L3.1 done (2026-10-17)**: `retake mcp` (23 tools over stdio) lets Claude list and edit scenarios, run dry runs and
  captures through a job queue and a separate worker, follow progress, cancel, run hooks and env resets, sign in (the
  human types) and start sandboxes; every risky action asks the human through an approval form. Tests on the Mac:
  **1738 — 1714 pass, 24 skipped (≈ 7 min)**. Requirements: 618 tracked — 514 done, 15 partial, 81 todo, 8 n/a-here. Register it with
  `node packages/cli/dist/bin.js mcp --print-config` (MACOS-CHECKLIST 12c).
- **L1.4 done (2026-10-17)**: every scenario-language option has a test that fails if the option is ignored; captures
  at 2560×1440, 4K and phone sizes; cursor and file-chip look checks with goldens; Ctrl-C / SIGTERM on the built CLI;
  `version: 1` on the persisted formats and the engine in run.json; `pnpm test:pg` (the Postgres tests, first run on
  the Mac) and `pnpm test:slow` (automated catalogue capture); the tests found and fixed `wait_for: {network_idle}`
  and four cancel / teardown bugs. Tests on the Mac: **1632 — 1608 pass, 24 skipped (≈ 6 m 35 s; 7 Postgres, 7 Docker, 8 slow, 1 old Node, 1 headed); `pnpm test:pg` 7/7, `pnpm test:slow` 8/8, Docker-gated 7/7**. Requirements: 618 tracked — 498 done, 9 partial,
  103 todo, 8 n/a-here; never exercised in phase 1: 0.
- **L1.8 done (2026-10-14)**: sandboxes — a `sandbox.yaml` per sandbox environment (process or docker-compose
  services, seed, reset by reseed or Postgres snapshot, demo accounts as personas, mailbox), `retake sandbox init | up
  | down | reset | status | logs`, `retake run --sandbox` (every take from the same state), the fixture shipped as a
  process and a Docker sandbox. Tests on the Mac: **1583 — 1567 pass, 16 skipped (≈ 6 m; 7 Postgres, 7 Docker without RETAKE_TEST_DOCKER, 1 old Node, 1 headed sign-in); the gated Docker tests pass 7/7 on OrbStack**. Requirements: 618 tracked — 467 done, 40 partial, 103
  todo, 8 n/a-here.
- **L1.7 done (2026-10-13)**: environment pages take a display URL (never localhost on screen or in a report),
  production / read-only environments (browser writes mocked or stopped, writing hooks refused, production writes only
  with `access: read-write` + `--allow-writes`, access mode in run.json / timeline / review), and a product clock
  (`clock:`, Date-only, timers and animations real). Tests on the Mac: **1455 — 1446 pass, 9 skipped (≈ 5 m 20 s; 7 Postgres without RETAKE_TEST_PG, 1 old Node, 1 headed sign-in)**.
- **L1.6 done (2026-10-13)**: personas per environment (`auth.personas`), one browser per persona on a per-run copy of
  its signed-in profile, a session preflight before every dry run and capture (automated off-camera login when
  `login:` steps exist, else the exact `retake login` command), a sign-in guard that fails a run and keeps nothing,
  `retake login --persona [--auto]`, `retake auth status`, interactive `retake new`, doctor persona lines; the fixture
  has a signed-in side (env `signed-in`, personas supplier and buyer). Tests on the Mac: **1212 — 1204 pass, 8 skipped (≈ 4 m 40 s; the 8th: the headed sign-in test without RETAKE_TEST_HEADED)**.
- **L1.2 done (2026-10-13)**: the runner finds targets in open shadow roots and same-origin iframes, never films a
  loading page (frames held until the new page paints, `timeline.loading`, cut in the edit), templates every scenario
  string with secrets resolved up front and redacted from every run file, checks the hosts of shell and js hooks, and
  gained choreography helpers (`date`, `park`, adaptive typing, robust `clear`, menu re-click). Tests on the Mac:
  **1142 — 1135 pass, 7 skipped (≈ 4 m)**.
- **L1.3 done (2026-10-12)**: the cursor waits for flowing frames after a scroll (stalls after scrolls gone) and
  before a press, the motion check warns on stalls ≥ 150 ms. Two limits stay partial: closing a dialog with a blurred
  overlay still freezes ≈ 0.26 s during the click ripple (R-ISS-12; `browser.frame_rate_limit: false` avoids it, not
  the default: rAF at thousands of Hz, 2–6× CPU), and hover-effect hitches (100–400 ms, now and then; R-ISS-02).
  Tests on the Mac: **896 — 889 pass, 7 skipped** (≈ 2 m 35 s).
- **L5.1 done (2026-10-12)**: the CLI tells an old Node.js which version it needs, a new workspace uses the starter
  templates, one-line keychain errors (printed once), `doctor` checks ffmpeg ≥ 5.1, scene rest points next to the
  click point and inside the target's dialog, continuing scenes glide next to a far first target, late popups caught
  by the next step. Tests on the Mac: **893 — 886 pass, 7 skipped** (6 Postgres without `RETAKE_TEST_PG`, 1
  without `RETAKE_TEST_OLD_NODE`), ≈ 2 m 45 s. Requirements: 618 tracked — 431 done, 50 partial, 129 todo,
  8 n/a-here.
- **L1.5 done (2026-10-12, on the Mac)**: every step of `docs/MACOS-CHECKLIST.md` ran on an Apple M4 (results table
  at its end); step 7 found stalls after scrolls and at dialog close (→ L1.3) and scene-start defects (→ L5.1); the
  imports into editing tools were skipped (none installed; R-RAW-06 partial). It fixed the Mac blockers of
  the test suite (ffmpeg 9, symbolic-link paths, a case-insensitive fixture, a font-sensitive look test), **narrowed
  L1.3** to the stalls a GPU Mac still shows and filled **L5.1** (`--lot L5.1`). Tests on the Mac: **878 — 872 pass,
  6 Postgres skipped, 2 m 28 s** for the full suite. Requirements: 618 tracked — 424 done, 50 partial, 136 todo,
  8 n/a-here.
- **Phases 1 and 2 are done**: phase 1 (core, runner-web, hooks, CLI, fixture product, starter templates) + L1.1, and
  phase 2 L2.1–L2.14 — contracts, components package, edit planner, Remotion render pipeline, reference-look
  components, review, layouts & previews, variants / 4K / music / export, mails / notifications / documents, tutorial
  overlays & story cards, multi-page capture (split, PiP), your own media & motion, raw capture export for editors,
  and the phase-2 acceptance (`docs/ACCEPTANCE-phase2.md`).
- **Acceptance (L2.14)**: fresh captures `20261012-144004-catalogue` / `20261012-144221-quote`; catalogue-v7 and
  quote-v17 (editorial) review clean; quote-v18 (`--theme motion`) and quote-v19 (`--frame studio/layout-laptop`)
  re-render the same capture with no scenario change and review clean; own-media-v9 (user intro video, alpha overlay,
  Lottie, image outro, music) clean; the raw export of the quote run validates (`scripts/validate-raw.py`).
- **Tests (end of phase 2, cloud)**: 875 — 869 pass, 6 Postgres tests skipped without `RETAKE_TEST_PG` (≈ 5–7 min
  in the cloud container); 878 after L1.5 (see above).
- **Not built yet**: phase 3 after L3.1 (MCP, authoring, recorder, skills), phase 4 (Studio app), phase 5 (macOS shell, iOS runner). `packages/mcp`
  is empty; `retake record|mcp|ui` print "available in phase N".

## Mac setup
The next sessions run locally on the user's Mac with Claude Code, on the `main` branch. Steps (once; `retake doctor`
checks the result):

1. **Command line tools** — `xcode-select --install` (git, clang). The full Xcode is only needed for phase 5.
2. **Node.js ≥ 22 and pnpm** — `brew install node@22` (keg-only: `brew link --force node@22`, or put
   `$(brew --prefix node@22)/bin` on the PATH; nvm / fnm work too), then `corepack enable`: corepack provides the
   pnpm version pinned in `package.json` (`packageManager: pnpm@10.28.0`). Node 25+ no longer bundles corepack:
   `npm i -g corepack` first, or stay on 22 / 24.
3. **ffmpeg and ffprobe** — `brew install ffmpeg` (H.264, VP9 / libvpx, ProRes encoders, ffprobe). Captures encode with
   it, renders are probed with it, the review decodes with it, the raw export encodes with it. Elsewhere on disk:
   `ffmpeg:` in `retake.yaml`, `$RETAKE_FFPROBE` for ffprobe.
4. **The repository** — `git clone -b main <repository URL> retake && cd retake`, then `pnpm install` and
   `pnpm build`. The lockfile already lists the macOS binaries (`@remotion/compositor-darwin-arm64`,
   `@img/sharp-darwin-arm64`, `@esbuild/darwin-arm64`); pnpm 10 runs install scripts only for esbuild and sharp
   (`onlyBuiltDependencies` in `pnpm-workspace.yaml`, the one list).
5. **Chromium for playwright-core** — `pnpm --filter @retake/runner-web exec playwright-core install chromium`.
   This downloads the Chromium build pinned by playwright-core 1.56.1 (Chromium 141, revision 1194) **and** its
   headless shell into `~/Library/Caches/ms-playwright/`. How the browsers are found
   (`packages/runner-web/src/probe.ts`, `session.ts`; `packages/editor/src/render/browser.ts`):
   - captures (runner): `browser.executable` in project.yaml / retake.yaml, else `$RETAKE_CHROMIUM`, else
     playwright-core's own Chromium launched in new headless mode (`channel: chromium`);
   - renders (Remotion): `$RETAKE_CHROMIUM_HEADLESS_SHELL`, else playwright-core's `chromium-headless-shell`
     (looked up through its registry), else Remotion downloads its own (a warning says so);
   - `PLAYWRIGHT_BROWSERS_PATH` moves the browser cache (the cloud container used `/opt/pw-browsers`); leave it unset
     on the Mac. No other environment variable is needed.
6. **Check** — `pnpm retake doctor` (Node, Chromium launch, ffmpeg / ffprobe, display, Keychain, notifications,
   workspace, template fonts): every line `OK`. Node must be 22+ in every folder the CLI runs from: a version manager
   pins it per folder (the user's machine: Node 22 in the repository — `.nvmrc` —, 10 elsewhere; an older Node.js
   prints which version it needs). A workspace outside the repository uses the starter templates by name. ffmpeg 5.1+
   (the Mac has Homebrew's 9.0; `retake doctor` fails below 5.1).
7. **Later, not before their lot** — Docker Desktop for L1.8 (sandbox mode, docker-compose provider); the full Xcode
   (App Store) + Rust (`rustup`) for phase 5 (L5.2 Tauri shell, L5.3 iOS Simulator runner: simctl / idb).
8. **Optional** — PostgreSQL for the 6 SQL hook tests (`brew install postgresql@16`, then
   `RETAKE_TEST_PG=postgres://…`); Python 3.13 or older + OpenTimelineIO for `scripts/validate-raw.py`
   (OpenTimelineIO 0.18.1 does not load on Python 3.14: `RuntimeError: bad any cast`; Homebrew has `python@3.13`):
   `python3.13 -m venv ~/.venvs/otio && ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter`.

**macOS permissions.** Headless captures need no Screen Recording permission (frames come from Chromium's own
screencast) and the fixture and the render asset server listen on loopback only (no firewall prompt). Expect prompts
only for what the L1.5 checklist exercises: Keychain access when a hook resolves `{{keychain:service/account}}`
(through `security`), the Notification / Automation prompt the first time `osascript` posts a notification from the
terminal, and a visible window for `--headed` runs and `retake login`.

## Order of the next lots
1. ~~L1.5 = `docs/MACOS-CHECKLIST.md` with the user~~ — done 2026-10-12 (narrowed L1.3, filled L5.1).
2. ~~L5.1~~, ~~L1.3~~ — done 2026-10-12, ~~L1.2~~, ~~L1.6~~, ~~L1.7~~ — done 2026-10-13, ~~L1.8~~ — done 2026-10-14,
   ~~L1.4~~ — done 2026-10-17: the chain is complete.
   Chain asked by the user (2026-10-12): L1.3 (stalls) → L1.2 (runner robustness) → L1.6 (sessions & personas) → **L1.7** (display URLs, read-only & production safety, frozen clock)
   → **L1.8** (sandbox mode) → **L1.4** (coverage, last so it covers the rest), then stop before phase 3 (**L3.1**).
3. One lot at a time; the user (in French) decides how many — see `CLAUDE.md`.

## Next lot
**The architecture series (L6.1 – L6.13) is done and waits for the person's review of its pull request** (branch `claude/arch-l6`; State above). After it: the action plan's T15 rest and T16 when the person asks; the desktop bundle's staging of stale `dist` outputs to decide.

**Before tagging v0.2.0: the person's review of the two hardening lots** (L5.17 and L5.18 done — ROADMAP
"L5.17 – L5.18"; the person checks the [action plan](audit/action-plan.md)'s security task against their private
report). Then come back to the audit of 2026-11-04 (`docs/audit/`):
propose the action plan's architecture tasks and backlog items to the person (the MVP scope stays locked until they
decide), and rerun `scripts/audit/snapshot.mjs` against `docs/audit/2026-11-04/summary.json`.

**Next: the first release v0.2.0** (asked by the person on 2026-11-04, the two hardening lots decided on
2026-11-05; L5.16, L5.14, L5.15, L5.17 and L5.18 are done: the standalone app and its releases, captures first on the
file queue, renders on the GPU, the two hardening lots). L5.14 signed rollback journals and bound approvals to their job
(DESIGN §4q); L5.17 pinned a job's scenario bytes, showed every hook in full, held agent-written shell hooks to plain
words, put every capture and render browser in Chromium's sandbox and checked the release workflow's inputs; L5.18
gave the processes that serve agents one flag under which a job runs no program of the workspace, passes only listed
browser switches and an allow-list of the environment, moved the Studio's token to the Retake home and kept
`retake mcp --http` off a port another program holds. **Decided
2026-10-29: L5.9 – L5.15** — the Studio redesign « Épure » (L5.9 – L5.12, BL-124), the rename to Retake (L5.13),
then the standalone app (L5.16, BL-36: everything inside, signed, notarised, DMG, updater — after the rename, decided
2026-10-29), captures first (L5.14, BL-116; on the file queue since 2026-11-04, BL-117 parked), renders on the GPU (L5.15, BL-114) — then L5.3 and
L5.4 (ROADMAP "L5.9 – L5.15"). In progress first: L5.2b (the desktop app's job notifications and a quit confirmation). L5.2's shell is ready for the redesign: one `TITLE_BAR` switch for the integrated title bar, the menu from one
command table (⌘R, ⇧⌘R, ⌘B, ⌘. left free), no forced appearance; the sheets' design (a confirm through the supervised
pipe) is in DESIGN §4j, not built. Pending
for the user: the live runs (MACOS-CHECKLIST 8b, 10b, 12b, 12c–12j, 13a) and the open questions, gathered in one test
document outside the repository; R-PRJ-02's wording (SPEC §3 vs ADR-2: the queue stays in files, the index holds a view); the open questions Q1 (first buyer) and Q2
(L4.7 scope). Open phase-1 items left: R-ISS-02 and R-ISS-12 (known capture limits, L1.3) and R-RAW-06 (an import
into an editing tool, L1.5). User checks pending in docs/MACOS-CHECKLIST.md: step 8b (a headed `retake login
--persona` typed by hand), 10b (a real Keychain item in a step), 12b (a sandbox), 13d (the field project with a
sandbox, a hook step and compact results through Claude Code).

## Lot log (what each lot built — details for whoever touches that code)
- **Phase 1 done** (commit `0df4a29`): core (scenario language, strict schemas, positioned errors), runner-web
  (headless capture, in-page cursor on real input, click strategies, widgets, screencast → CFR mp4, timeline.json),
  hooks (http/sql/shell/js + rollback journal + allow-list), CLI (`retake …`), fixture product
  `fixtures/wholesale` ("Northfield", fictional, real Radix + Base UI), project `projects/northfield-fixture`,
  starter templates `default`, `editorial`, `motion`. 275 tests pass (6 Postgres tests need `RETAKE_TEST_PG`).
- **L1.1 done** (phase-1 polish + `retake doctor`): invented fixture names (test-guarded), ripple ring visible on
  same-colour buttons, field-notes ripple/motion curves, scene `cursor` key (auto rest point next to the first
  target, no visible jump), every widget click in `data.clicks`, standalone hook journals in
  `<project>/.retake/journals/`, pacing `nudge_*`, `after_navigation_ms`, `popup_fallback_ms`, `scroll_offset`,
  64 KB DOM snippets, project `locale` → browser locale, missing hook files are errors, `retake doctor`,
  `docs/MACOS-CHECKLIST.md` (the steps of L1.5). 301 tests pass (6 Postgres tests skipped).
- **L2.1 done** (phase-2 contracts in core): `ComponentKind`, `COMPONENT_KINDS`, `ComponentRef`, `ComponentId`,
  `COMPONENT_ID_RE` and `FrameSpec` live in `packages/core` (`@retake/components` re-exports the first three);
  template `brand` + `components` (id or `{id, params}`, `null` = none) with `resolveThemeComponents()` (legacy field
  mapping, `source: theme|legacy|default`) and a validation warning when an entry contradicts a legacy field; scenario
  `intro`/`outro`/`interstitial` take `component` + `params`, new `card:` entries (no capture time, `card-<n>` default
  id), `frame` = FrameStyle or layout id on project/scenario/scene, step `overlay` (≤ 30 s); the runner records card
  scenes, `event.overlay` with the anchor measured at the END of the step (camera too) and `timeline.video` (title,
  intro, outro, effective frame, template, music; `timelineVideo()` in core). Starter templates declare brand +
  components; the quote fixture has a card and an overlay (run `20261011-172942-quote`: overlay bbox on the €720.00
  total). JSON Schemas regenerated. 345 tests pass (6 Postgres tests skipped).
- **L2.2 done** (components package, `@retake/components`): `component.yaml` strict zod schema + `parseManifest`
  (positioned issues; id = folder; semver; slots + `default_from` sources; params = JSON-Schema subset with defaults,
  objects closed; preview samples fill required slots; layout `geometry`/`geometry_vertical` inside 1920×1080 /
  1080×1920) and `schema/component.schema.json` (`pnpm -F @retake/components gen:schema`, test-guarded);
  `loadComponentRegistry({root})` (retake.yaml `components_dir` → `packages/components/library/` — empty until L2.5;
  override warning; invalid folders as `notices`; `list`/`has`/`get` (did you mean)/`resolve(ref, kind)` (defaults
  merged, validated, kind checked)/`resolveTheme(template)`); `validateComponent(dir)` (esbuild in-memory compile:
  only react, remotion, `@retake/components/kit` and own files; react/remotion/kit named imports checked against
  their real exports; Math.random/Date/fetch/timers scan); 8 per-kind scaffolds `packages/components/scaffolds/<kind>/`
  (valid components `scaffolds/<kind>`, theme-driven, unit-sized, deterministic; stand-ins for the render pipeline)
  + `createComponent`; `themeTokens(template, urls)` (font family names `ds-<template>-display|body` + `font_faces`);
  `fillSlots` (default_from sources, for the planner); the kit (easing incl. theme zoom_ease, frame-driven
  fade/rise/stagger, `fitText` with balanced lines + ellipsis, Background/Logo/Wordmark/SafeArea/FitText, colour
  helpers); `ComponentProps` gained `area` (caption), `anchor` (overlay), `direction` (transition); CLI
  `retake components list|validate|create` (+ `--json`); `FrameComment` type + `COMMENTS_DIR` in core; README section
  "Components". 427 tests pass (6 Postgres tests skipped).
- **L2.3 done** (edit planner, `@retake/editor`): `planEdit({timeline, template, project, registry, captureFile,
  scenario?, overrides?})` pure + deterministic (src/plan.ts; time maps in src/timing.ts, camera/reframe in
  src/camera.ts, geometry + `mapSourceRect` in src/layout.ts, component precedence in src/resolve.ts, `summarizePlan`
  + `resolvePlanAssets` in src/summary.ts). Contiguous same-page clips are planned as one *run* (one continuous time
  map: speeds, ramps, trims and camera continue across the join, then split back into clips). `srcFrames` are exact
  CFR frame indices (frame n = capture time n/fps; `timeline.capture.frames` is the screencast frame count, the CFR
  count is round(duration·fps)). Plan types extended additively (PlanTransition on segments; clip cues/layout/src/
  speeds/trims/zooms/heldFrames; OverlayUse.anchor in source px; PlanLayout.crop/fallback; ResolvedComponent.missing;
  `plan.assets` maps `ds-asset:<name>` URLs → files and `plan.meta`). `retake plan <project> <run|latest>` (summary,
  `--json`, `--out`, `--theme`, `--frame`, `--vertical`, `--scenario`); README "Editing". Tests: real timelines
  `packages/editor/test/fixtures/{catalogue,quote}.timeline.json` (runs 20261011-182524-catalogue /
  20261011-182706-quote) + synthetic timelines; a temp workspace scaffolds `components/studio/*` with
  `createComponent` (helpers add the params the starter themes pass: layout-card `width`, transitions `duration`,
  caption-below `position`, *-minimal `logo_only`). Plans: catalogue 59.0 s, quote 56.3 s (no page loads, crossfades
  at every non-contiguous join, card + interstitial + €720.00 callout in the quote). 476 tests pass (6 Postgres tests
  skipped).
- **L2.4 done** (render pipeline): placeholder built-in library `packages/components/library/studio/*` — the 18 ids the
  starter themes and the legacy mapping use (intro-stack/-minimal, outro-stack/-minimal, card-title,
  interstitial-clock/-plain, layout-card/-browser/-laptop/-phone/-raw, caption-below/-overlay, overlay-callout/
  -lower-third, transition-crossfade/-fade-black), theme-driven, tag `placeholder`, accepting the params the themes
  pass; layouts draw exactly their declared geometry (layout-card accepts `width` but draws 1560 × 877.5 until geometry
  follows params) and no longer draw the brand mark (the composition does; scaffold layout changed accordingly).
  Compositions `DemoVideo`/`DemoVertical` in `packages/editor/src/remotion/` (Root.tsx, DemoVideo.tsx, frames.ts pure
  helpers, fonts.ts, modules.ts). Render pipeline in `packages/editor/src/render/`: generated entry + registry module
  and bundle cache (bundle.ts, `<root>/.retake/cache/remotion-<hash>/`, ≈ 10 s per bundle), asset server
  (asset-server.ts), browser choice (browser.ts, playwright-core registry), `renderVideo`/`renderPlan`/`renderStill`
  (render.ts), runs/versions/`listRenders` (runs.ts), RenderRecord types (types.ts). CLI `retake render` and
  `retake still` (packages/cli/src/commands/render.ts); README "Rendering"; DESIGN-phase2 §2.2 updated. 513 tests pass
  (6 Postgres tests skipped); new: components/test/library.test.ts, editor/test/render-units.test.ts,
  editor/test/render-real.test.ts (colour-coded synthetic capture: every sampled output frame shows the plan's source
  frame), cli/test/render.test.ts. Fixture renders `projects/northfield-fixture/renders/{catalogue,quote}-v1.mp4`
  (runs 20261011-182524-catalogue / 20261011-182706-quote) checked frame by frame.
- **L2.5 done** (reference-look components): `studio/intro-stack`, `outro-stack`, `layout-card`, `caption-below`,
  `interstitial-clock`, `transition-crossfade` rewritten (tag `reference-look`, 1.0.0; the 12 other ids stay
  placeholders until L2.7). Every colour/font/logo/wordmark from the theme; text placed by its CAP BAND (look.md
  positions are cap centres) with the new kit `fontMetrics` / `capTextLayout` / `<CapText>` (canvas metrics in the
  browser, estimate in Node); intro/outro = bands + measured gaps, whole stack centred; wordmark = a visual height
  (image, or the brand name in the display font × 1.3 — kit `Wordmark` semantics changed accordingly); night tone =
  `colors.dark` else the darker of text/paper; readability guard (`readableOn`); `biasMotion(style_bias)` (real = the
  reference motion; balanced/motion: more rise, scale/tracking settles, self-drawing caption rule and clock ring,
  1–2 % crossfade scale). **Geometry expressions**: layout manifests may write every geometry value as an expression
  over numeric params, `vars` and `aspect` (packages/components/src/geometry.ts; parseManifest checks them; JSON schema
  `GeometryValue`); `planEdit` evaluates them per use with the capture aspect (warning + fallback when they fail or
  leave the frame); the composition passes the evaluated rects to the layout as `props.rects`. layout-card: width 1560
  → card {180, 40, 1560 × 878}, caption {180, 930, 1220 × 110}, brand mark {1420, 965, 320 × 40}; width 1400 →
  {260, 85, 1400 × 788}; height follows the capture aspect (≤ 878). Caption-below: kicker row centred 28 px and line
  cap-centred 65.5 px under the caption area top; a caption enters 0.15 s after the clip start and leaves 0.15 s
  before its end (no double exposure in crossfades). Interstitial veil: ease-in over 0.6 s (matches the reference at
  ≈ 0.4 s better than look.md's 0.5 s). Kit radial background refitted to the reference (lighter at the top).
  Editorial caption line 35 → 38 px. `renderStills` (several frames in one browser session). interstitial-plain
  `tone: paper` now uses the theme paper (was light on the dark motion theme). Tests: components/test/geometry.test.ts,
  editor/test/planner-geometry.test.ts, editor/test/render-look.test.ts (pixel analysis of real stills: rule, card
  edges, caption, brand mark, logo rows, clock, texts within ≤ 3 px; motion at 0.4/1.0/1.3 s; width 1400 on screen;
  half size; determinism), library.test.ts rewritten for the reference look. 540 tests pass (6 Postgres tests
  skipped). Fixture renders `renders/{catalogue,quote}-v3.mp4` compared side by side with the reference stills.
- **L2.6 done** (review package, `@retake/review`): `reviewRender({project, render: id|path|'latest', scenario?,
  fps?: 1|2, previous?: id|false, thumbnails?: false|'sheets'|'all', thumbnail_px?, rules?, sheet?, out?})` →
  `ReviewResult` (src/review.ts; contract in src/types.ts with `DEFAULT_RULES`). Writes `review/<render-id>/` aside and
  swaps it in: `sheet_<fps>fps.jpg` (+ `_p2`… pages, ≤ 6×10 tiles shared evenly; labels timecode · frame, segment ·
  step · ◆ marker · ⇄ transition; tiles outlined red/orange where a finding points), `sheet_scene_<id>.jpg` (2 fps,
  scenes/cards/interstitials), `keyframes/<marker>.png` + `<seg>-first/-last.png` (first/last fully visible frame) +
  `intro-hold`/`outro-hold`, `timeline.json` (output time: segments + components/caption/transition/layout/speed/zooms/
  overlays, transitions, captions, markers, step spans, clicks placed on the output — src/timeline.ts), `report.json`,
  `report.md`, `diff_<previous>.jpg`; returns JPEG thumbnails ≤ 1280 px as base64 (sheet pages + marker key frames by
  default). Frames: one ffmpeg `select` pass per video (render, capture, previous render), raw RGB streamed with
  back-pressure (src/ffmpeg.ts); sharp tiles/sheets/key frames (src/sheets.ts); stats in JS (src/pixels.ts: share near
  the median colour, luminance sd, 96×54 signatures; also `readImage`/`bbox` for tests). Spans (src/spans.ts): visible
  `[from, next.from)`, `clearFrom/clearTo` outside transition windows. Checks: src/checks.ts (no pixels: durations,
  long scenes, captions — mismatch, overlaps, `fitText` with the theme's REAL font files via src/fonts.ts (cmap/hmtx
  reader; `fitText`/`estimateTextWidth` now exported from `@retake/components`), brand mark —, text slots vs
  `max_chars`, cursor at clicks with `viewOf`, camera, transitions over clicks, render status/probe/missing components)
  and src/pixel-checks.ts (blank/near-uniform screen runs with the capture frame consulted, blank/loading scene starts,
  screen changing during the opening still, `long-wait` = unchanging screen ≥ 3 s while the scenario waits — wait
  steps + time after an action until the next step, holds excluded —, caption not visible, empty cards); src/diff.ts
  (per-segment durations and plan changes, sample frames compared at the same segment offset). CLI `retake review
  <project> <render|latest> [--scenario] [--fps 1|2] [--previous ID|--no-previous] [--strict] [--json]` and `retake
  render --review` (packages/cli/src/commands/review.ts); README "Reviewing a render"; DESIGN-phase2 §3 notes. Tests:
  review/test/review.test.ts (synthetic renders drawn with ffmpeg from real plans of synthetic runs at quarter size:
  clean case, blank screen + blank scene start, overlapping / wrong-scene captions, too-long captions, cursor outside
  the zoom + off screen + two zooms, transition on a click, 35 s scene + long wait + empty cards + pagination, video
  length warning/info, diff, lookup errors), review/test/checks.test.ts (fixture plans pass the plan checks; caption
  width with the real font = 1079 px vs 1072 px of ink on the render), cli/test/review.test.ts, render.test.ts
  `--review`. 572 tests: 566 pass, 6 Postgres tests skipped (one timing flake in runner-web scene-cursor passed on
  rerun). A 1-min 1080p review takes ≈ 10 s.
- **L2.7 done** (layouts & previews): the whole built-in library is final (19 components, all 1.0.0, no placeholder
  left): layout-browser (macOS window: traffic lights, optional tab strip, address bar showing the REAL url of the
  capture at the frame's time from the timeline's urls track, chrome auto/light/dark), layout-laptop, layout-phone
  (dynamic island, status bar strip above the capture so the island hides nothing), NEW layout-tablet (portrait/
  landscape chosen by the capture aspect; frame style `tablet` in core), layout-raw (full frame, caption area for
  caption-overlay), caption-overlay (translucent night band, kicker lifted to contrast in the accent's hue), card-title,
  intro-/outro-minimal (`logo_only`), interstitial-plain (`tone` dark|paper), overlay-callout (pill + pointer toward
  the anchor bbox, clamped inside the screen or the safe area — exported `placeCallout`), overlay-lower-third,
  transition-fade-black (`through` black|night, `color`). Device geometry is written as expressions over params and the
  capture `aspect` (0/1 switches with `min/max/ceil`, no comparisons); a capture whose aspect is outside the device's
  proportions is letterboxed/pillarboxed on the theme background (`PlanLayout.display` / `LayoutRects.display`).
  Kit: `devices.ts` (deviceTones, SYSTEM_COLORS, addressParts, cardShadow), `liftToContrast`, `captionBandBox` (shared
  with review: `captionRegion(plan, clip)` → caption band over the capture for `position: over`). caption-below paints a
  paper band when its area overlaps the capture (raw layout). **Previews** (R-CMP-12/13/14): composition
  `ComponentPreview` (packages/editor/src/remotion/Preview.tsx; spec built by `buildComponentPreview` in
  src/preview.ts: layouts with sample screens of the fixture shipped in `packages/components/preview/` — desktop
  1280×720, tablet 820×1180, phone 390×844, generated once by `scripts/preview-samples.mjs`; captions/overlays/
  transitions inside the theme's own layout; transitions mid-way into a card-title), `renderComponentPreviews`
  (render/preview.ts: one bundle + browser, still at half scale = 960×540, ffmpeg palette quantisation when > 200 KB),
  `retake components preview [id|--all [--workspace]] [--stale] [--theme <name>] [--out <dir>] [--json]` → `<dir>/preview.png` +
  `preview.json` (format, component, version, theme, moment, source hash of manifest + entry + local imports) + the
  generated block of README.md (markers; author text kept); `retake components create` renders the preview
  (`--theme`, `--no-preview`; a warning, not a failure, without a browser); `components list --json` reports preview
  state. Committed previews for the 19 library components and the 8 scaffolds (editorial; 17–195 KB);
  packages/components/test/previews.test.ts fails on a missing/stale/oversized preview. `retake still --layout <id>`.
  **Flake fix** (runner-web scene-cursor): the cursor glide advanced on wall-clock time, so a stalled tick (GC, CDP
  backlog) made the cursor jump most of the way at once; it now advances on a motion clock capped at 2 ticks
  (`MAX_TICK_ADVANCE_MS`; `PointerHost.clock` injectable) and the test asserts the glide on the recorded samples
  (≥ 8 samples, no step > 0.3 × distance, monotonic approach, lands < 1 px); unit tests with a fake slow host. A capture
  that records no frame now fails (`EncodeError`) instead of producing an empty "successful" run. **Fixture shop**
  responsive at 390×844 and 820×1180 (tabs row, single-column hero/PDP, bottom-sheet dialogs, one-month date picker,
  full-width toasts); scenario `mobile-quote` (capture 390×844 scale 1, frame phone; run 20261011-222856-mobile-quote).
  `runIdMatchesScenario` (core): `latest` for `quote` no longer picks a `mobile-quote` run. 600 tests: 594 pass,
  6 Postgres tests skipped (full suite run twice, green both times).
- **L2.8 done** (variants & export): **square 1:1** variant next to vertical 9:16 (`PlanVariant` `square`, manifest
  `geometry_square` + JSON schema, `variants: [landscape, vertical, square]`, composition `DemoSquare`, `--square` on
  plan/render/still, renders `<scenario>-v<N>-square.mp4`); every layout + the layout scaffold declare both formats
  (card / browser as tall as the format allows: a capture wider than 4:5 (vertical) / ≈ 4:3 (square) is **reframed**,
  narrower ones shown whole; devices keep their proportions; caption block below, or beside a phone / portrait tablet in
  square). **Reframing** (camera.ts `reframeTrack`, plan.ts `reframeTargets`): region of interest = cursor box (+ where
  it goes in 0.4 s), step targets (0.5 s look-ahead), hard boxes (every click ± 0.35/0.5 s — widgets: each
  `data.clicks` —, overlay anchors while shown); dead zone 15 % + re-centring; calm start (framed on the first step,
  nothing moves during the opening still); `dampedSmooth` (two first-order lags τ 0.2 s forward + backward: critically
  damped, zero phase); `corridorSmooth` (banded QP Σd² + 2L²Σ(Δd)² + L⁴Σ(Δ²x)², L 0.3 s, ADMM: the smoothest critically
  damped repair keeping the cursor and hard boxes in view — no ringing); view inside the capture; per run. Crop ≥ 0.9
  design px per CSS px (`REFRAME_MIN_SCALE`). The composition draws the crop with `object-fit: fill` (it was
  letterboxed). Kit `formatMetrics` (full-frame type ×1.2 vertical / ×1.05 square, margins halved) used by intro/outro/
  card/interstitial components, `captionMaxLines` (≥ 2 lines vertical/square, ≥ 3 in a narrow column; review too),
  `captionBandBox` puts caption-overlay bands below the card in vertical/square. **4K** (spike numbers below):
  `--force-device-scale-factor=<scale>` at launch for headless scale ≠ 1 (runner-web `scaleArgs`) → real 3840×2160
  frames; 4K render of a 1080p capture works with an upscaling plan warning. **Music bed**: `music: {file, volume, duck,
  loop}` (core types/schemas) / `--music` / `--no-music`; renderVideo measures the track (ffprobe) → `planEdit({…,
  musicDuration_s})` plans `PlanMusic.plays` (trim, or loops with 1 s equal-power seams), `musicVolumeAt` (smoothstep
  fades and ducking ×0.5 under clips, base volume on intro/outro/cards), `musicPlayGain`; MusicBed = one Html5Audio per
  play; `generateTestTrack` (ffmpeg sine chords, nothing committed). **Theme default zoom** (R-ED-22 decision):
  `DEFAULT_ZOOM` rules in plan.ts, `ZoomMove/ZoomSpan.source 'theme'`, asymmetric ease-out (`outFrames`), the motion
  starter sets `default_zoom: 1.12`. **Export**: `exportRender` (editor render/export.ts) + `retake export` (cli
  commands/export.ts) → `exports/<render-id>/` + manifest.json; formats mp4_1080p (copy / lanczos scale, CRF 18),
  mp4_4k (copy / re-render scale 2), webm (VP9 CRF 32 + Opus), vertical_9x16 / square_1x1 (re-rendered with the
  master's run, theme and overrides), gif_preview (480 px, 12 fps, palette, 15 s around the first marker). **Review**:
  widget clicks placed one by one with their bbox, `target-cut` (error), `cursor-outside-reframe`, `reframe-jump`
  (rules `reframe_max_step` 6 %, `reframe_max_accel` 1.5 %), theme zooms outside the `max_zooms` budget with
  `theme-zoom-count|cut|real`, the opening-still check compares the capture frames when the view moves. `retake plan`
  shows the reframe travel and theme zooms. Previews regenerated (15 + caption-overlay; landscape look unchanged).
  Tests: editor reframe.test.ts, planner-motion-music.test.ts, export-real.test.ts (DemoSquare frame, test track loops
  and ducking measured, export of 4 formats + manifest), planner-rules (vertical/square/music), review checks
  (variants, theme zooms, widget clicks), components library/scaffolds (square geometry = defaultRects, nothing over the
  device), runner scale-2 capture, CLI export/square. 630 tests: 624 pass, 6 Postgres tests skipped (full suite run
  twice, green both times).
- **L2.9 done** (mails, notifications & documents): **core** `mailbox: {provider: mailpit | http, url, poll_ms?,
  headers?}` (host must be allowed: allow-list helpers moved from hooks to core `hosts.ts`, hooks re-exports them),
  actions `wait_for_email {to?, from?, subject?, timeout?, as}` and `download {click, as, timeout?}`, `SceneTransition`
  (a scene / card `transition` may be a component id), timeline `artefacts` (email | document | notification, files
  relative to the run) and the `notification` event; checks: unknown `email:` / `document:` names (with a suggestion),
  project documents (`.pdf/.png/.jpg/.jpeg`, file exists), `notification:` name or 1-based index, duplicate `as`,
  `wait_for_email` without a project mailbox. **Runner** (`packages/runner-web/src/artefacts/`): `MailboxClient`
  (Mailpit `/api/v1/messages` + `/api/v1/message/{ID}`; `http`: the generic JSON shape in the README), baseline at run
  start, oldest new unclaimed match; `download` (real click; download event or new tab polled until its URL leaves
  about:blank, fetched with `context.request` = session cookies; tab closed; `watchNavigation` ignores a navigation that
  became a download); `ArtefactStore` + `ArtefactRenderer` after the capture (clean Chromium): email HTML sandboxed (JS
  off, offline, CSP, cid: inlined) at 600 px × 2 full height, PDFs with pdfjs-dist 5.4.296 (served from node_modules
  via `ctx.route`) at 2 × 96/72 (A4 ≈ 1587×2245) → `documents/<as>/page-<n>.png` + page sizes, notification icons →
  192 px PNG. **Web notifications**: the kit patches `new Notification` / `ServiceWorkerRegistration.prototype.
  showNotification` once per window; the session grants `notifications` and exposes `__retakeNotification`;
  `watchNotifications` records artefact + event (step −1 of the current scene). **Planner**: artefact slots →
  serialisable `props.media` (images as `ds-asset:` plan assets; warnings naming what the run captured), notification
  overlays start when the notification showed (inside the clip), `OverlayUse.componentFrames` when cut, tap anchors:
  manifest `anchor` / `anchor_vertical` / `anchor_square` expressions (builtins `frame_w/h`, `screen_x/y/w/h`, `aspect`,
  one-hot `style_<value>` params; `evalAnchor`, `checkAnchor`) evaluated on the outgoing overlay (last second) or card
  → `PlanTransition.anchor`. **Components** (kit `notifications.tsx`: 5 styles, sizes, placement, motion, tones,
  `AppIcon`; kit `phone.tsx`: `PhoneDevice`, `phoneCardGeometry`, wallpapers; `SYSTEM_COLORS.badge/page`):
  `studio/notification`, `studio/mail-notification`, `studio/mail-view`, `studio/document-pdf`,
  `studio/phone-lockscreen`, `studio/phone-home-badge`, `studio/transition-tap-open`; previews committed (media samples
  in `packages/components/preview/` from `scripts/preview-media-samples.mjs`), `Preview.tsx` passes media + a sample
  anchor. **Fixture**: `/signup` + `/signup/confirm` (token `latest`), confirmation email with a cid: logo into the
  built-in Mailpit-compatible API (`/mailbox/api/v1/…` on both ports, cleared by `/api/reset`), real quote PDF
  (`/quotes/:id/quote.pdf`, Chromium `page.pdf`, cached; compact print CSS fits one A4 page), console web notification
  for each new quote request (polls every 1 s), `/app-icon.svg`; smoke script checks the PDF and the mail. Project
  `mailbox`; scenario **`signup`** (new: sign-up → mail notification overlay → tap-open into the mail-view card →
  lock screen → home badge → tap-open into the confirmed account → first product) and **`quote`** (setup hook
  `open-console` opens the console tab; the captured notification overlaid when it showed; `download` of the quote PDF
  + `quote-pdf` document card; the request scene split into `request` + `delivery`, see notes). Tests: core
  artefacts.test.ts, runner artefacts.test.ts (8: mailbox baseline, cid, sandbox, download event 2 pages, new tab with
  the session cookie, Notification + service worker, project document), components library-l29.test.ts (anchors vs
  layout, media rendering, page selection, grouping, badge, tap-open, dark theme and all formats), editor
  planner-artefacts.test.ts (frozen timelines `signup.timeline.json`, `quote-artefacts.timeline.json`). 671 tests:
  665 pass, 6 Postgres tests skipped (full suite run twice, green both times).
- **L2.10 done** (tutorial overlays & story cards): **core** `tutorial` switches on the scenario, a scene or a step
  (`true` / `false` / a mode — `spotlight: steps | clicks`, `progress: scenes | cards` — / `{component?, params?}`;
  `resolveTutorial`: most specific wins; `progress` is scenario-only, a warning elsewhere; a step switch that cannot
  apply to its action is a warning), `TUTORIAL_FEATURES` / `TUTORIAL_COMPONENTS`, `parseFrameRef` (`mark:` / name,
  `start:` / `end:` scene, `12.5s`, image file), action `capture_text: {target, as, pattern?}` → `text` artefact
  (checks: target, regex, duplicate `as`), slot checks for `capture:` (capture_text names), `before:` / `after:`
  (marks, scenes, files), `data:` (.csv / .tsv) and image slots (`logo`, `avatar`, `image`). **Runner**: switches
  copied into the timeline (`video.tutorial`, `scene.tutorial`, `event.tutorial` — the editor never reads the
  scenario); `capture_text` polls the kit's `visibleText` until the pattern matches → `artefacts/texts/<as>.json`;
  `type` records `data: {chars, cps, t_type, t_typed, t_enter?}` and, without `into`, the focused field (kit
  `focused()`) as its target; `press` records `{key, times}`. **Planner** (`packages/editor/src/tutorial.ts`, pure,
  `TUTORIAL_TIMING`): shortcut caps per `press` and per Enter of `type`, starting 0.3 s before the real press
  (`moment`), trimmed by the next; spotlight = one overlay per run of targeted steps on the `screen` layer whose box
  glides (`OverlayUse.track`, `trackBoxAt`, smoothstep over `TRACK_GLIDE_S` 0.45 s), a click ends it 0.45 s later;
  badges beside clicked targets (per scene or video); one loupe per run of typed fields, gliding, `OverlayUse.region`
  rendered from the capture itself; `plan.tutorial = {uses, skipped, progress}` (chapter bar between intro and
  outro); tutorial targets join the reframe targets; skipped → plan warning. Story-card media: `frame` → `PictureMedia`
  (capture frozen at the time, or an image file as plan asset), `data` → `TableMedia` (`parseCsv`), `capture` →
  `TextMedia`; project files read before planning by `planInputFiles` (CSV text, image sizes; wired in render, still
  and `retake plan`); `planComponentIds` includes the progress component. **Composition**: screen layer drawn before
  the brand mark and caption, `moment` / `region` / `chapters` props, the progress bar at the top level, `avoid`
  (the caption band of a caption over the screen; for the loupe and badges also the key caps' row — `overlayAvoid`,
  `shortcutRow`, kit `shortcutPlateBox`) and one side for a loupe gliding over several fields (`loupePlacement`, kit
  `loupeLens`). **Components**
  (kit `keys.ts`, `figures.ts`, `qr.ts`, `icons.tsx`, `picture.tsx`, `place.ts`; slot types `capture`, `frame`,
  `data`; manifest `preview.target: button | field`): `studio/overlay-shortcut`, `overlay-spotlight`, `overlay-steps`,
  `overlay-loupe`, `overlay-progress`, `card-figure`, `card-features`, `card-before-after`, `card-testimonial`,
  `card-cta` (QR from the kit's encoder — byte mode, v1–40, L/M/Q/H — equal module for module to the `qrcode`
  package, a devDependency of components used by the tests only), `card-chart`; previews committed (sample frames
  `preview/frame-before.jpg` / `frame-after.jpg` from `scripts/preview-frame-samples.mjs`, sample field box).
  **Review**: `tutorial-skipped`, `tutorial-target-cut` (box centre outside the visible capture at the overlay's start,
  middle, end), `media-missing` (capture / frame / data slots that did not resolve); the opening-still check compares
  capture frames when an overlay or a caption over the screen comes in during the still (it flagged the spotlight fade
  and the motion theme's caption entrance). **CLI**: `render --tutorial | --no-tutorial`. **Fixture**: shop search
  focus shortcut (⌘K / Ctrl+K or "/", `⌘K` hint); `signup` with every tutorial overlay (Tab between fields, a `type`
  without `into`, ⌘K → type Selowa ↵ → result); new `highlights` (coffees, quotes with `capture_text` of the proposal
  total + `mark: proposal-open`, then figure, before/after, features, chart from `data/quotes-per-month.csv`,
  testimonial, CTA cards). Tests: core tutorial.test.ts, runner tutorial.test.ts, components qr.test.ts +
  library-l210.test.ts, editor planner-tutorial.test.ts (frozen timelines `signup-tutorial.timeline.json`,
  `highlights.timeline.json`), review tutorial.test.ts; library / registry / previews / CLI counts now 37 built-in
  components. `SYSTEM_COLORS.white` / `.black` (mask, QR plate and modules, last-resort ink) keep the sources free of
  colour literals (test-guarded). 757 tests: 751 pass, 6 Postgres tests skipped (full suite run twice, green both
  times).
- **L2.11 done** (multi-page capture: split screen & picture in picture): **core** scene `pages:` (map `id →
  {page?, open?, viewport?, label?, cursor?} | null`, or a list of ids continuing earlier declarations / objects),
  `open: "<env page>:/path"`, viewport presets (`desktop` = capture size, `laptop` 1440×900, `tablet` 820×1180,
  `mobile` 390×844 with touch + mobile UA, or `{width, height, mobile?, touch?}`), step `on: <page>`, `pacing.
  page_switch_ms` (500), `frame: split | pip`; `pages.ts` (`resolveScenePages`, `scenePageEntries`, `splitPageOpen`,
  `stepPageOf`), positioned checks (unknown pages with suggestions, `on:` outside / unknown, page/open beside pages, not
  two pages, duplicates, new_tab / switch_page inside, a page id asked at another viewport, a single-page scene filming
  a page whose viewport is not the capture size — explicit, via switch_page / open, or by continuation), timeline
  `tracks[]`, `scenes[].pages`, `events[].page`, `markers[].page`; schemas regenerated. **Runner** (`runtime.enterPages / leavePages / act`, `scenes.ts
  runPagesScene`): one screencast + `TrackBuilder` per page id for the whole run, on the shared clock, encoded on the
  CFR grid of `capture.mp4` as `capture-<page>.mp4` (same frame count); viewport by a persistent CDP emulation session
  per page (detaching reverts it); one `Pointer` per page (only the acting one moves; switch = `page_switch_ms` pause
  then a glide from its rest; a page with no step of its own in the scene rests near its centre — never under a PiP
  inset); the main recorder pauses during multi-page scenes (not created when every scene is multi-page: `capture.mp4`
  is then a copy of the first track); a mobile page in a single-page scene or a page whose viewport changes is a
  StepError (also caught by the validation now); `rt.resolveUrl` resolves a page id of `pages` against the environment
  page it was declared on (base path kept). **Planner** (`editor/src/panes.ts`): `plan.tracks`, clip `panes` (fit
  top-aligned in the layout's panes, per-page camera / reframe / URLs) on one `srcFrames`, `acting` (the opening still's page from
  the clip's start; a joined clip eases from the previous one's), PiP `inset` (`planInsetTrack`: corners kept off the
  main page's current and next targets — `stepBoxes`: `focusBox` ±180×110 CSS px around the acted point + the
  `leadingBox` of a wide target, clearance, caption band soft —, glides `INSET_LEAD_S` before, ≥ `INSET_MIN_HOLD_S`
  apart, never while its page acts (a corner the next main-page step needs is reached after the inset's step; ties go
  to the corner the next steps leave free), continues across joined clips; grows ×1.18 while its page acts with
  emphasis — `growClearOf` lowers it, to 1 under 1.04, so it never reaches a caption band over the screen), automatic
  split / pip for a single-pane frame, fallback for single-page scenes, theme-dressed (radius, shadow, chrome), geometry keys `panes` /
  `inset` and the `aspect2` variable; tutorial per pane (`OverlayUse.pane`; badges numbered once per clip in time order
  over both pages, `planBadgeNumbers`; an inset's spotlight and badges stay inside it, `staysInInset`, its caps / lens
  use the main page's room and keep clear of its targets — `clear[].pane`); a caption band
  over the screen goes below a split (note); story-card frames of a page read its track. **Composition**: one
  `CaptureScreen` per pane (`source`), `rects.panes` (`layoutPaneRectsAt`, eased acting weights), overlays mapped per
  pane, main-page overlays clipped around the inset (`insetHole`). **Components** `studio/layout-split`,
  `studio/layout-pip` (kit `panes.tsx`: `WindowBar`, `PaneLabel`, `InsetCard`, `InsetPhone`, `insetPhoneEdge`),
  previews committed; manifest `preview.screens`. **Polish carried over from L2.10**: `OverlayUse.clear` (current
  target + click targets of the next `CLEAR_LOOKAHEAD_S` 1.2 s) → `avoid` (`kind: 'target'`), key caps take the other row
  (`shortcutSlot`), kit `stepBadgeBox` / `shortcutPlateLayout` shared with the review (`drawnOverlayBox`), the loupe
  cross-fades two fixed regions instead of panning (`trackKeysAt`). **Review**: clicks per pane (`OutputClick.page /
  pane`, `cursorAt(…, page)`), cursor / reframe / tutorial checks per pane, capture-frame keys `<track>:<frame>`,
  `overlay-covers-target` (caps, badge, loupe, PiP inset over > 15 % of a click target of the current / next step),
  `tutorial-stale-target` (a spotlight or badge still on its target > 0.6 s after its page changed URL; the planner
  ends a spotlight run and a badge after a click that navigates, `stepNavigates`), `target-outside-view` is an info
  when a reframed target larger than the view shows its leading part and the click. **Reframe** (all vertical /
  square plans): a wide target counts by its leading part (`leadingPart`), a run starts framed toward the page's
  top-left, a cursor resting alone after its step is only brought back inside the dead zone, an idle pane settles on
  its page's heading at the start of a scene where it only rests (`reframeTrack({settle})`). **Fixture**: live lists
  (`useLiveList`, 1 s poll, "New" pill) in the console's quote requests and the shop's quotes, and the shop's
  notifications bell polls every second (unread badge + ring a second after the console's proposal); scenarios
  `live-quote` (split, step badges) and `phone-and-desktop` (pip, step badges; the send scene holds 1.2 s so the
  request reaches the desk's list before the desk's opening still). Bundle hash covers
  `COMPOSITION_DEPS` = layout, util, plan-types, panes. Tests: core multipage.test.ts, runner-web multipage.test.ts,
  editor planner-panes.test.ts (frozen timelines `live-quote.timeline.json` = run 20261012-073840-live-quote,
  `phone-and-desktop.timeline.json` = run 20261012-080444-phone-and-desktop), review multipage.test.ts, components
  library.test.ts (multi-page layouts); review-fix tests in the same files plus editor reframe.test.ts (leading part,
  leading start, settle), planner-tutorial.test.ts (navigation ends the spotlight run and the badge), review
  tutorial.test.ts (`tutorial-stale-target`); counts now 39 built-in components. 792 tests: 786 pass, 6 Postgres
  tests skipped (full suite run twice after the review fixes, green both times). No dependency added.
- **L2.12 done** (bring your own media & motion; R-OWN-01…05): `intro`, `outro`, `card`, `interstitial` take
  `{video | image | lottie, from, to, fit, background, volume, duration}` and a template's `components.intro / outro /
  interstitial` may be a file (relative to the template folder) — no component is mandatory. **Core**: `types.ts`
  (`MediaFileFields`, `OverlaySpec`, `OverlayAt`, `OVERLAY_ANCHORS`, `MEDIA_COMPONENTS`, `TemplateMediaRef`),
  `media.ts` (`mediaSegmentUse`, `overlayUseOf`, `probeVideoFile` = sync ffprobe cached by path / size / mtime,
  `readLottieMeta`), `checks/media.ts` (positioned: one file per use, extension per kind with hints, existence, image
  signature, Lottie JSON, codec / container / alpha / from-to / volume via ffprobe). **Components**: `studio/media`
  (video, image; `fit: auto` default = cover when covering keeps ≥ 80 % of each side, else contain) and
  `studio/lottie` (`@remotion/lottie` 4.0.534 + `lottie-web` 5.13.0 — the only dependencies added; `colors` maps the
  file's colours to theme keys), both kind `card` with `kinds: [intro, outro, interstitial, overlay]` (new manifest
  field; the registry resolves an id for any of its kinds, the component gets `props.as`); slot types `media` /
  `lottie` → `props.media.file` (`VideoMedia` with size, length, fps, audio, alpha, codec; `LottieMedia`); kit
  `media.tsx` (`VideoFile` with `transparent` for alpha, plays once then holds its last frame, or loops; `ImageFile`,
  `LottieFile`, `recolorLottie`, `autoFit`, `mediaBackground`); previews committed. **Editor**: `inputs.ts`
  `planInputFiles` reads every file before planning (the planner stays pure); the scenario file → theme file → theme
  component chain; durations from the file (note `"<where>": your file … for N s`, and a note when `fit: auto`
  contains); file overlays: `at` (step / end, start, click, `mark:<name>`, seconds), `box` (`rect`, or target /
  cursor / screen / a corner or side: the file's own size × `scale` in page px), layer `screen`, mapped per frame by
  `overlayBoxAt` (layout, camera, reframe; `insetHole` around a PiP inset); music ducks under clips and under files
  that play sound (`duckSpans`, `playsSound`); render record `encoding.audio`: `silent | music | files |
  music+files`. **Catalogue long-wait, root cause** (R-OWN-05, `timing.ts` `waitingSpans`): a marked wait protected
  its whole waiting at 1× — now a marked wait protects only the moment its state appears (around its end), and the
  waiting itself (wait steps + the load pause before a wait that really waited) plays at up to 4× after its first
  0.5 s (`WAIT_SPEED`, `WAIT_KEEP_S`; step speed wins; off with `overrides.trim_idle: false`). **Review**:
  `media-missing` covers files ("could not be read — nothing is shown"), `empty-segment` names the file. **CLI**:
  `retake components new` (alias of `create`), plan / render pass the template (theme files). **Docs**:
  `docs/BRING-YOUR-OWN-MOTION.md` (linked from the README; export settings for motion tools, Remotion, Lottie,
  workspace components, the output of Claude motion / design skills), README section "Your own media and motion",
  DESIGN-phase2 §1.9. **Fixture**: `scripts/fixture-media.mjs` renders the media with Remotion
  (`fixtures/own-media/src`: intro 1920×1080 3.6 s with a chime made by ffmpeg, end card, a 480×480 VP9-alpha burst;
  `--prores` also writes a ProRes 4444 burst to `.retake/`) and `fixtures/own-media/lottie.mjs` writes two
  hand-written Lottie files → `projects/northfield-fixture/assets/` (each < 300 KB; `.gitignore` lets
  `projects/*/assets/*.mp4|webm` in); scenario `own-media` (46 s). Tests: core media.test.ts, components media.test.ts,
  editor planner-media.test.ts and render-media.test.ts (real render: the intro's tone, VP9 and ProRes alpha pixel
  checks with a halo scan), review tutorial.test.ts case; planner-real / planner-rules / review tests updated for the
  waits; counts now 41 built-in components. Dependencies added: `@remotion/lottie@4.0.534` and `lottie-web@5.13.0`
  (components). **Review fixes** (two reviewers, code + video editor): (1) a file's own sound dipped and clicked where
  the transition after it began and never got its end ramp — `VideoFile` took its 4-frame ramps from the frame
  Remotion passes to a `volume` callback, which restarts at 0 inside TransitionRender's `<Sequence from={-shift}>`;
  the gain now comes from the video element's own frame (kit `filePartGain`, a number per frame); render test with an
  intro leaving and an outro entering by crossfade (per-frame RMS within 1 dB, end ramp; fails on the old callback).
  (2) the vertical / square reframe kept a step overlay over [step end, +2.5 s] and its target — now over the capture
  time it really shows (`overlayStartAt`: `at` incl. click / marks / seconds, its own length through the run's time
  map) and its real box (a file's box on the target / cursor, a `rect`): `stepOverlayOf` resolves each step overlay
  once for the reframe and the clip. (3) a file at a corner / side moves to the nearest free corner (side) when, in the
  variant's framing, it would cover its step's or the coming steps' `stepBoxes` (`SCREEN_POSITION_CHOICES`, plan
  note), and the review's `overlay-covers-target` measures user file overlays at screen positions (hover targets too).
  (4) a kind-wide `overrides.components.overlay` no longer replaces user files (note). (5) a missing / unreadable file
  is no longer a plan asset (the render refused the plan). (6) with `overrides.trim_idle: false` a marked wait step is
  protected whole again (`protectedSpans(…, waitsFaster)`). New tests in render-media, planner-media (4) and review
  tutorial (1). 833 tests: 827 pass, 6 Postgres tests skipped (full suite run twice after the fixes, green both
  times).
- **L2.13 done** (raw capture export for editors; R-RAW-01…06): `retake export-capture <project> <run|latest>
  [--scenario] [--format mp4|prores] [--fps 30|60] [--cursor baked|none|layer] [--layer prores|webm] [--selects]
  [--no-cuts] [--out] [--json]` and `retake run … --raw [same flags]` (packages/cli/src/commands/export-capture.ts;
  engine `exportCapture` in **runner-web `src/raw/`**: plan.ts, encode.ts, cursor.ts, layer.ts, markers.ts, export.ts)
  → `<project>/exports/<run>-raw-<format><fps>-<cursor>/` = `clips/NN-<scene>[-<page>].mp4|mov`, `cursor/`
  (cursor.json, cursor.csv, clicks.csv, `NN-<scene>-cursor.mov|webm` layers), `markers/<scenario>.fcpxml|.edl|.otio`
  + markers.csv/json, optional `selects.*`, `manifest.json`, `README.md`. **Clips**: one per scene (per page of a
  multi-page scene, same frames; the page of the opening still is on the sequence), from the still (page loads never
  in), real time; **loading cuts** (`loadingCuts`): a run of `wait_for` / `wait_for_email` that waited ≥ 0.3 s is cut
  from 0.3 s after the LAST press of the step before (`actionMoment`: its option / item / confirm click, its Enter, the
  end of its typing; a drag or repeated keys whole) — or that press's URL change — to the awaited state painted (wait
  end + 1.5 local screencast intervals, 0.05–0.3 s, then the next screencast frame when the page was still painting —
  the catalogue import dialog paints a frame behind its DOM at ≈ 8 fps); not made when the scene ends < 0.2 s after
  it (loading kept, note: add a `hold`); `--no-cuts` keeps them. Frames: `cfrSchedule` at the export rate over `frames.jsonl` (60 fps = real screencast
  timing, never interpolated), encoded once from the JPEGs (MP4 libx264 high CRF 14 GOP 1 s yuv420p faststart;
  ProRes 422 HQ prores_ks profile 3 yuv422p10le), BT.709 tv; each clip's tmcd timecode = its sequence position (source
  TC = record TC); runs without kept frames fall back to the CFR video (tag-aware decode, frames repeated, note).
  **Cursor**: runner option `hideCursor` (kit `cursor.hidden` → `.c,.rps{display:none}`; `timeline.capture.cursor:
  hidden`, `run.json options.cursor`; the cursor-motion fps warning is skipped then); the kit now reports icon / press /
  release / ripple through the binding `__retakeCursor` → `timeline.cursor_effects` (+ `tracks[].cursor_effects`,
  current icon when a page starts being filmed); `api.cursorLook` exposes the overlay's CSS + markup. Layer:
  `renderCursorAtlas` draws the kit's look in Chromium (icons × 11 press scales, ripple every 1/120 s), Node composites
  per frame, ffmpeg `prores_aw` profile 4 (5× faster than prores_ks here, alpha within 1/255) or VP9-alpha WebM; runs
  before L2.13 get approximated icons / presses / ripples (`approximateEffects`, noted). **Markers**: scene (chapter),
  step, mark, caption (until the next), cut — FCPXML 1.10 (assets with media-rep and start = timecode, one project,
  spine, ProRes layers lane 1, other pages connected `enabled="0"`; WebM layers left out), CMX 3600 (reel CLIP<nnn>,
  `* LOC:`), OTIO JSON (V1, Cursor, Page n tracks; `file://` target URLs; WebM layers from media time 0), CSV / JSON;
  a marker at a scene's very end sits on the clip's last frame. project.yaml `raw` defaults (core `RawSettings`, schema regenerated). Output
  folders are replaced only when new, empty or an earlier raw package. Editor: a hidden-cursor run plans with a
  warning. Tests: runner-web raw-units.test.ts (21: cuts, plans on frozen catalogue / quote / live-quote timelines,
  writers, cursor model, kit CSS drift, settings), raw-real.test.ts (two real captures with the debug cursor — hidden /
  baked —: effects recorded, no cursor pixel, no loading frame, green first frame after the cut, layer dot on the baked
  dot and on the samples ±1.5 px, ripple ring, refusals, folder guard), cli export-capture.test.ts (colour-coded run:
  each capture frame twice at 60 fps, load out, video fallback; usage errors), editor planner-rules (hidden-cursor
  warning). No dependency added (OpenTimelineIO only in a scratch venv to validate). 865 tests: 859 pass, 6 Postgres
  tests skipped (full suite run twice, green both times).
  **Review fixes (after two reviews — code and an editor receiving the package):** the cut no longer starts inside
  the step before the waits (it used `t_click`, the first press: a type's field click, a select's trigger — it cut the
  typing, the Enter, the open popup and the option click); the resume snaps to the next screencast frame when the page
  was still painting (at 60 fps the catalogue import resumed on a half-drawn dialog, frame 1005); a scene that ends on
  its awaited state keeps its loading (the cut ran to the clip's end: the result, the wait's step marker and its mark
  were in no clip) and markers at a scene's very end land on its last frame (live-quote "delivery" step 6 was dropped
  even without a cut); WebM layers have no timecode — the FCPXML / OTIO declared them at their clip's timecode: now
  OTIO from 0, not in the FCPXML, README and a note say Final Cut Pro / Premiere need `--layer prores`; OTIO
  target_url is a `file://` URL (Premiere via otio-fcp-adapter then gets `file://` pathurls); layer codec labels name
  no pixel format (the manifest said yuva444p10le next to ffprobe's yuva444p12le); `run --raw --json` prints one
  `raw_export` JSON line instead of a pretty manifest in the JSON-lines stream. Tests added: raw-units (last press for
  type / select / menu / drag / keys, URL rewritten while typing, scene ending on a wait with / without mark, paint
  snap at 30 / 60 fps through `cfrSchedule`, idle page, WebM interchange, ProRes layer at a later sequence start),
  raw-real (WebM package: no timecode, OTIO from 0, README; manifest pix_fmt = ffprobe), cli e2e (`run --raw --cursor
  none --json`: every stdout line is JSON, last = raw_export). 873 tests: 867 pass, 6 Postgres tests skipped (full
  suite run twice after the review fixes, green both times).
- **L2.14 done** (phase-2 acceptance + Mac handoff; R-ACC2-01…06, R-GOAL-05, R-LES-10, R-CMP-01): fresh captures of
  catalogue and quote, renders and reviews listed in `docs/ACCEPTANCE-phase2.md`. **Fixes found by the review**:
  (1) marker key frames showed the start of the marked step (a marked wait's spinner / skeleton): plan markers gain
  `done` (`markDoneAt` in plan.ts — the screen once the step is done, the rule `frame: mark:` already used) and the
  review's `keyframes/<marker>.png` is that frame (`timeline.json` markers: `done_frame` / `done_time`);
  (2) **R-CMP-01**: the composition drew a component-less fade itself (opacity envelope + `#000000` veil) — removed;
  `transitionWindows` gives such a fade the transition stand-in (`standInTransition`), review spans lost the `fade`
  kind; justified exceptions (theme background token, brand mark) documented in DESIGN-phase2 §2.2; guards in
  editor render-units.test.ts (no component-less non-cut transition in real plans, stand-in, no colour literal in
  `src/remotion/`). Renders unchanged by (2) (reviews of catalogue-v7 / quote-v17 vs v6 / v14: no visible change).
  **Helpers in the repo**: `scripts/validate-raw.py` (raw-package validator, optional, OpenTimelineIO). **Docs**:
  root `CLAUDE.md`, this file's "Mac setup" / "First local session", `docs/ACCEPTANCE-phase2.md`, BL-54 (layouts keep
  an empty caption block under an overlay caption), README phase status + validator, MACOS-CHECKLIST (clone `main`,
  validator), ROADMAP (phase 2 done, L1.5 next). 875 tests: 869 pass, 6 Postgres tests skipped (full suite run twice,
  green both times).
- **L1.5 done** (macOS verification pass, 2026-10-12, a local Claude Code session with the user at an Apple M4 /
  macOS 26.6.2 / ffmpeg 9.0.2; R-GOAL-08, R-ACC-04, R-CLI-09/10, R-SEC-02, R-ACT-28, R-PRIN-10, R-ISS-09 done, R-RAW-06
  partial): `docs/MACOS-CHECKLIST.md` steps 1–13, results table at its end. **Fixes made in the lot** (the suite was
  red on the Mac: 28 failures): ffmpeg 9 removed `-vsync` → `-fps_mode passthrough` (review `ffmpeg.ts` / `pixels.ts`,
  editor test helper) and refuses `select` expressions nested > 100 deep → `selectExpr` builds a balanced sum (log2
  depth) for the review's one-pass extraction (new review/test/ffmpeg.test.ts: 250 frames of a lossless ramp);
  `checkComponentEntry` resolves the component folder, entry and kit to real paths (esbuild reports `/private/var/…`
  for `/var/…`: a component's own imports were "leaving the folder"; validate.test.ts symlink case, fails without the
  fix on Linux too); registry test fixture `Zeta/Bad` (APFS ignores case: `Acme/` merged with `acme/`); render-look
  measures the intro kicker by its cap band (`capBand`: modal column top/bottom) — the bbox included the É accent,
  which macOS rasterises darker (the cap band is 2.5 px off target, the whole intro stack ≈ 3 px higher than on Linux,
  within tolerance). README: ffmpeg 5.1+, the validator venv on Python ≤ 3.13; checklist notes (Node per folder,
  `templates_dir`, Python). **Measured** (step 7, two captures analysed frame by frame by a workflow with an
  independent re-check of every defect): ≈ 60 frames/s while the cursor moves (cloud 15–20), 42 of 43 moves ≥ 24 fps,
  drawn cursor within 2 px of the track in 94 % of moving frames; stalls after scripted scrolls (R-ISS-11), at every
  animated dialog close (R-ISS-12) and invisible to the runner's averaged check (R-ISS-13) → **L1.3 narrowed** (ROADMAP);
  scene-start rest points (R-MAC-06 detour out of a dialog, R-MAC-07 keep vs field rule), Node guard (R-MAC-03),
  starter templates in a new workspace (R-MAC-04), keychain error formatting (R-MAC-05), late unannounced popup under
  load (R-MAC-08), doctor ffmpeg version (R-MAC-09) → **L5.1**. 878 tests: 872 pass, 6 Postgres tests skipped (full
  suite green on the Mac after the fixes, 2 m 28 s to 2 m 44 s). The diff was reviewed by a second workflow (code,
  numbers against the measurements, repository rules; each finding re-checked): `selectExpr([])` guard, the entry's
  real path taken through its folder, and wording / numbers in these docs fixed. No dependency added.
- **L5.1 done** (fixes found by the macOS pass; R-MAC-03…09): **Node guard** — `cli/src/bin.ts` is readable by any
  Node.js up to its version check (no import / export / import.meta / top-level await, ES2017; the CLI is loaded with
  a dynamic import built at run time; the cli tsconfig sets `moduleDetection: legacy` so tsc emits no `export {}`):
  "retake needs Node.js 22 or later; this is vX (path)…" (cli/test/bin.test.ts: syntax scan, a faked Node 18,
  `RETAKE_TEST_OLD_NODE` for a real one); `.nvmrc` = 22. **Starter templates** — core `STARTER_TEMPLATES_DIR`;
  `listTemplates` returns the workspace's templates plus the starters no workspace folder shadows, sorted by name (`source`; a same-named folder without a template.yaml is an error, not a silent fallback), `loadTemplate`
  falls back to the starter of that name (editor previews reuse it; doctor and `retake list` mark starters).
  **Keychain** — one line "keychain item S/A not found (reason)"; the CLI hook context logs hook errors at debug level
  (the results list prints them once). **doctor** — ffmpeg / ffprobe below 5.1 fail (`MIN_FFMPEG`; snapshot builds not
  judged). **Scene rest points** (kit `restNear(box, {point, ref})`) — candidates around the click point (±80 px of a
  wide target), inside the dialog that holds the element, neutral; else the nearest neutral gap around the click point
  (`near-<side>`; `<label>`s count as interactive). **Continuing scenes** — keep the cursor only when it is clear of
  the first target and within `KEEP_NEAR_PX` 240 px of its click point, else glide next to it during the still
  (decision recorded in DESIGN §3.3 / README). **Late popups** — a plain click that showed nothing within
  after_click_ms leaves `Runtime.pendingPopup`; the next step, when its target is not on screen yet, waits up to
  popup_timeout_ms after the press for a new popup, then marks the click `popup_opened` and keeps after_popup_ms in
  the click's step (`settleLatePopup`). Tests: kit.test.ts (dialog edge, wide field, dense form), scene-cursor.test.ts
  (far → glide, near → keep, dialog scenes), pacing.test.ts (dialog 450 ms late), core template / templating tests,
  cli doctor / bin tests. Mac re-captures: quote 20261012-191149 and 20261012-191556 (request rests 152 px from
  "Request a quote" in both; delivery at (960,458) between two selects inside the dialog in 191556 — 191149 predates
  the near-scan and rested on the Message field's edge), catalogue 20261012-191245 (scene
  starts unchanged; its known stall after the scroll stays for L1.3). **Review fixes** (a review workflow, each finding
  re-checked): bin.js resolves `main.js` next to the real file (a symlinked `retake` broke) and exits 13 when main()
  never settles; a same-named workspace folder without template.yaml shadows the starter (error, not a silent
  fallback); an out-of-view anchor is judged at its box centre (the kit's point is clipped to the viewport); a clear
  cursor is kept when no spot next to a huge target exists; the late-popup wait ends when the target shows without a
  popup; the scene-start glide's end is recorded (`t_settled`) and the review compares the opening still from 0.3 s
  after it (`stillGlideEnd`, `stillPair(span, fps, timeline)`): no false "screen changes during the opening still".
  893 tests: 886 pass, 7 skipped (full suite green on the Mac, 2 m 43 s). No dependency added.
- **L1.3 done** (capture smoothness on the Mac; R-ISS-01, R-ISS-11, R-ISS-13, R-ACC-02 done, R-ISS-02 and R-ISS-12
  partial): **diagnosis** (a temporary in-recorder trace, removed: every screencast frame, page long tasks and rAF
  gaps) — during the stalls the page had no long task, rAF ran steadily and no frame was dropped: Chromium's frame
  production stopped. Dialog close: 263–266 ms every time an element with a `backdrop-filter` goes away (none without
  the blur, also with animations off; unchanged by Graphite off, GPU raster off, zero-copy, partial raster, SwiftShader,
  CALayer overlays off, `--disable-gpu-vsync`); `--disable-frame-rate-limit` removes it (a web search found related
  backdrop-filter issues on Chrome Mac, not this one). In a standalone page it reproduces only with the kit injected
  and a real hover / press sequence — and none of the kit's parts alone (bindings, kind detection, session save,
  ripple, press state, move handlers, drop-shadow, will-change, top-layer popover, host size, hidden cursor) causes
  it: the next bisect step is in R-ISS-12's gap. After a scroll: a one-time render of newly exposed content (a 0.4 s pause after the first
  scroll removes it; later scrolls do not stall). Hover: 100–400 ms now and then as the cursor enters an element with a
  hover effect (CheckerImaging off, raster threads, low-res tiling: no reliable change). **Decision**: the flag was the
  default during the lot, then a review found that without the limiter a page's rAF runs at ≈ 24,000 Hz while any CSS
  animation is on screen (2–6× CPU; animations stepping per frame play too fast) → the limiter stays, the flag is an
  option. **Changes**: session.ts `frameRateArgs` (core `browser.frame_rate_limit: false` →
  `--disable-frame-rate-limit`, not added twice; schema regenerated); recorder
  `waitFrameAfter` / `lastFrameAt`; Runtime `filming`, `awaitFreshFrame` (after `scroll` and `ensureInView`: 1 px probes
  until 3 frames in a row within 50 ms, ≤ 0.9 s, a probe unanswered for 0.45 s ends it; skipped when the cursor is
  hidden) and `awaitCaughtUp` (Pointer `beforePress` hook + `lastMoveAt`: before a press, wait until a captured frame
  shows the last move, at most until 0.45 s after it; a cancelled run does not press); click.ts (the late-popup
  window counted from the press; the popup re-checked once the next target is found); timeline `motionCapture`
  (motion-only fps, `stalls` ≥ `STALL_MIN_S` 0.15 s in a motion or a ripple, page changes and 1 px probes ignored) +
  run.ts `motionWarnings` (a hint to `browser.frame_rate_limit` when a ripple froze); raw/plan.ts
  `RAW_CUT.result_margin_s` 0.05 → 0.2 s (the catalogue import paints 0.16 s after its DOM). Tried and dropped: dating the cursor
  track by the page's rAF after each move (lands a frame late half the time). Tests: unit (stalls, nudges, page
  changes, warnings, launch args), raw-units (new margin), raw-real (60/30 fps frame tolerance 3, every resting frame
  compared), pacing (late popup: a target found in the same tick as its dialog). Acceptance with the flag (under
  another project's test load, load 4–24): quote 20261012-211506 / -211729, catalogue 20261012-211610 / -211826 — no
  dialog-close stall, one 192 ms hover hitch; quote rendered (quote-v1, 60.0 s, 2 m 09 s) and reviewed clean.
  Acceptance with the defaults: quote 20261012-221656 / -221911, catalogue 20261012-221752 / -222005 — no stall after a
  scroll or in a move, 84 of 84 moves ≥ 24 fps (lowest 51.4), dialog closes 186–264 ms during the ripple, warned with
  the hint (the post-scroll pauses, up to 319 ms, fall in the probes: frames differ only by the 1 px probe).
  896 tests: 889 pass, 7 skipped (the e2e capture test now tolerates a freeze during a click ripple only, R-ISS-12). A review workflow checked the lot (fixed: the default flag, useless 0.9 s press waits,
  the click-time skew of the late-popup window, a press after cancel, nudges counted as motion, the raw-real flakes,
  a stale doc comment). No dependency added.
- **L1.2 done** (runner robustness for any site; R-ISS-07, R-ISS-08, R-RUN-16, R-RUN-17, R-SEC-06, R-CHO-10/13/14/15/18/
  21/24 done, R-KIT-11 closed on the way). Built in five areas, each by a subagent from a design plan and its
  adversarial critique (design workflow), then reviewed by four independent reviewers (≈ 40 findings, one high: shell
  hosts inside `$(…)` were never checked) and fixed in three passes, each finding with a regression test.
  **A — shadow DOM and frames (R-ISS-07)**: everything in the top kit (kit.ts "trees" section: winOf / styleOf / isA /
  deepHit / deepActive / composed order); boxes and points cross the kit boundary in top-level CSS px both ways; refs
  may point into same-origin frames (stale after the frame navigates); ensureInView 6 layers; a missing target behind
  cross-origin frames says "N cross-origin frame(s) not searched"; the text tier is chosen in the searched document
  first (a same-origin widget frame no longer steals a page match). Fixture: "Before you order" at the bottom of every
  product page (`<nf-brew-guide>` with an open shadow root, `/embed/shipping` iframe), scenario `embedded`; tests
  kit.test (shadow, frames, R-KIT-11 forwarding), deep.test (real capture). **B — full-page loads (R-ISS-08)**:
  hold.ts `LoadHold` + recorder (frameNavigated / lifecycle events): frames of a loading document are held until the
  page's own first contentful paint (or load + grace, or the 10 s limit, warned), released frames stamped at the
  release; `timeline.loading` / `tracks[].loading` (`until`, `held_frames`); the kit draws the cursor on a new document
  only after the page's first paint (the cursor faking the first paint was the cause of the blank catalogue shell);
  Runtime `awaitLoaded` / `awaitShownLoaded` before and right after every step (all panes of a multi-page scene), a
  fresh tab's blank hold never awaited; the recorder restarts the screencast when Chromium stops sending frames after
  a paint and asks for a fresh frame after one dropped by the size check (the navigation-test flake); the edit cuts
  held loads ≥ 0.15 s whole (`LOADING_CUT_MIN_S`) except where another page acts, the raw export makes them
  `navigation` cuts. Fixture: "Sales reports" (plain links, a slow report), scenario `reports`. **C — templating and
  secrets (R-RUN-16/17)**: core scenario-template.ts templates each scene / card / interstitial once when reached
  (steps before normalizeStep; the video block after the setup hooks; emit and screenshot names stay literal; a token
  in a `vars` value is a validation error until BL-56); every `{{env:…}}` / `{{keychain:…}}` is a secret, resolved
  before the browser opens; runner-web secrets.ts redacts by path policy (timeline, run record, progress events:
  ids, enums, files and timestamps kept at known positions, everything else masked, incl. URL-encoded forms as Chrome
  serialises them); step descriptions from a fully redacted copy; typing a secret into a visible field warns; hooks
  get `{{run.dir}}`. **D — hook host policy (R-SEC-06)**: js hooks run in a guarded tab per page key (CDP Fetch +
  page.route + routeWebSocket + service-worker bypass + no popups), kept for the session; shell hooks: core
  shell-hosts.ts reads the script command by command (its own assignments, `$(…)` / backticks / heredocs scanned as
  scripts, inline interpreter code, curl / wget / HTTPie / database clients / ssh / git remotes, proxies) at validation
  and again at run time with the real env; a host computed at run time is refused; what it cannot see is listed in the
  README and BL-57. **E — choreography (R-CHO-*)**: re-click of a menu trigger when nothing opened in 3 s, row-action
  trigger fallbacks (hover reveal, positional last resort), adaptive typing rate (search ≈ 10, default 14, long text
  24 cps), `clear` with keys / native setter / editor fallbacks (frames included), new `date` action (last visible
  month buttons inside the calendar, days compared as dates, quick month runs played up to 3× in the edit), opt-in
  `park` modifier (after a scroll or a result, away from what changed, never away from a menu the step opened).
  Acceptance (Mac): embedded 20261012-225230 (14/14, no warning, worst 54.5 fps); reports 20261013-120620 (5 held
  loads, 1.38 s mid-scene, 1.36 s at scene open), live-quote -120643, phone-and-desktop -120721, catalogue -120752,
  quote -120904 — no frame under 20 KB (the old catalogue 20261012-211826 had 4 blank ones), no frame inside a held
  load, durations within 0.25 s of earlier runs, only the known R-ISS-12 ripple warnings; signup 20261013-001611 typed
  its `vars`; a scratch env-secret run kept the secret out of log.jsonl / run.json / timeline.json (except captured
  email artefacts, by design); quote's js hook tab still fires the captured notification; scratch calendar / clear /
  park captures looked at frame by frame; renders reports-v2, live-quote-v1, catalogue-v1, embedded-v1 and
  choreo-check-v1 reviewed clean of blank / loading findings. 1142 tests: 1135 pass, 7 skipped. No dependency added.
- **L1.6 done** (sessions & personas; R-AUTH-01..08 done). Planned by a design agent, criticised by an adversarial
  review (14 defects, ≈ 20 % cut), built in two parts (runtime, then user-facing), reviewed by three independent
  reviewers (25 findings) and fixed in three passes (runtime, CLI, a temp-profile sweep). **Model**: `auth.personas`
  per environment (`session: profile | storage_state`, `check`, `login_url` patterns, `login:` steps, `pages`);
  scenes and multi-page specs take `persona:` (`none` for a public page); core `planPersonas` binds every page,
  tab and js hook tab (explicit, then already bound, then the persona's pages, then the legacy `default`); no paths
  in project.yaml — masters under `~/.retake/profiles/<project>/<env>/<persona>/`, snapshots and statuses under
  `~/.retake/sessions/…` (0600 files, 0700 folders; `RETAKE_HOME` moves the root). **Runtime**
  (runner-web auth.ts): one browser per persona; each run works on a copy of the master (caches, `Singleton*`,
  `Login Data*`, `Web Data*` skipped; ≈ 20–60 ms for 10 MB) plus the snapshot's cookies — a session cookie without
  expiry survives only in the snapshot; a locked master is refused (a copy of an open profile carries no cookie);
  nothing is written back (BL-59). Preflight after the secrets prefetch, before setup hooks and the recorder:
  every persona the scenario uses is checked off camera; on failure the `login:` steps sign in automatically (secret
  refs resolved lazily, redacted), else `PreflightError` with the exact `retake login … --env … --persona …`. Login
  guard: any filmed page (tabs, downloads, hook tabs, panes) landing on a sign-in pattern fails the run and keeps
  nothing (frames, capture, timeline, screenshots, artefacts, error files); a tab landing on another persona's
  sign-in says so; the status file becomes `expired` (`by: run`). Copies are registered, removed on close, on a second
  Ctrl-C (sync) and by a sweep of stale `retake-session-*` / `-login-*` / `-profile-*` folders. **CLI**: `retake
  login <p> [--env] [--persona] [--auto]` (headed window opened with the saved cookies; closing it signed out never
  replaces a valid snapshot; `--auto` checks first and keeps a valid session), `retake auth status [--project]
  [--check] [--json]`, interactive `retake new` (environments, personas, sign in now or later; validated before the
  questions), `doctor` persona lines (never / expired / in use / git-tracked), SIGINT handling (exit 130, copies
  removed) in every command that opens a session. **Fixture**: sign-in listeners :4403 (console) / :4404 (shop) in the
  same process, cookie `northfield_session` (console: no expiry), invented accounts, `POST /api/auth/expire`; the
  project's env `signed-in` (personas supplier, buyer; passwords from `NORTHFIELD_SUPPLIER_PASSWORD` /
  `NORTHFIELD_BUYER_PASSWORD`); env `local` and every scenario unchanged. Acceptance (Mac, scratch RETAKE_HOME):
  `retake login --auto` for both personas (1.6–1.7 s), live-quote signed in 20261013-133904 / -141530 / -152036
  (frames: buyer pane as Demo Café, supplier as Maja Lindqvist; no sign-in URL in any timeline; track frames within
  3 % of env local, the same two ripple warnings), quote signed in 20261013-134020 / -152115 / -155049 (the js hook
  tab ran as supplier and fired the captured notification; PDF fetched as buyer); expired sessions → catalogue
  20261013-134239 failed in 520 ms at 0/21 before any hook with the command; a session expired mid-run →
  20261013-134306 failed at step 3 with nothing kept; reports twice in parallel on one persona + embedded at once all
  succeeded, master untouched; env local quote / catalogue unchanged; `auth status --check` after `curl expire`
  showed both expired (exit 1); `retake new` through a pseudo-terminal. Not proven by a person: a headed `retake login`
  typed by hand (MACOS-CHECKLIST step 8b; the gated `RETAKE_TEST_HEADED=1` test drives it by code). 1212 tests: 1204 pass, 8 skipped.
  No dependency added.
- **L1.7 done** (display URLs, read-only & production safety, frozen clock; R-ENV-01..05 done). Planned, criticised
  (11 defects; the clock probe proved the kit had to keep real timers), built in three parts (core + hooks, browser,
  edit side + review + fixture), reviewed by three independent reviewers (23 findings, two high: `fetchLater` and
  SharedWorker writes bypassed the guard) and fixed in two passes. **Environments**: the short form is unchanged
  (`page: url` or `page: {url, display}`); a long form adds `{production, access, pages, read_only: {hosts, allow,
  mocks}}` (keyed union on `pages`); `ProjectConfig.environments` keeps real URLs, settings live in the derived
  `environment_settings`; production is read-only by default; writing there needs `access: read-write` AND
  `--allow-writes` (on run, hooks run / rollback, env reset), else the run is read-only with a notice. **Hooks**
  (core access.ts / hook-writes.ts): writing hooks refused on read-only environments before any browser opens (http by
  method, SQL by a classifier + `BEGIN READ ONLY`, shell unless `writes: false`, rollbacks with their hook, journal
  replays judged by their own environment); hosts that belong only to read-only / production environments are protected
  in every run (`crossEnvironmentHosts`). **Browser guard** (runner-web write-guard.ts): `context.route` in every
  persona realm armed at launch; reads pass, writes are mocked / allowed / stopped (a navigation gets 204, the rest is
  aborted), production guards every host (fail-closed), a non-production read-only environment its page hosts +
  `read_only.hosts`; GraphQL mutations (batches judged whole), keepalive / beacon writes rewritten by an init script,
  `fetchLater` and `SharedWorker` removed, service-worker traffic routed, pages closed through `about:blank`; the
  sign-in tab is exempt only on its sign-in page; js hook tabs stop writes and never mock them; every write lands in
  `timeline.environment.writes`, the run summary and the review. **Display URLs**: edit-time data (project.yaml's current
  table for the run's environment wins, also for runs captured before L1.7); the address bar, `{{page}}` in edit text,
  notifications, raw markers show the display URL; a local URL without one is never drawn (`hidden` urls entry,
  warnings only for layouts that draw a URL); reports never name a local host. **Clock** (runner-web product-clock.ts):
  `clock:` on project / scenario patches only `Date` and Intl's "now" in every document, frame, popup, hook tab and
  dedicated worker, anchored at capture start; timers, rAF and `performance` stay real (Playwright's clock slowed the
  product's own animations to 30 fps with ten rAF loops — dropped); `freeze` opt-in; never on sign-in / check tabs;
  non-existent or ambiguous DST wall times refused. Fixture: display URLs `console. / shop.northfield.example`, env
  `production` (same local server: the refusal demo), `/api/health` `mutations` counter, `/#as-of` price-date line,
  scenario `read-only` (mocked quote POST, clock, browser frame). Acceptance (Mac): read-only takes
  20261013-205843 / -205930 — one mocked POST, `mutations` 0 → 0, "Monday 2 November 2026, 10:24" pixel-identical in
  both; read-only-v4 shows `shop.northfield.example` in the bar and reviews clean; no localhost in report.md /
  report.json / the review timeline / the raw export; `quote --env production` refused before the browser (3 writing
  hooks); env local quote / catalogue / live-quote capture and render as before; an old run re-rendered with `--frame
  browser` (quote-v6) shows the project's display URL; product rAF / timers at full rate with the clock (60 fps, 100
  ticks/s, a burst of 100 timeouts in 0 ms). 1455 tests: 1446 pass, 9 skipped. No dependency added.
- **L1.8 done** (sandbox mode; R-SBX-01..06 done). Planned, criticised (10 must-fix points measured on the Mac:
  loopback-only URLs, snapshots only of a database the sandbox's own compose project publishes, OrbStack accepting a
  busy host port, `up --wait` exiting 0 on timeout…), built in four parts (core manifest + hooks plumbing; the
  `@retake/sandbox` package + process provider + CLI + `run --sandbox`; docker-compose + Postgres snapshot + `init`;
  the fixture's Docker sandbox + SMTP relay + docs), reviewed by three independent reviewers (≈ 30 findings, several
  of data-loss class: `?host=` / `?port=` in database URLs, a second checkout sharing `compose.project`, another
  container on `[::1]` of the same port, a stale-lock race, pid reuse) and fixed in two passes. **Manifest**
  (`sandbox.yaml`, `version: 1`, declared by `sandboxes: {<env>: <file>}` in project.yaml): provider process |
  docker-compose, services with `pages` (url, display) and health, seed steps (http / sql / shell / compose `exec`; no
  js; never rolled back), reset reseed | snapshot, `accounts` → personas with automated login (plain demo passwords
  allowed, masked; under 3 characters refused), mailbox, databases (`external: true` to touch what the sandbox does
  not serve); every URL loopback; a sandbox is never production, always read-write. **Engine** (packages/sandbox):
  state under `<project>/.retake/sandbox/<env>/` (state.json with boot time and process-tree members, an atomic
  take lock with a stale-lock breaker, logs with rotation), process provider (detached groups identified by pid +
  start time, ownership of every port by our own tree via lsof, SIGTERM → SIGKILL, Ctrl-C stops only what the call
  started, seed steps abortable), compose provider (`retake-<slug>-<env>-<path hash>`, folder check on every
  command, `ps` verification after `up --wait`, `docker ps --filter publish` so no other container shares a port,
  connections pinned to the published address), Postgres template-clone snapshot (PG ≥ 13; owned database only; stale
  on seed or image change; ≈ 0.3 s restore vs 1.5–2 s reseed at 114 MB), mailbox cleared and supersede of pending
  rollbacks after each reset. **CLI**: `retake sandbox init | up | down | reset | status | logs`, `retake run --sandbox`
  (up if needed, health, reset, capture; stays up; busy → fail fast), doctor Sandbox / Docker lines (Docker a FAIL only
  when the default sandbox needs it). **Fixture**: process sandbox (env `sandbox`, 4501–4504) and Docker sandbox (env
  `sandbox-docker`, 4511–4514 + Mailpit v1.29.4 on 4525; host-built bundle, no Chromium so no PDFs), SMTP relay
  (`NORTHFIELD_SMTP`), scenario `sandbox-quote`. Acceptance (Mac): two `run --sandbox` takes of `sandbox-quote` with
  a quote POSTed between them read the same data (`Q-1042`, `Q-1043 · requested Today, 10:24`, identical boxes;
  frames at the marks identical up to encoder noise) on the process sandbox (20261014-021102 / -021133) and the
  Docker one (-021243 / -021311); a control take without reset shows the new row; `signup --env sandbox-docker
  --sandbox` got its email from the real Mailpit; `init` scaffold up / seed / snapshot / restore on Postgres; Ctrl-C
  leaves nothing running; the user's own Docker containers, images, volumes and networks identical before and after
  every step; env local quote unchanged. 1583 tests: 1567 pass, 16 skipped; gated Docker tests 7/7. No new npm dependency (`pg` reused; the lockfile gained the new
  package's importer lines).
- **L1.4 done** (coverage of untested options + automated fixture acceptance; 33 requirements done, "never
  exercised" 0 for phase 1). Planned, built in three parts (scenario-language options; captures, look and run
  lifecycle; formats, Postgres, catalogue capture and close-out — part C was paused on 2026-10-14 and finished on
  2026-10-17), then reviewed by three reviewers whose findings were each adversarially verified (6 of 12 confirmed,
  all fixed). **Tests added**: every scenario option exercised by a test that fails when the option is ignored
  (runner-web widgets.test "options of the scenario language (L1.4)", run.test, kit.test); captures at 2560×1440, 4K
  (scale 2, `keep_frames: false`) and phone (scale 2) (capture-sizes.test); the cursor and file-chip look with
  structural checks + tolerance goldens (look.test, test/golden/; chip golden darwin only; rewrite with
  `RETAKE_UPDATE_GOLDEN=1`); SIGINT / SIGTERM / AbortSignal on the built CLI (cli e2e.test); `retake hooks run`
  forms; the 7 Postgres tests through `pnpm test:pg` (throwaway `retake-pg-test-*` container with its anonymous
  volume removed — first run on the Mac: 7/7); the committed catalogue scenario captured on the fixture with the debug
  cursor (`pnpm test:slow`, 8 tests, ≈ 75 s: hotspot ≤ 0.5 px from every click). **Code fixes found by the tests**:
  `wait_for: {network_idle}` never waited for a request started after the page's first idle (runner-web network.ts:
  a per-page in-flight tracker, re-armed on every call, forgetting a frame's requests when it commits a new document,
  a response body still open 1 s after its headers no longer counted — a fire-and-forget fetch of a `no-store` answer
  is never reported as ended; also used by login steps, where a network-idle timeout now fails the step); a cancel
  during a setup hook waited for it (up to 30 s) and a cancel between or during non-shell hooks skipped the rollback;
  teardown skipped after a failed setup; a second signal left shell hooks running; `drop_file` read a file before its
  size check; `retake plan` accepted a newer run.json. **Formats**: optional `version: 1` on scenario / project /
  template / studio YAML and run.json (core formats.ts; missing = 1, newer = one positioned error; hook files have
  none; `retake migrate` is BL-70); run.json `engine` (Retake, Node, Chromium, OS, font digest; runner-web
  engine.ts). **Requirements**: a generated "Never exercised" section in REQUIREMENTS.md and `node
  scripts/requirements.mjs --untested 1` (exits non-zero while phase 1 has one); R-RUN-17's real-Keychain check is
  MACOS-CHECKLIST step 10b for the user. 1632 tests: 1608 pass, 24 skipped; test:pg 7/7, test:slow 8/8, Docker-gated 7/7. No dependency added.
- **L3.1 done** (engine API, jobs, MCP server; 16 requirements done, 6 partial — R-MCP-01, R-MCP-03, R-ARC-01,
  R-ARC-02, R-ARC-03, R-GOAL-07, finished by L3.2 / L4.1 / L3.8; R-MCP-02 and R-ARC-05 moved to L4.1). Planned,
  criticised (the critique found shell hooks written by the agent could run arbitrary code on production), built in
  four parts (engine read side + MCP skeleton; jobs + worker; hooks / approvals; sign-in, sandboxes, docs), reviewed
  by two reviewers (16 findings, five safety holes) and fixed with mutation-checked tests. **Engine**
  (packages/engine): workspace / project loading, `executeRun`, hooks context, sign-in and sandbox jobs moved out of
  the CLI, which keeps its options, output and exit codes. **Jobs**: `<workspace>/.retake/jobs/` (job.json written
  once by the submitter then only by the claiming worker; claim and cancel O_EXCL markers; `interrupted` derived from a
  dead worker), `worker.lock` (pid + start + build stamp of every runtime package), a detached `retake worker` that
  stops claiming at the first signal, exits on the next, outlives the MCP session and exits after 60 s idle; core
  `reserveRunId`; `history.jsonl` (runs, renders, stills, export re-renders). **MCP** (packages/mcp; SDK 1.32.1 imported
  only in server.ts): 23 tools, schemas from zod, slugs only, page / mail / hook text under `untrusted`, no Chromium in
  the server process, progress notifications, long-poll `wait_s` ≤ 25 s, `retake mcp --print-config` (stable Node path,
  PATH without pnpm folders). **Safety under trust `mcp`**: `confirm: true` does not count; every shell hook, shell
  seed, destructive hook and destructive / shell / js rollback needs a human approval through elicitation (form lists
  each hook and its rollback), fingerprinted on the raw hook + referenced files and HMAC-signed (key in
  RETAKE_HOME), else refused with the `retake …` command; no `allow_writes`; production / read-only hosts of every
  project protected; no `{{env:}}` / `{{keychain:}}` in agent-written text; no file reference outside the project or
  into agent-writable folders; no credential ever passes through a tool (`auth_login` opens a window for the human).
  ARCHITECTURE: ADR-1 amended (engine location vs UI delivery, job input contract, data-flow table: tool results,
  screenshots and page text Claude reads go into the conversation). Acceptance: the whole loop automated with the SDK
  client over stdio on a copy of the fixture (dry run, quote and catalogue captures with frames looked at, an approval
  answered, cancel, `kill -9` of the worker → interrupted, env reset, auth_login auto, sandbox up / reset); `claude mcp
  add` registration checked ("Connected"). Not done: a live Claude Code conversation (the Mac's `claude` was signed
  out) — MACOS-CHECKLIST step 12c for the user; Claude desktop untested. 1738 tests: 1714 pass, 24 skipped. No new dependency (the MCP SDK was
  already declared).
- **L3.2 done** (MCP render / review / export, previews, themes and components; R-MCP-09/11/13–16/29–32 and R-ARC-02
  done; R-MCP-01 / R-MCP-03 stay partial — authoring and record are L3.3 / L3.4). Planned, criticised (network-guard
  spike; two bypasses found: Remotion's `/proxy` and Node-side media downloads), built in three parts, reviewed (5
  findings, the worst a case-insensitive path trick letting a captured download run as Lottie code) and fixed with
  mutation-checked tests. Engine: `planRun` (editor) with two gates under trust `mcp`, render id reserved at submit,
  browser pid recorded and killed by the next worker after a SIGKILL, review folder swapped atomically, history counts;
  engine now depends on editor, review and components (lazy imports). MCP: 36 tools, image blocks (sharp thumbnails made
  on read), every report key / id / code re-derived or moved under `untrusted`, job error messages under
  `untrusted.error`. Acceptance: `pnpm test:slow` now includes the full MCP loop on the fixture (capture quote → render
  editorial → review clean → render motion + laptop → export mp4 / gif / vertical) with frames looked at. 1819 tests: 1791 pass, 28 skipped; test:slow green. No new dependency.
- **L3.3 done** (authoring; R-MCP-22, R-MCP-23, new R-MCP-36 done; R-PRIN-04 partial). User decision: Claude writes
  the scenario, the tool makes no model call. Planned, criticised (ladder cost measured: 48 s per page without a
  per-call cache), built in three parts (kit inventory + runner inspect; inspect job + page_inspect + `retake inspect`;
  scenario_from_script aid + authoring acceptance + docs), reviewed (9 findings, the worst a late JS navigation getting
  a foreign page inspected as `ok`) and fixed with mutation-checked tests. Kit 1.4.0: per-call memo, `inventory`,
  verified suggestions, `checkTargets`, `nameText` (never field contents). Runner: `inspectPage`, `RunOptions.inspect`,
  `KitClient.callOnce`, a main-frame route stopping foreign navigations during an inspection. Engine: `inspect` job
  (pruned to 20, never a queued / running one), `markBoxes` + review `drawMarks`. MCP: `page_inspect`,
  `scenario_from_script` (38 tools), INSTRUCTIONS give the authoring loop. Fixture: `/inspect-lab`. Also fixed: the
  sandbox P6 test flake (a race in the test's fake ps). 1887 tests: 1855 pass, 32 skipped; test:slow green. No new dependency.
- **L3.4 done** (recorder; R-MCP-24 done). Planned, criticised (the binding of `exposeBinding` is visible and forgeable
  by the page — replaced by an isolated world over CDP; a field switched from password to text leaked; a GET form put a
  password in the URL), built in three parts (capture; draft generator + engine + `retake record`; job + MCP + docs),
  reviewed (10 findings: the worst, a write to an API on another host was not seen, so the check replay would repeat it;
  partial passwords masking common words; dropped tokens; tokens in typed URLs; `{{` in typed text) and fixed with
  mutation-checked tests. Files: runner-web `record-session.ts`, `kit/record-script.ts` (kit 1.5.0: `passive`,
  `suggestFor`, `secretField`), core `recording.ts` (event schema + pure generator), engine `record.ts` +
  `jobs/record-job.ts`, cli `record.ts`, mcp `scenario_record`; fixture `/record-lab`. Acceptance in `test:slow`: the
  quote flow recorded through the job by a Playwright driver standing in for the person → draft → validate → run_dry
  15/15, a sentinel password nowhere. 1967 tests: 1934 pass, 33 skipped; test:slow green. No new dependency.
- **L3.5 done** (themes from brand inputs and from a site URL; R-MCP-10, R-MCP-12 done, R-DEC-04 partial — the theme
  editor is R-UI-07). Planned, criticised with probes (a route-fulfil design let redirects and WebSocket / service
  worker / preconnect escape — replaced by a local CONNECT proxy as Chromium's only network; `--force-webrtc-…` does
  not stop STUN, `--webrtc-ip-handling-policy` does; starter names and existing folders must be compared without case),
  built in three parts (brand files → theme; site extraction; acceptance + docs), reviewed by two independent
  reviewers (21 findings: SVG scan bypasses through non-ASCII namespace prefixes and an ISO-2022-JP declaration, a
  renderer busy loop hanging the worker, SharedWorker requests past the route, extraction files written through planted
  links, stale-folder cleanup deleting a human's `.tmp-*` folder, WOFF weights read from the family name…) and fixed
  with mutation-checked tests (the fixer also found `fetchLater` past the route). Files: core `brand.ts`, `ip-class.ts`,
  `site.ts` (+ `site` job kind); components `brand/palette.ts`, `brand/template-file.ts`; engine `brand/files.ts`,
  `brand/create.ts`, `jobs/site-job.ts`, site approvals; runner-web `site/proxy.ts`, `site/extract.ts`,
  `site/page-script.ts`, `site/palette.ts`; mcp `template_create_from_brand`, `template_from_site` (41 tools), the site
  approval form; cli `retake theme create | from-site`, doctor warning. Test fixture: `runner-web/test/fixtures/
  brand-site` (invented brand on `.test` names over self-signed https; openssl needed). Acceptance in `test:slow`
  (`mcp/test/theme-acceptance.test.ts`): site → draft → theme with the site's logo and the workspace's fonts → preview
  → fixture quote render reviewed clean, frames looked at. Cuts and limits: BL-75. 2294 tests: 2257 pass, 37 skipped;
  test:slow 21/21. No new dependency.
- **L3.6 done** (frame comments API; R-MCP-17/18/19, R-CMT-02..05, R-ARC-04, R-DEC-06 done). Planned, criticised with
  a real render (the anchor at a marker named the next step because a satisfied wait owns no frame — the planner now
  puts the marked step on `plan.markers[]`; an `if_match`-only write lost entries across processes — writes go under
  the sandbox package's `TakeLock`; "human" cannot be proven — entries carry `author.via: cli | mcp`; committed stills
  would put product frames in git — stills stay in `.retake/comments/`), built in three parts (types + anchor +
  still; store + CLI; MCP + acceptance + docs), reviewed by two reviewers (trust / storage; anchor / docs / tests: an
  injected lock-file text in an error, no size cap on comments_list, the caption band of the motion theme read as the
  screen, a vertical render resolving a landscape thread, invisible tag characters, a file grown past the read cap…)
  and fixed with 30 mutation-checked tests. Files: core `comments.ts`, `ids.ts` (shared ULID); editor plan markers;
  review `anchor.ts`, `still.ts`; engine `comments.ts` (`engine.comments`); cli `commands/comment.ts`; mcp
  `tools/comments.ts`. Acceptance in `test:slow` (fixture-acceptance): CLI comment at the `proposal` marker → MCP
  list with anchor and still → reply → motion re-render → resolve. Cuts and limits: BL-76. 2355 tests: 2316 pass, 39
  skipped; test:slow 23/23. No new dependency.
- **L3.7 done** (Claude skills + plugin packaging; R-SKL-01/02/03 done, R-DEC-05 partial until 12i). Planned, criticised
  with a scratch Claude Code config (`${user_config.*}` expands in a plugin `.mcp.json` on 2.1.267; a user-scope install
  would put 44 tools in every session — `--scope local` is the default; the plugin's `home` overrides an inherited
  RETAKE_HOME; 7 scaffolds imported remotion), built in three parts (kit re-export + scaffolds; plugin +
  registration + PATH; skills + lint + docs), reviewed (the CLI rule still allowed `retake run` in the shell before any
  refusal; the lint read one sentence; load-time `!` commands; two local installs share one set of values; workspace
  folders on the serving PATH…) and fixed with mutation-checked tests. Files: `skills/` (3 skills + 2 references,
  plugin manifest, `.mcp.json`, README), `.claude-plugin/marketplace.json`, components `kit/renderer.ts`, mcp
  `config-snippet.ts` (`clientPath` absolute and outside the workspace, plugin install lines), `engine_info`
  `started_in`, compile scan refuses `random()` without a seed; tests `mcp/test/skill-lint.ts` + `skills.test.ts` (73,
  every tool call checked against the tool schemas) and `plugin.test.ts` (3 gated on the `claude` CLI). Cuts: BL-77.
  2445 tests: 2403 pass, 42 skipped; test:slow 36/36. No new dependency.
- **L3.8 done** (phase 3 acceptance; R-ACC3-01..06 partial until the live 12j). Planned, criticised with probes (a
  component made over MCP renders as an intro override; the planned scenario either failed its dry run or wrote to the
  product; the video was under the 45 s review floor; the planned skill-order check passed with a validate dropped),
  built in three parts (the D1 scenario-changed check and wording; the acceptance; docs), reviewed (plan_preview still
  offered a render of the old run; a crafted run folder name reached a trusted summary through `latest`; the check read
  a FIFO; whitespace edits flagged; a full-suite hang in the inspect redirect test) and fixed with 20 mutation-checked
  tests. Files: core `scenarioChangedSinceRun` / `scenarioChangedMessage`; engine `planRenderRequest`
  (`scenario_changed`, run-id shape); editor `latest` filters run ids; runner-web `inspectPage` bounds every page wait
  (guard 5 s, kit calls 15 s + budget; a deadline counts as a document change); mcp plan_preview / render / comments_list
  wording; `scripts/requirements.mjs --check-cites` (every quoted test title exists); tests `phase3-acceptance`,
  `inspect-deadline`, `requirements-cites`. 2484 tests: 2436 pass, 48 skipped; test:slow 56/56. No new dependency.
- **L4.1 done** (Studio app shell; R-UI-01/04/05, R-CLI2-04, R-MCP-02, R-ARC-05 done; R-PRJ-02, R-DEC-07, R-ARC-01
  partial). Planned, criticised with probes (one event stream per tab exhausted Chromium's 6 connections per host; an
  index of job states would show a crashed job running forever; the planned security tests could not fail since they
  never sent a token; README / scenario reads followed links out of the project), built in three parts (gate +
  discovery + bootstrap code + `retake ui` skeleton; the app from files + Chromium e2e; index + events + MCP over HTTP),
  reviewed by two reviewers (the token printed for a committed `.mcp.json`; abandoned HTTP sessions locking clients out;
  unsaved text lost when the session ended; CRLF / Latin-1 READMEs rewritten; links followed by the index…) and fixed
  with 35 mutation-checked tests. Files: engine `src/http/` (gate, token, bootstrap codes, discovery, token file),
  `src/index-db/`, storage `readContained`; mcp `src/http.ts` (one `wireServer` for stdio and HTTP); new `packages/ui`
  (server, ops incl. `projects_overview`, app); cli `commands/ui.ts`, `mcp --http`. Cuts: BL-79. 2593 tests: 2545 pass,
  48 skipped; test:slow 56/56. No new external dependency (zod and playwright-core reused).
- **L4.3 done** (blocks editing; R-UI-11, R-UI-12 done). Planned with probes (whole-file re-serialisation is lossy:
  0/12 byte-exact; text splices exact), criticised (lost updates between two writers with the same hash; a re-apply
  after a 409 reverting another writer's field; agent trust overclaimed; undo not byte-exact), built in four parts in a
  worktree while another session worked on main (write path + YAML tab; step moves / DnD / undo; value edits / forms /
  palette; acceptance + docs), rebased on L5.6, reviewed by two reviewers (hooks bypass through `vars`; a case-variant
  name escaping the lock; a lone CR turning into a hidden step; step_now lost after a cross-scene move; forms removing
  untouched empty values; a flow-map key removal dropping a comment…) and fixed with 28 mutation-checked tests (≈ 55k
  fuzzed edits: 0 value mismatches, undo always byte-exact). Files: core `scenario-edit.ts`, `step-edits.ts`,
  `step-forms.ts`; engine `project-lock.ts`, storage write lock, `scenarios.edit`; ui `YamlTab.tsx`, `StepEditing.tsx`,
  `StepForm.tsx`, `forms.ts`, `TextEditing.tsx`; mcp `job_status` preview stills. Cuts: BL-95 (and BL-96: the CLI's
  writers take no write lock). No new dependency.
- **L4.4 done** (Run screen; R-UI-16/17/18/19, R-AUTH-10 done). Planned with probes (a second CDP screencast does not
  disturb the recorder), criticised (a pause clock shifting t0 would mis-convert page loads; `everyNthFrame` left the
  preview stale; a resume gap would raise a false freeze), built in five parts in a worktree while L5.7 / L5.8 landed on
  main (rebased twice): A runner / engine (live preview, worker live channel, dry-run pause, outline / session / pause
  events, sign-in limit), B the Studio's `/v1/live` relay and ops, C the Run screen + Sessions panel + dialog, D pausing a
  capture on L5.7's clock (pausable CaptureClock, recorders, encoder horizon, perf sampler), E acceptance, CPU, docs;
  reviewed by two reviewers (U+2028 dropping events, a dishonest confirmation for check-less personas, idle sockets
  starving the channel, an interrupted run's endless clock, 0.1 s of each pause filmed…) and fixed with 34
  mutation-checked tests (99 mutations over the lot). Files: runner-web `live-preview.ts`, `pause.ts`, timeline
  CaptureClock; engine `jobs/live-channel.ts`, `runs.pause`, `auth.forScenario`; ui `server/run-live.ts`,
  `RunScreen.tsx`, `LiveView.tsx`, `Sessions.tsx`, `run-live.ts`, `sse.ts`. Cuts: BL-105, BL-106. No new dependency.
- **L4.7 done** (library + theme editor; R-UI-06, R-UI-07 done, R-UI-06b partial — cursors get no loop). Planned with
  probes (the ComponentPreview composition renders as a GIF loop in 1–1.5 s; the Studio CSP has no media-src, so loops
  are GIF data URLs; Homebrew ffmpeg has no libwebp), criticised ("Use for this project" would not re-theme existing
  takes → a scenario `template` field instead; every library request building a 28 MB bundle; a cache key blind to
  binary component files; one bad component or a full disk breaking the library), built in parts in a worktree (A core
  theme edits + engine write path, B motion mode + loop rendering + library cache and job, C Studio server ops + player
  `component-preview` format, D1 library screen, D2 theme editor, E acceptance of all 41 loops in two themes and a
  Studio-to-render drive), reviewed by two reviewers (a component importing through folders its hash skips stayed
  allowed after a change — an L4.5 hole, now refused at four points; theme copies laundering hard links; layout-pip /
  split failing the preview scan; one broken workspace component failing every card for good…) and fixed with
  mutation-checked tests (≈ 140 mutations over the lot, all killed). Files: core `map-edits.ts`, `theme-edits.ts`, jobs
  `library` target; editor motion mode, `renderComponentLoops`, `componentFilesGuard`; engine `theme-edit.ts`,
  `library.ts`, brand `copy.ts` / `file-list.ts`, `site-list.ts`; ui `server/library-ops.ts`, `theme-ops.ts`,
  `library-watch.ts`, `LibraryScreen.tsx`, `ThemesScreen.tsx`, `ThemeEditor.tsx`, `library-words.ts`, `theme-words.ts`.
  No new dependency. Cuts: BL-113.
- **L4.8 done** (Record screen; R-UI-20, R-UI-21, R-UI-22 done). Decision with the user: a real headed window and the
  Studio as control panel, not input forwarding through the live preview (BL-25 gets the reasons). Planned with probes
  (alternatives on 160 fixture controls: 71 % get one, 0.04–0.55 ms each), criticised, built in parts in a worktree
  (1 core generator + annotations schema, 2 kit 1.6.0 alternatives + runner, 3 engine record-studio + queue stop marker
  + meta.json, 4 Studio server ops + records watch, 5 Record screen, 6 docs + gated Studio-to-render acceptance),
  reviewed by two reviewers (an insert "after" a recorder-added row landing elsewhere, the cursor sliding a row, Save
  of a draft changed since it was shown, a missing events hash passing, hidden characters reaching a saved draft, a
  zoom above the theme's max, a check result describing a different draft…) and fixed with mutation-checked tests (60
  checks after the reviews, 59 killed — the survivor is the worker's belt-and-braces stop check at claim). L3.4's
  generator is pinned byte for byte by golden drafts (`packages/core/test/fixtures/recordings/`). Files: core
  `recording.ts`, `record-annotations.ts`; runner-web kit `kit.ts` / `record-script.ts`, `record-session.ts`; engine
  `record-files.ts`, `record-studio.ts`, `record.ts`, jobs `queue.ts` / `worker.ts` / `record-job.ts`; ui
  `server/record-ops.ts`, `record-watch.ts`, `RecordScreen.tsx`, `record-words.ts`; fixture RecordLab (a far section,
  `?hostile=1`). No new dependency. Cuts: BL-118, BL-119.
- **L4.9 done** (identity + accessibility pass + Studio acceptance; R-UI-03, R-ACC4-01 done, R-UI-02 partial — the
  Geist pair is named, not bundled). Planned with a prototype checker over 14 screens (already clean in Chromium on
  contrast / names / focus / headings; real findings: the theme editor's sideways scroll, WebKit placeholders at
  2.35:1, `.pd-mark`, an open palette), criticised (the overflow fix did not fix it, text over media measured against
  the card behind, a focus rule that was a tautology, nothing guarding the token move), built in parts in a worktree
  (A checker, B fixes + palette + lints, C two tours + keyboard path, D the Chrome acceptance, E docs), reviewed by two
  reviewers (the editable theme editor never audited, a selected state carried by colour, a Tab walk cut silently at
  80, half-loaded screens audited, an Undo race that flaked the keyboard path under load…) and fixed with
  mutation-checked rules (≈ 100 mutations over the lot, all killed). Files: ui `app.css`, `LiveView.tsx`; tests
  `a11y.ts`, `a11y-tour.ts`, `a11y-checker.test.ts`, `studio-e2e-a11y*.test.ts`, `studio-e2e-acceptance.test.ts`,
  `app-source.test.ts`; editor test helper `linkSharedCache` (15 test files). No new dependency. Cuts: BL-120 – BL-123.
- **L5.2 done** (Tauri desktop shell; R-ARCH-11, R-DSK-01, R-DEC-07 done, R-DSK-02 partial). Planned with probes (tauri
  2.12.5 resolves offline to 406 crates, release binary 7.9 MB; the real Studio loads in a WKWebView window), criticised
  (Tauri's drag handler swallowing block drag & drop, WebKit's persistent store writing capture media into ~/Library,
  keep-alive passing for "the page loaded"), built in parts in a worktree (supervised CLI, the shell, lifecycle, tests
  and docs; notifications cut), reviewed by two reviewers (downloads not cancelled, a navigation guard no test failed
  without, Open Workspace quitting the app on a refused folder, `pnpm test` red without the Xcode tools…) and fixed with
  mutation-checked tests (≈ 35 mutations over the lot). A gated-acceptance flake was a product race in the preview
  frame (fixed: `frame-store.ts`). Files: `apps/desktop` (src: main, child, menu, logfilter, macos; core crate: rules,
  config, json; scripts/desktop.mjs), cli `commands/ui.ts` (`--supervised`), engine `http/gate.ts`
  (Permissions-Policy), ui `server/{launch,player,studio}.ts` (counters, `player`), `player/frame-store.ts`; tests
  `desktop-{config,core,shell}.test.ts`, `player-preview` / `player-protocol` additions. New dependency: the Rust crates
  of apps/desktop only (Tauri, offline cache), none in the pnpm workspace. Cuts: BL-125.
- **L5.2b done** (job notifications and a quit confirmation in the desktop app, asked by the user; R-DSK-02 evidence:
  notifications done, native pickers / keychain still the gap). Planned with offline probes (objc2-user-notifications
  and block2 add 4 lock edges, no package; tao has no `applicationShouldTerminate:`, added at runtime), criticised (a
  test hook calling terminate from a Tauri closure hung the app; a second terminate during the question quit without
  asking), built in a worktree, reviewed by two reviewers (a report outliving its tab, SIGTERM not ending the other
  questions, wrong words at logout and a restart blocked by jobs, Return restarting over unsaved text…) and fixed with
  mutation-checked tests (≈ 75 mutations, all killed). Files: ui `server/{supervise,unsaved}.ts`,
  `app/unsaved-report.ts`, `drafts.ts` marks; engine `JobsWatch.unfinished` / `record`; cli `ui.ts`; desktop
  `src/{guard,notify,macos,child,main}.rs`, core `{pipe,words,notify,config}.rs`. Cuts: BL-125 trimmed.
- **L5.9 done** (Studio « Épure » 1; R-UI-02 as amended, R-UI-30 – R-UI-34 done, R-DSK-03 partial). Planned from the
  founder's canvas (copied for the lot: tokens, type scale 13 / 15 / 20, pane anatomy), criticised (the checker's
  colour-only rule going blind on the new token files, a native drag band leaving WebKit "pressed", dark for legacy
  screens bigger than planned, the library-free kit untested in WebKit), built in parts in a worktree (A tokens + fonts,
  B / C the kit and its overlays, D the shell, E gallery + lints + tours, F desktop menu, G docs), reviewed by two
  reviewers (the palette printing names without Txt, a toolbar stealing arrows from menus and fields, a ratchet missing
  role-based controls, the timeline losing its track rows in the shorter centre pane…) and fixed with mutation-checked
  tests. A scratch WebKit run of the kit e2e: 9/9 once macOS's Tab / radio / click-focus conventions are allowed for.
  Files: ui `src/app/{tokens.ts,tokens.css,brand.ts,screens.css,GalleryScreen.tsx}`, `ui-kit/`, `shell/`,
  `scripts/{gen-tokens,kit-ratchet,ratchet}.ts`, `fonts/`; desktop `src/{main,menu}.rs`; docs/reference/studio-ui.md.
  No new dependency (the Geist files are assets, OFL). Cuts: BL-126, BL-127.
- **L5.10a done** (the project side of Épure 2; R-UI-35 – R-UI-37). Planned from B32-Projet / R4-Welcome (C1 / C2 were
  round 1's rejected direction — studio-ui.md corrected), criticised (`project_board` on the 16-entry scenario-view cache
  evicting the open scenario; the lot sized L → split), built in a worktree (board read, state words, store, kit rows /
  Facts / Disclosure / PosterGrid, shell browser and routes, Welcome / Productions / Cast screens), 24 e2e files migrated
  under a guard comparing titles, `expect` counts and test ids with HEAD, reviewed by two reviewers (a read loop on an
  errored op — ~1560 calls in 5 s —, a board read per take step, a location inspector hidden by a selection, a grid
  collapsing at 900 px, loosened migrated assertions…) and fixed with mutation-checked tests. Files: engine
  `project-board.ts`, `index-db/jobs-watch.ts`; core `checks/context.ts` (`filesRead`); ui `project-data.ts`,
  `board-words.ts`, `WelcomeScreen.tsx`, `ProductionsScreen.tsx`, `CastScreen.tsx`, `shell/`, `ui-kit/` (Sheet,
  CommandPalette, cards, panes, fields). Cuts: BL-128.
- **L5.10b done** (the scenario side of Épure 2; R-UI-38, R-UI-39). Built from the L5.10 plan and critique (drag & drop on
  the list with the slot from the pointer, no double unsaved mark on the YAML editor, a minimal take strip), reviewed by
  two reviewers (the YAML view losing the running run, a stale selection whose Delete would hit a step never picked, the
  edit e2e leaving a route installed after a failure, a stale remembered location breaking the screen, the keyboard
  entering the frames in the wrong place…) and fixed with mutation-checked tests (≈ 45 mutations over L5.10b). Files: ui
  `ScenarioScreen.tsx`, `Storyboard.tsx`, `TakeStrip.tsx`, `ScenarioInspector.tsx`, `ScenesBrowser.tsx`,
  `board-keys.ts`, `scenario-words.ts`, StepForm / StepEditing / YamlTab / YamlView / TextEditing / Thumb on the kit,
  `ui-kit/frames.tsx` (FrameGrid, FrameOption, RowCard), `Callout`, `TerminalCommands`. Cuts: BL-129.
- **L5.11a done** (Shoot without the Record screen; R-UI-40 – R-UI-43). Planned (the lot sized L → split), criticised
  (⌘. could reach the wrong owner after a reload; `scenario_actions` on the scenario view's 16-entry cache with a second
  validation per save; blocker words keyed on a code shared by several gates; a page probe from Prepare that a refused
  run would never make — cut), built in a worktree, 20 e2e / lint files migrated under `scripts/test-guard.mjs` (11
  decreases, each explained: Edit mode replaces Open timeline, `run-cancel` → `run-stop`, the compact blocker), reviewed
  by two reviewers (Prepare's sessions table squeezed to one-character cells at 900 px, `scenario_actions` re-read every
  step of a running take, focus dropped on Start, a Copy that copied a command not on screen, the polite line raw and
  never cleared, a weakened location test, a survived Stop-owner mutation…) and fixed with mutation-checked tests (30
  mutations, all caught). Files: engine `scenario-view.ts` (`actions`), `run-job.ts` (`blockerKind`); ui
  `ShootPrepare.tsx`, `ShootLive.tsx`, `ShootBrowser.tsx`, `shoot-data.ts`, `shoot-words.ts`, `run-location.ts`,
  `shell/command-bus.ts`, `shell/StatusActions.tsx`, `shell/say.ts`, LiveView / Sessions on the kit, ui-kit Checklist /
  Blocker (compact, CommandPopover); desktop `menu.rs` Scenario menu. Cuts: BL-130.
- **L5.11b done** (the Record screen in the shell; R-UI-44). Built from the L5.11 plan's part R and the critique's
  record items, reviewed by two reviewers (arrowing through alternatives under a slow save checking one option and
  focusing another; every draft row a tab stop, Stop 200 Tabs away; a typed Caption lost when the insert block moved; a
  vacuous callout assertion; Save's rule untested; the drive's errors surfacing late…) and fixed with mutation-checked
  tests (12 + 23 mutations, all caught). Files: ui `RecordScreen.tsx` (rebuilt), `ShootBrowser.tsx` (Recordings),
  `record-words.ts`, `shell/command-bus.ts` (`useScenarioGroup`), ui-kit `RadioGroup`, `RowList` / `RowCard`
  (`option`, `compact`, `aside`); tests `studio-e2e-record-keys.test.ts` (answers the record ops itself to hold a view or
  a save back). Cuts: BL-131.
- **L5.13 done** (the rename to Retake and the mark; R-REN-01 – R-REN-04). Planned with a probe (the lockfile is never
  regenerated offline: a text rewrite, keys re-sorted) and an adversarial critique (four Highs: the old tool folder must
  stay never-run-as-code, the outgoing sandbox variable is read by the person's product, the old-home notice must not die
  at first use, test isolation once the variable is renamed), split in two parts. L5.13a: the script, legacy.ts, the
  notices and doctor group, the guard test, README "Upgrading", DESIGN §4o; two reviews (a planted old ui.json could block
  every start; a test deleting the scratch home; a set old home variable silent; project `.gitignore`s; the script
  touching untracked / dirty files) fixed with mutation-checked tests (≈ 40 + 31). L5.13b: the mark and gen:mark; two
  reviews (the title-bar svg broke the hostile-data e2e guard; PNG tests that read only sizes; the icns step's silent
  fallback; mark colours outside the contrast lint) fixed (28 mutations, with the old-home-variable case). Cuts: BL-136.
  Files: `scripts/rename-l513.mjs`, `packages/{core,engine}/src/legacy.ts`, cli doctor / errors / main, `packages/ui/src/mark.ts`,
  `ui-kit/AppMark.tsx`, `packages/ui/scripts/gen-mark.ts`, `apps/desktop/icons/*`, `core/test/old-name.test.ts`, 14
  `legacy*` tests; ~1 030 files renamed.
- **L5.12d done** (the quit sheet, the end of legacy, motion; R-DSK-04, R-UI-50). Started with a probe of the re-entry
  on macOS (the hook answers Cancel, a thread re-posts `terminate:`: SIGUSR2 and a Dock-style quit exit in 18–330 ms,
  reliable), so the page sheet was built with every rule of the critique's H1; reviewed by two reviewers (no path quits
  without a yes or traps the person; the buttons in the reverse of the alert's order; Return on a focused Quit Anyway
  quitting; the page's text cap below words.rs's worst case; the gated page path not covering SIGTERM / a server exit;
  lint gaps for object-literal classes and motion cascade order…) and fixed with mutation-checked tests (29 + 19
  mutations, all caught). Files: desktop `core/src/guard_flow.rs`, `pipe.rs`, `guard.rs`, `child.rs`, `main.rs`; ui
  `server/desktop.ts`, `server/supervise.ts`, `shell/quit.ts`, `shell/QuitSheet.tsx`, `base.css` (app.css deleted),
  `bits.tsx`, `main.tsx`. Cuts: BL-135.
- **L5.12c done** (the Library and the theme editor; R-UI-49). Built from the L5.12 plan's part c with the critique's M5
  cut (one preview with a target switch, not three tiles), reviewed by two reviewers (Set as default on a starter from
  the grid losing its result when the inspector remounted on the copy's page; a refused colour re-sent on leaving the
  hex field; the op allow-list dodged by an aliased `call`; 85 Tabs from the grid to the inspector; Play outside the
  card's frame; the New theme form deaf to typed hex…) and fixed with mutation-checked tests (19 + 23 mutations, all
  caught). Files: ui `LibraryScreen.tsx`, `LibraryCards.tsx`, `LibraryInspector.tsx`, `LibraryDetail.tsx`,
  `LibraryBrowser.tsx`, `CreateSheet.tsx`, `ThemesScreen.tsx`, `ThemeEditor.tsx`, `ThemeFields.tsx`, ui-kit
  `ColorField.tsx`, `DataTable.tsx`, `Sheet` (content, per-action disabled, initial focus, Return in a field). Cuts:
  BL-134.
- **L5.12b done** (Comments, the proposal, README, ⌘K; R-UI-47, R-UI-48). Built from the L5.12 plan's part b and the
  critique's M1 (the lints pinned to the files the split moved, re-pointed by name with app-wide counts), reviewed by
  two reviewers (the comments e2e file exiting 1 with every test ticked; "the banner never applies" and "the palette
  never writes" proved by string matches a link or a helper slipped past; Shoot's actions in the Review mode's status
  bar; the shell re-rendering on every frame step; a cancelled pointer committing a region; the a11y checker walking
  into a modal's inert page…) and fixed with mutation-checked tests (17 + 31 mutations, all caught). Files: ui
  `CommentsScreen.tsx`, `ThreadList.tsx`, `FrameViewer.tsx`, `Composer.tsx`, `ThreadPanel.tsx`, `ProposalCard.tsx`,
  `ProposalBanner.tsx`, `proposal-focus.ts`, `ReadmeEditor.tsx`, `ReviewScreen.tsx` (`ReviewChrome`), ui-kit
  `DiffTable.tsx` (DiffTable, RegionOverlay), `CommandPalette.tsx`, `shell/command-bus.ts` (`paletteGroup`); tests
  `a11y.ts` (modal dialogs). Cuts: BL-133.
- **L5.12a done** (Edit and the Review report; R-UI-45, R-UI-46). Planned (L+ → four parts), criticised (Edit's Render
  through the status bar would have rendered the file on disk from a proposal and lost RenderBar's refusals; exports
  only as copied commands did not deliver the roadmap's export; lints pinned to files the split moves), built in a
  worktree, e2e files migrated under `scripts/test-guard.mjs` (7 decreases, each explained: render-row / review-panel /
  finding-seek moved to the report, the conflict check on the shell's inspector, timeline test 2's height check, the
  opacity lint 4 → 3 states, the gallery's measured exempt counts), reviewed by two reviewers (Render from a proposal
  while Edit was loading; a queued ⌘Z undoing the wrong switch after a failed write; the scenario name and finding codes
  shown bare; a false "made from another version" note; an export race test that raced nothing; "Render succeeded"
  beside "1 error"…) and fixed with mutation-checked tests (15 + 23 mutations caught; 1 survived by design: Edit's
  early-state Render owner is a second guard behind the status bar's refusal). Files: ui `TimelineScreen.tsx`,
  `EditPreview.tsx`, `EditStatus.tsx`, `EditNotes.tsx`, `TimelineInspector.tsx`, `TimelineTracks.tsx`, `ReviewScreen.tsx`,
  `review-words.ts`, `edit-handoff.ts`, `Renders.tsx`, `route.ts`, `shell/modes.ts` / `StatusActions.tsx` / `slots.tsx`,
  ui-kit `ChoiceChips`, `tracks.tsx`, `ContactSheet`, `Tag`, `NumberField`; server `ops.ts` (`review_export`). Cuts:
  BL-132.
- **L4.6 done** (frame comments UI; R-UI-27/28/29 done). Planned with probes (a seek to (F − 0.5)/fps returns the exact
  frame in 0.06–0.2 s where an exact select takes 1.3 s at the end of a render), criticised (what the person reads could
  differ from what Apply writes; proposals Claude could not plan or review; Apply and re-render on a vertical thread;
  Undo leaving "applied"; Apply failing after its write), built in seven parts in a worktree (A1 channel and frames, A2
  proposals, B MCP and skills, C Studio server ops on one shared op chain, D1 Comments screen, D2 proposal UI, E gated
  installed-Chrome acceptance on the fixture and docs), reviewed by two reviewers (Apply offered while a change sat below
  a 300-row cut; RTL letters reordering digits in the diff; thread caps checked after the scenario write; theme changes
  accepted as proposals; newest-wins decided after the file opened; the frame shrinking at 1280 px…) and fixed with
  mutation-checked tests (≈ 150 mutations over the lot, all killed but one redundant CSS line). Files: core
  `line-diff.ts`, `canonical-json.ts`, comments proposal schema; engine `render-frames.ts`, `comment-proposals.ts`,
  comments apply / proposal / counts; mcp `comment_reply.proposal`, `comments_list {comment_id}`; ui
  `server/comment-ops.ts`, `server/op-chain.ts`, `CommentsScreen.tsx`, `CommentsTab.tsx`, `ProposalPanel.tsx`,
  `comment-words.ts`. No new dependency. Cuts: BL-111, BL-112.
- **L4.5 done** (timeline; R-UI-15, R-UI-23/24/25/26 done). Planned with probes (esbuild bundles the Player and every
  component in ≈ 0.5 s; a `sandbox="allow-scripts"` frame on a second origin blocks a hostile component's network),
  criticised (a postMessage flood froze the Studio tab; one throwing component killed the preview; a switch killed a
  queued render; the plan carried product text into JSON ops; the sandbox test had no positive control), built in six
  parts in a worktree (model + `caption_component` + `set_field` + render snapshot + inline review; player origin and
  sandbox after a go / no-go on the real bundle; timeline screen; inspector and switching; render / queue / review;
  acceptance in the installed Chrome), reviewed by two reviewers (Chrome follows `<link rel=prerender>` despite the
  frame CSP and sandbox — closed by a guard in boot.ts, Trusted Types and a per-session allow of workspace components;
  outro switches deleting the user's tagline; a stale memo after a theme change; "from this version" ignoring render
  options…) and fixed with mutation-checked tests. Files: editor `timeline.ts`, `preview-plan.ts`,
  `remotion/preview-mode.ts`; core `field-edits.ts`; components `fit.ts`, `engines.kit`; engine `timeline-view.ts`,
  `field-options.ts`, render snapshot + inline review; ui `server/player.ts`, `server/preview-allow.ts`, `src/player/*`,
  `TimelineScreen.tsx`, `TimelineTracks.tsx`, `TimelineInspector.tsx`, `PreviewFrame.tsx`, `Renders.tsx`. New direct
  dependency of packages/ui: `@remotion/player` (already in the lockfile; R-UI-25 asks for it). Cuts: BL-107 – BL-110.
- **L4.2 done** (scenario as blocks; R-UI-08/09/10/13/14 done, R-UI-15 partial — "Open timeline" is L4.5). Planned,
  criticised with probes (re-reading the view on every run step; a capture refused only after the click; the last
  step's seek past the video; fingerprints blind to `on:` and scene pages; the Studio's worker inheriting its env),
  built in four parts (core block model + safe reads + run blockers; view + thumbnails + events; read-only screen + e2e;
  run actions + worker + acceptance), reviewed by two reviewers (a quadratic YAML alias check freezing every client; a
  failed Studio run vanishing; multi-page scenes shown wrong; thumbnail reads unbounded; credentials kept in an
  MCP-started worker's env…) and fixed with 40 mutation-checked tests. Files: core `blocks.ts`, `step-match.ts`,
  `plain-file.ts`, `clientPath` moved to core; engine `run-files.ts`, `run-data.ts`, `run-thumbs.ts`, `scenario-view.ts`,
  `cleanWorkerEnv`, `scenarios.check` (run_blockers); review `./thumbs`; ui ops `scenario_blocks`, `run_thumbs`,
  `scenario_run`, `run_cancel`, `run_status`, the scenario screen. Cuts: BL-80. 2794 tests: 2744 pass, 50 skipped;
  test:slow 58/58. No new dependency.

## Working with the fixture
**On a fresh clone (the Mac) none of the runs, renders, reviews or exports named in this file exist** — they are
git-ignored and stayed in the cloud container. Start the fixture, capture (`retake run`), then render / review /
export `latest`; generate the music test bed once with the `generateTestTrack` line below. The fixture's own media
(`projects/northfield-fixture/assets/`) and the frozen test timelines (`packages/*/test/fixtures/`) are committed.

Render, review, export and preview commands (cloud fixture captures: L2.14 acceptance runs 20261012-144004-catalogue and
20261012-144221-quote; earlier runs 20261011-182524-catalogue, 20261011-182706-quote
(before L2.9), 20261012-022141-quote (L2.9: notification + PDF), 20261012-022315-signup (L2.9),
20261012-034207-signup (L2.10: tutorial overlays), 20261012-034247-highlights (L2.10: story cards),
20261012-073840-live-quote and 20261012-080444-phone-and-desktop (L2.11: two pages on one clock),
20261012-093815-own-media (L2.12: your own files) and 20261012-093047-catalogue (L2.12: waits), 20261012-123617-quote (L2.13: quote
captured without the cursor, `run --raw --cursor none`), 20261011-222856-mobile-quote,
and the 4K run 20261011-234009-quote-4k of a scale-2 copy of the quote scenario). Captures need the fixture server
(`node fixtures/wholesale/server.mjs`; stop it with `kill <pid>` — `pkill -f` with its path also matches the shell
that runs it):
```
node packages/cli/dist/bin.js run northfield-fixture signup              # mail, phone cards, tap-open, tutorial overlays (≈ 45 s)
node packages/cli/dist/bin.js run northfield-fixture embedded            # shadow DOM widget + iframe on a product page (≈ 25 s)
node packages/cli/dist/bin.js run northfield-fixture reports             # full-page loads, a slow report held until painted (≈ 20 s)
node packages/cli/dist/bin.js run northfield-fixture highlights          # capture_text + every story card (≈ 46 s)
node packages/cli/dist/bin.js run northfield-fixture live-quote          # shop + console at once (split, ≈ 1 m 15 s)
node packages/cli/dist/bin.js run northfield-fixture phone-and-desktop   # desktop + phone at once (pip, ≈ 50 s)
node packages/cli/dist/bin.js render northfield-fixture live-quote --theme motion --review
node scripts/fixture-media.mjs [--prores]                                # regenerate the fixture's own media (Remotion + ffmpeg)
node packages/cli/dist/bin.js run northfield-fixture own-media           # intro video, outro image, alpha burst, Lottie card + overlay (≈ 45 s)
node packages/cli/dist/bin.js render northfield-fixture own-media --music projects/northfield-fixture/.retake/test-bed.m4a --review
node packages/cli/dist/bin.js render northfield-fixture phone-and-desktop --vertical --review
node packages/cli/dist/bin.js still northfield-fixture live-quote --square --frame 880
node packages/cli/dist/bin.js run northfield-fixture quote --raw --cursor none --selects            # capture without the cursor + raw package (≈ 2 m)
node packages/cli/dist/bin.js export-capture northfield-fixture latest --scenario quote --format prores --fps 60 --cursor layer
node packages/cli/dist/bin.js export-capture northfield-fixture 20261012-073840-live-quote --cursor layer --layer webm
node packages/cli/dist/bin.js render northfield-fixture signup && node packages/cli/dist/bin.js review northfield-fixture signup-v12
node packages/cli/dist/bin.js render northfield-fixture signup --no-tutorial   # the same video without the overlays
node packages/cli/dist/bin.js render northfield-fixture highlights --theme motion
node packages/cli/dist/bin.js render northfield-fixture catalogue        # → renders/catalogue-v<N>.mp4 + .json
node packages/cli/dist/bin.js render northfield-fixture quote --vertical # 1080×1920, reframed → quote-v<N>-vertical.mp4
node packages/cli/dist/bin.js render northfield-fixture quote --square --theme motion   # 1080×1080 + theme zoom
node packages/cli/dist/bin.js render northfield-fixture catalogue --music projects/northfield-fixture/.retake/test-bed.m4a
node packages/cli/dist/bin.js export northfield-fixture catalogue-v4 --formats all     # → exports/catalogue-v4/
node packages/cli/dist/bin.js plan northfield-fixture latest --scenario quote --vertical   # shows each clip's reframe
node packages/cli/dist/bin.js review northfield-fixture quote-v9-vertical
node packages/cli/dist/bin.js components preview --all --stale          # regenerate stale committed previews
node -e "import('./packages/editor/dist/index.js').then(m => m.generateTestTrack('projects/northfield-fixture/.retake/test-bed.m4a', {seconds: 16}))"
```
Render times in the cloud container (4 CPUs, no GPU, concurrency 3; L2.14: ≈ 4 m per 70 s 1080p video, own-media 46 s
≈ 2 m 50 s; a Mac should be faster): 1080p quote 56.3 s → ≈ 3 m; vertical 1080×1920 → 3 m 13 s,
square 1080×1080 → 2 m 23 s; catalogue 59 s with music → 3 m 34 s; 4K catalogue (export mp4_4k) → 8 m 04 s; WebM (VP9)
transcode of 59 s 1080p → 1 m 25 s; ≈ 8–9 output fps at 1080p; a still ≈ 1–2 s with a cached bundle.

## Evidence per lot (measured in the cloud container)
The renders and packages below are git-ignored (they stay in the cloud container); the acceptance of phase 2 is in
`docs/ACCEPTANCE-phase2.md`.

**4K findings (spike, measured here — headless Chromium 141, 4 CPUs, no GPU, JPEG q 90):**
- Without help, scale 2 gives CSS-size images on every path: the CDP screencast (new headless and the headless shell
  alike), `Emulation.setDeviceMetricsOverride` re-sent on the recorder's session with screencast maxWidth/maxHeight at
  device pixels, and `Page.captureScreenshot` (with or without `clip`, `fromSurface`, `optimizeForSpeed`) — all
  1920×1080 for a 1920×1080 viewport at DPR 2 (the page reports DPR 2).
- `--force-device-scale-factor=2` at launch makes all of them 3840×2160, text rasterised at 2× (crops compared with a
  Playwright DPR-2 screenshot: identical sharpness). Kept: the runner adds it for headless captures with scale ≠ 1.
- Frame rate (animated element on the fixture pages): screencast 9.5 fps on the shop, 13.6 on the console, 16 on a
  blank page at 4K vs 44–58 fps at 1080p; `captureScreenshot` in a loop 5.6 fps at 4K (13 at 1080p) → the screencast
  stays the path. JPEG quality 60–95 changes nothing (raster / readback bound).
- Real capture `quote` at scale 2 (run 20261011-234009-quote-4k): 3840×2160 capture.mp4, 338 frames over 110.9 s of
  capture (48.4 s at scale 1): 6–9 fps on the shop pages, 2–3 fps under the request dialog (backdrop blur); the cursor
  glides on its motion clock, so the run itself slows down (4 m 53 s) and motion stays smooth but slow. Usable for
  stills and slow scenes here; a Mac with a GPU should be much faster (L1.3 / L1.5).
- 4K output: a scale-2 capture renders 3840×2160 with every component at unit 2 (crisp, stills compared with a 4K
  render of the 1080p capture: visibly sharper text); `--scale 2` / export `mp4_4k` of a 1080p capture works with the
  plan warning "the capture is 1920×1080 px (scale 1): it is upscaled …".

Renders of L2.8, looked at frame by frame (frames extracted with ffmpeg at every click and the 5 frames around the
largest reframe move of each clip) and reviewed with `retake review`: **quote-v9-vertical** (editorial, 56.3 s;
review clean, 1 info) — every clicked target (Selowa Ridge, Request a quote, Increase ×2, the size and grind
dropdowns and their options, Delivery window, Next month at the right edge, 10 Jan, 24 Jan, Message, Send request, the
notification bell and item, Download quote PDF) and the cursor in view, the callout on €720.00 mapped through the
crop, captions on one line under the card, consecutive frames of the largest pans move ≈ 11 px a frame, nothing moves
during the opening stills; **quote-v10-square** (motion theme, 57.2 s; review clean, 1 info): the same, caption bands
under the card, the theme zoom 1.12× on the marked proposal (in 3.8 s, back to 1× before the outro); **catalogue-v4**
(editorial + the 16 s test track, 59.0 s): music RMS ≈ −25 dB on the intro, ≈ −31/−33 dB under footage (−6 dB
ducking), −27.6 dB on the outro, no dip at the loop seams (15.5 s, 30.5 s, 45.5 s), faded out to silence at 59 s.
**Export of catalogue-v4, all six formats** (`retake export … --formats all`, 15 m 37 s; every file ffprobed):
mp4_1080p copy 1920×1080 h264 + aac 59.01 s 8.8 MB; mp4_4k re-rendered 3840×2160 h264 + aac 59.01 s 17.4 MB (8 m 04 s,
the upscaling warning); webm 1920×1080 vp9 + opus 59.02 s 4.6 MB (1 m 25 s); vertical_9x16 re-rendered 1080×1920
h264 + aac 59.01 s 11.5 MB (3 m 17 s); square_1x1 re-rendered 1080×1080 h264 + aac 59.01 s 9.1 MB (2 m 49 s);
gif_preview 480×270 12 fps 15.0 s 0.77 MB (8.4–23.4 s around the first marker, 1.5 s). Every file with sound carries
the music (mean −31.1 dB, the master's level). Frames of the exported vertical and square looked at (every click of
import / availability / add-product: targets and cursor in view; the file chip dragged in from the capture's right
edge followed smoothly), the exported vertical reviewed: the known `long-wait` warning only.
Earlier: quote-v7-vertical / quote-v8-square (before the calm start and the caption bands below the card),
catalogue-v3 one `long-wait` warning (registry delay of the fixture, 00:45.1–00:48.9) — to fix for L2.12.

Renders of L2.9, reviewed with `retake review` and looked at frame by frame (ffmpeg frames of every new component,
the tap-open transitions frame by frame, crops at full size): **signup-v4** (editorial, 46.4 s, run
20261012-022315-signup; review clean, 5 info — video length within the tolerance): the mail notification slides in
at the top right when the mail was captured (sender, subject, two-line preview, mail glyph), the tap ring on it, the
mail-view card grows from the banner's box and scrolls the real rendered email (date from the `date` slot), the lock
screen (theme wallpaper, 9:41) receives the scenario notification then the captured email on top, the home screen badge
counts 0 → 2 on the theme app icon, tap-open from that icon into the confirmed-account clip, then Browse coffees →
Selowa Ridge → hover on Request a quote. **quote-v13** (editorial, 70.7 s, run 20261012-022141-quote; review clean,
8 info): the console's real web notification ("New quote request — Demo Café asks for Selowa Ridge · 3 × 5 kg", the
app icon fetched from the product) overlaid in macOS style at the moment it showed, with the "Instantly" caption; the
download click on "Download quote PDF" with no flash of the PDF tab; the `quote-pdf` card zooming slowly into the real
one-page PDF (no overlap since the print CSS was compacted). Previews of the 7 new components (regenerated after the
last source edits) and variant sheets (windows / ios-banner / android / in-app, motion theme, document scroll, mail and
lock-screen motion) looked at. Earlier: signup-v1…v3 (35.8 / 41.6 s: `video-length` warning), quote-v11 (PDF footer
over the signature), quote-v12 (request scene 34.1 s: `long-scene` warning) — fixed by the changes above.

Renders of L2.10, reviewed with `retake review` and looked at frame by frame (ffmpeg frames at every overlay's start,
moment and glide, contact sheets): runs 20261012-034207-signup and 20261012-034247-highlights. **signup-v7**
(editorial, 45.47 s; review clean, 3 info): spotlight on Café name gliding to Your name, Work email and Create account,
badges 1 and 2, the loupe gliding from field to field (Tab between them shows ⇥ caps), ⌘K then the lens on the search
field and ↩, badge 1 on the Selowa Ridge result, the chapter bar at the top. **signup-v8-vertical** (45.47 s; clean,
1 info): the same reframed; the typed email reads in the lens; between two fields the lens glides for 0.45 s and shows
the label in between (accepted). **signup-v9** (motion, 45.97 s): the key caps sat over the caption band of
caption-overlay → overlays now receive `avoid`; **signup-v10**: the caps moved above the band but then covered the
lens → the loupe also avoids the caps' row and keeps one side for its whole glide; **signup-v11** (motion, 45.97 s;
clean, 3 info): caps above the band, the lens above the fields, nothing overlapping; **signup-v12** (editorial again
after these changes, 45.47 s; clean): unchanged look (caps at the bottom of the capture, lens below the fields).
After these renders only test-guard fixes touched the components (colour literals → `SYSTEM_COLORS.white/black`, the
spotlight and progress fades read `style_bias`: ×1.1 in motion); previews re-rendered, identical to the eye.
**highlights-v1** (editorial, 45.80 s; clean, 1 info) and **highlights-v2** (motion, dark night tone, 47.97 s; clean
after the still fix, 13 info): €465.00 counted up from the proposal, the before/after wipe from the quotes list to the
open proposal, four features staggered, the bar chart with Nov in the accent, the testimonial with initials, the CTA
with its QR (sampled from the frame: version 3, 29 × 29 modules, 9.1 px each at 1080p, 0 modules different from the
encoder). Previews of the 11 new components looked at (re-rendered after the last kit edits: byte-identical).
Render times here: signup 1080p ≈ 2 m 40 s, vertical ≈ 3 m 20 s, highlights ≈ 2 m 10 s.

Renders of L2.11 after the code and video review fixes, reviewed with `retake review` and looked at frame by frame
(ffmpeg frames at every click of each page, every acting-page switch and both hand-offs; the café's bell cropped at
10 fps; pane luminance measured across the switches): run **20261012-073840-live-quote** — **live-quote-v7**
(editorial, 42.33 s): the two pages side by side with their labels, the roaster's label takes the accent within
0.3 s of its scene's start (the new Q-1043 row with its "New" pill already in its list), badges on each page's pane;
the roaster sends the proposal (output 29.93 s) and the café's bell shows its unread badge 0.8 s later and rings —
both hand-offs live; **live-quote-v8** (motion, 42.10 s): idle page dimmed, measured — the café pane brightens within
0.37 s of the proposal scene's start (was ≈ 1.3 s late); **live-quote-v9-vertical** (stacked): the idle roaster pane
shows its page from the top-left ("Quote requests" and its subtitle whole, was cut mid-word), pans right only for the
Send-proposal click and settles back at the café's scene. Run **20261012-080444-phone-and-desktop** —
**phone-and-desktop-v9** (editorial, 31.93 s): the desk's cursor rests visible at the centre of the desk page through
the phone scenes (was hidden under the phone, coming out of it), the phone's badges 1–5 inside the phone, the request
arrives in the desk's list during the send scene's hold (live, behind the phone) and the desk scene opens on a still
list; **phone-and-desktop-v10** (motion, 31.70 s): the phone does not grow (growing would reach the caption band; plan
note), the band clear of the phone, the desk dimmed while the phone acts and bright from its scene's start;
**phone-and-desktop-v11-vertical**: the clicked row framed by its leading part (Q-1043, "New", Selowa Ridge) with the
click, and the closing hold on the detail page's title (was the right half of the page). **signup-v14** (motion,
45.97 s, run 20261012-034207-signup; review clean): after the click on the search result the spotlight ring and badge
fade within 0.45 s of the click (were 1.4 s on the gone card), the next spotlight comes in on Request a quote. Reviews:
only the `video-length` warning (32–42 s videos, short on purpose); in the vertical pip the 1342 px row is an info
(`target-outside-view`: its leading part and the click are shown). A first pd capture (20261012-073952, renders
phone-and-desktop-v6/v7/v8-vertical) had the request arrive during the desk's opening still (`loading-scene-start`)
→ the scenario's send scene holds 1.2 s. Superseded: live-quote-v1…v6, phone-and-desktop-v1…v8, signup-v13.
Capture fps per page (the runner's own measure, cursor moves below 18 fps): live-quote buyer 11 of 14 (lowest 9 fps,
the request dialog's backdrop blur), supplier 1 of 2 (lowest 13); phone-and-desktop phone 1 of 12 (lowest 18), desk
none. General capture speed stays L1.3. Render times: ≈ 3 m per 1080p video (42 s), vertical ≈ 3 m 30 s, pip ≈ 2 m 30 s.

Renders of L2.12, reviewed with `retake review` and looked at frame by frame (ffmpeg frames at every segment boundary,
inside the intro and the outro, through the alpha burst — full-resolution crops of its edges over the white dialog and
the dimmed page —, the Lottie card and the Lottie check overlay; audio measured sample by sample against the source
intro). Run **20261012-093815-own-media** — **own-media-v6** (editorial + the test bed, 46.03 s; review clean, 9 info
— the diff against v3 counts as info): the intro is the user's video (coffee bean, "Northfield", tagline) crossfading
into the shop; the burst (VP9 alpha) bursts on the Send request button from the click, rays clean over the dialog and
the dimmed page (no halo, no black fringe); the Lottie cup recoloured in the theme's accent (burgundy) on the paper
card; the check badge Lottie at the top-right of the screen over empty space right of the quotes list; the end-card
image as the outro; record `audio: music+files`. Music (measured on v2, same plan): bass −46.8 dB under the intro ≈
−47.5 dB under footage vs −40.0 / −41.2 dB on the silent Lottie card and the image outro → ducked ≈ 6–7 dB under the
file with sound only. **own-media-v7** (motion + music, 47.17 s; clean, 9 info): fade-black transitions around the
files, the cup in the motion accent (orange) on the night background. **own-media-v8-vertical** (46.03 s; clean,
4 info): the 16:9 intro and outro shown whole on the theme background (`fit: auto` → contain, plan notes), the whole
burst kept in the reframe while it plays, the check badge placed at the bottom-right of the crop (asked top-right: it
would cover the hovered Selowa Ridge row there — plan note) clear of the row and the cursor; record `audio: files`.
Intro audio after the fix: in v8-vertical the intro's gain against `assets/intro.mp4` (least squares per frame) is
1.000 on frames 3–104 then 0.68 / 0.49 / 0.25 (its end ramp; v5-vertical: 0.27 at frame 97 where the crossfade
starts, and no end ramp); v6 − v7 bit-identical over the intro although the crossfade starts at 97 and the
fade-black at 102; v6 vs v2 and v7 vs v3 differ only on frames 96–108 (pictures identical: PSNR ≥ 58 dB); the click
at 3.22 s (sample jump 0.0388) is gone (0.0037, as in the source). The new `overlay-covers-target` on the old plans
flags v5-vertical's badge, not v6 / v7 / v8-vertical. Superseded: own-media-v2 / v3 / v5-vertical (the intro's sound
dipped with a click where the transition began, no end ramp; v5-vertical's badge over the hovered row),
own-media-v1 (run 20261012-090240, 42.7 s: `video-length` warning → the scenario holds longer),
own-media-v4-vertical (16:9 intro and outro cropped by cover → `fit: auto`; its record still says `audio: silent`,
before the `files` label); earlier own-media runs 20261012-085959 / 090124 (the burst first on the cursor, then on a
toast that the cut hid). Run **20261012-093047-catalogue** — **catalogue-v5** (editorial, 70.13 s; review clean,
7 info): the add-product registry spinner is on screen ≈ 2.2 s (was 3.8 s at 1× → `long-wait` warning in
catalogue-v3/v4), frames 58.2–60.4 s looked at; the video is longer than catalogue-v4 (59 s) because this capture ran
slower here (steps took longer; capture fps), not because of the waits (none of the review fixes changes its plan).
Render times: ≈ 2 m 35 s–2 m 55 s per own-media render (1080p and vertical).

Raw packages of L2.13 (`projects/northfield-fixture/exports/`, git-ignored), all re-exported after the review fixes
and each checked: every clip and layer ffprobe'd with `-count_frames` (codec, profile, pix_fmt, fps, frames,
duration, timecode) against `manifest.json`, every cut strictly inside its clip, the FCPXML (well-formed; spine
offsets, durations, asset starts on the frame grid and equal to the clips' timecodes; a ProRes layer's asset start =
its own file's timecode; no WebM layer; markers inside their clips), the OTIO (read by OpenTimelineIO 0.18.1: V1
clips at their sequence position, available range = timecode, `file://` URLs; every other track's clip against its
media — start = its timecode or 0 for WebM, frame count — and its sequence position; markers inside), the EDL (read by
OTIO's cmx_3600 adapter at the package rate: events and LOC locators), the FCPXML again through OTIO's fcpx_xml
adapter, markers.csv = markers.json — script `validate.py` (scratch, not in the repo; L2.14 can add a repo helper if
wanted). The OTIOs of the catalogue and live-quote packages converted with otio-fcp-adapter (FCP 7 XML, Premiere's
route): `file://` pathurls, markers kept (31, 29):
- `20261012-022141-quote-raw-mp430-baked` — 4 clips, H.264 High yuv420p 30 fps, 1700 frames (56.67 s), 35 markers;
  starts / ends looked at (loaded pages, cursor in place).
- `20261012-022141-quote-raw-prores60-layer` — ProRes 422 HQ 60 fps + ProRes 4444 layers + selects (3398 frames);
  each layer composited over its own baked clip (ffmpeg overlay, crops ×2 at the clicks): the drawn cursor covers the
  captured one exactly (hand on "Request a quote"); the baked ripple starts later where the screencast ran at ≈ 9 fps
  (the layer draws the frame's true time).
- `20261012-123617-quote-raw-mp430-none` — `run --raw --cursor none --selects`: no cursor or ripple anywhere (crops at every
  click), effects recorded (icons hand / ibeam / arrow, 17 presses and ripples).
- `20261012-123617-quote-raw-prores60-layer` — its ProRes 60 clips + layers: composited, the kit's hand, ripple and arrow at
  the click points, the same look as the baked captures; the icon switches to the arrow as the request dialog takes
  the pointer (recorded by the kit).
- `20261012-073840-live-quote-raw-mp430-baked` — 8 clips (4 scenes × buyer / supplier, 1440×900, same frames per
  scene; the supplier is on the sequence for "arrives"), 1092 frames, 29 markers (28 before the review: "delivery"
  ends on a 6 ms wait whose step marker fell one frame past the clip and was dropped); both pages' first / last frames
  looked at. `…-raw-mp430-layer` — the same with VP9-alpha WebM layers: no timecode, so out of the FCPXML and from
  media time 0 in the OTIO (the validator checks each against its file); composited with libvpx-vp9 over its baked
  clip at "Send request": the layer's hand on the captured hand.
- `20261012-093047-catalogue-raw-mp430-baked` — 3 clips + selects, cuts: import 2.24 s of loading (17.807–20.051 s:
  the press on "Start import" with its ripple → "921 offers created" fully painted; the resume is now the arrival of
  the first painted frame, 20.051 s) and add-product 4.36 s of page loading (from the URL change after the option
  click → the product page's reveal starting, no skeleton frame); frames 502–504 and 270–272 looked at.

Scratch checks of the review fixes (scratchpad, not in the repo): the catalogue at 60 fps (frame 1005 after the import
cut = the full "Import complete" dialog, was its title only; the navigation cut clean at 542); a copy of signup run
20261012-034207 whose search wait lasts 1 s (the cut starts at the URL change after Enter: "Selo" → "Selowa" typed and
kept, then the results page — the old plan cut from 16.13 s, mid-typing); a copy of the catalogue run whose import
scene ends on its wait (no cut, the 2.24 s of loading kept to the clip's end, a note, mark "import-done" on the last
frame).

## Notes
Notes from L5.13:
- Names: a branch from before L5.13 runs `node scripts/rename-l513.mjs` on itself before a rebase (`--dry` lists,
  `--only <files>` for a few files, `--allow-dirty` for a dirty tree); lines or regions tagged `old-name:` are never
  rewritten. The old names the code reads live only in `packages/core/src/legacy.ts` / `packages/engine/src/legacy.ts`;
  tests of them are `legacy*.test.ts`; elsewhere the guard fails.
- Every brief exports `RETAKE_HOME` (vitest makes a temp one when unset and refuses `~/.retake` / the old home).
- Not old names: the `studio/` namespace, the `studio` comment channel, `studio:*` events, "the Studio", README block
  markers `studio:component-preview`.
- The main checkout's git-ignored old tool folders stay ignored (`.gitignore` keeps them): optional cleanup.

Notes from L5.12d:
- The quit question: `guard_flow.rs` is the only place its rules live (pure, injected clock); guard.rs runs its effects.
  `RETAKE_DESKTOP_TEST_QUIT=native` keeps the L5.2b gated cases on the native alert; the page-path cases run
  without it.
- `desktop_answer` is never an MCP tool and never nudges onWrite; only `shown` is rate-capped.
- There is no legacy CSS: base.css holds element defaults on --ui-* tokens; a className word must be defined in a
  stylesheet (or be a named hook); every motion rule has a later `prefers-reduced-motion: reduce` override.
- Connecting / Ended have no session to answer through: Quit there goes native after 1.5 s, by design.

Notes from L5.12c:
- App files import the api's `call` / `useCall` only by name (no alias, namespace, default or dynamic import, no
  re-export): `apiImportFindings` in app-source, so the per-file op lists (`LIBRARY_OPS`, `COMMENTS_OPS`, Shoot's,
  the scenario side's) cannot be dodged.
- ColorField drafts on `input` and writes on the native `change`; give it `version` (the file's sha256) so a 409 or a
  new version resets the hex text; `onText` is for forms that own the text (New theme).
- The Library's component inspector is rendered once, after the grid / detail branch, keyed by component: state like
  SetDefault's result survives the route change to the copy.
- The card grid is one roving tab stop; Enter on the selected card moves focus to the inspector.

Notes from L5.12b:
- Comments-side writes are checked structurally in app-source (`COMMENTS_OPS` per file, ProposalCard imported only by
  ThreadPanel, `BANNER_IMPORTS`, `threadWrites` reads `if_match` on resolve / reopen / apply; thread_reply has no
  `if_match` by design). A new comments file needs its row in `COMMENTS_OPS`.
- A palette group registers through `paletteGroup` (`useScenarioGroup` is an alias); its handlers must not reach a
  writer (traced in app-source; the kit and comments e2e run every row under an op counter). Rows with a key are the
  menu bar's (checked against menu.rs).
- Both Review views share `ReviewChrome` / `useReviewRender`; StatusActions stays hidden on the review and comments routes.
- The a11y checker skips the page behind a `dialog:modal`.
- A test file is green only when vitest exits 0 (a route released while its handler sleeps prints "Errors 1" with every
  test ticked): `unrouteAll({ behavior: 'wait' })`.

Notes from L5.12a:
- Edit owns `render` at PRIORITY.screen in every state (loading, error, blocked, ready) and the status bar's
  `renderWhy` also refuses on a proposal route: two guards on purpose (a proposal never renders the file on disk).
- The playhead is an overlay: never pass `frame` into the tracks (studio-e2e-edit-budget counts track renders).
- A queued undo / redo behind a switch write is dropped and said when that write fails or conflicts; a pending "Show in
  Edit" seek is dropped on a route change or an error state.
- `review_export` runs on one workspace chain: one export per render, at most `REVIEW_EXPORTS_OPEN` (2) open across the
  workspace (CLI and Claude exports count); the answer carries no path. The raw capture is a command built only from
  ids passing the slug rules.
- The Review report never says "passed" (the review does not record which checks ran); "Rendered" is a state word in
  the a11y checker (`STATE_WORDS`).
- Every Edit / Review file is under the app-source "every value from data is text" lint (EDIT_REVIEW_SIDE); new screens
  join such a lint from their first commit.

Notes from L5.11b:
- On the Record route a live recording holds stop / rehearse / capture / render at PRIORITY.recording from the first
  paint (before the view is read), so ⌘. after a reload reaches `record_stop`. Ownership is per route by design: on
  the start form or Prepare the usual defaults apply.
- One change in flight per recording: picks queue (newest per step), Stop and Discard wait and go right after, other
  changes are refused and said; queued changes read the newest view's revision.
- State that must survive the inspector's remount (the Name, the insert form, the Discard sheet) lives in
  `RecordingBody`; the inspector itself still remounts when hidden (the app-source lint bans `document.createElement`).
- `studio-e2e-record-keys.test.ts` answers the record ops in the page (no headed window), so it can hold a view or a
  save back and build any draft length; `studio-e2e-record` keeps the real window flow.

Notes from L5.11a:
- Commands go through `shell/command-bus.ts`: a handler registers with a priority (PRIORITY.defaults 0, screen 10,
  recording 20) and is held in a ref; the highest priority wins, the latest registration breaks ties. A screen that owns
  Stop registers it; never call `stopRun` from a key handler directly.
- `scenario_actions` is the status bar's and Prepare's read: never route it through `scenarios.view` (its 16-entry LRU
  holds the open scenario). The Scenario screen feeds the store from its own blocks read; a run's progress never
  re-reads it (only a run's end or a file change does).
- Blocker words key on the engine's `kind` (`shoot-words.ts` `blockerShort`), with an honest fallback for an unknown
  kind; add a kind at the gate when a new gate appears.
- "Rehearse" is the UI word only; a source lint (app-source "L5.11a: Shoot") keeps "dry run" out of the UI's own words.
- The polite line (`shell/say.ts`) is one message at a time, through Txt, cleared after 6 s and on a route change (the
  key includes the run id). Progress never goes there.
- Prepare's Start footer is sticky; the centre pane has a `scroll-padding-bottom` so keyboard focus lands above it.

Notes from L5.10b:
- The scenario screen keeps one resolved selection (`resolveSelection`): a gone step falls back to its scene, then the
  video — never to another step. The storyboard is a set of listboxes (one per scene) with grid keys from
  `board-keys.ts`; a drop's slot comes from the pointer (`slotFromPointer`), so gaps are not dead zones.
- `Running` (progress, Cancel) sits above the Board · YAML switch. The Location select sends `env` to `scenario_run`
  only when it differs from the file's own and names a known environment.
- E2e tests that install `page.route` release it in `afterEach` (`holdRoute`) and wait for reads to go quiet before a
  conflict test (`holdReads`). The a11y checker skips `.k-sr` text like `.sr-only`.
- "YAML view" (not "YAML tab") and "Board" (not "Blocks") everywhere in the UI and messages.

Notes from L5.10a:
- Project data comes from `project-data.ts` (one entry per project: project_get, project_board, auth_status; stable
  subscriptions, first read in an effect, errored entries retried with a backoff or on an event). Screens never call
  those ops themselves; tests count reads (`studio-e2e-board-reads.test.ts`).
- `project_board` must stay off `scenarios.view` (its 16-entry LRU holds the open scenario). Its caches are stat-keyed
  with a 60 s TTL; the `workspace` event carries `files`, the `jobs` event `projects`.
- E2e migrations of a screen rebuild run the guard (`l510/guard` in the lot's scratch notes: titles, `expect` counts,
  test ids vs HEAD); state words carry a word the a11y checker knows ("valid" was added to its list).
- A dialog that closes itself gives focus back at once and ignores its own late `close` event; JobsWatch keeps a job id
  unknown until its job.json can be read.

Notes from L5.9:
- Colours live in `tokens.ts` only: run `pnpm -F @retake/ui gen:tokens` after a change (a test compares the
  committed `tokens.css`). New screens use the kit (`src/app/ui-kit/`) and `--ui-*` tokens; legacy screens sit in
  `@layer legacy` (app.css) and the ratchet in `test/legacy-controls.json` may only go down (`pnpm -F @retake/ui
  ratchet` after removing legacy controls). The reference for L5.10 – L5.12 is docs/reference/studio-ui.md (C1 / C2
  give layout only; the R4 boards the drawing).
- The centre pane (`#main`) is the only scroller: IntersectionObservers and test scrolls target it; sizes derive from
  `--main-h` (no `vh`, also inside min / max / clamp).
- The app's name is `APP_NAME` in `brand.ts` (a lint refuses "Retake" elsewhere in the app; server / player
  comments and one server test title are left for L5.13).
- Page commands come from `MENU_COMMANDS` (`commands.ts`), mirrored by the desktop menu table (parity test), dispatched
  as `studio:command` (ids only, ignored while a modal dialog is open); in a browser tab only ⌘K (Ctrl+K off a Mac,
  outside text fields) is bound.
- WebKit: Tab skips buttons unless macOS keyboard navigation is on, radios do not wrap, a click does not focus a button
  — the kit's focus return falls back to `#main`; Safari / the app are checked by hand (MACOS-CHECKLIST 14b).

Notes from L5.2b:
- The supervised pipe is one-way and line-framed (`"\n"+line+"\n"`, ≤ 8 KB): `pending` (coalesced 250 ms,
  latest-wins) and `job_end` (≤ 20 a minute); console output goes to stderr in supervised mode. The shell keeps the last
  snapshot, so Quit reads memory; after a server crash only the unsaved part is kept.
- Every word of an alert or a notification lives in `apps/desktop/core/src/words.rs`; the pipe carries enums and names
  that pass the slug rules (checked on both sides, existing projects / scenarios only). A static test keeps the TS and
  Rust enum lists equal.
- Never send `terminate:` from a Tauri closure (tao's lock): only `performSelectorOnMainThread` from the signal thread.
  `GUARD_OPEN` makes a second terminate during a question answer Cancel; `QUIT_NOW` (SIGTERM / SIGINT / SIGHUP) aborts
  any shell modal and blocks new ones.
- Test mode (`RETAKE_DESKTOP_TEST` + parent not launchd) answers questions from `_ANSWERS`, logs notifications
  instead of posting them, and SIGUSR2 sends Quit; a Finder launch can never arm it.

Notes from L5.2:
- `retake ui --supervised` is the shell's only contract: one JSON line (`v`, `url`, `player`, …), stop on stdin EOF /
  SIGTERM with `stopped: <reason>` on stderr; exit 2 is preceded by `{"type":"error","code":"no_workspace"}` (an exit
  2 without it means an older CLI: `pnpm build`). `/v1/info` gains token-gated counters (`sessions`, `streams`,
  `player_media_bytes_read`, `player_range_requests`) used by the gated test as proof the page and the Player loaded.
- Rust never runs in `pnpm build`; `pnpm test` runs the core crate's tests only when cargo, a recent rustc and
  `xcode-select -p` are there (checked before cargo, so no Command Line Tools dialog). Cargo always `--locked`;
  `CARGO_NET_OFFLINE=true` for offline. Build folders: see README (≈ 1–2 GB per target dir; `pnpm desktop:clean`).
- The app is never installed by the tooling; the gated test launches the binary inside the .app directly and
  unregisters it from LaunchServices (`lsregister -u`, its own path only); it asserts ~/Library and ~/Downloads unchanged.
- The window chrome follows the page's `color-scheme` (app.css pins light today; L5.9's dark / light tokens change it);
  `TITLE_BAR` in `src/main.rs` switches to the overlay title bar; the app name and bundle id live in tauri.conf.json.
- The preview frame's plan goes through `frame-store.ts` (`latest()` + `useSyncExternalStore`): never hold a React
  setter taken in an effect for a message that can arrive before it (WKWebView fires the frame's load first).
- A Finder-launched app gets launchd's minimal environment (no `{{env:}}` values; the shared worker it starts keeps it
  until it idles out): README, MACOS-CHECKLIST 14a, BL-125.

Notes from L4.9:
- Every app.css colour lives in `:root`; the lints fail on a literal elsewhere, an undefined or unused token, a text /
  background token pair under 4.5:1, a missing `::placeholder` colour, an outline removed without the accent ring, and a
  handler on a non-native element outside four reasoned exceptions. A selected state needs more than colour (weight, a
  ≥ 2 px mark at 3:1, a 3:1 fill or a marker).
- The tours (`studio-e2e-a11y.test.ts`, `studio-e2e-a11y-keyboard.test.ts`, ≈ 21 s each) audit an editable workspace
  theme (`tour-theme`), wait for loading `role=status` messages, treat a truncated Tab walk or a still-loading station
  as a finding, and wait for Undo to be enabled before ⌘Z (StepEditing drops ⌘Z while saving: BL-122).
- The acceptance: `RETAKE_TEST_SLOW=1 RETAKE_TEST_CHROME=1 npx vitest run
  packages/ui/test/studio-e2e-acceptance.test.ts` (installed Chrome for H.264; not in test:slow, like the other Chrome
  tests). Its render wait fails fast with the job's phase; a once-seen cold-cache hang did not reproduce (BL-123).
- Tests that link the repo's shared render cache use `linkSharedCache(root)` (editor/test/render-helpers.ts), which
  creates `REPO/.retake/cache` first — a fresh clone or worktree no longer depends on test order.
- WebKit-2370 (cached, not Playwright 1.56.1's 2215) launches through `executablePath`; Firefox does not drive (BiDi).
  Neither is in the suite (BL-121); Safari / Firefox / VoiceOver are MACOS-CHECKLIST 13j.

Notes from L4.8:
- A Studio recording is the person's only when its job exists with `submitted_by: 'ui'` and is the job its `meta.json`
  names; otherwise it is read-only. Studio record jobs never auto-save; Save writes a new file only and sends back the
  `draft_sha256` from the view (409 when events, a project var or the annotations changed). A missing / malformed
  `events_sha256`, or a succeeded job with no record.json, is `tampered` (no Save, no "check passed").
- `studio.json` (picks, inserts) is written by the engine only, under the recording's lock, with a revision check and
  no-follow opens; inserts carry the identity of their row (`row`, `after_insert`), so the draft can regenerate without
  moving them. Studio drafts are written without YAML aliases (CLI / MCP drafts unchanged: BL-119).
- The queue's `stop` marker (like `pause`) is polled by the worker for running `record` jobs only; `queue.cancel(id, by,
  'discard')` records why. MCP `job_cancel` is refused on an open Studio recording. No new job kind, no job.json change
  (relevant to BL-117).
- The check replays the recorded draft without picks and inserts (a dry run of the saved scenario checks those). One
  instant wheel jump (headless 2400 px) records no scroll — an L3.4 limit noted in BACKLOG; tests scroll in steps.
- The lab's labels must not contain each other (Playwright `getByRole` names match substrings): the far section's
  buttons are "Unlock the last step" / "Delayed control". The gated L4.8 acceptance: `RETAKE_TEST_SLOW=1 npx
  vitest run packages/ui/test/studio-e2e-record-acceptance.test.ts` (part of test:slow; `RETAKE_TEST_HEADED=1`
  shows the window).

Notes from L4.7:
- A scenario's `template` (a listed theme name, written through set_field / scenario_edit) re-themes existing takes at
  their next render; project.yaml's theme stays a hand edit. Editable themes are decided by real path; starters and
  project-folder themes are read-only (Copy to edit; copying a project-folder theme is BL-113). Theme copies refuse
  links and hard links. brand / outro URLs are shown as typed (no scheme).
- Library loops: the worker bundles the whole registry once (≈ 30 MB, shared with renders); an item that fails there is
  re-rendered with its own components only; `failed.json` records the bundle hash (a failure under another hash
  re-renders without Retry). The key = component folder hashes + theme content + spec (URLs as file hashes) +
  composition / kit / Remotion / browser identity. The job refuses below 1 GB free.
- A component may not import through what its content hash skips (dot entries, node_modules, previews, dist…): refused
  by the compile check, the player loader and a webpack guard on render bundles. `<workspace>/node_modules` stays in
  webpack's lookup (same trust as renders; BL-113).
- The app's one image element is `Picture`, built only by `imageDataUrl` (JPEG / PNG / GIF, magic-checked, capped per
  format; never SVG / WebP — theme logos show in the live frame only). The app bundle budget is 600 KB (raised
  freely). The gated L4.7 acceptance: `RETAKE_TEST_SLOW=1 npx vitest run
  packages/ui/test/studio-e2e-themes-acceptance.test.ts` (part of test:slow).

Notes from L4.6:
- `via: 'studio'` exists only through the Studio's HTTP routes (only studio.ts makes a `ui` engine client); its comment
  ops pin their inputs (no author, via, path or proposal from a page). MCP still cannot create, reopen or apply; the
  rule keeping Claude off the Studio token (`.retake/ui.json`) and `/v1` routes is an instruction (skill lint), not
  a barrier (BL-106) — Apply through it would still run under agent trust.
- A proposal is edit-only (a `template:` / theme, filmed or override change is the direct loop), joined with the file's
  own line breaks (a file mixing LF and CR LF is refused), rebuilt strictly from canonical hunks; Apply always runs the
  agent-trust write checks (cli included), holds the thread lock (then the storage write lock) and checks the thread's
  room before writing. A previewed proposal is never a restorable version. Undo apply lives in the tab that applied.
- The Studio never cuts a diff; Apply sits after it; the timeline's Preview banner only leads back to the thread.
- render_frame: one ffmpeg per frame on descriptors (links refused), two shared slots with run thumbnails, ≤ 4 pending,
  newest wins per tab session before the file opens; busy is 429, a timeout 503 (the only ops not on 423). The
  scenario_edit answer no longer carries `path`; Studio errors are path-free except the copyable `fix` command.
- An MCP server started before L4.6 reads Studio threads and proposal entries as invalid until restarted (the skill
  says so). The gated installed-Chrome acceptance: `RETAKE_TEST_CHROME=1 npx vitest run
  packages/ui/test/studio-e2e-comments-chrome.test.ts` (fixture on free ports, ≈ 2–6 min). The app bundle budget is
  490 KB.
- The test suite sets `RETAKE_DISK_WARN=off` (vitest.config.ts): captures still measure the free space but the
  low-disk warning (below 10 GB or 5 % of the disk, R-FLD-28) no longer fails the capture tests that assert no warnings
  (user decision 2026-10-27).

Notes from L4.5:
- The preview runs agent-writable code (workspace components): it lives in a `sandbox="allow-scripts"` iframe on the
  player origin (a second loopback port, one capability per project leased by the page and revoked when the last tab
  leaves, CORS `null` on media, hard links and symlinks refused), with Trusted Types, WebRTC removed and boot.ts refusing
  `rel=prerender` (Chrome follows it despite CSP and sandbox). A workspace component runs there only once the person
  allowed it in this Studio session (memory only, keyed by its folder content hash; no MCP tool reaches it).
- `set_field` writes only the scenario's edit values (always an edit change: no new capture); intro / outro switches
  refuse when the map holds more than component and duration. `caption_component` picks the caption component.
- A Studio render renders the scenario text it was submitted with (`.retake/jobs/<id>/edit.yaml`) and runs its
  review inline; "from this version" needs the same plan signature and theme hash.
- The gated real-Chrome timeline test: `RETAKE_TEST_CHROME=1` (+ `RETAKE_TEST_REAL=<ws>:<project>:<scenario>`).
  The app bundle budget is 430 KB.

Notes from L4.4:
- Live pictures never reach disk (a scan test enforces it); the worker channel (`live.json`, 0600, read without
  following links) passes the engine gate with browsers refused; the Studio opens one upstream per job only while a tab
  watches; a capture streams only when the page asks (`frames: true`).
- Capture time comes only from the capture clock (DESIGN §3.4); a pause is a list entry the clock subtracts from every
  wall time (`timeline.pauses`, `t0_wall` alone no longer converts). The product clock is not re-anchored after a pause
  (what moved on the page shows as a jump; documented). `RETAKE_PAUSE_MAX_MIN` (30), `RETAKE_SIGNIN_MAX_MIN`
  (30).
- Every resolved persona's secrets (incl. sandbox account passwords) are registered before the outline is emitted:
  nothing a run writes may hold a secret (auth.test scans every event and run file).
- `sessions_ack` is a confirmation, not person presence (BL-106); `auto` sessions require every `{{env:}}` of their
  login steps to be set for the worker.
- capture-pause.test.ts (real Chromium) can fail when run in parallel with other browser tests; alone it passes.

Notes from L5.8:
- A `hook:` step runs while the recorder keeps filming (the encoder's clock goes on, the page holds still); only the
  edit and the raw export leave its span out. What the hook changed shows when the page fetches it: add a `wait_for`
  after the step (the fixture's quote list reloads every second; BL-102).
- Named hooks never change from the Studio (`hooks` in HOOK_SECTIONS); the Studio may add, move or delete a `hook:`
  step — what it runs is still gated by the approval rules (a shell or destructive entry needs a terminal).
- The page pre-flight runs before every run (inspections and dry runs too) on every page of the environment; tests
  with an unused dead page must give it a live URL (BL-103 would narrow it).
- MCP results are compact by default: acceptance tests that read full fields pass `detail: "full"` (authoring,
  phase-3 and fixture acceptances). Every result's JSON is now one line.
- The gated L1.8 Docker suites (compose.test.ts, sandbox-docker.test.ts) need busybox:1.38.0 and postgres:17-alpine,
  missing from this Mac's Docker cache on 2026-10-26 (not pulled: a download for the user to approve); the new
  compose-env test needs only the docker CLI.

Notes from L4.3:
- `scenario_edit` is the only Studio write path; every kind (replace_text, restore, move / delete / duplicate, set_step,
  insert_step) is verified by re-parse (value equals the intended one) and refused otherwise. `restore` accepts only a
  version the engine showed or wrote. Hidden characters are kept only on lines identical to the base file.
- From the Studio, hooks never change, and neither do `vars` / `env` while the file has hooks or mocks (hooks read
  them); a scenario that is a link outside `scenarios/` or holds a lone CR is read-only there. A Studio dry run skips
  hooks: scenarios like quote need their state prepared first.
- Every `if_match` write holds `.retake/locks/write-*.lock` keyed on the real path (the CLI's own writers do not:
  BL-96). `comments_list` returns `step_now` (the step in today's file, across scenes).
- `run.test.ts` "an AbortSignal cancels the run…" failed every time at load 26–32 on main 2f1813a too (setup 'failed'
  instead of 'ok'): a timing flake that load now triggers reliably — worth hardening (L5.7 touches capture timing).
- L4.7 gained R-UI-06b (user decision): an animated preview per component in the library.

Notes from L4.2:
- Pictures are never written to disk: the server keeps a byte-bounded memory cache keyed by run id + run key, and sends
  base64 JPEG through the gated call route (`data:` URLs; the app's only `src=` is in `Thumb.tsx`).
- Run files are read only through `readPlainFile` + realpath inside the run (no links, FIFOs or oversized files); the
  video goes to ffmpeg as a file descriptor. A capture's picture is the frame on screen at the step's end (after its
  hold): `min(floor(t·fps), frames−1)`.
- The screen re-reads its view only for its own scenario file and its runs starting, finishing or being removed;
  progress uses `run_status`. Step numbers a person reads are 1-based everywhere (`stepRef`).
- `scenario_run` pins its arguments, takes the view's hash (409 when the file changed) and refuses a second run of a
  scenario already queued; every non-CLI client's worker starts with `cleanWorkerEnv` (a deny-list: BL-80 residue).
- `parseYaml`'s alias check is one pass (a quadratic version froze every client on a crafted file).

Notes from L4.1:
- Every HTTP route goes through engine `checkRequest` with a RouteSpec (fixed order: Host → Origin / Sec-Fetch-Site →
  route / method → token → content type / body cap). MCP over HTTP refuses any Origin and any Sec-Fetch-* header but a
  lone `Sec-Fetch-Mode: cors` (Node's fetch sends it); the Host check is what stops DNS rebinding.
- The `ui` client runs a short op allow-list (9 ops) under agent trust with no approver; later lots add the ops their
  screens need. Reads never follow a link out of a project (README, scenarios, project.yaml through the engine).
- One Studio server per workspace (`.retake/ui.json`, 0600); `retake ui` opens a one-time code (60 s); the index is
  a cache (missing / corrupt / not a regular file → rebuilt); unfinished jobs come live from the queue.
- `retake mcp --http` (default port 47820) keeps a stable token in the Retake home (`--rotate-token`); print-config
  never prints it. Port squatting on a multi-user Mac is an accepted residue (BL-79).
- Mutation scripts must give restored files a fresh mtime (or run `tsc -b --force`): `tsc -b` keeps a stale dist.

Notes from L3.8:
- A render shows the run as captured: scenario edits (steps, captions, timing, title, intro / outro, template) need a
  new capture; a theme or a render override needs only a render (a run keeps its captured theme: pass `template`).
  `plan_preview` / `render` warn (`scenario_changed`) and then name `run_capture`.
- `inspectPage` never waits on the page without a deadline; if the inspect redirect test ever hangs again, its 60 s
  iteration cap reports the query, the stage and the last progress events (the root cause was not reproduced).
- `node scripts/requirements.mjs --check-cites` (also run by every rewrite) fails on an evidence string quoting a test
  title that no longer exists.
- test:slow takes ≈ 11.5 min (phase3-acceptance ≈ 9 min of it).

Notes from L3.7:
- A lot that changes a loop, a tool argument or a CLI flag must update the skills: `skills.test.ts` fails until it does.
  The lint proves names, arguments, commands, links, examples and wording rules — not that Claude follows them.
- The plugin's values (`node`, `cli`, `workspace`, `home`) are per user even with `--scope local`: one workspace at a
  time (reinstall to switch); the skills stop when `engine_info`'s root is not the session's folder. `--plugin-dir
  skills` loads the skills without the MCP server.
- `retake mcp` keeps only absolute PATH entries outside the workspace, and completes PATH with Homebrew / system folders
  when serving. The gated `claude` tests use a scratch CLAUDE_CONFIG_DIR (`RETAKE_TEST_CLAUDE=1` or test:slow).
- The Remotion licence question (BACKLOG open decisions) stays parked: it matters before selling, not for own use.

Notes from L3.6:
- Threads `<project>/comments/<scenario>/c_<ULID>.json` (ignored in this repository: `projects/*/comments/`), written
  only through the engine store under `<project>/.retake/locks/comment-<id>.lock` (TakeLock: busy retried 3 s,
  stale only when the holder is dead); entries are appended, the status derived; a file never passes 2 MB.
- Trust: MCP has no create / reopen and no author field (entries are `{via: mcp, name: agent}`); every free text and
  every field read from a thread file is untrusted (`trustedAnchor` shows a bad value as `unknown`); INSTRUCTIONS: a
  comment may only ask for changes to the video. `retake comment add --author` from Claude's Bash stays possible (BL-76).
- `--at` takes the frame on screen (floor); a marker name used twice is refused; a resolving render must be the same
  variant (`latest` = newest of that variant); `comments_list` returns the last 10 entries per thread and at most
  60,000 characters of text. `RETAKE_AUTHOR` sets the CLI's default author.

Notes from L3.5:
- Two theme tools: `template_create_from_brand` (sources only from the workspace, never agent-writable folders,
  `.retake/` only through a `site:<id>/logo-<n>` ref; SVG refused, never cleaned; new names lower-case, never a
  starter's or an existing folder's, compared without case; never inside the Retake package — the repository root
  cannot be the workspace of a theme create; `replace` only of an unchanged theme made the same way: MCP replaces only
  MCP-made themes; annotated destructive) and `template_from_site` (a `site` job: the worker refuses the whole job
  unless it carries a verified signed approval of the exact URL's fingerprint).
- Site network contract (runner-web `site/`): Chromium's only network is a local CONNECT proxy in the worker (DNS
  names on 443 only, every address public — core `ip-class.ts` —, connects to the checked address, tunnels only hosts
  the route announced, caps per tunnel / job); the top-level redirect chain is followed first in Node, only to the same
  host or its www / apex sibling; WebSocket closed, WebRTC UDP off, service workers, shared workers and `fetchLater`
  removed in every frame (switch + init script); 15 s per page call, 120 s per extraction, `job_cancel` closes the
  browser; outputs written via temp + rename into a folder the worker makes new. Every page string under `untrusted`.
- Test-only `RETAKE_UNSAFE_TEST_RESOLVE=<name>.test=127.0.0.1:<port>` (loopback only; doctor warns; it must be in
  the MCP server's environment). Known limits (BL-75): subresource redirects to another host fail, a signed site job
  has no expiry, "public" ≠ "the internet".
- Many tests leave `ds-*` folders in `$TMPDIR` (≈ 10,000 / 7 GB since 2026-10-12 on the Mac): clean them now and then
  (`find "$TMPDIR" -maxdepth 1 -name 'ds-*' -mmin +180 -exec rm -rf {} +`); making the tests clean up is a chore to do.

Notes from L3.4:
- The recorder never uses `exposeBinding` (its binding is visible to the page in Playwright 1.56): everything runs in
  a CDP isolated world (`Runtime.addBinding` scoped to it); the isolated world reports origin "://", so the origin is
  read from the main-world context.
- Secrets: masked in the page (memory of committed / current secret values, ≥ 6 characters) and again on the runner
  side (salted hashes, never written); typed URLs mask token-like path segments and drop token-like query values.
- Writes: on read-write environments any non-GET request from the window counts (whatever its host) to bound the check
  replay; telemetry POSTs cut it early (safe side). A recording holds the single worker as long as the person takes
  (≤ 30 min, `RETAKE_RECORD_MAX_MIN`); a worker signal stops and keeps, `job_cancel` discards.
- Playwright `setInputFiles` with buffers fires untrusted events: tests choose files by path through the file chooser.

Notes from L3.3:
- The authoring loop (INSTRUCTIONS): page_inspect → Claude writes the YAML → scenario_validate → scenario_save →
  page_inspect {scenario, until} → run_dry. `scenario_from_script` is an optional deterministic aid.
- Inspections: dry-run semantics (no hooks, writes only as a dry run would), inspection pacing, outputs in
  `<project>/.retake/inspect/<id>/` (never runs/), origin checked on every kit read (`callOnce`, no retry across
  documents) and foreign main-frame navigations answered 204; an automated sign-in refreshes the persona's session like
  any run. Page text only under `untrusted`; labels never include field contents (`nameText`).
- Kit budget: per-call memo; an unscoped nth is not looked up among more than 10,000 matches (`NTH_MAX`).

Notes from L3.2:
- Worker renders are guarded (editor render/network-guard.ts: CDP Fetch on the browser connection, `/proxy` src check,
  `onDownload`, CSP meta; bundle format 2); `retake render` stays open (https: slots work). Remotion binds its bundle
  server on all interfaces (BL-72). The worker ignores EPIPE rejections only (a refused guarded download).
- Trust `mcp` render rules: `planRun` gate 1 (before any read) and gate 2 (every plan asset inside project / run /
  theme); agent-writable folders matched case-insensitively on the on-disk path (macOS); `video.template` a name or the
  project's own; export and review read renders by id with containment checks; `review_get` never trusts report.json
  (keys, codes and ids re-derived, the rest under `untrusted`).
- Images reach the model as MCP image blocks (≤ 4 / 1.5 MB / 1280 px per result, env-overridable); how Claude Code
  counts them against its output limit is unverified (12d).
- New job kinds: core `JOB_KINDS` + the worker's exhaustive switch; failed-job messages of product-facing kinds go
  under `untrusted.error`.

Notes from L3.1:
- Register the MCP server with `node packages/cli/dist/bin.js mcp --print-config` (never `pnpm retake …`: pnpm's banner
  breaks the JSON and its folders end up in PATH); secrets for automated sign-ins go as `-e NAME=…` before the `--` of
  `claude mcp add`; remove the user-scope registration after a test (`claude mcp remove retake -s user`).
- All SDK imports live in packages/mcp/src/server.ts. The MCP process never launches Chromium: everything that opens a
  browser is a job for the worker. Worker log: `<workspace>/.retake/workers/worker.log`; queue:
  `.retake/jobs/`; history: `.retake/history.jsonl`; `RETAKE_WORKER_IDLE_MS` sets the idle exit.
- A worker keeps the environment of the MCP server that spawned it; `retake jobs` never starts one. A headed
  `auth_login` holds the queue (concurrency 1) until its window closes. `retake run` in a terminal does not go through
  the queue (it can overlap an MCP capture).
- Trust `mcp` rules (engine approvals.ts, core agent-trust.ts, engine protected-hosts.ts, jobs/signing.ts) must
  survive refactors: no `confirm: true`, approvals for shell / destructive hooks, seeds and rollbacks, fingerprints on
  raw hooks + referenced files, HMAC-signed approvals, no secrets refs, no outside files, protected hosts across
  projects. The CLI (trust `author`) is unchanged.
- New job kinds: add them to core `JOB_KINDS` and the worker's exhaustive switch; untrusted text from the filmed product
  goes under `untrusted` in tool results.

Notes from L1.4:
- Run `pnpm build` before `pnpm test`: the signal tests spawn packages/cli/dist/bin.js (they skip without it). The
  gated suites, one at a time: `pnpm test:pg` (≈ 5 s), `pnpm test:slow` (≈ 75 s), the Docker sandboxes (≈ 65 s);
  `node scripts/test-pg.mjs --all` runs everything this Mac can. Run them after any change to the runner, hooks or
  sandbox, and `node scripts/requirements.mjs --untested 1` at every lot end.
- Goldens (runner-web test/golden/) change with Chromium, GPU and fonts: rewrite them only with
  `RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/runner-web/test/look.test.ts`, then look at the PNGs; the
  structural checks carry the assertion.
- `wait_for: {network_idle}` (runner-web network.ts) is re-armed on every call: a page that never goes quiet (long
  polling, a hanging request) now times out and fails the step — and a login step. A response body still open 1 s
  after its headers stops counting. Limit (BL-71): a worker request of an iframe that went away.
- Cancel semantics: a cancel during setup stops a running shell hook (its group), lets an http / sql / js hook end,
  rolls back what ran, then teardown always runs; a second signal SIGKILLs shell hook groups. A cancelled `retake run`
  exits 1 (others: 130) — by design so far.
- Earlier `pnpm test:pg` runs (2026-10-14 / -16) left anonymous Postgres data volumes in Docker (fixed since: `docker
  rm -f -v`); removing them needs the user's OK. `packages/core/test/helpers.ts` `specProjectDir()` leaves tiny
  `$TMPDIR/retake-spec-*` folders (cosmetic).
- The catalogue's two scroll steps take ≈ 0.56 s longer than set (the post-scroll fresh-frame probe, L1.3); the slow
  test allows +1 s.

Notes from L1.8:
- DOCKER: the user runs other compose stacks on this Mac (ports 8025, 1025, 5432, 3000… are theirs). Never stop,
  remove or prune anything not named `retake-*`; no `docker system/volume/image prune`, no `--rmi all`. Gated
  Docker tests (`RETAKE_TEST_DOCKER=1 npx vitest run packages/sandbox/test/compose.test.ts
  packages/cli/test/sandbox-docker.test.ts`, ≈ 75 s) create `retake-test-<run token>-*` resources and sweep only
  their own; they need busybox:1.38.0, postgres:17-alpine and axllent/mailpit:v1.29.4 present.
- Diagnose a sandbox: `retake sandbox status [--json]` / `logs <service>`, then `lsof -nP -iTCP:<port> -sTCP:LISTEN`;
  state in `<project>/.retake/sandbox/<env>/` (state.json, take.lock, seed-journal.json, logs/). Fixture ports:
  process 4501–4504, Docker 4511–4514 + Mailpit 4525 (http://localhost:4525 shows the mails); tests copy the manifests
  to free ports.
- Safety rules that must survive refactors: every sandbox URL is loopback; database URLs refuse `host` / `hostaddr`
  / `port` / `service` / `dbname` query parameters and `pg.Client` gets explicit host and port; a snapshot, a mailbox
  clear or a reseed SQL touches only what the sandbox serves (`servedBy`) unless sandbox.yaml says `external: true`;
  compose commands check the project's folder; `up --wait`'s exit code is never trusted; another container on the same
  port (OrbStack accepts `[::1]` next to `127.0.0.1`) is refused; process identity is pid + start time + boot time.
- Seed shell steps (and hooks on a sandbox env) get the process services' `env` plus `RETAKE_SANDBOX`, layered
  over the CLI's environment — a recipe never touches the developer's own database. Seeds must drop / truncate what
  they create (a seed runs on the data as the last take left it).
- `--sandbox` does not imply a clock: the server writes real timestamps (BL-68). What still differs between takes:
  server timestamps, UUIDs, caches outside Postgres, the first request after a restore.
- A new workspace package: hand-add its importer lines to pnpm-lock.yaml, then `pnpm install --frozen-lockfile
  --offline` (a plain offline install prunes other-platform entries).
- The fixture's Docker image copies the host-built bundle: after a UI change run `node fixtures/wholesale/build.mjs`,
  then `sandbox up --env sandbox-docker --build`. Clean up after use: `sandbox down --env sandbox-docker`, then remove
  the `retake-northfield-fixture-*` images.

Notes from L1.7:
- `ProjectConfig.environments` always holds the real URLs (both forms); settings only in `environment_settings`
  (absent for short-form projects, so their configs are as before L1.7). Code reading project.yaml raw uses
  `rawEnvironments` / `rawEnvironmentPages`. The schema's keyed union (`misplaced`) turns production / access /
  read_only written in the short form into one targeted error.
- Refusal order in hooks `runOne`: prepare (template) → read-only / protected-host check → destructive confirm → dry; a
  refusal never prompts. Journal replays use `ctx.accessOf(entry.env)`; a refused replay stays pending. The runner
  refuses statically (`writingHooks`) before secrets, sessions or the browser; `runOne` stays authoritative.
- The browser guard is armed only when `guardsWrites(policy)`: read-write runs of projects without production /
  read-only environments are byte-for-byte unchanged. Any context route disables Chromium's HTTP cache and pauses every
  request (invisible locally, slower on remote sites). Pages of a guarded context close through `closePage` /
  `unloadPages`, never `page.close()`. A stopped form POST gets 204 and the page stays; mock one with 303 + location.
- On production every host is guarded: a third-party write (analytics, an identity provider) needs an `allow` rule or a
  mock; an identity provider's sign-in page belongs in `login_url` (the sign-in tab is exempt only on sign-in pages).
- Diagnose writes with `timeline.environment.writes` (outcome blocked / mocked / allowed / passed / exempt, `t`, `via`,
  `protected_by`) and the log line "read-only run: writes to … are stopped (N mocks)". Fixture proof of "no change on
  the server": `curl localhost:4402/api/health` → `mutations` (never reset).
- Display URLs are edit-time data: change `display:` in project.yaml and render again (no re-capture). Hidden local
  entries stay in `urls` (the `tutorial-stale-target` check needs them). `drawsUrl` decides the warnings (browser layout
  unless show_url and tabs are off; split / pip only with `chrome`; device and custom layouts draw nothing).
- The product clock patches only `Date` / Intl "now" (runner-web product-clock.ts): shared and service workers keep the
  real date, a dedicated worker's first lines may too; server-made dates are untouched (BL-65). The kit keeps its own
  real timers anyway (kit 1.3.0: never use page globals for timing in kit code, use `RT`). Session checks and the
  automated sign-in always run on real time.
- SQL hooks on read-only environments run in `BEGIN READ ONLY`; Postgres cases need `RETAKE_TEST_PG` (no server
  on the Mac: the classifier is unit-tested, the execution was not).

Notes from L1.6:
- Tests and probes ALWAYS set `RETAKE_HOME` to a temp folder: the real `~/.retake` holds the user's own
  signed-in profile (from L1.5). Never launch a browser on it, never touch the Keychain.
- Sign in the fixture personas for a signed-in capture: start the fixture, then
  `NORTHFIELD_SUPPLIER_PASSWORD=… NORTHFIELD_BUYER_PASSWORD=… retake login northfield-fixture --env signed-in
  --persona supplier --auto` (and `buyer`; values in fixtures/wholesale/README.md), then `run … --env signed-in`.
  Expire sessions with `curl -X POST localhost:4403/api/auth/expire` (`/api/reset` does not touch them).
- The lock check relies on Chromium taking a `SingletonLock`: runs launch with channel chromium (`launchTarget`);
  Playwright's default headless shell takes none. `signIn` waits for the browser pid to exit before copying a master
  (Chromium keeps writing the profile after its lock is gone).
- A run that signed in automatically leaves the stored status `expired` with a warning ("signed in automatically for
  run X") — by design: the master was not refreshed. A sign-in screen shown without a URL change is caught only when
  a step fails (then the check re-runs off camera and the message says the session expired). Tokens kept in
  sessionStorage are lost between runs; rotating refresh tokens are not written back (BL-59).
- Bindings: a tab keeps its opener's persona (film another persona's app on its own page); a page id keeps one persona
  per run; `persona: none` pages and their tabs are never guarded; js hook tabs take the persona their page is filmed
  with. Diagnose: persona debug lines in log.jsonl (copy time, check result), statuses in
  `$RETAKE_HOME/sessions/<project>/<env>/`, leftover copies `$TMPDIR/retake-session-*`.
- A legacy `auth.profile` (persona `default`) never fails the preflight and is now copied per run (rolling refreshes
  are no longer saved back); a missing legacy `storage_state` file still fails the run. The user's own workspace uses
  the legacy form: it keeps working, signed in through the copy.
- Two runs started in the same second get distinct folders (the later one takes the next free second).

Notes from L1.2:
- Kit, cross-realm rule: no `instanceof`, bare `getComputedStyle` or top-realm constructors on elements that may live
  in a frame — `isA`, `styleOf`, `winOf`. Composed order: a host or frame before what it holds, shadow content before
  slotted content; on pages with components or frames, counts / `nth` / `last_visible` include deep matches. Run the
  `embedded` scenario after any kit change touching frames or shadow DOM.
- `topDialog`, `popupState` and the menu / listbox scopes are deep: a visible role=dialog inside a same-origin iframe
  can win `in: dialog` when nothing is `:modal`. `blankAt` refuses points over frames. A move inside a frame reaches
  the overlay one postMessage later per nesting level.
- Never draw contentful overlay content on a new document before the page's own first paint (kit `revealed` gate):
  Chromium counts it as the page's first paint. Diagnose a hold with `timeline.loading` / `tracks[].loading`
  (`until`: paint / load / limit / left / end; `held_frames`): no frame lies in [t_start, t_end). Chromium can stop
  sending frames after a page paints until the next input; the recorder restarts the screencast. Constants: hold.ts
  8 / 40 / 120 ms, 3 s / 0.5 s grace, 10 s limit; kit reveal fallback 10 s.
- Timing shift: a navigation's paint wait is inside the click (or the step that navigated) — a `wait_for` right after
  it waits ≈ 0 s, so fewer wait-based raw cuts and less wait compression; the held-load cut replaces them. In a
  multi-page scene no step starts while any of its pages is held; a page's held load is cut only beside the other
  pages' inactivity. Known gaps (R-ISS-08): an iframe's own navigation is not held, an app's loading UI after its first
  paint is not (use `wait_for`), a navigation whose request starts after the step returns is awaited at the next step.
- Secrets: every `{{env:…}}` / `{{keychain:…}}` is a secret; values the video may show go in `vars` (literal values:
  a token inside a `vars` value is refused until BL-56). A new timeline or RunRecord string field must be added to the
  path policy in runner-web/src/secrets.ts, or it is redacted. Grep the run folder for a value to check; captured
  email artefacts keep theirs by design. No real Keychain item was used in a step (agents cannot write to the
  Keychain): the user can try one with `security add-generic-password` and a `{{keychain:…}}` step.
- js hooks run in their own guarded tab per page key (not in `session.pages`, never recorded): scenes must `open`
  their page; sessionStorage and page state do not carry over; teardown js hooks do not see the last page. New
  `context.on('page')` / `context.route` code (L1.7) must ignore `session.hookPages`. Shell hooks: a variable in a host
  position after `source`, `read`, `for` or `eval` of computed text is refused as computed; an ssh alias is checked as
  written (list it in `allow_hosts`). Refusals say how the host was reached and name hosts, never URLs.
- `park` is opt-in per step; the change record (MutationObserver, top document, last 500 elements) runs only when a
  step of the scenario parks. `type` without `cps` adapts its rate (fixture scenarios all set `cps`). `date`: English
  and ISO days, the native `input[type=date]` path, no time of day; `kit.calendar()` lists the days it reads.
  `menuTrigger` returns `{ref, hover}`. Kit VERSION 1.2.0.
- Disk: `keep_frames` defaults to true and a capture keeps ≈ 300–400 MB of JPEGs; the Mac's disk filled up during
  L1.2 (29 GB of runs) and the frames of the 2026-10-12/13 runs were deleted with the user's OK. Prune `runs/*/frames`
  now and then.

Notes from L1.3:
- Heavy background work (another project's tests, Spotlight, updaters: load averages of 15–27 seen) slows a capture
  (the catalogue took 1 m 37 s instead of 1 m 12 s) and its motion; the run warns when the capture froze ≥ 150 ms.
  Capture on a quiet machine when it matters.
- A "click ripple" freeze of ≈ 0.26 s at a dialog close is R-ISS-12 (blurred overlay going away). For a capture that
  matters: `browser: {frame_rate_limit: false}` in the project or scenario — check the page's own animations look
  right (rAF unthrottled) and expect 2–6× the CPU.
- Diagnose a stall: `motionCapture` on the run's frames.jsonl + timeline.json (run warnings list them); a frame gap with
  no page long task and steady rAF is Chromium's frame production, not the page's JavaScript.

Notes from L1.5 (the Mac):
- Runs of the pass (git-ignored, on the Mac): catalogue `20261012-181152-catalogue`, quote `20261012-181304-quote`
  (both captured while the user worked), `20261012-181929-quote` (`--headed`), `20261012-182250-quote` (`--raw --cursor
  layer --format prores --fps 60` → `exports/20261012-182250-quote-raw-prores60-layer/`, validated). The step-7 frame
  analyses (tables, crops, scripts) stayed in the session scratchpad; the numbers are in the checklist results and the
  requirements' evidence.
- A capture with `--cursor layer` (or `none`) hides the cursor, so the screen does not change while it moves: fewer
  screencast frames (825 vs 1538 for quote) and no fps check — expected.
- The runner's motion fps (`motionCapture`) averages a move with the rest before its click (the cursor dispatch rate
  caps it near 30–40 fps on the Mac); the motion itself runs at ≈ 60 frames/s. Stalls hide in that average (R-ISS-13).
- Agents may not write to the macOS Keychain (the harness refuses `security add-generic-password`): the user runs that
  line of checklist step 10 themselves.
- Full-suite load (all test files in parallel, many Chromium) once delayed a fixture dialog past `after_click_ms` and
  failed the e2e `popup_opened` assertion (R-MAC-08). Since L5.1 the next step waits up to `popup_timeout_ms` after
  the press for such a late popup (`settleLatePopup`); a failure there now means the dialog took longer than that —
  rerun the file alone before suspecting the runner.
- OpenTimelineIO 0.18.1 does not load on Python 3.14 (`bad any cast`): `~/.venvs/otio` is made with Homebrew's
  `python3.13` on the Mac.

Notes from L2.14:
- Plan markers: `frame` = the marked step's start (the timeline marker, DESIGN §timeline — the raw export's mark
  markers too), `done` = the screen once the step is done. Use `done` when you need "the moment the mark names".
- The composition draws nothing of its own except the theme background and the brand mark (R-CMP-01, DESIGN-phase2
  §2.2); `render-units.test.ts` fails on a colour literal in `src/remotion/`. A new visual = a component.
- To show what a switch changed, review against an explicit render: `retake review <project> <render> --previous
  <id>` (the default previous is the scenario's latest earlier render).
- The CLI switches only the layout (`--frame <style|layout id>`) and the theme (`--theme`); other kinds go through
  `renderVideo({overrides: {components: {...}}})` until L3.2 (MCP) / L4.5 (timeline UI).
- Motion theme + project `frame: card`: an empty caption block stays under the card (BL-54).
- Reproduce the raw validation: `scripts/validate-raw.py` (see README "Raw export for editors").

Notes from L2.13 (raw export):
- The raw export lives in runner-web (`src/raw/`): capture-side (frames, CFR schedule, the kit's look). Its CLI is
  `packages/cli/src/commands/export-capture.ts` (+ `run --raw`). Real imports into Final Cut Pro / Premiere / Resolve
  are R-RAW-06 (Mac, MACOS-CHECKLIST step 12).
- Encoding speed here (4 CPUs, no hardware encoder): MP4 30 fps ≈ 30–40 s per minute of clips; ProRes 422 HQ
  (prores_ks) ≈ 17 fps → ≈ 3 min for 50 s at 60 fps; layers (prores_aw 4444) ≈ 90 fps. VideoToolbox on the Mac would be
  much faster (not wired: the brief names prores_ks; BACKLOG open decision on encoders).
- Runs before L2.13 have no `cursor_effects`: their cursor data / layers use approximated icons, presses and ripples
  (hand over a running step's clickable target); new runs record what the kit drew. A run captured without the cursor
  renders with a plan warning (no cursor in the edited video) — use it for raw exports only.
- Loading cuts only follow wait steps that really waited (≥ 0.3 s); a load the scenario does not wait for stays in the
  clip at real time (the editor's 4× wait speed-up is edit-only). Marked waits keep their moment; `--no-cuts` keeps
  everything; cut markers (magenta) show where the jump cuts are. A cut starts after the step's last recorded press
  (`actionMoment`); an action that runs past what it records (drag, repeated keys, typing in runs before `t_typed`)
  is kept whole. A scene whose last step is a long wait keeps its loading (a note asks for a `hold`): the result after
  it was never filmed in that scene. No fixture run has a type / select right before a long wait — the checks used
  edited copies of real runs (scratch) and unit cases.
- WebM cursor layers are for web players and ffmpeg tools: no timecode (OTIO from 0, not in the FCPXML), alpha only
  through libvpx-vp9 in ffmpeg. Editing tools want `--layer prores` (the default). Whether Resolve takes the WebM
  layers from the OTIO is an optional MACOS-CHECKLIST step 12 item.
- `retake run --raw --json`: RunProgress lines, then `{"type":"raw_export","dir","manifest"}`; `export-capture
  --json` prints the manifest as one document.
- Interchange files reference the clips by absolute path (relink after moving the folder). The EDL has one picture
  track: other pages and layers are in the FCPXML / OTIO only. Clips of different sizes in one sequence (a phone page
  on the sequence of a multi-page scene) skip the selects file with a warning; FCPXML gives each size its own format.
- `exportCapture` refuses to replace a folder that is not empty and not an earlier raw package (`--out` safety).

Notes from L2.12 for L2.13 (kept for reference):
- The run already has what a raw export needs: `capture.mp4` (+ `capture-<page>.mp4` per page of a multi-page scene),
  the CFR frame grid, `timeline.json` (scenes, events with t_start / t_end, markers, cursor samples, clicks with
  target boxes, page segments, idle) — the planner's source ranges (`ClipSegment.source` / `srcFrames`) cut page
  loads; a per-scene clip = the scene's source range (opening still → scene end) without the edit's speed changes.
- Waits now play faster in the edit (R-OWN-05): a raw export should keep real time (1×) — the editor's job.
- User files (`studio/media`, `studio/lottie`) belong to the edit, not to the capture: a raw export can list them in
  its manifest (`planFileRefs`, `themeFileRefs`) so an editor can re-use them.
- The composition bundle's hash covers `COMPOSITION_DEPS` (editor files the composition imports besides
  `remotion/`): add any new module the composition imports (a Lottie player…), or a stale bundle is reused.
- `ClipSegment` stays capture-based; multi-page clips add `panes` / `acting` / `inset`. Overlays carry `pane`;
  `overlayRects` / `mapUseRect` / `useScreen` route them (`staysInInset`: an inset's spotlight and badges stay in it,
  its other free-standing overlays use the main page's room — decide for a new overlay kind, e.g. a Lottie callout).
  An overlay video with alpha drawn over a PiP main page should be clipped around the inset like the others
  (`insetHole`); a `clear` entry may carry the `pane` its box belongs to.
- The reframe changed for every vertical / square plan (leading part of wide targets, leading-edge start, no pan for a
  resting cursor, `settle` for idle panes): earlier vertical / square renders of other scenarios (quote-v9-vertical,
  signup-v8-vertical, catalogue exports) would frame differently if re-rendered — not re-rendered here.
- Known limits of L2.12: ffprobe on PATH (or `$RETAKE_FFPROBE`) is needed to check and plan video files (without
  it: a validation warning and the file is planned as unreadable); GIF and dotLottie (`.lottie`) are not read (the
  validation says how to convert); a Lottie with external images or expressions is drawn as `lottie-web` can (warning
  for external images); an overlay file is clipped to the capture screen (never over the caption or the frame); an
  overlay video plays its own length (the fixture's burst outlives the closing dialog by ≈ 0.6 s — 18 frames: the
  dialog closes at frame 892 of own-media-v6, the burst runs 874–909; `duration` shortens it — cut, not faded); a file
  at a screen position picks its corner once for its whole span (it does not move while it shows) and `center` never
  moves (a note when it covers a target); `fit: auto` uses an 80 % threshold (a 4:3 image in a 16:9 video is
  contained; write `fit: cover`); the 4-frame ramps of a file's sound are steps per frame (Remotion's volume is per
  frame) — far below a click (sample jumps 0.0039 at the intro's end vs 0.037 in its chime); renders and reviews made
  before `encoding.audio: files` say `silent` / `music` for videos with an intro's own sound.
- A `wait_for` records no box for what it waited for, so the vertical / square reframe does not aim at it: in
  own-media-v8-vertical the "Quote request sent" toast at the page's bottom-right is cut by the crop's right edge
  during the send scene's last second (it was cut in v5-vertical too; a little more now, because the reframe keeps the
  whole burst in view while it plays). Recording the awaited element's box (runner) and making it a soft reframe
  target would fix it — a candidate for L2.14 or the backlog.
- The overlay keep of the reframe changed for every vertical / square plan with a step overlay (its real start and
  length, its real box): earlier vertical / square renders with callouts (quote-v9-vertical, quote-v10-square) would
  frame slightly differently if re-rendered — not re-rendered here.
- Known limits (L2.11): two pages per scene (`MAX_SCENE_PAGES`); a step badge outlives a target that disappears right after
  its click without a URL change (a closing dialog) by ≈ 1 s (after a navigating click it leaves with the page, the
  spotlight fades within 0.45 s); "leading" means top-left (left-to-right pages); in a stacked vertical split a click
  at a page's far right still cuts the page's left edge (the crop keeps ≥ 0.9 design px per CSS px) — the idle pane
  settles back afterwards; a motion PiP whose caption band is over the screen does not grow its inset (no room); the
  caption band in a split's caption area is centred in that area (not the frame); an idle page's cursor rests near its
  centre whatever the layout; renders killed mid-way leave `renders/.<id>.lock` (removed by hand once here).
- The fixture's shop polls its notifications every second now (the bell rings live): a scenario that expects the bell
  to change only on reload (none here) would see it earlier.

Carried over (from L2.10 notes, still true):
- `capture_text` reads the kit's `visibleText` (innerText, whitespace collapsed): inline children without spaces come
  out joined (the fixture's total reads "€465.00incl. VAT"; the pattern picks the value).
- Preview samples: `scripts/preview-frame-samples.mjs` (needs the fixture running) writes the before/after sample
  frames; `preview/samples.json` has a sample `field` box (manifest `preview.target: field`).
- Dependencies added by L2.10: `qrcode@1.5.4` as a devDependency of components (tests only; the encoder is the kit's).
- Carried over: capture under dialogs is slow (backdrop blur; L1.3); `download` of a file that is neither a PDF nor an
  image keeps the file with a warning; `mail-view` shows the captured `date` unless the
  slot stages one; components drawn over the capture (notification banners) are not known to the reframe;
  `preview.json.source_hash` does not cover the kit (`components preview --all` after a kit change that alters a
  look); still open from L2.8: caption bands over a reframed capture with `layout-raw`, the reframe release jolt
  (≈ 1 %/frame², under the 1.5 % threshold), 4K export ≈ 4× the 1080p time, the interstitial caption fade.
- The fixture videos are ≈ 45–48 s: `video-length` info (the reference look targets 60–120 s, 25 % tolerance); the
  L2.11 ones (31–44 s) get the `video-length` warning — short on purpose (brief: < 60 s each).

## Decisions (do not re-litigate)
- The tool stays generic: no client/brand/person names anywhere in the repo or its history (history was squashed for
  this). Customer material lives in the user's own workspace (`RETAKE_ROOT` or a `retake.yaml`).
- Everything visual in the edit is a **component** (plugin) with a manifest; themes (templates) give tokens and pick
  components; workspace components can be created by Claude through a skill; a cloud marketplace comes in V2.
- **Frame comments** are stored as files in the workspace and exposed to Claude through MCP; anchored to the render
  frame and to the scenario (scene/step/segment/component) via the edit plan's provenance.
- **Studio app**: web UI first (`retake ui`), Tauri macOS shell later around the same UI; scenario shown as blocks /
  cards / badges, two-way with YAML; timeline with live Remotion Player preview and one-click component switching;
  Run and Record screens as in the canvas.
- Backlog lives **only in the repo** (no Linear). Small lots; each lot is committed and pushed; consumption reported.
- (History) The user allowed force-pushes on the cloud working branch `claude/new-session-pq6jtq` to squash WIP
  checkpoints into one commit per phase / lot. On `main`, ask before rewriting history.
- App UI language: English. Conversation with the user: French.

- (2026-10-11) Autonomy granted through the end of phase 4 — superseded on 2026-10-12: autonomy through phase 2 in the
  cloud, then the user decides how many lots to chain (ROADMAP working agreement).
- (2026-10-11) Phase 2 now ends with L2.9 mails/notifications/documents, L2.10 tutorial overlays & story cards,
  L2.11 multi-page capture (split screen, picture in picture), L2.12 acceptance (see ROADMAP). Backlog for the
  marketplace: terminal, code, chat/SMS, Dynamic Island, calendar, sounds, webcam, SRT subtitles.
- (2026-10-11) Theme `motion.default_zoom` (L2.8): only for style_bias balanced/motion — at most one slow zoom per
  scene on a marked step target, never across a cut; `real` keeps a static camera.
- (2026-10-11, L2.6) Review severities for the look targets: video length outside 1–2 min = **info** within ±25 %
  (45–150 s), warning beyond (the range is a style target measured on two reference videos, not a defect: the 59 s /
  56 s fixtures are fine); scenes outside 4–25 s = info, < 2 s = warning; more than one zoom per video = warning, a zoom
  that is not "very slow" = info. Thresholds live in `DEFAULT_RULES` and can be overridden per call (`rules`).
- Risk to review before V2: Remotion's licence for a redistributed commercial tool (keep the renderer swappable
  behind the EditPlan/component contract).

- (2026-10-12) **Architecture: local-first, desktop-first, flat files** — see docs/ARCHITECTURE.md (ADR-1, ADR-2).
  V1 stays simple: no server-side capture/render; full cloud later, outside this development phase.
- (2026-10-12, L2.14) **Phase 2 done; the work moves to the Mac.** At the end of L2.14 the work is pushed to a new
  `main` branch (no pull request); local Claude Code sessions clone / pull `main` and commit each lot there. The user
  writes in French and gets answers in French; the repository stays in English.

## Conventions
- TypeScript ESM/NodeNext, relative imports end in `.js`; `pnpm build` (= `tsc -b`), `pnpm test` (= `vitest run`;
  `vitest.config.ts` aliases `@retake/*` to `src/`). No new dependencies without a strong reason.
- Commit messages end with the session attribution lines given by the harness. Never commit `runs/`, `renders/`,
  `review/`, frames or videos (git-ignored).
- At the end of a lot: update `docs/requirements.json` (status/evidence/gap), run `node scripts/requirements.mjs`,
  update this file and ROADMAP's status table, commit on `main`, push, report.
- `docs/BACKLOG.md` is maintained by hand (new ideas get the next `BL-` id; nothing there is scheduled).
- Helpers live in the repo (`scripts/`): nothing a later session needs may stay in a scratch folder.

## Environment
On the Mac: see "Mac setup" above (Homebrew ffmpeg, playwright-core's Chromium and headless shell in
`~/Library/Caches/ms-playwright/`, no environment variable needed). The user's Mac (L1.5): Apple M4, 10 cores, 24 GB,
macOS 26.6.2, Node 22.16 pinned in the repository folder by mise (an untracked `mise.toml`; Node 10 elsewhere), pnpm
10.28, ffmpeg 9.0.2, Chromium 141 (+ a newer playwright build in the cache, unused), Python 3.14 by default (3.13 from
Homebrew for OpenTimelineIO), no Final Cut Pro / Premiere Pro / DaVinci Resolve. Full test suite ≈ 2.5 min.

### Cloud container (Linux) — specific to the cloud sessions of phases 1–2
- Chromium 141 via playwright-core 1.56.1 (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); new headless
  (`channel: 'chromium'`). Remotion renders with
  `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` (found through playwright-core's
  registry; `$RETAKE_CHROMIUM_HEADLESS_SHELL` overrides).
- ffmpeg 6.1 on PATH. Postgres 16 installed (`pg_ctlcluster 16 main start`, run as the postgres user).
- No GPU: pages with heavy effects (backdrop blur) are captured at 6–10 fps during cursor motion (L1.3). No display and
  no macOS: login, `--headed`, Keychain and notifications are verified by the user on a Mac (L1.5).
- Python 3.13 without OpenTimelineIO: the raw validation used a scratch venv (`pip install opentimelineio
  otio-cmx3600-adapter otio-fcpx-xml-adapter`).
- Fixture: `node fixtures/wholesale/server.mjs` (console :4401, shop :4402), then
  `node packages/cli/dist/bin.js run northfield-fixture catalogue` (add `--dry` for a rehearsal).
