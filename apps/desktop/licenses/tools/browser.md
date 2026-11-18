# The browser — Chrome for Testing 159.0.8154.6

**What it is.** Chrome for Testing, a flavour of Google Chrome made for browser automation and testing. Retake drives
it for captures, sign-in, recording and the doctor's browser probe.

**Who publishes it.** Google (Google LLC).

**Where it comes from.** Retake does not carry it and does not redistribute it. On your click (Set-up › Tools, or
`retake tools install`) Retake downloads Google's own archive, unmodified, from Google's Chrome for Testing storage:

    https://storage.googleapis.com/chrome-for-testing-public/159.0.8154.6/mac-arm64/chrome-mac-arm64.zip

It checks the archive's size and sha256 before extracting anything, and the extracted folder's digest after
(apps/desktop/bundle/tools.json in Retake's source repository records both), then keeps it in your Retake home
(`<RETAKE_HOME>/tools/browsers/chromium-1255`). One file is removed after extraction: the framework's self-install
script (`Resources/install.sh`), which nothing of Retake runs.

**Its licence.** Google's terms: the browser's own notice (`chrome-mac-arm64/ABOUT` in its folder) says it is
copyright Google LLC, all rights reserved, made possible by the Chromium open source project and other open source
software (listed at `chrome://credits`), and points to its Terms of Service at `chrome://terms` — Google's Chrome
terms (https://www.google.com/chrome/terms/). Using it means accepting those terms. Google describes Chrome for
Testing as meant for automation and testing, and for trustworthy content only.

Retake never fetches these terms itself; this notice is Retake's own summary, not Google's text.
