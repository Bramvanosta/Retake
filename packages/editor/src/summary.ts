/**
 * A human summary of an EditPlan (CLI `studio plan`, MCP later): segments with their components and transitions,
 * per clip the source range, speeds, trims, zooms, overlays and captions, then captions, markers, notes, warnings.
 */
import type { ClipSegment, EditPlan, PlanSegment, ResolvedComponent } from './plan-types.js';
import { PLAN_ASSET_SCHEME } from './plan-types.js';

const s = (frames: number, fps: number) => `${(frames / fps).toFixed(2)} s`;

function component(rc: ResolvedComponent | null | undefined): string {
  if (!rc) return 'none';
  const flags = [rc.source === 'builtin-default' ? 'built-in default' : rc.source, ...(rc.missing ? ['MISSING'] : [])];
  return `${rc.id} (${flags.join(', ')})`;
}

function transition(seg: PlanSegment, fps: number): string {
  if (!seg.transition) return seg.transitionIn === 'none' ? '—' : seg.transitionIn;
  const t = seg.transition;
  if (t.kind === 'cut') return 'cut';
  return `${t.kind} ${s(t.frames, fps)}`;
}

function clipLines(plan: EditPlan, c: ClipSegment): string[] {
  const fps = plan.fps;
  const out: string[] = [];
  const content = c.durationInFrames - c.heldFrames;
  out.push(`source ${c.src.from_s.toFixed(2)}–${c.src.to_s.toFixed(2)} s of the capture → ${s(content, fps)}${c.heldFrames ? ` + ${s(c.heldFrames, fps)} held` : ''}`);
  const bySpeed = new Map<string, number>();
  let ramps = 0;
  let protectedFrames = 0;
  for (const sp of c.speeds) {
    if (sp.speed === 0) continue;
    if (sp.speed !== sp.to_speed) {
      ramps++;
      continue;
    }
    const key = `${sp.speed}×`;
    bySpeed.set(key, (bySpeed.get(key) ?? 0) + (sp.to - sp.from));
    if (sp.protected) protectedFrames += sp.to - sp.from;
  }
  const speeds = [...bySpeed.entries()].map(([k, f]) => `${k} ${s(f, fps)}`).join(', ');
  out.push(`speed ${speeds || '1×'}${protectedFrames ? ` (1× kept ${s(protectedFrames, fps)}: still, holds, marks)` : ''}${ramps ? `, ${ramps} ramp${ramps === 1 ? '' : 's'}` : ''}`);
  if (c.trims.length) {
    out.push(`trims ${c.trims.map((t) => `${t.src_from_s.toFixed(2)}–${t.src_to_s.toFixed(2)} s cut at ${s(t.at, fps)}`).join('; ')}`);
  }
  for (const z of c.zooms) {
    const clamped = z.requested_zoom !== undefined ? ` (asked ${z.requested_zoom}×, clamped)` : '';
    const out_ = z.out_at >= content ? 'held to the end of the clip' : `eases out at ${s(z.out_at, fps)}`;
    out.push(
      `${z.source === 'theme' ? 'theme zoom' : 'zoom'} ${z.zoom}×${clamped} step ${z.step}: from ${s(z.from, fps)} over ${s(z.in_frames, fps)} on (${Math.round(z.focus.x)}, ${Math.round(z.focus.y)}) → view (${Math.round(z.view.x)}, ${Math.round(z.view.y)}), ${out_}`,
    );
  }
  if (c.reframe && c.layout.crop) {
    const xs = c.reframe.map((r) => r[0]);
    const ys = c.reframe.map((r) => r[1]);
    let step = 0;
    for (let k = 1; k < c.reframe.length; k++) step = Math.max(step, Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]));
    const range = Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
    out.push(`reframe ${Math.round(c.layout.crop.w)}×${Math.round(c.layout.crop.h)} of the capture, ${range ? `travels ${range} px (at most ${step.toFixed(1)} px per frame)` : 'still'}`);
  }
  for (const o of c.overlays) {
    const anchor = o.anchor?.bbox ? ` on box ${Math.round(o.anchor.bbox.x)},${Math.round(o.anchor.bbox.y)} ${Math.round(o.anchor.bbox.w)}×${Math.round(o.anchor.bbox.h)}` : o.anchor?.point ? ` on point ${o.anchor.point.x},${o.anchor.point.y}` : '';
    const text = o.component.slots.text ?? o.component.slots.title;
    out.push(`overlay ${component(o.component)} step ${o.step} at ${s(o.from, fps)} for ${s(o.durationInFrames, fps)}${anchor}${text ? `: "${text}"` : ''}`);
  }
  out.push(`caption ${component(c.caption)}${c.cues.length ? `, ${c.cues.length} cue${c.cues.length === 1 ? '' : 's'}` : ''}`);
  const steps = c.steps.map((st) => `${st.step < 0 ? st.action.replace('scene_', '') : `${st.step}:${st.action}`} ${((st.to - st.from) / fps).toFixed(1)}`).join(', ');
  out.push(`steps ${steps}`);
  return out;
}

/** The summary as lines of plain text. */
export function summarizePlan(plan: EditPlan): string[] {
  const fps = plan.fps;
  const lines: string[] = [];
  lines.push(
    `${plan.meta.scenario} (run ${plan.meta.run_id}) — ${plan.variant} ${plan.width}×${plan.height} @ ${fps} fps — ${s(plan.durationInFrames, fps)} (${plan.durationInFrames} frames) — theme ${plan.meta.theme} — frame ${plan.frame}`,
  );
  lines.push('');
  lines.push('Segments');
  const idW = Math.max(7, ...plan.segments.map((g) => g.id.length));
  lines.push(`  ${'from'.padStart(8)}  ${'length'.padStart(8)}  ${'segment'.padEnd(idW)}  ${'kind'.padEnd(12)}  ${'transition in'.padEnd(16)}  component`);
  for (const g of plan.segments) {
    lines.push(
      `  ${s(g.from, fps).padStart(8)}  ${s(g.durationInFrames, fps).padStart(8)}  ${g.id.padEnd(idW)}  ${g.kind.padEnd(12)}  ${transition(g, fps).padEnd(16)}  ${component(g.component)}`,
    );
    const pad = ' '.repeat(2 + 8 + 2 + 8 + 2);
    if (g.kind === 'clip') for (const l of clipLines(plan, g)) lines.push(`${pad}${l}`);
    else {
      const slots = Object.entries(g.component.slots)
        .filter(([, v]) => v !== undefined && !String(v).startsWith(PLAN_ASSET_SCHEME))
        .map(([k, v]) => `${k}: "${v}"`)
        .join(', ');
      if (slots) lines.push(`${pad}${slots}`);
      if (g.kind === 'interstitial' && g.backdropSrcFrame !== undefined) lines.push(`${pad}backdrop: source frame ${g.backdropSrcFrame}`);
    }
  }
  lines.push('');
  lines.push(`Captions (${plan.captions.length})`);
  for (const c of plan.captions) lines.push(`  ${s(c.from, fps).padStart(8)} – ${s(c.to, fps).padStart(8)}  ${c.scene}: ${c.kicker ? `${c.kicker.toUpperCase()} · ` : ''}${c.text}`);
  if (plan.markers.length) {
    lines.push('');
    lines.push('Markers');
    for (const m of plan.markers) lines.push(`  ${m.name} at ${s(m.frame, fps)} (frame ${m.frame}, ${m.scene})`);
  }
  if (plan.music) {
    lines.push('');
    const m = plan.music;
    const plays = m.plays ? (m.plays.length > 1 ? `, ${m.plays.length} loops of ${m.duration_s} s` : m.duration_s !== undefined ? `, ${m.duration_s} s track` : '') : '';
    lines.push(`Music ${m.file} (volume ${m.volume}, ducked ×${m.duck} under footage${plays})`);
  }
  lines.push('');
  lines.push(`Notes (${plan.notes.length})`);
  for (const n of plan.notes) lines.push(`  - ${n}`);
  lines.push('');
  lines.push(`Warnings (${plan.warnings.length})`);
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  return lines;
}

/**
 * The plan with every `ds-asset:` URL replaced by `resolveUrl(url, file)` (the renderer's asset server). Pure: the
 * input plan is not modified.
 */
export function resolvePlanAssets(plan: EditPlan, resolveUrl: (url: string, file: string) => string): EditPlan {
  const map = new Map(Object.entries(plan.assets).map(([url, file]) => [url, resolveUrl(url, file)]));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.startsWith(PLAN_ASSET_SCHEME) ? (map.get(v) ?? v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk({ ...plan, assets: {} }) as EditPlan;
  out.assets = { ...plan.assets };
  return out;
}
