/**
 * The Remotion bundle of a render: a GENERATED entry + registry module importing the composition (src/remotion) and
 * the implementation of every component the plan uses (built-in library and workspace components alike, resolved by
 * the registry) plus the per-kind scaffolds (stand-ins for missing uses). Bundles are cached under
 * `<workspace>/.retake/cache/remotion-<hash>/`, the hash covering the composition sources, the kit, every
 * component folder bundled and the Remotion version: a render rebuilds only when one of them changed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_KINDS, bundleInfoOrNull } from '@retake/core';
import type { ComponentKind } from '@retake/core';
import {
  HASHED_FILE,
  MANIFEST_FILE,
  PREVIEW_ARTIFACTS,
  UNHASHED_DIRS,
  kitEntry,
  paramDefaults,
  parseManifest,
  scaffoldDir,
  unhashedFileProblem,
  unhashedImportMessage,
} from '@retake/components';
import type { ComponentRegistry, JsonSchemaNode } from '@retake/components';
import type { EditPlan } from '../plan-types.js';
import { usedComponentIds } from '../remotion/preview-mode.js';

/** Bump when the generated files or the bundle layout change (invalidates every cached bundle). 2: the CSP meta. */
export const BUNDLE_FORMAT = 2;

/**
 * The Content-Security-Policy of every render page (L3.2, network-guard.ts): fetch / XHR / EventSource may use http(s)
 * (a guarded render's CDP allow-list decides which), but no WebSocket leaves the page — CDP Fetch does not see
 * WebSockets. Only `connect-src`: images, fonts and media load as before.
 */
export const BUNDLE_CSP = "connect-src 'self' http: https: data: blob:";

/** index.html with the CSP meta as the first element of its head (pure; idempotent). */
export function withCspMeta(html: string): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${BUNDLE_CSP}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`;
}
/** Cached bundles kept per workspace (most recently used first). */
export const BUNDLE_CACHE_KEEP = 6;

/** packages/editor (this module lives in src/render or dist/render). */
export const EDITOR_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const require = createRequire(import.meta.url);

/** A component implementation to bundle. */
export interface BundleComponent {
  /** Component id, or `scaffolds/<kind>` for a stand-in. */
  id: string;
  kind: ComponentKind;
  /** Absolute component folder (hashed: every code file in it). */
  dir: string;
  /** Absolute implementation file. */
  entry: string;
  /** Params defaults of the manifest. */
  defaults: Record<string, unknown>;
  /** Stand-in of its kind (a scaffold). */
  scaffold?: boolean;
}

export interface RenderBundle {
  /** The bundle folder Remotion serves (selectComposition / renderMedia `serveUrl`). */
  serveUrl: string;
  /** Cache entry folder (`remotion-<hash>`). */
  dir: string;
  hash: string;
  /** True when the bundle came from the cache. */
  cached: boolean;
  /** Bundling time (0 on a cache hit). */
  ms: number;
  components: string[];
}

export interface EnsureBundleOptions {
  /** Workspace root: the cache lives in <root>/.retake/cache. */
  root: string;
  components: BundleComponent[];
  /** Override the cache folder (tests). */
  cacheDir?: string;
  /** Bundling progress 0..1 (not called on a cache hit). */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

/** The composition entry and every source file it pulls in (hashed). Sources when present, else the built JS. */
export function compositionFiles(): { root: string; files: string[] } {
  const src = join(EDITOR_DIR, 'src');
  const useSrc = existsSync(join(src, 'remotion', 'Root.tsx'));
  const base = useSrc ? src : join(EDITOR_DIR, 'dist');
  const ext = useSrc ? '.ts' : '.js';
  const remotionDir = join(base, 'remotion');
  const files = readdirSync(remotionDir)
    .filter((f) => (useSrc ? /\.tsx?$/.test(f) : /\.js$/.test(f)) && !f.endsWith('.d.ts'))
    .map((f) => join(remotionDir, f));
  for (const dep of COMPOSITION_DEPS) files.push(join(base, `${dep}${ext}`));
  return { root: join(remotionDir, useSrc ? 'Root.tsx' : 'Root.js'), files: files.sort() };
}

/** Modules outside src/remotion that the composition imports (relative to src/, without extension). */
export const COMPOSITION_DEPS = ['layout', 'util', 'plan-types', 'panes'] as const;

/** The kit folder (source when present, else built) and the files hashed for it. */
function kitFiles(): { entry: string; files: string[] } {
  const entry = kitEntry();
  if (!entry) throw new Error('the components kit is missing (packages/components/src/kit or dist/kit)');
  const dir = dirname(entry);
  const files = listFiles(dir).filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.map'));
  return { entry, files };
}

/** Every file under `dir` (sorted, absolute), skipping dot entries and the folders UNHASHED_DIRS names. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!UNHASHED_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The files of a component folder its content hash reads (sorted, absolute): code, manifest, own assets — never a dot
 * entry, node_modules / previews / dist, the generated preview files. The import rules (components
 * `unhashedFileProblem`, the same constants) refuse every other file, so the hash covers all a bundle loads of it.
 */
export function componentHashedFiles(dir: string): string[] {
  return listFiles(dir).filter((x) => HASHED_FILE.test(x) && !PREVIEW_ARTIFACTS.has(basename(x)));
}

function packageVersion(name: string): string {
  try {
    return (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * The cache key of a bundle: the format, the Remotion versions, the composition sources, the kit and every bundled
 * component folder (code files, manifest, own assets), by content.
 */
export async function bundleHash(components: readonly BundleComponent[]): Promise<string> {
  const h = createHash('sha256');
  const add = (label: string, data: string | Buffer) => {
    h.update(`${label}\0${data.length}\0`);
    h.update(data);
    h.update('\0');
  };
  add('format', String(BUNDLE_FORMAT));
  add('remotion', `${packageVersion('remotion')} ${packageVersion('@remotion/bundler')}`);
  const comp = compositionFiles();
  for (const f of comp.files) add(`composition:${relative(EDITOR_DIR, f).split(sep).join('/')}`, await readFile(f));
  const kit = kitFiles();
  for (const f of kit.files) add(`kit:${relative(dirname(kit.entry), f).split(sep).join('/')}`, await readFile(f));
  for (const c of [...components].sort((a, b) => a.id.localeCompare(b.id))) {
    add(`component:${c.id}:entry`, relative(c.dir, c.entry).split(sep).join('/'));
    add(`component:${c.id}:defaults`, JSON.stringify(c.defaults));
    for (const f of componentHashedFiles(c.dir)) add(`component:${c.id}:${relative(c.dir, f).split(sep).join('/')}`, await readFile(f));
  }
  return h.digest('hex').slice(0, 16);
}

let compositionMemo: { stamp: string; hash: string } | undefined;

/**
 * What every bundle shares, by content (16 hex): the bundle format, the Remotion versions, the composition sources and
 * the kit — the part of bundleHash that is not the components. A library preview's cache key (L4.7) covers it: a
 * change of the composition or the kit is a new preview. Memoised on the files' sizes and mtimes.
 */
export async function compositionHash(): Promise<string> {
  const comp = compositionFiles();
  const kit = kitFiles();
  const files = [...comp.files, ...kit.files];
  const stamp = files.map((f) => {
    const st = statSync(f);
    return `${f}:${st.size}:${st.mtimeMs}`;
  }).join('\n');
  if (compositionMemo?.stamp === stamp) return compositionMemo.hash;
  const h = createHash('sha256');
  const add = (label: string, data: string | Buffer) => {
    h.update(`${label}\0${data.length}\0`);
    h.update(data);
    h.update('\0');
  };
  add('format', String(BUNDLE_FORMAT));
  add('remotion', `${packageVersion('remotion')} ${packageVersion('@remotion/bundler')}`);
  for (const f of comp.files) add(`composition:${relative(EDITOR_DIR, f).split(sep).join('/')}`, await readFile(f));
  for (const f of kit.files) add(`kit:${relative(dirname(kit.entry), f).split(sep).join('/')}`, await readFile(f));
  const hash = h.digest('hex').slice(0, 16);
  compositionMemo = { stamp, hash };
  return hash;
}

/**
 * One component folder's content hash (16 hex): its entry, its defaults and every code file, manifest and own asset —
 * what bundleHash covers of it. The Studio's preview allow-list (L4.5 fixes) is keyed by it: an edited component is a
 * new hash, never run in the preview until it is allowed again.
 */
export async function componentFolderHash(c: Pick<BundleComponent, 'id' | 'dir' | 'entry' | 'defaults'>): Promise<string> {
  const h = createHash('sha256');
  const add = (label: string, data: string | Buffer) => {
    h.update(`${label}\0${data.length}\0`);
    h.update(data);
    h.update('\0');
  };
  add('id', c.id);
  add('entry', relative(c.dir, c.entry).split(sep).join('/'));
  add('defaults', JSON.stringify(c.defaults));
  for (const f of componentHashedFiles(c.dir)) add(relative(c.dir, f).split(sep).join('/'), await readFile(f));
  return h.digest('hex').slice(0, 16);
}

/** Source of the generated registry module (pure). */
export function registryModuleSource(components: readonly BundleComponent[]): string {
  const lines = ['// Generated by Retake: the component implementations of this render bundle. Do not edit.'];
  const own: string[] = [];
  const scaffolds: string[] = [];
  [...components]
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((c, i) => {
      const name = `c${i}`;
      lines.push(`import ${name} from ${JSON.stringify(c.entry.split(sep).join('/'))};`);
      const value = `{ component: ${name}, defaults: ${JSON.stringify(c.defaults)} }`;
      if (c.scaffold) scaffolds.push(`    ${JSON.stringify(c.kind)}: ${value},`);
      else own.push(`    ${JSON.stringify(c.id)}: ${value},`);
    });
  lines.push('', 'export const modules = {', '  components: {', ...own, '  },', '  scaffolds: {', ...scaffolds, '  },', '};', '');
  return lines.join('\n');
}

/** Source of the generated bundle entry (pure). */
export function entrySource(rootFile: string): string {
  return [
    '// Generated by Retake: the Remotion entry of this render bundle. Do not edit.',
    "import { registerRoot } from 'remotion';",
    `import { createRoot } from ${JSON.stringify(rootFile.split(sep).join('/'))};`,
    "import { modules } from './registry';",
    '',
    'registerRoot(createRoot(modules));',
    '',
  ].join('\n');
}

/** The ids of the components a plan uses (missing uses excluded: they render with the scaffold of their kind). */
export function planComponentIds(plan: EditPlan): string[] {
  return usedComponentIds(plan);
}

/** The per-kind scaffolds (stand-ins of `missing` uses), as bundle components. */
export async function scaffoldComponents(): Promise<BundleComponent[]> {
  const out: BundleComponent[] = [];
  for (const kind of COMPONENT_KINDS) {
    const dir = scaffoldDir(kind);
    const { manifest } = parseManifest(await readFile(join(dir, MANIFEST_FILE), 'utf8'), MANIFEST_FILE);
    if (!manifest) throw new Error(`the ${kind} scaffold has an invalid manifest (${dir})`);
    out.push({
      id: `scaffolds/${kind}`,
      kind,
      dir,
      entry: resolve(dir, manifest.entry ?? 'index.tsx'),
      defaults: paramDefaults(manifest.params as JsonSchemaNode | undefined),
      scaffold: true,
    });
  }
  return out;
}

/** The components to bundle for a plan: its component uses (looked up in the registry) and the scaffolds. */
export async function bundleComponentsFor(plan: EditPlan, registry: ComponentRegistry): Promise<BundleComponent[]> {
  const out: BundleComponent[] = [];
  for (const id of planComponentIds(plan)) {
    const info = registry.get(id);
    out.push({
      id,
      kind: info.manifest.kind,
      dir: info.dir,
      entry: info.entry,
      defaults: paramDefaults(info.manifest.params as JsonSchemaNode | undefined),
    });
  }
  out.push(...(await scaffoldComponents()));
  return out;
}

/**
 * Every usable component of the registry (built-in and workspace; folders that do not load are not listed) and the
 * per-kind scaffolds, as bundle components: the bundle of library previews (L4.7) — one per registry state, whatever
 * components a job shows.
 */
export async function registryBundleComponents(registry: ComponentRegistry): Promise<BundleComponent[]> {
  const out: BundleComponent[] = registry.list().map((info) => ({
    id: info.manifest.id,
    kind: info.manifest.kind,
    dir: info.dir,
    entry: info.entry,
    defaults: paramDefaults(info.manifest.params as JsonSchemaNode | undefined),
  }));
  out.push(...(await scaffoldComponents()));
  return out;
}

/** <root>/.retake/cache */
export function bundleCacheDir(root: string): string {
  return join(resolve(root), '.retake', 'cache');
}

async function isComplete(dir: string): Promise<boolean> {
  return existsSync(join(dir, 'bundle.json')) && existsSync(join(dir, 'bundle', 'index.html'));
}

/** Keep the BUNDLE_CACHE_KEEP most recently used bundles; drop abandoned temporary folders older than an hour. */
async function pruneCache(cacheDir: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }
  const done: Array<{ dir: string; t: number }> = [];
  for (const name of entries) {
    if (!name.startsWith('remotion-')) continue;
    const dir = join(cacheDir, name);
    if (name.includes('.tmp-')) {
      const st = await stat(dir).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600_000) await rm(dir, { recursive: true, force: true });
      continue;
    }
    const st = await stat(join(dir, 'bundle.json')).catch(() => null);
    done.push({ dir, t: st?.mtimeMs ?? 0 });
  }
  done.sort((a, b) => b.t - a.t);
  for (const d of done.slice(BUNDLE_CACHE_KEEP)) if (d.dir !== keep) await rm(d.dir, { recursive: true, force: true });
}

function abortError(): Error {
  const e = new Error('render cancelled');
  e.name = 'AbortError';
  return e;
}

/** The path with symbolic links resolved (a missing tail is kept as written under its real parent). */
function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realPathOf(parent), basename(p));
  }
}

function within(dir: string, file: string): string | undefined {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined;
}

/**
 * Why a file the render bundler loaded is outside the bundle hash, or undefined (pure but for real paths). A file in a
 * bundled component's folder must be one componentHashedFiles reads; a file in the folders holding workspace / built-in
 * components (a namespace folder, `components/`) must belong to a component. Webpack follows imports with no rules of
 * its own (a planted node_modules there would win): this guard fails the bundle closed instead of caching code the hash
 * never saw (L4.7 review fix; the compile check and the Studio's player loader refuse the same imports).
 */
export function bundledFileProblem(file: string, components: readonly Pick<BundleComponent, 'id' | 'dir' | 'scaffold'>[]): string | undefined {
  const real = realPathOf(file.split('?')[0]);
  const dirs = components.map((c) => ({ c, dir: realPathOf(c.dir) }));
  for (const { c, dir } of dirs) {
    const rel = within(dir, real);
    if (rel === undefined) continue;
    const what = unhashedFileProblem(rel);
    return what ? `${c.id}: ${unhashedImportMessage(rel, what)}` : undefined;
  }
  for (const { c, dir } of dirs) {
    if (c.scaffold) continue;
    for (const holder of [dirname(dir), dirname(dirname(dir))]) {
      const rel = within(holder, real);
      if (rel !== undefined) return `the render bundle loaded ${rel} from the folder holding ${c.id}, but it belongs to no component (a planted node_modules?): not bundled`;
    }
  }
  return undefined;
}

interface GuardCompilation {
  errors: Error[];
  hooks: { finishModules: { tap(name: string, fn: (modules: Iterable<{ resource?: unknown }>) => void): void } };
}

/** The webpack plugin applying bundledFileProblem to every module of the bundle (each problem is a build error). */
export function componentFilesGuard(components: readonly Pick<BundleComponent, 'id' | 'dir' | 'scaffold'>[]): {
  apply(compiler: { hooks: { compilation: { tap(name: string, fn: (c: GuardCompilation) => void): void } } }): void;
} {
  const name = 'retake-component-files';
  return {
    apply(compiler) {
      compiler.hooks.compilation.tap(name, (compilation) => {
        compilation.hooks.finishModules.tap(name, (modules) => {
          for (const m of modules) {
            if (typeof m.resource !== 'string' || m.resource === '') continue;
            const problem = bundledFileProblem(m.resource, components);
            if (problem) compilation.errors.push(new Error(problem));
          }
        });
      });
    },
  };
}

/**
 * The places a render bundle may take a module from when Retake runs from an app bundle (L5.16 review A H1, the render
 * half): the app's Resources, the workspace and the bundle cache — never a `node_modules` folder above them. The
 * bundler walks every `node_modules` folder up to `/` like Node.js; a planted `/Applications/node_modules/<optional
 * peer>` (@remotion/studio names `@remotion/video-matting`, which the app does not hold) would otherwise be bundled into
 * the render page. One RegExp (webpack's `resolve.restrictions` must all match: a list of paths would mean all of them):
 * a module found elsewhere is not found, as it is without the planted folder. Real paths (webpack resolves links).
 */
export function renderBundleRestriction(roots: readonly string[]): RegExp {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const all = [...new Set(roots.flatMap((r) => [resolve(r), real(r)]))].map((r) => r.replace(/[/\\]+$/, ''));
  return new RegExp(`^(?:${all.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:[/\\\\]|$)`);
}

/**
 * The bundle for these components: from the cache when the hash matches, else bundled with @remotion/bundler into a
 * temporary folder renamed into place (concurrent renders never see a half-written bundle).
 */
export async function ensureBundle(opts: EnsureBundleOptions): Promise<RenderBundle> {
  const hash = await bundleHash(opts.components);
  const cacheDir = opts.cacheDir ? resolve(opts.cacheDir) : bundleCacheDir(opts.root);
  const dir = join(cacheDir, `remotion-${hash}`);
  const ids = opts.components.map((c) => c.id).sort();
  if (await isComplete(dir)) {
    const now = new Date();
    await utimes(join(dir, 'bundle.json'), now, now).catch(() => undefined);
    return { serveUrl: join(dir, 'bundle'), dir, hash, cached: true, ms: 0, components: ids };
  }
  if (opts.signal?.aborted) throw abortError();
  await mkdir(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `remotion-${hash}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const t0 = performance.now();
  try {
    await mkdir(join(tmp, 'src'), { recursive: true });
    const comp = compositionFiles();
    const kit = kitFiles();
    await writeFile(join(tmp, 'src', 'registry.ts'), registryModuleSource(opts.components));
    await writeFile(join(tmp, 'src', 'entry.ts'), entrySource(comp.root));
    const { bundle } = await import('@remotion/bundler');
    const nodeModules = [join(EDITOR_DIR, 'node_modules'), join(dirname(dirname(kit.entry)), '..', 'node_modules')];
    const app = bundleInfoOrNull();
    await bundle({
      entryPoint: join(tmp, 'src', 'entry.ts'),
      outDir: join(tmp, 'bundle'),
      rootDir: join(tmp, 'src'),
      enableCaching: false,
      ignoreRegisterRootWarning: true,
      onProgress: (p: number) => opts.onProgress?.(Math.max(0, Math.min(1, p / 100))),
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...((config.resolve?.alias as Record<string, string> | undefined) ?? {}),
            '@retake/components/kit$': kit.entry,
          },
          // Workspace sources import siblings as "./x.js" (NodeNext): try the TypeScript file first.
          extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
          modules: [...((config.resolve?.modules as string[] | undefined) ?? ['node_modules']), ...nodeModules],
          ...(app ? { restrictions: [renderBundleRestriction([app.root, opts.root, cacheDir])] } : {}),
        },
        plugins: [...(config.plugins ?? []), componentFilesGuard(opts.components) as never],
      }),
    });
    const index = join(tmp, 'bundle', 'index.html');
    await writeFile(index, withCspMeta(await readFile(index, 'utf8')));
    const ms = Math.round(performance.now() - t0);
    await writeFile(join(tmp, 'bundle.json'), `${JSON.stringify({ format: BUNDLE_FORMAT, hash, created_at: new Date().toISOString(), ms, components: ids }, null, 2)}\n`);
    try {
      await rename(tmp, dir);
    } catch (e) {
      // Another render finished the same bundle first: use it.
      await rm(tmp, { recursive: true, force: true });
      if (!(await isComplete(dir))) throw e;
    }
    await pruneCache(cacheDir, dir);
    if (opts.signal?.aborted) throw abortError();
    return { serveUrl: join(dir, 'bundle'), dir, hash, cached: false, ms, components: ids };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/** Cached bundles of a workspace (newest first). */
export function listCachedBundles(root: string): Array<{ dir: string; hash: string; mtimeMs: number }> {
  const cacheDir = bundleCacheDir(root);
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir)
    .filter((n) => n.startsWith('remotion-') && !n.includes('.tmp-') && existsSync(join(cacheDir, n, 'bundle.json')))
    .map((n) => ({ dir: join(cacheDir, n), hash: n.slice('remotion-'.length), mtimeMs: statSync(join(cacheDir, n, 'bundle.json')).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
