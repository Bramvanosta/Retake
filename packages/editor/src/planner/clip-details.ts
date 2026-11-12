/**
 * A step of `planEdit`: the details of each placed clip, in this order — captions, step overlays, tutorial overlays,
 * the targets overlays keep clear of, provenance, URLs, the acting page and the inset of a multi-page clip, files
 * placed at a position of the screen, speeds / trims / zooms / time map, markers. An interstitial gets the last frame
 * of the clip before it as its backdrop.
 */
import { MEDIA_COMPONENTS } from '@retake/core/model';
import type { CaptionCue } from '@retake/components/geometry';
import { clampView, isStatic } from '../camera.js';
import { drawsUrl, growClearOf, insetCornerRects, mapPaneRect, paneIndexOf, paneSource, planActing, planInsetTrack, stepBoxes } from '../panes.js';
import type { CardSegment, ClipSegment, EditPlan, OverlayUse, SpeedSpan, StepSpan, TimeMapEntry, TrimSpan, ZoomSpan } from '../plan-types.js';
import { captionBandOver, staysInInset } from '../remotion/frames.js';
import { outFrameAt } from '../timing.js';
import type { RunTiming } from '../timing.js';
import { planBadgeNumbers, planClipTutorial } from '../tutorial.js';
import { clamp, round, secs, stepEnd } from '../util.js';
import type { StepOverlays } from './overlays.js';
import { pageAt, pushAddress, trackUrlAt } from './pages.js';
import { CLEAR_LOOKAHEAD_S } from './rules.js';
import type { ClipEntry, Draft, PlanScope } from './scope.js';
import { markDoneAt } from './targets.js';

/** What the details of the whole video add to the plan. */
export interface ClipDetails {
  captions: CaptionCue[];
  markers: EditPlan['markers'];
  timemap: TimeMapEntry[];
}

/** One clip of the details pass: its draft, its segment and where it sits. */
interface ClipPass {
  drafts: Draft[];
  /** The draft's index in `drafts`. */
  i: number;
  d: Draft & { clip: NonNullable<Draft['clip']> };
  seg: ClipSegment;
  entry: ClipEntry;
  run: RunTiming;
  k0: number;
  k1: number;
  /** Content frames of the clip (before held frames). */
  n: number;
  /** The clip's first output frame. */
  F: number;
  /** Where its captions end: the next segment's start or the clip's end. */
  cueEnd: number;
  /** A capture time as a frame of the clip (clamped to its content). */
  rel: (tSec: number) => number;
}

/** The details of every clip (and the backdrop of every interstitial), with the plan's captions, markers and time map. */
export function planClipDetails(s: PlanScope, drafts: Draft[], overlays: StepOverlays): ClipDetails {
  const { notes } = s;
  const out: ClipDetails = { captions: [], markers: [], timemap: [] };
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
    const c: ClipPass = { drafts, i, d: d as ClipPass['d'], seg, entry, run, k0, k1, n, F, cueEnd, rel };
    clipCaptions(c, out);
    clipStepOverlays(s, c, overlays);
    clipTutorialOverlays(s, c);
    clipClearAreas(c);
    clipProvenance(s, c);
    clipUrls(s, c);
    clipPanes(s, c);
    // Your own file placed at a position of the screen (L2.12: a corner, a side) keeps clear of what the viewer looks
    // at — the boxes of its step and of the steps that come while it shows, around the cursor (stepBoxes) — in the
    // framing of THIS variant (a vertical crop puts a corner over a list that a landscape frame leaves free): the
    // nearest free position of the same kind, else where it was asked, with a note naming what it covers.
    for (const use of seg.overlays) overlays.placeScreenOverlay(entry, seg, use, rel);
    clipTiming(s, c, out);
    clipMarkers(s, c, out);
  });
  return out;
}

/** Captions: the scene caption from the first visible frame; step captions replace it from their output start. */
function clipCaptions(c: ClipPass, out: ClipDetails): void {
  const { seg, entry, F, cueEnd, rel } = c;
  if (!seg.caption) return;
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
  const kept = cues.filter((x) => x.to > x.from);
  out.captions.push(...kept);
  seg.cues = kept.map((x, j) => ({ ...x, from: x.from - F, to: j === kept.length - 1 ? seg.durationInFrames : x.to - F }));
}

/**
 * Overlays from step `overlay` modifiers (resolved by stepOverlayOf: the reframe already asked for them), shown from
 * their start (`at`; default: the step's output end).
 */
function clipStepOverlays(s: PlanScope, c: ClipPass, overlays: StepOverlays): void {
  const { warnings, notes, outFps, fr, planShape, mainSource } = s;
  const { seg, entry, n, rel } = c;
  for (const ev of entry.events) {
    if (!ev.overlay || ev.step < 0) continue;
    const o = ev.overlay;
    const so = overlays.stepOverlayOf(entry, ev);
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
      use.box = overlays.overlayBox(o, rc, page, where);
      use.layer = 'screen';
    }
    seg.overlays.push(use);
  }
}

/**
 * Tutorial overlays (L2.10): the spotlight is drawn over the capture, under everything else; badges, loupe and key
 * caps under the scenario's own step overlays.
 */
function clipTutorialOverlays(s: PlanScope, c: ClipPass): void {
  const { tutorialOn, planShape, cssW, cssH, stateOf, videoBadges, outFps, tutorialResolve, resolver, tutorial } = s;
  const { seg, entry, rel, n, F } = c;
  if (!tutorialOn) return;
  // A multi-page clip plans each page's overlays on its own page (its events, its size) — in that page's pane.
  const groups = seg.panes
    ? seg.panes.map((p, i) => ({
        pane: i,
        events: entry.events.filter((ev) => ev.step < 0 || ev.page === p.page),
        css: { w: paneSource(planShape, p).cssWidth, h: paneSource(planShape, p).cssHeight },
      }))
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

/**
 * Overlays keep clear of what the viewer is about to look at (L2.11 polish): the targets of the step they belong to
 * and of the next click step(s) — key caps take the other row, a lens or a badge another side.
 */
function clipClearAreas(c: ClipPass): void {
  const { seg, entry, rel } = c;
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
}

/** Provenance: which step produced each output frame (held frames belong to the last step). */
function clipProvenance(s: PlanScope, c: ClipPass): void {
  const { srcFps } = s;
  const { seg, entry } = c;
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
}

/**
 * URLs (browser chrome) along the clip: of the main capture, or of each page's track — as the video shows them (L1.7):
 * display URLs; a local one is kept hidden, and a layout that would draw it gets a plan warning.
 */
function clipUrls(s: PlanScope, c: ClipPass): void {
  const { timelineTracks, srcFps, addressOf, warnHiddenUrl, timeline } = s;
  const { seg, entry } = c;
  if (seg.panes) {
    seg.panes.forEach((pane, p) => {
      const tr = timelineTracks.get(pane.track);
      const scenePage = entry.pages?.find((x) => x.id === pane.page);
      seg.srcFrames.forEach((f, k) => {
        const url = (tr ? trackUrlAt(tr, f / srcFps) : undefined) ?? scenePage?.url;
        if (url) pushAddress(pane.urls, k, addressOf(url));
      });
      if (drawsUrl(seg, p)) for (const u of pane.urls) if (u.hidden) warnHiddenUrl(u.url);
    });
  } else {
    seg.srcFrames.forEach((f, k) => {
      const url = pageAt(timeline, f / srcFps)?.url ?? entry.scene.url;
      if (url) pushAddress(seg.urls, k, addressOf(url));
    });
    if (drawsUrl(seg)) for (const u of seg.urls) if (u.hidden) warnHiddenUrl(u.url);
  }
}

/** Multi-page clips (L2.11): the acting page over time, and where a picture-in-picture inset sits. */
function clipPanes(s: PlanScope, c: ClipPass): void {
  const { outFps, planShape, unit, notes } = s;
  const { seg, entry, rel, n, drafts, i } = c;
  if (!seg.panes) return;
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

/** Speeds, trims, zooms and the time map of the clip; a static camera is dropped. */
function clipTiming(s: PlanScope, c: ClipPass, out: ClipDetails): void {
  const { srcFps, outFps, cssW, cssH } = s;
  const { seg, entry, run, k0, n, F, d } = c;
  const { timemap } = out;
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
  seg.trims = run.cuts.filter((x) => x.clip === d.clip.index).map((x): TrimSpan => ({ at: x.at - k0, src_from_s: round(x.a / srcFps), src_to_s: round(x.b / srcFps), reason: x.reason }));
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
}

/** The timeline's markers of the clip's scene, in output frames (and the frame of their `done` screen). */
function clipMarkers(s: PlanScope, c: ClipPass, out: ClipDetails): void {
  const { timeline } = s;
  const { entry, run, k0, k1, F } = c;
  for (const mk of timeline.markers) {
    if (mk.scene !== entry.scene.id) continue;
    const k = outFrameAt(run, mk.t);
    if (k < k0 || k >= k1) continue;
    // `done`: the screen once the marked step is done (a marked wait's awaited state), inside this clip.
    const kd = clamp(outFrameAt(run, markDoneAt(timeline, mk)), k, k1 - 1);
    // The marked step itself: a satisfied wait lasts less than one capture frame and owns no span of `steps`.
    const ev = entry.events.find((e) => e.step === mk.step);
    out.markers.push({
      name: mk.name,
      frame: F + (k - k0),
      scene: mk.scene,
      done: F + (kd - k0),
      step: mk.step,
      ...(ev?.id ? { step_id: ev.id } : {}),
      ...(ev ? { action: ev.action } : {}),
    });
  }
}

function captionText(c: { kicker?: string; text: string }): { kicker?: string; text: string } {
  return c.kicker !== undefined ? { kicker: c.kicker, text: c.text } : { text: c.text };
}
