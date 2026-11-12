/**
 * Test helpers of the planner: a temp workspace whose components/studio/* are created from the scaffolds
 * (createComponent) with the params the starter themes pass — the planner tests do not depend on the built-in library
 * (placeholders since L2.4, replaced in L2.5/L2.7: builtinDir null) —, the real templates and fixture project of the
 * repo, the two real fixture timelines and a builder of synthetic timelines.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, loadTemplate, fileFacts } from '@retake/core/io';
import type { ComponentKind, LoadedProject, LoadedTemplate, Timeline, TimelineEvent, TimelineScene } from '@retake/core';
import { createComponent, loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { planEdit } from '@retake/editor';
import type { ClipSegment, EditOverrides, EditPlan, PlanSegment } from '@retake/editor';
import { PERSON_POLICY } from '@retake/core';

/** The scaffold's writer in these tests: plain files (the engine's project store in the CLI and the engine). */
const plainWrite = async (file: string, text: string): Promise<void> => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
};

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** The studio/* ids the starter themes refer to, created from the scaffold of their kind. */
export const STUDIO_COMPONENTS: Array<[string, ComponentKind]> = [
  ['studio/intro-stack', 'intro'],
  ['studio/intro-minimal', 'intro'],
  ['studio/outro-stack', 'outro'],
  ['studio/outro-minimal', 'outro'],
  ['studio/card-title', 'card'],
  ['studio/interstitial-clock', 'interstitial'],
  ['studio/interstitial-plain', 'interstitial'],
  ['studio/layout-card', 'layout'],
  ['studio/layout-browser', 'layout'],
  ['studio/layout-raw', 'layout'],
  ['studio/caption-below', 'caption'],
  ['studio/caption-overlay', 'caption'],
  ['studio/overlay-callout', 'overlay'],
  ['studio/transition-crossfade', 'transition'],
  ['studio/transition-fade-black', 'transition'],
];

/** Params the starter themes pass that the scaffolds do not declare (the built-in library declares them). */
const EXTRA_PARAMS: Record<string, string[]> = {
  'studio/layout-card': ['    width: {type: number, minimum: 400, maximum: 1920, default: 1560}'],
  'studio/intro-minimal': ['    logo_only: {type: boolean, default: false}'],
  'studio/outro-minimal': ['    logo_only: {type: boolean, default: false}'],
  'studio/caption-below': ['    position: {type: string, enum: [below, above], default: below}'],
  'studio/transition-crossfade': ['    duration: {type: number, minimum: 0, maximum: 3, default: 0.35}'],
  'studio/transition-fade-black': ['    duration: {type: number, minimum: 0, maximum: 3, default: 0.4}'],
};

export interface Workspace {
  root: string;
  registry: ComponentRegistry;
  cleanup: () => Promise<void>;
}

/**
 * A temp workspace with components/studio/* scaffolded; `patch` edits a component.yaml after creation, `extra` adds
 * components (other ids, from the scaffold of their kind), `omit` leaves studio/* ids out.
 */
export async function studioWorkspace(patch: Record<string, (yaml: string) => string> = {}, opts: { extra?: Array<[string, ComponentKind]>; omit?: string[] } = {}): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'retake-editor-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  const componentsDir = join(root, 'components');
  const all = [...STUDIO_COMPONENTS.filter(([id]) => !(opts.omit ?? []).includes(id)), ...(opts.extra ?? [])];
  for (const [id, kind] of all) {
    const created = await createComponent(root, { write: plainWrite, id, kind, componentsDir, builtinDir: null, description: `Test stand-in for ${id}.` });
    const file = join(created.dir, 'component.yaml');
    let yaml = await readFile(file, 'utf8');
    const extra = EXTRA_PARAMS[id];
    if (extra) yaml = yaml.replace(/^  properties:\n/m, `  properties:\n${extra.join('\n')}\n`);
    if (kind === 'transition') {
      // A transition is a crossfade unless it dips through a colour (the fade-black one dips through the text colour).
      yaml = yaml.replace(
        /through: \{type: string, enum: \[none, paper, text, accent\], default: none/,
        `through: {type: string, enum: [none, paper, text, accent], default: ${id.endsWith('fade-black') ? 'text' : 'none'}`,
      );
    }
    if (patch[id]) yaml = patch[id](yaml);
    await writeFile(file, yaml);
  }
  const registry = await loadComponentRegistry({ root, componentsDir, builtinDir: null });
  return { root, registry, cleanup: () => rm(root, { recursive: true, force: true }) };
}

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

export function clips(plan: EditPlan): ClipSegment[] {
  return plan.segments.filter((s): s is ClipSegment => s.kind === 'clip');
}

export function seg(plan: EditPlan, id: string): PlanSegment {
  const s = plan.segments.find((x) => x.id === id);
  if (!s) throw new Error(`no segment ${id} in ${plan.segments.map((x) => x.id).join(', ')}`);
  return s;
}

export function clip(plan: EditPlan, id: string): ClipSegment {
  const s = seg(plan, id);
  if (s.kind !== 'clip') throw new Error(`${id} is a ${s.kind}`);
  return s;
}

export interface PlanContext {
  ws: Workspace;
  project: LoadedProject;
  editorial: LoadedTemplate;
}

export function plan(ctx: PlanContext, timeline: Timeline, overrides?: EditOverrides, tpl?: LoadedTemplate): EditPlan {
  return planEdit({
    timeline,
    template: tpl ?? ctx.editorial,
    project: ctx.project,
    registry: ctx.ws.registry,
    captureFile: '/captures/capture.mp4',
    overrides,
  });
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
