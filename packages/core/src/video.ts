import type { ProjectConfig, Scenario, TimelineVideo } from './types.js';

/**
 * The scenario's edit info as carried into timeline.json (`Timeline.video`), so the editor never re-reads the
 * scenario snapshot: title, intro, outro, music and tutorial switches as written; the effective default frame (scenario `frame`, else
 * the project `frame`, itself 'card' by default) and the template the run used (`template` when given, else the
 * scenario's, else the project's). Pure; values are copied.
 */
export function timelineVideo(scenario: Scenario, project: Pick<ProjectConfig, 'frame' | 'template'>, template?: string): TimelineVideo {
  const video: TimelineVideo = {};
  if (scenario.title) video.title = structuredClone(scenario.title);
  if (scenario.intro !== undefined) video.intro = structuredClone(scenario.intro);
  if (scenario.outro !== undefined) video.outro = structuredClone(scenario.outro);
  video.frame = scenario.frame ?? project.frame;
  video.template = template ?? scenario.template ?? project.template;
  if (scenario.music) video.music = structuredClone(scenario.music);
  if (scenario.tutorial !== undefined) video.tutorial = structuredClone(scenario.tutorial);
  if (scenario.target_length !== undefined) video.target_length = { ...scenario.target_length };
  return video;
}

/**
 * Reading pace of the text a card or an interstitial shows (R-FLD-03, L5.5): about 250 words a minute, plus 1.5 s for
 * its entry and exit animations.
 */
export const READING_PACE = Object.freeze({ words_per_minute: 250, extra_s: 1.5 });

/** Words of some texts (runs of letters or digits; a number with its separators is one word). */
export function wordCount(texts: Iterable<string | undefined | null>): number {
  let n = 0;
  for (const t of texts) if (typeof t === 'string') n += (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,:/-]*/gu) ?? []).length;
  return n;
}

/** Seconds a text of `words` words needs on screen (READING_PACE), 0 for none; rounded to 0.1 s. */
export function readingSeconds(words: number): number {
  if (words <= 0) return 0;
  return Math.round((words / READING_PACE.words_per_minute) * 60 * 10 + READING_PACE.extra_s * 10) / 10;
}
