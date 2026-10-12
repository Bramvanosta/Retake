/**
 * `planEdit`: the edit of a capture as an EditPlan (docs/DESIGN-phase2.md §2.1, SPEC §9). PURE and deterministic:
 * no I/O, no clock, no randomness — the same input gives the same JSON.
 */
import { dirname, extname, isAbsolute, join } from 'node:path';
import { COMPONENT_KINDS, MEDIA_COMPONENTS, MULTI_PAGE_LAYOUTS, TUTORIAL_COMPONENTS, TUTORIAL_FEATURES, VIDEO_FILE_EXTENSIONS, applyTutorial, fileExtension, mediaSegmentUse, parseFrameRef, timelineVideo, tutorialOff } from '@demo-studio/core';
import type {
  ComponentKind,
  FrameSpec,
  LottieMeta,
  MediaFileFields,
  OverlayAnchor,
  VideoProbe,
  LoadedProject,
  LoadedTemplate,
  Scenario,
  Timeline,
  TimelineArtefact,
  TimelineEvent,
  TimelineScene,
  TimelineScenePage,
  TimelineTrack,
  TimelineVideo,
  TransitionKind,
} from '@demo-studio/core';
import { ANCHOR_KEYS, ARTEFACT_SLOT_TYPES, GEOMETRY_KEYS, evalAnchor, evalLayoutGeometry, fontFileFace, isMultiPaneGeometry, paramEnums, parseCsv, themeTokens } from '@demo-studio/components';
import type { AnchorSpec, ArtefactSlotType, CaptionCue, ComponentManifest, ComponentRegistry, LayoutGeometry, MediaValue, PictureMedia, SlotContext } from '@demo-studio/components';
import { MIN_ZOOM_EASE_S, cameraTrack, hintEase, clampView, isStatic, reframeTrack } from './camera.js';
import type { ReframeTarget, ZoomMove } from './camera.js';
import { DESIGN_SPACES, FALLBACK_GEOMETRY, RAW_GEOMETRY, geometryOutside, planLayout } from './layout.js';
import { PLAN_ASSET_SCHEME } from './plan-types.js';
import type {
  CameraFrame,
  CardSegment,
  ClipSegment,
  EditOverrides,
  EditPlan,
  IntroSegment,
  OutroSegment,
  OverlayUse,
  PlanBrand,
  PlanInset,
  PlanLayout,
  PlanMusic,
  PlanPane,
  PlanSegment,
  PlanSource,
  PlanTransition,
  PlanVariant,
  ResolvedComponent,
  SpeedSpan,
  StepSpan,
  TimeMapEntry,
  TrimSpan,
  ZoomSpan,
} from './plan-types.js';
import { ComponentResolver, transitionKindOf } from './resolve.js';
import type { Candidate } from './resolve.js';
import { DEFAULT_IDLE_THRESHOLD_S, WAIT_SPEED, outFrameAt, planRunTiming, waitingSpans } from './timing.js';
import type { RunTiming } from './timing.js';
import { MessageList, clamp, cursorAt, round, secs, stepEnd } from './util.js';
import { INSET_GROW, cornerOf, growClearOf, insetCornerRects, mapPaneRect, paneIndexOf, paneSource, planActing, planInsetTrack, planPaneLayout, stepBoxes } from './panes.js';
import { captionBandOver, mapUseRect, overlayBoxAt, playsSound, staysInInset } from './remotion/frames.js';
import { autoFit } from '@demo-studio/components/kit';
import { planBadgeNumbers, planClipTutorial, planProgress, tutorialReframeTargets, tutorialRequested, tutorialStateOf } from './tutorial.js';
import type { TutorialResolve } from './tutorial.js';
import type { PlanTutorial } from './plan-types.js';

/** Input of `planEdit` (DESIGN-phase2 §2). */
export interface PlanEditInput {
  timeline: Timeline;
  /** The theme. With `overrides.theme`, the caller loads that template and passes it here. */
  template: LoadedTemplate;
  project: LoadedProject;
  registry: ComponentRegistry;
  /** Absolute path of the run's capture.mp4. */
  captureFile: string;
  /** Optional extra context: used for the edit info of older timelines without a `video` block. */
  scenario?: Scenario;
  overrides?: EditOverrides;
  /** Length (s) of the music track when the caller measured it (the planner does no I/O): its loops are then planned. */
  musicDuration_s?: number;
  /** The run directory (artefact files of timeline.artefacts are relative to it); default: the capture file's folder. */
  runDir?: string;
  /**
   * Project files the planner reads (it does no I/O), by their path as written in the scenario: the text of `data:`
   * CSV files, the pixel size of image files. `planInputFiles(timeline, project)` (./inputs.ts) reads them.
   */
  files?: Record<string, PlanInputFile>;
}

/** A project file read for the planner (`PlanEditInput.files`). */
export interface PlanInputFile {
  /** Absolute path. */
  file: string;
  /** Text files (CSV / TSV). */
  text?: string;
  /** Images, videos and Lottie files: pixel size. */
  width?: number;
  height?: number;
  /** A video file (L2.12): what ffprobe says. */
  video?: VideoProbe;
  /** A Lottie file (L2.12): its metadata. */
  lottie?: LottieMeta;
  /** The file exists but could not be used (not a video ffprobe reads, not a Lottie JSON…). */
  error?: string;
  /** The file does not exist or could not be read. */
  missing?: boolean;
}

/** Seconds before the end of a clip during which an overlay still counts as "showing" for a tap-open anchor. */
export const ANCHOR_OVERLAY_WINDOW_S = 1;

/** The input cannot be planned (dry-run timeline, no capture…). */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Defaults of a music bed (base volume, multiplier under footage and its ramp, fades, loop seams). */
export const MUSIC_DEFAULTS = { volume: 0.6, duck: 0.5, duck_ramp_s: 0.5, fadeIn_s: 1, fadeOut_s: 2, loop: true, crossfade_s: 1 } as const;
/** Two scenes are contiguous in the capture when the second starts within this many seconds of the first's end. */
export const CONTIGUOUS_GAP_S = 0.1;

/**
 * The theme default zoom (motion.default_zoom, style_bias balanced / motion — R-ED-22): a very slow zoom-in on the first
 * marked step's target of a scene, held, and eased back out before the scene ends.
 */
export const DEFAULT_ZOOM = {
  /** Ease-in length (output s): as slow as the scene allows, up to this. */
  in_max_s: 4,
  /** Shortest ease-in that still reads as a slow zoom; a scene with less room gets none (a note says so). */
  in_min_s: 1.5,
  /** Ease-out back to the full view, ending with the scene's own frames (its last frame is at 1×). */
  out_s: 1.6,
  out_min_s: 0.8,
  /** Share of the room left after the mark that the ease-in may take. */
  in_share: 0.5,
} as const;

/** Overlays keep a step's targets clear from this many capture seconds before the step starts (the next click). */
export const CLEAR_LOOKAHEAD_S = 1.2;

/** Seconds around a click during which the clicked target must stay fully in view of a reframed variant. */
export const REFRAME_CLICK_WINDOW_S = { before: 0.35, after: 0.5 } as const;

interface ClipEntry {
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

type CardEntry = { type: 'card'; scene: TimelineScene } | { type: 'interstitial'; scene: TimelineScene };

type Entry = ClipEntry | CardEntry;

/** A segment being built: content frames first, transitions applied afterwards. */
interface Draft {
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

/** The URL a page's track shows at capture time `t` (its last URL segment starting at or before `t`). */
function trackUrlAt(track: TimelineTrack, t: number): string | undefined {
  let url: string | undefined;
  for (const p of track.pages) {
    if (p.t_start <= t + 1e-6) url = p.url ?? url;
    else break;
  }
  return url ?? track.pages[0]?.url;
}

function pageAt(timeline: Timeline, t: number): { id: string; url?: string } | undefined {
  let found: Timeline['pages'][number] | undefined;
  for (const p of timeline.pages) {
    if (p.t_start <= t + 1e-6) found = p;
    if (p.t_start > t) break;
  }
  return found;
}

/** A short deterministic hash of a string (FNV-1a, 8 hex digits): unique asset names for user files. */
function shortHash(v: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function centre(b: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Plan the edit of a capture. Pure and deterministic. */
export function planEdit(input: PlanEditInput): EditPlan {
  const { timeline, template, project, registry } = input;
  const ov: EditOverrides = input.overrides ?? {};
  const warnings = new MessageList();
  const notes = new MessageList();
  const t = template.template;

  if (timeline.mode === 'dry') throw new PlanError(`run ${timeline.run_id} is a dry run: it has no capture to edit`);
  const cap = timeline.capture;
  if (!(cap.fps > 0) || !(cap.duration > 0)) throw new PlanError(`run ${timeline.run_id} has no usable capture (fps ${cap.fps}, ${cap.duration} s)`);
  if (cap.cursor === 'hidden') {
    warnings.add(`run ${timeline.run_id} was captured without its in-page cursor (raw export for editors, run --raw --cursor none|layer): the video shows no cursor — capture without --raw for an edited video`);
  }

  // ── Output format ────────────────────────────────────────────────────────────
  const srcFps = cap.fps;
  let variant: PlanVariant = ov.variant ?? 'landscape';
  if (!(variant in DESIGN_SPACES)) {
    warnings.add(`overrides.variant "${String(variant)}" ignored: use landscape, vertical or square`);
    variant = 'landscape';
  }
  let outFps = srcFps;
  if (ov.fps !== undefined) {
    if (ov.fps > 0 && ov.fps <= 120) outFps = ov.fps;
    else warnings.add(`overrides.fps ${ov.fps} ignored: use 1–120 (keeping the capture's ${srcFps} fps)`);
  }
  let scale = cap.scale > 0 ? cap.scale : 1;
  if (ov.scale !== undefined) {
    if (ov.scale > 0 && ov.scale <= 4) scale = ov.scale;
    else warnings.add(`overrides.scale ${ov.scale} ignored: use a factor in (0, 4]`);
  }
  const design = DESIGN_SPACES[variant];
  const width = Math.round(design.width * scale);
  const height = Math.round(design.height * scale);
  const unit = width / design.width;
  const cssW = cap.width;
  const cssH = cap.height;
  const srcFrameCount = Math.max(1, Math.round(cap.duration * srcFps));
  const capScale = cap.scale > 0 ? cap.scale : 1;
  if (scale > capScale + 1e-6) {
    warnings.add(
      `the capture is ${Math.round(cssW * capScale)}×${Math.round(cssH * capScale)} px (scale ${capScale}): it is upscaled in this ${width}×${height} output ` +
        `(×${round(scale / capScale, 2)}; everything else is drawn at full resolution) — capture at scale ${round(scale, 2)} for a crisp result`,
    );
  }
  const fr = (s: number) => Math.max(1, Math.round(s * outFps));

  // ── Edit info, theme, assets ─────────────────────────────────────────────────
  let video: TimelineVideo;
  if (timeline.video) video = timeline.video;
  else {
    video = input.scenario ? timelineVideo(input.scenario, project.config) : { frame: project.config.frame };
    notes.add(`timeline.json has no "video" block (run made before L2.1): edit info taken from ${input.scenario ? 'the scenario' : 'the project'}`);
  }
  if (ov.theme !== undefined && ov.theme !== template.name && ov.theme !== t.name) {
    warnings.add(`overrides.theme is "${ov.theme}" but the theme passed to the planner is "${template.name}": the caller loads the override theme`);
  }
  if (video.template && video.template !== template.name && video.template !== t.name) {
    notes.add(`theme "${template.name}" (the run was captured with "${video.template}"): the scenario is unchanged`);
  }

  const assets: Record<string, string> = {};
  const asset = (name: string, file: string): string => {
    const url = `${PLAN_ASSET_SCHEME}${name}${extname(file).toLowerCase()}`;
    assets[url] = file;
    return url;
  };
  const captureUrl = asset('capture', input.captureFile);
  // Per-page tracks of multi-page scenes (L2.11): every one CFR on the capture's frame grid.
  const trackDir = input.runDir ?? dirname(input.captureFile);
  const trackSources: Record<string, PlanSource> = {};
  const timelineTracks = new Map<string, TimelineTrack>((timeline.tracks ?? []).map((tr) => [tr.id, tr]));
  for (const tr of timeline.tracks ?? []) {
    const file = join(trackDir, tr.file);
    const name = `track-${tr.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    trackSources[tr.id] = {
      url: asset(name, file),
      file,
      width: Math.round(tr.width * tr.scale),
      height: Math.round(tr.height * tr.scale),
      cssWidth: tr.width,
      cssHeight: tr.height,
      scale: tr.scale,
      fps: tr.fps,
      frames: srcFrameCount,
      ...(tr.mobile ? { mobile: true } : {}),
    };
  }
  const mainSource: PlanSource = {
    url: captureUrl,
    file: input.captureFile,
    width: Math.round(cssW * cap.scale),
    height: Math.round(cssH * cap.scale),
    cssWidth: cssW,
    cssHeight: cssH,
    scale: cap.scale,
    fps: srcFps,
    frames: srcFrameCount,
  };
  /** What the pane mapping helpers need of the plan (they are shared with the composition and the review). */
  const planShape = { tracks: trackSources, source: mainSource, variant, fps: outFps, width, height, unit };
  const logoUrl = asset('logo', template.assets.logo);
  const wordmarkUrl = template.assets.wordmark ? asset('wordmark', template.assets.wordmark) : undefined;
  const displayUrl = asset('font-display', template.assets.display);
  const bodyUrls = template.assets.body.map((f, i) => asset(`font-body-${i}`, f));
  const tokens = themeTokens(template, { logo: logoUrl, wordmark: wordmarkUrl, fonts: { display: displayUrl, body: bodyUrls } });

  // ── Artefacts (L2.9): `email` / `document` / `notification` slots → media with ds-asset images ──────────────
  const runDir = input.runDir ?? dirname(input.captureFile);
  const artefacts: TimelineArtefact[] = timeline.artefacts ?? [];
  const findArtefact = (type: ArtefactSlotType, value: string): TimelineArtefact | undefined => {
    const v = value.trim();
    const kind = type === 'capture' ? 'text' : type;
    const own = artefacts.filter((a) => a.kind === kind);
    const byName = own.find((a) => a.name === v);
    if (byName || type !== 'notification' || !/^\d+$/.test(v)) return byName;
    return own.find((a) => a.kind === 'notification' && a.index === Number(v));
  };
  const slugOf = (x: string) => x.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const mediaOfArtefact = (a: TimelineArtefact): MediaValue => {
    const img = (prefix: string, i: { file: string; width: number; height: number }) => ({ url: asset(`${prefix}`, join(runDir, i.file)), width: i.width, height: i.height });
    if (a.kind === 'email') {
      return {
        kind: 'email',
        name: a.name,
        from: a.from,
        ...(a.from_name ? { from_name: a.from_name } : {}),
        to: [...a.to],
        subject: a.subject,
        date: a.date,
        preview: a.preview,
        ...(a.image ? { image: img(`artefact-email-${slugOf(a.name)}`, a.image) } : {}),
      };
    }
    if (a.kind === 'document') {
      return {
        kind: 'document',
        name: a.name,
        file_name: a.file_name,
        pages: a.pages.map((p, i) => ({ ...img(`artefact-document-${slugOf(a.name)}-p${i + 1}`, p), number: i + 1, width_pt: p.width_pt, height_pt: p.height_pt })),
      };
    }
    if (a.kind === 'text') return { kind: 'text', name: a.name, value: a.value, text: a.text };
    let app = a.origin;
    try {
      app = new URL(a.origin).host || a.origin;
    } catch {
      /* keep the origin */
    }
    return {
      kind: 'notification',
      name: a.name,
      title: a.title,
      body: a.body,
      app,
      time: a.time,
      ...(a.tag ? { tag: a.tag } : {}),
      ...(a.icon ? { icon: img(`artefact-notification-${slugOf(a.name)}-icon`, a.icon) } : {}),
    };
  };
  // L2.10: frames of the capture (before/after cards), project images and CSV tables.
  const projectFile = (rel: string): string => (isAbsolute(rel) ? rel : join(project.dir, rel));
  const captureFrameTime = (t: number): number => {
    const k = clamp(Math.round(t * cap.fps), 0, Math.max(0, srcFrameCount - 1));
    return round(k / cap.fps, 4);
  };
  const sceneStart = (sceneId: string): number | undefined => {
    const sc = timeline.scenes.find((x) => x.id === sceneId && x.kind === 'scene');
    if (!sc) return undefined;
    const evs = timeline.events.filter((e) => e.scene === sc.id && e.scene_index === sc.index);
    const still = evs.find((e) => e.action === 'scene_still');
    const open = evs.find((e) => e.action === 'scene_open');
    return (still ? still.t_start : open ? open.t_end : sc.t_start) + 0.05;
  };
  const frameMedia = (slot: string, value: string, where: string): PictureMedia | undefined => {
    const ref = parseFrameRef(value);
    if (!ref) {
      warnings.add(`${where}: "${value}" is not a frame (a mark, start:/end:<scene>, 12.5s or an image file)`);
      return undefined;
    }
    if (ref.kind === 'file') {
      const f = input.files?.[ref.path];
      if (f?.missing) warnings.add(`${where}: image ${ref.path} not found`);
      const url = asset(`image-${slugOf(ref.path)}`, f?.file ?? projectFile(ref.path));
      return { kind: 'picture', name: slot, url, ...(f?.width && f.height ? { width: f.width, height: f.height } : {}), label: ref.path };
    }
    let t: number | undefined;
    let label = '';
    // Multi-page scenes (L2.11): a scene start / end or a mark shows the frame of that page's own track.
    let src: PlanSource = mainSource;
    if (ref.kind === 'scene') {
      const pg = timeline.scenes.find((x) => x.id === ref.scene && x.kind === 'scene')?.pages?.[0];
      if (pg && trackSources[pg.track]) src = trackSources[pg.track];
    } else if (ref.kind === 'mark') {
      const page = timeline.markers.find((m) => m.name === ref.name)?.page;
      if (page && trackSources[page]) src = trackSources[page];
    }
    if (ref.kind === 'time') {
      t = ref.t;
      label = `${ref.t} s of the capture`;
      if (t > cap.duration) warnings.add(`${where}: ${value} is past the end of the capture (${secs(cap.duration)})`);
    } else if (ref.kind === 'scene') {
      const sc = timeline.scenes.find((x) => x.id === ref.scene && x.kind === 'scene');
      if (sc) t = ref.at === 'start' ? sceneStart(sc.id) : sc.t_end - 1 / cap.fps;
      label = `${ref.at === 'start' ? 'start' : 'end'} of scene ${ref.scene}`;
      if (t === undefined) warnings.add(`${where}: scene "${ref.scene}" was not captured by run ${timeline.run_id}`);
    } else {
      const mk = timeline.markers.find((m) => m.name === ref.name);
      label = `mark ${ref.name}`;
      if (!mk) warnings.add(`${where}: mark "${ref.name}" is not in run ${timeline.run_id} (marks: ${timeline.markers.map((m) => m.name).join(', ') || 'none'})`);
      else t = markDoneAt(timeline, mk);
    }
    if (t === undefined) return undefined;
    return { kind: 'picture', name: slot, url: src.url, width: src.width, height: src.height, video: { time_s: captureFrameTime(t) }, label };
  };
  /** A user file named by a `media` / `lottie` slot (L2.12): served by the renderer, with what was read of it. */
  const fileMedia = (type: 'media' | 'lottie', v: string, where: string): MediaValue | undefined => {
    const f = input.files?.[v];
    const file = f?.file ?? projectFile(v);
    // Served only when it is drawn: a file that is missing or unreadable is a warning and shows nothing — it is not an
    // asset of the plan (the renderer refuses a plan whose assets are missing).
    const served = () => asset(`file-${slugOf(v.replace(/^.*[\\/]/, ''))}-${shortHash(file)}`, file);
    if (!f || f.missing) {
      warnings.add(`${where}: file ${v} ${f?.missing ? 'not found' : 'was not read (the caller passes `files`, see planInputFiles)'}: nothing is shown`);
      return undefined;
    }
    if (f.error) {
      warnings.add(`${where}: file ${v}: ${f.error}: nothing is shown`);
      return undefined;
    }
    if (type === 'lottie') {
      if (!f.lottie) {
        warnings.add(`${where}: ${v} is not a Lottie file: nothing is shown`);
        return undefined;
      }
      const l = f.lottie;
      return { kind: 'lottie', name: v, url: served(), width: l.width, height: l.height, fps: l.fps, frames: l.frames, duration_s: l.duration_s };
    }
    if (VIDEO_FILE_EXTENSIONS.includes(fileExtension(v))) {
      const p = f.video;
      if (!p) {
        warnings.add(`${where}: video ${v} could not be probed (ffprobe): nothing is shown`);
        return undefined;
      }
      return { kind: 'video', name: v, url: served(), width: p.width, height: p.height, duration_s: p.duration_s, fps: p.fps, audio: p.audio, alpha: p.alpha, codec: p.codec };
    }
    return { kind: 'picture', name: v, url: served(), ...(f.width && f.height ? { width: f.width, height: f.height } : {}), label: v };
  };
  const mediaOf = (manifest: ComponentManifest, slots: Record<string, string | undefined>, where: string): Record<string, MediaValue> | undefined => {
    let out: Record<string, MediaValue> | undefined;
    for (const [slot, spec] of Object.entries(manifest.slots)) {
      const value = slots[slot];
      if (value === undefined || value.trim() === '') continue;
      if (spec.type === 'image') {
        // An image file of the project: served by the renderer, the slot holds its URL.
        const v = value.trim();
        if (!/^(https?:|data:|ds-asset:)/.test(v)) {
          const f = input.files?.[v];
          if (f?.missing) warnings.add(`${where}: image ${v} not found`);
          slots[slot] = asset(`image-${slugOf(v)}`, f?.file ?? projectFile(v));
        }
        continue;
      }
      if (spec.type === 'frame') {
        const m = frameMedia(slot, value, where);
        if (m) (out ??= {})[slot] = m;
        continue;
      }
      if (spec.type === 'media' || spec.type === 'lottie') {
        // A user file (L2.12): a video or an image (media), a Lottie JSON (lottie) — of the project, or of the theme
        // (absolute paths).
        const m = fileMedia(spec.type, value.trim(), where);
        if (m) (out ??= {})[slot] = m;
        continue;
      }
      if (spec.type === 'data') {
        const v = value.trim();
        const f = input.files?.[v];
        if (!f || f.text === undefined) {
          warnings.add(`${where}: data file ${v} ${f?.missing ? 'not found' : 'was not read (the caller passes `files`, see planInputFiles)'}`);
          continue;
        }
        const table = parseCsv(f.text);
        if (table.columns.length === 0) warnings.add(`${where}: data file ${v} is empty`);
        (out ??= {})[slot] = { kind: 'table', name: v, columns: table.columns, rows: table.rows };
        continue;
      }
      if (!(ARTEFACT_SLOT_TYPES as readonly string[]).includes(spec.type)) continue;
      const type = spec.type as ArtefactSlotType;
      const a = findArtefact(type, value);
      if (!a) {
        const kind = type === 'capture' ? 'text' : type;
        const names = artefacts.filter((x) => x.kind === kind).map((x) => (x.kind === 'notification' ? `${x.name} (#${x.index})` : x.name));
        warnings.add(
          `${where}: ${type} "${value}" was not captured by run ${timeline.run_id}` +
            (names.length ? ` (captured: ${names.join(', ')})` : ` (the run captured no ${type === 'capture' ? 'text' : type})`) +
            ' — the component shows its scenario values only',
        );
        continue;
      }
      if (a.kind === 'document' && a.pages.length === 0) warnings.add(`${where}: document "${value}" has no rasterised page (not a PDF or an image?)`);
      (out ??= {})[slot] = mediaOfArtefact(a);
    }
    return out;
  };

  const resolver = new ComponentResolver(registry, template, warnings, mediaOf);
  const overrideRefs = ov.components ?? {};
  const kindOverride = (kind: ComponentKind): Candidate[] =>
    overrideRefs[kind] !== undefined ? [{ ref: overrideRefs[kind], source: 'override', label: `overrides.components.${kind}` }] : [];
  const segmentOverride = (id: string, kind: ComponentKind): Candidate[] =>
    id !== kind && overrideRefs[id] !== undefined ? [{ ref: overrideRefs[id], source: 'override', label: `overrides.components["${id}"]` }] : [];
  const themeAndBuiltin = (kind: ComponentKind): Candidate[] => [resolver.themeCandidate(kind), resolver.builtinCandidate(kind)];

  const outro = video.outro === false ? undefined : video.outro;
  const slotBase: SlotContext = {
    theme: tokens,
    templateOutro: { tagline: t.outro.tagline, url: t.outro.url },
    scenario: { title: video.title, outro: video.outro === false ? false : outro ? { tagline: outro.tagline, url: outro.url } : undefined },
  };

  // ── Tutorial overlays (L2.10): switches scenario → scene → step, the render override over the scenario's ───────
  const stateOf = tutorialStateOf(video.tutorial, ov.tutorial);
  const tutorialOn = tutorialRequested(timeline, ov.tutorial);
  if (ov.tutorial === false && tutorialRequested(timeline, undefined)) notes.add('tutorial overlays disabled (overrides.tutorial = false)');
  const tutorial: PlanTutorial = { uses: {}, skipped: [] };
  const tutorialResolve: TutorialResolve = (feature, state, slots, where) => {
    const chain: Candidate[] = [];
    const key = `tutorial-${feature}`;
    if (overrideRefs[key] !== undefined) chain.push({ ref: overrideRefs[key], source: 'override', label: `overrides.components["${key}"]` });
    const builtin = TUTORIAL_COMPONENTS[feature];
    const custom = state.component !== builtin || Object.keys(state.params).length > 0;
    chain.push({ ref: { id: state.component, params: state.params }, source: custom ? 'scenario' : 'builtin-default', label: `the tutorial ${feature}` });
    if (state.component !== builtin) chain.push({ ref: builtin, source: 'builtin-default', label: 'the built-in default' });
    return resolver.resolve('overlay', chain, where, { explicit: slots, ctx: slotBase });
  };
  const videoBadges = { video: 0 };

  // ── Entries: scenes, cards, interstitials in scenario order ──────────────────
  const entries: Entry[] = [];
  const knownIds = new Set<string>(['intro', 'outro', ...TUTORIAL_FEATURES.map((f) => `tutorial-${f}`)]);
  for (const scene of timeline.scenes) {
    knownIds.add(scene.id);
    if (scene.status === 'skipped') {
      notes.add(`scene "${scene.id}" was skipped by the run: not in the edit`);
      continue;
    }
    if (scene.kind === 'card' || scene.kind === 'interstitial') {
      entries.push(scene.kind === 'card' ? { type: 'card', scene } : { type: 'interstitial', scene });
      continue;
    }
    if (scene.status === 'failed' || scene.status === 'partial') warnings.add(`scene "${scene.id}" ${scene.status === 'failed' ? 'failed' : 'is partial'} in the run: its clip shows what was captured`);
    // Notification events (step -1, L2.9) belong to no step: they are artefacts, not provenance.
    const events = timeline.events
      .filter((e) => e.scene === scene.id && e.scene_index === scene.index && e.action !== 'notification')
      .sort((a, b) => a.t_start - b.t_start || a.step - b.step);
    const open = events.find((e) => e.action === 'scene_open');
    const still = events.find((e) => e.action === 'scene_still');
    const s0 = still ? still.t_start : open ? open.t_end : scene.t_start;
    const s1 = Math.min(scene.t_end, cap.duration);
    let A = Math.ceil(s0 * srcFps - 1e-6);
    const B = Math.min(srcFrameCount, Math.ceil(s1 * srcFps - 1e-6));
    const prev = entries[entries.length - 1];
    let joined = false;
    const pages = scene.pages && scene.pages.length > 0 ? scene.pages : undefined;
    if (pages) {
      const missing = pages.filter((pg) => !trackSources[pg.track]);
      if (missing.length > 0) warnings.add(`scene "${scene.id}": no track for page${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m.id}"`).join(', ')} in the run: shown from the main capture`);
    }
    if (prev && prev.type === 'clip' && !open) {
      const gap = s0 - prev.s1;
      // Single-page scenes: the same page of the main capture; multi-page scenes: the same pages (their tracks).
      const samePages = pages || prev.pages ? (pages ?? []).map((p) => p.id).join('|') === (prev.pages ?? []).map((p) => p.id).join('|') : undefined;
      const pagePrev = pageAt(timeline, Math.max(prev.s0, prev.s1 - 1e-3))?.id ?? prev.scene.page;
      const pageNext = pageAt(timeline, s0)?.id ?? scene.page;
      if (gap <= CONTIGUOUS_GAP_S && gap >= -CONTIGUOUS_GAP_S && (samePages ?? pagePrev === pageNext)) {
        joined = true;
        A = prev.B;
        notes.add(`"${scene.id}" continues "${prev.scene.id}" on the same page: joined without a transition (the camera continues)`);
        if (scene.transition && scene.transition !== 'cut') notes.add(`"${scene.id}": transition "${scene.transition}" not used — contiguous same-page scenes are joined`);
      }
    }
    if (B <= A) {
      warnings.add(`scene "${scene.id}" has nothing to show (capture ${secs(s0)}–${secs(s1)}): left out`);
      continue;
    }
    let speed = scene.speed ?? 1;
    const ovSpeed = ov.speeds?.[scene.id];
    if (ovSpeed !== undefined) {
      if (ovSpeed > 0 && ovSpeed <= 16) {
        speed = ovSpeed;
        notes.add(`scene "${scene.id}": speed ${ovSpeed}× (overrides.speeds)`);
      } else warnings.add(`overrides.speeds["${scene.id}"] = ${ovSpeed} ignored: use a speed in (0, 16]`);
    }
    if (!(speed > 0)) speed = 1;
    if (open) notes.add(`"${scene.id}": page load ${secs(open.t_start)}–${secs(s0)} of the capture is not shown`);
    entries.push({ type: 'clip', scene, events, s0, s1, A, B, joined, speed, ...(pages && pages.every((pg) => trackSources[pg.track]) ? { pages } : {}) });
  }
  for (const id of Object.keys(ov.speeds ?? {})) {
    if (!timeline.scenes.some((s) => s.id === id && s.kind === 'scene')) warnings.add(`overrides.speeds["${id}"]: no captured scene "${id}" in this run`);
  }
  for (const key of Object.keys(overrideRefs)) {
    if (!(COMPONENT_KINDS as readonly string[]).includes(key) && !knownIds.has(key)) {
      warnings.add(`overrides.components["${key}"]: neither a component kind nor a segment id of this video`);
    }
  }
  if (!entries.some((e) => e.type === 'clip')) warnings.add('no captured scene to show: the video has only cards');

  // ── Runs (contiguous clips) and their time maps ───────────────────────────────
  const trimIdle = ov.trim_idle !== false;
  let idleThreshold = DEFAULT_IDLE_THRESHOLD_S;
  if (ov.idle_threshold !== undefined) {
    if (ov.idle_threshold > 0) idleThreshold = ov.idle_threshold;
    else warnings.add(`overrides.idle_threshold ${ov.idle_threshold} ignored: use a number of seconds > 0`);
  }
  if (!trimIdle) notes.add('idle trimming disabled (overrides.trim_idle = false)');
  const runs: ClipEntry[][] = [];
  for (const e of entries) {
    if (e.type !== 'clip') continue;
    if (e.joined && runs.length > 0) runs[runs.length - 1].push(e);
    else runs.push([e]);
  }
  const runOf = new Map<ClipEntry, { run: RunTiming; index: number; entries: ClipEntry[] }>();
  // Page changes (URL segments of the main capture and of every page track): a wait right after one shows loading.
  const pageChanges = [...timeline.pages.map((pg) => pg.t_start), ...(timeline.tracks ?? []).flatMap((tr) => tr.pages.map((pg) => pg.t_start))].sort((a, b) => a - b);
  for (const runEntries of runs) {
    const waits = trimIdle ? runEntries.flatMap((e) => waitingSpans(e.events, pageChanges)) : [];
    const run = planRunTiming({
      clips: runEntries.map((e) => ({ scene: e.scene.id, A: e.A, B: e.B, baseSpeed: e.speed, events: e.events })),
      srcFps,
      outFps,
      idle: timeline.idle,
      trimIdle,
      idleThresholdS: idleThreshold,
      waits,
    });
    for (const w of waits) {
      const sc = runEntries.find((e) => w.t_start >= e.s0 - 1e-6 && w.t_start < e.s1)?.scene.id ?? runEntries[0].scene.id;
      notes.add(`"${sc}": waiting ${secs(w.t_start)}–${secs(w.t_end)} of the capture played at up to ${WAIT_SPEED}× (a loading state; marks and holds stay at 1×)`);
    }
    runEntries.forEach((e, index) => runOf.set(e, { run, index, entries: runEntries }));
    for (const c of run.cuts) {
      const kept = (c.idle.b - c.idle.a - (c.b - c.a)) / srcFps;
      notes.add(`"${runEntries[c.clip].scene.id}": idle ${secs((c.idle.b - c.idle.a) / srcFps)} at ${secs(c.idle.a / srcFps)} of the capture shortened to ${secs(kept)}`);
    }
  }

  // ── Camera (per run) ──────────────────────────────────────────────────────────
  const maxZoom = t.motion.max_zoom;
  // Theme default zoom (R-ED-22, decided 2026-10-11): only with style_bias balanced / motion; `real` keeps a static
  // camera. At most one per scene, on the first marked step that has a target, never across a cut or a join.
  const dz = t.motion.default_zoom;
  let defaultZoom: number | null = null;
  if (typeof dz === 'number' && dz > 1) {
    if (t.style_bias === 'real') notes.add(`motion.default_zoom ${dz} not used: style_bias "real" keeps a static camera (zooms only from step camera hints)`);
    else if (ov.camera === false) notes.add(`motion.default_zoom ${dz} not used (overrides.camera = false)`);
    else {
      defaultZoom = Math.min(dz, maxZoom);
      if (dz > maxZoom) notes.add(`motion.default_zoom ${dz} clamped to the theme max_zoom ${maxZoom}`);
    }
  }
  const themeZoom = (e: ClipEntry, ci: number, run: RunTiming): ZoomMove | null => {
    if (defaultZoom === null) return null;
    const marked = e.events.filter((ev) => ev.step >= 0 && ev.mark);
    for (const ev of marked) {
      const box = ev.camera?.bbox ?? ev.target?.bbox ?? ev.overlay?.bbox;
      const point = box ? centre(box) : ev.point ?? ev.overlay?.point;
      if (!point) continue;
      const range = run.clipRanges[ci];
      const start = Math.max(range.k0, outFrameAt(run, ev.t_start));
      const room = range.k1 - start;
      const outFrames = Math.min(DEFAULT_ZOOM.out_s * outFps, room * 0.25);
      const inFrames = Math.min(DEFAULT_ZOOM.in_max_s * outFps, room * DEFAULT_ZOOM.in_share);
      if (inFrames < DEFAULT_ZOOM.in_min_s * outFps || outFrames < DEFAULT_ZOOM.out_min_s * outFps) {
        notes.add(`"${e.scene.id}": no theme zoom on the mark "${ev.mark}" (step ${ev.step}): ${secs(room / outFps)} left in the scene, too short for a slow zoom`);
        return null;
      }
      notes.add(`"${e.scene.id}": theme zoom ${defaultZoom}× on the mark "${ev.mark}" (step ${ev.step}), in over ${secs(inFrames / outFps)}, out before the scene ends`);
      return {
        scene: e.scene.id,
        step: ev.step,
        zoom: defaultZoom,
        requested: typeof dz === 'number' ? dz : defaultZoom,
        focus: { x: round(point.x, 2), y: round(point.y, 2) },
        start,
        frames: round(inFrames, 3),
        outAt: round(range.k1 - 1 - outFrames, 3),
        outFrames: round(outFrames, 3),
        ease: t.motion.zoom_ease,
        source: 'theme',
      };
    }
    return null;
  };
  type RunCamera = { track: CameraFrame[]; moves: ZoomMove[] };
  // Multi-page runs (L2.11): one camera per page (its own steps' hints and theme zoom, on its own page size).
  const camByRun = new Map<RunTiming, RunCamera & { pages?: Map<string, RunCamera> }>();
  let hintCount = 0;
  const runCamera = (runEntries: ClipEntry[], run: RunTiming, page: string | undefined, cursor: Timeline['cursor'], W: number, H: number): RunCamera => {
    const moves: ZoomMove[] = [];
    runEntries.forEach((e, ci) => {
      const evs = page === undefined ? e.events : e.events.filter((ev) => ev.page === page);
      const hinted = e.events.some((ev) => ev.camera && ev.step >= 0);
      // The theme zoom of a multi-page scene goes to the page of its first marked step (at most one per scene).
      const firstMarked = e.events.find((ev) => ev.step >= 0 && ev.mark && (ev.camera?.bbox ?? ev.target?.bbox ?? ev.overlay?.bbox ?? ev.point ?? ev.overlay?.point));
      if (!hinted && defaultZoom !== null && ov.camera !== false && (page === undefined || firstMarked?.page === page)) {
        const mv = themeZoom({ ...e, events: evs }, ci, run);
        if (mv) moves.push(mv);
      }
      for (const ev of evs) {
        if (!ev.camera || ev.step < 0) continue;
        hintCount++;
        if (ov.camera === false) continue;
        const requested = ev.camera.zoom;
        const zoom = clamp(requested, 1, maxZoom);
        if (requested > maxZoom) notes.add(`"${e.scene.id}" step ${ev.step}: zoom ${requested} clamped to the theme max_zoom ${maxZoom}`);
        const focus = ev.camera.bbox ? centre(ev.camera.bbox) : ev.camera.point ? { ...ev.camera.point } : (cursorAt(cursor, ev.t_end, false) ?? { x: W / 2, y: H / 2 });
        const start = outFrameAt(run, ev.t_start);
        if (start >= run.clipRanges[ci].k1) continue;
        const stepFrames = Math.max(0, outFrameAt(run, ev.t_end) - start);
        const frames = Math.max(MIN_ZOOM_EASE_S, ev.camera.duration ?? stepFrames / outFps) * outFps;
        const until = ev.camera.until ?? 'scene_end';
        const outAt =
          until === 'step_end' ? outFrameAt(run, stepEnd(ev)) : until === 'scene_end' ? run.clipRanges[ci].k1 : start + frames + until * outFps;
        moves.push({ scene: e.scene.id, step: ev.step, zoom, requested, focus: { x: round(focus.x, 2), y: round(focus.y, 2) }, start, frames, outAt, ease: hintEase(ev.camera, t.motion.zoom_ease), source: 'hint' });
      }
    });
    return { track: cameraTrack(moves, run.src.length, W, H), moves };
  };
  for (const runEntries of runs) {
    const { run } = runOf.get(runEntries[0])!;
    const pages = runEntries[0].pages;
    if (pages) {
      const per = new Map<string, RunCamera>();
      for (const pg of pages) {
        const tr = timelineTracks.get(pg.track)!;
        per.set(pg.id, runCamera(runEntries, run, pg.id, tr.cursor, tr.width, tr.height));
      }
      camByRun.set(run, { track: cameraTrack([], run.src.length, cssW, cssH), moves: [...per.values()].flatMap((c) => c.moves), pages: per });
    } else camByRun.set(run, runCamera(runEntries, run, undefined, timeline.cursor, cssW, cssH));
  }
  if (ov.camera === false && hintCount > 0) notes.add(`camera disabled (overrides.camera = false): ${hintCount} zoom hint${hintCount === 1 ? '' : 's'} ignored`);

  // ── Layouts ───────────────────────────────────────────────────────────────────
  const videoFrame: FrameSpec = ov.frame ?? video.frame ?? project.config.frame;
  const layoutChain = (sceneFrame: FrameSpec | undefined, segmentId?: string): Candidate[] => {
    const chain: Candidate[] = [];
    if (segmentId) chain.push(...segmentOverride(segmentId, 'layout'));
    chain.push(...kindOverride('layout'));
    if (ov.frame !== undefined) chain.push(resolver.frameCandidate(ov.frame, 'override', 'overrides.frame'));
    if (sceneFrame !== undefined) chain.push(resolver.frameCandidate(sceneFrame, 'scenario', 'the scene frame'));
    const vf = video.frame ?? project.config.frame;
    chain.push(resolver.frameCandidate(vf, 'scenario', 'the scenario/project frame'));
    const theme = resolver.themeCandidate('layout');
    if (theme.ref !== null) chain.push(theme);
    chain.push(resolver.builtinCandidate('layout'));
    return chain;
  };
  const layoutOf = (rc: ResolvedComponent | null, frameSpec: FrameSpec, where: string): PlanLayout => {
    const manifest = resolver.manifest(rc);
    const geometryKey = GEOMETRY_KEYS[variant];
    const spec = manifest?.[geometryKey];
    const radius = typeof rc?.params.radius === 'number' ? rc.params.radius : undefined;
    if (spec && rc) {
      // The geometry follows the params of this use (and the capture aspect): e.g. a theme `width` moves the card and
      // the caption / brand mark rects with it.
      let geometry: LayoutGeometry | undefined;
      try {
        geometry = evalLayoutGeometry(spec, rc.params, { aspect: cssW / cssH });
      } catch (e) {
        warnings.add(`${where}: layout ${rc.id}: ${(e as Error).message}: default geometry used`);
      }
      if (geometry) {
        const outside = geometryOutside(geometry, variant);
        if (outside.length > 0) warnings.add(`${where}: layout ${rc.id} with ${JSON.stringify(rc.params)}: ${outside.join(', ')} leave${outside.length === 1 ? 's' : ''} the frame`);
        return planLayout(geometry, { variant, unit, cssWidth: cssW, cssHeight: cssH, radius: geometry.radius ?? radius });
      }
    }
    const raw = frameSpec === 'raw' || rc?.id.endsWith('layout-raw');
    if (rc && !rc.missing) warnings.add(`${where}: layout ${rc.id} declares no ${GEOMETRY_KEYS[variant]}: default geometry used`);
    return planLayout((raw ? RAW_GEOMETRY : FALLBACK_GEOMETRY)[variant], { variant, unit, cssWidth: cssW, cssHeight: cssH, radius, fallback: true });
  };
  const mainLayoutComponent = resolver.resolve('layout', layoutChain(undefined), 'video layout') ?? null;
  const mainLayout = layoutOf(mainLayoutComponent, videoFrame, 'video layout');

  // ── Drafts ────────────────────────────────────────────────────────────────────
  const drafts: Draft[] = [];
  const reframeByRun = new Map<RunTiming, Array<[number, number]>>();
  const paneReframeByRun = new Map<string, Array<[number, number]>>();
  let runKeys = 0;
  const runKey = new Map<RunTiming, number>();

  /**
   * The panes of a multi-page clip (L2.11): the layout's geometry evaluated with both pages' aspects, each page's
   * output rect (split: top-aligned in its pane; picture in picture: the main page in `screen`, the other in `inset`),
   * its camera (its own steps' zooms; none in an inset), its reframe in vertical / square, its URLs.
   */
  function planPanes(e: ClipEntry, rc: ResolvedComponent, where: string, r: { run: RunTiming; entries: ClipEntry[] }, range: { k0: number; k1: number }): { layout: PlanLayout; panes: PlanPane[]; inset?: PlanInset } | null {
    const pages = e.pages!;
    const manifest = resolver.manifest(rc);
    const spec = manifest?.[GEOMETRY_KEYS[variant]] ?? manifest?.geometry;
    if (!spec || !isMultiPaneGeometry(spec)) {
      warnings.add(`${where}: layout ${rc.id} shows one page: the scene's ${pages.length} pages cannot be placed (the first one is shown)`);
      return null;
    }
    const css = (pg: TimelineScenePage) => trackSources[pg.track];
    const aspectOf = (pg: TimelineScenePage) => css(pg).cssWidth / css(pg).cssHeight;
    // Picture in picture: the main page is the landscape one when the first page is a portrait one (a phone).
    let ordered = [...pages];
    const isPip = spec.inset !== undefined;
    if (isPip && ordered.length === 2 && aspectOf(ordered[0]) < 1 && aspectOf(ordered[1]) >= 1) {
      ordered = [ordered[1], ordered[0]];
      notes.add(`${where}: "${ordered[0].id}" is the main page, "${ordered[1].id}" (narrower) the inset`);
    }
    let g: LayoutGeometry;
    try {
      g = evalLayoutGeometry(spec, rc.params, { aspect: aspectOf(ordered[0]), aspect2: aspectOf(ordered[1] ?? ordered[0]) });
    } catch (err) {
      warnings.add(`${where}: layout ${rc.id}: ${(err as Error).message}`);
      return null;
    }
    const outside = geometryOutside(g, variant);
    if (outside.length > 0) warnings.add(`${where}: layout ${rc.id}: ${outside.join(', ')} leave${outside.length === 1 ? 's' : ''} the frame`);
    const radius = g.radius ?? (typeof rc.params.radius === 'number' ? rc.params.radius : 0);
    const s = (x: { x: number; y: number; w: number; h: number }) => ({ x: round(x.x * unit, 3), y: round(x.y * unit, 3), w: round(x.w * unit, 3), h: round(x.h * unit, 3) });
    const layout: PlanLayout = { capture: s(g.screen), card: s(g.screen), radius: round(radius * unit, 3) };
    if (g.caption) layout.caption = s(g.caption);
    if (g.brandmark) layout.brandmark = s(g.brandmark);
    const rects = isPip ? [g.screen, g.inset!] : g.panes!;
    if (!runKey.has(r.run)) runKey.set(r.run, runKeys++);
    const camRun = camByRun.get(r.run)!;
    const panes: PlanPane[] = [];
    ordered.forEach((pg, i) => {
      const src = css(pg);
      const rect = rects[i];
      if (!rect) return;
      const inset = isPip && i === 1;
      const paneLayout = planPaneLayout(rect, { variant, unit, cssWidth: src.cssWidth, cssHeight: src.cssHeight, radius: inset ? Math.min(radius, 22) : radius, top: !isPip });
      if (inset) {
        // The inset is drawn at its rect exactly (its aspect is the page's): the planner moves it between corners.
        paneLayout.capture = s(rect);
        paneLayout.card = s(rect);
        delete paneLayout.crop;
      }
      const pc = camRun.pages?.get(pg.id);
      let camera: CameraFrame[] | null = pc ? pc.track.slice(range.k0, range.k1) : null;
      const moves = pc ? pc.moves.filter((m) => m.scene === e.scene.id) : [];
      if (inset && moves.length > 0) {
        notes.add(`${where}: no zoom in the inset page "${pg.id}" (${moves.length} zoom${moves.length > 1 ? 's' : ''} ignored)`);
        camera = null;
      }
      const pane: PlanPane = { page: pg.id, track: pg.track, layout: paneLayout, camera, urls: [], zooms: [] };
      if (pg.label !== undefined) pane.label = pg.label;
      if (inset) pane.inset = true;
      if (!inset) {
        pane.zooms = moves.map((m): ZoomSpan => {
          const [vx, vy] = clampView(m.zoom, m.focus.x, m.focus.y, src.cssWidth, src.cssHeight);
          const z: ZoomSpan = { scene: m.scene, step: m.step, from: m.start - range.k0, in_frames: round(m.frames), out_at: round(Math.max(m.outAt, m.start + m.frames) - range.k0), out_frames: round(m.outFrames ?? m.frames), zoom: m.zoom, focus: m.focus, view: { x: round(vx, 2), y: round(vy, 2) } };
          if (m.requested !== m.zoom) z.requested_zoom = m.requested;
          if (m.source === 'theme') z.source = 'theme';
          return z;
        });
      }
      if (paneLayout.crop) {
        const key = `${runKey.get(r.run)}:${pg.id}`;
        let track = paneReframeByRun.get(key);
        if (!track) {
          const tl = timelineTracks.get(pg.track)!;
          const evsOf = (x: ClipEntry) => x.events.filter((ev) => ev.page === pg.id);
          const targets = r.entries.flatMap((x) => [...reframeTargets(evsOf(x), overlayKeepOf(x)), ...(tutorialOn ? tutorialReframeTargets(evsOf(x), (ev) => stateOf(x.scene, ev)) : [])]);
          const camTrack = pc?.track ?? cameraTrack([], r.run.src.length, src.cssWidth, src.cssHeight);
          // A scene where this page only rests (the other page acts) lets its view settle on the page's content.
          const settle = r.entries.slice(1).filter((x) => !x.events.some((ev) => ev.step >= 0 && ev.status !== 'skipped' && ev.page === pg.id)).map((x) => x.s0);
          track = reframeTrack({ times: r.run.p.map((p) => p / srcFps), camera: camTrack, cursor: tl.cursor, crop: paneLayout.crop, css: { w: src.cssWidth, h: src.cssHeight }, outFps, targets, settle });
          paneReframeByRun.set(key, track);
        }
        pane.reframe = track.slice(range.k0, range.k1);
      }
      panes.push(pane);
    });
    let inset: PlanInset | undefined;
    if (isPip && panes.length === 2) {
      const emphasis = rc.params.emphasis;
      const grow = emphasis === 'none' ? 1 : emphasis === 'grow' || t.style_bias !== 'real' ? INSET_GROW : 1;
      inset = { pane: 1, track: [{ at: 0, corner: cornerOf(panes[0].layout.capture, panes[1].layout.capture), rect: { ...panes[1].layout.capture } }], grow };
    }
    return { layout, panes, ...(inset ? { inset } : {}) };
  }
  const base = (id: string, durationInFrames: number, component: ResolvedComponent) => ({
    id,
    from: 0,
    durationInFrames,
    fadeIn: { frames: 0, color: 'none' as const },
    fadeOut: { frames: 0, color: 'none' as const },
    transitionIn: 'none' as const,
    component,
  });
  const segDuration = (
    rc: ResolvedComponent,
    explicit: number | undefined,
    themeDefault: number | undefined,
    fallback: number,
    where: string,
  ): number => {
    const m = resolver.manifest(rc)?.duration;
    let s = explicit ?? themeDefault ?? m?.default ?? fallback;
    if (m?.min !== undefined && s < m.min) {
      notes.add(`${where}: ${s} s raised to the ${rc.id} minimum ${m.min} s`);
      s = m.min;
    }
    if (m?.max !== undefined && s > m.max) {
      notes.add(`${where}: ${s} s lowered to the ${rc.id} maximum ${m.max} s`);
      s = m.max;
    }
    return s;
  };

  /** The natural length (s) of a use's file (L2.12): a video's part, a Lottie animation; undefined otherwise. */
  const fileLength = (rc: ResolvedComponent | null | undefined): number | undefined => {
    const m = rc?.media?.file;
    if (!m) return undefined;
    if (m.kind === 'lottie') return m.duration_s;
    if (m.kind !== 'video') return undefined;
    const from = typeof rc!.params.from === 'number' ? rc!.params.from : 0;
    const to = typeof rc!.params.to === 'number' ? rc!.params.to : m.duration_s;
    return Math.max(1 / outFps, Math.min(to, m.duration_s) - from);
  };
  /** The scenario's own file for a segment (`intro: {video: …}`), as a candidate of its chain (L2.12). */
  const fileCandidate = (spec: (MediaFileFields & { params?: Record<string, unknown> }) | undefined, label: string): Candidate[] => {
    const use = spec ? mediaSegmentUse(spec) : undefined;
    if (!use) return [];
    return [{ ref: { id: use.id, params: use.params }, slots: use.slots, source: 'scenario', label: `${label} file ${use.slots.file}` }];
  };
  /**
   * The box of a box-filling overlay (L2.12) in its page: `rect` as written; a target / cursor anchor: the file's own
   * size (its pixels / the page's device scale, × `scale`) centred on the step's target / the cursor; a position of the
   * screen: that size, placed by the composition; `screen`: the visible capture.
   */
  const overlayBox = (o: NonNullable<TimelineEvent['overlay']>, rc: ResolvedComponent, page: PlanSource, where: string): NonNullable<OverlayUse['box']> => {
    const b = o.box ?? {};
    if (b.rect) return { anchor: 'rect', rect: { ...b.rect } };
    const file = rc.media?.file;
    const natural = file && (file.kind === 'video' || file.kind === 'lottie' || file.kind === 'picture') && file.width && file.height ? { w: file.width, h: file.height } : undefined;
    const k = (b.scale ?? 1) / (file?.kind === 'lottie' ? 1 : page.scale || 1);
    const size = natural ? { w: round(natural.w * k, 2), h: round(natural.h * k, 2) } : { w: round(page.cssWidth * 0.25 * (b.scale ?? 1), 2), h: round(page.cssWidth * 0.25 * (b.scale ?? 1), 2) };
    if (!natural) notes.add(`${where}: the file's size is unknown: a box of a quarter of the page width`);
    let anchor = b.anchor ?? (o.bbox ? 'target' : 'center');
    let c: { x: number; y: number } | undefined;
    if (anchor === 'target') {
      c = o.bbox ? centre(o.bbox) : o.point;
      if (!o.bbox) notes.add(`${where}: no target recorded: ${o.point ? 'centred on the cursor' : 'centred on the screen'}`);
    } else if (anchor === 'cursor') {
      c = o.point ?? (o.bbox ? centre(o.bbox) : undefined);
      if (!o.point) notes.add(`${where}: no cursor position recorded: ${o.bbox ? 'centred on the target' : 'centred on the screen'}`);
    }
    if (anchor === 'target' || anchor === 'cursor') {
      if (!c) anchor = 'center';
      else return { anchor, rect: { x: round(c.x - size.w / 2, 2), y: round(c.y - size.h / 2, 2), w: size.w, h: size.h } };
    }
    return anchor === 'screen' ? { anchor } : { anchor, size };
  };

  /**
   * Seconds of a full-frame use: the scenario's `duration`, else what the winning candidate sets (a theme's file), else
   * the file's own length (a video part, a Lottie animation), else the kind's default (theme, component, fallback).
   */
  const useDuration = (rc: ResolvedComponent, explicit: number | undefined, themeDefault: number | undefined, fallback: number, where: string): number => {
    const own = explicit ?? resolver.candidateOf(rc)?.duration ?? fileLength(rc);
    const s = segDuration(rc, own, rc.media?.file ? (own === undefined ? themeDefault : undefined) : themeDefault, fallback, where);
    if (rc.media?.file) {
      const m = rc.media.file;
      const what = m.kind === 'video' ? `video ${secs(fileLength(rc) ?? m.duration_s)}${m.audio ? ', with sound' : ''}${m.alpha ? ', alpha' : ''}` : m.kind === 'lottie' ? `Lottie ${secs(m.duration_s)}` : 'image';
      notes.add(`${where}: your file ${m.name} (${what}) for ${secs(s)}`);
      if (rc.params.fit === 'auto' && (m.kind === 'video' || m.kind === 'picture') && m.width && m.height && autoFit(m, { w: width, h: height }) === 'contain') {
        notes.add(`${where}: ${m.name} (${m.width}×${m.height}) does not have the shape of the ${width}×${height} video: shown whole on the background (fit: contain; write fit: cover to fill the frame, cropped)`);
      }
    }
    return s;
  };

  /**
   * The step overlay of `ev` in clip `entry`, resolved once — the reframe of a vertical / square clip asks for it before
   * the clip's overlays are drawn: its component, when it starts (capture s: `at`, or when its notification showed),
   * how long it shows (output s; undefined: a looped file, to the clip's end) and the box of its page the reframe keeps
   * in view (a `rect`, a file's box on the target / the cursor, what a callout points at; nothing for a file placed on
   * the screen — it follows the view).
   */
  type StepOverlay = { rc: ResolvedComponent; where: string; tAt: number; seconds?: number; keep?: { x: number; y: number; w: number; h: number } };
  const stepOverlays = new Map<TimelineEvent, StepOverlay | null>();
  const stepOverlayOf = (entry: ClipEntry, ev: TimelineEvent): StepOverlay | null => {
    const known = stepOverlays.get(ev);
    if (known !== undefined) return known;
    const o = ev.overlay;
    let out: StepOverlay | null = null;
    if (o && ev.step >= 0) {
      const where = `scene "${entry.scene.id}" step ${ev.step} overlay`;
      // Your own file (L2.12) stays yours: a kind-wide override restyles the provided overlays, not the files.
      const userFile = o.component === MEDIA_COMPONENTS.media || o.component === MEDIA_COMPONENTS.lottie;
      const kindWide = kindOverride('overlay');
      if (userFile && kindWide.length > 0) notes.add(`${where}: your file is kept (overrides.components.overlay replaces the provided overlays, not your own files)`);
      const chain: Candidate[] = [...(userFile ? [] : kindWide), { ref: { id: o.component, params: o.params }, source: 'scenario', label: 'the step overlay' }, ...themeAndBuiltin('overlay')];
      const rc = resolver.resolve('overlay', chain, where, { explicit: o.slots, ctx: { ...slotBase, scene: { caption: entry.scene.caption } } });
      if (rc) {
        // When it starts (L2.12 `at`): the end of the step (default), its start, its click, a mark, or seconds after it starts.
        const start = overlayStartAt(ev, timeline.markers, entry);
        if (start.fallback === 'no-click') notes.add(`${where}: the step recorded no click: it starts at the end of the step`);
        else if (start.fallback === 'no-mark') warnings.add(`${where}: ${String(o.at)} is not a mark of run ${timeline.run_id}: it starts at the end of the step`);
        else if (start.fallback === 'outside-clip') warnings.add(`${where}: ${String(o.at)} (${secs(start.markT!)}) is outside the clip of "${entry.scene.id}": it starts at the end of the step`);
        let tAt = start.t;
        // A notification overlay shows when the notification showed (when that moment is inside this clip).
        const nName = Object.entries(o.slots).find(([k]) => resolver.manifest(rc)?.slots[k]?.type === 'notification')?.[1];
        const shown = nName ? findArtefact('notification', nName) : undefined;
        if (shown && shown.t >= entry.s0 && shown.t < entry.s1) {
          tAt = shown.t;
          notes.add(`${where}: starts when notification "${shown.name}" showed (${secs(shown.t)} of the capture)`);
        }
        const len = fileLength(rc);
        const looped = rc.params.loop === true && len !== undefined;
        const seconds = o.duration ?? (looped ? undefined : (len ?? resolver.manifest(rc)?.duration?.default ?? 2.5));
        out = { rc, where, tAt, ...(seconds !== undefined ? { seconds } : {}) };
        if (o.box || rc.id === MEDIA_COMPONENTS.media || rc.id === MEDIA_COMPONENTS.lottie) {
          const pg = entry.pages?.find((x) => x.id === ev.page);
          const rect = overlayBox(o, rc, pg && trackSources[pg.track] ? trackSources[pg.track] : mainSource, where).rect;
          if (rect) out.keep = { ...rect };
        } else if (o.bbox) out.keep = { ...o.bbox };
      }
    }
    stepOverlays.set(ev, out);
    return out;
  };
  /** See the per-clip pass "Your own file placed at a position of the screen". */
  const placeScreenOverlay = (entry: ClipEntry, seg: ClipSegment, use: OverlayUse, rel: (t: number) => number): void => {
    const b = use.box;
    if (!b || b.rect || !b.size || b.anchor === 'screen' || b.anchor === 'rect') return;
    const asked: OverlayAnchor = b.anchor;
    const choices = SCREEN_POSITION_CHOICES[asked];
    if (!choices) return;
    const end = use.from + use.durationInFrames;
    const page = use.pane !== undefined ? seg.panes?.[use.pane]?.page : undefined;
    const clear: Array<{ from: number; to: number; bbox: { x: number; y: number; w: number; h: number }; what: string }> = [];
    for (const ev of entry.events) {
      if (ev.step < 0 || ev.status === 'skipped' || (page !== undefined && ev.page !== page)) continue;
      const a = ev.step === use.step ? rel(ev.t_start) : rel(ev.t_start - CLEAR_LOOKAHEAD_S);
      const z = rel(stepEnd(ev)) + 1;
      if (z <= use.from || a >= end) continue;
      const what = `the ${ev.action} target of step ${ev.step}${ev.target?.desc ? ` (${ev.target.desc})` : ''}`;
      for (const box of stepBoxes(ev)) clear.push({ from: Math.max(0, a - use.from), to: Math.min(use.durationInFrames, z - use.from), bbox: { ...box }, what });
    }
    if (clear.length === 0) return;
    // Every 0.1 s of the overlay and its last frame.
    const every = Math.max(1, Math.round(0.1 * outFps));
    const samples: number[] = [];
    for (let local = 0; local < use.durationInFrames; local += every) samples.push(local);
    if (samples[samples.length - 1] !== use.durationInFrames - 1) samples.push(use.durationInFrames - 1);
    const boxAt = (anchor: OverlayAnchor, local: number) => overlayBoxAt(planShape, seg, { ...use, box: { ...b, anchor } }, use.from + local)!;
    const covered = (anchor: OverlayAnchor): string | undefined => {
      for (const local of samples) {
        const box = boxAt(anchor, local);
        for (const c of clear) {
          if (local < c.from || local >= c.to) continue;
          const t = mapUseRect(planShape, seg, use, use.from + local, c.bbox);
          const ox = Math.min(box.x + box.w, t.x + t.w) - Math.max(box.x, t.x);
          const oy = Math.min(box.y + box.h, t.y + t.h) - Math.max(box.y, t.y);
          if (ox > 0 && oy > 0) return c.what;
        }
      }
      return undefined;
    };
    const hit = covered(asked);
    if (!hit) return;
    // The other positions of the same kind, nearest first (at the overlay's first frame).
    const c0 = boxAt(asked, 0);
    const dist = (a: OverlayAnchor) => {
      const x = boxAt(a, 0);
      return Math.hypot(x.x - c0.x, x.y - c0.y);
    };
    const others = choices.filter((a) => a !== asked).sort((x, y) => dist(x) - dist(y));
    const where = `scene "${entry.scene.id}" step ${use.step} overlay`;
    const free = others.find((a) => !covered(a));
    if (free) {
      b.anchor = free;
      notes.add(`${where}: at ${asked} it would cover ${hit} in this ${variant} framing: placed at ${free}`);
    } else notes.add(`${where}: at ${asked} it covers ${hit} in this ${variant} framing (no free ${others.length === 3 ? 'corner' : 'position'}): kept there`);
  };
  /** The reframe's keep of a step overlay of clip `entry`: its box over the capture time it shows (stepOverlayOf). */
  const overlayKeepOf =
    (entry: ClipEntry) =>
    (ev: TimelineEvent): OverlayKeep | null => {
      const so = stepOverlayOf(entry, ev);
      const r = runOf.get(entry);
      if (!so?.keep || !r) return null;
      const range = r.run.clipRanges[r.index];
      const q0 = Math.max(range.k0, outFrameAt(r.run, so.tAt));
      if (q0 >= range.k1) return null;
      const q1 = so.seconds === undefined ? range.k1 - 1 : Math.min(range.k1 - 1, q0 + fr(so.seconds));
      return { t0: round(r.run.p[q0] / srcFps, 4), t1: round(r.run.p[q1] / srcFps, 4), box: so.keep };
    };

  // Intro
  const introOn = ov.intro ?? video.intro !== false;
  if (ov.intro === true && video.intro === false) notes.add('intro forced on (overrides.intro) although the scenario disables it');
  if (ov.intro === false) notes.add('intro disabled (overrides.intro = false)');
  if (introOn) {
    const spec = video.intro === false ? undefined : video.intro;
    const chain: Candidate[] = [...kindOverride('intro'), ...fileCandidate(spec, 'the scenario intro')];
    if (spec?.component) chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario intro' });
    chain.push(...themeAndBuiltin('intro'));
    const rc = resolver.resolve('intro', chain, 'intro', { named: { title: video.title?.text, kicker: video.title?.kicker }, ctx: slotBase });
    if (rc) {
      const frames = fr(useDuration(rc, spec?.duration, t.intro.duration, 3.2, 'intro'));
      drafts.push({ seg: { ...base('intro', frames, rc), kind: 'intro' } as IntroSegment, content: frames });
    } else notes.add('no intro: the theme has none');
  } else if (video.intro === false && ov.intro === undefined) notes.add('no intro (scenario intro: false)');

  // Scenes, cards, interstitials
  const captionsOn = ov.captions !== false;
  if (!captionsOn) notes.add('captions disabled (overrides.captions = false)');
  for (const e of entries) {
    const id = e.scene.id;
    if (e.type === 'card') {
      const spec = e.scene.card ?? {};
      const file = fileCandidate(spec, 'the scenario card');
      const chain: Candidate[] = [...segmentOverride(id, 'card'), ...kindOverride('card'), ...file];
      if (spec.component) chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario card' });
      chain.push(...themeAndBuiltin('card'));
      const rc = resolver.resolve('card', chain, `card "${id}"`, { explicit: file.length > 0 ? undefined : spec.slots, ctx: slotBase });
      if (!rc) {
        warnings.add(`card "${id}": the theme has no card component and the scenario names none: left out`);
        continue;
      }
      const frames = fr(useDuration(rc, spec.duration, undefined, 2.5, `card "${id}"`));
      drafts.push({ seg: { ...base(id, frames, rc), kind: 'card' } as CardSegment, content: frames });
      continue;
    }
    if (e.type === 'interstitial') {
      const spec = e.scene.interstitial ?? { text: '' };
      const chain: Candidate[] = [...segmentOverride(id, 'interstitial'), ...kindOverride('interstitial'), ...fileCandidate(spec, 'the scenario interstitial')];
      if (spec.component) {
        chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario interstitial' });
        if (spec.style) warnings.add(`interstitial "${id}": style "${spec.style}" ignored (component ${spec.component} is set)`);
      } else if (spec.style) {
        const legacy = spec.style === 'dark-clock' ? { id: 'studio/interstitial-clock', params: {} } : { id: 'studio/interstitial-plain', params: { tone: spec.style } };
        chain.push({ ref: legacy, source: 'scenario', label: `the scenario interstitial style "${spec.style}"` });
      }
      chain.push(...themeAndBuiltin('interstitial'));
      const ctx: SlotContext = { ...slotBase, interstitial: { text: spec.text ?? '', kicker: spec.kicker } };
      const rc = resolver.resolve('interstitial', chain, `interstitial "${id}"`, { named: { text: spec.text, kicker: spec.kicker }, ctx });
      if (!rc) {
        warnings.add(`interstitial "${id}": the theme has no interstitial component and the scenario names none: left out`);
        continue;
      }
      const frames = fr(useDuration(rc, spec.duration, t.interstitial.duration, 2.6, `interstitial "${id}"`));
      drafts.push({ seg: { ...base(id, frames, rc), kind: 'interstitial' } as CardSegment, content: frames });
      continue;
    }
    // Clip
    const r = runOf.get(e)!;
    const range = r.run.clipRanges[r.index];
    const content = range.k1 - range.k0;
    if (content <= 0) {
      warnings.add(`scene "${id}": every frame was trimmed away: left out`);
      continue;
    }
    const where = `scene "${id}"`;
    const frameSpec: FrameSpec = ov.frame ?? e.scene.frame ?? videoFrame;
    let layoutRc =
      e.scene.frame === undefined && ov.components?.[id] === undefined
        ? mainLayoutComponent
        : resolver.resolve('layout', layoutChain(e.scene.frame, id), where);
    // L2.11: a multi-page scene needs a layout that shows several pages, a single-page scene one that shows one.
    const multiPane = (rc: ResolvedComponent | null | undefined) => {
      const m = resolver.manifest(rc);
      return isMultiPaneGeometry(m?.[GEOMETRY_KEYS[variant]] ?? m?.geometry);
    };
    const pageCss = (pg: TimelineScenePage) => trackSources[pg.track] ?? { cssWidth: cssW, cssHeight: cssH };
    if (e.pages && !multiPane(layoutRc)) {
      const aspects = e.pages.map((pg) => pageCss(pg).cssWidth / pageCss(pg).cssHeight);
      const kind = aspects.some((a) => a < 0.9) && aspects.some((a) => a >= 1.2) ? 'pip' : 'split';
      const auto = resolver.resolve('layout', [resolver.multiPageCandidate(kind, 'builtin-default', 'the multi-page default')], where);
      if (auto) {
        notes.add(`${where} films ${e.pages.length} pages: ${auto.id}${layoutRc ? ` (${layoutRc.id} shows one page)` : ''}`);
        layoutRc = auto;
      }
    } else if (!e.pages && multiPane(layoutRc)) {
      const single = resolver.resolve('layout', [resolver.themeCandidate('layout'), resolver.builtinCandidate('layout')].filter((c) => c.ref !== null), where);
      const msg = `${where} films one page: ${layoutRc!.id} shows several, ${single?.id ?? 'the built-in layout'} used`;
      if (e.scene.frame !== undefined) warnings.add(msg);
      else notes.add(msg);
      layoutRc = single;
    }
    const layoutComponent = layoutRc ?? resolver.resolve('layout', [resolver.builtinCandidate('layout')], where)!;
    let layout = layoutRc === mainLayoutComponent && !multiPane(layoutRc) ? mainLayout : layoutOf(layoutComponent, frameSpec, where);
    const captionRc = captionsOn
      ? resolver.resolve('caption', [...kindOverride('caption'), ...themeAndBuiltin('caption')], where, {
          ctx: { ...slotBase, scene: { caption: e.scene.caption } },
        })
      : null;
    const cam = camByRun.get(r.run)!;
    const camera = cam.track.slice(range.k0, range.k1);
    const seg: ClipSegment = {
      ...base(id, content, layoutComponent),
      kind: 'clip',
      scene: id,
      frame: frameSpec,
      srcFrames: r.run.src.slice(range.k0, range.k1),
      camera,
      urls: [],
      caption: captionRc,
      overlays: [],
      steps: [],
      cues: [],
      layout,
      src: { from_s: round(e.A / srcFps), to_s: round(e.B / srcFps) },
      speeds: [],
      trims: [],
      zooms: [],
      heldFrames: 0,
    };
    let reframe: Array<[number, number]> | undefined;
    if (e.pages) {
      const mp = planPanes(e, layoutComponent, where, r, range);
      if (mp) {
        layout = mp.layout;
        seg.layout = layout;
        seg.panes = mp.panes;
        if (mp.inset) seg.inset = mp.inset;
        // A caption band drawn over the screen would straddle both pages of a split (and hide what they act on):
        // it goes to the layout's caption area, below the pages. A picture in picture keeps it over its main page.
        if (!mp.inset && captionRc && captionRc.params.position === 'over') {
          seg.caption = { ...captionRc, params: { ...captionRc.params, position: 'area' } };
          notes.add(`${where}: the caption band goes below the pages (over the screen it would straddle both)`);
        }
      }
    } else if (variant !== 'landscape' && layout.crop) {
      let track = reframeByRun.get(r.run);
      if (!track) {
        const targets = r.entries.flatMap((x) => [...reframeTargets(x.events, overlayKeepOf(x)), ...(tutorialOn ? tutorialReframeTargets(x.events, (ev) => stateOf(x.scene, ev)) : [])]);
        track = reframeTrack({ times: r.run.p.map((p) => p / srcFps), camera: cam.track, cursor: timeline.cursor, crop: layout.crop, css: { w: cssW, h: cssH }, outFps, targets });
        reframeByRun.set(r.run, track);
      }
      reframe = track.slice(range.k0, range.k1);
      seg.reframe = reframe;
    }
    drafts.push({ seg, content, clip: { entry: e, run: r.run, index: r.index, k0: range.k0, k1: range.k1, camera, reframe, moves: cam.moves.filter((m) => m.scene === id) } });
  }

  // Outro
  const outroOn = ov.outro ?? video.outro !== false;
  if (ov.outro === true && video.outro === false) notes.add('outro forced on (overrides.outro) although the scenario disables it');
  if (ov.outro === false) notes.add('outro disabled (overrides.outro = false)');
  if (outroOn) {
    const chain: Candidate[] = [...kindOverride('outro'), ...fileCandidate(outro, 'the scenario outro')];
    if (outro?.component) chain.push({ ref: { id: outro.component, params: outro.params }, source: 'scenario', label: 'the scenario outro' });
    chain.push(...themeAndBuiltin('outro'));
    const rc = resolver.resolve('outro', chain, 'outro', {
      named: { tagline: outro?.tagline ?? t.outro.tagline, url: outro?.url ?? t.outro.url },
      ctx: slotBase,
    });
    if (rc) {
      const frames = fr(useDuration(rc, outro?.duration, t.outro.duration, 3, 'outro'));
      drafts.push({ seg: { ...base('outro', frames, rc), kind: 'outro' } as OutroSegment, content: frames });
    } else notes.add('no outro: the theme has none');
  } else if (video.outro === false && ov.outro === undefined) notes.add('no outro (scenario outro: false)');

  // ── Transitions and timing of the segments ────────────────────────────────────
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
  const durationInFrames = drafts.reduce((m, d) => Math.max(m, d.seg.from + d.seg.durationInFrames), 0);

  // ── Per-clip details: captions, overlays, provenance, speeds, trims, zooms, urls, timemap ──
  const captions: CaptionCue[] = [];
  const markers: EditPlan['markers'] = [];
  const timemap: TimeMapEntry[] = [];
  drafts.forEach((d, i) => {
    if (d.seg.kind === 'interstitial') {
      const prev = drafts[i - 1];
      if (prev?.seg.kind === 'clip') (d.seg as CardSegment).backdropSrcFrame = prev.seg.srcFrames[prev.seg.srcFrames.length - 1];
      else notes.add(`interstitial "${d.seg.id}": no clip before it, drawn without a backdrop frame`);
    }
    if (!d.clip || d.seg.kind !== 'clip') return;
    const seg = d.seg;
    const { entry, run, k0, k1 } = d.clip;
    const n = d.content;
    const F = seg.from;
    const next = drafts[i + 1];
    const cueEnd = Math.min(F + seg.durationInFrames, next ? next.seg.from : F + seg.durationInFrames);
    const rel = (tSec: number) => clamp(outFrameAt(run, tSec) - k0, 0, n);

    // Captions: the scene caption from the first visible frame; step captions replace it from their output start.
    if (seg.caption) {
      const cues: CaptionCue[] = [];
      if (entry.scene.caption) cues.push({ from: F, to: cueEnd, ...captionText(entry.scene.caption), scene: entry.scene.id });
      for (const ev of entry.events) {
        if (ev.step < 0 || !ev.caption) continue;
        const start = Math.min(F + rel(ev.t_start), cueEnd);
        const last = cues[cues.length - 1];
        if (last && start <= last.from) cues.pop();
        else if (last) last.to = start;
        cues.push({ from: start, to: cueEnd, ...captionText(ev.caption), scene: entry.scene.id });
      }
      const kept = cues.filter((c) => c.to > c.from);
      captions.push(...kept);
      seg.cues = kept.map((c, j) => ({ ...c, from: c.from - F, to: j === kept.length - 1 ? seg.durationInFrames : c.to - F }));
    }

    // Overlays from step `overlay` modifiers (resolved by stepOverlayOf: the reframe already asked for them), shown from
    // their start (`at`; default: the step's output end).
    for (const ev of entry.events) {
      if (!ev.overlay || ev.step < 0) continue;
      const o = ev.overlay;
      const so = stepOverlayOf(entry, ev);
      if (!so) continue;
      const { rc, where } = so;
      const from = rel(so.tAt);
      if (from >= n) {
        warnings.add(`${where}: the step ends after the clip: overlay left out`);
        continue;
      }
      // A file plays for its own length (a looped one: to the clip's end, at most 30 s) unless the step says how long.
      const seconds = so.seconds ?? Math.min(30, (seg.durationInFrames - from) / outFps);
      let frames = fr(seconds);
      let componentFrames: number | undefined;
      if (from + frames > seg.durationInFrames) {
        componentFrames = frames;
        frames = seg.durationInFrames - from;
        notes.add(`${where}: shortened to ${secs(frames / outFps)} (the clip ends): it stays on screen to the clip's last frame`);
      }
      const use: OverlayUse = { component: rc, from, durationInFrames: frames, scene: entry.scene.id, step: ev.step };
      if (componentFrames !== undefined) use.componentFrames = componentFrames;
      if (o.bbox) use.anchor = { bbox: { ...o.bbox } };
      else if (o.point) use.anchor = { point: { ...o.point } };
      else notes.add(`${where}: no anchor recorded — the overlay places itself`);
      // Multi-page clip: the overlay belongs to the page the step acted on.
      const pi = paneIndexOf(seg, ev.page);
      if (pi >= 0) use.pane = pi;
      // A box-filling overlay (L2.12): a user file — or any overlay given anchor / rect / scale.
      const isFile = rc.id === MEDIA_COMPONENTS.media || rc.id === MEDIA_COMPONENTS.lottie;
      if (o.box || isFile) {
        const page = pi >= 0 && seg.panes ? paneSource(planShape, seg.panes[pi]) : mainSource;
        use.box = overlayBox(o, rc, page, where);
        use.layer = 'screen';
      }
      seg.overlays.push(use);
    }

    // Tutorial overlays (L2.10): the spotlight is drawn over the capture, under everything else; badges, loupe and key
    // caps under the scenario's own step overlays.
    if (tutorialOn) {
      // A multi-page clip plans each page's overlays on its own page (its events, its size) — in that page's pane.
      const groups = seg.panes
        ? seg.panes.map((p, i) => ({ pane: i, events: entry.events.filter((ev) => ev.step < 0 || ev.page === p.page), css: { w: paneSource(planShape, p).cssWidth, h: paneSource(planShape, p).cssHeight } }))
        : [{ pane: -1, events: entry.events, css: { w: cssW, h: cssH } }];
      // Badges are numbered once over the whole clip, in time order (steps may go back and forth between pages).
      const badgeNumbers = planBadgeNumbers(entry.events, (ev) => stateOf(entry.scene, ev), videoBadges);
      const uses = groups.flatMap((gr) => {
        const list = planClipTutorial({
          scene: entry.scene,
          events: gr.events,
          rel,
          n,
          duration: seg.durationInFrames,
          fps: outFps,
          css: gr.css,
          stateOf: (ev) => stateOf(entry.scene, ev),
          resolve: tutorialResolve,
          counter: videoBadges,
          badgeNumbers,
          durationOf: (rc) => resolver.manifest(rc)?.duration?.default,
          out: tutorial,
          segmentFrom: F,
        });
        if (gr.pane >= 0) for (const u of list) u.pane = gr.pane;
        return list;
      });
      seg.overlays = [...uses.filter((u) => u.layer === 'screen'), ...uses.filter((u) => u.layer !== 'screen'), ...seg.overlays];
    }

    // Overlays keep clear of what the viewer is about to look at (L2.11 polish): the targets of the step they belong to
    // and of the next click step(s) — key caps take the other row, a lens or a badge another side.
    const clipSteps = entry.events.filter((ev) => ev.step >= 0 && ev.status !== 'skipped');
    for (const use of seg.overlays) {
      if (!use.tutorial || use.tutorial === 'spotlight') continue;
      const page = use.pane !== undefined ? seg.panes?.[use.pane]?.page : undefined;
      // An inset page's key caps or lens are drawn over the main page: its targets count too (mapped through its pane).
      const over = use.pane !== undefined && seg.inset?.pane === use.pane && !staysInInset(use) ? 0 : undefined;
      const end = use.from + use.durationInFrames;
      const clear: NonNullable<OverlayUse['clear']> = [];
      for (const ev of clipSteps) {
        const other = page !== undefined && ev.page !== page;
        if (other && (over === undefined || ev.page !== seg.panes![over].page)) continue;
        const a = rel(ev.t_start - CLEAR_LOOKAHEAD_S);
        const b = rel(stepEnd(ev)) + 1;
        if (b <= use.from || a >= end) continue;
        for (const box of stepBoxes(ev)) clear.push({ from: Math.max(0, a - use.from), to: Math.min(use.durationInFrames, b - use.from), bbox: { ...box }, ...(other ? { pane: over } : {}) });
      }
      if (clear.length > 0) use.clear = clear;
    }

    // Provenance: which step produced each output frame (held frames belong to the last step).
    const steps: StepSpan[] = [];
    const evs = entry.events;
    seg.srcFrames.forEach((f, k) => {
      let ev = evs[0];
      for (const x of evs) if (x.t_start * srcFps <= f + 1e-6) ev = x;
      const last = steps[steps.length - 1];
      if (ev && last && last.step === ev.step && last.action === ev.action) last.to = k + 1;
      else if (ev) steps.push({ scene: entry.scene.id, step: ev.step, ...(ev.id ? { step_id: ev.id } : {}), action: ev.action, from: k, to: k + 1 });
    });
    seg.steps = steps;

    // URLs (browser chrome) along the clip: of the main capture, or of each page's track.
    if (seg.panes) {
      for (const pane of seg.panes) {
        const tr = timelineTracks.get(pane.track);
        const scenePage = entry.pages?.find((p) => p.id === pane.page);
        seg.srcFrames.forEach((f, k) => {
          const url = (tr ? trackUrlAt(tr, f / srcFps) : undefined) ?? scenePage?.url;
          if (url && pane.urls[pane.urls.length - 1]?.url !== url) pane.urls.push({ frame: k, url });
        });
      }
    } else {
      seg.srcFrames.forEach((f, k) => {
        const url = pageAt(timeline, f / srcFps)?.url ?? entry.scene.url;
        if (url && seg.urls[seg.urls.length - 1]?.url !== url) seg.urls.push({ frame: k, url });
      });
    }

    // Multi-page clips (L2.11): the acting page over time, and where a picture-in-picture inset sits.
    if (seg.panes) {
      const paneOf = (page: string | undefined) => paneIndexOf(seg, page);
      const stepsOn = entry.events.filter((ev) => ev.step >= 0 && ev.status !== 'skipped');
      const still = entry.events.find((ev) => ev.action === 'scene_still');
      // A clip joined to the previous one (same pages, no cut) continues its acting page and its inset corner.
      const prevSeg = drafts[i - 1]?.seg;
      const continued = entry.joined && prevSeg?.kind === 'clip' && prevSeg.panes?.map((p) => p.page).join('|') === seg.panes.map((p) => p.page).join('|') ? prevSeg : undefined;
      const prevActing = continued?.acting?.[continued.acting.length - 1]?.pane;
      // The page of the opening still (= of the first step) acts from the clip's start, a joined clip included.
      const opening = paneOf(still?.page ?? stepsOn[0]?.page);
      const first = opening >= 0 ? opening : (prevActing ?? 0);
      seg.acting = planActing(stepsOn, paneOf, rel, outFps, first, prevActing);
      if (seg.inset) {
        const main = seg.panes[0];
        const insetPane = seg.panes[seg.inset.pane];
        const corners = insetCornerRects(main.layout.capture, insetPane.layout.capture);
        const band = captionBandOver(planShape, seg);
        const planned = planInsetTrack({
          steps: stepsOn,
          mainPage: main.page,
          insetPage: insetPane.page,
          rel,
          n,
          fps: outFps,
          mapMain: (f, box) => mapPaneRect(planShape, seg, 0, f, box),
          corners,
          preferred: seg.inset.track[0].corner,
          grow: seg.inset.grow,
          ...(band ? { avoid: [band] } : {}),
          clearance: 14 * unit,
          ...(continued?.inset ? { initial: continued.inset.track[continued.inset.track.length - 1].corner } : {}),
        });
        seg.inset.track = planned.track;
        if (band && seg.inset.grow > 1) {
          let g = growClearOf(planned.track, seg.inset.grow, [band], 8 * unit);
          if (g - 1 < 0.04) g = 1; // a growth that would not read
          if (g < seg.inset.grow) {
            notes.add(`scene "${entry.scene.id}": the inset ${g === 1 ? 'does not grow' : `grows ×${g} (not ×${seg.inset.grow})`} while its page acts: it keeps clear of the caption band`);
            seg.inset.grow = g;
          }
        }
        if (planned.reasons?.length) {
          seg.inset.reasons = planned.reasons;
          notes.add(`scene "${entry.scene.id}": inset ${planned.reasons.join('; ')}`);
        }
      }
    }

    // Your own file placed at a position of the screen (L2.12: a corner, a side) keeps clear of what the viewer looks
    // at — the boxes of its step and of the steps that come while it shows, around the cursor (stepBoxes) — in the
    // framing of THIS variant (a vertical crop puts a corner over a list that a landscape frame leaves free): the
    // nearest free position of the same kind, else where it was asked, with a note naming what it covers.
    for (const use of seg.overlays) placeScreenOverlay(entry, seg, use, rel);

    // Speeds, trims, zooms, time map.
    const r = srcFps / outFps;
    const speeds: SpeedSpan[] = [];
    for (const m of run.pieces) {
      if (m.clip !== d.clip.index || m.cut || m.q1 - m.q0 < 1e-9) continue;
      const from = round(clamp(m.q0 - k0, 0, n));
      const to = round(clamp(m.q1 - k0, 0, n));
      if (to <= from) continue;
      const span: SpeedSpan = { from, to, speed: round(m.u / r, 4), to_speed: round(m.w / r, 4) };
      if (m.protected) span.protected = true;
      const last = speeds[speeds.length - 1];
      if (last && !m.ramp && last.speed === last.to_speed && last.speed === span.speed && span.speed === span.to_speed && !!last.protected === !!span.protected) last.to = to;
      else speeds.push(span);
      timemap.push({
        out_from: round(F + clamp(m.q0 - k0, 0, n)),
        out_to: round(F + clamp(m.q1 - k0, 0, n)),
        src_from_s: round(m.p0 / srcFps, 4),
        src_to_s: round(m.p1 / srcFps, 4),
        scene: entry.scene.id,
      });
    }
    if (seg.heldFrames > 0) {
      speeds.push({ from: n, to: n + seg.heldFrames, speed: 0, to_speed: 0 });
      const lastSrc = round(seg.srcFrames[seg.srcFrames.length - 1] / srcFps, 4);
      timemap.push({ out_from: F + n, out_to: F + n + seg.heldFrames, src_from_s: lastSrc, src_to_s: lastSrc, scene: entry.scene.id });
    }
    seg.speeds = speeds;
    seg.trims = run.cuts
      .filter((c) => c.clip === d.clip!.index)
      .map((c): TrimSpan => ({ at: c.at - k0, src_from_s: round(c.a / srcFps), src_to_s: round(c.b / srcFps) }));
    seg.zooms = d.clip.moves.map((m): ZoomSpan => {
      const [vx, vy] = clampView(m.zoom, m.focus.x, m.focus.y, cssW, cssH);
      const z: ZoomSpan = {
        scene: m.scene,
        step: m.step,
        from: m.start - k0,
        in_frames: round(m.frames),
        out_at: round(Math.max(m.outAt, m.start + m.frames) - k0),
        out_frames: round(m.outFrames ?? m.frames),
        zoom: m.zoom,
        focus: m.focus,
        view: { x: round(vx, 2), y: round(vy, 2) },
      };
      if (m.requested !== m.zoom) z.requested_zoom = m.requested;
      if (m.source === 'theme') z.source = 'theme';
      return z;
    });
    if (seg.camera && isStatic(seg.camera)) seg.camera = null;
    if (seg.panes) {
      seg.zooms = seg.panes.flatMap((p) => p.zooms);
      for (const p of seg.panes) if (p.camera && isStatic(p.camera)) p.camera = null;
    }

    for (const mk of timeline.markers) {
      if (mk.scene !== entry.scene.id) continue;
      const k = outFrameAt(run, mk.t);
      if (k < k0 || k >= k1) continue;
      // `done`: the screen once the marked step is done (a marked wait's awaited state), inside this clip.
      const kd = clamp(outFrameAt(run, markDoneAt(timeline, mk)), k, k1 - 1);
      markers.push({ name: mk.name, frame: F + (k - k0), scene: mk.scene, done: F + (kd - k0) });
    }
  });

  // ── Tap targets of transitions (L2.9): the outgoing segment's (or its last overlay's) manifest anchor ──────────
  const anchorKey = ANCHOR_KEYS[variant];
  const anchorOf = (rc: ResolvedComponent, where: string, layout?: PlanLayout): EditPlan['layout']['capture'] | undefined => {
    const m = resolver.manifest(rc);
    // A variant without its own anchor uses the landscape one (expressions over frame_w / frame_h follow the format).
    const spec = (m?.[anchorKey] ?? m?.anchor) as AnchorSpec | undefined;
    if (!m || !spec) return undefined;
    const c = layout?.capture;
    try {
      const r = evalAnchor(spec, rc.params, {
        enums: paramEnums(m.params),
        frame: { w: design.width, h: design.height },
        ...(c ? { screen: { x: c.x / unit, y: c.y / unit, w: c.w / unit, h: c.h / unit } } : {}),
        aspect: cssW / cssH,
      });
      return { x: round(r.x * unit, 2), y: round(r.y * unit, 2), w: round(r.w * unit, 2), h: round(r.h * unit, 2) };
    } catch (e) {
      warnings.add(`${where}: the ${anchorKey} of ${rc.id} cannot be evaluated: ${(e as Error).message}`);
      return undefined;
    }
  };
  drafts.forEach((d, i) => {
    const tr = d.seg.transition;
    const prev = drafts[i - 1];
    if (!tr?.component || !prev) return;
    let anchor: EditPlan['layout']['capture'] | undefined;
    if (prev.seg.kind === 'clip') {
      const end = prev.content;
      const showing = prev.seg.overlays.filter((o) => o.from + o.durationInFrames >= end - ANCHOR_OVERLAY_WINDOW_S * outFps && o.from < end);
      for (let k = showing.length - 1; k >= 0 && !anchor; k--) anchor = anchorOf(showing[k].component, `overlay of "${prev.seg.id}"`, prev.seg.layout);
    }
    anchor ??= anchorOf(prev.seg.component, `"${prev.seg.id}"`);
    if (anchor) tr.anchor = anchor;
  });

  const segments = drafts.map((d) => d.seg);
  // The chapter progress bar (a scenario-level switch).
  const progressState = applyTutorial(applyTutorial(tutorialOff(), video.tutorial, 'scenario'), ov.tutorial === false ? false : ov.tutorial, 'scenario').progress;
  if (progressState.on) {
    const p = planProgress({ segments, timeline, state: progressState, resolve: tutorialResolve });
    if (p) {
      tutorial.progress = p;
      tutorial.uses.progress = 1;
      notes.add(`progress bar: ${p.chapters.length} chapters (${p.mode}) over ${secs(p.durationInFrames / outFps)}`);
    }
  }
  const tutorialUsed = Object.keys(tutorial.uses).length > 0 || tutorial.skipped.length > 0;
  if (tutorialUsed) {
    const parts = Object.entries(tutorial.uses).map(([k, v]) => `${k} ${v}`);
    if (parts.length) notes.add(`tutorial overlays: ${parts.join(', ')}`);
    for (const sk of tutorial.skipped) warnings.add(`scene "${sk.scene}" step ${sk.step}: no ${sk.feature} — ${sk.reason}`);
  }
  const totalSeconds = durationInFrames / outFps;
  notes.add(`${segments.length} segments, ${secs(totalSeconds)} at ${outFps} fps`);

  // ── Brand, music ──────────────────────────────────────────────────────────────
  const brand: PlanBrand = {
    tokens,
    colors: structuredClone(t.colors),
    background: structuredClone(t.background),
    captions: structuredClone(t.captions),
    intro: structuredClone(t.intro),
    outro: structuredClone(t.outro),
    interstitial: structuredClone(t.interstitial),
    brandmark: structuredClone(t.brandmark ?? { position: 'bottom-right' }),
    frame: structuredClone(t.frame),
    style_bias: t.style_bias,
    fonts: {
      display: { family: tokens.fonts.display, url: displayUrl },
      body: bodyUrls.map((url, i) => ({ family: tokens.fonts.body, url, weight: fontFileFace(template.assets.body[i]).weight })),
    },
    logo: { url: logoUrl },
  };
  if (wordmarkUrl) brand.wordmark = { url: wordmarkUrl };

  let music: PlanMusic | undefined;
  if (ov.music === false && video.music) notes.add('music disabled (overrides.music = false)');
  else if (typeof ov.music === 'string') notes.add(`music: ${ov.music} (overrides.music)`);
  const musicSpec = musicSpecOf(video, ov);
  if (musicSpec) {
    const file = musicFile(musicSpec, project);
    music = {
      url: asset('music', file),
      file,
      volume: musicSpec.volume ?? MUSIC_DEFAULTS.volume,
      duck: musicSpec.duck ?? MUSIC_DEFAULTS.duck,
      duck_ramp_s: MUSIC_DEFAULTS.duck_ramp_s,
      fadeIn_s: MUSIC_DEFAULTS.fadeIn_s,
      fadeOut_s: MUSIC_DEFAULTS.fadeOut_s,
      loop: musicSpec.loop ?? MUSIC_DEFAULTS.loop,
      crossfade_s: MUSIC_DEFAULTS.crossfade_s,
    };
    const L = input.musicDuration_s;
    if (L !== undefined && L > 0) {
      music.duration_s = round(L, 3);
      music.plays = musicPlays(L, durationInFrames, outFps, music.loop, music.crossfade_s);
      const total = secs(durationInFrames / outFps);
      if (L * outFps >= durationInFrames) notes.add(`music: the ${secs(L)} track is trimmed to the video (${total}), faded out over ${secs(music.fadeOut_s)}`);
      else if (!music.loop) notes.add(`music: the ${secs(L)} track plays once (loop: false); the rest of the ${total} video has no music`);
      else notes.add(`music: the ${secs(L)} track loops ${music.plays.length}× over ${total} (seams crossfaded over ${secs(music.crossfade_s)})`);
    }
    const ownSound = segments.some((sg) => sg.kind !== 'clip' && playsSound(sg.component));
    notes.add(`music: volume ${music.volume} on the intro, outro and cards, ×${music.duck} under footage${ownSound ? ' and under your files with sound' : ''}`);
  }

  const plan: EditPlan = {
    version: 1,
    variant,
    fps: outFps,
    width,
    height,
    unit,
    durationInFrames,
    frame: videoFrame,
    brand,
    layout: mainLayout,
    source: mainSource,
    ...(Object.keys(trackSources).length > 0 ? { tracks: trackSources } : {}),
    segments,
    captions,
    markers,
    timemap,
    assets,
    meta: { run_id: timeline.run_id, project: timeline.project, scenario: timeline.scenario, theme: template.name },
    notes: notes.items,
    warnings: warnings.items,
  };
  if (music) plan.music = music;
  if (tutorialUsed) plan.tutorial = tutorial;
  resolver.flush();
  plan.warnings = warnings.items;
  return plan;

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
}

/** The music bed of an edit: the scenario's (timeline `video.music`), replaced by `overrides.music` (a file) or removed (`false`). */
export function musicSpecOf(video: Pick<TimelineVideo, 'music'> | undefined, ov: Pick<EditOverrides, 'music'> = {}): TimelineVideo['music'] | undefined {
  if (ov.music === false) return undefined;
  if (typeof ov.music === 'string') return { ...(video?.music ?? {}), file: ov.music };
  return video?.music;
}

/** Absolute path of a music bed file (relative paths are relative to the project). */
export function musicFile(spec: { file: string }, project: Pick<LoadedProject, 'dir'>): string {
  return isAbsolute(spec.file) ? spec.file : join(project.dir, spec.file);
}

/**
 * The plays of a music track of `L` seconds over a video of `total` output frames: one play when the track covers the
 * video or `loop` is false (trimmed by the video's end), else back-to-back loops overlapping by `crossfade_s` (each
 * fades out while the next fades in — equal-power curves in the composition). Frames are output frames.
 */
export function musicPlays(L: number, total: number, fps: number, loop: boolean, crossfadeS: number): Array<{ from: number; frames: number; fadeIn: number; fadeOut: number }> {
  const len = Math.max(1, Math.floor(L * fps));
  if (len >= total || !loop) return [{ from: 0, frames: Math.min(len, total), fadeIn: 0, fadeOut: 0 }];
  const xf = Math.max(0, Math.min(Math.round(crossfadeS * fps), Math.floor(len / 3)));
  const out: Array<{ from: number; frames: number; fadeIn: number; fadeOut: number }> = [];
  for (let from = 0; from < total; from += len - xf) {
    const frames = Math.min(len, total - from);
    out.push({ from, frames, fadeIn: from > 0 ? xf : 0, fadeOut: 0 });
    if (from + len >= total) break;
  }
  for (let i = 0; i < out.length - 1; i++) out[i].fadeOut = xf;
  return out;
}

/**
 * Where a file overlay placed at a position of the screen may move to keep clear of the step's targets (the planner's
 * per-variant check): a corner to another corner, a top / bottom side to the other, a left / right side to the other.
 * The centre stays (a note when it covers a target).
 */
export const SCREEN_POSITION_CHOICES: Partial<Record<OverlayAnchor, readonly OverlayAnchor[]>> = {
  'top-left': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  'top-right': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  'bottom-left': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  'bottom-right': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  top: ['top', 'bottom'],
  bottom: ['top', 'bottom'],
  left: ['left', 'right'],
  right: ['left', 'right'],
  center: ['center'],
};

type ClickData = { bbox?: { x: number; y: number; w: number; h: number }; t_click?: number };

/**
 * Capture time of "the screen once the marked step is done": within its hold (0.8 s in, or half a shorter hold), else
 * 0.25 s after the step's end — still inside its scene. A timeline marker sits at the step's start (DESIGN §timeline);
 * for a marked wait this is the awaited state, which story-card frames (`frame: mark:<name>`) and the review's key
 * frame of the marker show.
 */
export function markDoneAt(timeline: Pick<Timeline, 'events' | 'scenes' | 'capture'>, mk: { scene: string; step: number; t: number }): number {
  const ev = timeline.events.find((e) => e.scene === mk.scene && e.step === mk.step);
  const sc = timeline.scenes.find((x) => x.id === mk.scene && x.kind === 'scene');
  const end = sc ? sc.t_end - 1 / timeline.capture.fps : timeline.capture.duration;
  if (!ev) return mk.t;
  if (ev.hold && ev.hold.t_end > ev.hold.t_start) return Math.min(ev.hold.t_start + Math.min(0.8, (ev.hold.t_end - ev.hold.t_start) / 2), end);
  return Math.min(ev.t_end + 0.25, end);
}

/**
 * When a step overlay starts (capture s; L2.12 `at`): the end of the step (default), its start, its click, a mark of
 * the run, or seconds after the step starts. `fallback` says why a requested start was not used (the end of the step
 * then): the step recorded no click, no such mark, or the mark (at `markT`) lies outside `clip`. Shared by the planner
 * (where the overlay shows) and the reframe (what it keeps in view meanwhile).
 */
export function overlayStartAt(
  ev: TimelineEvent,
  markers: ReadonlyArray<{ name: string; t: number }>,
  clip?: { s0: number; s1: number },
): { t: number; fallback?: 'no-click' | 'no-mark' | 'outside-clip'; markT?: number } {
  const at = ev.overlay?.at;
  if (at === 'start') return { t: ev.t_start };
  if (at === 'click') {
    const clicks = (ev.data as { clicks?: Array<{ t_click?: number }> } | undefined)?.clicks;
    const tc = ev.t_click ?? clicks?.find((c) => typeof c.t_click === 'number')?.t_click;
    return tc === undefined ? { t: ev.t_end, fallback: 'no-click' } : { t: tc };
  }
  if (typeof at === 'number') return { t: ev.t_start + at };
  if (typeof at === 'string' && at.startsWith('mark:')) {
    const mk = markers.find((m) => m.name === at.slice(5));
    if (!mk) return { t: ev.t_end, fallback: 'no-mark' };
    if (clip && (mk.t < clip.s0 || mk.t >= clip.s1)) return { t: ev.t_end, fallback: 'outside-clip', markT: mk.t };
    return { t: mk.t };
  }
  return { t: ev.t_end };
}

/** What the reframe keeps in view for a step overlay: a box of the page (CSS px) over capture seconds [t0, t1]. */
export interface OverlayKeep {
  t0: number;
  t1: number;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * The overlay keep of a step without the planner's knowledge (its resolved component, the file's length, the time
 * map): from its start (`overlayStartAt`, marks unknown) for its `duration` (default 2.5 s) of capture time; its `rect`,
 * the box around the cursor (`anchor: cursor`), or its target — nothing for a file placed on the screen (a corner, a
 * side, the centre, the whole screen: it follows the view).
 */
export function defaultOverlayKeep(ev: TimelineEvent): OverlayKeep | null {
  const o = ev.overlay;
  if (!o) return null;
  const t0 = overlayStartAt(ev, []).t;
  const t1 = t0 + (o.duration ?? 2.5);
  const anchor = o.box?.anchor;
  if (o.box?.rect) return { t0, t1, box: { ...o.box.rect } };
  if (anchor === 'cursor') {
    const p = o.point ?? (o.bbox ? centre(o.bbox) : undefined);
    return p ? { t0, t1, box: { x: p.x - 1, y: p.y - 1, w: 2, h: 2 } } : null;
  }
  if (anchor !== undefined && anchor !== 'target') return null;
  return o.bbox ? { t0, t1, box: { ...o.bbox } } : null;
}

/**
 * What the reframe of a vertical / square clip keeps in view (camera.ts `reframeTrack`): each step's target over the
 * step (soft), each click's target around the click (hard: never cut — widgets list every click of a select / date
 * pick in `data.clicks`), camera targets (soft) and step overlays while they show (hard; `overlayKeep` — the planner
 * passes what it planned: the overlay's real start, length and box; default `defaultOverlayKeep`).
 */
export function reframeTargets(events: readonly TimelineEvent[], overlayKeep: (ev: TimelineEvent) => OverlayKeep | null = defaultOverlayKeep): ReframeTarget[] {
  const out: ReframeTarget[] = [];
  const W = REFRAME_CLICK_WINDOW_S;
  for (const ev of events) {
    if (ev.step < 0) continue;
    const label = `${ev.scene} step ${ev.step}`;
    const end = stepEnd(ev);
    const box = ev.target?.bbox;
    if (box && box.w > 0 && box.h > 0) out.push({ t0: ev.t_start, t1: end, box: { ...box }, label });
    const data = ev.data as { clicks?: ClickData[] } | undefined;
    const clicks = Array.isArray(data?.clicks) ? data!.clicks.filter((c) => c.bbox && typeof c.t_click === 'number') : [];
    let prev = ev.t_start;
    for (const c of clicks) {
      out.push({ t0: prev, t1: Math.min(end, c.t_click! + W.after), box: { ...c.bbox! }, label: `${label} click` });
      out.push({ t0: c.t_click! - W.before, t1: c.t_click! + W.after, box: { ...c.bbox! }, hard: true, label: `${label} click` });
      prev = c.t_click!;
    }
    if (clicks.length === 0 && box && ev.t_click !== undefined) out.push({ t0: ev.t_click - W.before, t1: ev.t_click + W.after, box: { ...box }, hard: true, label: `${label} click` });
    if (ev.camera?.bbox) out.push({ t0: ev.t_start, t1: end, box: { ...ev.camera.bbox }, label: `${label} camera` });
    const keep = ev.overlay ? overlayKeep(ev) : null;
    if (keep) out.push({ t0: keep.t0, t1: keep.t1, box: { ...keep.box }, hard: true, label: `${label} overlay` });
  }
  return out;
}

function captionText(c: { kicker?: string; text: string }): { kicker?: string; text: string } {
  return c.kicker !== undefined ? { kicker: c.kicker, text: c.text } : { text: c.text };
}

/** The transition kind the chain asked for when no component resolved (the stand-in still needs a kind). */
function requestedKind(chain: readonly Candidate[]): TransitionKind {
  const first = chain.find((c) => c.ref !== null);
  if (!first) return 'cut';
  const ref = typeof first.ref === 'string' ? { id: first.ref, params: {} } : { id: first.ref!.id, params: first.ref!.params ?? {} };
  return transitionKindOf(ref);
}
