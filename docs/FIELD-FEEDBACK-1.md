# Field feedback 1 — the first real use (2026-10-26)

The first use of Retake on a real product, outside the fixture: three internal videos of about four minutes
each, written first in one language and then remade in another after a redesign of the product and a database
change. The product is a B2B web app with two sides (a customer app and an admin back office, one persona each), a
Postgres database, a Redis job queue, local object storage and a Mailpit mailbox, run from its own dev servers on the
same Mac. Claude drove the whole loop through MCP and wrote down what cost time; the user added their own remarks on
the videos. This file is the generic triage of those notes (no product or person names) and the decisions taken.

**Decision (2026-10-26):** the user opens a **field-feedback group of lots, L5.5 – L5.8, done before L4.3** resumes
(L4.3's first part stays parked on its branch). Order: L5.5 → L5.6 → L5.7 → L5.8; L5.5 and L5.6 touch different
packages and run in parallel. Everything not in those lots went to `docs/BACKLOG.md` (BL-81 – BL-89).

## Triage

| Chantier | What the field showed | Where it went |
|---|---|---|
| **A — edit without re-capture** | Nearly every remark from the user was about the edit (cards too short, a mail shown before the action that sends it, a notification at the wrong moment, a caption). Each one cost a full take: reset the database, empty the mailbox, film 4 minutes again, render. Cause: since L3.8 a render shows the run as captured and any change to the scenario file reports `scenario_changed`. | **L5.5** |
| **B — capture reliability** | Silent failures and slow diagnostics: a `type` that clicked a field below the fold inside a scrolling dialog and typed into another field (a date picker opened, the take "succeeded", nobody noticed until the user watched it); a click that did nothing and was only reported 60 s later by the next wait; a download that failed once on a transient socket error and lost 54 steps; a mail that never came with no hint why (the account had mail notifications off); a 15 s default timeout too short for an action that generates a PDF; one missing target found per take (5 takes to find 5 renamed labels). | **L5.6** |
| **C — performance** | The CPU sat at 100 % during the take on a recent Mac, the take froze now and then, a 6-minute take weighed 1.6 – 2.4 GB and `runs/` reached 24 GB in three days. Latency of the product (skeletons, spinners, a 15 s dialog close) shows on screen. | **L5.7** (measurements below) |
| **D — environment and off-camera actions** | Data reset by a hand-written SQL script (about ten times), mailbox emptied through its API, demo accounts prepared by hand, ports that moved, other work's test data on screen. Three actions had to happen *during* a take without being filmed (mark a payment, move a period into the past, trigger a queue job): an external script polled the database in parallel. The sandboxes of L1.8 already cover reset, snapshot, mailbox, seed, health and accounts — they were not used because nothing pointed to them. | **L5.8** (with the MCP ergonomics of E) |
| **E — MCP ergonomics** | `page_inspect` ≈ 15,000 tokens per page, `review` over 25,000 (truncated), `run_status` lists every capture; job completion watched by a side script. | **L5.8** |
| **F — disk** | See C: frames kept by default, no pruning of failed takes, dry runs and old renders. | **L5.7** |
| **G — edit "extras"** | A notification should land on any shot, a chapter card included, at a relative moment, using a mail captured anywhere in the take by name — no filmed waiting shot just for it. | BL-81 |
| **H — authoring at scale** | Language switch rewrote every target and expected text (i18n keys, localised values); three scenarios copy the same twenty steps (fragments, project vars); no storyboard before paying a take; knowledge lost between sessions (project memory); direct database / API / queue access by the assistant (controlled data tools); demo hygiene (forbidden text, who is signed in, persona locale, document language); iterating past an irreversible step (resume a take from a step, exploration mode, a target check against known states). | BL-82 – BL-89 |

## Chantier C — measurements (2026-10-26, Apple M4, fixture `quote`, 47 s of video)

Three real captures of the same scenario with a per-process CPU sampler (cumulative CPU time from `ps` every 500 ms;
the script is easy to rebuild: it groups Chromium's browser, GPU, renderer and other helpers, the studio's node
process, ffmpeg and the fixture server).

| Setting | Chromium (browser + GPU + renderer + other) | retake node | ffmpeg (end encode) | Total | `frames/` |
|---|---|---|---|---|---|
| Default (frame-rate limiter on, JPEG quality 100) | 31 cpu-s (23 + 4.5 + 2.9 + 0.5) | 10.5 | 29 | 71 cpu-s | 528 MB (1,563 frames, 344 KB each) |
| `browser.frame_rate_limit: false` (what the field project set) | **86 cpu-s** (31.5 + 32 + 21 + 0.5) | 11 | 29 | 125 cpu-s | 498 MB |
| Limiter on, JPEG quality 85 | 25 cpu-s | 6.5 | 26 | 58 cpu-s | 183 MB |

`capture.mp4` is 4 – 5 MB in every case.

Findings:
1. **The GPU is active.** `chrome://gpu` in the runner's headless Chromium (playwright chromium-1194, Chrome 141):
   Canvas, Compositing, Rasterization, WebGL, Video Decode / Encode all "Hardware accelerated"; ANGLE Metal on the
   Apple M4, Skia Graphite. The run warning "software rendering without a GPU, heavy effects … or several pages at
   once" (`runner-web/src/run.ts`) is a generic list of causes, not a diagnosis — the field read it as one.
2. **`frame_rate_limit: false` is the main CPU cost**: Chromium ×2.8 (GPU process ×7, renderer ×7). It removes the
   R-ISS-12 dialog-close freeze (≈ 0.21 – 0.26 s, seen again in the default take) but the compositor draws back to
   back. With two personas (one browser each, backgrounding disabled by our flags) the unfilmed page likely adds the
   same again — not measured yet (no two-persona scenario in the fixture).
3. **The capture is a CDP screencast, not a screenshot per frame**, but every frame is a JPEG at quality 100
   (Chromium's browser process encodes it: ≈ 15 ms a frame), decoded from base64 and written by node: about a third
   of the take's CPU. Quality 85 cuts the frames ÷ 2.9 and the browser + node CPU by a quarter; SSIM of a q85
   re-encode vs the q100 frame: 0.993 – 0.998 (visible on small text: aim near 90 and look at frames).
4. **The end encode** (libx264 preset medium, CRF 16) costs 21 cpu-s per 30 s of video — the "26 s at 100 % after a
   6-minute take" of the field. On 900 captured frames: x264 medium 21.2 cpu-s (SSIM vs source 0.9990), x264 veryfast
   10.9 cpu-s (0.9984), VideoToolbox H.264 `-q:v 65` 4.8 cpu-s of which ≈ 4.0 is JPEG decoding (0.9959 — needs a
   higher quality setting to match).
5. **`frames/` is almost never read.** The render reads only `capture.mp4` (`editor/src/render/plan-run.ts`); the
   frames serve the raw export (exact VFR timing, 60 fps) and the L4.2 step pictures, both with a fallback to the
   video. Yet `capture.keep_frames` defaults to true: 99 % of a run's size.
6. Not pursued: comparing WebKit, Firefox or a headed window captured by ScreenCaptureKit — with the GPU on and the
   limiter in place Chromium stays under one core during the take.

What L5.7 does with it: keep the limiter and fix R-ISS-12 another way; encode during the take (no `frames/` by
default, frames only on request for the raw export); a lower default JPEG quality after a visual check; a performance
report per take; a GPU check in `doctor`; the two-persona measurement; slow-transition detection and compression in
the edit; page pre-warming; pruning of runs and renders.

## After L5.7 — measurements (2026-10-26, Apple M4, same sampler)

The same per-process sampler (cumulative CPU time from `ps` every 500 ms, Chromium browser / GPU / renderer / other,
retake node, ffmpeg, fixture), on the code before L5.7 (commit 2f1813a, built in a scratch worktree) and after it,
**alternated** take by take on a quiet machine (1-minute load 2.3 – 5.2): fixture `quote` three times each (46.6 s of
video), and the new two-persona fixture scenario `two-personas` (`--env signed-in`: the supplier's console and the
buyer's shop in two browsers, `NORTHFIELD_QUOTES_MS=1500`) twice each (42 s of video). Means:

| Take | Chromium (browser + GPU + renderer) | retake node | ffmpeg | Total | Wall (command) | Run folder | Freezes in a ripple |
|---|---|---|---|---|---|---|---|
| `quote` before (limiter on, JPEG 100, frames kept, x264 medium at the end) | 31.4 cpu-s (24.3 + 4.6 + 2.0) | 11.8 | 29.1 | **72.3 cpu-s** | 55.0 s | 570 MB (frames 566 MB) | 2 in 3 takes |
| `quote` after (limiter on, JPEG 90, no frames, VideoToolbox during the take) | 26.1 cpu-s (18.2 + 4.6 + 2.9) | 6.8 | 6.8 | **39.7 cpu-s (−45 %)** | 49.0 s | **20 MB** | 0 in 3 takes (8 – 10 fresh frames asked a take) |
| `two-personas` before | 21.9 cpu-s | 8.9 | 24.6 | **55.4 cpu-s** | 49.2 s | 356 MB | 3 in 2 takes |
| `two-personas` after | 24.5 cpu-s | 6.1 | 5.9 | **36.6 cpu-s (−34 %)** | 45.0 s | **13 MB** | 0 in 2 takes |

The take's own report (run.json `perf`) agrees: 0.76 – 0.82 cores for `quote` over the take (Chromium 0.53 –
0.56, encoder 0.14, studio 0.12 – 0.15), the limiter on and the GPU accelerated (ANGLE Metal). capture.mp4 grows from
4 MB (x264 medium CRF 16) to 20 MB (VideoToolbox `-q:v 85`, SSIM 0.9985 against the frames vs 0.9989), and the take
ends 6 s sooner (no end encode: the encoder finishes 20 – 30 ms after the take). One `two-personas` "before" take
lost a GPU process to the sampler (17.6 Chromium cpu-s): the mean of the two is shown.

Findings:
1. **Encoding during the take** removes the end encode (21 – 32 cpu-s per take of the fixture) and nearly all of the
   node process's frame writing; the hardware encoder costs 0.14 core, mostly JPEG decoding. The video is frame for
   frame the CFR schedule of the screencast frames (tested on a real capture with the frames kept).
2. **JPEG quality 90** instead of 100: small grey table text compared at 6× zoom on three fixture pages is
   indistinguishable (luma SSIM of the text crop vs quality 100: 0.994 – 0.996; whole frame 0.996 – 0.998; quality 85:
   0.992 – 0.993, quality 80 shows ringing), at 0.39 – 0.46× the bytes; Chromium's browser process −25 %.
3. **R-ISS-12 with the limiter on**: asking for a fresh frame (a screencast restart) whenever none came for 90 ms while
   a ripple plays keeps the frames flowing — the frames it brings all differ (the ripple goes on: the compositor still
   draws, only the screencast stopped sending); in the alternated series, 5 freezes in 5 takes before, none in 5 after.
   A freeze left (seen once in an earlier take, during a download click under load) is cut by the edit
   (`timeline.stalls`). `frame_rate_limit: false` is no longer needed; a run with it warns with the measured ×2.8.
4. **Two personas**: the browser nobody films costs ≈ 0.02 core (`perf.cpu.browsers[].unfilmed`: the supplier's 0.59
   cpu-s over 30 s while the café was filmed, the console's list polling every second; the buyer's 0.32 cpu-s over
   14 s): nothing is throttled (BL-97 if a real product's does; the run warns above 0.25 core).
5. What a take costs now is mostly Chromium's browser process reading back and JPEG-encoding ≈ 55 – 60 frames a second
   while the cursor moves (BL-98: half of them would do for a 30 fps video).

## After L5.8 — MCP result sizes (2026-10-26, fixture)

What a client receives (the summary and the JSON text blocks), measured through `retake mcp` over stdio on the fixture
(`quote` take and render of L5.8's acceptance), before (main e74fc2e: JSON pretty-printed, every field) and after
(compact by default, one-line JSON). Tokens ≈ characters / 4 (the estimate Claude Code's size limit uses); images
(`images: "none"` here) are not counted.

| Call | Before (chars / ≈ tokens) | After, compact | After, `detail: "full"` |
|---|---|---|---|
| `page_inspect` console `/products` (40 elements) | 53,039 / 13,260 | 8,694 / 2,174 | 30,470 / 7,618 |
| `page_inspect` shop `/` | 33,797 / 8,449 | 4,732 / 1,183 | 20,248 / 5,062 |
| `page_inspect {scenario: quote, until: request.0}` (the dialog) | 40,522 / 10,131 | 6,002 / 1,501 | 22,788 / 5,697 |
| `run_status` of a dry run (20 screenshots, a failure) | 10,860 / 2,715 | 3,731 / 933 | 9,627 / 2,407 |
| `run_status` of a capture | 3,567 / 892 | 1,440 / 360 | 2,923 / 731 |
| `review_get` of a clean 61 s render | 8,620 / 2,155 | 1,632 / 408 | 7,280 / 1,820 |

Of the page_inspect saving, the indentation of pretty-printed JSON is ≈ 43 % of the text (the `full` column); the rest is the
elements out of view (9 of 31 on the dialog replay) and each element's box, null fields, duplicated text and target
(the step hint already holds the target). The field's 25,000-token review came from a 4-minute video with many
findings: compact keeps every error and at most 30 warnings with their messages (BL-104: measure a long one).

## Quick wins on a field project (no code)
- Remove `browser: {frame_rate_limit: false}` (since L5.7 the dialog-close freeze is handled with the limiter on) and
  drop `capture: {keep_frames: …}` (L5.7: no frames by default). `retake prune <project>` frees what older takes and
  renders hold.
- Write a `sandbox.yaml` (docker-compose or process provider) for the Postgres snapshot, the mailbox and the seed,
  and film with `retake run … --sandbox` (since L5.8 `retake doctor --project` says when one is missing; README "A
  stage sandbox" for a product shipped as images).
- Replace the side script that polled the database with named hooks and `hook:` steps (L5.8, README "Hooks during
  the take").
