import { z } from 'zod';
import { SANDBOX_PROVIDERS, SANDBOX_RESET_STRATEGIES } from '../types.js';
import type { ExecStepSpec, SeedStep } from '../types.js';
import { HOOK_COMMON_KEYS, HttpHookSchema, ShellHookSchema, SqlHookSchema, hookBranch } from './hooks.js';
import { keyedUnion } from './keyed.js';
import { keyString, nonEmpty, positiveSeconds, slugString } from './primitives.js';
import { PageValueSchema, httpUrl, mailboxShape } from './project.js';
import { LoginPatternsSchema, personaShape } from './settings.js';

/** Kinds of seed step: the hooks without js (no browser in a sandbox), plus `exec` (docker-compose). */
export const SEED_KINDS = ['http', 'sql', 'shell', 'exec'] as const;

const statusSchema = z.number().int().min(100).max(599);

const HealthSchema = z
  .union([
    z.literal(false).describe('No health check.'),
    nonEmpty().describe('A path on the service\'s url (e.g. "/up"), or an absolute local URL.'),
    z.strictObject({
      path: nonEmpty().describe('Path on the service\'s url (default "/").').optional(),
      url: httpUrl().describe('An absolute local URL instead of a path.').optional(),
      tcp: z.number().int().min(1).max(65_535).describe('process services only: a port that must accept a connection.').optional(),
      status: z.union([statusSchema, z.array(statusSchema).min(1)]).describe('Expected status code(s) (default 200–399).').optional(),
      text: nonEmpty().describe('Text the answer must contain.').optional(),
      timeout_s: positiveSeconds().describe('Seconds before the service counts as not healthy (default 60 for a process, 120 for compose).').optional(),
      interval_ms: z.number().int().min(50).max(10_000).describe('Delay between two tries in ms (default 250).').optional(),
    }),
  ])
  .describe('How the sandbox tells this service is up (default: GET its url).');

const ServiceSchema = z
  .strictObject({
    url: httpUrl().describe('Base URL of the service on this machine (localhost only); the default health check GETs it.').optional(),
    pages: z
      .record(z.string(), PageValueSchema)
      .describe('Environment pages this service serves: page key → URL (localhost only), or {url, display} (the URL the video shows).')
      .optional(),
    health: HealthSchema.optional(),
    command: z
      .union([nonEmpty(), z.array(nonEmpty()).min(1)])
      .describe('process only: argv (a first word "node" runs the CLI\'s own Node), or a string run by sh -c (PATH lookup).')
      .optional(),
    cwd: nonEmpty().describe('process only: working directory, relative to sandbox.yaml (default its folder).').optional(),
    env: z.record(z.string(), z.string()).describe('process only: extra environment variables ({{env:VAR}} references are expanded).').optional(),
    stop_timeout_s: positiveSeconds().describe('process only: seconds between SIGTERM and SIGKILL when it stops (default 10).').optional(),
  })
  .describe('A compose service (docker-compose) or a process to start (process).');

const ExecSchema = z.strictObject({
  service: nonEmpty().describe('The compose service the command runs in.'),
  command: z.union([nonEmpty(), z.array(nonEmpty()).min(1)]).describe('A string run by sh -c in the service, or argv.'),
  env: z.record(z.string(), z.string()).optional(),
  timeout_s: positiveSeconds().describe('Seconds (default 300).').optional(),
}) satisfies z.ZodType<ExecStepSpec>;

/** One seed step: exactly one of http, sql, shell, exec (no js: a sandbox has no browser). */
export const SeedStepSchema = keyedUnion(
  [
    hookBranch('http', HttpHookSchema, 'HTTP request (an API that creates the demo data).'),
    hookBranch('sql', SqlHookSchema, 'SQL file (relative to sandbox.yaml) or inline query, run in a transaction on a database of the sandbox.'),
    hookBranch('shell', ShellHookSchema, 'Shell command (sh -c), run in the folder of sandbox.yaml.'),
    hookBranch('exec', ExecSchema, 'docker-compose only: a command run inside a compose service (docker compose exec).'),
  ],
  {
    noun: 'seed step',
    label: 'step type',
    keys: SEED_KINDS,
    common: HOOK_COMMON_KEYS,
    example: 'e.g. "sql: seed/01-demo-data.sql"',
    refused: {
      keys: ['js'],
      message: () => 'seed steps run without a browser: use http, sql, shell or exec (a js hook needs the browser of a run)',
    },
  },
  { id: 'SeedStep', description: 'Exactly one of http, sql, shell, exec, plus name / optional (no rollback: a seed is never undone).' },
) as unknown as z.ZodType<SeedStep>;

const AccountSchema = z
  .strictObject({
    username: nonEmpty().describe('{{account.username}} in its login steps.').optional(),
    password: nonEmpty()
      .describe('{{account.password}} in its login steps: plain (every sandbox URL is local; masked in logs) or {{env:VAR}} / {{keychain:service/account}}.')
      .optional(),
    ...personaShape,
  })
  .describe('A demo account the seed creates: the persona of the same name on this sandbox\'s environment (signed in automatically by its login steps).');

/** sandbox.yaml `databases`: project.yaml's shape, plus `external`. */
const SandboxDatabasesSchema = z.record(
  z.string(),
  z.strictObject({
    url: nonEmpty().describe('Connection URL on this machine (loopback); the password may be plain or a {{env:VAR}} / {{keychain:service/account}} reference.'),
    external: z
      .boolean()
      .describe(
        "The sandbox does not start this database's server (your own Postgres) and the database is the sandbox's alone: sql seed steps may rewrite it. Without it they are refused unless a service of the sandbox serves its port.",
      )
      .optional(),
  }),
);

/** sandbox.yaml (version 1). */
export const SandboxFileSchema = z
  .strictObject({
    version: z.literal(1).describe('Version of this file\'s format (1).'),
    provider: z.enum(SANDBOX_PROVIDERS).describe('docker-compose: `docker compose` on the compose files; process: local processes started by Demo Studio.'),
    compose: z
      .strictObject({
        files: z.array(nonEmpty()).min(1).describe('Compose files, relative to sandbox.yaml (default [compose.yaml]).').optional(),
        project: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, { error: 'a compose project name is lower-case letters, digits, "_" or "-" (at most 63)' })
          .describe('Compose project name (default demo-studio-<project>-<environment>-<hash of the folder>).')
          .optional(),
        env_file: z
          .union([nonEmpty(), z.literal(false)])
          .describe('The env file docker compose reads `${VAR}` values from (image versions, settings), relative to sandbox.yaml; default .env next to the first compose file when there is one; false: none.')
          .optional(),
      })
      .describe('docker-compose only.')
      .optional(),
    services: z.record(slugString('service name'), ServiceSchema).describe('service name → its URL, pages, health (and command, for process).'),
    seed: z.array(SeedStepSchema).describe('Steps that build the demo data (paths relative to sandbox.yaml); they stop at the first failure.').optional(),
    reset: z
      .strictObject({
        strategy: z
          .enum(SANDBOX_RESET_STRATEGIES)
          .describe('reseed (default): run the seed again before each take; snapshot: restore a Postgres snapshot taken after the seed (docker-compose).')
          .optional(),
        snapshot: z
          .strictObject({ database: keyString('database').describe('Key of `databases` (default the first one): dropped and recreated at every reset.').optional() })
          .optional(),
        restart: z.array(nonEmpty()).describe('Services restarted after each reset (apps that do not survive a database swap).').optional(),
      })
      .optional(),
    databases: SandboxDatabasesSchema.describe('Databases of the sandbox (sql seeds, and the sql hooks of scenarios on this environment); local only.').optional(),
    mailbox: z
      .strictObject({
        ...mailboxShape,
        clear: z.boolean().describe('Empty it at every reset (default true; Mailpit only).').optional(),
        external: z
          .boolean()
          .describe(
            "Another program serves this mailbox (a Mailpit you run) and it is the sandbox's alone: emptied at every reset all the same. Without it, a reset that empties it is refused unless a service of the sandbox serves its port.",
          )
          .optional(),
      })
      .describe('The test mailbox of the sandbox (read by wait_for_email on this environment instead of the project\'s).')
      .optional(),
    login_url: LoginPatternsSchema.describe('Sign-in pages of every account.').optional(),
    accounts: z
      .record(slugString('account name'), AccountSchema)
      .describe('Demo accounts the seed creates, each one the persona of the same name on this environment.')
      .optional(),
  })
  .meta({ id: 'Sandbox', title: 'Demo Studio sandbox', description: 'sandbox.yaml (version 1): a disposable, local copy of the product, seeded and reset before each take.' });
