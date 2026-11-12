import { relativeInside } from '@retake/core/base';

// L7.25: a sandbox's files are part of core's folder layout (core/src/layout.ts), re-exported here.
export { SANDBOX_STATE_DIR, sandboxPaths, serviceLog } from '@retake/core/project';
export type { SandboxPaths } from '@retake/core/project';

/** A path as messages show it: relative to the working directory when inside it, else absolute. */
export function shownPath(file: string, cwd: string = process.cwd()): string {
  return relativeInside(file, cwd, { self: false, dotDotPrefix: true }) ?? file;
}
