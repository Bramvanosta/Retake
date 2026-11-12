import { z } from 'zod';
import type { HookKind } from '../types.js';
import { keyedUnion } from './keyed.js';
import { keyString, nonEmpty, positiveSeconds, slugString } from './primitives.js';

export const HOOK_KINDS: readonly HookKind[] = ['http', 'sql', 'shell', 'js'];

// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;
/** A name a person reads in a form or a log: no control character (a line break, an escape sequence). */
const noControl = (what: string) => z.string().regex(NO_CONTROL, `${what}: no control character (a line break, a tab, an escape)`);

export const hookCommonShape = {
  name: nonEmpty().regex(NO_CONTROL, 'a hook name: no control character (a line break, a tab, an escape)').describe('Name shown in logs and journals.').optional(),
  confirm: z.boolean().describe('Required (true) for destructive hooks.').optional(),
  destructive: z.boolean().describe('Declare the hook destructive explicitly (also auto-detected).').optional(),
  optional: z.boolean().describe('Continue even if this hook fails.').optional(),
  writes: z.boolean().describe('Shell hooks only: false declares that the command only reads, so it may run on a read-only environment.').optional(),
};

export const HOOK_COMMON_KEYS = Object.keys(hookCommonShape);

const statusSchema = z.number().int().min(100).max(599);

const httpRequestShape = {
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).describe('Default GET.').optional(),
  url: nonEmpty().describe('Request URL; templated ({{page}}, {{vars.x}}, {{env:VAR}}…).'),
  headers: z.record(z.string(), z.string()).optional(),
  json: z.unknown().describe('JSON body.').optional(),
  body: z.string().describe('Raw body.').optional(),
  expect: z
    .union([statusSchema, z.array(statusSchema).min(1)])
    .describe('Expected status code(s). Default: any 2xx.')
    .optional(),
  auth: z
    .strictObject({ persona: slugString('persona').describe('A persona of the environment (a sandbox account).') })
    .describe(
      'Send the request as a persona: the cookies its saved session holds for the URL and, for a product signed in with Firebase Auth, its ID token as `Authorization: Bearer …`. Not in a sandbox seed.',
    )
    .optional(),
};

export const HttpHookSchema = z.strictObject({
  ...httpRequestShape,
  save_as: keyString('save_as').describe('Store the response as {{hooks.<save_as>.status|body|json.<path>}}.').optional(),
  rollback: z.strictObject(httpRequestShape).describe('Request that undoes this one (templated after the request: {{response.json.id}}).').optional(),
});

export const SqlHookSchema = z.union([
  nonEmpty().describe('A .sql file relative to the project dir (a sandbox seed: to sandbox.yaml), or an inline query.'),
  z.strictObject({
    file: nonEmpty().describe('SQL file relative to the project dir (a sandbox seed: to sandbox.yaml).').optional(),
    query: nonEmpty().describe('Inline SQL.').optional(),
    db: nonEmpty().describe('Database key from project.databases (default: the first one).').optional(),
    rollback: z
      .union([nonEmpty(), z.strictObject({ file: nonEmpty().optional(), query: nonEmpty().optional() })])
      .describe('SQL that undoes this hook: a *.sql file or inline SQL.')
      .optional(),
  }),
]);

export const ShellHookSchema = z.union([
  nonEmpty().describe('Command run with sh -c in the project dir (a sandbox seed: the folder of sandbox.yaml); every host it names must be allowed.'),
  z.strictObject({
    run: nonEmpty(),
    cwd: nonEmpty().optional(),
    env: z.record(noControl('an env name'), z.string()).optional(),
    rollback: nonEmpty().describe('Command that undoes this one.').optional(),
    timeout: positiveSeconds().optional(),
  }),
]);

const JsHookSchema = z.union([
  nonEmpty().describe('Inline JS (function body) evaluated in the js hook tab of the first environment page.'),
  z.strictObject({
    code: nonEmpty().describe('Inline JS (function body; may return / await).').optional(),
    file: nonEmpty().describe('JS file relative to the project dir.').optional(),
    page: keyString('page').describe('Environment page key whose hook tab runs it (default: the first page).').optional(),
    rollback: nonEmpty().optional(),
  }),
]);

export const hookBranch = <K extends string, S extends z.ZodType>(kind: K, schema: S, description: string) =>
  z.strictObject({ [kind]: schema, ...hookCommonShape } as { [P in K]: S } & typeof hookCommonShape).meta({ title: kind, description });

/** One setup / teardown / reset hook: exactly one of http, sql, shell, js. */
export const HookStepSchema = keyedUnion(
  [
    hookBranch('http', HttpHookSchema, 'HTTP request (fetch); response saved for templating; optional rollback request.'),
    hookBranch('sql', SqlHookSchema, 'SQL file or inline query run in a transaction (project.databases).'),
    hookBranch('shell', ShellHookSchema, 'Shell command (sh -c) in the project dir; every host it names must be allowed.'),
    hookBranch('js', JsHookSchema, 'JavaScript evaluated in its own tab on an environment page (through the runner); requests to unlisted hosts are blocked.'),
  ],
  {
    noun: 'hook',
    label: 'hook type',
    keys: HOOK_KINDS,
    common: HOOK_COMMON_KEYS,
    example: 'e.g. "sql: hooks/reset.sql"',
  },
  { id: 'HookStep', description: 'Exactly one of http, sql, shell, js, plus name / confirm / destructive / optional / writes.' },
);

/** `hooks:` of a scenario or project.yaml (L5.8): name → one hook entry or a list of them, run by a `hook: <name>` step. */
export const NamedHooksSchema = z
  .record(slugString('hook name'), z.union([HookStepSchema, z.array(HookStepSchema).min(1)]))
  .describe('Named hooks a `hook: <name>` step runs during the take: name → one hook entry (http, sql, shell, js) or a list of them, run in order.');
