/**
 * `preview` jobs (L3.2, R-MCP-11 / R-MCP-15): stills of one component (component_preview: its manifest's preview
 * samples, or the slot values and params the client gives) or of a theme (template_preview: the theme's own intro,
 * layout with its caption over a sample screen, card, interstitial and outro), rendered by the jobs worker with the
 * editor's `renderComponentPreviews` — one bundle, one browser, guarded like a render (network-guard.ts).
 *
 * The images go to <workspace>/.retake/previews/<preview_id>/ only (`outDir`): a component folder (its committed
 * preview.png, preview.json, README block) is never written — that stays `retake components preview`. Checked at submit
 * and again by the worker: the theme is a name (or the project's own), its files lie in its folder; the component is
 * one of the registry; slot values only for text slots (text, url, color — file and media slots keep their samples);
 * params valid against the component's schema. A preview counts nothing in the history. The editor is imported lazily.
 *
 * L4.7 `library` targets (the Studio library): posters and / or loops of up to 12 registry components in the job's theme
 * into the content-keyed cache of ../library.ts — refused under 1 GB free (at submit and in the worker), the worker's
 * own keys (a difference from the client's is reported, never trusted), cached keys skipped, failed keys left alone
 * unless `retry`, one whole-registry bundle (`bundle: 'registry'`: every library job shares it), items isolated (a
 * component that fails gets failed.json and the others go on), a full disk stops the job ("the disk has N MB free"),
 * the cache pruned at the end.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_INPUT_VERSION, PreviewJobInputSchema, newUlidId, statePath } from '@retake/core';
import type { ComponentKind, LoadedTemplate, PreviewJobInput } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import type { BrowserProcessInfo, LoopItem, PreviewBackend, PreviewComponentTarget, RenderedLoopItem } from '@retake/editor';
import { fileFacts } from '@retake/core/io';
import { stampOf } from '../clock.js';
import { checkComponentId, components, workspaceRegistry } from '../components.js';
import { EngineError, toEngineError } from '../errors.js';
import {
  LIBRARY_FILES,
  LIBRARY_PREVIEW_FORMAT,
  checkLibraryDisk,
  commitLibraryEntry,
  diskSentence,
  dropLibraryEntry,
  ensureLibraryCacheDir,
  failureIsCurrent,
  freeBytesOf,
  libraryCacheDir,
  libraryKeyContext,
  libraryPreviewKey,
  libraryReason,
  libraryStates,
  pruneLibraryCache,
  readLibraryEntry,
  stageLibraryEntry,
} from '../library.js';
import type { LibraryKeyContext, LibraryPreviewKind, LibraryStatesView } from '../library.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { themeAssetProblems, themeForWork } from '../templates.js';
import { withPreviewBackend } from '../render/editor-renderer.js';
import { diskFullWork, loopsWork, previewsWork } from '../render/work.js';
import type { Renderer } from '../render/renderer.js';
import type { SubmitContext } from './run-job.js';
import type { JobEventBody, JobProgress, JobRecord, LibraryEntryView, PreviewJobResult } from './types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';

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

/** <workspace>/.retake/previews/<preview_id>/ */
export function previewDir(ws: OpenedWorkspace, previewId: string): string {
  return statePath(ws.root, 'previews', previewId);
}

/** The `retake components preview` command a human runs for (about) the same component preview. */
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

/** The theme and registry of a preview: the project, the theme (a name or the project's own) serving only its own files. */
async function previewTheme(ws: OpenedWorkspace, req: Pick<PreviewJobInput, 'project' | 'template'>): Promise<{ template: LoadedTemplate; registry: ComponentRegistry }> {
  checkProjectSlug(req.project);
  const project = await openProjectBySlug(ws, req.project);
  const template = await themeForWork(project, req.template, fileFacts(ws.policy));
  const assets = themeAssetProblems(template);
  if (assets.length) throw new EngineError('refused', `${assets.join('; ')}: through MCP a theme serves only its own files`, { details: { problems: assets } });
  return { template, registry: await workspaceRegistry(ws) };
}

/**
 * The library states of a theme (engine `components.library`): keys and cache states of `components` (each one of the
 * registry; default all of it), computed with the worker's own key builder.
 */
export async function libraryStatesOf(ws: OpenedWorkspace, req: { project: string; template?: string; components?: readonly string[] }): Promise<LibraryStatesView> {
  const { template, registry } = await previewTheme(ws, req);
  if (req.components) {
    if (req.components.length > 500) throw new EngineError('invalid', 'at most 500 components at once');
    for (const id of req.components) {
      checkComponentId(id);
      if (!registry.has(id)) throw new EngineError('not_found', `component ${id} is not in the registry (component_list names them)`);
    }
  }
  return libraryStates(ws, await libraryKeyContext(template, registry, { policy: ws.policy }), req.components);
}

/** Check a preview's input and build its targets (submit, and again in the worker). EngineError invalid / refused / not_found. */
async function preparePreview(ws: OpenedWorkspace, req: Pick<PreviewJobInput, 'project' | 'template' | 'target'>): Promise<PreparedPreview> {
  const { template, registry } = await previewTheme(ws, req);
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
  } else if (t.kind === 'theme') {
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
  } else {
    // A library target: every component one of the registry (a scaffold or a folder never is).
    for (const item of t.items) {
      checkComponentId(item.component);
      let info;
      try {
        info = registry.get(item.component);
      } catch (e) {
        throw toEngineError(e);
      }
      targets.push({ id: info.manifest.id, dir: info.dir, entry: info.entry, manifest: info.manifest });
    }
  }
  return { template, registry, targets, skipped };
}

/** Check and queue a `preview` job (images in .retake/previews/<preview_id>/). */
export async function submitPreviewJob(ctx: SubmitContext, req: PreviewRequest): Promise<{ job: JobRecord; preview_id: string; theme: string; targets: string[]; skipped: ComponentKind[] }> {
  const previewId = newUlidId('preview');
  const input: PreviewJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'preview',
    project: req.project,
    preview_id: previewId,
    target: req.target,
    ...(req.template !== undefined ? { template: req.template } : {}),
    submitted_by: ctx.client,
  };
  if (req.target.kind === 'library') {
    // The shape first (at most 12 ids, keys of their form), before the registry is read.
    const parsed = PreviewJobInputSchema.safeParse(input);
    if (!parsed.success) throw new EngineError('invalid', `invalid library preview: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
  }
  const prepared = await preparePreview(ctx.ws, req);
  if (req.target.kind === 'library') await checkLibraryDisk(ctx.ws.root);
  return { job: await ctx.queue.enqueue(input), preview_id: previewId, theme: prepared.template.name, targets: prepared.targets.map((t) => t.id), skipped: prepared.skipped };
}

/** What the job runs with; its ports (`clock`, `stores`) are its composition root's, handed on by the job runner. */
export interface PreviewJobContext extends EnginePorts {
  ws: OpenedWorkspace;
  cli: string;
  input: PreviewJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  /** The preview browser runs: the worker records it (job folder, browser.json). */
  browser(b: BrowserProcessInfo): void;
  /** What the job renders with (the runner's: render/renderer.ts). */
  renderer: Renderer;
  /** In-process tests only (WorkerOptions.previewTest). */
  test?: PreviewJobTestHooks;
}

/**
 * In-process tests of library jobs: a stand-in for Remotion, and the free space the disk gate sees. `backend` draws a
 * library job's posters and loops in place of the worker's renderer's previews (render/editor-renderer.ts
 * withPreviewBackend). A worker is handed this or a whole renderer (WorkerOptions.ports.renderer), never both: runWorker
 * refuses the two together.
 */
export interface PreviewJobTestHooks {
  backend?: PreviewBackend;
  freeBytes?: (dir: string) => Promise<number | undefined>;
}

/** Execute a `preview` job: the checks again, then `renderComponentPreviews` into the preview's folder, guarded. */
export async function executePreviewJob(ctx: PreviewJobContext): Promise<PreviewJobResult> {
  const { input } = ctx;
  if (input.target.kind === 'library') return executeLibraryPreview(ctx, input.target);
  const prepared = await preparePreview(ctx.ws, input);
  const dir = previewDir(ctx.ws, input.preview_id);
  const total = prepared.targets.length;
  ctx.progress({ steps_done: 0, steps_total: total, phase: 'bundling', fraction: 0, updated_at: stampOf(ctx.clock) });
  let warnings: string[] = [];
  const done = await previewsWork({
    renderer: ctx.renderer,
    workPolicy: ctx.ws.policy,
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
      ctx.progress({ steps_done: n, steps_total: of, phase: 'rendering', fraction: Math.round((0.2 + (0.8 * n) / Math.max(1, of)) * 1000) / 1000, updated_at: stampOf(ctx.clock) }),
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

type LibraryTarget = Extract<PreviewJobInput['target'], { kind: 'library' }>;

/** One asked key of a library job, as the worker sees it. */
interface LibraryWant {
  component: string;
  kind: LibraryPreviewKind;
  key: string | null;
  expected: string;
  state?: LibraryEntryView['state'];
  /** Its temporary entry folder while it renders. */
  tmp?: string;
}

/** Execute a library job (see the module comment). */
async function executeLibraryPreview(ctx: PreviewJobContext, target: LibraryTarget): Promise<PreviewJobResult> {
  const { input, ws } = ctx;
  const freeBytes = ctx.test?.freeBytes ?? freeBytesOf;
  await checkLibraryDisk(ws.root, freeBytes);
  const { template, registry } = await previewTheme(ws, input);
  const keys: LibraryKeyContext = await libraryKeyContext(template, registry, { policy: ctx.ws.policy });
  const theme = { name: template.name, hash: keys.themeHash };
  const cacheDir = await ensureLibraryCacheDir(ws);
  const wants: LibraryWant[] = [];
  const failures: Array<{ component: string; reason: string }> = [];
  for (const item of target.items) {
    for (const kind of ['poster', 'loop'] as const) {
      const expected = item[kind];
      if (expected === undefined) continue;
      let key: string | null = null;
      if (registry.has(item.component)) key = await libraryPreviewKey(keys, item.component, kind);
      wants.push({ component: item.component, kind, key, expected, ...(key === null ? { state: 'not_found' as const } : {}) });
    }
  }
  for (const c of new Set(wants.filter((w) => w.key === null).map((w) => w.component))) failures.push({ component: c, reason: `${c} is not a component of the registry any more` });
  for (const w of wants) {
    if (w.key === null) continue;
    const have = await readLibraryEntry(cacheDir, w.key);
    if (have.state === 'cached') w.state = 'cached';
    else if (have.state === 'too_large') w.state = 'too_large';
    // A failure under the registry as it is now waits for a Retry; one under another registry state is stale (review
    // A M3 / B H1: maybe another component's) and is rendered again.
    else if (have.state === 'failed' && !target.retry && failureIsCurrent(have.failure, await keys.registryHash())) w.state = 'kept_failed';
    else if (have.state === 'failed') await dropLibraryEntry(cacheDir, w.key);
  }
  const todo = wants.filter((w) => w.state === undefined);
  const at = () => stampOf(ctx.clock);
  let bundle: { hash: string; cached: boolean } | null = null;
  let warnings: string[] = [];
  const cleanup = async () => {
    for (const w of todo) if (w.tmp) await rm(w.tmp, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const items: LoopItem[] = [];
    const byComponent = new Map<string, { poster?: LibraryWant; loop?: LibraryWant }>();
    for (const w of todo) {
      w.tmp = await stageLibraryEntry(cacheDir, w.key!);
      const slot = byComponent.get(w.component) ?? {};
      slot[w.kind] = w;
      byComponent.set(w.component, slot);
    }
    for (const [component, slot] of byComponent) {
      const info = registry.get(component);
      items.push({
        target: { id: info.manifest.id, dir: info.dir, entry: info.entry, manifest: info.manifest },
        ...(slot.poster ? { poster: join(slot.poster.tmp!, LIBRARY_FILES.poster) } : {}),
        ...(slot.loop ? { loop: join(slot.loop.tmp!, LIBRARY_FILES.loop) } : {}),
      });
    }
    const total = items.length;
    ctx.progress({ steps_done: 0, steps_total: total, phase: 'bundling', fraction: 0, updated_at: at() });
    if (items.length) {
      const commit = async (r: RenderedLoopItem) => {
        const slot = byComponent.get(r.id)!;
        if (slot.poster && r.poster) {
          await commitLibraryEntry(cacheDir, slot.poster.key!, slot.poster.tmp!, {
            meta: { format: LIBRARY_PREVIEW_FORMAT, key: slot.poster.key!, kind: 'poster', component: r.id, theme, at: at(), state: 'ok', bytes: r.poster.bytes, width: r.poster.width, height: r.poster.height },
          });
          slot.poster.state = 'written';
        }
        if (slot.loop && r.loop) {
          const l = r.loop;
          const meta =
            'too_large' in l
              ? ({ format: LIBRARY_PREVIEW_FORMAT, key: slot.loop.key!, kind: 'loop', component: r.id, theme, at: at(), state: 'too_large', bytes: l.bytes } as const)
              : ({ format: LIBRARY_PREVIEW_FORMAT, key: slot.loop.key!, kind: 'loop', component: r.id, theme, at: at(), state: 'ok', bytes: l.bytes, width: l.width, height: l.height, fps: l.fps, frames: l.frames, duration_s: l.duration_s } as const);
          await commitLibraryEntry(cacheDir, slot.loop.key!, slot.loop.tmp!, { meta });
          slot.loop.state = 'too_large' in l ? 'too_large' : 'written';
        }
      };
      const done = await loopsWork({
        renderer: ctx.test?.backend ? withPreviewBackend(ctx.renderer, ctx.test.backend) : ctx.renderer,
        workPolicy: ws.policy,
        root: ws.root,
        registry,
        template,
        items,
        bundle: 'registry',
        network: 'guard',
        signal: ctx.signal,
        onBrowser: (b) => ctx.browser(b),
        onItem: commit,
        onProgress: (n, of) =>
          ctx.progress({ steps_done: n, steps_total: of, phase: 'rendering', fraction: Math.round((0.2 + (0.8 * n) / Math.max(1, of)) * 1000) / 1000, updated_at: at() }),
      });
      bundle = done.bundle;
      warnings = done.warnings;
      for (const f of done.failed) {
        // Untrusted words (B16), the workspace's part of any path cut off (review A L2; the Studio shortens the rest).
        const reason = libraryReason(f.reason.split(`${ws.root}/`).join('').split(ws.root).join('.'));
        failures.push({ component: f.id, reason });
        const slot = byComponent.get(f.id);
        for (const w of [slot?.poster, slot?.loop]) {
          // A key already written (the poster, when the loop failed after it) stays as it is.
          if (!w || w.state) continue;
          // A fresh temporary folder becomes its failed.json entry (the editor removed the item's files).
          await rm(w.tmp!, { recursive: true, force: true });
          w.tmp = await stageLibraryEntry(cacheDir, w.key!);
          await commitLibraryEntry(cacheDir, w.key!, w.tmp, { failure: { format: LIBRARY_PREVIEW_FORMAT, key: w.key!, kind: w.kind, component: f.id, theme, at: at(), reason, bundle: await keys.registryHash() } });
          w.state = 'failed';
        }
      }
    }
  } catch (e) {
    await cleanup();
    if (await diskFullWork(e)) throw new EngineError('refused', diskSentence(await freeBytes(ws.root)), { details: { disk_full: true } });
    throw e;
  } finally {
    await cleanup();
    await pruneLibraryCache(cacheDir, { theme }).catch(() => undefined);
  }
  const changed = wants.filter((w) => w.key !== null && w.key !== w.expected).length;
  return {
    kind: 'preview',
    preview_id: input.preview_id,
    dir: libraryCacheDir(ws),
    theme: template.name,
    target: { kind: 'library' },
    images: [],
    library: {
      theme,
      entries: wants.map((w) => ({ component: w.component, kind: w.kind, key: w.key, state: w.state ?? 'failed', ...(w.key !== w.expected ? { expected: w.expected } : {}) })),
      changed,
      bundle,
    },
    untrusted: { warnings, ...(failures.length ? { failures } : {}) },
  };
}
