/**
 * `preview` jobs (L3.2, R-MCP-11 / R-MCP-15): stills of one component (component_preview: its manifest's preview
 * samples, or the slot values and params the client gives) or of a theme (template_preview: the theme's own intro,
 * layout with its caption over a sample screen, card, interstitial and outro), rendered by the jobs worker with the
 * editor's `renderComponentPreviews` — one bundle, one browser, guarded like a render (network-guard.ts).
 *
 * The images go to <workspace>/.demo-studio/previews/<preview_id>/ only (`outDir`): a component folder (its committed
 * preview.png, preview.json, README block) is never written — that stays `studio components preview`. Checked at submit
 * and again by the worker: the theme is a name (or the project's own), its files lie in its folder; the component is
 * one of the registry; slot values only for text slots (text, url, color — file and media slots keep their samples);
 * params valid against the component's schema. A preview counts nothing in the history. The editor is imported lazily.
 */
import { join } from 'node:path';
import { JOB_INPUT_VERSION } from '@demo-studio/core';
import type { ComponentKind, LoadedTemplate, PreviewJobInput, WorkspaceConfig } from '@demo-studio/core';
import type { ComponentRegistry } from '@demo-studio/components';
import type { BrowserProcessInfo, PreviewComponentTarget } from '@demo-studio/editor';
import { checkComponentId, components, workspaceRegistry } from '../components.js';
import { EngineError, toEngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { themeAssetProblems, themeForWork } from '../templates.js';
import { newJobId } from './ids.js';
import { editor } from './render-job.js';
import type { SubmitContext } from './run-job.js';
import type { JobEventBody, JobProgress, JobRecord, PreviewJobResult } from './types.js';

/** The kinds a theme preview shows, in order (R-MCP-11). */
export const THEME_PREVIEW_KINDS: readonly ComponentKind[] = ['intro', 'layout', 'card', 'interstitial', 'outro'];

/** Slot types whose value a preview may take from a client: plain text. File and media slots keep their samples. */
const TEXT_SLOT_TYPES = new Set(['text', 'url', 'color']);

export interface PreviewRequest {
  project: string;
  /** A theme name; default the project's own theme. */
  template?: string;
  target: PreviewJobInput['target'];
}

/** <workspace>/.demo-studio/previews/<preview_id>/ */
export function previewDir(ws: WorkspaceConfig, previewId: string): string {
  return join(ws.root, '.demo-studio', 'previews', previewId);
}

/** The `studio components preview` command a human runs for (about) the same component preview. */
export function previewCommandLine(cli: string, r: { component: string; template?: string }): string {
  return [cli, 'components', 'preview', r.component, ...(r.template ? ['--theme', r.template] : []), '--out', '<folder>'].join(' ');
}

interface PreparedPreview {
  template: LoadedTemplate;
  registry: ComponentRegistry;
  targets: PreviewComponentTarget[];
  /** Theme kinds with no component (none shown). */
  skipped: ComponentKind[];
}

/** Check a preview's input and build its targets (submit, and again in the worker). EngineError invalid / refused / not_found. */
async function preparePreview(ws: WorkspaceConfig, req: Pick<PreviewJobInput, 'project' | 'template' | 'target'>): Promise<PreparedPreview> {
  checkProjectSlug(req.project);
  const project = await openProjectBySlug(ws, req.project);
  const template = await themeForWork(project, req.template);
  const assets = themeAssetProblems(template);
  if (assets.length) throw new EngineError('refused', `${assets.join('; ')}: through MCP a theme serves only its own files`, { details: { problems: assets } });
  const registry = await workspaceRegistry(ws);
  const lib = await components();
  const targets: PreviewComponentTarget[] = [];
  const skipped: ComponentKind[] = [];
  const t = req.target;
  if (t.kind === 'component') {
    checkComponentId(t.component);
    let info;
    try {
      info = registry.get(t.component);
    } catch (e) {
      throw toEngineError(e);
    }
    const m = info.manifest;
    const problems: string[] = [];
    for (const [name, value] of Object.entries(t.slots ?? {})) {
      const spec = m.slots[name];
      if (!spec) problems.push(`slots.${name}: ${t.component} has no slot "${name}" (slots: ${Object.keys(m.slots).join(', ') || 'none'})`);
      else if (!TEXT_SLOT_TYPES.has(spec.type)) problems.push(`slots.${name}: a ${spec.type} slot keeps its preview sample (only text, url and color slots take a value here)`);
      else if (typeof value !== 'string' || value.includes('\0') || value.length > 2000) problems.push(`slots.${name}: a text of at most 2000 characters`);
    }
    if (t.params !== undefined) {
      const schema = (m.params ?? { type: 'object', properties: {} }) as Parameters<typeof lib.validateParamValue>[0];
      const merged = lib.applyParamDefaults(schema, { ...((m.preview?.params as Record<string, unknown> | undefined) ?? {}), ...t.params });
      for (const i of lib.validateParamValue(schema, merged, ['params'])) problems.push(`${i.path.join('.')}: ${i.message}`);
    }
    if (problems.length) throw new EngineError('invalid', `component_preview of ${t.component}: ${problems.join('; ')}`, { details: { problems } });
    targets.push({
      id: m.id,
      dir: info.dir,
      entry: info.entry,
      manifest: m,
      ...(t.slots ? { slots: t.slots } : {}),
      ...(t.params ? { params: t.params } : {}),
      ...(t.at_s !== undefined ? { at: t.at_s } : {}),
      file: `${m.id.replace('/', '__')}.png`,
    });
  } else {
    let theme;
    try {
      theme = registry.resolveTheme(template.template);
    } catch (e) {
      throw toEngineError(e);
    }
    for (const kind of THEME_PREVIEW_KINDS) {
      const rc = theme[kind];
      if (!rc) {
        skipped.push(kind);
        continue;
      }
      const info = registry.get(rc.id);
      targets.push({ id: rc.id, dir: info.dir, entry: info.entry, manifest: rc.manifest, params: rc.params, file: `${kind}.png` });
    }
  }
  return { template, registry, targets, skipped };
}

/** Check and queue a `preview` job (images in .demo-studio/previews/<preview_id>/). */
export async function submitPreviewJob(ctx: SubmitContext, req: PreviewRequest): Promise<{ job: JobRecord; preview_id: string; theme: string; targets: string[]; skipped: ComponentKind[] }> {
  const prepared = await preparePreview(ctx.ws, req);
  const previewId = `p_${newJobId().slice(2)}`;
  const input: PreviewJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'preview',
    project: req.project,
    preview_id: previewId,
    target: req.target,
    ...(req.template !== undefined ? { template: req.template } : {}),
    submitted_by: ctx.client,
  };
  return { job: await ctx.queue.enqueue(input), preview_id: previewId, theme: prepared.template.name, targets: prepared.targets.map((t) => t.id), skipped: prepared.skipped };
}

export interface PreviewJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: PreviewJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  /** The preview browser runs: the worker records it (job folder, browser.json). */
  browser(b: BrowserProcessInfo): void;
}

/** Execute a `preview` job: the checks again, then `renderComponentPreviews` into the preview's folder, guarded. */
export async function executePreviewJob(ctx: PreviewJobContext): Promise<PreviewJobResult> {
  const { input } = ctx;
  const prepared = await preparePreview(ctx.ws, input);
  const ed = await editor();
  const dir = previewDir(ctx.ws, input.preview_id);
  const total = prepared.targets.length;
  ctx.progress({ steps_done: 0, steps_total: total, phase: 'bundling', fraction: 0, updated_at: new Date().toISOString() });
  let warnings: string[] = [];
  const done = await ed.renderComponentPreviews({
    root: ctx.ws.root,
    registry: prepared.registry,
    template: prepared.template,
    targets: prepared.targets,
    outDir: dir,
    network: 'guard',
    signal: ctx.signal,
    onBrowser: (b) => ctx.browser(b),
    onWarnings: (w) => (warnings = w),
    onProgress: (n, of) =>
      ctx.progress({ steps_done: n, steps_total: of, phase: 'rendering', fraction: Math.round((0.2 + (0.8 * n) / Math.max(1, of)) * 1000) / 1000, updated_at: new Date().toISOString() }),
  });
  return {
    kind: 'preview',
    preview_id: input.preview_id,
    dir,
    theme: prepared.template.name,
    target: input.target.kind === 'component' ? { kind: 'component', component: input.target.component } : { kind: 'theme' },
    images: done.map((p, i) => {
      const t = prepared.targets[i];
      // A theme preview names each image by the kind it shows (the theme's intro, layout…).
      const kind = (input.target.kind === 'theme' ? (t.file ?? '').replace(/\.png$/, '') : t.manifest.kind) as ComponentKind;
      return { component: p.id, kind, file: p.file, at: p.at, bytes: p.bytes, ...(p.screen ? { screen: p.screen } : {}) };
    }),
    ...(prepared.skipped.length ? { skipped: prepared.skipped } : {}),
    untrusted: { warnings },
  };
}
