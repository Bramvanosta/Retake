/**
 * `planEdit`: the edit of a capture as an EditPlan (docs/DESIGN-phase2.md §2.1, SPEC §9). PURE and deterministic:
 * no I/O, no clock, no randomness — the same input gives the same JSON.
 */
import { extname, isAbsolute, join } from 'node:path';
import { COMPONENT_KINDS, timelineVideo } from '@demo-studio/core';
import type {
  ComponentKind,
  FrameSpec,
  LoadedProject,
  LoadedTemplate,
  Scenario,
  Timeline,
  TimelineEvent,
  TimelineScene,
  TimelineVideo,
  TransitionKind,
} from '@demo-studio/core';
import { fontFileFace, themeTokens } from '@demo-studio/components';
import type { CaptionCue, ComponentRegistry, SlotContext } from '@demo-studio/components';
import { MIN_ZOOM_EASE_S, cameraTrack, hintEase, clampView, isStatic, reframeTrack } from './camera.js';
import type { ZoomMove } from './camera.js';
import { FALLBACK_GEOMETRY, RAW_GEOMETRY, planLayout } from './layout.js';
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
  PlanLayout,
  PlanMusic,
  PlanSegment,
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
import { DEFAULT_IDLE_THRESHOLD_S, outFrameAt, planRunTiming } from './timing.js';
import type { RunTiming } from './timing.js';
import { MessageList, clamp, cursorAt, round, secs, stepEnd } from './util.js';

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
}

/** The input cannot be planned (dry-run timeline, no capture…). */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Defaults of a music bed (base volume, multiplier under footage, fades). */
export const MUSIC_DEFAULTS = { volume: 0.6, duck: 0.5, fadeIn_s: 1, fadeOut_s: 2 } as const;
/** Two scenes are contiguous in the capture when the second starts within this many seconds of the first's end. */
export const CONTIGUOUS_GAP_S = 0.1;

const LANDSCAPE = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

interface ClipEntry {
  type: 'clip';
  scene: TimelineScene;
  events: TimelineEvent[];
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

function pageAt(timeline: Timeline, t: number): { id: string; url?: string } | undefined {
  let found: Timeline['pages'][number] | undefined;
  for (const p of timeline.pages) {
    if (p.t_start <= t + 1e-6) found = p;
    if (p.t_start > t) break;
  }
  return found;
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

  // ── Output format ────────────────────────────────────────────────────────────
  const srcFps = cap.fps;
  const variant: PlanVariant = ov.variant ?? 'landscape';
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
  const design = variant === 'landscape' ? LANDSCAPE : VERTICAL;
  const width = Math.round(design.width * scale);
  const height = Math.round(design.height * scale);
  const unit = width / design.width;
  const cssW = cap.width;
  const cssH = cap.height;
  const srcFrameCount = Math.max(1, Math.round(cap.duration * srcFps));
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
  const logoUrl = asset('logo', template.assets.logo);
  const wordmarkUrl = template.assets.wordmark ? asset('wordmark', template.assets.wordmark) : undefined;
  const displayUrl = asset('font-display', template.assets.display);
  const bodyUrls = template.assets.body.map((f, i) => asset(`font-body-${i}`, f));
  const tokens = themeTokens(template, { logo: logoUrl, wordmark: wordmarkUrl, fonts: { display: displayUrl, body: bodyUrls } });

  const resolver = new ComponentResolver(registry, template, warnings);
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

  // ── Entries: scenes, cards, interstitials in scenario order ──────────────────
  const entries: Entry[] = [];
  const knownIds = new Set<string>(['intro', 'outro']);
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
    const events = timeline.events.filter((e) => e.scene === scene.id && e.scene_index === scene.index).sort((a, b) => a.t_start - b.t_start || a.step - b.step);
    const open = events.find((e) => e.action === 'scene_open');
    const still = events.find((e) => e.action === 'scene_still');
    const s0 = still ? still.t_start : open ? open.t_end : scene.t_start;
    const s1 = Math.min(scene.t_end, cap.duration);
    let A = Math.ceil(s0 * srcFps - 1e-6);
    const B = Math.min(srcFrameCount, Math.ceil(s1 * srcFps - 1e-6));
    const prev = entries[entries.length - 1];
    let joined = false;
    if (prev && prev.type === 'clip' && !open) {
      const gap = s0 - prev.s1;
      const pagePrev = pageAt(timeline, Math.max(prev.s0, prev.s1 - 1e-3))?.id ?? prev.scene.page;
      const pageNext = pageAt(timeline, s0)?.id ?? scene.page;
      if (gap <= CONTIGUOUS_GAP_S && gap >= -CONTIGUOUS_GAP_S && pagePrev === pageNext) {
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
    entries.push({ type: 'clip', scene, events, s0, s1, A, B, joined, speed });
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
  for (const runEntries of runs) {
    const run = planRunTiming({
      clips: runEntries.map((e) => ({ scene: e.scene.id, A: e.A, B: e.B, baseSpeed: e.speed, events: e.events })),
      srcFps,
      outFps,
      idle: timeline.idle,
      trimIdle,
      idleThresholdS: idleThreshold,
    });
    runEntries.forEach((e, index) => runOf.set(e, { run, index, entries: runEntries }));
    for (const c of run.cuts) {
      const kept = (c.idle.b - c.idle.a - (c.b - c.a)) / srcFps;
      notes.add(`"${runEntries[c.clip].scene.id}": idle ${secs((c.idle.b - c.idle.a) / srcFps)} at ${secs(c.idle.a / srcFps)} of the capture shortened to ${secs(kept)}`);
    }
  }

  // ── Camera (per run) ──────────────────────────────────────────────────────────
  const maxZoom = t.motion.max_zoom;
  const camByRun = new Map<RunTiming, { track: CameraFrame[]; moves: ZoomMove[] }>();
  let hintCount = 0;
  for (const runEntries of runs) {
    const { run } = runOf.get(runEntries[0])!;
    const moves: ZoomMove[] = [];
    runEntries.forEach((e, ci) => {
      for (const ev of e.events) {
        if (!ev.camera || ev.step < 0) continue;
        hintCount++;
        if (ov.camera === false) continue;
        const requested = ev.camera.zoom;
        const zoom = clamp(requested, 1, maxZoom);
        if (requested > maxZoom) notes.add(`"${e.scene.id}" step ${ev.step}: zoom ${requested} clamped to the theme max_zoom ${maxZoom}`);
        const focus = ev.camera.bbox ? centre(ev.camera.bbox) : ev.camera.point ? { ...ev.camera.point } : (cursorAt(timeline.cursor, ev.t_end, false) ?? { x: cssW / 2, y: cssH / 2 });
        const start = outFrameAt(run, ev.t_start);
        if (start >= run.clipRanges[ci].k1) continue;
        const stepFrames = Math.max(0, outFrameAt(run, ev.t_end) - start);
        const frames = Math.max(MIN_ZOOM_EASE_S, ev.camera.duration ?? stepFrames / outFps) * outFps;
        const until = ev.camera.until ?? 'scene_end';
        const outAt =
          until === 'step_end' ? outFrameAt(run, stepEnd(ev)) : until === 'scene_end' ? run.clipRanges[ci].k1 : start + frames + until * outFps;
        moves.push({ scene: e.scene.id, step: ev.step, zoom, requested, focus: { x: round(focus.x, 2), y: round(focus.y, 2) }, start, frames, outAt, ease: hintEase(ev.camera, t.motion.zoom_ease) });
      }
    });
    camByRun.set(run, { track: cameraTrack(moves, run.src.length, cssW, cssH), moves });
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
    const geometry = variant === 'landscape' ? manifest?.geometry : manifest?.geometry_vertical;
    const radius = typeof rc?.params.radius === 'number' ? rc.params.radius : undefined;
    if (geometry) return planLayout(geometry, { variant, unit, cssWidth: cssW, cssHeight: cssH, radius });
    const raw = frameSpec === 'raw' || rc?.id.endsWith('layout-raw');
    if (rc && !rc.missing) warnings.add(`${where}: layout ${rc.id} declares no ${variant === 'landscape' ? 'geometry' : 'geometry_vertical'}: default geometry used`);
    return planLayout((raw ? RAW_GEOMETRY : FALLBACK_GEOMETRY)[variant], { variant, unit, cssWidth: cssW, cssHeight: cssH, radius, fallback: true });
  };
  const mainLayoutComponent = resolver.resolve('layout', layoutChain(undefined), 'video layout') ?? null;
  const mainLayout = layoutOf(mainLayoutComponent, videoFrame, 'video layout');

  // ── Drafts ────────────────────────────────────────────────────────────────────
  const drafts: Draft[] = [];
  const reframeByRun = new Map<RunTiming, Array<[number, number]>>();
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

  // Intro
  const introOn = ov.intro ?? video.intro !== false;
  if (ov.intro === true && video.intro === false) notes.add('intro forced on (overrides.intro) although the scenario disables it');
  if (ov.intro === false) notes.add('intro disabled (overrides.intro = false)');
  if (introOn) {
    const spec = video.intro === false ? undefined : video.intro;
    const chain: Candidate[] = [...kindOverride('intro')];
    if (spec?.component) chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario intro' });
    chain.push(...themeAndBuiltin('intro'));
    const rc = resolver.resolve('intro', chain, 'intro', { named: { title: video.title?.text, kicker: video.title?.kicker }, ctx: slotBase });
    if (rc) {
      const frames = fr(segDuration(rc, spec?.duration, t.intro.duration, 3.2, 'intro'));
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
      const chain: Candidate[] = [...segmentOverride(id, 'card'), ...kindOverride('card')];
      if (spec.component) chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario card' });
      chain.push(...themeAndBuiltin('card'));
      const rc = resolver.resolve('card', chain, `card "${id}"`, { explicit: spec.slots, ctx: slotBase });
      if (!rc) {
        warnings.add(`card "${id}": the theme has no card component and the scenario names none: left out`);
        continue;
      }
      const frames = fr(segDuration(rc, spec.duration, undefined, 2.5, `card "${id}"`));
      drafts.push({ seg: { ...base(id, frames, rc), kind: 'card' } as CardSegment, content: frames });
      continue;
    }
    if (e.type === 'interstitial') {
      const spec = e.scene.interstitial ?? { text: '' };
      const chain: Candidate[] = [...segmentOverride(id, 'interstitial'), ...kindOverride('interstitial')];
      if (spec.component) {
        chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario interstitial' });
        if (spec.style) warnings.add(`interstitial "${id}": style "${spec.style}" ignored (component ${spec.component} is set)`);
      } else if (spec.style) {
        const legacy = spec.style === 'dark-clock' ? { id: 'studio/interstitial-clock', params: {} } : { id: 'studio/interstitial-plain', params: { tone: spec.style } };
        chain.push({ ref: legacy, source: 'scenario', label: `the scenario interstitial style "${spec.style}"` });
      }
      chain.push(...themeAndBuiltin('interstitial'));
      const ctx: SlotContext = { ...slotBase, interstitial: { text: spec.text, kicker: spec.kicker } };
      const rc = resolver.resolve('interstitial', chain, `interstitial "${id}"`, { named: { text: spec.text, kicker: spec.kicker }, ctx });
      if (!rc) {
        warnings.add(`interstitial "${id}": the theme has no interstitial component and the scenario names none: left out`);
        continue;
      }
      const frames = fr(segDuration(rc, spec.duration, t.interstitial.duration, 2.6, `interstitial "${id}"`));
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
    const layoutRc =
      e.scene.frame === undefined && ov.components?.[id] === undefined
        ? mainLayoutComponent
        : resolver.resolve('layout', layoutChain(e.scene.frame, id), where);
    const layoutComponent = layoutRc ?? resolver.resolve('layout', [resolver.builtinCandidate('layout')], where)!;
    const layout = layoutRc === mainLayoutComponent ? mainLayout : layoutOf(layoutComponent, frameSpec, where);
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
    if (variant === 'vertical' && layout.crop) {
      let track = reframeByRun.get(r.run);
      if (!track) {
        track = reframeTrack({ times: r.run.p.map((p) => p / srcFps), camera: cam.track, cursor: timeline.cursor, crop: layout.crop, css: { w: cssW, h: cssH }, outFps });
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
    const chain: Candidate[] = [...kindOverride('outro')];
    if (outro?.component) chain.push({ ref: { id: outro.component, params: outro.params }, source: 'scenario', label: 'the scenario outro' });
    chain.push(...themeAndBuiltin('outro'));
    const rc = resolver.resolve('outro', chain, 'outro', {
      named: { tagline: outro?.tagline ?? t.outro.tagline, url: outro?.url ?? t.outro.url },
      ctx: slotBase,
    });
    if (rc) {
      const frames = fr(segDuration(rc, outro?.duration, t.outro.duration, 3, 'outro'));
      drafts.push({ seg: { ...base('outro', frames, rc), kind: 'outro' } as OutroSegment, content: frames });
    } else notes.add('no outro: the theme has none');
  } else if (video.outro === false && ov.outro === undefined) notes.add('no outro (scenario outro: false)');

  // ── Transitions and timing of the segments ────────────────────────────────────
  const transitionFor = (next: Draft): PlanTransition => {
    const chain: Candidate[] = [...kindOverride('transition')];
    if (ov.transition !== undefined) chain.push(resolver.transitionCandidate(ov.transition, 'override', 'overrides.transition'));
    const sceneKind = next.clip?.entry.scene.transition;
    if (sceneKind) chain.push(resolver.transitionCandidate(sceneKind, 'scenario', `the transition of scene "${next.seg.id}"`));
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

    // Overlays from step `overlay` modifiers, shown from the step's output end.
    for (const ev of entry.events) {
      if (!ev.overlay || ev.step < 0) continue;
      const o = ev.overlay;
      const where = `scene "${entry.scene.id}" step ${ev.step} overlay`;
      const chain: Candidate[] = [...kindOverride('overlay'), { ref: { id: o.component, params: o.params }, source: 'scenario', label: 'the step overlay' }, ...themeAndBuiltin('overlay')];
      const rc = resolver.resolve('overlay', chain, where, { explicit: o.slots, ctx: { ...slotBase, scene: { caption: entry.scene.caption } } });
      if (!rc) continue;
      const from = rel(ev.t_end);
      if (from >= n) {
        warnings.add(`${where}: the step ends after the clip: overlay left out`);
        continue;
      }
      const seconds = o.duration ?? resolver.manifest(rc)?.duration?.default ?? 2.5;
      let frames = fr(seconds);
      if (from + frames > seg.durationInFrames) {
        frames = seg.durationInFrames - from;
        notes.add(`${where}: shortened to ${secs(frames / outFps)} (the clip ends)`);
      }
      const use: OverlayUse = { component: rc, from, durationInFrames: frames, scene: entry.scene.id, step: ev.step };
      if (o.bbox) use.anchor = { bbox: { ...o.bbox } };
      else if (o.point) use.anchor = { point: { ...o.point } };
      else notes.add(`${where}: no anchor recorded — the overlay places itself`);
      seg.overlays.push(use);
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

    // URLs (browser chrome) along the clip.
    seg.srcFrames.forEach((f, k) => {
      const url = pageAt(timeline, f / srcFps)?.url ?? entry.scene.url;
      if (url && seg.urls[seg.urls.length - 1]?.url !== url) seg.urls.push({ frame: k, url });
    });

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
        out_frames: round(m.frames),
        zoom: m.zoom,
        focus: m.focus,
        view: { x: round(vx, 2), y: round(vy, 2) },
      };
      if (m.requested !== m.zoom) z.requested_zoom = m.requested;
      return z;
    });
    if (seg.camera && isStatic(seg.camera)) seg.camera = null;

    for (const mk of timeline.markers) {
      if (mk.scene !== entry.scene.id) continue;
      const k = outFrameAt(run, mk.t);
      if (k < k0 || k >= k1) continue;
      markers.push({ name: mk.name, frame: F + (k - k0), scene: mk.scene });
    }
  });

  const segments = drafts.map((d) => d.seg);
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
  let musicSpec = video.music;
  if (ov.music === false) {
    if (musicSpec) notes.add('music disabled (overrides.music = false)');
    musicSpec = undefined;
  } else if (typeof ov.music === 'string') {
    musicSpec = { ...(musicSpec ?? {}), file: ov.music };
    notes.add(`music: ${ov.music} (overrides.music)`);
  }
  if (musicSpec) {
    const file = isAbsolute(musicSpec.file) ? musicSpec.file : join(project.dir, musicSpec.file);
    music = {
      url: asset('music', file),
      file,
      volume: musicSpec.volume ?? MUSIC_DEFAULTS.volume,
      duck: musicSpec.duck ?? MUSIC_DEFAULTS.duck,
      fadeIn_s: MUSIC_DEFAULTS.fadeIn_s,
      fadeOut_s: MUSIC_DEFAULTS.fadeOut_s,
    };
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
    source: {
      url: captureUrl,
      file: input.captureFile,
      width: Math.round(cssW * cap.scale),
      height: Math.round(cssH * cap.scale),
      cssWidth: cssW,
      cssHeight: cssH,
      scale: cap.scale,
      fps: srcFps,
      frames: srcFrameCount,
    },
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
    seg.heldFrames += frames;
    seg.durationInFrames += frames;
  }
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
