# macOS checklist (lot L1.5)

What the Linux build container cannot verify: a capture on a Mac with a GPU while you keep using it, `studio login`
on a real profile, `--headed` runs, Keychain secrets and desktop notifications. Run the steps in order; each one says
what you should see and what to send back. Paste command output as text; never send passwords, tokens or screenshots
of private data. Findings go to lot L5.1.

Conventions: run every command from the repository root; `<id>` is the run id printed by `studio run`
(`runs/<id>/…` = `projects/northfield-fixture/runs/<id>/…`).

## 1. Install

```sh
xcode-select --install                 # if git / compilers are missing
brew install node@22 ffmpeg            # or nvm install 22; any Node.js 22+
brew link --force node@22               # node@22 is keg-only
corepack enable                        # provides pnpm 10
git clone -b main <repository URL> demo-studio && cd demo-studio   # the work continues on main
pnpm install
pnpm --filter @demo-studio/runner-web exec playwright-core install chromium
```

- **Expected:** every command ends without an error; Playwright prints where it put Chromium and its headless shell
  (`~/Library/Caches/ms-playwright/chromium-…` and `chromium_headless_shell-…`: captures use the first, renders the
  second).
- **Send back:** macOS version and chip (Apple menu → About This Mac), `node -v`, `pnpm -v`, `ffmpeg -version | head -1`,
  and the last lines of any command that failed.
- **Note:** `node -v` must be 22+ in every folder you run the CLI from, not only in the repository: a version manager
  (mise, nvm, fnm) picks the Node of the current folder (step 8 runs from `~/demo-check`). An older Node.js prints
  "studio needs Node.js 22 or later; this is v…" — run that Node 22 by its path, or make it the default.

## 2. Build (and the tests)

```sh
pnpm build
pnpm test            # optional, ~2.5 min on an M4: the end-to-end tests start the fixture by themselves
```

- **Expected:** `pnpm build` prints nothing and exits 0; `pnpm test` ends with every test passed (6 Postgres tests
  skipped unless `DEMO_STUDIO_TEST_PG` is set, 1 unless `DEMO_STUDIO_TEST_OLD_NODE` points to an old `node`).
- **Send back:** the `Test Files … Tests …` summary lines, and the full output of any failing test.

## 3. `studio doctor`

```sh
pnpm studio doctor
```

- **Expected:** `OK` on every line: Node.js, Chromium (version, path, "new headless launch … ms"), ffmpeg, ffprobe,
  Display ("macOS desktop"), Secrets ("macOS Keychain via security"), Notifications ("osascript"), Workspace (the
  repository, 1 project: northfield-fixture), Template default / editorial / motion ("fonts present"); then
  `0 failures, 0 warnings` and exit code 0 (`echo $?`).
- **Send back:** the whole output.

## 4. Start the fixture product

```sh
pnpm fixture                           # terminal 1 — keep it running
pnpm studio doctor --project northfield-fixture   # terminal 2
```

- **Expected:** terminal 1 prints "Northfield fixture is running" with the console on http://localhost:4401 and the
  shop on http://localhost:4402 (both open in Safari). The doctor adds `Project northfield-fixture`, `Profile`
  ("none configured") and `Host local·console` / `Host local·shop` → HTTP 200, all `OK`.
- **Send back:** the doctor lines from `Project` down.

## 5. Dry run

```sh
pnpm studio run northfield-fixture catalogue --dry --hooks run
```

- **Expected:** one ✓ line per step (21 steps), `✓ dry run succeeded`, no browser window, a screenshot per step in
  `runs/<id>/screenshots/`.
- **Send back:** the run id, the summary block and any `!` warning line.

## 6. Capture while you use the Mac

```sh
pnpm studio run northfield-fixture catalogue
pnpm studio run northfield-fixture quote
```

Start each capture, then **keep working normally** during the ~70 s it takes: switch apps, type in a document,
scroll a web page, move windows around.

- **Expected:** no browser window appears, focus is never stolen, your typing is never sent to the capture; both runs
  end with `✓ capture succeeded … 21/21 steps` (catalogue) and `25/25 steps` (quote). The warning
  "… cursor moves were captured below 18 fps …" should **not** appear (it appears in GPU-less containers).
- **Send back:** for each run: the run id, the summary block, every `!` warning line, and the output of
  `node -e "console.log(require('./projects/northfield-fixture/runs/<id>/run.json').warnings)"`. If you can, attach
  `runs/<id>/timeline.json` and `runs/<id>/frames.jsonl` (small text files, no video needed).

## 7. Check smoothness in the videos

Open `runs/<id>/capture.mp4` of both captures in QuickTime Player. Play it once at normal speed, then step through
the cursor moves frame by frame (← / → keys).

- **Expected:**
  - cursor moves are smooth (no stutter, no position jumping several centimetres between two frames), at 30 fps;
  - at every scene start the cursor is already resting next to the first thing it will click (e.g. just below
    "New import", "Add a coffee", the notifications bell), never on top of it, and it does not jump when the scene
    starts;
  - every click shows a ripple, including on the dark red (burgundy) buttons "New import", "Start import", "Pause",
    "Save", "Add a coffee", "Send request": a light ring with a soft dark edge that expands and fades in about half
    a second, at the moment of the click (not visibly later);
  - for the file import the cursor goes to the right edge, comes back carrying the file chip, and drops it;
  - no loading screens, blank frames or half-rendered pages.
- **Send back:** OK / not OK for each bullet, with the video time (mm:ss) of anything wrong. Optionally three frames:
  `ffmpeg -ss 00:00:03 -i runs/<id>/capture.mp4 -frames:v 1 frame-3s.png`.

## 8. `studio login` on a real profile

Use a site where you have an account (a personal one, nothing confidential), in your own workspace — never in the
repository:

```sh
mkdir -p ~/demo-check && cd ~/demo-check && echo "projects_dir: projects" > studio.yaml
node <repo>/packages/cli/dist/bin.js new site-check --env "prod=app:https://<the site>"
```

Add to `~/demo-check/projects/site-check/project.yaml`:

```yaml
auth: {profile: ~/.demo-studio/profiles/site-check}
```

and write `~/demo-check/projects/site-check/scenarios/signed-in.yaml`:

```yaml
video: signed-in
scenes:
  - id: home
    page: app
    open: /
    steps:
      - assert: {text: <a text only visible when signed in, e.g. your account name or "Sign out">}
```

```sh
node <repo>/packages/cli/dist/bin.js login site-check     # a Chromium window opens on the site
# sign in by hand, then close the window
node <repo>/packages/cli/dist/bin.js doctor --project site-check
node <repo>/packages/cli/dist/bin.js run site-check signed-in --dry
```

- **Expected:** `login` opens a visible Chromium window and, once you close it, prints `profile saved: …`; the doctor
  shows `Profile` `OK` (a `WARN … in use by a browser` if the window is still open) and the host `OK`; the headless
  dry run succeeds (the assert passes because the profile is signed in).
- **Send back:** the three outputs with the site name and account details removed. Delete the profile afterwards
  if you wish: `rm -rf ~/.demo-studio/profiles/site-check`.

## 9. `--headed` run

```sh
pnpm studio run northfield-fixture quote --headed
```

- **Expected:** a visible Chromium window plays the scenario (cursor overlay drawn inside the page, ripples on
  clicks), the window closes at the end, `✓ capture succeeded … 25/25 steps`.
- **Send back:** the summary block and anything that looked wrong in the window.

## 10. A `{{keychain:service/account}}` reference in a hook

```sh
security add-generic-password -s demo-studio-check -a token -w s3cret-check-value
cat > ~/demo-check/keychain-hook.yaml <<'YAML'
- name: keychain-check
  http:
    method: POST
    url: "{{console}}/api/quotes/auto-proposal"
    headers: {x-demo-token: "{{keychain:demo-studio-check/token}}"}
    json: {after_minutes: 5}
    rollback: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}
YAML
pnpm studio hooks run northfield-fixture ~/demo-check/keychain-hook.yaml
grep -rl s3cret-check-value projects/northfield-fixture/.demo-studio || echo "secret not stored: OK"
pnpm studio hooks rollback northfield-fixture
security delete-generic-password -s demo-studio-check -a token
```

- **Expected:** macOS may ask once to let `security` read the item (choose "Allow"); the hook line is
  `✓ keychain-check  200 OK`; the journal is written to `projects/northfield-fixture/.demo-studio/journals/<id>.json`
  (and nothing new appears under `runs/`); the `grep` prints `secret not stored: OK`; the rollback line is `✓`.
- **Send back:** the outputs (they never contain the secret value).

## 11. Notification step

```sh
cat > ~/demo-check/notify.yaml <<'YAML'
video: notify
scenes:
  - id: ping
    page: console
    open: /imports
    steps:
      - notify: {title: Demo Studio, message: Notification check}
YAML
pnpm studio run northfield-fixture ~/demo-check/notify.yaml --dry
```

- **Expected:** the run succeeds and a macOS notification "Demo Studio — Notification check" appears (if it does not,
  allow notifications for "Script Editor" in System Settings → Notifications, and run it again).
- **Send back:** whether the notification appeared, and the run output.

## 12. Raw export into your editing tools (L2.13)

```sh
pnpm studio run northfield-fixture quote --raw --cursor layer --format prores --fps 60
```

Optional first: `scripts/validate-raw.py <package>` checks the package (ffprobe against the manifest, FCPXML, the OTIO
and EDL read back with OpenTimelineIO — set-up in docs/HANDOFF.md "Mac setup"; make the venv with Python 3.13 or
older: OpenTimelineIO 0.18.1 fails on 3.14 with `RuntimeError: bad any cast`); it should print `OK`.
Then import the package (`projects/northfield-fixture/exports/<run>-raw-prores60-layer/`) into the tools you have:
Final Cut Pro (File → Import → XML… → `markers/quote.fcpxml`), DaVinci Resolve (File → Import → Timeline… → the
`.fcpxml` or `.otio`), Premiere Pro (File → Import → `markers/quote.edl` with the `clips/` folder).

- **Expected:** the clips land in one timeline in order, with the scene / step / mark / caption markers; the cursor
  layers sit on the track above their clip (FCPXML, OTIO) and composite cleanly (no halo, no offset); the clips'
  timecodes match the timeline (00:00:00:00 at the start); a ProRes 60 fps export takes noticeably less than here
  (≈ 3.5 min for 50 s of clips on 4 CPUs without hardware encoders). The FCPXML and OTIO point at the clips with
  `file://` URLs: no relink prompt while the package stays where it was written. For Premiere through the OTIO, try
  `otioconvert -i markers/quote.otio -o quote.xml` (otio-fcp-adapter, FCP 7 XML) and File → Import that XML.
- **Optional (WebM layers):** `pnpm studio export-capture northfield-fixture latest --scenario quote --cursor layer
  --layer webm` — the README says Final Cut Pro and Premiere cannot read them; say whether Resolve imports the `.otio`
  with the WebM cursor track lined up on its clips (media from 00:00:00:00) and keeps their transparency.
- **Send back:** which tools imported which file, any error message, a screenshot of a timeline with its markers.

## 13. Clean up

Stop the fixture (Ctrl-C in terminal 1). Generated folders (`runs/`, `.demo-studio/`) are git-ignored; delete them
with `rm -rf projects/northfield-fixture/runs projects/northfield-fixture/.demo-studio` if you want.

**Send everything back in one message**, numbered like the steps above.

## Results — first pass (L1.5, 2026-10-12)

Run by a local Claude Code session with the user at the Mac: Apple M4 (10 cores, 24 GB), macOS 26.6.2, Node.js 22.16
(pinned in the repository folder by a version manager), pnpm 10.28, ffmpeg / ffprobe 9.0.2 (Homebrew), Chromium 141
(playwright-core 1.56.1). Findings and where they go: `docs/ROADMAP.md` L1.3 (narrowed) and L5.1;
`node scripts/requirements.mjs --lot L5.1`.

| Step | Result |
|---|---|
| 1. Install | Already set up. Outside the repository folder the default `node` was 10.24: the CLI then fails with `SyntaxError: Unexpected token {` (note added to step 1; R-MAC-03). |
| 2. Build / tests | Build OK. First full run: 28 failures, 27 of them from the Mac: ffmpeg 9 dropped `-vsync` and refuses `select` expressions nested over 100 deep (the review's one-pass frame extraction); `/var` → `/private/var` made the component validator call a component's own imports "outside the folder"; APFS ignores case (a test's `Acme/` folder merged with `acme/`); a look test measured the kicker with its É accent. The 28th was a load flake (an unannounced dialog seen after `after_click_ms`; R-MAC-08; green alone and in the next runs). Fixed in L1.5 (R-MAC-01, R-MAC-02) → **878 tests: 872 pass, 6 Postgres skipped, 2 m 28 s** (2 m 41–2 m 44 s in the later runs). |
| 3. Doctor | Every line OK, 0 warnings (new headless launch 1.0 s). |
| 4. Fixture | OK; hosts HTTP 200. |
| 5. Dry run | 21/21 steps in 1 m 06 s, no warning, no window. |
| 6. Captures while working | catalogue 21/21 (1 m 12 s), quote 25/25 (54.6 s) while the user switched apps, typed, scrolled and moved windows: no window, focus never taken, typing intact. Catalogue warning: 1 of 24 moves below 18 fps (13 fps at 19.2 s). |
| 7. Smoothness | Measured frame by frame (both runs; every defect re-checked independently). **Motion:** ≈ 60 frames/s while the cursor moves (cloud without GPU: 15–20), moves over blurred dialog backdrops 57–75 fps, 42 of 43 moves ≥ 24 fps; the drawn cursor within 2 px of the recorded track in 94 % of moving frames, the rest within one sample. **Not OK:** the first move after a scripted scroll stalls (2 of 2: catalogue 00:19.16, 0.43 s frozen then hops; quote 00:05.42, 0.26 s frozen then a 329 px jump, inside the edited clip) and one scroll stalled itself (quote 00:04.40, 0.14 s then a 240 px jump; R-ISS-11); every animated dialog close stalls the screencast ≈ 0.26 s, so the click ripple freezes then vanishes (3 of 3: Pause confirm 00:23.21, Save 00:41.04, Send request 00:30.65; a dialog that unmounts with a navigation shows no gap; R-ISS-12); a short renderer pause on a card's hover-in (quote 00:02.59). **Scene starts:** OK for scenes that open a page (cursor just below / beside its first target, no jump); a continuing scene keeps a cursor 484 px from its first target (quote request, DESIGN §3.3 "keep"; R-MAC-07) and the delivery scene glides out of its dialog and back (rest point beside a 622 px field, outside the dialog; R-MAC-06). **Ripples:** visible within ≈ 0.02–0.05 s of every click, burgundy buttons included, gone by ≈ 0.55 s (except the dialog-close stalls). **File chip:** OK. **Loading frames:** the page loads of scene openings are in the raw capture only (cut by the edit and the raw export); 1–2 frames of the shop's own loading skeleton on client-side navigations (quote 00:06.30 and 00:40.20, the app's own state) play in the edit too. |
| 8. Login | Personal staging site, in a workspace outside the repository: visible window, signed in by hand, `profile saved`; doctor Profile OK; the headless dry run passed an assert on the signed-in user's name. The new workspace needed `templates_dir` (no starter template outside the repository; R-MAC-04). |
| 9. `--headed` | Visible window, in-page cursor and ripples, closed at the end, 25/25 (53.9 s). |
| 10. Keychain | The user added the test item (an agent may not write to the Keychain); the hook resolved it through `security find-generic-password` (200 OK); the value is nowhere on disk; rollback ✓; a missing item fails clearly but prints the error twice with `security`'s raw stderr line (R-MAC-05). |
| 11. Notification | The `notify` step and a direct `osascript` notification both shown; no permission prompt. |
| 12. Raw export | `run quote --raw --cursor layer --format prores --fps 60`: 4 ProRes 422 HQ clips + 4 ProRes 4444 layers in 1 m 12 s (cloud ≈ 3.5 min), machine busy with other work; `scripts/validate-raw.py` OK with OpenTimelineIO 0.18.1 on Python 3.13 (3.14: `bad any cast`); a layer composited over its clip with ffmpeg at "Send request": hand on the button, ripple, no halo. **No editing tool installed** (no Final Cut Pro, Premiere Pro or DaVinci Resolve): imports skipped by the user's choice, R-RAW-06 stays partial. |
| 13. Clean up | Fixture stopped; the test keychain item deleted by the user. |
