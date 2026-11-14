/**
 * The pacing of a replay that checks rather than films (L7.12, moved from @retake/runner-web, which imports and
 * re-exports both unchanged): an inspection's replay and a recording's check replay. Pure data: the runner merges it
 * over the project's and the scenario's pacing, the engine writes it into a check replay's scenario.
 */
import type { Pacing } from './types.js';

/** `hold`, `wait`, a step's `hold:` and a scene's still last at most this long during an inspection's replay (s). */
export const INSPECT_PAUSE_CAP_S = 0.2;

/**
 * The replay's pacing: the cursor travels and hovers fast and types fast; navigation, popup and settle waits are the
 * project's (the page must reach the state the scenario describes).
 */
export const INSPECT_PACING: Partial<Pacing> = {
  scene_start_still: INSPECT_PAUSE_CAP_S,
  move_base_ms: 0,
  move_ms_per_px: 0.1,
  move_min_ms: 60,
  move_max_ms: 200,
  nudge_ms: 60,
  nudge_hover_ms: 30,
  hover_ms: 40,
  press_ms: 40,
  type_cps: 80,
  scroll_duration: 0.3,
  jitter: 0,
  page_switch_ms: 60,
  park_hold: INSPECT_PAUSE_CAP_S,
  park_scroll_hold: INSPECT_PAUSE_CAP_S,
};
