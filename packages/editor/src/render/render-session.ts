/**
 * The session of one render or still: the bundle, the asset server and the render browser (drawing as the policy
 * resolves it, guarded when asked), and the checks on what a render is handed.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoadedProject } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { GpuInfo } from '@retake/core/render';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditPlan } from '../plan-types.js';
import { resolvePlanAssets } from '../summary.js';
import { startAssetServer } from './asset-server.js';
import { assertRenderBrowser, renderBrowser } from './browser.js';
import type { RenderBrowser } from './browser.js';
import { bundleComponentsFor, ensureBundle } from './bundle.js';
import type { RenderBundle } from './bundle.js';
import { GUARDED_NO_OTHER_BROWSER, armNetworkGuard, browserProcessInfo, pickFreePort } from './network-guard.js';
import type { BrowserProcessInfo, NetworkGuard } from './network-guard.js';
import { openRenderBrowser, withGl } from './policy.js';
import type { RenderGl, RenderPolicy } from './policy.js';
import { RenderError } from './types.js';
import { handedRegistry } from './registry-source.js';
import { errorMessage } from '@retake/core/base';
import { rendererLibrary } from './library.js';
import type { LibraryBrowser } from './library.js';
import type { RenderNetwork, RenderSeams } from './render-options.js';

/**
 * The workspace root a render was handed, resolved. The editor never looks for a workspace from the current folder:
 * a caller outside the type checker that hands none is refused.
 */
export function handedRoot(root: unknown): string {
  if (typeof root !== 'string' || root === '') throw new RenderError('no workspace root was handed to the render (the caller names its workspace)');
  return resolve(root);
}

/** The loaded project a use case was handed: the editor loads no project by itself (a slug or a folder is refused). */
export function handedProject(project: unknown): LoadedProject {
  if (typeof project !== 'object' || project === null || typeof (project as LoadedProject).dir !== 'string') {
    throw new RenderError('no loaded project was handed (the caller loads the project; a slug or a folder is not read here)');
  }
  return project as LoadedProject;
}

/**
 * Remotion's encoder pipe rejects with EPIPE, unhandled, when the encoder dies under it (a failed render; a hardware
 * encoder refusing its session): the render itself fails with that error, the process must not die of it. Installed
 * once per process by the first render or still (a `retake render`, an export, the Studio, the worker — whose own
 * handlers do the same); any other unhandled rejection is left as it was: thrown when no other handler decides.
 */
let pipeGuarded = false;
export function guardEncoderPipe(): void {
  if (pipeGuarded) return;
  pipeGuarded = true;
  process.on('unhandledRejection', (reason) => {
    if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') return;
    if (process.listenerCount('unhandledRejection') > 1) return;
    throw reason;
  });
}

export function cancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export interface Session {
  serveUrl: string;
  bundle: RenderBundle;
  browser: RenderBrowser;
  served: EditPlan;
  close: () => Promise<void>;
  puppeteer: LibraryBrowser;
  warnings: string[];
  /** Options every Remotion call of a guarded session takes: the bundle server's port and the download check. */
  remotion: { port?: number; onDownload?: (src: string) => undefined };
  guard?: NetworkGuard;
  /** How this browser draws (after the GPU check), and what it reported. */
  gl: RenderGl;
  gpu?: GpuInfo;
  /** `chromiumOptions` of its Remotion calls (a browser Remotion replaces after a crash draws the same way). */
  chromium: { gl?: 'angle' };
  /**
   * The `browserExecutable` of its Remotion calls: the render browser's, or — guarded — one that is no program
   * (network-guard.ts GUARDED_NO_OTHER_BROWSER: Remotion never opens a browser of its own for a guarded render).
   */
  executable: string | null;
  /** The policy this session renders with: the one asked, its GL as the browser draws (a reopen in software takes the software default concurrency unless set). */
  policy: RenderPolicy;
}

/**
 * Asset server + bundle + browser for one render or still; `close` releases the server and the browser. The browser
 * draws as `policy` resolves it; with ANGLE its GPU is checked first (CDP SystemInfo): none under `auto` → closed and
 * reopened in software, `gpu` → kept, with a warning. Only the browser that will render is reported (`onBrowser`) and
 * guarded — after that check, so a reopened one is too.
 */
export async function openSession(opts: {
  plan: EditPlan;
  workPolicy: WorkPolicy;
  root: string;
  registry: ComponentRegistry;
  cacheDir?: string;
  signal?: AbortSignal;
  onBundleProgress?: (p: number, cached: boolean) => void;
  network?: RenderNetwork;
  onBrowser?: (b: BrowserProcessInfo) => void;
  policy: RenderPolicy;
  seams?: RenderSeams;
}): Promise<Session> {
  const warnings: string[] = [];
  const registry = handedRegistry(opts.registry, 'render');
  const components = await bundleComponentsFor(opts.plan, registry);
  const bundle = await ensureBundle({
    root: opts.root,
    components,
    cacheDir: opts.cacheDir,
    signal: opts.signal,
    onProgress: (p) => opts.onBundleProgress?.(p, false),
  });
  opts.onBundleProgress?.(1, bundle.cached);
  // The browser first: without a headless shell (or with one the agent policy refuses) no server is started.
  const browser = renderBrowser();
  const executable = assertRenderBrowser(browser, opts.workPolicy);
  if (browser.note) warnings.push(browser.note);
  const server = await startAssetServer();
  const missing = Object.values(opts.plan.assets).filter((f) => !existsSync(f));
  if (missing.length > 0) {
    await server.close();
    throw new RenderError(`files of the plan are missing: ${missing.join(', ')}`);
  }
  const served = resolvePlanAssets(opts.plan, (_url, file) => server.urlFor(file));
  const { openBrowser } = await rendererLibrary();
  let opened: Awaited<ReturnType<typeof openRenderBrowser<Session['puppeteer']>>>;
  try {
    opened = await openRenderBrowser({
      policy: opts.policy,
      launch: (chromium) => openBrowser('chrome', { browserExecutable: executable, chromeMode: 'headless-shell', logLevel: 'error', ...(chromium.gl ? { chromiumOptions: chromium } : {}) }),
      ...(opts.seams?.gpuInfo ? { gpuInfo: opts.seams.gpuInfo } : {}),
    });
  } catch (e) {
    await server.close();
    throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${errorMessage(e).split('\n')[0]}`);
  }
  const { puppeteer, gl, gpu } = opened;
  warnings.push(...opened.warnings);
  const close = async () => {
    await puppeteer.close({ silent: true }).catch(() => undefined);
    await server.close();
  };
  if (opts.onBrowser) {
    const info = await browserProcessInfo(puppeteer);
    if (info) opts.onBrowser(info);
  }
  let guard: NetworkGuard | undefined;
  let remotion: Session['remotion'] = {};
  if (opts.network === 'guard') {
    try {
      const port = await pickFreePort();
      guard = await armNetworkGuard(puppeteer, { assetPrefix: server.prefix, bundlePort: port });
      remotion = { port, onDownload: (src: string) => guard!.onDownload(src) };
    } catch (e) {
      await close();
      throw new RenderError(`the render cannot run with its network guard: ${errorMessage(e)}`);
    }
  }
  return {
    serveUrl: bundle.serveUrl,
    bundle,
    browser,
    served,
    puppeteer,
    warnings,
    remotion,
    ...(guard ? { guard } : {}),
    close,
    gl,
    ...(gpu ? { gpu } : {}),
    chromium: opened.chromium,
    executable: guard ? GUARDED_NO_OTHER_BROWSER : executable,
    // A reopen in software renders at the software default (what doctor says), not the GPU's 3.
    policy: gl === opts.policy.gl.resolved ? opts.policy : withGl(opts.policy, gl),
  };
}

export const COMMON = { chromeMode: 'headless-shell', logLevel: 'error', timeoutInMilliseconds: 90_000 } as const;
