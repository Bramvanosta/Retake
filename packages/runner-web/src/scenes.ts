import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeTarget, interpolate, isCard, isInterstitial, isPoint, normalizeStep, normalizeTarget, sceneId } from '@demo-studio/core';
import type {
  CameraHint,
  CaptionSpec,
  MenuArgs,
  NormalizedStep,
  OverlaySpec,
  RunProgress,
  RunRecord,
  Scenario,
  Scene,
  TargetSpec,
  TimelineEvent,
  TimelineScene,
} from '@demo-studio/core';
import { ACTIONS, primaryTarget } from './actions/index.js';
import type { ActionResult } from './actions/types.js';
import { approach } from './actions/click.js';
import { menuTriggerFor } from './actions/widgets.js';
import { navigate } from './actions/pages.js';
import { StepError, errorMessage, isCancelled } from './errors.js';
import { Jitter } from './motion.js';
import { resolveTarget } from './resolve.js';
import type { Runtime, StepContext } from './runtime.js';
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
    case 'scroll':
      return a.to !== undefined ? `to ${typeof a.to === 'object' ? describeTarget(a.to as TargetSpec) : a.to}` : `by ${a.by}`;
    case 'wait_for':
    case 'assert':
      return JSON.stringify(a).slice(0, 100);
    case 'screenshot':
      return String(a.name);
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
  const out: NonNullable<TimelineEvent['overlay']> = {
    component: spec.component,
    slots: { ...(spec.slots ?? {}) },
    params: structuredClone(spec.params ?? {}),
  };
  if (spec.duration !== undefined) out.duration = spec.duration;
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
  return out;
}

async function errorArtifacts(rt: Runtime, scene: string, step: number, e: unknown): Promise<{ screenshot?: string; dom?: string }> {
  const base = join(rt.screenshotsDir, `error-${fileSlug(scene)}-${step}`);
  const out: { screenshot?: string; dom?: string } = {};
  try {
    await rt.page.screenshot({ path: `${base}.png`, timeout: 10_000 });
    out.screenshot = `${base}.png`;
  } catch (err) {
    rt.log('warn', `error screenshot failed: ${errorMessage(err)}`);
  }
  try {
    const ref = e instanceof StepError ? e.domRef : null;
    const html = await rt.kit.snapshot(ref, ERROR_DOM_MAX);
    const header = [
      '<!-- Demo Studio step failure',
      `  scene: ${scene}  step: ${step}`,
      `  url: ${rt.page.url()}`,
      `  error: ${errorMessage(e).replace(/--/g, '—')}`,
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
  const file = join(rt.screenshotsDir, `${fileSlug(scene)}-${pad(step.index, 2)}-${step.action}.png`);
  try {
    await rt.page.screenshot({ path: file, timeout: 10_000 });
    opts.record.screenshots.push(file);
  } catch (e) {
    rt.log('warn', `dry-run screenshot failed: ${errorMessage(e)}`);
  }
}

type StepOutcome = 'ok' | 'failed-optional' | 'stop-scene';

async function runStep(rt: Runtime, opts: SceneLoopOptions, scene: Scene, sceneIndex: number, step: NormalizedStep): Promise<StepOutcome> {
  const ctx: StepContext = {
    rt,
    scene: { id: scene.id, index: sceneIndex },
    step,
    timeoutMs: (step.timeout ?? DEFAULT_STEP_TIMEOUT_S) * 1000,
    jitter: new Jitter(`${opts.scenarioName}:${scene.id}:${step.index}`, rt.pacing.jitter),
    clicks: [],
  };
  const desc = describeStep(step);
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
    rt.timeline.addMarker({ name: step.mark, t: ev.t_start, scene: scene.id, step: step.index });
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
    const handler = ACTIONS[step.action] as (c: StepContext, a: unknown) => Promise<ActionResult>;
    const res = await handler(ctx, step.args);
    ev.t_end = rt.now();
    if (res.target) ev.target = res.target;
    if (res.point) ev.point = { x: res.point.x, y: res.point.y };
    if (res.t_click !== undefined) ev.t_click = res.t_click;
    if (res.strategy) ev.strategy = res.strategy;
    if (res.popup_opened !== undefined) ev.popup_opened = res.popup_opened;
    if (res.data !== undefined) ev.data = res.data;
    if (res.hold) ev.hold = { t_start: ev.t_start, t_end: ev.t_end };
    if (step.camera) ev.camera = await cameraFor(ctx, step.camera, res);
    if (step.overlay) ev.overlay = await overlayFor(ctx, step.overlay, res);
    if (step.hold !== undefined && step.hold > 0) {
      await rt.sleep(step.hold * 1000);
      ev.hold = { t_start: ev.t_end, t_end: rt.now() };
    }
    if (rt.mode === 'dry') await dryScreenshot(rt, opts, scene.id, step);
    return outcome;
  } catch (e) {
    ev.t_end = rt.now();
    ev.status = 'failed';
    ev.error = errorMessage(e);
    message = ev.error;
    if (isCancelled(e)) throw e;
    const art = await errorArtifacts(rt, scene.id, step.index, e);
    if (step.optional) {
      rt.warn(`${scene.id}.${step.index} (${step.action}) failed but is optional: ${ev.error}`);
      return (outcome = 'failed-optional');
    }
    throw new StepFailure(`scene ${scene.id}, step ${step.index} (${step.action} ${desc}): ${ev.error}`, scene.id, step.index, step.action, art.screenshot, art.dom);
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
  for (let si = 0; si < scenes.length; si++) {
    throwIfAborted(rt.signal);
    const entry = scenes[si];
    const id = sceneId(entry, si);
    if (isInterstitial(entry)) {
      const t = rt.now();
      rt.timeline.addScene({ id, index: si, kind: 'interstitial', t_start: t, t_end: t, interstitial: structuredClone(entry.interstitial), status: 'ok' });
      continue;
    }
    if (isCard(entry)) {
      // A card takes no capture time: the editor shows it between the clips around it.
      const t = rt.now();
      rt.timeline.addScene({ id, index: si, kind: 'card', t_start: t, t_end: t, card: structuredClone(entry.card), status: 'ok' });
      continue;
    }
    const scene = entry;
    if (scene.skip) {
      const t = rt.now();
      rt.timeline.addScene({ id, index: si, kind: 'scene', t_start: t, t_end: t, status: 'skipped' });
      continue;
    }
    opts.emit({ type: 'scene_start', scene: id, index: si });
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
    rt.timeline.addScene(ts);
    try {
      if (scene.open !== undefined) {
        const ev: TimelineEvent = { scene: id, scene_index: si, step: -1, action: 'scene_open', t_start: rt.now(), t_end: rt.now(), status: 'ok' };
        rt.timeline.addEvent(ev);
        const url = rt.resolveUrl(interpolate(scene.open, rt.template), pageKey);
        ev.target = { desc: url };
        await navigate(rt, rt.page, url);
        ev.t_end = rt.now();
        ev.page = pageKey;
        ev.url = rt.page.url();
      } else if (fresh) {
        rt.warn(`scene ${id} starts on a blank "${pageKey}" page (add \`open\`)`);
      }
      // Scene-start cursor (scene key `cursor`): placed while the page loads, or glided during the still — never a jump.
      const stillS = scene.still ?? rt.pacing.scene_start_still;
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
}
