# Field notes — choreography that worked on real products

Generic techniques extracted from a hand-written capture toolkit that produced real product videos before this tool
existed (cursor overlay injected into the page + one async function per scene). The runner must encode them.

## Cursor
- Arrow path (24-unit viewBox): `M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.6 20.3 L11.6 13.6 L17.8 13.6 Z`, fill `#111`,
  stroke `#fff` 1.4 with round joins, `drop-shadow(0 2px 3px rgba(0,0,0,.35))`, rendered at ~26 px; hotspot (4, 2).
- Motion: easeInOutCubic; slight arc — perpendicular offset `min(60, 0.08·d) · sin(π·e)`; duration
  `clamp(0.9·d, 450, 1100)` ms. Repeated clicks on (almost) the same spot use short moves (~250 ms) and a short
  hover (~120 ms) — never a 450 ms move of zero length.
- Ripple: 12 px disc, scale .4 → 5.5, opacity 1 → 0; transform .5 s `cubic-bezier(.2,.7,.2,1)`, opacity .55 s ease-out;
  template ripple colour (alpha ≈ .45).

## Clicks
- Sequence: move → hover events → ~200 ms → ripple → activate → `after` (300 ms; 600–1000 ms after opening a
  menu/popover; 1.5–2.8 s after an action that changes the page).
- Hit-test with `elementFromPoint` at the click point and act on the inner hit element when it is inside the target.
- Popups: if the trigger has `aria-haspopup` and `aria-expanded` is still not `"true"` ~160 ms after the click, replay a
  pointerdown/mousedown/pointerup/mouseup sequence (Radix-style selects). If the expected menu item is still absent after
  ~3 s, click the trigger once more.
- Close a popover inside a dialog with a full pointer sequence on the dialog heading — never Escape (closes the dialog).
- After a confirmation dialog, some menu libraries re-open the previous row menu: wait until no
  `[role=alertdialog]` is visible, and if a `[role=menu]` re-appeared, close it (Escape on the menu only) before going on.
- Row actions: the trigger is usually the button in the row's last cell; when nothing else identifies a trigger, its
  position (e.g. top-right corner of the header) is a last resort.

## Typing
- 8–11 chars/s in search fields, ~14 by default, up to 24 for long free-text messages; ±30 % per-character jitter.
- Clear a field before typing (select-all + delete, or native value setter + `input` event on React inputs).
- Type real secrets only into password fields (bullets on screen); a visible field shows them in the video (the runner
  warns) — sign in beforehand or type a showable value from `vars`.

## Scrolling & attention
- Eased scrolls of 1.5–2.2 s; scroll so the target sits ~140 px below the top; then park the cursor next to the target
  (not on the text) and hold 3–3.5 s.
- Scene start: put the cursor at an explicit neutral spot (right-centre of the screen), keep still 1.5–2 s.
- Draw attention to an element without clicking: move onto it and pause ~0.9 s (hover).
- After an action, park the cursor away from the area that changes, then hold 1.5–2.6 s on the result.

## Files, calendars, tabs
- File drop: a "file chip" (white, 1 px border, radius 12, shadow `0 16px 36px rgba(31,20,19,.22)`; a 36×44 badge
  coloured by extension — xlsx green, pdf red, csv grey, docx blue — with the extension in 10 px bold; name 15 px/600 and
  an optional detail line 12 px muted) follows the cursor at offset (−30, −22), rotated −3°, fades in .25 s, travels
  ~1.3 s from a start point to the drop zone, waits 250 ms, fades out; then the File is delivered (drop events or the
  hidden `<input type=file>` + `change`).
- Calendars: several can be mounted — always use the LAST VISIBLE navigation buttons; pick days by `aria-label`
  ("January 10th, 2027"); wait for a date popover to close before opening the next one; long month runs are quick clicks
  (~110 ms apart, ripple each) and get sped up ×3 in the edit.
- Links that open a new tab (downloads, documents): hover + ripple on the link, then open its href in a new page with
  the same viewport, and keep filming there.
- Notifications: the item is the smallest element containing the text inside the open popover; act on its closest
  interactive ancestor.
