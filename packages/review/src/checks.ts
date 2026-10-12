/**
 * The checks of a review that need no pixels (pure): durations, captions (scene mismatch, overlaps, too long for their
 * area, brand mark), text slots, cursor at clicks, long scenes at ~1×, camera zooms, transitions over clicks, and the
 * render itself (status, probe, missing components, plan warnings). Pixel checks live in ./pixel-checks.ts.
 */
import type { Timeline } from '@demo-studio/core';
import { CAPTION_BAND_PAD_X, captionBandBox, captionMaxLines, fitText } from '@demo-studio/components';
import type { ComponentManifest, ComponentRegistry, TextMeasurer } from '@demo-studio/components';
import { brandmarkRect, mapSourceRect, trackBoxAt, viewOf } from '@demo-studio/editor';
import type { CameraFrame, ClipSegment, EditPlan, RenderRecord, ResolvedComponent } from '@demo-studio/editor';
import type { OutputClick } from './timeline.js';
import { cursorAt } from './timeline.js';
import type { Finding, FindingAt, ReviewRules, SegmentDuration, Severity } from './types.js';
import type { SegmentSpan, TransitionSpan } from './spans.js';
import { isClip, meanSpeed, round, segmentLabel, spanAt, stepAt, timecode } from './spans.js';

export interface CheckContext {
  record: RenderRecord;
  plan: EditPlan;
  timeline?: Timeline;
  rules: ReviewRules;
  spans: SegmentSpan[];
  transitions: TransitionSpan[];
  clicks: OutputClick[];
  registry?: ComponentRegistry;
  measure: TextMeasurer;
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

const finding = (severity: Severity, code: string, message: string, at?: FindingAt): Finding => (at ? { severity, code, message, at } : { severity, code, message });

const fmtS = (s: number) => `${s.toFixed(1)} s`;

// ── Render ────────────────────────────────────────────────────────────────────

export function checkRender(ctx: CheckContext, probed?: { duration_s: number; frames?: number; width: number; height: number }): Finding[] {
  const out: Finding[] = [];
  const { record, plan } = ctx;
  if (record.status !== 'succeeded') out.push(finding('error', 'render-failed', `the render ${record.status}${record.error ? `: ${record.error}` : ''}`));
  const expected = plan.durationInFrames / plan.fps;
  if (probed) {
    if (Math.abs(probed.duration_s - expected) > Math.max(0.15, 2 / plan.fps)) {
      out.push(finding('warning', 'duration-mismatch', `the video lasts ${probed.duration_s.toFixed(2)} s but the plan ${expected.toFixed(2)} s`));
    }
    if (probed.width !== plan.width || probed.height !== plan.height) {
      out.push(finding('warning', 'size-mismatch', `the video is ${probed.width}×${probed.height}, the plan ${plan.width}×${plan.height}`));
    }
  }
  for (const w of plan.warnings) out.push(finding('info', 'plan-warning', w));
  const missing = (c: ResolvedComponent | null | undefined, where: string, frame: number) => {
    if (c?.missing) out.push(finding('warning', 'component-missing', `${where}: component ${c.id} could not be resolved, a stand-in was rendered`, locate(ctx, frame)));
  };
  for (const s of plan.segments) {
    missing(s.component, `${s.kind} ${s.id}`, s.from);
    missing(s.transition?.component, `transition into ${s.id}`, s.from);
    if (isClip(s)) {
      missing(s.caption, `caption of ${s.id}`, s.from);
      for (const o of s.overlays) missing(o.component, `overlay of ${s.id}`, s.from + o.from);
    }
  }
  return out;
}

// ── Durations ─────────────────────────────────────────────────────────────────

export function segmentDurations(ctx: Pick<CheckContext, 'plan' | 'spans'>): SegmentDuration[] {
  const fps = ctx.plan.fps;
  return ctx.spans.map(({ segment: s, from, to }) => {
    const d: SegmentDuration = {
      id: s.id,
      kind: s.kind,
      from,
      to,
      from_s: round(from / fps, 3),
      to_s: round(to / fps, 3),
      duration_s: round((to - from) / fps, 3),
      component: s.component.id,
    };
    if (isClip(s)) {
      d.scene = s.scene;
      d.speed = round(meanSpeed(s), 3);
    }
    return d;
  });
}

/** Video 1–2 min (look.md): info when a little outside, warning when far outside; scenes 4–25 s: info; < 2 s: warning. */
export function checkDurations(ctx: CheckContext, durations: SegmentDuration[]): Finding[] {
  const out: Finding[] = [];
  const r = ctx.rules;
  const total = ctx.plan.durationInFrames / ctx.plan.fps;
  const lo = r.video_min_s;
  const hi = r.video_max_s;
  if (total < lo || total > hi) {
    const far = total < lo * (1 - r.video_tolerance) || total > hi * (1 + r.video_tolerance);
    const side = total < lo ? `${fmtS(lo - total)} shorter than` : `${fmtS(total - hi)} longer than`;
    out.push(
      finding(
        far ? 'warning' : 'info',
        'video-length',
        `the video lasts ${fmtS(total)}: ${side} the ${lo}–${hi} s target of the reference look${far ? '' : ` (within the ${Math.round(r.video_tolerance * 100)} % tolerance)`}`,
      ),
    );
  }
  for (const d of durations) {
    if (d.kind !== 'clip') continue;
    const at = locate(ctx, d.from, { segment: d.id, scene: d.scene });
    if (d.duration_s < r.scene_too_short_s) {
      out.push(finding('warning', 'scene-too-short', `scene "${d.id}" is on screen ${fmtS(d.duration_s)}: too short to read its caption (< ${r.scene_too_short_s} s)`, at));
    } else if (d.duration_s < r.scene_min_s || d.duration_s > r.scene_max_s) {
      out.push(finding('info', 'scene-length', `scene "${d.id}" lasts ${fmtS(d.duration_s)} (reference look: ${r.scene_min_s}–${r.scene_max_s} s per scene)`, at));
    }
  }
  return out;
}

/** Scenes longer than `long_scene_s` played at about 1×: suggest a speed or a cut. */
export function checkLongScenes(ctx: CheckContext, durations: SegmentDuration[]): Finding[] {
  const out: Finding[] = [];
  const [a, b] = ctx.rules.normal_speed;
  for (const d of durations) {
    if (d.kind !== 'clip' || d.duration_s <= ctx.rules.long_scene_s) continue;
    const speed = d.speed ?? 1;
    if (speed < a || speed > b) continue;
    out.push(
      finding(
        'warning',
        'long-scene',
        `scene "${d.id}" lasts ${fmtS(d.duration_s)} at ${speed.toFixed(2)}×: longer than ${ctx.rules.long_scene_s} s at normal speed — speed it up (scene \`speed\`), trim idle time or split it`,
        locate(ctx, d.from, { segment: d.id, scene: d.scene }),
      ),
    );
  }
  return out;
}

// ── Captions ──────────────────────────────────────────────────────────────────

/** Faces of the plan's theme fonts: CSS family + weight → file (through plan.assets). */
export function planFontFiles(plan: EditPlan): Array<{ family: string; weight: number; style: 'normal' | 'italic'; file: string }> {
  const faces = plan.brand.tokens.font_faces ?? [];
  return faces.map((f) => ({ family: f.family, weight: f.weight, style: f.style, file: plan.assets[f.url] ?? f.url })).filter((f) => !f.file.startsWith('ds-asset:'));
}

interface CaptionFit {
  scale: number;
  truncated: boolean;
  width: number;
  lines: number;
}

/**
 * Where a clip's caption is drawn: the layout's caption rect — or, for a caption whose params say `position: over`
 * (studio/caption-overlay), the band box over the capture (kit `captionBandBox`, the box the component draws in).
 * `inset` = the horizontal padding of the text inside it. Undefined when there is no place.
 */
export function captionRegion(plan: Pick<EditPlan, 'width' | 'height' | 'unit'> & Partial<Pick<EditPlan, 'variant'>>, clip: ClipSegment): { rect: { x: number; y: number; w: number; h: number }; over: boolean; inset: number } | undefined {
  const params = clip.caption?.params ?? {};
  if (params.position === 'over') {
    const maxWidth = typeof params.max_width === 'number' ? params.max_width : 1400;
    const band = captionBandBox({ rects: { screen: clip.layout.capture }, area: clip.layout.caption, width: plan.width, height: plan.height, unit: plan.unit, position: 'over', maxWidth, variant: plan.variant });
    return { rect: band.box, over: band.over, inset: CAPTION_BAND_PAD_X * plan.unit };
  }
  const area = clip.layout.caption;
  return area ? { rect: area, over: false, inset: 6 * plan.unit } : undefined;
}

/** How a caption line fits the clip's caption area with the theme's caption style (kit fitText, real font widths). */
export function fitCaption(ctx: Pick<CheckContext, 'plan' | 'rules' | 'measure'>, clip: ClipSegment, text: string): CaptionFit | undefined {
  const region = captionRegion(ctx.plan, clip);
  const style = ctx.plan.brand.tokens.captions?.line;
  if (!region || !style) return undefined;
  const area = region.rect;
  const unit = ctx.plan.unit;
  const params = clip.caption?.params ?? {};
  const maxLinesParam = typeof params.max_lines === 'number' ? params.max_lines : 1;
  // Same rule as the caption components (kit captionMaxLines): ≥ 2 lines in vertical / square, ≥ 3 in a narrow column.
  const maxLines = region.over ? maxLinesParam : captionMaxLines(ctx.plan.variant, maxLinesParam, area.w / unit);
  const size = style.size * unit;
  const inset = region.inset;
  const r = fitText({
    text,
    width: area.w - 2 * inset,
    maxFontSize: size,
    minFontSize: size * ctx.rules.caption_floor_scale,
    maxLines,
    lineHeight: 1.18,
    fontFamily: style.font,
    fontWeight: style.weight,
    letterSpacing: style.letter_spacing,
    uppercase: style.uppercase,
    measure: ctx.measure,
  });
  return { scale: r.fontSize / size, truncated: r.truncated, width: r.width, lines: r.lines.length };
}

export function checkCaptions(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan, rules } = ctx;
  const fps = plan.fps;
  const edge = Math.round(0.15 * fps);
  const clips = plan.segments.filter(isClip);

  // 1. Cues of a clip belong to its scene; cues of a clip never overlap.
  for (const clip of clips) {
    const cues = [...clip.cues].sort((a, b) => a.from - b.from);
    for (const cue of cues) {
      if (cue.scene && cue.scene !== clip.scene) {
        out.push(finding('error', 'caption-scene-mismatch', `the caption "${cue.text}" of scene "${cue.scene}" is shown on scene "${clip.scene}"`, locate(ctx, clip.from + cue.from)));
      }
    }
    for (let i = 1; i < cues.length; i++) {
      if (cues[i - 1].to > cues[i].from) {
        out.push(
          finding(
            'error',
            'caption-overlap',
            `captions "${cues[i - 1].text}" and "${cues[i].text}" overlap for ${cues[i - 1].to - cues[i].from} frames in scene "${clip.scene}"`,
            locate(ctx, clip.from + cues[i].from),
          ),
        );
      }
    }
  }

  // 2. Video-level cues: within the segments of their scene (plus the transitions at their edges), never overlapping.
  const sceneFrames = (scene: string): Array<[number, number]> =>
    ctx.spans.filter((s) => isClip(s.segment) && s.segment.scene === scene).map((s) => [s.from, s.to] as [number, number]);
  const sorted = [...plan.captions].sort((a, b) => a.from - b.from);
  for (const cue of sorted) {
    const own = sceneFrames(cue.scene);
    if (own.length === 0) {
      out.push(finding('error', 'caption-scene-mismatch', `the caption "${cue.text}" belongs to scene "${cue.scene}", which is not in the video`, locate(ctx, cue.from)));
      continue;
    }
    let outside = 0;
    let firstOutside = -1;
    for (let f = cue.from; f < cue.to; f++) {
      const inside = own.some(([a, b]) => f >= a - edge && f < b + edge) || ctx.transitions.some((t) => f >= t.from && f < t.to);
      if (!inside) {
        outside++;
        if (firstOutside < 0) firstOutside = f;
      }
    }
    if (outside > 0) {
      const other = spanAt(ctx.spans, firstOutside);
      out.push(
        finding(
          'warning',
          'caption-scene-mismatch',
          `the caption of scene "${cue.scene}" ("${cue.text}") stays ${(outside / fps).toFixed(2)} s on ${other ? segmentLabel(other.segment) : 'another segment'}`,
          locate(ctx, firstOutside),
        ),
      );
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.to <= b.from) continue;
    // Cues of two clips joined by a crossfade overlap by the crossfade: the caption component fades them apart.
    const allowed = a.scene !== b.scene ? Math.max(0, ...ctx.transitions.filter((t) => t.from <= b.from + 1 && t.to >= b.from).map((t) => t.to - t.from)) : 0;
    if (a.to - b.from > allowed) {
      out.push(finding('error', 'caption-overlap', `captions "${a.text}" and "${b.text}" are both on screen for ${((a.to - b.from) / fps).toFixed(2)} s`, locate(ctx, b.from)));
    }
  }

  // 3. The captions of the capture (scene + step captions) are the ones shown.
  if (ctx.timeline && ctx.record.overrides?.captions !== false) {
    for (const clip of clips) {
      if (!clip.caption) continue;
      const scene = ctx.timeline.scenes.find((s) => s.id === clip.scene);
      const expected = new Set<string>();
      if (scene?.caption?.text) expected.add(scene.caption.text);
      for (const ev of ctx.timeline.events) if (ev.scene === clip.scene && ev.caption?.text) expected.add(ev.caption.text);
      if (scene?.caption?.text && clip.cues.length === 0) {
        out.push(finding('warning', 'caption-missing', `scene "${clip.scene}" has a caption ("${scene.caption.text}") but none is shown`, locate(ctx, clip.from)));
      }
      for (const cue of clip.cues) {
        if (expected.size > 0 && !expected.has(cue.text)) {
          out.push(finding('warning', 'caption-scene-mismatch', `the caption "${cue.text}" is not a caption of scene "${clip.scene}" in the capture`, locate(ctx, clip.from + cue.from)));
        }
      }
    }
  }

  // 4. Captions too long for their area (fitText with the theme caption style), and clear of the brand mark.
  const seen = new Set<string>();
  for (const clip of clips) {
    const region = captionRegion(plan, clip);
    if (!clip.caption || !region) continue;
    for (const cue of clip.cues) {
      const key = `${clip.id}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fit = fitCaption(ctx, clip, cue.text);
      if (!fit) continue;
      const at = locate(ctx, clip.from + Math.max(cue.from, 0));
      const pct = Math.round(fit.scale * 100);
      if (fit.truncated) {
        out.push(finding('error', 'caption-truncated', `the caption "${cue.text}" (${cue.text.length} characters) does not fit its area even at ${Math.round(rules.caption_floor_scale * 100)} % of the theme size: it is cut with "…"`, at));
      } else if (fit.scale < rules.caption_min_scale) {
        out.push(finding('warning', 'caption-too-long', `the caption "${cue.text}" (${cue.text.length} characters) shrinks to ${pct} % of the theme size to fit its area: shorten it`, at));
      } else if (fit.scale < 0.999) {
        out.push(finding('info', 'caption-shrunk', `the caption "${cue.text}" is drawn at ${pct} % of the theme size to fit its area`, at));
      }
      const mark = brandmarkRect(plan, clip.layout.brandmark, plan.brand.brandmark?.position);
      const area = region.rect;
      if (mark && clip.caption.params.position !== 'above' && !region.over) {
        const left = clip.caption.params.align === 'center' ? area.x + (area.w - fit.width) / 2 : area.x + region.inset;
        const right = left + fit.width;
        const vOverlap = mark.rect.y < area.y + area.h && mark.rect.y + mark.rect.h > area.y;
        const hOverlap = right > mark.rect.x && left < mark.rect.x + mark.rect.w;
        if (vOverlap && hOverlap) {
          out.push(finding('warning', 'caption-overlaps-brandmark', `the caption "${cue.text}" runs under the brand mark (${Math.round(right - mark.rect.x)} px)`, at));
        }
      }
    }
  }
  return out;
}

// ── Text slots ────────────────────────────────────────────────────────────────

function manifestOf(registry: ComponentRegistry | undefined, id: string): ComponentManifest | undefined {
  if (!registry) return undefined;
  try {
    return registry.get(id).manifest;
  } catch {
    return undefined;
  }
}

/** Text slots longer than their component's `max_chars` (cards, intro, outro, interstitials, overlays, caption cues). */
export function checkTextSlots(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const check = (c: ResolvedComponent, where: string, frame: number, values: Record<string, string | undefined>) => {
    const m = manifestOf(ctx.registry, c.id);
    if (!m) return;
    for (const [name, spec] of Object.entries(m.slots)) {
      if (spec.type !== 'text' && spec.type !== 'url') continue;
      const v = values[name];
      if (spec.required && (v === undefined || v.trim() === '') && c.kind !== 'caption') {
        out.push(finding('warning', 'text-slot-empty', `${where}: the required slot "${name}" of ${c.id} is empty`, locate(ctx, frame)));
      }
      if (v !== undefined && spec.max_chars !== undefined && [...v].length > spec.max_chars) {
        out.push(
          finding('warning', 'text-slot-overflow', `${where}: "${name}" is ${[...v].length} characters (${c.id} allows ${spec.max_chars}): "${v.length > 60 ? `${v.slice(0, 57)}…` : v}"`, locate(ctx, frame)),
        );
      }
    }
  };
  for (const s of ctx.plan.segments) {
    if (isClip(s)) {
      if (s.caption) {
        const seen = new Set<string>();
        for (const cue of s.cues) {
          const key = `${cue.kicker ?? ''}|${cue.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          check(s.caption, `caption of ${s.id}`, s.from + cue.from, { text: cue.text, kicker: cue.kicker });
        }
      }
      for (const o of s.overlays) check(o.component, `overlay of ${s.id}`, s.from + o.from, o.component.slots);
    } else {
      check(s.component, `${s.kind} ${s.id}`, s.from, s.component.slots);
    }
  }
  return out;
}

// ── Cursor at clicks ──────────────────────────────────────────────────────────

const inside = (p: { x: number; y: number }, v: { cx: number; cy: number; w: number; h: number }, margin: number) =>
  p.x >= v.cx - v.w / 2 + margin && p.x <= v.cx + v.w / 2 - margin && p.y >= v.cy - v.h / 2 + margin && p.y <= v.cy + v.h / 2 - margin;

export function checkCursor(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const W = plan.source.cssWidth;
  const H = plan.source.cssHeight;
  const ripple = Math.round(0.4 * plan.fps);
  for (const c of ctx.clicks) {
    const clip = plan.segments.find((s): s is ClipSegment => s.id === c.segment && isClip(s));
    if (!clip || !c.point) continue;
    const rel = c.frame - clip.from;
    const at = locate(ctx, c.frame, { scene: c.scene, step: c.step });
    const what = `the ${c.action} of step ${c.step_id ?? c.step} in "${c.scene}"`;
    if (c.point.x < 0 || c.point.y < 0 || c.point.x > W || c.point.y > H) {
      out.push(finding('error', 'cursor-offscreen', `${what} happens with the cursor off screen (${Math.round(c.point.x)}, ${Math.round(c.point.y)} in a ${W}×${H} capture)`, at));
      continue;
    }
    const ev = ctx.timeline?.events.find((e) => e.scene === c.scene && e.step === c.step && e.t_click !== undefined);
    if (ctx.timeline && ev?.t_click !== undefined) {
      const cur = cursorAt(ctx.timeline, ev.t_click);
      if (cur && !cur.visible) out.push(finding('warning', 'cursor-hidden', `${what} happens while the cursor is hidden`, at));
    }
    const reframed = plan.variant !== 'landscape' && !!clip.layout.crop && (clip.layout.crop.w < W - 0.5 || clip.layout.crop.h < H - 0.5);
    for (const f of [rel, Math.min(clip.durationInFrames - 1, rel + ripple)]) {
      const view = viewOf(plan, clip, f);
      const zoomed = view.w < W - 0.5 || view.h < H - 0.5;
      const viewName = reframed ? `${plan.variant} reframe` : `zoomed view (${(W / view.w).toFixed(2)}×)`;
      if (!inside(c.point, view, Math.min(view.w, view.h) * 0.01)) {
        out.push(
          finding(
            'error',
            'cursor-outside-view',
            `${what} is outside the ${zoomed ? viewName : 'visible area'}: cursor at (${Math.round(c.point.x)}, ${Math.round(c.point.y)}), view x ${Math.round(view.cx - view.w / 2)}–${Math.round(view.cx + view.w / 2)}, y ${Math.round(view.cy - view.h / 2)}–${Math.round(view.cy + view.h / 2)}${f === rel ? '' : ` ${(ripple / plan.fps).toFixed(1)} s after the click`}`,
            at,
          ),
        );
        break;
      }
      const bb = c.bbox ?? ev?.target?.bbox;
      if (bb && zoomed && f === rel) {
        // Only the part of the target inside the capture can be shown.
        const x0 = Math.max(0, bb.x);
        const y0 = Math.max(0, bb.y);
        const x1 = Math.min(W, bb.x + bb.w);
        const y1 = Math.min(H, bb.y + bb.h);
        const corners = [
          { x: x0, y: y0 },
          { x: x1, y: y1 },
        ];
        const fits = x1 - x0 <= view.w && y1 - y0 <= view.h;
        if (!corners.every((p) => inside(p, view, -0.5))) {
          if (reframed && fits) {
            out.push(finding('error', 'target-cut', `${what}: the ${plan.variant} reframe cuts its target (${c.target ?? ev?.target?.desc ?? 'element'})`, at));
          } else {
            out.push(finding('warning', 'target-outside-view', `${what}: its target (${c.target ?? ev?.target?.desc ?? 'element'}) is partly outside the ${viewName}`, at));
          }
        }
      }
    }
  }
  return out;
}

// ── Camera ────────────────────────────────────────────────────────────────────

const camAt = (plan: EditPlan, clip: ClipSegment, f: number): CameraFrame => clip.camera?.[Math.max(0, Math.min(clip.durationInFrames - 1, f))] ?? [1, plan.source.cssWidth / 2, plan.source.cssHeight / 2];

export function checkCamera(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan, rules } = ctx;
  const W = plan.source.cssWidth;
  const H = plan.source.cssHeight;
  const clips = plan.segments.filter(isClip);
  const zooms = new Map<string, { clip: ClipSegment; zoom: ClipSegment['zooms'][number] }>();
  for (const clip of clips) for (const z of clip.zooms) zooms.set(`${z.scene}|${z.step}`, { clip, zoom: z });
  const list = [...zooms.values()].sort((a, b) => a.clip.from + a.zoom.from - (b.clip.from + b.zoom.from));
  // Step hints count against the per-video budget; the theme's default zoom (style_bias balanced / motion) has its own
  // rule: at most one per scene, back to the full view before the scene ends (never across a cut or a join).
  const hinted = list.filter((z) => z.zoom.source !== 'theme');
  const themed = list.filter((z) => z.zoom.source === 'theme');
  if (themed.length > 0 && plan.brand.style_bias === 'real') {
    out.push(finding('warning', 'theme-zoom-real', `${themed.length} theme zoom(s) with style_bias "real": a real-style theme keeps a static camera`, locate(ctx, themed[0].clip.from + themed[0].zoom.from)));
  }
  const perScene = new Map<string, number>();
  for (const { clip, zoom } of themed) {
    perScene.set(zoom.scene, (perScene.get(zoom.scene) ?? 0) + 1);
    const at = locate(ctx, clip.from + zoom.from, { scene: zoom.scene, step: zoom.step });
    if (perScene.get(zoom.scene) === 2) out.push(finding('warning', 'theme-zoom-count', `more than one theme zoom in "${zoom.scene}": the theme default zoom is at most one per scene`, at));
    const end = clip.durationInFrames - clip.heldFrames;
    const last = camAt(plan, clip, end - 1);
    if (zoom.out_at + zoom.out_frames > end + 0.5 || last[0] > 1.001) {
      out.push(finding('warning', 'theme-zoom-cut', `the theme zoom of "${zoom.scene}" is still ${last[0].toFixed(2)}× when the scene ends: it must ease back out before the cut`, locate(ctx, clip.from + end - 1, { scene: zoom.scene })));
    }
  }
  if (hinted.length > rules.max_zooms) {
    const extra = hinted[rules.max_zooms];
    out.push(
      finding(
        'warning',
        'zoom-count',
        `${hinted.length} camera zooms (${hinted.map((z) => `${z.zoom.zoom}× at ${timecode((z.clip.from + z.zoom.from) / plan.fps)}`).join(', ')}): the reference look keeps the camera static with at most ${rules.max_zooms === 1 ? 'one very slow zoom' : `${rules.max_zooms} zooms`} per video`,
        locate(ctx, extra.clip.from + extra.zoom.from, { scene: extra.zoom.scene, step: extra.zoom.step }),
      ),
    );
  }
  for (const { clip, zoom } of list) {
    const at = locate(ctx, clip.from + zoom.from, { scene: zoom.scene, step: zoom.step });
    const inS = zoom.in_frames / plan.fps;
    if (inS < rules.slow_zoom_min_s || zoom.zoom > rules.slow_zoom_max) {
      out.push(
        finding('info', 'zoom-not-slow', `zoom ${zoom.zoom}× in ${inS.toFixed(1)} s (step ${zoom.step} of "${zoom.scene}"): the reference zoom is very slow (≈ 1.12× over ≈ 6 s, ≤ ${rules.slow_zoom_max}× over ≥ ${rules.slow_zoom_min_s} s)`, at),
      );
    }
    if (zoom.requested_zoom !== undefined) {
      out.push(finding('info', 'zoom-clamped', `zoom ${zoom.requested_zoom}× was limited to ${zoom.zoom}× by the theme's max_zoom`, at));
    }
  }
  // Same-page joins (no transition) must continue the camera; inside a clip the camera never jumps.
  for (let i = 0; i < plan.segments.length - 1; i++) {
    const a = plan.segments[i];
    const b = plan.segments[i + 1];
    if (!isClip(a) || !isClip(b) || b.transition) continue;
    const ca = camAt(plan, a, a.durationInFrames - 1 - a.heldFrames);
    const cb = camAt(plan, b, 0);
    if (Math.abs(ca[0] - cb[0]) > 0.01 || Math.abs(ca[1] - cb[1]) > 0.01 * W || Math.abs(ca[2] - cb[2]) > 0.01 * H) {
      out.push(
        finding('warning', 'zoom-reset', `the camera jumps at the same-page join "${a.scene}" → "${b.scene}" (${ca[0].toFixed(2)}× → ${cb[0].toFixed(2)}×): a zoom must continue across a join without a transition`, locate(ctx, b.from)),
      );
    }
  }
  // Reframed variants: the crop glides (no jump, no jolt) and the cursor never leaves it.
  for (const clip of clips) {
    const rf = clip.reframe;
    const crop = clip.layout.crop;
    if (plan.variant === 'landscape' || !rf || !crop) continue;
    const n = rf.length - clip.heldFrames;
    let jumped = false;
    for (let f = 1; f < n && !jumped; f++) {
      const step = Math.hypot(rf[f][0] - rf[f - 1][0], rf[f][1] - rf[f - 1][1]);
      const accel = f >= 2 ? Math.hypot(rf[f][0] - 2 * rf[f - 1][0] + rf[f - 2][0], rf[f][1] - 2 * rf[f - 1][1] + rf[f - 2][1]) : 0;
      if (step > rules.reframe_max_step * crop.w || accel > rules.reframe_max_accel * crop.w) {
        jumped = true;
        out.push(
          finding(
            'warning',
            'reframe-jump',
            `the ${plan.variant} reframe of "${clip.scene}" ${step > rules.reframe_max_step * crop.w ? `moves ${Math.round(step)} px in one frame` : `jolts (${accel.toFixed(1)} px/frame²)`} (crop ${Math.round(crop.w)} px wide)`,
            locate(ctx, clip.from + f),
          ),
        );
      }
    }
    if (!ctx.timeline) continue;
    for (let f = 0; f < n; f++) {
      const t = (clip.srcFrames[f] ?? 0) / plan.source.fps;
      const cur = cursorAt(ctx.timeline, t);
      if (!cur || !cur.visible) continue;
      const view = viewOf(plan, clip, f);
      if (!inside(cur, view, 0)) {
        out.push(finding('warning', 'cursor-outside-reframe', `the cursor (${Math.round(cur.x)}, ${Math.round(cur.y)}) leaves the ${plan.variant} reframe of "${clip.scene}"`, locate(ctx, clip.from + f)));
        break;
      }
    }
  }
  for (const clip of clips) {
    if (!clip.camera) continue;
    for (let f = 1; f < clip.camera.length - clip.heldFrames; f++) {
      const p = clip.camera[f - 1];
      const c = clip.camera[f];
      if (Math.abs(c[0] - p[0]) > 0.04 || Math.abs(c[1] - p[1]) > (0.03 * W) / c[0] || Math.abs(c[2] - p[2]) > (0.03 * H) / c[0]) {
        out.push(finding('warning', 'camera-jump', `the camera jumps between two frames in "${clip.scene}" (${p[0].toFixed(2)}× → ${c[0].toFixed(2)}×)`, locate(ctx, clip.from + f)));
        break;
      }
    }
  }
  return out;
}

// ── Transitions over clicks ──────────────────────────────────────────────────

export function checkTransitionsOnClicks(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const [before, after] = ctx.rules.click_window_s;
  const fps = ctx.plan.fps;
  for (const c of ctx.clicks) {
    const a = c.frame - Math.round(before * fps);
    const b = c.frame + Math.round(after * fps);
    const t = ctx.transitions.find((x) => x.from < b && x.to > a);
    if (!t) continue;
    out.push(
      finding(
        'warning',
        'transition-on-click',
        `the ${c.action} of step ${c.step_id ?? c.step} in "${c.scene}" at ${timecode(c.frame / fps)} is covered by the ${t.kind} ${t.before ?? ''}→${t.after ?? ''} (${timecode(t.from / fps)}–${timecode(t.to / fps)}): the click and its ripple must be fully visible`,
        locate(ctx, c.frame, { scene: c.scene, step: c.step }),
      ),
    );
  }
  return out;
}

// ── Tutorial overlays and story-card media (L2.10) ─────────────────────────────

/**
 * Tutorial overlays and data-driven cards:
 *  - `tutorial-skipped` (warning): an overlay the switches ask for could not be shown (a spotlight or a step badge
 *    without a recorded target box, a loupe without a field, a shortcut without its key) — the plan lists them;
 *  - `tutorial-target-cut` (warning): the target of a spotlight, a badge or a loupe lies outside the visible capture
 *    (zoom, reframe) while the overlay shows;
 *  - `media-missing` (warning): a card / overlay names data (a captured text, a frame, a CSV, an email…) that the plan
 *    could not resolve — the component shows a fallback.
 */
export function checkTutorial(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  for (const sk of plan.tutorial?.skipped ?? []) {
    out.push(finding('warning', 'tutorial-skipped', `${sk.scene} step ${sk.step}: no ${sk.feature} overlay — ${sk.reason}`, sk.frame !== undefined ? locate(ctx, sk.frame) : undefined));
  }
  for (const s of plan.segments) {
    if (!isClip(s)) continue;
    const cap = s.layout.capture;
    for (const o of s.overlays) {
      if (!o.tutorial || o.tutorial === 'shortcuts' || !o.anchor?.bbox) continue;
      // Sample the overlay at its start, middle and end (inside the clip) with its track box of that frame.
      const frames = [0, Math.floor(o.durationInFrames / 2), Math.max(0, o.durationInFrames - 1)];
      for (const k of frames) {
        const f = o.from + k;
        if (f >= s.durationInFrames) continue;
        const box = trackBoxAt(o, k, plan.fps) ?? o.anchor.bbox;
        const r = mapSourceRect(plan, s, f, box);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        if (cx < cap.x || cx > cap.x + cap.w || cy < cap.y || cy > cap.y + cap.h) {
          out.push(finding('warning', 'tutorial-target-cut', `${s.id} step ${o.step}: the ${o.tutorial} target is outside the visible capture (zoom or reframe)`, locate(ctx, s.from + f)));
          break;
        }
      }
    }
  }
  const media = (c: ResolvedComponent | null | undefined, where: string, frame: number) => {
    if (!c) return;
    const m = manifestOf(ctx.registry, c.id);
    if (!m) return;
    for (const [name, spec] of Object.entries(m.slots)) {
      if (!['email', 'document', 'notification', 'capture', 'frame', 'data'].includes(spec.type)) continue;
      const v = c.slots[name];
      if (v === undefined || v.trim() === '' || c.media?.[name]) continue;
      out.push(finding('warning', 'media-missing', `${where}: ${c.id} slot "${name}" (${spec.type} "${v}") could not be resolved — the component shows a fallback`, locate(ctx, frame)));
    }
  };
  for (const s of plan.segments) {
    media(s.component, `${s.kind} ${s.id}`, s.from);
    if (isClip(s)) for (const o of s.overlays) media(o.component, `overlay of ${s.id}`, s.from + o.from);
  }
  return out;
}
