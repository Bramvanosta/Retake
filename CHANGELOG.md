# Changelog

What changed in each version of Retake, newest first. The paragraph under a version's heading is what the desktop
app's update sheet shows (plain text: `scripts/publish-update.mjs` reads it at release time), so write one for every
release — for the person about to click Install and Restart.

## [Unreleased]

### Added
- The workspace journal, `.retake/journal.jsonl`: every file Retake writes for you (a scenario, the README, a comment
  thread, a theme, a component, a new project, a sandbox scaffold) and every hook it runs, with who did it (you in a
  terminal, the Studio or Claude), when and how it ended — never a value or a secret. `retake journal` lists it.

### Changed
- The README block `retake components preview` (and `retake components create`) writes into a component of your
  workspace's components folder is an entry of the workspace journal too, written on the README as it was read.
- A component README that is a symbolic link out of the components folder is now refused, like every other authored
  write (the preview image and preview.json are still written, and the error says so); a README made while a preview
  renders is no longer overwritten.
- A sandbox scaffold (`retake sandbox init --force`) and the line it adds to project.yaml are written on the version
  just read: a file changed in between is reported as a conflict instead of being overwritten. `--force` over a
  sandbox that project.yaml declares in a folder outside the project is refused (its files are not written there).
- Two theme creations or copies of the same name at once: the second waits a moment, then is told the name is being
  created and to try again.
- A component scaffold (`retake components create`) and a new project (`retake new`, `project_create`) are refused
  when one of their files appears while they are being written, instead of replacing it.
- Claude (the MCP tools) is held to the same rules as the Studio before a job is queued: one run of a scenario at a
  time (`run_dry`, `run_capture`), one render of a scenario at a time (`render`), at most one export of a render and
  two of the workspace at once (`export`), and a capture whose persona's session is not valid and that no run signs
  in by itself waits until `run_capture`'s new `sessions_ack` names that persona (checked on the environment the take
  uses: a sandbox capture's accounts sign in by themselves). Each refusal is a `conflict` that says what it waits for
  and which tool follows up; a capture whose hooks waited for the user's approval is checked again before it is queued.
- `job_cancel` is marked destructive for MCP clients: cancelling a recording whose window is open discards it.
- The CLI prints these errors as one line instead of a stack trace: a scenario changed since it was submitted, a
  write or host refused on a read-only environment or by the allow-list, an agent's render refused, an export error,
  an unusable hooks source, a cancelled review, a full disk during a render.
- `retake new --theme` names the starter theme (`--template` still works).
- An MCP tool's error names the guide page about it (`docs`, its web address as of this version's release tag) when
  there is one.
- `retake doctor` and `retake list` say "theme" where they said "template" (the check names stay).
- Through MCP (and the Studio's agent path), an http hook with `auth: {persona}` sends that persona's session only to
  the persona's own pages — the origins of the pages it signs in to; a hook aimed at another origin is refused before
  it runs, naming the persona and the rule. A run you start yourself is unchanged.

### Fixed
- The Studio's Set-up sheet: after Install or Uninstall of the `retake` command, the keyboard focus lands on the
  command's next action once the sheet shows the new status, instead of being lost when the status came back late.

## [0.2.6] — 2026-11-11

The review now catches what client demos kept bringing up: a page still loading on screen, a zoom while the page
scrolls, a caption that says the opposite of the screen, an annotation lost at the end of a scene. Forms can fill in
one go.

### Added
- **Review checks:** `loading-filmed` (a skeleton, a spinner or a busy region the video shows; the take now records
  them), `zoom-during-scroll`, `caption-contradicts-ui` (a note) and `overlay-lost` / `overlay-cut` (an annotation
  dropped or cut by the end of its scene, until now only a render warning).
- **`type: {…, fill: true}`** fills a field at once, as a browser autofill.
- **Claude's scenario skill** gains the editing rules that hold for every product: loads off camera, the state rather
  than the path, no annotation on a scene's last step, readable speed, one zoom at most, live updates in two beats,
  captions true to the screen, the app's language and theme first, dates in next month, frame-by-frame look.

### Fixed
- **The end of an update.** While the app installs, its window is gone for a few seconds: the sheet now says so
  beforehand, the Dock icon shows ↻ meanwhile, and the restarted app says "Updated to vX" once.
- **`project_get` and a hand-written README.** Environment lines written with the name in bold, a note in
  parentheses, several pages on one line or a description after the URLs were reported as gone.

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
