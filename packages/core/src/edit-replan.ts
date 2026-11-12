/**
 * The edit of today's scenario on an existing take (L5.5, R-FLD-01). When the filmed part of a scenario is unchanged
 * since a run (core filmedChanges), a render re-plans the edit from today's file: this module rewrites the run's
 * timeline — the planner's only input — with today's edit values on the run's measurements.
 *
 * Kept from the take: every capture time (scenes, steps, holds, clicks), the cursor, the pages, the target boxes the
 * runner measured, the artefacts (mails, documents, notifications, texts), the tracks, the environment.
 * From today's file: title, intro / outro, frame, template, music, tutorial switches, target length, the caption
 * component (L4.5); the cards and interstitials and their place between the scenes; each scene's caption, speed,
 * transition, frame, tutorial switches, page labels and `offscreen` (L5.8); each step's caption, speed, tutorial
 * switches, id, mark (the markers are rebuilt on the steps' start times), overlay and camera hint.
 *
 * A value equal to the run's snapshot keeps the timeline's (templated at capture: `{{hooks.…}}` resolved then). A
 * changed value is templated now with the edit context (display URLs, vars, run); a token only the take knew
 * (`{{hooks.…}}`, a secret) keeps the captured value with a warning. An overlay or camera hint names its target: the
 * same target as the take measured reuses that box; none (the default) uses the step's target box, else the cursor at
 * the end of the step (`end_point`, L5.5); a target the take never measured falls back to the step's with a warning.
 */
import { canonicalJson } from './canonical-json.js';
import { overlayUseOf } from './media.js';
import { scenePageEntries } from './pages.js';
import { sceneId } from './steps.js';
import { describeTarget } from './targets.js';
import { interpolateAt, TemplateError } from './templating.js';
import type { TemplateContext } from './templating.js';
import { isCaptureScene, isCard, isInterstitial } from './types.js';
import type {
  BBox,
  CaptionSpec,
  CameraHint,
  OverlaySpec,
  ProjectConfig,
  Scenario,
  Scene,
  Step,
  TargetSpec,
  Timeline,
  TimelineEvent,
  TimelineMarker,
  TimelineScene,
  TimelineVideo,
} from './types.js';
import { timelineVideo } from './video.js';

export interface ReplanEditInput {
  /** The run's timeline (not changed). */
  timeline: Timeline;
  /** Today's scenario (parsed and valid). */
  now: Scenario;
  /** The run's snapshot (parsed). */
  then: Scenario;
  project: Pick<ProjectConfig, 'frame' | 'template'>;
  /** The template context of the text the video shows (display URLs, vars, run). */
  ctx: TemplateContext;
}

export interface ReplanEditResult {
  timeline: Timeline;
  /** What today's edit changed against the run's (keys, scene ids, step keys): empty when nothing did. */
  changes: string[];
  warnings: string[];
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function captionOf(c: CaptionSpec | undefined): { kicker?: string; text: string } | undefined {
  if (c === undefined) return undefined;
  return typeof c === 'string' ? { text: c } : { ...c };
}

function isPointSpec(t: unknown): t is { x: number; y: number } {
  return t !== null && typeof t === 'object' && typeof (t as { x?: unknown }).x === 'number' && typeof (t as { y?: unknown }).y === 'number' && !('selector' in (t as object));
}

/** Rewrite a run's timeline with today's edit (see the module comment). Pure. */
export function replanEdit(input: ReplanEditInput): ReplanEditResult {
  const { now, then, ctx } = input;
  const src = input.timeline;
  const changes: string[] = [];
  const warnings: string[] = [];
  /** A changed edit value templated now; `keep` when a token only the take knew is in it. */
  const tpl = <T>(value: T, path: (string | number)[], keep: T, where: string): T => {
    try {
      return interpolateAt(value, ctx, path);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      warnings.push(`${where}: ${e.message} — a value known only during the take: the captured text is kept (capture again to change it)`);
      return keep;
    }
  };

  // ── Video ───────────────────────────────────────────────────────────────────
  // A run made before L2.1 has no video block: the snapshot's (the planner reads it from there for such a run).
  const video: TimelineVideo = { ...(src.video ?? timelineVideo(then, input.project)) };
  const vNow = timelineVideo(now, input.project);
  for (const k of ['title', 'intro', 'outro', 'music', 'tutorial'] as const) {
    if (same(now[k], then[k])) continue;
    changes.push(k);
    if (vNow[k] === undefined) delete video[k];
    else (video as Record<string, unknown>)[k] = k === 'music' ? vNow[k] : tpl(vNow[k], [k], src.video?.[k], k);
  }
  if (!same(now.frame, then.frame)) {
    changes.push('frame');
    video.frame = vNow.frame;
  }
  if (!same(now.template, then.template)) {
    changes.push('template');
    video.template = now.template ?? input.project.template;
  }
  if (now.target_length !== undefined) video.target_length = { ...now.target_length };
  else delete video.target_length;
  if (!same(now.target_length, then.target_length)) changes.push('target_length');
  if (now.caption_component !== undefined) video.caption_component = now.caption_component;
  else delete video.caption_component;
  if (!same(now.caption_component, then.caption_component)) changes.push('caption_component');

  // ── Scenes, cards, interstitials in today's order ───────────────────────────
  const thenEntries = then.scenes.map((e, i) => ({ e, id: sceneId(e, i) }));
  const thenScene = (id: string): Scene | undefined => then.scenes.find((e): e is Scene => isCaptureScene(e) && e.id === id);
  const captured = new Map(src.scenes.filter((s) => s.kind === 'scene').map((s) => [s.id, s]));
  const nowCapture = now.scenes.filter(isCaptureScene);
  // A take that stopped early (--until) holds the first scenes only: today's entries after its last one are left out.
  const complete = nowCapture.every((s) => captured.has(s.id));
  const lastCaptured = complete ? now.scenes.length - 1 : now.scenes.findLastIndex((e) => isCaptureScene(e) && captured.has(e.id));
  const scenes: TimelineScene[] = [];
  const usedThen = new Set<number>();
  let tPrev = 0;
  const nowCards = now.scenes.map((e, i) => (isCaptureScene(e) ? null : canonicalJson({ ...e, id: sceneId(e, i) })));
  const thenCards = then.scenes.map((e, i) => (isCaptureScene(e) ? null : canonicalJson({ ...e, id: sceneId(e, i) })));
  if (!same(nowCards.filter(Boolean), thenCards.filter(Boolean))) changes.push('cards and interstitials');
  // Labels of the pages of multi-page scenes as today's file declares them (a later scene inherits a page's label).
  const labels = new Map<string, string>();
  for (let si = 0; si <= lastCaptured; si++) {
    const entry = now.scenes[si];
    if (!isCaptureScene(entry)) {
      const id = sceneId(entry, si);
      // The same card as the run's (same data, same id) keeps its templated value; else today's, templated now.
      const k = thenEntries.findIndex((t, j) => !usedThen.has(j) && !isCaptureScene(t.e) && t.id === id && same(t.e, entry));
      const prev = k >= 0 ? src.scenes.find((s) => s.id === id && s.kind !== 'scene') : undefined;
      if (k >= 0) usedThen.add(k);
      const t = tPrev;
      if (isInterstitial(entry)) {
        const value = prev?.interstitial ?? tpl(entry.interstitial, ['scenes', si, 'interstitial'], { ...entry.interstitial, text: '' }, `interstitial "${id}"`);
        scenes.push({ id, index: si, kind: 'interstitial', t_start: t, t_end: t, interstitial: structuredClone(value), status: 'ok' });
      } else if (isCard(entry)) {
        const value = prev?.card ?? tpl(entry.card, ['scenes', si, 'card'], {}, `card "${id}"`);
        scenes.push({ id, index: si, kind: 'card', t_start: t, t_end: t, card: structuredClone(value), status: 'ok' });
      }
      continue;
    }
    const ts = captured.get(entry.id);
    if (!ts) continue;
    const old = thenScene(entry.id);
    const out: TimelineScene = { ...structuredClone(ts), index: si };
    const where = `scene "${entry.id}"`;
    if (!same(entry.caption, old?.caption)) {
      changes.push(`caption of ${entry.id}`);
      const c = captionOf(entry.caption);
      if (c) out.caption = tpl(c, ['scenes', si, 'caption'], ts.caption ?? c, `the caption of ${where}`);
      else delete out.caption;
    }
    for (const k of ['speed', 'transition', 'frame', 'tutorial'] as const) {
      if (same(entry[k], old?.[k])) continue;
      changes.push(`${k} of ${entry.id}`);
      if (entry[k] === undefined) delete out[k];
      else (out as unknown as Record<string, unknown>)[k] = k === 'speed' || k === 'frame' ? entry[k] : tpl(structuredClone(entry[k]), ['scenes', si, k], ts[k], `the ${k} of ${where}`);
    }
    // Off camera (L5.8): the take played it either way; today's file says whether the video shows it.
    if (!same(entry.offscreen === true, old?.offscreen === true)) changes.push(`offscreen of ${entry.id}`);
    if (entry.offscreen === true) out.offscreen = true;
    else delete out.offscreen;
    for (const p of scenePageEntries(entry.pages)) if (p.spec.label !== undefined) labels.set(p.id, p.spec.label);
    if (out.pages) {
      for (const pg of out.pages) {
        const label = labels.get(pg.id);
        const before = ts.pages?.find((x) => x.id === pg.id)?.label;
        if (label === undefined) delete pg.label;
        else if (!same(label, scenePageEntries(old?.pages).find((x) => x.id === pg.id)?.spec.label) || before === undefined) {
          pg.label = tpl(label, ['scenes', si, 'pages', pg.id, 'label'], before ?? label, `the label of page ${pg.id} of ${where}`);
        }
      }
      if (!same(scenePageEntries(entry.pages).map((p) => p.spec.label), scenePageEntries(old?.pages).map((p) => p.spec.label))) changes.push(`page labels of ${entry.id}`);
    }
    scenes.push(out);
    tPrev = ts.t_end;
  }
  // Scenes the take recorded that today's order does not reach (never: the filmed part is the same) stay out.

  // ── Steps ──────────────────────────────────────────────────────────────────
  const events: TimelineEvent[] = [];
  const markers: TimelineMarker[] = [];
  const sceneOf = new Map(nowCapture.map((s) => [s.id, s]));
  const multiPage = new Set(src.scenes.filter((s) => s.pages && s.pages.length > 0).map((s) => s.id));
  for (const ev0 of src.events) {
    const ev: TimelineEvent = structuredClone(ev0);
    events.push(ev);
    if (ev.step < 0) continue;
    const scene = sceneOf.get(ev.scene);
    const step: Step | undefined = scene?.steps?.[ev.step];
    if (!scene || !step) continue;
    const before: Step | undefined = thenScene(ev.scene)?.steps?.[ev.step];
    const key = `${ev.scene}.${ev.step}`;
    const si = now.scenes.indexOf(scene);
    const path = (k: string): (string | number)[] => ['scenes', si, 'steps', ev.step, k];
    if (!same(step.caption, before?.caption)) {
      changes.push(`caption of ${key}`);
      const c = captionOf(step.caption);
      if (c) ev.caption = tpl(c, path('caption'), ev0.caption ?? c, `the caption of step ${key}`);
      else delete ev.caption;
    }
    if (!same(step.speed, before?.speed)) {
      changes.push(`speed of ${key}`);
      if (step.speed === undefined) delete ev.speed;
      else ev.speed = step.speed;
    }
    if (!same(step.tutorial, before?.tutorial)) {
      changes.push(`tutorial of ${key}`);
      if (step.tutorial === undefined) delete ev.tutorial;
      else ev.tutorial = tpl(structuredClone(step.tutorial), path('tutorial'), ev0.tutorial ?? structuredClone(step.tutorial), `the tutorial switches of step ${key}`);
    }
    if (step.id === undefined) delete ev.id;
    else ev.id = step.id;
    if (!same(step.mark, before?.mark)) changes.push(`mark of ${key}`);
    if (step.mark === undefined) delete ev.mark;
    else {
      ev.mark = step.mark;
      const kept = src.markers.find((m) => m.scene === ev.scene && m.step === ev.step && m.name === step.mark);
      markers.push(kept ? { ...kept } : { name: step.mark, t: ev.t_start, scene: ev.scene, step: ev.step, ...(multiPage.has(ev.scene) && ev.page ? { page: ev.page } : {}) });
    }
    if (!same(step.overlay, before?.overlay)) {
      changes.push(`overlay of ${key}`);
      if (step.overlay === undefined) delete ev.overlay;
      else ev.overlay = overlayOn(ev0, step.overlay, before?.overlay, (v, k, keep) => tpl(v, [...path('overlay'), k], keep, `the overlay of step ${key}`), (w) => warnings.push(`step ${key}: ${w}`));
    }
    if (!same(step.camera, before?.camera)) {
      changes.push(`camera of ${key}`);
      if (step.camera === undefined) delete ev.camera;
      else ev.camera = cameraOn(ev0, step.camera, before?.camera, (w) => warnings.push(`step ${key}: ${w}`));
    }
  }
  // Markers of no step (none today) keep their place.
  for (const m of src.markers) if (m.step < 0) markers.push({ ...m });
  markers.sort((a, b) => a.t - b.t);

  const timeline: Timeline = { ...src, video, scenes, events, markers };
  return { timeline, changes: [...new Set(changes)], warnings };
}

/** The box and point the take measured for a step, as an anchor: its target box, else the cursor at its end. */
function stepAnchor(ev: TimelineEvent): { target?: string; bbox?: BBox; point?: { x: number; y: number } } {
  if (ev.target?.bbox) return { target: ev.target.desc, bbox: { ...ev.target.bbox } };
  const p = ev.end_point ?? ev.point;
  return p ? { point: { x: p.x, y: p.y } } : {};
}

/** A step overlay of today's file on the take's measurements (the runner's overlayFor, without a browser). */
function overlayOn(
  ev: TimelineEvent,
  spec: OverlaySpec,
  before: OverlaySpec | undefined,
  tpl: <T>(v: T, key: string, keep: T) => T,
  warn: (w: string) => void,
): NonNullable<TimelineEvent['overlay']> {
  const use = overlayUseOf(spec);
  const out: NonNullable<TimelineEvent['overlay']> = { component: use.component, slots: tpl(use.slots, 'slots', ev.overlay?.slots ?? use.slots), params: tpl(use.params, 'params', ev.overlay?.params ?? use.params) };
  if (spec.duration !== undefined) out.duration = spec.duration;
  if (spec.at !== undefined) out.at = spec.at;
  if (use.box) out.box = use.box;
  const measured = ev.overlay;
  if (spec.target !== undefined) {
    if (measured && before?.target !== undefined && same(spec.target, before.target)) {
      if (measured.target !== undefined) out.target = measured.target;
      if (measured.bbox) out.bbox = { ...measured.bbox };
      if (measured.point) out.point = { ...measured.point };
    } else {
      const a = stepAnchor(ev);
      out.target = a.target ?? describeTarget(spec.target);
      if (a.bbox) out.bbox = a.bbox;
      else if (a.point) out.point = a.point;
      warn(`the overlay names a target this take did not measure (${describeTarget(spec.target)}): it is anchored to ${a.bbox ? "the step's target" : 'the cursor at the end of the step'} — capture again to measure it`);
    }
  } else {
    const a = stepAnchor(ev);
    if (a.bbox) {
      out.target = a.target;
      out.bbox = a.bbox;
    } else if (a.point) out.point = a.point;
  }
  if (use.box?.anchor === 'cursor' && !out.point) {
    const p = ev.end_point ?? ev.point;
    if (p) out.point = { x: p.x, y: p.y };
  }
  return out;
}

/** A camera hint of today's file on the take's measurements (the runner's cameraFor, without a browser). */
function cameraOn(ev: TimelineEvent, hint: CameraHint, before: CameraHint | undefined, warn: (w: string) => void): NonNullable<TimelineEvent['camera']> {
  const cam: NonNullable<TimelineEvent['camera']> = { ...structuredClone(hint) };
  const t = hint.target;
  const end = ev.end_point ?? ev.point;
  if (t === undefined || t === 'step') {
    if (ev.target?.bbox) cam.bbox = { ...ev.target.bbox };
    else if (end) cam.point = { x: end.x, y: end.y };
  } else if (t === 'cursor') {
    if (end) cam.point = { x: end.x, y: end.y };
  } else if (isPointSpec(t)) {
    cam.point = { x: t.x, y: t.y };
  } else if (ev.camera && before?.target !== undefined && same(t, before.target) && (ev.camera.bbox || ev.camera.point)) {
    if (ev.camera.bbox) cam.bbox = { ...ev.camera.bbox };
    else if (ev.camera.point) cam.point = { ...ev.camera.point };
  } else {
    if (ev.target?.bbox) cam.bbox = { ...ev.target.bbox };
    else if (end) cam.point = { x: end.x, y: end.y };
    warn(`the camera hint names a target this take did not measure (${describeTarget(t as TargetSpec)}): it centres on ${ev.target?.bbox ? "the step's target" : 'the cursor'} — capture again to measure it`);
  }
  return cam;
}
