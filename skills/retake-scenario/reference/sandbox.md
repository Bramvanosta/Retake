# Sandboxes, in short

A sandbox is a disposable, local copy of the product that Retake starts, seeds with demo data and resets before
every take, so two takes show the same data. It is declared by a `sandbox.yaml` the **user** fills in: `sandbox_init
{project}` (with their go-ahead) or `retake sandbox init <project>` in their terminal writes Retake's docker-compose
scaffold and adds `sandboxes: {sandbox: sandbox/sandbox.yaml}` to project.yaml — never over a file. Its compose.yaml
and sandbox.yaml are then the user's: propose their text in chat and let the user write them (what they name runs on
this machine). The sandbox is an environment of its own. Propose it when a project films a local copy of the product with a
database or a mailbox: `project_get` says so (and so does `retake doctor --project <slug>`, which the user runs in
their own terminal).

Then: `sandbox_up {project}` (it pulls the compose file's images the first time: ask the user; or nothing:
`run_capture {project, scenario, env: "sandbox", sandbox: true}` starts it if needed, checks its health and resets it
before the take). `sandbox_reset` resets it between two dry runs. Shell seed steps are approved by the user like
hooks. Every URL of a sandbox is on this machine.

**When sandbox.yaml or an image changes** (a seed step, a rebuilt image, `reset.firebase_auth` added), the snapshot is
outdated: the next reset restores the base — the database as it was before its first seed — and seeds again, never
on what a take left. A sandbox snapshotted before it kept a base seeds from its outdated snapshot and says how to get
one (`retake sandbox down … --volumes`, then `up`: the user's, in their terminal; it deletes every volume of the
sandbox). `sandbox_status` says what the next reset does. A database in memory (`tmpfs:`), in its container's own
layer or in an anonymous volume loses its data at every `down`: Retake forgets its seed, and a new Postgres cluster
there is seeded again by the next reset. When it cannot tell, the user runs `retake sandbox down … --volumes --forget`.

## The product's own dev server (provider `process`)

```yaml
# sandbox/sandbox.yaml — every path relative to this file
version: 1
provider: process
services:
  web:
    command: "npm run dev -- --port 4701"      # its own port: never the one the developer works on
    cwd: ../..
    env: {DATABASE_URL: "postgres://demo:sandbox-db-4702@localhost:4702/app"}   # a database of its own
    url: http://localhost:4701
    health: {path: /api/health, timeout_s: 120}
    pages: {app: {url: "http://localhost:4701", display: app.example.com}}
seed:
  - shell: {run: "npm run db:reset && npm run db:seed", cwd: ../..}   # gets web's DATABASE_URL, never the shell's
databases:
  main: {url: "postgres://demo:sandbox-db-4702@localhost:4702/app", external: true}
mailbox: {provider: mailpit, url: "http://localhost:4725"}              # emptied at every reset
login_url: /sign-in
accounts:                                     # demo accounts the seed creates: the environment's personas
  admin:
    pages: [app]
    username: admin@example.com
    password: demo-admin-4701
    login:
      - open: "app:/sign-in"
      - type: {into: {label: Email}, text: "{{account.username}}"}
      - type: {into: {label: Password}, text: "{{account.password}}"}
      - click: {role: button, name: Sign in}
```

## Images in compose (provider `docker-compose`)

```yaml
# sandbox/sandbox.yaml, next to its compose.yaml and the .env its variables come from
version: 1
provider: docker-compose
services:                                     # services of compose.yaml (published on 127.0.0.1)
  app:
    url: http://localhost:4801
    health: /up
    pages: {app: {url: "http://localhost:4801", display: app.example.com}}
  mailpit: {url: "http://localhost:4825", health: /api/v1/info}
seed:
  - exec: {service: app, command: "bin/rails db:prepare db:seed", timeout_s: 600}
reset:
  strategy: snapshot                          # a Postgres snapshot taken after the seed, restored in ≈ 0.3 s
  restart: [app]
  # firebase_auth: {url: "http://localhost:9099", project: demo-app}   # an Auth emulator: its accounts put back too
  # hooks: [{http: {method: POST, url: "{{app}}/api/test/reset-cache"}}]  # run at every reset, after the data is back
databases:
  main: {url: "postgres://demo:sandbox-db-4832@localhost:4832/app"}
mailbox: {provider: mailpit, url: "http://localhost:4825"}
```

**The snapshot covers the Postgres database only.** A service that keeps its own state (a Firebase Auth emulator
holds its accounts in memory) does not go back with it: the account a take created is still there at the next take,
and restarting the service loses the seeded ones too. For the Auth emulator, `reset.firebase_auth` puts its accounts
back as the seed left them; for anything else, `reset.hooks` run at every reset, once the data is back. Rather than a
setup hook that deletes the account in each scenario, propose these to the person (sandbox.yaml is theirs).

The `.env` next to compose.yaml (or another file named in sandbox.yaml's `compose:`) holds the image versions and
settings, such as `APP_VERSION=2.14.0` for the tag of the compose file's `image:` line. A value the shell sets for the
same name is ignored there: the file wins, so every take films the same build. The compose files may live in
the product's repository (`compose.files` relative to sandbox.yaml): their own relative paths resolve next to them.
The hooks the person writes for a sandbox (in project.yaml, in sandbox.yaml) may read its accounts and its compose
env file; a scenario you write never does. An http hook acts as an account with `auth: {persona: admin}`: the
account's saved session (its cookies, and the sign-in token of an app on Firebase) goes with the request. Not in a
seed step: nobody is signed in yet.
One app with several roles: each account may list the same page (`pages: [admin]`); the first one declared is the
page's default and a scene films another with `persona: <account>`. One video showing both: a multi-page scene with a
page id per account (`pages: {theirs: {page: admin}, ours: {page: admin, persona: staff}}`). `docs/guide/sandbox.md` of the Retake repository has the whole
format, and a "stage" sandbox for a product shipped as images.

## A monorepo without app images, a hybrid, an external sign-in

- **Apps without images** (recommended): each app a compose service on a stock runtime image (an exact Node tag) with
  the repository mounted, a named volume over its packages (the host's macOS binaries do not run in Linux) and a
  command that installs then starts the app on every interface, beside the infrastructure's images in the same
  compose file: one compose project, so `strategy: snapshot` works.
- **Apps on the host, infra in Docker**: provider `process`, the infra one more service whose `command` is `docker
  compose -p retake-<name>-infra -f infra.yaml up` (attached: `sandbox down` stops it), with no `url` / `health` of its
  own (Docker holds those ports, a process service must own its ports), the app's health path reading the database,
  `databases.<key>.external: true`, strategy `reseed` only.
- **Sign-in**: the provider's emulator as a service (Firebase Auth emulator + `reset.firebase_auth`, the apps pointed
  at it) or the product's local sign-in mode — never a hosted tenant. With `firebase_auth`, every reset signs the
  personas out: each take signs them in again with their `login` steps (an account without them is refused).

`docs/guide/sandbox.md` › Recipes has each one in full; propose the files' text to the user, who writes them.
