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
