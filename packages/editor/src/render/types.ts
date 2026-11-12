/** Types of the render API (DESIGN-phase2 §2: renderVideo, renderStill, listRenders). */
import type { RenderAttempt, RenderRecord } from '../render-record.js';
import { GUIDE } from '@retake/core/base';
import type { ErrorKind } from '@retake/core/base';

/** A render that cannot start or failed (message written for the user). */
export class RenderError extends Error {
  constructor(
    message: string,
    /** The record of the failed/cancelled render (never written to a disk). */
    readonly record?: RenderAttempt,
  ) {
    super(message);
    this.name = 'RenderError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'invalid';
  }

  get errorDocs(): string {
    return GUIDE.editing;
  }
  /**
   * A failed render (renderPlan): the path it tried — the GPU path, its fallback and why (the record's `policy`).
   * The `Renderer` port and this package's driver call it `renderPath`: planDriver (render.ts) maps the name.
   */
  path?: RenderRecord['policy'];
  /** A failed render (renderPlan): its warnings so far (a fallback's, a guard's blocked origins). */
  renderWarnings?: string[];
}

/** The render was cancelled through its AbortSignal: nothing was written under the final name. */
export class RenderCancelledError extends RenderError {
  constructor(record?: RenderAttempt) {
    super('render cancelled: no output written', record);
    this.name = 'CancelledError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  override get errorKind(): ErrorKind {
    return 'cancelled';
  }
}

/**
 * The disk filled up during a render or a preview (ENOSPC): the work stopped there, nothing more was attempted. The
 * jobs worker turns it into "the disk has N MB free".
 */
export class RenderDiskFullError extends RenderError {
  /** Read by name (isDiskFullError): a render driver's own failure may say it too. */
  readonly diskFull = true as const;

  constructor(detail: string) {
    super(`the disk is full (${detail})`);
    this.name = 'DiskFullError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  override get errorKind(): ErrorKind {
    return 'internal';
  }
}

/** A failure that says the disk is full (`diskFull`), an ENOSPC from Node (its `code`) or from a tool's message (ffmpeg, Chromium, Remotion). */
export function isDiskFullError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if ((e as { diskFull?: unknown }).diskFull === true) return true;
  if ((e as { code?: unknown }).code === 'ENOSPC') return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && /\bENOSPC\b|no space left on device/i.test(message);
}

/** `retrying`: the GPU path failed and the video renders again in software (L5.15; progress does not go back). */
export type RenderStage = 'planning' | 'bundling' | 'rendering' | 'retrying' | 'encoding' | 'done';

export interface RenderProgress {
  stage: RenderStage;
  /** 0..1 within the stage. */
  progress: number;
  /** 0..1 over the whole render (bundling ≈ 0–10 %, rendering 10–95 %, encoding 95–100 %). */
  overall: number;
  totalFrames?: number;
  renderedFrames?: number;
  encodedFrames?: number;
  /** bundling: the bundle came from the cache. */
  cached?: boolean;
  /** Seconds left (rendering), when Remotion estimates it. */
  eta_s?: number;
}
