/**
 * EditPlan — the contract between the edit planner (pure TS, `planEdit`), the Remotion
 * compositions (pure rendering of a plan) and the review package (output-time mapping, layout).
 *
 * All times are OUTPUT FRAMES unless the field name says seconds (`_s`) or source frames (`src`).
 * Layout rectangles are in output pixels.
 */
import type { BBox, FrameSpec, OverlayAnchor, PointSpec, TransitionKind, Template, TutorialFeatureName, TutorialSwitch } from '@demo-studio/core';
import type { CaptionCue, ComponentManifest, MediaValue, ProgressChapter, ThemeTokens } from '@demo-studio/components';

export type { CaptionCue };

/** Output orientation: landscape 16:9 (1920×1080 × scale), vertical 9:16 (1080×1920), square 1:1 (1080×1080). */
export type PlanVariant = 'landscape' | 'vertical' | 'square';

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

/**
 * URL scheme of the assets a plan refers to (capture, logo, wordmark, fonts, music): `ds-asset:<name>`. The planner
 * is pure and does not know where the renderer serves files, so every URL in a plan uses this scheme and
 * `EditPlan.assets` maps each such URL to its absolute file; the renderer serves the files and swaps the URLs
 * (`resolvePlanAssets`).
 */
export const PLAN_ASSET_SCHEME = 'ds-asset:';

/** Geometry of the main layout (computed by the planner from the frame style + template). */
export interface PlanLayout {
  /** Where the capture pixels are drawn (inside the card / mockup screen). */
  capture: Rect;
  /** The card / device outline that contains the capture (equals capture for 'raw'). */
  card: Rect;
  /**
   * The layout's declared screen rect (a device display, a browser page area) when the capture, fitted to its own
   * aspect ratio, does not fill it (`capture` is then letterboxed / pillarboxed inside it): the layout paints the
   * difference with the theme background. Absent when the capture fills the screen rect.
   */
  display?: Rect;
  /** Browser chrome bar above the capture (frame 'browser' only). */
  chrome?: Rect;
  /** Caption block area. */
  caption?: Rect;
  /** Corner radius of the card in output px. */
  radius: number;
  /** Brandmark position. */
  brandmark?: Rect;
  /**
   * Vertical and square variants: size (source CSS px) of the capture region shown in `capture` — the region of the
   * capture with the aspect ratio of the screen rect (the whole capture when the aspects match); its centre follows
   * `ClipSegment.reframe`.
   */
  crop?: { w: number; h: number };
  /** The layout component's manifest had no geometry for this variant: a default geometry was used. */
  fallback?: boolean;
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
  /**
   * The run artefacts its `email` / `document` / `notification` slots name (key = slot name), with `ds-asset:` image
   * URLs (L2.9). Handed to the component as `props.media`.
   */
  media?: Record<string, MediaValue>;
  /**
   * Set when no registered component could be resolved for this use (not found, wrong kind or invalid params): the
   * renderer draws a stand-in of the kind; the plan warnings say why.
   */
  missing?: boolean;
}

/** The transition that leads into a segment (absent: the first segment, or a contiguous same-page join). */
export interface PlanTransition {
  kind: TransitionKind;
  /** crossfade: overlap with the previous segment; fade-black: fade-out frames + fade-in frames; cut: 0. */
  frames: number;
  /** The transition component (null for a cut). */
  component: ResolvedComponent | null;
  /**
   * Output px box the transition opens from: the tap target the outgoing segment's component declares (manifest
   * `anchor`, evaluated with its params) — a lock-screen notification, an app icon, a notification overlay still
   * showing at the end of the outgoing clip. Absent when the outgoing segment declares none.
   */
  anchor?: Rect;
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
  /** Frames on screen (cut by the clip's end). */
  durationInFrames: number;
  /**
   * The component's own length when the clip's end cut the overlay short: the component is rendered with this
   * `durationInFrames`, so its exit animation (after the cut) is never seen — it stays on screen to the clip's last
   * frame (and through a tap-open transition from it).
   */
  componentFrames?: number;
  /** Step that requested it. */
  scene: string;
  step: number;
  /**
   * What the overlay points at, in SOURCE CSS px (the target box measured at the end of the step, else the cursor
   * point). The composition maps it through the layout and the camera of each frame (`mapSourceRect`); absent when
   * the runner recorded no anchor.
   */
  anchor?: { bbox?: BBox; point?: PointSpec };
  /** L2.10: the tutorial overlay this use is (absent: a step `overlay`). */
  tutorial?: Exclude<TutorialFeatureName, 'progress'>;
  /** `screen`: drawn right over the capture, under the caption, the brand mark and the other overlays (a spotlight's dim). */
  layer?: 'screen';
  /**
   * The anchor along the overlay, in SOURCE CSS px, from frame `at` (relative to the overlay) on: the composition glides
   * from one box to the next over `TRACK_GLIDE_S` (a spotlight following the steps).
   */
  track?: Array<{ at: number; bbox: BBox }>;
  /** The frame (relative to the overlay) of the moment it shows: the key press, the click (`ComponentProps.moment`). */
  moment?: number;
  /** A capture region (source CSS px) the composition renders as the component's `screen` (the typing loupe). */
  region?: BBox;
  /**
   * Multi-page clips (L2.11): the pane of the page the step acted on — anchor, track, region and `rects.screen` are that
   * page's (source CSS px of its track; the spotlight dims only that page).
   */
  pane?: number;
  /**
   * What the overlay must not cover while it shows (L2.11 polish): the targets of the step it belongs to and of the next
   * click step(s), in SOURCE CSS px of its page, over frames [from, to) relative to the overlay. The composition maps
   * them per frame and adds them to `avoid` (kind `target`): key caps take another slot, a lens or a badge another side.
   * `pane`: a box of another page than the overlay's (an inset page's key caps or lens are drawn over the main page,
   * whose targets they keep clear of too), mapped through that pane.
   */
  clear?: Array<{ from: number; to: number; bbox: BBox; pane?: number }>;
  /**
   * A box-filling overlay (L2.12: a user video, image or Lottie file — or any overlay given `anchor` / `rect` / `scale`):
   * the box the component fills (`ComponentProps.anchor`), evaluated per frame by the composition (`overlayBoxAt`).
   * `rect` (target, cursor, rect anchors): a box of its page in SOURCE CSS px, mapped through the layout, the camera and
   * the reframe like any anchor; a position of the screen (`center`, `top-right`…): `size` (source CSS px, scaled like
   * the page) at that point of the visible capture; `screen`: the whole visible capture.
   */
  box?: { anchor: OverlayAnchor | 'rect'; rect?: BBox; size?: { w: number; h: number } };
}

/** The video-wide chapter progress bar (L2.10): drawn over every segment between the intro and the outro. */
export interface PlanProgress {
  component: ResolvedComponent;
  /** Output frames [from, from + durationInFrames). */
  from: number;
  durationInFrames: number;
  /** What a chapter is: every scene and card, or each card and what follows it. */
  mode: 'scenes' | 'cards';
  /** Frames relative to `from`. */
  chapters: ProgressChapter[];
}

/** Tutorial overlays of a plan (L2.10). */
export interface PlanTutorial {
  /** Uses per overlay (shortcuts, spotlight, steps, loupe; progress = 1 when the bar is shown). */
  uses: Partial<Record<TutorialFeatureName, number>>;
  /**
   * Steps an overlay was asked for but could not be shown (a spotlight or a badge without a target box, a loupe without
   * a field…): the review reports them. `frame` = the step's output frame in the video, when it is on screen.
   */
  skipped: Array<{ feature: TutorialFeatureName; scene: string; step: number; frame?: number; reason: string }>;
  progress?: PlanProgress;
}

/** Playback speed over output frames [from, to) of a clip (relative to the segment). */
export interface SpeedSpan {
  from: number;
  to: number;
  /** Speed (×) at `from`; equals `to_speed` except on a ramp. */
  speed: number;
  /** Speed (×) at `to` (ramps). */
  to_speed: number;
  /** 1× span kept by rule (opening still, hold, marked step window). */
  protected?: boolean;
}

/** An idle gap shortened by the planner: at output frame `at` (relative), capture time jumps over [src_from_s, src_to_s). */
export interface TrimSpan {
  at: number;
  src_from_s: number;
  src_to_s: number;
}

/** A camera zoom of a clip, from a step `camera` hint (frames relative to the clip whose step asked for it). */
export interface ZoomSpan {
  scene: string;
  step: number;
  /** Zoom-in starts (the step's output start). */
  from: number;
  /** Ease-in length (frames). */
  in_frames: number;
  /** Ease-out starts (may lie beyond the clip: the zoom then continues into the next same-page clip or ends with the clip). */
  out_at: number;
  out_frames: number;
  zoom: number;
  /** The hint's zoom when it was clamped to the theme max_zoom. */
  requested_zoom?: number;
  /** Focus point in source CSS px (bbox centre, else point, else cursor) and the view centre after clamping. */
  focus: PointSpec;
  view: PointSpec;
  /**
   * `hint` (default): a step `camera` hint. `theme`: the theme's `motion.default_zoom` (style_bias balanced / motion) —
   * at most one per scene, on a marked step's target, eased slowly in and back out before the scene ends (never across
   * a cut or a same-page join).
   */
  source?: 'hint' | 'theme';
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
  /** The transition into this segment, with its component (absent for the first segment and same-page joins). */
  transition?: PlanTransition;
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
  /** Frame as resolved for this scene (scene → scenario → project); the layout component is `component`. */
  frame: FrameSpec;
  /**
   * Source frame index (into the CFR capture.mp4) for each output frame of this segment.
   * length === durationInFrames. Encodes speed ramps, idle trims and the held last frame of a crossfade.
   */
  srcFrames: number[];
  /** Per-output-frame camera, or null when the camera is static (zoom 1) for the whole segment. */
  camera: CameraFrame[] | null;
  /** URL shown by the browser-chrome frame, from relative frame `frame` onwards. */
  urls: Array<{ frame: number; url: string }>;
  /**
   * Vertical and square variants: per-output-frame crop centre in source CSS px (the reframe track: cursor, step
   * targets and overlay anchors kept in view, dead zone, critically damped smoothing; see camera.ts `reframeTrack`).
   */
  reframe?: Array<[cx: number, cy: number]>;
  /** Caption component used for this clip (cues are in plan.captions). */
  caption: ResolvedComponent | null;
  overlays: OverlayUse[];
  /** Which scenario steps produced which output frames. */
  steps: StepSpan[];
  /** The caption cues of this clip relative to the segment (the last one runs to the segment's end, overlap included). */
  cues: CaptionCue[];
  /** Geometry of this clip's layout component (equals plan.layout unless the scene has its own frame). */
  layout: PlanLayout;
  /** Source range shown, capture seconds [from, to) (page loads excluded). */
  src: { from_s: number; to_s: number };
  /** Playback speeds over the clip (output frames, relative). */
  speeds: SpeedSpan[];
  /** Idle gaps shortened in this clip. */
  trims: TrimSpan[];
  /** Camera zooms asked by this clip's steps. */
  zooms: ZoomSpan[];
  /** Number of trailing frames that repeat the last source frame (outgoing side of a crossfade / fade). */
  heldFrames: number;
  /**
   * Multi-page scene (L2.11): its pages in the layout's order, each from its own track. Every track is CFR on the
   * capture clock, so `srcFrames` indexes all of them: the panes play from the same source time.
   */
  panes?: PlanPane[];
  /** The acting page over the clip: pane index from relative frame `frame` on (only its cursor moves). */
  acting?: Array<{ frame: number; pane: number }>;
  /** Picture in picture: the floating page and its corners over time. */
  inset?: PlanInset;
}

// ── Multi-page clips (L2.11) ─────────────────────────────────────────────────

/** A recorded video the plan shows: the main capture (`plan.source`) or a page's own track (`plan.tracks`). */
export interface PlanSource {
  /** Filled at render time (asset server URL). */
  url: string;
  /** Absolute path of the video. */
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
  /** Mobile emulation (a phone or tablet viewport). */
  mobile?: boolean;
}

/** Where one page of a multi-page clip is drawn (output px; the inset of a picture in picture moves: see `ClipSegment.inset`). */
export interface PlanPaneLayout {
  /** Where the page's capture pixels go (fitted to its aspect inside the layout's pane rect). */
  capture: Rect;
  /** The card / device outline (the capture, plus the browser bar when the layout draws one). */
  card: Rect;
  /** Browser bar above the capture (layouts with `chrome`). */
  chrome?: Rect;
  /** Corner radius in output px. */
  radius: number;
  /** Vertical and square variants: the capture region (source CSS px) with the pane's aspect, when it differs (reframed). */
  crop?: { w: number; h: number };
}

/** One page of a multi-page clip: its track, geometry and camera (frames relative to the segment). */
export interface PlanPane {
  /** Page id (the key of the scene's `pages`). */
  page: string;
  /** Key of `plan.tracks`. */
  track: string;
  label?: string;
  layout: PlanPaneLayout;
  /** Per-output-frame camera of this page (zooms of its steps), or null when static. */
  camera: CameraFrame[] | null;
  /** Vertical / square: the crop centre per output frame when the pane reframes the page. */
  reframe?: Array<[cx: number, cy: number]>;
  /** URL of the page from relative frame `frame` on (a browser bar shows it). */
  urls: Array<{ frame: number; url: string }>;
  zooms: ZoomSpan[];
  /** The page is the floating inset of a picture in picture. */
  inset?: boolean;
}

/** The corners an inset may take (picture in picture). */
export type InsetCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/**
 * The floating page of a picture in picture: from relative frame `at` on, the inset sits in `corner` (rect `rect`,
 * output px; the composition glides between rects over `INSET_GLIDE_S`), `grow` = how much larger it is drawn while its
 * page acts (1 = not at all; theme emphasis), anchored on its corner.
 */
export interface PlanInset {
  pane: number;
  track: Array<{ at: number; corner: InsetCorner; rect: Rect }>;
  grow: number;
  /** Why each corner was chosen (review, debugging). */
  reasons?: string[];
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
  /** Base volume 0..1: the level of the intro, the outro, cards and interstitials. */
  volume: number;
  /** Multiplier applied while product footage is on screen (bed ducking), 0..1; eased over `duck_ramp_s`. */
  duck: number;
  duck_ramp_s: number;
  fadeIn_s: number;
  fadeOut_s: number;
  /** A track shorter than the video loops (seams crossfaded over `crossfade_s`); false: it plays once. */
  loop: boolean;
  crossfade_s: number;
  /** Length of the track (s), when the caller measured it (renderVideo does, with ffprobe): loops are then planned. */
  duration_s?: number;
  /**
   * The track's plays (output frames): one, trimmed to the video (a longer track, or `loop: false`), or one per loop
   * when the track is shorter — each next play starts `crossfade_s` before the previous one ends. Absent when the
   * track length is unknown (the composition then loops the element itself).
   */
  plays?: Array<{ from: number; frames: number; fadeIn: number; fadeOut: number }>;
}

export interface EditPlan {
  version: 1;
  variant: PlanVariant;
  fps: number;
  width: number;
  height: number;
  /** Layout unit: output width / 1920 (landscape) or / 1080 (vertical, square). Multiply every design size by it. */
  unit: number;
  durationInFrames: number;
  frame: FrameSpec;
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
  /** Per-page tracks of multi-page scenes (L2.11), by key (`PlanPane.track`); every one on the capture's frame grid. */
  tracks?: Record<string, PlanSource>;
  segments: PlanSegment[];
  captions: CaptionCue[];
  markers: Array<{ name: string; frame: number; scene: string }>;
  timemap: TimeMapEntry[];
  music?: PlanMusic;
  /** Tutorial overlays (L2.10): what was planned, what could not be shown, the progress bar. Absent when none is on. */
  tutorial?: PlanTutorial;
  /** Every `ds-asset:` URL of the plan → absolute file (capture, logo, wordmark, fonts, music). */
  assets: Record<string, string>;
  /** Run, scenario, project and theme the plan was made from. */
  meta: { run_id: string; project: string; scenario: string; theme: string };
  /** Planner decisions worth surfacing (trimmed idle gaps, clamped zooms…). */
  notes: string[];
  warnings: string[];
}

/** Overrides accepted by planEdit / render (MCP `render.overrides`). */
export interface EditOverrides {
  frame?: FrameSpec;
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
  /**
   * Tutorial overlays at render time (L2.10): `false` = none; `true` or switches = applied over the scenario's switches
   * (the scenes' and steps' own switches still apply under them).
   */
  tutorial?: TutorialSwitch;
}
