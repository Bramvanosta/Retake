/**
 * The app bundle (L5.16, DESIGN §4p): where Retake finds its own tools when it runs from a staged tree or from
 * `Retake.app/Contents/Resources` — Node.js, the engine, the browsers, ffmpeg, the starter themes and the Claude plugin —
 * and the rules every resolver follows:
 *
 * - **Order:** an explicit setting (retake.yaml `ffmpeg`, `browser.executable`) → an explicit variable
 *   (`$RETAKE_FFMPEG`, `$RETAKE_FFPROBE`, `$RETAKE_CHROMIUM`, `$RETAKE_CHROMIUM_HEADLESS_SHELL`) → the bundle's own →
 *   the system's (PATH, Playwright's cache). In a repository checkout there is no bundle: every resolver answers what it
 *   answered before L5.16.
 * - **Discovery:** `bundle.json` (the stage step writes it) in exactly one folder, the one core's dist sits five
 *   folders below (`<root>/engine/node_modules/@retake/core/dist`; this module is in its `io/` folder), and only when its `paths.engine` holds this module
 *   at `node_modules/@retake/core/` — never a folder above the app, never a stray `bundle.json` above a checkout. A
 *   damaged manifest of this engine never throws at import: `bundleProblems()` names it (doctor), and every resolver
 *   that needs the bundle throws it (a damaged app says so instead of falling back to the system's tools).
 * - **Browsers:** playwright-core reads PLAYWRIGHT_BROWSERS_PATH once, when it loads. `prepareBundle()` (first thing in
 *   both entry points: the CLI's bin and the jobs worker's main) sets it to the bundle's browsers, loads playwright-core,
 *   and restores the inherited value — so it never reaches hooks, sandbox services, shells or workers.
 * - **Nothing writes inside the bundle** at run time (its signature seals every file): `assertOutsideBundle`.
 * - **The workspace's ffmpeg** (retake.yaml `ffmpeg`, made absolute against the workspace root when it names a path)
 *   comes first in resolveMediaTools; which ffmpeg and ffprobe a process runs, under the agent policy: media-tools.ts.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The manifest file of a bundle (in `Contents/Resources`, or the stage folder). */
export const BUNDLE_FILE = 'bundle.json';
/** How many folders above core's dist the manifest sits (`<root>/engine/node_modules/@retake/core/dist`). */
const BUNDLE_DEPTH = 5;
/** How many folders below core's dist (or src) this module sits: `io/`. */
const MODULE_DEPTH = 1;

/** `bundle.json`, as the stage step writes it (paths relative to the folder holding it). */
export interface BundleManifest {
  v: 1;
  /** The app's version (one number: package.json, RETAKE_VERSION, tauri.conf.json, Cargo.toml). */
  app: string;
  node: string;
  playwright: { core: string; chromium: string; headless_shell: string };
  compositor: string;
  /** null: the bundle has no ffmpeg of its own (the system's is used). `libx264`: whether it has that encoder. */
  ffmpeg: { version: string; licence: string; libx264: boolean; sha256: Record<string, string> } | null;
  /** Lowest macOS the bundle runs on (Remotion's own libraries need 15). */
  minimum_macos: string;
  paths: { node: string; engine: string; browsers: string; ffmpeg: string | null; templates: string; plugin: string };
}

/** A bundle found around the running engine: its folder, manifest and absolute paths. */
export interface BundleInfo {
  /** The folder holding bundle.json (`…/Retake.app/Contents/Resources`, or the stage folder). */
  root: string;
  /** What nothing may write inside: the `.app` around `root` when there is one, else `root`. */
  sealed: string;
  manifest: BundleManifest;
  paths: { node: string; engine: string; browsers: string; ffmpeg: string | null; templates: string; plugin: string };
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }

  /** What a client outside the CLI is told (core error-kind.ts; a literal: this module imports nothing but node:). */
  get errorKind(): 'internal' {
    return 'internal';
  }
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
}

/**
 * Whether `p` is `dir` or inside it — pathInside's lexical check (path-inside.ts, its options `{}`), kept here as a copy:
 * this module imports nothing but node: builtins (it is the first module of the app bundle; test/app-bundle.test.ts loads
 * it alone), and test/path-inside.test.ts pins this copy against pathInside.
 */
function within(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const PATH_KEYS = ['node', 'engine', 'browsers', 'ffmpeg', 'templates', 'plugin'] as const;

/**
 * Read and check `<dir>/bundle.json`: every path relative and inside `dir` (once links are followed); BundleError
 * otherwise. Exported for tests and the stage step's own check.
 */
export function readBundleManifest(dir: string): BundleInfo {
  const root = real(resolve(dir));
  let m: BundleManifest;
  try {
    m = JSON.parse(readFileSync(join(root, BUNDLE_FILE), 'utf8')) as BundleManifest;
  } catch (e) {
    throw new BundleError(`cannot read ${join(root, BUNDLE_FILE)}: ${(e as Error).message}`);
  }
  if (!m || typeof m !== 'object' || m.v !== 1 || !m.paths || typeof m.paths !== 'object') throw new BundleError(`${join(root, BUNDLE_FILE)} is not a version 1 bundle manifest`);
  const paths = {} as BundleInfo['paths'];
  for (const key of PATH_KEYS) {
    const rel = m.paths[key];
    if (rel === null && key === 'ffmpeg') {
      paths.ffmpeg = null;
      continue;
    }
    if (typeof rel !== 'string' || !rel || isAbsolute(rel)) throw new BundleError(`${BUNDLE_FILE}: paths.${key} must be a relative path inside the bundle`);
    const abs = real(resolve(root, rel));
    if (!within(root, abs)) throw new BundleError(`${BUNDLE_FILE}: paths.${key} (${rel}) leaves the bundle`);
    paths[key] = abs;
  }
  const contents = dirname(root);
  const app = dirname(contents);
  const sealed = basename(root) === 'Resources' && basename(contents) === 'Contents' && app.endsWith('.app') ? app : root;
  return { root, sealed, manifest: m, paths };
}

/** Does the engine folder `engine` hold `self` as `node_modules/@retake/core/…` (where a deployed core sits)? */
function holdsCore(engine: string, self: string): boolean {
  return within(join(engine, 'node_modules', '@retake', 'core'), self);
}

/**
 * The bundle `file` (this module of core, in `dist/io/`) belongs to, or null: `bundle.json` BUNDLE_DEPTH folders above
 * core's dist, when its `paths.engine` holds `file` at `node_modules/@retake/core/`. Nothing else is looked at (no walk up).
 * A manifest there that claims this engine but is broken throws (a damaged app must say so, not fall back to the
 * system's tools); one that does not claim it is ignored.
 */
export function findBundle(file: string, exists: (p: string) => boolean = existsSync): BundleInfo | null {
  const self = real(resolve(file));
  const dir = resolve(dirname(self), ...Array<string>(MODULE_DEPTH + BUNDLE_DEPTH).fill('..'));
  if (!exists(join(dir, BUNDLE_FILE))) return null;
  let info: BundleInfo | null = null;
  try {
    info = readBundleManifest(dir);
  } catch (e) {
    if (claimsEngine(dir, self)) throw e;
  }
  return info && holdsCore(info.paths.engine, self) ? info : null;
}

function claimsEngine(dir: string, self: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, BUNDLE_FILE), 'utf8')) as { paths?: { engine?: unknown } };
    return typeof m.paths?.engine === 'string' && !isAbsolute(m.paths.engine) && holdsCore(real(resolve(dir, m.paths.engine)), self);
  } catch {
    return false;
  }
}

let cached: BundleInfo | null | undefined;
const problems = new Set<string>();

/**
 * The bundle this engine runs from (cached), or null in a repository checkout. A damaged manifest of this engine
 * throws its BundleError on every call (and is kept for `bundleProblems`).
 */
export function bundleInfo(): BundleInfo | null {
  if (cached === undefined) {
    try {
      cached = findBundle(fileURLToPath(import.meta.url));
    } catch (e) {
      problems.add((e as Error).message);
      throw e;
    }
  }
  return cached;
}

/** bundleInfo() without the throw: null for a damaged bundle (its problem is in `bundleProblems`). */
export function bundleInfoOrNull(): BundleInfo | null {
  try {
    return bundleInfo();
  } catch {
    return null;
  }
}

/**
 * Which copy of Retake this engine is (L5.16c, critique M6): the `.app` it runs from (the sealed folder of its bundle),
 * else the repository checkout holding it (the first folder up with `pnpm-workspace.yaml`), else core's package folder.
 * The worker lock records it: a workspace's worker started by another copy (the app and a checkout, two apps) is said.
 */
export function engineLocation(bundle: BundleInfo | null = bundleInfoOrNull(), self: string = fileURLToPath(import.meta.url), exists: (p: string) => boolean = existsSync): string {
  if (bundle) return bundle.sealed;
  const start = dirname(real(self));
  for (let dir = start, i = 0; i < MODULE_DEPTH + 6; i++, dir = dirname(dir)) {
    if (exists(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) break;
  }
  return resolve(start, ...Array<string>(MODULE_DEPTH + 1).fill('..'));
}

/**
 * What is wrong with this engine's bundle, as far as this process has seen: a damaged manifest, a playwright-core that
 * would not load with the bundle's browsers. Empty in a sound bundle and in a checkout. Doctor shows them.
 */
export function bundleProblems(): string[] {
  bundleInfoOrNull();
  return [...problems];
}

/** Tests only: answer `b` from bundleInfo() (undefined: look again; the problems seen are forgotten). Values computed at load (STARTER_TEMPLATES_DIR) keep theirs. */
export function overrideBundleInfo(b: BundleInfo | null | undefined): void {
  cached = b;
  problems.clear();
}

/**
 * The module lookup guard of a bundle (relative to its root; apps/desktop/bundle/guard.cjs, staged by bundle.mjs): code
 * inside the bundle resolves bare specifiers inside it only, never from a `node_modules` folder above the app (DESIGN
 * §4p). Every Node.js the app starts gets it as an argument (`bundleNodeArgs`), never through NODE_OPTIONS.
 */
export const BUNDLE_GUARD = 'node/guard.cjs';

/**
 * The Node.js arguments that load the bundle's guard (`--require <root>/node/guard.cjs`), to put before the script of
 * every Node.js process started on the bundle's code (the jobs worker, the MCP registration); none in a checkout. A
 * bundle without its guard is damaged: BundleError.
 */
export function bundleNodeArgs(bundle: BundleInfo | null = bundleInfo(), exists: (p: string) => boolean = existsSync): string[] {
  if (!bundle) return [];
  const guard = join(bundle.root, BUNDLE_GUARD);
  if (!exists(guard)) throw new BundleError(`${guard} is missing: this copy of Retake is damaged — install it again from its disk image`);
  return ['--require', guard];
}

/** Is `p` inside the sealed bundle (links followed; a path that does not exist yet by its nearest existing folder)? */
export function insideBundle(p: string, bundle: BundleInfo | null = bundleInfo()): boolean {
  return !!bundle && within(bundle.sealed, real(resolve(p)));
}

/**
 * Refuse a write inside the bundle: the app's signature seals every file in it, and an update replaces it whole.
 * `what` names the write ("the component preview", "the workspace").
 */
export function assertOutsideBundle(p: string, what: string, bundle: BundleInfo | null = bundleInfo()): void {
  if (insideBundle(p, bundle)) {
    throw new BundleError(`refused: ${what} (${p}) lies inside the Retake app (${bundle!.sealed}), which nothing may write to — use a workspace folder of your own`);
  }
}

/**
 * Point playwright-core at the bundle's browsers for this process only (see the module comment). A no-op without a
 * bundle. Never throws (it runs first in both entry points): a damaged manifest, or a playwright-core that does not
 * load, is kept for `bundleProblems` (doctor) — a later import would otherwise quietly use the person's own Playwright
 * cache. `load` (tests) replaces the playwright-core import. First, the bundle's module lookup guard (BUNDLE_GUARD):
 * a process started the usual way already has it (`--require`: the launcher, the shell, the worker, the MCP
 * registration — Node.js keeps one copy of a module); one started on the bundle's code without it (the Claude plugin's
 * own .mcp.json names `node <cli>` only) gets it here, before playwright-core or the commands load. `guard` (tests)
 * replaces the require.
 */
export function prepareBundle(env: NodeJS.ProcessEnv = process.env, bundle?: BundleInfo | null, load?: () => unknown, guard: (file: string) => unknown = (f) => createRequire(import.meta.url)(f)): void {
  const b = bundle === undefined ? bundleInfoOrNull() : bundle;
  if (!b) return;
  const guardFile = join(b.root, BUNDLE_GUARD);
  try {
    if (!existsSync(guardFile)) throw new Error(`${guardFile} is missing`);
    guard(guardFile);
  } catch (e) {
    problems.add(`the app's module lookup guard does not load (${(e as Error).message.split('\n')[0]}): reinstall Retake`);
  }
  const KEY = 'PLAYWRIGHT_BROWSERS_PATH';
  const had = Object.prototype.hasOwnProperty.call(env, KEY);
  const before = env[KEY];
  env[KEY] = b.paths.browsers;
  try {
    if (load) load();
    else createRequire(join(b.paths.engine, 'package.json'))('playwright-core');
  } catch (e) {
    problems.add(`the app's playwright-core does not load (${(e as Error).message.split('\n')[0]}): its browsers are not used — reinstall Retake`);
  } finally {
    if (had) env[KEY] = before;
    else delete env[KEY];
  }
}

// ── ffmpeg / ffprobe ───────────────────────────────────────────────────────────

export type MediaToolSource = 'retake.yaml' | 'RETAKE_FFMPEG' | 'RETAKE_FFPROBE' | 'bundled' | 'PATH';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  ffmpegSource: MediaToolSource;
  ffprobeSource: MediaToolSource;
}

/** A relative path with a folder in it (`tools/ffmpeg`): it would resolve in each process's cwd (a worker's is the workspace). */
export function isRelativeToolPath(p: string): boolean {
  return !isAbsolute(p) && p.includes('/');
}

/**
 * ffmpeg and ffprobe, in the resolver order. ffmpeg: retake.yaml `ffmpeg` → `$RETAKE_FFMPEG` → the bundle's → `ffmpeg`
 * on PATH. ffprobe: beside retake.yaml's ffmpeg when one is there → `$RETAKE_FFPROBE` → beside `$RETAKE_FFMPEG` when one
 * is there → the bundle's → `ffprobe` on PATH (so a lone static ffmpeg in retake.yaml keeps the ffprobe found before).
 * A variable naming a relative path (`tools/ffmpeg`) is refused (BundleError): it would name another file in each
 * process (retake.yaml's is made absolute by loadWorkspaceConfig). Pure but for `exists` (tests, doctor).
 */
export function resolveMediaTools(o: { configured?: string | undefined; env?: NodeJS.ProcessEnv; bundle?: BundleInfo | null; exists?: (p: string) => boolean } = {}): MediaTools {
  const env = o.env ?? {};
  const exists = o.exists ?? existsSync;
  const configured = o.configured?.trim();
  const envFfmpeg = env.RETAKE_FFMPEG?.trim();
  const envFfprobe = env.RETAKE_FFPROBE?.trim();
  for (const [name, value] of [['RETAKE_FFMPEG', envFfmpeg], ['RETAKE_FFPROBE', envFfprobe]] as const) {
    if (value && isRelativeToolPath(value)) throw new BundleError(`$${name} (${value}) must be an absolute path or a command on PATH: a relative path names another file in each process`);
  }
  const bundled = o.bundle?.paths.ffmpeg ?? null;
  const beside = (ffmpeg: string | undefined): string | null => {
    if (!ffmpeg || !isAbsolute(ffmpeg)) return null;
    const f = join(dirname(ffmpeg), 'ffprobe');
    return exists(f) ? f : null;
  };
  const ffmpeg: [string, MediaToolSource] = configured
    ? [configured, 'retake.yaml']
    : envFfmpeg
      ? [envFfmpeg, 'RETAKE_FFMPEG']
      : bundled
        ? [join(bundled, 'ffmpeg'), 'bundled']
        : ['ffmpeg', 'PATH'];
  const besideConfigured = beside(configured);
  const besideEnv = beside(envFfmpeg);
  const ffprobe: [string, MediaToolSource] = besideConfigured
    ? [besideConfigured, 'retake.yaml']
    : envFfprobe
      ? [envFfprobe, 'RETAKE_FFPROBE']
      : besideEnv
        ? [besideEnv, 'RETAKE_FFMPEG']
        : bundled
          ? [join(bundled, 'ffprobe'), 'bundled']
          : ['ffprobe', 'PATH'];
  return { ffmpeg: ffmpeg[0], ffprobe: ffprobe[0], ffmpegSource: ffmpeg[1], ffprobeSource: ffprobe[1] };
}

/**
 * The starter themes: the bundle's, else the repository's `templates/` (three folders above core's dist or src). Never
 * throws (template.ts evaluates it at import): a damaged bundle gives the repository's path, which does not exist in
 * an app (doctor names the damage).
 */
export function starterTemplatesDir(bundle: BundleInfo | null = bundleInfoOrNull()): string {
  return bundle ? bundle.paths.templates : resolve(dirname(fileURLToPath(import.meta.url)), ...Array<string>(MODULE_DEPTH + 3).fill('..'), 'templates');
}

/** This process's engine against what is installed now where it runs from (hotfix v0.2.5, field point 20). */
export interface StaleEngine {
  /** The version this process loaded (RETAKE_VERSION of its modules). */
  running: string;
  /** The version on disk now: the app's bundle.json, or the checkout's core package.json. */
  installed: string;
}

/**
 * The version installed now where this engine runs from, read from disk on every call: the `app` of the bundle's
 * bundle.json (an app updated in place swaps it), else the `version` of the checkout's packages/core/package.json (a
 * pull and a build change it); undefined when it cannot be read.
 */
export function installedVersion(bundle: BundleInfo | null = bundleInfoOrNull(), location: string = engineLocation(bundle)): string | undefined {
  const file = bundle ? join(bundle.root, BUNDLE_FILE) : join(location, 'packages', 'core', 'package.json');
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { app?: unknown; version?: unknown })[bundle ? 'app' : 'version'];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The engine this process runs is older (or other) than the one installed now — the app was updated, the checkout
 * pulled and built, while a long-lived process (the MCP server a client started) kept the modules it loaded. Null when
 * they match or the installed version cannot be read.
 */
export function staleEngine(running: string, installed: string | undefined = installedVersion()): StaleEngine | null {
  return installed !== undefined && installed !== running ? { running, installed } : null;
}
