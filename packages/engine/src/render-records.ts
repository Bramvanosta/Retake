/**
 * The engine's reads of renders/ through the one reader (core/io render-folder.ts), and what its answers say of them
 * (L7.6b): the folder as a listing reads it, one record BY ITS ID, why a file that is there is no record a by-id call
 * takes — never "not found" —, and what a `latest` passed over, as an answer carries it (a count a trusted line may
 * say; the file names under `untrusted`). Kept apart from renders.ts so that the comment views, prune and the jobs
 * read renders/ without importing the render views.
 */
import { existsSync } from 'node:fs';
import { byIdProblem, previousRender, projectPath, renderRecordsOf } from '@retake/core';
import { readRenderById, readRendersFolder } from '@retake/core/io';
import type { CompleteRender, RenderEntry, RenderLatestPick, RenderNot, StoredRenderRecord } from '@retake/core';
import { EngineError } from './errors.js';

/**
 * What a `latest` of renders says of the files it did not take: `renders_passed_over` — how many newer files of
 * renders/ of the scenario asked are no render it takes —, `renders_not_considered` — how many files say nothing
 * readable under a name that is no render id. Counts: a trusted line may say them. Absent when zero.
 */
export interface LatestRenderNotice {
  renders_passed_over?: number;
  renders_not_considered?: number;
}

/**
 * The newer files of renders/ a `latest` passed over, newest first (at most core PASSED_OVER_MAX; the count holds them
 * all): `file` is a file name of renders/ — text anyone who can write the folder chose, kept under `untrusted` —,
 * `why` one of a closed list of reasons (core RenderNot; its words: renderNotWords).
 */
export type PassedOverRenders = Array<{ file: string; why: RenderNot }>;

/** What a `latest` of renders passed over, as an answer carries it: the counts, and the names for `untrusted`. */
export function latestRenderNotice(pick: Pick<RenderLatestPick<unknown>, 'passed' | 'passed_more' | 'not_considered'>): { notice: LatestRenderNotice; passed: PassedOverRenders } {
  const count = pick.passed.length + pick.passed_more;
  return {
    notice: { ...(count > 0 ? { renders_passed_over: count } : {}), ...(pick.not_considered > 0 ? { renders_not_considered: pick.not_considered } : {}) },
    passed: pick.passed,
  };
}

/** The members an answer gains from a `latest` of renders (none when nothing was passed over). */
export function latestRenderMembers(pick: Pick<RenderLatestPick<unknown>, 'passed' | 'passed_more' | 'not_considered'> | undefined): LatestRenderNotice & { untrusted?: { renders_passed_over: PassedOverRenders } } {
  if (!pick) return {};
  const { notice, passed } = latestRenderNotice(pick);
  return { ...notice, ...(passed.length ? { untrusted: { renders_passed_over: passed } } : {}) };
}

/** renders/ of a project, read by the one reader as a listing reads it: no link followed, each file within the cap. */
export function renderEntries(projectDir: string, only?: (name: string) => boolean): Promise<RenderEntry[]> {
  return readRendersFolder(projectPath(projectDir, 'renders'), only ? { only } : {});
}

/** renders/<id>.json read by its id: the record's own file, never through a link, whatever its size (core/io readRenderById). */
export function readById(projectDir: string, id: string): Promise<RenderEntry> {
  return readRenderById(projectPath(projectDir, 'renders'), id);
}

/**
 * Why renders/<id>.json, which is THERE, is no record a by-id call takes — never "not found": core byIdProblem (the one
 * by-id rule, also core/io's for an export or a review job named by its id), as the engine's error. Null: the file is
 * missing (the caller's "not found"), or it is a record of this id — of whatever status.
 */
export function renderFileProblem(entry: RenderEntry, id: string): EngineError | null {
  const p = byIdProblem(entry, id);
  return p ? new EngineError(p.kind, p.message) : null;
}

/**
 * The render a review compares `current` with by default (L7.11: the records rule the review package's findPrevious
 * runs, over core, not the reviewer's): core previousRender over the complete records of their own file of renders/
 * (core renderRecordsOf), whose video is there. Undefined when there is none.
 */
export async function previousOfRender(
  projectDir: string,
  current: Pick<StoredRenderRecord, 'file' | 'scenario' | 'variant' | 'created_at' | 'render_version'>,
): Promise<CompleteRender | undefined> {
  return previousRender(renderRecordsOf(await renderEntries(projectDir)), current, existsSync);
}
