import { TemplateError, resolvePageUrl } from '@retake/core/base';
import { isCaptureScene, isCard, isInterstitial } from '@retake/core/language';
import { normalizeStep, resolveScenePages, sceneId, templateSceneEntry } from '@retake/core/language';
import type { NormalizedStep, Scene, SceneEntry, ResolvedScenePage } from '@retake/core/language';
import type { TimelineEvent, TimelineScene } from '@retake/core/run';
import type { RunningRun } from '@retake/core/run';
import { assertMayOpen, navigate } from './actions/pages.js';
import { RunnerError, StepError, errorMessage, isCancelled } from './errors.js';
import { Jitter } from './motion.js';
import { INSPECT_PAUSE_CAP_S } from './inspect-limits.js';
import type { Runtime, ScenePane } from './runtime.js';
import { placeSceneCursor } from './scene-cursor.js';
import { throwIfAborted, wallNow } from './util.js';
import { caption } from './step-describe.js';
import { runStep } from './scene-step.js';
import type { SceneLoopOptions } from './scene-step.js';

export { DEFAULT_STEP_TIMEOUT_S, runStep } from './scene-step.js';
export type { SceneLoopOptions, StepOutcome } from './scene-step.js';
export { describeStep } from './step-describe.js';
export { ERROR_DOM_MAX, StepFailure, trimSnippet } from './step-failure.js';

/** After a scene-start teleport, before the still: hover transitions of the element the pointer left settle. */
const TELEPORT_SETTLE_MS = 300;

/**
 * Template part of the scenario (R-RUN-16): a TemplateError fails the run; a {{hooks.…}} token that cannot resolve
 * because the setup hooks were skipped says how to run them.
 */
export function templated<T>(fn: () => T, record: RunningRun): T {
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

/** The scene's own keys recorded on its timeline scene (caption, speed, transition, frame, tutorial, offscreen), then added. */
function addSceneTimeline(rt: Runtime, scene: Scene, ts: TimelineScene): void {
  const cap = caption(scene.caption);
  if (cap) ts.caption = cap;
  if (scene.speed !== undefined) ts.speed = scene.speed;
  if (scene.transition !== undefined) ts.transition = scene.transition;
  if (scene.frame !== undefined) ts.frame = scene.frame;
  if (scene.tutorial !== undefined) ts.tutorial = structuredClone(scene.tutorial);
  if (scene.offscreen === true) ts.offscreen = true;
  rt.timeline.addScene(ts);
}

/** A dry run stops the scene at an irreversible step: the scene is partial, its later steps recorded as skipped. */
function stopAtIrreversible(
  rt: Runtime,
  opts: SceneLoopOptions,
  ts: TimelineScene,
  { steps, at, pageOf }: { steps: NonNullable<Scene['steps']>; at: number; pageOf?: (s: NormalizedStep) => string },
): void {
  ts.status = 'partial';
  if (!opts.record.stopped_at) opts.record.stopped_at = { scene: ts.id, step: at, reason: 'irreversible' };
  rt.log('info', `dry-run: scene ${ts.id} stops at irreversible step ${at}; the next scene continues`);
  for (let j = at + 1; j < steps.length; j++) {
    const s = normalizeStep(steps[j], j);
    const t = rt.now();
    rt.timeline.addEvent({ scene: ts.id, scene_index: ts.index, step: j, action: s.action, t_start: t, t_end: t, ...(pageOf ? { page: pageOf(s) } : {}), status: 'skipped' });
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
    // The text the video shows reads the display URLs; steps and `open` the real ones.
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
    if (await runPageScene(rt, opts, scene, { si, id, pageKey })) return;
  }
  // The last frames never show a sign-in page either.
  rt.assertSignedIn();
}

/**
 * A single-page scene on page `pageKey`: the page activated, its `open`, the scene-start cursor and still, then the
 * steps. Returns true when the run stops here (--until).
 */
async function runPageScene(rt: Runtime, opts: SceneLoopOptions, scene: Scene, { si, id, pageKey }: { si: number; id: string; pageKey: string }): Promise<boolean> {
  const fresh = !rt.session.has(pageKey);
  const switched = rt.activeId !== pageKey;
  await rt.activate(pageKey);
  const ts: TimelineScene = { id, index: si, kind: 'scene', t_start: rt.now(), t_end: rt.now(), page: pageKey, status: 'ok' };
  rt.current = { scene: id, scene_index: si, step: -1 };
  addSceneTimeline(rt, scene, ts);
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
    // A scene never starts on a sign-in page.
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
        stopAtIrreversible(rt, opts, ts, { steps, at: i });
        break;
      }
      if (isUntil) {
        opts.record.stopped_at = { scene: id, step: i, reason: 'until' };
        return true;
      }
    }
    // --until on a scene that ended early (or has no steps) still ends the run here.
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

/** The pages of a multi-page scene laid out and opened; returns their panes and the pages it opened. */
async function enterScenePages(rt: Runtime, pages: ResolvedScenePage[], ts: TimelineScene, fresh: ReadonlySet<string>): Promise<{ panes: Map<string, ScenePane>; opened: Set<string> }> {
  const { id, index: si } = ts;
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
  return { panes, opened };
}

/**
 * Each page's cursor of a multi-page scene: next to that page's first target (its own steps), never on it —
 * teleported while its page loads (then the hover transitions settle), else glided during the still (returned).
 */
async function placePageCursors(
  rt: Runtime,
  opts: SceneLoopOptions,
  scene: Scene,
  ts: TimelineScene,
  { pages, panes, opened, fresh, stillS }: { pages: ResolvedScenePage[]; panes: Map<string, ScenePane>; opened: Set<string>; fresh: ReadonlySet<string>; stillS: number },
): Promise<{ glides: Array<{ id: string; glide: () => Promise<void> }>; records: Record<string, unknown> }> {
  const id = ts.id;
  const glides: Array<{ id: string; glide: () => Promise<void> }> = [];
  const records: Record<string, unknown> = {};
  for (const pg of pages) {
    await rt.act(pg.id);
    const own = (scene.steps ?? []).filter((raw) => ((raw as { on?: string }).on ?? pages[0].id) === pg.id);
    const placed = await placeSceneCursor(
      rt,
      { id, steps: own, ...(pg.cursor !== undefined ? { cursor: pg.cursor } : {}) },
      {
        loading: opened.has(pg.id) || fresh.has(pg.id),
        idle: own.length === 0,
        stillMs: stillS * 1000,
        jitter: new Jitter(`${opts.scenarioName}:${scene.id}:${pg.id}:cursor`, rt.pacing.jitter),
      },
    );
    records[pg.id] = placed.record;
    if (placed.glide) glides.push({ id: pg.id, glide: placed.glide });
  }
  if (Object.values(records).some((r) => (r as { how: string }).how === 'teleport')) {
    await rt.sleep(TELEPORT_SETTLE_MS);
    for (const pg of pages) await rt.painted(panes.get(pg.id)!.page);
  }
  return { glides, records };
}

/**
 * A multi-page scene: its pages are opened and recorded at the same time, each on its own track (one clock);
 * each page's cursor is placed (teleported while its page loads, else glided during the still); then the steps run on
 * the page they name (`on:`, default the first page). When a step acts on another page than the previous one, the
 * runner pauses `pacing.page_switch_ms` and that page's cursor glides from where it rests — the other cursor stays
 * still, visible. Returns true when the run stops here (--until).
 */
async function runPagesScene(rt: Runtime, opts: SceneLoopOptions, scene: Scene, si: number, id: string): Promise<boolean> {
  let pages: ResolvedScenePage[];
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
  addSceneTimeline(rt, scene, ts);
  try {
    const { panes, opened } = await enterScenePages(rt, pages, ts, fresh);
    rt.assertSignedIn();
    const stillS = Math.min(scene.still ?? rt.pacing.scene_start_still, rt.inspecting ? INSPECT_PAUSE_CAP_S : Infinity);
    const { glides, records } = await placePageCursors(rt, opts, scene, ts, { pages, panes, opened, fresh, stillS });
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
        stopAtIrreversible(rt, opts, ts, { steps, at: i, pageOf: (s) => s.on ?? pages[0].id });
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
