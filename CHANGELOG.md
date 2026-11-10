# Changelog

What changed in each version of Retake, newest first. The paragraph under a version's heading is what the desktop
app's update sheet shows (plain text: `scripts/publish-update.mjs` reads it at release time), so write one for every
release — for the person about to click Install and Restart.

## [Unreleased]

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
