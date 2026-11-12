/**
 * A step of `planEdit`: the segments of the video, in order — the intro, each card, interstitial and clip (its layout,
 * caption, camera, panes and reframe), the outro — as drafts: content frames first, transitions applied afterwards
 * (transitions.ts).
 */
import { mediaSegmentUse } from '@retake/core/model';
import { READING_PACE, readingSeconds, wordCount } from '@retake/core/language';
import type { FrameSpec, MediaFileFields, TimelineScenePage } from '@retake/core/model';
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
import type { Draft, Entry, PlanScope, RunOf } from './scope.js';
import { reframeTargets } from './targets.js';

/** What the segments step plans from: the entries and their runs, the cameras, the layouts, the step overlays. */
export interface SegmentInputs {
  entries: Entry[];
  runOf: RunOf;
  camByRun: RunCameras;
  layouts: PlanLayouts;
  overlays: StepOverlays;
}

/** The drafts of the video's segments, in order. */
export function planSegments(s: PlanScope, from: SegmentInputs): Draft[] {
  const {
    ov,
    video,
    t,
    notes,
    warnings,
    resolver,
    kindOverride,
    segmentOverride,
    themeAndBuiltin,
    slotBase,
    outro,
    fr,
    outFps,
    width,
    height,
    variant,
    trackSources,
    cssW,
    cssH,
    srcFps,
    timeline,
    tutorialOn,
    stateOf,
  } = s;
  const { entries, runOf, camByRun, layouts, overlays } = from;
  const { videoFrame, layoutChain, layoutOf, mainLayoutComponent, mainLayout } = layouts;
  const { overlayKeepOf } = overlays;
  const drafts: Draft[] = [];
  const reframeByRun = new Map<RunTiming, Array<[number, number]>>();
  const planPanes = panePlanner(s, camByRun, overlays);

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
    reading?: { words: number; seconds: number },
  ): number => {
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
  };

  /** The words of a use's text slots and the seconds they need to be read (R-FLD-03); undefined without text. */
  const readingOf = (rc: ResolvedComponent): { words: number; seconds: number } | undefined => {
    if (rc.media?.file) return undefined;
    const slots = resolver.manifest(rc)?.slots ?? {};
    const words = wordCount(
      Object.entries(rc.slots)
        .filter(([k]) => slots[k]?.type === 'text')
        .map(([, v]) => v),
    );
    return words > 0 ? { words, seconds: readingSeconds(words) } : undefined;
  };

  /** The scenario's own file for a segment (`intro: {video: …}`), as a candidate of its chain (L2.12). */
  const fileCandidate = (spec: (MediaFileFields & { params?: Record<string, unknown> }) | undefined, label: string): Candidate[] => {
    const use = spec ? mediaSegmentUse(spec) : undefined;
    if (!use) return [];
    return [{ ref: { id: use.id, params: use.params }, slots: use.slots, source: 'scenario', label: `${label} file ${use.slots.file}` }];
  };

  /**
   * Seconds of a full-frame use: the scenario's `duration`, else what the winning candidate sets (a theme's file), else
   * the file's own length (a video part, a Lottie animation), else the kind's default (theme, component, fallback).
   */
  const useDuration = (
    rc: ResolvedComponent,
    explicit: number | undefined,
    themeDefault: number | undefined,
    fallback: number,
    where: string,
    reading?: { words: number; seconds: number },
  ): number => {
    const own = explicit ?? resolver.candidateOf(rc)?.duration ?? fileLength(rc, outFps);
    const sec = segDuration(rc, own, rc.media?.file ? (own === undefined ? themeDefault : undefined) : themeDefault, fallback, where, rc.media?.file ? undefined : reading);
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
  // L4.5: the scenario's caption component, between a render override and the theme (per video: captions resolve by kind).
  const scenarioCaption: Candidate[] = video.caption_component ? [{ ref: video.caption_component, source: 'scenario', label: 'the scenario (caption_component)' }] : [];
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
      const reading = readingOf(rc);
      const frames = fr(useDuration(rc, spec.duration, undefined, 2.5, `card "${id}"`, reading));
      drafts.push({ seg: { ...base(id, frames, rc), kind: 'card', ...(reading ? { reading } : {}) } as CardSegment, content: frames });
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
      const reading = readingOf(rc);
      const frames = fr(useDuration(rc, spec.duration, t.interstitial.duration, 2.6, `interstitial "${id}"`, reading));
      drafts.push({ seg: { ...base(id, frames, rc), kind: 'interstitial', ...(reading ? { reading } : {}) } as CardSegment, content: frames });
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
    let layoutRc = e.scene.frame === undefined && ov.components?.[id] === undefined ? mainLayoutComponent : resolver.resolve('layout', layoutChain(e.scene.frame, id), where);
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
    const layoutComponent = layoutRc ?? resolver.resolve('layout', [resolver.builtinCandidate('layout')], where)!;
    let layout = layoutRc === mainLayoutComponent && !multiPane(layoutRc) ? mainLayout : layoutOf(layoutComponent, frameSpec, where);
    const captionRc = captionsOn
      ? resolver.resolve('caption', [...kindOverride('caption'), ...scenarioCaption, ...themeAndBuiltin('caption')], where, {
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
  return drafts;
}
