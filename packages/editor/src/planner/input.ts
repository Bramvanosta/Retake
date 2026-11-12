/** What `planEdit` is given (DESIGN-phase2 §2) and the error it throws when the input cannot be planned. */
import { GUIDE } from '@retake/core/base';
import type { ErrorKind } from '@retake/core/base';
import type { LoadedProject, LoadedTemplate, LottieMeta, Scenario, Timeline, VideoProbe } from '@retake/core/model';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditOverrides } from '../plan-types.js';

/** Input of `planEdit` (DESIGN-phase2 §2). */
export interface PlanEditInput {
  timeline: Timeline;
  /** The theme. With `overrides.theme`, the caller loads that template and passes it here. */
  template: LoadedTemplate;
  project: LoadedProject;
  registry: ComponentRegistry;
  /** Absolute path of the run's capture.mp4. */
  captureFile: string;
  /** Optional extra context: used for the edit info of older timelines without a `video` block. */
  scenario?: Scenario;
  /**
   * The environment the run filmed (run.json `env`): its display URLs in project.yaml apply to runs whose timeline has
   * no `environment` block (captured before L1.7). A timeline's own `environment.name` wins.
   */
  env?: string;
  overrides?: EditOverrides;
  /** Length (s) of the music track when the caller measured it (the planner does no I/O): its loops are then planned. */
  musicDuration_s?: number;
  /** The run directory (artefact files of timeline.artefacts are relative to it); default: the capture file's folder. */
  runDir?: string;
  /**
   * Project files the planner reads (it does no I/O), by their path as written in the scenario: the text of `data:`
   * CSV files, the pixel size of image files. `planInputFiles(timeline, project)` (./inputs.ts) reads them.
   */
  files?: Record<string, PlanInputFile>;
}

/** A project file read for the planner (`PlanEditInput.files`). */
export interface PlanInputFile {
  /** Absolute path. */
  file: string;
  /** Text files (CSV / TSV). */
  text?: string;
  /** Images, videos and Lottie files: pixel size. */
  width?: number;
  height?: number;
  /** A video file (L2.12): what ffprobe says. */
  video?: VideoProbe;
  /** A Lottie file (L2.12): its metadata. */
  lottie?: LottieMeta;
  /** The file exists but could not be used (not a video ffprobe reads, not a Lottie JSON…). */
  error?: string;
  /** The file does not exist or could not be read. */
  missing?: boolean;
}

/** The input cannot be planned (dry-run timeline, no capture…). */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'invalid';
  }

  get errorDocs(): string {
    return GUIDE.editing;
  }
}
