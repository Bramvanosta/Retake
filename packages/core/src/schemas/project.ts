import { z } from 'zod';
import { HookStepSchema } from './hooks.js';
import { FrameSpecSchema, nonEmpty } from './primitives.js';
import { RAW_CURSOR_MODES, RAW_FORMATS, RAW_LAYER_FORMATS } from '../types.js';
import {
  AuthConfigSchema,
  BrowserConfigSchema,
  CapturePartialSchema,
  CaptureSettingsSchema,
  PacingPartialSchema,
} from './settings.js';

const httpUrl = () =>
  z.url({ protocol: /^https?$/, error: 'expected an absolute http(s) URL, e.g. "https://app.staging.example.com"' });

const projectShape = {
  name: nonEmpty().describe('Display name of the product / project.'),
  environments: z
    .record(z.string(), z.record(z.string(), httpUrl()))
    .describe('env name → page key → base URL, e.g. {staging: {console: https://…, shop: https://…}}.')
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
    .describe('Extra hosts hooks may target (environment hosts and localhost are always allowed).')
    .optional(),
  databases: z
    .record(
      z.string(),
      z.strictObject({
        url: nonEmpty().describe('Connection URL; use {{env:VAR}} / {{keychain:service/account}} for credentials.'),
      }),
    )
    .optional(),
  pacing: PacingPartialSchema.optional(),
  browser: BrowserConfigSchema.optional(),
  reset: z.array(HookStepSchema).describe('Hooks run by env_reset.').optional(),
  vars: z.record(z.string(), z.string()).describe('Variables shared by every scenario ({{vars.x}}).').optional(),
  mailbox: z
    .strictObject({
      provider: z.enum(['mailpit', 'http']).describe('mailpit: the Mailpit API; http: the generic JSON shape (see the README).'),
      url: httpUrl().describe('Base URL of the mailbox API, e.g. http://localhost:8025 (its host must be allowed).'),
      poll_ms: z.number().int().min(100).max(10_000).describe('Polling interval in ms (default 500).').optional(),
      headers: z
        .record(z.string(), z.string())
        .describe('Extra request headers, e.g. an API token ({{env:VAR}} references are expanded).')
        .optional(),
    })
    .describe('Test mailbox read by wait_for_email (Mailpit or a generic HTTP JSON API).')
    .optional(),
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
    .describe('Defaults of the raw capture export for editors (studio export-capture, studio run --raw).')
    .optional(),
};

/** project.yaml as written (defaults not applied). */
export const ProjectFileSchema = z
  .strictObject(projectShape)
  .meta({ id: 'Project', title: 'Demo Studio project', description: 'projects/<slug>/project.yaml' });

/** ProjectConfig after defaults (what loadProject returns). */
export const ProjectConfigSchema = z.strictObject({
  ...projectShape,
  environments: projectShape.environments.unwrap(),
  capture: CaptureSettingsSchema,
  frame: FrameSpecSchema,
  template: nonEmpty(),
});

/** studio.yaml at the workspace root. */
export const WorkspaceFileSchema = z
  .strictObject({
    projects_dir: nonEmpty().describe('Projects directory, relative to the workspace root (default "projects").').optional(),
    templates_dir: nonEmpty().describe('Templates directory, relative to the workspace root (default "templates").').optional(),
    components_dir: nonEmpty()
      .describe('Workspace components directory (<namespace>/<name>/component.yaml), relative to the workspace root (default "components").')
      .optional(),
    browser: BrowserConfigSchema.optional(),
    ffmpeg: nonEmpty().describe('ffmpeg binary (default: "ffmpeg" on PATH).').optional(),
  })
  .meta({ id: 'Workspace', title: 'Demo Studio workspace', description: 'studio.yaml' });
