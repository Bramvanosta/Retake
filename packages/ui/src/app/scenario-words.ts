/**
 * Words of the scenario screen (L4.2): a step's state in the source run, why it has no picture, durations — said in
 * words, never by colour alone.
 */
import type { StepBinding } from '@retake/engine';
import type { ScenarioBlocksView } from './data/ops.js';

/** The scenario screen's view (scenario_blocks). */
export type View = ScenarioBlocksView;

export function seconds(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export const MODE = (m: string) => (m === 'dry' ? 'rehearsal' : 'capture');

/**
 * A step as the screen numbers it: "step 3 of proposal" — 1-based like the rows and the inspector, never the run's
 * 0-based key (`proposal.2`); the same words as the engine's (scenario-view `stepRef`).
 */
export function stepWords(scene: string, index: number): string {
  return Number.isInteger(index) && index >= 0 ? `step ${index + 1} of ${scene}` : `scene ${scene}`;
}

/**
 * A run's error in the screen's words (review B M2): the runner leads it with "scene proposal, step 2 (click …)", its
 * 0-based index — said here "step 3 of proposal (click …)" like every step a person reads.
 */
export function runErrorWords(message: string): string {
  return message.replace(/^scene ([A-Za-z0-9][A-Za-z0-9_-]*), step (\d{1,4})\b/, (_m, scene: string, step: string) => stepWords(scene, Number(step)));
}

/** How a scene's pages are laid out in the video (review B M1): its frame, else the video's, else the render's choice. */
export function layoutWords(sceneFrame: string | undefined, videoFrame: string | undefined, pages: number): string {
  const frame = sceneFrame ?? videoFrame;
  const named = (f: string) => (f === 'pip' ? 'picture in picture (pip)' : f === 'split' ? 'side by side (split)' : `layout ${f}`);
  if (pages > 1) {
    if (frame === undefined) return `${pages} pages: chosen at render — side by side (split), or picture in picture (pip) for a phone and a desktop`;
    return `${pages} pages, ${named(frame)}${sceneFrame === undefined ? ' — the video’s frame' : ''}`;
  }
  return frame === undefined ? "the video's" : `frame ${frame}${sceneFrame === undefined ? ' (the video’s)' : ''}`;
}

/** A run's step key (`<scene>.<index>`) in the screen's words; the key itself when it is not one. */
export function keyWords(key: string): string {
  const m = /^(.+)\.(\d{1,4})$/.exec(key);
  return m ? stepWords(m[1], Number(m[2])) : key;
}

/** Why a step has no picture, in words. */
export function missingWords(b: Extract<StepBinding, { missing: string }>): string {
  switch (b.missing) {
    case 'not_reached':
      return b.why ? `Not reached: ${b.why}` : 'Not reached in this run';
    case 'changed':
      return 'Changed since this run';
    case 'new':
      return 'New since this run';
    case 'scene_changed':
      return 'Its scene changed since this run (page, address or persona)';
    case 'scene_skipped':
      return 'Its scene was skipped in this run';
    case 'scene_not_in_run':
      return 'Its scene is not in this run';
    case 'unreadable':
      return b.why ? `Cannot tell: ${b.why}` : "Cannot tell: this run's timeline cannot be read";
  }
}

/** A step outcome's tone (the kit's mark is chosen from it; the words always beside it). */
export type StatusTone = 'neutral' | 'danger' | 'warning' | 'info' | 'success';

export const STATUS_WORDS: Record<string, [string, StatusTone]> = {
  ok: ['done', 'success'],
  failed: ['failed in this run', 'danger'],
  skipped: ['skipped in this run', 'warning'],
  dry: ['not executed (irreversible)', 'warning'],
  unknown: ['outcome unknown', 'neutral'],
};

/** A run's status in the picker and the source line (an unknown status is `unknown`, never run.json's text). */
export const RUN_STATUS_WORDS: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'interrupted',
};

/** run.json's `partial` in the Studio's words: a stopped run says "stopped" (the engine's "cancelled", review B-L2 of L5.11a). */
export function partialWords(p: string): string {
  return p === 'cancelled' ? 'stopped' : p;
}

/** The words of a step's state in the source run, for its row and its accessible name. */
export function bindingWords(b: StepBinding | undefined, hasSource: boolean): string {
  if (!hasSource) return 'no run with pictures yet';
  if (!b) return 'not in this run';
  if ('missing' in b) return missingWords(b);
  const words = STATUS_WORDS[b.status]?.[0] ?? b.status;
  // L4.3: a step moved since the run keeps its picture, which shows it at its old place.
  return b.moved ? `${words} · moved since this run` : words;
}

/**
 * The take the timeline plans and Render edits, or undefined: the capture the engine names (`capture` — `latest` by
 * the one rule of the domain: the newest capture that succeeded, with its timeline and its film). The front end holds
 * no rule of its own, and looks through no list.
 */
export function timelineRun(v: Pick<View, 'capture'>): string | undefined {
  return v.capture?.id;
}

/** L5.10b: a step's verb on its frame (B32: "Hover", "Wait for", "Drop file"), from its category. */
export function verbWords(category: string): string {
  if (category === 'unknown') return 'Unknown';
  const w = category.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** L5.10b: a step's state in the source run as a mark (a shape beside its words: never colour alone). */
export function bindingMark(b: StepBinding | undefined, hasSource: boolean): 'ok' | 'fail' | 'warn' | 'idle' | 'waiting' {
  if (!hasSource || !b) return 'idle';
  if ('missing' in b) return b.missing === 'new' ? 'waiting' : b.missing === 'changed' || b.missing === 'scene_changed' ? 'warn' : 'idle';
  if (b.moved) return 'warn';
  return b.status === 'ok' ? 'ok' : b.status === 'failed' ? 'fail' : 'idle';
}
