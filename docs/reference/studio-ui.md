# The Studio's UI — reference (« Épure »)

The Studio's look and its design system, exported from the design canvas the founder validated in four rounds
(2026-10-29; BACKLOG BL-124 records the decisions and where the canvas lives). L5.9 built the foundations — the tokens,
the components, the shell, the gallery; L5.10 – L5.12 rebuild the screens from them; L5.13 renames the product (done in
L5.13a; the page writes the name in one place, `packages/ui/src/app/brand.ts`, every screen included — a lint over the
app's sources).
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
(`pnpm -F @retake/ui gen:tokens`; a test fails when they differ). Every token is a `--ui-*` one (L5.12d: the L4.9
palette — `--bg`, `--fg` … — went with the last legacy screen and app.css); the kit, the shell, the screens and the
page's base (`base.css`: element defaults only, no class) read them.

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
| `--ui-accent` | `#2f6fe0` | `#2f6fe0` | the primary fill, a switch on, a progress fill |
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
| `--ui-mark-plate`, `-back`, `-front` | see The mark | | the app mark (L5.13b) |

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
(The legacy steps' in-flight edge `--busy-edge` went with the legacy palette in L5.12d: the kit's steps show a write in
flight with their own dashed edge, no fade.)

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
│ [inset] ■ Retake › Project › scenario      ⟨ Script · Shoot · Edit · Review ⟩  [ctx] [◫] │
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

- **Title bar.** The app mark (tiny, 18 px: The mark and the name) and name, then the open project (L5.10a: a menu button — the workspace's projects, then
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
- **Status bar.** The connection (a state mark and word), the worker, what a filming take holds of this workspace's
  heavy work (L5.14: "a render is slowed during a take (elsewhere on this Mac)", "2 jobs wait for a take to finish (in
  this workspace)"; only while it holds any), live updates; a polite line for what a command answered ("Open a scenario first"); the screen's actions on the right (Rehearse, ● Capture, Render: L5.11 makes them
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
| Toolbar | one tab stop; arrows, Home, End over its visible controls (a radio group counts once); L5.12a fixes: `clickLeavesKeys` — after a control was focused by a click, the arrows, Home and End stay the page's (Edit's transport: the playhead) until the focus comes by the keyboard | groups controls inside a pane (not the title bar); a menu, a segmented control or a field inside it keeps its own keys |
| StatusBar | state, information, actions | one per window (the shell's) and samples |
| SourceList | headed groups, nested items, current (`aria-current`, select fill + 600), a count or a flag in words; L5.10a: an icon, a lead column, a value (mono), a quiet row, a test id; L5.10b: a row that acts (`onSelect`: a button, `aria-current="true"`) and a 2 px bar | the label truncates first; the flag, the count and the value never wrap |
| Facts | a `<dl>` of read-only rows, the label in the 96 px right-aligned column (L5.10a); a name goes on a `group` around it, never on the `dl` | read-only values; FieldRow stays for controls |
| Disclosure | a native `<details>`, closed by default (L5.10a) | the one collapsible outside the inspector (the ratchet bans `<details>` elsewhere) |
| FrameGrid, FrameOption | ONE listbox per scene (L5.10b): three columns (two under 1100 px), options with `aria-selected` and a name (scene, number, verb, target, state words), the list holding the selection the one tab stop; selected: select fill + 2 px ring; a drop: a 3 px bar on one side; dragged: a dashed outline, a dimmed picture | the caller's keys (`board-keys.ts`: ← → by step, ↑ ↓ by column across scenes, Home / End, Page Up / Down three rows, Alt+arrows move); the list takes the drag over its gaps, the slot from the pointer (`slotFromPointer`); an empty scene's drop zone |
| RowCard | a pressed button: a 96 × 54 tile, a title, a meta line (L5.10b); L5.11b: `compact` — a list row (a number column, the title at body size, transparent until hovered or selected) with an `aside` word on the right (under the text in a RowList narrower than 560 px; a word is never broken); L5.11b fixes: `option` — an option of a RowList listbox instead of a button (`aria-selected`, never a tab stop; the active one ringed while its list has the focus); L5.12a fixes: `to` — a link to another screen (`aria-current="page"` on the row shown), never a toggle | cards between scenes, Before / After filming; compact: the Record screen's draft rows; `to`: the render rows |
| RowList, RowListItem | L5.11b fixes: a list of compact rows, its own size container; `listbox` — the caller holds the active option (`aria-activedescendant`; the list holding it is the one tab stop of all its lists) and the keys; its items `role="none"`, so the list owns only its options and any group the caller puts between them | the Record screen's draft (one listbox per scene; the cursor block a group after its row) |
| RadioGroup | L5.11b: a `fieldset` of native radios named by its legend (visible or hidden), each a row — label, a second line, a word on the right; checked = a ring with a filled dot (a shape); one tab stop, the arrows native; a value that matches none leaves all unchecked | a choice among a few long options (target alternatives, what to wait for, a zoom factor); a short one is Segmented |
| Callout | a short note in a pane well: its state as a shape and its title (a state word), then its text (L5.10b) | replaces the legacy Notice on rebuilt screens |
| TerminalCommands | the command to type and its node form, selectable (L5.10b) | blockers and refusals (the Run, Record and Timeline screens use it too) |
| PosterGrid | ONE listbox (L5.10a): options with `aria-selected`, the selected one the active descendant (no `aria-activedescendant` while none is), select fill + 2 px ring; as many columns as fit, 200 px at least | arrows (↑ ↓ move by the row the layout shows: three at 1440, one at 900), Home / End, Enter opens, Space selects, Escape clears; a click selects, a double-click opens; nothing selected at first |
| InspectorSection | titled; collapsible (`<details>`) | |
| FrameCard, PosterCard | selected (select fill + 2 px ring) or not; a button that selects or a link that goes | the picture comes from Thumb.tsx (the one image source) |
| Blocker | a state mark, one sentence, one action (a button, or Copy with "Copied", or a link); L5.10a: without a word, no mark (a command to copy nothing waits on); L5.11a: `compact` — the status bar's form: the mark and a few words (never cut), a ghost action — for a command, "Command…", a popover that shows the whole command wrapped beside its Copy (L5.11a fixes: what is copied is what is shown). The command is never cut (it wraps); "Copied" (or "Not copied: select the command instead") is visible | one line; the explanation on demand |
| Checklist, ChecklistItem | an `<ol>` of checks (L5.11a): a 28 px state column (the shape), a title (h3) with its state word beside it (a visible word: the colour-only rule), its body, its actions; a hairline between items | Prepare's four checks; a short list of facts each with one state |
| EmptyState | title, text, actions; `level` 1 – 3 (L5.12d: 1 when it is the whole screen — the not-found screen) | |
| Sheet | a modal `<dialog>` under the title bar; alertdialog when destructive or `alert` (L5.11a: a warning that loses nothing); test ids on the dialog and its actions; L5.12c: `content` fields, Return in a one-line text field runs the default (when on) | the default holds the focus (off: the first text field, else the first action that is on); a destructive default falls back to Cancel; it follows its `open` even when the platform closes the dialog (Escape refused twice); L5.16c fixes: `focusTitle` starts the focus on the title instead (focusable, not a tab stop: a long sheet opens at its top), `escapeAction` names what Escape answers (default: the cancel action) |
| Menu | a popover menu button; ↓ ↑ Home End, typeahead, Escape / Tab close | a click on the open trigger closes it |
| CommandPalette | a modal dialog: combobox + grouped listbox, filter, ↑ ↓, Enter, Escape; L5.12b (R4-Palette): 640 px (`--ui-palette-w`), "Search commands, scenes and themes", an icon per row (`icon`, decorative), Esc's key cap in the field, a footer legend (↑ ↓ Move · Return Run · Esc Close, and a `footnote`); the list is never a tab stop of its own | the active option has a 3 px bar; keys wait while an input method composes; the focus goes back to its opener, or to the centre pane when a command took the opener away |
| ChoiceChips | L5.12a: a radio group of `<button role="radio">` named by its legend; one tab stop (the checked chip), arrows / Home / End move the focus, Space / Enter picks; checked = select fill + 600 + a ring; a chip that cannot be taken is `aria-disabled`, dashed, focusable, its reason after " — "; a whole group off is dashed | a choice written at once (Edit's switches); a pick never follows the arrows (one write per pick) |
| Track, TrackItem | L5.12a: a labelled row (`group` "Name: N items") — a 96 px label column and a lane of items placed by percentages (a span, or a tick with a 24 px target centred on its frame); every item a 24 px target (24 px tall; a span narrower than 24 px a centred 24 px hit area; a lane's ticks nudged apart to 24 px while it has room: `spaceTicks`); an item is a button carrying its words; pressed = select fill + 600 + a 2 px ring; a band at its start under its words (a transition, a camera ramp); a tip beside a tick on hover and focus | timelines; memoise the rows and keep the playhead out of their props |
| Scrubber, Playhead | L5.12a: the playhead's range input on a lane (its own arrows move one frame; its value text says where) with decorative time labels; the playhead a 2 px line over the lanes | one per timeline; the Playhead is drawn by the screen, never inside the tracks |
| ContactSheet | L5.12a: figures in a grid, each picture a toggle (`aria-pressed`; one name, "<name>, larger" — the state is aria-pressed's) that spans the row when larger; words while it loads or cannot be read; the label and a meta line as the caption | the pictures come from Thumb.tsx; ask them one at a time |
| Tag | L5.12a: a quiet label in a well — text, never a state | a source, a note's kind; a state is a StatusMark; not in the status bar (plain words there) |
| NumberField | L5.12a: TextField's sibling, `type="number"`, min / max / step, Enter runs its action; no unsaved mark (a value written on Set); L5.12b: `onBlur` | a speed or a duration beside chips; a comment's region in % |
| DiffTable | L5.12b: a change line by line — every row (no inner scroll), a sign shown and its word hidden, the line numbers, the line a `<code dir="ltr">` cell in byte order (bidi override) with edge spaces `·`, tabs `→`, unseen characters `[U+…]` and a "right-to-left text" marker; add / del rows a 3 px bar beside their sign; a title line over the table; the table named by a caption, the dots and arrows hidden from assistive technology and read as words ("2 leading spaces", "a tab") | Claude's proposal (the caller passes comment-words' `diffRowsView` rows); never a `<bdi>` inside a line (an isolate undoes byte order) |
| RegionOverlay | L5.12b: a region over a picture by its shares (0–1), its label at the corner, dashed while drawn; `aria-hidden` (the region is said in words beside it) | presentational: the drag surface is the caller's |
| DataTable | L5.12c: a native table — a caption (visible, or hidden and still its name), column headers `th scope="col"`, each row headed by its first cell (`th scope="row"`), a cell without a value a quiet dash; figures right-aligned (`numeric`); cells wrap (no inner scroll) | a component's slots and params; not for a list that selects (RowList) |
| ColorField | L5.12c: one colour — the native `<input type="color">` (its well is the swatch dragged from: each move `onDraft`, its native `change` `onCommit`) and the hex typed beside it (Enter or leaving writes, once; empty and removable removes; anything else goes back), while dragged a dot of the written colour (a hex only) and "previewing #…" in words, a hint; nothing written: the well hatched and dashed (a shape, never a fade) and "not set (the picker starts at #…)" in hidden words describing both inputs; `version` (a new one shows the written value again: a refused write re-read); `onText` (the caller owns the text: every keystroke, kept as typed — a form) | the kit holds no colour: the picker's value and the swatch come from the caller (theme data); the hex field is named by the label and a hidden "hex" |
| AppMark | L5.13b: the app mark, `full` / `small` / `tiny` at a given size (mark.ts's drawing, `--ui-mark-*`), `aria-hidden` | the title bar and Welcome only; the name always beside it (The mark and the name) |

L5.12b also gave the kit: Segmented options a `testId` (the comments' `filter-*`), TrackItem `to` (a tick that is a
link: a comment's pin), Scrubber `label`, TextArea `onKeyDown` (⌘↩ posts), LinkButton `onClick` (a hand-off before it
goes), RowListItem `status`. L5.12c: Sheet `content` (fields under the text, outside its description: a copy's name,
Create with Claude's form) and an action's `disabled`; TextField `onBlur`; Switch's row layout passes its `testId`;
(fixes) PosterCard / FrameCard `tabIndex`, `labelledBy`, `describedBy` (a roving grid's stop named by its title);
LinkButton `id`, `labelledBy`, `tabIndex`; the token `--ui-pressed` (a pressed toggle's bar, not the focus ring's colour).

## The screens (from the canvas)

The Project and Scenario reference is **B32 (« B·3b Épure », round 3, validated)** — `B32-Projet` and `B32-Scenario`,
layout and drawing. C1 / C2 are round 1's rejected « Script » direction: not used. The canvas says "Retake"; the
Studio keeps `APP_NAME` (L5.13 renames).

- **Welcome** (no project open; R4-Welcome) — built in L5.10a: R4's identity column — the app's 128 px mark (full: The mark and the name), its name,
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
  name and the last take under 1000 px, Command… down to its icon —, what a take holds is never dropped: at 1000 px and
  less its short form ("a render slowed by a take", "2 jobs wait for a take"), the blocker's words are never cut; nothing scrolls
  sideways at 900 px. Stop and Pause act on the scenario's run with a job first (a terminal's run beside it: Ctrl-C
  there). A screen may claim the slot (Prepare, the live screen while its run goes, a live recording): the buttons hide,
  the commands stay. The polite line says command answers and a run's start, stop or refusal — never a step's progress;
  it is text, one line at a time, gone after 6 s and when the screen changes. ⌘. always answers (with the palette open
  it closes it first). "Rehearse" is the Studio's word for a dry run (`retake run … --dry`, MCP `run_dry`); Prepare
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
  "Renders and review" section at its end (L5.12a: the queue, the newest three, Open the review report). One selection drives the board, the browser and
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
- **Edit** (R4-Edit) — built in L5.12a: the browser pane hidden (`BrowserCollapsed`); the h1 "<scenario> — Edit" for
  assistive technology only; the title bar's context: *Take* (a select, with more than one capture). Centre: the notes
  that matter now (a refused Render, a proposal's banner, why the switches are off, the workspace components the preview
  waits to run with *Allow in the preview*, a slow scrub), the **stage** — the preview at the video's ratio, as large
  as what the tracks leave (a size container), its notes over it (Loading, Buffering, cannot play, stopped + Restart) —,
  the playhead's words under it, the **transport** (a Toolbar: Previous frame, Play / Pause, Next frame, the time and
  frame, Unmute — kept although R4 draws none —, Speed, Comment (C), Fit / Zoom in), the take's facts; the **tracks**
  (kit Track / TrackItem on a pane: Segments with their component and the transition as a band, Captions, Steps,
  Camera with its ramp, Speed with its cuts, Markers, Comments; the Scrubber with time labels on a round step; the
  Playhead over the lanes, never a prop of the tracks); the key hints; the comments made on another take; *Warnings and
  notes* (a Disclosure). Inspector: the switch's answer and a 409's offer on top (sticky), then the selected segment
  (its name, times and steps; said in the inspector's own polite region) and the whole video — every switch a fieldset
  of **ChoiceChips** (a radio group of buttons: one tab stop, arrows move, Space / Enter picks, a chip that cannot be
  taken stays focusable with " — why"), a speed or a duration with a NumberField and Set. Status bar (the screen's):
  what is on screen (plain words, no tag), the render line (polite), Cancel the render, Undo · Redo (⌘Z while a switch is
  in flight is queued and said; dropped and said when that switch is not saved), Render (⌘B: Edit's, through
  useRenders; off with why on a proposal — in every state of the screen, the status bar's own Render too). The
  inspector's general hint is last; an empty answer line takes no room. The transport roves with the arrows after a Tab;
  after a click they stay the playhead's (`Toolbar clickLeavesKeys`). Deviations: the
  inspector's transition / speed / theme stay chips (R4 draws selects; the chips keep the one keyboard model and every
  reason in sight), no ruler of its own (time labels on the scrubber), the take as captured / proposed edit words in the
  status bar rather than a caption under the preview; Phone / Tablet / Picture-in-picture follow the plan's choices only.
- **Review — report and exports** (R4-Review) — built in L5.12a (`#/…/review[/<render>]`): the title bar's View (Report
  · Comments (n open); Review opens the view this tab used last, the report first); the browser hidden. Head: the
  scenario and the version, its facts and "from this version" against the file on disk, the counts in words (never
  "passed"), the render picker. **Contact sheet** (kit ContactSheet: the review's sheets as it kept them, one request at
  a time, larger on click), **Checks** (one RowList listbox; each family a group with its count; severity as a mark and
  a word; ↑ ↓ Home End), "Nothing else found."; the inspector **Selected check** (the finding's frame, severity, message
  as text, Where / At / Check / Code, Show in Edit); **Renders** (the queue with Cancel, a failure, newest five, Show
  all; a row is a link to its report — `RowCard to`, `aria-current` on the one shown; the time of day where two read the
  same); **Export** (Export video (MP4): the Studio's `review_export` — one export job, 1080p, the fixed folder, two
  exports of the workspace at most; the raw capture as a command with Copy). Status bar: Rendered · when · vN (a neutral
  mark), Open in Edit, Render again
  (⌘B: the report's). Empty states: no render (Render), a review queued (progress) or failed (its message), an unknown
  render. Deviations: "n passed", Open the step, Show in Finder, the per-scene rows with times (the review's own scene
  sheets as they are) — BL-132.
- **Review — frame comments** (R4-Comments) — built in L5.12b (`#/…/comments[/<thread> | /at/<render>/<frame>]`): the
  title bar's View (the Comments segment keeps `comments-tab`, "Comments (n open)"). Browser pane: the threads (Open ·
  Resolved · All, This render only, counts; rows are links; All grouped Open / Resolved; the list shown stays while a
  filter is read, with its own words — the filter it was read with — marked busy). Centre: "Frame N · vN · rendered … · theme …" with the render picker; the frame with the region
  (RegionOverlay), the Scrubber "Frame", markers and pins on one lane ("Marks & pins"; a pin is a link to its thread),
  ± 1 s and ◀ ▶, the typed time; the composer under it (the region's four % fields, Clear, "Where it points" as tags,
  the text, ⌘↩, Post — arriving to comment a frame, the text and Post scroll into view and the text is focused) or
  "Comment this frame" while a thread is open. Status bar: Review's line, shared with the report — "Rendered · when · vN
  · n open · n resolved", Open in Edit, Render (never Shoot's actions). Inspector: the thread (status, channel, text, chips,
  region, newer renders, still when gone, entries), Claude's proposal (summary, rewrite note, the DiffTable with
  "scenarios/<name>.yaml · line N", the offered buttons, Undo apply, the render after it, Resolve with vN), Reply,
  Resolve, Reopen; while none is open, how comments work. Edit shows the proposal's banner (a Callout: never applies).
  Deviations: no 64 px thumbnail per row (a still read per row: BL-133); the inspector 320 px (the token), R4 380. At
  900 px the panes keep their places (a trade-off: the frame ≥ 260 px, the diff's code column ≥ 160 px with its lines
  wrapped, no sideways scroll — an e2e holds it); drawing a region there is easier with the four % fields.
- **README** — built in L5.12b on the kit: a tall text area, the save state in words, Save / Discard changes, the count
  and its cap, ⌘S; Callouts for a missing README, a notice, an error; the conflict panel and kept text (TextEditing.tsx);
  read-only with why on `readme_error`. No Markdown preview (deliberate).
- **Library** (R4-Library) — built in L5.12c (`#/p/<slug>/library[/<theme>[/<ns>/<name>]]`): the browser's Library
  group (Components, Themes) and the project's themes (a row shows the Library in that theme); the title bar's Theme
  select; the centre's "Components · n in <theme>", Create with Claude…, Source (Segmented), the search, the Kind chips
  ("All (41)", "Intros (4)"), the notices, a section of poster cards per kind — a card is one selection control (a
  pressed button named by the component's name) with Play under it inside the card's frame (a toggle with one name,
  "Play <name>", pressed = `--ui-pressed`'s bar and a pause icon; the poster's "Playing · loop" mark says it plays),
  Retry, Render again; the grid is one tab stop (arrows, Home / End, Escape; Enter on the selected card goes to its
  inspector; with the inspector hidden the selected card links to its page); the inspector: the selected card's picture, facts (kind, slots, length, kit — a mark and
  a word —, the themes that pick it), Play in the theme, Open the details, Create with Claude…, Theme default (Set as
  default…: a Sheet, Return sets; a starter: a Sheet for the copy's name, "Copy as <name> and set"), About; nothing
  selected: the theme's summary; the status bar: Idle / n previews queued · "Posters render while their cards are on
  screen", Render all loops, Open the theme editor. A component's page keeps the picture large, About and the slots /
  params as DataTables, the README as text. Create with Claude is a Sheet (Copy the prompt the default; the words kept
  across a close). Deviation: Play stays under each poster (R4 draws cards without buttons: BL-134).
- **Theme editor** (R4-Theme) — built in L5.12c (`#/p/<slug>/themes[/<theme>]`): the browser is the theme's sections (a
  row brings the inspector's section and focuses it) and its components (links to the library in this theme); the centre
  the name with Editable / Read-only and Starter / Workspace as tags, what uses it, Copy to edit… (a Sheet), the status
  line, ONE live preview with a target Segmented (Intro · Clip with caption · Outro), Play / Restart, the held components
  with Allow, Use in a scenario; the inspector the fields (ColorFields with the contrast lines under them, the background,
  Type, Motion and cursor, Max zoom, Components per kind); the status bar "Ready · each change is saved and checked",
  Undo, Redo, Extract from a website…, Use in a scenario…. The Themes list: rows with swatches, tags, what uses each,
  Edit / Open, Copy to edit… (a Sheet); New theme; the site panel (commands only). Deviations: one preview, not R4's
  three tiles; no "Content from <scenario>" (no data: theme_preview has no scenario target); Undo / Redo in the status
  bar only (BL-134).
- **Confirmation sheet** — the kit's Sheet. Built in L5.9; screens adopt it in L5.10 – L5.12. L5.11a: the capture's
  sessions confirmation (R4-Confirm) — Cancel (Escape) · "Sign in <persona> first…" (the default and the focus: the
  canvas's Return on Capture anyway is not taken — a session known to be bad would run the hooks) · Capture anyway (the
  record variant); the personas with their states and what the capture does with each; one sheet in the shell for the
  status bar's Capture, ⇧⌘R and Prepare's Start capture.
- **⌘K palette** (R4-Palette) — the kit's CommandPalette with the shell's commands. Built in L5.9; L5.11a: the
  Scenario menu's commands (the browser tab's way to them: ⌘R / ⇧⌘R / ⌘B / ⌘. stay the browser's there). L5.12b: the
  groups Commands (Rehearse · Capture · Render · Stop, or a live recording's own; "Comment at this frame"; the
  inspector) · Go to (the modes, "Review report — last render · <words>", the project's pages, All projects, UI gallery) ·
  Scenes (the Scenario screen's and Edit's, through `paletteGroup`) · Themes (the scenario's theme on Edit, the
  project's, All themes) · Scenarios · Projects; an icon per row; the legend (read by assistive technology too);
  "Commands with a key are also in the menu bar" only in the desktop app (a row shows a key only when it is a menu bar
  item). An entry never writes (a theme row opens the theme editor; a scene on the YAML view goes to its lines) — but the
  Scenario menu's own commands, which act as from the menu. Deviation: no "Open renders" entry (it is Review › Report:
  BL-133).
- **Light appearance** — the same layout, the mapped palette. Built in L5.9 (tokens).

- **The quit sheet (R4-Confirm, L5.12d)** — in the desktop app only, the quit question the shell asks
  (`studio:quit`): a kit Sheet over whatever is open, the shell's words as text (title, the lines and bullets pre-line,
  up to the shell's own bound of 4 000), the alert's buttons in its visual order and its keys — the default rightmost,
  as in every kit Sheet: unsaved text [Quit Anyway (destructive, no key)] [Cancel ●], jobs only [Cancel] [Quit
  Anyway ●] —, Escape = Cancel, Return on a focused destructive button = the default (Space presses it); it acks once it
  is painted and visible and answers through `desktop_answer`, staying open and busy until the answer arrives (a failed
  one is said in the sheet, which stays answerable); the native alert after 1.5 s without an ack (DESIGN §4j).
- **The screens outside the shell (L5.12d)** — Connecting (a Progress), the start error (a Callout), the session ended
  (a Callout and each unsaved text in a read-only TextArea to copy), the not-found screen (an EmptyState, level 1).

- **The Set-up sheet (L5.16c)** — in the installed app only (the window page's `__studioShell` flag; a browser tab never
  shows it), a kit Sheet wider than a confirmation (the palette's width, scrolling inside the window, opened at its
  top): its title "Set up Retake", one sentence ("Each step is optional…"), then one Checklist ("Set-up steps") of
  eight items — Workspace, Retake home, Command line, Claude Code, Claude Desktop, Notifications, Screen recording,
  Local network — each with its state word (a word of the colour-only rule's list: Open, Default, Ready to install,
  Installed, Conflict: another copy, Blocked: another file is there, Ready, Missing: not found, Ready to add, Added,
  Conflict: another entry, Invalid settings file, Pending: asked at the first one, Allowed, Not needed, Pending: asked
  when needed; "Blocked: move the app first" on the three steps that record the app's path while it runs from a
  translocated copy, its disk image or /Volumes, under an attention Callout saying "Move Retake to Applications, then
  open it again"), its paths as mono text, its commands as Blockers to copy (the zsh PATH line, the two `claude plugin`
  lines, the Claude Desktop entry), and its actions: Install retake / Replace · Choose a Folder… · Uninstall… (an inline
  confirmation, destructive), Run, Add to Claude Desktop… / Replace… (an inline confirmation showing the file and the
  entry), Allow…. An action's outcome is a Callout under its item (`role="alert"` when it failed); Claude Code's output
  and the Claude Desktop entry there now are text (`Txt`: markup shown, controls made visible). Done is the default; it
  alone remembers the sheet (Escape closes it without that: it opens again at the next start). It opens by itself at
  the first start, on the shell's `studio:setup` event (Help › Set Up Retake…, Install / Uninstall the retake Command…)
  and at `#/setup` (the projects behind it; Done goes back to `#/`). L5.16c fixes — **focus**: the sheet opens on its
  title (`focusTitle`); Help › Install… focuses the command's first action, Help › Uninstall… the confirmation's
  Uninstall (Keep it when nothing is installed); an inline confirmation takes the focus on its first button and gives it
  back to its opener on Keep it / Cancel; after an action, its button keeps the focus, else the item's first action,
  else the item's title. The folder panel is said ("Choose the folder in the panel the app opened", attention) only once
  the shell says it opened, "No folder was chosen…" after a cancel; Claude Desktop running — or not known (`ps`
  failed) — is an attention Callout and keeps Add off; the process list is read only while that step is in view (or
  the window comes to front). Its a11y tour: dark at 1280 / 1440 / 900 and light, the Tab walk inside the modal, in the
  ordinary and the "move the app" states, and the focus steps above checked by `document.activeElement`
  (`test/studio-e2e-setup.test.ts`).

- **The update (L5.16d)** — in the desktop app only (`__studioShell`), and only while the app's own server says an
  update is known, under way or failed for a version: a ghost kit Button in the status bar's state area ("Update
  available · v0.2.1", "Downloading v0.2.1…", "Update waits for 2 jobs", "Installing v0.2.1…", "Update v0.2.1 failed",
  "Update v0.2.1 not installed", "Update v0.2.1: install it from its disk image"; a live button with `aria-busy` while a
  step runs — it reopens the sheet, where Later is), nothing when up to date or off. It opens a kit Sheet: "Update
  Retake to v0.2.1?", one sentence in the future tense (what Install and Restart will do, what is kept, when the feed was
  last checked), the release notes (the feed's text through `Txt`, line breaks kept, in a focusable region named
  "Release notes, from the update feed" that scrolls past 12 rem from the keyboard — markup shown, never rendered),
  then the step under way, the failure or "off" as a Callout (title and sentence; `role="alert"` for a failure). The
  sheet stays open on a click's refusal (not writable, off) and while a check runs; it sets `white-space: normal` (it is
  rendered inside the one-line status bar). Actions: Later · Install and Restart ● while an update can be installed
  (available, or a failure the shell may retry: Later then acknowledges it), Close · Later ● while it downloads or
  waits for jobs (Later stops it), Close otherwise. The click goes to the shell through `desktop_update`; a click that
  did not arrive is said in the sheet. It opens on the button and on the shell's `studio:update` event (Help › Check
  for Updates… found one). Its a11y tour: dark at 1280 / 900 and light (`test/studio-e2e-update.test.ts`).

**The legacy layer is gone (L5.12d).** Every screen is on the kit: `app.css` (the cascade layer `legacy`) is deleted, the
ratchet table `test/legacy-controls.json` is `{}` (every file holds zero findings), bits.tsx keeps only `Txt`, `shown`
and small helpers (no Badge, Notice or Loading). A class word given in a JSX `className` or an object's `className:`
field — a const or a one-expression helper of the same file it names included, a comparison's strings left out — is a
class of a stylesheet or one of the named hooks, each with its reason (a lint), so a legacy class written there fails;
what the lint does not see is a template's variable part (`k-btn-${variant}` passes on the prefix) or a class built
in another file.

**Motion (L5.12d).** Every animation or transition of the stylesheets has a later rule of its own selector, in cascade
order (base → kit → shell → screens), off under `prefers-reduced-motion: reduce` (a lint; today the spinner, the indeterminate progress and the switch's knob); no smooth
scrolling anywhere (every scroll call says `behavior: 'auto'`, a lint; Edit's follow-while-playing is instant).

## The mark and the name

The name is `brand.ts`'s `APP_NAME` (L5.13a) and the desktop app's `productName` in `tauri.conf.json`. The mark is
**"two takes"** (L5.13b; declension « Nette » of the canvas, kept exactly as validated): the previous take as a blue
outline behind, the new one in front with a play triangle, on a plate — one drawing, `packages/ui/src/mark.ts`, on a
100-unit grid (plate 96 with 22-unit corners), in three variants by the size it is seen at (the bands are
`markVariantFor`'s):

| variant | size | drawing | where |
|---|---|---|---|
| full | ≥ 64 px | back take a 6-unit outline (50 × 36 at 17, 21), front take filled (50 × 36 at 33, 43), play triangle in the plate's colour (2.5 stroke, round joins) | Welcome (128 px), the desktop icon (1024, and the icns' 128 – 1024 slots) |
| small | 21 – 63 px | frames 52 × 38 at 15, 19 / 33, 43, an 8-unit outline, no triangle | the icns' 32 pt slot (32 and 64 px) |
| tiny | ≤ 20 px | both takes filled (56 × 40 at 12, 16; 56 × 42 at 32, 40), no triangle | the title bar (18 px), the favicon, the icns' 16 pt slot |

| token | dark | light | use |
|---|---|---|---|
| `--ui-mark-plate` | `#2a2e37` | `#141823` | the plate and the triangle — a quiet lift in dark (≈ 1.3:1 on the `#18191c` title bar, accepted as decorative: the blue take carries the mark; an ink plate would vanish), the ink plate in light (the canvas's light-plate declension is not used: its triangle cannot be plate-coloured) |
| `--ui-mark-back` | `#3d7bff` | `#3d7bff` | the back take |
| `--ui-mark-front` | `#f4f5f7` | `#f4f5f7` | the front take |

- **In the page:** the kit's `AppMark` (`variant`, `size`) — inline SVG, `aria-hidden` (the name is always written
  beside it), painted by `.k-appmark-*` classes on those tokens (no colour in the component); the gallery shows the three
  variants in both appearances.
- **The favicon** is the tiny mark on the fixed ink palette (tokens.ts `MARK_INK`: plate `#141823`, back `#3d7bff`,
  front `#f4f5f7` — a favicon does not follow the page's appearance in every browser), a `data:image/svg+xml` URL in
  the document (the CSP's `img-src 'self' data:`; no route serves it).
- **The desktop icon** is generated: `pnpm -F @retake/ui gen:mark` writes `apps/desktop/icons/icon.svg` (the full mark
  on macOS's icon grid: a 1024 canvas, the plate 824 wide at 100), `icon.png` (1024², sharp), the iconset's 16 and 32 pt
  slots drawn for their size (`iconset/icon_16x16{,@2x}.png` tiny, `icon_32x32{,@2x}.png` small) and `icon.json` (the
  hash of each SVG a PNG was made from); a test compares them with `mark.ts` (ui `mark.test.ts`: the SVGs as text, each
  PNG's pixels against its SVG rasterised again, within a tolerance). `desktop.mjs` requires the four drawn files at
  their pixel sizes and fails the build otherwise.
- **Contrast:** the back take on the plate, the front take on the back and on the plate, ≥ 3:1 in both appearances
  (app-source's mark pairs).
- Don't: draw the mark anywhere but through `mark.ts` (`AppMark`, `markSvg`); give it a meaning (it is never a button
  or a state); put the triangle on the small or tiny variants. At Dock size the light front take with its triangle
  reads close to a well-known video platform's logo — the person chose to keep the drawing as validated (2026-11-03);
  the macOS 26 appearance variants (Icon Composer: dark, tinted) are BACKLOG BL-136.
