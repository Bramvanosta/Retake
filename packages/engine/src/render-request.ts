/**
 * A render request planned in this process (no browser), through the trust gates of work submitted through MCP: its
 * names checked, its overrides parsed, the run `latest` picks and what it passed over, where the plan's edit comes from.
 * The render job submits what this plans (jobs/render-job.ts); the render views plan with it too (renders.ts).
 */
import { isRunId, isThemeName } from '@retake/core/ids';
import { untilStep } from '@retake/core/run';
import type { LoadedProject } from '@retake/core/model';
import type { NotUsable } from '@retake/core/run';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditOverrides } from '@retake/editor/plan';
import { EditOverridesInputSchema } from './jobs/job-input.js';
import type { EditOverridesInput } from './jobs/job-input.js';
import type { PlannedRun } from './render/editor-calls.js';
import { planTrustProblems } from './render/editor-calls.js';
import { ENGINE_TRUST } from './caller.js';
import { EngineError, toEngineError } from './errors.js';
import { planWork } from './pipeline.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug, checkRunId, checkScenarioName } from './refs.js';
import type { OpenedWorkspace } from './workspace.js';

export interface RenderRequest {
  project: string;
  scenario: string;
  /** A capture run of the scenario (default: its latest capture). */
  run_id?: string;
  /** A theme name (template_list): never a folder. */
  template?: string;
  overrides?: EditOverridesInput;
  /** Review the render in the same job once it is written (L4.5, critique B12): contact sheets at `fps`. */
  review?: { fps: 1 | 2 };
  /**
   * sha256 of the scenario file as the client showed it (the Studio timeline's `hash`, L4.5 part E): after planning and
   * before the id is reserved, the file the edit was planned from — today's file when the edit comes from the run — must
   * still be that one, else `conflict` (nothing reserved, nothing queued): what was clicked is what renders.
   */
  expect_edit_sha256?: string;
}

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `retake render` command a human runs for (about) the same render (overrides other than the theme are not carried). */
export function renderCommandLine(cli: string, r: { project: string; scenario: string; run_id?: string; template?: string }): string {
  return [cli, 'render', r.project, r.scenario, ...(r.run_id ? ['--run', q(r.run_id)] : []), ...(r.template ? ['--theme', q(r.template)] : [])].join(' ');
}

/** Check the names of a render request and parse its overrides (strict, bounded): EngineError `invalid`. */
export function checkRenderRequest(req: RenderRequest): EditOverridesInput {
  checkProjectSlug(req.project);
  checkScenarioName(req.scenario);
  if (req.run_id !== undefined) checkRunId(req.run_id);
  if (req.template !== undefined && !isThemeName(req.template)) {
    throw new EngineError('invalid', `invalid theme "${String(req.template)}": a theme name (template_list names them), never a path`);
  }
  if (req.review !== undefined && !(req.review && typeof req.review === 'object' && (req.review.fps === 1 || req.review.fps === 2) && Object.keys(req.review).length === 1)) {
    throw new EngineError('invalid', 'invalid review: {fps: 1} or {fps: 2} (contact sheet frames per second)');
  }
  if (req.expect_edit_sha256 !== undefined && (typeof req.expect_edit_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(req.expect_edit_sha256))) {
    throw new EngineError('invalid', 'invalid expect_edit_sha256: the sha256 of the scenario file as shown (64 lower-case hex characters)');
  }
  const parsed = EditOverridesInputSchema.safeParse(req.overrides ?? {});
  if (!parsed.success) {
    throw new EngineError('invalid', `invalid overrides: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(overrides)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/**
 * Where a planned render's edit comes from (L5.5): `scenario` — today's scenario file re-planned on the run (its filmed
 * part is unchanged since the capture); `run` — the run as captured. `scenario_changed`: the filmed part changed since
 * the capture (re-capture to film it; absent when either file is missing), `filmed_changes` what changed in it,
 * `edit_changes` what today's edit changed. Both lists hold keys, scene ids and step keys only (trusted words).
 */
export interface RenderEditSource {
  edit: 'scenario' | 'run';
  scenario_changed?: boolean;
  filmed_changes?: string[];
  edit_changes?: string[];
}

/** A planned run's edit source, as the engine reports it. */
export function editSourceOf(planned: Pick<PlannedRun, 'edit'>): RenderEditSource {
  const e = planned.edit;
  return {
    edit: e.from,
    ...(e.scenario_changed !== undefined ? { scenario_changed: e.scenario_changed } : {}),
    ...(e.filmed_changes?.length ? { filmed_changes: e.filmed_changes } : {}),
    ...(e.changes?.length ? { edit_changes: e.changes } : {}),
  };
}

/**
 * What `latest` said of the run it picked (core latestTake) — absent members: nothing to say; a run named by its id:
 * none. `passed_over`: how many newer captures of the scenario it did not take (failed, cancelled, not finished,
 * without their film…) — a count, which a trusted line may say. `not_considered`: how many newer run folders it met
 * whose run.json is missing or does not read as a record (nothing says which scenario they are of). `until`: the capture picked was stopped by `--until`:
 * a render shows the scenario up to there — after this step when run.json names it as a scenario does (a scene id and a
 * whole number: run.json is a file anyone may write, and only such words are repeated); else `{}`.
 */
export interface LatestRunNotice {
  passed_over?: number;
  not_considered?: number;
  until?: { scene?: string; step?: number };
}

/**
 * The newer captures `latest` passed over, newest first (at most core PASSED_OVER_MAX; `passed_over` counts them all):
 * each run's folder name and why, in the rule's closed list of reasons. A folder's name is text anyone who can write
 * runs/ chose: it is kept under `untrusted`, never said in a trusted line.
 */
export type PassedOverRuns = Array<{ run_id: string; why: NotUsable }>;

/** What `latest` said of a planned run: the notice, and the runs it passed over (empty: none, or the run was named). */
export function latestNoticeOf(planned: Pick<PlannedRun, 'run'>): { notice: LatestRunNotice; passed: PassedOverRuns } {
  const pick = planned.run.latest;
  if (!pick) return { notice: {}, passed: [] };
  const count = pick.passed.length + pick.passed_more;
  return {
    // Where a capture stopped by `--until` ends, in words that can be repeated (core untilStep), else `{}`.
    notice: {
      ...(count > 0 ? { passed_over: count } : {}),
      ...(pick.without_record > 0 ? { not_considered: pick.without_record } : {}),
      ...(pick.take?.until ? { until: untilStep(pick.take.until) ?? {} } : {}),
    },
    passed: pick.passed.map((p) => ({ run_id: p.run, why: p.why })),
  };
}

/**
 * Plan a render request in this process (no browser), through the trust gates of work submitted through MCP. A
 * refusal is EngineError `refused` with the `retake render` command a human runs. The plan's edit comes from today's
 * scenario file when its filmed part is unchanged since the run, else from the run as captured (L5.5, editor planRun):
 * `source` says which and what changed. `editText` (L4.6): a text read instead of today's file (a proposal's preview).
 */
export async function planRenderRequest(
  ws: OpenedWorkspace,
  cli: string,
  req: RenderRequest,
  o: { registry?: ComponentRegistry; musicLength?: (file: string) => Promise<number | undefined>; editText?: string } = {},
): Promise<{ project: LoadedProject; planned: PlannedRun; overrides: EditOverridesInput; source: RenderEditSource }> {
  const overrides = checkRenderRequest(req);
  const project = await openProjectBySlug(ws, req.project);
  try {
    const planned = await planWork({
      workPolicy: ws.policy,
      project,
      run: req.run_id ?? 'latest',
      scenario: req.scenario,
      ...(req.template !== undefined ? { template: req.template } : {}),
      overrides: overrides as EditOverrides,
      root: ws.root,
      trust: ENGINE_TRUST,
      ...(o.registry ? { registry: o.registry } : {}),
      ...(o.musicLength ? { musicLength: o.musicLength } : {}),
      // L4.6 (critique B9): a proposal previewed in the timeline is planned from its text in memory, never written.
      ...(o.editText !== undefined ? { editText: o.editText } : {}),
    });
    // The run id reaches trusted summaries: `latest` picks only run ids (editor findRun); never one of another shape.
    if (!isRunId(planned.run.id)) {
      throw new EngineError('invalid', 'the run picked is not a run id of runs/ (letters, digits, ".", "_", "-"): pass run_id (run_list names the runs)');
    }
    return { project, planned, overrides, source: editSourceOf(planned) };
  } catch (e) {
    const refused = await planTrustProblems(e);
    if (refused) throw new EngineError('refused', refused.message, { fix: renderCommandLine(cli, req), details: { problems: refused.problems } });
    throw toEngineError(e);
  }
}
