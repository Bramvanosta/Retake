/**
 * Sandbox mode (L1.8), the core model: sandbox.yaml (version 1) — schema and positioned checks (provider keys, paths
 * relative to the manifest, loopback-only URLs, pages, seed steps, reset strategy, accounts and their {{account.*}}
 * tokens, weak plain passwords) — and the project merge: project.yaml `sandboxes:` → one environment per sandbox
 * (pages, display URLs, personas from its accounts, mailbox, databases), helpers mailboxFor / databasesFor, the seed
 * hash. Projects without sandboxes load exactly as before.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  SandboxConfigError,
  allowedHosts,
  applyProjectDefaults,
  databasesFor,
  formatIssues,
  isHostAllowed,
  isLoopbackHost,
  loadProject,
  mailboxFor,
  parseProjectYaml,
  parseSandboxYaml,
  parseScenario,
  resolveEnvironment,
  resolvePersonas,
  sandboxNames,
  sandboxOf,
  seedFileRefs,
  seedHash,
  unmaskedPasswordReason,
  weakPasswordReason,
} from '@retake/core';
import type { ValidationIssue } from '@retake/core';
import { errors, lineOf, tempDir, warnings, writeFiles } from './helpers.js';

const msgs = (issues: ValidationIssue[]) => issues.map((i) => `${i.severity} ${i.line}:${i.col} ${i.path.join('.')}: ${i.message}`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function temp(): Promise<string> {
  const t = await tempDir('retake-sandbox-');
  cleanups.push(t.cleanup);
  return t.dir;
}

/** The fixture as a process sandbox: the signed-in side on 4503 / 4504, accounts with {{account.*}}. */
const PROCESS = `version: 1
provider: process
services:
  fixture:
    command: [node, server.mjs, --console-port, "4501"]
    cwd: app
    url: http://localhost:4501
    health: /api/health
    env: {NORTHFIELD_SEED: "demo", TOKEN: "{{env:DEMO_TOKEN}}"}
    pages:
      console: {url: http://localhost:4503, display: console.northfield.example}
      shop: {url: http://localhost:4504, display: shop.northfield.example}
seed:
  - name: reset
    http: {method: POST, url: "{{console}}/api/reset"}
  - sql: seed/01-demo.sql
mailbox: {provider: mailpit, url: http://localhost:4501/mailbox}
databases:
  main: {url: "postgres://demo:sandbox-pass-4632@localhost:4632/app"}
login_url: /sign-in
accounts:
  buyer:
    pages: [shop]
    username: orders@demo-cafe.example
    password: cafe-pass-4504
    check: {url: "shop:/", expect_text: Demo Cafe}
    login:
      - open: "shop:/sign-in"
      - type: {into: {label: Email}, text: "{{account.username}}"}
      - type: {into: {label: Password}, text: "{{ account.password }}"}
      - click: {role: button, name: Sign in}
  supplier:
    pages: [console]
    username: maja@northfield.example
    password: "{{env:NORTHFIELD_SUPPLIER_PASSWORD}}"
    check: {url: "console:/", expect_text: Maja}
    login:
      - open: "console:/sign-in"
      - type: {into: {label: Email}, text: "{{account.username}}"}
      - type: {into: {label: Password}, text: "{{account.password}}"}
`;

const COMPOSE_YAML = `services:
  app: {image: busybox:1.38.0}
  db: {image: postgres:17-alpine}
  mailpit: {image: axllent/mailpit:v1.29.4}
`;

/** A docker-compose sandbox with a snapshot reset. */
const COMPOSE = `version: 1
provider: docker-compose
compose: {files: [compose.yaml], project: my-app-sandbox}
services:
  app:
    url: http://localhost:4600
    health: {path: /up, timeout_s: 90}
    pages: {app: {url: http://localhost:4600, display: app.example.com}}
  db: {health: false}
  mailpit: {url: http://localhost:4625, health: /readyz}
seed:
  - sql: {file: seed/01-demo-data.sql, db: main}
  - exec: {service: app, command: "bin/seed --host db"}
reset:
  strategy: snapshot
  snapshot: {database: main}
  restart: [app]
databases:
  main: {url: "postgres://demo:sandbox-db-4632@127.0.0.1:4632/app"}
mailbox: {provider: mailpit, url: http://localhost:4625}
`;

async function sandboxDir(files: Record<string, string>): Promise<string> {
  const dir = await temp();
  await writeFiles(dir, files);
  return dir;
}

describe('sandbox.yaml: schema and checks (R-SBX-01)', () => {
  it('the process and docker-compose examples are valid', async () => {
    const pdir = await sandboxDir({ 'sandbox.yaml': PROCESS, 'app/server.mjs': '', 'seed/01-demo.sql': 'INSERT INTO t VALUES (1);\n' });
    const p = parseSandboxYaml(PROCESS, join(pdir, 'sandbox.yaml'), { env: 'sandbox' });
    expect(msgs(p.issues)).toEqual([]);
    expect(p.manifest?.services.fixture.pages?.console).toEqual({ url: 'http://localhost:4503', display: 'console.northfield.example' });
    const cdir = await sandboxDir({ 'sandbox.yaml': COMPOSE, 'compose.yaml': COMPOSE_YAML, 'seed/01-demo-data.sql': 'CREATE TABLE t (id int);\nDELETE FROM t;\n' });
    const c = parseSandboxYaml(COMPOSE, join(cdir, 'sandbox.yaml'), { env: 'sandbox' });
    // A destructive seed step needs no `confirm: true` (a seed rebuilds a disposable copy).
    expect(msgs(c.issues)).toEqual([]);
    expect(c.manifest?.reset?.strategy).toBe('snapshot');
  });

  it('a newer version is refused before anything else; a missing one is required', () => {
    const v2 = parseSandboxYaml('version: 2\nprovider: kubernetes\nservices: 3\n');
    expect(msgs(v2.issues)).toEqual(['error 1:10 version: this sandbox.yaml is version 2: it was made for a newer Retake (this one reads version 1) — update Retake']);
    const none = parseSandboxYaml('provider: process\nservices: {}\n');
    expect(msgs(none.issues)).toEqual(['error 1:1 version: expected 1, got nothing']);
  });

  it('loopback only: private addresses, names without a dot, *.internal and remote hosts are refused (critique 1)', () => {
    for (const host of ['10.0.0.5', '192.168.1.20', '100.100.1.1', 'prod-db', 'db.corp.internal', 'db.example.com']) {
      const text = `version: 1\nprovider: process\nservices:\n  app:\n    command: x\n    pages: {app: http://localhost:4600}\ndatabases:\n  main: {url: "postgres://u:{{env:PW}}@${host}:5432/app"}\n`;
      expect(msgs(parseSandboxYaml(text).issues), host).toEqual([
        `error 8:15 databases.main.url: database main ${host} is not on this machine: sandbox URLs name localhost, *.localhost, 127.0.0.1 or [::1] only: a sandbox is reset — its databases dropped and recreated — before every take`,
      ]);
    }
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      const text = `version: 1\nprovider: process\nservices:\n  app:\n    command: x\n    url: "http://${host}:4600"\n    pages: {app: "http://${host}:4600"}\nmailbox: {provider: mailpit, url: "http://${host}:4625"}\n`;
      expect(msgs(parseSandboxYaml(text).issues), host).toEqual([]);
    }
    expect(['localhost', 'LOCALHOST.', 'a.b.localhost', '127.0.0.1', '127.255.0.9', '::1', '[::1]'].every(isLoopbackHost)).toBe(true);
    expect(['10.0.0.1', '128.0.0.1', '127.0.0.256', 'devbox', 'localhost.example.com', '::2', '0.0.0.0'].some(isLoopbackHost)).toBe(false);
    const templatedHost = parseSandboxYaml('version: 1\nprovider: process\nservices:\n  app: {command: x, pages: {app: "http://localhost:1"}}\ndatabases:\n  main: {url: "postgres://u:p@{{env:DB_HOST}}/app"}\n');
    expect(msgs(templatedHost.issues)[0]).toContain('databases.main.url: database main: write its host as it is (localhost)');
  });

  it('positioned errors: provider keys, paths, pages, health, seed steps, reset, accounts', async () => {
    const dir = await sandboxDir({ 'compose.yaml': COMPOSE_YAML, 'dump.sql': "COPY public.t (id) FROM stdin;\n1\n\\.\n" });
    const text = `version: 1
provider: docker-compose
compose: {files: [compose.yaml]}
services:
  app:
    command: [node, app.mjs]
    url: http://localhost:4600
    health: {tcp: 4600, text: ok}
    pages:
      app: http://localhost:4600
      vars: http://localhost:4601
  web:
    pages: {app: http://localhost:4602, admin: {url: http://localhost:4603, display: localhost:4603}}
seed:
  - js: "return 1"
  - exec: {service: worker, command: "seed --url https://api.example.com/x"}
  - sql: /home/someone/seed.sql
  - sql: dump.sql
  - shell: {run: ./load.sh, cwd: ~/data, rollback: ./unload.sh}
reset:
  strategy: snapshot
  restart: [ap]
databases:
  main: {url: "postgres://demo:sandbox-db-4632@localhost:4632/postgres"}
accounts:
  admin:
    pages: [app]
    password: "x{{env:PW}}"
    check: {url: "app:/", expect_text: "{{account.username}}"}
    login:
      - type: {into: {label: Email}, text: "{{account.username}}"}
`;
    const { issues } = parseSandboxYaml(text, join(dir, 'sandbox.yaml'), { env: 'sandbox' });
    expect(msgs(errors(issues))).toEqual([
      `error ${lineOf(text, 'command: [node')}:5 services.app.command: \`command\` is for provider process: a docker-compose service is started from its compose file`,
      `error ${lineOf(text, 'health: {tcp')}:14 services.app.health.tcp: a TCP check of a port Docker publishes always succeeds (its proxy accepts the connection): give the compose service a healthcheck, or check an http path`,
      `error ${lineOf(text, 'health: {tcp')}:25 services.app.health.text: \`text\` is for an http health check, not \`tcp\``,
      `error ${lineOf(text, 'vars: http')}:7 services.app.pages: page key "vars" is reserved for templating ({{vars.…}})`,
      `error ${lineOf(text, '  web:')}:3 services: service "web" is not a service of the compose files (they declare: app, db, mailpit)`,
      `error ${lineOf(text, 'pages: {app: http://localhost:4602')}:13 services.web.pages: page "app" is already served by service app: a page key names one page of the environment`,
      `error ${lineOf(text, 'display: localhost:4603')}:86 services.web.pages.admin.display: display "localhost:4603" is a local host: the video would show it — give the public address (e.g. "shop.example.com" or "https://shop.example.com/app")`,
      `error ${lineOf(text, '- js:')}:5 seed.0.js: seed steps run without a browser: use http, sql, shell or exec (a js hook needs the browser of a run)`,
      `error ${lineOf(text, 'service: worker')}:21 seed.1.exec.service: unknown service "worker" (the compose files declare: app, db, mailpit)`,
      `error ${lineOf(text, 'service: worker')}:38 seed.1.exec.command: exec names host api.example.com (URL): a seed only reaches the sandbox's services, localhost and allowed hosts`,
      `error ${lineOf(text, '/home/someone')}:10 seed.2.sql: SQL file "/home/someone/seed.sql" only exists on this computer: write it relative to sandbox.yaml`,
      `error ${lineOf(text, 'sql: dump.sql')}:10 seed.3.sql: this SQL is pg_dump's plain output (COPY … FROM stdin): sql steps run SQL statements — dump with \`pg_dump --inserts\`, or load it with an \`exec\` step (psql -f inside the database's container)`,
      `error ${lineOf(text, 'cwd: ~/data')}:34 seed.4.shell.cwd: cwd "~/data" only exists on this computer: write it relative to sandbox.yaml`,
      `error ${lineOf(text, 'restart: [ap]')}:13 reset.restart.0: unknown service "ap" (did you mean "app"?) (services: app, web)`,
      `error ${lineOf(text, '/postgres"')}:15 databases.main.url: database main is "postgres": a snapshot reset drops and recreates its database at every take — give the sandbox a database of its own`,
      `error ${lineOf(text, 'password: "x{{')}:15 accounts.admin.password: a password is plain text or one {{env:VAR}} / {{keychain:service/account}} / {{compose_env:NAME}} reference (it is put into the login steps as is)`,
      `error ${lineOf(text, 'expect_text: "{{account')}:40 accounts.admin.check.expect_text: {{account.username}} is only available in the login steps of an account (accounts.<name>.login)`,
      `error ${lineOf(text, '    login:')}:5 accounts.admin.login: the login steps use {{account.username}}: give account admin a \`username\``,
    ]);
    expect(msgs(warnings(issues))).toEqual([
      `warning ${lineOf(text, 'rollback: ./unload.sh')}:42 seed.4.shell.rollback: a seed step is never rolled back (the next reset rebuilds the data): \`rollback\` is ignored`,
    ]);
  });

  it('process sandboxes: `command` required, no `exec`, no `compose`, no snapshot; a page is required', () => {
    const text = `version: 1
provider: process
compose: {files: [compose.yaml]}
services:
  app: {url: http://localhost:4600}
seed:
  - exec: {service: app, command: "true"}
reset: {strategy: snapshot}
`;
    expect(msgs(parseSandboxYaml(text).issues)).toEqual([
      'error 3:1 compose: `compose` is for provider docker-compose (this sandbox starts local processes)',
      'error 4:1 services: a sandbox needs at least one page: add `pages: {app: http://localhost:<port>}` to the service that serves the product',
      'error 5:3 services.app: service app needs `command`: the program the sandbox starts (provider process)',
      'error 7:5 seed.0.exec: `exec` runs a command inside a compose service (provider docker-compose): with provider process, write a `shell` step (with `cwd`)',
      "error 8:19 reset.strategy: snapshot resets need provider docker-compose: the database must belong to the sandbox's own compose project (a process sandbox reseeds — strategy: reseed)",
    ]);
  });

  it('snapshot: a Postgres database of the sandbox, named, not a system one, short enough; snapshot settings without it are noted', async () => {
    const dir = await sandboxDir({ 'compose.yaml': COMPOSE_YAML });
    const base = 'version: 1\nprovider: docker-compose\nservices:\n  app: {url: http://localhost:4600, pages: {app: http://localhost:4600}}\n';
    const check = (rest: string) => msgs(parseSandboxYaml(base + rest, join(dir, 'sandbox.yaml')).issues);
    expect(check('reset: {strategy: snapshot}\n')).toEqual([
      'error 5:19 reset.strategy: a snapshot reset needs the Postgres database it snapshots: add `databases: {main: {url: "postgres://…@localhost:<port>/<db>"}}`',
    ]);
    expect(check('reset: {strategy: snapshot, snapshot: {database: other}}\ndatabases: {main: {url: "postgres://u:sandbox-db-4632@localhost:1/app"}}\n')).toEqual([
      'error 5:50 reset.snapshot.database: unknown database "other" (databases: main)',
    ]);
    expect(check('reset: {strategy: snapshot}\ndatabases: {main: {url: "mysql://u:sandbox-db-4632@localhost:1/app"}}\n')).toEqual([
      'error 5:19 reset.strategy: database main is not a Postgres URL (postgres://…): snapshots are Postgres template copies (other databases: strategy reseed)',
    ]);
    const long = 'a'.repeat(51);
    expect(check(`reset: {strategy: snapshot}\ndatabases: {main: {url: "postgres://u:sandbox-db-4632@localhost:1/${long}"}}\n`)).toEqual([
      `error 6:25 databases.main.url: database name "${long}" is longer than 50 characters: its snapshot "${long}__ds_snapshot" would be cut by Postgres (63 bytes at most)`,
    ]);
    expect(check('reset: {snapshot: {database: main}}\ndatabases: {main: {url: "postgres://u:sandbox-db-4632@localhost:1/app"}}\n')).toEqual([
      'warning 5:9 reset.snapshot: `snapshot` is only used with `strategy: snapshot` (this sandbox reseeds)',
    ]);
  });

  it('a database URL connects where it says: no host / port / hostaddr / service / dbname parameter, no templated query (K1)', () => {
    const db = (url: string) => `version: 1\nprovider: process\nservices:\n  app: {command: x, pages: {app: http://localhost:4600}}\ndatabases:\n  main: {url: "${url}"}\n`;
    for (const q of ['host=prod-db.example.com', 'host=/tmp', 'port=5432', 'Port=5432', 'hostaddr=10.0.0.5', 'service=prod', 'dbname=other', 'sslmode=disable&host=%2Ftmp']) {
      const issues = msgs(parseSandboxYaml(db(`postgres://demo:sandbox-db-4632@localhost:4632/app?${q}`)).issues);
      expect(issues, q).toEqual([expect.stringMatching(/^error 6:15 databases\.main\.url: database main: the query parameter "(host|port|hostaddr|service|dbname)" would connect elsewhere than the host and port the URL names \(another server, a unix socket\)/)]);
    }
    expect(msgs(parseSandboxYaml(db('postgres://demo:sandbox-db-4632@localhost:4632/app?{{env:Q}}=1')).issues)).toEqual([
      'error 6:15 databases.main.url: database main: its query string is templated — only the password may be a {{env:VAR}} / {{keychain:…}} reference',
    ]);
    // A unix socket written as a URL has no host.
    expect(msgs(parseSandboxYaml(db('socket:/tmp?db=app')).issues)[0]).toContain('database main has no host');
    expect(msgs(parseSandboxYaml(db('postgres://demo:sandbox-db-4632@localhost:4632/app?sslmode=disable&application_name=demo')).issues)).toEqual([]);
  });

  it('a health path stays on the service\'s url: "//host" and backslashes are refused (P8)', () => {
    const svc = (health: string) => `version: 1\nprovider: process\nservices:\n  app:\n    command: x\n    url: http://localhost:4600\n    health: ${health}\n    pages: {app: http://localhost:4600}\n`;
    expect(msgs(parseSandboxYaml(svc('"//evil.example/up"')).issues)).toEqual([
      'error 7:13 services.app.health: "//evil.example/up" could leave the service\'s url ("//…" names another host, and a "\\" counts as "/"): write a path ("/health") or an absolute local URL',
    ]);
    expect(msgs(parseSandboxYaml(svc("'/\\evil.example/up'")).issues)).toEqual([expect.stringMatching(/^error 7:13 services\.app\.health: "\/\\evil\.example\/up" could leave the service's url/)]);
    expect(msgs(parseSandboxYaml(svc('{path: "//evil.example/up"}')).issues)[0]).toMatch(/^error 7:\d+ services\.app\.health\.path: "\/\/evil\.example\/up" could leave the service's url/);
    expect(msgs(parseSandboxYaml(svc('/api/health')).issues)).toEqual([]);
  });

  it('a plain password shorter than 3 characters is refused: it would never be masked (P10)', () => {
    expect(unmaskedPasswordReason('ab')).toMatch(/^a plain password shorter than 3 characters is never masked in the logs/);
    expect(unmaskedPasswordReason('abc')).toBeNull();
    const text = `version: 1
provider: process
services:
  app: {command: x, pages: {app: http://localhost:4600}}
databases:
  main: {url: "postgres://demo:x@localhost:4632/app"}
accounts:
  admin: {pages: [app], check: {url: "app:/"}, username: admin@example.com, password: pw}
`;
    expect(msgs(parseSandboxYaml(text).issues).map((m) => m.split(': a plain')[0])).toEqual(['error 6:15 databases.main.url', 'error 8:87 accounts.admin.password']);
  });

  it('a shell seed step gets the env of the process services: a variable two of them set differently is the step\'s to set (I3)', () => {
    const text = (stepEnv: string) => `version: 1
provider: process
services:
  web: {command: x, env: {DATABASE_URL: "postgres://demo:sandbox-db-4702@localhost:4702/app", PORT: "4701"}, pages: {app: http://localhost:4701}}
  worker: {command: y, env: {DATABASE_URL: "postgres://demo:sandbox-db-4702@localhost:4702/jobs", PORT: "4701"}}
seed:
  - shell: {run: "npm run db:reset"${stepEnv}}
`;
    expect(msgs(parseSandboxYaml(text('')).issues)).toEqual([
      "error 7:12 seed.0.shell: services web and worker set DATABASE_URL differently, and a shell step gets the env of the sandbox's services: set DATABASE_URL in the step's own `env`",
    ]);
    expect(msgs(parseSandboxYaml(text(', env: {DATABASE_URL: "postgres://demo:sandbox-db-4702@localhost:4702/app"}')).issues)).toEqual([]);
  });

  it('`external: true` acknowledges a database or mailbox the sandbox does not start (I4); project.yaml never sees it', async () => {
    const text = `version: 1
provider: process
services:
  app: {command: x, pages: {app: http://localhost:4600}}
databases:
  main: {url: "postgres://demo:sandbox-db-4632@localhost:4632/app", external: true}
mailbox: {provider: mailpit, url: http://localhost:4625, external: true}
`;
    const p = parseSandboxYaml(text);
    expect(msgs(p.issues)).toEqual([]);
    expect(p.manifest?.databases?.main.external).toBe(true);
    expect(p.manifest?.mailbox?.external).toBe(true);
    const dir = await workspace(PROJECT, { 'sandbox/sandbox.yaml': text });
    const project = await loadProject(dir);
    expect(databasesFor(project, 'sandbox')).toEqual({ main: { url: 'postgres://demo:sandbox-db-4632@localhost:4632/app' } });
    expect(mailboxFor(project, 'sandbox')).toEqual({ provider: 'mailpit', url: 'http://localhost:4625' });
  });

  it('a compose service under `profiles:` never starts in a sandbox: naming it (a service, an exec step) is an error (K7)', async () => {
    const dir = await sandboxDir({ 'compose.yaml': `${COMPOSE_YAML}  tools: {image: busybox:1.38.0, profiles: [debug]}\n` });
    const text = `version: 1
provider: docker-compose
services:
  app: {url: http://localhost:4600, pages: {app: http://localhost:4600}}
  tools: {health: false}
seed:
  - exec: {service: tools, command: "seed"}
`;
    const { issues } = parseSandboxYaml(text, join(dir, 'sandbox.yaml'), { env: 'sandbox' });
    expect(msgs(errors(issues))).toEqual([
      `error ${lineOf(text, '  tools:')}:3 services: service "tools" has \`profiles:\` in the compose files: a sandbox never starts it (Retake runs docker compose without COMPOSE_PROFILES) — remove its \`profiles\``,
      `error ${lineOf(text, 'service: tools')}:21 seed.0.exec.service: service "tools" has \`profiles:\` in the compose files: a sandbox never starts it, so an exec step cannot run in it — remove its \`profiles\``,
    ]);
    // Not named by sandbox.yaml: a profiled service is simply not started.
    expect(errors(parseSandboxYaml('version: 1\nprovider: docker-compose\nservices:\n  app: {url: http://localhost:4600, pages: {app: http://localhost:4600}}\n', join(dir, 'sandbox.yaml')).issues)).toEqual([]);
  });

  it('the loopback hosts of a sandbox\'s mailbox and databases are allowed hosts at run time (db.localhost, 127.0.0.2: I7)', async () => {
    const text = `version: 1
provider: process
services:
  app: {command: x, pages: {app: http://localhost:4600}}
databases:
  main: {url: "postgres://demo:sandbox-db-4632@db.localhost:4632/app"}
mailbox: {provider: mailpit, url: http://127.0.0.2:4625}
`;
    expect(msgs(parseSandboxYaml(text).issues)).toEqual([]);
    const project = await loadProject(await workspace(PROJECT, { 'sandbox/sandbox.yaml': text }));
    expect(isHostAllowed('db.localhost', project)).toBe(true);
    expect(isHostAllowed('127.0.0.2', project)).toBe(true);
    expect(allowedHosts(project)).toEqual(expect.arrayContaining(['db.localhost', '127.0.0.2']));
    // Only a sandbox's: project.yaml's own databases are not added (db.example.com stays out).
    expect(isHostAllowed('db.example.com', project)).toBe(false);
    expect(isHostAllowed('other.localhost', project)).toBe(false);
  });

  it('weak plain passwords (short, or one word) are warned: their text is masked everywhere (critique §3)', () => {
    expect(weakPasswordReason('demo')).toMatch(/^a plain password shorter than 8 characters or made of one word/);
    expect(weakPasswordReason('password')).not.toBeNull();
    expect(weakPasswordReason('sandbox-db-4632')).toBeNull();
    const text = `version: 1
provider: process
services:
  app: {command: x, pages: {app: http://localhost:4600}}
databases:
  main: {url: "postgres://demo:demo@localhost:4632/app"}
  other: {url: "postgres://demo:{{env:PW}}@localhost:4632/app"}
accounts:
  admin: {pages: [app], check: {url: "app:/"}, username: admin@example.com, password: secret}
`;
    expect(msgs(parseSandboxYaml(text).issues).map((m) => m.split(': a plain')[0])).toEqual(['warning 6:15 databases.main.url', 'warning 9:87 accounts.admin.password']);
  });

  it('accounts are checked like personas: their pages, a literal password, unknown {{account.*}} fields', () => {
    const text = `version: 1
provider: process
services:
  app: {command: x, pages: {app: http://localhost:4600}}
login_url: /
accounts:
  admin:
    pages: [nope]
    username: admin@example.com
    login:
      - type: {into: {label: Password}, text: hunter-2-secret}
      - type: {into: {label: Email}, text: "{{account.email}}"}
`;
    expect(msgs(parseSandboxYaml(text).issues)).toEqual([
      'error 5:12 login_url: "/" matches every page: every run would stop on its first page as "landed on the sign-in page" — write the sign-in page\'s own path ("/sign-in")',
      'error 8:13 accounts.admin.pages.0: unknown page "nope" (environment pages: app)',
      "warning 11:47 accounts.admin.login.0.type.text: a password written in a login step: write {{account.password}} (the account's password is masked in logs)",
      'error 12:44 accounts.admin.login.1.type.text: unknown template key {{account.email}}; available: account.username, account.password',
    ]);
  });

  it('{{account.*}} means nothing in project.yaml or a scenario (unchanged messages there)', () => {
    const { issues } = parseProjectYaml('name: x\nenvironments:\n  local: {app: http://localhost:4600}\nreset:\n  - http: {url: "{{account.username}}/x"}\n');
    expect(msgs(issues)).toEqual(['error 5:17 reset.0.http.url: unknown template key {{account.username}}; available: app, env:VAR, keychain:service/account']);
  });
});

/** A workspace with project northfield: its project.yaml (+ files) under projects/northfield. */
async function workspace(projectYaml: string, files: Record<string, string> = {}): Promise<string> {
  const root = await temp();
  const dir = join(root, 'projects', 'northfield');
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
  await writeFiles(dir, { 'project.yaml': projectYaml, ...files });
  return dir;
}

const PROJECT = `name: Northfield
environments:
  local:
    console: http://localhost:4401
    shop: http://localhost:4402
  production:
    production: true
    pages: {console: https://console.example.com, shop: https://shop.example.com}
auth:
  login_url: /sign-in
  personas:
    supplier: {pages: [console], check: {url: "console:/", expect_text: Maja}}
databases:
  main: {url: "postgres://staging@db.example.com:5432/app"}
mailbox: {provider: http, url: http://localhost:4401/mailbox-http}
sandboxes:
  sandbox: sandbox/sandbox.yaml
`;

const SANDBOX_FILES = { 'sandbox/sandbox.yaml': PROCESS, 'sandbox/app/server.mjs': '', 'sandbox/seed/01-demo.sql': 'INSERT INTO t VALUES (1);\n' };

describe('project.yaml sandboxes: each one an environment (R-SBX-01, R-SBX-03)', () => {
  it('loadProject adds the sandbox as an environment: pages, display URLs, provider, mailbox, databases, personas', async () => {
    const dir = await workspace(PROJECT, SANDBOX_FILES);
    const p = await loadProject(dir);
    expect(p.issues).toEqual([]);
    expect(sandboxNames(p)).toEqual(['sandbox']);
    expect(p.config.environments.sandbox).toEqual({ console: 'http://localhost:4503', shop: 'http://localhost:4504' });
    const file = join(dir, 'sandbox', 'sandbox.yaml');
    expect(p.config.environment_settings?.sandbox).toEqual({
      display: { console: 'https://console.northfield.example', shop: 'https://shop.northfield.example' },
      sandbox: { file, provider: 'process' },
      mailbox: { provider: 'mailpit', url: 'http://localhost:4501/mailbox' },
      databases: { main: { url: 'postgres://demo:sandbox-pass-4632@localhost:4632/app' } },
    });
    expect(p.sandboxes?.sandbox).toMatchObject({ env: 'sandbox', file, dir: join(dir, 'sandbox'), issues: [], secrets: { buyer: ['cafe-pass-4504'] } });
    const env = resolveEnvironment(p, 'sandbox');
    expect(env).toEqual({
      name: 'sandbox',
      pages: { console: 'http://localhost:4503', shop: 'http://localhost:4504' },
      display: { console: 'https://console.northfield.example', shop: 'https://shop.northfield.example' },
      sandbox: { file, provider: 'process' },
    });
    expect(sandboxOf(p, 'sandbox')).toEqual({ file, provider: 'process' });
    expect(sandboxOf(p, 'local')).toBeUndefined();
    // The environment's mailbox and databases: a sandbox's own, never the project's.
    expect(mailboxFor(p, 'sandbox')).toEqual({ provider: 'mailpit', url: 'http://localhost:4501/mailbox' });
    expect(mailboxFor(p, 'local')).toEqual({ provider: 'http', url: 'http://localhost:4401/mailbox-http' });
    expect(mailboxFor(p, undefined)).toEqual(p.config.mailbox);
    expect(databasesFor(p, 'sandbox')).toEqual({ main: { url: 'postgres://demo:sandbox-pass-4632@localhost:4632/app' } });
    expect(databasesFor(p, 'local')).toEqual({ main: { url: 'postgres://staging@db.example.com:5432/app' } });
    expect(databasesFor(p, 'gone')).toEqual(databasesFor(p, 'local'));
  });

  it('accounts become the personas of the sandbox: credentials substituted, a plain password as a secret; the global auth goes keyed', async () => {
    const p = await loadProject(await workspace(PROJECT, SANDBOX_FILES));
    // The global auth is the same block for every other environment.
    expect(Object.keys(p.config.auth ?? {})).toEqual(['local', 'production', 'sandbox']);
    expect(resolvePersonas(p, 'local', { home: '/h' }).map((x) => x.name)).toEqual(['supplier']);
    const personas = resolvePersonas(p, 'sandbox', { home: '/h' });
    expect(personas.map((x) => [x.name, x.pages, x.sandbox, x.secrets])).toEqual([
      ['buyer', ['shop'], true, ['cafe-pass-4504']],
      ['supplier', ['console'], true, undefined],
    ]);
    const buyer = personas[0];
    expect(buyer.login).toEqual([
      { open: 'shop:/sign-in' },
      { type: { into: { label: 'Email' }, text: 'orders@demo-cafe.example' } },
      { type: { into: { label: 'Password' }, text: 'cafe-pass-4504' } },
      { click: { role: 'button', name: 'Sign in' } },
    ]);
    expect(buyer.loginPatterns).toEqual(['/sign-in']);
    expect(buyer.snapshot).toBe('/h/sessions/northfield/sandbox/buyer.json');
    // A secret reference stays one: resolved (and masked) by the run like any {{env:…}}.
    expect(personas[1].login?.[2]).toEqual({ type: { into: { label: 'Password' }, text: '{{env:NORTHFIELD_SUPPLIER_PASSWORD}}' } });
    // A scenario on the sandbox binds its pages to these personas.
    const { issues } = parseScenario('video: x\nenv: sandbox\nscenes:\n  - {id: a, page: shop, persona: buyer, open: /, steps: [{hold: 1}]}\n', { project: p });
    expect(msgs(issues)).toEqual([]);
  });

  it('a project without sandboxes loads exactly as before (global auth kept, no derived settings)', async () => {
    const text = PROJECT.replace(/sandboxes:\n.*\n/, '');
    const p = await loadProject(await workspace(text));
    expect(p.sandboxes).toBeUndefined();
    expect('sandboxes' in p).toBe(false);
    expect(p.config).toEqual(parseProjectYaml(text).config);
    expect(p.config.auth).toEqual({ login_url: '/sign-in', personas: { supplier: { pages: ['console'], check: { url: 'console:/', expect_text: 'Maja' } } } });
    expect(p.config.environment_settings).toEqual({ production: { production: true } });
    expect(resolvePersonas(p, 'local', { home: '/h' })[0]).not.toHaveProperty('sandbox');
  });

  it('wait_for_email on a sandbox reads its own mailbox: none declared is an error naming its sandbox.yaml', async () => {
    const noMailbox = PROCESS.replace(/^mailbox:.*\n/m, '');
    const p = await loadProject(await workspace(PROJECT, { ...SANDBOX_FILES, 'sandbox/sandbox.yaml': noMailbox }));
    expect(mailboxFor(p, 'sandbox')).toBeUndefined();
    const scenario = 'video: x\nscenes:\n  - {id: a, page: shop, open: /, steps: [{wait_for_email: {to: x@example.com, as: welcome}}]}\n';
    expect(msgs(parseScenario(`env: sandbox\n${scenario}`, { project: p }).issues)).toEqual([
      'error 4:59 scenes.0.steps.0.wait_for_email: sandbox sandbox has no `mailbox`: add mailbox: {provider: mailpit, url: http://localhost:<port>} to its sandbox.yaml',
    ]);
    expect(msgs(parseScenario(scenario, { project: p, env: 'local' }).issues)).toEqual([]);
  });

  it('project.yaml checks: names, collisions with environments and auth, default_env, missing manifest, auth.<sandbox>', async () => {
    const check = (yaml: string, dir?: string) => msgs(parseProjectYaml(yaml, dir ? join(dir, 'project.yaml') : undefined).issues);
    const dir = await sandboxDir({ 'sandbox/sandbox.yaml': '' });
    expect(
      check(
        `name: x
environments:
  local: {app: http://localhost:4600}
default_env: sandbox
auth:
  sandbox: {personas: {admin: {pages: [app]}}}
sandboxes:
  sandbox: sandbox/sandbox.yaml
  local: sandbox/sandbox.yaml
  "bad name": sandbox/other.yaml
  personas: /abs/sandbox.yaml
`,
        dir,
      ),
    ).toEqual([
      'error 6:3 auth: the personas of sandbox sandbox come from `accounts:` in its sandbox.yaml: remove auth.sandbox',
      'error 9:3 sandboxes: "local" is already an environment of project.yaml: a sandbox is an environment of its own — give it another name',
      'error 10:3 sandboxes: sandbox name "bad name" must be slug-like (letters, digits, "-" or "_"): it is an environment name',
      'error 10:15 sandboxes.bad name: sandbox manifest "sandbox/other.yaml" not found in the project',
      'error 11:3 sandboxes: sandbox name "personas" is also an `auth` key (profile, storage_state, login_url, personas): rename the sandbox',
      'error 11:13 sandboxes.personas: "/abs/sandbox.yaml" only exists on this computer: write the path of sandbox.yaml relative to the project',
    ]);
    // Only sandboxes: no "no environments yet" warning; an unknown default_env lists them.
    expect(check('name: x\ndefault_env: sandbx\nsandboxes: {sandbox: sandbox/sandbox.yaml}\n', dir)).toEqual([
      'error 2:14 default_env: unknown environment "sandbx" (did you mean "sandbox"?) (available: sandbox)',
    ]);
  });

  it('a broken sandbox.yaml fails loadProject with its own file and positions; a page on a production host:port is an error', async () => {
    const bad = PROCESS.replace('http://localhost:4504, display', 'https://shop.example.com, display');
    const dir = await workspace(PROJECT, { ...SANDBOX_FILES, 'sandbox/sandbox.yaml': bad });
    const e = await loadProject(dir).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxConfigError);
    expect(e).toBeInstanceOf(ConfigError);
    const err = e as SandboxConfigError;
    expect(err.name).toBe('ConfigError');
    expect(err.env).toBe('sandbox');
    expect(err.file).toBe(join(dir, 'sandbox', 'sandbox.yaml'));
    expect(formatIssues(err.issues)).toBe(
      `${lineOf(bad, 'shop: {url: https')}:19 error services.fixture.pages.shop.url: page shop shop.example.com is not on this machine: sandbox URLs name localhost, *.localhost, 127.0.0.1 or [::1] only: a sandbox is reset — its databases dropped and recreated — before every take`,
    );
    expect(err.message.split('\n')[0]).toBe(`sandbox sandbox ${err.file} has 1 error:`);
    // A sandbox page on the host:port of a read-only environment's page (here: production on localhost:4401).
    const prodLocal = PROJECT.replace('pages: {console: https://console.example.com, shop: https://shop.example.com}', 'pages: {console: http://localhost:4503}');
    const e2 = (await loadProject(await workspace(prodLocal, SANDBOX_FILES)).catch((x: unknown) => x)) as SandboxConfigError;
    expect(e2.issues.map((i) => i.message)).toEqual([
      'page console (localhost:4503) is also a page of environment production, which is production: a sandbox is reset — its data dropped — before every take; give it a port of its own',
    ]);
    // Every loopback host is the same server (I8): 127.0.0.1, [::1] and *.localhost against localhost.
    for (const host of ['127.0.0.1', '[::1]', 'app.localhost']) {
      const other = PROJECT.replace('pages: {console: https://console.example.com, shop: https://shop.example.com}', `pages: {console: "http://${host}:4503"}`);
      const e4 = (await loadProject(await workspace(other, SANDBOX_FILES)).catch((x: unknown) => x)) as SandboxConfigError;
      expect(e4.issues?.map((i) => i.message), host).toEqual([
        `page console (localhost:4503) is also a page of environment production (${host}:4503: the same server), which is production: a sandbox is reset — its data dropped — before every take; give it a port of its own`,
      ]);
    }
    const missing = await workspace(PROJECT, {});
    const e3 = (await loadProject(missing).catch((x: unknown) => x)) as ConfigError;
    expect(e3.message).toContain('sandboxes.sandbox: sandbox manifest "sandbox/sandbox.yaml" not found in the project');
  });

  it('warnings of a manifest stay with it (LoadedSandbox.issues), not with project.yaml', async () => {
    const weak = PROCESS.replace('cafe-pass-4504', 'cafe');
    const p = await loadProject(await workspace(PROJECT, { ...SANDBOX_FILES, 'sandbox/sandbox.yaml': weak }));
    expect(p.issues).toEqual([]);
    expect(msgs(p.sandboxes!.sandbox.issues).map((m) => m.split(': a plain')[0])).toEqual([`warning ${lineOf(weak, 'password: cafe')}:15 accounts.buyer.password`]);
    // A weak plain password is still a secret value.
    expect(p.sandboxes!.sandbox.secrets).toEqual({ buyer: ['cafe'] });
  });
});

describe('seed hash (R-SBX-05 support)', () => {
  it('stable for the same seed; changes with a SQL file, a file of seed/, the strategy or extra inputs', async () => {
    const dir = await sandboxDir({ 'sandbox.yaml': COMPOSE, 'compose.yaml': COMPOSE_YAML, 'seed/01-demo-data.sql': 'INSERT INTO t VALUES (1);\n', 'seed/.hidden': 'x' });
    const { manifest } = parseSandboxYaml(COMPOSE, join(dir, 'sandbox.yaml'));
    const s = { dir, manifest: manifest! };
    expect(await seedFileRefs(s)).toEqual([join(dir, 'seed', '01-demo-data.sql')]);
    const h1 = await seedHash(s);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await seedHash({ dir, manifest: structuredClone(manifest!) })).toBe(h1);
    await writeFile(join(dir, 'seed', '01-demo-data.sql'), 'INSERT INTO t VALUES (2);\n');
    const h2 = await seedHash(s);
    expect(h2).not.toBe(h1);
    await writeFile(join(dir, 'seed', 'users.csv'), 'id\n1\n');
    expect(await seedFileRefs(s)).toEqual([join(dir, 'seed', '01-demo-data.sql'), join(dir, 'seed', 'users.csv')]);
    const h3 = await seedHash(s);
    expect(h3).not.toBe(h2);
    expect(await seedHash({ dir, manifest: { ...manifest!, reset: { strategy: 'reseed' } } })).not.toBe(h3);
    expect(await seedHash(s, ['sha256:image-a'])).not.toBe(h3);
  });
});

describe('ProjectConfig stays a plain project.yaml shape', () => {
  it('applyProjectDefaults keeps `sandboxes` as written', () => {
    const c = applyProjectDefaults({ name: 'x', sandboxes: { sandbox: 'sandbox/sandbox.yaml' } });
    expect(c.sandboxes).toEqual({ sandbox: 'sandbox/sandbox.yaml' });
  });
});
