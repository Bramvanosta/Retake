/** What the pure checks share: their context, where a frame is, a finding, and how a report names a local URL. */
import { displayUrl, findLocalUrls, isLocalUrl, shownUrl as namedUrl } from '@retake/core/environment';
import type { DisplayEntry } from '@retake/core/environment';
import type { Timeline } from '@retake/core/run';
import type { StoredRunRecord, UnknownStatusRun } from '@retake/core/run';
import type { ComponentManifest, ComponentRegistry, TextMeasurer } from '@retake/components/geometry';
import type { EditPlan, NamedRender } from '@retake/editor/plan';
import type { OutputClick } from './timeline.js';
import type { Finding, FindingAt, ReviewRules, Severity } from './types.js';
import type { SegmentSpan, TransitionSpan } from './spans.js';
import { isClip, round, spanAt, stepAt } from './spans.js';

export interface CheckContext {
  record: NamedRender;
  plan: EditPlan;
  timeline?: Timeline;
  rules: ReviewRules;
  spans: SegmentSpan[];
  transitions: TransitionSpan[];
  clicks: OutputClick[];
  registry?: ComponentRegistry;
  measure: TextMeasurer;
  /** The run's run.json (its `perf`), when it can be read. */
  run?: StoredRunRecord | UnknownStatusRun;
}

/** Where a frame is: time, segment, scene and step (from the plan's provenance). */
export function locate(ctx: Pick<CheckContext, 'plan' | 'spans'>, frame: number, extra: Partial<FindingAt> = {}): FindingAt {
  const f = Math.max(0, Math.min(ctx.plan.durationInFrames - 1, Math.round(frame)));
  const span = spanAt(ctx.spans, f);
  const at: FindingAt = { frame: f, time: round(f / ctx.plan.fps, 2) };
  if (span) {
    at.segment = span.segment.id;
    if (isClip(span.segment)) {
      at.scene = span.segment.scene;
      const st = stepAt(span.segment, f - span.segment.from);
      if (st) at.step = st.step;
    } else if (span.segment.kind === 'card' || span.segment.kind === 'interstitial') at.scene = span.segment.id;
  }
  return { ...at, ...extra };
}

export const finding = (severity: Severity, code: string, message: string, at?: FindingAt): Finding => (at ? { severity, code, message, at } : { severity, code, message });

export const fmtS = (s: number) => `${s.toFixed(1)} s`;

export function manifestOf(registry: ComponentRegistry | undefined, id: string): ComponentManifest | undefined {
  if (!registry) return undefined;
  try {
    return registry.get(id).manifest;
  } catch {
    return undefined;
  }
}

export const inside = (p: { x: number; y: number }, v: { cx: number; cy: number; w: number; h: number }, margin: number) =>
  p.x >= v.cx - v.w / 2 + margin && p.x <= v.cx + v.w / 2 - margin && p.y >= v.cy - v.h / 2 + margin && p.y <= v.cy + v.h / 2 - margin;

/** The path (and query) of a local URL, also written without a scheme (`localhost:3000/x`); a file: URL's file name. */
export function pathOf(url: string): string {
  return namedUrl(/^(?:https?|file|blob|filesystem):/i.test(url) ? url : `http://${url}`, []);
}

/** A local URL as a report may name it: its path (never the local host), "(a local page)". */
export function localPath(url: string): string {
  const p = pathOf(url);
  return p ? `${p} (a local page)` : 'a local page';
}

/** A text with every local URL it names reduced to "a local page" / "<path> (a local page)". */
export function maskLocalUrls(text: string): string {
  let out = text;
  for (const u of findLocalUrls(text)) {
    const p = pathOf(u);
    out = out.split(u).join(p && p !== '/' ? `${p} (a local page)` : 'a local page');
  }
  return out;
}

/** A real URL of the run as the report names it: the display URL, else (still local) its path. */
export function shownUrl(url: string, table: readonly DisplayEntry[]): string {
  const d = displayUrl(url, table);
  return isLocalUrl(d) ? localPath(d) : d;
}

/** The first output frame showing capture time `t` or the moment after it (a trimmed moment: the next one shown). */
export function outputFrameAtCapture(ctx: Pick<CheckContext, 'plan'>, t: number): number | undefined {
  const src = Math.round(t * ctx.plan.source.fps);
  for (const s of ctx.plan.segments) {
    if (!isClip(s) || s.srcFrames.length === 0) continue;
    const f = s.srcFrames;
    if (src < f[0] - 2 || src > f[f.length - 1] + 2) continue;
    let lo = 0;
    let hi = f.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid] < src) lo = mid + 1;
      else hi = mid;
    }
    return s.from + Math.min(lo, f.length - 1);
  }
  return undefined;
}
