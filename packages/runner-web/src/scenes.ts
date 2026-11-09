import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TemplateError,
  describeTarget,
  isCaptureScene,
  isCard,
  isInterstitial,
  isPoint,
  normalizeStep,
  normalizeTarget,
  overlayUseOf,
  resolvePageUrl,
  resolveScenePages,
  sceneId,
  templateSceneEntry,
} from '@retake/core';
import type {
  CameraHint,
  CaptionSpec,
  MenuArgs,
  MissingTarget,
  NormalizedStep,
  OverlaySpec,
  RunProgress,
  RunRecord,
  Scenario,
  Scene,
  SceneEntry,
  TargetSpec,
  TimelineEvent,
  TimelineScene,
} from '@retake/core';
import { ACTIONS, primaryTarget } from './actions/index.js';
import type { ActionResult } from './actions/types.js';
import { approach, settleLatePopup } from './actions/click.js';
import { settleEffectChecks } from './actions/effects.js';
import { formatMissing, isNotFound, missingTargets } from './missing.js';
import { menuTriggerFor } from './actions/widgets.js';
import { assertMayOpen, navigate } from './actions/pages.js';
import { RunnerError, StepError, errorMessage, isCancelled } from './errors.js';
import { Jitter } from './motion.js';
import { resolveTarget } from './resolve.js';
import { INSPECT_PAUSE_CAP_S } from './runtime.js';
import type { Runtime, StepContext } from './runtime.js';
import { ACTING_ACTIONS, parkCursor, parkPlan } from './park.js';
import type { ParkRecord } from './park.js';
import { placeSceneCursor } from './scene-cursor.js';
import { fileSlug, pad, throwIfAborted, wallNow } from './util.js';

export const DEFAULT_STEP_TIMEOUT_S = 15;
/** After a scene-start teleport, before the still: hover transitions of the element the pointer left settle. */
const TELEPORT_SETTLE_MS = 300;
/**
 * DOM snippets written next to error screenshots (`error-<scene>-<step>.html`) are trimmed to this many characters
 * (docs/DESIGN.md §3.2): the failing element's outerHTML when known, else the body — enough to see the structure
 * around a missing target, small enough to read or hand to an agent.
 */
export const ERROR_DOM_MAX = 64 * 1024;

/** A non-optional step failed: the run aborts (teardown still runs). */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly scene: string,
    readonly step: number,
    readonly action: string,
    readonly screenshot?: string,
    readonly dom?: string,
    /** The target was not found: the scene's later targets missing from the page too (R-FLD-10). */
    readonly missing?: MissingTarget[],
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

export interface SceneLoopOptions {
  scenario: Scenario;
  scenarioName: string;
  until: { sceneIndex: number; stepIndex: number } | null;
  record: RunRecord;
  emit: (e: RunProgress) => void;
  save: () => void;
  /**
   * Called at the top of every step, once its page is loaded and signed in, before anything of the step (L4.4: a pause
   * between steps waits here).
   */
  beforeStep?: (scene: string, step: number) => Promise<void>;
}

/**
 * Template part of the scenario (R-RUN-16): a TemplateError fails the run; a {{hooks.…}} token that cannot resolve
 * because the setup hooks were skipped says how to run them.
 */
export function templated<T>(fn: () => T, record: RunRecord): T {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof TemplateError)) throw e;
    const skipped = record.hooks.setup === 'skipped' && /\{\{\s*hooks\./.test(e.message);
    throw new RunnerError(skipped ? `${e.message} — the setup hooks were skipped (a dry run skips them: add --hooks run)` : e.message);
  }
}

/** A scene entry as far as the run goes: with --until, the steps of its scene after the last one to run are left out. */
export function untilSteps<T extends SceneEntry>(entry: T, si: number, until: SceneLoopOptions['until']): T {
  if (!until || until.sceneIndex !== si || !isCaptureScene(entry)) return entry;
  return { ...entry, steps: (entry.steps ?? []).slice(0, until.stepIndex + 1) } as T;
}

function caption(c: CaptionSpec | undefined): { kicker?: string; text: string } | undefined {
  if (c === undefined) return undefined;
  return typeof c === 'string' ? { text: c } : { ...c };
}

/** Short description of a step for progress events. */
export function describeStep(step: NormalizedStep): string {
  const a = step.args as unknown as Record<string, unknown>;
  const t = primaryTarget(step);
  const td = t ? describeTarget(t) : '';
  switch (step.action) {
    case 'open':
      return String(a.url);
    case 'click':
      return td || (a.outside !== undefined && typeof a.outside === 'object' ? `outside → ${describeTarget(a.outside as TargetSpec)}` : 'outside');
    case 'wait':
    case 'hold':
      return `${a.seconds} s`;
    case 'type':
      return `${JSON.stringify(a.text)}${td ? ` into ${td}` : ''}`;
    case 'press':
      return `${a.key}${a.times ? ` ×${a.times}` : ''}`;
    case 'select':
    case 'pick':
      return `${JSON.stringify(a.option)} in ${td}`;
    case 'menu':
      return `${td} → ${JSON.stringify(a.item)}${a.confirm ? ' + confirm' : ''}`;
    case 'date':
      return `${JSON.stringify(a.day)}${td ? ` in ${td}` : ''}`;
    case 'scroll':
      return a.to !== undefined ? `to ${typeof a.to === 'object' ? describeTarget(a.to as TargetSpec) : a.to}` : `by ${a.by}`;
    case 'wait_for':
    case 'assert':
      return JSON.stringify(a).slice(0, 100);
    case 'screenshot':
      return String(a.name);
    case 'hook':
      return `${a.name} (off camera)`;
    case 'switch_page':
      return String(a.to);
    case 'emit':
      return String(a.name);
    case 'notify':
      return String(a.message);
    case 'wait_for_email': {
      const f = [a.to && `to ${a.to}`, a.from && `from ${a.from}`, a.subject && `subject ${a.subject}`].filter(Boolean).join(', ');
      return `${f || 'any new message'} → ${a.as}`;
    }
    case 'download':
      return `${td} → ${a.as}`;
    case 'capture_text':
      return `${describeTarget(a.target as TargetSpec)}${a.pattern ? ` ${String(a.pattern)}` : ''} → ${a.as}`;
    case 'cursor':
      return `${a.mode}${a.to ? ` ${isPoint(a.to) ? `(${(a.to as { x: number }).x}, ${(a.to as { y: number }).y})` : describeTarget(a.to as TargetSpec)}` : ''}`;
    default:
      return td || (step.action === 'new_tab' && a.href ? String(a.href) : '');
  }
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
  // A user file (L2.12) is recorded as its component use (studio/media, studio/lottie) with the box it goes in.
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

const TRIM_NOTE = /\n<!-- … trimmed to \d+ of (\d+) chars -->$/;

/**
 * A DOM snippet cut to `max` characters after its last complete tag within the cap (a cut inside a tag would be
 * unreadable), with the kit's note on what was left out; a snippet the kit already trimmed keeps the original length.
 */
export function trimSnippet(html: string, max: number): string {
  const note = TRIM_NOTE.exec(html);
  const body = note ? html.slice(0, note.index) : html;
  if (body.length <= max) return html;
  let cut = body.lastIndexOf('>', max - 1) + 1;
  if (cut < max * 0.75) cut = max;
  return `${body.slice(0, cut)}\n<!-- … trimmed to ${cut} of ${note ? note[1] : body.length} chars -->`;
}

async function errorArtifacts(rt: Runtime, scene: string, step: number, e: unknown): Promise<{ screenshot?: string; dom?: string }> {
  const base = join(rt.screenshotsDir, `error-${fileSlug(scene)}-${step}`);
  const out: { screenshot?: string; dom?: string } = await errorFiles(rt, scene, step, e, base);
  // Never a picture or the DOM of a sign-in page (L1.6): a landing seen while they were taken removes them.
  if (rt.guard && guardFired(rt)) {
    await Promise.all([out.screenshot, out.dom].filter((f): f is string => !!f).map((f) => rm(f, { force: true }).catch(() => undefined)));
    return {};
  }
  return out;
}

/** Whether a filmed page is (or was) on a sign-in page: the landing is then recorded by the guard. */
function guardFired(rt: Runtime): boolean {
  try {
    rt.assertSignedIn();
    return false;
  } catch {
    return true;
  }
}

async function errorFiles(rt: Runtime, scene: string, step: number, e: unknown, base: string): Promise<{ screenshot?: string; dom?: string }> {
  const out: { screenshot?: string; dom?: string } = {};
  try {
    await rt.page.screenshot({ path: `${base}.png`, timeout: 10_000 });
    out.screenshot = `${base}.png`;
  } catch (err) {
    rt.log('warn', `error screenshot failed: ${errorMessage(err)}`);
  }
  try {
    const ref = e instanceof StepError ? e.domRef : null;
    // Secret values are masked before the snippet is trimmed (a cut must not keep the start of one): the kit trims at
    // twice the size, the final cut is made here.
    const html = trimSnippet(rt.secrets.redactText(await rt.kit.snapshot(ref, ERROR_DOM_MAX * 2)), ERROR_DOM_MAX);
    const header = [
      '<!-- Retake step failure',
      `  scene: ${scene}  step: ${step}`,
      `  url: ${rt.secrets.redactText(rt.page.url())}`,
      `  error: ${rt.secrets.redactText(errorMessage(e)).replace(/--/g, '—')}`,
      '-->',
    ].join('\n');
    await writeFile(`${base}.html`, `${header}\n${html}\n`);
    out.dom = `${base}.html`;
  } catch (err) {
    rt.log('warn', `error DOM snapshot failed: ${errorMessage(err)}`);
  }
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
  // A sign-in page that showed while the picture was taken (L1.6): never kept.
  if (rt.guard && guardFired(rt)) {
    await rm(file, { force: true }).catch(() => undefined);
    opts.record.screenshots = opts.record.screenshots.filter((f) => f !== file);
    rt.assertSignedIn();
  }
}

type StepOutcome = 'ok' | 'failed-optional' | 'stop-scene';

async function runStep(rt: Runtime, opts: SceneLoopOptions, scene: Scene, sceneIndex: number, step: NormalizedStep): Promise<StepOutcome> {
  // Never act on a page whose load the capture holds (R-ISS-08): one the app started itself, or — in a multi-page scene —
  // another page's (cut from every page of the scene). Not part of the step's time.
  await rt.awaitShownLoaded();
  // …nor on a sign-in page (L1.6).
  rt.assertSignedIn();
  if (opts.beforeStep) {
    // A pause (L4.4) waits here: between steps, on a loaded page — then the page is checked again (a session may have
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

  const started = performance.now();
  let outcome: StepOutcome = 'ok';
  let message: string | undefined;
  try {
    if (rt.mode === 'dry' && (step.irreversible || scene.irreversible)) {
      // Dry-run never executes irreversible steps: show what would be clicked, then stop the scene.
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
      message = 'irreversible step not executed in dry-run';
      return (outcome = 'stop-scene');
    }
    const park = parkPlan(step, rt.pacing);
    let parked: ParkRecord | undefined;
    // Parking before a `hold` step: the hold starts once the cursor rests (R-CHO-21).
    if (park?.when === 'before') parked = await parkCursor(ctx, park, rt.lastActed);
    const holdFrom = parked ? rt.now() : ev.t_start;
    let popupsBefore: number[] | undefined;
    if (rt.parkWatch && ACTING_ACTIONS.has(step.action)) {
      await rt.kit.watchChanges().catch(() => undefined);
      popupsBefore = await rt.kit.popupState().then((ps) => ps.map((p) => p.id), () => undefined);
    }
    // A click before this step may still be watched for its effect (R-FLD-12): its check ends before this step acts.
    if (ACTING_ACTIONS.has(step.action)) await settleEffectChecks(ctx);
    const handler = ACTIONS[step.action] as (c: StepContext, a: unknown) => Promise<ActionResult>;
    const res = await handler(ctx, step.args);
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
    // Where an overlay or a zoom added to the scenario after this take anchors (L5.5), as overlayFor reads it now.
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
    return outcome;
  } catch (e) {
    ev.t_end = rt.now();
    ev.status = 'failed';
    // A step that failed because its page landed on a sign-in page (L1.6) — a target missing there, an abort — fails
    // the run with the landing: never tolerated as optional, no screenshot or DOM of that page.
    const landing = rt.loginGuardError() ?? (guardFired(rt) ? rt.loginGuardError() : null);
    ev.error = errorMessage(landing ?? e);
    message = ev.error;
    if (landing) throw landing;
    if (isCancelled(e)) throw e;
    const art = await errorArtifacts(rt, scene.id, step.index, e);
    if (step.optional) {
      rt.warn(`${scene.id}.${step.index} (${step.action}) failed but is optional: ${ev.error}`);
      // Listed in the run result (R-FLD-16): an optional step that failed is not lost among the warnings.
      (opts.record.optional_failures ??= []).push({
        scene: scene.id,
        step: step.index,
        action: step.action,
        error: ev.error,
        ...(art.screenshot ? { screenshot: art.screenshot } : {}),
      });
      return (outcome = 'failed-optional');
    }
    // A missing target: the scene's other targets missing from this page too, in the same error (R-FLD-10).
    const missing = isNotFound(e) ? await missingTargets(rt, scene, step) : [];
    throw new StepFailure(
      `scene ${scene.id}, step ${step.index} (${step.action} ${desc}): ${ev.error}${rt.secrets.redactText(formatMissing(missing))}`,
      scene.id,
      step.index,
      step.action,
      art.screenshot,
      art.dom,
      missing.length ? missing : undefined,
    );
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

/** Execute every scene: page switching, open, still, steps, dry-run stops, --until. */
export async function runScenes(rt: Runtime, opts: SceneLoopOptions): Promise<void> {
  const envKeys = Object.keys(rt.env.pages);
  let pageKey: string | null = null;
  const scenes = opts.scenario.scenes;
  // Parking (R-CHO-21) needs what changed since the last action: recorded only when some step parks.
  rt.parkWatch = scenes.some((e) => {
    const steps = (e as { steps?: unknown }).steps;
    return Array.isArray(steps) && steps.some((st) => st !== null && typeof st === 'object' && (st as { park?: unknown }).park !== undefined && (st as { park?: unknown }).park !== false);
  });
  for (let si = 0; si < scenes.length; si++) {
    throwIfAborted(rt.signal);
    const entry = scenes[si];
    const id = sceneId(entry, si);
    // Every string of the entry is templated now, once (R-RUN-16): what the timeline records holds values, not tokens.
    // The text the video shows reads the display URLs (L1.7); steps and `open` the real ones.
    const templateEntry = <T extends SceneEntry>(e: T): T => templated(() => templateSceneEntry(untilSteps(e, si, opts.until), si, rt.template, rt.editTemplate), opts.record);
    if (isInterstitial(entry)) {
      const t = rt.now();
      rt.timeline.addScene({ id, index: si, kind: 'interstitial', t_start: t, t_end: t, interstitial: templateEntry(entry).interstitial, status: 'ok' });
      continue;
    }
    if (isCard(entry)) {
      // A card takes no capture time: the editor shows it between the clips around it.
      const t = rt.now();
      rt.timeline.addScene({ id, index: si, kind: 'card', t_start: t, t_end: t, card: templateEntry(entry).card, status: 'ok' });
      continue;
    }
    if (entry.skip) {
      const t = rt.now();
      rt.timeline.addScene({ id, index: si, kind: 'scene', t_start: t, t_end: t, status: 'skipped' });
      continue;
    }
    opts.emit({ type: 'scene_start', scene: id, index: si });
    const scene = templateEntry(entry);
    if (scene.pages !== undefined) {
      const stop = await runPagesScene(rt, opts, scene, si, id);
      // A next single-page scene without `page` continues on this scene's first page.
      pageKey = rt.timeline.scenes[rt.timeline.scenes.length - 1]?.page ?? pageKey;
      if (stop) return;
      continue;
    }
    pageKey = scene.page ?? pageKey ?? envKeys[0] ?? null;
    if (!pageKey) throw new StepError(`scene ${id}: environment "${rt.env.name}" declares no pages`);
    if (!(pageKey in rt.env.pages) && !rt.session.has(pageKey)) {
      throw new StepError(`scene ${id}: unknown page "${pageKey}" (environment ${rt.env.name}: ${envKeys.join(', ')})`);
    }
    const fresh = !rt.session.has(pageKey);
    const switched = rt.activeId !== pageKey;
    await rt.activate(pageKey);
    const ts: TimelineScene = { id, index: si, kind: 'scene', t_start: rt.now(), t_end: rt.now(), page: pageKey, status: 'ok' };
    rt.current = { scene: id, scene_index: si, step: -1 };
    const cap = caption(scene.caption);
    if (cap) ts.caption = cap;
    if (scene.speed !== undefined) ts.speed = scene.speed;
    if (scene.transition !== undefined) ts.transition = scene.transition;
    if (scene.frame !== undefined) ts.frame = scene.frame;
    if (scene.tutorial !== undefined) ts.tutorial = structuredClone(scene.tutorial);
    if (scene.offscreen === true) ts.offscreen = true;
    rt.timeline.addScene(ts);
    try {
      if (scene.open !== undefined) {
        const ev: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_open', t_start: rt.now(), t_end: rt.now(), status: 'ok' };
        rt.timeline.addEvent(ev);
        const url = rt.resolveUrl(scene.open, pageKey);
        ev.target = { desc: url };
        await navigate(rt, rt.page, url);
        ev.t_end = rt.now();
        ev.page = pageKey;
        ev.url = rt.page.url();
      } else if (fresh) {
        rt.warn(`scene ${id} starts on a blank "${pageKey}" page (add \`open\`)`);
      }
      // A scene never starts on a sign-in page (L1.6).
      rt.assertSignedIn();
      // Scene-start cursor (scene key `cursor`): placed while the page loads, or glided during the still — never a jump.
      const stillS = Math.min(scene.still ?? rt.pacing.scene_start_still, rt.inspecting ? INSPECT_PAUSE_CAP_S : Infinity);
      const placed = await placeSceneCursor(rt, scene, {
        loading: scene.open !== undefined || switched,
        stillMs: stillS * 1000,
        jitter: new Jitter(`${opts.scenarioName}:${scene.id}:cursor`, rt.pacing.jitter),
      });
      if (placed.record.how === 'teleport') {
        // Still part of the loading (cut by the editor): let hover-out transitions of the element the pointer left end.
        await rt.sleep(TELEPORT_SETTLE_MS);
        await rt.painted();
      }
      // The still starts on a painted page (R-ISS-08), never on a load the capture still holds — nor on a sign-in page.
      await rt.awaitLoaded();
      rt.assertSignedIn();
      ts.url = rt.page.url();
      const still: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_still', t_start: rt.now(), t_end: rt.now(), status: 'ok' };
      rt.timeline.addEvent(still);
      const stillStart = wallNow();
      if (placed.glide) await placed.glide();
      const left = stillStart + stillS * 1000 - wallNow();
      if (left > 0) await rt.sleep(left);
      still.t_end = rt.now();
      still.point = rt.pointer.pos();
      still.data = { cursor: placed.record };
      ts.t_actions = still.t_end;

      const steps = scene.steps ?? [];
      for (let i = 0; i < steps.length; i++) {
        const step = normalizeStep(steps[i], i);
        const outcome = await runStep(rt, opts, scene, si, step);
        const isUntil = opts.until !== null && opts.until.sceneIndex === si && opts.until.stepIndex === i;
        if (outcome === 'stop-scene') {
          ts.status = 'partial';
          if (!opts.record.stopped_at) opts.record.stopped_at = { scene: id, step: i, reason: 'irreversible' };
          rt.log('info', `dry-run: scene ${id} stops at irreversible step ${i}; the next scene continues`);
          for (let j = i + 1; j < steps.length; j++) {
            const s = normalizeStep(steps[j], j);
            const t = rt.now();
            rt.timeline.addEvent({ scene: id, scene_index: si, step: j, action: s.action, t_start: t, t_end: t, status: 'skipped' });
          }
          break;
        }
        if (isUntil) {
          opts.record.stopped_at = { scene: id, step: i, reason: 'until' };
          return;
        }
      }
      // --until on a scene that ended early (or has no steps) still ends the run here.
      if (opts.until !== null && opts.until.sceneIndex === si) {
        opts.record.stopped_at ??= { scene: id, step: opts.until.stepIndex, reason: 'until' };
        return;
      }
    } catch (e) {
      ts.status = isCancelled(e) ? 'partial' : 'failed';
      throw e;
    } finally {
      ts.t_end = rt.now();
    }
  }
  // The last frames never show a sign-in page either (L1.6).
  rt.assertSignedIn();
}

/**
 * A multi-page scene (L2.11): its pages are opened and recorded at the same time, each on its own track (one clock);
 * each page's cursor is placed (teleported while its page loads, else glided during the still); then the steps run on
 * the page they name (`on:`, default the first page). When a step acts on another page than the previous one, the
 * runner pauses `pacing.page_switch_ms` and that page's cursor glides from where it rests — the other cursor stays
 * still, visible. Returns true when the run stops here (--until).
 */
async function runPagesScene(rt: Runtime, opts: SceneLoopOptions, scene: Scene, si: number, id: string): Promise<boolean> {
  let pages;
  try {
    pages = resolveScenePages(scene, { capture: rt.capture, envPages: Object.keys(rt.env.pages), known: (pid) => rt.declaredPages.get(pid) });
  } catch (e) {
    throw new StepError(errorMessage(e));
  }
  if (pages.length < 2) throw new StepError(`scene ${id}: a multi-page scene films at least 2 pages`);
  for (const pg of pages) {
    if (pg.page !== undefined && !(pg.page in rt.env.pages)) {
      throw new StepError(`scene ${id}: unknown page "${pg.page}" (environment ${rt.env.name}: ${Object.keys(rt.env.pages).join(', ')})`);
    }
  }
  const fresh = new Set(pages.filter((pg) => !rt.session.has(pg.id)).map((pg) => pg.id));
  const ts: TimelineScene = { id, index: si, kind: 'scene', t_start: rt.now(), t_end: rt.now(), page: pages[0].id, status: 'ok', pages: [] };
  rt.current = { scene: id, scene_index: si, step: -1 };
  const cap = caption(scene.caption);
  if (cap) ts.caption = cap;
  if (scene.speed !== undefined) ts.speed = scene.speed;
  if (scene.transition !== undefined) ts.transition = scene.transition;
  if (scene.frame !== undefined) ts.frame = scene.frame;
  if (scene.tutorial !== undefined) ts.tutorial = structuredClone(scene.tutorial);
  if (scene.offscreen === true) ts.offscreen = true;
  rt.timeline.addScene(ts);
  try {
    // What each page opens, checked before any page of the scene is laid out (opens.ts).
    const urls = new Map<string, string>();
    for (const pg of pages) {
      if (!pg.open) continue;
      const url = pg.open.absolute || pg.page === undefined ? pg.open.url : resolvePageUrl(rt.env.pages[pg.page], pg.open.url);
      assertMayOpen(rt, url, undefined, `page "${pg.id}" open`);
      urls.set(pg.id, url);
    }
    await rt.enterPages(pages);
    const panes = new Map(rt.scenePanes.map((p) => [p.id, p]));
    // Open every page (the loads are cut by the editor: the clip starts at the still).
    const opened = new Set<string>();
    for (const pg of pages) {
      const pane = panes.get(pg.id)!;
      if (pg.open) {
        const ev: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_open', t_start: rt.now(), t_end: rt.now(), page: pg.id, status: 'ok' };
        rt.timeline.addEvent(ev);
        const url = urls.get(pg.id)!;
        ev.target = { desc: url };
        await navigate(rt, pane.page, url);
        await pane.pointer.syncPage();
        ev.t_end = rt.now();
        ev.url = pane.page.url();
        opened.add(pg.id);
      } else if (fresh.has(pg.id)) {
        rt.warn(`scene ${id}: page "${pg.id}" starts blank (give it \`open\`)`);
      }
    }
    rt.assertSignedIn();
    // Each page's cursor: next to that page's first target (its own steps), never on it.
    const stillS = Math.min(scene.still ?? rt.pacing.scene_start_still, rt.inspecting ? INSPECT_PAUSE_CAP_S : Infinity);
    const glides: Array<{ id: string; glide: () => Promise<void> }> = [];
    const records: Record<string, unknown> = {};
    for (const pg of pages) {
      await rt.act(pg.id);
      const own = (scene.steps ?? []).filter((raw) => ((raw as { on?: string }).on ?? pages[0].id) === pg.id);
      const placed = await placeSceneCursor(rt, { id, steps: own, ...(pg.cursor !== undefined ? { cursor: pg.cursor } : {}) }, {
        loading: opened.has(pg.id) || fresh.has(pg.id),
        idle: own.length === 0,
        stillMs: stillS * 1000,
        jitter: new Jitter(`${opts.scenarioName}:${scene.id}:${pg.id}:cursor`, rt.pacing.jitter),
      });
      records[pg.id] = placed.record;
      if (placed.glide) glides.push({ id: pg.id, glide: placed.glide });
    }
    if (Object.values(records).some((r) => (r as { how: string }).how === 'teleport')) {
      await rt.sleep(TELEPORT_SETTLE_MS);
      for (const pg of pages) await rt.painted(panes.get(pg.id)!.page);
    }
    // The still starts with every page painted (R-ISS-08), none on a sign-in page.
    await rt.awaitShownLoaded();
    rt.assertSignedIn();
    // The page of the first step acts from the start (no switch pause before it).
    const firstRaw = (scene.steps ?? [])[0] as { on?: string } | undefined;
    const firstActing = firstRaw?.on !== undefined && pages.some((p) => p.id === firstRaw.on) ? firstRaw.on : pages[0].id;
    await rt.act(firstActing);
    for (const pg of pages) {
      const pane = panes.get(pg.id)!;
      const entry: NonNullable<TimelineScene['pages']>[number] = { id: pg.id, viewport: { ...pg.viewport }, url: pane.page.url(), track: pg.id };
      if (pg.page !== undefined) entry.page = pg.page;
      if (pg.label !== undefined) entry.label = pg.label;
      ts.pages!.push(entry);
    }
    ts.url = panes.get(pages[0].id)!.page.url();
    const still: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_still', t_start: rt.now(), t_end: rt.now(), page: firstActing, status: 'ok' };
    rt.timeline.addEvent(still);
    const stillStart = wallNow();
    // A continuing page glides to its rest point during the still, one page after the other (only one cursor moves).
    for (const g of glides) {
      await rt.act(g.id);
      await g.glide();
    }
    await rt.act(firstActing);
    const left = stillStart + stillS * 1000 - wallNow();
    if (left > 0) await rt.sleep(left);
    still.t_end = rt.now();
    still.point = rt.pointer.pos();
    still.data = { cursor: records };
    ts.t_actions = still.t_end;

    const steps = scene.steps ?? [];
    let acting = firstActing;
    for (let i = 0; i < steps.length; i++) {
      const step = normalizeStep(steps[i], i);
      const on = step.on ?? pages[0].id;
      if (!pages.some((p) => p.id === on)) throw new StepError(`scene ${id}, step ${i}: unknown page "${on}" (this scene films ${pages.map((p) => p.id).join(', ')})`);
      if (on !== acting) {
        // The eye moves to the other page: a short pause, then that page's cursor glides from where it rests.
        await rt.sleep(rt.pacing.page_switch_ms);
        await rt.act(on);
        acting = on;
      }
      const outcome = await runStep(rt, opts, scene, si, step);
      const isUntil = opts.until !== null && opts.until.sceneIndex === si && opts.until.stepIndex === i;
      if (outcome === 'stop-scene') {
        ts.status = 'partial';
        if (!opts.record.stopped_at) opts.record.stopped_at = { scene: id, step: i, reason: 'irreversible' };
        rt.log('info', `dry-run: scene ${id} stops at irreversible step ${i}; the next scene continues`);
        for (let j = i + 1; j < steps.length; j++) {
          const s = normalizeStep(steps[j], j);
          const t = rt.now();
          rt.timeline.addEvent({ scene: id, scene_index: si, step: j, action: s.action, t_start: t, t_end: t, page: s.on ?? pages[0].id, status: 'skipped' });
        }
        break;
      }
      if (isUntil) {
        opts.record.stopped_at = { scene: id, step: i, reason: 'until' };
        return true;
      }
    }
    if (opts.until !== null && opts.until.sceneIndex === si) {
      opts.record.stopped_at ??= { scene: id, step: opts.until.stepIndex, reason: 'until' };
      return true;
    }
    return false;
  } catch (e) {
    ts.status = isCancelled(e) ? 'partial' : 'failed';
    throw e;
  } finally {
    ts.t_end = rt.now();
  }
}
