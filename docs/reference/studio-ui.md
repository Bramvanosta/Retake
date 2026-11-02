# The Studio's UI — reference (« Épure »)

The Studio's look and its design system, exported from the design canvas the founder validated in four rounds
(2026-10-29; BACKLOG BL-124 records the decisions and where the canvas lives). L5.9 built the foundations — the tokens,
the components, the shell, the gallery; L5.10 – L5.12 rebuild the screens from them; L5.13 renames the product (the
canvas says "Retake"; the repository says "Demo Studio" until then — the page writes it in one place,
`packages/ui/src/app/brand.ts`, every screen included (a lint over the app's sources; the server's comments and the preview
bundle's generated header still name it, for L5.13).
Contracts and tests: DESIGN §4k. The gallery (`#/ui`, or ⌘K › UI gallery) shows every component below in both
appearances.

## Principles

- **A pro three-pane app.** References: Final Cut Pro, Logic Pro. A title bar with the pipeline as the one way to
  navigate (Script · Shoot · Edit · Review), a browser on the left, the content in the centre, an inspector on the
  right, a status bar with the state and the actions.
- **Panes separated by tone, not lines.** Centre ≈ `#111214`, panes ≈ `#18191c` in dark; hairlines inside lists only.
- **Three type sizes, two weights.** 13 / 15 / 20 px, 400 and 600, sentence case. Mono (Geist Mono, tabular figures)
  only for timecodes, ids and counts.
- **One blue accent** for the selection and the primary action; **red only for Capture and recording** (and a
  destructive action's fill); status colours always beside a word.
- **A state is a shape and a word**: ● Ready, ◐ Running, ○ Idle, ◌ Waiting, ◆ Warning, ▲ Blocked, ✕ Failed,
  ● Recording.
- **State in short words, the explanation on demand.** A blocker is one line with its one action ("Copy command").
  Paths, run ids and the worker live in the panes and the status bar, never in titles.
- **Dark by default, following the system.** The light appearance has the same layout and a mapped palette; nothing in
  the app switches it (the system does).
- **The same UI on the web and in the desktop app.** In the app the menu bar carries the commands and sheets replace
  modal pages; ⌘K everywhere.

## Tokens

One file, `packages/ui/src/app/tokens.ts`, for both appearances; `tokens.css` is generated from it
(`pnpm -F @demo-studio/ui gen:tokens`; a test fails when they differ). The kit and the shell read `--ui-*` only; the
legacy screens read the L4.9 palette (`--bg`, `--fg` …: light exactly as L4.9, dark mapped onto these), which goes with
the last legacy screen.

### Colours (`--ui-*`)

| token | dark | light | use |
|---|---|---|---|
| `--ui-canvas` | `#111214` | `#f6f6f7` | the centre pane, a scope's surface |
| `--ui-pane` | `#18191c` | `#ececee` | title bar, browser, inspector, status bar; wells and blockers in the centre |
| `--ui-raised` | `#25272b` | `#dfe0e4` | a secondary button, a select |
| `--ui-raised-hi` | `#2b2d32` | `#ffffff` | hover of raised; the current segment, a pressed icon button |
| `--ui-field` | `#111214` | `#ffffff` | a text field (sunken, as the canvas draws it) |
| `--ui-well` | `#111214` | `#e2e3e6` | the segmented control's well (sunken under the pane) |
| `--ui-overlay` | `#222428` | `#ffffff` | sheet, menu, palette |
| `--ui-select` | `#1d2a44` | `#dbe7ff` | a selected row or card (always with weight 600 or a 2 px ring) |
| `--ui-video` | `#0a0a0b` | `#0a0a0b` | frames and their letterbox |
| `--ui-kbd` | `#2e3035` | `#e2e3e6` | key caps, a command to copy |
| `--ui-record-tint` | `#2b2224` | `#f6e3e1` | the Capture button |
| `--ui-recording` | `#3d2523` | `#f2d4d1` | the same while recording |
| `--ui-accent` | `#2f6fe0` | `#2f6fe0` | the primary fill, a switch on, a progress fill, the app mark |
| `--ui-danger` | `#c42e25` | `#b42318` | a destructive button's fill |
| `--ui-text` | `#ececef` | `#16181d` | text |
| `--ui-text-2` | `#c9ccd3` | `#3d424b` | secondary text, a ghost button |
| `--ui-text-3` | `#a3a8b3` | `#555b66` | labels, counts, hints, a disabled control's text |
| `--ui-text-strong` | `#ffffff` | `#0f1115` | the selected row, the current segment |
| `--ui-link` | `#7aaaff` | `#1a56c4` | a text link |
| `--ui-on-accent` | `#ffffff` | `#ffffff` | text on accent and danger fills |
| `--ui-on-video` | `#ffffff` | `#ffffff` | text over a frame (a card's number) |
| `--ui-danger-text` | `#ff7b72` | `#b42318` | an error sentence, a destructive menu item |
| `--ui-ring` | `#4c8dff` | `#2f6fe0` | the focus ring, a selection ring, the palette's active bar |
| `--ui-ok` | `#4cd27a` | `#1a8d4c` | ● Ready / Connected |
| `--ui-warn` | `#f2b84b` | `#a86d14` | ◆ Warning, ▲ Blocked |
| `--ui-fail` | `#ff7b72` | `#d93a30` | ✕ Failed, a field in error |
| `--ui-record` | `#ff453a` | `#d93a30` | ● Recording, the record symbol |
| `--ui-idle` | `#9fa4ae` | `#6b7079` | ○ Idle |
| `--ui-waiting` | `#7d828c` | `#7a7f89` | ◌ Waiting |
| `--ui-track` | `#6b7079` | `#7d828c` | a switch off, a progress track |
| `--ui-knob` | `#ececef` | `#ffffff` | a switch's knob |
| `--ui-hairline` | `#2e3035` | `#d6d8dc` | lines inside lists and overlays (decorative) |
| `--ui-field-line` | `#43464d` | `#d3d5da` | a field's edge (see Fields below) |
| `--ui-backdrop` | `rgba(6, 7, 8, 0.55)` | `rgba(22, 24, 29, 0.35)` | behind a sheet or the palette |
| `--ui-shadow` | `rgba(0, 0, 0, 0.55)` | `rgba(0, 0, 0, 0.18)` | an overlay's shadow, the current segment's lift |

### Contrast (WCAG ratios; a lint recomputes every pair in both appearances)

Text on the surfaces it may sit on — dark:

| text | canvas | pane | raised | raised-hi | field, well | overlay | select |
|---|---|---|---|---|---|---|---|
| `text` | 15.9 | 14.9 | 12.7 | 11.7 | 15.9 | 13.2 | 12.1 |
| `text-2` | 11.7 | 10.9 | 9.3 | 8.6 | 11.7 | 9.7 | 8.9 |
| `text-3` | 7.9 | 7.4 | 6.3 | 5.8 | 7.9 | 6.5 | 6.0 |
| `text-strong` | 18.7 | 17.6 | 15.0 | 13.8 | 18.7 | 15.5 | 14.3 |
| `link` | 8.1 | 7.6 | 6.4 | 5.9 | 8.1 | 6.7 | 6.1 |
| `danger-text` | 7.4 | 7.0 | 5.9 | 5.5 | 7.4 | 6.2 | 5.7 |

Light:

| text | canvas | pane | raised | raised-hi | field | well | overlay | select |
|---|---|---|---|---|---|---|---|---|
| `text` | 16.4 | 15.1 | 13.5 | 17.8 | 17.8 | 13.8 | 17.8 | 14.3 |
| `text-2` | 9.4 | 8.6 | 7.7 | 10.1 | 10.1 | 7.9 | 10.1 | 8.1 |
| `text-3` | 6.3 | 5.8 | 5.2 | 6.8 | 6.8 | 5.3 | 6.8 | 5.5 |
| `text-strong` | 17.5 | 16.0 | 14.3 | 18.9 | 18.9 | 14.7 | 18.9 | 15.2 |
| `link` | 6.1 | 5.6 | 5.0 | 6.6 | 6.6 | 5.2 | 6.6 | 5.3 |
| `danger-text` | 6.1 | 5.6 | 5.0 | 6.6 | 6.6 | 5.1 | 6.6 | 5.3 |

Fills: white on accent 4.7 (both), on danger 5.6 (dark) / 6.6 (light). Marks (≥ 3:1) — dark: ring 5.9 on canvas,
5.5 on pane, 4.7 on raised, 4.5 on select; ok 9.0, warn 9.8, fail 7.0, record 5.2 (4.5 on the record tint), idle 7.0,
waiting 4.6 on pane; knob on track 4.2, track on pane 3.5. Light: ring 4.3 / 4.0 / 3.6 / 3.8; ok 3.6, warn 3.7, fail
3.9, record 3.9 (3.7 on the record tint), idle 4.2, waiting 3.4; knob on track 3.9, track on pane 3.3. Accepted below
3:1 and stated: hairlines (decorative), a field's edge (label + ring), the selection fill against its pane (a selected
row always adds weight 600 or a 2 px ring), waiting on raised surfaces (never drawn there), a disabled control's text
(WCAG exempts it). No other token shares a status colour's value (the accessibility checker reads a colour back to its
family; L5.9's review moved `--ui-idle` off `--ui-text-3`'s value in dark and `--ui-waiting` off `--ui-track`'s in light).
The legacy steps' in-flight edge `--busy-edge` (`#80858f` / `#7d828c`) is a mark at 3:1 on a step's every background
(3.9 – 4.7 dark, 3.4 – 3.9 light): the steps keep their text colours while a write is in flight, no fade.

### Fields and the segmented well (review B-L2: aligned with the canvas)

- **The segmented well is sunken**: `--ui-well`, the canvas tone in dark and a grey under the pane in light (1.07 / 1.09:1
  against the pane: the well is a recess, its segments the controls), radius 9 (`--ui-radius-seg`); the current segment a
  raised fill + weight 600 + a shadow. The title bar's mode switch pads its segments 16 px a side, as the canvas.
- **A field is sunken too**: `--ui-field` is the canvas tone in dark and white in light. **Its 1 px edge stays in both**
  (the canvas draws one in light, `#d3d5da`, none in dark): a dark field on the canvas tone — a scope, the gallery's
  column, every centre-pane form — would be a hole with no outline, so the dark edge `#43464d` (1.98:1 on the field)
  draws the box. Neither edge reaches 3:1, and need not: WCAG 1.4.11 asks that what identifies a control reach 3:1, and
  a field is identified by its visible label and its place, its focus by the 2 px `--ui-ring` (≥ 3:1 everywhere).

### Type, spacing, radii, sizes

- Type: `--ui-type-sm` 13 / `--ui-lead-sm` 18 · `--ui-type-md` 15 / 22 · `--ui-type-lg` 20 / 26; tracking −0.01em; weights
  400 and 600. Fonts: Geist and Geist Mono (variable woff2, SIL OFL 1.1, bundled in `packages/ui/fonts` and served by the
  Studio's own origin), system fallbacks after. Key caps 13 px mono and the palette's input 15 px (the canvas had 11 –
  12 and 17): three sizes, no exception — the Edit screen's ruler too (R4-Edit draws its tick labels at 11 px; L5.12
  sets them at 13, fewer labels).
- Spacing (4-based): `--ui-space-1 … -10` = 2 4 6 8 12 16 20 24 32 40.
- Radii: key cap 4, segment 6, control 7 (buttons, fields, rows), frame 8, segmented well 9, well 10 (blocker, menu,
  section), card 12, overlay 14 (sheet, palette).
- Sizes: title bar 48, status bar 34, browser 240, inspector 320 (label column 96 + gap 16), control 30 / small 26 /
  large 36, icon 16 (1.5 px strokes), status mark 7 (as the canvas; rings 10), frame card ≈ 248 × 140 (16:9), overlay width 560,
  the overlay title bar's inset 80 (0 on the web).

## Pane anatomy

```
┌ title bar 48 ─────────────────────────────────────────────────────────────────────────────┐
│ [inset] ■ Demo Studio › Project › scenario      ⟨ Script · Shoot · Edit · Review ⟩  [ctx] [◫] │
├ browser 240 ─┬ centre (the one scroller) ──────────────────────────┬ inspector 320 (optional) ┤
│ Projects     │ the current screen                                   │ sections, label column 96 │
│  › project   │                                                      │                           │
│    Overview… │                                                      │                           │
│ ──────────── │                                                      │                           │
│ Workspace …  │                                                      │                           │
├──────────────┴──────────────────────────────────────────────────────┴───────────────────────────┤
│ ● Connected · worker idle · live updates      (what a command answered)            [actions] │ 34
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Title bar.** The app mark and name, then the open project (L5.10a: a menu button — the workspace's projects, then
  "All projects" → Welcome) › the scenario (text), truncated before they reach the mode switch (at 900 px too). The mode switch is centred: a link per mode when a scenario is in context (the
  route's, or the one opened last in this project while it still lists it), disabled buttons with a hint otherwise.
  It is centred on the window, under the desktop app's overlay bar too (two equal side columns around it; the window
  buttons' inset sits inside the start one). Right: the screen's context
  control (a select: Location, Take, View) and the inspector toggle (an icon button named "Inspector", pressed while
  shown). Nothing in the bar can be selected as text.
- **Browser.** A source list. No project open (Welcome): Projects and the workspace's projects. A project open
  (L5.10a, B32): **Productions** (its count) with its smart groups **Ready to render · Needs a shoot · Failed** (counts);
  **Library** (Components, Themes); **Locations** (one row per environment, its riskiest flag in a word: production,
  read-only, sandbox, default); **Cast** (Sessions, then each persona's session as a shape and a word); **Project**
  (README with "unsaved" while dirty, Record a scenario). Its foot: the workspace path, the version and the worker's
  pid, the UI gallery link. A scenario open (L5.10b, B32-Scenario): its own list in the browser's place (a `browser`
  slot; the foot stays) — Video (the total length), Before filming, each scene (number, title, length, a 2 px bar against
  the longest), the cards (quieter), After filming; a row selects its entry and brings it into view (on the board the
  entry, in the YAML view its lines).
- **Centre.** The only scroller: the bars never move. It starts at the top when the screen changes, and keeps its
  place when the screen moves inside itself (a thread, a frame, a run, a theme picked).
- **Inspector.** Shown only while the screen fills it; titled sections, the inspector's field rows (a right-aligned
  label column).
- **Status bar.** The connection (a state mark and word), the worker, live updates; a polite line for what a command
  answered ("Open a scenario first"); the screen's actions on the right (Rehearse, ● Capture, Render: L5.11 makes them
  act).

## Components (`packages/ui/src/app/ui-kit/`)

Every component is a native element where one exists, named, keyboard-complete, drawn with `--ui-*` tokens only, its
focus ring 2 px `--ui-ring` offset 2 px. Every slot that shows text the kit did not write (a label, a hint, a row, a
status word, a palette entry, a menu item) renders a string through `<Txt>` (`shown()` in bits.tsx: a `<bdi>`, its
direction controls made visible); an `<option>` and a key cap, which cannot hold a `<bdi>`, through `visibleControls`. A
parser lint holds every JSX child of the kit to that, and an SSR test plants a hostile name in every slot.

| component | states | do / don't |
|---|---|---|
| Button | primary, secondary, ghost, destructive, record (and recording); sm / md / lg; icon; key caps; busy; disabled with its reason beside it | one primary per area; a destructive action is never a form's default; the record variant only for Capture |
| LinkButton | the button look, a link to a route | for navigation; a Button for actions |
| IconButton | pressed or not | its label is its name (the icon is hidden); a toggle keeps one label ("Inspector") |
| Kbd | key caps | shows a shortcut; the key is bound elsewhere |
| Segmented | radios (one tab stop, arrows) or links (`aria-current`); current = raised fill + 600; a disabled segment | ≤ 5 options; more is a Select |
| Switch | on (knob right, accent) / off / disabled | a modifier that applies at once; a choice among several is Segmented |
| TextField, TextArea | empty with placeholder, filled, error ("Error: …"), mono, read-only, stacked or in a row | `unsaved` is required: the item the quit question names, or `null` for no one's text |
| Select | the system's menu | long or dynamic lists |
| FieldRow | a group named by its label (inspector row) | for what is not one native field |
| StatusMark | ok, running, waiting, idle, warn, attention, fail, recording | its word must say the state |
| Timecode | `00:00:49.0`, optional total and frame; spoken form in hidden text | mono, tabular |
| Progress | determinate (values), indeterminate | no motion under reduced motion |
| Toolbar | one tab stop; arrows, Home, End over its visible controls (a radio group counts once) | groups controls inside a pane (not the title bar); a menu, a segmented control or a field inside it keeps its own keys |
| StatusBar | state, information, actions | one per window (the shell's) and samples |
| SourceList | headed groups, nested items, current (`aria-current`, select fill + 600), a count or a flag in words; L5.10a: an icon, a lead column, a value (mono), a quiet row, a test id; L5.10b: a row that acts (`onSelect`: a button, `aria-current="true"`) and a 2 px bar | the label truncates first; the flag, the count and the value never wrap |
| Facts | a `<dl>` of read-only rows, the label in the 96 px right-aligned column (L5.10a); a name goes on a `group` around it, never on the `dl` | read-only values; FieldRow stays for controls |
| Disclosure | a native `<details>`, closed by default (L5.10a) | the one collapsible outside the inspector (the ratchet bans `<details>` elsewhere) |
| FrameGrid, FrameOption | ONE listbox per scene (L5.10b): three columns (two under 1100 px), options with `aria-selected` and a name (scene, number, verb, target, state words), the list holding the selection the one tab stop; selected: select fill + 2 px ring; a drop: a 3 px bar on one side; dragged: a dashed outline, a dimmed picture | the caller's keys (`board-keys.ts`: ← → by step, ↑ ↓ by column across scenes, Home / End, Page Up / Down three rows, Alt+arrows move); the list takes the drag over its gaps, the slot from the pointer (`slotFromPointer`); an empty scene's drop zone |
| RowCard | a pressed button: a 96 × 54 tile, a title, a meta line (L5.10b); L5.11b: `compact` — a list row (a number column, the title at body size, transparent until hovered or selected) with an `aside` word on the right (under the text in a RowList narrower than 560 px; a word is never broken); L5.11b fixes: `option` — an option of a RowList listbox instead of a button (`aria-selected`, never a tab stop; the active one ringed while its list has the focus) | cards between scenes, Before / After filming; compact: the Record screen's draft rows |
| RowList, RowListItem | L5.11b fixes: a list of compact rows, its own size container; `listbox` — the caller holds the active option (`aria-activedescendant`; the list holding it is the one tab stop of all its lists) and the keys; its items `role="none"`, so the list owns only its options and any group the caller puts between them | the Record screen's draft (one listbox per scene; the cursor block a group after its row) |
| RadioGroup | L5.11b: a `fieldset` of native radios named by its legend (visible or hidden), each a row — label, a second line, a word on the right; checked = a ring with a filled dot (a shape); one tab stop, the arrows native; a value that matches none leaves all unchecked | a choice among a few long options (target alternatives, what to wait for, a zoom factor); a short one is Segmented |
| Callout | a short note in a pane well: its state as a shape and its title (a state word), then its text (L5.10b) | replaces the legacy Notice on rebuilt screens |
| TerminalCommands | the command to type and its node form, selectable (L5.10b) | blockers and refusals (the Run, Record and Timeline screens use it too) |
| PosterGrid | ONE listbox (L5.10a): options with `aria-selected`, the selected one the active descendant (no `aria-activedescendant` while none is), select fill + 2 px ring; as many columns as fit, 200 px at least | arrows (↑ ↓ move by the row the layout shows: three at 1440, one at 900), Home / End, Enter opens, Space selects, Escape clears; a click selects, a double-click opens; nothing selected at first |
| InspectorSection | titled; collapsible (`<details>`) | |
| FrameCard, PosterCard | selected (select fill + 2 px ring) or not; a button that selects or a link that goes | the picture comes from Thumb.tsx (the one image source) |
| Blocker | a state mark, one sentence, one action (a button, or Copy with "Copied", or a link); L5.10a: without a word, no mark (a command to copy nothing waits on); L5.11a: `compact` — the status bar's form: the mark and a few words (never cut), a ghost action — for a command, "Command…", a popover that shows the whole command wrapped beside its Copy (L5.11a fixes: what is copied is what is shown). The command is never cut (it wraps); "Copied" (or "Not copied: select the command instead") is visible | one line; the explanation on demand |
| Checklist, ChecklistItem | an `<ol>` of checks (L5.11a): a 28 px state column (the shape), a title (h3) with its state word beside it (a visible word: the colour-only rule), its body, its actions; a hairline between items | Prepare's four checks; a short list of facts each with one state |
| EmptyState | title, text, actions | |
| Sheet | a modal `<dialog>` under the title bar; alertdialog when destructive or `alert` (L5.11a: a warning that loses nothing); test ids on the dialog and its actions | the default holds the focus; a destructive default falls back to Cancel; it follows its `open` even when the platform closes the dialog (Escape refused twice) |
| Menu | a popover menu button; ↓ ↑ Home End, typeahead, Escape / Tab close | a click on the open trigger closes it |
| CommandPalette | a modal dialog: combobox + grouped listbox, filter, ↑ ↓, Enter, Escape | the active option has a 3 px bar; keys wait while an input method composes; the focus goes back to its opener, or to the centre pane when a command took the opener away |

## The screens (from the canvas)

The Project and Scenario reference is **B32 (« B·3b Épure », round 3, validated)** — `B32-Projet` and `B32-Scenario`,
layout and drawing. C1 / C2 are round 1's rejected « Script » direction: not used. The canvas says "Retake"; the
Studio keeps `APP_NAME` (L5.13 renames).

- **Welcome** (no project open; R4-Welcome) — built in L5.10a: R4's identity column — the app's 128 px mark, its name,
  version and one sentence, New project as a command to copy (no write path from the page), the projects folder —
  beside "Recent projects" (name, slug, scenario and location counts, last run as a shape and a word, location flags in
  words, folder; a project that does not load with its first error line); one column under 1180 px; then the search and
  Lately; the inspector: the workspace and Claude (the MCP command to copy; under Lately when the inspector is hidden).
  Deviations: R4's three columns become two inside the shell (the browser is R4's third); no project poster (they span
  projects: BL-128), no "This Mac is ready" panel (no doctor op: BL-128), no Open a folder (no write path: BL-128), the
  projects listed by name, not by recency.
- **The status bar's actions** — built in L5.11a (B32-Projet / B32-Scenario footers): on every screen with a scenario
  in context, its state in a non-live span (*Rehearsing · step 12 of 25 · Watch*, *Capture paused*, *Last take
  succeeded · 2 h ago*, *Idle*; its name first off its own screens; *on staging* when the tab chose another location),
  then Rehearse, ● Capture (the record variant), Render — and Pause / Stop while a run of it is unfinished. One blocker
  line at a time (Capture's first, else Rehearse's), in the gate's own words (*1 hook to approve*, *protected
  location*, *uses a secret or an outside file*, *read-only location refuses its hooks*, *the file has errors*; an
  unknown gate: *needs the terminal*) with Command… (a popover showing the whole command beside its Copy) or Open the
  YAML; each disabled action's full reason is its description. Key caps only in the desktop app, hidden under 1100 px;
  in a narrow window whole segments give way — "live updates" and the last take's time under 1100 px, the scenario's
  name and the last take under 1000 px, Command… down to its icon —, the blocker's words are never cut; nothing scrolls
  sideways at 900 px. Stop and Pause act on the scenario's run with a job first (a terminal's run beside it: Ctrl-C
  there). A screen may claim the slot (Prepare, the live screen while its run goes, a live recording): the buttons hide,
  the commands stay. The polite line says command answers and a run's start, stop or refusal — never a step's progress;
  it is text, one line at a time, gone after 6 s and when the screen changes. ⌘. always answers (with the palette open
  it closes it first). "Rehearse" is the Studio's word for a dry run (`studio run … --dry`, MCP `run_dry`); Prepare
  shows that mapping once. A stopped run is "stopped" everywhere.
- **Project** (B32-Projet) — built in L5.10a: h1 "Productions" (or the smart group) and its count; search, Sort (Last
  activity · Name · Length), New scenario (the Record screen); the poster grid (one listbox; each poster its capture's
  last pictured step, its title, its state as a shape and a word, its length); a project.yaml warning line with a
  Disclosure. The inspector: nothing selected → the project (facts, README preview and Edit / Write / Open, recent
  runs, Lately); a production → its poster, title and file, state, facts (length, content, last take, capture, render,
  review, location), Open and Render (L5.11a: the status bar's Render on that production), Lately; a Location
  (`#/p/<slug>/loc/<env>`) → its flags, pages (URL, shown as) and personas — a location route clears the selection. The
  inspector hidden: its content under the grid, under a heading. The posters reflow (auto-fill, 200 px at least); the
  search's label is visually hidden behind a search icon (B32). The Cast (`#/p/<slug>/cast`; L5.11a: on the kit — one
  section per location, the personas as Prepare's session rows, Sign in… / Cancel / Sign in again); the browser's Cast rows put a persona's location on a second line that wraps. Deviations: the canvas's
  Location select on this screen is cut (BL-128).
- **Scenario** (B32-Scenario) — built in L5.10b: the title bar's context holds View (Board · YAML) and Location (the
  environments with their flags in words; a choice holds in this tab only and changes what Rehearse and Capture use —
  L5.11a: Prepare and the status bar share it —; one project.yaml no longer has is dropped and said once); the scenario's
  name is a visually hidden h1 (the title bar keeps it readable at 900 px, its full text in a tooltip). Above the board
  and the YAML view alike: the running take (progress, Watch live; L5.11a: Pause and Stop are the status bar's). The
  take strip (L5.11a: the run actions moved to the status bar, Open timeline went — the Edit mode opens the same
  capture): Pictures from, the source run as a shape and words, the open comments, the location, what the last start
  came to (whoever started it), what the pictures may not show. The file's notices, the edit
  bar (Undo / Redo naming the edit, Add a step…), the palette. The storyboard: the step count and the file, Before
  filming, the scenes (title = the caption's kicker, its caption, flags in words, "Scene 1 · shop, / · 9.3 s" — "no
  capture yet" under a dry run's pictures — and Add step, then its frames, three a row while the board is wider than
  600 px, two to 380 px, one below (the board's width: a container query) — 256 × 201 with a 244 × 137 picture and
  20 px gaps at 1440 —: picture or why there is none, number, verb and target ("Wait for …"; without a target, what it
  does: "Wait 1.6 s"), "took …", state words, modifiers, the step's note), cards between them, After filming; a closed
  "Renders and review" section at its end (the legacy card until L5.12). One selection drives the board, the browser and
  the inspector; a selected step gone from the file leaves its scene selected, never another step. The inspector: a
  step in B32's order (its picture 288 × 162, "Step 3 · Click", scene and "took …", its form — fields in words, "Other
  ways to find it (n)", the modifiers as switches, all on the first screen at 1440 × 900 —, what it does, Move up /
  Move down / Duplicate / Delete — the button keeps the focus —, In this run, As written, Show in the file · line n), a
  scene's facts, a card's, the hooks, the video's (its location: the file's own, the tab's choice beside it). Deviations: the canvas's
  action Type select and Rest field, the Zoom modifier and verified alternative targets are cut (BL-129).
- **Scenario source** (R4-Source) — built in L5.10b: View › YAML: a toolbar line (the file, "Comments and layout are
  kept when you edit the board.", Edit / Save / Discard changes / Close the editor), the numbered lines with each issue
  under its line, the focus lines outlined; the editor is the kit's text area (same drafts, conflicts, live checks); the
  File inspector (valid or n errors in words, warnings, unsaved, hidden characters, the size against the cap). Deviations:
  no syntax colours, no Ln / Col, the scenes browser in place of the Outline, no Show in Finder (BL-129).
- **Shoot — prepare a take** (R4-ShootPrep) — built in L5.11a: the title bar's Location (shared with the Scenario
  screen); the browser: Prepare, the scenario's Runs (kind, when, outcome as a shape and words; the running one first;
  each opens its live route), Record a scenario; the centre: h1 "Prepare a take of <name>", "Nothing here runs
  anything.", a Checklist — Location (flags, pages, shown as), Sessions this run signs in with (a table without a
  Location column: persona, state, last check, Sign in… — none for a sandbox account or a persona its login steps sign
  in —, what a run does with it on its own line under the row; the rows stack below 520 px of pane; "None needed on
  <env>"; "A capture asks first"), What would stop a run (one Blocker per refusal with its message and its command in
  full with Copy command, the node form in a disclosure; "A rehearsal skips the hooks, so it is not affected"), Live
  picture during a capture (a switch, off) — then a run already going (Watch it; a terminal's: "press Ctrl-C there"), a
  refusal with its command (it takes the focus), the mapping line, and Start rehearsal / ● Start capture with what
  stops each beside it, in a footer that stays at the foot of the centre pane (one short row under 1100 px); a project
  or scenario that does not load says so in the checks, beside the buttons and in the status bar; the inspector: the
  Last take (its poster, facts, Open in Edit, Open its run); the status bar: its state and the scenes and steps, Pause /
  Stop while a run goes (disabled ones say why). Deviations: no "Pages that answer" (no page is probed from Prepare: BL-130), no estimates, no
  hooks / rollbacks facts or Watch replay in the Last take, no Recordings group (on the Record routes only, L5.11b) — BL-130.
- **Shoot — a live rehearsal / capture** (R4-ShootLive) — built in L5.11a: "Rehearsal of <name>" / "Capture of
  <name>" (no run id in the title), the current step, when it started and where; the live picture (a video-toned frame,
  a "Live" mark, the toggle); the steps done and the time elapsed (a kit Progress); the mode's note and what Pause and
  Stop do; once it ended the outcome with what comes next (Open in Edit, Start capture, Rehearse again, Back to the
  board). The inspector "Steps and log": Steps (Follow current step; the current row in the select fill, weight 600,
  `aria-current="step"`), Log (Show, Follow, the dropped count). The status bar: the run's state in the status bar's
  words (Rehearsing, Capture paused…), Pause / Resume, Stop while it goes (⌘. stops this run — once the stream says
  whose run it is; a stop or pause on its way is said), then the defaults. Opened by a start, its title takes the focus;
  the outcome's Start capture / Rehearse again open the new run.
- **Shoot — record a scenario** (R4-Record) — built in L5.11b. The browser is Shoot's: Prepare and the Runs while a
  scenario is in context, the **Recordings** (the project's recent ones, newest first: name, when — "now" while it goes
  —, its state as a shape and words, "not saved" / "saved as …", who started it when not the Studio; the open one with
  its live state and actions), Record a scenario. **The start form** in the centre: Location, Page and Persona (Selects),
  Path and Name (text fields with no unsaved mark: nobody's work), the window note (full size: the desktop layout is
  what the video films), the persona's stored session with Sign in, the location's warnings, the recording already open
  (one window at a time, Open it), Start recording (the record variant) with what stops it beside it; a refusal takes
  the focus. **A recording**: h1 "Recording <name>" (focused when Start opened it), the state in a sentence, the time
  left (mono, right), the state as a shape and words with the counts, the callout "Recording in the browser window";
  the draft as compact row cards by scene (number, the step's words and target, what made it, "2 alternatives" or
  "Target picked by you" on the right; an insert set in; the modifiers as chips). L5.11b fixes: each scene's rows are a
  listbox and the draft is ONE tab stop — ↑ ↓ across scenes, Home / End, Page Up / Down, Enter or Space selects the
  active row (a click too). Selecting a row puts the draft cursor right after it — a group (not a row) with the row's
  own Remove buttons, its verified alternatives as a radio group ("Suggested" on the recorder's; the radio follows each
  arrow press while the pick is saved, the newest sent when the one in flight ends), then the Insert toolbar "Insert after step n of <scene>" (Hold 2 s, Wait for…, Caption…, Mark, Zoom…
  — the theme's factors up to its maximum —, Back to the end); pressing it again goes back to the end ("Insert at the
  end": a hold or a wait before the next action, the rest waiting for it under "Applies to your next action"); "Waiting
  for your next action in the browser…" while the window is open; the draft as YAML in a disclosure. **The inspector**:
  Started with (location, page, path, persona, who, when; the Name Save uses), the selected step (its facts, Add after
  this step — the toolbar takes the focus), Stop recording (the record variant, ⌘. in the app) / Save as new scenario
  (disabled with "Saving opens after Stop. It writes a new file, scenarios/<name>.yaml." while the window is open,
  "Saving opens once the check is over." while the draft is made and checked; Enter in Name says why) / Discard (the
  kit's sheet:
  "Keep it" is the default and the cancel, Return never discards), then Check, To look at, Secret fields, Writes,
  Warnings. **The status bar** while the recording goes (queued → checked): "Recording · browser window open" and "n
  actions · n inserts · draft updated just now" (the counts give way under 1000 px); ⌘. stops this recording (also
  after a reload, before its view is read: it waits and says so), Rehearse / Capture / Render say why they wait and
  send nothing; once it is over, the defaults again. ⌘K's Scenario group is the recording's while it goes: "Stop
  recording" and "Discard…", named after it (never the scenario in context). The one Stop visible is the inspector's
  (in the head beside the time when the inspector is hidden; what was typed — the Name, an open insert form — survives
  hiding it and a cursor block that moves). Stop or Discard pressed while a change is written goes right after it. The
  focus is never dropped: a control that goes (Stop, Discard, a removed insert, the toolbar moving onto a hold) hands it
  to its replacement, else to the title. The Recordings also say a recording's location and steps, and a saved one has
  a row "Open <scenario>" under it. Deviations: Show the window and Check replay (BL-130), the step's "Recorded 00:41
  into the recording", the inspector's second set of insert buttons, the title bar's Location on this screen (BL-131).
- **Edit** — the timeline and its live preview. L5.12.
- **Review — frame comments** — the frame, the thread, Claude's proposal. L5.12.
- **Review — report and exports** — the review report, the raw package. L5.12.
- **Library** — the components (the browser's word "Components" until L5.12). L5.12.
- **Theme editor** — tokens and their preview. L5.12.
- **Confirmation sheet** — the kit's Sheet. Built in L5.9; screens adopt it in L5.10 – L5.12. L5.11a: the capture's
  sessions confirmation (R4-Confirm) — Cancel (Escape) · "Sign in <persona> first…" (the default and the focus: the
  canvas's Return on Capture anyway is not taken — a session known to be bad would run the hooks) · Capture anyway (the
  record variant); the personas with their states and what the capture does with each; one sheet in the shell for the
  status bar's Capture, ⇧⌘R and Prepare's Start capture.
- **⌘K palette** — the kit's CommandPalette with the shell's commands (places, modes, the inspector). Built in L5.9;
  L5.11a: a Scenario group (Rehearse, Capture, Render, Stop — the browser tab's way to them: ⌘R / ⇧⌘R / ⌘B / ⌘. stay the
  browser's there); its content grows in L5.12.
- **Light appearance** — the same layout, the mapped palette. Built in L5.9 (tokens).

Until a screen is rebuilt it keeps its L4 content inside the shell's centre pane, in both appearances (the legacy
palette's dark values; the L4.9 checker passes on every one of them in dark and light).

## The mark and the name

The app mark today is the blue square of L4.1, drawn by the shell; "two takes" (declension "Nette": the previous take
as a blue outline behind, the new one in front with a play triangle, on an ink plate) and the name Retake land together
in L5.13 — `brand.ts`, the desktop app's name in `tauri.conf.json`, and the docs.
