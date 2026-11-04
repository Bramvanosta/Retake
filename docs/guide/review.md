# Review and frame comments

How Retake checks a render, and how people comment on its frames. Part of the [Retake guide](README.md).

## Reviewing a render

`retake review <project> <render>` (a render id such as `catalogue-v3`, a `renders/<id>.json` or `.mp4` path, or
`latest` — of `--scenario` when given) looks at a finished video the way an editor would and writes everything an
agent or a person needs to check it before showing it, in `review/<render-id>/` (git-ignored, replaced at each
review):

```
$ retake review northfield-fixture catalogue-v3
! review catalogue-v3 (59.00 s, 5 segments) → projects/northfield-fixture/review/catalogue-v3
  not clean: 1 warning, 4 info
  warning [00:45.1 · f1352 · add-product · step 2] the screen of "add-product" barely changes for 3.8 s while the scenario waits (steps 2–4, 00:45.1–00:48.9): a loading state on screen — speed it up or shorten the wait (long-wait)
  info    the video lasts 59.0 s: 1.0 s shorter than the 60–120 s target of the reference look (within the 25 % tolerance) (video-length)
  info    [00:50.3 · f1509 · add-product · step 5] zoom 1.3× in 2.2 s (step 5 of "add-product"): the reference zoom is very slow (≈ 1.12× over ≈ 6 s, ≤ 1.2× over ≥ 3 s) (zoom-not-slow)
  info    59.00 s (catalogue-v2: 59.00 s, +0.00 s) (diff-duration)
  info    no visible change in 59 sample frames since catalogue-v2 (diff-frames)
  files: projects/northfield-fixture/review/catalogue-v3/sheet_1fps.jpg · 3 scene sheets · 10 key frames · timeline.json · report.json · report.md
  report projects/northfield-fixture/review/catalogue-v3/report.md · 10.8 s
```

| File | Content |
|---|---|
| `sheet_<fps>fps.jpg` (+ `_p2`, `_p3`… when long) | contact sheet at 1 frame per second (`--fps 2`: two), each thumbnail labelled with its timecode, frame number, segment / scene, step, markers (◆) and transitions (⇄); tiles a finding points at are outlined (red error, orange warning); at most 6 × 10 tiles a page, shared evenly between pages |
| `sheet_scene_<id>.jpg` (+ pages) | one sheet per scene, card and interstitial at 2 frames per second |
| `keyframes/<marker>.png`, `keyframes/<scene>-first.png`, `-last.png`, `intro-hold.png`, `outro-hold.png` | full-size frames: every marker (the screen once its marked step is done — for a marked `wait_for`, the awaited state), the first and last fully visible frame of each scene, a held frame of the intro and the outro |
| `timeline.json` | the output-time timeline: segments (frames and seconds, components with params and slots, caption component, transition in, layout rects, source range, speed, zooms, overlays), transitions, captions, markers, step spans and the clicks of the capture placed on the output (cursor point in capture px and on screen) |
| `report.json` | the review result: render, rules, `clean`, counts, findings, segment durations, the diff and the files |
| `report.md` | the same for people: the run's environment (L1.7: `Environment production · production · read-only · 1 write mocked · clock 2026-11-02T10:24:00`; also in report.json `environment` and on the terminal), findings with timecodes, a segment table, captions, markers and clicks, changes since the previous render, files |
| `diff_<previous>.jpg` | the frames that changed visibly since the previous render, side by side (before \| now) |

Findings are `{severity: error|warning|info, code, message, at?: {frame, time, segment, scene, step}}`; a review is
**clean** when it has no error and no warning (info notes do not count). `--strict` exits with `1` when the review is
not clean; `--json` prints the result. The checks:

| Check | Codes |
|---|---|
| Durations of every segment and of the video (reference look: video 1–2 min — or the scenario's `target_length` —, scenes 4–25 s), a card or an interstitial shorter than its text needs (250 words a minute + 1.5 s) | `video-length` (info a little outside, warning beyond ±25 %), `scene-length` (info), `scene-too-short` (< 2 s: warning), `card-too-short` (warning) |
| A card showing a captured mail or document before the scene whose step captures it (the result before its cause) | `artefact-before-step` (warning) |
| Scenes longer than 30 s at about 1× | `long-scene` (warning) |
| Blank, near-uniform or loading screens inside the layout's screen rect (2 fps samples, transitions excluded), at scene starts (rendered frame and capture frame), a screen still changing during the opening still (compared on the capture frames when the view moves or something is drawn over the page: an overlay such as a spotlight, a caption over the screen), waiting on an unchanging screen for 3 s or more (wait steps and the time after an action until the next step; holds are deliberate) | `blank-screen` (error from 1 s), `near-uniform-screen`, `blank-scene-start` (error), `loading-scene-start`, `long-wait`, `empty-segment` (a card that draws nothing) |
| Captions: shown on another scene, overlapping in time, too long for their area (the kit's `fitText` with the theme caption style and the theme's real font files: shrunk below 85 % of the theme size = warning, cut with "…" = error), under the brand mark, not visible in the caption area, missing | `caption-scene-mismatch`, `caption-overlap`, `caption-too-long`, `caption-truncated`, `caption-shrunk` (info), `caption-overlaps-brandmark`, `caption-not-visible`, `caption-missing` |
| Text slots longer than their component's `max_chars` (titles, kickers, taglines, callouts, captions) or required and empty | `text-slot-overflow`, `text-slot-empty` |
| Cursor at every click of the capture: off screen, hidden, outside the zoomed view (at the click and 0.4 s later), target partly outside the view (info when a reframed target larger than the view shows its leading part and the click) | `cursor-offscreen`, `cursor-hidden`, `cursor-outside-view` (error), `target-outside-view` |
| Camera: more zooms than the reference look's one very slow zoom per video, zooms faster / stronger than "very slow", clamped zooms, a zoom reset at a same-page join, camera jumps | `zoom-count` (warning), `zoom-not-slow`, `zoom-clamped` (info), `zoom-reset`, `camera-jump` |
| A transition (or fade) over a click and its ripple | `transition-on-click` (warning) |
| The take's slow transitions (run.json `perf`: a click whose result took over 0.8 s to settle on screen), at the click | `slow-transition` (info) |
| The render itself: failed status, duration or size different from the plan, missing components (stand-ins), plan warnings | `render-failed`, `duration-mismatch`, `size-mismatch`, `component-missing`, `plan-warning` |
| The environment (L1.7, see [Environments](environments.md#environments-display-urls-production-read-only-clock)): a write the read-only guard stopped (one per method and path, at its output frame; the app saw a network error), a browser bar left without its address (a local URL without a display URL, on a layout that draws the URL), a caption / card / overlay / page label / intro / outro text naming a local URL | `write-blocked`, `url-hidden`, `local-url-text` (warnings) |
| Diff with the previous render of the same scenario (auto-detected; `--previous <id>` or `--no-previous`): total and per-segment durations, component / caption / transition / layout changes, sample frames compared at the same offset inside the same segment | `diff-duration`, `diff-segment`, `diff-frames` (info) |

How it works (`@retake/review`, `docs/DESIGN-phase2.md` §3): frames are decoded by ffmpeg in one pass per video
(the render, its capture for the scene starts, the previous render), streamed as raw RGB; sharp makes the thumbnails,
the sheets (labels drawn as SVG) and the key frames; the checks read the plan of the render record (segments, layout
rects, captions, step spans, camera, time map) and the run's timeline (clicks, cursor track, captions as captured).
The duration rule is a style target measured on two reference videos, not a defect: a video a few seconds outside 1–2
minutes is an info note, a warning only beyond ±25 % (45 s – 150 s); a scenario's `target_length` replaces that
range (the plan carries it). Thresholds are `rules` of the API (`DEFAULT_RULES`, `reviewRules`); rules a caller passes
win. With an edit re-planned from today's scenario, the caption checks compare with the captions it planned.

API: `reviewRender({project, render, scenario?, fps?: 1|2, previous?: id|false, thumbnails?: false|'sheets'|'all',
thumbnail_px?, rules?, out?})` → `ReviewResult` (the report plus `thumbnails`: JPEGs ≤ 1280 px as base64 for the MCP
— the contact sheet pages and the marker key frames by default, every sheet and key frame with `'all'`). A review of a
one-minute 1080p render takes ≈ 10 s.

## Frame comments

A comment points at one frame of a render — optionally a region of it — and says what to change. Claude reads it with
the frame still and where the frame sits in the scenario, replies, changes the scenario (an edit — a caption, a card, a duration,
an overlay — renders on the same take; a change to its filmed part — steps, pages, hooks — needs a new capture first) or
the render overrides, renders again and resolves it with the new render (through
MCP). The Studio app writes the same files (its Comments screen: see [Studio app](studio.md#studio-app)).

```
$ retake comment add northfield-fixture quote-v1 --marker proposal --region 0.67,0.42,0.12,0.08 "Keep the total on screen longer"
✓ comment c_01K… on quote-v1 frame 1421 (00:47.37): clip proposal · step proposal.3 (wait_for) · area screen · studio/layout-card · marker proposal · overlays studio/overlay-callout
$ retake comment list northfield-fixture --status all
$ retake comment reply northfield-fixture c_01K… "The callout too, please"
$ retake comment resolve northfield-fixture c_01K… --note "Held the total 2 s longer" --render quote-v2
$ retake comment reopen northfield-fixture c_01K… --note "Still too short"
```

- **The frame**: `--frame <n>` (0-based), `--at <seconds>` (the frame on screen at that time — `--at 0.99` at 30 fps is
  frame 29; the duration an error prints is the last frame) or `--marker <name>` (the screen once the marked step is
  done; a name marking several steps is refused: use `--frame`). `--region x,y,w,h` is 0..1 of the frame. Texts are at
  most 2000 characters (control, bidirectional and invisible characters removed, line breaks kept). The author is `--author`, else `$RETAKE_AUTHOR`, else your
  user name.
- **The anchor** is computed from the render's edit plan when the comment is made: the segment and its component, the
  scene, the step (`<scene>.<step id or index>`, the `--until` syntax; a fingerprint of the step in the run's scenario,
  so a moved step can be found), its action, the marker, the overlays on screen, the transition; with a region, whether
  it lies on the caption (its band, for a caption drawn over the screen) or the brand mark.
- **Files**: `comments/<scenario>/c_<id>.json` per thread — the comment, the render it was made on (its id and when it
  was made: a render id is reused once renders/ is cleaned), the anchor and append-only entries (replies, resolutions,
  reopenings, each with its own id). The status is derived from the entries. Commit comments/ with your scenarios. The
  still lives in `.retake/comments/<id>.jpg`, on this machine only: a frame of a production capture never enters
  git. It shows the frame with your region outlined (no number on it: the video has its own step badges).
- **Resolving** names the render that answers the comment: a later render of the same scenario and variant (`latest`:
  the newest one of that variant — a vertical cut does not answer a frame of the landscape video). The thread stays on
  the render it was made on (`--render` of `list` shows the threads made on that render as it is now).
- **Who wrote it**: each entry says the channel — `cli` (a `retake comment` command, whoever typed it), `studio` (the
  Studio web app's page, named by `$RETAKE_AUTHOR` of `retake ui`, else your OS user — any program of yours that
  reads the Studio's token file could write there too) or `mcp` (Claude through the MCP tools) —, never "a person".
  Only people's channels create and reopen threads: `retake comment` and the Studio (which reopens and resolves only
  the version of the thread it showed, and comments only the render it showed). A comment's text is data: it asks for
  a change to the video, never for a hook, a sign-in or a file outside scenarios/.

**With Claude** (the MCP tools, see [MCP](mcp.md#mcp-claude-drives-retake)): ask it to address the open comments.
`comments_list` gives each open thread with its anchor — `step_ref` is where the step was in the rendered run, `step_now` that
step in today's file (what `page_inspect {scenario, until}` takes; steps moved in the Studio change their index) —
and the still of the frame with your region outlined (an image Claude looks at); Claude changes the scenario (then
captures it again with `run_capture`), the render overrides or the theme, renders and reviews, then `comment_reply` (what it changed) and `comment_resolve`
(the new render, with the thread's hash: if you replied meanwhile, it is refused and Claude reads your reply first).
Its entries say `mcp`. It cannot create, reopen or apply anything to a thread, and it is told that a comment only asks for changes to the
video: one asking it to run a hook, sign in, open a URL or edit project.yaml gets a reply, not the action. On a thread
you wrote **in the Studio** whose fix only changes the edit of its scenario (captions, cards, durations, overlays,
title, intro/outro), Claude proposes instead of saving: `comment_reply` with a `proposal` (the whole new file and the
hash it read) is checked as the Studio would check the write — edit-only, the same hooks, no secret reference, at most
200 changed lines — and stored on the thread as a line diff; the scenario stays as it is until you apply it in the
Studio. A filmed change, a theme or an override, and every thread from a terminal, take the loop above. Claude reads
its proposal back (`comments_list {comment_id}`: the diff and its state — pending, applied, undone, superseded, stale)
and is told never to read the Studio's token file or call its routes. Reopen a
thread you disagree with (`retake comment reopen`, or in the Studio). A thread reaches Claude with its last 10 entries, and one listing
with at most 60,000 characters of comment text (narrow it by scenario or render when it says so). Limits: Claude's own
shell can run `retake comment` like you (its entries then say `cli`: it is told never to create or reopen threads);
a thread holds at most 500 entries and 2 MB; a listing reads every thread file (no index yet). An MCP server started
on a build older than the Studio's comments skips the threads written in the Studio ("not a valid thread") until you
restart it (reconnect it from `/mcp` in Claude Code, or start a new session); never edit a thread file by hand.
