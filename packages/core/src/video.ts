import type { ProjectConfig, Scenario, TimelineVideo } from './types.js';

/**
 * The scenario's edit info as carried into timeline.json (`Timeline.video`), so the editor never re-reads the
 * scenario snapshot: title, intro, outro and music as written; the effective default frame (scenario `frame`, else
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
  return video;
}
