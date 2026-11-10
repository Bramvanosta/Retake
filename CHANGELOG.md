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

### Fixed
- The Studio's Set-up sheet: after Install or Uninstall of the `retake` command, the keyboard focus lands on the
  command's next action once the sheet shows the new status, instead of being lost when the status came back late.

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
