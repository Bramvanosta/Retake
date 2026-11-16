/**
 * The checks of a review that need no pixels (pure): durations, captions (scene mismatch, overlaps, too long for their
 * area, brand mark), text slots, cursor at clicks, long scenes at ~1×, camera zooms, transitions over clicks, and the
 * render itself (status, probe, missing components, plan warnings). The captions, camera, overlay and environment
 * checks live in ./checks-<topic>.ts and are re-exported here; pixel checks live in ./pixel-checks.ts.
 */
import type { TimelineLoadingUi } from '@retake/core/run';
import { BUTTON_LABEL_MIN, buttonColors } from '@retake/components/geometry';
import type { ResolvedComponent } from '@retake/editor/plan';
import type { CheckContext } from './checks-base.js';
import { finding, fmtS, locate, manifestOf, maskLocalUrls, outputFrameAtCapture } from './checks-base.js';
import type { Finding, SegmentDuration } from './types.js';
import { isClip, meanSpeed, round, timecode } from './spans.js';

export type { CheckContext } from './checks-base.js';
export { locate } from './checks-base.js';
export { captionRegion, checkCaptionContradictions, checkCaptions, fitCaption, planFontFiles } from './checks-captions.js';
export { checkCamera, checkCursor, checkZoomScroll } from './checks-camera.js';
export { COVER_SHARE, OVERLAY_CUT_SHARE, STALE_TARGET_S, checkOverlayCover, checkOverlaysKept, checkTutorial } from './checks-overlays.js';
export { checkEnvironment, environmentLine, reviewEnvironment } from './checks-environment.js';

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
  // A plan warning may name a local URL (a page without a display URL): a report never names a local host.
  for (const w of plan.warnings) out.push(finding('info', 'plan-warning', maskLocalUrls(w)));
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
        `the video lasts ${fmtS(total)}: ${side} the ${lo}–${hi} s target ${r.video_target === 'scenario' ? 'of the scenario (target_length)' : 'of the reference look'}${far ? '' : ` (within the ${Math.round(r.video_tolerance * 100)} % tolerance)`}`,
      ),
    );
  }
  for (const d of durations) {
    if (d.kind === 'card' || d.kind === 'interstitial') {
      // R-FLD-03: a card shorter than its text needs (the planner's reading time: 250 words a minute + 1.5 s).
      const seg = ctx.plan.segments.find((s) => s.id === d.id);
      const reading = seg && (seg.kind === 'card' || seg.kind === 'interstitial') ? seg.reading : undefined;
      const shown = seg ? seg.durationInFrames / ctx.plan.fps : d.duration_s;
      if (reading && shown + 0.05 < reading.seconds) {
        out.push(
          finding(
            'warning',
            'card-too-short',
            `${d.kind} "${d.id}" is on screen ${fmtS(shown)}: its ${reading.words} words need about ${fmtS(reading.seconds)} (250 words a minute + 1.5 s) — remove its \`duration\` (the default follows the text) or make it longer, or shorten the text`,
            locate(ctx, d.from, { segment: d.id }),
          ),
        );
      }
    }
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

/**
 * R-FLD-06: a card that shows a captured mail or document before the scene whose step captures it (a document card
 * before the mail that attaches it, before the action that downloads it): the viewer sees the result before its cause.
 * The card's place is the last clip before it; a project file (no capturing step) is not checked.
 */
export function checkArtefactOrder(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const tl = ctx.timeline;
  if (!tl?.artefacts?.length) return out;
  const sceneIndex = new Map(tl.scenes.map((s) => [s.id, s.index]));
  let lastClip: string | undefined;
  for (const seg of ctx.plan.segments) {
    if (isClip(seg)) {
      lastClip = seg.scene;
      continue;
    }
    if (seg.kind !== 'card') continue;
    for (const m of Object.values(seg.component.media ?? {})) {
      if (m.kind !== 'email' && m.kind !== 'document') continue;
      const art = tl.artefacts.find((a) => a.kind === m.kind && a.name === m.name);
      if (!art?.scene) continue;
      const at = sceneIndex.get(art.scene);
      const shownAfter = lastClip === undefined ? -1 : (sceneIndex.get(lastClip) ?? -1);
      if (at === undefined || shownAfter >= at) continue;
      const what = m.kind === 'email' ? 'mail' : 'document';
      out.push(
        finding(
          'warning',
          'artefact-before-step',
          `card "${seg.id}" shows the ${what} "${m.name}" before scene "${art.scene}"${art.step !== undefined ? ` (step ${art.scene}.${art.step})` : ''} captures it: the viewer sees it before the action that ${m.kind === 'email' ? 'sends' : 'produces'} it — move the card after that scene`,
          locate(ctx, seg.from, { segment: seg.id }),
        ),
      );
    }
  }
  return out;
}

// ── Text slots ────────────────────────────────────────────────────────────────

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
          finding(
            'warning',
            'text-slot-overflow',
            `${where}: "${name}" is ${[...v].length} characters (${c.id} allows ${spec.max_chars}): "${v.length > 60 ? `${v.slice(0, 57)}…` : v}"`,
            locate(ctx, frame),
          ),
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

// ── Button contrast ──────────────────────────────────────────────────────────

/**
 * Hotfix v0.2.5 (field point 22): the label of a filled button against the fill it is painted on — for a component with
 * a `button` slot (studio/card-cta), with the theme's button colours (kit `buttonColors`: the accent, the label chosen
 * against it). Below BUTTON_LABEL_MIN (4.5): a warning, once per component and theme.
 */
export function checkButtonContrast(ctx: CheckContext, colors: typeof buttonColors = buttonColors): Finding[] {
  const out: Finding[] = [];
  const tokens = ctx.plan.brand?.tokens;
  if (!tokens) return out;
  const seen = new Set<string>();
  const check = (c: ResolvedComponent, where: string, frame: number) => {
    if (seen.has(c.id) || !manifestOf(ctx.registry, c.id)?.slots.button) return;
    seen.add(c.id);
    const b = colors(tokens);
    if (b.ratio !== undefined && b.ratio < BUTTON_LABEL_MIN) {
      out.push(
        finding(
          'warning',
          'button-contrast',
          `${where}: the label of ${c.id}'s button (${b.label} on ${b.fill}) contrasts ${b.ratio.toFixed(1)}:1, under ${BUTTON_LABEL_MIN}:1 — change the theme's accent or its text / paper colours`,
          locate(ctx, frame),
        ),
      );
    }
  };
  for (const s of ctx.plan.segments) {
    if (isClip(s)) for (const o of s.overlays) check(o.component, `overlay of ${s.id}`, s.from + o.from);
    else check(s.component, `${s.kind} ${s.id}`, s.from);
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

/**
 * The take's slow transitions (R-FLD-23: run.json `perf.transitions`, a click whose result took over 0.8 s to
 * settle on screen), slowest first: `slow-transition` (info) at the click's output frame when the video shows it. The
 * product was slow there: the edit shortened what showed a wait (a skeleton, a spinner), prewarming the page
 * (`capture.prewarm`) helps a first visit.
 */
export function checkSlowTransitions(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const x of ctx.run?.perf?.transitions?.slow ?? []) {
    const click = ctx.clicks.find((c) => c.scene === x.scene && c.step === x.step);
    const frame = click?.frame ?? outputFrameAtCapture(ctx, x.t);
    out.push(
      finding(
        'info',
        'slow-transition',
        `${x.scene}.${x.step}: the screen settled ${fmtS(x.ms / 1000)} after the click${x.target ? ` on ${x.target}` : ''}${frame === undefined ? ' (not in the video)' : ''} — the product is slow there: ` +
          'the edit shortens what showed a wait (a skeleton, a spinner); `capture.prewarm: true` helps a first visit',
        frame !== undefined ? locate(ctx, frame) : undefined,
      ),
    );
  }
  return out;
}

// ── Client demo retro (hotfix v0.2.6) ─────────────────────────────────────────

/** A loading indicator shown at least this long is said. */
export const LOADING_FILMED_MIN_S = 0.3;

/**
 * `loading-filmed`: a skeleton, a shimmer, a spinner or an `aria-busy` region the take recorded in the filmed page
 * (`timeline.loading_ui`) that the video shows for LOADING_FILMED_MIN_S or more — beyond the empty screens the pixel
 * checks see. Page loads and a click's client-side route changes are held until ready (R-ISS-08, R-ISS-14): what still
 * shows is a loading state the take could not wait out — in the page, or a route still loading after its limit.
 */
export function checkLoadingFilmed(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  // The reader checks the lists every timeline has; this optional one is a list of spans here (a timeline edited by hand).
  const listed: unknown = ctx.timeline?.loading_ui;
  const spans = (Array.isArray(listed) ? listed : []).filter(
    (x): x is TimelineLoadingUi => typeof x === 'object' && x !== null && Number.isFinite((x as TimelineLoadingUi).t_start) && Number.isFinite((x as TimelineLoadingUi).t_end),
  );
  if (!spans.length) return out;
  const fps = ctx.plan.source.fps;
  for (const span of spans) {
    const a = span.t_start * fps;
    const b = span.t_end * fps;
    for (const s of ctx.plan.segments) {
      if (!isClip(s)) continue;
      let first: number | undefined;
      let shown = 0;
      s.srcFrames.forEach((src, f) => {
        if (src >= a && src < b) {
          shown++;
          first ??= f;
        }
      });
      const seconds = shown / ctx.plan.fps;
      if (first === undefined || seconds < LOADING_FILMED_MIN_S) continue;
      out.push(
        finding(
          'warning',
          'loading-filmed',
          `scene "${s.scene}" shows the page still loading for ${fmtS(seconds)} (${span.what}) — a loading state the take could not wait out (in the page, or a route still loading after 3 s): wait for its content (wait_for) or film it offscreen`,
          locate(ctx, s.from + first),
        ),
      );
    }
  }
  return out;
}
