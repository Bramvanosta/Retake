/** The options and the result of a render (`renderPlan`), the record of its path and the test seams. */
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { GpuInfo } from '@retake/core/render';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditPlan } from '../plan-types.js';
import type { RenderBrowser } from './browser.js';
import type { RenderBundle } from './bundle.js';
import type { BrowserProcessInfo } from './network-guard.js';
import type { encodingRecord } from './policy.js';
import type { ChooseEncodeOptions, RenderEncoder, RenderGl, RenderPolicy, VideotoolboxProbe } from './policy.js';
import type { RenderProgress } from './types.js';
import type { RenderBrowserHandle } from './library.js';

/** Seams of the render path, for tests only (a GPU that is not there, a GPU path that fails). */
export interface RenderSeams {
  /** The render browser's GPU status (default: CDP SystemInfo.getInfo, ./policy.ts renderGpuInfo). */
  gpuInfo?: (browser: RenderBrowserHandle) => Promise<GpuInfo | undefined>;
  /** The VideoToolbox probe (default: the compositor's ffmpeg at the render's size). */
  videotoolbox?: VideotoolboxProbe;
  /** The encoder of the first attempt, past the choice (a hardware encoder failing for real: an oversize session). */
  encoder?: RenderEncoder;
  /** Called before each renderMedia attempt (1, then 2 for the fallback): a test throws to fail one. */
  beforeRender?: (attempt: number, path: { gl: RenderGl; encoder: RenderEncoder }) => void | Promise<void>;
  /** Fail attempt `attempt` with `message` once `frames` frames are rendered (a failure mid-render: progress made, a partial file). */
  failAfter?: { attempt: number; frames: number; message: string };
  /** This machine's ffmpeg for the frame encode (default: the work's, read from the binary; ./encode-tools.ts). */
  ownFfmpeg?: ChooseEncodeOptions['own'];
  /** The frame-encode probe of that ffmpeg (default: the command itself on three frames). */
  ownEncodes?: ChooseEncodeOptions['ownEncodes'];
}

/** What a render record says of its policy (types.ts RenderRecord.policy). */
export interface RenderPathRecord {
  gl: { asked: RenderPolicy['gl']['asked']; source: RenderPolicy['gl']['source']; resolved: RenderGl; used: RenderGl; renderer?: string };
  encoder: { asked: RenderPolicy['encoder']['asked']; source: RenderPolicy['encoder']['source']; used: RenderEncoder };
  concurrency_source: RenderPolicy['concurrencySource'];
  /** The GPU path failed and the video was rendered again, in software with libx264 (its first error line). */
  fallback?: { reason: string };
  /**
   * Which ffmpeg encoded the frames: the setting, what was used, our ffmpeg's version when it was looked at,
   * why the library's encoded although the setting is not `library` (`note`: one of our own sentences — the rule of
   * `auto` on this path, why ours did not qualify, the second attempt) and what the first attempt failed with while
   * ours encoded (`failed`: the failure's own words; the video was rendered again with the library's).
   */
  ffmpeg?: { asked: RenderPolicy['ffmpeg']['asked']; source: RenderPolicy['ffmpeg']['source']; used: 'own' | 'library'; version?: string; note?: string; failed?: string };
}

export interface RenderPlanOptions {
  plan: EditPlan;
  /** Output .mp4 (written to a temporary name first, renamed on success). */
  out: string;
  /** Workspace root (bundle cache): the caller's, never looked for from the current folder. */
  root: string;
  /** Registry to find the plan's component implementations (the planned run's): required, a render loads none by itself. */
  registry: ComponentRegistry;
  /** Bundle cache folder (default <root>/.retake/cache). */
  cacheDir?: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  /** Only these output frames [first, last] (inclusive; previews, tests). */
  frameRange?: [number, number];
  /** `guard`: the render's Chromium loads only the plan's files (network-guard.ts; renders of the jobs worker). */
  network?: RenderNetwork;
  /** Called once the render browser runs, with its process (the jobs worker records it to kill it after a crash). */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** Render settings over the process's (./policy.ts: an explicit option wins over retake.yaml and the environment). */
  settings?: RenderSettings;
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
  /** Tests only. */
  seams?: RenderSeams;
}

/** `open`: the render's Chromium has the machine's network (a `retake` command); `guard`: network-guard.ts. */
export type RenderNetwork = 'open' | 'guard';

export interface RenderPlanResult {
  file: string;
  bundle: RenderBundle;
  browser: RenderBrowser;
  concurrency: number;
  bundle_ms: number;
  render_ms: number;
  size_bytes: number;
  warnings: string[];
  /** The policy asked, resolved and used (the record's `policy`). */
  path: RenderPathRecord;
  /** The record's encoding fields of the encoder used. */
  encoding: ReturnType<typeof encodingRecord>;
}
