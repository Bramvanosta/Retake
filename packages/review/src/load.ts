/**
 * What a review works on: the project, the render (id, record or video path, `latest`), its run timeline and the
 * render to compare with.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE, missingOrInvalid } from '@retake/core/base';
import { projectPath } from '@retake/core/project';
import { previousRender, renderRecordsOf } from '@retake/core/render';
import { findNamedRender, loadProject, readRendersFolder, readRunRecord, readTimeline } from '@retake/core/io';
import type { ErrorKind } from '@retake/core/base';
import type { LoadedProject, Timeline } from '@retake/core/model';
import type { StoredRunRecord, UnknownStatusRun } from '@retake/core/run';
import type { NamedRenderFound } from '@retake/core/io';
import { withPlan } from '@retake/editor/plan';
import type { NamedRender, StoredRender } from '@retake/editor/plan';

/** A review that cannot start (message written for the user). */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return missingOrInvalid(this.message);
  }

  get errorDocs(): string {
    return GUIDE.review;
  }
}

export async function openProject(project: LoadedProject | string, root?: string): Promise<LoadedProject> {
  if (typeof project !== 'string') return project;
  try {
    return await loadProject(project, root);
  } catch (e) {
    throw new ReviewError(`project "${project}": ${(e as Error).message}`);
  }
}

/** `<project>/renders`: where the project's renders and their records are. */
function rendersDir(project: Pick<LoadedProject, 'dir'>): string {
  return projectPath(project.dir, 'renders');
}

/** A render found to review (core/io findNamedRender), its plan as an edit plan. */
export type FoundReviewRender = Omit<NamedRenderFound, 'record'> & { record: NamedRender };

/**
 * The render to review, found as a terminal names it (core/io findNamedRender): `latest` (the most recent succeeded
 * record of renders/, of `scenario` when given, whatever its file is called — then the record OF THAT FILE), a render
 * id of the project (renders/<id>.json), or a path to a record (.json) or a video (.mp4 next to its .json). A file that
 * is there is a record or one sentence says what it is; a record without its plan is refused; a record of any status
 * is reviewed (its status is a finding).
 */
export async function locateRender(project: LoadedProject, arg: string, scenario?: string): Promise<FoundReviewRender> {
  const found = await findNamedRender(rendersDir(project), arg, { verb: 'review', slug: project.slug, videoAlone: true, ...(scenario !== undefined ? { scenario } : {}) });
  if (!found.ok) throw new ReviewError(found.message);
  // (core/io refused a record without its plan: here its plan becomes an edit plan.)
  return { ...found.render, record: withPlan(found.render.record).value };
}

/** The render to review (locateRender): its record. */
export async function findRender(project: LoadedProject, arg: string, scenario?: string): Promise<NamedRender> {
  return (await locateRender(project, arg, scenario)).record;
}

/**
 * The render to compare with: `previous` (an id or path), none when `false`, else the previous render of core's rule
 * (previousRender): the most recent succeeded render of the same scenario and variant made before this one, among the
 * complete records of their own file, whose video is there. A render without its creation time has none.
 */
export async function findPrevious(
  project: LoadedProject,
  current: Pick<StoredRender, 'id' | 'file' | 'scenario' | 'variant' | 'created_at' | 'render_version'>,
  previous: string | false | undefined,
): Promise<NamedRender | undefined> {
  if (previous === false) return undefined;
  if (previous !== undefined) {
    const r = await findRender(project, previous);
    if (r.id === current.id && r.file === current.file) throw new ReviewError(`--previous ${previous} is the render under review`);
    return r;
  }
  const listed = renderRecordsOf(await readRendersFolder(rendersDir(project))).map((r) => withPlan(r).value);
  return previousRender(listed, current, existsSync);
}

/**
 * The run timeline of a render (cursor track, clicks, captions as captured); undefined when the run is gone or its
 * timeline does not read (the core's one reader: core/io run-folder.ts). A review reads the run its render names,
 * through a link too.
 */
export async function renderTimeline(project: LoadedProject, record: Pick<StoredRender, 'run_dir' | 'run_id'>): Promise<{ timeline?: Timeline; file?: string }> {
  for (const dir of [record.run_dir, record.run_id ? projectPath(project.dir, 'runs', record.run_id) : '']) {
    if (!dir) continue;
    const file = join(dir, 'timeline.json');
    const r = await readTimeline(file, { follow: true });
    if (r.ok) return { timeline: r.value, file };
    // else: try the next place
  }
  return {};
}

/**
 * The run.json of a render's run (L5.7: what the take cost, its slow transitions), when it reads as a record — a
 * status Retake never writes included; a record a newer Retake wrote, or a file that is no record, is not read.
 */
export async function renderRun(project: LoadedProject, record: Pick<StoredRender, 'run_dir' | 'run_id'>): Promise<StoredRunRecord | UnknownStatusRun | undefined> {
  for (const dir of [record.run_dir, record.run_id ? projectPath(project.dir, 'runs', record.run_id) : '']) {
    if (!dir) continue;
    const r = await readRunRecord(join(dir, 'run.json'), { follow: true });
    if (r.ok) return r.value;
    if (r.problem === 'unknown-status') return r.record;
    // else: try the next place
  }
  return undefined;
}

/** `<project>/review` */
export function reviewsDir(project: Pick<LoadedProject, 'dir'>): string {
  return projectPath(project.dir, 'review');
}
