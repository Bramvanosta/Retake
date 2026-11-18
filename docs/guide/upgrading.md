# Upgrading

What to do when a new build replaces an older one on the same workspace. Part of the [Retake guide](README.md).

## Two builds on one workspace (the Studio's token in the Retake home)

Since L5.18 a Studio server keeps its token in the Retake home (`~/.retake/ui/<hash>.token`) and `.retake/ui.json`
holds no secret (record version 2). A build from before reads such a `ui.json` as broken, replaces it and starts a
second server on the same workspace — two servers then serve one workspace and neither knows of the other. So, when
you update: stop every Studio of the old build (`retake ui` in a terminal, the desktop app) before starting the new
one, and never run an old build's `retake ui` or app on a workspace a current one serves. The new build, the other way
round, does not touch a server of the old build: `retake ui` says *a Studio server of an older Retake serves this
workspace* and opens nothing until it is stopped.

## From v0.3.0 and earlier: the app downloads its Tools (BL-192)

Up to v0.3.0 the app carried its browser (Chromium 141), its render browser and the compositor. From the next version
it carries none of them: on its first start the Set-up sheet's first item, **Browser and render tools**, offers
**Download · 315 MB**, and nothing that films or renders runs before that click (jobs asked meanwhile wait in the queue
and start by themselves; `retake run`, `retake render` and the other in-process commands refuse, saying `retake tools
install`). An update from v0.3.0 cannot download them before its restart (v0.3.0's updater has no such step): the new
version asks after it starts. Later updates download the Tools they need before they restart. The browser is now
Chrome for Testing 159: a persona signed in with it can no longer be opened by an older copy of Retake (the profile
records the newer browser), so keep one version per Retake home. The Tools live in `<Retake home>/tools/` (about
600 MB); `retake tools prune` removes the folders no copy of Retake uses.
