/**
 * L4.2 part 1 (critique B4): which step of a run a step of today's scenario is — the picture identity (fingerprint +
 * `on:` + the scene's page / open / pages / persona) and the matching after edits. A step whose frame no longer shows
 * what it does has no picture (`changed`, `new`, `scene_changed`); a modifier-only edit keeps it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchRunSteps, scenarioBlocks, sceneStepFingerprints, stepFingerprint } from '@retake/core';
import type { RunStepMatch } from '@retake/core';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A scenario with scenes given as [id, scene keys (YAML flow), steps (YAML flow each)]. */
function yaml(scenes: Array<[string, string, string[]]>): string {
  return `video: x\nscenes:\n${scenes.map(([id, keys, steps]) => `  - id: ${id}\n${keys ? `    ${keys}\n` : ''}    steps:\n${steps.map((s) => `      - ${s}\n`).join('')}`).join('')}`;
}

function match(run: string, now: string): Record<string, RunStepMatch> {
  const a = sceneStepFingerprints(run);
  const b = sceneStepFingerprints(now);
  expect(a && b).toBeTruthy();
  return Object.fromEntries(matchRunSteps(b!, a!));
}

const RUN = yaml([
  [
    'request',
    'page: shop\n    open: /products',
    ['{click: Request a quote}', '{click: {aria: Increase, in: dialog}}', '{click: {aria: Increase, in: dialog}}', '{select: {field: Bag size, option: 5 kg}}', '{hold: 1.2}'],
  ],
  ['send', '', ['{click: Send}', '{wait_for: Sent}']],
]);

describe('matchRunSteps', () => {
  it('the same file: every step is its own run step', () => {
    expect(match(RUN, RUN)).toEqual({
      'request.0': { run_index: 0 },
      'request.1': { run_index: 1 },
      'request.2': { run_index: 2 },
      'request.3': { run_index: 3 },
      'request.4': { run_index: 4 },
      'send.0': { run_index: 0 },
      'send.1': { run_index: 1 },
    });
  });

  it('a step inserted at the top: it is new, every other keeps its own run step (never its neighbour’s picture)', () => {
    const now = RUN.replace('      - {click: Request a quote}\n', '      - {wait_for: Ready}\n      - {click: Request a quote}\n');
    const m = match(RUN, now);
    expect(m['request.0']).toEqual({ missing: 'new' });
    expect([1, 2, 3, 4, 5].map((i) => m[`request.${i}`])).toEqual([0, 1, 2, 3, 4].map((j) => ({ run_index: j })));
  });

  it('an argument changed: that step is changed (naming the run step it replaced); the others keep theirs', () => {
    const m = match(RUN, RUN.replace('option: 5 kg', 'option: 1 kg'));
    expect(m['request.3']).toEqual({ missing: 'changed', run_index: 3 });
    expect(m['request.4']).toEqual({ run_index: 4 });
    expect(m['request.2']).toEqual({ run_index: 2 });
  });

  it('a changed step is paired with the run step of the same action between its neighbours, not the one before it (review B L1)', () => {
    const run = yaml([['a', 'page: shop\n    open: /', ['{click: Start}', '{wait_for: Ready}', '{click: Go}', '{hold: 1}']]]);
    const m = match(run, run.replace('      - {wait_for: Ready}\n', '').replace('{click: Go}', '{click: Go now}'));
    expect(m['a.1']).toEqual({ missing: 'changed', run_index: 2 });
    expect([m['a.0'], m['a.2']]).toEqual([{ run_index: 0 }, { run_index: 3 }]);
    // No candidate of the same action: in order, as before.
    const m2 = match(run, run.replace('{wait_for: Ready}', '{type: {into: Name, text: X}}'));
    expect(m2['a.1']).toEqual({ missing: 'changed', run_index: 1 });
  });

  it('a step removed: the rest keep their run steps; identical steps map in order', () => {
    const m = match(RUN, RUN.replace('      - {click: {aria: Increase, in: dialog}}\n', ''));
    expect([0, 1, 2, 3].map((i) => m[`request.${i}`])).toEqual([{ run_index: 0 }, { run_index: 1 }, { run_index: 3 }, { run_index: 4 }]);
  });

  it('only modifiers changed (caption, hold, speed, camera, mark, overlay, id): the picture is kept', () => {
    const now = RUN.replace(
      '{select: {field: Bag size, option: 5 kg}}',
      '{select: {field: Bag size, option: 5 kg}, caption: Pick a size, hold: 2, speed: 1.5, camera: {zoom: 1.3}, mark: size, id: size, overlay: {component: studio/overlay-callout}}',
    );
    expect(match(RUN, now)['request.3']).toEqual({ run_index: 3 });
  });

  it('`on:` changed: the step acts on another page — changed', () => {
    const run = yaml([['both', 'pages: [desk, phone]', ['{click: Save, on: phone}', '{hold: 1}']]]);
    const m = match(run, run.replace('on: phone', 'on: desk'));
    expect(m['both.0']).toEqual({ missing: 'changed', run_index: 0 });
    expect(m['both.1']).toEqual({ run_index: 1 });
    // `on:` added where it was the default page is a change of identity too (safe side).
    expect(match(yaml([['s', 'pages: [desk, phone]', ['{click: Save}']]]), yaml([['s', 'pages: [desk, phone]', ['{click: Save, on: desk}']]]))['s.0']).toEqual({ missing: 'changed', run_index: 0 });
  });

  it.each([
    ['open', (t: string) => t.replace('open: /products', 'open: /quotes')],
    ['page', (t: string) => t.replace('page: shop', 'page: console')],
    ['persona', (t: string) => t.replace('open: /products', 'open: /products\n    persona: buyer')],
    ['pages', (t: string) => t.replace('page: shop\n    open: /products', 'pages: [shop]')],
  ])('the scene’s %s changed: every step of the scene is scene_changed', (_what, edit) => {
    const m = match(RUN, edit(RUN));
    for (let i = 0; i < 5; i++) expect(m[`request.${i}`]).toEqual({ missing: 'scene_changed' });
    // `send` names no page: it inherits request's — a page change reaches it, an open change does not.
    expect(m['send.0']).toEqual(_what === 'page' ? { missing: 'scene_changed' } : _what === 'pages' ? { missing: 'scene_changed' } : { run_index: 0 });
  });

  it('a scene the run did not have, and a step with no single action', () => {
    const now = RUN.replace('  - id: send\n', '  - id: extra\n    steps:\n      - {hold: 1}\n  - id: send\n').replace('{wait_for: Sent}', '{wait_for: Sent, click: X}');
    const m = match(RUN, now);
    expect(m['extra.0']).toEqual({ missing: 'scene_not_in_run' });
    expect(m['send.1']).toEqual({ missing: 'unreadable' });
  });

  it('occurrences: two identical steps are 0 and 1 (blocks and snapshots agree)', () => {
    const blocks = scenarioBlocks(RUN);
    const scene = blocks.entries[0];
    expect(scene.type === 'scene' && scene.steps.map((s) => s.occurrence)).toEqual([0, 0, 1, 0, 0]);
    const ids = sceneStepFingerprints(RUN)!;
    expect(ids.get('request')!.steps.map((s) => s.n)).toEqual([0, 0, 1, 0, 0]);
    expect(ids.get('request')!.steps[1].fp).toBe(stepFingerprint({ click: { aria: 'Increase', in: 'dialog' } }));
  });

  it('a text that does not parse has no identity; a recursive alias is refused', () => {
    expect(sceneStepFingerprints('scenes: [')).toBeUndefined();
    expect(sceneStepFingerprints('video: x\nscenes:\n  - &a {id: a, steps: [*a]}\n')).toBeUndefined();
  });

  it('on the fixture scenarios: blocks carry exactly the snapshot identities (one rule for both sides)', () => {
    for (const name of ['quote', 'catalogue', 'phone-and-desktop', 'signup']) {
      const text = readFileSync(join(ROOT, 'projects', 'northfield-fixture', 'scenarios', `${name}.yaml`), 'utf8');
      const ids = sceneStepFingerprints(text)!;
      for (const e of scenarioBlocks(text).entries) {
        if (e.type !== 'scene') continue;
        const id = ids.get(e.id)!;
        expect(e.context, `${name} ${e.id}`).toBe(id.context);
        expect(e.steps.map((s) => [s.fingerprint, s.picture, s.occurrence])).toEqual(id.steps.map((s) => [s.fp, s.picture, s.n]));
      }
      // Today's file against itself: every step matched.
      expect([...matchRunSteps(ids, ids).values()].every((m) => 'run_index' in m && !('missing' in m))).toBe(true);
    }
  });
});
