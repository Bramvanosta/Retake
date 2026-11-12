/** The first steps of `planEdit`: the input checked, the output format, the edit info — the plan's context. */
import { hasTokens } from '@retake/core/base';
import { timelineVideo } from '@retake/core/language';
import type { Timeline, TimelineVideo } from '@retake/core/model';
import { DESIGN_SPACES } from '../layout.js';
import type { EditOverrides, PlanVariant } from '../plan-types.js';
import { MessageList, round } from '../util.js';
import { PlanError } from './input.js';
import type { PlanEditInput } from './input.js';
import type { PlanContext } from './scope.js';

/** The plan's context: `checkCapture`, `planFormat` and `planEditInfo`, in that order. */
export function openPlan(input: PlanEditInput): PlanContext {
  const { timeline, template, project, registry } = input;
  const ov: EditOverrides = input.overrides ?? {};
  const warnings = new MessageList();
  const notes = new MessageList();
  checkCapture(timeline, warnings);
  const format = planFormat(timeline, ov, warnings);
  const base = { input, timeline, template, t: template.template, project, registry, ov, warnings, notes, cap: timeline.capture, ...format };
  return { ...base, video: planEditInfo(base) };
}

/** A dry run or a run without a usable capture cannot be planned; a capture without its cursor is a warning. */
export function checkCapture(timeline: Timeline, warnings: MessageList): void {
  if (timeline.mode === 'dry') throw new PlanError(`run ${timeline.run_id} is a dry run: it has no capture to edit`);
  const cap = timeline.capture;
  if (!(cap.fps > 0) || !(cap.duration > 0)) throw new PlanError(`run ${timeline.run_id} has no usable capture (fps ${cap.fps}, ${cap.duration} s)`);
  if (cap.cursor === 'hidden') {
    warnings.add(`run ${timeline.run_id} was captured without its in-page cursor (raw export for editors, run --raw --cursor none|layer): the video shows no cursor — capture without --raw for an edited video`);
  }
}

type PlanFormat = Pick<PlanContext, 'srcFps' | 'variant' | 'outFps' | 'scale' | 'design' | 'width' | 'height' | 'unit' | 'cssW' | 'cssH' | 'srcFrameCount' | 'fr'>;

/** The output format: variant, fps, size and scale (overrides checked), the capture's size and frame count. */
export function planFormat(timeline: Timeline, ov: EditOverrides, warnings: MessageList): PlanFormat {
  const cap = timeline.capture;
  const srcFps = cap.fps;
  let variant: PlanVariant = ov.variant ?? 'landscape';
  if (!(variant in DESIGN_SPACES)) {
    warnings.add(`overrides.variant "${String(variant)}" ignored: use landscape, vertical or square`);
    variant = 'landscape';
  }
  let outFps = srcFps;
  if (ov.fps !== undefined) {
    if (ov.fps > 0 && ov.fps <= 120) outFps = ov.fps;
    else warnings.add(`overrides.fps ${ov.fps} ignored: use 1–120 (keeping the capture's ${srcFps} fps)`);
  }
  let scale = cap.scale > 0 ? cap.scale : 1;
  if (ov.scale !== undefined) {
    if (ov.scale > 0 && ov.scale <= 4) scale = ov.scale;
    else warnings.add(`overrides.scale ${ov.scale} ignored: use a factor in (0, 4]`);
  }
  const design = DESIGN_SPACES[variant];
  const width = Math.round(design.width * scale);
  const height = Math.round(design.height * scale);
  const unit = width / design.width;
  const cssW = cap.width;
  const cssH = cap.height;
  const srcFrameCount = Math.max(1, Math.round(cap.duration * srcFps));
  const capScale = cap.scale > 0 ? cap.scale : 1;
  if (scale > capScale + 1e-6) {
    warnings.add(
      `the capture is ${Math.round(cssW * capScale)}×${Math.round(cssH * capScale)} px (scale ${capScale}): it is upscaled in this ${width}×${height} output ` +
        `(×${round(scale / capScale, 2)}; everything else is drawn at full resolution) — capture at scale ${round(scale, 2)} for a crisp result`,
    );
  }
  const fr = (s: number) => Math.max(1, Math.round(s * outFps));
  return { srcFps, variant, outFps, scale, design, width, height, unit, cssW, cssH, srcFrameCount, fr };
}

/** The edit info (the timeline's `video` block; older runs: the scenario's or the project's), theme and token notes. */
export function planEditInfo(c: Omit<PlanContext, 'video'>): TimelineVideo {
  const { timeline, template, project, ov, warnings, notes, t, input } = c;
  let video: TimelineVideo;
  if (timeline.video) video = timeline.video;
  else {
    video = input.scenario ? timelineVideo(input.scenario, project.config) : { frame: project.config.frame };
    notes.add(`timeline.json has no "video" block (run made before L2.1): edit info taken from ${input.scenario ? 'the scenario' : 'the project'}`);
  }
  if (ov.theme !== undefined && ov.theme !== template.name && ov.theme !== t.name) {
    warnings.add(`overrides.theme is "${ov.theme}" but the theme passed to the planner is "${template.name}": the caller loads the override theme`);
  }
  if (video.template && video.template !== template.name && video.template !== t.name) {
    notes.add(`theme "${template.name}" (the run was captured with "${video.template}"): the scenario is unchanged`);
  }
  const literal = literalTokens(timeline, video);
  if (literal.length) {
    warnings.add(`${literal.join(', ')} still ${literal.length > 1 ? 'show' : 'shows'} {{…}} tokens as written: a run captured before scenario templating (L1.2), or a token inside a \`vars\` value (inserted as written) — fix it and capture again`);
  }
  return video;
}

/**
 * Where the text the video shows still holds {{tokens}}: runs captured before scenario templating (L1.2) recorded
 * captions, cards, labels and the title as written; a token inside a `vars` value is inserted as written (validation
 * flags it since; BL-56). An unresolved token fails a new run.
 */
function literalTokens(timeline: Timeline, video: TimelineVideo): string[] {
  const has = (v: unknown) => v !== undefined && hasTokens(JSON.stringify(v));
  const out: string[] = [];
  if (has([video.title, video.intro, video.outro, video.tutorial])) out.push('the title, intro or outro');
  for (const s of timeline.scenes) {
    if (has([s.caption, s.card, s.interstitial, s.tutorial, s.pages?.map((p) => p.label)])) out.push(`scene ${s.id}`);
  }
  for (const e of timeline.events) {
    if (has([e.caption, e.overlay?.slots, e.overlay?.params, e.tutorial])) out.push(`step ${e.scene}.${e.step}`);
  }
  return out.length > 4 ? [...out.slice(0, 4), '…'] : out;
}
