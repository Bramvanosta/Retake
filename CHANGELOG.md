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
- `latest` means one thing everywhere — `retake render` (with no `--run`, or `--run latest`), `retake still`,
  `retake plan <project> latest`, `retake export-capture <project> latest`, the MCP tools `plan_preview` and `render`,
  and the Studio's Render, timeline and board: **the newest capture of the scenario that succeeded and has its
  timeline and its film in its folder**. A newer take that failed, was cancelled, is still filming, lost its film or
  its timeline, has files that are symbolic links, or was written by a newer Retake is passed over instead of being
  edited (a failed take's partial film was rendered before) or failing the command. A run you name (`--run <id>`, a
  run folder, `run_id`) keeps working whatever its record says — also with a `timeline.json` made by hand that holds
  no run id or names no film (the film is then `capture.mp4`), which only `latest` passes over
  (`its timeline does not read`).
- When `latest` passes over newer captures, the command says so on one line (stderr; nothing with `--json`, whose
  output is unchanged), with each run and a fixed word for the reason — `failed`, `cancelled`,
  `not finished, or interrupted`, `its film is missing`, `its film is not a file of its folder`,
  `its timeline is missing`, `its timeline does not read`, `its timeline is of another scenario`, `a dry run` (a
  record that says capture beside a timeline that says dry run), `written by a newer Retake`,
  `its status is not one Retake writes`, `its files are links`:
  `! run 20261001-100000-quote is used: 1 newer capture of "quote" passed over — 20261002-100000-quote (failed) (name one with --run <id>)`
  (`retake plan` ends with `(name one in place of "latest")`; past five runs: `…; and 3 more`). A capture whose
  record still says it is running is said the same way —
  `… passed over — 20261002-100000-quote (not finished, or interrupted) (name one with --run <id>)`: a render started
  while a newer capture of the scenario is filming renders the previous one and says so, and a take whose process
  died before it closed its record can be named. Newer run folders whose `run.json` is missing (beside a timeline) or
  does not read as a record are counted on the same line, never named:
  `… ; 1 newer run folder without a run.json that reads as a record was not considered (name one with --run <id>)`.
  At a terminal the film of a take `latest` picks is one file name of its folder: a take whose timeline names its
  film by a path (`sub/film.mp4`) is passed over (`its film is not a file of its folder`) and still renders by name.
- A capture stopped with `--until` is still the latest capture, and the command now says where it ends:
  ``! run 20261002-100000-quote stops at step catalog.1 (`--until`): the capture holds the scenario up to there``
  (`stops early` when `run.json` does not name the step as a scenario does: no text of a run's files is printed as the
  file has it — a scenario or a film a timeline names is shown on one line, without control characters).
- When no capture can be edited, the error says why, with counts and no folder name:
  ``no capture run of scenario "quote" in …/runs: capture one with `retake run <project> quote` — 1 capture of it cannot be edited: failed (1)``,
  and, for run folders without a readable `run.json` (a folder assembled by hand),
  ``1 run folder without a readable run.json was not considered (name one with `--run <id>`)`` (through MCP:
  ``name one with `run_id` ``). When the only captures were written by a newer Retake, the error is still the one that
  asks to update Retake (through MCP it names no run: `the newest capture of scenario "quote": this run.json is version 2: …`);
  a newer dry run is never counted as a capture.
- Through MCP, `plan_preview` and `render` say the same in their text with a count and no run name —
  `1 newer capture of the scenario passed over: "untrusted.passed_over" names it`, and
  ``run <id> stops at step catalog.1 (`--until`): the render shows the scenario up to there`` — and their data gains
  `passed_over` (the count), `not_considered` (the count of newer run folders without a `run.json` that reads as a
  record: `1 newer run folder without a run.json that reads as a record was not considered`), `until`
  (`{scene, step}` when they read as a step) and `untrusted.passed_over` (`[{run_id, why}]`, at most five; `why` is
  one of a closed list: `failed`, `cancelled`, `not-finished`, `no-film`, `film-outside`, `no-timeline`,
  `timeline-unreadable`, `scenario-mismatch`, `dry-run`, `newer-format`, `unknown-status`, `linked`, `outside`).
  The tool list is unchanged.
- Through MCP a render reads a run of the project only: a run whose folder lies outside the project once symbolic
  links are followed (a linked run folder, or a `runs/` that is itself a link to another disk) is refused when it is
  named — `run <id> is a link to a folder outside the project: …`, or, when a folder above it is the link,
  `run <id> lies outside the project (its folder, or a folder above it, is a link): through MCP a render reads only the runs inside it` —
  and is never `latest` (it is counted with the captures passed over, as `it lies outside the project`); the film a
  named run's timeline names must be a file of that run's folder (one file name, no path), else
  `run <id>: the film its timeline names is not a file of the run folder: through MCP a render reads only the film inside it`;
  and a named run whose `run.json`, `timeline.json` or film is a symbolic link is refused:
  `run <id>: its files are links: through MCP a render reads only the files of the run folder itself`.
  At a terminal nothing of this changes: linked runs and a `runs/` on another disk render by name and as `latest`
  (a run folder that is itself a link is never `latest`; name it).
- Run folders have one order everywhere (`latest`, `retake plan … latest`, `run_list`, every list of the Studio): the
  dated folders Retake makes first, newest first, then folders named by hand. A hand-named folder that sorts above
  the dates (`zz-quote`) was first in some lists, and was what `retake plan … latest` planned.
- A run's scenario is the one its `run.json` names (its timeline must agree), not the end of its folder's name: a
  folder renamed by hand keeps its scenario, and a folder named after another scenario does not become its take.
- A `run.json` that is not a run record (an empty list, a file without a scenario or a status, a record in a state
  no run has: succeeded with an error, finished without its end) is not a run in the lists any more — `run_list`, the
  Studio — where it showed as a row of empty fields. It is said as what it is: `run_list` shows
  `- <id>: its run.json does not read as a record` (a row holding the id and `unread`, when no filter is asked),
  `run_status` answers `run "<id>" of <project>: its run.json does not read as a record (at <member>)`, and `latest`
  counts it (above). Only that makes a record unreadable: a word, a number or a block this version does not know —
  one a later version of the same format writes — never loses a run; it is kept as the file holds it, or left out. A
  run with a status Retake never wrote is still listed as `unknown`, and such a folder still renders when you name it.
- A run whose `timeline.json` is cut short or is not a timeline is refused with one sentence —
  `run <id>: its timeline does not read (timeline.json is not JSON)` (or `… is not a timeline`) — by `retake render`,
  `retake plan`, `retake export-capture` and the Studio's timeline, where a JSON parser's message showed.
  `retake review` then says the timeline is not available instead of failing on it.
- `retake export-capture <run>` of a run whose `run.json` does not read as a record writes a manifest without
  `run.status` and `run.env` (it copied whatever the file held).
- `retake run` refuses a scenario whose file name is too long for a run folder (about 185 characters and more):
  `scenario "…": its name is too long for a run folder, which is named after it (a run id holds at most 200 characters: … for the scenario's name) — give the scenario file a shorter name`.
  Such a capture was filmed into a folder no list showed.
- The scenario view's takes (`scenario_view`, `scenario_actions` of the Studio) each say whether Render can edit
  them (`take`), and the scenario view names the capture Render edits (`capture`, as `scenario_actions` does).
- `retake doctor` and `retake list` say "theme" where they said "template" (the check names stay).

### Fixed
- The Studio, in a project that keeps the captures' frames: Render and the timeline offer the newest capture (they
  never did there; with one capture they said there was no finished capture yet).
- The Studio's timeline opened without a chosen take shows the take Render edits; after a failed, cancelled or
  still-running capture it showed, or failed on, that one. The board's capture of a scenario is that same take — also
  when more than twenty newer runs of the scenario cannot be edited (Render then said there was no capture).
- A dangling link in `runs/` no longer makes `latest` answer that there is no capture run.
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
