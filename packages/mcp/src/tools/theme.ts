import { z } from 'zod';
import type { TemplateDetail, TemplateSummary } from '@demo-studio/engine';
import { projectSlug, templateName } from '../schema.js';
import { plural } from '../result.js';
import { PREVIEW_JOB, READ, defineTool } from './define.js';
import type { ToolContext, ToolDef } from './define.js';
import { previewOutput } from './preview.js';
import { waitS } from './run.js';

function themeLine(t: TemplateSummary): string {
  const picks = Object.entries(t.components)
    .filter(([k]) => ['intro', 'layout', 'caption', 'card', 'interstitial', 'outro', 'transition'].includes(k))
    .map(([k, v]) => `${k} ${v ?? 'none'}`)
    .join(', ');
  return `- ${t.name} (${t.source}${t.default ? ', the project\'s theme' : ''}${t.style_bias ? `, ${t.style_bias}` : ''})${picks ? `: ${picks}` : ''}${t.issues.length ? ` — ${plural(t.issues.length, 'issue')}` : ''}`;
}

function detailSummary(d: TemplateDetail): string {
  const resolved = Object.entries(d.resolved)
    .map(([k, v]) => `${k}: ${v ? `${v.id}${Object.keys(v.params).length ? ` ${JSON.stringify(v.params)}` : ''}` : 'none'}`)
    .join('\n  ');
  return [
    `theme ${d.name} (${d.source}${d.default ? ', the project\'s theme' : ''}) in ${d.dir}`,
    `colours: ${Object.entries(d.colors).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `components:\n  ${resolved}`,
    ...(d.issues.length ? [`issues: ${d.issues.join('; ')}`] : []),
    'template.yaml is in "yaml" (read only through this server: a human edits themes). template_preview shows it.',
  ].join('\n');
}

export const templateList = defineTool({
  name: 'template_list',
  title: 'List themes',
  description:
    'Themes (templates) a render can use, by name: the workspace\'s templates/ and the starter themes shipped with Demo Studio (default, editorial, motion), each with the component it picks per kind (intro, layout, caption, card, interstitial, outro, transition). With project: which theme is the project\'s own. With template: that theme in detail — template.yaml, colours, fonts, brand, asset files and each kind\'s component with its params. A theme is switched per render (render {template}) or per scenario (video.template), always by name; themes are read only here (a human edits them).',
  input: z.strictObject({
    project: projectSlug.optional().describe('Mark this project\'s theme (and list its own theme folder, when project.yaml names one).'),
    template: templateName.optional().describe('Return this theme in detail instead of the list.'),
  }),
  annotations: READ,
  async run({ project, template }, { engine }) {
    if (template !== undefined) {
      const d = await engine.templates.get({ template, ...(project ? { project } : {}) });
      return { summary: detailSummary(d), data: d as unknown as Record<string, unknown> };
    }
    const v = await engine.templates.list(project ? { project } : {});
    return {
      summary: [`${plural(v.templates.length, 'theme')}${v.project_theme ? ` (project theme: ${v.project_theme})` : ''}:`, ...v.templates.map(themeLine), 'Details: template_list {template}; stills: template_preview {project, template}.'].join('\n'),
      data: v as unknown as Record<string, unknown>,
    };
  },
});

export const templatePreview = defineTool({
  name: 'template_preview',
  title: 'Preview a theme',
  description:
    'Stills of a theme as a render would show it: its intro, its layout with its caption over a neutral sample screen, a card, an interstitial and its outro (960×540 each), rendered by a job in the background into <workspace>/.demo-studio/previews/<id>/. Waits up to wait_s (default 20): when it finishes in time the stills come back as images (a few inline, the rest as files), else follow it with job_status {job_id, wait_s} which returns them. Default theme: the project\'s. The previews load nothing from the network.',
  input: z.strictObject({
    project: projectSlug.describe('Project whose theme is the default (and whose context the theme is resolved in).'),
    template: templateName.optional().describe('Theme to preview (template_list names them); default the project\'s own.'),
    wait_s: waitS(20, 'the stills'),
  }),
  annotations: PREVIEW_JOB,
  async run({ project, template, wait_s }, ctx: ToolContext) {
    const sub = await ctx.engine.templates.preview({ project, ...(template ? { template } : {}) });
    return previewOutput(ctx.engine, sub, wait_s, ctx, `preview of the ${sub.theme} theme submitted (job ${sub.job.id}): ${sub.targets.length} stills.`);
  },
});

export const THEME_TOOLS: ToolDef[] = [templateList, templatePreview];
