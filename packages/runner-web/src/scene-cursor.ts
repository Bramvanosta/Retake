import { describeTarget, isPoint, normalizeStep, normalizeTarget } from '@demo-studio/core';
import type { BBox, MenuArgs, NormalizedStep, PointSpec, Scene, SceneCursor, ScrollArgs, TargetSpec } from '@demo-studio/core';
import { primaryTarget } from './actions/index.js';
import { errorMessage } from './errors.js';
import { distance } from './motion.js';
import type { Jitter } from './motion.js';
import type { Runtime } from './runtime.js';
import { clamp, wallNow } from './util.js';

/** Steps that travel to an element: the cursor should rest near the first one at the scene start. */
const POINTER_ACTIONS = new Set(['click', 'double_click', 'hover', 'type', 'select', 'pick', 'menu', 'drag', 'drop_file', 'new_tab']);
/** Steps that change what is on screen before any pointer step: no anchor can be predicted across them. */
const PAGE_CHANGING = new Set(['open', 'new_tab', 'switch_page', 'press', 'eval']);
/** How long a scene that opened a page waits for its first target to render before falling back. */
const ANCHOR_WAIT_MS = 1500;
/** Clearance kept between the drawn cursor and the anchor box. */
const COVER_CLEAR = 10;

/** What the scene-start placement did (recorded as `data.cursor` of the scene_still event). */
export interface SceneCursorRecord {
  /** Requested placement. */
  mode: 'auto' | 'keep' | 'point' | 'target';
  /** teleport = placed while the page loaded (before the still); glide = eased move during the still; keep = no move. */
  how: 'teleport' | 'glide' | 'keep';
  from?: PointSpec;
  to: PointSpec;
  /** auto: the first pointer target the rest point was chosen next to, and on which side. */
  anchor?: string;
  side?: string;
  /** ms of the glide. */
  move_ms?: number;
}

interface Anchor {
  desc: string;
  box: BBox;
}

/** The first pointer step, and the document scroll that precedes it (if any). Null when a page change comes first. */
export function firstPointerStep(steps: NormalizedStep[]): { step: NormalizedStep; scrolls: ScrollArgs[] } | null {
  const scrolls: ScrollArgs[] = [];
  for (const step of steps) {
    if (step.action === 'cursor') return null; // the scenario moves the cursor itself
    if (POINTER_ACTIONS.has(step.action)) {
      if (step.action === 'type' && (step.args as { into?: unknown }).into === undefined) continue;
      if (step.action === 'new_tab' && (step.args as { target?: unknown }).target === undefined) return null;
      return { step, scrolls };
    }
    if (PAGE_CHANGING.has(step.action)) return null;
    if (step.action === 'scroll') scrolls.push(step.args as ScrollArgs);
  }
  return null;
}

function normalized(scene: Scene): NormalizedStep[] {
  const out: NormalizedStep[] = [];
  (scene.steps ?? []).forEach((s, i) => {
    try {
      out.push(normalizeStep(s, i));
    } catch {
      /* invalid steps fail later, in their own step */
    }
  });
  return out;
}

/** Box of the first pointer step's target right now (no waiting, no scrolling), or null. */
async function anchorBox(rt: Runtime, step: NormalizedStep): Promise<Anchor | null> {
  const { kit } = rt;
  if (step.action === 'menu') {
    const a = step.args as MenuArgs;
    if (a.trigger === undefined && typeof a.row === 'string') {
      const rowRef = await kit.rowFor(a.row);
      const trig = rowRef ? await kit.menuTrigger(rowRef) : null;
      const pt = trig ? await kit.point(trig) : null;
      return pt ? { desc: `menu trigger of row "${a.row}"`, box: pt.bbox } : null;
    }
  }
  const t = primaryTarget(step);
  if (!t) return null;
  const r = await kit.find(normalizeTarget(t));
  if (r.count === 0 || !('bbox' in r)) return null;
  return { desc: r.desc || describeTarget(t), box: r.bbox };
}

/** Document scroll performed by the scroll steps before the first pointer step (null: not predictable). */
async function predictedScroll(rt: Runtime, scrolls: ScrollArgs[]): Promise<number | null> {
  if (!scrolls.length) return 0;
  const { kit } = rt;
  const container = await kit.scrollContainerFor(null);
  const info = await kit.scrollInfo(container);
  let top = info.top;
  for (const s of scrolls) {
    if (s.in !== undefined) return null;
    if (typeof s.to === 'number') top = s.to;
    else if (s.to === 'top') top = 0;
    else if (s.to === 'bottom') top = info.max_top;
    else if (s.to === undefined && s.by !== undefined) top += s.by;
    else return null; // a scroll to a target: its final position is computed at run time
    top = clamp(Math.round(top), 0, Math.max(0, info.max_top));
  }
  return top - info.top;
}

async function findAnchor(rt: Runtime, scene: Scene, waitMs: number): Promise<Anchor | null> {
  const first = firstPointerStep(normalized(scene));
  if (!first) return null;
  const deadline = wallNow() + waitMs;
  for (;;) {
    const a = await anchorBox(rt, first.step).catch(() => null);
    if (a) {
      const dy = await predictedScroll(rt, first.scrolls).catch(() => null);
      if (dy === null) return null;
      const box = { ...a.box, y: a.box.y - dy };
      const W = rt.capture.width;
      const H = rt.capture.height;
      // Only an anchor that will be on screen when its step starts is useful.
      if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= W || box.y >= H) return null;
      return { desc: a.desc, box };
    }
    if (wallNow() >= deadline) return null;
    await rt.sleep(100);
  }
}

/** The drawn arrow extends right and down from its hotspot: does it cover `box` at point p? */
export function cursorCovers(p: PointSpec, box: BBox, size = 26, clear = COVER_CLEAR): boolean {
  const l = p.x - 6;
  const t = p.y - 6;
  const r = p.x + size * 0.8 + 4;
  const b = p.y + size + 6;
  return r > box.x - clear && l < box.x + box.w + clear && b > box.y - clear && t < box.y + box.h + clear;
}

function insideViewport(rt: Runtime, p: PointSpec): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= rt.capture.width && p.y <= rt.capture.height;
}

function clampToViewport(rt: Runtime, p: PointSpec): PointSpec {
  return { x: clamp(Math.round(p.x), 4, rt.capture.width - 4), y: clamp(Math.round(p.y), 4, rt.capture.height - 4) };
}

/**
 * Place the cursor for a scene start. `loading`: the scene opened a page (or switched to another one), so the
 * cursor is teleported now, before the still (that part of the capture is cut by the editor); otherwise it glides
 * during the still (`still()` is called to sleep the remaining stillness). Never throws: a failure keeps the cursor.
 */
export async function placeSceneCursor(
  rt: Runtime,
  scene: Scene,
  opts: { loading: boolean; stillMs: number; jitter: Jitter },
): Promise<{ record: SceneCursorRecord; glide: (() => Promise<void>) | null }> {
  const spec: SceneCursor = scene.cursor ?? 'auto';
  const { pointer, kit } = rt;
  const from = pointer.known ? pointer.pos() : undefined;
  const mode: SceneCursorRecord['mode'] = spec === 'auto' || spec === 'keep' ? spec : isPoint(spec) ? 'point' : 'target';
  let to: PointSpec | null = null;
  let anchor: Anchor | null = null;
  let side: string | undefined;
  try {
    if (spec === 'keep' && pointer.known) {
      to = null;
    } else if (mode === 'point') {
      to = clampToViewport(rt, spec as PointSpec);
    } else if (mode === 'target') {
      const t = normalizeTarget(spec as TargetSpec);
      const r = await kit.find(t);
      if (r.count > 0 && 'ref' in r) {
        const pt = await kit.point(r.ref);
        if (pt) to = { x: pt.x, y: pt.y };
      }
      if (!to) rt.warn(`scene ${scene.id}: cursor target ${describeTarget(spec as TargetSpec)} not found at the scene start; the cursor rests at an automatic spot`);
    }
    if (to === null && !(spec === 'keep' && pointer.known)) {
      anchor = await findAnchor(rt, scene, opts.loading ? ANCHOR_WAIT_MS : 0);
      if (!opts.loading && from && insideViewport(rt, from) && (!anchor || !cursorCovers(from, anchor.box))) {
        to = null; // a continuing scene keeps a position that is already clear of its first target
      } else if (anchor) {
        const plan = await kit.restNear(anchor.box);
        to = { x: plan.x, y: plan.y };
        side = plan.side;
      } else if (opts.loading || !from) {
        to = await kit.restPoint();
        side = 'fallback';
      }
    }
  } catch (e) {
    rt.log('debug', `scene ${scene.id}: cursor placement failed (${errorMessage(e)}); keeping it`);
    to = null;
  }

  const record: SceneCursorRecord = { mode, how: 'keep', to: from ?? { x: 0, y: 0 } };
  if (from) record.from = from;
  if (anchor) record.anchor = anchor.desc;
  if (side) record.side = side;
  if (!to || (from && distance(from, to) < 1)) {
    if (!pointer.known) {
      const p = await kit.restPoint();
      await pointer.teleport(p);
      record.to = pointer.pos();
      record.how = 'teleport';
    }
    return { record, glide: null };
  }
  if (opts.loading || !from) {
    await pointer.teleport(to);
    record.how = 'teleport';
    record.to = pointer.pos();
    return { record, glide: null };
  }
  // Continuing scene: no jump in the capture — an eased move during the still.
  const target = to;
  record.how = 'glide';
  record.to = target;
  const glide = async () => {
    const lead = Math.min(300, opts.stillMs * 0.2);
    await rt.sleep(lead);
    record.move_ms = await pointer.moveTo(target, { jitter: opts.jitter });
  };
  return { record, glide };
}
