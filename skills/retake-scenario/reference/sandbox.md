# Sandboxes, in short

A sandbox is a disposable, local copy of the product that Retake starts, seeds with demo data and resets before
every take, so two takes show the same data. It is declared by a `sandbox.yaml` the **user** writes (`retake sandbox
init <project>` in their terminal scaffolds one, and adds `sandboxes: {sandbox: sandbox/sandbox.yaml}` to project.yaml);
the sandbox then is an environment of its own. Propose it when a project films a local copy of the product with a
database or a mailbox: `project_get` says so (and so does `retake doctor --project <slug>`, which the user runs in
their own terminal).

Then: `sandbox_up {project}` (or nothing: `run_capture {project, scenario, env: "sandbox", sandbox: true}` starts it if
needed, checks its health and resets it before the take). `sandbox_reset` resets it between two dry runs. Shell seed
steps are approved by the user like hooks. Every URL of a sandbox is on this machine.

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
databases:
  main: {url: "postgres://demo:sandbox-db-4832@localhost:4832/app"}
mailbox: {provider: mailpit, url: "http://localhost:4825"}
```

The `.env` next to compose.yaml (or another file named in sandbox.yaml's `compose:`) holds the image versions and
settings, such as `APP_VERSION=2.14.0` for the tag of the compose file's `image:` line. A value the shell sets for the
same name is ignored there: the file wins, so every take films the same build. `docs/guide/sandbox.md` of the Retake repository has the whole
format, and a "stage" sandbox for a product shipped as images.
