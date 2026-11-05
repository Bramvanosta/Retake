# Install and requirements

What Retake needs on a machine, and where it finds its tools. The macOS app carries all of it: see [The desktop app](desktop-app.md). Part of the [Retake guide](README.md).

## Requirements

- macOS or Linux, Node.js 22+ (an older Node.js gets a message saying so; `.nvmrc` pins 22 for nvm, and for mise when `idiomatic_version_file_enable_tools` includes `node`), pnpm 10
- ffmpeg and ffprobe 5.1+ on `PATH` (or `ffmpeg:` in `retake.yaml`, or `$RETAKE_FFMPEG`); used with 6.1 (Linux) and
  9.0 (macOS, Homebrew)
- Chromium for Playwright: `pnpm --filter @retake/runner-web exec playwright-core install chromium`
  (or point `$RETAKE_CHROMIUM` / `browser.executable` at a Chromium or Chrome binary)

**Where Retake finds its tools** (one order for every tool, L5.16): an explicit setting (`retake.yaml` `ffmpeg:`,
`browser.executable`) → an explicit variable (`$RETAKE_FFMPEG`, `$RETAKE_FFPROBE`, `$RETAKE_CHROMIUM`,
`$RETAKE_CHROMIUM_HEADLESS_SHELL`) → the app's own (when Retake runs from the app bundle: its Node.js, Chromium,
headless shell, ffmpeg, starter themes and Claude plugin) → the system's (`PATH`, Playwright's cache). From a
repository checkout there is no bundle, so nothing changes. ffprobe is taken beside `retake.yaml`'s ffmpeg when one is
there, else `$RETAKE_FFPROBE`, else beside `$RETAKE_FFMPEG` when one is there, else the app's, else `PATH` — a lone
static ffmpeg in `retake.yaml` keeps the ffprobe found before. A path in `retake.yaml` (`ffmpeg: tools/ffmpeg`) is the
workspace's (relative to its root); a relative `$RETAKE_FFMPEG` / `$RETAKE_FFPROBE` is refused (it would name another
file in each process) — an absolute path or a command name on `PATH`. `retake doctor` names the source on each tool line
(`retake.yaml`, `$RETAKE_FFMPEG`, `bundled`, `PATH`, `Playwright cache`); its MCP line checks the ffmpeg an MCP client
will get (the registration carries `PATH` and `RETAKE_HOME` only, never your shell's `$RETAKE_FFMPEG`). An ffmpeg
without libx264 (a foreign build) still encodes H.264, through the Mac's VideoToolbox (same SSIM as libx264 CRF 18 on a
1080p render, ≈ 3× larger files; a raw package then says "VideoToolbox q:v 85" for its clips); one with neither is
refused with the ffmpeg's path. Each H.264 site asks the ffmpeg once (`ffmpeg -encoders`, cached per path). The app's
own ffmpeg decodes AV1 videos only where the Mac has an AV1 hardware decoder (M3 and later): it carries no software AV1
decoder.
- Optional: PostgreSQL client access for `sql` hooks
- Optional: Docker with Compose v2.17+ (Docker Desktop or OrbStack) for docker-compose sandboxes (Sandbox mode)

`retake doctor` checks all of this in one go (see [Command line](cli.md#command-line)).

Every browser Retake launches runs with Chromium's OS sandbox on (`retake doctor`: **Chromium sandbox**). On Linux
that sandbox needs unprivileged user namespaces (on by default on most distributions; Ubuntu 23.10+ restricts them
through AppArmor) and a user that is not root: Chromium does not run sandboxed as root, so in a container run Retake as
a regular user (a non-root `USER`). Where either is missing, Chromium does not start and `retake doctor` says what to
change; Retake never turns the sandbox off.

Smooth 30 fps captures need GPU-accelerated rendering, which desktop machines provide (an Apple M4 captures ≈ 60
frames/s while the cursor moves, blurred dialogs included); `retake doctor` checks it (Chromium's own GPU report: the
capture browser's new headless mode uses the GPU, `browser.channel: headless-shell` does not). Without a GPU the
browser renders in software: pages with heavy effects (for example `backdrop-filter` blur behind dialogs) are then
captured at a lower frame rate, and the run warns with the measured cause (no GPU, a busy machine, a page whose
renderer stayed busy…). The run also warns when the capture froze 150 ms or more while the cursor moved or a click
ripple played. A known one: closing a dialog whose overlay has a `backdrop-filter` (a blur) can freeze the picture
≈ 0.26 s during the click ripple — the recorder asks for fresh frames while a ripple plays and the edit cuts what is
left of a freeze, so Chromium's frame-rate limiter stays on. `browser: {frame_rate_limit: false}` still turns it off,
at a measured cost (fixture `quote`: ×2.8 Chromium's CPU, its GPU and renderer processes ×7; `requestAnimationFrame`
runs at thousands of Hz while anything animates, so an animation that steps once per frame plays too fast): a run
with it warns. After a scroll the cursor waits, still, until the new content is painted before it moves on. A capture
is smoothest on a quiet machine: heavy background work (indexing, updates, another project's tests) shows up as
slower, choppier motion — every take reports what it cost (`perf` in run.json, see [Outputs of a run](workspace.md#outputs-of-a-run)).
