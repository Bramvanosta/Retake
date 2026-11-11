/**
 * A step of `planEdit`: the transitions between segments and the timing they give the video — each segment's start,
 * the frames a crossfade or a fade through black overlaps or holds — and the video's length.
 */
import type { TimelineScene, TransitionKind } from '@retake/core';
import type { ClipSegment, PlanTransition } from '../plan-types.js';
import { transitionKindOf } from '../resolve.js';
import type { Candidate } from '../resolve.js';
import type { Draft, PlanScope } from './scope.js';

/** Places every draft (its `from`, transition and fades; a clip before a transition holds its last frame) and returns the video's length in frames. */
export function planTransitions(s: PlanScope, drafts: Draft[]): number {
  const { timeline, kindOverride, ov, resolver, themeAndBuiltin, t, warnings, notes, outFps } = s;
  const timelineSceneOf = (id: string): TimelineScene | undefined => timeline.scenes.find((x) => x.id === id);
  const transitionFor = (next: Draft): PlanTransition => {
    const chain: Candidate[] = [...kindOverride('transition')];
    if (ov.transition !== undefined) chain.push(resolver.transitionCandidate(ov.transition, 'override', 'overrides.transition'));
    const cardScene = next.seg.kind === 'card' ? timelineSceneOf(next.seg.id) : undefined;
    const sceneSpec = next.clip?.entry.scene.transition ?? cardScene?.card?.transition;
    if (sceneSpec) {
      const what = next.seg.kind === 'card' ? 'card' : 'scene';
      chain.push(resolver.sceneTransitionCandidate(sceneSpec, 'scenario', `the transition of ${what} "${next.seg.id}"`));
    }
    chain.push(...themeAndBuiltin('transition'));
    const rc = resolver.resolve('transition', chain, `transition into "${next.seg.id}"`);
    const kind: TransitionKind = rc?.missing ? requestedKind(chain) : transitionKindOf(rc);
    let seconds = t.transitions.duration;
    if (typeof rc?.params.duration === 'number') seconds = rc.params.duration;
    if (ov.transition_duration !== undefined) {
      if (ov.transition_duration >= 0 && ov.transition_duration <= 3) seconds = ov.transition_duration;
      else warnings.add(`overrides.transition_duration ${ov.transition_duration} ignored: use 0–3 s`);
    }
    return { kind, frames: kind === 'cut' ? 0 : Math.max(0, Math.round(seconds * outFps)), component: rc };
  };

  drafts.forEach((d, i) => {
    const prev = drafts[i - 1];
    if (!prev) {
      d.seg.from = 0;
      return;
    }
    const joined = d.clip?.entry.joined === true && prev.clip !== undefined && prev.clip.run === d.clip.run;
    if (joined) {
      d.seg.from = prev.seg.from + prev.seg.durationInFrames;
      return;
    }
    const tr = transitionFor(d);
    // Never let a transition eat more than half of either segment.
    const limit = Math.floor(Math.min(prev.content, d.content) / 2);
    if (tr.frames > limit) {
      notes.add(`transition into "${d.seg.id}" shortened to ${limit} frames (short segments)`);
      tr.frames = limit;
    }
    d.seg.transition = tr;
    d.seg.transitionIn = tr.kind;
    if (tr.kind === 'crossfade' && tr.frames > 0) {
      if (prev.clip) hold(prev, tr.frames);
      d.seg.fadeIn = { frames: tr.frames, color: 'none' };
      d.seg.from = prev.seg.from + prev.seg.durationInFrames - tr.frames;
    } else if (tr.kind === 'fade-black' && tr.frames > 0) {
      const out = Math.floor(tr.frames / 2);
      const inn = tr.frames - out;
      if (prev.clip) hold(prev, out);
      prev.seg.fadeOut = { frames: out, color: 'black' };
      d.seg.fadeIn = { frames: inn, color: 'black' };
      d.seg.from = prev.seg.from + prev.seg.durationInFrames;
    } else {
      d.seg.from = prev.seg.from + prev.seg.durationInFrames;
    }
  });
  // The last clip of the video holds nothing; recompute the end after the holds.
  return drafts.reduce((m, d) => Math.max(m, d.seg.from + d.seg.durationInFrames), 0);
}

/** A clip holds its last frame for `frames` more frames (its source frame, camera, reframe and panes'). */
function hold(d: Draft, frames: number): void {
  const seg = d.seg as ClipSegment;
  const last = seg.srcFrames[seg.srcFrames.length - 1];
  for (let k = 0; k < frames; k++) seg.srcFrames.push(last);
  if (d.clip) {
    const cam = d.clip.camera[d.clip.camera.length - 1];
    for (let k = 0; k < frames; k++) d.clip.camera.push(cam);
    if (d.clip.reframe) {
      const rf = d.clip.reframe[d.clip.reframe.length - 1];
      for (let k = 0; k < frames; k++) d.clip.reframe.push(rf);
    }
  }
  for (const p of seg.panes ?? []) {
    if (p.camera) {
      const c = p.camera[p.camera.length - 1];
      for (let k = 0; k < frames; k++) p.camera.push(c);
    }
    if (p.reframe) {
      const rf = p.reframe[p.reframe.length - 1];
      for (let k = 0; k < frames; k++) p.reframe.push(rf);
    }
  }
  seg.heldFrames += frames;
  seg.durationInFrames += frames;
}

/** The transition kind the chain asked for when no component resolved (the stand-in still needs a kind). */
function requestedKind(chain: readonly Candidate[]): TransitionKind {
  const first = chain.find((c) => c.ref !== null);
  if (!first) return 'cut';
  const ref = typeof first.ref === 'string' ? { id: first.ref, params: {} } : { id: first.ref!.id, params: first.ref!.params ?? {} };
  return transitionKindOf(ref);
}
