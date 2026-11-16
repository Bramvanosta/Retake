/** One step of a scene: its timeline event, the action run on the page, its camera and overlay, and its failure. */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { overlayUseOf } from '@retake/core/language';
import { describeTarget, isPoint, normalizeStep, normalizeTarget } from '@retake/core/language';
import { RAW_WAIT_ACTIONS } from './raw/plan.js';
import type { CameraHint, MenuArgs, NormalizedStep, OverlaySpec, Scene, TargetSpec } from '@retake/core/language';
import type { TimelineEvent } from '@retake/core/run';
import type { Scenario } from '@retake/core/scenario';
import type { RunProgress, RunningRun } from '@retake/core/run';
import { ACTIONS, primaryTarget } from './actions/index.js';
import type { ActionResult } from './actions/types.js';
import { approach, settleLatePopup } from './actions/click.js';
import { settleEffectChecks } from './actions/effects.js';
import { formatMissing, isNotFound, missingTargets } from './missing.js';
import { menuTriggerFor } from './actions/widgets.js';
import { errorMessage, isCancelled } from './errors.js';
import { Jitter } from './motion.js';
import { resolveTarget } from './resolve.js';
import type { Runtime, StepContext } from './runtime.js';
import { ACTING_ACTIONS, parkCursor, parkPlan } from './park.js';
import type { ParkRecord } from './park.js';
import { fileSlug, pad } from './util.js';
import { caption, describeStep } from './step-describe.js';
import { StepFailure, errorArtifacts, guardFired } from './step-failure.js';

export const DEFAULT_STEP_TIMEOUT_S = 15;

export interface SceneLoopOptions {
  scenario: Scenario;
  scenarioName: string;
  until: { sceneIndex: number; stepIndex: number } | null;
  record: RunningRun;
  emit: (e: RunProgress) => void;
  save: () => void;
  /**
   * Called at the top of every step, once its page is loaded and signed in, before anything of the step (a pause
   * between steps waits here).
   */
  beforeStep?: (scene: string, step: number) => Promise<void>;
}

/**
 * Camera hint of a step, with its focus measured at the END of the step (after the action, so after any scroll):
 * the step target as the action reports it (a scroll reports the post-scroll box), an explicit target looked up now,
 * a point, or the cursor.
 */
async function cameraFor(ctx: StepContext, hint: CameraHint, res: ActionResult): Promise<NonNullable<TimelineEvent['camera']>> {
  const cam: NonNullable<TimelineEvent['camera']> = { ...hint };
  const t = hint.target;
  const { pointer, kit } = ctx.rt;
  if (t === undefined || t === 'step') {
    if (res.target?.bbox) cam.bbox = res.target.bbox;
    else cam.point = pointer.pos();
  } else if (t === 'cursor') {
    cam.point = pointer.pos();
  } else if (isPoint(t)) {
    cam.point = { x: t.x, y: t.y };
  } else {
    const r = await kit.find(normalizeTarget(t as TargetSpec));
    if (r.count > 0 && 'bbox' in r) cam.bbox = r.bbox;
    else ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: camera target ${describeTarget(t as TargetSpec)} not found; the editor will centre on the cursor`);
  }
  return cam;
}

/**
 * Step `overlay` as recorded on the event: spec + anchor measured at the END of the step (after any scroll). With a
 * `target`, that element is looked up now; without one, the step's own target box is used (as the action reports it),
 * else the cursor position.
 */
async function overlayFor(ctx: StepContext, spec: OverlaySpec, res: ActionResult): Promise<NonNullable<TimelineEvent['overlay']>> {
  // A user file is recorded as its component use (studio/media, studio/lottie) with the box it goes in.
  const use = overlayUseOf(spec);
  const out: NonNullable<TimelineEvent['overlay']> = { component: use.component, slots: use.slots, params: use.params };
  if (spec.duration !== undefined) out.duration = spec.duration;
  if (spec.at !== undefined) out.at = spec.at;
  if (use.box) out.box = use.box;
  const { pointer, kit } = ctx.rt;
  if (spec.target !== undefined) {
    const t = normalizeTarget(spec.target);
    out.target = describeTarget(spec.target);
    const r = await kit.find(t);
    if (r.count > 0 && 'bbox' in r) out.bbox = r.bbox;
    else {
      out.point = pointer.pos();
      ctx.rt.warn(`${ctx.scene.id}.${ctx.step.index}: overlay target ${out.target} not found; the overlay is anchored to the cursor`);
    }
  } else if (res.target?.bbox) {
    out.target = res.target.desc;
    out.bbox = res.target.bbox;
  } else {
    out.point = pointer.pos();
  }
  // A file anchored on the cursor goes where the cursor is at the end of the step, whatever the step's target.
  if (use.box?.anchor === 'cursor' && !out.point) out.point = pointer.pos();
  return out;
}

async function dryScreenshot(rt: Runtime, opts: SceneLoopOptions, scene: string, step: NormalizedStep): Promise<void> {
  // An inspection's replay takes one picture, of the page it ends on (inspect.ts).
  if (rt.inspecting) return;
  const file = join(rt.screenshotsDir, `${fileSlug(scene)}-${pad(step.index, 2)}-${step.action}.png`);
  rt.assertSignedIn();
  try {
    await rt.page.screenshot({ path: file, timeout: 10_000 });
    opts.record.screenshots.push(file);
  } catch (e) {
    rt.log('warn', `dry-run screenshot failed: ${errorMessage(e)}`);
  }
  // A sign-in page that showed while the picture was taken: never kept.
  if (rt.guard && guardFired(rt)) {
    await rm(file, { force: true }).catch(() => undefined);
    opts.record.screenshots = opts.record.screenshots.filter((f) => f !== file);
    rt.assertSignedIn();
  }
}

export type StepOutcome = 'ok' | 'failed-optional' | 'stop-scene';

/** The step's timeline event (its mark, caption, speed and tutorial), added to the timeline as the step starts. */
function stepEvent(rt: Runtime, scene: Scene, sceneIndex: number, step: NormalizedStep): TimelineEvent {
  const ev: TimelineEvent = {
    scene: scene.id,
    scene_index: sceneIndex,
    step: step.index,
    action: step.action,
    t_start: rt.now(),
    t_end: rt.now(),
    status: 'ok',
  };
  if (step.id !== undefined) ev.id = step.id;
  if (step.mark !== undefined) {
    ev.mark = step.mark;
    const page = rt.scenePanes.length > 0 ? rt.activeId : null;
    rt.timeline.addMarker({ name: step.mark, t: ev.t_start, scene: scene.id, step: step.index, ...(page ? { page } : {}) });
  }
  const cap = caption(step.caption);
  if (cap) ev.caption = cap;
  if (step.speed !== undefined) ev.speed = step.speed;
  if (step.tutorial !== undefined) ev.tutorial = structuredClone(step.tutorial);
  rt.timeline.addEvent(ev);
  return ev;
}

/** Dry-run never executes irreversible steps: show what would be clicked (the scene then stops). */
async function showIrreversible(ctx: StepContext, opts: SceneLoopOptions, scene: Scene, ev: TimelineEvent): Promise<void> {
  const { rt, step } = ctx;
  const t = primaryTarget(step);
  if (t) {
    const r = step.action === 'menu' ? (await menuTriggerFor(ctx, step.args as MenuArgs)).trigger : await resolveTarget(ctx, t);
    await approach(ctx, r);
    await rt.sleep(ctx.jitter.ms(rt.pacing.hover_ms));
    ev.target = { desc: r.desc, bbox: r.bbox };
    ev.point = rt.pointer.pos();
  }
  ev.status = 'dry';
  ev.t_end = rt.now();
  await dryScreenshot(rt, opts, scene.id, step);
}

/** The step's action on the page, with its park, hold, camera and overlay recorded on its event. */
async function actStep(ctx: StepContext, opts: SceneLoopOptions, scene: Scene, ev: TimelineEvent): Promise<void> {
  const { rt, step } = ctx;
  const park = parkPlan(step, rt.pacing);
  let parked: ParkRecord | undefined;
  // Parking before a `hold` step: the hold starts once the cursor rests (R-CHO-21).
  if (park?.when === 'before') parked = await parkCursor(ctx, park, rt.lastActed);
  const holdFrom = parked ? rt.now() : ev.t_start;
  let popupsBefore: number[] | undefined;
  if (rt.parkWatch && ACTING_ACTIONS.has(step.action)) {
    await rt.kit.watchChanges().catch(() => undefined);
    popupsBefore = await rt.kit.popupState().then(
      (ps) => ps.map((p) => p.id),
      () => undefined,
    );
  }
  // A click before this step may still be watched for its effect (R-FLD-12): its check ends before this step acts.
  if (ACTING_ACTIONS.has(step.action)) await settleEffectChecks(ctx);
  const handler = ACTIONS[step.action] as (c: StepContext, a: unknown) => Promise<ActionResult>;
  let res: ActionResult;
  try {
    res = await handler(ctx, step.args);
  } finally {
    // A route that changes once the step returned is no route of its press (R-ISS-14).
    rt.stepDone();
  }
  // A navigation the step started (an `open` up to its commit, an Enter, a new tab, a click) ends with the new page
  // painted (R-ISS-08): its park, hold and overlays never fall inside the held load the edit cuts.
  await rt.awaitShownLoaded();
  ev.t_end = rt.now();
  if (res.target) ev.target = res.target;
  if (res.point) ev.point = { x: res.point.x, y: res.point.y };
  if (res.t_click !== undefined) ev.t_click = res.t_click;
  if (res.strategy) ev.strategy = res.strategy;
  if (res.popup_opened !== undefined) ev.popup_opened = res.popup_opened;
  if (res.pending_popup) rt.pendingPopup = { ...res.pending_popup, ev, page: rt.page };
  if (res.data !== undefined) ev.data = res.data;
  if (res.hold) ev.hold = { t_start: holdFrom, t_end: ev.t_end };
  if (ACTING_ACTIONS.has(step.action)) {
    rt.lastActed = {
      ...(res.target?.bbox ? { bbox: res.target.bbox } : {}),
      ...(res.ref ? { ref: res.ref } : {}),
      popup_opened: res.popup_opened === true,
      ...(popupsBefore ? { popups_before: popupsBefore } : {}),
      page: rt.page,
    };
  }
  // Where an overlay or a zoom added to the scenario after this take anchors, as overlayFor reads it now.
  const end = rt.pointer.pos();
  ev.end_point = { x: end.x, y: end.y };
  if (step.camera) ev.camera = await cameraFor(ctx, step.camera, res);
  if (step.overlay) ev.overlay = await overlayFor(ctx, step.overlay, res);
  if (park?.when === 'after') {
    // The park move belongs to the step (its speed, its tutorial window); its hold replaces the `hold` modifier.
    parked = await parkCursor(ctx, park, rt.lastActed);
    ev.t_end = rt.now();
    if (park.hold_s > 0) {
      await rt.sleep(park.hold_s * 1000);
      ev.hold = { t_start: ev.t_end, t_end: rt.now() };
    }
  } else if (step.hold !== undefined && step.hold > 0) {
    await rt.pause(step.hold);
    ev.hold = { t_start: ev.t_end, t_end: rt.now() };
  }
  if (parked) ev.data = { ...(ev.data !== null && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : {}), park: parked };
  if (rt.mode === 'dry') await dryScreenshot(rt, opts, scene.id, step);
}

/**
 * A step that failed (not on a sign-in page, not cancelled): its screenshot and DOM written; an optional one is
 * listed in the run result, any other fails the run (StepFailure).
 */
async function stepFailed({
  rt,
  opts,
  scene,
  step,
  desc,
  e,
  error,
}: {
  rt: Runtime;
  opts: SceneLoopOptions;
  scene: Scene;
  step: NormalizedStep;
  desc: string;
  e: unknown;
  error: string;
}): Promise<StepOutcome> {
  const art = await errorArtifacts(rt, scene.id, step.index, e);
  if (step.optional) {
    rt.warn(`${scene.id}.${step.index} (${step.action}) failed but is optional: ${error}`);
    // Listed in the run result (R-FLD-16): an optional step that failed is not lost among the warnings.
    (opts.record.optional_failures ??= []).push({
      scene: scene.id,
      step: step.index,
      action: step.action,
      error,
      ...(art.screenshot ? { screenshot: art.screenshot } : {}),
    });
    return 'failed-optional';
  }
  // A missing target: the scene's other targets missing from this page too, in the same error (R-FLD-10).
  const missing = isNotFound(e) ? await missingTargets(rt, scene, step) : [];
  throw new StepFailure(`scene ${scene.id}, step ${step.index} (${step.action} ${desc}): ${error}${rt.secrets.redactText(formatMissing(missing))}`, {
    scene: scene.id,
    step: step.index,
    action: step.action,
    screenshot: art.screenshot,
    dom: art.dom,
    missing: missing.length ? missing : undefined,
  });
}

/**
 * The scene films the wait after step `index` on purpose (R-ISS-14: no route hold for that step): the waits right
 * after it (wait_for, wait_for_email) include one with a `mark` — the moment it waits for is kept, and what the page
 * shows until then is the scenario's (an import's progress it reveals). A wait's `hold` (seconds still after it) is
 * no such sign.
 */
function filmsNextWait(scene: Scene, index: number): boolean {
  const steps = scene.steps ?? [];
  for (let i = index + 1; i < steps.length; i++) {
    const next = normalizeStep(steps[i], i);
    if (!RAW_WAIT_ACTIONS.has(next.action)) return false;
    if (next.mark !== undefined) return true;
  }
  return false;
}

export async function runStep(rt: Runtime, opts: SceneLoopOptions, scene: Scene, sceneIndex: number, step: NormalizedStep): Promise<StepOutcome> {
  // Never act on a page whose load the capture holds (R-ISS-08): one the app started itself, or — in a multi-page scene —
  // another page's (cut from every page of the scene). Not part of the step's time.
  await rt.awaitShownLoaded();
  // …nor on a sign-in page.
  rt.assertSignedIn();
  if (opts.beforeStep) {
    // A pause waits here: between steps, on a loaded page — then the page is checked again (a session may have
    // expired meanwhile).
    await opts.beforeStep(scene.id, step.index);
    rt.assertSignedIn();
  }
  const ctx: StepContext = {
    rt,
    scene: { id: scene.id, index: sceneIndex },
    step,
    timeoutMs: (step.timeout ?? rt.defaultTimeoutS ?? DEFAULT_STEP_TIMEOUT_S) * 1000,
    jitter: new Jitter(`${opts.scenarioName}:${scene.id}:${step.index}`, rt.pacing.jitter),
    clicks: [],
    ...(filmsNextWait(scene, step.index) ? { filmsWait: true as const } : {}),
  };
  // Described from a fully redacted copy (describeStep cuts long arguments: no prefix of a secret may survive the cut).
  const desc = describeStep(rt.secrets.redactDeep(step));
  const pending = rt.pendingPopup;
  rt.pendingPopup = null;
  if (pending && pending.ev.scene === scene.id) {
    await settleLatePopup(ctx, pending, primaryTarget(step)).catch((e: unknown) => {
      if (isCancelled(e) || rt.loginGuardError()) throw rt.loginGuardError() ?? e;
      return false;
    });
  }
  rt.current = { scene: scene.id, scene_index: sceneIndex, step: step.index };
  opts.emit({ type: 'step_start', scene: scene.id, step: step.index, action: step.action, desc });
  opts.record.current = { scene: scene.id, step: step.index, action: step.action };
  opts.save();
  const ev = stepEvent(rt, scene, sceneIndex, step);

  const started = performance.now();
  let message: string | undefined;
  try {
    if (rt.mode === 'dry' && (step.irreversible || scene.irreversible)) {
      await showIrreversible(ctx, opts, scene, ev);
      message = 'irreversible step not executed in dry-run';
      return 'stop-scene';
    }
    await actStep(ctx, opts, scene, ev);
    return 'ok';
  } catch (e) {
    ev.t_end = rt.now();
    ev.status = 'failed';
    // A step that failed because its page landed on a sign-in page — a target missing there, an abort — fails
    // the run with the landing: never tolerated as optional, no screenshot or DOM of that page.
    const landing = rt.loginGuardError() ?? (guardFired(rt) ? rt.loginGuardError() : null);
    ev.error = errorMessage(landing ?? e);
    message = ev.error;
    if (landing) throw landing;
    if (isCancelled(e)) throw e;
    return await stepFailed({ rt, opts, scene, step, desc, e, error: ev.error });
  } finally {
    try {
      ev.page = rt.activeId ?? undefined;
      ev.url = rt.page.url();
    } catch {
      /* page gone */
    }
    opts.record.steps_done++;
    opts.record.warnings = [...rt.timeline.warnings];
    opts.emit({
      type: 'step_end',
      scene: scene.id,
      step: step.index,
      action: step.action,
      status: ev.status,
      ms: Math.round(performance.now() - started),
      message,
    });
    opts.save();
  }
}
