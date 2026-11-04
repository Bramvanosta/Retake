# Sign-ins and environments

Personas and signed-in sessions, then environments: display URLs, production, read-only, the clock. Part of the [Retake guide](README.md).

## Signing in: personas and sessions

Scenarios never contain passwords, and `project.yaml` never contains the path of a session. A project names its
**personas** — the accounts its videos are filmed as — per environment (or for all of them); each one's session stays
on this computer, in the Retake home `~/.retake` (`RETAKE_HOME` moves it), outside every project and
repository:

```yaml
# project.yaml (the fixture project's environment signed-in)
auth:                                  # global, or keyed by environment name (as here)
  signed-in:
    login_url: /sign-in                # sign-in pages: a path prefix, "<page>:/path", a URL prefix or {regex, flags}
    personas:
      supplier:
        pages: [console]               # environment pages it is signed into (a page belongs to one persona)
        check: {url: "console:/products", expect_text: Maja Lindqvist}   # off camera, before every run
        login:                         # optional: automated login, off camera (secret references only)
          - open: "console:/sign-in"
          - type: {into: {label: Email}, text: maja@northfield.example}
          - type: {into: {label: Password}, text: "{{env:NORTHFIELD_SUPPLIER_PASSWORD}}"}   # or {{keychain:…}}
          - click: {role: button, name: Sign in}
          - wait_for: {text: Maja Lindqvist}
      buyer:
        pages: [shop]
        check: {url: "shop:/", expect_text: Demo Café}
```

A persona's keys: `email` (its mail address: `wait_for_email {to: persona:<name>}`), `pages`, `session` (`profile`, the default: a Chromium profile; `storage_state`: cookies and
localStorage only), `check` (`url`: `"<page>:/path"`, a path or a URL, default its first page's `/`; `expect_text`: a
text only shown when signed in — without it, signed in means "loads off the sign-in pages"; `expect_not_url`: more
sign-in pages; `timeout`, default 10 s), `login_url` (its own sign-in pages, with `auth.login_url`) and `login` (steps
`open`, `click`, `type`, `press`, `wait_for`, `wait` in scenario syntax; `{{hooks.…}}` is not available there).

**Sign in once** with `retake login`:

```sh
retake login northfield-fixture --env signed-in --persona supplier          # a browser window: sign in (SSO, 2FA…), close it
retake login northfield-fixture --env signed-in --persona buyer --auto      # or its login steps, headless (CI, tests)
retake auth status                                                           # every persona, and its last check
```

`retake login` opens a visible Chromium window on the persona's own profile
(`~/.retake/profiles/<project>/<env>/<persona>/`), on its check page (`--page KEY` / `--url URL` to choose),
with the session saved so far — still signed in when it still works. Sign in, then close the window (or quit the
browser). It saves a snapshot of the session (`~/.retake/sessions/<project>/<env>/<persona>.json`: the cookies —
session cookies too, which a profile loses when it closes — and localStorage, readable only by you), checks the
session the way a run will see it and prints
`✓ supplier (env signed-in) signed in: console:/products shows "Maja Lindqvist" — runs use a copy of this session`
(else "still signed out … did the sign-in finish?", exit 1). A window that ends signed out never replaces a saved
session that still works (it is kept, and said so). A new profile never offers to save a password; a first sign-in
that fails leaves no profile behind. Ctrl-C closes the window and saves nothing (exit 130). `--persona` is needed when
the environment has several personas; `--auto` runs the persona's `login:` steps headless instead of a window — after
checking the saved session the way a run sees it: one still valid is kept as is, no step runs. A profile a browser
still holds (another login window) is refused. On a terminal, `retake new` asks for the personas (a persona whose
environment pages all have one already films none by default: a scene picks it with `persona:`) and offers to sign
each one in (no answer: later).

**Who films which page.** A page is signed in as the persona whose `pages` list its environment page;
`persona: <name>` on a scene — or on a page of a multi-page scene, `pages.<id>.persona` — chooses another one, and
`persona: none` none (a fresh browser: a sign-up, a public page). A page id keeps the persona it is first filmed with
for the whole run: another account on the same environment page needs a page id of its own (a multi-page scene's
`pages`). A `new_tab` is signed in as the page that opened it (a tab of a `persona: none` page has none either);
`persona: none` written on a later scene for a page filmed without a persona so far leaves it unguarded for the run. A
`js` hook runs as the persona its page is filmed with in the scenario (`none` included), else as that page's default —
`retake hooks run <project> <scenario>:setup` binds it the same way. Each persona gets its own browser (its own
cookies): a multi-page scene films the supplier and the buyer of one site side by side, each signed in as itself.
Validation names an unknown persona and a page asked for two. An environment without personas behaves as before.

**Before every run** — dry runs too, once the secrets are read, before any setup hook or recording — each persona the
run films is checked off camera, in a tab of its own browser. A persona that is not signed in and has `login:` steps
signs in automatically (off camera; the run warns, and its saved session stays expired: `retake login` saves one runs
can reuse). Otherwise the run stops before anything happens, with the exact command:

```
✗ run failed in 762 ms · 0/19 steps
  error     session preflight failed — nothing was recorded:
              persona buyer (env signed-in): expired — shop:/ landed on the sign-in page (http://localhost:4404/sign-in)
                sign in again: retake login northfield-fixture --env signed-in --persona buyer
```

**During the run**, a filmed page that lands on a sign-in page — `auth.login_url`, the persona's `login_url` or
`check.expect_not_url`, matched on the URL's origin and path (never its query; `/sign-in` also matches `/sign-in/…`,
not `/sign-in-help`; `"<page>:/path"` and URLs also after an http → https or apex → www redirect) — fails the run at
once, and the run keeps nothing: no frame, video, screenshot, artefact or timeline (a step failing meanwhile reports
the landing, even an `optional` one). A `download` whose document opens on a sign-in page fails the same way (it is
never saved). Pages without a persona are guarded by `auth.login_url` too, unless written `persona: none`. A landing
right after the setup hooks says a hook may have reset the sessions; a tab that reaches the sign-in page of another
persona's page says so (`… that is page "shop", filmed as persona buyer: a tab keeps the persona of the page it is
opened from — film "shop" on its own page`); after a step fails on a persona's page, one check says whether its
session expired. An expiry seen during a run is saved: `retake auth status` shows `expired` (`expired during run …`).
Validation refuses a sign-in pattern that would match every page (`/`, `"<page>:"`, an environment page's URL, a
regex matching any URL) and the regex flags `g` / `y`, and warns about `{regex: "^/…"}` (a regex sees `http://host/…`)
and `/sign-in/i` (a path, not a regex: write `{regex: sign-in, flags: i}`).

**Copies.** A run never opens a persona's profile: it runs on a copy (copy-on-write where the disk allows; caches,
locks and saved passwords left out) plus the snapshot's cookies, in the system temp folder, removed at the end. Runs
of one persona can therefore run at the same time; a profile a login window still holds is refused (close it first).
A `storage_state` persona runs on a fresh profile plus its snapshot. A second Ctrl-C removes the run's copies before
it quits; Ctrl-C in `retake login`, `auth status --check` or js hooks (`hooks run`, `hooks rollback`, `env reset`)
closes their browser and its copies, then exits 130; copies a killed process left behind (`retake-session-*`,
`retake-login-*`, `retake-profile-*`, no browser on them for 10 minutes) are removed by the next run. Ctrl-C during the preflight's
check or automated login cancels at once.

**Status.** `retake auth status [--project P [--env E]] [--json]` lists every persona from what is stored — `valid`,
`expired`, `never` (no session saved), `unchecked` (saved, never checked), `error` (could not be checked) — with when
and by what it was last checked (a run's preflight, a run it expired during, `retake login`, `auth status --check`),
whether a browser holds its profile, and the command for any that is not valid:

```
northfield-fixture · env signed-in
  supplier  valid     checked 2 min ago (preflight of run 20261013-141530-live-quote)
  buyer     expired   checked just now (auth status --check): shop:/ landed on the sign-in page (http://localhost:4404/sign-in)
            → sign in again: retake login northfield-fixture --env signed-in --persona buyer
```

`--check` checks each saved session now (headless, one after the other, without signing in), saves the result and
exits with 1 when one is not valid; a profile a browser holds is not checked (`not checked · in use by a browser`:
close that browser first). `retake doctor --project P` shows the same per persona, and warns when the Retake
home — or a session — sits inside a git work tree that does not ignore it.

**The fixture** serves its two apps behind a sign-in too (:4403 / :4404, invented accounts and passwords in
`fixtures/wholesale/README.md`): the fixture project's environment `signed-in` runs every scenario signed in.

```sh
export NORTHFIELD_SUPPLIER_PASSWORD=… NORTHFIELD_BUYER_PASSWORD=…     # from fixtures/wholesale/README.md
pnpm retake login northfield-fixture --env signed-in --persona supplier --auto
pnpm retake login northfield-fixture --env signed-in --persona buyer --auto
pnpm retake run northfield-fixture live-quote --env signed-in        # each pane signed in as its persona
```

**One account, the older form.** `auth: {profile: ~/…}` (or `storage_state: file.json`), global or per environment,
still works as the persona `default` on every page, with a validation warning (a path that only exists on one
computer): `retake login <project> [--env E]` opens a window on that profile as before, and runs use a copy of it. As
before, a missing profile starts signed out and a missing `storage_state` file fails the run before anything runs
(`retake auth status` says to export it again: `retake login` has no window for it).

**Limits.**
- Nothing is written back from a run: an app that rotates its refresh token on every use may ask to sign in again
  sooner (each run refreshes a copy); `retake login` again then.
- Tokens kept in sessionStorage are lost between runs; IndexedDB travels in a `profile` persona's copy, not in a
  `storage_state` snapshot.
- A sign-in screen an app shows without changing its URL is caught only when a step fails (the frames until then are
  filmed): give such an app a `check` with `expect_text`, and steps that wait for signed-in content.
- Signing out on camera fails the run (the guard sees the sign-in page).
- A session belongs to the computer that saved it (a snapshot from another one is warned about); sessions are kept
  per project slug, so two workspaces with a project of the same slug share them.
- A copy starts with cold caches: its first page loads are slower (held, and cut by the edit).

## Environments: display URLs, production, read-only, clock

An environment is written in one of two forms. The **short form** is the page map itself; the **long form** puts
settings next to a `pages:` map. A page is its base URL, or `{url, display}` — in both forms.

```yaml
environments:
  local:                                        # short form: page key → base URL …
    console: http://localhost:4401
    shop: {url: http://localhost:4402, display: shop.northfield.example}   # … or {url, display}
  production:                                   # long form
    production: true                            # read-only, unless access: read-write (and then only with --allow-writes)
    access: read-only                           # read-only | read-write; default: read-only in production, else read-write
    pages:
      console: {url: https://console.example.com, display: console.example.com}
      shop: https://shop.example.com
    read_only:                                  # used only when a run on this environment is read-only
      hosts: [api.example.com]                  # hosts that belong to it: writes stopped (production: every host is), never written to from other environments
      allow:                                    # writes let through: a token refresh, a search sent as POST…
        - POST console:/api/session/refresh
        - {request: "POST shop:/graphql", operation: SearchProducts}
      mocks:                                    # answers to stopped writes, for every scenario on this environment
        - {request: "POST shop:/api/track", status: 204}
```

`production`, `access` and `read_only` written in the short form are an error that says to use the long form (a page
key named `access` with a URL stays a page). Every consumer still sees each page's real URL: `{{shop}}` in a step or
a hook is `http://localhost:4402`.

**Display URLs.** `display` is a public host (`shop.example.com`, https implied: the address bar shows the lock), a
`host/path` or an `http(s)://` URL — no query, fragment or `{{…}}`: it is shown as written; a local host or a port out
of range is refused. The runner navigates the real URL; `timeline.json` keeps both (`environment.display`) and what the
video shows maps the real URL to the display one: the page whose base is the longest prefix of it (path and query
kept; a page without a display URL keeps its URLs as they are), else — a URL under no page, on the origin of one with a
display URL — that origin's display host. Only http(s) URLs are mapped (a `blob:` URL maps the URL it wraps; a `file:`
URL is local). Display URLs are **edit-time data**: `retake render`, `plan`, `still` and `export-capture` take
project.yaml's current display URLs of the run's environment (a run captured before L1.7: the environment of its
`run.json`), so adding or changing one needs a new render, never a new capture (only text templated at capture —
`{{shop}}` in a caption — keeps what it read then); what the run recorded is kept for pages project.yaml no longer
declares. What the video shows:

- **Browser bars**: the address bar and tab strip of `studio/layout-browser`, the window bars of `split` / `pip` (themes
  framing captures in a browser) show the display URL. A **local URL without a display URL** (localhost, a name without
  a dot such as `devbox`, `*.localhost`, `*.local`, `*.test`, `*.internal`, `*.lan`, `*.home.arpa` and kin, a loopback,
  private, link-local or 100.64/10 address, `file:`) is never drawn: the bar shows no address there (the window bars
  fall back to the theme's `brand.url`), `retake render` warns once per page ("page "shop" has no display URL
  (http://localhost:4402)… add display: to environments.local.shop in project.yaml and render again") and the review
  reports `url-hidden` — only for layouts that draw a URL (a card, a laptop, a phone draws none).
- **Text you write**: `{{shop}}` in a caption, a card, an overlay's slots, a page label, the title, the intro or the
  outro reads the display URL (`https://shop.example.com`); in a step, `open`, a hook or a mock it stays the real URL.
  A text that names a local URL anyway is `local-url-text` in the review.
- **Notification overlays** name the display host of the page that sent the notification (a local host without one:
  the theme's brand name).
- **Reports and raw exports**: a review's findings never name a local host (a URL is its display URL, else its path
  "(a local page)"; a caption you wrote is quoted as written in report.md's caption list, and flagged
  `local-url-text`); the step markers and click targets of `export-capture` name the display URL, else the path
  (`3. open /quotes`). The real URLs stay in the run's `timeline.json`.
- Not mapped: what the captured page itself shows (its own links and text), captured emails and PDFs.

**Access of a run.**

| Environment | Without `--allow-writes` | With `--allow-writes` |
|---|---|---|
| not production, read-write (the default) | read-write | read-write (nothing changes) |
| `access: read-only` | read-only | usage error |
| `production: true` | read-only | usage error |
| `production: true` + `access: read-write` | read-only, with a notice | read-write, with a warning ("writes go to production") |

`--allow-writes` exists on `retake run`, `retake hooks run`, `retake hooks rollback` and `retake env reset`; it
confirms writes, it never grants them. The run header says `production` / `read-only` / `writes allowed`, and
`run.json` / `timeline.json` record the access.

**On a read-only run, hooks that write are refused** (status `refused`; `optional: true` does not skip a refusal): an
`http` hook whose method is not GET or HEAD (a GraphQL query sent as POST reads; a JSON body is GraphQL only when its
keys are `query` / `operationName` / `variables` / `extensions` and its `query` is a document), a `sql` hook with a
statement that is not a read (reads: `SELECT` without `INTO` / `FOR UPDATE` / `nextval` / `dblink`, `WITH` without a
data-modifying part, `TABLE`, `VALUES`, `SHOW`, `EXPLAIN` of a read, `SET` / `RESET` of anything but the transaction
mode or the role — a quoted name counts: `SET "transaction_read_only" = off` writes), a `shell` hook unless it declares
`writes: false` (and then `rm`, `dropdb` or destructive SQL given to `psql` still write), and a setup hook whose
`rollback` writes. `js` hooks run: their tab stops their writes. The SQL of a read-only run runs in a read-only
transaction (a function that writes fails in Postgres). `retake run` refuses a scenario with
such hooks before any browser opens, listing them — run it with `--hooks skip`, on a read-write environment, or with
`--allow-writes` where project.yaml allows writes; `retake validate` warns about them. `retake env reset` and `retake
hooks rollback` judge each pending rollback by the environment its hook ran in: a rollback journaled on production
with `--allow-writes` is not replayed by a plain `retake env reset` on a local environment.

**No run writes to another environment's production hosts.** The hosts of the project's read-only environments (a
production one, `access: read-only`: their pages' hosts and `read_only.hosts`) are protected in every run: on a run on
`local`, an `http` hook that writes to one (or a redirect hop of it), a `sql` hook that writes to a database there, a
`shell` hook that writes and names one is refused (`refusing a hook that writes (HTTP POST) to api.example.com, a host
of environment production — this run is on environment local: …`), and the browser stops writes to them (no mock, no
allow entry: recorded with `protected_by`, counted `1 stopped (hosts of read-only environments)`). Unless that
environment's own access applies: production with `access: read-write` and `--allow-writes`. A host an environment
this run may write to shares (the fixture's `production` is the same `localhost` as `local`; ports aside) is never
protected — a project without such environments runs exactly as before (nothing is armed).

**In the browser, a read-only run stops writes.** Every browser of the run (one per persona) is guarded from its
launch, the session check included: a request whose method is not GET, HEAD or OPTIONS — a GraphQL query sent as POST
reads; a mutation, or a persisted query known only by its name, writes — to a **guarded host** (on a **production**
environment, every host: fail closed — a write anywhere, a third-party API or analytics included, needs an allow entry
or a mock; on another read-only environment, the hosts of its pages and `read_only.hosts`; on any run, the protected
hosts of the project's other read-only environments) is

- answered by the first matching **mock** (the scenario's, then the environment's): the flow goes on on screen;
- else let through by a `read_only.allow` entry;
- else **stopped**: a fetch / XHR / beacon fails like a network error the app sees, a form POST (in any frame or a new
  window) is answered `204 No Content` — the page stays where it is, never a browser error page, and the click goes on
  at once. The run warns once per stopped request (`a write was stopped (POST shop:/api/quotes, step request.5, 12.4
  s)…`): the app may show an error — add a mock. A stopped write fails the request, not the run.

On a read-only environment that is not production, a write to a host the guard does not watch is sent, recorded
`passed` and warned about once per host (list the host in `read_only.hosts` when it writes your data). An allow entry
or a mock narrowed to a GraphQL `operation` covers a request only when every operation of it that writes is that one (a
batch `[RefreshToken, CreateOrder]` is stopped). `timeline.json` lists every write the guard saw
(`environment.writes`: capture time, method, URL, `blocked` / `mocked` / `allowed` / `passed` / `exempt`, the rule that
matched, `via` page / hook / sign-in, `protected_by`); the run summary counts them (`writes  1 mocked, 0 stopped
(read-only)`; the sign-in's exempt writes aside), the review's environment line too, and each stopped write is a
`write-blocked` warning at the moment the video shows it. Covered: fetch, XHR, `sendBeacon` and `keepalive` fetches
(also while a page unloads — a page the runner closes goes through `about:blank` first, and an unload write to a
guarded host is sent as an ordinary request), dedicated workers, service workers (their own requests included),
cross-site frames, popups and new windows, every persona's browser. `fetchLater` and `SharedWorker` do not exist in a
guarded browser nor in a js hook tab (the browser would send their requests past the guard): apps feature-detect them
— neither exists in every browser — and fall back to what the guard sees; one that requires them fails there. **What
it cannot stop**: messages over a WebSocket (allowed, warned about once per host — an app that saves over WebSockets
writes), WebTransport / WebRTC, an unsafe GET (a write sent as GET), a write to an unguarded host that redirects to a
guarded one (only its first hop is seen), requests of other programs, and what the server does on its own after a
read. Read-only means "no mutating HTTP from the run's browsers and hooks".

- **Signing in.** The automated sign-in tab (`login:` steps of a persona) is exempt while it is on a sign-in page of
  its persona (`auth.login_url`, its `login_url`, `check.expect_not_url`; every page when it declares none) — its
  `POST /sign-in` must happen (recorded `exempt`, `via: sign-in`). What it sends from the page the sign-in lands on (a
  "last seen" ping, an onboarding call) is guarded like a capture page's (recorded `via: sign-in`, counted and
  reported). It bypasses service workers, so a worker that would forward its sign-in POST cannot hide it. An identity
  provider on another host is guarded too on production: list its sign-in page in `login_url` (a URL pattern). The
  session check and every capture page are guarded; an OAuth popup the sign-in opens is not exempt. A **token
  refresh** the app sends from a capture page is a write: list it in `read_only.allow`, or the app may sign out and the
  run fails at the sign-in page. `retake login` and `retake auth status --check` run outside any run: they are never
  guarded.
- **js hooks** run in their own tab, guarded by it: their writes are stopped and never mocked (a hook that writes is
  refused, not fooled) — a hook that fails after a stopped write is `refused`; one that catches the error goes on with
  a warning.
- **Cost.** Any request interception makes Chromium pause every request of the browser and disables its HTTP cache:
  every page load of a read-only run (or of a run that protects another environment's hosts) fetches its assets again
  — invisible on a local app, slower loads (held by the capture, cut by the edit) on a remote one.

**Mocks** (`mocks:` of a scenario, then `read_only.mocks` of its environment) answer writes a read-only run stops in
the browser: `request` (same pattern as `allow`: `"[METHOD ]<page>:/path"` relative to that page's base URL, or
`"[METHOD ]/path"` on any guarded host — on production, any host; `*` matches within a path segment, `**` anything; the query is ignored; GET
patterns are refused), `operation` (a GraphQL operation name), `status` (200–599, default 200), `json` or `body`
(+ `content_type`), `headers`, `delay_ms` (0–10 000). Mocks are literal (no `{{…}}`) and apply to read-only runs only
(a read-write run with `mocks:` warns once: its writes really happen). A mock is the same answer every time — a list
the app reloads afterwards does not show the mocked write. To mock a form POST (a navigation), answer it like the
server would: `status: 303` with `headers: {location: /quotes}`; a JSON answer to a navigation shows the JSON.

**Clock.** `clock:` (project or scenario; a scenario's wins, `clock: false` turns the project's off) is the date and
time the product's browser clock reads when the capture starts — an ISO date-time such as `2026-11-02T10:24:00`
(without an offset: wall time in `browser.timezone`, else the machine's zone; a wall time a DST change skips or shows
twice is refused — write the offset the error suggests, e.g. `2026-10-25T02:30:00+02:00`) or `{at, freeze: true}`. A
date alone, offset minutes past 59 and years before 1970 are refused. `timeline.json` records the clock
(`environment.clock`: `at`, `epoch_ms`, `timezone`, `freeze`), `run.json` too (`at`, `timezone`, `freeze`), and the run
header says it (`clock 2026-11-02T10:24:00 Europe/Paris (frozen)`).

- **When.** The clock is installed in every browser of the run after the session check and the automated sign-in
  (they run on the real time: a sign-in checks its tokens against it; so does the session check after a failed step)
  and before the setup hooks; at capture time 0 it is set to the clock's time, then runs with the capture — two takes
  show the same date and the same time at the same capture time.
- **How.** Only the date: in every page, frame (one created empty too), popup and js hook tab of the run's browsers,
  `new Date()`, `Date()`, `Date.now()` and the date `Intl.DateTimeFormat#format()` / `#formatToParts()` use without one
  read the clock; timers, `requestAnimationFrame`, `performance` and event time stamps stay the browser's own, so the
  product's animations and timers run exactly as without a clock (a clock that fakes timers slowed them: ten animation
  loops from 60 to 30 fps, 100 `setTimeout(0)` from 0 to ~500 ms). Every document computes the time from one anchor:
  pages opened before and after capture time 0, in any persona's browser, agree. **Not covered**: a dedicated worker
  gets the clock as soon as it starts (its very first lines may still read the real date), shared workers (absent on
  read-only runs) and service workers keep the real date, and so do `performance.timeOrigin`, `document.lastModified`,
  cookie expiry and what the server makes (`created_at`, emails, PDFs: L1.8 seeds). A clock far from now can make
  client-side token checks (a JWT's `exp`) refresh or sign out: choose a recent date, and allow the refresh endpoint on
  read-only environments.
- **`freeze: true`** keeps `Date` at the clock's time the whole run. Timers and animation frames still run, but code
  that measures elapsed time with `Date` stalls — a debounced search field that compares `Date.now()`, a
  `Date`-driven animation or countdown, "updated 3 s ago" labels, a timeout computed from `Date`. Use it only when the
  product shows seconds and does none of that on screen.

**The fixture shows all of it.** `projects/northfield-fixture` gives its pages display URLs
(`shop.northfield.example`, `console.northfield.example`) and an environment `production` — the local fixture,
read-only. Its scenario `read-only` (`env: production`, `frame: browser`, `clock: 2026-11-02T10:24:00`) requests a
quote: the scenario's mock answers the `POST /api/quotes` (the toast reads the mock's supplier), the fixture's
`GET /api/health` counts no new write (`mutations`), the address bar shows `shop.northfield.example`, and the shop's
"Prices as of Monday 2 November 2026, 10:24" line (`/#as-of`: the fixture's only date from the browser's clock) is the
same in every take. `retake run northfield-fixture quote --env production` is refused before anything runs (its setup
hooks write).
