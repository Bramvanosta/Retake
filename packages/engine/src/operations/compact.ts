/**
 * Compact results (L5.8, R-FLD-34): the `detail` argument, the run status as run_status returns it by default — the
 * status, where it failed, the paths to read — and the review as review_get returns it, and, with `detail: "full"`,
 * everything as before (moved from the MCP server's compact.ts: the run's in L7.13 with run_status, the review's in
 * L7.14 with review_get, the inspection's in L7.15 with page_inspect). Nothing the summary says is dropped: run.json and
 * report.json keep the rest.
 *
 * Trust is unchanged: what the filmed site or the scenario wrote stays under `untrusted` (capUntrusted still applies).
 */
import { z } from 'zod';
import { perfSummary } from '@retake/core/run';
import type { CompactRunStatus, RunStatusWithJob } from '../facade/types.js';
import type { ReviewView } from '../reviews.js';

export const detail = z
  .enum(['compact', 'full'])
  .default('compact')
  .describe('"compact" (default): what to act on — status, where it failed, findings, the paths to read; "full": every field (all elements, files, timings), several times longer.');

export type Detail = z.infer<typeof detail>;

/** Warnings a compact run status carries (the rest are counted; run.json and log.jsonl have them all). */
export const COMPACT_WARNINGS_MAX = 8;
/** Findings a compact review carries besides its errors (every error is kept). */
export const COMPACT_FINDINGS_MAX = 30;
/** Characters of one untrusted message in a compact result. */
export const COMPACT_MESSAGE_MAX = 400;

/** One untrusted message of a compact result, cut to `max` characters (saying how many more). */
export const cutMessage = (s: string, max = COMPACT_MESSAGE_MAX): string => (s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s);

/** A run's status, compact: no per-step screenshot list, no hashes, the take's cost as one line. */
export function compactRunStatus(r: RunStatusWithJob): CompactRunStatus {
  const out = (name: string) => r.outputs.find((o) => o.ref.endsWith(`/${name}`))?.path;
  const hooks = Object.fromEntries(Object.entries(r.hooks).filter(([, v]) => v !== undefined && v !== 'none'));
  const warnings = r.untrusted.warnings;
  return {
    id: r.id,
    project: r.project,
    scenario: r.scenario,
    mode: r.mode,
    env: r.env,
    status: r.status,
    finished: r.finished,
    steps_done: r.steps_done,
    steps_total: r.steps_total,
    ...(r.duration_ms !== undefined ? { duration_s: Math.round(r.duration_ms / 100) / 10 } : {}),
    ...(r.current && !r.finished ? { current: r.current } : {}),
    ...(r.paused && !r.finished ? { paused: r.paused } : {}),
    ...(r.stopped_at ? { stopped_at: r.stopped_at } : {}),
    ...(Object.keys(hooks).length ? { hooks } : {}),
    ...(r.error
      ? {
          error: {
            ...(r.error.scene !== undefined ? { scene: r.error.scene } : {}),
            ...(r.error.step !== undefined ? { step: r.error.step } : {}),
            ...(r.error.action !== undefined ? { action: r.error.action } : {}),
            ...(r.error.screenshot ? { screenshot: r.error.screenshot.path } : {}),
            ...(r.error.dom ? { dom: r.error.dom.path } : {}),
          },
        }
      : {}),
    ...(r.optional_failures?.length
      ? { optional_failures: r.optional_failures.map((f) => ({ scene: f.scene, step: f.step, action: f.action, ...(f.screenshot ? { screenshot: f.screenshot.path } : {}) })) }
      : {}),
    ...(r.perf ? { perf: perfSummary(r.perf) } : {}),
    files: {
      dir: r.dir,
      ...(out('capture.mp4') ? { capture: out('capture.mp4') } : {}),
      ...(out('timeline.json') ? { timeline: out('timeline.json') } : {}),
      ...(r.screenshots.length ? { screenshots: { dir: `${r.dir}/screenshots`, count: r.screenshots.length } } : {}),
    },
    ...(r.job
      ? {
          job: {
            id: r.job.id,
            state: r.job.state,
            ...(r.job.queue ? { queue: r.job.queue } : {}),
            ...(r.job.cancel_requested_at ? { cancel_requested_at: r.job.cancel_requested_at } : {}),
            ...(r.job.pause_requested_at ? { pause_requested_at: r.job.pause_requested_at } : {}),
            ...(r.job.error ? { error: r.job.error } : {}),
          },
        }
      : {}),
    untrusted: {
      ...(r.untrusted.error_message !== undefined ? { error_message: r.untrusted.error_message } : {}),
      ...(r.untrusted.missing_targets?.length ? { missing_targets: r.untrusted.missing_targets } : {}),
      ...(r.untrusted.optional_errors?.length ? { optional_errors: r.untrusted.optional_errors.map((m) => cutMessage(m)) } : {}),
      ...(warnings.length ? { warnings: warnings.slice(0, COMPACT_WARNINGS_MAX).map((w) => cutMessage(w)) } : {}),
      ...(warnings.length > COMPACT_WARNINGS_MAX ? { warnings_total: warnings.length } : {}),
    },
  };
}

/**
 * A review, compact: the verdict, the findings that are not notes (errors first, at most COMPACT_FINDINGS_MAX besides
 * the errors) with their messages, the contact sheet and report paths; no per-segment durations, per-file key frames or
 * per-segment diff.
 */
export function compactReview(r: ReviewView): Record<string, unknown> {
  const findings = (r.findings ?? []).map((f, i) => ({ f, message: r.untrusted.messages?.[i] }));
  const errors = findings.filter((x) => x.f.severity === 'error');
  const others = findings.filter((x) => x.f.severity === 'warning');
  const kept = [...errors, ...others.slice(0, COMPACT_FINDINGS_MAX)];
  const files = r.files;
  return {
    project: r.project,
    render_id: r.render_id,
    status: r.status,
    finished: r.finished,
    ...(r.job
      ? {
          job: {
            id: r.job.id,
            state: r.job.state,
            ...(r.job.progress ? { progress: r.job.progress } : {}),
            ...(r.job.error ? { error: { code: r.job.error.code, ...(r.job.error.fix ? { fix: r.job.error.fix } : {}) } } : {}),
          },
        }
      : {}),
    ...(r.created_at ? { created_at: r.created_at } : {}),
    ...(r.fps ? { fps: r.fps } : {}),
    ...(r.clean !== undefined ? { clean: r.clean } : {}),
    ...(r.counts ? { counts: r.counts } : {}),
    ...(r.durations ? { duration_s: r.durations.total_s } : {}),
    ...(kept.length ? { findings: kept.map((x) => x.f) } : {}),
    ...(others.length > COMPACT_FINDINGS_MAX ? { findings_left_out: others.length - COMPACT_FINDINGS_MAX } : {}),
    ...(r.diff ? { diff: { previous: r.diff.previous, compared: r.diff.compared, changed_frames: r.diff.changed_frames, ...(r.diff.duration_s ? { duration_s: r.diff.duration_s } : {}) } } : {}),
    ...(r.dir ? { dir: r.dir } : {}),
    ...(files
      ? {
          files: {
            sheets: files.sheets,
            ...(files.report_md ? { report_md: files.report_md } : {}),
            report_json: files.report_json,
            ...(Object.keys(files.keyframes).length ? { keyframes: { dir: `${r.dir}/keyframes`, count: Object.keys(files.keyframes).length } } : {}),
            // sheet_scene_<scene>.jpg next to the contact sheet, one per scene (several pages for a long one).
            ...(Object.keys(files.scene_sheets).length ? { scene_sheets: Object.values(files.scene_sheets).flat().length } : {}),
            ...(files.diff_sheet ? { diff_sheet: files.diff_sheet } : {}),
          },
        }
      : {}),
    untrusted: {
      ...(kept.length ? { messages: kept.map((x) => cutMessage(x.message ?? '')) } : {}),
      ...(r.untrusted.error !== undefined ? { error: r.untrusted.error } : {}),
    },
  };
}

/** One inspected element, compact: its mark, where it is, its action and the step hint to copy; flags only when set. */
export interface CompactElement {
  mark: number;
  in: string;
  action: string;
  /** Visible matches of its target without `nth`, when not 1. */
  matches?: number;
  fragile?: string[];
  /** Its state flags that are set: disabled, expanded, checked, selected, covered. */
  state?: string[];
  /** Out of view (listed because it is in a dialog, a menu or a popover). */
  out_of_view?: true;
  untrusted: { role: string | null; name: string; hint?: string; target?: string | null; href_path?: string };
}

const STATE_FLAGS = ['disabled', 'expanded', 'checked', 'selected', 'covered'] as const;

/** Elements of an inspection, compact: those in view or in a dialog, menu, listbox or popover. */
export function compactElements(elements: ReadonlyArray<Record<string, unknown>>): { elements: CompactElement[]; left_out: number } {
  const out: CompactElement[] = [];
  let left = 0;
  for (const e of elements) {
    const inView = e.in_view === true;
    const floating = e.in !== 'page' && e.in !== 'row';
    if (!inView && !floating) {
      left++;
      continue;
    }
    const u = (e.untrusted ?? {}) as Record<string, unknown>;
    const st = (e.state ?? {}) as Record<string, unknown>;
    const flags = STATE_FLAGS.filter((k) => st[k] === true);
    const fragile = Array.isArray(e.fragile) ? (e.fragile as string[]) : [];
    const hint = (u.hint as { yaml?: string } | null | undefined)?.yaml;
    const name = typeof u.name === 'string' ? cutMessage(u.name, 120) : '';
    out.push({
      mark: e.mark as number,
      in: String(e.in),
      action: String(e.action),
      ...(typeof e.matches === 'number' && e.matches !== 1 ? { matches: e.matches } : {}),
      ...(fragile.length ? { fragile } : {}),
      ...(flags.length ? { state: [...flags] } : {}),
      ...(!inView ? { out_of_view: true as const } : {}),
      untrusted: {
        role: (u.role as string | null) ?? null,
        name,
        ...(hint ? { hint } : { target: (u.target_yaml as string | null) ?? null }),
        ...(typeof u.href_path === 'string' && u.role === 'link' ? { href_path: u.href_path } : {}),
      },
    });
  }
  return { elements: out, left_out: left };
}
