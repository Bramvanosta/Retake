/**
 * Step structure edits from the Studio's Blocks tab (R-UI-11 / R-UI-12): move a step (within its scene or
 * to another one, an empty one included), delete it, duplicate it — as splices of the file's text, never a
 * re-serialisation: every byte outside the lines an edit touches stays as it was (comments, quoting, blank lines, line
 * breaks, a missing final line break). Pure; the engine (scenarios.edit) re-parses the result and refuses it unless its
 * value is exactly `intended` (core verifyEditText) — the splice model may refuse an unusual file, never corrupt it.
 *
 * - A step's span: its dash line to the end of its last content line (an inline comment on it included), plus the
 *   comment lines that belong to it (by column, never a line regex alone): the contiguous `#` lines just
 *   above the dash line at the dash's own column (not past the previous step's end or the `steps:` line), and the
 *   contiguous `#` lines just after it indented deeper than the dash (a commented-out modifier). A comment at another
 *   column (a section header at column 0) and blank lines stay where they are.
 * - Moving to a list whose dash sits at another column re-indents the span by the difference (a line less indented
 *   than its dash is refused). The only step moved out or deleted leaves `steps: []`; a step moved into `steps: []`
 *   turns it into a block list.
 * - Not editable (each with why, also shown on the block — blocks.ts `locked`): a step or scene written as a YAML alias,
 *   steps written as a non-empty flow list (`steps: [a, b]`), the steps of a scene with a dash item not written plainly
 *   (stepsDashWhy: an anchor, a tag or a comment after the dash is fine), a duplicate of a step holding an anchor (`&x`
 *   would be defined twice), removing a key of a flow map written over several lines or holding comments.
 * - Duplicate: the copy (without the comments around the original) drops `id` (ids are unique) and
 *   `mark` (a mark names one moment), and a capture's `as` (capture_text, download, wait_for_email: names are unique)
 *   gets the first free `-2`, `-3`… suffix; each change is a notice.
 * - Steps are addressed by scene id + index + `guard` (stepGuard, the canonical JSON of the step as written, modifiers
 *   included): an edit re-sent on a newer version ("Apply it to the new version") is refused as stale when that place
 *   now holds another step, instead of moving a neighbour.
 */
import { isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { Node, Pair, YAMLMap } from 'yaml';
import { CAPTURE_AS, StepEditError } from './step-edit-model.js';
import type { StepEdit, StepEditApplied } from './step-edit-model.js';
import {
  applySplices,
  blockOf,
  cloneValue,
  commentColumn,
  context,
  eolOf,
  finish,
  holdsAnchor,
  insertLines,
  insertion,
  itemLines,
  lastValueEnd,
  lineAt,
  lineEndOf,
  lineStartOf,
  pairRemoval,
  removal,
  sceneSteps,
  stepAt,
} from './step-edit-text.js';
import type { Ctx, Splice } from './step-edit-text.js';
import { composeWithTokens, insertStep, nodeIn, pairEnd, renderFlow, renderPair, setStep } from './step-value-edits.js';
import { stepActionKeys } from './steps.js';

export { STEP_EDIT_KINDS, StepEditError, stepGuard } from './step-edit-model.js';
export type { FieldChange, StepAt, StepEdit, StepEditApplied } from './step-edit-model.js';
export { stepsDashWhy } from './step-edit-text.js';
export { newStepValue } from './step-value-edits.js';

// ── The edits ───────────────────────────────────────────────────────────────

function moveStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'move_step' }>): StepEditApplied {
  const { scene: src, span } = stepAt(ctx, edit.from);
  const same = edit.to.scene === edit.from.scene;
  const dst = same ? src : sceneSteps(ctx, edit.to.scene);
  if (dst.flow && dst.values.length > 0) throw new StepEditError('not_editable', `the steps of scene ${dst.id} are written as a flow list: edit them in the YAML view`);
  const room = dst.values.length - (same ? 1 : 0);
  const j = edit.to.index;
  if (!Number.isInteger(j) || j < 0 || j > room) throw new StepEditError('stale', `scene ${dst.id} has no position ${j + 1} (any more): read the file again`);
  if (same && j === edit.from.index) throw new StepEditError('invalid', `step ${j + 1} of ${src.id} is already there: nothing to move`);
  const block = blockOf(ctx, span);
  // Index in the destination as it is in the file (the source still in it when moving within the scene).
  const target = same && j >= edit.from.index ? j + 1 : j;
  const splices = [...removal(src, span), ...insertion(ctx, dst, target, { block, dashCol: span.dashCol, keyColFrom: src.keyCol })];
  const intended = cloneValue(ctx.value);
  const [moved] = (intended.scenes[src.entry] as { steps: unknown[] }).steps.splice(edit.from.index, 1);
  (intended.scenes[dst.entry] as { steps: unknown[] }).steps.splice(j, 0, moved);
  return {
    text: finish(ctx, splices),
    intended,
    label: same ? `Moved step ${edit.from.index + 1} of ${src.id} to position ${j + 1}` : `Moved step ${edit.from.index + 1} of ${src.id} to position ${j + 1} of ${dst.id}`,
    select: `${dst.id}.${j}`,
    notices: [],
  };
}

function deleteStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'delete_step' }>): StepEditApplied {
  const { scene, span } = stepAt(ctx, edit.at);
  const i = edit.at.index;
  const intended = cloneValue(ctx.value);
  (intended.scenes[scene.entry] as { steps: unknown[] }).steps.splice(i, 1);
  const left = scene.values.length - 1;
  const notices: string[] = [];
  if (span.start < span.dashLine || span.end > span.contentEnd) notices.push('Its comment lines went with it.');
  if (left === 0) notices.push(`Scene ${scene.id} has no step now (steps: []).`);
  return {
    text: finish(ctx, removal(scene, span)),
    intended,
    label: `Deleted step ${i + 1} of ${scene.id}`,
    select: left === 0 ? null : `${scene.id}.${Math.min(i, left - 1)}`,
    notices,
  };
}

/** The `as` names the captures of the scenario's steps take (CAPTURE_AS). */
function takenCaptureNames(scenes: readonly unknown[]): Set<string> {
  const taken = new Set<string>();
  for (const e of scenes) {
    const steps = e && typeof e === 'object' ? (e as { steps?: unknown }).steps : undefined;
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      for (const a of Object.keys(CAPTURE_AS)) {
        const v = (s as Record<string, unknown>)[a];
        if (v && typeof v === 'object' && typeof (v as { as?: unknown }).as === 'string') taken.add((v as { as: string }).as);
      }
    }
  }
  return taken;
}

function duplicateStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'duplicate_step' }>): StepEditApplied {
  const { scene, span, node, raw } = stepAt(ctx, edit.at);
  const i = edit.at.index;
  const anchor = holdsAnchor(node);
  if (anchor) throw new StepEditError('not_editable', `step ${i + 1} of ${scene.id} defines the YAML anchor &${anchor}: a copy would define it twice — duplicate it in the YAML view`);
  const copy = cloneValue(raw) as Record<string, unknown>;
  const notices: string[] = [];
  const cuts: Splice[] = [];
  if (isMap(node) && copy && typeof copy === 'object') {
    const map = node as YAMLMap;
    const pairOf = (k: string) => map.items.find((p) => isScalar(p.key) && p.key.value === k) as Pair<Node, Node | null> | undefined;
    for (const [k, why] of [
      ['id', 'step ids are unique'],
      ['mark', 'a mark names one moment'],
    ] as const) {
      const p = pairOf(k);
      if (!p || copy[k] === undefined) continue;
      const [a, b] = pairRemoval(ctx.text, map, p, span.dashLine);
      cuts.push({ at: a, remove: b - a, insert: '' });
      notices.push(`The copy has no ${k}: ${why} (the original keeps "${String(copy[k])}").`);
      delete copy[k];
    }
    const action = stepActionKeys(copy)[0];
    const kind = action ? CAPTURE_AS[action] : undefined;
    const args = action ? copy[action] : undefined;
    const argsNode = action ? pairOf(action)?.value : undefined;
    if (kind && args && typeof args === 'object' && typeof (args as { as?: unknown }).as === 'string' && isMap(argsNode)) {
      const old = (args as { as: string }).as;
      const asNode = (argsNode as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === 'as')?.value;
      const taken = takenCaptureNames(ctx.value.scenes);
      let n = 2;
      while (taken.has(`${old}-${n}`)) n++;
      const name = `${old}-${n}`;
      if (!isScalar(asNode) || !asNode.range) throw new StepEditError('not_editable', "this capture's `as` is not a plain value: duplicate it in the YAML view");
      const [s, e] = asNode.range;
      const at = asNode.type === 'PLAIN' ? e : asNode.type === 'QUOTE_DOUBLE' || asNode.type === 'QUOTE_SINGLE' ? e - 1 : -1;
      if (at < 0 || (asNode.type === 'PLAIN' && ctx.text.slice(s, e) !== old)) throw new StepEditError('not_editable', "this capture's `as` is not written on one line: duplicate it in the YAML view");
      cuts.push({ at, remove: 0, insert: `-${n}` });
      (copy[action!] as { as: string }).as = name;
      notices.push(`The copy saves its ${kind} as "${name}": names of captures are unique (the original keeps "${old}").`);
    }
  }
  // The copy: the step's own lines (not the comments around it, nor a comment line after its last value that the node's
  // range takes in), with the cuts above, inserted after the original's span.
  const base = span.dashLine;
  const own = ctx.text.slice(base, Math.min(span.contentEnd, lineEndOf(ctx.text, Math.max(lastValueEnd(node), base + 1) - 1)));
  const copied = applySplices(
    own,
    cuts.map((c) => ({ ...c, at: c.at - base })),
  );
  const intended = cloneValue(ctx.value);
  (intended.scenes[scene.entry] as { steps: unknown[] }).steps.splice(i + 1, 0, copy);
  return {
    text: finish(ctx, [insertLines(ctx.text, span.end, copied, ctx.eol)]),
    intended,
    label: `Duplicated step ${i + 1} of ${scene.id}`,
    select: `${scene.id}.${i + 1}`,
    notices,
  };
}

export function applyStepEdit(text: string, edit: StepEdit): StepEditApplied {
  const ctx = context(text);
  switch (edit.kind) {
    case 'move_step':
      return moveStep(ctx, edit);
    case 'delete_step':
      return deleteStep(ctx, edit);
    case 'duplicate_step':
      return duplicateStep(ctx, edit);
    case 'set_step':
      return setStep(ctx, edit);
    case 'insert_step':
      return insertStep(ctx, edit);
    default: {
      const unknown: never = edit;
      throw new StepEditError('invalid', `unknown step edit "${String((unknown as { kind?: unknown }).kind)}"`);
    }
  }
}

/**
 * Why the steps of a scene (the `steps` node) take no block edit, or undefined (blocks.ts `locked`): written as an
 * alias, or as a non-empty flow list.
 */
export function stepsLockedWhy(stepsNode: unknown, aliased: boolean): string | undefined {
  if (aliased || isAlias(stepsNode)) return 'written as a YAML alias: edit it in the YAML view';
  if (isSeq(stepsNode) && stepsNode.flow && stepsNode.items.length > 0) return 'its scene writes its steps as a flow list ([…]): edit them in the YAML view';
  return undefined;
}

/**
 * The low-level text helpers of this module, shared by field-edits.ts (`set_field`), by
 * export only. Not meant for other callers.
 */
export const stepEditText = Object.freeze({
  lineStartOf,
  lineEndOf,
  lineAt,
  commentColumn,
  eolOf,
  applySplices,
  insertLines,
  itemLines,
  pairRemoval,
  composeWithTokens,
  nodeIn,
  renderFlow,
  renderPair,
  pairEnd,
});
