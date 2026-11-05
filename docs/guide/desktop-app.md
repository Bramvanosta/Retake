# The desktop app (macOS)

Installing Retake.app, releasing an update, and the desktop shell. Part of the [Retake guide](README.md).

## Install the app (macOS)

**Retake.app** carries everything it needs — its own Node.js, engine, Chromium and render browser, ffmpeg, starter
themes and Claude plugin (L5.16): no repository, Node.js, Homebrew or Playwright download on the Mac that runs it.
macOS 15 or later, Apple silicon.

1. Open `Retake_<version>_aarch64.dmg` and drag **Retake** onto **Applications**.
2. Open Retake from Applications. A release built with a Developer ID (the release page says "notarised by Apple")
   opens without a warning. **An ad hoc build** — `pnpm desktop:bundle`, or a release made without the Apple secrets
   (its release page says "Not notarised") — is refused by macOS at the first open of a downloaded copy (one that
   carries the quarantine mark): try to open it once, then System Settings › Privacy & Security › Open Anyway
   (macOS 15 no longer offers Control-click › Open for it). A copy built on this Mac and never downloaded opens
   directly.
3. **Move it first.** Opened straight from the disk image or from Downloads, macOS runs a temporary, read-only copy
   of the app (App Translocation) or the image under /Volumes: the app works, but its Set-up sheet keeps the command
   and the Claude registrations off and says "Move Retake to Applications, then open it again" (a path recorded then
   would point into a folder that goes away). `retake doctor`'s App location line says the same.
4. **The first run.** With no workspace yet the app asks: **Create ~/Retake** (the default: the app's own
   `retake init` makes a `retake.yaml` and a `projects/` folder), **Choose a Folder…** (a workspace you have, or an
   empty folder made one) or **Quit**. The choice is remembered; File › Open Workspace… changes it. A folder `retake
   init` refuses (one that is not empty and not a workspace) is left as it is, and the question comes back with the
   reason.
5. **The Set-up sheet** opens at the first start, its title focused (Return there chooses nothing), until you close
   it with **Done** — Escape closes it without that, so it opens again next time (Help › Set Up Retake… brings it back
   any time). Every step is optional and happens only when you click it:
   - **Command line** — Install links `~/.local/bin/retake` (or a folder you choose in the app's own panel) to the
     `retake` inside the app, so it always runs the version of the app you have. It never replaces a file that is not
     such a link (your own `retake` script stays), a link to another copy of the app only with Replace, and it never
     edits your shell profile: when the folder is not on the PATH the app was given, the sheet shows the line to add to
     `~/.zprofile` (`export PATH="$HOME/.local/bin:$PATH"`; a folder whose name holds a space, a quote or a `$` is
     single-quoted, so pasting the line never runs anything). "Another copy of the app" means a link to
     `<Some>.app/Contents/Resources/bin/retake` in an app whose identifier is Retake's — any other `…/bin/retake` is
     your file. The app keeps one command: the folder it linked is remembered (`app.json` in the Retake home), and
     installing in another folder waits until you Uninstall that one. The app cannot see your shell's PATH — check in
     a new Terminal window: `retake doctor` (its `retake command` line names the link, a link left dangling after the
     app moved, a file in its place that is not Retake's, another `retake` first on your PATH). **Uninstall:** Help ›
     Uninstall the retake Command… removes this app's link (nothing else), or `rm ~/.local/bin/retake`. Deleting the
     app leaves a dangling link behind (doctor says so, with the `rm` line to paste).
   - **Claude Code** — the Retake plugin with the app's Node.js, engine and this workspace: the sheet shows the two
     `claude plugin …` lines (Copy) and Run runs them for you with the `claude` it finds in `~/.local/bin`,
     `/opt/homebrew/bin`, `/usr/local/bin` or `~/.claude/local` (no shell; your `CLAUDE_CONFIG_DIR` when the app has it;
     60 s, then "run them in Terminal" — Claude Code may be asking a question; the answer comes when `claude` itself
     exits, even if something it started keeps running; one run at a time). Its output is shown as text.
   - **Claude Desktop** — Add to Claude Desktop… shows the exact `mcpServers.retake` entry and the file
     (`~/Library/Application Support/Claude/claude_desktop_config.json`), and writes it only when you confirm: a
     backup first in the Retake home's `backups/claude-desktop/` (private to you; the last 5 kept — never next to the
     file, nor in a dotfiles repository a symlinked config points into), every other setting kept, a symlinked config
     written where it really lives, its permissions kept, read back after. It refuses a file that is not valid JSON,
     asks you to quit Claude Desktop first (it may write its settings over the change) — and waits too when it cannot
     tell whether Claude Desktop runs — and replaces a different `retake` entry only with Replace. Copy entry is always
     there to do it by hand.
   - **Notifications** (Allow… asks macOS now), **screen recording** (not needed: captures are headless), the **local
     network** (macOS asks the first time a capture opens a site on your network).
   No MCP tool can install the command or register Retake with Claude: these are the Studio's own operations, on the
   app's own server only.
6. The command line is inside the app either way: `/Applications/Retake.app/Contents/Resources/bin/retake doctor`
   (every tool says `bundled`). Link to it rather than copying it (a copy outside the app refuses to run). The app's
   code only loads its own modules: a `node_modules` folder above the app (in /Applications, your home…) is never read.
   Hooks and sandbox commands run with the app's Node.js first on their PATH (BL-141).
7. **Two copies of Retake** (the app and a repository checkout, or two apps) share your workspaces and the Retake home:
   a workspace's jobs run in the worker of whichever copy started it — doctor, the Studio's Welcome inspector, the
   Studio's own Capture / Rehearse / Render ("queued" line) and an MCP submit say when it is another copy (version,
   path; to an agent, the path only under `untrusted` in engine_info). A signed-in profile is never opened by an older Chromium than
   the one that opened it last (that would downgrade it and may lose its sessions): the run says which copy to use.
8. **Updates.** An app built with a feed (below: *Releasing an update*) checks it at launch, at most once a day, and
   Help › Check for Updates… asks now (an alert says "up to date", "off" or "could not check", with the date of the
   last successful check). When a newer version is out, the Studio's status bar shows **Update available · vX**; the
   click opens a sheet with its release notes (plain text) and **Later · Install and Restart** — nothing installs
   without that click. Install and Restart downloads the update (https only, at most 1.5 GB, stopped after a minute
   without data; Later stops it) and checks its signature against the public key compiled into the app (and that it
   was signed for that very version, never an older one), keeps it in the app's cache folder, waits while a job of
   this workspace runs or waits (Later stops waiting and removes the download), asks the usual quit question if a tab
   holds unsaved text — your answer holds however long the question stays open — stops the Studio server, swaps the
   app in place and restarts it. A check while an install is under way is refused, with a word why. An update that
   cannot be installed keeps the app you have and says so at its next start, which checks the feed again at once (the
   sheet offers Install and Restart again only when the feed still has it; doctor says it until then). Workspaces,
   the Retake home, the command's link and the Claude registrations stay valid (they point at the same app). An app
   run from a translocated copy or a read-only disk does not update ("move it to Applications"); one in a folder this
   account may not write (a root-owned /Applications) says, in the sheet and the status bar, to install the new
   version from its disk image. `RETAKE_DISABLE_UPDATE_CHECK=1` in the app's environment turns the checks off;
   `retake doctor` shows the last successful check (`App updates`). A build without a feed — the developer app, a
   bundle built without the two variables — says "Updates are off in this build" (doctor too).

**Building the app and the DMG** (from a checkout, offline once the caches are filled):

```sh
pnpm build
pnpm desktop:bundle --out <scratch folder> --ffmpeg <folder with ffmpeg + ffprobe>   # or RETAKE_BUNDLE_OUT=<folder>
```

It stages the payload, signs it ad hoc (inside-out, the hardened runtime on every binary, the entitlements of
`apps/desktop/bundle/sign-table.json`), lays the app out with Tauri's bundler (the Tauri CLI comes from the pnpm store,
every file checked against the sha512 pinned in `apps/desktop/bundle/tauri-cli.json`: no dependency is added), signs
the shell and the app, verifies them (signatures, entitlements, Resources byte for byte against the signed payload),
then makes and checks the DMG (`hdiutil`, APFS, compressed; no Finder scripting). Every tool the build runs gets an
allow-listed environment: no credential of your shell (Apple, updater keys, registry or cloud tokens) reaches pnpm,
cargo's build scripts or anything else (the updater's private key reaches only the command that signs the update archive: *Releasing an update* below). Everything lands in the folder you name — a folder of its own: empty (or a
previous build's), never in the checkout, /Applications, ~/Library, your home folder itself or the Desktop / Documents
/ Downloads folder itself (a folder inside them is fine) — `app/Retake.app`, `Retake_<version>_aarch64.dmg` and
`bundle-report.json` (≈ 1 GB app, ≈ 420 MB DMG, ≈ 3 min with a cold cargo cache; the folder needs ≈ 4 GB free while
it builds: stage, app, DMG and cargo's target). `--ffmpeg` takes a relocatable build (`node scripts/build-ffmpeg.mjs`);
without it the app uses the system's ffmpeg. `--stage <dir>` reuses a stage (`bundle.mjs stage`) of the app's own
version: one staged before a version bump is refused before Tauri builds anything (stage again). Cargo runs with
`--locked` (`--offline` when `CARGO_NET_OFFLINE=true`). The end-to-end check of a built app is opt-in:
`RETAKE_TEST_BUNDLE=1 RETAKE_TEST_BUNDLE_FFMPEG=<ffmpeg folder> npx vitest run
packages/cli/test/app-bundle-acceptance.test.ts` (≈ 7 min: builds, then doctor, a capture and a render of the fixture
through the app's own command, the app's window serving the Studio, its first run creating ~/Retake in a scratch home
and its Set-up operations linking the command there, no module loaded from above the app, the signature
intact afterwards; `RETAKE_TEST_BUNDLE_APP=<Retake.app>` checks a built one). `pnpm desktop:build` keeps building the
developer app below, which runs this repository's CLI.

**Releases are made by GitHub Actions** from a pushed `vX.Y.Z` tag (`.github/workflows/release.yml`): the DMG on a
GitHub release, signed and notarised when the Apple secrets are set, the update published in the repository's own
`update-feed` release —
[docs/RELEASING.md](../RELEASING.md) (the `release` environment, its secrets and variables, each release, re-runs, a
pre-release). The workflow builds the ad hoc app on one runner (`pnpm desktop:bundle --app-only`) and signs it on
another that runs only this repository's scripts (`node apps/desktop/scripts/release.mjs sign --app <…/Retake.app>
--out <folder> [--release] [--app-version <v>] [--tauri-cli <folder>]`): the signing keys never share a runner with a
dependency's code; the update archive is signed by a fresh copy of the pinned Tauri CLI, made right before and
removed right after. The stage refuses a Node.js or a browser build other than the ones `apps/desktop/bundle/node.json`
and `browsers.json` pin (`node apps/desktop/scripts/bundle.mjs check-pins`). The same release run by hand — your
Developer ID, notarisation, stapling — is `pnpm desktop:release --out <folder> --ffmpeg <folder>` (the ad hoc build,
then the same signing step; MACOS-CHECKLIST 15b). It refuses before anything runs unless `APPLE_SIGNING_IDENTITY` ("Developer ID
Application: <name> (<TEAM>)"), `APPLE_TEAM_ID` and a notarisation credential are set: `APPLE_KEYCHAIN_PROFILE`, a
profile you store once with `xcrun notarytool store-credentials <profile>`, or an App Store Connect API key
(`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` — the .p8 file). An Apple ID password is not taken:
notarytool would show it to every process on its command line. The app is notarised as a zip, then stapled; the DMG is
signed, notarised and stapled; then the team of every signature, Gatekeeper and both tickets are checked.
`APPLE_KEYCHAIN` (optional: the absolute path of a keychain file) makes codesign take the identity from that keychain
only — the release workflow names its temporary one.

### Releasing an update

The release workflow does all of this from a tag ([docs/RELEASING.md](../RELEASING.md)); what follows is the same by
hand, from a checkout on your Mac — the fallback when GitHub Actions is not an option, and the reference for what the
workflow runs.

The installed apps update themselves from a **static feed on the repository's GitHub releases** (L5.16f) — the
repository names no account, no key and no URL; the repository comes from your environment (`GITHUB_REPOSITORY`).
**The repository must be public**: the apps download with no credentials (a private one is refused). Its
*immutable releases* setting must stay off (the feed's files are replaced at every release).

```
<server>/<owner>/<repo>/releases/download/update-feed/latest.json   the newest STABLE version ← stable builds read this
<server>/<owner>/<repo>/releases/download/update-feed/rc.json       the newest version, pre-release or not ← pre-release builds
<server>/<owner>/<repo>/releases/download/v<version>/Retake.app.tar.gz (+ .sig)     the signed archive
<server>/<owner>/<repo>/releases/download/v<version>/platform-<platform>.json        {signature, url}
```

`update-feed` is one fixed release, a pre-release (never shown as the latest), created by the first publication; it
is the only release whose files are replaced once public. GitHub answers those addresses with a redirect to its
download host: the app follows it, https only at every hop.

0. **Bump the version** — one number in about fifteen files (the root and every package's `package.json`,
   `RETAKE_VERSION` in `packages/core/src/formats.ts`, `apps/desktop/tauri.conf.json`, the Claude plugin's manifest,
   `apps/desktop/Cargo.toml` and its `Cargo.lock` entry):
   ```sh
   node scripts/set-version.mjs <version>     # writes it everywhere (only each file's version field)
   node scripts/set-version.mjs --check       # lists a file that disagrees (packages/cli/test/app-bundle.test.ts checks it too)
   pnpm build
   ```
   The archive is signed for the version the app was built with and published for the one you name: a partial bump
   gives a refused publish ("signed for version X, not Y") or a disk image named after the old version.
1. **The signing key, once** (docs/RELEASING.md gives the offline command, from the pnpm store):
   `pnpm dlx @tauri-apps/cli@2.12.4 signer generate -w ~/retake-updater.key` (the CLI
   version the bundle step pins) — keep the private key and its password in your password
   manager: **lose them and the installed apps can never be updated again** (they trust that key only). The `.pub`
   file's content is the public key.
2. **Build** with the feed and the key in the environment (both, or neither):
   ```sh
   RETAKE_UPDATE_FEED=$(GITHUB_REPOSITORY=<owner>/<repo> node scripts/release.mjs feed <version>) \
   RETAKE_UPDATE_PUBKEY="$(cat ~/retake-updater.key.pub)" \
   TAURI_SIGNING_PRIVATE_KEY="$HOME/retake-updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… \
   pnpm desktop:release --out <folder> --ffmpeg <folder>        # or desktop:bundle for an ad hoc build
   ```
   `TAURI_SIGNING_PRIVATE_KEY` is the key file's **path**, not its text: the key itself is never in the environment
   of pnpm, its hooks or the build — bundle.mjs reads the file and hands its text (and the password) to the one
   command that signs the archive; every other child gets an allow-listed environment without either.
   A pre-release build (a version with `-rc.N`) names `…/rc.json` instead, so it is offered the next pre-release and
   the final version, and a stable build is never offered a pre-release — the build refuses a feed of the other
   channel than its version (`latest.json` for a stable version, `rc.json` for a pre-release). `release.mjs feed`
   prints the right one for the version (`GITHUB_SERVER_URL` when not GitHub's own). The feed must be https (any https
   feed works for a local build); the overlay compiles
   `requireSignedVersion` and no downgrade in. Besides the app and the DMG the folder then holds
   `Retake.app.tar.gz` (made with macOS's tar: every link of the app kept, no extended attribute) and its `.sig`
   (`tauri signer sign --app-version <version>`; the private key reaches that one command only), checked against the
   public key before the build ends. Without the private key the archive is left unsigned (nothing to publish).
3. **Write the release notes** — the paragraph under `## [<version>]` in `CHANGELOG.md`, for the person about to click
   Install and Restart (plain text: the sheet shows it as typed).
4. **Publish** — first the version's GitHub release, public (`gh release create v<version> --verify-tag …`, the
   archive and its `.sig` attached or not: the step attaches them when missing), then:
   ```sh
   GITHUB_TOKEN=<token> GITHUB_REPOSITORY=<owner>/<repo> \
   RETAKE_UPDATE_PUBKEY="$(cat ~/retake-updater.key.pub)" \
   node scripts/publish-update.mjs <version> --artifact <folder>/Retake.app.tar.gz --signature <folder>/Retake.app.tar.gz.sig
   ```
   It checks the signature in Node first (the key, the archive, the signed version) and writes nothing otherwise;
   then, still before any write, that the repository is public, that `v<version>` is a **published** release (a
   draft's files answer 404 to the apps) and that what it already holds is these very bits (the archive and `.sig`:
   size and GitHub's sha256; the platform file: the same signature and URL). Then only what the release lacks — the
   archive, its `.sig`, `platform-darwin-aarch64.json` — and it **rebuilds** `rc.json` (every version) and
   `latest.json` (stable ones) on `update-feed` from the platform files the version's release holds — a re-run heals a
   feed that lost a race, and a channel is never moved back to an older version. Other bits on a public release are
   refused with no override (the old `--force` is gone): a fixed build is a new version. Only `darwin-aarch64` is
   accepted for `--platforms` (the archive is the Apple-silicon app). With `RETAKE_UPDATE_FEED` set (the feed you built
   with), it must be this version's channel on this repository. `--notes <file>` replaces the CHANGELOG's paragraph.
   `GITHUB_API_URL` and `GITHUB_SERVER_URL` (https) default to GitHub's own; the token needs `contents: write` on the
   repository — prefer a fine-grained token limited to this repository (*Contents: Read and write*) over
   `$(gh auth token)`, which is your whole account's (the workflow uses its job token). The token goes to the API and
   to the API's own upload host only (`uploads.<host>` for `api.<host>`, else the API's host); a release naming another
   upload address is refused.
   Every request has a timeout, and a server error, a rate limit (its `Retry-After` honoured up to a minute) or a
   network error is asked again with a pause. A channel is replaced through `<channel>.tmp-<run>`, and looked at again
   before each delete: a newer feed another publication wrote meanwhile is kept. **If it stops saying a channel "may
   be MISSING"** (the old file deleted, the rename not done), every app's check fails until it is back: run the same
   command again — it writes the channel and removes the temporary file it kept. A channel kept at a version with no
   published release (a feed that would freeze every app) is printed as a `::warning::` and the command still succeeds
   (a channel never moves back on its own): delete that file on `update-feed`, then publish the newest real version
   again. A half-uploaded file of an interrupted run on the version's release is deleted and uploaded again.
5. **Check it on a Mac with the previous version** (MACOS-CHECKLIST 15d): the status bar offers the update, Install
   and Restart lands on the new version.

The end-to-end check of the updater, offline on this Mac (two app builds, ≈ 3 GB in a temp folder, a test key made for
the run, a feed on 127.0.0.1): `RETAKE_TEST_UPDATE=1 npx vitest run packages/cli/test/app-update-e2e.test.ts`.

## Desktop app (macOS)

`apps/desktop` is a small Mac app around the same Studio (L5.2): a window on the workspace's own Studio server, the
native menu, a workspace picker, a clean stop. It is the browser tab of `retake ui` without the browser — nothing of
the Studio is rebuilt in it, and its Rust is only OS glue (Tauri 2, macOS's own WebKit).

```sh
pnpm build                     # the app runs this repository's built CLI
pnpm desktop:dev [--root <workspace>]      # a debug build, started from the terminal (its output: origins only)
pnpm desktop:build             # apps/desktop/target/release/bundle/Retake.app (ad hoc signed, never installed)
pnpm desktop:test              # the shell's rules (apps/desktop/core: seconds)
pnpm desktop:clean             # both build folders, apps/desktop/gen/ and the app's Launch Services record
```

- **Needs** Rust (`cargo` on PATH, Rust 1.90 or later) and the Xcode command line tools — for these commands only:
  `pnpm build` and `pnpm test` never need Rust (`pnpm test` runs the shell's rules when Rust 1.70+ and the command line
  tools are there, and skips them, saying why, otherwise). Cargo runs with `--locked` (Cargo.lock is committed); set
  `CARGO_NET_OFFLINE=true` (or pass `--offline`) to build from the cargo cache only (`cargo fetch --locked` once with a
  network fills it).
- **Disk.** The build folders are inside the checkout (git-ignored), one set per checkout or worktree:
  `apps/desktop/target` (≈ 1 GB for a debug build, ≈ 0.85 GB for a release one) and `apps/desktop/core/target`
  (≈ 11 MB, also built by `pnpm test`). Set `CARGO_TARGET_DIR` to put them elsewhere; `pnpm desktop:clean` removes
  them (and Tauri's generated `apps/desktop/gen/`).
- **What it runs.** `pnpm desktop:build` writes into the app the Node.js that built it (by a path that survives a patch
  upgrade, as the plugin's config) and this repository's `packages/cli/dist/bin.js`: the app runs `node bin.js --root
  <workspace> ui --supervised`. A `git pull` + `pnpm build` updates what the app runs at its next start; a moved
  repository or a removed Node.js gives an alert with the fix (`pnpm desktop:build` again). `pnpm desktop:dev` passes
  them through `RETAKE_NODE` / `RETAKE_CLI` instead (only a debug build reads those).
- **Which workspace.** `--root`, else `RETAKE_ROOT`, else the last one opened (`<Retake home>/desktop.json`), else
  the current folder's `retake.yaml`, else a folder picker; File › Open Workspace… (⌘O) switches (the server of the
  first one stops before the next starts). A folder that is not a workspace changes nothing, and if the new one cannot
  start, the previous one opens again.
- **The menu bar (L5.9).** View › Command Palette… (⌘K), Script ⌘1, Shoot ⌘2, Edit ⌘3, Review ⌘4 (the scenario in
  context; with none, the status bar says so), Show or Hide Inspector (⌥⌘I), Enter Full Screen. The window follows the
  system's appearance (dark or light) with the Studio. ⌘R, ⇧⌘R and ⌘B (Rehearse, Capture, Render) arrive with the Shoot
  screens (L5.11). The title bar is the standard macOS one for now (an integrated one: BACKLOG BL-126).
- **One server per workspace, as `retake ui`.** When no server serves the workspace, the app's server is its own:
  Quit (⌘Q, or SIGTERM / Ctrl-C under `pnpm desktop:dev`) stops it, and if the app crashes the server sees its pipe
  close and stops too — no server is left holding `ui.json`. When one already serves it (a terminal's `retake ui`),
  the app attaches: it opens that server's Studio and never stops it; nothing watches it either — if it stops, the
  window says to run `retake ui` again: File › Open Workspace… on the same folder gives the app a server of its own
  (and if the page reloads meanwhile, the app says the server is gone and offers Restart). Attaching needs that
  server's token, which `retake ui` keeps in the Retake home (`~/.retake/ui/`), not in the workspace: a server
  started with another `RETAKE_HOME` (or by an older Retake) is not attached to — the app's *The Studio could not start* alert
  quotes why; stop that server, or start it with the default home.
  The jobs worker is never the app's: quitting while a capture runs lets it finish.
- **Quit asks when something would be left behind** (L5.2b). With a job of the workspace's queue running or waiting
  (a capture, dry run, render, review, export, recording, sandbox start or reset, environment reset or hooks, queued
  by the Studio or by Claude through MCP — a terminal's `retake run` / `render` / `export` / `record` runs in-process,
  is no job, and is neither asked about nor notified) or unsaved text in the Studio (a README or a scenario's YAML
  being edited, a step form's typed fields, a comment being written, the Library's "create a component" words, a
  new-theme form, a theme colour picked and not written yet — in this window or in a browser tab on the app's server),
  ⌘Q, Quit in the menu or the Dock ask first, naming each: jobs keep running after the app quits (it just stops
  telling you when they end); unsaved text can no longer be saved. A recording the Studio started keeps its window:
  the question says to close that window to end it and save it from the Record screen later. With unsaved text,
  Cancel comes first and **Quit Anyway** is red and takes no key (Return never loses text; Escape: MACOS-CHECKLIST
  14a); with jobs only, Quit Anyway is the default. Names are the project's and scenario's own (only ones that exist,
  cut at 40 characters). **Logging out** asks the same, saying the jobs stop (the jobs worker ends with your session);
  **a restart or shut down** of the Mac asks only about unsaved text — jobs alone never hold an unattended restart
  (they stop with it). File › Open Workspace… asks the same way (Open Anyway), and when the app's server stops on its
  own, its restart alert names the unsaved text still in the window, with **Not Now** as the default (Restart and
  Quit, which lose it, take no key). Nothing pending: Quit is instant, as before. A job waiting with no worker to run
  it does not count (it starts with the next job). SIGTERM / Ctrl-C quit at once and close whichever question of the
  app is up — the quit question, Open Workspace…'s, the restart alert, "not a workspace", the folder picker (the
  picker's case is checked by hand: MACOS-CHECKLIST 14a). A job queued from the Studio counts at once; one from Claude
  within a second.
  **Since L5.12d** the question of a plain Quit (⌘Q, the menu, the Dock) is a sheet in the window itself, with the
  same words, the buttons in the same places (the default on the right) and the same keys — Return on a focused Quit
  Anyway still chooses the default; Quit Anyway quits at once. If the answer does not reach the app, the sheet says so
  and stays. If the window cannot show it (the page still loading, the connecting or ended screen, the server not
  answering), the app's own alert asks after about 1.5 s; logout, restart and shut down, the restart alert
  and Open Workspace… keep the app's own alerts. A second ⌘Q while the sheet is up shows it again; left unanswered for
  10 seconds, the next ⌘Q asks with the alert.
- **Notifications** (L5.2b). When a job ends while the window is not in front (closed, hidden, minimised, or another
  app active), a notification says how it ended — "Capture finished", "Render needs attention — the review found errors
  or warnings", "Recording needs attention — ready to save on the Record screen" — with the project and scenario;
  several ending close together come as one summary (at most one notification every 5 s); a cancelled job says
  nothing. A click shows the window. macOS asks for permission at the first one (System Settings › Notifications ›
  Retake turns them off or on again — turned on there, the next notification shows, no relaunch needed; a refusal
  by macOS itself is logged with its error code). Only the built app posts them (`pnpm desktop:dev` runs a bare
  binary: it says so and posts none).
- **An attached server** (a terminal's `retake ui` was there first) gives the app no pipe: no quit question, no
  notifications — the app says so when it attaches. File › Open Workspace… on the same folder after stopping the other
  server gives the app a server of its own.
- **After `pnpm build`, run `pnpm desktop:build` too** when the CLI and the app drift apart: an app older than the CLI
  (or the other way round) refuses to start with an alert that says which one to rebuild.
- **The window.** Closing it hides it (the page stays connected); the Dock icon or Window › Show Studio Window (⌘0)
  shows it again (⌘Tab alone does not). The title bar takes the page's colour — light today, also in Dark mode, until
  the Studio's own dark theme. The Edit menu makes
  ⌘Z ⌘C ⌘V ⌘X ⌘A work in fields; the app binds no ⌘S, ⌘R, ⇧⌘R, ⌘B, ⌘. or ⌘Enter, so the Studio's own shortcuts work.
  The Record screen's few typed words (a recording's name) are not among the unsaved text Quit names (BACKLOG BL-125).
- **What it keeps and prints.** No token: the page trades the one-time code for its token as in a browser and keeps it
  in the window's memory; the window's web storage is ephemeral (nothing in `~/Library`: no copy of capture media);
  the window loads only the Studio's and the preview's `127.0.0.1` origins (every navigation, every frame; none once
  its server stopped), cancels every download, grants no camera, microphone or screen, the page gets no command of the
  app, and the app's output names origins only — never the one-time link, a preview capability or the token. A built
  app passes the Studio server your environment without `NODE_OPTIONS`, `NODE_PATH` and the linker's `DYLD_*` /
  `LD_*` variables (nothing set with `launchctl setenv` makes it load code).
- **From Finder**, the app gets macOS's minimal environment, not your shell's: `{{env:NAME}}` references of a scenario
  find nothing there (use `{{keychain:…}}` references, or start the app from a terminal with `pnpm desktop:dev`);
  ffmpeg is still found in Homebrew's folders. A jobs worker the app's server starts keeps that environment while it
  lives (it exits after 60 s without a job), so a job Claude submits through MCP meanwhile runs with it too — let it
  idle out before relying on `{{env:…}}` set in a terminal (BACKLOG BL-125). Your jobs from the app follow the rules
  of every job the worker runs, Claude's included: no program from inside the workspace and only switches in
  `browser.args`, none that loads code or files, and their shell hooks, `docker` and sandbox services get only the
  shell's own variables of the worker's environment plus the names of project.yaml `pass_env:` (see
  [Workspace](workspace.md)); a run typed in a terminal keeps them.
  macOS may ask
  whether the app may reach devices on your local network (a capture of a product on another machine), access your
  Desktop, Documents or Downloads folder (a workspace there: the server is the app's child), or show notifications (the
  app's own job notifications, or a `notify` step), naming the app; the ad hoc signature changes with every
  `pnpm desktop:build`, so it may ask again after a build (notification permission is kept by bundle id: expected to
  survive a rebuild — MACOS-CHECKLIST 14a checks it).
- **Launch Services** records each built copy of the app (even started from a terminal); keep one copy —
  `pnpm desktop:clean` removes the record with the build.
- **Checks.** `packages/cli/test/desktop-config.test.ts` (the configuration, read statically) and
  `desktop-core.test.ts` (the shell's rules, when cargo is on PATH) run in `pnpm test`; the black-box test of the built
  app is opt-in: `RETAKE_TEST_DESKTOP=1 npx vitest run packages/cli/test/desktop-shell.test.ts` (≈ 2 min warm: the
  quit question, Quit Anyway / Open Anyway, SIGTERM during every question and the notification rule included,
  notifications logged, never posted; its test mode (`RETAKE_DESKTOP_TEST=1`) is honoured only for a binary another
  process started — never for a Finder or Dock launch (launchd its parent), whatever `launchctl setenv` says; with
  `RETAKE_TEST_SLOW=1`, a fixture capture on its timeline too); by hand: MACOS-CHECKLIST 14a (Finder, picker, keys,
  drag & drop, the Player playing, Quit during a capture, the notification permission, a banner and its click). Not
  yet: native pickers for the Studio's path fields, signing and an installer (BACKLOG BL-125, BL-36).
- **The standalone app's payload (L5.16, in progress).** `node apps/desktop/scripts/bundle.mjs stage --out <scratch dir>
  [--ffmpeg <dir with ffmpeg and ffprobe>]` stages, offline, everything the app will carry in
  `Contents/Resources`: this Node.js (major 22, re-signed ad hoc), the engine (`pnpm deploy --prod`, hoisted, without
  maps or `.d.ts`), the Chromium and headless shell revisions the engine's playwright-core pins (copied from
  Playwright's cache, never downloaded), Remotion's compositor relinked to `@loader_path`, ffmpeg (relocatable builds
  only; without `--ffmpeg` the system's is used), the starter themes, the Claude plugin, the licences and `bundle.json`
  (versions, relative paths, sha256, sizes). ≈ 980 MB with ffmpeg. `bundle.mjs check <dir>` re-runs its layout check
  (links relative and inside, no file with a second hard link, no path of the build machine in any text file, one
  playwright-core, the browser markers empty). The stage never writes the checkout: pnpm hard-links the injected
  workspace packages to the repository's files, so the stage gives each of them a copy of its own before writing
  anything, copies only git-tracked templates and skills, and ends by comparing the checkout's `git status` (and the
  bytes of every file it lists) with what it was. The staged engine runs as is: `<stage>/node/bin/node
  <stage>/engine/dist/bin.js doctor` names every tool `bundled` (a damaged `bundle.json` is an "App bundle" FAIL line,
  never a crash). Nothing writes inside a bundle (a workspace or one of its folders there, a project folder linked into
  it, a `$RETAKE_HOME` there, any command's `--out` there, or a component preview next to a built-in component, is
  refused; from it, `components preview --all` means `--workspace`). Licences: `apps/desktop/licenses/` holds our
  ffmpeg's notices and written source offer, and the notice of Remotion's compositor (its own GPL FFmpeg build; the
  stage refuses a compositor version the notice does not name). That compositor build also compiles in fdk-aac next to
  the GPL (BACKLOG BL-138): a licence risk accepted on 2026-11-04 for the releases this repository publishes — public
  GitHub releases, so a distribution to anyone who downloads them, not only our own use — to be resolved before any
  sale. The app and its DMG: [Install the app
  (macOS)](#install-the-app-macos).
