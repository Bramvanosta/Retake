# Security model

What Retake protects and how: hooks, secrets, the local servers, agents. To report a vulnerability, see [SECURITY.md](../../SECURITY.md). Part of the [Retake guide](README.md).

## Security

- **The Studio server** (`retake ui`) listens on `127.0.0.1` only and checks every request in a fixed order before
  anything runs: the `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise: a DNS-rebinding page
  carries its own name), a present `Origin` must be its own and API requests must not come from another page
  (`Sec-Fetch-Site`; a page of another local port — a filmed local app — is *same-site* and refused), then the method
  (no CORS: a preflight always fails), the bearer token (a header, never a cookie or a URL), `application/json` (a
  `<form>` cannot send it) and a 2 MiB body cap. Every answer carries a strict Content-Security-Policy (scripts,
  styles and fetches from the server itself only; no inline script, no `eval`; the page may frame one origin, the
  preview's below, and nothing may frame it) and a Permissions-Policy asking that the camera, microphone, screen
  capture and location stay off for the page and its frames (L5.2: Chromium browsers enforce it; the desktop app
  denies them itself). No secret is in the app's files; the token comes from the one-time code
  (see [Studio app](studio.md#studio-app)).
- **The timeline preview** (L4.5) plays in its own origin: a second `127.0.0.1` port of the same `retake ui` process
  that serves only the preview frame, its script and the files of the take being previewed (the capture, the theme's
  fonts and logo, the music, card media) — each registered only when it lies inside the project, the run or the theme,
  has one name (no hard link) and is read without following a link — under a capability in the path, one per project,
  revoked when the last timeline page of the project is left or `retake ui` stops, never logged; only the frame's
  opaque origin may read those files from a script (CORS `null`).
  The frame is `sandbox="allow-scripts"` (an opaque origin: no storage, no cookie, no access to the Studio page), its
  CSP allows scripts, fetches, images, fonts and media only from that capability (no other host, no WebSocket) and
  requires Trusted Types with no policy (no HTML is ever parsed from a string there), and WebRTC is removed in it.
  It talks to the page over one channel whose messages are checked; one that floods it is stopped.
  **A workspace component runs in the preview only once you allow it:** components of your workspace are code (an
  agent may have written or changed one), so until you click *Allow in the preview* on the timeline — which names the
  component and its folder's content hash — it is not even in the preview's bundle and its stand-in draws. The
  permission lives in the Studio's memory only, for that session: it is gone when `retake ui` stops, and a component
  changed since is held again. No MCP tool can give it. Built-in components always run. (Why: Chrome's prerender of
  a `<link rel="prerender">` ignores a frame's CSP and sandbox — the frame's first script refuses to make one, Trusted
  Types close the HTML parsers, and an unallowed component's code never reaches the frame at all.) An allowed
  component is bundled only with imports of its own folder (real paths: a link out of it is refused), `react`,
  `remotion` and the kit; its module runs only when a previewed plan uses it.
  In Safari (WebKit) the frame shares the page's process: a component that loops in its render freezes the Studio tab
  until it returns (Chrome runs the frame apart); a flooding one is still stopped (BACKLOG BL-110).
- **MCP over HTTP** (`retake mcp --http`) listens on `127.0.0.1` only and takes no request from a web page: the `Host`
  check (421) stops a DNS-rebinding page, and a page holds no token; as a second line, any request carrying an
  `Origin` header or a `Sec-Fetch-*` header is refused (browsers send an `Origin` on every POST and cross-origin fetch,
  and `Sec-Fetch-*` from secure contexts; MCP clients send neither — Node's fetch sends `Sec-Fetch-Mode: cors` alone,
  which is served). Then the route (`/mcp`), the bearer token (the stable one in the Retake home, mode 600),
  `application/json` and a 4 MiB body cap. It is a separate process from the Studio: a page of the Studio never holds
  this token. Known limit: its port is fixed (47820) so the registration survives restarts — on a Mac shared with
  other accounts, another local user's program could listen there first while `retake mcp --http` is not running and
  receive the token a client sends (BACKLOG BL-79).
- **Reads stay in the project.** README.md, scenario files and `project.yaml` read through the engine (MCP tools, the
  Studio), and the files a tool names (a hook's SQL or JS file, a dropped file), never follow a symbolic link out of
  the project folder: they are refused, and the refusal does not name where the link leads. A write through a link to
  another file of the project lands in that file; through one leading out it is refused. The `retake` command line
  itself reads what you point it at. The workspace index (`.retake/index.sqlite`) indexes only regular files of
  the project and takes the umask's mode, like the README files it holds.
- **No secrets in files.** Use `{{env:VAR}}` or `{{keychain:service/account}}` references; validation flags database
  URLs with a clear-text password. Resolved secret values are redacted from hook logs, results and journals, and from
  the run's `log.jsonl`, `run.json`, `timeline.json` and error snippets (see "Secrets in steps").
- **Allow-list.** Hooks of every kind only reach the hosts of the project's environments, `allow_hosts`, localhost
  and the loopback hosts of a sandbox's mailbox and databases (a refusal names the host, never the URL, and `optional:
  true` does not tolerate it):
  - `http` and `sql`: checked on the connection; redirects are checked hop by hop and credentials are dropped when
    the origin changes.
  - `js`: the hook's tab blocks every request to another host before it leaves the browser — navigations and each
    redirect hop, fetch / XHR, beacons, EventSource, images, workers, frames, the page's WebSockets; service workers
    are bypassed there, `window.open` is disabled, and `fetchLater` and `SharedWorker` do not exist (their requests
    would escape the tab's guard). A page that redirects to another host, or a hook that fails
    while a request was blocked, is refused (the message adds the hook's own error — the blocked request may be the
    app's own background traffic: add its host to `allow_hosts`); a hook that catches the failed request and goes on
    succeeds, with a warning naming the host.
  - `shell`: before anything runs, the command line is read for the hosts it names — a best-effort reading of the
    shell text, not a sandbox (dry runs report them; validation flags those written literally): URLs (also as
    `--opt=URL`, in `NAME=URL` assignments and inside inline code: `node -e`, `python3 -c`, `ruby -e`, `perl -e`,
    `php -r`, `deno eval`, `bun -e`, `mongosh --eval`), `$VARS` expanded from the script's own assignments and the
    environment `sh` gets, `curl` / `wget` / HTTPie / `xh` targets without a scheme, proxies (`curl -x`, `--socks5…`,
    `HTTPS_PROXY=`…) and `curl --resolve` / `--connect-to` addresses, database-client hosts (`psql -h`, `host=`,
    PGHOST for a client given no host, `mysql -h`, `redis-cli -h`, `mongosh --host` or address), ssh / scp / rsync
    destinations (`-J`, `-o HostName`, a ProxyCommand), git repositories (`clone`, `fetch`, `pull`, `push`,
    `ls-remote`, `remote add`, `submodule add`), `nc` / `telnet` destinations, the hook's `env:` values — also inside
    `sh -c`, `eval`, command substitutions (`$(…)`, backticks) and heredocs, here-strings or `echo` output fed to a
    shell (other heredocs, SQL and JSON text are data). A host computed when the command runs is refused: built from
    `$(…)`, from a variable the script reads (`read`, a `for` loop, a function argument) or may have set (after
    `source`), a computed database, mongosh address or git repository; an ssh alias of `~/.ssh/config` is checked as
    written (list it in `allow_hosts`). Shell hooks get `$RETAKE_ALLOWED_HOSTS` (comma-separated) to check hosts
    they compute themselves.
  - **What the allow-list cannot see:** what a shell hook's programs do on their own — connecting from their own
    configuration (`pnpm run seed` reading `DATABASE_URL` from a `.env` file, the real host behind an ssh alias,
    kubectl contexts, cloud CLI profiles, PGSERVICE, docker compose service names), a script file they run, a host
    they compute or read (URLs read from files or stdin, `xargs curl < urls.txt`, `fetch(process.env.API)` in inline
    code), code they download or pipe into a shell (`curl … | sh`), commands run inside a container or on another
    machine (`docker exec`, `kubectl exec`, `ssh host 'curl …'`), network tools the scanner does not know (`socat`,
    `ncat`, `ftp`…); in the js hook tab, WebSockets opened by workers, service workers and shared workers already
    running for the origin or started by the hook, WebTransport / WebRTC and preconnect hints, redirect hops inside a
    cross-site frame, the first request of a popup a link opens (closed at once). Like an `http` hook to a local
    server, the check covers what the hook names, not what that program does next (network isolation of hooks:
    `docs/BACKLOG.md` BL-57).
- **Read-only and production environments** (see [Environments](environments.md#environments-display-urls-production-read-only-clock)):
  hooks that write are refused there, before anything runs, and the run's browsers stop their writes to the
  environment's hosts (or answer them with a mock); a production environment is written to only where project.yaml
  sets `access: read-write` **and** the command line says `--allow-writes`.
- **Destructive hooks need `confirm: true`.** SQL `DELETE`/`DROP`/`TRUNCATE`/`ALTER`/`UPDATE` (inline, in files or
  sent to `psql`), HTTP `DELETE`, shell `rm`/`dropdb`, and hooks declared `destructive: true` are flagged by
  validation and refused at run time without it (`retake hooks run --yes` approves explicitly).
- **Everything is journaled.** Each executed hook and its rollback is recorded in `runs/<id>/hooks-journal.json`
  (captures) or `.retake/journals/<id>.json` (`retake hooks run`, `retake env reset`); `retake env reset`
  replays whatever is still pending in both. Journal entries are signed with the key of your Retake home
  (`~/.retake/approvals.key`) when written, over where their journal stands (its project and workspace, runs/ or
  .retake/journals/, its id) and the whole entry: work submitted through MCP or the Studio, and a capture's own
  teardown, replay only entries signed for that journal (another one — older, moved, copied or edited — is refused and
  said: a person can review it in a terminal), and each signed rollback once (`~/.retake/rollbacks-done/`). A terminal
  lists what it replays first and asks about an unsigned entry, shown in full, only with `--replay-unsigned` — never a
  sql or js one, one with secrets or a shell one on a sandbox.
- **What you approve is shown in full.** The approval form of work submitted through MCP or the Studio shows each
  hook as it will run, every field on its own line (a shell hook's command, working folder and each environment
  variable; a sql hook's statement or file and database; a js hook's code or file and page; an http hook's method, URL,
  headers and body; its rollback the same way), templated, secrets as `***`, hidden characters and unusual spaces
  written out, names and keys kept on their line, never cut. A hook over 4,000 characters or a form over 16,000
  (counted as the whole form reads) is refused before anyone is asked (run it in a terminal). A hook's name and its
  `env` names hold no control character (validation).
- **Shell hooks the agent wrote are plain commands.** Through MCP or the Studio, a shell hook written in the scenario
  (or a project.yaml hook rendered with the scenario's `vars`) is read, templated, before anyone is asked and again by
  the worker. Its command, rollback and working folder are plain words — letters, digits and `. / : = @ % + , - _` —
  separated by single spaces, commands joined by ` && `: no quotes, `$`, backticks, pipes, redirections, `;`, globs,
  `#`, `\`, control or non-ASCII characters, so the shell expands, substitutes and hides nothing — and at most 4,000
  characters, checked first. On those words it is refused for `cd` / `eval` / `exec` / `command` / `trap` / `alias` /
  `source` (as the program, after a wrapper or after a shell's prefix word such as `coproc`), a loader variable it sets
  (`PATH`, `HOME`, `NODE_OPTIONS`, `BASH_ENV`, `IFS`, `LD_*`, `DYLD_*`, `BASH_FUNC_*`, `GIT_*`, `PYTHON*`, `PSQLRC`,
  `LESSOPEN`, `MANPAGER`, `SSH_ASKPASS`, `RUSTC_WRAPPER`, `MAVEN_OPTS`, `FPATH`, `npm_config_*`, `PNPM_*`, `COREPACK_*`,
  `PIP_*`, `UV_*` and the like — before the program, as an `env` argument, or by `export` / `read`…), inline interpreter
  code (`node -e`, `python -c`, `awk` without `-f`…), `xargs`, `find -exec`, `env -S`, a package runner or its
  subcommand (`npx`,
  `pnpm dlx`, `npm exec`…), `git -c`, any path through README.md, `scenarios/`, `comments/`, `runs/`, `renders/`,
  `review/`, `exports/` or `.retake/` of a project of the workspace (existing or not; a bare `README.md` too), a path to
  project.yaml or into `hooks/` other than the script a command runs, and a saved response (`{{hooks.…}}`), whose value
  is not known when it is asked about. It names no secret (`{{env:…}}`, `{{keychain:…}}`), as a scenario never does.
  Its `env` names are letters, digits and `_`, and no loader variable. Its rollback is checked again, on the text it
  runs, when it is replayed. The full list: [MCP: Claude drives Retake](mcp.md#mcp-claude-drives-retake), *Safety*.
  These rules decide how a command is written, not what a program does with its arguments: the form still shows the
  command in full, and approving it is approving what it does. A hook that needs more belongs in `hooks/<name>.yaml`
  (or project.yaml's `hooks:` without the scenario's vars), shown in full and asked about, or in a terminal.
- **Approvals are bound to their job.** A human approval taken at submit is signed for that job's id in that workspace
  and used once, when the worker takes the job: a job file copied under another id or into another workspace, or made
  again under the id of a job that already ran, runs no approved hook.
- **A job runs the scenario it was submitted with.** A capture, a rehearsal, an inspection and a scenario's own hooks
  (`<scenario>:setup` / `:teardown`) carry the sha256 of the scenario bytes checked and approved at submit (signed
  with the approvals). The worker reads the file once and runs those bytes only: a scenario changed in between — its
  hooks, or only the `vars` they are rendered with — fails the job as `conflict` ("submit it again"), before any hook
  runs.
- **What a scenario opens.** Every scenario opens only `http:` and `https:` pages or exactly `about:blank`, never a
  URL holding sign-in details: `file:`, `data:`, `javascript:`, `blob:`, `view-source:`, `chrome:` and the like are
  validation errors at the field. The URL is read as a browser parses it (WHATWG URL: any case, leading spaces and
  tabs ignored), never by matching its text. Work submitted through MCP or the Studio — every job the worker runs —
  opens a full URL only on the exact origin of one of the pages of the environment it runs on (scheme, host and port;
  `//host/…` refused); a path of an environment page is always fine. Checked at submit and again by the worker before
  anything opens; a refusal names the field, the origins allowed and the fix (a person adds the origin as a page of the
  environment in project.yaml). A templated URL is checked once rendered and resolved, when its step runs, and fails
  the step before its page loads; prewarm skips it. A link the page itself provides (a `new_tab` click that opened no
  tab, followed by the runner) is held to the scheme rule only, plus `blob:` documents of the page's own origin. The
  rule covers what the runner opens: a redirect, a link the page follows itself or a click that opens a tab may still
  take the browser to another http(s) site.
- **Sign-in details of an environment page.** A page URL of project.yaml may carry HTTP sign-in details
  (`https://user:password@staging.example.com`, for a staging site behind basic authentication): Retake takes them out
  of the URL — the runner, the logs, the timeline, the video, the Studio and the hooks' `{{pages.…}}` see it without
  them — and gives them to the capture, sign-in and recording browsers as HTTP credentials for that page's origin
  only: another origin that asks for a sign-in is never answered with them (its request waits). The password is
  masked like a secret wherever a run writes. One origin per environment can carry them (with one set of details);
  more is a validation error of the environment.
- **The capture browser reads no local file.** Every browser a capture, a rehearsal or an inspection opens fails any
  `file:` request itself — of any page, tab, popup or frame, whatever started it —, set before anything loads; a run
  whose browser cannot be set this way does not start. An http redirect to a `file:` URL fails too.
- **What a page reports to the runner is bounded.** The calls the in-page kit makes to the runner (a web notification,
  what its cursor shows) are taken from a page's own document only: a frame inside it — an embed, an ad — is ignored.
  A notification's fields must have the expected types (else it is ignored); its title, body and tag are cut at 2,048
  characters. A run records at most 50 notifications and reads at most 20 icons, then says so once. An icon is read
  only from a `data:` URL of at most 1 MiB decoded, or from an http(s) URL on the notifying page's own origin or one of
  the environment's origins (another port of localhost is another origin), fetched with that page's cookies, without
  following a redirect and stopped beyond 1 MiB; any other icon is not requested — a warning, and the artefact keeps
  its URL. An icon served from a CDN or behind a redirect is therefore not read: to have it read, add its origin as a
  page of the environment in project.yaml. What the cursor reports needs a finite time (and point), and a page's cursor
  effects beyond 60 in a second are not recorded (one warning per run).
- **Every browser runs sandboxed.** Each Chromium the runner launches — captures, rehearsals and inspections, the
  sign-in and recording windows, a site extraction, the artefact renderer, the cursor layer, `retake doctor`'s probe —
  runs with its OS sandbox on (renderers, GPU and utility processes confined by the system) and site isolation on
  (asked for at every launch: `browser.channel: headless-shell` included, which leaves it off by default).
  `browser.args` cannot turn either off, nor open the browser to other code (`--disable-web-security`, a launcher such
  as `--renderer-cmd-prefix` or `--gpu-launcher`, `--browser-subprocess-path`, a `--remote-debugging-port`): those
  switches are validation errors in retake.yaml and project.yaml (see [Workspace](workspace.md)) and refused again at
  launch. Each launch then reads the browser's own command line and refuses a browser that holds one anyway — an
  executable that adds switches itself (`browser.executable`, `RETAKE_CHROMIUM`) — and `retake doctor` fails on it.
- **The render browser is sandboxed too, and its page server is local.** On macOS the Chromium a render opens
  (videos, stills, component previews, `retake doctor`'s GPU check) runs with its OS sandbox on and every site in a
  renderer process of its own: Retake ships Remotion's renderer with a patch (`patches/`, applied by pnpm) that leaves
  out the switches Remotion would add to turn them off, and a render browser whose own command line turns either off
  anyway (a `RETAKE_CHROMIUM_HEADLESS_SHELL` that adds switches itself) is refused. The server that hands the render page its bundle listens on
  `127.0.0.1` and `::1` only, at the same port (the page loads `http://localhost:<port>`, which reaches either) — never
  on another address of the machine — and serves the render page's own origin only: a `Host` other than `localhost`,
  `127.0.0.1` or `[::1]` with its port gets 421, a request from another origin (an `Origin` other than its own, a
  `Sec-Fetch-Site` other than `same-origin` or `none`) 403. A port another program already holds on `::1` is never
  used: a render that picks its port takes another one, a render given its port (every render the worker runs) fails.
  Like every loopback server, it can be reached by another account of the same Mac while the render runs.
- **Sandboxes are local.** Every URL of a sandbox.yaml is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`,
  `[::1]`; a database URL without `?host=` / `?port=`), a sandbox is never production, and a sandbox scenario's sql
  hooks reach only the sandbox's databases. What a reset rewrites — the mailbox, a seed's database — must be served by
  the sandbox or marked `external: true`, and its shell commands get the sandbox services' `env` (`DATABASE_URL`…), not
  your shell's. Its plain demo passwords are masked like secrets (see [Sandbox mode](sandbox.md#sandbox-mode)).
- **Dry runs** never execute steps marked `irreversible`.
