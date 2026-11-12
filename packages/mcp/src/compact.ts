/**
 * Compact results (L5.8, R-FLD-34): what review / review_get and page_inspect return by default — the findings, the
 * paths to read — and, with `detail: "full"`, everything as before. The field measured ≈ 15,000 tokens per
 * page_inspect and over 25,000 for a review (cut by the client). Nothing the summary says is dropped: the files keep the
 * rest (inspect.json, report.json). The `detail` argument and the run status's compact are the engine's operations'
 * (L7.13: @retake/engine/contract), re-exported here.
 *
 * Trust is unchanged: what the filmed site or the scenario wrote stays under `untrusted` (capUntrusted still applies).
 */
import { COMPACT_FINDINGS_MAX, cutMessage as cut } from '@retake/engine/contract';
import type { ReviewView } from '@retake/engine';

export { COMPACT_FINDINGS_MAX, COMPACT_MESSAGE_MAX, COMPACT_WARNINGS_MAX, compactRunStatus, detail } from '@retake/engine/contract';
export type { Detail } from '@retake/engine/contract';

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
    ...(r.job ? { job: { id: r.job.id, state: r.job.state, ...(r.job.progress ? { progress: r.job.progress } : {}), ...(r.job.error ? { error: { code: r.job.error.code, ...(r.job.error.fix ? { fix: r.job.error.fix } : {}) } } : {}) } } : {}),
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
      ...(kept.length ? { messages: kept.map((x) => cut(x.message ?? '')) } : {}),
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
    const name = typeof u.name === 'string' ? cut(u.name, 120) : '';
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
