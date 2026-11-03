/**
 * All missing targets of a scene in one take (L5.6, R-FLD-10): when a step's target is not found, the targets of the
 * scene's later steps are looked up on the same page, without acting, and those that do not resolve either are listed
 * with the visible elements closest to each — five renamed labels show in one failed take, not in five.
 */
import { describeTarget, hasLocator, normalizeStep, normalizeTarget, pickTarget } from '@retake/core';
import type { MissingTarget, NearElement, NormalizedStep, Scene, TargetObject, TargetSpec } from '@retake/core';
import { StepError } from './errors.js';
import type { Runtime } from './runtime.js';

/** At most this many later targets are looked up (one in-page call). */
const MAX_TARGETS = 40;

/** Whether a step failed because its target was not found (resolve.ts notFoundError). */
export function isNotFound(e: unknown): e is StepError {
  return e instanceof StepError && e.details.candidates === 0 && e.details.target !== undefined;
}

/** The targets a step looks for on the page it runs on (none for the elements a popup it opens holds). */
export function stepTargets(step: NormalizedStep): TargetSpec[] {
  const a = step.args as unknown as Record<string, unknown>;
  const out: unknown[] = [];
  switch (step.action) {
    case 'click':
    case 'double_click':
    case 'hover':
      if (a.outside === undefined || a.outside === false) out.push(pickTarget(a as TargetObject));
      break;
    case 'type':
      out.push(a.into);
      break;
    case 'select':
      out.push(a.combobox ?? (typeof a.field === 'string' ? { label: a.field } : a.field));
      break;
    case 'pick':
    case 'date':
      out.push(typeof a.field === 'string' ? { label: a.field } : a.field);
      break;
    case 'menu':
      out.push(a.trigger ?? (typeof a.row === 'string' ? { text: a.row } : a.row));
      break;
    case 'scroll':
      if (a.to !== undefined && typeof a.to === 'object') out.push(a.to);
      out.push(a.in);
      break;
    case 'drag':
      out.push(a.from, a.to);
      break;
    case 'drop_file':
      out.push(a.zone);
      break;
    case 'wait_for':
    case 'assert':
      out.push(a.target);
      break;
    case 'download':
      out.push(a.click);
      break;
    case 'capture_text':
      out.push(a.target);
      break;
    case 'new_tab':
      out.push(a.target);
      break;
    default:
      break;
  }
  return out.filter((t): t is TargetSpec => t !== undefined && t !== null && (typeof t === 'string' || hasLocator(normalizeTarget(t as TargetSpec))));
}

/** Steps that leave the page: what follows them is looked for on another page. */
const PAGE_CHANGES = new Set(['open', 'new_tab', 'switch_page']);

/**
 * The later steps' targets of `scene` (after step `failed`, on the same page — up to the first step that opens another
 * page) that do not resolve on the page now, with their closest visible elements. Never throws: [] when the page
 * cannot be read.
 */
export async function missingTargets(rt: Runtime, scene: Scene, failed: NormalizedStep): Promise<MissingTarget[]> {
  const steps = scene.steps ?? [];
  const wanted: Array<{ step: NormalizedStep; target: TargetObject }> = [];
  for (let i = failed.index + 1; i < steps.length && wanted.length < MAX_TARGETS; i++) {
    let step: NormalizedStep;
    try {
      step = normalizeStep(steps[i], i);
    } catch {
      continue;
    }
    if (PAGE_CHANGES.has(step.action) || (step.on ?? null) !== (failed.on ?? null)) break;
    for (const t of stepTargets(step)) wanted.push({ step, target: normalizeTarget(t) });
  }
  if (!wanted.length) return [];
  let checks: Array<{ count: number; near: NearElement[] }>;
  try {
    checks = await rt.kit.closest(wanted.map((w) => w.target));
  } catch {
    return [];
  }
  const out: MissingTarget[] = [];
  wanted.forEach((w, k) => {
    if ((checks[k]?.count ?? 1) > 0) return;
    out.push({ scene: scene.id, step: w.step.index, action: w.step.action, target: describeTarget(w.target), near: checks[k].near });
  });
  return out;
}

/** "button "Export all"" — a near element as the messages show it. */
export function formatNearElement(e: NearElement): string {
  const label = e.name ?? e.text ?? '';
  return `${e.role ?? 'element'}${label ? ` ${JSON.stringify(label)}` : ''}${e.text && e.name && e.text !== e.name ? ` (${JSON.stringify(e.text)})` : ''}`;
}

/** The lines the run error adds for the other missing targets. */
export function formatMissing(list: MissingTarget[]): string {
  if (!list.length) return '';
  const lines = list.map((m) => `  - step ${m.step} (${m.action}) ${m.target}: ${m.near.length ? `closest: ${m.near.map(formatNearElement).join(', ')}` : 'nothing close on the page'}`);
  return `\n${list.length} later target${list.length > 1 ? 's' : ''} of scene ${list[0].scene} not on this page either (looked up without acting; some may only show after the steps before them):\n${lines.join('\n')}`;
}
