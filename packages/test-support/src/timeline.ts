/**
 * Timelines and the repository's own material for the tests of every package: the two real fixture timelines (the
 * editor's test fixtures, read by path), the starter themes and the fixture project as loaded, and a builder of
 * synthetic timelines.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, loadTemplate, fileFacts } from '@retake/core/io';
import type { LoadedProject, LoadedTemplate, Timeline, TimelineEvent, TimelineScene } from '@retake/core';
import { PERSON_POLICY } from '@retake/core';
import { REPO } from './repo.js';

/** The editor's test fixtures (the two real timelines among them), with a trailing slash. */
export const FIXTURES = fileURLToPath(new URL('../../editor/test/fixtures/', import.meta.url));

const templates: Record<string, LoadedTemplate> = {};
export async function template(name: 'editorial' | 'motion' | 'default'): Promise<LoadedTemplate> {
  templates[name] ??= await loadTemplate(name, REPO, { files: fileFacts(PERSON_POLICY) });
  return templates[name];
}

export async function fixtureProject(): Promise<LoadedProject> {
  return loadProject('northfield-fixture', REPO);
}

export function realTimeline(name: 'catalogue' | 'quote'): Timeline {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
}

// ── Synthetic timelines ──────────────────────────────────────────────────────

export interface SceneSpec {
  id: string;
  /** Capture seconds. */
  t_start: number;
  t_end: number;
  /** Page load [t_start, open_end) (a scene that opens a page). */
  open_end?: number;
  /** Opening still [still_start, still_end). */
  still?: [number, number];
  speed?: number;
  page?: string;
  url?: string;
  caption?: { kicker?: string; text: string };
  transition?: TimelineScene['transition'];
  frame?: string;
  /** Steps: action + times; `hold` = seconds after t_end. */
  steps?: Array<Partial<TimelineEvent> & { action: TimelineEvent['action']; t_start: number; t_end: number; holdS?: number }>;
}

export type EntrySpec = SceneSpec | { card: { id: string; slots?: Record<string, string>; duration?: number; component?: string } } | { interstitial: { id: string; text: string; duration?: number } };

/**
 * A timeline of `duration` seconds at `fps` with the given scenes (in order), idle intervals and cursor track.
 * Pages: one segment per scene url (a scene without `open_end` continues the previous page).
 */
export function synthTimeline(opts: {
  entries: EntrySpec[];
  duration: number;
  fps?: number;
  idle?: Array<[number, number]>;
  cursor?: Array<[number, number, number]>;
  video?: Timeline['video'];
  markers?: Timeline['markers'];
}): Timeline {
  const fps = opts.fps ?? 30;
  const scenes: TimelineScene[] = [];
  const events: TimelineEvent[] = [];
  const markers: Timeline['markers'] = [...(opts.markers ?? [])];
  const pages: Timeline['pages'] = [];
  let lastT = 0;
  opts.entries.forEach((e, index) => {
    if ('card' in e) {
      scenes.push({
        id: e.card.id,
        index,
        kind: 'card',
        t_start: lastT,
        t_end: lastT,
        card: { ...(e.card.slots ? { slots: e.card.slots } : {}), ...(e.card.duration ? { duration: e.card.duration } : {}), ...(e.card.component ? { component: e.card.component } : {}) },
        status: 'ok',
      });
      return;
    }
    if ('interstitial' in e) {
      scenes.push({
        id: e.interstitial.id,
        index,
        kind: 'interstitial',
        t_start: lastT,
        t_end: lastT,
        interstitial: { text: e.interstitial.text, ...(e.interstitial.duration ? { duration: e.interstitial.duration } : {}) },
        status: 'ok',
      });
      return;
    }
    const s = e;
    const url = s.url ?? `http://app.test/${s.id}`;
    const page = s.page ?? 'app';
    scenes.push({
      id: s.id,
      index,
      kind: 'scene',
      t_start: s.t_start,
      t_end: s.t_end,
      ...(s.still ? { t_actions: s.still[1] } : {}),
      page,
      url,
      status: 'ok',
      ...(s.caption ? { caption: s.caption } : {}),
      ...(s.speed !== undefined ? { speed: s.speed } : {}),
      ...(s.transition ? { transition: s.transition } : {}),
      ...(s.frame ? { frame: s.frame } : {}),
    });
    if (s.open_end !== undefined) {
      events.push({ scene: s.id, scene_index: index, step: -1, action: 'scene_open', t_start: s.t_start, t_end: s.open_end, status: 'ok', page, url });
      pages.push({ id: page, t_start: s.t_start, t_end: s.t_end, url });
    } else if (pages.length === 0) {
      pages.push({ id: page, t_start: s.t_start, t_end: s.t_end, url });
    } else {
      pages[pages.length - 1].t_end = s.t_end;
    }
    if (s.still) events.push({ scene: s.id, scene_index: index, step: -1, action: 'scene_still', t_start: s.still[0], t_end: s.still[1], status: 'ok' });
    (s.steps ?? []).forEach((st, i) => {
      const { holdS, ...rest } = st;
      const ev: TimelineEvent = { scene: s.id, scene_index: index, step: i, status: 'ok', page, url, ...rest } as TimelineEvent;
      if (holdS) ev.hold = { t_start: st.t_end, t_end: st.t_end + holdS };
      if (st.action === 'hold') ev.hold = { t_start: st.t_start, t_end: st.t_end };
      if (st.mark) markers.push({ name: st.mark, t: st.t_start, scene: s.id, step: i });
      events.push(ev);
    });
    lastT = s.t_end;
  });
  return {
    version: 1,
    run_id: 'synthetic',
    project: 'test',
    scenario: 'synthetic',
    created_at: '2026-01-01T00:00:00.000Z',
    mode: 'capture',
    capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps, duration: opts.duration, t0_wall: 0, frames: Math.round(opts.duration * fps) },
    video: opts.video ?? { title: { kicker: 'Kicker', text: 'Synthetic video' }, frame: 'card', template: 'editorial' },
    scenes,
    events,
    markers,
    pages,
    cursor: (opts.cursor ?? [[0, 960, 540]]).map(([t, x, y]) => ({ t, x, y, visible: true })),
    idle: (opts.idle ?? []).map(([a, b]) => ({ t_start: a, t_end: b })),
    warnings: [],
  };
}
