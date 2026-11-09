/**
 * The last steps of `planEdit`: the tap targets of transitions (L2.9), the chapter progress bar and the tutorial
 * summary, and the brand the compositions draw with.
 */
import { applyTutorial, tutorialOff } from '@retake/core';
import { ANCHOR_KEYS, evalAnchor, fontFileFace, paramEnums } from '@retake/components';
import type { AnchorSpec } from '@retake/components';
import type { EditPlan, PlanBrand, PlanLayout, PlanSegment, ResolvedComponent } from '../plan-types.js';
import { planProgress } from '../tutorial.js';
import { round, secs } from '../util.js';
import { ANCHOR_OVERLAY_WINDOW_S } from './rules.js';
import type { Draft, PlanScope } from './scope.js';

/** Tap targets of transitions (L2.9): the outgoing segment's (or its last overlay's) manifest anchor. */
export function planTapTargets(s: PlanScope, drafts: Draft[]): void {
  const { variant, resolver, design, unit, cssW, cssH, warnings, outFps } = s;
  const anchorKey = ANCHOR_KEYS[variant];
  const anchorOf = (rc: ResolvedComponent, where: string, layout?: PlanLayout): EditPlan['layout']['capture'] | undefined => {
    const m = resolver.manifest(rc);
    // A variant without its own anchor uses the landscape one (expressions over frame_w / frame_h follow the format).
    const spec = (m?.[anchorKey] ?? m?.anchor) as AnchorSpec | undefined;
    if (!m || !spec) return undefined;
    const c = layout?.capture;
    try {
      const r = evalAnchor(spec, rc.params, {
        enums: paramEnums(m.params),
        frame: { w: design.width, h: design.height },
        ...(c ? { screen: { x: c.x / unit, y: c.y / unit, w: c.w / unit, h: c.h / unit } } : {}),
        aspect: cssW / cssH,
      });
      return { x: round(r.x * unit, 2), y: round(r.y * unit, 2), w: round(r.w * unit, 2), h: round(r.h * unit, 2) };
    } catch (e) {
      warnings.add(`${where}: the ${anchorKey} of ${rc.id} cannot be evaluated: ${(e as Error).message}`);
      return undefined;
    }
  };
  drafts.forEach((d, i) => {
    const tr = d.seg.transition;
    const prev = drafts[i - 1];
    if (!tr?.component || !prev) return;
    let anchor: EditPlan['layout']['capture'] | undefined;
    if (prev.seg.kind === 'clip') {
      const end = prev.content;
      const showing = prev.seg.overlays.filter((o) => o.from + o.durationInFrames >= end - ANCHOR_OVERLAY_WINDOW_S * outFps && o.from < end);
      for (let k = showing.length - 1; k >= 0 && !anchor; k--) anchor = anchorOf(showing[k].component, `overlay of "${prev.seg.id}"`, prev.seg.layout);
    }
    anchor ??= anchorOf(prev.seg.component, `"${prev.seg.id}"`);
    if (anchor) tr.anchor = anchor;
  });
}

/** The chapter progress bar (a scenario-level switch) and what the tutorial overlays did; whether the plan has any. */
export function planTutorialSummary(s: PlanScope, segments: PlanSegment[]): boolean {
  const { video, ov, timeline, tutorialResolve, tutorial, notes, warnings, outFps } = s;
  const progressState = applyTutorial(applyTutorial(tutorialOff(), video.tutorial, 'scenario'), ov.tutorial === false ? false : ov.tutorial, 'scenario').progress;
  if (progressState.on) {
    const p = planProgress({ segments, timeline, state: progressState, resolve: tutorialResolve });
    if (p) {
      tutorial.progress = p;
      tutorial.uses.progress = 1;
      notes.add(`progress bar: ${p.chapters.length} chapters (${p.mode}) over ${secs(p.durationInFrames / outFps)}`);
    }
  }
  const tutorialUsed = Object.keys(tutorial.uses).length > 0 || tutorial.skipped.length > 0;
  if (tutorialUsed) {
    const parts = Object.entries(tutorial.uses).map(([k, v]) => `${k} ${v}`);
    if (parts.length) notes.add(`tutorial overlays: ${parts.join(', ')}`);
    for (const sk of tutorial.skipped) warnings.add(`scene "${sk.scene}" step ${sk.step}: no ${sk.feature} — ${sk.reason}`);
  }
  return tutorialUsed;
}

/** The theme as the compositions draw it: tokens, colours, fonts, logo and wordmark. */
export function planBrand(s: PlanScope): PlanBrand {
  const { tokens, t, displayUrl, bodyUrls, template, logoUrl, wordmarkUrl } = s;
  const brand: PlanBrand = {
    tokens,
    colors: structuredClone(t.colors),
    background: structuredClone(t.background),
    captions: structuredClone(t.captions),
    intro: structuredClone(t.intro),
    outro: structuredClone(t.outro),
    interstitial: structuredClone(t.interstitial),
    brandmark: structuredClone(t.brandmark ?? { position: 'bottom-right' }),
    frame: structuredClone(t.frame),
    style_bias: t.style_bias,
    fonts: {
      display: { family: tokens.fonts.display, url: displayUrl },
      body: bodyUrls.map((url, i) => ({ family: tokens.fonts.body, url, weight: fontFileFace(template.assets.body[i]).weight })),
    },
    logo: { url: logoUrl },
  };
  if (wordmarkUrl) brand.wordmark = { url: wordmarkUrl };
  return brand;
}
