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
- On a Mac, a render on the GPU path (from a terminal, or from the Studio or an MCP client of a checkout) now encodes
  the video's frames with your own ffmpeg (the one `retake doctor` shows) when it is recent enough and runs the
  encode. Measured on one Mac under load, on one 1-minute 1080p render: about a fifth less CPU, no measured gain in
  render time, files 1.5–2 % larger. The picture is the same to the eye (SSIM of the worst frame ≥ 0.995 against the
  previous encode on that render), not to the byte. Renders on the software path keep the previous encode (the gain
  measured there is too small for a default), and so do renders in the desktop app (not verified there yet).
  `render: {ffmpeg: library}` in `retake.yaml` (or `RETAKE_RENDER_FFMPEG=library`) gives back the previous encode
  everywhere; `ffmpeg: own` asks for your ffmpeg on any path. `retake doctor`'s Renders line names the ffmpeg.
- The first render or component preview after this update rebuilds its render bundle once, and the Studio draws its
  library previews again once (the files they are built from moved). Pictures are unchanged: compared byte for byte
  on the software render path.
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
- A new theme's name holds at most 60 characters, whatever makes it: `retake theme create`, a copy in the Studio (its
  name fields stop there and say the rule under the field, and the name it proposes for a copy fits),
  `template_create_from_brand`. A copy accepted 64 before. A theme that exists under a longer name keeps working:
  listed, opened, edited, previewed, rendered with, copied from (up to 100 characters).
- One rule says what a theme's name is where a theme is read by its name: letters, digits, `_` and `-`, at most 100
  characters. A theme a project names by a path still loads and renders whatever its folder is called; the project
  board, a render's theme in the lists and the Studio's sentence about a proposal name that theme only when its
  folder's name is one (the sentence quoted a folder name with a dot and stopped at 64 characters before).
- A render's version is at most 999999. When a file of `renders/` already claims that version or more for a scenario,
  a new render or plan of that scenario is refused with the file's name ("Remove or rename that file, then render
  again") — two renders never get the same id. A name with a higher version is not a render id any more: such a file
  is not listed, reviewed, commented or exported, a tool refuses it as it refuses any other name that is no render
  id, and `latest` never names it.
- `retake prune` and `project_prune` never read "threads that cannot be read" as "no thread". When a comment thread
  file is broken, a link or in the wrong folder, or a scenario's folder of `comments/` is a link, every render and take
  of that scenario stays (a folder of `comments/` that differs from its scenario by case only counts for it); when
  `comments/` cannot be read at all, or holds more thread files than a listing reads, every render and take stays.
  The result says so (a warning line, `threads_unread` in `--json` and in the tool's data), and reviews of renders
  that are gone can still go.
- `retake prune` counts the last renders of a scenario among its renders only: the records named `<scenario>-v<N>` as
  Retake names them. Another record of `renders/` — a video written there under a name of its own, a name past 200
  characters or with a version past 999999 — never takes a render's place: it stays, with its review and its take,
  when it succeeded, and goes only when it failed or was cancelled. A record whose id is empty or starts with a dot is
  never a prune item.
- An id longer than 200 characters is not a run id or a render id anywhere: a run folder or a render record with such
  a name is not listed (it could not be opened before either); prune never deletes such a run folder, and treats such
  a record as it treats any record that is no render (above).
- `retake render … --run latest`, `retake plan` and a render's `latest` no longer take a run folder named
  `<date>-<time>-` with nothing after it, or with a line break in its name, for a run of the scenario its name ends in.
- A comment and a frame of a render are refused when the record's id is not exactly `<its scenario>-v<N>` (a
  hand-edited record: `quote-v2-v1` filed under scenario `quote`). A comment thread file that does not read as a
  thread, whatever it holds, is reported by the comment list, and the other threads are listed.
- An MCP tool's error names the guide page about it (`docs`, its web address as of this version's release tag) when
  there is one.
- `retake doctor` and `retake list` say "theme" where they said "template" (the check names stay).

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
