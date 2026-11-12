import { z } from 'zod';
import { COMPONENT_KINDS, KEY_RE } from '@retake/core';
import { componentId, projectSlug, templateName } from '../schema.js';
import { plural } from '../result.js';
import { PREVIEW_JOB, READ, WRITE_FILES, defineTool } from './define.js';
import type { ToolContext, ToolDef } from './define.js';
import { previewOutput } from './preview.js';
import { waitS } from '@retake/engine/contract';

const kind = z.enum(COMPONENT_KINDS as [string, ...string[]]);

export const componentList = defineTool({
  name: 'component_list',
  title: 'List components',
  description:
    'Components a theme or a render can use, by id: the workspace\'s components/ (they win over a built-in of the same id) and the built-in library (studio/…). Each with its kind (intro, outro, card, interstitial, caption, layout, overlay, transition), version, source, description, slot names and its committed preview image with whether it is fresh or stale. Registry notices list invalid or overriding components. Use an id in render {overrides: {components: {<kind or scene id>: <id>}}}; component_get has its slots and params.',
  input: z.strictObject({ kind: kind.optional().describe('Only components usable as this kind.') }),
  annotations: READ,
  async run({ kind: k }, { engine }) {
    const v = await engine.components.list(k);
    const lines = v.components.map((c) => `- ${c.id} (${c.kind}, ${c.source} ${c.version}): ${c.description.split('\n')[0].slice(0, 120)}${c.preview ? '' : ' — no preview'}`);
    return {
      summary: [
        `${plural(v.components.length, 'component')}${k ? ` usable as ${k}` : ''}:`,
        ...lines,
        ...(v.notices.length ? [`${plural(v.notices.length, 'registry notice')}: ${v.notices.map((n) => n.message).join('; ')}`] : []),
      ].join('\n'),
      data: v,
    };
  },
});

export const componentGet = defineTool({
  name: 'component_get',
  title: 'Read a component',
  description:
    'One component: its manifest (slots with their types, params as JSON Schema with defaults, duration, layout geometry, preview samples), the param values with defaults applied, its source files, README and committed preview. Read it before choosing params for a render or a preview. Component code is not edited through this server: the user (or you, with your own file tools when the user allows it) edits the files in its folder.',
  input: z.strictObject({ component: componentId }),
  annotations: READ,
  async run({ component }, { engine }) {
    const c = await engine.components.get(component);
    const slots = Object.entries(c.manifest.slots).map(([n, s]) => `${n} (${s.type}${s.required ? ', required' : ''})`);
    return {
      summary: [
        `${c.id}: ${c.kind} component (${c.source} ${c.version}) in ${c.dir}`,
        `slots: ${slots.join(', ') || 'none'}`,
        `params: ${Object.keys(c.param_defaults).length ? JSON.stringify(c.param_defaults) : 'none'}`,
        ...(c.preview ? [`preview: ${c.preview} (${c.preview_status})`] : []),
        ...(c.overrides_builtin ? ['it replaces the built-in component of the same id'] : []),
      ].join('\n'),
      data: c,
    };
  },
});

export const componentValidate = defineTool({
  name: 'component_validate',
  title: 'Validate a component',
  description:
    'Validate a component of the registry (workspace or built-in, valid or not): its component.yaml (schema, params JSON Schema and defaults, preview samples, geometry), the id matching its folder, the entry file, and a compile of the code with esbuild that allows only react, remotion and the kit (nothing is executed). Issues are positioned (file, line, col). Run it after a component\'s files were edited.',
  input: z.strictObject({ component: componentId }),
  annotations: READ,
  async run({ component }, { engine }) {
    const v = await engine.components.validate(component);
    return {
      summary: [
        `${v.id}: ${v.ok ? 'valid' : 'invalid'}${v.errors || v.warnings ? ` (${plural(v.errors, 'error')}, ${plural(v.warnings, 'warning')})` : ''} — ${v.dir}`,
        ...v.issues.slice(0, 20).map((i) => `${i.severity} ${(i as { file?: string }).file ?? ''}${i.line ? `:${i.line}${i.col ? `:${i.col}` : ''}` : ''} ${i.message}`),
        ...(v.issues.length > 20 ? [`… ${v.issues.length - 20} more in "issues"`] : []),
      ].join('\n'),
      data: v,
    };
  },
});

export const componentPreview = defineTool({
  name: 'component_preview',
  title: 'Preview a component',
  description:
    'A still of one component with a theme (default the project\'s) — over a neutral sample screen for layouts, captions, overlays and transitions — with its manifest\'s preview samples, or the slot values and params you give (text, url and color slots take a value; file and media slots keep their samples). Rendered by a job in the background into <workspace>/.retake/previews/<id>/ (960×540; never into the component\'s folder). Waits up to wait_s (default 20): when it finishes in time the still comes back as an image, else follow it with job_status {job_id, wait_s}. The preview loads nothing from the network: what a component tries to load is blocked and named under "untrusted".',
  input: z.strictObject({
    project: projectSlug.describe('Project whose theme is the default.'),
    component: componentId,
    template: templateName.optional().describe('Theme of the preview (template_list names them); default the project\'s own.'),
    slots: z
      .record(z.string().max(60).regex(KEY_RE, 'a slot name of the component'), z.string().max(2000))
      .refine((r) => Object.keys(r).length <= 30, 'at most 30 slots')
      .optional()
      .describe('Slot values (text, url and color slots) instead of the preview samples, e.g. {"title": "Quotes in two clicks"}.'),
    params: z
      .record(z.string().max(60), z.unknown())
      .refine((r) => JSON.stringify(r).length <= 8192, 'params of at most 8 KB')
      .optional()
      .describe('Params over the component\'s defaults (component_get lists them and their schema).'),
    at_s: z.number().min(0).max(600).optional().describe('Second of the component shown (default: its preview moment).'),
    wait_s: waitS(20, 'the still'),
  }),
  annotations: PREVIEW_JOB,
  async run({ project, component, template, slots, params, at_s, wait_s }, ctx: ToolContext) {
    const sub = await ctx.engine.components.preview({ project, component, ...(template ? { template } : {}), ...(slots ? { slots } : {}), ...(params ? { params } : {}), ...(at_s !== undefined ? { at_s } : {}) });
    return previewOutput(ctx.engine, sub, wait_s, ctx, `preview of ${component} with the ${sub.theme} theme submitted (job ${sub.job.id}).`);
  },
});

export const componentCreate = defineTool({
  name: 'component_create',
  title: 'Scaffold a component',
  description:
    'Scaffold a new workspace component, components/<namespace>/<name>/, from the template of its kind: component.yaml (manifest: slots, params, duration, preview samples), index.tsx (an implementation using the kit, theme tokens and frame-driven animation) and README.md, then validated. The id must not use the built-in "studio/" namespace or an id of a built-in component. This writes the tool\'s own scaffold only: the code is then edited by the user (or by you with your own file tools, when the user allows it) — never through this server. Follow with component_validate and component_preview.',
  input: z.strictObject({
    id: componentId.describe('New component id "namespace/name", e.g. acme/intro-split (not studio/…).'),
    kind: kind.describe('Its kind.'),
    description: z.string().min(1).max(500).describe('One or two sentences: what it looks like and when to use it (written into component.yaml and README.md as text).'),
    name: z.string().min(1).max(80).optional().describe('Display name (default from the id).'),
  }),
  annotations: WRITE_FILES,
  async run({ id, kind: k, description, name }, { engine }) {
    const c = await engine.components.create({ id, kind: k, description, ...(name ? { name } : {}) });
    return {
      summary: [
        `created ${c.kind} component ${c.id} in ${c.dir} (validated): ${c.files.map((f) => f.slice(c.dir.length + 1)).join(', ')}`,
        `next: the code is edited outside this server (the user, or your own file tools with the user's permission); then component_validate {component: "${c.id}"} and component_preview {project, component: "${c.id}"}`,
      ].join('\n'),
      data: c,
    };
  },
});

export const COMPONENT_TOOLS = [componentList, componentGet, componentValidate, componentPreview, componentCreate] as const satisfies readonly ToolDef[];
