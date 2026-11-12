/**
 * L4.3 part 2, core step edits (step-edits.ts): move / delete / duplicate as text splices, checked with facts
 * independent of the splice code — the re-parsed value against the edit applied to the parsed value (verifyEditText),
 * the bytes outside the touched lines, moves reversible to the byte —, on every step of the fixture's 15 scenarios
 * (goldens), then a hostile corpus (critique B6: comment ownership by the dash column; anchors, aliases, flow lists,
 * block scalars holding `#`, CR LF + BOM + no final line break, indentless lists, empty scenes), duplicates (critique
 * B8: id and mark dropped, a capture's `as` renamed), the guard (critique B2), the `moved` flags (LIS) and where a
 * comment's step is today (critique B10).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  StepEditError,
  applyStepEdit,
  locateAnchorStep,
  matchRunSteps,
  movedSteps,
  parseYaml,
  scenarioBlocks,
  sceneStepFingerprints,
  stepFingerprint,
  stepGuard,
  verifyEditText,
} from '../src/index.js';
import type { StepEdit } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCENARIOS = join(ROOT, 'projects', 'northfield-fixture', 'scenarios');

type Doc = { scenes: Array<{ id?: string; steps?: unknown[] }> };
const valueOf = (t: string) => parseYaml(t).value as Doc;
const stepsOf = (t: string, scene: string) => valueOf(t).scenes.find((s) => s.id === scene && Array.isArray(s.steps))!.steps!;
const at = (t: string, scene: string, index: number) => ({ scene, index, guard: stepGuard(stepsOf(t, scene)[index]) });
const move = (t: string, a: string, i: number, b: string, j: number) => applyStepEdit(t, { kind: 'move_step', from: at(t, a, i), to: { scene: b, index: j } });
const del = (t: string, a: string, i: number) => applyStepEdit(t, { kind: 'delete_step', at: at(t, a, i) });
const dup = (t: string, a: string, i: number) => applyStepEdit(t, { kind: 'duplicate_step', at: at(t, a, i) });
const comments = (t: string) => t.split('\n').filter((l) => /^\s*#/.test(l) || / #/.test(l)).length;
const warnings = (t: string) => parseYaml(t).issues.filter((i) => i.severity === 'warning').length;

/** `after` is `before` with one contiguous run of whole lines removed (or inserted, swapped): that run, else null. */
function oneRun(longer: string, shorter: string): string | null {
  let p = 0;
  while (p < shorter.length && longer[p] === shorter[p]) p++;
  p = longer.lastIndexOf('\n', p - 1) + 1; // back to a line start
  let s = 0;
  while (s < shorter.length - p && longer[longer.length - 1 - s] === shorter[shorter.length - 1 - s]) s++;
  if (p + s < shorter.length) return null;
  const run = longer.slice(p, longer.length - (shorter.length - p));
  return run;
}

/** The value of `t` with an edit applied to its parsed value (the independent expectation). */
function expected(t: string, f: (d: Doc) => void): Doc {
  const d = valueOf(t);
  f(d);
  return d;
}

const scene = (d: Doc, id: string) => d.scenes.find((s) => s.id === id)!.steps!;

describe('step edits on every step of the fixture scenarios (goldens)', () => {
  const names = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
  it('the fixture has its 15 scenarios', () => expect(names).toHaveLength(15));

  it.each(names)(
    '%s: every move (in its scene, to the start / end of every other scene) re-parses to the moved value, keeps every line and comment, and moves back to the same bytes; every delete and duplicate re-parses to its value and touches one run of lines',
    (name) => {
      const text = readFileSync(join(SCENARIOS, name), 'utf8');
      const v = valueOf(text);
      const scenes = v.scenes.filter((s) => typeof s.id === 'string' && Array.isArray(s.steps)) as Array<{ id: string; steps: unknown[] }>;
      const w0 = warnings(text);
      let n = 0;
      for (const s of scenes) {
        for (let i = 0; i < s.steps.length; i++) {
          const targets: Array<[string, number]> = [];
          for (let j = 0; j < s.steps.length; j++) if (j !== i) targets.push([s.id, j]);
          for (const t of scenes) if (t !== s) targets.push([t.id, 0], [t.id, t.steps.length]);
          for (const [b, j] of targets) {
            const r = move(text, s.id, i, b, j);
            expect(verifyEditText(r.text, r.intended), `${name} ${s.id}.${i} → ${b}.${j}`).toBeNull();
            expect(r.intended).toEqual(expected(text, (d) => scene(d, b).splice(j, 0, scene(d, s.id).splice(i, 1)[0])));
            if (s.steps.length > 1 || b === s.id)
              expect(
                r.text
                  .split('\n')
                  .map((l) => l.trimStart())
                  .sort(),
              ).toEqual(
                text
                  .split('\n')
                  .map((l) => l.trimStart())
                  .sort(),
              );
            expect(comments(r.text)).toBe(comments(text));
            expect(warnings(r.text)).toBeLessThanOrEqual(w0);
            expect(r.select).toBe(`${b}.${j}`);
            const back = move(r.text, b, j, s.id, i);
            expect(back.text, `${name} ${s.id}.${i} → ${b}.${j} and back`).toBe(text);
            n++;
          }
          const d = del(text, s.id, i);
          expect(verifyEditText(d.text, d.intended)).toBeNull();
          expect(d.intended).toEqual(expected(text, (x) => scene(x, s.id).splice(i, 1)));
          const removed = oneRun(text, d.text);
          expect(removed, `${name} delete ${s.id}.${i}: one run of whole lines`).not.toBeNull();
          expect(removed!.endsWith('\n')).toBe(true);
          const c = dup(text, s.id, i);
          expect(verifyEditText(c.text, c.intended)).toBeNull();
          const added = oneRun(c.text, text);
          expect(added, `${name} duplicate ${s.id}.${i}: one run of whole lines`).not.toBeNull();
          expect(c.select).toBe(`${s.id}.${i + 1}`);
          n += 2;
        }
      }
      expect(n).toBeGreaterThan(0);
    },
  );
});

describe('comment ownership by the dash column (critique B6)', () => {
  const T = [
    'scenes:',
    '  - id: a',
    '    steps:',
    '      # about x',
    '      - click: x',
    '        # caption: old caption of x',
    '      - type:',
    '          into: {label: Script}',
    '          text: |',
    '            line one',
    '            # not a comment: part of the text',
    '# a section header at column 0',
    '      - click: z',
    '  - id: b',
    '    steps:',
    '      - click: w',
    '',
  ].join('\n');

  it('a commented-out modifier deeper than the dash stays with its step; the comment above at the dash column goes with it', () => {
    const r = move(T, 'a', 0, 'a', 2);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(r.text.split('\n').slice(3, 13)).toEqual([
      '      - type:',
      '          into: {label: Script}',
      '          text: |',
      '            line one',
      '            # not a comment: part of the text',
      '# a section header at column 0',
      '      - click: z',
      '      # about x',
      '      - click: x',
      '        # caption: old caption of x',
    ]);
    expect(move(r.text, 'a', 2, 'a', 0).text).toBe(T);
  });

  it('moving the next step does not take the deeper comment above it; a block scalar line starting with # stays in the text', () => {
    const r = move(T, 'a', 1, 'a', 0);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect((stepsOf(r.text, 'a')[0] as { type: { text: string } }).type.text).toBe('line one\n# not a comment: part of the text\n');
    expect(r.text.indexOf('        # caption: old caption of x')).toBeGreaterThan(r.text.indexOf('      - click: x'));
  });

  it('a column-0 comment between steps stays put on a move across scenes (no throw)', () => {
    const r = move(T, 'a', 2, 'b', 1);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(r.text).toContain('            # not a comment: part of the text\n# a section header at column 0\n  - id: b');
    expect(r.text.endsWith('      - click: w\n      - click: z\n')).toBe(true);
  });

  it('delete takes the comments it owns (a notice says so) and nothing else', () => {
    const r = del(T, 'a', 0);
    expect(r.text).toBe(T.replace('      # about x\n      - click: x\n        # caption: old caption of x\n', ''));
    expect(r.notices).toEqual(['Its comment lines went with it.']);
    expect(r.select).toBe('a.0');
  });
});

describe('what the splices refuse rather than corrupt', () => {
  const ANCHORED = 'scenes:\n  - id: a\n    steps:\n      - click: &t {text: Save}\n      - hover: *t\n';

  it('a duplicate of a step defining an anchor; an anchor moved after its alias (the verify refuses)', () => {
    expect(() => dup(ANCHORED, 'a', 0)).toThrow(/defines the YAML anchor &t: a copy would define it twice/);
    const r = move(ANCHORED, 'a', 0, 'a', 1);
    expect(verifyEditText(r.text, r.intended)).toMatch(/^the edit would not give valid YAML/);
  });

  it('a step written as an alias, steps written as an alias or as a flow list', () => {
    const alias = 'scenes:\n  - id: a\n    steps:\n      - &s {click: Save}\n      - *s\n';
    expect(() => move(alias, 'a', 1, 'a', 0)).toThrow(/step 2 of a is written as a YAML alias/);
    const seqAlias = 'common: &c\n  - click: A\nscenes:\n  - id: a\n    steps: *c\n';
    expect(() => del(seqAlias, 'a', 0)).toThrow(/the steps of scene a are written as a YAML alias/);
    const flow = 'scenes:\n  - id: a\n    steps: [{click: A}, {click: B}]\n';
    expect(() => move(flow, 'a', 0, 'a', 1)).toThrow(/written as a flow list/);
    expect(() => applyStepEdit('scenes: [\n', { kind: 'delete_step', at: { scene: 'a', index: 0, guard: '0'.repeat(16) } })).toThrow(/not valid YAML/);
  });

  it('a stale guard, a step or position no longer there, a move to where it is (critique B2)', () => {
    const t = 'scenes:\n  - id: a\n    steps:\n      - click: A\n      - click: B\n';
    const wrong = { scene: 'a', index: 0, guard: stepGuard({ click: 'B' }) };
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof StepEditError ? `${e.code}: ${e.message}` : String(e);
      }
      return 'no error';
    };
    expect(err(() => applyStepEdit(t, { kind: 'delete_step', at: wrong }))).toBe('stale: step 1 of a is not the step the edit was made on (it changed or moved): read the file again');
    expect(err(() => applyStepEdit(t, { kind: 'delete_step', at: { ...wrong, index: 5 } }))).toMatch(/^stale: scene a has no step 6/);
    expect(err(() => applyStepEdit(t, { kind: 'delete_step', at: { ...wrong, scene: 'zz' } }))).toMatch(/^stale: the file has no scene "zz"/);
    expect(err(() => move(t, 'a', 0, 'a', 5))).toMatch(/^stale: scene a has no position 6/);
    expect(err(() => move(t, 'a', 1, 'a', 1))).toBe('invalid: step 2 of a is already there: nothing to move');
    // A modifier change alone changes the guard (fingerprints leave modifiers out).
    expect(stepGuard({ click: 'A', caption: { text: 'x' } })).not.toBe(stepGuard({ click: 'A' }));
    expect(stepFingerprint({ click: 'A', caption: { text: 'x' } })).toBe(stepFingerprint({ click: 'A' }));
  });
});

describe('layouts the splices handle', () => {
  it('CR LF, a BOM and no final line break: moves keep CR LF and the missing final break, and move back to the same bytes', () => {
    const t = '\ufeffscenes:\r\n  - id: a\r\n    steps:\r\n      - click: A\r\n      - click: B\r\n  - id: b\r\n    steps:\r\n      - click: C';
    for (const [a, i, b, j] of [
      ['b', 0, 'a', 0],
      ['a', 0, 'b', 1],
      ['a', 1, 'b', 0],
    ] as const) {
      const r = move(t, a, i, b, j);
      expect(verifyEditText(r.text, r.intended)).toBeNull();
      expect(r.text.replace(/\r\n/g, '').includes('\n')).toBe(false);
      expect(r.text.endsWith('\n')).toBe(false);
      expect(r.text.startsWith('\ufeff')).toBe(true);
      expect(move(r.text, b, j, a, i).text).toBe(t);
    }
    const d = del(t, 'b', 0);
    expect(d.text).toBe('\ufeffscenes:\r\n  - id: a\r\n    steps:\r\n      - click: A\r\n      - click: B\r\n  - id: b\r\n    steps: []');
    const c = dup(t, 'b', 0);
    expect(c.text).toBe(`${t}\r\n      - click: C`);
  });

  it('an indentless list moved into an indented one is re-indented (and back)', () => {
    const t = 'scenes:\n- id: a\n  steps:\n  - click: A\n  - type: {into: {label: N}, text: x}\n    hold: 1\n- id: b\n  steps:\n      - click: B\n';
    const r = move(t, 'a', 1, 'b', 1);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(r.text.endsWith('      - click: B\n      - type: {into: {label: N}, text: x}\n        hold: 1\n')).toBe(true);
    expect(move(r.text, 'b', 1, 'a', 1).text).toBe(t);
  });

  it('the only step moved out leaves `steps: []`; moved into `steps: []` (an inline comment kept) it becomes a block list', () => {
    const t = 'scenes:\n  - id: a\n    steps:\n      - click: A\n  - id: b\n    steps: []   # later\n    caption: {text: B}\n';
    const r = move(t, 'a', 0, 'b', 0);
    expect(r.text).toBe('scenes:\n  - id: a\n    steps: []\n  - id: b\n    steps:   # later\n      - click: A\n    caption: {text: B}\n');
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(del(t, 'a', 0).notices).toEqual(['Scene a has no step now (steps: []).']);
  });

  it('1,200 steps: a move across scenes and its verify in well under a second', () => {
    const lines = ['scenes:'];
    for (let s = 0; s < 12; s++) {
      lines.push(`  - id: s${s}`, '    steps:');
      for (let i = 0; i < 100; i++) lines.push(`      - click: Button ${s}-${i}`);
    }
    const t = `${lines.join('\n')}\n`;
    const t0 = performance.now();
    const r = move(t, 's11', 99, 's0', 0);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('duplicate (critique B8)', () => {
  it('drops id (on the dash line) and mark, renames a capture `as` to the first free suffix, each with a notice; the original keeps them', () => {
    const t = [
      'scenes:',
      '  - id: a',
      '    steps:',
      '      - id: grab',
      '        capture_text: {target: {testid: total}, as: total}',
      '        # the moment',
      '        mark: here',
      '        hold: 1',
      '      - capture_text: {target: {testid: other}, as: total-2}',
      '      - {click: Save, mark: saved}',
      '',
    ].join('\n');
    const r = dup(t, 'a', 0);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(r.text.split('\n').slice(8, 10)).toEqual(['      - capture_text: {target: {testid: total}, as: total-3}', '        hold: 1']);
    expect(r.notices).toEqual([
      'The copy has no id: step ids are unique (the original keeps "grab").',
      'The copy has no mark: a mark names one moment (the original keeps "here").',
      'The copy saves its text as "total-3": names of captures are unique (the original keeps "total").',
    ]);
    const f = dup(t, 'a', 2);
    expect(f.text.endsWith('      - {click: Save, mark: saved}\n      - {click: Save}\n')).toBe(true);
    expect(verifyEditText(f.text, f.intended)).toBeNull();
    // A quoted `as` keeps its quotes.
    const q = dup('scenes:\n  - id: a\n    steps:\n      - download: {click: {text: PDF}, as: "quote"}\n', 'a', 0);
    expect(q.text.endsWith('      - download: {click: {text: PDF}, as: "quote-2"}\n')).toBe(true);
  });
});

describe("pictures after edits: moved (LIS) and where a comment's step is today (critique B10)", () => {
  const RUN = 'scenes:\n  - id: a\n    steps:\n      - click: A\n      - click: B\n      - click: C\n      - click: D\n';
  it('a step moved to the top is the only one marked moved; an unchanged file has none', () => {
    const run = sceneStepFingerprints(RUN)!;
    const now = move(RUN, 'a', 3, 'a', 0).text;
    const cur = sceneStepFingerprints(now)!;
    expect([...movedSteps(cur, matchRunSteps(cur, run))]).toEqual(['a.0']);
    expect([...movedSteps(run, matchRunSteps(run, run))]).toEqual([]);
    const swapped = sceneStepFingerprints(move(RUN, 'a', 1, 'a', 2).text)!;
    expect(movedSteps(swapped, matchRunSteps(swapped, run)).size).toBe(1);
  });

  it('locateAnchorStep: by step id, else fingerprint + occurrence; null when gone; undefined without a step', () => {
    const now = move(RUN, 'a', 1, 'a', 3).text; // B moved to the end
    const fp = stepFingerprint({ click: 'B' })!;
    expect(locateAnchorStep(now, { scene: 'a', step: 1, step_fp: fp, step_fp_n: 0 })).toBe('a.3');
    expect(locateAnchorStep(del(RUN, 'a', 1).text, { scene: 'a', step: 1, step_fp: fp, step_fp_n: 0 })).toBeNull();
    expect(locateAnchorStep('scenes:\n  - id: a\n    steps:\n      - click: X\n      - id: k\n        click: B\n', { scene: 'a', step: 0, step_id: 'k' })).toBe('a.1');
    expect(locateAnchorStep(now, { scene: 'a', step: 1 })).toBeNull();
    expect(locateAnchorStep(now, { scene: 'a' })).toBeUndefined();
    expect(locateAnchorStep('scenes: [', { scene: 'a', step: 0, step_fp: fp })).toBeNull();
  });

  it('review B M1: a step dragged to another scene is found there, by its id or by its single fingerprint; two candidates: null', () => {
    const two = 'scenes:\n  - id: a\n    steps:\n      - click: A\n      - id: k\n        click: B\n  - id: delivery\n    steps:\n      - click: C\n';
    const fp = stepFingerprint({ click: 'B' })!;
    const moved = move(two, 'a', 1, 'delivery', 0).text;
    expect(locateAnchorStep(moved, { scene: 'a', step: 1, step_id: 'k' })).toBe('delivery.0');
    const noId = move(RUN.replace('  - id: a', '  - id: a').concat('  - id: delivery\n    steps:\n      - click: E\n'), 'a', 1, 'delivery', 0).text;
    expect(locateAnchorStep(noId, { scene: 'a', step: 1, step_fp: fp, step_fp_n: 0 })).toBe('delivery.0');
    // Its own scene first; elsewhere only a single match.
    const both = `${noId}  - id: other\n    steps:\n      - click: B\n`;
    expect(locateAnchorStep(both, { scene: 'a', step: 1, step_fp: fp, step_fp_n: 0 })).toBeNull();
    expect(locateAnchorStep(`${RUN}  - id: delivery\n    steps:\n      - click: B\n`, { scene: 'a', step: 1, step_fp: fp, step_fp_n: 0 })).toBe('a.1');
  });
});

describe('review B fixes', () => {
  it("L4: an anchor, a tag or a comment on a step's dash line travels with it (edits verified); a dash item not written plainly locks its scene with why", () => {
    for (const dash of ['- &s', '- !!map', '- # the save', '- &s # note', '- !!map &t']) {
      const t = `video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: A\n      ${dash}\n        id: s\n        click: Save\n  - id: b\n    page: shop\n    open: /\n    steps:\n      - click: C\n`;
      const scene = scenarioBlocks(t).entries.find((e) => e.type === 'scene' && e.id === 'a');
      expect(scene?.type === 'scene' ? scene.steps_locked : 'x', dash).toBeUndefined();
      const edits: StepEdit[] = [
        { kind: 'delete_step', at: at(t, 'a', 1) },
        { kind: 'move_step', from: at(t, 'b', 0), to: { scene: 'a', index: 2 } },
        { kind: 'move_step', from: at(t, 'a', 1), to: { scene: 'b', index: 1 } },
        { kind: 'move_step', from: at(t, 'a', 0), to: { scene: 'a', index: 1 } },
      ];
      for (const e of edits) {
        const r = applyStepEdit(t, e);
        expect(verifyEditText(r.text, r.intended), `${dash} ${e.kind}`).toBeNull();
      }
      // The moved step keeps its dash line as written.
      expect(move(t, 'a', 1, 'b', 1).text).toContain(`      - click: C\n      ${dash}\n        id: s\n`);
    }
    // A tab between the anchor and the value: not a plain dash item — its scene is locked with why, and an edit of a
    // neighbour says the same (it needs where that step ends).
    const odd = 'video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: A\n      - &a\t{click: B}\n';
    const scene = scenarioBlocks(odd).entries.find((e) => e.type === 'scene');
    const why = 'step 2 of its scene is not written as a plain "- " item (a tab after the dash or its anchor, something before it on the line): edit these steps in the YAML view';
    expect(scene?.type === 'scene' ? [scene.steps_locked, scene.steps.map((s) => s.locked)] : null).toEqual([why, [why, why]]);
    expect(() => del(odd, 'a', 1)).toThrow('step 2 of a is not written as a plain "- " item');
  });

  it("a duplicate copies the step's own lines, not a comment after its last value (even one the node takes in)", () => {
    const t = 'scenes:\n  - id: a\n    steps:\n      - id: u3\n        wait_for: {text: Fresh arrivals}\n          # T:u3 deeper still\n      - click: B\n';
    const r = dup(t, 'a', 0);
    expect(verifyEditText(r.text, r.intended)).toBeNull();
    expect(r.text).toBe(
      'scenes:\n  - id: a\n    steps:\n      - id: u3\n        wait_for: {text: Fresh arrivals}\n          # T:u3 deeper still\n      - wait_for: {text: Fresh arrivals}\n      - click: B\n',
    );
    // A block scalar's last line starting with "#" is a value: copied.
    const e = 'scenes:\n  - id: a\n    steps:\n      - eval: |\n          return 1\n          # kept\n';
    const d = dup(e, 'a', 0);
    expect(verifyEditText(d.text, d.intended)).toBeNull();
    expect(d.text.split('# kept').length).toBe(3);
  });
});

// The edit union stays exhaustive with the core kinds.
const kinds: Array<StepEdit['kind']> = ['move_step', 'delete_step', 'duplicate_step'];
void kinds;
