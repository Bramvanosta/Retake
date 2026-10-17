import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { ElementHandle } from 'playwright-core';
import { isPoint, projectFileProblem } from '@demo-studio/core';
import type { DragArgs, DropFileArgs, PointSpec, TargetSpec } from '@demo-studio/core';
import { StepError } from '../errors.js';
import { distance, moveDuration } from '../motion.js';
import { resolveTarget } from '../resolve.js';
import type { Resolved } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { clamp, formatBytes, mimeFor } from '../util.js';
import { approach, clickData } from './click.js';
import type { ActionResult } from './types.js';

/** Default size of a fake dropped file. */
export const FAKE_FILE_BYTES = 48 * 1024;
/** Real files above this size are refused (they travel to the page as base64). */
const MAX_DROP_BYTES = 64 * 1024 * 1024;
/** Travel time of the file ghost from the viewport edge to the drop zone. */
const GHOST_TRAVEL_MS = 1300;
const GHOST_FADE_MS = 250;

export async function drag(ctx: StepContext, args: DragArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const { pointer, pacing } = rt;
  const from = await resolveTarget(ctx, args.from);
  let to: PointSpec;
  let toDesc: string;
  if (isPoint(args.to)) {
    to = args.to;
    toDesc = `(${to.x}, ${to.y})`;
  } else {
    const r = await resolveTarget(ctx, args.to as TargetSpec, { scroll: false });
    to = r.point;
    toDesc = r.desc;
  }
  await approach(ctx, from);
  await rt.sleep(ctx.jitter.ms(pacing.hover_ms));
  const start = pointer.pos();
  const t_click = await pointer.press();
  await rt.sleep(150);
  // A short first nudge gets drag libraries past their activation distance before the long travel.
  const dx = Math.sign(to.x - start.x) || 1;
  const dy = Math.sign(to.y - start.y) || 1;
  await pointer.moveTo({ x: start.x + 6 * dx, y: start.y + 4 * dy }, { ms: 120, arc: false });
  const ms = args.duration !== undefined ? args.duration * 1000 : ctx.jitter.ms(moveDuration(distance(start, to), pacing) * 1.25);
  await pointer.moveTo(to, { ms, jitter: ctx.jitter });
  await rt.sleep(150);
  await pointer.release();
  await rt.sleep(ctx.jitter.ms(pacing.after_click_ms));
  ctx.clicks.push({ role: 'trigger', t: t_click, point: start, desc: from.desc, bbox: from.bbox, strategy: 'real', popup_opened: false });
  return { target: { desc: `${from.desc} → ${toDesc}`, bbox: from.bbox }, point: pointer.pos(), t_click, data: { from: start, to } };
}

interface FilePayload {
  name: string;
  mime: string;
  bytes: Buffer | null;
  size: number;
}

async function loadPayload(ctx: StepContext, args: DropFileArgs): Promise<FilePayload> {
  if (args.path) {
    if (ctx.rt.agentTrust) {
      const problem = projectFileProblem(ctx.rt.project.dir, args.path);
      if (problem) throw new StepError(`drop_file: ${problem}`);
    }
    const file = isAbsolute(args.path) ? args.path : join(ctx.rt.project.dir, args.path);
    let bytes: Buffer;
    try {
      // The size first: a file above the cap is refused without being read.
      const { size } = await stat(file);
      if (size > MAX_DROP_BYTES) {
        throw new StepError(`drop_file: ${file} is ${formatBytes(size)}; files above ${formatBytes(MAX_DROP_BYTES)} cannot be dropped`);
      }
      bytes = await readFile(file);
    } catch (e) {
      if (e instanceof StepError) throw e;
      throw new StepError(`drop_file: cannot read ${file}: ${(e as Error).message}`);
    }
    if (bytes.length > MAX_DROP_BYTES) {
      throw new StepError(`drop_file: ${file} is ${formatBytes(bytes.length)}; files above ${formatBytes(MAX_DROP_BYTES)} cannot be dropped`);
    }
    const name = args.name ?? basename(file);
    return { name, mime: args.mime ?? mimeFor(name), bytes, size: bytes.length };
  }
  if (!args.name) throw new StepError('drop_file: give `path` (a real file) or `name` (with fake: true)');
  const size = args.size ?? FAKE_FILE_BYTES;
  return { name: args.name, mime: args.mime ?? mimeFor(args.name), bytes: null, size };
}

function entryPoint(side: NonNullable<DropFileArgs['from']>, zone: PointSpec, w: number, h: number): PointSpec {
  switch (side) {
    case 'left':
      return { x: 2, y: clamp(zone.y + 60, 16, h - 16) };
    case 'top':
      return { x: clamp(zone.x + 120, 16, w - 16), y: 2 };
    case 'bottom':
      return { x: clamp(zone.x + 120, 16, w - 16), y: h - 2 };
    default:
      return { x: w - 2, y: clamp(zone.y + 60, 16, h - 16) };
  }
}

async function elementHandle(ctx: StepContext, ref: string): Promise<ElementHandle<Element>> {
  const h = await ctx.rt.page.evaluateHandle((r) => {
    const k = (window as unknown as { __demoStudio?: { el(r: string): Element | null } }).__demoStudio;
    return k ? k.el(r) : null;
  }, ref);
  const el = h.asElement();
  if (!el) throw new StepError(`${ctx.step.action}: element is gone`);
  return el as ElementHandle<Element>;
}

/**
 * A file chip travels with the cursor from the viewport edge into the drop zone, then the file is delivered:
 * drag events with a real DataTransfer, or the zone's <input type=file> when no drop handler accepted it.
 */
export async function dropFile(ctx: StepContext, args: DropFileArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const { pointer, kit, pacing } = rt;
  const payload = await loadPayload(ctx, args);
  const zone = await resolveTarget(ctx, args.zone);
  let input: Resolved | null = null;
  if (args.input !== undefined) input = await resolveTarget(ctx, args.input, { includeHidden: true, scroll: false });

  const start = entryPoint(args.from ?? 'right', zone.point, rt.viewport.width, rt.viewport.height);
  // The hand fetches the file at the edge of the screen: an eased move out (never a visible jump), then back in
  // carrying the file chip.
  if (pointer.known && pointer.visible) await pointer.moveTo(start, { jitter: ctx.jitter });
  else await pointer.teleport(start);
  if (!input) {
    await kit.fileDragBegin({
      name: payload.name,
      mime: payload.mime,
      size: payload.size,
      base64: payload.bytes ? payload.bytes.toString('base64') : undefined,
    });
  }
  let delivered: 'drop' | 'input' | null = null;
  let t_click = 0;
  try {
    await kit.ghostShow(payload.name, formatBytes(payload.size));
    await rt.sleep(GHOST_FADE_MS);
    await pointer.moveTo(zone.point, { ms: ctx.jitter.ms(GHOST_TRAVEL_MS), jitter: ctx.jitter });
    await rt.sleep(GHOST_FADE_MS);
    await kit.ghostHide();
    t_click = rt.now();
    if (!input) {
      const out = await kit.fileDragDrop(zone.point.x, zone.point.y);
      if (out.accepted) delivered = 'drop';
    }
  } catch (e) {
    if (!input) await kit.fileDragCancel().catch(() => undefined);
    throw e;
  }
  if (!delivered) {
    const inputRef = input?.ref ?? (await kit.fileInputFor(zone.ref));
    if (!inputRef) {
      throw new StepError(
        `drop_file: ${zone.spec} did not accept the dropped file and no <input type=file> was found in or around it (pass \`input\`)`,
      );
    }
    const handle = await elementHandle(ctx, inputRef);
    await handle.setInputFiles({
      name: payload.name,
      mimeType: payload.mime,
      buffer: payload.bytes ?? Buffer.alloc(payload.size, 0x20),
    });
    delivered = 'input';
  }
  await rt.sleep(ctx.jitter.ms(pacing.after_click_ms));
  // The drop is the step's only "click": its strategy says how the file was delivered (drop events or the file input).
  const strategy = delivered === 'drop' ? 'drop' : 'input';
  ctx.clicks.push({ role: 'trigger', t: t_click, point: zone.point, desc: zone.desc, bbox: zone.bbox, strategy, popup_opened: false });
  return {
    target: { desc: zone.desc, bbox: zone.bbox },
    point: pointer.pos(),
    t_click,
    strategy,
    popup_opened: false,
    data: { file: payload.name, size: payload.size, delivered, clicks: clickData(ctx) },
  };
}
