/**
 * L4.3 part 3, the app's pure form logic (forms.ts) against the real forms (core stepForms, what scenario_forms
 * answers): an input read with its field's schema rules (numbers and their bounds, whole numbers, patterns, one line,
 * options, required — a group's fields only once the group has a value), the changes a form sends (field patches with
 * the value shown, critique B2), a refused save's issue placed at its field, and an edit found again on a newer version
 * ("Apply it to the new version": a form's step by its fingerprint, a new step after the same step by its guard).
 */
import { describe, expect, it } from 'vitest';
import { scenarioBlocks, stepForms } from '@retake/core';
import type { SceneBlock } from '@retake/core';
import { anchorOf, editAgain, fieldsOf, formChanges, issueField, readInput, readInputs } from '../src/app/script/forms.js';
import type { View } from '../src/app/words/scenario-words.js';

const forms = stepForms();
const typeFields = fieldsOf(forms, 'type');
const field = (key: string) => typeFields.find((f) => f.key === key)!;

describe('readInput: the schema rules in the form', () => {
  it('numbers: a number, above an exclusive minimum (cps > 0), whole numbers for integers; empty is not set unless required', () => {
    expect(readInput(field('type.cps'), '12.5', false)).toEqual({ value: 12.5 });
    expect(readInput(field('type.cps'), '-3', false)).toEqual({ error: 'more than 0' });
    expect(readInput(field('type.cps'), '0', false)).toEqual({ error: 'more than 0' });
    expect(readInput(field('type.cps'), 'fast', false)).toEqual({ error: 'a number' });
    expect(readInput(field('type.cps'), '1e400', false)).toEqual({ error: 'a number' });
    expect(readInput(field('type.cps'), '', false)).toEqual({ value: undefined });
    expect(readInput(field('type.into.nth'), '1.5', false)).toEqual({ error: 'a whole number' });
    expect(readInput(field('type.into.nth'), '-1', false)).toEqual({ value: -1 });
    expect(readInput(field('speed'), '9', false)).toEqual({ error: 'at most 8' });
    expect(readInput(field('hold'), '-1', false)).toEqual({ error: 'at least 0' });
  });

  it('texts: one line, the slug pattern of a mark, at least one character where the schema says so; choices: their options only', () => {
    expect(readInput(field('type.text'), 'a\nb', true)).toEqual({ error: 'one line only' });
    expect(readInput(field('type.text'), '', true)).toEqual({ error: 'needs a value' });
    expect(readInput(field('mark'), 'my mark', false)).toMatchObject({ error: expect.stringMatching(/letters, digits/) });
    expect(readInput(field('mark'), 'my-mark', false)).toEqual({ value: 'my-mark' });
    expect(readInput(field('type.into.in'), 'dialog', false)).toEqual({ value: 'dialog' });
    expect(readInput(field('type.into.in'), 'sidebar', false)).toMatchObject({ error: expect.stringMatching(/one of dialog/) });
    expect(readInput(field('type.clear'), 'true', false)).toEqual({ value: true });
    expect(readInput(field('type.clear'), 'false', false)).toEqual({ value: false });
  });

  it("a group's required field (caption text) is required only once the group has a value", () => {
    expect(readInputs(typeFields, { 'type.text': 'x', 'caption.text': '', 'caption.kicker': '' }).errors).toEqual({});
    expect(readInputs(typeFields, { 'type.text': 'x', 'caption.text': '', 'caption.kicker': 'K' }).errors).toEqual({ 'caption.text': 'needs a value' });
  });
});

describe('formChanges: field patches with the value the form showed (critique B2)', () => {
  it('only the changed fields, each with `from` (absent: none) and `to` (absent: removed); locked fields left out', () => {
    const before = { 'type.text': 'Light roast', 'type.cps': 18, 'caption.text': 'Note' };
    const after = { 'type.text': 'Dark roast', 'type.cps': 18, 'type.clear': true };
    expect(formChanges(typeFields, before, after)).toEqual([
      { path: ['type', 'text'], from: 'Light roast', to: 'Dark roast' },
      { path: ['type', 'clear'], to: true },
      { path: ['caption', 'text'], from: 'Note' },
    ]);
    expect(formChanges(typeFields, before, after, new Set(['type.text']))).toHaveLength(2);
    expect(formChanges(typeFields, before, before)).toEqual([]);
  });
});

describe('issueField: a refused save at its field', () => {
  it("an issue's path inside the step → the longest field key it starts with; another step's issue → none", () => {
    expect(issueField(['scenes', 2, 'steps', 4, 'type', 'cps'], 2, 4, typeFields)).toBe('type.cps');
    expect(issueField(['scenes', 2, 'steps', 4, 'type', 'into', 'label'], 2, 4, typeFields)).toBe('type.into.label');
    expect(issueField(['scenes', 2, 'steps', 4, 'type', 'into'], 2, 4, typeFields)).toBe('type.into.text');
    expect(issueField(['scenes', 2, 'steps', 5, 'type', 'cps'], 2, 4, typeFields)).toBeUndefined();
    expect(issueField(['video'], 2, 4, typeFields)).toBeUndefined();
  });
});

describe('editAgain: an edit on a newer version ("Apply it to the new version")', () => {
  const view = (text: string) => ({ blocks: scenarioBlocks(text) }) as unknown as View;
  const T0 = 'video: v\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: One\n      - type: {text: Light}\n        caption: Old\n';
  const scene = (v: View) => v.blocks.entries.find((e) => e.type === 'scene') as SceneBlock;

  it("a form's changes go to the same step found by its fingerprint with its new guard (a caption changed and a step added above meanwhile); a step whose arguments changed is not found", () => {
    const v0 = view(T0);
    const st = scene(v0).steps[1];
    const op = { kind: 'set_step' as const, at: { scene: 'a', index: 1, guard: st.guard! }, changes: [{ path: ['type', 'text'], from: 'Light', to: 'Dark' }] };
    const anchor = anchorOf(v0, 'a', 1);
    const v1 = view(T0.replace('      - click: One\n', '      - hold: 1\n      - click: One\n').replace('caption: Old', 'caption: New'));
    const again = editAgain(op, anchor, v1);
    expect(again).toEqual({ op: { ...op, at: { scene: 'a', index: 2, guard: scene(v1).steps[2].guard } } });
    expect(editAgain(op, anchor, view(T0.replace('{text: Light}', '{text: Other}')))).toEqual({ why: 'the step it changes is no longer in the file as it was, or its scene now has more or fewer steps like it' });
  });

  it('a new step goes after the same step as before (by its guard); moves go as they were (their guard decides)', () => {
    const v0 = view(T0);
    const g = scene(v0).steps[0].guard!;
    const ins = { kind: 'insert_step' as const, to: { scene: 'a', index: 1 }, after: g, action: 'hold' as const, values: { hold: 1 } };
    const v1 = view(T0.replace('    steps:\n', '    steps:\n      - hold: 2\n'));
    expect(editAgain(ins, null, v1)).toEqual({ op: { ...ins, to: { scene: 'a', index: 2 } } });
    expect(editAgain(ins, null, view(T0.replace('click: One', 'click: Two')))).toEqual({ why: 'the step it was to follow changed or moved' });
    const mv = { kind: 'move_step' as const, from: { scene: 'a', index: 0, guard: g }, to: { scene: 'a', index: 1 } };
    expect(editAgain(mv, null, v1)).toEqual({ op: mv });
  });
});

describe('review fixes (L4.3 reviews A and B)', () => {
  const view = (text: string) => ({ blocks: scenarioBlocks(text) }) as unknown as View;
  const scene = (v: View) => v.blocks.entries.find((e) => e.type === 'scene') as SceneBlock;

  it('B M2: an untouched "" is no change (no removal sent); a required text that holds "" reads as ""; a typed field still changes', () => {
    const captionFields = fieldsOf(forms, 'click');
    const before = { 'click.text': 'Save', 'caption.kicker': '', 'caption.text': 'Saved' };
    const shown = { 'click.text': 'Save', 'caption.kicker': '', 'caption.text': 'Saved' };
    const inputs = { ...shown, 'caption.text': 'Saved!' };
    const { values, errors } = readInputs(captionFields, inputs, new Set(), before);
    expect(errors).toEqual({});
    expect(formChanges(captionFields, before, values, new Set(), { inputs, shown })).toEqual([{ path: ['caption', 'text'], from: 'Saved', to: 'Saved!' }]);
    // Whatever an untouched input reads back as (here "" read without the held value: not set), it is no change.
    const blind = readInputs(captionFields, inputs).values;
    expect(blind['caption.kicker']).toBeUndefined();
    expect(formChanges(captionFields, before, blind, new Set(), { inputs, shown })).toEqual([{ path: ['caption', 'text'], from: 'Saved', to: 'Saved!' }]);
    // type {text: "", clear: true}: "needs a value" no more, nothing to save until something is typed.
    const held = { 'type.text': '', 'type.clear': true };
    const typeShown = { 'type.text': '', 'type.clear': 'true' };
    const r = readInputs(typeFields, typeShown, new Set(), held);
    expect(r.errors).toEqual({});
    expect(formChanges(typeFields, held, r.values, new Set(), { inputs: typeShown, shown: typeShown })).toEqual([]);
    expect(readInput(field('type.text'), '', true, '')).toEqual({ value: '' });
    expect(readInput(field('type.text'), '', true, 'x')).toEqual({ error: 'needs a value' });
    // A field cleared on purpose is a removal.
    const cleared = { ...shown, 'caption.kicker': '', 'click.text': 'Save', 'caption.text': '' };
    const c = readInputs(captionFields, { ...shown, 'caption.text': '', 'caption.kicker': '' }, new Set(), before);
    expect(formChanges(captionFields, before, c.values, new Set(), { inputs: cleared, shown })).toEqual([{ path: ['caption', 'text'], from: 'Saved' }]);
  });

  it("A L5: Apply finds a form's step again only while its scene has as many steps like it (a deleted twin no longer moves the edit to the next one)", () => {
    const T = 'video: v\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: Save\n        caption: First\n      - hold: 1\n      - click: Save\n        caption: Second\n';
    const v0 = view(T);
    const st = scene(v0).steps[0];
    const op = { kind: 'set_step' as const, at: { scene: 'a', index: 0, guard: st.guard! }, changes: [{ path: ['speed'], to: 2 }] };
    const anchor = anchorOf(v0, 'a', 0);
    expect(anchor).toMatchObject({ nth: 0, count: 2 });
    // The first "click: Save" deleted meanwhile: the nth would now be the second one — refused.
    const gone = view(T.replace('      - click: Save\n        caption: First\n', ''));
    expect(editAgain(op, anchor, gone)).toEqual({ why: 'the step it changes is no longer in the file as it was, or its scene now has more or fewer steps like it' });
    // A step added elsewhere: found, with its new index and guard.
    const added = view(T.replace('      - hold: 1\n', '      - hold: 1\n      - hold: 2\n'));
    expect(editAgain(op, anchor, added)).toEqual({ op: { ...op, at: { scene: 'a', index: 0, guard: scene(added).steps[0].guard } } });
  });
});
