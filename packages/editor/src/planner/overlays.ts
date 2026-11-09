/**
 * The step overlays of `planEdit` (a step's `overlay` modifier): each resolved once, when it starts and how long it
 * shows, the box a box-filling overlay fills (L2.12), what the reframe of a vertical / square clip keeps in view for
 * it, and where a file placed at a position of the screen goes so it keeps clear of the steps' targets.
 */
import { MEDIA_COMPONENTS } from '@retake/core';
import type { OverlayAnchor, TimelineEvent } from '@retake/core';
import type { ClipSegment, OverlayUse, PlanSource, ResolvedComponent } from '../plan-types.js';
import type { Candidate } from '../resolve.js';
import { mapUseRect, overlayBoxAt } from '../remotion/frames.js';
import { stepBoxes } from '../panes.js';
import { outFrameAt } from '../timing.js';
import { round, secs, stepEnd } from '../util.js';
import { CLEAR_LOOKAHEAD_S, SCREEN_POSITION_CHOICES } from './rules.js';
import type { ClipEntry, PlanScope, RunOf } from './scope.js';
import { centre, overlayStartAt } from './targets.js';
import type { OverlayKeep } from './targets.js';

/**
 * A step overlay resolved: its component, when it starts (capture s: `at`, or when its notification showed), how long
 * it shows (output s; undefined: a looped file, to the clip's end) and the box of its page the reframe keeps in view (a
 * `rect`, a file's box on the target / the cursor, what a callout points at; nothing for a file placed on the screen —
 * it follows the view).
 */
export type StepOverlay = { rc: ResolvedComponent; where: string; tAt: number; seconds?: number; keep?: { x: number; y: number; w: number; h: number } };

export interface StepOverlays {
  /** The step overlay of `ev` in clip `entry`, resolved once — the reframe asks for it before the clip's overlays are drawn. */
  stepOverlayOf: (entry: ClipEntry, ev: TimelineEvent) => StepOverlay | null;
  /** The reframe's keep of a step overlay of clip `entry`: its box over the capture time it shows. */
  overlayKeepOf: (entry: ClipEntry) => (ev: TimelineEvent) => OverlayKeep | null;
  overlayBox: (o: NonNullable<TimelineEvent['overlay']>, rc: ResolvedComponent, page: PlanSource, where: string) => NonNullable<OverlayUse['box']>;
  /** Your own file placed at a position of the screen: moved to the nearest free position of the same kind. */
  placeScreenOverlay: (entry: ClipEntry, seg: ClipSegment, use: OverlayUse, rel: (t: number) => number) => void;
}

/** The natural length (s) of a use's file (L2.12): a video's part, a Lottie animation; undefined otherwise. */
export function fileLength(rc: ResolvedComponent | null | undefined, outFps: number): number | undefined {
  const m = rc?.media?.file;
  if (!m) return undefined;
  if (m.kind === 'lottie') return m.duration_s;
  if (m.kind !== 'video') return undefined;
  const from = typeof rc!.params.from === 'number' ? rc!.params.from : 0;
  const to = typeof rc!.params.to === 'number' ? rc!.params.to : m.duration_s;
  return Math.max(1 / outFps, Math.min(to, m.duration_s) - from);
}

export function planStepOverlays(s: PlanScope, runOf: RunOf): StepOverlays {
  const { notes, warnings, timeline, resolver, kindOverride, themeAndBuiltin, slotBase, findArtefact, trackSources, mainSource, outFps, srcFps, fr, planShape, variant } = s;
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
        const len = fileLength(rc, outFps);
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
  return { stepOverlayOf, overlayKeepOf, overlayBox, placeScreenOverlay };
}
