/** The tutorial's chapter progress bar, and the resolver a tutorial overlay use goes through. */
import type { Timeline } from '@retake/core/run';
import type { TutorialFeatureName, TutorialFeatureState } from '@retake/core/language';
import type { PlanProgress, PlanSegment, ResolvedComponent } from './plan-types.js';

/** Resolves a tutorial overlay use (the planner's ComponentResolver behind it). */
export type TutorialResolve = (feature: TutorialFeatureName, state: TutorialFeatureState, slots: Record<string, string>, where: string) => ResolvedComponent | null;

/**
 * The chapter progress bar (R-TUT-05): over every segment between the intro and the outro; chapters = each captured
 * scene and card (`scenes`; an interstitial belongs to the chapter before it), or each card and what follows it
 * (`cards`; what comes before the first card is a chapter too). Labels: the scene caption's kicker (else its text, else
 * the id), the card's kicker / title.
 */
export function planProgress(opts: { segments: readonly PlanSegment[]; timeline: Timeline; state: TutorialFeatureState; resolve: TutorialResolve }): PlanProgress | null {
  const segs = opts.segments.filter((s) => s.kind !== 'intro' && s.kind !== 'outro');
  if (segs.length === 0) return null;
  const outro = opts.segments.find((s) => s.kind === 'outro');
  const from = segs[0].from;
  const last = segs[segs.length - 1];
  const end = outro ? outro.from + (outro.transition?.kind === 'crossfade' ? outro.transition.frames : 0) : last.from + last.durationInFrames;
  const durationInFrames = Math.max(1, end - from);
  const mode = opts.state.mode === 'cards' ? 'cards' : 'scenes';
  const label = (s: (typeof segs)[number]): string | undefined => {
    const ts = opts.timeline.scenes.find((x) => x.id === s.id);
    if (s.kind === 'card') return s.component.slots.kicker ?? s.component.slots.title ?? ts?.card?.slots?.kicker ?? s.id;
    if (s.kind === 'clip') return ts?.caption?.kicker ?? ts?.caption?.text ?? s.id;
    return undefined;
  };
  const starts = segs.filter((s, i) => (mode === 'cards' ? i === 0 || s.kind === 'card' : s.kind === 'clip' || s.kind === 'card' || i === 0));
  const chapters = starts.map((s, i) => {
    const next = starts[i + 1];
    const a = Math.max(0, s.from - from);
    const b = next ? next.from - from : durationInFrames;
    const l = label(s);
    return { id: s.id, ...(l ? { label: l } : {}), from: a, to: Math.max(a + 1, b) };
  });
  const rc = opts.resolve('progress', opts.state, {}, 'the progress bar');
  if (!rc) return null;
  return { component: rc, from, durationInFrames, mode, chapters };
}
