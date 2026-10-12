/**
 * Rendering component previews (R-CMP-12/13/14): `renderComponentPreviews` renders the ComponentPreview composition of
 * each component with a theme (the editorial theme for the committed previews) — one bundle, one asset server and one
 * browser for all of them (≈ 0.5 s per preview once the bundle is cached) — into `<component dir>/preview.png`
 * (960×540: the 1920×1080 frame at half scale; palette-quantised when the full-colour PNG would exceed 200 KB), its
 * sidecar `preview.json` (source hash: see @demo-studio/components `previewStatus`) and the generated block of the
 * component's README.md. With `outDir`, only the images are written there (`<outDir>/<namespace>/<name>.png`).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STARTER_TEMPLATES_DIR, loadTemplate } from '@demo-studio/core';
import type { LoadedTemplate } from '@demo-studio/core';
import {
  PREVIEW_FILE,
  PREVIEW_FORMAT,
  PREVIEW_MAX_BYTES,
  PREVIEW_META_FILE,
  PREVIEW_SIZE,
  componentSourceFiles,
  componentSourceHash,
  loadComponentRegistry,
  paramDefaults,
  themeTokens,
  writePreviewReadme,
} from '@demo-studio/components';
import type { ComponentManifest, ComponentRegistry, JsonSchemaNode, PreviewMeta } from '@demo-studio/components';
import { buildComponentPreview, loadPreviewSamples } from '../preview.js';
import type { BuiltPreview, PreviewSamples } from '../preview.js';
import { startAssetServer } from './asset-server.js';
import { renderBrowser } from './browser.js';
import { ensureBundle, scaffoldComponents } from './bundle.js';
import type { BundleComponent } from './bundle.js';
import { RenderError } from './types.js';

/** The starter templates shipped with Demo Studio (default, editorial, motion). */
export { STARTER_TEMPLATES_DIR };

/**
 * The theme of previews: a template of the workspace (name or path), else — for a bare name — the starter template of
 * that name shipped with Demo Studio (the committed previews use the starter `editorial`): `loadTemplate` falls back
 * to the starters itself.
 */
export async function loadPreviewTheme(nameOrDir: string, root: string): Promise<LoadedTemplate> {
  return loadTemplate(nameOrDir, root);
}

/** Composition id of component previews (see ../remotion/Root.tsx). */
export const PREVIEW_COMPOSITION = 'ComponentPreview';

/** A component to preview: a registry entry, a scaffold (`scaffolds/<kind>`) or any component folder. */
export interface PreviewComponentTarget {
  id: string;
  dir: string;
  entry: string;
  manifest: ComponentManifest;
}

export interface RenderPreviewsOptions {
  /** Workspace root (bundle cache). */
  root: string;
  targets: PreviewComponentTarget[];
  /** Theme of the previews (the committed built-in previews use the editorial theme). */
  template: LoadedTemplate;
  /** Context components (the theme's layout, caption, card) come from it (default: the workspace's). */
  registry?: ComponentRegistry;
  cacheDir?: string;
  /** Write only the images, to `<outDir>/<namespace>/<name>.png`, instead of updating the component folders. */
  outDir?: string;
  samples?: PreviewSamples;
  onProgress?: (done: number, total: number, id: string) => void;
}

export interface RenderedPreview {
  id: string;
  /** The image written. */
  file: string;
  bytes: number;
  /** Second shown. */
  at: number;
  screen?: string;
  /** Palette-quantised to stay under PREVIEW_MAX_BYTES. */
  quantized: boolean;
  /** Written in the component folder (without outDir). */
  meta?: PreviewMeta;
  readme?: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((ok) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0;
      ok({ code, stderr: String(stderr) });
    });
  });
}

/**
 * A 256-colour PNG of `src` (ffmpeg palettegen + paletteuse, light ordered dithering: no banding on the theme
 * gradients). Returns false when ffmpeg is not available.
 */
async function quantizePng(src: string, out: string): Promise<boolean> {
  const r = await run('ffmpeg', [
    '-v', 'error', '-y', '-i', src,
    '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-frames:v', '1', out,
  ]);
  return r.code === 0;
}

/** The bundle components of the previews: every component shown (targets + context) and the per-kind scaffolds. */
async function previewBundleComponents(targets: readonly PreviewComponentTarget[], ids: readonly string[], registry: ComponentRegistry): Promise<BundleComponent[]> {
  const out = new Map<string, BundleComponent>();
  for (const t of targets) {
    out.set(t.id, { id: t.id, kind: t.manifest.kind, dir: t.dir, entry: t.entry, defaults: paramDefaults(t.manifest.params as JsonSchemaNode | undefined) });
  }
  for (const id of ids) {
    if (out.has(id)) continue;
    const info = registry.get(id);
    out.set(id, { id, kind: info.manifest.kind, dir: info.dir, entry: info.entry, defaults: paramDefaults(info.manifest.params as JsonSchemaNode | undefined) });
  }
  return [...out.values(), ...(await scaffoldComponents())];
}

/** `<outDir>/<namespace>/<name>.png` for an id ("scaffolds/layout" → scaffolds/layout.png). */
function outFile(outDir: string, id: string): string {
  const [ns, name] = id.includes('/') ? id.split('/') : ['_', id];
  return join(resolve(outDir), ns, `${name}.png`);
}

/** Render the previews of `targets` with one theme (see the module comment). */
export async function renderComponentPreviews(opts: RenderPreviewsOptions): Promise<RenderedPreview[]> {
  if (opts.targets.length === 0) return [];
  const root = resolve(opts.root);
  const registry = opts.registry ?? (await loadComponentRegistry({ root }));
  const samples = opts.samples ?? loadPreviewSamples();
  const server = await startAssetServer();
  const tpl = opts.template;
  const tokens = themeTokens(tpl, {
    logo: server.urlFor(tpl.assets.logo),
    wordmark: tpl.assets.wordmark ? server.urlFor(tpl.assets.wordmark) : undefined,
    fonts: { display: server.urlFor(tpl.assets.display), body: tpl.assets.body.map((f) => server.urlFor(f)) },
  });
  const built: Array<{ target: PreviewComponentTarget; preview: BuiltPreview }> = [];
  let puppeteer: Awaited<ReturnType<typeof import('@remotion/renderer')['openBrowser']>> | undefined;
  const scratch = join(tmpdir(), `demo-studio-preview-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    for (const target of opts.targets) {
      try {
        built.push({ target, preview: buildComponentPreview({ target, template: tpl, tokens, registry, samples, sampleUrl: (f) => server.urlFor(f) }) });
      } catch (e) {
        throw new RenderError(`preview of ${target.id}: ${(e as Error).message}`);
      }
    }
    const ids = [...new Set(built.flatMap((b) => b.preview.components))];
    const bundle = await ensureBundle({ root, components: await previewBundleComponents(opts.targets, ids, registry), cacheDir: opts.cacheDir });
    const browser = renderBrowser();
    const { openBrowser, renderStill, selectComposition } = await import('@remotion/renderer');
    try {
      puppeteer = await openBrowser('chrome', { browserExecutable: browser.path, chromeMode: 'headless-shell', logLevel: 'error' });
    } catch (e) {
      throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${(e as Error).message.split('\n')[0]}`);
    }
    await mkdir(scratch, { recursive: true });
    const common = { chromeMode: 'headless-shell', logLevel: 'error', timeoutInMilliseconds: 60_000 } as const;
    const out: RenderedPreview[] = [];
    let done = 0;
    for (const { target, preview } of built) {
      const inputProps = { preview: preview.spec };
      const composition = await selectComposition({ ...common, serveUrl: bundle.serveUrl, id: PREVIEW_COMPOSITION, inputProps, puppeteerInstance: puppeteer, browserExecutable: browser.path });
      const raw = join(scratch, `${done}-raw.png`);
      await renderStill({
        ...common,
        composition,
        serveUrl: bundle.serveUrl,
        frame: preview.spec.frame,
        output: raw,
        imageFormat: 'png',
        scale: PREVIEW_SIZE.width / preview.spec.width,
        overwrite: true,
        inputProps,
        puppeteerInstance: puppeteer,
        browserExecutable: browser.path,
      });
      let image = raw;
      let quantized = false;
      if ((await stat(raw)).size > PREVIEW_MAX_BYTES) {
        const q = join(scratch, `${done}-q.png`);
        if (await quantizePng(raw, q)) {
          image = q;
          quantized = true;
        }
      }
      const bytes = (await stat(image)).size;
      if (bytes > PREVIEW_MAX_BYTES) {
        throw new RenderError(`preview of ${target.id} is ${Math.round(bytes / 1024)} KB, over ${PREVIEW_MAX_BYTES / 1024} KB${quantized ? ' even with 256 colours' : ' (ffmpeg is needed to reduce it)'}`);
      }
      if (opts.outDir) {
        const file = outFile(opts.outDir, target.id);
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, await readFile(image));
        out.push({ id: target.id, file, bytes, at: preview.at, ...(preview.screen ? { screen: preview.screen } : {}), quantized });
      } else {
        const file = join(target.dir, PREVIEW_FILE);
        const tmp = `${file}.tmp-${randomBytes(3).toString('hex')}`;
        await writeFile(tmp, await readFile(image));
        await rename(tmp, file);
        const files = componentSourceFiles(target.dir, target.manifest);
        const meta: PreviewMeta = {
          format: PREVIEW_FORMAT,
          component: target.id,
          version: target.manifest.version,
          kind: target.manifest.kind,
          theme: tpl.name,
          at: preview.at,
          ...(preview.screen ? { screen: preview.screen } : {}),
          files,
          source_hash: componentSourceHash(target.dir, files),
          image: { file: PREVIEW_FILE, width: PREVIEW_SIZE.width, height: PREVIEW_SIZE.height },
        };
        await writeFile(join(target.dir, PREVIEW_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
        const readme = await writePreviewReadme(target.dir, target.manifest, meta);
        out.push({ id: target.id, file, bytes, at: preview.at, ...(preview.screen ? { screen: preview.screen } : {}), quantized, meta, readme });
      }
      done++;
      opts.onProgress?.(done, built.length, target.id);
    }
    return out;
  } catch (e) {
    if (e instanceof RenderError) throw e;
    throw new RenderError(`component previews failed: ${(e as Error).message}`);
  } finally {
    await puppeteer?.close({ silent: true }).catch(() => undefined);
    await server.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
