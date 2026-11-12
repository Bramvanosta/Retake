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
- `retake run` (and `retake hooks run <scenario>:setup|teardown`) lists, as they will run, the shell hooks of a
  scenario whose hooks an agent wrote last (through MCP or the Studio) and runs them only on your yes — asked in a
  terminal, `--yes` in a script, refused otherwise; hooks you wrote or changed yourself run as before, and
  `retake hooks trust` makes an agent's hooks yours once you have read them.
- An sql hook an agent wrote is treated like its shell hooks: work submitted through MCP or the Studio asks your
  approval for each one (whatever the statement, bound to it like a shell hook), and `retake run` / `retake hooks run`
  list and ask about them with the shell hooks; your own sql hooks and sandbox seeds are unchanged.
- `retake prune` and `project_prune` keep the capture you can still edit. Per scenario they now keep the newest take
  whose record says the capture succeeded **and** the newest take that can really be edited (its timeline reads, its
  film is there) **and** the newest such take that was not stopped by `--until`. Before, a newer capture whose film
  had been removed, whose timeline was damaged, or that was a short `--until` test sent the older, complete capture
  to the list — the only one a render could still use. A run folder that is a symbolic link is no longer taken for a
  scenario's last capture and is never listed (deleting one only ever removed the link); a take written by a newer
  Retake is left alone. Prune lists nothing it kept before: it only keeps more, so it can free less — delete such a
  take by hand when you want its space. The output says what stayed and why (`kept  run  <id>  the last capture that
  can be edited`, per reason the first five takes and then a count; through MCP one line per reason with a count;
  `kept_takes` in the result and with `--json`), and the approval form of an agent's prune names these keeps. A
  `run.json` that is no regular file or is over 32 MB is no longer read by prune: its take is kept.
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
- Render records (`renders/<id>.json`) are read by one reader everywhere — `retake review`, `retake export`,
  `retake prune`, the MCP tools and the Studio —, and a render is the record of its own file: a copy of a record
  (`quote-v1 copy.json`), a record renamed by hand (`quote-final.json` that says `quote-v1`), a record file that is a
  link, a record written by a newer Retake, one whose status Retake never writes and one that lacks its scenario, its
  creation time or its plan are no longer listed or taken by `latest`; each is said instead. Only projects with such a
  hand-made, renamed, copied, linked, damaged or newer file in `renders/` see a difference:
  - `retake review|export <project> latest` takes the newest succeeded record of `renders/`, whatever its file is
    called (a render written with `--out` included, as before), and works on **that file** — before, it looked the
    id the record says up again and answered `render "quote-v2" not found` for a record renamed by hand. What it
    passed over is one line: `! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario,
    its creation time or its plan` (also `its record is a link`, `its status is not one Retake writes`, `written by a
    newer Retake`, `its record does not read`, `failed or cancelled`; then `! 1 file of renders/ does not read: not
    considered`).
  - A record renamed or copied by hand, named at a terminal, still exports and reviews, with one line: `! renders/
    quote-final.json says it is quote-v1` (`says an empty id`, `says an id that is no render id`). Its folders of
    `exports/` and `review/` are never another render's: when another file of `renders/` has the id it says — as the
    disk compares names, so `QUOTE-V1` is `quote-v1` on a disk that ignores case — they are named after its own file,
    and the line says so: `! renders/quote-final.json says it is quote-v1 — its exports and review are named
    quote-final` (before: it was exported into `exports/quote-v1/` and its review replaced `review/quote-v1/`, the real
    render's; an id with a control character, or over 200 bytes, names no folder either). It is refused when
    the video it names is now another render's: `✗ renders/quote-final.json says it is quote-v1, and renders/
    quote-v1.mp4 is now the video of another render: nothing to export — correct "file" in the record, or render again
    with --out` (before: exit 0 and the other render's video in `exports/quote-v1/`).
  - Named at a terminal: a record of a newer Retake says `…/renders/quote-v2.json: this render record is version 2: it
    was made for a newer Retake (this one reads version 1) — update Retake` (before: `… is not a render record`); a
    record without its plan `render quote-v2 has no plan (…/renders/quote-v2.json): nothing to export` (or `nothing to
    review`); a file that does not read `…/renders/quote-v2.json does not read as a render record (it is not JSON)` —
    `(status)`, `(id)`, `(version)` for the member that decides — instead of a JSON parser's message; a record without
    a status is no record any more (before: `render quote-v2 undefined: nothing to export`, and a review of it started).
  - Through MCP and the Studio, a render named by its id whose file is there is never "not found": `render "quote-v2":
    renders/quote-v2.json does not read as a render record (status)`, `… is a link: through MCP a render is read from
    its own file` (refused), `… says it is another render`, the newer-Retake sentence, `render quote-v2 has no plan
    (renders/quote-v2.json): nothing to read`. `render_status` answers a record without its plan or its creation time,
    and hands on a member that does not read as its type as its empty value (or leaves it out). Their `latest` (and
    `review`, `export`, `comments_list`, `comment_resolve` with `latest`) counts the newer files it passed over in the
    summary — `1 newer file of renders/ passed over: "untrusted.renders_passed_over" names it` — with
    `renders_passed_over`, `renders_not_considered` and `untrusted.renders_passed_over` (`[{file, why}]`) in the answer;
    `render_status latest` answers a record of a status Retake never writes as `unknown`, in its text and its answer.
    Their sentences quote no word of a record: a job of a record of such a status says `render quote-v2: its status is
    not one Retake writes: nothing to read`, an export of an unknown variant `its record says a variant this Retake
    does not export`, a missing video `the video of render quote-v2 is missing: its record names a file that is not
    there` (the path under `details.untrusted`). The comment list on a render named by its id reads a record bigger
    than a listing reads, as every by-id read does.
  - The Studio's list of a scenario's renders no longer shows a record of an unknown status as succeeded, nor a record
    of another scenario, without its scenario or without its plan; one line per reason under the list says what it
    did not show: `1 file of renders/ is not shown as a render: its status is not one Retake writes` (`2 files of
    renders/ are not shown as renders — for each, …`).
  - `retake prune` and `project_prune` leave every such file alone with the render and the take it names, and say so:
    `kept  render  quote-final.json  its record says another id`, `kept  run  <id>  a file of renders/ that is no
    render names it`; through MCP `1 file of renders/ left alone (no render of its own name, or a record that lacks a
    member), with the renders and the takes it names ("untrusted.renders_alone" names it)`; `renders_alone`, `renders_unread` and `untrusted.renders_alone` in the
    result. A record renamed by hand keeps its take however many newer renders there are (before: its take was offered
    once three newer renders existed, with a line `render quote-v0` for a file that does not exist), a render whose
    number was reused is no longer listed twice, `quote-v1.final.json` and `.mp4` no longer go with `quote-v1`, a
    record of a status Retake never writes and its video are no longer offered (`paused render`), and the takes of a
    record of a newer Retake or without a plan are kept. A file of `renders/` too big to read keeps everything: `1 file
    of renders/ is too big to read: every render, review and take is kept`. Prune's `kept:` line counts such files
    apart: `kept: 1 take, 3 renders and 1 other file of renders/` (`retake prune --json`'s `kept.renders` counts every
    record file that stays). A record whose variant is no text (`5`, `null`) is kept and counted in no scenario's
    window. Prune lists nothing it kept before.
- The Studio's search, its timeline and its frame viewer read `renders/` through the same reader, and a render is
  the record of its own file there too. Only projects with a hand-made, renamed, copied, linked, damaged or newer
  file in `renders/` see a difference:
  - A copy of a record (`quote-v1 copy.json`) or a record renamed by hand that says the id of another file of
    `renders/` no longer stops the Studio's updates: before, the search index failed on two renders of one id at each
    poll, and the Studio stopped refreshing the whole workspace on its own (runs, jobs, the activity, the search)
    while the file was there.
  - The search finds a render under its own file's name only: a record renamed or copied by hand, a record file that
    is a link, a record of a newer Retake, one without a status and one that says an empty id are no longer found; a
    record of a status Retake never writes is found with the status `unknown` (before: the file's word). A record of
    1 to 16 MB is found (before: left out).
  - The timeline pins a comment at its own frame (instead of at its step) only on a render that succeeded, read from
    its own file and made at the time the comment says: a record without a status, of a status Retake never writes,
    failed, of a newer Retake, or that says another id than its file's name no longer counts as the version shown.
  - A record whose plan is nested deeper than Retake can write it back no longer makes the Studio's list of the
    scenario's renders fail: it is listed, and it is no version the timeline shows.
  - The frame viewer answers as before.
- Through MCP (and the Studio's agent path), an http hook with `auth: {persona}` sends that persona's session only to
  the persona's own pages — the origins of the pages it signs in to; a hook aimed at another origin is refused before
  it runs, naming the persona and the rule. A run you start yourself is unchanged.

- Through MCP, `render_status` of a render named by its id — and the `render` tool's answer, which reads the same —
  holds outside "untrusted" only closed words and checked values, as `render_status latest` already did: a status Retake never writes is `unknown`; `record` holds the record's
  numbers, flags, words of Retake's (another word is `unknown`), ids, hashes and times that pass their grammar, the
  known options with a value of their kind; the record as its file holds it (without its plan, its warnings and its error) is `untrusted.record`. `record_file` is
  the file read, and `file` is `renders/<id>.mp4` as Retake spells it, only when the record names that file — another
  path is said to be in `untrusted.record.file`.
- Through MCP and the Studio's agent path, a sandbox's shell `reset.hooks` steps are asked about with its shell seed
  steps (listed as `reset hook <n>`, numbered within `reset.hooks` as the sandbox's messages are, each bound to its own
  phase and position: never shared with a seed step's approval) and run once approved. Before, they were never asked
  about, so a sandbox reset that had one was always refused there. An unapproved reset hook, or one changed since its
  approval, is still refused; a reset at a terminal is unchanged.
- The project board compares a scenario's theme with its renders' by the theme's identity — the name of the theme's
  folder, as the render record holds it —, also for a theme named by a path whose folder name is no theme name or whose
  reference is over 200 characters. Before, no theme was compared for such a theme and the row could show the newest
  render of another theme as current. The board's row says whether its render shows today's file (`render_current`).
- The project board tells two theme folders of one name apart. A render record now holds the theme's folder as the
  render loaded it (`template_folder`: `/starter:<name>` for a starter theme, else its path relative to the
  workspace), and the board compares that: a render made with `themes/brand` no longer reads as current for a scenario
  now on `../shared/brand`. Editing a theme still leaves its renders current. A render made before this version holds
  no folder and is compared by the folder's name, as before.
- An export's re-rendered formats (vertical, square) use the theme folder the render was made with. Before, they
  looked the theme up by its name, so a project whose theme is a folder (`./themes/brand`) re-rendered them with the
  workspace's theme of that name, or failed with "not found". Through MCP such a re-render uses only a folder the
  project names today (its `template:`, a theme of the workspace or a starter) and refuses another one; at a terminal
  it uses the folder itself.
- A sandbox's `sql` reset hooks get the seed's check: the database they rewrite must be served by the sandbox or
  marked `external: true`, checked before the reset changes anything, at a terminal as through MCP. Before, a sql
  reset hook's database was not checked (the hook simply connected to it).
- `project_prune`'s description names everything prune keeps (the capture that can still be edited, the last complete
  one, a run folder that is a link, a take of a newer Retake, the files of `renders/` left alone).

### Fixed
- A hooks journal whose rollback does not have its kind's shape (an http rollback without `request.url`, a shell one
  without `run`, a sql one without `db` or `query`, a js one without `code`, a member of the wrong type) is refused
  when it is read, naming the entry (`entries[1] (#2) has a malformed http rollback: …`), and nothing of it is
  replayed. Before, it was read, and listing it for `--replay-unsigned` stopped on a raw `TypeError`.
- `retake prune`, `retake review latest`, `retake export latest`, the comment list and MCP's `latest` no longer stop
  on `Cannot read properties of undefined (reading 'localeCompare')` when a file of `renders/` has no creation time;
  a review of such a record named at a terminal starts (with no render to compare with).
- `retake export` of a record whose variant this version does not write says `render quote-v2: its record says
  variant "cube", which this Retake does not export (landscape, vertical or square)` instead of `unexpected error:
  Cannot read properties of undefined (reading 'base')`; through MCP the export is refused in the same sentence
  without the word.
- A review of a record without its run id starts (before: `unexpected error: The "path" argument must be of type
  string`).
- A record whose id is empty or holds a path, named at a terminal, is exported into `exports/<its file's name>/` and
  reviewed into `review/<its file's name>/`: before, the export went straight into `exports/` and a review into
  `review/` itself.
- `retake export <project> <name>` of a record file that is a pipe answers at once that it is no file (before: it
  waited for ever).
- The Studio, in a project that keeps the captures' frames: Render and the timeline offer the newest capture (they
  never did there; with one capture they said there was no finished capture yet).
- The Studio's timeline opened without a chosen take shows the take Render edits; after a failed, cancelled or
  still-running capture it showed, or failed on, that one. The board's capture of a scenario is that same take — also
  when more than twenty newer runs of the scenario cannot be edited (Render then said there was no capture).
- A dangling link in `runs/` no longer makes `latest` answer that there is no capture run.
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
