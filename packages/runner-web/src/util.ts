import { CancelledError, RunnerError } from './errors.js';

/** Wall clock in epoch ms with sub-millisecond precision (monotonic within a run). */
export function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Throw when the run was aborted: a runner error given as the reason as is (a cancel, or the sign-in guard's
 * LoginPageError, which fails the run rather than cancelling it), anything else as a cancel.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const r: unknown = signal.reason;
    throw r instanceof RunnerError ? r : new CancelledError(r instanceof Error ? r.message : 'run cancelled');
  }
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (e) {
        reject(e);
      }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Sleep until a wall-clock deadline (epoch ms). */
export function sleepUntil(deadline: number, signal?: AbortSignal): Promise<void> {
  return sleep(deadline - wallNow(), signal);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Seconds rounded to the millisecond (timeline precision). */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** File-name-safe slug. */
export function fileSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  json: 'application/json',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp4: 'video/mp4',
};

export function mimeFor(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
