# Releasing Retake

Releases are made by GitHub Actions (L5.16e): pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`, which builds
the macOS app on a GitHub-hosted Apple-silicon runner, signs it on another one, attaches its disk image to a GitHub
release and publishes the update in **the feed the installed apps read: a release of this same repository**,
`update-feed` (L5.16f — no update host of your own). The repository names no host, no key and no account: everything
comes from a GitHub environment's secrets, the repository's variables and the run's own context (the repository it
runs in). Each part is all or nothing —
none of its settings: that part is skipped and said in the run's log; some of them: the run fails at once, naming what
is missing. Without a single secret the workflow still makes a release: an ad hoc app, not notarised, that does not
update itself.

The same steps by hand, on your Mac, stay possible: [docs/guide/desktop-app.md](guide/desktop-app.md#releasing-an-update) › *Install the app (macOS)* › *Releasing an update*
(`pnpm desktop:release`, then `scripts/publish-update.mjs`).

## Once: GitHub's settings

All of this is in the repository's Settings on GitHub; you make it there (nothing in this repository writes to GitHub).

1. **The `release` environment** — Settings › Environments › New environment › `release`. *Deployment branches and
   tags* › *Selected branches and tags* › add a rule for **tags** `v*` (and no branch): only a run started by a `v*`
   tag can read its secrets. Optionally *Required reviewers* › you: each release then waits for your click (the
   `release`, `sign` and `publish` jobs each ask). Put **every secret below in this environment** (its *Environment
   secrets*), not in the repository's: a workflow file pushed on any branch could read repository secrets.
2. **A tag ruleset** — Settings › Rules › Rulesets › New ruleset › *New tag ruleset*: target `v*`, *Restrict
   creations*, *Restrict updates*, *Restrict deletions*, with yourself (the repository admin role) as the only bypass.
   Nobody else can make a release, and a published tag cannot be moved. Then **a second tag ruleset** for the feed:
   target `update-feed`, *Restrict updates* and *Restrict deletions* only — not *Restrict creations*: the first
   publication creates that tag with the workflow's job token —, yourself as the bypass. The workflow needs no bypass:
   replacing the feed's files never moves or deletes its tag (a deleted `update-feed` tag would turn the release into
   a draft, and every app's check would get a 404).
3. **main's protection** — a branch ruleset (or branch protection) on `main`: no force push, no deletion, changes
   through a pull request (you may keep yourself as a bypass). The release job only builds commits of `main`.
4. **The variables** — Settings › Secrets and variables › Actions › *Variables* (repository variables, or the
   environment's: both work).

| Name | Kind | What | Part |
|---|---|---|---|
| `APPLE_CERTIFICATE` | secret | your *Developer ID Application* certificate, its private key and its chain, as a `.p12`, base64 | Apple |
| `APPLE_CERTIFICATE_PASSWORD` | secret | the password the `.p12` was exported with — **not empty** | Apple |
| `APPLE_SIGNING_IDENTITY` | secret | `Developer ID Application: <name> (<TEAM ID>)`, exactly as `security find-identity -v -p codesigning` prints it | Apple |
| `APPLE_TEAM_ID` | secret | the team id (the ten characters in the identity's parentheses) | Apple |
| `APPLE_API_KEY` | secret | an App Store Connect API key's id (notarisation) | Apple |
| `APPLE_API_ISSUER` | secret | that key's issuer id | Apple |
| `APPLE_API_KEY_P8` | secret | that key's `.p8` file (its whole text) | Apple |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | the updater's private key file (its whole text) | updater |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | its password | updater |
| `RETAKE_UPDATE_PUBKEY` | **variable** | the updater's public key (the `.pub` file's text): compiled into the app | updater |

- **Apple** — none: an ad hoc app (Gatekeeper: Open Anyway). All seven: signed with your Developer ID, notarised.
- **updater** — none: no updater in the app ("Updates are off in this build"). All three: the app updates itself, and
  each release publishes its update in the feed — with the run's own job token, no other secret (*The update feed*
  below).

A set with a missing piece fails the run in its first job, "What is configured", before anything is built — naming the
missing names, and saying "set as a variable: it must be a secret" (or the reverse) when you put one in the wrong
place. The workflow never sees a secret's value there, only whether it is set.

### The Apple pieces

You need an Apple Developer Program membership. Two of the steps can only be done by the team's **Account Holder**
(the person who enrolled): creating the Developer ID Application certificate, and the first access to App Store
Connect's team API keys.

1. **The certificate.** No Developer ID certificate yet: the Account Holder opens the Apple Developer account's
   Certificates page › + › *Developer ID Application* (from a certificate signing request Keychain Access makes:
   Certificate Assistant › Request a Certificate From a Certificate Authority…), downloads it and opens it on the Mac
   that made the request. Then, in Keychain Access › login › My Certificates, select *Developer ID Application: …*
   (its disclosure triangle shows the private key), File › Export Items… › Personal Information Exchange (.p12), with a
   **non-empty** password (the workflow refuses an empty one). The workflow's keychain also needs Apple's *Developer ID
   Certification Authority* intermediate certificate: if the run says the certificate "holds no valid code-signing
   identity", export the identity together with that intermediate (select both in Keychain Access before exporting —
   the intermediate is in the System or login keychain's Certificates). Then `base64 -i DeveloperID.p12 | pbcopy` and
   paste it as `APPLE_CERTIFICATE`; delete the `.p12` file afterwards.
2. **The App Store Connect API key** (notarisation, no Apple ID password anywhere). The first time, the Account Holder
   opens App Store Connect › Users and Access › Integrations › App Store Connect API and clicks *Request Access* (once
   per team; Apple must accept it). Then (Account Holder or an Admin) › *Team Keys* › + with the *Developer* role.
   Download the `AuthKey_<id>.p8` — Apple lets you download it once: `pbcopy < AuthKey_<id>.p8` → `APPLE_API_KEY_P8`;
   the key id → `APPLE_API_KEY`; the issuer id shown above the list → `APPLE_API_ISSUER`.

### The updater key

Once for the life of the app: every installed copy trusts this key only, so **lose the key or its password and those
copies can never be updated again**. From a checkout (offline: the Tauri CLI the build pins, rebuilt from the pnpm
store with every file checked against `apps/desktop/bundle/tauri-cli.json`):

```sh
node -e "import('./apps/desktop/scripts/bundle.mjs').then((b) => console.log(b.tauriCli(process.argv[1])))" "$HOME/retake-tauri-cli"
node "$HOME/retake-tauri-cli/node_modules/@tauri-apps/cli/tauri.js" signer generate -w "$HOME/retake-updater.key"
```

(If the store lacks that CLI, the first line says so; `pnpm dlx @tauri-apps/cli@2.12.4 signer generate -w …` does the
same with a network.) It asks for a password — give one (the workflow requires it). Keep `retake-updater.key`, its
password and the `.pub` in your password manager, then: `pbcopy < ~/retake-updater.key` → `TAURI_SIGNING_PRIVATE_KEY`,
the password → `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `pbcopy < ~/retake-updater.key.pub` → the `RETAKE_UPDATE_PUBKEY`
**variable**.

### The update feed: a GitHub release

Nothing to set up but two settings that must stay as they are:

- **The repository is public.** An installed app downloads its updates with no credentials, from the releases' public
  download addresses. With the updater set, the `release` job reads the repository's visibility with its job token
  (`gh api`) and refuses a repository that is not public before anything is built; the publish step checks it again.
- **Its name and its owner stay as they are.** Every installed app carries `<server>/<owner>/<repo>/…` compiled in.
  After a rename GitHub redirects the old addresses — until someone creates a repository with the old name; and an
  owner's old login can be claimed by anyone, who would then serve the old apps' feed (withhold or freeze their
  updates — never make an app install something your key did not sign). If you must rename: never reuse or give up
  the old name (keep the old login when the owner changes), publish the next versions from the new name (their apps
  read the new address), and know that the apps installed before stop seeing updates if the redirect ever ends — they
  then need the new version downloaded once from its release page.
- **Immutable releases stay OFF** (Settings › General › Releases). The feed's two files are replaced at every release,
  and each version's release gains its platform file once public — an immutable release allows neither.

The feed lives on **one fixed release, `update-feed`**, which the first publication creates (its tag too, on the
default branch): a *pre-release*, so GitHub never shows it as the latest release, holding `latest.json` (the newest
stable version) and `rc.json` (the newest version, pre-release or not). An app built by the workflow reads
`<server>/<owner>/<repo>/releases/download/update-feed/latest.json` (a pre-release build: `rc.json`) — the address
`node scripts/release.mjs feed <version>` prints from the run's context (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`);
it is compiled into the app, never committed. GitHub answers that address with a redirect to its download host: the
app follows it, https only at every hop. Each version's release holds the archive `Retake.app.tar.gz`, its `.sig` and
`platform-darwin-aarch64.json` (`{signature, url}`); the feed is rebuilt from those platform files at every
publication.

Do not edit, delete or rename `update-feed` or its files by hand: the installed apps read them. The `v*` ruleset
restricts creations, the `update-feed` one does not, so the workflow's token may create the `update-feed` tag. A feed
file is replaced through a temporary name (`latest.json.tmp-<run>`: uploaded whole, then the old file deleted and the
new one renamed), so an app checking at that instant at worst gets one failed check and asks again later. Before each
delete the file holding the name is looked at again: a newer feed another publication wrote meanwhile is kept. Every
request has a timeout, and a server error, a rate limit or a network error is asked again (with a pause; GitHub's
`Retry-After` up to a minute). **A `publish` interrupted or failing between the delete and the rename** (a runner lost,
a cancelled run, GitHub down longer than the retries) leaves that channel missing — every app's check fails until it
is back — and its new feed kept as `<channel>.tmp-<run>`; the job's error says "may be MISSING": **re-run `publish`**
(*Re-run failed jobs*): it writes the channel again and removes the temporary file (any temporary file of an
interrupted run goes at the next publication). A channel at a version that has no published release — a feed file
someone put there by hand — is never moved back by a publication: the run says so in a `::warning::` annotation and
stays green; delete that file on `update-feed`, then re-run the newest version's `publish`.

## Each release

1. **The browser the app ships**: bump Playwright (`playwright-core`, every package that names it, the same exact
   version) to its newest release — its Chromium is the app's — then install its browsers
   (`node packages/runner-web/node_modules/playwright-core/cli.js install chromium chromium-headless-shell`) and
   re-record `apps/desktop/bundle/browsers.json` for the new revision folders
   (`node apps/desktop/scripts/bundle.mjs browser-digest <Playwright's cache>/chromium-<revision>`, and the headless
   shell's; DESIGN §4p (e)). Every release, even when nothing else changed.
2. **The version**, everywhere it is written, then the tests, on the Mac (the CI workflow, `.github/workflows/ci.yml`, builds,
   checks the guards and runs only the deterministic tier of the tests, `pnpm test:ci`, on main, BACKLOG BL-163; the
   release does not wait for it — see that main's run of the commit is green before you tag, BACKLOG BL-144):
   ```sh
   node scripts/set-version.mjs 0.2.1
   node scripts/set-version.mjs --check      # says nothing: every file agrees
   pnpm build && pnpm test
   ```
   **The gated tests** — neither `pnpm test` nor any workflow runs them (`release.yml` builds and signs, it runs no
   test), and they alone hold the app, its updater, the Docker sandboxes and the whole loops. Run each once per
   release, on a quiet Mac with Docker running, and tick it:
   - [ ] the desktop shell, black box (a release build of the shell first) —
     `RETAKE_TEST_DESKTOP=1 npx vitest run packages/cli/test/desktop-shell.test.ts`
   - [ ] the built app, launched and checked (about 5 min) — `RETAKE_TEST_BUNDLE=1
     RETAKE_TEST_BUNDLE_FFMPEG=<ffmpeg-out> npx vitest run packages/cli/test/app-bundle-acceptance.test.ts`
     (`<ffmpeg-out>`: the folder `node scripts/build-ffmpeg.mjs` wrote)
   - [ ] the updater end to end (two app builds, ≈ 3 GB of scratch) —
     `RETAKE_TEST_UPDATE=1 npx vitest run packages/cli/test/app-update-e2e.test.ts`
   - [ ] the Docker sandboxes (about 65 s; images `retake-test-*`, removed after) — `RETAKE_TEST_DOCKER=1 npx vitest run
     packages/sandbox/test/compose.test.ts packages/sandbox/test/compose-env.test.ts packages/engine/test/sandboxes.test.ts
     packages/cli/test/sandbox-docker.test.ts`
   - [ ] the SQL hooks against Postgres (a few seconds; `pnpm test` runs them too when the image is here, this one
     fails instead of skipping) — `pnpm test:pg`
   - [ ] the slow acceptances: the catalogue capture, the MCP loops, the phase 3 loop, the Studio's (about 13 min) —
     `pnpm test:slow`
3. **The notes**: a `## [0.2.1] — <date>` section in `CHANGELOG.md` whose first paragraph is written for the person
   about to click Install and Restart (plain text: the update sheet shows it as typed; the release page shows it too).
4. **Commit on main** and push main; wait for its CI run (`gh run list --branch main --workflow ci.yml`) to be green.
5. **Tag that commit and push the tag** — the tag is the release:
   ```sh
   git tag v0.2.1
   git push origin v0.2.1
   ```
6. **The workflow** (Actions › Release; `build` takes most of the time: ffmpeg and cargo, both built at every run —
   the workflow keeps no cache; `sign` waits for Apple's notarisation, which can take long for a new team's first
   submissions). Every job first installs Node.js itself (`apps/desktop/scripts/ci-node.sh`, right after its
   checkout, before anything else runs): the official tarball of the version `apps/desktop/bundle/node.json` pins,
   downloaded from the Node.js project and checked in the shell against the sha256 recorded there for that platform
   (darwin-arm64 on the macOS jobs, linux-x64 on the ubuntu ones) before anything of it is unpacked or run, then its
   `bin/node` against the binary's pin:
   - `release` refuses a tag that is not the repository's version (`node scripts/set-version.mjs --check`, then
     `node scripts/release.mjs tag`) or not a commit of main, checks **what is configured** (each part all or nothing;
     the updater only on a public repository; `node scripts/release.mjs preflight`), then creates the release as a **draft** with the CHANGELOG paragraph and
     how to install.
   - `build` (no secret at all) installs pnpm (corepack, at `package.json`'s `packageManager`: its version and the
     sha512 the download is checked against), the dependencies (`pnpm install --frozen-lockfile`), Rust 1.99.1,
     Playwright's Chromium and headless shell — checked against the digests `apps/desktop/bundle/browsers.json` pins —
     and our ffmpeg from its sha256-checked sources, then lays the app out and signs it ad hoc
     (`pnpm desktop:bundle --app-only`) and hands it over packed, with its sha256.
   - `sign`, on a fresh runner that runs only this repository's scripts (no `pnpm install`, no package script, no
     Homebrew, no cargo), checks the artifact's sha256 and unpacks only its two parts — `app/Retake.app` and
     `tauri-cli/`, real folders (`node apps/desktop/scripts/release.mjs unpack`: its members are read first, and an
     archive with any other member, a hard link, a device, a link out of the app or an AppleDouble name is refused
     before anything is written) — before any key is on the runner, then imports the certificate into a temporary
     keychain (`apps/desktop/scripts/ci-keychain.sh`) and runs `node apps/desktop/scripts/release.mjs sign`: the
     app's version (Info.plist and bundle.json) checked against the tag's, the app re-signed with your Developer ID,
     notarised and stapled, the update archive `Retake.app.tar.gz` and its `.sig` (signed by the pinned Tauri CLI, run
     from a fresh temporary copy of its bytes, each file checked against its sha512 — made right before it signs and
     removed right after), the DMG signed, notarised and
     stapled, then the team, Gatekeeper and both tickets checked. Without the Apple part: an ad hoc DMG, and the log says so. The keychain and
     the key files are removed at the end, whatever happened.
   - `attach` refuses unless the release is still a draft, removes any file of an earlier run this build does not
     make, attaches the DMG, the archive and its `.sig`, and `SHA256SUMS-macos.txt`, and completes the notes (notarised
     or "Open Anyway", updates on or off).
   - `publish` makes the release public (*latest*, or a *pre-release*), then — the updater on — fetches the archive
     and its `.sig` back from the release (a missing one fails it) and publishes the update with
     `scripts/publish-update.mjs` and the job token: the signature is checked against `RETAKE_UPDATE_PUBKEY` before
     anything is written; then the version's release must be public and hold these very bits; it gains
     `platform-darwin-aarch64.json`, and the `update-feed` release's `rc.json` (and `latest.json` for a stable
     version) are rebuilt — never moved back to an older version. One `publish` runs at a time in the repository,
     whatever the tag (two runs never rewrite the feed together; GitHub may cancel a third one waiting — re-run it).
7. **Check it** (MACOS-CHECKLIST 15b): download the DMG from the release page on another account or Mac — it opens
   with no Gatekeeper prompt — and update the previous version through the feed (15d).

**A job failed?** Fix what it says (a secret, a variable), then Actions › the run › *Re-run failed jobs* — while the
release is still a draft: a re-run edits the draft instead of failing on it and replaces its files. **Once the release
is public its files are never replaced**: a re-run of `sign` / `attach` then fails in `attach` ("public already"), and
a re-run of `publish` only heals the feed with the same archive (publish-update.mjs refuses other bits on a public
release — there is no override: a fixed build is a new version) — which is also the fix when `publish` says a channel
"may be MISSING" (*The update feed* above). A fix in the code needs a new version (`0.2.2`):
never move a tag once its release is public or its update is published (the tag ruleset stops it anyway). While the
release is still a draft and nothing was published, you may delete the draft and the tag (`git push --delete origin
v0.2.1`) and tag the fixed commit.

Two failures are the runner's, not yours: `hdiutil: … Resource busy` (the DMG step tries three times before it gives
up) — *Re-run failed jobs*; and a notarisation that times out (75 minutes per submission) — re-run `sign`. A first run
may also stop on a digest: the browsers' download (`build`) differs from what their pins were recorded from — DESIGN
§4p (e) says how to record a checked one; `apps/desktop/bundle/node.json`'s `about` says how to record a Node.js
upgrade. The workflow keeps no cache, so every run — a re-run too — downloads ffmpeg's sources again: two of them
(x264's and libvpx's) are archives their forge generates on request and may come back with other bytes; a run that
stops on their sha256 means re-verify and re-pin them (`scripts/ffmpeg-sources.json`), never skip the check.

## A pre-release

A version with a pre-release part — `node scripts/set-version.mjs 0.3.0-rc.1`, tag `v0.3.0-rc.1` — makes a GitHub
*pre-release*. Its app reads `rc.json` (offered the next pre-release and the final version), its update goes to
`rc.json` only, and a stable app (reading `latest.json`) is never offered it. The final `v0.3.0` then goes to both. The
sign job refuses an app whose version (Info.plist, bundle.json) is not the tag's.

## A Remotion upgrade

Retake ships `@remotion/renderer` with a patch of its own, `patches/@remotion__renderer@<version>.patch` (root
`package.json` › `pnpm.patchedDependencies`; the lockfile records its sha256, so `pnpm install --frozen-lockfile` —
the release workflow's — applies exactly that file or fails). It keeps the render browser in Chromium's OS sandbox with
site isolation on macOS and Remotion's bundle server on loopback (DESIGN-phase2 §2.2). The patch names one version: an
upgrade of Remotion (every `@remotion/*` package and `remotion`, the same exact version) ports it by hand:

1. `pnpm patch @remotion/renderer@<new version>` (it prints the folder to edit). Make each change in **both builds** —
   the CommonJS files and the one ESM file, `dist/esm/index.mjs` — and keep each `retake-patch:` comment, once per
   change:
   - `dist/open-browser.js` and `internalOpenBrowser` (ESM) — `retake-patch: render-sandbox`: on macOS
     (`process.platform === 'darwin'`) no `--no-sandbox`, no `--disable-setuid-sandbox`, `IsolateOrigins` and
     `site-per-process` out of `--disable-features`, and `--site-per-process` in place of
     `--disable-site-isolation-trials`; other platforms as Remotion has them.
   - `dist/port-config.js` and `getHostToBind` / `getHostsToTry` (ESM) — `retake-patch: loopback-server`: bind
     `127.0.0.1`; try `::1` and `127.0.0.1` only (each when the machine has it).
   - `dist/serve-static.js` and `serveStatic` (ESM) — `retake-patch: loopback-server`: two HTTP servers with one
     handler, listening on `127.0.0.1` then `::1` at the same port (a `::1` failure other than EADDRNOTAVAIL /
     EAFNOSUPPORT closes the first and fails the listen); before any route, 421 for a `Host` other than `localhost`,
     `127.0.0.1` or `[::1]` with the port, 403 for an `Origin` other than its own (plain HTTP on that `Host`) or a
     `Sec-Fetch-Site` other than `same-origin` / `none`; `close` closes both.
2. `pnpm patch-commit <that folder>`: it writes `patches/@remotion__renderer@<new version>.patch`, points
   `patchedDependencies` at it and updates the lockfile. Delete the old patch file. If a mark's count changed (Remotion
   merged two files, say), update `RENDERER_PATCH_MARKS` in `apps/desktop/scripts/bundle.mjs`.
3. Run `packages/editor/test/render-isolation.test.ts` (the switches, the sandbox, the listeners, the answers — each
   build), `network-guard.test.ts`, `render-gpu.test.ts` and `packages/cli/test/app-bundle.test.ts` (the deploy
   carries the patch), then the full suite and one `RETAKE_TEST_BUNDLE=1` run: the stage refuses an engine whose
   renderer lacks a mark.

If Remotion ever offers these as options (a sandboxed `openBrowser`, a loopback-only server), drop the patch for them.

## What the workflow trusts

- It runs on pushed `v*` tags only — never on a pull request — with read-only permissions by default; `contents: write`
  only on the three jobs that call `gh` (`release`, `attach`, `publish`), which run no build tool; the job token only in
  the steps that call `gh` and in `publish` › *Publish the update* (`scripts/publish-update.mjs`, plain Node: the
  GitHub REST API through `fetch`, no other token, no other host). Every action is GitHub's own, pinned to the commit
  of an exact release (the tag is written beside it); checkouts keep no credential.
- The feed is not signed — only the archive is: whoever can write the repository's releases can withhold an update or
  point the feed elsewhere, never make an app install something not signed by your updater key.
- **The signing keys never share a runner with code from a dependency.** On a hosted runner every step runs as the same
  user, and a process one step leaves behind can read files and other processes' environments until the job ends. So
  the `build` job, which runs the dependencies' code (pnpm's packages and their scripts, cargo's build scripts,
  Homebrew, ffmpeg's build, Playwright's installer), holds no secret, no variable and no environment; the `sign` job,
  which holds the keys, runs on a fresh runner and runs only this repository's scripts (their imports: Node.js and
  files of this repository — `packages/cli/test/release-workflow.test.ts` walks them) and the Tauri CLI, from a fresh
  temporary copy of bytes that matched its pinned sha512, made only to sign the update archive (its HOME in that copy;
  no folder of its module lookup path outside the copy may exist). Of the build job's archive it unpacks the app and
  the Tauri CLI only, read member by member first, before any key is written. The certificate, the `.p8` and the
  updater key are written by one step into a
  temporary keychain (the key non-extractable) and files only the runner's user reads; no password is ever on a command
  line; all of it is removed in a final step that always runs.
- What the build job builds is what gets signed: the sign job checks the artifact is the one the build job packed, but
  trusts the build itself (build provenance: BACKLOG BL-145). Node.js and the browsers are checked against pins; pnpm,
  the Tauri CLI, our ffmpeg's sources and the lockfile's packages against hashes.
- **No cache.** Nothing is restored from an earlier run or another workflow: every job starts from the checkout, the
  pinned downloads and the lockfile (ffmpeg and cargo are built at every run; no setup action, no cache action).
  **Node.js is checked by the shell** in every job, before anything of it runs: `apps/desktop/scripts/ci-node.sh`
  checks the official tarball's `shasum -a 256` against `apps/desktop/bundle/node.json`'s pin for the runner's
  platform before it unpacks it — npm, corepack and every other file of the install with it — then the unpacked
  `bin/node` against the binary's pin; the binary is never asked to vouch for itself.
- `packages/cli/test/release-workflow.test.ts` reads the workflow as data, runs its step scripts against stand-ins and
  holds it to these rules.
- The app carries Remotion's compositor and the compositor's own FFmpeg build (GPL, with fdk-aac compiled in — not our
  ffmpeg, which is built without non-free parts). A public release distributes it to anyone who downloads it; that
  licence risk was accepted on 2026-11-04 for these releases, to be resolved before any sale (BACKLOG BL-138).
