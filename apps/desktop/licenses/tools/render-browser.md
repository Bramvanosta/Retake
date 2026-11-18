# The render browser — Chrome Headless Shell 159.0.8154.6

**What it is.** Chrome Headless Shell, the headless build of Chrome for Testing (no window, no user interface).
Retake renders its videos, stills and component previews in it, through Remotion.

**Who publishes it.** Google (Google LLC).

**Where it comes from.** Retake does not carry it and does not redistribute it. On your click (Set-up › Tools, or
`retake tools install`) Retake downloads Google's own archive, unmodified, from Google's Chrome for Testing storage:

    https://storage.googleapis.com/chrome-for-testing-public/159.0.8154.6/mac-arm64/chrome-headless-shell-mac-arm64.zip

It checks the archive's size and sha256 before extracting anything, and the extracted folder's digest after
(apps/desktop/bundle/tools.json in Retake's source repository records both), then keeps it in your Retake home
(`<RETAKE_HOME>/tools/browsers/chromium_headless_shell-1255`).

**Its licence.** Google's terms, as for the browser: its notice (`chrome-headless-shell-mac-arm64/ABOUT` in its
folder) says it is copyright Google LLC, all rights reserved, and points to its Terms of Service at `chrome://terms`
— Google's Chrome terms (https://www.google.com/chrome/terms/). The folder also holds `LICENSE.headless_shell`: the
Chromium project's BSD licence and the licences of the open source software it is built from.

Retake never fetches these terms itself; this notice is Retake's own summary, not Google's text.
