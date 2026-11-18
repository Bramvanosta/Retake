# Handoff — read this first in a new session

**Retake was called Demo Studio before L5.13** (command `studio`, home `~/.demo-studio`, workspace file `studio.yaml`, variables `DEMO_STUDIO_*`): every name in this file is the current one — entries written before L5.13 were rewritten mechanically by the rename's one-off script (removed in v0.2.1), so commands of earlier runs read `retake …`. <!-- old-name: the history line -->

Last updated: 2026-11-23, **BL-192** (Playwright 1.65.1 and the app's downloaded Tools, a pull request against
`main`); before it 2026-11-17, L8.4 and **L5.3**; **v0.3.0** (the L8 chain, lots L8.1 – L8.3, on `main` since pull request 20;
this file is cut to what is true now, the history moved, verbatim, to
[archive/HANDOFF-history.md](archive/HANDOFF-history.md): the states of every lot before L7.58, the hotfix notes
v0.2.1 – v0.2.6, the lot log, the evidence per lot, the notes per lot and the trust rules in them, the cloud
container, the earlier heads of this file — under their original headings, so a reference such as HANDOFF "State
(after L7.1)" is found there).

## Where things stand
- **Phases 1 – 4 are done** (phases 3 – 4 pending the user's live runs, MACOS-CHECKLIST 12c – 12j and 13a – 13j);
  **phase 5 is under way** (L5.1, L5.2, L5.2b, L5.3, L5.5 – L5.18 done: the « Épure » Studio, the name Retake, the standalone
  app and its releases, captures first, renders on the GPU, the two hardening lots, the iOS Simulator runner). The architecture series
  (L6.1 – L6.13, L7.1 – L7.58) is on `main` since 2026-11-15; the **L8 chain** answers the second field feedback
  ([FIELD-FEEDBACK-2.md](FIELD-FEEDBACK-2.md): L8.1, L8.1b, L8.2, L8.2b) and finishes the app's native menus (L8.3).
  The MVP scope is locked to the ROADMAP's lots; new ideas go to `docs/BACKLOG.md`.
- **Releases** are tagged on `main` (`vX.Y.Z` → `.github/workflows/release.yml`, `docs/RELEASING.md`): v0.2.0, the
  hotfixes v0.2.1 – v0.2.6 (their notes are in the archive), then v0.3.0 on 2026-11-16: the architecture series,
  the Studio's large-screen pass, the native menu bar and the L8 chain (on Playwright 1.56.1). BL-192 brings
  playwright-core 1.65.1 and the app's Tools ("State (after BL-192)"): the next release is the first without a browser
  in the DMG.
- **Branches.** `main`: the releases, the architecture series (fast-forwarded on 2026-11-15: pull request 8 merged,
  pull request 9 closed with nothing left to merge), the Studio's large-screen pass (`0131be7d`) and the native menu
  bar (`053baebc`), both 2026-11-15. Then the L8 chain, one commit per lot (pull request 20, 2026-11-16).
  `claude/bl-192-playwright-b161b7`: BL-192, one commit, its pull request open (not merged, no tag).
  The branches of merged pull requests are deleted, locally and on `origin`.
- **Guards** (each in the CI's `checks` job, `.github/workflows/ci.yml`): `pnpm build`, the test files' type check
  (`tsconfig.test.json`), `node scripts/audit/rules.mjs . --check` (the import-rules ratchet),
  `node scripts/audit/size-limits.mjs --check` (the size ratchet), `node scripts/requirements.mjs --untested 1` and
  `--check-cites`, `node scripts/set-version.mjs --check`, `pnpm lint` (Biome's linter held to
  `scripts/lint-baseline.json`), then `pnpm test:ci` (the deterministic tier of the tests, `scripts/test-ci.json`); a
  weekly run of that tier in a shuffled order (`.github/workflows/shuffled.yml`). Not in the CI: `pnpm format:check`
  (`pnpm format` writes), `node scripts/test-guard.mjs` for migrated tests, and the full suite and the gated tests (on
  the Mac).

## Next steps
1. **BL-192's pull request**: the person reviews and merges it, then checks MACOS-CHECKLIST §22 by hand (the first
   real download from the publishers, a signed and notarised release's Tools step). The next release re-records
   `apps/desktop/bundle/tools.json` (RELEASING step 1).
2. **The two open Homebrew pull requests** (4 and 7) do the same job: one should land, the other be closed.
3. **The person's hand checks** (MACOS-CHECKLIST): the L8 chain's below (14h, §18 – §20 and the L8 notes' "left for the
   person"), then the older live runs under "Pending for the person".
4. **L5.3 is done** (below, "State (after L5.3)"), pending its pull request's merge; **L5.4** (the phase-5 acceptance)
   only when the person asks. Also open, when the person asks: the 2026-11-04 plan's T15 rest and T16
   (the measured snapshot, `scripts/audit/snapshot.mjs` against `docs/audit/2026-11-04/summary.json`), and the desktop
   bundle's staging of stale `dist` outputs (until it is decided, `rm -rf packages/*/dist && pnpm build` before a
   bundle).
5. One lot at a time; the user (in French) decides how many — see `CLAUDE.md`.

## Pending for the person
- The L8 chain's hand checks: the menus (MACOS-CHECKLIST 14h), one real font fetch from the npm registry (§20: the
  fontsource package layout is an unverified assumption), a real variable font at two weights and a real wide logo in a
  full render (L8.1), a real design-token export through `retake theme from-tokens` (L8.1b), one live take on a real
  Firebase Auth emulator after a reset and `packages/cli/test/sandbox-docker.test.ts` with a `node:22-alpine` image
  (L8.2, §18: neither was run), `retake env` and a real single-page app's route that loads (L8.2b, §19).
- The live runs (MACOS-CHECKLIST 8b, 10b, 12b, 12c – 12j, 13a; 13d: the field project with a sandbox, a hook step and
  compact results through Claude Code) and the open questions, gathered in one test document outside the repository.
- R-PRJ-02's wording (SPEC §3 vs ADR-2: the queue stays in files, the index holds a view); the open questions Q1 (first
  buyer) and Q2 (L4.7 scope).
- Open phase-1 items: R-ISS-02 and R-ISS-12 (known capture limits, L1.3) and R-RAW-06 (an import into an editing tool,
  L1.5).

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
   `packages/core/src/types/<context>.ts`, `packages/components/src/types.ts`, `packages/editor/src/plan-types.ts`.
5. References: `docs/reference/look.md` (measured target look), `docs/reference/choreography.md` (field-tested
   cursor/click/typing rules), `docs/design-brief.md` + the mock-up canvas (Studio screens 1–7 and video frames in two
   themes): https://claude.ai/artifact/CEa9o9do5hr9AcLBajLRye (private to the owner).
6. `README.md` — the front page; `docs/guide/` — usage, scenario language reference, CLI (the README's reference
   sections since 2026-11-04; `docs/guide/README.md` maps an old "README › section" note to its page).
7. `docs/BACKLOG.md` — everything outside the locked MVP (unprioritised), guard-rails to apply when L1.2–L5.2
   start, recorder precisions for L3.4/L4.8, open decisions; **maintained by hand** from now on (the scratch files of its
   first version are not in the repo: edit it directly, the next free id one above the file's highest); `docs/COMPETITION.md` — competitive study
   (2026-10-12).
8. `docs/ACCEPTANCE-phase2.md` — the phase-2 acceptance (renders, reviews, the theme / component switch, R-CMP-01
   audit, own media, raw export validation).

## Lots since the cut
Each lot adds its "State (after <lot>)" section here, above the previous one: newest first (the lead's register helper
inserts it above the first such heading). When this part holds more than a few lots, move the older sections verbatim to
the archive, above its newest "State (after …)" section (L7.57b's since 2026-11-16).

## State (after BL-192)
- **BL-192 done (2026-11-18; branch `claude/bl-192-playwright-b161b7`, a pull request against `main`, not merged)** —
  playwright-core 1.56.1 → 1.65.1 in ui, runner-web, editor and fixtures/wholesale (Chrome for Testing 159.0.8154.6,
  revision 1255).
  - **Licence.** Chrome for Testing's terms give no right to redistribute it, and Playwright ≥ 1.57 builds no Chromium
    of its own. Decision (the person): the app no longer ships the browser, the render shell or Remotion's compositor.
    They are its **Tools**, downloaded on the person's click from their publishers (storage.googleapis.com,
    registry.npmjs.org) into `<Retake home>/tools/`, each archive checked against `apps/desktop/bundle/tools.json`
    (replaces browsers.json; `bundle.mjs record-tools --from`, `check-tools --fetch` in release.yml). DESIGN §4p (f),
    RELEASING step 1.
  - **Product.** core `io/tools.ts`; engine `tools/*` (installer: host allow-list, ≤ 3 checked redirects, sha256
    before extraction, our own archive listing check, read-only trees, atomic rename, a lock; prune after a new
    version's first start, 30-day start records); the queue holds a job that needs a missing Tool (`held_by: 'tools'`,
    a project with its own browser needs none) and wakes on install; `retake tools`, doctor's Tools / Compositor
    lines, `engine_info.tools`; the Studio's Set-up item, status bar, Welcome card and Tools page (the approved
    8-screen mockup); the updater downloads a new version's Tools before its restart (`update_tools`). The DMG went from
    422 MB to ≈ 203 MB; the download is 315 MB, ≈ 620 MB on disk.
  - **Playwright 1.65 changes met.** The registry read through `playwright-core/lib/coreBundle` (fail closed when it
    moves); `--enable-automation` re-added; screencast frames stamped in the future (`frameWall = min(stamp,
    arrival)`); unload keepalive requests no longer reported to `page.on('request')`; CfT plays H.264 (the Studio
    tests stub it). Two bugs found by the final runs: Chrome 159 never releases `Response.blob()` bodies (renders
    failed on a nearly full disk; workaround `editor remotion/response-blob.ts`, BL-201), and the recorder lost a
    wheel scroll from rest (its baseline read after Chromium scrolled; `scrollTrail`, a bug from before the lot). Also
    the bundle cache's prune race (`BUNDLE_IN_USE_MS`), and a race of studio-e2e-comments' console check (a removed
    preview frame's last font fetch answered 404 after `timeline_leave`, reported by Chrome as a CORS error; the same
    on Chromium 1194): `ui/test/console-errors.ts` excuses only that case. The other e2e files that frame the preview
    and assert no console error can adopt it if they flake.
  - **Runs (2026-11-18, the final tree).** `pnpm build`, lint, typecheck, the ratchets and `--check-cites` green; the
    full suite (one intermittent failure of worker-heavy's exit-3 approvals case under load: 23 runs of it alone or in
    parallel green, its message now says the job's state). The last full run: 7375 passed, 1 failed —
    network-guard's leak check counted a render browser another file started at the same time; it now counts only
    this process's descendants (the file green alone 4 times); `pnpm test:slow` 65/65 (three runs in a row
    before); the gated bundle acceptance 11/11 (an ad hoc `desktop:bundle` built and run, Tools installed from local
    archives), the update e2e 3/3, app-release-sign 30/30.
  - **Left.** BL-194 – BL-201 (Spotlight/Time Machine, managed Macs, the worker's in-use record, the Tools' terms in
    the app, the update sheet's list, a menu item, proxies, the blob workaround); headed windows show Chrome's
    automation infobar (review B-M2). Open for the person: the publisher names "Google" and "Remotion" in tools.json and
    the notices (licence attribution, like `apps/desktop/licenses/`), the release `sign` job's import guard loosened
    for the Tools' checks, and MACOS-CHECKLIST §22 (a real download, a managed Mac, an update with new Tools).

## State (after L8.4)
- **L8.4 done (2026-11-17; branch `claude/fb-30-build-secrets-aaf6fb`, a pull request against `main`)** — a
  docker-compose sandbox's build secrets (field feedback 2, point 30: an image installing a private package failed
  from `sandbox_up` over MCP, the job's docker having none of the shell's tokens, docker compose passing the secret
  empty without a word, the error cut at `exit code: 1):`).
  - sandbox.yaml `compose.secrets: {NAME: "{{keychain:…}}" | "{{env:…}}" | false}` (core schema, types, checks:
    one reference or `false` per name; loader variables, the settings of docker / buildx / BuildKit / compose / SSH /
    XDG and the system's own names refused; a name the env file sets refused; a name no compose secret reads warned).
  - sandbox `build-secrets.ts`, run by `up` after `config`: a name must be read by a service's `build.secrets`, never
    mounted by a running container, and placed nowhere else — `config` is read once more with a marker value per name
    (a container's `environment`, a build argument, any `${NAME}` refuse). The services the up builds (`--build`,
    `pull_policy: build`, a missing image — docker compose builds a `never` one too, probed) give the variables needed;
    only those references are resolved; each must be non-empty for docker compose (declared, env file, inherited) and
    at least 3 characters, else refused before anything starts, the message leading with the keychain (and, for a
    job, `RETAKE_WORKER_KEEP_ENV`), one hint a line. The values go in the environment of the `up` command alone;
    `BUILDKIT_PROGRESS=plain` on a building up; every line (compose-up.log, debug, live note) and every message of
    the up masked; the failing BuildKit step's last lines (`failedBuildStep`, 15) end the message, after the services'
    list; `compose-up.log` rotated to `.1`.
  - Engine `worker-env.ts`: `RETAKE_WORKER_KEEP_ENV` (the client's environment: the person's profile) keeps the dropped
    names it lists, never a loader variable nor `RETAKE_MCP_TOKEN`. MCP `sandbox_up`'s text says where a build secret
    comes from (tool-list golden rewritten).
  - Probed on this Mac (OrbStack, compose 5.5.0): an unset or empty secret variable is passed empty silently; the env
    file feeds secrets; `config --format json` lists `secrets.<id>.environment` and fills a bare `environment:` /
    `build.args` entry from the environment; a changed secret does not invalidate BuildKit's cache; `pull_policy:
    never` is built under `--build` and when the image is missing; the error line the field saw is `failure()`'s
    `head:` after `exit code: 1)`.
  - Acceptance: a real jobs worker through `createEngine` as an MCP client (refused without the keep list, built with
    it, the token in no file of the workspace) and `packages/sandbox/test/build-secrets-docker.test.ts`
    (`RETAKE_TEST_DOCKER=1`, busybox). Requirement R-SBX-14; mutations 19, all caught. Plan, critique and the two
    reviews: their findings all fixed (the leaks a bare `environment:` / `build.args` / runtime mount would open, the
    `never` pull policy, optional secrets, the long messages, the keep list's reach written down).
  - Left for the person: MACOS-CHECKLIST §21 (the keychain from the Studio and the app opened from the Finder,
    `{{env:}}` with the keep list through Claude, a real private registry's 401 in the message).

## State (after FB-31)
- **FB-31 done (2026-11-17; branch `claude/fb-31-tmpfs-78a094`, a pull request, not merged; lot or hotfix not
  decided)** — a sandbox database kept in memory (field feedback 2, point 31: `tmpfs:` on Postgres's data folder, no
  volume). Docker lists no tmpfs in `.Mounts`, so `down` (even `--volumes`) counted the database as kept and left its
  seed in the state; the product loaded data at its own start-up, so the next `up` refused and proposed
  `down --volumes`, which changed nothing.
  - Where the data lives: compose-parse `dataLocation` reads `docker inspect` whole — the deepest mount over the
    container's `PGDATA` (else the official image's folder; Postgres 18's `/var/lib/postgresql/18/docker` read right; a
    tmpfs wins a tie), `HostConfig.Tmpfs` and `type: tmpfs` mounts; nothing over a declared `PGDATA` is the container's
    own layer; a custom image without `PGDATA` is read as before. `DataStorage` kinds `tmpfs`, `container`;
    `goesWithDown` adds an anonymous volume (probed: compose leaves it behind at `down`, the next `up` makes a new one —
    the official image with no volume named loses its data at every `down` too).
  - `down`: a tmpfs forgets the seed, last reset, `unseeded_at` and the snapshot, base and cluster records at once
    (`DownResult.forgotten`); the container's own layer and an anonymous volume (a reading of settings) do so only when
    no cluster is recorded yet, else the next reset's cluster check decides. `retake sandbox down --forget` forgets them
    for any sandbox (nothing deleted). CLI only: no MCP tool stops a sandbox.
  - The cluster: `SnapshotPort.clusterId` (`pg_control_system().system_identifier`, readable by any role), recorded as
    `provider_state.cluster` after each reset. Another cluster under the sandbox makes the reset forget the old seed and
    snapshot: where the data lives with the container, the database is fresh whatever it holds (a first seed and a
    base); elsewhere (a named volume: a dump restored) the last reset is kept, so only an empty database is fresh and
    one holding data is refused (review A's finding). `up` seeds for it (`its Postgres is a new cluster`);
    `sandbox status` runs the same plan with the records forgotten (`new_cluster`, `storage`).
  - The refusal's command follows where the data lives: `--volumes` for a volume of the sandbox, a plain `down` for a
    tmpfs or the container's own layer, `down --volumes --forget` when it cannot be read (and what `--forget` alone does).
  - Not done: `reset.snapshot.ephemeral` (proposed in the notes) — the cluster identity tells the same thing without a
    key, and `--forget` covers what it cannot see. Requirement R-SBX-13 (lot label `FB-31`, to rename once decided).
  - Method: two reviews (A: safety — a new cluster trusted unconditionally, the container reading, anonymous volumes,
    the `--forget` wording; B: the façade's status type, a CLI case for `--forget`, the `down` lines, a tmpfs tie,
    missing cases), all fixed with tests; 7 mutations, all caught (no tmpfs forget, no forget on a new cluster, a new
    cluster always fresh, the container forgotten despite a cluster, `HostConfig.Tmpfs` ignored, no container layer,
    the cluster not recorded).
  - Tests: reset-order (8 new), compose-units (`dataLocation`), sandbox-words, operations-cli (`down --forget`, golden
    regenerated); Docker `compose.test.ts` with a new tmpfs case (initdb loads a table on every new data folder: down,
    up, then the database restarted under the running sandbox). The FB-30 branch also touches `compose-parse.ts` and
    `compose.ts`: expect a merge there.

## State (after L5.3)
- **The iOS Simulator runner** (`packages/runner-ios`, guide [guide/ios.md](guide/ios.md)): a project environment
  `ios: {app, device, schemes}` picked with `env:`; a dedicated device "Retake - <type> - <runtime>" (en-US, QWERTY,
  booted headless, status bar 9:41, a lock per device machine-wide); an XCUITest driver built from the repo
  (`packages/runner-ios/driver`, built once per Xcode into `<RETAKE_HOME>/ios-driver/`), on 127.0.0.1 with a per-run
  token proved by HMAC, deadlines per command and an idle quit; existing steps reused (click = tap, scroll = swipe,
  open = deep link through the driver), every other one refused at validation on its line; typing a secret refused.
- **The film:** `simctl io recordVideo --codec h264`, t0 = the "Recording started" line corrected by the lateness the
  movie's own duration shows (`mov-box.ts`); the variable-rate movie made constant-rate BT.709 at the project's fps; each
  tap's touch-down read from the video; a grey fingertip disc with the ripple burnt in by the runner (one ffmpeg
  overlay pass: `overlay`, `setpts`, `setparams` and `crop` are in `ENGINE_NEEDS` — **the app's ffmpeg must be rebuilt
  with them at the next release**). Same `timeline.json` + `capture.mp4` contract through runner-web's driver seam;
  the planner renders a device capture at scale 1 in a phone frame unless a frame is written (layout-phone's island
  now covers the device's).
- **Measured** (M4, 2026-11-17): calibration Δ 1–5 ms per tap on a quiet run (one tap +54 ms under load 20–30: BL-193),
  lateness 2–68 ms per take; burn 7–17 s; `retake run` ~80 s warm, ~2 min cold; `render --review` 95–115 s.
- **Fixture:** `fixtures/ios-wholesale` (the SwiftUI app Northfield Buyer, `build.mjs`) and its project; the gated
  acceptance `RETAKE_TEST_IOS=1 npx vitest run packages/runner-ios/test/ios-acceptance.test.ts` (~10 min after
  `pnpm build`) deletes the devices it made unless `RETAKE_IOS_KEEP_DEVICE=1`.
- **Left:** BACKLOG BL-193 (dry runs, recording, live picture and pause on iOS; gestures; runtime choice; paste of a
  secret; the timing under load). The Studio shows an iOS environment read-only; `retake env set` does not edit one.

## State (after L8.5)
- **L8.5 done (2026-11-17; branch `claude/fb-33-mail-timezone-82c1d3`)** — the mail card dated like the filmed pages
  (field feedback 2, point 33: the card showed the mailbox's UTC date, the page before it the browser's zone).
  - Runner: `BrowserSession.dating()` — read once when the session opens, from the first realm's blank page before
    anything loads (`page-dating.ts`, 2 s at most): its Intl default zone and locale, canonical, extensions dropped
    (`-u-ca-…` would change the calendar), at most 35 characters; else `browser.timezone` / `browser.locale` (the
    project `locale` folded in by `projectBrowser`), else the machine's zone (`machineZone`, now exported by core's
    clock). No product page is asked: a busy page cannot slow a `wait_for_email`, every mail of a take gets the same
    values (both reviews' point, after a first design that read the active page at each mail). `productTime(ms)`: the product clock's reading of a real instant
    (`epoch + (ms − since)`, `epoch` when frozen). `addEmail` takes a `dating` object (persona, zone, locale,
    productTime) and records `timezone`, `locale` and `product_date` on the email artefact (timeline schema, optional:
    old timelines read as before; a timeline written now has fields an older Retake refuses).
  - Planner: `EmailMedia.date` is now the date the pages would show (`product_date ?? date`), with `timezone` and
    `locale`. Card: `mailDates()` in `studio/mail-view` — Intl with the zone, medium date and short time, a
    locale checked with `supportedLocalesOf` (an unknown tag keeps the card's own words, in the zone: deterministic
    across Node, the render's Chromium and the Studio's web view), narrow / no-break spaces and direction marks removed;
    no zone, a date without a time or an unknown zone: the old digits. The `date` slot still wins. Preview regenerated
    (the same picture, re-encoded: the sample has no zone); the version stays 1.0.0, like every built-in component (`library.test.ts`).
  - Acceptance: the fixture's signup scenario copied to a scratch workspace with `browser: {timezone: Asia/Tokyo,
    locale: en-US}`, `clock: 2026-11-17T19:55:00` and its `date` slot removed: the mail sent at 20:52 UTC reads
    "Nov 17, 2026, 7:55 PM" in the rendered card (frame inspected).
  - Mutations: 12, 11 caught; the survivor (in the first design, the configured locale replaced by the page's read)
    was equivalent — the page reports the locale it was launched with. Tests: a frozen clock's run, `page-dating.test.ts`
    (new, in the CI tier).
  - Known limits (R-MAIL-05's gap): dates the server writes into its pages stay real under a product clock; a mail
    sent before capture time 0 reads a time the pages never showed.

## State (after L8.2b)
- **L8.2b done (2026-11-16; branch `claude/l8-feedback2`)** — a project's environments by tool (field feedback 2,
  point 1) and no loading state filmed after a client-side route change (point 27).
  - Environments: core `project-env-edit.ts` edits one environment of project.yaml by splicing its own lines (comments
    and the other settings stay; an environment written on one line is rewritten in block form; aliases and anchors on
    it refused), then re-parses and compares the result with the expected data, else refuses ("edit it by hand").
    Engine `project-env.ts` (`engine.projects.setEnvironment / removeEnvironment`); ops `project_env_set` (write,
    upsert) and `project_env_remove` (destructive), MCP and `retake env add | set | remove`. An agent's change that
    reaches a new origin, lowers a production or read-only mark, moves the default onto a protected environment or
    carries sign-in details in a URL is asked in a form (`Approver.approveProjectChange`, the prune pattern) with the
    `retake env …` command a person runs instead; a read-write environment on a protected host is refused through MCP,
    a warning in the CLI (the command is the person's own act: the CLI asks nothing). The file is re-read after the
    question (a change meanwhile is a conflict) and written with the store's `ifMatch`. `read_only` (hosts, allow,
    mocks) is never written by these tools (BL-189); no Studio screen edits environments (BL-188).
  - Route holds: runner-web `route-hold.ts` — a route change in the same document (another path or a `#/` route,
    never a query-only change) within 1 s of a step's own click, key or Enter holds the frames from the route change
    until the indicators it brought are gone and the network is quiet (3 s at most, then a run warning naming the
    indicator); the press's picture stays 0.1 s, then the ready route; the edit cuts the span like a page load
    (`timeline.loading` gains `until: ready`, `same_document: true`, `indicator`). Indicators already in view before
    the press never count; a marked wait right after the step is filmed on purpose (not held); a route the app changes
    after the step returned is filmed as before. The wide selectors (`animate-pulse`, `data-slot="skeleton"`,
    `data-loading="true"`) count only for the route watcher and only for elements with no text and nothing to click.
  - Counts (after L8.2 → after L8.2b, on its own branch): catalogue 125 → 127, MCP tools 46 → 48, CLI commands
    46 → 49; merged with L8.1, L8.1b and L8.2: catalogue 130, MCP tools 51, CLI commands 51 (see the merge below).
    Requirements R-ENV-06, R-ENV-07, R-ISS-14 (lot `L8.2b`); BACKLOG BL-188, BL-189. Mutations: 18 + 20 (review
    fixes), all caught (the query in the route key first only by the unit test, since by a real browser).
  - **For the record:** it repaired L8.2's red `engine-entries.test.ts` (the `@retake/engine/shell` value cap: L8.2's
    three sandbox words), raising the cap with the reason written in the test.
  - Left for the person: MACOS-CHECKLIST §19 (`retake env` on a copy of a real project, the approval form through
    Claude, a real single-page app's route that loads). Known limits (R-ISS-14's gap): recordings keep their own
    trimming (no route hold), an indicator outside the probe's selectors or drawn on a canvas is filmed as it is, the
    press's ripple is frozen for the 0.1 s it stays.
- **The merge of the L8 chain (2026-11-16)**: L8.2 and L8.2b cherry-picked on top of L8.1, L8.1b and L8.3, then one
  commit for the counts, the goldens and the instruction sentence. Counts after all five lots: 130 operations
  (57 read, 60 write, 13 destructive), 51 MCP tools, 78 Studio ops, 60 CLI operations served by 51 commands; the
  engine's entries 146 types and 156 shell values.

## State (after L8.2)
- **L8.2 done (2026-11-16; branch `claude/l8-feedback2`)** — sandboxes (field feedback 2, points 9, 28, 29).
  - An outdated snapshot (the seed changed, an image rebuilt, `reset.firebase_auth` added) never seeds on a take's
    data: `packages/sandbox/src/reset-plan.ts` (pure) decides restore | first-seed | from-base | from-snapshot |
    refuse. A base template `<db>__retake_base` is taken before a database's first seed and kept; a sandbox snapshotted
    before has none and starts again from its outdated snapshot, with a hint (`retake sandbox down … --volumes`, then
    `up`: a base). With neither, an empty database gets its first seed and a base; one holding data is refused before
    anything changes. The services of `reset.restart` restart after a restore and again after the snapshot is taken;
    copies go through `<db>__retake_next` (a failed copy leaves the old one).
  - `retake sandbox status` and `sandbox_status` say what the next reset does with the snapshot (current, outdated
    and why, base kept or not), read only.
  - Sessions: after a reset puts a Firebase Auth emulator's accounts back (`accounts_at` in the sandbox state), a
    persona's session saved before is signed out: each take signs it in again with its login steps, off camera; a
    persona without login steps is refused naming sandbox.yaml; a hook's `auth: {persona}` outside a take refuses
    instead of sending its request without a token.
  - `sandbox_init` over MCP (write): Retake's docker-compose scaffold and the `sandboxes.<env>` line of project.yaml,
    never over a file and never `--force`; the user fills compose.yaml and sandbox.yaml (Claude proposes the text),
    and the tools say `sandbox_up` pulls missing images (ask first: no form does, BL-185). Three recipes in
    docs/guide/sandbox.md: a monorepo without app images, a hybrid (apps on the host, infra in Docker — the variant
    whose health reads the database: a probe showed a TCP check passes before Postgres is ready), an external sign-in.
  - Decisions: one-shot compose services are not re-run (a compose sandbox cannot hold one: `up` refuses an exited
    container); a database already used is told by its state as well as by its tables (`unseeded_at` for
    `up --no-seed`), so an app that migrates at boot still gets its first seed.
  - Counts (on its own branch): MCP tools 45 → 46; catalogue unchanged (`sandbox_init` was already an operation, now
    served over MCP). Requirements R-SBX-08 – R-SBX-12 (R-SBX-02 and R-SBX-05 extended); BACKLOG BL-185 – BL-187.
    Mutations: 11, all caught (the reset ladder, the sessions after a reset, `sandbox_init` never forcing).
  - **For the record:** the lot was first committed on its work branch with `engine-entries.test.ts` red (three
    sandbox words over the `@retake/engine/shell` value cap); L8.2b repaired it before anything reached `main`.
  - Not run: a live take on a real Firebase Auth emulator (none on this Mac: MACOS-CHECKLIST §18 item 3), and
    `packages/cli/test/sandbox-docker.test.ts` (no local `node:22-alpine` image; it would pull) — `compose.test.ts`
    ran in full with Docker (9/9). Left for the person: MACOS-CHECKLIST §18.

## State (after L8.1b)
- **L8.1b done (2026-11-16; branch `claude/l8-feedback2`)** — open-licence fonts by reference and a draft theme from a
  design-token file (field feedback 2, points 6, 7).
  - Fonts: core `fontsource-ref.ts` (`fontsource:<id>[@<version>][:<weight>[italic]]`, OFL-1.1 and Apache-2.0 only);
    the font store `.retake/fonts/fontsource/<id>@<version>/` (latin WOFF2 faces, LICENSE, record.json with each
    file's sha256); engine port `fonts/font-registry.ts`, adapter `fonts/npm-registry.ts` (its own HTTPS agent, no
    redirect, size caps), the one table of assumptions about the package layout in `fonts/fontsource-layout.ts`. Op
    `font_fetch` (MCP, an approval form first) and `retake theme fetch-font`; the order: refs parsed, a pinned stored
    package answered offline, the approval, the manifest, the tarball's integrity checked **before** the archive is read
    (own tar reader: links, traversal and duplicates refused, caps on entries and bytes), LICENSE required. Themes are
    made and updated offline from the store (`template_create_from_brand`, `template_update`, the Studio's New-theme
    sheet lists the store's faces).
  - Tokens: core `brand-tokens.ts` (a list format and DTCG, aliases, a role proposal by name then by contrast — a
    heuristic the person confirms); op `template_from_tokens` (read only, writes nothing) and
    `retake theme from-tokens <file> [--map role=token]`; token names and families only under `untrusted`.
  - Test guards: `RETAKE_TEST_NO_FONT_FETCH=1` in the suite (every fetch refused unless the loopback test registry
    `RETAKE_UNSAFE_TEST_NPM_REGISTRY` is set); `retake doctor` reports that test registry.
  - Repaired L8.1's red tests (below): the authoring / job / query MCP characterization goldens re-recorded with
    `template_update`, and the three L8.1 test files added to `scripts/test-ci.json`.
  - Counts: catalogue 126 → 128, MCP tools 46 → 48 (R-MCP-02's cite), CLI commands 46 → 48. Requirements R-FLD-45 –
    R-FLD-48, R-SEC-42 (lot `L8.1b`); BACKLOG BL-180 – BL-184. Mutations: 43 + 24 (review fixes) run, 2 + 3 survived,
    each explained in the lot's notes (a proxy rule Node 22.16 does not exercise, an order that cannot matter, a redundant
    guard).
  - **Not verified:** no real fetch from the npm registry was ever made — the fontsource package layout (registry
    address, manifest fields, tarball URL, `package/files/<id>-latin-<weight>-<style>.woff2`) is an assumption, checked
    by hand in MACOS-CHECKLIST §20; a real design-system token export was not read (synthetic files only).

## State (after L8.1)
- **L8.1 done (2026-11-15; branch `claude/l8-feedback2`)** — themes (field feedback 2, points 3, 4, 5, 8).
  - A logo's kind: `logo_kind: mark | wordmark` in template.yaml (absent: 3:1 or wider is a wordmark, read from the
    file's declared size by core `image-size.ts`, the loader reading a 256 KB head only). A wordmark logo is the brand
    name: intro-stack, intro-minimal, outro-stack (new param `wordmark_width`, default 520), outro-minimal, the brand
    mark and the scaffolds draw it once, sized by its width; an app icon shows the brand's initial. Kit: `withLogo`,
    `logoKind`, `logoBox`, `BrandLockup`, `Logo` `maxWidth` / `monogram`, `Wordmark` `force` (KIT_API_VERSION stays 1:
    additive). Manifest versions stay 1.0.0 (the built-ins track Retake's version). Previews regenerated.
  - The brand input: `components` (per kind `{id?, params?}`, checked before anything is written), `cursor {style,
    size}`, `logo_kind`; body files 4 → 8; a variable font is one face for a weight range (`{file, weight: "200 800"}`,
    the file's `fvar` `wght` axis, or `wght<min>-<max>` in its name, one reader: components `fontFileRange`). The tone
    warning ("consider base motion") is gone: a palette of the other tone gets the cursor of its tone, with a note.
  - `template_update` (MCP): changes only the keys given on a theme made through MCP and unchanged since; the theme's
    provenance (`made_via`, `record_sha256`, `sources`, every file listed) is checked before anything is read.
    **Behaviour fixed:** a theme a person made in the Studio (or with the CLI, or before `made_via`) is no longer
    replaceable through MCP.
  - Requirements R-FLD-40 – R-FLD-44, R-SEC-41; BACKLOG BL-175 – BL-178. Counts: catalogue 125 → 126, MCP tools 45 → 46.
    Mutations: 20 + 16 (review fixes), all caught after two tests were strengthened.
  - **For the record:** the lot was first committed on its work branch with four red tests — the authoring, job and
    query MCP characterization goldens (their "unknown tool" lists lacked `template_update`) and three of its test
    files missing from `scripts/test-ci.json` (image-size, editor theme-fonts-face, theme-update) — and L8.1b repaired
    them before anything reached `main`.
  - Left for the person: a real variable font at two weights on frames (synthetic `fvar` and a stubbed FontFace only),
    a theme with a real wide PNG logo in a full render (component previews only), the cursor of the palette's tone on a
    capture (R-FLD-44's gap).

## State (after L8.3)
- **L8.3 done (2026-11-15; branch `claude/l8-feedback2`)** — the app's native menus, the rest (BL-166, after the
  native menu review below).
  - The freeze: menu.rs `apply` only queues the update on the main thread (`run_on_main_thread`, fire and forget); the
    state is read when the closure runs; every menu entry point has that shape (two quick menu keys could freeze the app).
  - The shell's own items follow its state: Check for Updates… by the update's state (fixed words, no version;
    Checking… and Installing… greyed), Install / Uninstall the retake Command… by the link's state (the server writes a
    `cli` pipe line after a status read or an install, best effort).
  - One command registry on the page (ui-kit `commands.ts`: COMMANDS, SHELL_KEYS, PAGE_KEYS, CONTEXT_MENUS), compared
    item by item with menu.rs by desktop-config.test.ts; every key cap in the Studio derives from it (a lint refuses a
    literal one). New items: Help › Keyboard Shortcuts (a sheet), ⌘, on Set Up, File › Show Workspace in Finder.
  - Native context menus on the Productions posters, behind a real secondary click (a local event monitor sees the
    click before WebKit; the page asks for a menu id of the shell's table only, `desktop_menu {popup}`, 30 a minute;
    WebKit's own menu stays in text fields). A probe on a scratch copy of the shell checked the AppKit sequence first.
  - Decisions: one window per workspace, no tabs (BL-191); the leftovers in BL-190. Requirements R-DSK-05 – R-DSK-07,
    R-DSK-03's gap. Mutations: 29 + 14 (review fixes), all caught; the black box 21 passed, 1 skipped.
  - Not done: app-bundle-acceptance and app-update-e2e not extended (gated: they need a bundle and a test feed) —
    covered by MACOS-CHECKLIST 14h items 3 – 4 and R-DSK-05's gap. By hand: MACOS-CHECKLIST 14h (a real right-click and
    ⌃-click, the shell's items after an install / uninstall, the shortcuts sheet, Show Workspace in Finder).

## State (after the native menu review)
- **Native menu review done (2026-11-15; branch `claude/native-menu`, stacked on `claude/studio-design`)** — the
  desktop app's menu bar on Ranch's model: it follows the screen. Not a ROADMAP lot.
  - Layout as macOS apps: the app menu (About, Check for Updates…, Set Up…, Services, Hide, Quit), File (New Scenario…
    ⌘N, Open Workspace… ⌘O), Edit, View (palette ⌘K, modes ⌘1 – 4 and views Board / Hooks / YAML ⌥⌘1 – 3 as check
    items, Show / Hide Inspector ⌥⌘I), a new Go menu (Back ⌘[, Forward ⌘], Welcome ⇧⌘H, Productions ⇧⌘P, the project's
    pages, the scenario's report and comments), Scenario, Window (the app's windows menu) and Help (its help menu: the
    search field). 25 page commands (ui-kit MENU_COMMANDS, compared with menu.rs by desktop-config.test.ts).
  - State: the page computes it (shell/native-menu.ts; command-bus.ts now carries what the status bar's buttons can
    run) and sends it through the own op `desktop_menu` (Studio only, supervised only, strict, 240 lines a minute); the
    server writes a `menu` pipe line; desktop_core `parse_pipe_line` reads it strictly (ids, bools, a 0 / 1 variant);
    menu.rs `apply` greys out, checks, relabels (a clicked check item gets the page's check back). Unlike Ranch the
    page never builds the menu (no IPC for a page served from 127.0.0.1): the shell keeps the table.
  - Tests: desktop-core `menu_lines_strict`; desktop-answer.test.ts (desktop_menu: allow-list, pipe line, cap, strict
    input, 409 unsupervised); native-menu.test.ts (the state per screen); desktop-config's menu assertions rewritten;
    the black box gains "⚑ the menu follows the page" (a Hooks view's state reaches the shell, test mode logs it); op
    counts 125 / 78 Studio; goldens re-recorded (the op table, the "this Studio allows" lists).
  - Gates: build, typecheck, lint, rules (desktop.ts's shell-op count 1 → 2 in its group), `--check-cites`, the Rust
    tests (85) and the black box (each case green alone). Full suite: first run 8 failures fixed (one real: the runs
    were enabled on Welcome — an unreported command is now off), last run 6953 passed, 4 failed in the timeline e2e (the
    known load flake: both files 29/29 alone, twice).
  - Still open: the Help menu's and the update's state (BL-142, BL-143: the shell's own Cmd items, not page commands);
    the black box's "the real question" case fails here on this Mac's session (a window listing), the same on main.

## State (after the Studio large-screen pass)
- **Studio large-screen pass done (2026-11-15; branch `claude/studio-design`, a pull request on `main`)** — the
  Studio's layout follows the window instead of a 1200 px column, from the person's review of the Studio and the
  mock-ups canvas "Studio — maquettes grand écran" (https://claude.ai/artifact/HpHSrLTfNFYDPWD4unSeNU, private: its
  "Maquettes" page and the real screens on "Écrans actuels"). Not a ROADMAP lot (no requirement row).
  - Shell: `--ui-browser-w` `clamp(240px, 15vw, 300px)`, `--ui-inspector-w` `clamp(320px, 24vw, 480px)`, the centre's
    side padding `--ui-gutter` (32 – 56 px); no screen caps its width any more (`.sc-screen`, the Review report, the
    theme editor, Comments, Shoot, Record, the Library detail); a wide storyboard takes 4 then 5 frames a row
    (container queries, ≥ 1180 / 1500 px of board); the browser's foot is the version, a running worker and the UI
    gallery (the workspace's folder moved to Welcome).
  - Welcome rebuilt: the whole window (browser collapsed, no inspector), a greeting beside the search, projects as
    picture cards (`projects_overview` gains `poster`: the newest capture's last pictured step), a New project card,
    Lately beside Set up (Claude, the workspace). New tokens `--ui-type-xl` / `--ui-lead-xl`, `--ui-gutter`.
  - Bugs met on the way (boy-scout rule): Edit's stage shrank to its toolbar when the top notes were empty (an empty
    `.ed-top` is `display: none`, so the grid's `1fr` row went to the tracks) — each part now keeps its row; the Cast
    table cut a persona's name ("supplie / r": the session column took 100 %); a button in a callout stretched across it.
  - Every mock-up page then (the person asked for all of them): the title bar's search (kit `SearchTrigger`, opens the
    palette); the project's browser regrouped (Library, then Project: Locations and cast with each location under it,
    Settings, README, Record — the persona rows went to the page); **Locations and cast** (`#/p/<slug>/cast`, every
    location with its pages and sessions); **a location's page** (`#/p/<slug>/loc/<env>`: pages, a sandbox's services,
    data and files, its personas — the Project screen no longer shows a location in its inspector); **Settings**
    (`#/p/<slug>/settings`, project.yaml read only); a scenario's **Hooks** view (`#/p/<slug>/s/<name>/hooks`, Board ·
    Hooks · YAML); Themes as cards drawn in each theme's colours; README full width; the Set-up sheet's checks as cards.
  - `sandbox_status` is now served by the Studio (a read: the location page); its other sandbox ops stay refused there.
    The Studio serves 77 operations (catalogue and op-table counts, the MCP characterizations' "this Studio allows"
    lists re-recorded).
  - Tests: the overview golden (`packages/mcp/test/fixtures/query-ops.json`) gains the poster; the mark test reads the
    64 px mark; three class hooks that now have rules left the hook list; the e2e follow the new tree (Welcome without a
    browser, the location's page, the 2400 px gallery for three posters); four test titles renamed with what they now
    say (R-UI-35's, R-UI-36's and R-ARCH-32's evidence follow).
  - Gates: `pnpm build`, `pnpm typecheck`, `pnpm lint` (none new), `rules.mjs --check`, `--check-cites` 0. Full suite
    twice: the first run's 7 failures fixed (sizes: the long new components split; feature boundaries: the two new
    pages are the project's public modules; two board-reads and two comments e2e on the new structure — the composer's
    Post now has a scroll margin, the bidi check reads a wrapped line); the second run 6948 passed, 3 failed in
    `studio-e2e-timeline-switch` (a "Saving…" still shown under load) — a load flake: the file 7/7 alone, twice, and
    with studio-e2e-edit 29/29 (one edit case failed once in a pair run, then 3/3 alone).

## State (after L7.58)
- **L7.58 done (2026-11-15; branch `claude/arch-l7`)** — the product's package adapters and their default ports live
  in a new composition package, `@retake/compose` (packages/compose); the shells build their engine from it; the
  engine loads no adapter package any more and never names the composition package.
  - Code: packages/compose (new, private, `exports` "." only): `lazy.ts` (the seven loaders, moved), `ports.ts`
    (`productPorts(given)`, `productAdapters`, `bindProduct`), the six package adapters moved out of the engine
    (editor-renderer, runner-web-capture, review-package, package-hooks, package-sandboxes, package-registries),
    `worker-main.ts` and `bundle-env.ts` (moved). Engine: `ports.ts` gains `Product` / `bindProduct` /
    `boundProduct` / `boundWorkerEntry` — `enginePorts` keeps the engine's own defaults (clock, stores, reads, queue,
    secrets, outputs, hosts) and takes the six package ports from the bound product (or refuses by name; every port
    handed needs none); `lazy.ts` holds the editor's and the components' modules the product binds (roots as types
    only); `jobs/spawn.ts` starts the bound worker entry; `jobs/build.ts` stamps the composition package's folders
    too; new entry `@retake/engine/composition` (what the composition package wires). `./shell` no longer exports
    `enginePorts`, `./testing` no longer the package adapters (now `@retake/compose`), the main entry no longer the
    type `Clock` (as on the branch). Shells: CLI `main()` binds the product, `cliEnginePorts` = `productPorts()`;
    MCP `createEngine({ …, ports: productPorts() })` (stdio and HTTP); Studio `studioPorts = productPorts()`, also
    handed to its engine. The app bundle needs no script change (`pnpm deploy` of the CLI brings the new package;
    set-version reads packages/ itself). Docs: target-architecture.md (composition layer, rules), DESIGN.md (worker
    entry), guide/development.md (the package).
  - Rules: scripts/audit/lib.mjs — layer `composition` (LAYERS), R2 forbids it to adapters, new checks `engine-load`
    (no value import / re-export / `import()` / require of an adapter package outside the domain entries anywhere in
    packages/engine/src, the loader included), `engine-deps` (the engine's @retake deps are core and the domain
    entries' packages; no package below the composition depends on it) and `compose-use` (only the shells' sources
    import it); LOADER_HOMES / ADAPTER_HOMES down to render/ and registries/; PORT_ROOTS of the package adapters in
    packages/compose/src; ENV_HOMES without the worker entry. Baseline 63 → 63 (no entry went stale: the moved
    adapters had none).
  - Tests: packages/compose/test/product.test.ts (new, ci tier: an unbound engine refuses by name, the bound product,
    the deps); vitest.setup.ts binds the product in a `beforeAll` (after each file's mocks apply); ~55 test files
    moved to `@retake/compose` imports, `enginePorts` from the shell entry → `productPorts`; child scripts (engine
    fixtures, app-bundle) bind the product; worker-process tests spawn compose's worker-main.
  - Mutations: engine-load (a value import and an `import()` of an adapter in lazy.ts), compose-use (engine and
    hooks importing the package), engine-deps (engine depending on compose and on mcp), R2 (hooks importing it): each
    red, restored green.
  - Gates: clean build (every packages/*/dist and *.tsbuildinfo removed, `npx tsc -b` 0), `pnpm typecheck`,
    `pnpm lint` (0), `pnpm format:check`, rules `--check`, size-limits `--strict`, test-guard (no decrease),
    check-cites on a scratch copy with the requirement edits: all 0. Tests, 39 files each alone (fresh RETAKE_HOME,
    RETAKE_DISK_WARN=off), all green: compose product, core import-rules and test-typecheck, engine engine-entries,
    ports, editor-renderer, pipeline, run-thumbs, worker-ports, capture-runner, hook-runner, reviewer, registries,
    sandboxes, comments and library-cache (child fixtures), worker-heavy, jobs, engine, render-use-case (real render),
    worker-process (real capture through compose's worker entry), render-worker-process (real render jobs),
    worker-captures, sign-in-sandbox-jobs; cli test-ci-tier, operations-cli, app-bundle, app-bundle-build,
    desktop-config, main-ports, doctor-captures, doctor, sandbox, pipeline-cli, record; mcp approval, site-output;
    ui library-ops, supervise, board-ops.
  - Not done: the engine still names the editor's and the components' roots as types (lazy.ts, render/,
    registries/) — their hand-on calls (render/editor-calls.ts, render/work.ts, registries/component-calls.ts) run
    on the modules the product binds; moving those calls behind ports needs the root-only types (FoundRender,
    RenderStillOptions, …) in the domain entries. The engine's package.json keeps all six adapter packages as
    dependencies, because the domain entries are their sub-paths.

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
8. **Optional** — Docker with the image `postgres:17-alpine` for the Postgres tests (never pulled by the tests;
   `pnpm test:pg` fails instead of skipping), or `RETAKE_TEST_PG=postgres://…` for a server of your own; Python 3.13 or older + OpenTimelineIO for `scripts/validate-raw.py`
   (OpenTimelineIO 0.18.1 does not load on Python 3.14: `RuntimeError: bad any cast`; Homebrew has `python@3.13`):
   `python3.13 -m venv ~/.venvs/otio && ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter`.

**macOS permissions.** Headless captures need no Screen Recording permission (frames come from Chromium's own
screencast) and the fixture and the render asset server listen on loopback only (no firewall prompt). Expect prompts
only for what the L1.5 checklist exercises: Keychain access when a hook resolves `{{keychain:service/account}}`
(through `security`), the Notification / Automation prompt the first time `osascript` posts a notification from the
terminal, and a visible window for `--headed` runs and `retake login`.

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
Homebrew for OpenTimelineIO), no Final Cut Pro / Premiere Pro / DaVinci Resolve. Full test suite ≈ 20 min (`pnpm test:ci` ≈ 4 min).
