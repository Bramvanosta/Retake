/**
 * Diff of a render with the previous render of the same scenario: total and per-segment durations, what changed in
 * the plan (components, captions, transitions, run, theme) and which sample frames changed visibly (frames compared
 * at the same offset inside the same segment, so a longer scene does not shift every later comparison).
 */
import type { EditPlan, NamedRender, PlanSegment } from '@retake/editor/plan';
import { isClip, round, segmentSpans, spanAt } from './spans.js';
import type { SegmentSpan } from './spans.js';
import type { Finding, ReviewDiff } from './types.js';

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function componentChange(label: string, a: { id: string; version: string; params: unknown; slots?: unknown } | null | undefined, b: typeof a): string | undefined {
  if (!a && !b) return undefined;
  if (!a || !b) return `${label}: ${a?.id ?? 'none'} → ${b?.id ?? 'none'}`;
  if (a.id !== b.id) return `${label}: ${a.id} → ${b.id}`;
  if (a.version !== b.version) return `${label}: ${a.id} ${a.version} → ${b.version}`;
  if (!same(a.params, b.params)) return `${label} params of ${a.id}`;
  if (!same(a.slots, b.slots)) return `${label} texts of ${a.id}`;
  return undefined;
}

function segmentChanges(prev: PlanSegment, cur: PlanSegment): string[] {
  const out: string[] = [];
  const c = componentChange(prev.kind === 'clip' ? 'layout' : 'component', prev.component, cur.component);
  if (c) out.push(c);
  if ((prev.transition?.kind ?? 'none') !== (cur.transition?.kind ?? 'none')) out.push(`transition in: ${prev.transition?.kind ?? 'none'} → ${cur.transition?.kind ?? 'none'}`);
  else {
    const t = componentChange('transition', prev.transition?.component, cur.transition?.component);
    if (t) out.push(t);
  }
  if (isClip(prev) && isClip(cur)) {
    const cap = componentChange('caption', prev.caption, cur.caption);
    if (cap) out.push(cap);
    if (
      !same(
        prev.cues.map((x) => [x.kicker, x.text]),
        cur.cues.map((x) => [x.kicker, x.text]),
      )
    )
      out.push('caption text');
    if (!same(prev.layout, cur.layout)) out.push('layout geometry');
    if (
      !same(
        prev.zooms.map((z) => [z.step, z.zoom]),
        cur.zooms.map((z) => [z.step, z.zoom]),
      )
    )
      out.push('camera zooms');
    if (
      !same(
        prev.overlays.map((o) => [o.component.id, o.step]),
        cur.overlays.map((o) => [o.component.id, o.step]),
      )
    )
      out.push('overlays');
    if (prev.src.from_s !== cur.src.from_s || prev.src.to_s !== cur.src.to_s) out.push(`source range ${prev.src.from_s}–${prev.src.to_s} s → ${cur.src.from_s}–${cur.src.to_s} s`);
  }
  return out;
}

/** The plan-level part of the diff (no pixels). */
export function diffRecords(previous: NamedRender, current: NamedRender): Omit<ReviewDiff, 'compared' | 'changed_frames'> {
  const ps = segmentSpans(previous.plan);
  const cs = segmentSpans(current.plan);
  const pf = previous.plan.fps;
  const cf = current.plan.fps;
  const dur = (s: SegmentSpan, fps: number) => (s.to - s.from) / fps;
  const segments: ReviewDiff['segments'] = [];
  for (const c of cs) {
    const p = ps.find((x) => x.segment.id === c.segment.id);
    if (!p) {
      segments.push({ id: c.segment.id, status: 'added', duration_s: round(dur(c, cf), 3), changes: [] });
      continue;
    }
    const changes = segmentChanges(p.segment, c.segment);
    const delta = round(dur(c, cf) - dur(p, pf), 3);
    segments.push({
      id: c.segment.id,
      status: changes.length > 0 || Math.abs(delta) > 0.0005 ? 'changed' : 'same',
      previous_duration_s: round(dur(p, pf), 3),
      duration_s: round(dur(c, cf), 3),
      duration_delta_s: delta,
      changes,
    });
  }
  for (const p of ps) if (!cs.some((c) => c.segment.id === p.segment.id)) segments.push({ id: p.segment.id, status: 'removed', previous_duration_s: round(dur(p, pf), 3), changes: [] });
  const pd = previous.plan.durationInFrames / pf;
  const cd = current.plan.durationInFrames / cf;
  const out: Omit<ReviewDiff, 'compared' | 'changed_frames'> = {
    previous: previous.id,
    previous_file: previous.file,
    duration_s: { previous: round(pd, 3), current: round(cd, 3), delta: round(cd - pd, 3) },
    segments,
  };
  if (previous.template !== current.template) out.template = { previous: previous.template, current: current.template };
  if (previous.run_id !== current.run_id) out.run = { previous: previous.run_id, current: current.run_id };
  return out;
}

/** Frame pairs to compare: each current frame with the previous render's frame at the same offset of the same segment. */
export function framePairs(previous: EditPlan, current: EditPlan, frames: number[]): Array<{ frame: number; previous_frame: number; segment: string }> {
  const ps = segmentSpans(previous);
  const cs = segmentSpans(current);
  const out: Array<{ frame: number; previous_frame: number; segment: string }> = [];
  for (const f of frames) {
    const c = spanAt(cs, f);
    if (!c) continue;
    const p = ps.find((x) => x.segment.id === c.segment.id);
    if (!p) continue;
    const offset = Math.round(((f - c.from) / current.fps) * previous.fps);
    if (offset >= p.to - p.from || p.from + offset >= previous.durationInFrames) continue;
    out.push({ frame: f, previous_frame: p.from + offset, segment: c.segment.id });
  }
  return out;
}

/** Informational findings summarising a diff. */
export function diffFindings(d: ReviewDiff): Finding[] {
  const out: Finding[] = [];
  const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} s`;
  out.push({
    severity: 'info',
    code: 'diff-duration',
    message: `${d.duration_s.current.toFixed(2)} s (${d.previous}: ${d.duration_s.previous.toFixed(2)} s, ${sign(d.duration_s.delta)})${d.template ? `; theme ${d.template.previous} → ${d.template.current}` : ''}${d.run ? `; run ${d.run.previous} → ${d.run.current}` : ''}`,
  });
  for (const s of d.segments) {
    if (s.status === 'same') continue;
    const what =
      s.status === 'added'
        ? `new segment (${s.duration_s?.toFixed(2)} s)`
        : s.status === 'removed'
          ? `removed (was ${s.previous_duration_s?.toFixed(2)} s)`
          : [Math.abs(s.duration_delta_s ?? 0) > 0.0005 ? `${sign(s.duration_delta_s ?? 0)}` : '', ...s.changes].filter(Boolean).join('; ');
    out.push({ severity: 'info', code: 'diff-segment', message: `"${s.id}": ${what}`, at: { segment: s.id } });
  }
  out.push({
    severity: 'info',
    code: 'diff-frames',
    message: d.changed_frames.length
      ? `${d.changed_frames.length} of ${d.compared} sample frames changed visibly since ${d.previous}${d.sheet ? ' (side by side in the diff sheet)' : ''}`
      : `no visible change in ${d.compared} sample frames since ${d.previous}`,
  });
  return out;
}
