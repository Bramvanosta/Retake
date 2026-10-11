import { z } from 'zod';
import { HookStepSchema } from './hooks.js';
import { FrameSpecSchema, nonEmpty } from './primitives.js';
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
    'Default frame of every scenario (default card): raw, card, browser, laptop, phone or a layout component id "namespace/name".',
  ).optional(),
  template: nonEmpty().describe('Template name (templates/<name>) or a path relative to the project dir.').optional(),
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
    browser: BrowserConfigSchema.optional(),
    ffmpeg: nonEmpty().describe('ffmpeg binary (default: "ffmpeg" on PATH).').optional(),
  })
  .meta({ id: 'Workspace', title: 'Demo Studio workspace', description: 'studio.yaml' });
