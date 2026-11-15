/** Stills of a plan: several output frames rendered to PNGs in one session. */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditPlan } from '../plan-types.js';
import { guardedPageFailed, guardedPageFailure } from './network-guard.js';
import type { BrowserProcessInfo } from './network-guard.js';
import { renderPolicy } from './policy.js';
import { VIDEO_COMPOSITIONS, videoProps } from '../remotion/contract.js';
import { RenderError } from './types.js';
import { errorMessage } from '@retake/core/base';
import { rendererLibrary } from './library.js';
import type { RenderNetwork, RenderSeams } from './render-options.js';
import { COMMON, guardEncoderPipe, handedRoot, openSession } from './render-session.js';

export interface RenderStillsOptions {
  plan: EditPlan;
  /** Output frames (0-based) and the .png each one goes to. */
  frames: Array<{ frame: number; out: string }>;
  /** Workspace root (bundle cache). */
  root: string;
  /** Registry to find the plan's component implementations: required, a still loads none by itself. */
  registry: ComponentRegistry;
  cacheDir?: string;
  /** The stills' network (default `open`; previews of the jobs worker: `guard`). */
  network?: RenderNetwork;
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** Receives the session's warnings (a guard's blocked origins, no GPU found) once the stills are done. */
  onWarnings?: (warnings: string[]) => void;
  /** Render settings over the process's (./policy.ts). Stills have no mid-render fallback: a failure is said as it is. */
  settings?: RenderSettings;
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;

  /** Tests only. */
  seams?: Pick<RenderSeams, 'gpuInfo'>;
}

/**
 * Render several output frames of a plan to PNGs in ONE session (bundle, asset server and browser are opened once:
 * ≈ 0.3–0.6 s per extra frame instead of ≈ 1–2 s per `renderStill`). Returns the files in the order given.
 */
export async function renderStills(opts: RenderStillsOptions): Promise<string[]> {
  for (const f of opts.frames) {
    const frame = Math.round(f.frame);
    if (!(frame >= 0 && frame < opts.plan.durationInFrames)) {
      throw new RenderError(`frame ${f.frame} is outside the video (0–${opts.plan.durationInFrames - 1})`);
    }
  }
  const root = handedRoot(opts.root);
  const policy = renderPolicy(opts.workPolicy, opts.settings);
  guardEncoderPipe();
  const session = await openSession({
    plan: opts.plan,
    workPolicy: opts.workPolicy,
    root,
    registry: opts.registry,
    cacheDir: opts.cacheDir,
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.onBrowser ? { onBrowser: opts.onBrowser } : {}),
    policy,
    ...(opts.seams ? { seams: opts.seams } : {}),
  });
  try {
    const { renderStill: still, selectComposition } = await rendererLibrary();
    const inputProps = videoProps(session.served);
    const composition = await selectComposition({
      ...COMMON,
      serveUrl: session.serveUrl,
      id: VIDEO_COMPOSITIONS[opts.plan.variant],
      inputProps,
      puppeteerInstance: session.puppeteer,
      browserExecutable: session.executable,
      ...(session.remotion.port !== undefined ? { port: session.remotion.port } : {}),
    });
    const files: string[] = [];
    for (const f of opts.frames) {
      const out = resolve(f.out);
      await mkdir(dirname(out), { recursive: true });
      await still({
        ...COMMON,
        composition,
        serveUrl: session.serveUrl,
        frame: Math.round(f.frame),
        output: out,
        imageFormat: 'png',
        overwrite: true,
        inputProps,
        puppeteerInstance: session.puppeteer,
        browserExecutable: session.executable,
        ...session.remotion,
      });
      files.push(out);
    }
    opts.onWarnings?.([...session.warnings, ...(session.guard?.warnings() ?? [])]);
    return files;
  } catch (e) {
    if (e instanceof RenderError) throw e;
    if (session.guard && guardedPageFailure(e)) throw new RenderError(`still failed: ${guardedPageFailed()}`);
    throw new RenderError(`still failed: ${errorMessage(e)}`);
  } finally {
    await session.close();
  }
}
