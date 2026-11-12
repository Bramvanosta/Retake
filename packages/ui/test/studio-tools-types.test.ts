/**
 * The types the app's StudioOps (src/app/data/ops.ts) is derived from, held exactly for a few of the operations the
 * Studio shares with MCP (L7.13: they became the engine's operations; written on the commit before the move): each
 * op's arguments as a page sends them (`ToolArgs`, the Studio's pinned arguments applied) and its answer (`ToolData`)
 * of `StudioTools` (server/studio.ts). A type that widens or narrows fails `pnpm typecheck` (tsconfig.test.json), not
 * this file's run: the run only says the file is part of the suite.
 */
import { describe, expect, it } from 'vitest';
import type { ToolArgs, ToolData } from '@retake/engine/contract';
import type { AuthStatus, EngineInfo, JobRecord, ProjectSummary, ProjectView, RunListItem, RunStatusWithJob } from '@retake/engine';
import type { CompactRunStatus } from '@retake/engine';
import type { StaleEngine } from '@retake/core/io';
import type { StudioTools } from '../src/server/studio.js';

/** A and B are each other's (mutually assignable) and have the same keys (an extra optional member counts). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Exact<A, B> = Same<A, B> extends true ? Same<keyof A, keyof B> : false;
type Holds<T extends true> = T;

type Args<K extends keyof StudioTools> = ToolArgs<StudioTools[K]>;
type Data<K extends keyof StudioTools> = ToolData<StudioTools[K]>;

/** The worker as engine_info and job_list say it (job_list without `started_by` / `other_copy`). */
type WorkerOfList = { pid: number; since: string; build: NonNullable<Awaited<ReturnType<import('@retake/engine').Engine['jobs']['worker']>>>['build'] };

export type Checks = [
  // engine_info: no argument; the engine's info with what the op adds.
  Holds<Exact<Args<'engine_info'>, Record<string, never>>>,
  Holds<Exact<Pick<Data<'engine_info'>, keyof EngineInfo>, EngineInfo>>,
  Holds<Exact<Data<'engine_info'>['stale'], StaleEngine | null>>,
  Holds<Exact<Data<'engine_info'>['started_in'], string>>,
  Holds<Exact<Data<'engine_info'>['started_outside_workspace'], boolean>>,
  Holds<Exact<Data<'engine_info'>['projects'], number>>,
  // project_list / project_get.
  Holds<Exact<Args<'project_list'>, Record<string, never>>>,
  Holds<Exact<Data<'project_list'>, { root: string; projects_dir: string; projects: ProjectSummary[] }>>,
  Holds<Exact<Args<'project_get'>, { project: string }>>,
  Holds<Exact<Data<'project_get'>, ProjectView & { sandbox_advice?: { detail: string; hint: string } }>>,
  // project_update_readme.
  Holds<Exact<Args<'project_update_readme'>, { project: string; markdown: string; if_match?: string | null | undefined }>>,
  Holds<Exact<Data<'project_update_readme'>, { project: string; file: string; path: string; hash: string }>>,
  // run_list.
  Holds<Exact<Args<'run_list'>, { project: string; scenario?: string | undefined; mode?: 'capture' | 'dry' | undefined; limit?: number | undefined }>>,
  Holds<Exact<Data<'run_list'>, { project: string; runs: RunListItem[] }>>,
  // run_status, its wait pinned to 0 in the Studio.
  Holds<Exact<Args<'run_status'>, { project: string; run_id: string; detail?: 'compact' | 'full' | undefined; wait_s?: 0 | undefined }>>,
  Holds<Exact<Data<'run_status'>, RunStatusWithJob | CompactRunStatus>>,
  // run_cancel.
  Holds<Exact<Args<'run_cancel'>, { project: string; run_id: string }>>,
  Holds<Exact<Data<'run_cancel'>, RunStatusWithJob>>,
  // job_list.
  Holds<Exact<Args<'job_list'>, { project?: string | undefined; state?: Array<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'> | undefined; limit?: number | undefined }>>,
  Holds<Exact<Data<'job_list'>, { jobs: Array<JobRecord & { untrusted?: { error: string } }>; worker: WorkerOfList | null }>>,
  // auth_status.
  Holds<Exact<Args<'auth_status'>, { project?: string | undefined; env?: string | undefined }>>,
  Holds<Exact<Data<'auth_status'>, AuthStatus>>,
  // auth_login, its mode pinned to headed and its wait to 0 in the Studio.
  Holds<Exact<Args<'auth_login'>, { project: string; persona?: string | undefined; env?: string | undefined; mode?: 'headed' | undefined; wait_s?: 0 | undefined }>>,
  Holds<Exact<Data<'auth_login'>, JobRecord>>,
  // scenario_validate.
  Holds<Exact<Args<'scenario_validate'>, { project: string; yaml: string; env?: string | undefined; until?: string | undefined; name?: string | undefined }>>,
];

describe("the Studio's shared operations, as types", () => {
  it('are held by the type check (pnpm typecheck), not at run time', () => {
    expect(true).toBe(true);
  });
});
