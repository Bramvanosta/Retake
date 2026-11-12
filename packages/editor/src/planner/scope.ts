/**
 * What the steps of `planEdit` share: the context opened from the input (output format, edit info), the sources and
 * assets, the display addresses, the component resolution and the tutorial switches — one flat scope built in that
 * order — and the working records of the later steps (entries in scenario order, segments being built).
 */
import type {
  ComponentKind,
  LoadedProject,
  LoadedTemplate,
  Timeline,
  TimelineArtefact,
  TimelineEvent,
  TimelineScene,
  TimelineScenePage,
  TimelineTrack,
  TimelineVideo,
} from '@retake/core/model';
import type { ResolvedTutorial } from '@retake/core/language';
import type { DisplayEntry } from '@retake/core/environment';
import type { ArtefactSlotType, ComponentManifest, ComponentRegistry, MediaValue, SlotContext, ThemeTokens } from '@retake/components/geometry';
import type { ZoomMove } from '../camera.js';
import type { CameraFrame, EditOverrides, PlanSegment, PlanSource, PlanTutorial, PlanVariant } from '../plan-types.js';
import type { Candidate, ComponentResolver } from '../resolve.js';
import type { RunTiming } from '../timing.js';
import type { TutorialResolve } from '../tutorial.js';
import type { MessageList } from '../util.js';
import type { PlanEditInput } from './input.js';

/** The input checked, the output format and the edit info (context.ts). */
export interface PlanContext {
  input: PlanEditInput;
  timeline: Timeline;
  template: LoadedTemplate;
  /** The theme's template.yaml (`template.template`). */
  t: LoadedTemplate['template'];
  project: LoadedProject;
  registry: ComponentRegistry;
  ov: EditOverrides;
  warnings: MessageList;
  notes: MessageList;
  cap: Timeline['capture'];
  srcFps: number;
  variant: PlanVariant;
  outFps: number;
  scale: number;
  design: { width: number; height: number };
  width: number;
  height: number;
  unit: number;
  cssW: number;
  cssH: number;
  srcFrameCount: number;
  /** Output frames of `s` seconds (at least one). */
  fr: (s: number) => number;
  video: TimelineVideo;
}

/** The URLs the browser bars show (sources.ts). */
export interface PlanAddresses {
  displayTable: DisplayEntry[];
  addressOf: (url: string) => { url: string; hidden?: true };
  warnHiddenUrl: (url: string) => void;
}

/** The plan's assets, its sources and the theme's assets and tokens (sources.ts). */
export interface PlanSources {
  assets: Record<string, string>;
  asset: (name: string, file: string) => string;
  trackSources: Record<string, PlanSource>;
  timelineTracks: Map<string, TimelineTrack>;
  mainSource: PlanSource;
  /** What the pane mapping helpers need of the plan (they are shared with the composition and the review). */
  planShape: { tracks: Record<string, PlanSource>; source: PlanSource; variant: PlanVariant; fps: number; width: number; height: number; unit: number };
  logoUrl: string;
  wordmarkUrl: string | undefined;
  displayUrl: string;
  bodyUrls: string[];
  tokens: ThemeTokens;
}

/** The media of component slots: artefacts, frames of the capture, files, tables (media.ts). */
export interface SlotMedia {
  findArtefact: (type: ArtefactSlotType, value: string) => TimelineArtefact | undefined;
  mediaOf: (manifest: ComponentManifest, slots: Record<string, string | undefined>, where: string) => Record<string, MediaValue> | undefined;
}

/** The component resolution: the resolver, the override candidates, the slot context (components.ts). */
export interface PlanComponents {
  resolver: ComponentResolver;
  overrideRefs: NonNullable<EditOverrides['components']>;
  kindOverride: (kind: ComponentKind) => Candidate[];
  segmentOverride: (id: string, kind: ComponentKind) => Candidate[];
  themeAndBuiltin: (kind: ComponentKind) => Candidate[];
  /** The scenario's outro (undefined when it has none or disables it). */
  outro: Exclude<TimelineVideo['outro'], false>;
  slotBase: SlotContext;
}

/** The tutorial overlays' switches and their resolution (components.ts). */
export interface TutorialSetup {
  stateOf: (scene: TimelineScene, ev?: TimelineEvent) => ResolvedTutorial;
  tutorialOn: boolean;
  tutorial: PlanTutorial;
  tutorialResolve: TutorialResolve;
  videoBadges: { video: number };
}

/** Everything the steps after the components share. */
export type PlanScope = PlanContext & PlanAddresses & PlanSources & SlotMedia & PlanComponents & TutorialSetup;

export interface ClipEntry {
  type: 'clip';
  scene: TimelineScene;
  events: TimelineEvent[];
  /** Multi-page scene (L2.11): its pages, each recorded on its own track. */
  pages?: TimelineScenePage[];
  /** Source seconds shown [s0, s1) and frames [A, B). */
  s0: number;
  s1: number;
  A: number;
  B: number;
  /** Joined to the previous clip without a transition (contiguous on the same page). */
  joined: boolean;
  speed: number;
}

export type CardEntry = { type: 'card'; scene: TimelineScene } | { type: 'interstitial'; scene: TimelineScene };

/** A scene, card or interstitial of the edit, in scenario order (entries.ts). */
export type Entry = ClipEntry | CardEntry;

/** The run (contiguous clips) a clip belongs to, its index in it and the run's clips (entries.ts). */
export type RunOf = Map<ClipEntry, { run: RunTiming; index: number; entries: ClipEntry[] }>;

/** A segment being built: content frames first, transitions applied afterwards. */
export interface Draft {
  seg: PlanSegment;
  /** Frames of content (clips: before any held frames). */
  content: number;
  clip?: {
    entry: ClipEntry;
    run: RunTiming;
    index: number;
    k0: number;
    k1: number;
    camera: CameraFrame[];
    reframe?: Array<[number, number]>;
    moves: ZoomMove[];
  };
}
