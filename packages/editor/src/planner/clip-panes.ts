/**
 * The panes of a multi-page clip (L2.11), for the segments step of `planEdit`: the layout's geometry evaluated with
 * both pages' aspects, each page's output rect (split: top-aligned in its pane; picture in picture: the main page in
 * `screen`, the other in `inset`), its camera (its own steps' zooms; none in an inset), its reframe in vertical /
 * square, its URLs.
 */
import type { TimelineScenePage } from '@retake/core';
import { GEOMETRY_KEYS, evalLayoutGeometry, isMultiPaneGeometry } from '@retake/components';
import type { LayoutGeometry } from '@retake/components';
import { cameraTrack, clampView, reframeTrack } from '../camera.js';
import { geometryOutside } from '../layout.js';
import { INSET_GROW, cornerOf, planPaneLayout } from '../panes.js';
import type { CameraFrame, PlanInset, PlanLayout, PlanPane, ResolvedComponent, ZoomSpan } from '../plan-types.js';
import type { RunTiming } from '../timing.js';
import { tutorialReframeTargets } from '../tutorial.js';
import { round } from '../util.js';
import type { RunCamera, RunCameras } from './cameras.js';
import type { StepOverlays } from './overlays.js';
import type { ClipEntry, PlanScope } from './scope.js';
import { reframeTargets } from './targets.js';

export type PlanPanes = (e: ClipEntry, rc: ResolvedComponent, where: string, r: { run: RunTiming; entries: ClipEntry[] }, range: { k0: number; k1: number }) => { layout: PlanLayout; panes: PlanPane[]; inset?: PlanInset } | null;

/** The planner of multi-page clips (the reframe of a page is planned once per run and page). */
export function panePlanner(s: PlanScope, camByRun: RunCameras, overlays: Pick<StepOverlays, 'overlayKeepOf'>): PlanPanes {
  const { resolver, variant, warnings, notes, trackSources, unit, timelineTracks, tutorialOn, stateOf, srcFps, outFps, t } = s;
  const { overlayKeepOf } = overlays;
  const paneReframeByRun = new Map<string, Array<[number, number]>>();
  let runKeys = 0;
  const runKey = new Map<RunTiming, number>();
  return (e, rc, where, r, range) => {
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
    const sc = (x: { x: number; y: number; w: number; h: number }) => ({ x: round(x.x * unit, 3), y: round(x.y * unit, 3), w: round(x.w * unit, 3), h: round(x.h * unit, 3) });
    const layout: PlanLayout = { capture: sc(g.screen), card: sc(g.screen), radius: round(radius * unit, 3) };
    if (g.caption) layout.caption = sc(g.caption);
    if (g.brandmark) layout.brandmark = sc(g.brandmark);
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
        paneLayout.capture = sc(rect);
        paneLayout.card = sc(rect);
        delete paneLayout.crop;
      }
      const pc: RunCamera | undefined = camRun.pages?.get(pg.id);
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
  };
}
