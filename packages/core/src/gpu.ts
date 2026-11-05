/**
 * Chromium's GPU status as CDP `SystemInfo.getInfo` reports it (L5.7 for the capture browser; L5.15: the render browser
 * reads it too, which is why it lives here — the editor does not depend on runner-web).
 */

/** What `gpuInfoOf` reads of SystemInfo.getInfo. */
export interface SystemInfoReply {
  gpu?: {
    featureStatus?: Record<string, string>;
    devices?: Array<{ deviceString?: string }>;
    auxAttributes?: Record<string, unknown>;
  };
}

/** A browser's GPU status (run.json `perf.gpu`, a render record's `policy.gl`, `retake doctor`). */
export interface GpuInfo {
  accelerated: boolean;
  renderer?: string;
  /** Features that run in software (e.g. "gpu_compositing", "rasterization"). */
  software?: string[];
}

/**
 * Hardware accelerated when compositing and rasterization are ("enabled…"); a SwiftShader renderer is software whatever
 * the statuses say. Pure.
 */
export function gpuInfoOf(info: SystemInfoReply): GpuInfo | undefined {
  const status = info.gpu?.featureStatus;
  if (!status) return undefined;
  const gl = info.gpu?.auxAttributes?.glRenderer;
  const renderer = typeof gl === 'string' && gl ? gl : info.gpu?.devices?.[0]?.deviceString || undefined;
  const on = (k: string) => typeof status[k] === 'string' && status[k].startsWith('enabled');
  const software = Object.entries(status)
    .filter(([, v]) => /software/.test(v))
    .map(([k]) => k)
    .sort();
  const accelerated = on('gpu_compositing') && on('rasterization') && !/swiftshader|llvmpipe|software/i.test(renderer ?? '');
  return { accelerated, ...(renderer ? { renderer } : {}), ...(software.length ? { software } : {}) };
}
