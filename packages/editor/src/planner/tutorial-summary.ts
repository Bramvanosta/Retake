/** A step of `planEdit`: the chapter progress bar and the summary of what the tutorial overlays did. */
import { applyTutorial, tutorialOff } from '@retake/core/language';
import type { PlanSegment } from '../plan-types.js';
import { planProgress } from '../tutorial.js';
import { secs } from '../util.js';
import type { PlanScope } from './scope.js';

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
