# The Studio

The Studio web app (`retake ui`), screen by screen. Part of the [Retake guide](README.md).

## Studio app

`retake ui` serves the Studio — a web app on your own machine — for the workspace (Phase 4, being built). It runs
the same engine and the same tools Claude uses over MCP, through the engine's local HTTP API, and needs nothing else
running: the MCP server keeps working without it.

- **The window (L5.9).** A fixed window of panes: the title bar (the open project › scenario, and the pipeline
  *Script · Shoot · Edit · Review* as the way between a scenario's screens — its blocks, Prepare and its runs, its timeline,
  its Review report and frame comments — L5.12a), the browser on the left (the projects, or the open project's productions, library, locations,
  cast and README; the workspace, the version and the worker at its foot), the screen in the centre (it scrolls; the bars stay), an inspector on the right where a
  screen has one, and the status bar (the connection, *live updates*, the worker, what a command answered). **Dark by
  default, following your system's appearance** (System Settings › Appearance: Light gives the light one, at once).
  **⌘K** opens the command palette (on a Mac; Ctrl+K elsewhere, outside a text field — on a Mac Ctrl+K stays a field's
  "delete to the end of the line"): go to a project, a page, a smart group, a location, a scenario ("Open quote"), a
  mode, the UI gallery — and, L5.11a, the scenario in context's **Rehearse**, **Capture**, **Render** and **Stop**.
  L5.12b: search *commands, scenes and themes* — its groups *Commands*, *Go to* (the modes, *Review report — last
  render v2 · 2 warnings*, the project's pages), *Scenes* (the scenes of the Script or Edit screen you are on: a pick
  selects the scene — on the YAML view, its lines —, or seeks to it in Edit), *Themes* (the theme of the take Edit shows, the project's, all themes: each opens the
  theme editor — the palette never changes anything by itself), *Scenarios*, *Projects*; on Review › Comments,
  *Comment at this frame*. ↑ ↓ move, Return runs, Esc closes. The *UI gallery* (the
  browser's foot, or ⌘K) shows every component of the Studio's design system in both appearances
  ([docs/reference/studio-ui.md](../reference/studio-ui.md)). The screens move onto that design one by one
  (L5.10 – L5.12); until then each keeps its content inside the new window.
- **Fonts.** The Studio bundles the Geist and Geist Mono variable fonts (SIL Open Font License 1.1: the licence is
  `packages/ui/fonts/LICENSE.txt`, beside the files) and serves them itself — no font is fetched from the internet.
  After changing a colour in `packages/ui/src/app/tokens.ts`, `pnpm -F @retake/ui gen:tokens` writes
  `tokens.css` again (a test fails while it is stale). The app mark ("two takes": `packages/ui/src/mark.ts`) is
  drawn from one source: after changing it, `pnpm -F @retake/ui gen:mark` writes the desktop app's icon files
  (`apps/desktop/icons/`) again (a test fails while they are stale). A screen moved onto the design system lowers its row of
  `packages/ui/test/legacy-controls.json` with `pnpm -F @retake/ui ratchet` (the count of controls, roles, classes
  and tokens it still draws by hand; a row only goes down).

- **Welcome and the projects (L5.10a).** With no project open, Welcome shows the app (its mark, name and version, New
  project, the projects folder) beside *Recent projects*: every project of the workspace with its
  scenario and location counts, its last run (a shape and a word), its locations' *production*, *read-only* and
  *sandbox* flags in words, its folder; a project whose `project.yaml` does not load is listed with its first problem.
  New project is a command to copy (`retake new <slug>`). The title bar's project name is a menu: another project, or
  *All projects* (Welcome).
- **The Project screen (L5.10a).** *Productions*: a poster per scenario — its capture's last pictured step, its title,
  its state as a shape and a word (*Draft · not shot yet*, *Shot · ready to render*, *Script changed since the shoot*,
  *Rendered · clean*, *Render outdated*, *Failed at step 3 of proposal*…) and its length — with a search, a sort and
  *New scenario*. The grid is one keyboard stop: the arrows move, Return opens, Escape clears. Nothing selected, the
  inspector shows the project (its README, recent runs, recent activity); a selected production shows its length,
  content, last take, capture, render, review and location, *Open* and *Render* (the timeline). The posters reflow to
  the window (three a row at 1440 px, one at the desktop app's narrowest). The browser holds the open project:
  Productions and its smart groups *Ready to render*, *Needs a shoot*, *Failed*; the Library (Components, Themes); the
  Locations (clicking one shows its pages, the URLs the video shows and its personas in the inspector, even with a
  production selected); the Cast (each persona's session, its location under it; *Sessions* opens the Sessions panel);
  README and Record a scenario. With the inspector hidden (its button, ⌥⌘I in the app), what it shows moves under the
  grid. It reads the project in one call (`project_board`) and re-reads it only when something of the project changed
  — never at every step of a running take, never in a loop when `project.yaml` does not load (it tries again after 2 s,
  then 4 s…).
- **Search and recent activity.** A search box finds projects (name, slug, README words), scenarios, runs and renders
  as you type (every word as a prefix); *Recent activity* lists the jobs that wait or run (with their progress; one
  whose worker died says *interrupted*) and then what finished — Claude's jobs and your `retake run` / `render`
  commands alike. Both come from the workspace index, `<workspace>/.retake/index.sqlite`: a cache rebuilt from the
  files (delete it any time), never the source of truth. It needs Node.js 22.13 or later (`node:sqlite`); on an older
  Node.js 22 the Studio runs without search and activity.
- **Live updates.** A change on disk — a README edited in your editor, a run Claude started, a new project — shows in
  every open Studio tab within about a second (the server polls the workspace while a tab is open, never otherwise).
  The browser keeps one update stream to the server whatever the number of tabs (the others hear from it); the status
  line in the status bar says *live updates*, or *updates every 3 s* when it falls back to polling.
- **README editor** (L5.12b: on the design system — a tall text area, the save state in words, the character count and its
  cap beside Save / Discard changes). Plain text (no Markdown preview), saved with Save or Cmd/Ctrl+S as an atomic write of
  `README.md`. If the file changes on disk while it is open (your editor, a terminal, Claude: the update stream says
  so), the editor loads the new
  version when you have no unsaved text, and otherwise keeps your edits and says so; a save that would overwrite a
  newer file shows both versions — keep yours ("Save mine over it") or load the one on disk (your text stays there to
  copy). Unsaved text survives moving around the app; closing the tab asks first; if the session ends (the server
  stopped or restarted), the text stays on screen, read-only, to copy into the new one. The file keeps its line
  breaks (CR LF stays CR LF) and ends with one; 200,000 characters at most, that final line break included. A README
  that is not UTF-8 text, or a symbolic link leading out of the project, opens read-only with the reason (convert or
  replace it in your editor); one linked to another file of the project is saved into that file. A project without a
  README.md says that saving creates it.
- **The Scenario screen (L5.10b).** A storyboard: the browser lists the scenario's entries (the video, *Before
  filming*, each scene with its length and a bar, the cards, *After filming*: a click selects one and brings it into
  view); the title bar holds *View* (Board · YAML) and *Location* (pick another environment for Rehearse and Capture in
  this tab — Prepare and the status bar use the same choice, the take strip and the status bar say so; a reload goes
  back to the file's own, and a location project.yaml no longer has is dropped, said once). A run of the scenario in
  progress shows above the board and the YAML view alike (its progress, *Watch live*; Pause and Stop are the status
  bar's). Above the board, the take strip: *Pictures from*, the source run, the open comments, the location the runs
  use, what the last start came to. The board says how many steps and scenes the file has; each scene shows its
  frames three a row — two or one when the board is narrow (a small window, the inspector open) — the step's picture,
  its number, its verb and target ("Wait for …", "Wait 1.6 s"), how long it took and its state in words; a scene
  filmed only by a dry run says *no capture yet* beside its number. The cards sit between scenes as one-line cards.
  The frames are one keyboard stop: Tab into them lands on the first step of the selected scene (or of the first
  scene), ← → step by step, ↑ ↓ by column (across scenes), Home / End; ⌥ + an arrow moves the selected step, Delete
  removes it, drag a frame onto another's half, into a gap or an empty cell. The inspector shows what is selected: a
  step (its picture, its title, its form — the fields named in words, the target's *Other ways to find it*, the
  modifiers as switches —, what it does, Move up / Move down / Duplicate / Delete — the button keeps the focus, so Enter
  again moves it again —, *In this run*, its lines, *Show in the file*), a scene's facts, a card, the hooks, the video
  (its location: the file's own, and the one Rehearse and Capture use when you picked another). A selected step that
  disappears from the file (an outside edit) leaves its scene selected — never another step. *View › YAML* shows the
  file's numbered lines with each issue under its line, *Edit* opens the editor, and the inspector says whether the
  file is valid. The renders sit in a closed *Renders and review* section at the board's end (L5.12a: the queue with
  **Cancel**, the newest three renders with their verdict, and **Open the review report**). The points
  below come from earlier lots and still hold, in the board's words: a step's row is its frame, a scene's card is its
  inspector, the *Blocks* tab is the board and the *YAML* tab the YAML view, and the runs from the Studio sit in the
  take strip.
- **Scenarios as blocks** (read-only: edits are made in the file). A project's scenario names open the scenario screen: the video's
  settings and the notes at the top of the file (without editor directives such as `yaml-language-server:`), the setup
  and teardown hooks (each with its kind, what it does, *destructive* / *with rollback* in words and whether it needs
  a person), then each filmed scene as a card, numbered 1, 2, 3… — its page, the URL it opens (shown without any
  `user:password@`) and the one the video shows, caption, speed, layout and how long it took in the run; a scene filmed
  on two pages lists each page with its URL (or the scene it continues from) and says how the video lays them out —
  with its
  steps as rows: what kind of action (*click*, *select*, *type*, *wait*, …), what it acts on in plain words
  ("button “Request a quote”", "field “Bag size”"), its modifiers (*hold 1.5 s*, *zoom ×1.3*, *mark*, *irreversible*,
  …) and the real picture of that step from a run: a dry run's screenshot, the frame on screen at the end of a capture
  step (after its hold), or a failed step's error screenshot. *Pictures from* picks the run (by default the newest run
  that went to the end and kept a copy of the scenario; a newer one that stopped early or left no picture is named
  above the pictures). A step without a picture says why — not reached (and where the run stopped), changed or new
  since that run, its scene skipped, a step with two actions — and when the scenario changed since
  the run a banner says so (a step whose arguments did not change keeps its picture). Selecting a step (click, or the
  arrow keys, Home and End: the steps are one stop for the Tab key) shows it in the inspector: what the action does,
  its arguments, its lines in the file (*Show in the file* opens the YAML view there), what the run did, and what
  the run found on the page, in a box of its own (text the filmed site controls). The pictures are made when a step
  comes on screen (a 1,200-step scenario opens in a fraction of a second on a recent Mac), kept in memory only — never
  written to disk — and the screen follows the files: an edit of the scenario or a run of it that starts or finishes
  shows within about a second. Steps are numbered from 1 everywhere on the screen ("failed at step 3 of proposal"). A
  scenario of more than 2,000 steps shows its first 2,000 and says so (the YAML view has the whole file).
- **Editing a scenario's YAML.** The *YAML* tab shows the file; **Edit** turns it into a text box (no highlighting).
  ⌘S / Ctrl+S or **Save** writes it — with the file's own line breaks (CR LF stays CR LF) and a final line break — and
  the blocks show the result; the issues of what you type appear below it as you go. A save is checked like one Claude
  makes: a text with errors is not saved (the errors are listed with their lines, your text stays in the box), warnings
  save. What you type stays when you move around the Studio (closing the tab asks first; if the session ends it stays on
  screen to copy), and while it is unsaved the *Blocks* tab says block editing is off. If the file changes on disk while
  you type (an editor, Claude, a terminal), a banner offers to load it; a save then shows both versions side by side
  (*Save mine over it*, *Load the version on disk*). Because a script in a page cannot be told from your click, the
  Studio saves a scenario only as Claude could through MCP, and more strictly: its `setup`, `teardown` and `mocks` must
  stay as they were (they run on your Mac: edit them in your editor) — and while it has any, so must its `vars` and
  `env` (a hook reads them: a var templated into a shell line is part of a command); it never adds a character that
  reads as nothing or as a line break in an editor (a direction control, a zero-width space, a soft hyphen, a variation
  selector, a line separator, a carriage return without a line feed), and one the file already has stays only on its
  line, unchanged (an emoji's own joiners and selectors are fine). A file outside the project is said to be outside
  whether it exists or not. A file the Studio does not write — one holding a secret reference (`{{env:…}}`,
  `{{keychain:…}}`), a file outside the project, a theme folder, a carriage return without a line feed (an editor shows
  a line break there, YAML does not), one that is not UTF-8 or over 500,000 characters, a link to a file outside
  `scenarios/` — opens read-only with why and the lines concerned: edit it in your editor (move a secret to
  project.yaml). A scenario name is case-sensitive (`Quote` is not `quote.yaml`).
- **Moving, duplicating and deleting steps.** On the *Blocks* tab, drag a step by its grip (⋮⋮) to another place in
  its scene, to another scene or into an empty one — a line shows where it will go — or select it and press
  **Alt+↑ / Alt+↓** (past a scene's first or last step it goes to the previous or next scene); **Delete** removes it,
  and the inspector has *Move up*, *Move down*, *Duplicate* and *Delete*. Each edit is saved at once and rewrites only
  the lines of that step: comments, quoting, blank lines and line breaks elsewhere stay byte for byte (the comment
  lines just above a step, at its dash's column, move with it; a section header at another column stays). **⌘Z /
  Ctrl+Z** undoes (the exact earlier bytes), **Shift+⌘Z** redoes, and the buttons above the blocks name the edit; the
  history is per screen and is cleared when the file changes elsewhere (a save of the YAML tab included, said as such:
  it is not an entry of the history — undo it in the YAML tab). Undo puts back exactly a version the Studio showed or
  wrote; moving a step back by hand gives the same steps but not always the same bytes (a blank line or a column-0
  comment does not travel with a step). Alt+↑ on the first step (Alt+↓ on the last) says it cannot move. A copy has
  no `id` (ids are unique) and no
  `mark` (a mark names one moment), and a capture's `as` gets a suffix (`quote-2`) — the Studio says each. The same
  checks as a YAML save apply. Editing is off — and the screen says why — while the YAML tab holds unsaved text, for a
  file with errors or one the Studio does not write; a step written as a YAML alias or in a `[…]` list is moved in the
  YAML tab (an anchor, a tag or a comment after a step's dash travels with it). If the file changed meanwhile, your
  edit is not applied and **Apply it to the new version** offers to make it there (refused if that step is no longer
  at that place; off, with why, when the new version cannot be edited in blocks). A step moved within its scene since
  the run keeps its picture and says *moved since this run*: the picture shows it at its old place — a new dry run or
  capture shows it where it is now (a step moved to another scene shows no picture until then). A comment left on a
  frame follows its step to its new place, in another scene too (Claude's `comments_list` gives it as `step_now`).
- **Changing a step's values and adding steps.** The inspector shows the selected step's form: its arguments (a target
  as text, role and name, label, aria label, placeholder, CSS selector, test id, scope, index, exact), then its caption
  (text, kicker), hold, speed and mark — the fields that hold a value, the empty ones folded under *More: …* (a
  target's other keys under *Other ways to find it*). The fields come from the scenario language itself and check what you type
  before anything is sent (a number, its bounds, a name made of letters, digits, `-` and `_`); **Save** writes only the
  values you changed, each on its own line — a `click: Save` stays a shorthand when you change its text, and becomes
  `click: {text: Save, in: dialog}` when you add a scope; a field you did not touch is never sent (an empty `""` stays
  as it is). What a form cannot show (a list, a point, a scope written as a row, a URL with a user name, a value holding
  an invisible character, an overlay, code) is named and stays for the YAML tab, and so is removing a key from a
  `{…}` written over several lines or holding comments. If the step changes on disk while you type, the form shows its
  new values and lists what you had typed. **Add a step…** opens a palette of
  16 actions (open, click, double click, hover, type, press, select, wait, wait for, hold, screenshot, scroll, menu,
  date, notify, hook — a named hook the file or project.yaml declares, run off camera: L5.8): pick one, fill its form, choose where it goes (after the selected step, or the start or end of a
  scene) and **Add** — one new line in the file. A secret reference typed into a field (`{{env:…}}`, `{{keychain:…}}`)
  is refused with the reason, as Claude's would be. After a save the Studio says what it means for your video: a
  changed argument or hold changes what the browser does (a dry run shows it, a capture films it); a caption, speed or
  mark is only the edit (a render of the last capture shows it). If the file changed meanwhile, **Apply it to the new
  version** makes your change on the same step there — found again by its arguments and its rank among the scene's
  steps with the same arguments. It is refused when that step is gone, when its scene now has more or fewer steps with
  the same arguments, or when a field you changed no longer holds what your form showed (it was changed meanwhile: the
  form then shows the new value).
- **Off camera (L5.8).** A `hook:` step has its own badge (*hook*, "off camera: cut from the video") and moves, edits
  (its hook's name), duplicates and deletes like any step; the named hooks (`hooks:`) are listed in the hooks strip,
  by name, read-only — like setup and teardown they never change from the Studio. A scene with `offscreen: true`
  shows "off camera: played, not in the video"; scene options (that one included) are edited in the YAML tab.
- **Rehearse, Capture and Render: the status bar (L5.11a).** On every screen with a scenario in context (its own, or
  the one last opened or selected in the project), the status bar says its state — *Rehearsing · step 3 of 7 · Watch*,
  *Capture paused*, *Last take succeeded · 2 h ago*, *Idle*; its name first off its own screens; *on staging* when the
  tab chose another location — and holds **Rehearse** (no hooks, a screenshot per step), **Capture** (the setup and
  teardown hooks, the video) and **Render** ([the latest capture](editing.md#the-latest-capture) — the timeline's own on the Edit screen —
  with the file as shown), with **Pause** and **Stop** while a run of it is queued or running. *Rehearse* is the
  Studio's word for a **dry run** (`retake run … --dry`, MCP `run_dry`); the engine's own messages may still say "dry
  run". What would stop each is said before any click: one line in the status bar names the gate in a few words — *1
  hook to approve*, *protected location*, *uses a secret or an outside file*, *opens another site · add it to
  project.yaml* (a URL the scenario opens is on none of the location's origins), *read-only location refuses its hooks*,
  *the file has errors* (Open the YAML) — with **Command…**, a small popover that shows the exact `retake run …`
  command to type in a terminal, in full, beside its **Copy command** ("Copied" shows; Prepare also shows it as
  `node <repository>/packages/cli/dist/bin.js …` where `retake` is not on your `PATH`); the full reason is each button's
  description. In a narrow window the status bar drops whole pieces (the last take, the scenario's name) rather than
  cutting a word; its answers line goes after a few seconds and when you change screens. The server checks again when you start — the file as the
  screen showed it: if it changed meanwhile, nothing starts — and refuses a second run of a scenario while one waits or
  runs; a held key, a click and a menu command in the same instant start one run. The Studio never resets a sandbox,
  never stops at a step (`--until`) and never runs the hooks of a rehearsal: those stay `retake run` options. A start
  from the status bar stays where you are (the status bar follows the run; the scenario screen's take strip says how
  it ended, with the first line of a failed run's error); one from Prepare, or from a run's live screen (its outcome's
  **Rehearse again** / **Start capture**), opens the new run live. **Stop** runs the teardown and rollbacks (a run
  started in a terminal: press Ctrl-C there; with a Studio run of the same scenario going too, Stop acts on the Studio
  run). A stopped run says *stopped* everywhere. In the desktop app the **Scenario** menu
  binds **⌘R** Rehearse, **⇧⌘R** Capture, **⌘B** Render and **⌘.** Stop (a live screen's Stop, a live recording's, or
  the status bar's — one Stop at a time); in a browser tab those keys stay the browser's and **⌘K** offers the four.
  On the Project screen, a production's **Render** acts the same way. A capture whose sessions must be confirmed asks
  first in a sheet: **Sign in … first…** (the default: it opens Prepare at that persona's Sign in), **Capture anyway**
  (once), Cancel.
- **Watching and pausing a run** (L4.4).
  Every run the worker executes — the Studio's or Claude's — can be watched live: the worker serves a small picture of
  the page the run acts on (at most 960 px wide and 10 frames a second) on a loopback port of its own, kept in memory
  only and sent only while someone watches, from the first scene to the end of the last — never the sign-in before it,
  the hooks or the teardown. A run — dry run or capture — can be paused between two steps (never inside a step): it
  waits, its `run.json` says before which step, and resumes where it stopped; **Stop** still runs the teardown and the
  rollbacks, paused or not; a pause longer than 30 minutes (`RETAKE_PAUSE_MAX_MIN`) stops the run, since a paused
  run holds the worker and its sessions. A **capture does not film the pause**: the last click's ripple plays out
  first, then the capture clock stops and the recording with it, at the same instant; on resume the video goes on from
  that instant, so not a frame of the pause is filmed — `capture.mp4` and the timeline are the take without the pause,
  plus the end of the last click's ripple the pause let play out first (at most 0.65 s; measured 0.54–0.56 s on the
  test board, and 0–1 ms of the pause itself). The pause is listed in `timeline.pauses` with the same length as in
  `run.json`, and its time and CPU are left out of the perf report. The page itself keeps running meanwhile — timers,
  animations, the product's clock: what it shows after the resume is what the video shows, a visible jump at that point
  when something moved (the run warns "paused once (… s, not filmed)"). A sign-in window opened through the worker
  (`auth_login` headed) closes by itself after 30 minutes (`RETAKE_SIGNIN_MAX_MIN`): it holds the worker while it is
  open. A stopped sign-in (Cancel, the time limit) writes no session file and no status — but a persona that already
  has a browser profile signs in **on** it, so what the window changed there (cookies, storage) stays and the next run
  starts from it; a first sign-in leaves nothing.
  The Studio follows a run from the run's own log (steps, each persona's sign-in check, the log, pauses) — for a run
  started in a terminal too, without its picture — and relays the picture only while a tab shows it: a hidden tab or
  the picture switched off closes it, and **during a capture the picture is off unless you ask for it** (it costs
  Chromium CPU during the take — about 15 % more on the fixture's 32-second two-page `live-quote` take, the
  recording itself unaffected; a rehearsal shows it by default). A capture filmed while someone watched says so: run.json
  `perf.live_preview` (the seconds the picture ran, the frames sent) and a run warning. At most two tabs follow runs at
  once. Starting a **capture** whose scenario needs a persona whose saved session is invalid (expired, failed, never
  signed in) and that no run signs in by itself asks you to confirm first: sign in, or capture anyway. A run signs a
  persona in by itself when it has `login:` steps **and** every `{{env:…}}` they use is set for the worker (the Studio
  checks the environment of the worker it starts, names a missing variable and never shows a value; a keychain item is
  not looked up — it is taken as there). The confirmation says what really happens: a persona with a `check` (or never
  signed in) is checked before filming and the run stops there if it is still invalid; one without a `check` cannot be
  — its saved session is used as it is, and the run fails only when a page lands on the sign-in page, after its setup
  hooks ran.
- **Shoot: Prepare a take and a run live (L5.11a).** *Shoot* (⌘2, or `#/p/<project>/s/<scenario>/run`) opens
  **Prepare a take**: four checks before the browser opens, nothing run — the **Location** (its flags, its pages and
  what the video shows instead; changed in the title bar, shared with the scenario screen), the **Sessions this run
  signs in with** (each persona's last known state as a shape and a word, its last check, what a run does with it, and
  **Sign in…**: a browser window where *you* sign in — none for a sandbox account or a persona its login steps sign in;
  *A capture asks first* when one must be confirmed), **What would
  stop a run** (each refusal in full, with its command to copy; *A rehearsal skips the hooks, so it is not affected*),
  and the **Live picture during a capture** (off by default) — then **Start rehearsal** and **Start capture**, each
  with what stops it beside a disabled one, at the foot of the window while the checks scroll. The browser lists the scenario's runs (each opens its screen); the
  inspector the last take (its picture, outcome, length, steps, run; **Open in Edit**, **Open its run**). A started run
  opens **its live screen**, for any run of the scenario, the Studio's or Claude's (a run started in a terminal: steps
  and log, no picture): *Rehearsal of quote* / *Capture of quote*, the current step, when it started and where; the
  **live picture** of the page (a rehearsal's on by default, a capture's behind **Show live picture**; *Not recorded*;
  it stops while the tab is hidden); the steps done and the time elapsed; in the inspector the **steps** as the run
  lists them with their status in words — *Before filming* (each persona's sign-in check, the setup hooks), the scenes
  (a `hook:` step's entries on its row), the teardown, the rollbacks, the encoding; *Follow current step* — and the
  **log** (the last 1,000 lines, warnings only on request). The status bar holds **Pause** / **Resume** (before the
  next step; a capture does not film the pause) and **Stop** (*the step in progress is interrupted; its teardown hooks
  and pending rollbacks still run*). Once it ended: how, the steps done (a failed step is not done), where it failed —
  a step's error, which may quote the page, in a box saying so; an error of the tool said plainly —, how the teardown
  and rollbacks went, then **Open in Edit** (a capture), **Start capture** (a rehearsal that passed) or **Rehearse
  again**, and **Back to the board**. A run whose worker was killed shows its running step as *interrupted*. A third
  live screen (two at most follow runs) reads the run's status every few seconds instead. Everything works
  with the keyboard; one status line tells a screen reader when the run starts, pauses, stops or ends. The **Cast**
  (the browser's *Sessions*) lists every persona by location with the same rows and **Sign in…**. A start from
  Prepare puts the keyboard focus on the live screen's title; a refusal shows its words and takes the focus.
- **Edit in the shell** (L5.12a). The Edit mode gives the take the window: the browser pane is hidden (the modes and ⌘K
  still go everywhere), the preview fills what the tracks leave, the transport sits under it (Previous frame, Play,
  Next frame, the time and frame, Unmute, Speed, Comment, Fit / Zoom in) with the take's facts, the tracks under that
  (the scrubber with time labels; the playhead drawn over the lanes — a 1,200-step take repaints nothing but it), the
  switches in the inspector (the selected segment first — its times and steps, said when you select it — then the
  whole video, the general hint last; every choice a chip, one that cannot be taken stays reachable with its reason).
  Every track item is a 24 px target (ticks crowded together are nudged apart while the lane has room; Zoom in spreads
  them). After a click on a transport button the arrows, Home and End still move the playhead (after a Tab they move
  along the toolbar); on the scrubber [ / ] and Shift + ← / → do what the keys line says. The status bar is Edit's:
  what is on screen in plain words (*Today's edit of take …*, *The take as it was captured*, *The edit Claude proposed
  …*), the newest render (its verdict, *from this version*, its report), **Cancel the render** while one goes, **Undo**
  · **Redo** (⌘Z pressed while a switch is still being written waits for it and undoes it after — it says so; if that
  switch is not saved, the undo is cancelled and said, never the switch before it undone), and **Render** — ⌘B and the
  palette are this button: it renders the capture and the file shown, refuses a file changed since (and reads it
  again), and says why it renders nothing on a proposal's preview (also while the preview loads or cannot open). The take picker is the title bar's *Take*; the comments made on another take
  sit under the tracks, the take's warnings and notes in a closed *Warnings and notes*.
- **The Review report** (L5.12a; `#/p/<project>/s/<scenario>/review[/<render>]`, the Review mode's first view —
  then the one you used last; *View: Report · Comments (n open)* in the title bar). The newest render (or the one
  picked): its version, when, size, length and theme, what the review found in words (*1 error, 2 warnings, 4 notes* —
  never "passed": a review records what it found, not which checks ran); the **contact sheet** (the review's own
  sheets, asked one at a time, larger on click); the **checks**, grouped by family (video length, scene lengths,
  captions, cursor, camera and zoom, transitions and speed, targets on screen, blank or loading screens, text slots,
  capture and media, changes since the previous render, other) in one list the arrows move through, then *Nothing else
  found*; in the inspector the **selected check** — the frame it points at (made by the server from the render), its
  message, where and when, its check and code, and **Show in Edit** (the take, at that frame when the render shows the
  version Edit plans — else at its step, and Edit says the render was made from another version; a check with no frame
  on the version shown opens Edit at its step, or where it is, saying nothing). Then the renders (the queue with
  **Cancel**, a failure with its message, the newest five, *Show all*, newest first — two that read the same *when* show
  their time of day; a row is a link to its report) and **Export**: **Export video (MP4)** queues the export job (1080p,
  into the project's exports folder, under the render's id; one at a time per render, two exports of the workspace at
  most at once; followed here and in the activity), and the raw capture for an editing tool is a command to copy
  (`retake export-capture <project> <run>`, see [Raw export for editors](editing.md#raw-export-for-editors)). The status bar:
  *Rendered · when · vN* (a neutral mark: what the render did, not a verdict), **Open in Edit**, **Render again** (the
  latest capture with the file on disk; a render you start here opens its report once reviewed). An unknown render says so and reads nothing. A file of `renders/` named like a render of the scenario that is not shown as one (its status is not one Retake writes, it lacks its scenario, its creation time or its plan, it is a link, it says another scenario or id, it does not read) is said under the list in one line per reason, with a count: *1 file of renders/ is not shown as a render: its status is not one Retake writes* (several: *2 files of renders/ are not shown as renders — for each, …*). Not yet: Show in
  Finder, other formats, "Open the step", the checks that ran (BACKLOG BL-132).
- **The timeline** (L4.5). The **Edit** mode (⌘3: the newest finished capture), **Open in Edit** after a capture on
  its live screen or on Prepare's last take, or **Show in timeline** on a
  step bound to a capture (`#/p/<project>/s/<scenario>/timeline[/<run>[/<step>]]`) shows one capture as the edit plans
  it — the edit of today's file on that take, or the take as captured when what the browser does changed since (it then
  says so). On top: the capture (a picker when there are several), the theme, the length, the frames, and the take's
  codec and keyframe spacing — a take encoded without the Mac's hardware encoder (keyframes seconds apart) says that
  scrubbing is slow on it. Then the **preview**: the edit drawn live by the Remotion Player, no render needed — exact to
  the frame when paused or scrubbing, close while playing; it starts muted (**Unmute**), says *Loading the preview…*
  until the frame asked is drawn, and a browser that cannot play the take's video (H.264: Playwright's own Chromium;
  Chrome, Safari and Firefox on a Mac play it) gets that said instead, the tracks still working. **Play** / **Pause**,
  one frame back or on, the time and frame, a playback speed, **Fit** or **Zoom in** (about ten seconds per screen,
  scrolled; the playhead follows while playing). Under it the scrubber and the **tracks**, each item placed at its
  frames and a button that seeks there: *Segments* (intro, scenes, cards, waiting screens, outro, each with its
  component; a transition shaded at its start), *Captions*, *Steps*, *Camera* (zooms with their ease in), *Speed*
  (each span's speed, a held frame under a transition, the cuts ✂ with their reason — an idle wait, a page load, a
  frozen screen, a busy wait, a hook step), *Markers* and *Comments* (the scenario's comment threads at their frames,
  read-only; those made on another take listed below). Keys: Space plays or pauses, ← / → one frame, Shift + ← / → one
  second, Home / End, [ / ] the previous / next segment — not while you type or in a choice group, and the scrubber's
  own arrows move it one frame. A segment picked (a click, [ / ]) shows from its first frame after the transition into
  it. A workspace component the take uses runs in the preview only once you click **Allow in the preview** in the
  notice that names it (with its folder's hash; for this Studio session — see [Security](security.md#security)); until then its
  kind's stand-in draws. The take's warnings and notes, and what the preview could not draw (a component that did not
  load or is not allowed: its kind's stand-in draws), are listed at the end. Beside the preview, the **inspector** switches in one
  click: for the whole video the caption component and every scene's layout; for the segment you select (click it on
  the *Segments* track, or [ / ]) a scene's layout (*Card*, *Browser*, *Laptop*, *Phone*, *Tablet*, *Full screen*, or a
  layout component of the workspace), its transition and its speed (1×, 1.25×, 1.5×, 2× or your own); a card's or a
  waiting screen's component and duration; the intro's and outro's component, duration, or *Off* — an intro or outro
  with its own text or files (a tagline, an image) is turned off or back to the theme's in the YAML tab, never by a
  click that would drop them. The video's layout offers *Split screen* / *Picture in picture* when a scene films
  several pages, and says so when a one-page layout would change no scene. *Theme default* (or *As the video*) removes
  the value from the file. A component the segment cannot take is shown greyed with the reason
  ("needs slots.before"). A click writes the scenario file at once — one line — and the preview shows it in about a
  tenth of a second, at the same frame; it changes only the edit: a render of this take shows it, no new capture. ⌘Z
  (or **Undo**) gives back the file's exact bytes, Shift+⌘Z redoes. If something else changed the file meanwhile, the
  switch is not applied: **Apply it to the new version** does it on the new file — unless that value itself was changed,
  which is then said, never overwritten. The arrows move between a group's choices; Space or Enter picks one. The
  preview is the render's own composition: against the render, frame by frame on the fixture, it shows the same frame
  of the capture, the same layout, captions, cards and fonts — text antialiased at the preview's size, and the capture's
  colours a few levels brighter than in the render (two video decoders: BACKLOG BL-108). Not in the timeline yet:
  durations by drag, text, variants and a theme picker (BL-107), playback frame-exact through speed changes and a
  lighter copy of the take for browsers without H.264 (BL-108).
- **Render and review** (L4.5; L5.12a: Render is Edit's status bar's, the queue, the renders and their reviews are the
  Review report's — above). **Render** renders the capture shown, as the screen shows it — the theme and options of your files (the timeline's own switches included), landscape — then reviews it in the
  same job (contact sheets at 1 fps, the checks, the report). If the file changed since the screen read it, the render
  is not started and the screen reads it again; while a render of the scenario waits or runs, Render is off (one at a
  time) and says why. You can keep switching meanwhile: the render keeps the version it was sent with. The renders (on
  the Review report, and in the scenario screen's card, where Render takes the newest finished capture) show the queue —
  *queued* (and what runs first), *rendering 43 % · about 12 s left*, *reviewing* — with **Cancel** (during the review:
  **Stop the review**, the render stays); a render that failed, with its message; and the renders, newest first, each
  with its size and length, whether it shows *this version* of the edit, and its review: *clean*, *2 warnings*, *1
  error*, *reviewing…*, *review failed*. A render's report (it opens by itself when a render you started is reviewed)
  lists the findings — **Show in Edit** goes to a finding's frame only when the render is of the version shown: the same plan (the same file, capture, options, fps and variant — a `retake render --no-intro`
  is another version, *with other options*) and the same theme files — and its images: the contact sheets, the scene
  sheets, the key frames and the diff with the previous render (at most 24), larger on click. A render that failed
  after the newest video is said in Edit's status bar too (*v4 failed — why: in the Review report*), its message's
  first line on the report (no path, no stack). Watching a finished render in the preview and other review settings
  from the Studio: BL-109.
- **Frame comments** (L4.6; L5.12b: Review › Comments in the window's panes). **Comments (N open)** in the Review mode's
  View (beside *Report*) opens the Comments screen (`#/p/<project>/s/<scenario>/comments`): the threads in the browser
  pane on the left — *Open*, *Resolved* or *All* (grouped Open, then Resolved), and *This render only* —, a render's
  own frames in the middle with the comment form under them, the open thread and Claude's proposal in the inspector on
  the right; the status bar says the render shown and the counts ("Rendered · … · v1 · 2 open · 3 resolved") beside
  *Open in Edit* and *Render*, as on the report. Pick a render (any finished one: an older
  version, a vertical cut) and a frame — the slider, ← / → one frame, Shift one second, or a time typed as `12.4` or
  `00:12.40` (the frame on screen then, as `--at`) —; the frame is made by the Studio server from the render file (no
  video plays in the page: every browser shows the same exact frame). Drag a rectangle on the frame for a region, or
  type it in the four % fields (left, top, width, height); *Where it points* shows the frame, the segment, the step (and
  where it is in today's file), the component, a marker, a transition — the anchor the thread will store. Write and
  **Post the comment**: the thread opens, written as the channel *Studio* under the name the Studio was started with
  (`$RETAKE_AUTHOR`, else your user name — the page never names an author). On the timeline, **Comment** (or C)
  opens the Comments screen at the playhead's frame when a render of the version shown exists (its frames are the
  preview's frames); a pin's tooltip has **Open thread**. A thread shows the comment, where it points, its entries with
  their channel (*Terminal*, *Studio*, *Agent · MCP* — how an entry was written, not who typed it), and Reply, Resolve
  (a note, optionally the newer render that answers it) or Reopen, each on the version of the thread you see: if Claude
  replied meanwhile, nothing is written and the screen says so with the new entry. A reply from Claude with a proposed
  change shows its summary (lines added and removed, its state). Every text in a thread is shown as text.
  **Claude's proposal** (the thread's newest) shows as a diff of the scenario file — "+" added, "−" removed, the line
  numbers before and after, a few unchanged lines around each change — computed by the Studio from today's file: what
  you read is exactly what Apply writes. Every row is on the page (never cut: Claude cannot store a diff longer than
  600 rows), and the buttons come after it. Lines are drawn as code: spaces at the start or end of a line show as `·`,
  a tab as `→`, any character you could not see (a direction mark, a zero-width or no-break space, a pile of accents
  past the third on one letter…) as `[U+…]`; a line with right-to-left letters is drawn in byte order and marked
  *right-to-left text* (your editor shows it in another order); past a quarter of the file it says the proposal is a
  rewrite. The buttons are what the Studio offers for it, and why not otherwise (nothing is offered when Apply would
  refuse it now — the reason is said): **Apply** writes it through the Studio's own checks and says any warning (then
  **Undo apply** puts the file back exactly, and the proposal can be applied again — in this tab, until it is
  reloaded: after that, the YAML tab or your editor); **Preview change** opens the timeline on the proposed edit under
  a banner (planned on the commented take, nothing written, switches and Render off; **Back to the comment** returns to
  the diff, where you apply it); **Apply and re-render** also renders the commented take on the file it wrote, follows
  the render in the thread and offers **Resolve with vN**. A theme change is never a proposal: Claude saves it and
  renders (the direct loop). Apply and re-render is offered for a landscape comment whose render used the files'
  theme and no option (the Studio renders that way); otherwise Apply, then render from your terminal or ask Claude.
- **Component library** (L4.7). **Components** in the project's pages (or *Open the library* on the project page,
  `#/p/<project>/library`) shows every component of the workspace by kind — the built-in library and your own
  `components/` — each card the component's poster in the project's theme; the *Theme* menu shows them in another
  (`#/p/<project>/library/<theme>`). Filter by kind, source and words: a kind's chip counts what it lists (the
  components of that kind and those that can also serve as one); in the full view a kind's section lists its own
  components, and *+ N more that can also serve here* picks that kind's filter. A tag says where it comes from: *Built-in* or *Workspace* (made in this workspace, by you or with Claude:
  the Studio cannot tell who). **Play** under a card shows the component moving — a looping GIF in place of the poster,
  marked *Playing · loop* — and pressing it again shows the poster; loops never start by themselves. (L5.12c, in the
  shell: the browser lists the Library — Components, Themes — and the project's themes, each showing the components in
  it; the title bar's *Theme* menu does the same; a click on a card selects it and the inspector shows its facts —
  kind, slots, length, whether its kit works here, the themes that pick it — with *Play in the theme*, *Open the
  details*, *Create with Claude…*, *Set as default…* and its description; the status bar says whether previews are
  queued, with **Render all loops** and **Open the theme editor**. By keyboard the grid is one stop: the arrow keys,
  Home and End move the selection, Escape clears it and Return on the selected card goes to its inspector; with the
  inspector hidden, the selected card links to its page, *Details*.) Posters and loops are rendered by the jobs worker (the
  component's code runs only in the render's guarded browser, never in the Studio) and kept in
  `.retake/cache/previews/`: posters of the cards on screen are asked 2 s after you stop scrolling or switch theme,
  12 components at a time, each batch once the previous one finished (a capture you start meanwhile goes first); a
  loop when you press Play or open a component; **Render all loops** the shown ones (about 1.5 s a loop once the
  worker has its bundle; the first one waits ≈ 20 s for it). A built-in's committed preview is
  its poster in the editorial starter. A preview that failed says why (as text) and is rendered again with **Retry** —
  or by itself once any component changed (a broken component of the workspace never fails the others: they are
  rendered with their own components); a batch that failed as a whole says why at the top of the page; nothing is
  queued while the disk has less than 1 GB free (the page says so — **Try again** after freeing space). A component's page (*Open the details* in the inspector) shows the picture large, its kinds, version, source, whether it works
  with this Retake's kit, its duration, formats, slots and params, which themes use it and its README as text.
  **Set as default of <theme>** makes it the theme's component for its kind (choose the kind when it serves several)
  after a confirmation sheet (Return sets it), with **Undo** (the theme file back byte for byte); a starter theme cannot be changed, so it is
  copied first to a theme of your workspace (name it — Return in the name field copies; the library then shows the copy,
  from the grid as from a component's page, with the result, **Undo** and *Open the copy* — your project keeps its theme
  until `template:` names the copy; *Open the copy* takes you to its theme editor, where *Use in this scenario* is). A
  component imports only its own files — never through a dot folder, `node_modules/`, `previews/` or `dist/` of its
  folder (their changes would go unseen by the caches): `retake components validate` names such an import.
  **Create with Claude…** opens a sheet that writes a prompt for Claude Code's component skill from a
  kind, an id and your words, to copy (**Copy the prompt**, the sheet's default) — the Studio calls no model — and shows
  the `retake components create <id> --kind <kind>` command; your words stay when you close it (until you leave the
  Library); the new component shows up in the library when its folder is written.
- **Themes** (L4.7). **Themes** in the project's pages (`#/p/<project>/themes`; *Open the theme editor* from the
  library) lists every theme — your workspace's, the starters, the project's own theme folder — with its colours, where
  it comes from, what uses it and whether the Studio edits it: a starter (or anything shipped with Retake, or a
  project's own folder theme) is read-only, and **Copy to edit…** copies a listed one into your workspace first (a sheet
  asks the copy's name — lower-case letters, digits and `-`, at most 60 characters; Return in it copies). A theme's editor (`#/p/<project>/themes/<theme>`) changes its brand (name, URL and the outro's URL as shown —
  `example.com/path`, no `https://` —, the outro's tagline; the logo
  and wordmark among the theme folder's own image files — add one there to pick it), colours (picker or hex, with the
  contrast checks; the cursor ripple can follow the accent), background (solid, radial or linear), type pair (the
  theme's own font files), style, zoom, cursor (filmed: the next capture uses it) and the component of each kind
  (switching keeps or drops the old one's params). Every change is written at once to template.yaml — comments and the
  rest of the file kept — and **Undo** / **Redo** (the status bar) put back the exact earlier bytes; if the file changed
  meanwhile (another window, Claude, you in an editor) the change is not written and the editor shows the new version
  (a colour's hex field included: leaving it then writes nothing).
  (L5.12c, in the shell: the fields are in the inspector — the browser's sections bring each one —, the browser also
  lists the theme's components, each opening its page in the library.) The **live preview** plays the theme's intro, a
  clip with its caption or its outro (one preview: pick the target above it; Play loops it); a colour being
  dragged shows there before it is written (on release). A workspace component the preview would run waits for
  **Allow in the preview**, as on the timeline. **Use in this scenario** sets a scenario's `template:` to the theme
  (Undo puts the file back): every existing take of it uses the theme at its next render, no new capture — the cursor
  style is filmed, existing takes keep theirs; the same choice is the timeline inspector's *Theme (this scenario)*. The
  project's own theme stays a hand edit of project.yaml. **New theme…** makes one from your brand (colours, a logo and
  fonts among the workspace's files, over a base theme) as Claude's template_create_from_brand does. **From a
  website**: the extractions already made (`retake theme from-site`, or Claude's template_from_site — the page's title
  shown as text) with **New theme from this**; for a new URL the Studio shows the command to copy — it never fetches a
  site itself (the extraction needs your approval of the URL).
- **Record a scenario** (L4.8). **Record a scenario** on the project page (or *Record a new scenario* on a scenario
  screen, `#/p/<project>/record`) records a flow by clicking through the product — the same recording as `retake
  record`, controlled from the Studio. The form takes an environment, a page and a path, the persona (with its stored
  session and **Sign in**) and a name; **Start** queues the recording and the worker opens a **real browser window on
  this Mac, full size** (the desktop layout is what the video films: keep it that size). Click and type in that window
  as you would for a colleague; switch to the Studio with Cmd-Tab (or keep it on a second screen) and come back to the
  window by its title bar — a click in the page is recorded, and a visit to the Studio commits the typing in progress
  (typing on in the same field still makes one step). Nothing you do in the Studio reaches the window: it shows the
  **live draft** (`#/p/<project>/record/<id>`), step by step as you act, with the steps the recorder added (a wait, a
  scroll) marked. A step whose target others matched says *n alternatives* on its right: press the row and they show
  under it as choices (the recorder's *Suggested*) — pick one and the saved step uses it (the recorder's wait and scroll
  before it follow). Pressing a row also puts the draft's cursor right after it: the **Insert** toolbar under it says
  *Insert after step n of <scene>*; press the row again (or *Back to the end*) to insert at the end. The draft is one
  Tab stop: ↑ / ↓ move through the rows (across scenes), Home / End, Enter or Space selects one — its choices and the
  toolbar come next in the Tab order, **Stop recording** a few Tabs on. **Quick inserts**
  go at the draft's cursor — at the end (following your next actions) or right *after* the row you choose, whatever its kind
  (after the recorder's scroll: between the scroll and its press; after its wait: between the wait and its press); the
  cursor stays on that row while the draft grows, and moves onto a hold or a wait you add, so the next one follows it:
  **Hold 2 s**, **Mark**, **Zoom…** (until the scene ends; the factors offered go up to the theme's `max_zoom` — 1.4×
  with the default and editorial themes, the default choice — so it is never clamped), **Wait for…** (the next target — a list's field by its
  label —, the page idle, or a text) and **Caption…** (a text and a kicker); a caption, a mark or a zoom made at the
  end waits for your next action and goes on it (*Applies to your next action*); each insert has **Remove** (a row's
  inserts under it once you select it). A
  password or another secret field shows as its `{{vars.…}}` placeholder only (a secret typed in two parts too: one
  placeholder). A text holding a hidden character (a direction control, a zero-width or line-separator character)
  never reaches the draft: its step is left out and said so. **Stop recording** closes the window (as closing it
  yourself does; in the desktop app ⌘. does the same while a recording goes — never a run of the scenario you had open,
  and Rehearse / Capture / Render wait, saying why, until it is over; ⌘K offers *Stop recording* and *Discard…* named
  after the recording), makes the draft and runs the check replay — it replays the draft **as recorded, without your picks
  and inserts** (none of them is checked; its counts are recorded steps, and its failing step is shown on its row, or
  as a recorded step when that row is gone): save, then dry-run the scenario to replay everything. **Save as new
  scenario** (it waits, saying why, until the check is over) writes a **new** `scenarios/<name>.yaml` (a taken name is refused: choose another) — exactly the draft on
  the screen: if its events, project.yaml or the arrangement changed since the screen read it, Save is refused and the
  screen reads it again — and opens its scenario screen; nothing is saved before you do, and the file has no YAML
  alias (the block editor can delete or duplicate the recorder's steps). **Discard** (after a confirmation whose
  default is *Keep it*: Return never discards) removes
  the recording, also while the window is open (it ends *Discarded*) or while the check runs (the folder goes when the
  job ends, even with no Studio open). One recording window at a time in the workspace; it holds the jobs worker while
  open, and stops by itself after 30 minutes; **Cancel recording** before the window opens never discards a window that opened
  meanwhile. A persona that cannot sign in by itself (no valid session, no `login:` steps) blocks **Start** and offers
  its **Sign in**; recordings Claude or `retake record` started are listed and shown read-only (already saved by their
  job), and so is one whose origin cannot be verified (its job gone) or whose files were changed after its job wrote
  them (*cannot be verified*: no Save). The recent recordings are Shoot's browser's **Recordings** on these screens
  (their state, saved or not; the open one live), and the status bar says *Recording · browser window open* with the
  counts while one goes. Not here: thumbnails per step, a picture of the window, editing steps before Save (BACKLOG BL-118), and
  recording through the live picture without a window (BL-25).
- **Sessions.** The project page lists every persona of every environment with its saved sign-in (*valid*, *expired*,
  *last check failed*, *never signed in*, *saved, never checked*; when and by what it was last checked) — the last
  known state: no browser opens to read it. **Sign in** queues a job that opens a browser window on this computer:
  you sign in there yourself, then close it (it may open behind the Studio's window, and closes by itself after 30
  minutes, `RETAKE_SIGNIN_MAX_MIN`); the row follows it (*waiting for the queue* while a run — a paused one too —
  holds the worker, *a browser window is open…*, then the result) with **Cancel** (*Stopped*: the saved session is not
  updated; on a persona's existing browser profile, what the window changed stays there). No password ever goes
  through the Studio. The capture's confirmation (a sheet) gives the focus back as it closes: Escape returns to the
  Capture that opened it, *Sign in … first…* to that persona's **Sign in…** on Prepare.
- **The jobs worker.** A run from the Studio is a job, like one Claude starts: the Studio starts the workspace's
  worker when you click (if none is running) and the worker exits after a minute without work. It gets a clean
  environment: your terminal's, without the folders a package manager adds to `PATH` (`pnpm retake ui` puts
  `node_modules/.bin` there) or any folder inside the workspace, without package-manager variables (`npm_*`: they can
  carry a registry token), the MCP HTTP token, model and agent credentials (Anthropic, Claude Code, OpenAI, Bedrock,
  Gemini and other model API keys — the tool never calls a model), GitHub / GitLab tokens, and anything that would make
  node load code from the workspace (`NODE_OPTIONS` naming a file, `NODE_PATH` / `DYLD_*` / `LD_*` entries inside it),
  and with `RETAKE_HOME` kept (your signed-in profiles). Secrets that an automated sign-in reads with `{{env:…}}`
  come from that environment, as for `retake worker` typed in the same terminal. Claude's MCP server starts the worker
  with the same clean environment, so whoever starts it — Claude or the Studio — it never carries more: the browser's foot,
  `retake jobs` and `retake doctor` say who started it (*worker running (pid 4242, started by the Studio)*). `retake ui` itself
  runs with the same cleaned `PATH`, like `retake mcp`. The worker runs your Studio jobs under the same rules as
  Claude's: no program from inside the workspace (`browser.executable`, `ffmpeg:`, `$RETAKE_CHROMIUM`,
  `$RETAKE_DOCKER`, the browser `$PLAYWRIGHT_BROWSERS_PATH` holds… there, or a relative path) and in `browser.args`
  only switches of a short list (window, language, colours, GPU, timers, proxy, features…) — the job fails before it
  starts the program and says what to change; the same run typed in a terminal is not affected (see
  [Workspace](workspace.md)). A tool variable pointing inside the workspace reaches the worker as it is, and the job
  that would use it fails with that message. The programs a Studio job starts — shell hooks, `docker`, a sandbox's
  services — get only the shell's own variables of the worker's environment (`PATH`, `HOME`, `USER`, the locale,
  `TZ`, proxy and certificate settings; `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and docker's other
  connection settings for docker) and the names project.yaml lists in `pass_env:`; a hook that needs a token the terminal exported reads it in
  its own `env:` (`{{env:NAME}}`) or through `pass_env:`. A hook that fails says which variables it got.
- **Text from files is shown as text.** Names, URLs, errors and READMEs never become markup or links, and
  right-to-left override characters are shown as visible marks (`[U+202E]`).

- **Keyboard, screen readers, browsers (L4.9).** Every screen works from the keyboard: *Skip to content* first, a
  visible focus ring on every control, the steps of a scene as one list you move through with the arrow keys
  (Alt+↓ / Alt+↑ moves a step, ⌘Z undoes), `[` / `]` and the arrow keys on the timeline, dialogs that take the focus,
  close on Escape and give it back. Controls are real buttons, fields and links with names; badges carry words and a
  diff row keeps its + / − (a colour is never the only cue); a selected step, row, chip or pressed button shows an accent
  bar or edge, not a tint alone; text keeps a 4.5:1 contrast. The look is the Studio's own — one blue accent, a closed
  palette, nothing from a video theme — and names the Geist pair first (shown where those fonts are installed; Safari
  shows system fonts; bundling the files is BL-120). In Safari turn on Settings → Advanced → *Press Tab to highlight
  each item* to reach buttons with Tab. The checks are automated in Chromium (`packages/ui/test/a11y.ts` and its two
  screen tours); the end-to-end acceptance runs in the installed Chrome, opt-in:
  `RETAKE_TEST_SLOW=1 RETAKE_TEST_CHROME=1 npx vitest run packages/ui/test/studio-e2e-acceptance.test.ts`;
  Safari, Firefox and VoiceOver are checked by hand (MACOS-CHECKLIST 13j).

- **One server per workspace.** The running server is named in `<workspace>/.retake/ui.json` (mode 600: its pid
  and port, no secret); its API token is kept in your Retake home, one file per workspace (`~/.retake/ui/<hash>.token`,
  mode 600). `retake ui` again opens that one with a new link and exits (with `--port N` naming another port, it says
  the running server keeps its own): it takes the port and the token from the home's file, never from the workspace.
  Ctrl-C stops the server and removes both files. A `.retake/` folder you cannot write is refused with what to do.
  A `retake ui` with another `RETAKE_HOME` (or a server of an older Retake on the workspace) says so and opens
  nothing: run it with the home that server was started with, or stop that server first. The other way round is not
  guarded: an older build's `retake ui` (or app) reads this record as broken, replaces it and starts a second server
  on the workspace — stop the older one before starting this one, and do not run both (see
  [Upgrading](upgrading.md#two-builds-on-one-workspace-the-studios-token-in-the-retake-home)). A Retake home inside
  the workspace (`RETAKE_HOME` set to a folder of it) is refused before anything starts: the token would lie where an
  agent reads files — set `RETAKE_HOME` to a folder outside the workspace, or leave it unset.
  What the token's place protects against: a program that can read or write the workspace folder and nothing else —
  an agent confined to it, a synced or shared copy of the folder — finds no secret in `.retake/` and cannot redirect
  the token. A program running as you that reads your Retake home can still use it: that program is you (the home
  also holds your signed-in profiles and the MCP HTTP token).
- **The link opens once.** It carries a one-time code (`http://127.0.0.1:<port>/#c=…`, valid 60 s) that the page
  trades for the session token, kept in that tab only (it survives a reload); a copy of the link — browser history,
  terminal scrollback — is dead after that. Another tab or browser needs a new link from `retake ui`. On macOS
  `retake ui` hands the link to your default browser through `osascript`'s input (`open location`), so it never
  appears in a program's arguments (which any process can list); if that fails it writes a private `.webloc` and opens
  that file, then removes it; if both fail it only prints the link. On Linux it runs `xdg-open <link>` (the code is in
  that command's arguments while it starts; it dies once the page used it, or after 60 s).
- **What the page may do** is an allow-list of tools (L4.1: `engine_info`, `project_list`, `project_get`,
  `project_update_readme`, `job_list`, `run_list`, and the Studio's own reads: `activity_list` and `search` from the
  index, `projects_overview` — every project card's environments and last run in one call; L4.2: `run_status` without
  waiting, `scenario_blocks` — a scenario read as blocks with its runs and each step bound to the run's pictures —,
  `run_thumbs` — small JPEG pictures of a run's steps, made in memory and never stored —, `scenario_run` — a dry run or
  a capture with its arguments pinned: the scenario, the mode and an environment, nothing else — and `run_cancel`;
  L4.4: `run_pause` — pause a run of a job (dry run or capture) before its next step, resume it —, `scenario_sessions` — the sessions a run of a
  scenario needs, with `has_check`, the login variables missing for the worker —, `auth_status`, `auth_login` — only
  the window where **you** sign in, never Claude's headless sign-in, never a wait — and `sign_in_cancel` — stop that
  window, nothing else; L4.5: `timeline_view` — a capture's timeline, its preview's two addresses on the preview's own
  origin, never the plan or a path —, `scenario_render` — a render of the capture shown with the review after it, the
  project, scenario, capture and the file's version as shown and nothing else (no theme, option or path) —,
  `scenario_renders` — the render queue and the renders with their review's verdict, no path —, `render_cancel` — a
  render or review of that project only —, `render_review` — a review without any path — and `review_image` — one
  contact sheet as a JPEG, by its name in the review folder, never through a link; L4.6: `threads_list`,
  `threads_counts`, `thread_get`, `thread_still`, `render_outline`, `render_frame` — one frame of a render as a JPEG,
  made in memory —, `frame_anchor`, `thread_add`, `thread_reply`, `thread_resolve`, `thread_reopen` and `thread_apply`
  — written as the channel *Studio*, never with an author, a channel or a proposal from the page, the writes on the
  thread's hash as shown; L4.7: `library_view`, `library_images` — posters (PNG) and loops (GIF) as base64, checked and
  capped —, `library_render` — at most 12 components' previews by the keys the library showed —, `library_component`
  — one component's detail, its manifest's words as text —, and the theme ops `theme_list`, `theme_view`, `theme_edit`, `theme_copy`,
  `theme_create`, `brand_files`, `site_list`, `theme_preview`; L4.8: the Record screen's `record_options`,
  `record_start` — a window on a page and a path of the environment, never a URL, never `--allow-writes`, its check
  always on —, `record_view`, `record_annotate`, `record_stop`, `record_discard` and `record_save` — a new scenario
  only, never over an existing one —, nothing of which reaches the window you click in), run with the trust an agent has
  through MCP and no approver: a page's script cannot be told from your click, so anything that needs your approval
  stays in the terminal.
