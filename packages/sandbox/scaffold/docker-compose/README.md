# Sandbox __ENV__

A disposable, local copy of the product for Demo Studio: `studio sandbox init` wrote this folder. Demo Studio starts it
with `docker compose`, seeds it with demo data, takes a snapshot of the seeded database, and restores that snapshot
before every take — so two takes of a scenario show the same data.

| File | What it is |
|---|---|
| `sandbox.yaml` | the manifest: services and pages, seed, reset strategy, database, mailbox, demo accounts |
| `compose.yaml` | the services: `app` (a placeholder page), `db` (Postgres 17), `mailpit` (catches the app's mail) |
| `seed/01-demo-data.sql` | the demo data (an example table) |
| `app/index.html` | the placeholder page `app` serves |

Ports (all on 127.0.0.1): app __APP_PORT__, Postgres __DB_PORT__, Mailpit __MAIL_PORT__ (web UI and API).

## Try it as it is

```sh
studio sandbox up __PROJECT____ENV_FLAG__        # compose up, health, seed, snapshot
studio sandbox status __PROJECT____ENV_FLAG__    # services, pages, seed, last reset
studio sandbox reset __PROJECT____ENV_FLAG__     # restore the snapshot (the time it took is printed)
studio sandbox logs __PROJECT____ENV_FLAG__      # each service's last log lines (--follow to keep reading)
studio sandbox down __PROJECT____ENV_FLAG__      # stop (--volumes also removes the database and its snapshot)
```

## Put your application in it

1. **The app service.** In `compose.yaml`, replace the placeholder's `image`, `command` and `volumes` with your
   application: `build: ../..` (a Dockerfile in your repository) or `image: …`. Keep `ports:
   ["127.0.0.1:__APP_PORT__:<the port your app listens on>"]` and a `healthcheck` (use `127.0.0.1`, not `localhost`).
   Give it the database and the SMTP server in the names it reads: `postgres://demo:__DB_PASSWORD__@db:5432/app` and
   `mailpit:1025`. Other services it needs (Redis, a worker) go next to it.
2. **Its pages.** In `sandbox.yaml`, `services.app.pages` maps the page keys scenarios use (`{{app}}`, `page: app`) to
   their URLs on this machine; `{url, display}` shows another URL in the video. `health` should be a path that reads
   the database, so a reset is not over before the app can serve the take.
3. **Its migrations and seed.** Run them as `exec` steps of `seed` (inside the app's container, after `up`):
   `- exec: {service: app, command: "bin/rails db:prepare db:seed"}`. Replace or remove `seed/01-demo-data.sql`.
   A one-shot migration container in `compose.yaml` does not work: `up --wait` fails when a container exits.
4. **Demo accounts.** Uncomment `login_url` and `accounts` in `sandbox.yaml`: each account is a persona of this
   environment, signed in off camera by its `login` steps before a take.
5. **After a reset.** The snapshot reset drops and recreates the database: the app's pooled connections are cut.
   Pools that reconnect on the next query (many do) are fine; if the first page of a take fails, uncomment
   `reset.restart: [app]` (the app restarts after each reset). A node-postgres `Pool` needs an `'error'` handler, or
   the idle connection the reset kills crashes the process.

The snapshot is taken again by itself when the seed changes (its steps, `seed/`, the images of the services). After
changes it cannot see (a script elsewhere), run `studio sandbox reset __PROJECT____ENV_FLAG__ --reseed`. Rebuild the app with
`studio sandbox up __PROJECT____ENV_FLAG__ --build`.
