# Changelog

What changed in each version of Retake, newest first. The paragraph under a version's heading is what the desktop
app's update sheet shows (plain text: `scripts/publish-update.mjs` reads it at release time), so write one for every
release — for the person about to click Install and Restart.

## [Unreleased]

## [0.2.5] — 2026-11-11

Claude's connection to Retake restarts by itself after an update, a sandbox reset also puts back a Firebase Auth
emulator, a call-to-action button always reads, and a list's search can be filled at once.

### Fixed
- **The MCP server after an update.** A server Claude started before the update kept running the old engine. It now
  notices the new version at its next call, says so (`engine_info.stale`, and in the call's error) and stops, so that
  Claude starts it again on the new one.
- **Call-to-action button.** With a dark accent on a dark page the button's label was invisible. The button keeps the
  accent and its label is chosen against it; the review warns about a button label that does not read
  (`button-contrast`).
- **An address in a call to action through Claude.** The CTA's `url` and `qr` are shown or encoded, never loaded: an
  https address there is no longer refused as a remote file (images and media still are).

### Added
- **Sandbox resets beyond Postgres.** `reset.firebase_auth` puts a Firebase Auth emulator's accounts back as the seed
  left them at every reset; `reset.hooks` (http, sql, shell, exec) run at every reset once the data is back. The guide
  says what a snapshot covers: the Postgres database only.
- **`search_instant` and `search_cps` on `select` / `pick`:** the search filled at once (only the final list is
  filmed), or typed at its own pace.

## [0.2.4] — 2026-11-11

An update now shows how far it has got, and the app comes back under the icon you keep in the Dock.

### Fixed
- **An update you can watch.** After Install and Restart the sheet lists the steps — the download, the signature
  check, the jobs it waits for, the quit that installs and restarts — and says the one under way; the download shows
  its megabytes, its percent and a bar, in the status bar too, and on the app's Dock icon while you work in another
  app. A step that fails is marked.
- **One Dock icon after an update.** The updated app started while the old one was still quitting, so macOS gave it a
  second icon beside the one kept in the Dock. It now starts once the old one is gone, under that same icon. (The
  update to this version still restarts the old way: the fix takes effect from the next one.)

## [0.2.3] — 2026-11-11

The hooks of a sandbox use its demo accounts directly: no password to copy into the keychain, and a request can be
sent as one of the accounts.

### Added
- **Sandbox accounts in hooks.** On a sandbox environment a hook reads `{{compose_env:NAME}}` (the sandbox's compose
  env file) and `{{accounts.<persona>.username}}` / `{{accounts.<persona>.password}}` (its sandbox.yaml), masked like
  every secret.
- **`auth: {persona}` on an http hook** sends the request as that persona: the cookies of its saved session and, for
  an app signed in with Firebase, its ID token as `Authorization: Bearer …`.

## [0.2.2] — 2026-11-10

Signed-in pages of an app that keeps its session in the browser's database (Firebase sign-in) can be inspected and
filmed, a sandbox says what it is doing while it starts, and a long list with a search field is chosen from without
extra settings.

### Fixed
- **An automated sign-in that ended too early.** A single-page app signs in with a request, then stores its session
  (the Firebase SDK: in IndexedDB) and routes away; the sign-in browser closed right after the last step and saved a
  signed-out profile, so every signed-in page landed on the sign-in page ("the session expired during the run"). The
  steps' requests now end first, and the page gets a moment to leave the sign-in page.
- **An automated sign-in that did not hold said "signed in".** A persona without a `check` is now opened once more
  the way a run will see it: landing on a sign-in page fails the login, saying so, and nothing is saved.
- **IndexedDB in saved sessions.** A `storage_state` persona's snapshot holds its IndexedDB and a run restores it;
  a profile persona's travels in its profile, as before.
- **The skills' workspace check** compared the workspace with the session's working directory only: a session with
  the product's repository added no longer stops.

### Added
- **`retake sandbox up` and `reset` show their steps** as they happen — the compose files, the build, the start, each
  health check, the seed, the snapshot — on one live line in a terminal, as time-stamped lines otherwise; `--verbose`
  copies every line of `docker compose`, and the last line gives the time of each step.
- **`select` and `pick` search by themselves.** An option a long list has not rendered is typed in the list's search
  field; `search:` still types something else, and the error says when a list has a search field.
- **One page, several accounts.** Several personas (or sandbox accounts) may list the same page; the first one is its
  default and a scene films another with `persona:`.
- **`project_create`** (MCP) takes `{url, display}` pages and `default_env`; `project_get` says when the README's
  "Environments & links" section no longer matches the project's environments.

## [0.2.1] — 2026-11-10

Docker sandboxes work again from the app and from Claude with OrbStack, a sandbox can use compose files kept in your
product's repository, and Retake no longer says anything about an installation from before its rename.

### Fixed
- **OrbStack from the app and MCP.** A docker-compose sandbox failed with `unsupported argv0 "docker-tools"` when a job
  came from the Studio, the desktop app or an MCP client; the command line was not affected.
- **Compose files outside the sandbox folder.** `compose.files` may point into another folder (the product's
  repository): the paths inside those files (`env_file`, build contexts, bind mounts) resolve next to them, as with
  `docker compose` itself. A sandbox set up that way gets a new default project name: `retake sandbox down`, then `up`.

### Added
- **`{{compose_env:NAME}}`** for a sandbox account's `username` or `password`: the value comes from the sandbox's compose
  env file, so demo passwords are written once and need no keychain item.
- The guide says how to film several accounts of one app (one page key per account on the same URL).

### Removed
- **Everything about the name before the rename.** No start-up line, `retake doctor` group, Studio note or refusal
  about the old home, workspace file, tool folders or variables: they are simply not seen. Scripts no longer get the
  old variable names next to the `RETAKE_*` ones, and a theme or raw package made before the rename is no longer
  replaced in place.

## [0.2.0] — 2026-11-03

The first installable version: Retake as a macOS app with everything inside — its own Node.js, browsers, ffmpeg and
engine — a first-run sheet that sets up the `retake` command and Claude, and updates that arrive signed and install
only when you click Install and Restart.

### Added
- **The standalone app.** A signed `Retake.app` and its disk image; the command, the MCP server and the Studio run from
  the app's own files.
- **First run and Set Up Retake….** A workspace folder, the `retake` command, Claude Code and Claude Desktop, notifications.
- **Updates.** A check at launch at most once a day, "Update available" in the Studio's status bar, the release notes,
  then Install and Restart once no job is running.
