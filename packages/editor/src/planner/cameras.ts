/**
 * A step of `planEdit`: the camera of each run — the zoom moves of the steps' camera hints and the theme's default
 * zoom (R-ED-22), as a per-frame camera track; a multi-page run (L2.11) has one camera per page.
 */
import type { Timeline } from '@retake/core';
import { MIN_ZOOM_EASE_S, cameraTrack, hintEase } from '../camera.js';
import type { ZoomMove } from '../camera.js';
import type { CameraFrame } from '../plan-types.js';
import { outFrameAt } from '../timing.js';
import type { RunTiming } from '../timing.js';
import { clamp, cursorAt, round, secs, stepEnd } from '../util.js';
import { DEFAULT_ZOOM } from './rules.js';
import type { ClipEntry, PlanScope, RunOf } from './scope.js';
import { centre } from './targets.js';

export type RunCamera = { track: CameraFrame[]; moves: ZoomMove[] };
/** The camera of each run (a multi-page run's: one per page, by page id). */
export type RunCameras = Map<RunTiming, RunCamera & { pages?: Map<string, RunCamera> }>;

/** The camera of every run, with notes on clamped, unused and disabled zooms. */
export function planCameras(s: PlanScope, runs: ClipEntry[][], runOf: RunOf): RunCameras {
  const { t, ov, notes, outFps, timeline, timelineTracks, cssW, cssH } = s;
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
  // Multi-page runs (L2.11): one camera per page (its own steps' hints and theme zoom, on its own page size).
  const camByRun: RunCameras = new Map();
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
  return camByRun;
}
