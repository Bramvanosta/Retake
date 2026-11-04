import { z } from 'zod';
import { clockError } from '../clock.js';
import { displayError } from '../display.js';
import { hostPatternError } from '../hosts.js';
import { ENVIRONMENT_ACCESS, RAW_CURSOR_MODES, RAW_FORMATS, RAW_LAYER_FORMATS, SANDBOX_PROVIDERS } from '../types.js';
import { requestPatternError } from '../writes.js';
import { HookStepSchema, NamedHooksSchema } from './hooks.js';
import { keyedUnion } from './keyed.js';
import { FrameSpecSchema, fileVersion, nonEmpty } from './primitives.js';
import {
  AuthConfigSchema,
  BrowserConfigSchema,
  CapturePartialSchema,
  CaptureSettingsSchema,
  PacingPartialSchema,
  RunDefaultsSchema,
} from './settings.js';

export const httpUrl = () =>
  z.url({ protocol: /^https?$/, error: 'expected an absolute http(s) URL, e.g. "https://app.staging.example.com"' });

/** A string checked by a function returning the reason it is refused (positioned like any schema issue). */
export const checkedString = (why: (s: string) => string | null) =>
  nonEmpty().superRefine((s, ctx) => {
    const message = why(s);
    if (message) ctx.addIssue({ code: 'custom', message });
  });

/** `clock:` (L1.7): an ISO 8601 date-time, or {at, freeze}. */
export const ClockSpecSchema = z
  .union([
    checkedString(clockError).describe('ISO 8601 date and time, e.g. 2026-11-02T10:24:00 (without an offset: wall time in the browser\'s time zone).'),
    z.strictObject({
      at: checkedString(clockError).describe('ISO 8601 date and time, e.g. 2026-11-02T10:24:00.'),
      freeze: z.boolean().describe('true: the clock never moves (timers still run; code measuring time with Date stalls). Default false: it starts at `at` when the capture starts and runs.').optional(),
    }),
  ])
  .describe('The date and time the product\'s browser clock reads when the capture starts, so every take shows the same dates and times.');

/** `[METHOD ]<page>:/path` or `[METHOD ]/path` (globs * and **), as in read_only.allow and mocks. */
const requestPattern = () =>
  checkedString(requestPatternError).describe('"[METHOD ]<page>:/path" or "[METHOD ]/path", e.g. "POST shop:/api/quotes"; * matches within a path segment, ** anything; the query is ignored.');

const WriteRuleSchema = z.union([
  requestPattern(),
  z.strictObject({
    request: requestPattern(),
    operation: nonEmpty().describe('GraphQL operation name.').optional(),
  }),
]);

/** The answer to a write stopped on a read-only run (literal: nothing in it is templated). */
export const WriteMockSchema = z
  .strictObject({
    request: requestPattern(),
    operation: nonEmpty().describe('GraphQL operation name.').optional(),
    status: z.number().int().min(200).max(599).describe('Status of the answer (default 200).').optional(),
    json: z.unknown().describe('JSON body of the answer.').optional(),
    body: z.string().describe('Raw body of the answer (text/plain unless content_type).').optional(),
    content_type: nonEmpty().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    delay_ms: z.number().int().min(0).max(10_000).describe('Wait before answering (ms).').optional(),
  })
  .describe('Answer to a write stopped on a read-only run, so the flow continues on screen.');

const ReadOnlySchema = z
  .strictObject({
    hosts: z
      .array(checkedString(hostPatternError))
      .describe(
        'More hosts whose writes are stopped (the pages\' hosts always are; on a production environment every host is): "api.example.com", "*.example.com", or "*" for every host. They also belong to this environment: runs on other environments never write to them.',
      )
      .optional(),
    allow: z.array(WriteRuleSchema).describe('Writes let through (a token refresh, a search sent as POST…).').optional(),
    mocks: z.array(WriteMockSchema).describe('Answers to stopped writes, for every scenario on this environment (a scenario\'s own mocks come first).').optional(),
  })
  .describe('Used only when a run on this environment is read-only (its hosts are also never written to from runs on other environments).');

/** A page of an environment (also of a sandbox service): its base URL, or {url, display}. */
export const PageValueSchema = z.union([
  httpUrl(),
  z.strictObject({
    url: httpUrl(),
    display: checkedString(displayError)
      .describe('The URL the video shows instead (address bar, captions): a host such as shop.example.com (https implied) or an http(s) URL.')
      .optional(),
  }),
]);

const PagesSchema = z.record(z.string(), PageValueSchema);

const LongEnvironmentSchema = z.strictObject({
  production: z.boolean().describe('A production environment: read-only unless access: read-write, and then only with --allow-writes.').optional(),
  access: z.enum(ENVIRONMENT_ACCESS).describe('read-only or read-write (default: read-only in production, else read-write).').optional(),
  pages: PagesSchema.describe('page key → base URL, or {url, display}.'),
  read_only: ReadOnlySchema.optional(),
});

/** One environment: the page map (short form), or {production, access, pages, read_only} (long form, L1.7). */
const EnvironmentSchema = keyedUnion(
  [LongEnvironmentSchema, PagesSchema],
  {
    noun: 'environment',
    label: 'environment form',
    keys: ['pages'],
    common: [],
    fallback: 1,
    example: 'page keys and URLs such as "console: https://console.staging.example.com", or "pages:" with production / access',
    misplaced: {
      keys: ['production', 'access', 'read_only'],
      message: (key, path) =>
        `"${key}" is a setting of environment ${String(path[path.length - 1])}, not a page: settings go with the long form — write the page URLs under \`pages:\` and \`${key}\` next to it`,
    },
  },
  {
    id: 'Environment',
    description: 'page key → base URL (or {url, display}); or the long form {production, access, pages, read_only}.',
  },
);

/** The fields of a test mailbox (project.yaml `mailbox`, sandbox.yaml `mailbox`). */
export const mailboxShape = {
  provider: z.enum(['mailpit', 'http']).describe('mailpit: the Mailpit API; http: the generic JSON shape (see docs/guide/scenarios.md).'),
  url: httpUrl().describe('Base URL of the mailbox API, e.g. http://localhost:8025 (its host must be allowed).'),
  poll_ms: z.number().int().min(100).max(10_000).describe('Polling interval in ms (default 500).').optional(),
  headers: z
    .record(z.string(), z.string())
    .describe('Extra request headers, e.g. an API token ({{env:VAR}} references are expanded).')
    .optional(),
};

const MailboxSchema = z.strictObject(mailboxShape);

/** Database key → connection URL (project.yaml `databases`, sandbox.yaml `databases`). */
export const DatabasesSchema = z.record(
  z.string(),
  z.strictObject({
    url: nonEmpty().describe('Connection URL; use {{env:VAR}} / {{keychain:service/account}} for credentials.'),
  }),
);

const EnvironmentSettingsSchema = z.strictObject({
  production: z.boolean().optional(),
  access: z.enum(ENVIRONMENT_ACCESS).optional(),
  display: z.record(z.string(), z.string()).optional(),
  read_only: ReadOnlySchema.optional(),
  sandbox: z.strictObject({ file: nonEmpty(), provider: z.enum(SANDBOX_PROVIDERS) }).optional(),
  mailbox: MailboxSchema.optional(),
  databases: DatabasesSchema.optional(),
});

const projectShape = {
  version: fileVersion(),
  name: nonEmpty().describe('Display name of the product / project.'),
  environments: z
    .record(z.string(), EnvironmentSchema)
    .describe('env name → page key → base URL (or {url, display}), e.g. {staging: {console: https://…, shop: https://…}}; or the long form {production, access, pages, read_only}.')
    .optional(),
  default_env: nonEmpty().describe('Environment used when a scenario does not say (default: the first one).').optional(),
  auth: z
    .union([AuthConfigSchema, z.record(z.string(), AuthConfigSchema)])
    .describe('Global auth, or per environment name. Never passwords.')
    .optional(),
  capture: CapturePartialSchema.optional(),
  frame: FrameSpecSchema.describe(
    'Default frame of every scenario (default card): raw, card, browser, laptop, phone, tablet or a layout component id "namespace/name".',
  ).optional(),
  template: nonEmpty().describe('Template name (the workspace templates/<name>, else a starter template: default, editorial, motion) or a path relative to the project dir.').optional(),
  locale: nonEmpty().optional(),
  allow_hosts: z
    .array(nonEmpty())
    .describe('Extra hosts hooks (every kind) and the mailbox may contact; environment hosts and localhost are always allowed.')
    .optional(),
  databases: DatabasesSchema.optional(),
  pacing: PacingPartialSchema.optional(),
  defaults: RunDefaultsSchema.describe("Step defaults of every scenario (a scenario's `defaults` win), e.g. {timeout_s: 30}.").optional(),
  browser: BrowserConfigSchema.optional(),
  reset: z.array(HookStepSchema).describe('Hooks run by env_reset.').optional(),
  hooks: NamedHooksSchema.describe('Named hooks of every scenario: what a `hook: <name>` step runs when its scenario has no hook of that name.').optional(),
  vars: z.record(z.string(), z.string()).describe('Variables shared by every scenario ({{vars.x}}).').optional(),
  mailbox: MailboxSchema.describe('Test mailbox read by wait_for_email (Mailpit or a generic HTTP JSON API).').optional(),
  clock: ClockSpecSchema.optional(),
  raw: z
    .strictObject({
      format: z.enum(RAW_FORMATS).describe('Clip codec: mp4 (H.264 high, CRF 14) or prores (ProRes 422 HQ .mov). Default mp4.').optional(),
      fps: z.union([z.literal(30), z.literal(60)]).describe('Clip frame rate (default 30).').optional(),
      cursor: z
        .enum(RAW_CURSOR_MODES)
        .describe('baked (as captured), none (captured without the cursor; cursor data only) or layer (a transparent cursor video per clip). Default baked.')
        .optional(),
      layer: z.enum(RAW_LAYER_FORMATS).describe('Cursor layer codec: prores (ProRes 4444) or webm (VP9 alpha). Default prores.').optional(),
      selects: z.boolean().describe('Also write one continuous selects file of the clips (default false).').optional(),
      cuts: z.boolean().describe('Cut the loading inside scenes (default true).').optional(),
    })
    .describe('Defaults of the raw capture export for editors (retake export-capture, retake run --raw).')
    .optional(),
  sandboxes: z
    .record(z.string(), nonEmpty())
    .describe(
      'Sandbox environments (L1.8): environment name → its sandbox.yaml, relative to the project dir. Each one is an environment of its own (pages, display URLs, personas from its accounts, mailbox, databases), local, never production.',
    )
    .optional(),
};

/** project.yaml as written (defaults not applied). */
export const ProjectFileSchema = z
  .strictObject(projectShape)
  .meta({ id: 'Project', title: 'Retake project', description: 'projects/<slug>/project.yaml' });

/** ProjectConfig after defaults (what loadProject returns). */
export const ProjectConfigSchema = z.strictObject({
  ...projectShape,
  // Normalised by loadProject: real page URLs only; the rest of the long form is in environment_settings.
  environments: z.record(z.string(), z.record(z.string(), httpUrl())),
  environment_settings: z.record(z.string(), EnvironmentSettingsSchema).optional(),
  capture: CaptureSettingsSchema,
  frame: FrameSpecSchema,
  template: nonEmpty(),
});

/** retake.yaml at the workspace root. */
export const WorkspaceFileSchema = z
  .strictObject({
    version: fileVersion(),
    projects_dir: nonEmpty().describe('Projects directory, relative to the workspace root (default "projects").').optional(),
    templates_dir: nonEmpty().describe('Templates directory, relative to the workspace root (default "templates").').optional(),
    components_dir: nonEmpty()
      .describe('Workspace components directory (<namespace>/<name>/component.yaml), relative to the workspace root (default "components").')
      .optional(),
    browser: BrowserConfigSchema.optional(),
    ffmpeg: nonEmpty().describe('ffmpeg binary (ffprobe is looked for beside it); default: $RETAKE_FFMPEG, the app\'s own, else "ffmpeg" on PATH.').optional(),
  })
  .meta({ id: 'Workspace', title: 'Retake workspace', description: 'retake.yaml' });
