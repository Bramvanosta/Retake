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

- **Title bar.** The app mark and name, then the open project (a link) › the scenario (text), truncated before they
  reach the mode switch (at 900 px too). The mode switch is centred: a link per mode when a scenario is in context (the
  route's, or the one opened last in this project while it still lists it), disabled buttons with a hint otherwise.
  It is centred on the window, under the desktop app's overlay bar too (two equal side columns around it; the window
  buttons' inset sits inside the start one). Right: the screen's context
  control (a select: Location, Take, View) and the inspector toggle (an icon button named "Inspector", pressed while
  shown). Nothing in the bar can be selected as text.
- **Browser.** A source list: Projects, the workspace's projects, the open project's pages (Overview, README with
  "unsaved" while dirty, Components, Themes, Record). Its foot: the workspace path, the version and the worker's pid, the
  UI gallery link. L5.10 adds the scenes of a scenario and smart groups (Ready to render, Needs a shoot, Failed).
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
| SourceList | headed groups, nested items, current (`aria-current`, select fill + 600), a count or a flag in words | |
| InspectorSection | titled; collapsible (`<details>`) | |
| FrameCard, PosterCard | selected (select fill + 2 px ring) or not; a button that selects or a link that goes | the picture comes from Thumb.tsx (the one image source) |
| Blocker | a state mark, one sentence, one action (a button, or Copy with "Copied") | one line; the explanation on demand |
| EmptyState | title, text, actions | |
| Sheet | a modal `<dialog>` under the title bar; alertdialog when destructive | the default holds the focus; a destructive default falls back to Cancel; it follows its `open` even when the platform closes the dialog (Escape refused twice) |
| Menu | a popover menu button; ↓ ↑ Home End, typeahead, Escape / Tab close | a click on the open trigger closes it |
| CommandPalette | a modal dialog: combobox + grouped listbox, filter, ↑ ↓, Enter, Escape | the active option has a 3 px bar; keys wait while an input method composes; the focus goes back to its opener, or to the centre pane when a command took the opener away |

## The screens (from the canvas)

The canvas's first round (C1 / C2: the project and scenario screens L5.10 rebuilds) is older than R4: its warm light
palette, 44 px three-column header and 23 / 17 / 12.5 px type are not the system — L5.10 takes their **layout** only,
on R4's tokens and pane anatomy above.

- **Welcome** (no project open) — an empty state with what to do first. L5.10.
- **Project** — the productions as a poster grid with where each one is, smart groups in the browser, an inspector. L5.10.
- **Scenario** — a storyboard of real frames per scene (≈ 248 × 140, three a row), the step inspector. L5.10.
- **Scenario source** — the YAML, a View segmented control (Blocks · YAML) in the title bar's context slot. L5.10.
- **Shoot — prepare a take** — the checklist; a blocking hook in one line with Copy command. L5.11.
- **Shoot — a live rehearsal / capture** — the live picture, the steps, Stop. L5.11.
- **Shoot — record a scenario** — the Record screen in the shell. L5.11.
- **Edit** — the timeline and its live preview. L5.12.
- **Review — frame comments** — the frame, the thread, Claude's proposal. L5.12.
- **Review — report and exports** — the review report, the raw package. L5.12.
- **Library** — the components (the browser's word "Components" until L5.12). L5.12.
- **Theme editor** — tokens and their preview. L5.12.
- **Confirmation sheet** — the kit's Sheet. Built in L5.9; screens adopt it in L5.10 – L5.12.
- **⌘K palette** — the kit's CommandPalette with the shell's commands (places, modes, the inspector). Built in L5.9;
  its content grows in L5.12.
- **Light appearance** — the same layout, the mapped palette. Built in L5.9 (tokens).

Until a screen is rebuilt it keeps its L4 content inside the shell's centre pane, in both appearances (the legacy
palette's dark values; the L4.9 checker passes on every one of them in dark and light).

## The mark and the name

The app mark today is the blue square of L4.1, drawn by the shell; "two takes" (declension "Nette": the previous take
as a blue outline behind, the new one in front with a play triangle, on an ink plate) and the name Retake land together
in L5.13 — `brand.ts`, the desktop app's name in `tauri.conf.json`, and the docs.
