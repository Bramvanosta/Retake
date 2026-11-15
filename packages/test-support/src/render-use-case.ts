/**
 * The render use case for the tests that render a run for real (the editor's render, export and media tests): the
 * engine's own (its in-process render and export: the version, the record, where the files go, on the disk's
 * outputs), drawn by the editor's driver made with the test's bundle cache folder and seams — the render itself.
 */
import { createRenderer } from '@retake/editor';
import type { RenderDriverOptions } from '@retake/editor';
import type { Renderer } from '@retake/engine';
import { exportInProcess, renderInProcess } from '@retake/engine/shell';
import { diskOutputs, diskWorkspaceReads, systemClock } from '@retake/engine/testing';

/** The disk's outputs and workspace reads: where a test's render goes. */
const DISK = { outputs: diskOutputs, reads: diskWorkspaceReads };

type Rendered = Parameters<typeof renderInProcess>[0];
type Exported = Parameters<typeof exportInProcess>[0];

/** A render's options as a test names them: no renderer, workspace or clock (made here); the root defaults to the project's. */
export type RenderRunOptions = Omit<Rendered, 'renderer' | 'ws' | 'clock' | 'root'> & { root?: string; renderer?: Rendered['renderer'] } & RenderDriverOptions;
export type ExportRunOptions = Omit<Exported, 'renderer' | 'ws' | 'clock' | 'root'> & { root?: string; renderer?: Exported['renderer'] } & RenderDriverOptions;

/** The editor's driver as a renderer: a test render never checks the machine (that is `retake doctor`'s). */
function driverOf(cacheDir: string | undefined, seams: RenderDriverOptions['seams'] | undefined): Renderer {
  const unprobed = () => Promise.reject(new Error('a test render does not check the machine'));
  return { ...createRenderer({ ...(cacheDir ? { cacheDir } : {}), ...(seams ? { seams } : {}) }), machine: { path: unprobed, browser: unprobed } };
}

/** Render a run as `retake render` does, on the editor's driver (or the renderer given). */
export function renderRun(o: RenderRunOptions): ReturnType<typeof renderInProcess> {
  const { cacheDir, seams, renderer, root, ...rest } = o;
  return renderInProcess({
    ...rest,
    root: root ?? rest.project.root,
    renderer: renderer ?? driverOf(cacheDir, seams),
    ws: DISK,
    clock: systemClock,
  });
}

/** Export a render as `retake export` does, its re-rendered formats on the editor's driver (or the renderer given). */
export function exportRun(o: ExportRunOptions): ReturnType<typeof exportInProcess> {
  const { cacheDir, seams, renderer, root, ...rest } = o;
  return exportInProcess({
    ...rest,
    root: root ?? rest.project.root,
    renderer: renderer ?? driverOf(cacheDir, seams),
    ws: DISK,
    clock: systemClock,
  });
}
