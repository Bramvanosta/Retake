/**
 * The scenario context's types (@retake/core/scenario): the scenario file and the loaded scenario.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { ValidationIssue } from '../issues.js';
import type { ClockSpec, WriteMockSpec } from './environment.js';
import type { HookStep, NamedHooks } from './hooks.js';
import type { FrameSpec, IntroSpec, MusicSpec, OutroSpec, SceneEntry, TargetLength, TutorialSwitch } from './language.js';
import type { ComponentId } from './model.js';
import type { CaptureSettings, Pacing, RunDefaults } from './project.js';

export interface Scenario {
  /** Format version (optional: a file without it is version 1). */
  version?: 1;
  /** Video name (usually equals the file name). */
  video: string;
  title?: { kicker?: string; text: string };
  /** `false` disables the intro card. */
  intro?: false | IntroSpec;
  /** `false` disables the outro card. */
  outro?: false | OutroSpec;
  /** Environment name (default project.default_env, else the first environment). */
  env?: string;
  /** Free variables usable as {{vars.x}} (and {{x}} when not shadowed). */
  vars?: Record<string, string>;
  setup?: HookStep[];
  teardown?: HookStep[];
  /**
   * Named hooks a `hook: <name>` step runs during the take: one hook entry or a list of them, run in order. A
   * name here wins over project.yaml's `hooks:`.
   */
  hooks?: NamedHooks;
  capture?: Partial<CaptureSettings>;
  /** Frame of every scene (default: the project frame). */
  frame?: FrameSpec;
  template?: string;
  pacing?: Partial<Pacing>;
  /** Step defaults: win over the project's. */
  defaults?: RunDefaults;
  music?: MusicSpec;
  /** Automatic tutorial overlays fed by the timeline (shortcuts, spotlight, numbered steps, loupe, progress bar). */
  tutorial?: TutorialSwitch;
  /** The length the video aims at: the review's length rule uses it instead of the reference 60–120 s. */
  target_length?: TargetLength;
  /**
   * The caption component of the whole video: a caption component id, between a render override and the theme's
   * caption (`overrides.components.caption` → `caption_component` → theme → built-in). An edit value.
   */
  caption_component?: ComponentId;
  /** The product's clock at capture time 0 (wins over the project's); `false` turns the project's clock off. */
  clock?: ClockSpec | false;
  /** Answers to writes stopped on read-only runs, tried before the environment's `read_only.mocks`. */
  mocks?: WriteMockSpec[];
  scenes: SceneEntry[];
}

export interface LoadedScenario {
  name: string;
  /** Absolute path of the YAML file. */
  file: string;
  text: string;
  /** sha256 (hex) of the file's bytes `text` was decoded from (core loadScenario: one read); absent for a scenario built in memory. */
  sha256?: string;
  scenario: Scenario;
  /** Non-blocking issues (warnings). */
  issues: ValidationIssue[];
}
