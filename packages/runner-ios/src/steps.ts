/**
 * The steps an iOS run plays (core checks/ios.ts IOS_STEP_ACTIONS), through the XCUITest driver: `click` taps an
 * element's frame centre (or a point), `type` taps its field and types in chunks timed to the step's pace, `press` sends
 * the keyboard's return or delete key, `scroll` swipes, `open` follows a deep link of the environment's schemes (checked
 * again once templated), the waits and checks poll the app's elements, `screenshot` takes the device's picture, `hook`
 * and `emit` as on the web. Every tap and swipe is logged (touch-track.ts) for the overlay and the timeline. Times are
 * the driver's (the host's wall clock) on the capture clock.
 */
import { join } from 'node:path';
import { describeTarget, isPoint } from '@retake/core/language';
import type { AssertArgs, NormalizedArgsMap, NormalizedStep, PressArgs, ScrollArgs, TargetObject, TargetSpec, TypeArgs, WaitForArgs } from '@retake/core/language';
import { iosNavigationProblem } from '@retake/core/policy';
import type { BBox, PointSpec } from '@retake/core/model';
import type { CaptureRun, CaptureTools, HookStepOutcome } from '@retake/runner-web/types';
import type { DriverClient, DriverElement, DriverReply } from './driver-client.js';
import { DriverError } from './driver-client.js';
import type { DriverQuery } from './query.js';
import { driverQuery } from './query.js';
import type { TouchRecord } from './touch-track.js';

/** What the steps act on: the run, the driver, the device's screen, the app, and the touches logged. */
export interface IosStage {
  run: CaptureRun;
  tools: CaptureTools;
  client: Pick<DriverClient, 'cmd'>;
  /** The device's screen in points. */
  screen: { width: number; height: number };
  bundleId: string;
  schemes: readonly string[];
  touches: TouchRecord[];
  /** A picture of the device's screen into `file` (simctl io screenshot). */
  screenshot(file: string): Promise<void>;
  /** What runs a `hook:` step (the lifecycle's), once set. */
  hookStep?: (name: string) => Promise<HookStepOutcome>;
  /** Seconds a step waits for its target by default (`defaults.timeout_s`, else 15). */
  timeoutS: number;
  /** One warning per run of a kind (typing slower than asked). */
  warned: Set<string>;
}

/** What a step's action gives its event. */
export interface StepResult {
  target?: { desc: string; bbox?: BBox };
  point?: PointSpec;
  /** The event of a `hold` step holds still (its hold span). */
  hold?: boolean;
  data?: unknown;
}

/** A step that fails in words (the scene loop makes it a StepFailure). */
export class IosStepError extends Error {
  constructor(
    message: string,
    readonly notFound = false,
  ) {
    super(message);
    this.name = 'IosStepError';
  }
}

/** Before each touch: the viewer's eye reaches the place (the dot shows 150 ms before the touch-down). */
export const TOUCH_LEAD_MS = 250;
/** XCUITest types about one character per 37 ms in one call; each call costs about 290 ms of its own. */
export const TYPE_CHAR_S = 0.037;
export const TYPE_CALL_S = 0.29;

/** The capture time of a wall-clock instant of the driver (epoch ms, Date's clock). */
export function captureTime(run: CaptureRun, epochMs: number): number {
  // The capture clock runs on performance.timeOrigin + now(); the driver stamps with Date: converted at the call.
  return run.clock.at(epochMs - (Date.now() - (performance.timeOrigin + performance.now())));
}

const frameBox = (e: DriverElement): BBox | undefined => (e.frame ? { x: round1(e.frame.x), y: round1(e.frame.y), w: round1(e.frame.w), h: round1(e.frame.h) } : undefined);
const round1 = (n: number) => Math.round(n * 10) / 10;

function timeoutMs(stage: IosStage, step: NormalizedStep, own?: number): number {
  return Math.round((own ?? step.timeout ?? stage.timeoutS) * 1000);
}

/** A tap, logged as a touch; its element (a query tap) and point. */
async function tap(stage: IosStage, body: { query?: DriverQuery; x?: number; y?: number; timeout_ms?: number }): Promise<DriverReply & DriverElement & { t_act: number; point: PointSpec }> {
  const { run, tools } = stage;
  await tools.sleep(TOUCH_LEAD_MS, run.signal);
  const wait = body.timeout_ms ?? 0;
  const r = await stage.client.cmd<DriverElement & { t_act: number; point: PointSpec }>('tap', body, wait + 30_000);
  stage.touches.push({ kind: 'tap', t_act: captureTime(run, r.t_act), t_end: captureTime(run, r.t_end), x: round1(r.point.x), y: round1(r.point.y) });
  return r;
}

/** Tap a target (or a point): the touch logged on the step's event too. */
async function tapTarget(stage: IosStage, step: NormalizedStep, target: TargetSpec | PointSpec): Promise<StepResult & { element?: DriverElement }> {
  if (isPoint(target)) {
    const r = await tap(stage, { x: target.x, y: target.y });
    return { point: r.point };
  }
  const desc = describeTarget(target);
  let r: Awaited<ReturnType<typeof tap>>;
  try {
    r = await tap(stage, { query: driverQuery(target), timeout_ms: timeoutMs(stage, step) });
  } catch (e) {
    if (e instanceof DriverError && e.kind === 'failed' && /no element matches/.test(e.message)) {
      throw new IosStepError(`no element matches ${desc} within ${(timeoutMs(stage, step) / 1000).toFixed(0)} s`, true);
    }
    throw e;
  }
  const bbox = frameBox(r);
  return { target: { desc, ...(bbox ? { bbox } : {}) }, point: { x: round1(r.point.x), y: round1(r.point.y) }, element: r };
}

async function click(stage: IosStage, step: NormalizedStep, args: NormalizedArgsMap['click']): Promise<StepResult> {
  const target: TargetSpec | PointSpec = isPoint(args as unknown) ? (args as unknown as PointSpec) : (args as TargetObject);
  const { element: _e, ...res } = await tapTarget(stage, step, target);
  await stage.tools.sleep(stage.run.pacing.after_click_ms, stage.run.signal);
  return res;
}

/** How many characters one typing call takes to keep to `cps` (one call for the fastest paces). Pure. */
export function typingChunk(cps: number, chars: number): number {
  const per = 1 / cps;
  if (per <= TYPE_CHAR_S) return Math.max(1, chars);
  return Math.max(1, Math.min(chars, Math.round(TYPE_CALL_S / (per - TYPE_CHAR_S))));
}

/** Type `text` in chunks paced to `cps`; the pace reached (characters per second). */
async function typeChunks(stage: IosStage, text: string, cps: number): Promise<number> {
  const { run, tools } = stage;
  const chars = [...text];
  const size = typingChunk(cps, chars.length);
  const t0 = Date.now();
  for (let i = 0; i < chars.length; i += size) {
    await stage.client.cmd('type', { text: chars.slice(i, i + size).join('') }, 60_000);
    const due = t0 + ((i + size) / cps) * 1000;
    const left = due - Date.now();
    if (left > 0 && i + size < chars.length) await tools.sleep(left, run.signal);
  }
  const s = (Date.now() - t0) / 1000;
  return s > 0 ? chars.length / s : cps;
}

async function typeStep(stage: IosStage, step: NormalizedStep, args: TypeArgs): Promise<StepResult> {
  const { run, tools } = stage;
  const text = args.text ?? '';
  // Typed text reaches xcodebuild's output and the result bundle: a secret value is never typed on iOS (the checks
  // refuse a secret reference; this catches one that came in another way, a hook's result, a templated value).
  if (text && run.secrets.contains(text)) throw new IosStepError('this type step would type a secret value: typing secrets is not available on iOS (it would reach the logs of the simulator)');
  let res: StepResult = {};
  let field: DriverElement | undefined;
  if (args.into !== undefined) {
    const t = await tapTarget(stage, step, args.into);
    field = t.element;
    res = { ...(t.target ? { target: t.target } : {}), ...(t.point ? { point: t.point } : {}) };
    await tools.sleep(300, run.signal);
  }
  if (args.clear) {
    const value = field?.value ?? '';
    const len = value && value !== field?.placeholder ? [...value].length : 0;
    if (len > 0) await stage.client.cmd('key', { name: 'delete', times: len }, 60_000);
  }
  if (text) {
    if (args.fill) await stage.client.cmd('type', { text }, 60_000);
    else {
      const cps = args.cps ?? run.pacing.type_cps;
      const reached = await typeChunks(stage, text, cps);
      if (reached < cps * 0.7 && !stage.warned.has('typing')) {
        stage.warned.add('typing');
        run.timeline.warn(`typing on the simulator runs at about ${reached.toFixed(1)} characters per second, slower than the ${cps} asked: the video shows the real pace`);
      }
    }
  }
  if (args.enter) await stage.client.cmd('key', { name: 'return' }, 30_000);
  return res;
}

async function pressStep(stage: IosStage, args: PressArgs): Promise<StepResult> {
  const k = args.key.trim().toLowerCase();
  const name = k === 'enter' || k === 'return' ? 'return' : k === 'backspace' || k === 'delete' ? 'delete' : null;
  if (!name) throw new IosStepError(`key "${args.key}" is not available on iOS (Enter, Return, Backspace, Delete)`);
  await stage.client.cmd('key', { name, times: Math.max(1, args.times ?? 1) }, 30_000);
  return { data: { key: args.key } };
}

/** One swipe from `from` to `to` (points), logged as a touch. */
async function swipe(stage: IosStage, from: PointSpec, to: PointSpec, dragS: number): Promise<void> {
  const { run, tools } = stage;
  await tools.sleep(TOUCH_LEAD_MS, run.signal);
  const press = 0.05;
  const hold = 0.1;
  const r = await stage.client.cmd<{ t_act: number }>('swipe', { from, to, duration_ms: Math.round(dragS * 1000), press_ms: press * 1000, hold_ms: hold * 1000 }, 60_000);
  stage.touches.push({ kind: 'swipe', t_act: captureTime(run, r.t_act), t_end: captureTime(run, r.t_end), x: from.x, y: from.y, to, press_s: press, drag_s: dragS, hold_s: hold });
}

/** The vertical swipe that scrolls the content by `dy` points (positive: down the page), inside the safe span. Pure. */
export function swipeFor(screen: { width: number; height: number }, dy: number): { from: PointSpec; to: PointSpec } {
  const span = Math.min(Math.abs(dy), screen.height * 0.6);
  const mid = screen.height * 0.55;
  const x = Math.round(screen.width / 2);
  const half = span / 2;
  return dy >= 0 ? { from: { x, y: Math.round(mid + half) }, to: { x, y: Math.round(mid - half) } } : { from: { x, y: Math.round(mid - half) }, to: { x, y: Math.round(mid + half) } };
}

async function scrollStep(stage: IosStage, args: ScrollArgs): Promise<StepResult> {
  const drag = Math.min(2, Math.max(0.25, args.duration ?? 0.6));
  const { screen } = stage;
  if (args.by !== undefined) {
    let left = args.by;
    for (let i = 0; i < 10 && Math.abs(left) >= 1; i++) {
      const s = swipeFor(screen, left);
      await swipe(stage, s.from, s.to, drag);
      left -= Math.sign(left) * Math.abs(s.from.y - s.to.y);
    }
    await stage.tools.sleep(300, stage.run.signal);
    return {};
  }
  if (args.to === undefined || typeof args.to === 'number' || args.to === 'top' || args.to === 'bottom') {
    throw new IosStepError('scroll on iOS takes `by` (points) or `to` a target (no position, no top or bottom)');
  }
  const target = args.to;
  const q = driverQuery(target);
  const top = 110;
  const bottom = screen.height - 150;
  for (let i = 0; i <= 10; i++) {
    const e = await stage.client.cmd<DriverElement>('find', { query: q, timeout_ms: 0 }, 30_000);
    const f = e.frame;
    if (e.exists && f && f.y >= top && f.y + f.h <= bottom) {
      const bbox = frameBox(e);
      return { target: { desc: describeTarget(target), ...(bbox ? { bbox } : {}) } };
    }
    if (i === 10) break;
    const dy = e.exists && f ? (f.y < top ? f.y - top - 40 : f.y + f.h - bottom + 60) : screen.height * 0.6;
    const s = swipeFor(screen, dy);
    await swipe(stage, s.from, s.to, drag);
    await stage.tools.sleep(400, stage.run.signal);
  }
  throw new IosStepError(`${describeTarget(target)} did not come into view after 10 swipes`, true);
}

/** Follow a deep link (the driver's open: no system prompt), checked against the environment's schemes. */
export async function openLink(stage: IosStage, url: string): Promise<void> {
  const problem = iosNavigationProblem(url, { envName: stage.run.env.name, ios: { schemes: stage.schemes } });
  if (problem) throw new IosStepError(problem);
  await stage.client.cmd('open', { url }, 30_000);
  await stage.tools.sleep(600, stage.run.signal);
}

/** Poll `found()` until it says `want` or the time is up. */
async function poll(stage: IosStage, ms: number, want: boolean, found: (left: number) => Promise<DriverElement>): Promise<DriverElement | null> {
  const until = Date.now() + ms;
  for (;;) {
    const left = Math.max(0, until - Date.now());
    const e = await found(want ? left : 0);
    if (e.exists === want) return e;
    if (Date.now() >= until) return null;
    await stage.tools.sleep(200, stage.run.signal);
  }
}

/** wait_for and assert: the text, the target, their absence (assert: now, wait_for: within the timeout). */
async function waitOrAssert(stage: IosStage, step: NormalizedStep, args: WaitForArgs | AssertArgs, ms: number): Promise<StepResult> {
  const find = (query: DriverQuery) => (left: number) => stage.client.cmd<DriverElement>('find', { query, timeout_ms: Math.min(left, 5000) }, left + 30_000);
  const what = step.action === 'assert' ? 'is not' : `did not appear within ${(ms / 1000).toFixed(0)} s`;
  const gone = step.action === 'assert' ? 'is still there' : `was still there after ${(ms / 1000).toFixed(0)} s`;
  if ((args as AssertArgs).count !== undefined) throw new IosStepError('`count` is not available on iOS');
  let res: StepResult = {};
  if (args.text !== undefined && !(await poll(stage, ms, true, find({ text: args.text })))) throw new IosStepError(`text "${args.text}" ${what} on screen`, true);
  if (args.target !== undefined) {
    const e = await poll(stage, ms, true, find(driverQuery(args.target)));
    if (!e) throw new IosStepError(`${describeTarget(args.target)} ${what} on screen`, true);
    const bbox = frameBox(e);
    res = { target: { desc: describeTarget(args.target), ...(bbox ? { bbox } : {}) } };
  }
  if (args.not_text !== undefined && !(await poll(stage, ms, false, find({ text: args.not_text })))) throw new IosStepError(`text "${args.not_text}" ${gone}`);
  if (args.gone !== undefined && !(await poll(stage, ms, false, find(driverQuery(args.gone))))) throw new IosStepError(`${describeTarget(args.gone)} ${gone}`);
  return res;
}

/** A file name of a screenshot's name. Pure. */
export function shotName(name: string): string {
  return `${
    name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'screenshot'
  }.png`;
}

/** Play one step's action; what it gives its event. */
export async function playStep(stage: IosStage, step: NormalizedStep): Promise<StepResult> {
  const { run, tools } = stage;
  const a = step.args as unknown;
  switch (step.action) {
    case 'click':
      return click(stage, step, a as NormalizedArgsMap['click']);
    case 'type':
      return typeStep(stage, step, a as TypeArgs);
    case 'press':
      return pressStep(stage, a as PressArgs);
    case 'scroll':
      return scrollStep(stage, a as ScrollArgs);
    case 'open':
      await openLink(stage, (a as NormalizedArgsMap['open']).url);
      return { data: { url: (a as NormalizedArgsMap['open']).url } };
    case 'wait':
      await tools.sleep((a as { seconds: number }).seconds * 1000, run.signal);
      return {};
    case 'hold':
      await tools.sleep((a as { seconds: number }).seconds * 1000, run.signal);
      return { hold: true };
    case 'wait_for':
      return waitOrAssert(stage, step, a as WaitForArgs, timeoutMs(stage, step, (a as WaitForArgs).timeout));
    case 'assert':
      return waitOrAssert(stage, step, a as AssertArgs, 0);
    case 'screenshot': {
      const file = join(run.screenshotsDir, shotName((a as { name: string }).name));
      await stage.screenshot(file);
      run.record.screenshots.push(file);
      return { data: { path: file } };
    }
    case 'hook': {
      if (!stage.hookStep) throw new IosStepError(`hook "${(a as { name: string }).name}": this run cannot run hooks`);
      return { data: await stage.hookStep((a as { name: string }).name) };
    }
    case 'emit':
      return { data: { name: (a as { name: string }).name, data: (a as { data?: unknown }).data ?? null } };
    default:
      throw new IosStepError(`${step.action} is not available on iOS`);
  }
}

/** The app must still be in front after a step (a step that sends it away, or a system alert over it, fails). */
export async function assertForeground(stage: IosStage): Promise<void> {
  const r = await stage.client.cmd<{ state: string }>('state', {}, 15_000);
  if (r.state !== 'runningForeground') throw new IosStepError(`the app is not in the foreground any more (${r.state}): a step opened another app, or the app quit`);
}
