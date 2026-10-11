/**
 * EditPlan — the contract between the edit planner (pure TS, `planEdit`), the Remotion
 * compositions (pure rendering of a plan) and the review package (output-time mapping, layout).
 *
 * All times are OUTPUT FRAMES unless the field name says seconds (`_s`) or source frames (`src`).
 * Layout rectangles are in output pixels.
 */
import type { FrameStyle, TransitionKind, Template } from '@demo-studio/core';
import type { CaptionCue, ComponentManifest, ThemeTokens } from '@demo-studio/components';

export type { CaptionCue };

export type PlanVariant = 'landscape' | 'vertical';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Brand values resolved for rendering (font/logo URLs are filled in by the renderer's asset server). */
export interface PlanBrand {
  /** Tokens handed to every component. */
  tokens: ThemeTokens;
  colors: Template['colors'];
  background: Template['background'];
  captions: Template['captions'];
  intro: Template['intro'];
  outro: Template['outro'];
  interstitial: Template['interstitial'];
  brandmark: NonNullable<Template['brandmark']>;
  frame: Template['frame'];
  style_bias: Template['style_bias'];
  /** CSS font-family names registered by the composition (e.g. "DS Display", "DS Body"). */
  fonts: {
    display: { family: string; url: string };
    body: Array<{ family: string; url: string; weight: number }>;
  };
  logo: { url: string };
  wordmark?: { url: string };
}

/** Geometry of the main layout (computed by the planner from the frame style + template). */
export interface PlanLayout {
  /** Where the capture pixels are drawn (inside the card / mockup screen). */
  capture: Rect;
  /** The card / device outline that contains the capture (equals capture for 'raw'). */
  card: Rect;
  /** Browser chrome bar above the capture (frame 'browser' only). */
  chrome?: Rect;
  /** Caption block area. */
  caption?: Rect;
  /** Corner radius of the card in output px. */
  radius: number;
  /** Brandmark position. */
  brandmark?: Rect;
}

/** A component resolved for one use in the plan (what the composition renders, what the UI can switch). */
export interface ResolvedComponent {
  id: string;
  version: string;
  kind: ComponentManifest['kind'];
  params: Record<string, unknown>;
  /** Slot values after defaults (theme / scenario) were applied. */
  slots: Record<string, string | undefined>;
  /** Where the choice came from (for the UI: "theme default" vs "scenario override"). */
  source: 'theme' | 'scenario' | 'override' | 'builtin-default';
}

/** Provenance of a span of output frames: which scenario step produced it (comments, timeline UI, review). */
export interface StepSpan {
  scene: string;
  step: number;
  step_id?: string;
  action: string;
  /** Output frames [from, to) relative to the segment. */
  from: number;
  to: number;
}

export interface OverlayUse {
  component: ResolvedComponent;
  /** Relative to the segment. */
  from: number;
  durationInFrames: number;
  /** Step that requested it. */
  scene: string;
  step: number;
}

export interface SegmentBase {
  /** Stable id: "intro", "outro", scene id, "interstitial-<n>". */
  id: string;
  /** First output frame. */
  from: number;
  /** Includes any overlap needed by the following transition. */
  durationInFrames: number;
  /** Opacity ramp at the start (frames). colour 'black' = fade from black. */
  fadeIn: { frames: number; color: 'none' | 'black' };
  /** Opacity ramp at the end (frames). colour 'black' = fade to black. */
  fadeOut: { frames: number; color: 'none' | 'black' };
  /** The transition that led into this segment (informational, for review). */
  transitionIn: TransitionKind | 'none';
  /** The component that renders this segment (layout component for clips). */
  component: ResolvedComponent;
}

export interface IntroSegment extends SegmentBase {
  kind: 'intro';
}

export interface OutroSegment extends SegmentBase {
  kind: 'outro';
}

/** Full-screen card: scenario `card:` entries and `interstitial:` entries. */
export interface CardSegment extends SegmentBase {
  kind: 'card' | 'interstitial';
  /** Interstitials are drawn over the dimmed last frame of the previous clip (source frame index), if any. */
  backdropSrcFrame?: number;
}

/** Camera value for one output frame: zoom and the source point (CSS px) at the centre of the view. */
export type CameraFrame = [zoom: number, cx: number, cy: number];

export interface ClipSegment extends SegmentBase {
  kind: 'clip';
  /** Scene id from the scenario/timeline. */
  scene: string;
  frame: FrameStyle;
  /**
   * Source frame index (into the CFR capture.mp4) for each output frame of this segment.
   * length === durationInFrames. Encodes speed ramps, idle trims and the held last frame of a crossfade.
   */
  srcFrames: number[];
  /** Per-output-frame camera, or null when the camera is static (zoom 1) for the whole segment. */
  camera: CameraFrame[] | null;
  /** URL shown by the browser-chrome frame, from relative frame `frame` onwards. */
  urls: Array<{ frame: number; url: string }>;
  /** Vertical variant only: per-output-frame crop centre in source CSS px (smoothed cursor/target track). */
  reframe?: Array<[cx: number, cy: number]>;
  /** Caption component used for this clip (cues are in plan.captions). */
  caption: ResolvedComponent | null;
  overlays: OverlayUse[];
  /** Which scenario steps produced which output frames. */
  steps: StepSpan[];
}

export type PlanSegment = IntroSegment | OutroSegment | CardSegment | ClipSegment;

/** Linear piece of the output→source time map (for review / key frames). */
export interface TimeMapEntry {
  /** Output frames [out_from, out_to). */
  out_from: number;
  out_to: number;
  /** Source seconds at out_from and out_to (linear in between). */
  src_from_s: number;
  src_to_s: number;
  scene: string;
}

export interface PlanMusic {
  url: string;
  /** Absolute path of the audio file. */
  file: string;
  /** Base volume 0..1. */
  volume: number;
  /** Multiplier applied while product footage is on screen (bed ducking), 0..1. */
  duck: number;
  fadeIn_s: number;
  fadeOut_s: number;
}

export interface EditPlan {
  version: 1;
  variant: PlanVariant;
  fps: number;
  width: number;
  height: number;
  /** Layout unit: output width / 1920 (landscape) or / 1080 (vertical). Multiply every design size by it. */
  unit: number;
  durationInFrames: number;
  frame: FrameStyle;
  brand: PlanBrand;
  layout: PlanLayout;
  source: {
    /** Filled at render time (asset server URL). */
    url: string;
    /** Absolute path of capture.mp4. */
    file: string;
    /** Video pixels. */
    width: number;
    height: number;
    /** CSS pixels (viewport) and device scale factor. */
    cssWidth: number;
    cssHeight: number;
    scale: number;
    fps: number;
    frames: number;
  };
  segments: PlanSegment[];
  captions: CaptionCue[];
  markers: Array<{ name: string; frame: number; scene: string }>;
  timemap: TimeMapEntry[];
  music?: PlanMusic;
  /** Planner decisions worth surfacing (trimmed idle gaps, clamped zooms…). */
  notes: string[];
  warnings: string[];
}

/** Overrides accepted by planEdit / render (MCP `render.overrides`). */
export interface EditOverrides {
  frame?: FrameStyle;
  variant?: PlanVariant;
  /** Output fps (default: capture fps). */
  fps?: number;
  /** Output size multiplier relative to 1920×1080 (default: capture scale). */
  scale?: number;
  intro?: boolean;
  outro?: boolean;
  captions?: boolean;
  /** Disable automatic idle trimming. */
  trim_idle?: boolean;
  /** Minimum idle gap (s) that gets trimmed (default 1.2). */
  idle_threshold?: number;
  /** Per-scene speed overrides. */
  speeds?: Record<string, number>;
  /** Transition between scenes. */
  transition?: TransitionKind;
  transition_duration?: number;
  /** Disable all camera moves. */
  camera?: boolean;
  /**
   * Component switches without touching the scenario: by kind ("intro", "layout", "caption"…) for the whole video,
   * or by segment id ("intro", "<scene id>", "interstitial-3") for one segment. Theme defaults apply otherwise.
   */
  components?: Record<string, import('@demo-studio/components').ComponentRef>;
  /** Use another theme (template) for this render. */
  theme?: string;
  music?: string | false;
}
