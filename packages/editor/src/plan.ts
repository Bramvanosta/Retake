/**
 * `planEdit`: the edit of a capture as an EditPlan (docs/DESIGN-phase2.md §2.1, SPEC §9). PURE and deterministic:
 * no I/O, no clock, no randomness — the same input gives the same JSON.
 *
 * The plan is made in named steps (./planner/), each adding to what the ones before it decided, in this order: the
 * context (input checked, output format, edit info), the display addresses, the sources and assets, the slot media,
 * the component resolution, the tutorial switches, the entries in scenario order, the runs of contiguous clips and
 * their time maps, the cameras, the layouts, the step overlays, the segments, the transitions, the details of each
 * clip, the tap targets of transitions, the tutorial summary, the brand and the music. The order is part of the
 * output: notes, warnings and assets are listed in the order the steps add them.
 */
import type { EditPlan } from './plan-types.js';
import { planCameras } from './planner/cameras.js';
import { planClipDetails } from './planner/clip-details.js';
import { planComponents, planTutorialSetup } from './planner/components.js';
import { planEntries, planRuns } from './planner/entries.js';
import { planBrand, planTapTargets, planTutorialSummary } from './planner/finish.js';
import { openPlan } from './planner/format.js';
import type { PlanEditInput } from './planner/input.js';
import { planLayouts } from './planner/layouts.js';
import { planSlotMedia } from './planner/media.js';
import { planMusic } from './planner/music.js';
import { planStepOverlays } from './planner/overlays.js';
import type { PlanScope } from './planner/scope.js';
import { planSegments } from './planner/segments.js';
import { planAddresses, planSources } from './planner/sources.js';
import { planTransitions } from './planner/transitions.js';
import { secs } from './util.js';

export { PlanError } from './planner/input.js';
export type { PlanEditInput, PlanInputFile } from './planner/input.js';
export { ANCHOR_OVERLAY_WINDOW_S, CLEAR_LOOKAHEAD_S, CONTIGUOUS_GAP_S, DEFAULT_ZOOM, LOAD_START_SLACK_S, MUSIC_DEFAULTS, REFRAME_CLICK_WINDOW_S, SCREEN_POSITION_CHOICES } from './planner/rules.js';
export { defaultOverlayKeep, markDoneAt, overlayStartAt, reframeTargets } from './planner/targets.js';
export type { OverlayKeep } from './planner/targets.js';
export { musicFile, musicPlays, musicSpecOf } from './planner/music.js';

/** Plan the edit of a capture. Pure and deterministic. */
export function planEdit(input: PlanEditInput): EditPlan {
  // The scope every later step reads: context, addresses, sources, slot media, components, tutorial switches.
  const context = openPlan(input);
  const addresses = planAddresses(context);
  const sources = planSources(context);
  const media = planSlotMedia({ ...context, ...addresses, ...sources });
  const components = planComponents({ ...context, ...sources, ...media });
  const tutorials = planTutorialSetup({ ...context, ...components });
  const s: PlanScope = { ...context, ...addresses, ...sources, ...media, ...components, ...tutorials };
  const { warnings, notes, outFps, variant, width, height, unit, timeline, template, video, trackSources, mainSource, assets, displayTable, resolver } = s;

  // The edit in time: entries, runs, cameras, layouts, step overlays, segments placed with their transitions.
  const entries = planEntries(s);
  const { runs, runOf } = planRuns(s, entries);
  const camByRun = planCameras(s, runs, runOf);
  const layouts = planLayouts(s);
  const overlays = planStepOverlays(s, runOf);
  const drafts = planSegments(s, { entries, runOf, camByRun, layouts, overlays });
  const durationInFrames = planTransitions(s, drafts);

  // What each clip shows, then what the video as a whole adds.
  const { captions, markers, timemap } = planClipDetails(s, drafts, overlays);
  planTapTargets(s, drafts);
  const segments = drafts.map((d) => d.seg);
  const tutorialUsed = planTutorialSummary(s, segments);
  const totalSeconds = durationInFrames / outFps;
  notes.add(`${segments.length} segments, ${secs(totalSeconds)} at ${outFps} fps`);
  const brand = planBrand(s);
  const music = planMusic(s, segments, durationInFrames);

  const plan: EditPlan = {
    version: 1,
    variant,
    fps: outFps,
    width,
    height,
    unit,
    durationInFrames,
    frame: layouts.videoFrame,
    brand,
    layout: layouts.mainLayout,
    source: mainSource,
    ...(Object.keys(trackSources).length > 0 ? { tracks: trackSources } : {}),
    segments,
    captions,
    markers,
    timemap,
    assets,
    ...(displayTable.length > 0 ? { display: displayTable } : {}),
    meta: { run_id: timeline.run_id, project: timeline.project, scenario: timeline.scenario, theme: template.name },
    ...(video.target_length ? { target_length: { ...video.target_length } } : {}),
    notes: notes.items,
    warnings: warnings.items,
  };
  if (music) plan.music = music;
  if (tutorialUsed) plan.tutorial = s.tutorial;
  resolver.flush();
  plan.warnings = warnings.items;
  return plan;
}
