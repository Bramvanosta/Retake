/**
 * What a review works on: the project, the render (id, record or video path, `latest`), its run timeline and the
 * render to compare with.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { GUIDE, missingOrInvalid, projectPath } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { LoadedProject, RunRecord, Timeline, ErrorKind } from '@retake/core';
import { isRenderRecord, readRenderRecords } from '@retake/editor/plan';
import type { RenderRecord } from '@retake/editor/plan';

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

async function readRecord(file: string): Promise<RenderRecord> {
  let r: RenderRecord;
  try {
    r = JSON.parse(await readFile(file, 'utf8')) as RenderRecord;
  } catch (e) {
    throw new ReviewError(`cannot read the render record ${file}: ${(e as Error).message}`);
  }
  if (!isRenderRecord(r)) throw new ReviewError(`${file} is not a render record (renders/<id>.json)`);
  return r;
}

/** `<project>/renders`: where the project's renders and their records are. */
function rendersDir(project: Pick<LoadedProject, 'dir'>): string {
  return projectPath(project.dir, 'renders');
}

/** The render records of a project (renders/*.json), oldest first; unreadable files are skipped. */
function listRenders(project: Pick<LoadedProject, 'dir'>): Promise<RenderRecord[]> {
  return readRenderRecords(rendersDir(project), { list: (d) => readdir(d), read: (f) => readFile(f, 'utf8') });
}

/**
 * The render to review: `latest` (the most recent succeeded render, of `scenario` when given), a render id of the
 * project (renders/<id>.json), or a path to a record (.json) or a video (.mp4 next to its .json).
 */
export async function findRender(project: LoadedProject, arg: string, scenario?: string): Promise<RenderRecord> {
  if (arg === 'latest') {
    const all = (await listRenders(project)).filter((r) => r.status === 'succeeded' && (!scenario || r.scenario === scenario));
    const last = all[all.length - 1];
    if (!last) {
      throw new ReviewError(`no render${scenario ? ` of scenario "${scenario}"` : ''} in ${rendersDir(project)}: render one with \`retake render ${project.slug} ${scenario ?? '<scenario>'}\``);
    }
    return last;
  }
  const byId = join(rendersDir(project), `${arg}.json`);
  if (!/[\\/]/.test(arg) && existsSync(byId)) return readRecord(byId);
  if (isAbsolute(arg) || arg.startsWith('.') || /[\\/]/.test(arg) || /\.(json|mp4)$/.test(arg)) {
    const file = resolve(arg);
    const json = extname(file) === '.json' ? file : join(dirname(file), `${basename(file, extname(file))}.json`);
    if (existsSync(json)) return readRecord(json);
    if (existsSync(file)) throw new ReviewError(`${file} has no render record next to it (${basename(json)}): review needs the plan the video was rendered from`);
  }
  const ids = (await listRenders(project)).map((r) => r.id);
  throw new ReviewError(`render "${arg}" not found in ${rendersDir(project)}${ids.length ? ` (renders: ${ids.slice(-8).join(', ')})` : ''}; use a render id, a .json/.mp4 path or "latest"`);
}

/**
 * The render to compare with: `previous` (an id or path), none when `false`, else the most recent succeeded render of
 * the same scenario and variant made before this one.
 */
export async function findPrevious(project: LoadedProject, current: RenderRecord, previous: string | false | undefined): Promise<RenderRecord | undefined> {
  if (previous === false) return undefined;
  if (previous !== undefined) {
    const r = await findRender(project, previous);
    if (r.id === current.id && r.file === current.file) throw new ReviewError(`--previous ${previous} is the render under review`);
    return r;
  }
  const all = await listRenders(project);
  const older = all.filter(
    (r) =>
      r.status === 'succeeded' &&
      r.scenario === current.scenario &&
      r.variant === current.variant &&
      r.file !== current.file &&
      (r.created_at < current.created_at || (r.created_at === current.created_at && (r.render_version ?? 0) < (current.render_version ?? 0))) &&
      existsSync(r.file),
  );
  return older[older.length - 1];
}

/** The run timeline of a render (cursor track, clicks, captions as captured); undefined when the run is gone. */
export async function renderTimeline(project: LoadedProject, record: RenderRecord): Promise<{ timeline?: Timeline; file?: string }> {
  for (const dir of [record.run_dir, projectPath(project.dir, 'runs', record.run_id)]) {
    if (!dir) continue;
    const file = join(dir, 'timeline.json');
    try {
      return { timeline: JSON.parse(await readFile(file, 'utf8')) as Timeline, file };
    } catch {
      // try the next place
    }
  }
  return {};
}

/** The run.json of a render's run (L5.7: what the take cost, its slow transitions), when it can be read. */
export async function renderRun(project: LoadedProject, record: RenderRecord): Promise<RunRecord | undefined> {
  for (const dir of [record.run_dir, projectPath(project.dir, 'runs', record.run_id)]) {
    if (!dir) continue;
    try {
      return JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunRecord;
    } catch {
      // try the next place
    }
  }
  return undefined;
}

/** `<project>/review` */
export function reviewsDir(project: Pick<LoadedProject, 'dir'>): string {
  return projectPath(project.dir, 'review');
}
