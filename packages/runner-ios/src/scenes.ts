/**
 * The scenes of an iOS take, as runner-web's scene loop records them (its timeline scenes and events, captions, marks,
 * holds, overlays and camera hints, `--until`, optional steps): cards and interstitials take no capture time, a
 * scene's `open` follows a deep link (scene_open), its still is filmed (scene_still), then its steps play one by one
 * (steps.ts) — each ends with the app still in front. A failed step leaves a picture of the device and the app's
 * element tree (the run's secrets masked) beside its error; an optional one is listed and the run goes on — unless the
 * driver did not answer in time (the app's state is then unknown).
 */
import { join } from 'node:path';
import { isCaptureScene, isCard, isInterstitial } from '@retake/core/language';
import { describeTarget, normalizeStep, overlayUseOf, sceneId, templateSceneEntry } from '@retake/core/language';
import { displayPages } from '@retake/core/environment';
import type { NormalizedStep, Scene, SceneEntry, TargetSpec } from '@retake/core/language';
import type { TimelineEvent, TimelineScene } from '@retake/core/run';
import type { DriverElement } from './driver-client.js';
import { DriverError } from './driver-client.js';
import { driverQuery } from './query.js';
import type { IosStage, StepResult } from './steps.js';
import { IosStepError, assertForeground, openLink, playStep, shotName } from './steps.js';

/** The element tree kept with a failed step (the driver's debugDescription, cut). */
const TREE_LIMIT = 48 * 1024;

/** Play every scene of the run (up to `--until`). */
export async function playScenes(stage: IosStage): Promise<void> {
  const { run, tools } = stage;
  const scenes = run.sc.scenes;
  for (let si = 0; si < scenes.length; si++) {
    tools.throwIfAborted(run.signal);
    const entry = scenes[si];
    const id = sceneId(entry, si);
    const editTemplate = { ...run.template, pages: displayPages(run.env) };
    const templateEntry = <T extends SceneEntry>(e: T): T => tools.templated(() => templateSceneEntry(tools.untilSteps(e, si, run.until), si, run.template, editTemplate), run.record);
    const t = run.clock.now();
    if (isInterstitial(entry)) {
      run.timeline.addScene({ id, index: si, kind: 'interstitial', t_start: t, t_end: t, interstitial: templateEntry(entry).interstitial, status: 'ok' });
      continue;
    }
    if (isCard(entry)) {
      run.timeline.addScene({ id, index: si, kind: 'card', t_start: t, t_end: t, card: templateEntry(entry).card, status: 'ok' });
      continue;
    }
    if (!isCaptureScene(entry)) continue;
    if (entry.skip) {
      run.timeline.addScene({ id, index: si, kind: 'scene', t_start: t, t_end: t, status: 'skipped' });
      continue;
    }
    run.emit({ type: 'scene_start', scene: id, index: si });
    if (await playScene(stage, templateEntry(entry), si, id)) return;
  }
}

/** The scene's own keys recorded on its timeline scene, then added. */
function addScene(stage: IosStage, scene: Scene, ts: TimelineScene): void {
  const cap = stage.tools.caption(scene.caption);
  if (cap) ts.caption = cap;
  if (scene.speed !== undefined) ts.speed = scene.speed;
  if (scene.transition !== undefined) ts.transition = scene.transition;
  if (scene.frame !== undefined) ts.frame = scene.frame;
  if (scene.tutorial !== undefined) ts.tutorial = structuredClone(scene.tutorial);
  if (scene.offscreen === true) ts.offscreen = true;
  stage.run.timeline.addScene(ts);
}

/** One scene: its open, its still, its steps. True when the run stops here (`--until`). */
async function playScene(stage: IosStage, scene: Scene, si: number, id: string): Promise<boolean> {
  const { run, tools } = stage;
  const now = () => run.clock.now();
  const page = run.env.name;
  const ts: TimelineScene = { id, index: si, kind: 'scene', t_start: now(), t_end: now(), page, status: 'ok' };
  addScene(stage, scene, ts);
  try {
    if (scene.open !== undefined) {
      const url = scene.open;
      const ev: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_open', t_start: now(), t_end: now(), target: { desc: url }, page, status: 'ok' };
      run.timeline.addEvent(ev);
      await openLink(stage, url).catch((e: unknown) => {
        throw tools.stepFailure(`scene ${id} (open ${url}): ${tools.errorMessage(e)}`, { scene: id, step: -1, action: 'open' });
      });
      ev.t_end = now();
    }
    const still: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_still', t_start: now(), t_end: now(), page, status: 'ok' };
    run.timeline.addEvent(still);
    await tools.sleep((scene.still ?? run.pacing.scene_start_still) * 1000, run.signal);
    still.t_end = now();
    ts.t_actions = still.t_end;
    const steps = scene.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      await playOneStep(stage, scene, si, normalizeStep(steps[i], i));
      if (run.until !== null && run.until.sceneIndex === si && run.until.stepIndex === i) {
        run.record.stopped_at = { scene: id, step: i, reason: 'until' };
        return true;
      }
    }
    if (run.until !== null && run.until.sceneIndex === si) {
      run.record.stopped_at ??= { scene: id, step: run.until.stepIndex, reason: 'until' };
      return true;
    }
    return false;
  } catch (e) {
    ts.status = tools.isCancelled(e) ? 'partial' : 'failed';
    throw e;
  } finally {
    ts.t_end = now();
  }
}

/** The step's event (its mark, caption, speed, tutorial), added as the step starts. */
function stepEvent(stage: IosStage, scene: Scene, si: number, step: NormalizedStep): TimelineEvent {
  const { run, tools } = stage;
  const t = run.clock.now();
  const ev: TimelineEvent = { scene: scene.id, scene_index: si, step: step.index, action: step.action, t_start: t, t_end: t, page: run.env.name, status: 'ok' };
  if (step.id !== undefined) ev.id = step.id;
  if (step.mark !== undefined) {
    ev.mark = step.mark;
    run.timeline.addMarker({ name: step.mark, t, scene: scene.id, step: step.index });
  }
  const cap = tools.caption(step.caption);
  if (cap) ev.caption = cap;
  if (step.speed !== undefined) ev.speed = step.speed;
  if (step.tutorial !== undefined) ev.tutorial = structuredClone(step.tutorial);
  run.timeline.addEvent(ev);
  return ev;
}

/** One step: its event, its action, the app still in front, its hold, overlay and camera; a failure's evidence. */
async function playOneStep(stage: IosStage, scene: Scene, si: number, step: NormalizedStep): Promise<void> {
  const { run, tools } = stage;
  const desc = tools.describeStep(run.secrets.redactDeep(step));
  run.emit({ type: 'step_start', scene: scene.id, step: step.index, action: step.action, desc });
  run.record.current = { scene: scene.id, step: step.index, action: step.action };
  void run.files.saveRecord();
  const ev = stepEvent(stage, scene, si, step);
  const touchesBefore = stage.touches.length;
  const started = performance.now();
  let message: string | undefined;
  try {
    const res = await playStep(stage, step);
    for (const t of stage.touches.slice(touchesBefore)) t.event = ev;
    await assertForeground(stage);
    ev.t_end = run.clock.now();
    await recordResult(stage, step, ev, res);
  } catch (e) {
    ev.t_end = run.clock.now();
    ev.status = 'failed';
    ev.error = tools.errorMessage(e);
    message = ev.error;
    if (tools.isCancelled(e)) throw e;
    await stepFailed(stage, scene, step, { desc, e });
  } finally {
    run.record.steps_done++;
    run.record.warnings = [...run.timeline.warnings];
    run.emit({ type: 'step_end', scene: scene.id, step: step.index, action: step.action, status: ev.status, ms: Math.round(performance.now() - started), ...(message ? { message } : {}) });
    void run.files.saveRecord();
  }
}

/** What the step gave its event: its target and point, its hold, its overlay's and camera's anchor. */
async function recordResult(stage: IosStage, step: NormalizedStep, ev: TimelineEvent, res: StepResult): Promise<void> {
  const { run, tools } = stage;
  if (res.target) ev.target = res.target;
  if (res.point) ev.point = { ...res.point };
  const end =
    res.point ?? (res.target?.bbox ? { x: res.target.bbox.x + res.target.bbox.w / 2, y: res.target.bbox.y + res.target.bbox.h / 2 } : { x: stage.screen.width / 2, y: stage.screen.height / 2 });
  ev.end_point = { x: end.x, y: end.y };
  if (res.data !== undefined) ev.data = res.data;
  if (res.hold) ev.hold = { t_start: ev.t_start, t_end: ev.t_end };
  if (step.overlay) {
    const use = overlayUseOf(step.overlay);
    const o: NonNullable<TimelineEvent['overlay']> = { component: use.component, slots: use.slots, params: use.params };
    if (step.overlay.duration !== undefined) o.duration = step.overlay.duration;
    if (step.overlay.at !== undefined) o.at = step.overlay.at;
    if (use.box) o.box = use.box;
    const anchor = step.overlay.target !== undefined ? await boxOf(stage, step.overlay.target) : res.target;
    if (anchor?.bbox) {
      o.target = anchor.desc;
      o.bbox = anchor.bbox;
    } else o.point = { ...end };
    ev.overlay = o;
  }
  if (step.camera) {
    const cam: NonNullable<TimelineEvent['camera']> = { ...step.camera };
    const t = step.camera.target;
    const anchor = t !== undefined && t !== 'step' && t !== 'cursor' && !('x' in (t as object)) ? await boxOf(stage, t as TargetSpec) : res.target;
    if (anchor?.bbox) cam.bbox = anchor.bbox;
    else cam.point = { ...end };
    ev.camera = cam;
  }
  if (step.hold !== undefined && step.hold > 0) {
    await tools.sleep(step.hold * 1000, run.signal);
    ev.hold = { t_start: ev.t_end, t_end: run.clock.now() };
  }
}

/** A target's box now (an overlay's or a camera's anchor), or undefined. */
async function boxOf(stage: IosStage, target: TargetSpec): Promise<{ desc: string; bbox?: { x: number; y: number; w: number; h: number } } | undefined> {
  try {
    const e = await stage.client.cmd<DriverElement>('find', { query: driverQuery(target), timeout_ms: 2000 }, 30_000);
    if (!e.exists || !e.frame) return undefined;
    return { desc: describeTarget(target), bbox: { x: e.frame.x, y: e.frame.y, w: e.frame.w, h: e.frame.h } };
  } catch {
    return undefined;
  }
}

/** A failed step: its picture and element tree written; an optional one is listed, any other fails the run. */
async function stepFailed(stage: IosStage, scene: Scene, step: NormalizedStep, f: { desc: string; e: unknown }): Promise<void> {
  const { run, tools } = stage;
  const error = tools.errorMessage(f.e);
  const file = join(run.screenshotsDir, shotName(`error-${scene.id}-${String(step.index).padStart(2, '0')}-${step.action}`));
  const screenshot = await stage.screenshot(file).then(
    () => file,
    () => undefined,
  );
  const tree = await stage.client.cmd<{ tree: string }>('tree', { limit: TREE_LIMIT }, 30_000).then(
    (r) => run.secrets.redactText(r.tree),
    () => undefined,
  );
  // A driver that did not answer in time may still be playing the command: what the app shows is unknown, so the run
  // stops there, optional step or not.
  const timedOut = f.e instanceof DriverError && f.e.kind === 'timeout';
  if (step.optional && !timedOut) {
    run.timeline.warn(`${scene.id}.${step.index} (${step.action}) failed but is optional: ${error}`);
    (run.record.optional_failures ??= []).push({ scene: scene.id, step: step.index, action: step.action, error, ...(screenshot ? { screenshot } : {}) });
    return;
  }
  const missing = f.e instanceof IosStepError && f.e.notFound;
  throw tools.stepFailure(`scene ${scene.id}, step ${step.index} (${step.action} ${f.desc}): ${error}${missing ? ' — the app’s element tree is in run.json (error.dom)' : ''}`, {
    scene: scene.id,
    step: step.index,
    action: step.action,
    ...(screenshot ? { screenshot } : {}),
    ...(tree ? { dom: tree } : {}),
  });
}
