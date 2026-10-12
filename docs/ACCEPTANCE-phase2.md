# Phase 2 acceptance (lot L2.14)

SPEC §14.2: *render two videos (supplier "catalogue" and buyer "quote request") from scenarios; the review report is
clean; the output is reviewed by Claude through contact sheets; switching a component or theme re-renders without
touching the scenario.* Done on 2026-10-12 in the Linux cloud container (4 CPUs, no GPU, headless Chromium 141) with
the engine as committed in L2.14. Verdict: **accepted**.

The review folders (`projects/northfield-fixture/review/<render>/`) are git-ignored, so this note lives in `docs/`.
Reproduce with the commands at the end (the fixture must be running for the captures).

## Captures (fresh, current engine)

| Run | Scenario | Capture | Steps | Notes |
|---|---|---|---|---|
| `20261012-144004-catalogue` | catalogue (supplier) | 85.0 s, 1920×1080 @ 30 fps | 21/21 | run warning: 20 of 25 cursor moves captured below 18 fps (software rendering, no GPU — L1.3 / L1.5) |
| `20261012-144221-quote` | quote (buyer) | 58.3 s, 1920×1080 @ 30 fps | 25/25 | run warning: 11 of 18 cursor moves below 18 fps (dialog backdrop blur) |

## Renders and reviews

| Render | What | Length | `studio review` | Folder |
|---|---|---|---|---|
| **catalogue-v7** | editorial theme | 71.87 s | **clean** (no error, no warning; 4 info) | `review/catalogue-v7/` |
| **quote-v17** | editorial theme | 69.97 s | **clean** (2 info) | `review/quote-v17/` |
| **quote-v18** | the same run, **theme switched** to motion | 71.23 s | **clean** (12 info) | `review/quote-v18/` |
| **quote-v19** | the same run, editorial, **one component switched**: layout `studio/layout-laptop` | 69.97 s | **clean** (6 info) | `review/quote-v19/` |
| **own-media-v9** | your own media: intro video, alpha overlay, Lottie card + overlay, image outro, music bed | 46.03 s | **clean** (3 info) | `review/own-media-v9/` |

Info items (none is a defect): catalogue — the availability scene lasts 26.2 s (look target 4–25 s; dense action at the
scenario's 1.6× speed) and the scenario's own camera hint zooms 1.3× in 2.2 s on the awards (the look prefers ≈ 1.12×
over ≈ 6 s); quote-v18 — the motion theme's default zoom 1.12× in 2.8 s on the marked proposal; own-media — 46 s is
inside the 25 % tolerance of the 60–120 s target; the rest are the diffs against the previous render.

Earlier renders of the lot: catalogue-v6 / quote-v14 (same captures, before the two fixes below — the reviews of v7 /
v17 against them: *no visible change* in 72 / 70 sample frames), quote-v15 / quote-v16 (first motion / laptop
renders, superseded by v18 / v19).

## Switching a theme and a component without touching the scenario (R-ACC2-02, R-ACC2-06)
`git diff -- projects/ templates/` is empty: no scenario, project or template file was edited. Both switches are render
options of the same capture:

- **Theme** — `studio render northfield-fixture quote --run 20261012-144221-quote --theme motion` (= `EditOverrides
  {theme: 'motion'}`). The motion template picks its own components: the review's diff against quote-v17 lists
  `intro-stack → intro-minimal`, `caption-below → caption-overlay`, `interstitial-clock → interstitial-plain`,
  `crossfade → fade-black` on every join and the motion layout params (radius, strong shadow); the layout stays
  `studio/layout-card` because the project asks for `frame: card` (a project / scenario frame wins over the theme's
  own `layout-browser`), and the theme's default zoom adds one slow 1.12× zoom on the marked step.
- **One component** — `studio render northfield-fixture quote --run 20261012-144221-quote --theme editorial --frame
  studio/layout-laptop` (= `EditOverrides {frame: 'studio/layout-laptop'}`; `--frame` takes a frame style or any
  layout component id). The diff of quote-v19 against quote-v17 names exactly one change per clip — `layout:
  studio/layout-card → studio/layout-laptop; layout geometry` — same length, same captions, transitions and cards.
  Other kinds switch the same way through the engine API (`renderVideo({overrides: {components: {caption:
  'studio/caption-overlay'}}})`, or per segment id); the CLI only exposes the layout (`--frame`) — the Studio app (L4.5)
  and the MCP tools (L3.2) will expose the rest.

## Contact-sheet review by Claude (R-ACC2-05)
Read as an agent reads them: `sheet_1fps*.jpg` of the five renders, every `sheet_scene_<id>.jpg` of catalogue and
quote, the key frames (`intro-hold`, `outro-hold`, every marker, the first / last frame of the scenes with dialogs,
notifications and the interstitial), the diff sheet of quote-v19, plus full-size ffmpeg crops where a sheet left a
doubt (the notification banner across the end of "delivery", the alpha burst of own-media). Checked against
`docs/reference/look.md`:

**catalogue-v7 (editorial) — accepted.**
- Intro: logo mark + wordmark row, kicker "FOR SUPPLIERS", title "Manage your catalogue", accent rule; fades in, holds,
  crossfades into the first clip. Outro: logo, wordmark, rule, tagline, URL.
- Layout: the capture in the rounded card (180, 40, 1560 × 878) with its soft shadow on the paper background; kicker
  row with its accent rule + one display-font caption line under the card; brand mark right-aligned with the card.
- Motion: four 0.35 s crossfades (one per join, none over a click — the review's transition check), no camera move
  except the scenario's single zoom on the awards in the last scene (held into the outro): no zoom at a cut.
- Pacing: the import's progress and the registry's "Enrichment in progress" skeleton play sped up (up to 4× after
  their first 0.5 s) as short loading states, ≈ 1.5 s each on screen; no stretch of slow action (longest scene 26.2 s, a click every ≈ 1–3 s); the
  drag of the price-list chip from the right edge into the drop zone is continuous.
- Key frames: `import-done` = "Import complete — 921 offers created", `reveal` = the product page filled in (after the
  fix below).

**quote-v17 (editorial) — accepted.**
- Same intro / layout / caption / brand-mark checks; the chapter card "Step two — Ask the roaster for a quote", the
  dark-clock interstitial "A few hours later" (dims from the last frame, 100 px clock, paper text), the PDF card zooming
  slowly into the real one-page quote, the outro.
- The captured macOS-style notification ("New quote request — Demo Café asks for Selowa Ridge · 3 × 5 kg") slides in at
  the top right when the console showed it, stays fully inside the frame for its hold (crops at 46.3–48.6 s: right edge
  at x 1900) and slides out at the end of the clip — its exit motion, not a cut-off.
- The callout "Total incl. VAT, ready to accept" points at €720.00 at the marked step; it sits over the subtotal / VAT
  amounts for its 2.5 s (above is the only side with room — the total, the Accept button the cursor goes to next and
  the cursor stay clear). Accepted.
- Every caption on one line, the step caption "Instantly" replaces the scene caption on the notification hold.

**quote-v18 (motion theme) — accepted, one observation.** Night background, minimal intro, caption bands over the
bottom of the capture (two lines where needed, kicker in the theme accent), plain interstitial, fade-through-black
joins, the slow 1.12× zoom on the proposal. Observation: with `frame: card` from the project and a caption that goes
over the screen, the card keeps the room of the (empty) caption block — ≈ 160 px of background under it. Not a
defect of this lot's scope: recorded as **BL-54** in `docs/BACKLOG.md`.

**quote-v19 (laptop layout) — accepted.** The capture inside the laptop's screen, captions and brand mark under the
device, the callout and the notification mapped through the device screen; only the layout differs from quote-v17
(diff sheet: every changed sample frame is the device frame).

**own-media-v9 (your own media) — accepted.** See "Your own media" below.

### Problems found during the review, and their fixes
1. **Marker key frames showed the wrong moment.** `keyframes/import-done.png` of catalogue-v6 showed the click on
   "Start import" with its spinner, `reveal.png` the loading skeleton, quote-v14's `proposal.png` the total before its
   callout: a timeline marker sits at the *start* of its step (DESIGN §timeline), so the review's key frame of a marked
   wait showed the waiting, not the awaited state its name promises. Fix: the planner gives every plan marker a
   `done` frame — "the screen once the marked step is done" (`markDoneAt`: within its hold, else 0.25 s after the step;
   the rule story-card `frame: mark:` already used) — and the review's key frame of a marker is that frame
   (`timeline.json` markers gain `done_frame` / `done_time`). Tests: planner-real (each `done` lies after the end of
   its marked wait), review checks (key frame = `done`). Re-rendered: catalogue-v7 / quote-v17 key frames show
   "921 offers created", the filled product page and the callout on €720.00.
2. **R-CMP-01 leak in the composition** (see the audit below): a fade without a transition component was drawn by the
   composition itself with a hard-coded black veil. Fixed; no visible change (the diffs above), since the planner
   never planned such a fade.

## R-CMP-01 audit — every visual element is a component
Grep of the edit composition (`packages/editor/src/remotion/`) and the render code for colours, text and shapes drawn
outside components:

- **Fixed — the plain fade envelope.** `DemoVideo.tsx` had an `Envelope` that, for a crossfade / dip without a
  transition component, faded the segment itself and laid a `#000000` veil over it. Now every fade is a transition
  component: `transitionWindows` gives a fade that carries none the transition stand-in (`standInTransition`, drawn by
  the transition scaffold, like any missing component) and the envelope is gone; the review's transition spans lost
  their component-less "fade" branch. Guards (`render-units.test.ts`): the planner never plans a non-cut transition
  without a component (editorial and motion plans), a component-less fade gets the stand-in, and **no colour literal**
  (`#rgb…`, `rgb(a)()`, `hsl(a)()`) appears in `src/remotion/`.
- **Justified exceptions (documented in DESIGN-phase2 §2.2):** the theme **background** behind every segment
  (`backgroundCss(theme)`: the theme's own token, the canvas the components draw on) and the **brand mark** (the kit's
  `Logo` + `Wordmark` — the primitives components use — sized, positioned and faded by the theme's `brandmark`
  settings in the rect the layout component declares). They stay in the composition because they are one layer for
  every layout (above the screen-layer overlays, under the caption, included in interstitial backdrops) and carry no
  look of their own: a theme changes them, and a layout that declares no `brandmark` rect gets none.
- Everything else the composition does is plumbing, not drawing: the capture frame (the layouts' `screen`), the camera /
  reframe transforms, the PiP clip-path around an inset, the loupe's two capture regions cross-faded inside the lens
  component, overlay placement, the music. The planner resolves every visual of a plan (intro, outro, card,
  interstitial, layout, caption, overlay, transition, progress bar, user files through `studio/media` /
  `studio/lottie`) to a component.

## Your own media (R-OWN on the acceptance)
`own-media-v9` = run `20261012-093815-own-media` re-rendered with the final engine (editorial + the 16 s test bed):
review clean, *no visible change* against own-media-v6 (L2.12), record `audio: music+files`. The user's intro video
(coffee bean, "Northfield", its chime) crossfades into the shop; the VP9-alpha burst plays over the dialog and the
dimmed page from the click on "Send request" — a full-size crop shows clean rays, no box, no halo; the Lottie cup card
in the theme accent, the Lottie check badge over empty space right of the quotes list, the end-card image as the outro.

## Raw export (R-RAW on the acceptance)
`studio export-capture northfield-fixture 20261012-144221-quote --format mp4 --fps 30 --cursor baked` (1 m 01 s) →
`exports/20261012-144221-quote-raw-mp430-baked/`: 4 clips (H.264 High, yuv420p, 30 fps, 1678 frames = 55.93 s; no
loading cut — every wait of this run was shorter than 0.3 s), 35 markers (4 scene, 25 step, 1 mark, 5 caption).
`scripts/validate-raw.py` (OpenTimelineIO 0.18.1 + the cmx_3600 and fcpx_xml adapters in a scratch venv) → **OK**:
every clip ffprobed against the manifest (frames counted, codec, profile, pix_fmt, BT.709 tv, timecode = sequence
position), FCPXML 1.10 well-formed (also `xmllint`), every time on the frame grid, spine and asset starts = timecodes,
35 markers inside their clips; the OTIO read back (V1 4 clips, 1678 frames, 35 markers, `file://` URLs); the EDL read
back by the cmx_3600 adapter (4 events, 35 locators); the FCPXML through the fcpx_xml adapter (4 clips, 1678 frames);
markers.csv = markers.json. The seven L2.13 packages validate OK with the same script. Imports into Final Cut Pro /
Premiere / Resolve remain R-RAW-06 (Mac, `docs/MACOS-CHECKLIST.md` step 12).

## Reproduce
```sh
node fixtures/wholesale/server.mjs &                     # then: kill <its pid>
node packages/cli/dist/bin.js run northfield-fixture catalogue
node packages/cli/dist/bin.js run northfield-fixture quote
node packages/cli/dist/bin.js render northfield-fixture catalogue --theme editorial --review
node packages/cli/dist/bin.js render northfield-fixture quote --theme editorial --review
node packages/cli/dist/bin.js render northfield-fixture quote --theme motion && node packages/cli/dist/bin.js review northfield-fixture latest --scenario quote --previous <editorial render>
node packages/cli/dist/bin.js render northfield-fixture quote --frame studio/layout-laptop && node packages/cli/dist/bin.js review northfield-fixture latest --scenario quote --previous <editorial render>
node packages/cli/dist/bin.js render northfield-fixture own-media --music projects/northfield-fixture/.demo-studio/test-bed.m4a --review
node packages/cli/dist/bin.js export-capture northfield-fixture latest --scenario quote
python3 scripts/validate-raw.py projects/northfield-fixture/exports/<run>-raw-mp430-baked
```
