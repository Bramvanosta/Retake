/**
 * The backend of component previews (./preview.ts): what renders a session's frames — Remotion in the render browser
 * (`REMOTION_PREVIEW_BACKEND`, guarded when asked) or a test's stand-in — and that backend as a render driver's previews
 * (`previewDriver`).
 */
import { errorMessage } from '@retake/core/base';
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { GpuInfo } from '@retake/core/render';
import type { ComponentPreviewSpec } from '../preview.js';
import { PREVIEW_COMPOSITION, previewProps } from '../remotion/contract.js';
import { assertRenderBrowser, renderBrowser } from './browser.js';
import { ensureBundle } from './bundle.js';
import type { BundleComponent } from './bundle.js';
import type { DriverPreviewBundle, DriverPreviews } from './driver-types.js';
import { rendererLibrary } from './library.js';
import type { RenderBrowserHandle } from './library.js';
import { GUARDED_NO_OTHER_BROWSER, armNetworkGuard, browserProcessInfo, guardedPageFailed, guardedPageFailure, pickFreePort } from './network-guard.js';
import type { BrowserProcessInfo, NetworkGuard } from './network-guard.js';
import { openRenderBrowser, renderPolicy } from './policy.js';
import { guardEncoderPipe } from './render.js';
import type { RenderNetwork } from './render.js';
import { RenderError } from './types.js';

/** What renders a session's frames: Remotion in the render browser (the default), or a test's stand-in. */
export interface PreviewBackend {
  /** The bundle of these components (default: ensureBundle in the workspace cache). */
  bundle(o: { root: string; components: BundleComponent[]; cacheDir?: string; signal?: AbortSignal }): Promise<{ serveUrl: string; hash: string; cached: boolean }>;
  /**
   * Start the renderer on that bundle (default: the render browser as the render policy draws — the GPU checked before it
   * is reported or guarded; no fallback mid-way: a failure is said as it is —, guarded when asked).
   */
  open(o: {
    serveUrl: string;
    assetPrefix: string;
    network?: RenderNetwork;
    signal?: AbortSignal;
    onBrowser?: (b: BrowserProcessInfo) => void;
    settings?: RenderSettings;
    /** What the work runs under (core WorkPolicy). */
    workPolicy: WorkPolicy;
    /** Tests: the browser's GPU status. */
    gpuInfo?: (browser: RenderBrowserHandle) => Promise<GpuInfo | undefined>;
  }): Promise<PreviewRenderer>;
}

export interface PreviewRenderer {
  /** A PNG of `spec` at `spec.frame`, scaled. */
  still(spec: ComponentPreviewSpec, out: string, scale: number): Promise<void>;
  /** A GIF of `spec` over the composition frames `frames` [first, last], every `everyNthFrame`, scaled, looping forever. */
  gif(spec: ComponentPreviewSpec, out: string, o: { scale: number; everyNthFrame: number; frames: [number, number] }): Promise<void>;
  /** The guard's blocked origins so far. */
  warnings(): string[];
  close(): Promise<void>;
}

type OpenOptions = Parameters<PreviewBackend['open']>[0];
type RendererLib = Awaited<ReturnType<typeof rendererLibrary>>;
type OpenedBrowser = Awaited<ReturnType<typeof openRenderBrowser<Awaited<ReturnType<RendererLib['openBrowser']>>>>>;
/** The guard of a guarded session and what Remotion's calls take from it (the bundle port, the download check). */
interface ArmedBrowser {
  guard: NetworkGuard | undefined;
  remotion: { port?: number; onDownload?: (src: string) => undefined };
}

/** The render browser as the render policy draws it (the GPU checked before it is reported or guarded). */
async function launchPreviewBrowser(o: OpenOptions, lib: RendererLib, browser: ReturnType<typeof renderBrowser>, browserExe: string): Promise<OpenedBrowser> {
  const { openBrowser } = lib;
  const policy = renderPolicy(o.workPolicy, o.settings);
  guardEncoderPipe();
  try {
    return await openRenderBrowser({
      policy,
      launch: (chromium) => openBrowser('chrome', { browserExecutable: browserExe, chromeMode: 'headless-shell', logLevel: 'error', ...(chromium.gl ? { chromiumOptions: chromium } : {}) }),
      ...(o.gpuInfo ? { gpuInfo: o.gpuInfo } : {}),
    });
  } catch (e) {
    throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${errorMessage(e).split('\n')[0]}`);
  }
}

/** The browser's process reported, and its network guard armed when asked; on a failure the browser is closed. */
async function armPreviewBrowser(o: OpenOptions, puppeteer: OpenedBrowser['puppeteer']): Promise<ArmedBrowser> {
  let guard: NetworkGuard | undefined;
  let remotion: ArmedBrowser['remotion'] = {};
  try {
    if (o.onBrowser) {
      const info = await browserProcessInfo(puppeteer);
      if (info) o.onBrowser(info);
    }
    if (o.network === 'guard') {
      try {
        const port = await pickFreePort();
        guard = await armNetworkGuard(puppeteer, { assetPrefix: o.assetPrefix, bundlePort: port });
        remotion = { port, onDownload: (src: string) => guard!.onDownload(src) };
      } catch (e) {
        throw new RenderError(`the previews cannot run with their network guard: ${errorMessage(e)}`);
      }
    }
  } catch (e) {
    await puppeteer.close({ silent: true }).catch(() => undefined);
    throw e;
  }
  return { guard, remotion };
}

/** The stills and GIFs of an opened (and armed) browser through Remotion. */
function remotionRenderer(o: OpenOptions, lib: RendererLib, opened: OpenedBrowser, browserExe: string, { guard, remotion }: ArmedBrowser): PreviewRenderer {
  const { renderMedia, renderStill, selectComposition, makeCancelSignal } = lib;
  const puppeteer = opened.puppeteer;
  const common = { chromeMode: 'headless-shell', logLevel: 'error', timeoutInMilliseconds: 60_000 } as const;
  // Guarded: a browser that is no program for every Remotion call — a page that fails ends that preview, never a
  // browser Remotion opens itself (network-guard.ts).
  const executable = guard ? GUARDED_NO_OTHER_BROWSER : browserExe;
  const plainly = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (e) {
      if (guard && !(e instanceof RenderError) && guardedPageFailure(e)) throw new RenderError(guardedPageFailed('preview'));
      throw e;
    }
  };
  const select = (spec: ComponentPreviewSpec) =>
    selectComposition({
      ...common,
      serveUrl: o.serveUrl,
      id: PREVIEW_COMPOSITION,
      inputProps: previewProps(spec),
      puppeteerInstance: puppeteer,
      browserExecutable: executable,
      ...(remotion.port !== undefined ? { port: remotion.port } : {}),
    });
  return {
    async still(spec, out, scale) {
      const composition = await select(spec);
      await plainly(() =>
        renderStill({
          ...common,
          composition,
          serveUrl: o.serveUrl,
          frame: spec.frame,
          output: out,
          imageFormat: 'png',
          scale,
          overwrite: true,
          inputProps: previewProps(spec),
          puppeteerInstance: puppeteer,
          browserExecutable: executable,
          ...remotion,
        }),
      );
    },
    async gif(spec, out, g) {
      const composition = await select(spec);
      const { cancelSignal, cancel } = makeCancelSignal();
      const onAbort = () => cancel();
      o.signal?.addEventListener('abort', onAbort);
      try {
        await plainly(() =>
          renderMedia({
            ...common,
            composition,
            serveUrl: o.serveUrl,
            codec: 'gif',
            scale: g.scale,
            everyNthFrame: g.everyNthFrame,
            numberOfGifLoops: null,
            frameRange: g.frames,
            outputLocation: out,
            overwrite: true,
            inputProps: previewProps(spec),
            cancelSignal,
            puppeteerInstance: puppeteer,
            browserExecutable: executable,
            ...(opened.chromium.gl ? { chromiumOptions: opened.chromium } : {}),
            ...remotion,
          }),
        );
      } finally {
        o.signal?.removeEventListener('abort', onAbort);
      }
    },
    warnings: () => [...opened.warnings, ...(guard?.warnings() ?? [])],
    close: () => puppeteer.close({ silent: true }).catch(() => undefined),
  };
}

/** The default backend: the workspace's bundle cache and Remotion in the render browser (guarded when asked). */
export const REMOTION_PREVIEW_BACKEND: PreviewBackend = {
  async bundle(o) {
    const b = await ensureBundle({ root: o.root, components: o.components, ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    return { serveUrl: b.serveUrl, hash: b.hash, cached: b.cached };
  },
  async open(o) {
    const browser = renderBrowser();
    const browserExe = assertRenderBrowser(browser, o.workPolicy);
    const lib = await rendererLibrary();
    const opened = await launchPreviewBrowser(o, lib, browser, browserExe);
    const armed = await armPreviewBrowser(o, opened.puppeteer);
    return remotionRenderer(o, lib, opened, browserExe, armed);
  },
};

/**
 * A preview backend as the previews of a render driver: the bundle's serve URL stays here (a bundle of another driver
 * is refused), `cacheDir` and `gpuInfo` are the driver's own, and a closed session refuses to render.
 */
export function previewDriver(backend: PreviewBackend = REMOTION_PREVIEW_BACKEND, d: { cacheDir?: string; gpuInfo?: Parameters<PreviewBackend['open']>[0]['gpuInfo'] } = {}): DriverPreviews {
  const served = new WeakMap<DriverPreviewBundle, string>();
  return {
    async bundle(o) {
      const b = await backend.bundle({ root: o.root, components: o.components, ...(d.cacheDir ? { cacheDir: d.cacheDir } : {}), ...(o.signal ? { signal: o.signal } : {}) });
      const bundle: DriverPreviewBundle = Object.freeze({ hash: b.hash, cached: b.cached });
      served.set(bundle, b.serveUrl);
      return bundle;
    },
    async open(bundle, o) {
      const serveUrl = served.get(bundle);
      if (serveUrl === undefined) throw new RenderError('this preview bundle was made by another renderer');
      const session = await backend.open({
        serveUrl,
        assetPrefix: o.assets,
        ...(o.network ? { network: o.network } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onProcess ? { onBrowser: o.onProcess } : {}),
        ...(o.settings ? { settings: o.settings } : {}),
        workPolicy: o.workPolicy,
        ...(d.gpuInfo ? { gpuInfo: d.gpuInfo } : {}),
      });
      let closed = false;
      const ready = (): void => {
        if (closed) throw new RenderError('this preview session is closed');
      };
      return {
        still: async (spec, out, scale) => {
          ready();
          await session.still(spec, out, scale);
        },
        gif: async (spec, out, g) => {
          ready();
          await session.gif(spec, out, g);
        },
        warnings: () => session.warnings(),
        close: async () => {
          if (closed) return;
          closed = true;
          await session.close();
        },
      };
    },
  };
}
