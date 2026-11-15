/**
 * A step of `planEdit`: the segments of the video, in order — the intro, each card, interstitial and clip (its layout,
 * caption, camera, panes and reframe), the outro — as drafts: content frames first, transitions applied afterwards
 * (transitions.ts).
 */
import { mediaSegmentUse } from '@retake/core/model';
import { READING_PACE, readingSeconds, wordCount } from '@retake/core/language';
import type { FrameSpec } from '@retake/core/language';
import type { MediaFileFields } from '@retake/core/model';
import type { TimelineScenePage } from '@retake/core/run';
import { GEOMETRY_KEYS, autoFit, isMultiPaneGeometry } from '@retake/components/geometry';
import type { SlotContext } from '@retake/components/geometry';
import { reframeTrack } from '../camera.js';
import type { CardSegment, ClipSegment, IntroSegment, OutroSegment, ResolvedComponent } from '../plan-types.js';
import type { Candidate } from '../resolve.js';
import type { RunTiming } from '../timing.js';
import { tutorialReframeTargets } from '../tutorial.js';
import { round, secs } from '../util.js';
import type { RunCameras } from './cameras.js';
import { panePlanner } from './clip-panes.js';
import type { PlanLayouts } from './layouts.js';
import { fileLength } from './overlays.js';
import type { StepOverlays } from './overlays.js';
import type { CardEntry, ClipEntry, Draft, Entry, PlanScope, RunOf } from './scope.js';
import { reframeTargets } from './targets.js';

/** What the segments step plans from: the entries and their runs, the cameras, the layouts, the step overlays. */
export interface SegmentInputs {
  entries: Entry[];
  runOf: RunOf;
  camByRun: RunCameras;
  layouts: PlanLayouts;
  overlays: StepOverlays;
}

/** The words of a text and the seconds they need to be read. */
type Reading = { words: number; seconds: number };

/** How long a full-frame use asks to last: its own duration, the theme's, the kind's fallback, and its text to read. */
interface DurationAsk {
  explicit: number | undefined;
  themeDefault: number | undefined;
  fallback: number;
  where: string;
  reading?: Reading;
}

/** A segment's common fields, before transitions. */
const base = (id: string, durationInFrames: number, component: ResolvedComponent) => ({
  id,
  from: 0,
  durationInFrames,
  fadeIn: { frames: 0, color: 'none' as const },
  fadeOut: { frames: 0, color: 'none' as const },
  transitionIn: 'none' as const,
  component,
});

/** Seconds of a use from its duration ask, held to its text's reading time and the component's min / max. */
function segDuration(s: PlanScope, rc: ResolvedComponent, ask: DurationAsk): number {
  const { resolver, notes } = s;
  const { explicit, themeDefault, fallback, where, reading } = ask;
  const m = resolver.manifest(rc)?.duration;
  let sec = explicit ?? themeDefault ?? m?.default ?? fallback;
  // R-FLD-03: without a duration of its own, a card stays long enough to read its text.
  if (explicit === undefined && reading && reading.seconds > sec) {
    notes.add(`${where}: ${reading.seconds} s to read its ${reading.words} words (${READING_PACE.words_per_minute} words a minute + ${READING_PACE.extra_s} s)`);
    sec = reading.seconds;
  }
  if (m?.min !== undefined && sec < m.min) {
    notes.add(`${where}: ${sec} s raised to the ${rc.id} minimum ${m.min} s`);
    sec = m.min;
  }
  if (m?.max !== undefined && sec > m.max) {
    notes.add(`${where}: ${sec} s lowered to the ${rc.id} maximum ${m.max} s`);
    sec = m.max;
  }
  return sec;
}

/** The words of a use's text slots and the seconds they need to be read (R-FLD-03); undefined without text. */
function readingOf(s: PlanScope, rc: ResolvedComponent): Reading | undefined {
  if (rc.media?.file) return undefined;
  const slots = s.resolver.manifest(rc)?.slots ?? {};
  const words = wordCount(
    Object.entries(rc.slots)
      .filter(([k]) => slots[k]?.type === 'text')
      .map(([, v]) => v),
  );
  return words > 0 ? { words, seconds: readingSeconds(words) } : undefined;
}

/** The scenario's own file for a segment (`intro: {video: …}`), as a candidate of its chain. */
function fileCandidate(spec: (MediaFileFields & { params?: Record<string, unknown> }) | undefined, label: string): Candidate[] {
  const use = spec ? mediaSegmentUse(spec) : undefined;
  if (!use) return [];
  return [{ ref: { id: use.id, params: use.params }, slots: use.slots, source: 'scenario', label: `${label} file ${use.slots.file}` }];
}

/**
 * Seconds of a full-frame use: the scenario's `duration`, else what the winning candidate sets (a theme's file), else
 * the file's own length (a video part, a Lottie animation), else the kind's default (theme, component, fallback).
 */
function segmentSeconds(s: PlanScope, rc: ResolvedComponent, ask: DurationAsk): number {
  const { resolver, notes, outFps, width, height } = s;
  const { explicit, themeDefault, fallback, where, reading } = ask;
  const own = explicit ?? resolver.candidateOf(rc)?.duration ?? fileLength(rc, outFps);
  const sec = segDuration(s, rc, {
    explicit: own,
    themeDefault: rc.media?.file ? (own === undefined ? themeDefault : undefined) : themeDefault,
    fallback,
    where,
    reading: rc.media?.file ? undefined : reading,
  });
  if (rc.media?.file) {
    const m = rc.media.file;
    const what =
      m.kind === 'video'
        ? `video ${secs(fileLength(rc, outFps) ?? m.duration_s)}${m.audio ? ', with sound' : ''}${m.alpha ? ', alpha' : ''}`
        : m.kind === 'lottie'
          ? `Lottie ${secs(m.duration_s)}`
          : 'image';
    notes.add(`${where}: your file ${m.name} (${what}) for ${secs(sec)}`);
    if (rc.params.fit === 'auto' && (m.kind === 'video' || m.kind === 'picture') && m.width && m.height && autoFit(m, { w: width, h: height }) === 'contain') {
      notes.add(
        `${where}: ${m.name} (${m.width}×${m.height}) does not have the shape of the ${width}×${height} video: shown whole on the background (fit: contain; write fit: cover to fill the frame, cropped)`,
      );
    }
  }
  return sec;
}

/** The intro's draft, with its notes; pushed onto `drafts` when the video has one. */
function planIntro(s: PlanScope, drafts: Draft[]): void {
  const { ov, video, t, notes, resolver, kindOverride, themeAndBuiltin, slotBase, fr } = s;
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
      const frames = fr(segmentSeconds(s, rc, { explicit: spec?.duration, themeDefault: t.intro.duration, fallback: 3.2, where: 'intro' }));
      drafts.push({ seg: { ...base('intro', frames, rc), kind: 'intro' } as IntroSegment, content: frames });
    } else notes.add('no intro: the theme has none');
  } else if (video.intro === false && ov.intro === undefined) notes.add('no intro (scenario intro: false)');
}

/** A card's draft; undefined (with a warning) when no component can draw it. */
function planCard(s: PlanScope, e: CardEntry): Draft | undefined {
  const { warnings, resolver, kindOverride, segmentOverride, themeAndBuiltin, slotBase, fr } = s;
  const id = e.scene.id;
  const spec = e.scene.card ?? {};
  const file = fileCandidate(spec, 'the scenario card');
  const chain: Candidate[] = [...segmentOverride(id, 'card'), ...kindOverride('card'), ...file];
  if (spec.component) chain.push({ ref: { id: spec.component, params: spec.params }, source: 'scenario', label: 'the scenario card' });
  chain.push(...themeAndBuiltin('card'));
  const rc = resolver.resolve('card', chain, `card "${id}"`, { explicit: file.length > 0 ? undefined : spec.slots, ctx: slotBase });
  if (!rc) {
    warnings.add(`card "${id}": the theme has no card component and the scenario names none: left out`);
    return undefined;
  }
  const reading = readingOf(s, rc);
  const frames = fr(segmentSeconds(s, rc, { explicit: spec.duration, themeDefault: undefined, fallback: 2.5, where: `card "${id}"`, reading }));
  return { seg: { ...base(id, frames, rc), kind: 'card', ...(reading ? { reading } : {}) } as CardSegment, content: frames };
}

/** An interstitial's draft; undefined (with a warning) when no component can draw it. */
function planInterstitial(s: PlanScope, e: CardEntry): Draft | undefined {
  const { t, warnings, resolver, kindOverride, segmentOverride, themeAndBuiltin, slotBase, fr } = s;
  const id = e.scene.id;
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
    return undefined;
  }
  const reading = readingOf(s, rc);
  const frames = fr(segmentSeconds(s, rc, { explicit: spec.duration, themeDefault: t.interstitial.duration, fallback: 2.6, where: `interstitial "${id}"`, reading }));
  return { seg: { ...base(id, frames, rc), kind: 'interstitial', ...(reading ? { reading } : {}) } as CardSegment, content: frames };
}

/** What every clip of the video shares while its segments are planned. */
interface ClipPlanning {
  s: PlanScope;
  from: SegmentInputs;
  planPanes: ReturnType<typeof panePlanner>;
  /** The reframe track of each run, computed once for its clips. */
  reframeByRun: Map<RunTiming, Array<[number, number]>>;
  captionsOn: boolean;
  /** The scenario's caption component, between a render override and the theme. */
  scenarioCaption: Candidate[];
}

/** A clip being planned: its entry, its run, its frame range in the run, its label. */
interface ClipAt {
  e: ClipEntry;
  r: NonNullable<ReturnType<RunOf['get']>>;
  range: { k0: number; k1: number };
  where: string;
}

/** Whether a layout component shows several pages. */
function isMultiPane(s: PlanScope, rc: ResolvedComponent | null | undefined): boolean {
  const m = s.resolver.manifest(rc);
  return isMultiPaneGeometry(m?.[GEOMETRY_KEYS[s.variant]] ?? m?.geometry);
}

/** A clip's layout component: a multi-page scene needs a layout that shows several pages, a single-page scene one that shows one. */
function clipLayoutRc(c: ClipPlanning, at: ClipAt): ResolvedComponent | null | undefined {
  const { s } = c;
  const { ov, notes, warnings, resolver, trackSources, cssW, cssH } = s;
  const { layoutChain, mainLayoutComponent } = c.from.layouts;
  const { e, where } = at;
  const id = e.scene.id;
  let layoutRc = e.scene.frame === undefined && ov.components?.[id] === undefined ? mainLayoutComponent : resolver.resolve('layout', layoutChain(e.scene.frame, id), where);
  const pageCss = (pg: TimelineScenePage) => trackSources[pg.track] ?? { cssWidth: cssW, cssHeight: cssH };
  if (e.pages && !isMultiPane(s, layoutRc)) {
    const aspects = e.pages.map((pg) => pageCss(pg).cssWidth / pageCss(pg).cssHeight);
    const kind = aspects.some((a) => a < 0.9) && aspects.some((a) => a >= 1.2) ? 'pip' : 'split';
    const auto = resolver.resolve('layout', [resolver.multiPageCandidate(kind, 'builtin-default', 'the multi-page default')], where);
    if (auto) {
      notes.add(`${where} films ${e.pages.length} pages: ${auto.id}${layoutRc ? ` (${layoutRc.id} shows one page)` : ''}`);
      layoutRc = auto;
    }
  } else if (!e.pages && isMultiPane(s, layoutRc)) {
    const single = resolver.resolve(
      'layout',
      [resolver.themeCandidate('layout'), resolver.builtinCandidate('layout')].filter((c) => c.ref !== null),
      where,
    );
    const msg = `${where} films one page: ${layoutRc!.id} shows several, ${single?.id ?? 'the built-in layout'} used`;
    if (e.scene.frame !== undefined) warnings.add(msg);
    else notes.add(msg);
    layoutRc = single;
  }
  return layoutRc;
}

/** A multi-page clip's panes on its segment; a caption band over the screen moves below the pages of a split. */
function applyPanes(c: ClipPlanning, at: ClipAt, layoutComponent: ResolvedComponent, seg: ClipSegment): void {
  const { notes } = c.s;
  const { e, r, range, where } = at;
  const captionRc = seg.caption;
  const mp = c.planPanes(e, layoutComponent, where, r, range);
  if (!mp) return;
  seg.layout = mp.layout;
  seg.panes = mp.panes;
  if (mp.inset) seg.inset = mp.inset;
  // A caption band drawn over the screen would straddle both pages of a split (and hide what they act on):
  // it goes to the layout's caption area, below the pages. A picture in picture keeps it over its main page.
  if (!mp.inset && captionRc && captionRc.params.position === 'over') {
    seg.caption = { ...captionRc, params: { ...captionRc.params, position: 'area' } };
    notes.add(`${where}: the caption band goes below the pages (over the screen it would straddle both)`);
  }
}

/** A cropped (portrait, square) clip's reframe track, computed once per run and sliced to the clip. */
function clipReframe(c: ClipPlanning, at: ClipAt, crop: NonNullable<ClipSegment['layout']['crop']>): Array<[number, number]> {
  const { srcFps, timeline, cssW, cssH, outFps, tutorialOn, stateOf } = c.s;
  const { overlayKeepOf } = c.from.overlays;
  const { r, range } = at;
  const cam = c.from.camByRun.get(r.run)!;
  let track = c.reframeByRun.get(r.run);
  if (!track) {
    const targets = r.entries.flatMap((x) => [...reframeTargets(x.events, overlayKeepOf(x)), ...(tutorialOn ? tutorialReframeTargets(x.events, (ev) => stateOf(x.scene, ev)) : [])]);
    track = reframeTrack({ times: r.run.p.map((p) => p / srcFps), camera: cam.track, cursor: timeline.cursor, crop, css: { w: cssW, h: cssH }, outFps, targets });
    c.reframeByRun.set(r.run, track);
  }
  return track.slice(range.k0, range.k1);
}

/** A clip's draft (layout, caption, camera, panes, reframe); undefined (with a warning) when every frame was trimmed. */
function planClip(c: ClipPlanning, e: ClipEntry): Draft | undefined {
  const { s } = c;
  const { ov, warnings, resolver, kindOverride, themeAndBuiltin, slotBase, variant, srcFps } = s;
  const { videoFrame, layoutOf, mainLayoutComponent, mainLayout } = c.from.layouts;
  const id = e.scene.id;
  const r = c.from.runOf.get(e)!;
  const range = r.run.clipRanges[r.index];
  const content = range.k1 - range.k0;
  if (content <= 0) {
    warnings.add(`scene "${id}": every frame was trimmed away: left out`);
    return undefined;
  }
  const where = `scene "${id}"`;
  const at: ClipAt = { e, r, range, where };
  const frameSpec: FrameSpec = ov.frame ?? e.scene.frame ?? videoFrame;
  const layoutRc = clipLayoutRc(c, at);
  const layoutComponent = layoutRc ?? resolver.resolve('layout', [resolver.builtinCandidate('layout')], where)!;
  const layout = layoutRc === mainLayoutComponent && !isMultiPane(s, layoutRc) ? mainLayout : layoutOf(layoutComponent, frameSpec, where);
  const captionRc = c.captionsOn
    ? resolver.resolve('caption', [...kindOverride('caption'), ...c.scenarioCaption, ...themeAndBuiltin('caption')], where, {
        ctx: { ...slotBase, scene: { caption: e.scene.caption } },
      })
    : null;
  const cam = c.from.camByRun.get(r.run)!;
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
  if (e.pages) applyPanes(c, at, layoutComponent, seg);
  else if (variant !== 'landscape' && layout.crop) {
    reframe = clipReframe(c, at, layout.crop);
    seg.reframe = reframe;
  }
  return { seg, content, clip: { entry: e, run: r.run, index: r.index, k0: range.k0, k1: range.k1, camera, reframe, moves: cam.moves.filter((m) => m.scene === id) } };
}

/** The outro's draft, with its notes; pushed onto `drafts` when the video has one. */
function planOutro(s: PlanScope, drafts: Draft[]): void {
  const { ov, video, t, notes, resolver, kindOverride, themeAndBuiltin, slotBase, outro, fr } = s;
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
      const frames = fr(segmentSeconds(s, rc, { explicit: outro?.duration, themeDefault: t.outro.duration, fallback: 3, where: 'outro' }));
      drafts.push({ seg: { ...base('outro', frames, rc), kind: 'outro' } as OutroSegment, content: frames });
    } else notes.add('no outro: the theme has none');
  } else if (video.outro === false && ov.outro === undefined) notes.add('no outro (scenario outro: false)');
}

/** The drafts of the video's segments, in order. */
export function planSegments(s: PlanScope, from: SegmentInputs): Draft[] {
  const { ov, video, notes } = s;
  const drafts: Draft[] = [];
  const planPanes = panePlanner(s, from.camByRun, from.overlays);

  planIntro(s, drafts);

  // Scenes, cards, interstitials
  const captionsOn = ov.captions !== false;
  if (!captionsOn) notes.add('captions disabled (overrides.captions = false)');
  // The scenario's caption component, between a render override and the theme (per video: captions resolve by kind).
  const scenarioCaption: Candidate[] = video.caption_component ? [{ ref: video.caption_component, source: 'scenario', label: 'the scenario (caption_component)' }] : [];
  const clips: ClipPlanning = { s, from, planPanes, reframeByRun: new Map(), captionsOn, scenarioCaption };
  for (const e of from.entries) {
    const draft = e.type === 'card' ? planCard(s, e) : e.type === 'interstitial' ? planInterstitial(s, e) : planClip(clips, e);
    if (draft) drafts.push(draft);
  }

  planOutro(s, drafts);
  return drafts;
}
