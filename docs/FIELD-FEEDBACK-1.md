# Field feedback 1 — the first real use (2026-10-26)

The first use of Demo Studio on a real product, outside the fixture: three internal videos of about four minutes
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

| Setting | Chromium (browser + GPU + renderer + other) | studio node | ffmpeg (end encode) | Total | `frames/` |
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

## Quick wins on a field project (no code)
- Remove `browser: {frame_rate_limit: false}` (the dialog-close freeze comes back until L5.7) and set
  `capture: {keep_frames: false}`.
- Write a `sandbox.yaml` (docker-compose or process provider) for the Postgres snapshot, the mailbox and the seed,
  and film with `studio run … --sandbox`.
