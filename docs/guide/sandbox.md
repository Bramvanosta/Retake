# Sandboxes

A disposable copy of your product that Retake starts, seeds and resets before every take. Part of the [Retake guide](README.md).

## Sandbox mode

A **sandbox** is a disposable, local copy of the product that Retake starts, seeds with demo data and resets
before every take, so two takes of a scenario show the same data. project.yaml names each sandbox's manifest; every
sandbox becomes an **environment** of its own:

```yaml
# project.yaml
sandboxes:                         # environment name → its sandbox.yaml, relative to the project
  sandbox: sandbox/sandbox.yaml
default_env: sandbox               # a sandbox may be the default environment (or a scenario's `env:`)
```

```yaml
# sandbox/sandbox.yaml   (every path in it is relative to this file)
# yaml-language-server: $schema=../../../packages/core/schema/sandbox.schema.json
version: 1                         # required; a newer version is refused (made for a newer Retake)
provider: process                  # process | docker-compose
services:
  app:
    command: [node, server.mjs]    # process only: argv (a first word "node" runs the CLI's own Node) or a string for sh -c
    cwd: ../app                    # process only (default: this folder); env: {…} and stop_timeout_s too
    url: http://localhost:4601     # where its health is checked (localhost only)
    health: /api/health            # a path on url | {path|url, status, text, timeout_s, interval_ms} | {tcp: port} | false
    pages:                         # the environment's pages: page key → URL, or {url, display}
      console: {url: http://localhost:4603, display: console.example.com}
      shop: http://localhost:4604
seed:                              # what builds the demo data: http, sql, shell (and exec, docker-compose)
  - http: {method: POST, url: "{{console}}/api/demo/reset"}
  - sql: seed/01-demo-data.sql     # a file next to sandbox.yaml, run on a database below
reset: {strategy: reseed}          # reseed (default) | snapshot (docker-compose + Postgres)
databases:                         # sql seeds, and the sql hooks of scenarios on this environment
  main: {url: "postgres://demo:sandbox-db-4632@localhost:4632/app"}   # a plain demo password is fine here
mailbox: {provider: mailpit, url: http://localhost:4625}             # wait_for_email on this environment reads it
login_url: /sign-in
accounts:                          # demo accounts the seed creates: the personas of this environment
  buyer:
    pages: [shop]
    username: orders@example.com
    password: buyer-pass-4604      # plain (masked in every log), {{env:VAR}}, {{keychain:service/account}} or {{compose_env:NAME}}
    check: {url: "shop:/", expect_text: Demo Cafe}
    login:                         # signs the account in, off camera, whenever its session is missing
      - open: "shop:/sign-in"
      - type: {into: {label: Email}, text: "{{account.username}}"}
      - type: {into: {label: Password}, text: "{{account.password}}"}
      - click: {role: button, name: Sign in}
```

Every key of sandbox.yaml (version 1; `retake schema sandbox` prints the JSON Schema, which editors use through the
`$schema` comment):

| Key | What it is |
|---|---|
| `version` | `1` (required) |
| `provider` | `process` (programs of this machine) or `docker-compose` (required) |
| `compose` | docker-compose: `files` (default `[compose.yaml]`), `project` (default `retake-<project>-<env>-<hash>`), `env_file` (default `.env` next to the first compose file when there is one; `false`: none — see [A "stage" sandbox](#a-stage-sandbox-images-of-a-production-build)) |
| `services.<name>` | `url` (health base), `pages` (key → URL or `{url, display}`), `health`; process: `command`, `cwd`, `env`, `stop_timeout_s` |
| `services.<name>.health` | a path, `false`, or `{path \| url, status, text, timeout_s, interval_ms, tcp}` (`tcp`: process only) |
| `seed[]` | `http`, `sql`, `shell`, `exec` (`{service, command, env, timeout_s}`, docker-compose) + `name`, `optional` |
| `reset` | `strategy` (`reseed` \| `snapshot`), `snapshot.database` (a key of `databases`), `restart` (services) |
| `databases.<key>` | `{url, external}` — sql seeds and the sql hooks of scenarios on this environment (loopback only); `external: true`: see below |
| `mailbox` | `{provider: mailpit \| http, url, poll_ms, headers, clear, external}` — `clear: false` keeps it at a reset |
| `login_url` | the sign-in page(s) of every account |
| `accounts.<persona>` | `username`, `password`, and the persona keys of project.yaml `auth`: `pages`, `check`, `login`, `session`… |

What the sandbox environment gets, from its manifest only (nothing is written twice):

- **Pages and display URLs**: the `pages` of its services (`{{console}}`, `page: shop`), each with its display URL.
- **Personas**: its `accounts`, with `login_url`, `check`, `login` and `session` as in project.yaml `auth`;
  `{{account.username}}` / `{{account.password}}` are only available in an account's own `login` steps, where they
  are written in when the project loads. A plain password is masked like a resolved `{{env:…}}` value as soon as the
  account signs in (log.jsonl, run.json, timeline.json, error pages, `retake login` messages) — every occurrence of
  its text is masked, so validation warns about one shorter than 8 characters or made of one word, and refuses one
  shorter than 3 (texts that short are never masked: they would mangle every log). Signing a sandbox
  account in automatically is expected (a reset drops the sessions the app stored): the run logs it as information,
  not as a warning, and `retake auth status` lists such an account as `auto` (never a `retake login` hint, never a
  failure of `--check`). `auth.<sandbox>` in project.yaml is an error; a global `auth` keeps applying to the other
  environments only.
- **Mailbox and databases**: the sandbox's own `mailbox` and `databases`, never project.yaml's (a sandbox scenario's
  sql hook cannot reach a staging database). A journal replay (`retake env reset`, `retake hooks rollback`) reaches
  the databases of the environment each entry ran in. Their loopback hosts (`db.localhost`, `127.0.0.2`…) are allowed
  hosts at run time, like `localhost`.
- **Never production**: a sandbox is always read-write and has no `production`, `access` or `read_only`.

Validation (`retake validate`, and every command: a broken sandbox.yaml stops them all, reported in that file):

- `version: 1` and `provider` are required. `compose` is for docker-compose; `command`, `cwd`, `env`,
  `stop_timeout_s` are for process (where `command` is required); `exec` steps are for docker-compose (a process
  sandbox writes a `shell` step with `cwd`); the services of a docker-compose sandbox must be services of its compose
  files (default `compose.yaml`), and not under `profiles:` there — Retake runs `docker compose` without
  `COMPOSE_PROFILES`, so such a service never starts (naming one as a service or in an `exec` step is an error).
- **Every URL is on this machine**: `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]` — services, pages, health,
  mailbox and databases (a host written as `{{env:…}}` is refused; only a password may be a reference). Private
  addresses, VPN ranges and names without a dot are refused: a reset may drop and recreate the sandbox's databases.
  A database URL connects where it says: its query string may not carry `host`, `hostaddr`, `port`, `service` or
  `dbname` (pg reads `?host=` — a unix socket too — and `?port=` over the URL's own host and port) and is never
  templated. A health path stays on the service's `url` (`//host/up` and backslashes are refused). A sandbox page on
  the host and port of a page of a production or read-only environment is an error — every loopback host counts as
  the same one (`127.0.0.1:4401`, `[::1]:4401` and `localhost:4401` reach the same server).
- Paths (compose files, `cwd`, SQL files) are relative to sandbox.yaml; an absolute or `~` path is refused. The
  compose files may live in another folder than sandbox.yaml (`compose.files: [../../../product/docker/compose.yaml]`,
  the product's repository): the compose project's folder is the first compose file's, as for `docker compose`
  itself, so the relative paths *inside* the compose files (a service's `env_file`, a build context, a bind mount)
  resolve next to them, and the default project name's hash is that folder's.
- **A password kept in the compose env file**: `password: "{{compose_env:DEMO_BUYER_PASSWORD}}"` (a `username`
  too) is the value that name has in the sandbox's compose env file (`compose.env_file`, or the `.env` next to the
  first compose file; docker-compose only) — one source for the product's seed and for the sign-in, no keychain
  item to copy, and it works in the desktop app, which never sees your shell's variables. Read when the project
  loads and masked like a plain password; a name the file does not set is an error.
- **One app, several accounts**: two roles of the same app (an owner and an admin on one URL) may both list its page
  (`pages: [admin]` on each account). The first account declared is the page's default; a scene films the other one
  with `persona: <account>` (`{page: admin, persona: staff}`). One video that shows both gives each a page id of its
  own in a multi-page scene — `pages: {theirs: {page: admin}, ours: {page: admin, persona: staff}}` —: a page id keeps
  one account for the whole run. (A page key per account on the same URL — `admin` and `backoffice` — still works.)
- Seed steps: `http`, `sql`, `shell`, `exec` — no `js` (there is no browser); they stop at the first failure, are
  never rolled back (a `rollback` is ignored, with a warning) and need no `confirm: true` (a seed rebuilds a local,
  disposable copy). A SQL file that is pg_dump's plain output (`COPY … FROM stdin`, `\connect`) is refused: dump with
  `pg_dump --inserts`, or load it with an `exec` step. A shell step gets the `env` of the process services (below):
  a variable two services set differently must be set in the step's own `env`.
- `strategy: snapshot` needs docker-compose and a Postgres database of `databases` (`reset.snapshot.database`,
  default the first) that is not `postgres` / `template0` / `template1`, with a name of at most 50 characters.
  `reset.restart` names services of the manifest.

### Starting, resetting and filming a sandbox

```sh
retake sandbox up northfield-fixture          # start what is not running, wait until healthy, seed it if needed
retake sandbox status northfield-fixture      # services (pid, health), pages, seed, last reset, take lock (--json)
retake sandbox logs northfield-fixture        # the last lines of each service's log ([service] [--lines 50] [--follow])
retake sandbox reset northfield-fixture       # back to the seed (the sandbox must be up; --reseed)
retake sandbox down northfield-fixture        # stop it (a process sandbox's data goes with it; --volumes)
retake run northfield-fixture sandbox-quote --sandbox   # up if needed, health, reset to the seed, then the take
```

`--env <name>` picks the sandbox (default: the first of project.yaml `sandboxes:`). `status` exits with `0` only when
every service runs and is healthy, `--json` for scripts.

`up` and `reset` say what they are doing while they do it — an image build and the health checks take minutes: on a
terminal, one live line (the step, its elapsed time, the last line of `docker compose` or of the seed command), replaced
by `✓ step  time` when the step ends; in a pipe or CI, a time-stamped line as each step starts and ends. The steps:
`compose` (the compose files, the ports), `build` (with `--build`), `start` (until every service runs and is healthy),
`health <service>`, `databases`, `seed n/N`, `snapshot`, `restart <service>` — a process sandbox: `start <service>`.
`--verbose` copies every line of `docker compose` and of the seed; the last line, `steps`, gives the time of each one.

- **`up`** starts the services that are not running (a process sandbox: in the order sandbox.yaml declares them, each
  one healthy before the next starts; a docker-compose one: `docker compose up`, below). It then seeds the sandbox
  when it was never seeded, when its seed changed (the seed steps, the files they read, the `seed/` folder next to
  sandbox.yaml, and for docker-compose the images of the services), or when it started a service (what a restarted
  process or container held in memory is gone; a process service started with `--no-seed` leaves the sandbox
  unseeded, so the next `up` seeds it), or — strategy `snapshot` — when an interrupted reset left its database
  missing or closed to connections; `--no-seed` skips that. A service still running is kept (and checked again); one
  whose definition changed in sandbox.yaml since it started keeps running as it was, with a warning — `down`, then
  `up`, applies the change. `--build` (docker-compose) builds the images first.
- **`down`** stops every service. A process sandbox's data goes with its processes; a docker-compose sandbox keeps
  its volumes (the next `up` restores its snapshot, or reseeds) unless `--volumes`, which removes them — the database
  and its snapshot — too. Images are never removed.
- **Every take checks its pages first** (L5.8, sandbox or not): one GET of each page of the environment, 5 s each.
  A page that does not answer — nothing listens on its port (a dev server that stopped or moved to another port), a
  gateway error (502, 503, 504) — stops the run before anything opens, naming the page and its URL; any other HTTP
  answer (a 404 at the root, a redirect to a sign-in) counts.
- **`retake doctor --project <slug>`** warns (`Sandbox`) when the project has no sandbox and one of its environments
  films only this machine with a database, a mailbox or reset hooks — each take then starts from whatever the last
  one left —, with the command that scaffolds one (`retake sandbox init`). MCP `project_get` says the same.
- **`run --sandbox`** takes the sandbox's take lock, starts what is not running, checks every service's health,
  resets the sandbox to its seed, then films; the sandbox stays up afterwards. The environment is `--env` (it must be
  a sandbox), else the scenario's `env` when it is a sandbox, else `default_env` when it is one, else the first
  sandbox; `--sandbox` on a project without one, or with an `--env` that is not one, is a usage error. The scenario is
  then validated once, against that environment (its pages, its mailbox): a scenario without `env:` that waits for an
  email only the sandbox's mailbox receives runs with `--sandbox`. A dry run (`--dry --sandbox`) resets too. A failure before the take (a busy sandbox, a port in use, a service that is not
  healthy, a failed seed) creates no run folder. The run prints `sandbox sandbox (process) · running · healthy 1/1 ·
  reset reseed 12 ms` first, its summary a `sandbox` line, and run.json / timeline.json record `environment.sandbox`
  (`{name, provider, strategy, restored, reset_ms, seed_hash, at}`).
- **Without `--sandbox`**, a run on a sandbox environment (`--env sandbox`, or a scenario whose `env` is one) films it
  as it is, with no reset — the sandbox must be up (otherwise the run is refused before anything runs) — and warns when
  a take holds its lock; run.json records the sandbox without a `strategy`.
- **A reset** (strategy `reseed`): the seed steps again (phase `seed`: the first failure stops it, and a sandbox whose
  seed failed counts as never seeded; strategy `snapshot`: the snapshot restored instead, see below; `--reseed` runs
  the seed and takes the snapshot again); as soon as the data is back, the pending rollbacks of earlier runs on that
  environment are marked superseded — `retake env reset` and `retake hooks rollback` never replay them on the
  reseeded data (`DELETE /api/quotes/7` would delete the new quote 7), even when what follows fails —; then the
  mailbox is emptied (Mailpit `DELETE /api/v1/messages`; `mailbox: {clear: false}` keeps it; an `http` mailbox is left
  to the seed) and the `reset.restart` services restarted.
- **Only what the sandbox owns.** A reset empties the mailbox and the seed's `sql` steps rewrite their database, so
  both must be the sandbox's own: served by a service of the sandbox — a port a running container of its compose
  project publishes (made from its folder, with no other project's container publishing that port too), or a port a
  process service names (`url`, `pages`, `health: {tcp: …}`) and listens on —, with no other program on it.
  Anything else is refused before the reset changes anything (`port 8025 (the mailbox http://localhost:8025) is not a
  port of a service of this sandbox …`): a `localhost:8025` or `localhost:5432` may be another stack's. A mailbox or a
  database the sandbox does not start but that is its alone (a Mailpit or a Postgres you run for it) says so with
  `external: true` in sandbox.yaml (`databases: {main: {url: …, external: true}}`, `mailbox: {…, external: true}`).
- **One take at a time.** `up`, `reset`, `down` and `run --sandbox` hold the sandbox's take lock
  (`.retake/sandbox/<env>/take.lock`): a second one fails at once, naming the holder (`sandbox sandbox is in use:
  run 20261014-101500-sandbox-quote (pid 4242) since 10:15:03`). The lock is created whole in one step (written aside,
  then hard-linked into place), and a lock whose process is gone is removed with a note — under a breaker file, and
  only if it is still that lock: two commands finding the same stale lock never both take it.
  `status` and `logs` never wait for it. Two takes at the same time need two sandboxes (another environment, other
  ports).
- **Ctrl-C** during `up`, `reset`, `down` or the preparation of a `run --sandbox` stops what that command started —
  and only that: services an earlier `up` started keep running —, a running seed step too (a `shell` step's process
  group: SIGTERM, SIGKILL 2 s later; an `exec` step's processes inside its container), and exits with `130`; a second
  Ctrl-C kills them at once.

**What two takes share.** A reset makes the data the seed builds equal for every take — rows, ids and sequences, the
mailbox. It does not make equal what the app writes while it is filmed: a server-side timestamp (`created_at`) is the
time of the take, a random token differs. The fixture's demo clock restarts at every reset, so its "requested
Today, 10:24" is the same in every take that requests its quote within the minute; a real app's server clock is its
own business — `--sandbox` never sets the browser clock (`clock:` stays explicit: a pinned browser clock next to real
server timestamps shows "created in 3 weeks").

**The process provider** (`provider: process`) starts each service as a program of its own process group, detached
(it outlives the command), in `cwd` (default the folder of sandbox.yaml):

- **Command**: argv, where a first word `node` runs Retake's own Node (a folder's Node version manager could
  otherwise pick another version), or a string run with `sh -c` (looked up on `PATH`).
- **Environment**: Retake's own, without the package manager's and test runner's variables (`npm_*`, `PNPM_*`,
  `VITEST*`, `NODE_ENV`, `NODE_OPTIONS`, `INIT_CWD`, `TEST` — set them in `env:` when the service needs them), plus
  `env:` (templated: `{{env:VAR}}`, `{{keychain:…}}`, page keys, vars) and `RETAKE_SANDBOX=<env>`. When a job of
  the Studio, the desktop app or an MCP client starts the sandbox, a service inherits only the shell's own variables
  of Retake's environment (`PATH`, `HOME`, `USER`, the locale, `TZ`, proxy and certificate settings) and the names of
  project.yaml `pass_env:` (see [Workspace](workspace.md)): write what it needs in `env:`. A `shell`
  command on the sandbox's environment — its seed steps, and the shell hooks of scenarios run there — gets the same
  `env:` of every process service and `RETAKE_SANDBOX` on top of Retake's own environment (its own `env:`
  wins): a seed's `npm run db:reset` reaches the sandbox's `DATABASE_URL`, never the one your shell or a `.env` file
  points at. A variable the services do not set comes from Retake's environment as usual.
- **Logs**: `.retake/sandbox/<env>/logs/<service>.log` (git-ignored), the previous start's kept as `.log.1`, cut
  at 20 MB before a take (a sandbox may stay up for days). A service that exits while it starts fails `up` at once
  with its exit code and the last 20 lines of its log.
- **Health**: the service's `health` (default a `GET` of its `url`: 200–399; or `{path|url, status, text,
  timeout_s, interval_ms}`, or `{tcp: port}`; `false`: none), then every page it serves must answer HTTP (any status:
  a sign-in redirect is fine; `health: false` keeps this). 60 s by default; every `run --sandbox` checks it again.
  Errors name the check, its last failure and the number of tries: `sandbox sandbox: service fixture is not healthy
  after 60 s — GET
  http://localhost:4501/api/health: connection refused (238 tries) — last lines of …/fixture.log: …`.
- **Ports**: before a service starts, every port of its `url`, `pages` and `health` must be free — `port 4501
  (service fixture, url) is in use by another program (node, pid 81234) — stop it or change the port in
  sandbox.yaml` (lsof names it) —, and once it is healthy its own processes must listen on each of them (it waits for
  that until the health timeout: a service binds a port when it is ready; `nothing listens on port 4702 (service web,
  url) after 60 s` otherwise) and no other program may: another one would answer part of the traffic, health checks
  included. The mailbox's and the databases' ports are checked by the reset (only what the sandbox owns, above).
- **Identity**: a service is its pid, its start time and the machine's boot time (`state.json` next to the logs; it
  is written as soon as the process exists, before anything is awaited), so a pid the system gave to another program
  is never signalled, and after a reboot nothing recorded is ours. A service whose first process exited while its
  children run (a dev server's wrapper) is still running when one of those children is a process recorded in its
  group once it was healthy (each `up` records them again): a group of that id with none of them may be another
  program's after a pid reuse, and is left alone (`down` says nothing ran; its ports, if held, are named).
- **Stop** (`down`, a restart): `SIGTERM` to the whole group, `SIGKILL` after `stop_timeout_s` (default 10), then the
  processes it started outside its group (a browser launched detached, as Playwright does) are stopped too; a port
  still held afterwards is named in a warning. Services sandbox.yaml no longer declares are stopped by the next `up`
  or `down`.
- macOS and Linux only (process groups).

**The fixture's sandbox.** `projects/northfield-fixture/sandbox/sandbox.yaml` (environment `sandbox`) starts the
fixture server on ports of its own — 4501 / 4502 (open console and shop: the health API) and 4503 / 4504 (the
signed-in side: its pages, shown as `console.northfield.example` / `shop.northfield.example`) — so it never meets a
fixture started by hand on 4401–4404. Its seed is the fixture's reset API (seed data, demo clock at 2 Nov 2026 10:24,
mailbox emptied), its mailbox the fixture's Mailpit-compatible API, its accounts the fixture's supplier and buyer
(their invented passwords written in plain: masked in every log). The scenario `sandbox-quote` has no setup or
teardown hook on purpose: the buyer opens the quotes list, requests a quote and opens it — two takes with
`--sandbox` capture the same latest quote and the same `Q-1043 · requested Today, 10:24` even when the sandbox was
used in between; with `--env sandbox` instead (no reset) the reference moves on.

**The docker-compose provider** (`provider: docker-compose`) runs the services of the compose files (`compose.files`,
default `compose.yaml` next to sandbox.yaml) with the `docker` CLI (Docker Desktop, OrbStack or Docker Engine, with
Compose v2.17 or later; `$RETAKE_DOCKER` names another binary). The services of sandbox.yaml are the compose
services that serve pages (their `url`, `pages`, `health`); every other compose service (a database, Mailpit, a
worker) counts too, judged by its own healthcheck.

- **A project of its own**: `compose.project`, else `retake-<project>-<environment>-<8 hex of the folder's path>`
  (two checkouts of a project never share containers or volumes). Every command — `up`, `down`, `status`, `reset`,
  `logs`, an `exec` step, a restart — reads the project's containers first: containers of that name made from another
  folder (another checkout given the same `compose.project`) refuse it, never read, reset or touched. Every call names
  the project, its folder and its files, and runs without the shell's `COMPOSE_*` variables (a `COMPOSE_PROFILES`
  would change what starts). In a job of the Studio, the desktop app or an MCP client, `docker` gets only the shell's
  own variables, docker's connection settings by name (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`,
  `DOCKER_CERT_PATH`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM`,
  `DOCKER_BUILDKIT`, `BUILDKIT_PROGRESS`; never another `DOCKER_*`, such as a registry password) and the names of
  project.yaml `pass_env:`: a `${VAR}` of the compose file that your shell sets reaches it only through `pass_env:`
  (or the env file below). There, the `docker` binary itself (`$RETAKE_DOCKER`, or the one found on `PATH`) may not
  be a relative path or lie inside the workspace: the job fails before it starts, saying to move it.
- **A renamed `compose.project`**: the name an earlier `up` used stays in the state until nothing of it is left. While
  its containers run, `up` refuses (`compose project … — the name an earlier up of this sandbox used (compose.project
  changed since) — is still running: retake sandbox down …`); `status` says what it left (containers, volumes);
  `down` takes it down too, from its folder, and `down --volumes` removes its volumes — only then is it forgotten.
- **`up`**: no container of another compose project (or none of compose) may publish a port the compose files
  publish, on any address (`docker ps --filter publish=<port>`: OrbStack lets a container publish `[::1]:4601` or
  `[::]:4601` next to the sandbox's `127.0.0.1:4601`, and `localhost` reaches `::1` first — `port 4601 (service db,
  published) is also published by container other-db-1 of compose project other (on [::])`); every port the compose
  files publish must be free — any listener refuses it, named (`port 4601 (service db, published) is in use by another
  program (postgres, pid 812)`): Docker on macOS lets a container publish a port another program holds, and that
  program then answers part of the traffic — except those this project's running containers hold; every port of
  sandbox.yaml's services must be one the compose files publish. Then `docker compose up
  -d --wait --wait-timeout <s> --remove-orphans` (`<s>`: the longest `health.timeout_s` of sandbox.yaml, default 120;
  its output in `.retake/sandbox/<env>/logs/compose-up.log`, and on the terminal with `--verbose`). Its exit code
  is not trusted (`--wait` can exit 0 when it times out): every container must then run, healthy or without a
  healthcheck, or `up` fails with each one's state and the last 30 lines of its logs (`db: running, health starting
  (not healthy yet)`). Then the container runtime alone must listen on the published ports and no other project's
  container may publish them (checked again: one may have started meanwhile), every service of sandbox.yaml must pass
  its health check (120 s by default; a `{tcp: …}` check is refused here: a published port always accepts a
  connection), and the server of every Postgres database of `databases` must answer `SELECT 1` on it (a database that
  does not exist yet — the seed creates it, or an interrupted restore dropped it — or that is closed to connections
  counts: its server answers, and the reset repairs it). pg is given the host and port explicitly, never the URL.
- **The address Docker publishes on**: the health checks, pg (`SELECT 1`, the snapshot), the seed's `sql` steps and
  the mailbox's emptying connect to the address a port is published on — `127.0.0.1` (or `::1` for an IPv6-only
  publish) — instead of resolving a host name such as `localhost` (an address written in the URL is used as it is);
  an http check keeps its URL and `Host` header. What the take itself
  opens — the browser's pages, `wait_for_email`, an `http` seed step — connects where its URL says: the checks above
  run right before every take (`run --sandbox` goes through `up`).
- **`exec` seed steps** run a command inside a running service (`docker compose exec -T`): a string with `sh -c`, or
  argv; `env` values are passed through docker's environment, never its command line; `timeout_s` (default 300); the
  output goes to `logs/seed.log`, secrets masked (the values it resolved, the sandbox's plain passwords). The hosts its
  rendered command and `env` name are checked like a shell hook's: a service of the compose files, localhost, a page
  or `allow_hosts` host — never a host of a production or read-only environment (a host computed inside the container
  is not seen). Every process it starts carries `RETAKE_EXEC=<token>`: Ctrl-C or the timeout stops them inside
  the container too (SIGTERM, SIGKILL 3 s later, through `sh` and `/proc`; an image without them gets a warning naming
  `docker compose restart <service>`), and Ctrl-C stays an interrupt (exit 130). Migrations and an application's own
  seed belong here: a one-shot container in the compose file fails `up --wait` when it exits.
- **`status`** shows every compose service with its container, docker's status and its health; **`logs`** reads
  `docker compose logs --tail` per service (`--follow` keeps reading until Ctrl-C); **`down`** is `docker compose down
  --remove-orphans`, plus `--volumes` when asked, never `--rmi`.
- A failed or interrupted `up` (or take) stops the containers that command started (`docker compose stop`: their
  logs stay readable); a second Ctrl-C kills them.
- Tips for the compose file: publish on `127.0.0.1` (`"127.0.0.1:4600:8080"`); give every service a healthcheck that
  checks `127.0.0.1` (small images resolve `localhost` to `::1` first); for Postgres, `pg_isready -h 127.0.0.1` (without
  `-h` it says ready while the init scripts still run); `init: true` for a program that runs as PID 1 and ignores
  SIGTERM; a `logging: {options: {max-size: 10m}}` (docker's default log never rotates).

### `retake sandbox init`

```sh
retake sandbox init my-product                 # sandbox/ + `sandboxes: {sandbox: sandbox/sandbox.yaml}` in project.yaml
retake sandbox init my-product --env demo      # another one: sandbox/demo/, its own ports
retake sandbox up my-product                   # it comes up as written: a placeholder page, seeded, snapshot taken
```

It writes a docker-compose sandbox that validates and comes up as it is: `sandbox.yaml` (strategy `snapshot`, the
page `app`, a sql seed step, the database and the mailbox), `compose.yaml` (`app`: a placeholder page served by busybox
`httpd`; `db`: `postgres:17-alpine` with a named volume and a `pg_isready -h 127.0.0.1` healthcheck; `mailpit`:
`axllent/mailpit` pinned to an exact version, its version check off), `seed/01-demo-data.sql` (an invented table),
`app/index.html` and a `README.md` saying how to put the application in it (its `build:` or `image:`, the database
and SMTP settings, migrations and seed as `exec` steps, accounts, `reset.restart`). Ports are picked free from 4600
upward, skipping the ports of the project's environments and other sandboxes, all published on 127.0.0.1; the demo
database password is `pg-sandbox-<port>` (a one-word password would be masked wherever that word appears in the logs).
project.yaml gets its `sandboxes:` entry as a text edit — nothing else of the file changes: appended (before a `...`
document end), after the last entry of a block `sandboxes:`, or inside a one-line `sandboxes: {…}`; its line endings
are kept (a flow mapping over several lines goes through the YAML library, comments kept, lines never folded). A file
the scaffold would write that already exists (`sandbox.yaml`, `compose.yaml`, `README.md`, `seed/…`, `app/…`) stops
it, named, before anything is written; `--force` writes the scaffold over them (project.yaml is left as it is);
`--json` prints the files and ports.

### Snapshot reset (Postgres)

With `reset: {strategy: snapshot}` (docker-compose only), the sandbox's database (`reset.snapshot.database`, a key of
`databases`, default the first) is copied as a template database `<db>__ds_snapshot` right after the seed, and every
reset drops the database and creates it again from that copy — a file-level copy inside Postgres, with no `pg_dump`
on this machine:

```sql
-- after the seed (take)
ALTER DATABASE "app" WITH ALLOW_CONNECTIONS false;            -- the app's pool cannot reconnect during the copy
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app' AND pid <> pg_backend_pid();
ALTER DATABASE "app__ds_snapshot" WITH IS_TEMPLATE false;     -- a retake only, when it exists
DROP DATABASE IF EXISTS "app__ds_snapshot" WITH (FORCE);
CREATE DATABASE "app__ds_snapshot" TEMPLATE "app";            -- STRATEGY left to the server (WAL_LOG from 15)
ALTER DATABASE "app" WITH ALLOW_CONNECTIONS true;
ALTER DATABASE "app__ds_snapshot" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true;
COMMENT ON DATABASE "app__ds_snapshot" IS 'retake snapshot <seed hash>';
-- before every take (restore)
ALTER DATABASE "app" WITH ALLOW_CONNECTIONS false;
DROP DATABASE IF EXISTS "app" WITH (FORCE);                   -- its sessions are terminated
CREATE DATABASE "app" TEMPLATE "app__ds_snapshot" OWNER "<owner at the take>";
```

- **Only the sandbox's own database**: the database's port must be published by a running service of the sandbox's
  compose project, made from its folder, nothing else may listen on it and no other project's container may publish
  it — a `localhost:5432` that is another stack's Postgres is refused; pg connects to the address the port is
  published on (`127.0.0.1`), never to `localhost`. Postgres 13 or later (`DROP DATABASE … WITH (FORCE)`). The role of the URL needs to drop and create
  databases and terminate the app's sessions: the compose image's `POSTGRES_USER` (a superuser) can.
- **When the snapshot is stale** it is taken again, after the seed: the seed hash (seed steps, the files they read,
  `seed/`, the images of the compose services — `up --build` with new migrations makes it stale) differs from the one
  in the state file or in the template's comment, the template is gone (`down --volumes`), or `reset --reseed` asks.
  After a change the hash cannot see (a script outside `seed/`, data an `exec` step fetches), run `retake sandbox
  reset <project> --reseed`.
- **Robust to interruptions**: every reset first lets connections in again when an interrupted reset left them
  blocked, recreates the database when an interrupted restore dropped it, and nothing between `DROP` and `CREATE`
  stops for Ctrl-C; `up` resets a sandbox whose database an interrupted reset left missing or closed, even when its
  seed is current.
- **What a restore keeps**: rows, sequences, indexes, extensions, large objects. Not copied: `ALTER DATABASE … SET`
  settings (set them in the compose file's `command` or per role) and the database's comment.
- **The app's connections**: the restore terminates them. Many pools reconnect on the next query (node-postgres,
  Rails 7.1+); others fail the first query after a restore (older Rails, a connection held open). An idle
  node-postgres client emits an `'error'` on its `Pool` — without a handler the process crashes —, and a client held
  in an open transaction stays broken. If the first page of a take fails, add
  `reset: {restart: [app]}` (the app restarts after every reset) and make its health path read the database.
- **Seeds start from a clean state**: a seed runs on the database as it is (after a take, with its changes), so it
  drops or truncates what it creates (the scaffold's drops its table first). A plain `pg_dump` file (`COPY … FROM
  stdin`, `\connect`) is refused by sql steps: dump with `pg_dump --inserts`, or load it with an `exec` step (`exec:
  {service: db, command: "psql -v ON_ERROR_STOP=1 -U demo -d app -f /seed/dump.sql"}`, the file mounted in the db
  service).
- **How fast** (Postgres 17 in OrbStack on an Apple M4, measured with the init scaffold): the scaffold's 5-row seed
  takes 20–30 ms to run and its snapshot restores in 40–300 ms, so `reseed` is as fast there. With a realistic seed —
  600 000 rows and two indexes, a 114 MB database — the seed takes 1.3–1.9 s (`reseed`: a 1.5–2.1 s reset) and the
  snapshot restores in 230–300 ms (the first one after a take ≈ 0.7 s): a 0.5–0.6 s reset, docker checks included.
  The take after the seed costs 0.45–0.75 s. `retake sandbox reset` prints both times.

### The fixture's Docker sandbox (Mailpit)

`projects/northfield-fixture/sandbox/docker/` (environment `sandbox-docker`, provider docker-compose) is the same
sandbox in Docker, the example of a docker-compose sandbox that runs a real product: the fixture server in a
container built from `fixtures/wholesale/Dockerfile`, and **Mailpit** (`axllent/mailpit:v1.29.4`) receiving its mails
over SMTP. Same pages (signed-in side), seed (`POST {{console}}/api/reset`) and accounts as `sandbox`; ports 4511–4514
for the fixture (the same numbers inside the container, so the links in its mails stay right) and 4525 for Mailpit —
its API is the sandbox's mailbox, and http://localhost:4525 shows what the fixture sent.

```sh
node fixtures/wholesale/build.mjs        # the UI bundle the image copies (again after a UI change, then up --build)
retake sandbox up northfield-fixture --env sandbox-docker       # builds the image the first time, starts, seeds
retake run northfield-fixture sandbox-quote --env sandbox-docker --sandbox
retake run northfield-fixture signup --env sandbox-docker --sandbox    # wait_for_email reads the real Mailpit
retake sandbox down northfield-fixture --env sandbox-docker
docker image rm $(docker images -q --filter 'reference=retake-northfield-fixture-*')   # the image (down keeps it)
```

- **The image**: `node:22-alpine` (≈ 160 MB, pulled once) plus the server and the bundle (≈ 4 MB): no `npm install` —
  the server needs no npm package at run time (esbuild is loaded only to build the bundle, playwright-core only to
  print a PDF) — and the build context is `fixtures/wholesale` with a `.dockerignore` that keeps only what the server
  reads. A missing bundle stops the build with the command to run. It runs as `node` (not root), on every interface
  of the container, with a `HEALTHCHECK` on `http://127.0.0.1:<console port>/api/health`; the compose file adds
  `init: true` and publishes every port on 127.0.0.1. No `image:` in the compose file: the image is named after the
  compose project (`retake-northfield-fixture-sandbox-docker-<hash>-fixture`).
- **No Chromium in the image**: the quote PDF (`/quotes/<id>/quote.pdf`) answers 500 there. `sandbox-quote` and
  `signup` do not open it; film `quote` (its "Download quote PDF") on the process sandbox or on `local`.
- **Mail**: with `NORTHFIELD_SMTP=mailpit:1025` the fixture delivers every mail it sends to Mailpit too (a small SMTP
  client on `node:net`, fixtures/wholesale/README.md), next to its own Mailpit-compatible mailbox. Each reset empties
  Mailpit (`DELETE /api/v1/messages`) and the fixture's mailbox (its reset API).
- Measured on this Mac (OrbStack): the first `up` 8.5–12 s with the image build, a reset 100–150 ms; two takes of
  `sandbox-quote` with a quote and a sign-up made between them captured the same `Q-1042` and `Q-1043 · requested
  Today, 10:24`; `signup`'s confirmation mail came from the real Mailpit in 0.5 s, its inline logo included.

### Recipes

```yaml
# A dev server on this machine (process): a string runs with sh -c and PATH (argv [node, …] runs Retake's Node).
# Its database is one of its own (a Postgres you run for the sandbox alone, on 4702) — never your development one.
services:
  web:
    command: "npm run dev -- --port 4701"
    cwd: ../..
    env: {DATABASE_URL: "postgres://demo:sandbox-db-4702@localhost:4702/app"}
    url: http://localhost:4701
    health: {path: /api/health, timeout_s: 120}     # a path that reads the database
    pages: {app: {url: http://localhost:4701, display: app.example.com}}
seed:
  # Gets web's DATABASE_URL (and RETAKE_SANDBOX), not the one of your shell or .env: it resets the sandbox's data.
  - shell: {run: "npm run db:reset && npm run db:seed", cwd: ../..}
databases:                    # for sql steps and scenario sql hooks: that Postgres is not started by the sandbox
  main: {url: "postgres://demo:sandbox-db-4702@localhost:4702/app", external: true}
```

```yaml
# An application in compose (docker-compose): migrations and its own seed inside its container, then a snapshot.
seed:
  - exec: {service: app, command: "bin/rails db:prepare db:seed", timeout_s: 600}
  - exec: {service: redis, command: [redis-cli, FLUSHALL]}   # state outside Postgres: emptied by the seed
reset:
  strategy: snapshot
  restart: [app]              # a service of sandbox.yaml: its pool starts fresh after each restore
```

- **Mail**: point the app's SMTP settings at `mailpit:1025` inside the compose network and declare `mailbox:
  {provider: mailpit, url: http://localhost:<published 8025>}`; `wait_for_email` then reads it, and every reset empties
  it.
- **Two takes at the same time**: a second sandbox (`retake sandbox init <project> --env demo-2`, its own ports and
  compose project).
- **A sign-in that survives the reset**: none — a reset drops the sessions the app stored, so the accounts sign in
  again off camera before every take (`accounts`, above).

### A "stage" sandbox: images of a production build

A product shipped as images (a registry's builds) is filmed from the same build every take with a docker-compose
sandbox whose versions and settings live in a `.env` next to its compose file — the stage of the product, on this
machine, with demo data:

```yaml
# sandbox/stage/compose.yaml — the product's images, published on 127.0.0.1 only
services:
  app:
    image: registry.example.com/acme/app:${APP_VERSION}
    environment: {DATABASE_URL: "postgres://demo:stage-db-4932@db:5432/app", SMTP_URL: "smtp://mailpit:1025", FEATURE_FLAGS: "${FEATURE_FLAGS}"}
    ports: ["127.0.0.1:4901:3000"]
    depends_on: [db]
  worker:
    image: registry.example.com/acme/worker:${APP_VERSION}
    environment: {DATABASE_URL: "postgres://demo:stage-db-4932@db:5432/app"}
  db:
    image: postgres:${POSTGRES_VERSION}
    environment: {POSTGRES_USER: demo, POSTGRES_PASSWORD: stage-db-4932, POSTGRES_DB: app}
    ports: ["127.0.0.1:4932:5432"]
  mailpit:
    image: axllent/mailpit:v1.29.4
    ports: ["127.0.0.1:4925:8025"]
```

```sh
# sandbox/stage/.env — what docker compose reads for the ${…} above
APP_VERSION=2.14.0
POSTGRES_VERSION=17-alpine
FEATURE_FLAGS=new-invoices
```

```yaml
# sandbox/stage/sandbox.yaml
version: 1
provider: docker-compose
services:
  app: {url: http://localhost:4901, health: /up, pages: {app: {url: http://localhost:4901, display: app.example.com}}}
  mailpit: {url: http://localhost:4925, health: /api/v1/info}
seed:
  - exec: {service: app, command: "bin/setup-demo-data", timeout_s: 600}
reset: {strategy: snapshot, restart: [app, worker]}
databases:
  main: {url: "postgres://demo:stage-db-4932@localhost:4932/app"}
mailbox: {provider: mailpit, url: http://localhost:4925}
```

- **The env file reaches every compose command** (`--env-file`): `.env` next to the first compose file, or
  `compose.env_file` (relative to sandbox.yaml; `false`: none). It is the file docker compose interpolates `${…}`
  from; a service's own `env_file: .env` is a path of the compose file, resolved next to it. The names it sets are left out of the environment
  docker runs with, like every `COMPOSE_*` variable of the shell: an `APP_VERSION` exported in your shell never
  changes the build a take films. A `COMPOSE_PROFILES` in it is refused (it would start other services than
  sandbox.yaml says). Checked against the real `docker compose config`: the file's tag wins over the shell's
  (`packages/sandbox/test/compose-env.test.ts`).
- **Another version** is another product: the env file's hash is part of the seed's inputs (with the images' ids), so
  the next `up` seeds again and a snapshot taken with the previous one is stale.
- `retake sandbox up <project> --env stage` pulls the images the first time (`docker login` to a private registry
  first, in your terminal); `retake run <project> <scenario> --env stage --sandbox` resets it before each take.

### Limits

- **Determinism.** A reset makes equal what the seed builds; not what the app does while it is filmed or between the
  reset and the take:
  - server-side timestamps (`created_at = now()`) are the time of the take — the fixture's demo clock restarts at each
    reset, a real app's clock does not;
  - UUIDs and random tokens differ between takes (it matters only when one is on screen);
  - state outside the reset database — Redis, a search index, uploaded files in a volume, an in-memory cache — stays
    as the last take left it unless a seed step or `reset.restart` clears it; background workers may act between the
    reset and the capture;
  - the first request after a snapshot restore may fail on a pooled connection the restore cut (`reset.restart`, a
    health path that reads the database).
- **No implied clock.** `--sandbox` never sets the browser clock: `clock:` stays explicit (project or scenario). A
  pinned browser clock next to real server timestamps shows "created in 3 weeks"; giving the server a clock is the
  app's business (BACKLOG BL-68: the project clock passed to the sandbox's services).
- **Local only**: every sandbox URL is loopback; a sandbox never runs on another machine (BACKLOG BL-69: remote and
  CI sandboxes).
- **What a take connects to** (docker-compose): the browser's pages, `wait_for_email` and `http` seed steps use their
  URL as written (`localhost` reaches `::1` first). The checks that no other container publishes the sandbox's ports
  run right before every take; one started during the take is not noticed — keep a sandbox's ports apart from other
  stacks' and publish them on `127.0.0.1` (BACKLOG BL-69: pinning those too).
- **Snapshots**: Postgres only, in the sandbox's own compose project; MySQL, SQLite and external databases use
  `reseed` (BACKLOG BL-67).
- **Process provider**: macOS and Linux; a program that leaves the service's process tree (a daemon re-parented to
  init) can keep running after `down` — a warning names whoever still holds the service's ports.
- **Disk**: `down` never removes images, and builds leave Docker's build cache; `docker image rm` and the usual Docker
  tools reclaim them.
