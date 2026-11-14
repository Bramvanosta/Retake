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
  (see [Studio app](studio.md#studio-app)). The token is kept in the Retake home (`ui/<hash>.token`, 0600), not in the
  workspace's `.retake/ui.json`, so a program confined to the workspace folder never reads it — and `retake ui`
  refuses to start when the Retake home itself lies inside the workspace (`RETAKE_HOME` set there). On macOS the link
  with its code reaches the browser through the input of `/usr/bin/osascript` (else a 0600 `.webloc` opened by
  `/usr/bin/open`), never a program's arguments.
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
  this token. Its port is fixed (47820) so the registration survives restarts; when it cannot take that port, the
  server looks up the listener (`lsof`, `ps`, by their absolute paths) and starts only beside its own kind: this
  account's own `retake mcp --http` gets the "port busy" answer (use it, or stop it first), and any other listener —
  another account's (invisible to this account) or one of this account that is not a Retake MCP server — is refused
  with the advice to stop it and run `retake mcp --http --rotate-token`, since a client may already have sent the
  token there. A lookup that fails is tried once more; failing again, the start is refused with the command that
  shows the listener and the same advice if it is not yours. Known limits: on a Mac shared with other accounts,
  another account's program can still take the port while `retake mcp --http` is not running and receive the token a
  client sends — the check runs at start only, and the client does not check the server it reaches; and "its own
  kind" is read from the listener's account and command line, which another program of the same account could copy
  (BACKLOG BL-162). The stdio registration listens on nothing: it is the safe default on a shared Mac.
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
- **Another project's production hosts.** Work submitted through MCP, the Studio or the desktop app may not point a
  read-write environment at a host of another project's production or read-only environment: `project_create` refuses
  such a page, and a run, hooks or a reset on such an environment are refused. Hosts are compared as the server they
  reach: loopback names and addresses are one address (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, and the
  unspecified `0.0.0.0` / `[::]`), an IPv4-mapped IPv6 address is its IPv4 form (`[::ffff:127.0.0.1]` is
  `127.0.0.1`), numeric forms are read as a browser reads them (`127.1`), and ports are compared. When one side is an
  address (loopback included, however it is written) and the other a name, the name is resolved (the system
  resolver, `/etc/hosts` included) and its addresses are compared; the names of one check are resolved together, so
  the check waits at most 2 s, however many names it holds. A name that does not resolve in time next to an address
  counts as the same server, so the work is refused (write the host the way the protected environment does, or a
  person adds the environment to project.yaml marked production).
  Not compared: two different names that resolve to the same address, and an IP literal behind a `*.domain` pattern
  of `read_only.hosts`.
- **Destructive hooks need `confirm: true`.** SQL `DELETE`/`DROP`/`TRUNCATE`/`ALTER`/`UPDATE` (inline, in files or
  sent to `psql`), HTTP `DELETE`, shell `rm`/`dropdb`, and hooks declared `destructive: true` are flagged by
  validation and refused at run time without it (`retake hooks run --yes` approves explicitly). A shell command is read
  with its quoting resolved (`'…'`, `"…"`, `$'…'`, `$"…"`, backslashes), and every script it makes a program run is
  read too, eight levels deep: command and process substitutions, the `-c` script of a shell (`sh`, `bash`, `zsh`,
  `dash`, `ksh`, `ash`, `mksh`, `yash`, `fish`, `tcsh`, `csh`, `busybox sh`, and a name ending in one such as `rbash` or
  `bash5`; also `-ec`, `-lc`, after other options), `eval`, `trap`, an `alias` value, `env -S`, `watch`, `su -c`,
  `sudo -s` / `-i`, `xargs` and `parallel` running a shell, `find -exec` / `-execdir` / `-ok`, and what a shell reads
  on its standard input. **Whenever the script a program will run is not exactly in the command, the command counts as
  destructive.** A script is exact only as a literal string (a `-c`, `eval`, `trap`… argument), a literal heredoc or
  here-string, or the output of an `echo` without backslashes or a `printf` with one literal format, no directive but
  `%%` and ANSI-C escapes; everything else counts — a command word computed or expanded when it runs (`$CMD`, `$(…)`,
  `` `…` ``, `<(…)`, a glob, a brace expansion, after assignments, keywords such as `function`, `coproc`, `time -p`
  and wrappers such as `sudo`, `env`, `timeout`), a shell reading a script piped from another program (`curl … | sh`,
  also after a line break, inside `( … )` or a compound command, through `/dev/stdin`, a file descriptor or `|&`), a
  script from a process substitution (`bash <(…)`, `source <(…)`), a script file named by a computed path
  (`sh "$SCRIPT"`), and a `-c` script, `xargs` / `find -exec` command or here-string that is computed or receives the
  file names or input lines (`{}`). A hook of yours written in such a form needs `confirm: true` (or the script
  written out). A computed argument (`echo "$X"`, `curl "$URL"`) does not count.
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
- **An agent's sql hooks are asked about like its shell hooks.** A statement can reach past its database (a database
  server may run programs or read and write files on its host), so through MCP or the Studio every sql hook the agent
  wrote — the scenario's setup, teardown and named hooks, or a hook whose statement, file, rollback file or database
  URL is rendered with its `vars` — needs your approval, whatever the statement, bound to it (and to the bytes of the
  file it reads) like a shell hook, its statements shown as they will run (a file's text rendered, the file named
  beside it), its rollback shown and approved with it. Your own sql hooks (project.yaml, `hooks/<name>.yaml`) keep the destructive rule only, and a
  sandbox's seed and reset steps come from `sandbox.yaml`, which no agent path writes: not concerned. What an approved
  hook then does is what you approved: a statement or a command that reaches the machine can write any file Retake's
  own files sit beside — the project's record of scenario writes too — so read it before you say yes.
- **An agent's shell and sql hooks are asked about in a terminal too.** When the hooks of a scenario were last written
  by an agent — through MCP or the Studio — `retake run` and `retake hooks run <scenario>:setup|teardown` list its shell
  and sql hooks (setup, teardown, the named hooks its steps run) as they will run: the command rendered with the run's
  vars, pages and run id, its working folder, each environment entry and its rollback; an sql hook's statements (a
  file's text), its database and its rollback; every hidden character written out;
  a secret stays a token and a value filled from an earlier hook's response is said to be unknown until the run. They
  run only on your yes: asked in a terminal (no by default), `--yes` in a script, refused without a terminal.
  Who wrote them is read from the scenario's hook surface — its setup, teardown, named hooks, the names its `hook:`
  steps run, its vars and its env: each scenario write of Retake adds a line to the project's own record
  (`<project>/.retake/scenario-writes.jsonl`: the bytes' and the surface's hashes, never a value, and who wrote it).
  The surface belongs to the newest write that brought it, or to your newest write of it; a write that left it as it
  was (a caption edited in the Studio) changes nothing, and an edit by hand that leaves the hooks as they were keeps
  them the agent's. The record read is that of the project holding the scenario file. For writes the record does not
  hold (from before it, or a line it lost), the workspace journal decides on the exact bytes; when it holds an agent's
  write of the file with other bytes, who brought the hooks cannot be told, and you are asked. For such a scenario an edit by
  hand does not stop the question; `retake hooks trust <project> <scenario>` does — it lists the hooks as a run would,
  asks, and on your yes records them as yours, so runs no longer ask until they change (a terminal's command only).
  That trust also binds the bytes of the files those hooks read. Code is bound strictly — an sql or js file and its
  rollback's, and in a shell command the script it runs: the command itself when written with a slash (`./seed.sh`),
  the script given to `sh`, `bash`, `zsh`, `dash`, `node`, `deno`, `bun`, `tsx`, `python`, `python3`, `ruby`, `perl`,
  `php`, `source` or `.`, psql's `-f`, and what `<` reads; the command is read with its `$'…'` quoting resolved, and the
  scripts of its command substitutions and of `sh -c` (also `-ec`, `-lc`) are read the same way; one that changed, one
  the hooks newly run, or one that cannot
  be read asks again. Every other file a shell command names (and its `env` values) is data, bound when it exists:
  one that changed or cannot be read asks again, one that appeared since does not. A word is looked for in the hook's
  working folder and in every folder an earlier `cd` of the command names; templates are rendered with the vars. When
  a file is not as trusted, `retake run` and `retake hooks run` ask again, whatever the kinds of the hooks (a js file
  too), and the listing names each file; the run is then held to the files as they were read — a hook whose files
  changed since (a teardown or a `hook:` step that runs minutes later, after the capture) is refused, and an sql or js
  file is checked again as its bytes are read. Files the hooks write are bound like any other, and only a file a hook
  names as written (a plain `>` target) can become the run's own output: any other held file that changes — between
  two hooks, or while a hook runs, even by that hook — is refused to the hooks that read it later. So a file written
  otherwise (`cp`, `tee`, `sed -i`, a script) and read later in the same command is asked about: write it with a plain
  `>` instead (`cat a > b` for `cp a b`, `… > f` for `… | tee f`). A file a hook writes with a plain `>` is the run's own output only when that hook ran in this
  command, succeeded and really wrote it (its bytes or its modification time changed; a `>` inside quotes is no
  redirect): later hooks of the same command read it as written — a script, a data file or a dump one hook writes and
  a later one reads runs, run after run. The check before the run leaves such a file out only when its writer is due
  to run before its first reader in the same command; the run then holds it to the trust until its writer writes it.
  Otherwise — `retake hooks run <scenario>:teardown` alone after its setup, a writer that did not run, wrote nothing
  (behind a condition) or did not succeed — the file is checked against the trust, and a reader whose writer did not
  succeed is refused. When such a file is then run as code, its writer's own inputs are bound as code too (`cat n.txt >
  gen.sh` then `sh gen.sh`: `n.txt` changed or newly there is asked about, under Retake's folders too), and so are the
  inputs of every writer up a chain of such files (`cat n > a`, `cat a > g.sh`, `sh g.sh`). Not
  bound: a file reached only through another (a script a bound script runs, an interpreter outside the list such as
  `awk -f`, what `make` or `npm run` read), a file piped into an interpreter (`cat x.sh | sh`: data, so one that
  appears later is not looked at, and nothing under Retake's folders), the value of an interpreter's option (in
  `node --require ./a.js b.js`, `a.js` is taken for the script and `b.js` for data), `$(…)` and glob words
  (`sh tools/*.sh`), a word with a template other than the vars (`{{run.dir}}`, a secret) or a working folder with
  one, an absolute or `~` path outside the project and its workspace, a command looked up on PATH, what `>>` appends
  to, and data under `runs/`, `renders/`, `review/`, `exports/` and `.retake/`; a shell command still reads its script a moment
  after its check. Files a run writes otherwise belong under `{{run.dir}}`,
  which is never bound — a `retake run` pattern: `retake hooks run` has no run folder. You are asked as well
  when the record or the journal cannot be read, or when the project lies outside the projects folder of the
  workspaces Retake looks at. The listing shows the commands, not the files they read: a command that runs or reads a
  file an agent can write (a scenario, a theme, a component) runs what that file holds now — read it before you say yes.
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
- **Jobs an agent can shape run no program of the workspace.** The jobs worker and its job processes, the MCP server
  and the Studio server serve work an agent can shape — the worker runs every job alike, so your own Studio and
  desktop-app jobs too. There, a program a job starts — `browser.executable`, retake.yaml's `ffmpeg:`, the render
  browser, `$RETAKE_CHROMIUM`, `$RETAKE_CHROMIUM_HEADLESS_SHELL`, `$RETAKE_FFMPEG`, `$RETAKE_FFPROBE`, `docker`
  (`$RETAKE_DOCKER`), and the browser Playwright picks for a capture (its cache, or `$PLAYWRIGHT_BROWSERS_PATH`) — may
  not be a relative path or lie inside the workspace (its root and its projects, templates and components folders,
  under any spelling, a symbolic link followed either way), and a command name may not be found on `PATH` in such a
  folder: an agent can write files there. The job fails before the program starts and says what to change (move it
  out of the workspace); the program that passes is started by the real path that was checked, so a link changed
  afterwards starts nothing else. A worker the Studio or an MCP client starts gets these variables as they are, so a
  job that would use one inside the workspace fails with that message rather than running another program.
  `browser.args` there holds switches only (no page or file to open, nothing after `--`), and only switches of a
  short list — the window and the screen, the language, colours and fonts, the GPU, timers and background work,
  first-run screens, media, the proxy and the resolver, WebRTC and QUIC, features (none that takes the network
  service out of its sandbox); everything else is refused, Chromium's switches that load code or a profile, write
  logs, dumps or traces, trust other certificates or open a debugging channel among them (the full list in
  [Workspace](workspace.md)). A command typed in a terminal runs as you wrote it; `retake doctor` warns about each
  setting such a job would refuse.
- **Jobs an agent can shape pass on an allow-list of the environment.** The worker keeps the environment it was
  started with (an automated sign-in's `{{env:…}}` reads it), but the programs its jobs start — shell hooks and their
  rollbacks, `docker` / `docker compose`, a process sandbox's services — get only the shell's own variables of it:
  `PATH` (no relative entry, no folder inside the workspace), `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TERM`,
  `LANG`, `LC_*`, `TZ`, the proxy and certificate variables, and for `docker` the ones that say which daemon and how
  (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`,
  `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM`, `DOCKER_BUILDKIT`, `BUILDKIT_PROGRESS`). A token or a password
  exported in the terminal that started the Studio, the app's worker or `retake worker` never reaches a program an
  agent can make run — except inside a proxy variable: a `user:password@` written in `HTTP_PROXY` / `HTTPS_PROXY`
  is passed on with it. Anything else is passed on purpose: by name in project.yaml `pass_env:` (a person's
  file; never a loader variable such as `NODE_OPTIONS` or `LD_PRELOAD`: a validation error), or as a hook's or a
  service's own `env:` (`{{env:NAME}}`, masked in every log). A hook that fails there names the variables it got
  (names, never values) and how to pass another. A command typed in a terminal passes its whole environment on.
- **Renders never download a browser.** Every render uses Playwright's Chromium headless shell (the app's own in the
  app) or `$RETAKE_CHROMIUM_HEADLESS_SHELL`; without one no render starts and the message says how to install it.
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
  hooks reach only the sandbox's databases. What a reset rewrites — the mailbox, the database of a seed step or of a
  reset hook — must be served by the sandbox or marked `external: true`, and its shell commands get the sandbox
  services' `env` (`DATABASE_URL`…), not your shell's. Its plain demo passwords are masked like secrets (see
  [Sandbox mode](sandbox.md#sandbox-mode)).
- **Dry runs** never execute steps marked `irreversible`.
