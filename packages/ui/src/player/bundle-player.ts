/**
 * The preview bundle (L4.5, DESIGN §4g; critiques B3, B11): esbuild, in memory, one classic IIFE script for the
 * sandboxed preview frame — the Remotion Player, DemoVideo (the render's own composition, src/remotion) and EVERY
 * component of the workspace (built-in and workspace components, plus the per-kind scaffolds), so a switch in the
 * Studio never rebuilds it — and `boot.js`, the frame's first script (boot.ts).
 *
 * - Lazy components (B3): the generated `ds:modules` maps each component id to `() => import(entry)`; esbuild turns each
 *   into a lazily initialised module inside the one IIFE. Nothing a component's module does runs before the frame
 *   asks for it (the plan uses it), and a module that throws rejects its own import only.
 * - Import allow-list (B11), because a workspace component is code an agent may write: a component may import only
 *   files inside its own folder (compile.ts `importProblem`, the rule `studio components` checks), `react`, `remotion`
 *   and the kit — bare imports resolved from this package, never from the component's folder (no planted
 *   node_modules). Each of its files is then loaded by this plugin: real path inside the component's real folder (a
 *   link out of it is refused), opened without following a link, a regular file of at most 1 MB, a code or JSON
 *   extension (no text, file or data-URL loader): an outside file cannot be inlined into the bundle the frame gets.
 *   The composition, the kit and the frame import their own sources and a short list of packages.
 * - A component that breaks a rule or does not compile is excluded (one retry without it): its uses draw with their
 *   kind's scaffold, and `excluded` says why (worded with its id, never its folder).
 * - A WORKSPACE component is bundled only once the person allowed it in this Studio session (review A H1 c; the
 *   Studio's PreviewAllowList, by id and folder content hash): until then it is `held` — not in the bundle at all, its
 *   uses drawn with their kind's scaffold. Built-in components and the scaffolds are always bundled.
 * - Memo (PlayerBundles): keyed by a hash of the render bundle's inputs (editor `bundleHash`: composition, kit, every
 *   component folder by content, Remotion's version), the frame's sources and the Player's version; at most two
 *   bundles, in memory only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, Plugin } from 'esbuild';
import { readPlainFile } from '@demo-studio/core';
import type { ComponentRegistry, JsonSchemaNode } from '@demo-studio/components';
import type { BundleComponent } from '@demo-studio/editor';
import { UI_TARGETS } from '../bundle.js';

/** Bump when the generated modules or the frame's layout change. 2: `held`. */
export const PLAYER_BUNDLE_FORMAT = 2;
/** Largest component file the preview bundles. */
export const COMPONENT_FILE_MAX = 1024 * 1024;
/** Bundles kept in memory. */
export const PLAYER_BUNDLES_KEEP = 2;

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/** The frame's sources (always the TypeScript sources: they ship with the package). */
export const PLAYER_DIR = join(PACKAGE_DIR, 'src', 'player');
export const FRAME_ENTRY = join(PLAYER_DIR, 'frame-main.tsx');
export const BOOT_ENTRY = join(PLAYER_DIR, 'boot.ts');
const FRAME_SOURCES = ['boot.ts', 'frame-main.tsx', 'protocol.ts'];

const KIT_MODULE = '@demo-studio/components/kit';
/** Bare modules a component may import (compile.ts ALLOWED_IMPORTS). */
const COMPONENT_BARE = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'remotion', KIT_MODULE]);
/** Bare modules the frame, the composition and the kit may import. */
const TRUSTED_BARE = new Set([...COMPONENT_BARE, 'react-dom', 'react-dom/client', '@remotion/player', '@remotion/lottie', 'lottie-web', 'scheduler', '@demo-studio/components', '@demo-studio/core']);
const COMPONENT_LOADERS: Readonly<Record<string, 'ts' | 'tsx' | 'js' | 'jsx' | 'json'>> = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.json': 'json' };
const TRUSTED_EXTENSIONS = new Set([...Object.keys(COMPONENT_LOADERS), '.cjs']);

export interface PlayerBundle {
  /** 16 hex: the inputs' hash (the frame reports it in `hello`). */
  hash: string;
  /** The frame's bundle (b.js). */
  js: Buffer;
  /** The frame's first script (boot.js). */
  boot: Buffer;
  /** Component ids in the bundle. */
  components: string[];
  /** Components left out, and why (no path: the id names it). */
  excluded: Array<{ id: string; why: string }>;
  /** Workspace components not allowed in this session (ids): not in the bundle. */
  held: string[];
  /** Build time (ms). */
  ms: number;
}

const require = createRequire(import.meta.url);

function playerVersion(): string {
  try {
    return (JSON.parse(readFileSync(require.resolve('@remotion/player/package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInside(file: string, dir: string): boolean {
  const r = relative(dir, file);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

const editor = () => import('@demo-studio/editor');

/** A workspace component as the allow-list sees it: its id, kind and folder content hash (16 hex). */
export interface WorkspaceComponent {
  id: string;
  kind: string;
  hash: string;
}

/** Decides whether a workspace component (id, folder content hash) is allowed in the preview. */
export type PreviewAllowed = (id: string, hash: string) => boolean;

const bundleComponentOf = async (info: ReturnType<ComponentRegistry['list']>[number]): Promise<BundleComponent> => {
  const { paramDefaults } = await import('@demo-studio/components');
  return { id: info.manifest.id, kind: info.manifest.kind, dir: info.dir, entry: info.entry, defaults: paramDefaults(info.manifest.params as JsonSchemaNode | undefined) };
};

/** The registry's workspace components with their folder content hash (editor componentFolderHash). */
export async function workspaceComponents(registry: ComponentRegistry): Promise<WorkspaceComponent[]> {
  const ed = await editor();
  const out: WorkspaceComponent[] = [];
  for (const info of registry.list()) {
    if (info.source !== 'workspace') continue;
    out.push({ id: info.manifest.id, kind: info.manifest.kind, hash: await ed.componentFolderHash(await bundleComponentOf(info)) });
  }
  return out;
}

/**
 * The components of a preview bundle and the per-kind scaffolds: every built-in component, and the workspace
 * components `allowed` (default: all of them — tests, and callers that build a bundle for themselves); `held`: the
 * workspace components left out.
 */
export async function playerComponentSet(registry: ComponentRegistry, allowed?: PreviewAllowed): Promise<{ components: BundleComponent[]; held: string[] }> {
  const ed = await editor();
  const components: BundleComponent[] = [];
  const held: string[] = [];
  for (const info of registry.list()) {
    const c = await bundleComponentOf(info);
    if (info.source === 'workspace' && allowed && !allowed(c.id, await ed.componentFolderHash(c))) held.push(c.id);
    else components.push(c);
  }
  components.push(...(await ed.scaffoldComponents()));
  return { components, held: held.sort() };
}

/** Every component of the registry (built-in and workspace) and the per-kind scaffolds, as bundle components. */
export async function playerComponents(registry: ComponentRegistry): Promise<BundleComponent[]> {
  return (await playerComponentSet(registry)).components;
}

/** The memo key of a bundle of these components (16 hex). */
export async function playerBundleHash(components: readonly BundleComponent[], held: readonly string[] = []): Promise<string> {
  const ed = await editor();
  const h = createHash('sha256');
  h.update(`format ${PLAYER_BUNDLE_FORMAT}\0player ${playerVersion()}\0inputs ${await ed.bundleHash(components)}\0held ${held.join(',')}\0`);
  for (const f of FRAME_SOURCES) h.update(`${f}\0`).update(readFileSync(join(PLAYER_DIR, f))).update('\0');
  return h.digest('hex').slice(0, 16);
}

/** Source of the generated `ds:modules` (pure). */
export function modulesSource(hash: string, components: readonly BundleComponent[], held: readonly string[] = []): string {
  const own = components.filter((c) => !c.scaffold).sort((a, b) => a.id.localeCompare(b.id));
  const scaffolds = components.filter((c) => c.scaffold).sort((a, b) => a.kind.localeCompare(b.kind));
  const load = (c: BundleComponent) => `() => import(${JSON.stringify(c.entry.split(sep).join('/'))})`;
  return [
    '// Generated by Demo Studio: the preview bundle\'s components, each loaded on first use. Do not edit.',
    `export const bundle = ${JSON.stringify(hash)};`,
    `export const held = ${JSON.stringify([...held])};`,
    'export const loaders = {',
    ...own.map((c) => `  ${JSON.stringify(c.id)}: ${load(c)},`),
    '};',
    'export const defaults = {',
    ...own.map((c) => `  ${JSON.stringify(c.id)}: ${JSON.stringify(c.defaults)},`),
    '};',
    'export const scaffolds = {',
    ...scaffolds.map((c) => `  ${JSON.stringify(c.kind)}: { load: ${load(c)}, defaults: ${JSON.stringify(c.defaults)} },`),
    '};',
    '',
  ].join('\n');
}

/** Source of the generated `ds:composition`: the render's own composition modules (pure). */
export function compositionSource(rootFile: string): string {
  const dir = dirname(rootFile).split(sep).join('/');
  const ext = rootFile.endsWith('.tsx') ? { tsx: '.tsx', ts: '.ts' } : { tsx: '.js', ts: '.js' };
  return [
    `export { DemoVideo } from ${JSON.stringify(`${dir}/DemoVideo${ext.tsx}`)};`,
    `export { ModulesContext } from ${JSON.stringify(`${dir}/modules${ext.ts}`)};`,
    `export { PreviewContext, usedComponentIds } from ${JSON.stringify(`${dir}/preview-mode${ext.ts}`)};`,
    '',
  ].join('\n');
}

interface Owner {
  id: string;
  realDir: string;
}

/**
 * Build the bundle of these components (every one of the workspace, see playerComponents). A component that breaks
 * the import rules or does not compile is excluded and the build retried once without it.
 */
export async function buildPlayerBundle(components: readonly BundleComponent[], o: { hash?: string; held?: readonly string[] } = {}): Promise<PlayerBundle> {
  const t0 = performance.now();
  const ed = await editor();
  const { kitEntry } = await import('@demo-studio/components');
  const kit = kitEntry();
  if (!kit) throw new Error('the components kit is missing');
  const held = [...(o.held ?? [])];
  const hash = o.hash ?? (await playerBundleHash(components, held));
  const composition = compositionSource(ed.compositionFiles().root);
  const excluded: Array<{ id: string; why: string }> = [];
  let set = [...components];
  for (let attempt = 0; ; attempt++) {
    const r = await buildOnce(set, hash, composition, kit, held);
    if (r.ok) {
      return { hash, js: r.js, boot: r.boot, components: set.filter((c) => !c.scaffold).map((c) => c.id).sort(), excluded, held, ms: Math.round(performance.now() - t0) };
    }
    if (attempt >= 1 || r.unowned) throw new Error(`the preview bundle did not build: ${r.unowned ?? r.byOwner.values().next().value ?? 'unknown error'}`);
    for (const [id, why] of r.byOwner) {
      const c = set.find((x) => x.id === id);
      if (c?.scaffold) throw new Error(`the preview bundle did not build: the ${c.kind} scaffold: ${why}`);
      excluded.push({ id, why });
    }
    set = set.filter((c) => !r.byOwner.has(c.id));
  }
}

type BuildOnce = { ok: true; js: Buffer; boot: Buffer } | { ok: false; byOwner: Map<string, string>; unowned?: string };

async function buildOnce(components: readonly BundleComponent[], hash: string, composition: string, kit: string, held: readonly string[]): Promise<BuildOnce> {
  const { build } = await import('esbuild');
  const owners: Owner[] = components.map((c) => ({ id: c.id, realDir: realPath(c.dir) })).sort((a, b) => b.realDir.length - a.realDir.length);
  const byId = new Map(owners.map((x) => [x.id, x]));
  const entryOwner = new Map(components.map((c) => [c.entry.split(sep).join('/'), c.id]));
  const ownerOf = (file: string): Owner | undefined => owners.find((x) => isInside(file, x.realDir));
  /** A component's words for one of its files: its id and the path inside its folder, never the folder. */
  const named = (owner: Owner, file: string) => `${owner.id}/${relative(owner.realDir, file).split(sep).join('/')}`;
  const fail = (owner: Owner, text: string) => ({ errors: [{ text, detail: owner.id }] });

  const plugin: Plugin = {
    name: 'demo-studio-preview',
    setup(b) {
      b.onResolve({ filter: /^ds:(modules|composition)$/ }, (args) => ({ path: args.path, namespace: 'ds' }));
      b.onLoad({ filter: /.*/, namespace: 'ds' }, (args) => ({ contents: args.path === 'ds:modules' ? modulesSource(hash, components, held) : composition, loader: 'js', resolveDir: PLAYER_DIR }));
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point' || (args.pluginData as { own?: boolean } | undefined)?.own) return undefined;
        const spec = args.path;
        let owner: Owner | undefined;
        if (args.namespace === 'ds') {
          const id = entryOwner.get(spec);
          if (id === undefined) {
            if (args.importer === 'ds:composition') return undefined;
            return { errors: [{ text: `the generated modules import ${basename(spec)}, which is no component entry` }] };
          }
          owner = byId.get(id);
        } else if (args.namespace === 'file') {
          owner = ownerOf(realPath(args.importer));
        }
        if (!owner) {
          // The frame, the composition, the kit, or a package's own files.
          if (spec === KIT_MODULE) return { path: kit };
          const inPackage = args.importer.split(sep).includes('node_modules');
          if (!inPackage && !spec.startsWith('.') && !isAbsolute(spec) && !TRUSTED_BARE.has(spec)) {
            return { errors: [{ text: `the preview does not bundle "${spec}" (imported by ${basename(args.importer)})` }] };
          }
          return undefined;
        }
        if (args.namespace !== 'ds') {
          const { importProblem } = await import('@demo-studio/components');
          const problem = importProblem(spec, args.resolveDir, owner.realDir);
          if (problem) return fail(owner, problem);
        }
        if (spec === KIT_MODULE) return { path: kit };
        if (COMPONENT_BARE.has(spec)) {
          // From this package, never from the component's folder (a planted node_modules would win there).
          const r = await b.resolve(spec, { kind: args.kind, resolveDir: PLAYER_DIR, pluginData: { own: true } });
          return r.errors.length > 0 ? fail(owner, r.errors[0].text) : { path: r.path };
        }
        const r = await b.resolve(spec, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { own: true } });
        if (r.errors.length > 0) return fail(owner, r.errors[0].text);
        return { path: r.path, pluginData: { component: owner.id } };
      });
      b.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
        const id = (args.pluginData as { component?: string } | undefined)?.component;
        if (id === undefined) {
          const owner = ownerOf(realPath(args.path));
          if (owner) return fail(owner, `${named(owner, realPath(args.path))} was reached outside its component's import rules`);
          if (!TRUSTED_EXTENSIONS.has(extname(args.path).toLowerCase())) return { errors: [{ text: `the preview does not bundle ${basename(args.path)}` }] };
          return undefined;
        }
        const owner = byId.get(id)!;
        const real = realPath(args.path);
        if (!isInside(real, owner.realDir)) return fail(owner, `${id}: an import leads out of the component folder (a link)`);
        const loader = COMPONENT_LOADERS[extname(real).toLowerCase()];
        if (!loader) return fail(owner, `${named(owner, real)}: only code and JSON files can be imported`);
        const read = readPlainFile(real, COMPONENT_FILE_MAX);
        if (!read.ok) return fail(owner, `${named(owner, real)}: ${read.reason === 'too_large' ? `over ${COMPONENT_FILE_MAX} bytes` : read.reason === 'link' ? 'a link' : 'not a readable regular file'}`);
        return { contents: read.bytes, loader, resolveDir: dirname(real) };
      });
    },
  };

  try {
    const out = await build({
      entryPoints: { b: FRAME_ENTRY, boot: BOOT_ENTRY },
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'iife',
      platform: 'browser',
      target: UI_TARGETS,
      minify: true,
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      legalComments: 'none',
      sourcemap: false,
      charset: 'utf8',
      logLevel: 'silent',
      absWorkingDir: PACKAGE_DIR,
      plugins: [plugin],
    });
    const js = out.outputFiles.find((f) => f.path.endsWith(`${sep}b.js`));
    const boot = out.outputFiles.find((f) => f.path.endsWith(`${sep}boot.js`));
    if (!js || !boot) return { ok: false, byOwner: new Map(), unowned: 'esbuild wrote no frame script' };
    return { ok: true, js: Buffer.from(js.contents), boot: Buffer.from(boot.contents) };
  } catch (e) {
    const errors = (e as { errors?: Message[] }).errors;
    if (!Array.isArray(errors)) throw e;
    const byOwner = new Map<string, string>();
    let unowned: string | undefined;
    for (const m of errors) {
      let owner = typeof m.detail === 'string' ? byId.get(m.detail) : undefined;
      if (!owner && m.location?.file) {
        const file = m.location.file.replace(/^file:/, '');
        owner = ownerOf(realPath(isAbsolute(file) ? file : resolve(PACKAGE_DIR, file)));
      }
      if (owner) {
        if (!byOwner.has(owner.id)) byOwner.set(owner.id, m.text.split('\n')[0].split(owner.realDir).join(owner.id).slice(0, 300));
      } else unowned ??= m.text.split('\n')[0].slice(0, 300);
    }
    return { ok: false, byOwner, ...(unowned !== undefined ? { unowned } : {}) };
  }
}

/** The bundles of this Studio (memo: at most PLAYER_BUNDLES_KEEP, by input hash; concurrent asks share one build). */
export class PlayerBundles {
  private readonly memo = new Map<string, Promise<PlayerBundle>>();
  /** Builds started (tests). */
  builds = 0;

  constructor(private readonly keep = PLAYER_BUNDLES_KEEP) {}

  /**
   * The bundle of the registry's components as they are now (re-hashed: an edited component file is a new bundle) —
   * with only the workspace components `allowed` (absent: all; the Studio passes its PreviewAllowList).
   */
  async get(registry: ComponentRegistry, allowed?: PreviewAllowed): Promise<PlayerBundle> {
    const { components, held } = await playerComponentSet(registry, allowed);
    const hash = await playerBundleHash(components, held);
    let p = this.memo.get(hash);
    if (p) {
      this.memo.delete(hash);
      this.memo.set(hash, p);
      return p;
    }
    this.builds++;
    p = buildPlayerBundle(components, { hash, held });
    this.memo.set(hash, p);
    p.catch(() => this.memo.delete(hash));
    while (this.memo.size > this.keep) this.memo.delete(this.memo.keys().next().value!);
    return p;
  }
}
