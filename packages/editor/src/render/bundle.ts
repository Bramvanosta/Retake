/**
 * The Remotion bundle of a render: a GENERATED entry + registry module importing the composition (src/remotion) and
 * the implementation of every component the plan uses (built-in library and workspace components alike, resolved by
 * the registry) plus the per-kind scaffolds (stand-ins for missing uses). Bundles are cached under
 * `<workspace>/.demo-studio/cache/remotion-<hash>/`, the hash covering the composition sources, the kit, every
 * component folder bundled and the Remotion version: a render rebuilds only when one of them changed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_KINDS } from '@demo-studio/core';
import type { ComponentKind } from '@demo-studio/core';
import { MANIFEST_FILE, kitEntry, paramDefaults, parseManifest, scaffoldDir } from '@demo-studio/components';
import type { ComponentRegistry, JsonSchemaNode } from '@demo-studio/components';
import type { EditPlan, ResolvedComponent } from '../plan-types.js';

/** Bump when the generated files or the bundle layout change (invalidates every cached bundle). */
export const BUNDLE_FORMAT = 1;
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
  /** Workspace root: the cache lives in <root>/.demo-studio/cache. */
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

const SKIP_DIRS = new Set(['node_modules', 'previews', '.git', 'dist']);
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|json|css|ya?ml|svg|png|jpe?g|webp|woff2?|ttf|otf)$/i;
/** Generated files of a component folder that never change what it renders (regenerating them keeps the bundle). */
const PREVIEW_ARTIFACTS = new Set(['preview.png', 'preview.json']);

/** Every file under `dir` (sorted, absolute), skipping node_modules, previews and dotfiles. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
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
    for (const f of listFiles(c.dir).filter((x) => CODE_FILE.test(x) && !PREVIEW_ARTIFACTS.has(basename(x)))) add(`component:${c.id}:${relative(c.dir, f).split(sep).join('/')}`, await readFile(f));
  }
  return h.digest('hex').slice(0, 16);
}

/** Source of the generated registry module (pure). */
export function registryModuleSource(components: readonly BundleComponent[]): string {
  const lines = ['// Generated by Demo Studio: the component implementations of this render bundle. Do not edit.'];
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
    '// Generated by Demo Studio: the Remotion entry of this render bundle. Do not edit.',
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
  const ids = new Set<string>();
  const add = (rc: ResolvedComponent | null | undefined) => {
    if (rc && !rc.missing) ids.add(rc.id);
  };
  for (const s of plan.segments) {
    add(s.component);
    add(s.transition?.component);
    if (s.kind === 'clip') {
      add(s.caption);
      for (const o of s.overlays) add(o.component);
    }
  }
  add(plan.tutorial?.progress?.component);
  return [...ids].sort();
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

/** <root>/.demo-studio/cache */
export function bundleCacheDir(root: string): string {
  return join(resolve(root), '.demo-studio', 'cache');
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
            '@demo-studio/components/kit$': kit.entry,
          },
          // Workspace sources import siblings as "./x.js" (NodeNext): try the TypeScript file first.
          extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
          modules: [...((config.resolve?.modules as string[] | undefined) ?? ['node_modules']), ...nodeModules],
        },
      }),
    });
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
