/** The caption checks: cues against their scene, overlaps, the captions of the capture, fit in their area, the brand mark, and captions that deny the UI. */
import { isPlanAssetUrl } from '@retake/core/base';
import type { Timeline } from '@retake/core/run';
import { CAPTION_BAND_PAD_X, captionMaxLines, captionOverBand, fitText } from '@retake/components/geometry';
import { brandmarkRect } from '@retake/editor/plan';
import type { ClipSegment, EditPlan } from '@retake/editor/plan';
import type { CheckContext } from './checks-base.js';
import { finding, locate } from './checks-base.js';
import type { Finding } from './types.js';
import { isClip, segmentLabel, spanAt } from './spans.js';

/**
 * Faces of the plan's theme fonts: CSS family + weight → file, through plan.assets only — a face whose url is no asset
 * of the plan is not measured (a url is never taken for a path: a record's text could name any file, relative to any
 * folder).
 */
export function planFontFiles(plan: EditPlan): Array<{ family: string; weight: number | [number, number]; style: 'normal' | 'italic'; file: string }> {
  const faces = plan.brand.tokens.font_faces ?? [];
  return faces.flatMap((f) => {
    const file = isPlanAssetUrl(f.url) && Object.hasOwn(plan.assets, f.url) ? plan.assets[f.url] : undefined;
    return typeof file === 'string' && file !== '' && !isPlanAssetUrl(file) ? [{ family: f.family, weight: f.weight, style: f.style, file }] : [];
  });
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
export function captionRegion(
  plan: Pick<EditPlan, 'width' | 'height' | 'unit'> & Partial<Pick<EditPlan, 'variant'>>,
  clip: ClipSegment,
): { rect: { x: number; y: number; w: number; h: number }; over: boolean; inset: number } | undefined {
  const params = clip.caption?.params ?? {};
  if (params.position === 'over') {
    const band = captionOverBand({ params, capture: clip.layout.capture, area: clip.layout.caption, width: plan.width, height: plan.height, unit: plan.unit, variant: plan.variant });
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
  const clips = ctx.plan.segments.filter(isClip);
  return [...clipCueFindings(ctx, clips), ...videoCueFindings(ctx), ...captureCaptionFindings(ctx, clips), ...captionFitFindings(ctx, clips)];
}

/** Cues of a clip belong to its scene; cues of a clip never overlap. */
function clipCueFindings(ctx: CheckContext, clips: ClipSegment[]): Finding[] {
  const out: Finding[] = [];
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

  return out;
}

/** Video-level cues: within the segments of their scene (plus the transitions at their edges), never overlapping. */
function videoCueFindings(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const fps = plan.fps;
  const edge = Math.round(0.15 * fps);
  const sceneFrames = (scene: string): Array<[number, number]> => ctx.spans.filter((s) => isClip(s.segment) && s.segment.scene === scene).map((s) => [s.from, s.to] as [number, number]);
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

  return out;
}

/** The captions of the capture (scene + step captions) are the ones shown. */
function captureCaptionFindings(ctx: CheckContext, clips: ClipSegment[]): Finding[] {
  const out: Finding[] = [];
  if (ctx.timeline && ctx.record.overrides?.captions !== false) {
    for (const clip of clips) {
      if (!clip.caption) continue;
      const scene = ctx.timeline.scenes.find((s) => s.id === clip.scene);
      const expected = new Set<string>();
      // An edit re-planned from today's scenario shows the captions it planned, not the take's.
      const planned = ctx.record.edit?.from === 'scenario' ? ctx.record.edit.captions : undefined;
      if (planned) for (const t of planned[clip.scene] ?? []) expected.add(t);
      else {
        if (scene?.caption?.text) expected.add(scene.caption.text);
        for (const ev of ctx.timeline.events) if (ev.scene === clip.scene && ev.caption?.text) expected.add(ev.caption.text);
      }
      const sceneCaption = planned ? planned[clip.scene]?.[0] : scene?.caption?.text;
      if (sceneCaption && clip.cues.length === 0) {
        out.push(finding('warning', 'caption-missing', `scene "${clip.scene}" has a caption ("${sceneCaption}") but none is shown`, locate(ctx, clip.from)));
      }
      for (const cue of clip.cues) {
        if (expected.size > 0 && !expected.has(cue.text)) {
          out.push(finding('warning', 'caption-scene-mismatch', `the caption "${cue.text}" is not a caption of scene "${clip.scene}" in the capture`, locate(ctx, clip.from + cue.from)));
        }
      }
    }
  }

  return out;
}

/** Captions too long for their area (fitText with the theme caption style), and clear of the brand mark. */
function captionFitFindings(ctx: CheckContext, clips: ClipSegment[]): Finding[] {
  const out: Finding[] = [];
  const { plan, rules } = ctx;
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
        out.push(
          finding(
            'error',
            'caption-truncated',
            `the caption "${cue.text}" (${cue.text.length} characters) does not fit its area even at ${Math.round(rules.caption_floor_scale * 100)} % of the theme size: it is cut with "…"`,
            at,
          ),
        );
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

const NEGATION = /\b(?:not|no|never|without|isn['’]t|aren['’]t|don['’]t|doesn['’]t|won['’]t|can['’]t)\s+(?:(?:a|an|the|any|your|their|one)\s+)?([\p{L}][\p{L}'’-]{2,})/giu;

/** The texts a scene's steps found on the page: the quoted parts of their targets' descriptions, and asserted texts. */
function uiTexts(timeline: Timeline, scene: string): string[] {
  const out: string[] = [];
  for (const ev of timeline.events) {
    if (ev.scene !== scene) continue;
    const desc = (ev as { target?: { desc?: unknown } }).target?.desc;
    if (typeof desc === 'string') for (const m of desc.matchAll(/["“]([^"”]{2,120})["”]/g)) out.push(m[1]);
    const data = ev.data as { text?: unknown; option?: unknown } | undefined;
    for (const v of [data?.text, data?.option]) if (typeof v === 'string' && v.length <= 120) out.push(v);
  }
  return out;
}

/**
 * `caption-contradicts-ui` (info): a caption that denies a word the page shows in the same scene ("Not a quote" over a
 * "Request a quote" button). A caption never says what the screen does not: check the wording against the UI.
 */
export function checkCaptionContradictions(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const timeline = ctx.timeline;
  if (!timeline) return out;
  const seen = new Set<string>();
  for (const clip of ctx.plan.segments.filter(isClip)) {
    const texts = uiTexts(timeline, clip.scene);
    if (!texts.length) continue;
    for (const cue of clip.cues) {
      const text = `${cue.kicker ?? ''} ${cue.text}`;
      for (const m of text.matchAll(NEGATION)) {
        const word = m[1].toLowerCase();
        const shown = texts.find((t) => new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(t));
        const key = `${clip.scene}|${cue.text}|${word}`;
        if (!shown || seen.has(key)) continue;
        seen.add(key);
        out.push(
          finding(
            'info',
            'caption-contradicts-ui',
            `the caption "${cue.text}" says "${m[0].trim()}" while the page shows "${shown}" in scene "${clip.scene}": a caption never contradicts the UI`,
            locate(ctx, clip.from + cue.from, { scene: clip.scene }),
          ),
        );
      }
    }
  }
  return out;
}
