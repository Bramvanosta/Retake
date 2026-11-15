/**
 * The size ratchet (scripts/audit/size-limits.mjs): file lines, function lines, parameter counts and nesting depth of
 * packages/*\/src, measured on the TypeScript syntax tree and held exactly to scripts/audit/size-baseline.json: a new
 * entry, a size above or below its recorded one, an entry back within its limit and a function over a limit without a
 * key of its own all fail. Keys are name paths, never positions.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without types
import * as sizes from '../../../scripts/audit/size-limits.mjs';
// @ts-expect-error — a plain .mjs script without types
import { loadTs } from '../../../scripts/audit/lib.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ts = loadTs(ROOT);
type Measure = { measure: string; file: string; name: string; size: number; shared: number };
/** The measures of a source as `measure name → size` (the file's own line count under `file`). */
const measured = (text: string, rel = 'packages/x/src/a.ts'): Record<string, number> =>
  Object.fromEntries((sizes.measureSource(ts, rel, text) as Measure[]).map((m) => [`${m.measure} ${m.name}`.trim(), m.size]));
/** The names of a source's functions, in source order. */
const names = (text: string): string[] => (sizes.measureSource(ts, 'packages/x/src/a.tsx', text) as Measure[]).filter((m) => m.measure === 'body').map((m) => m.name);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join('\n');

describe('the size ratchet', () => {
  it('the repository holds its baseline exactly: nothing new, raised, lowered, stale or ambiguous, the limits as written, every group with a reason', () => {
    const cmp = sizes.compareSizes(sizes.sizeEntries(ROOT), sizes.readSizeBaseline(ROOT));
    expect(cmp.added).toEqual([]);
    expect(cmp.stale).toEqual([]);
    expect(cmp.lowered).toEqual([]);
    expect(cmp.ambiguous).toEqual([]);
    expect(cmp.limits).toEqual([]);
    expect(cmp.unexplained).toEqual([]);
    expect(sizes.LIMITS).toEqual({ file: 1000, body: 100, params: 5, nesting: 5 });
  });

  it('counts the lines of a file (a last newline is no line) and of a function from its first line to its last', () => {
    expect(sizes.lineCount('')).toBe(0);
    expect(sizes.lineCount('a\nb\n')).toBe(2);
    expect(sizes.lineCount('a\nb')).toBe(2);
    const m = measured(`function f() {\n${lines(3)}\n}\nconst g = () => 1;\n`);
    expect(m.file).toBe(6);
    expect(m['body f']).toBe(5);
    expect(m['body g']).toBe(1);
  });

  it('names a function by its path in the file: declarations, variables, properties, class members and blocks, callbacks by their call, an IIFE', () => {
    const src = [
      'export function outer() { const inner = () => 1; return [1].map((x) => x); }',
      'const o = { prop: function () {}, method() {} };',
      'class K { constructor(a: number) {} get v() { return 1; } run(this: K, a: number) {} static { const s = () => 0; } }',
      'export default () => 0;',
      "function C() { useEffect(() => {}, []); program.command('add').option('--json').action(action((u: number) => u)); on('click', () => 0); (() => 1)(); return () => 2; }",
    ].join('\n');
    expect(names(src)).toEqual([
      'outer',
      'outer › inner',
      'outer › map(…)',
      'prop',
      'method',
      'K › constructor',
      'K › get v',
      'K › run',
      'K › static',
      'K › static › s',
      'default',
      'C',
      'C › useEffect(…)',
      "C › action('add')",
      "C › on('click')",
      'C › <iife>',
      'C › <returned>',
    ]);
    const m = measured(src);
    expect(m['params K › run']).toBe(1); // a `this` parameter is no parameter
    expect(m['params K › constructor']).toBe(1);
    expect(m['params K › static']).toBe(0);
  });

  it('keeps a key when code is added above the function or inside an IIFE, and two callbacks of the same call are told apart by its argument', () => {
    const body = (n: number) => `{\n${lines(n)}\n}`;
    const before = `function C() {\n  useEffect(() => ${body(2)}, []);\n  cmd.command('a').action(() => ${body(2)});\n  cmd.command('b').action(() => ${body(2)});\n  (() => ${body(2)})();\n}`;
    const after = `function C() {\n  useMemo(() => 0, []);\n  cmd.command('z').action(() => 0);\n  useEffect(() => ${body(2)}, []);\n  cmd.command('a').action(() => ${body(2)});\n  cmd.command('b').action(() => ${body(2)});\n  (() => ${body(9)})();\n}`;
    const kept = ['C › useEffect(…)', "C › action('a')", "C › action('b')", 'C › <iife>'];
    expect(names(before)).toEqual(['C', ...kept]);
    expect(names(after)).toEqual(['C', 'C › useMemo(…)', "C › action('z')", ...kept]);
  });

  it('refuses two functions sharing a key when one is over a limit, and lets them be while both are within', () => {
    const src = `function C() {\n  useEffect(() => {\n${lines(101)}\n  }, []);\n  useEffect(() => 0, []);\n}\n`;
    const e = sizes.sizeEntries(ROOT, [{ rel: 'packages/x/src/c.tsx', text: src }]);
    expect(e.body).toEqual({ 'packages/x/src/c.tsx › C': 106 }); // the component itself has its own key
    expect(e.ambiguous).toEqual(['packages/x/src/c.tsx › C › useEffect(…): 2 functions share this key, one is over the body limit (give it a name)']);
    const cmp = sizes.compareSizes(e, { limits: sizes.LIMITS, groups: [] });
    expect(sizes.sizeReport(cmp)).toMatch(/without a key of its own[\s\S]*useEffect/);
    const small = sizes.sizeEntries(ROOT, [{ rel: 'packages/x/src/c.tsx', text: 'function C() { useEffect(() => 1, []); useEffect(() => 0, []); }' }]);
    expect(small.ambiguous).toEqual([]);
  });

  it('measures nesting per function: an else-if chain and a chain of conditionals add no depth, a nested function starts again', () => {
    const m = measured(
      [
        'function chain(a: number) { if (a) {} else if (a > 1) {} else if (a > 2) { if (a) {} } return a ? 1 : a > 1 ? 2 : a > 2 ? 3 : 4; }',
        'function deep(a: number[]) { for (const x of a) { while (x) { try { switch (x) { case 1: if (x) { return x ? 1 : 2; } } } catch { } } } }',
        'function caught() { try { if (1) {} } catch { if (1) {} } finally { if (1) {} } }',
        'function holder(a: number) { if (a) { const f = () => { if (a) {} }; f(); } }',
        'function inTrue(a: number) { return a ? (a > 1 ? 1 : 2) : 3; }',
      ].join('\n'),
    );
    expect(m['nesting chain']).toBe(2);
    expect(m['nesting deep']).toBe(6); // for, while, try, switch, if, conditional
    expect(m['nesting caught']).toBe(2); // a catch and a finally sit at their try's depth, as an else does
    expect(m['nesting holder']).toBe(1);
    expect(m['nesting holder › f']).toBe(1);
    expect(m['nesting inTrue']).toBe(2);
  });

  it('lists only what is over a limit, keyed by file and name', () => {
    const src = `function long() {\n${lines(101)}\n}\nfunction many(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) {}\nfunction few(a: 1, b: 2, c: 3, d: 4, e: 5) {}\n`;
    const e = sizes.sizeEntries(ROOT, [{ rel: 'packages/x/src/a.ts', text: src }]);
    expect(e).toEqual({ file: {}, body: { 'packages/x/src/a.ts › long': 103 }, params: { 'packages/x/src/a.ts › many': 6 }, nesting: {}, ambiguous: [] });
    const big = sizes.sizeEntries(ROOT, [{ rel: 'packages/x/src/b.ts', text: `${lines(1001)}\n` }]);
    expect(big.file).toEqual({ 'packages/x/src/b.ts': 1001 });
  });

  it('fails a new entry, a raised size, a lowered size and a stale entry; the limits and the reasons are checked', () => {
    const baseline = { limits: sizes.LIMITS, groups: [{ measure: 'body', reason: 'why', entries: { 'a.ts › f': 150, 'a.ts › g': 120, 'a.ts › gone': 130 } }] };
    const cmp = sizes.compareSizes({ file: {}, body: { 'a.ts › f': 151, 'a.ts › g': 110, 'a.ts › h': 101 }, params: {}, nesting: {} }, baseline);
    expect(cmp.added).toEqual(['body a.ts › f: 151, above its recorded 150', 'body a.ts › h: 101 (limit 100)']);
    expect(cmp.stale).toEqual(['body a.ts › gone: within 100 now']);
    expect(cmp.lowered).toEqual(['body a.ts › g: 110, below its recorded 120']);
    expect(cmp.limits).toEqual([]);
    expect(sizes.sizeReport(cmp)).toMatch(/over the limit[\s\S]*within the limit now[\s\S]*smaller than recorded[\s\S]*a\.ts › g/);
    const lowered = sizes.compareSizes({ file: {}, body: { 'a.ts › f': 150, 'a.ts › g': 119, 'a.ts › gone': 130 }, params: {}, nesting: {} }, baseline);
    expect(sizes.sizeReport(lowered)).toMatch(/^smaller than recorded[\s\S]*--write-baseline[\s\S]*a\.ts › g: 119, below its recorded 120$/);
    const held = sizes.compareSizes({ file: {}, body: { 'a.ts › f': 150, 'a.ts › g': 120, 'a.ts › gone': 130 }, params: {}, nesting: {} }, baseline);
    expect(sizes.sizeReport(held)).toBe('');
    const loose = sizes.compareSizes({ file: {}, body: {}, params: {}, nesting: {} }, { limits: { ...sizes.LIMITS, body: 200 }, groups: [{ measure: 'file', reason: ' ', entries: {} }] });
    expect(loose.limits).toHaveLength(1);
    expect(loose.unexplained).toEqual(['a file group has no reason']);
  });

  it("rewrites the baseline for today: each entry kept in its group with today's size, a stale one dropped, a new one in a group without a reason", () => {
    const old = { about: 'x', limits: sizes.LIMITS, groups: [{ measure: 'body', reason: 'why', entries: { 'a.ts › f': 150, 'a.ts › gone': 130 } }] };
    const next = sizes.rewriteSizeBaseline({ file: { 'b.ts': 1200 }, body: { 'a.ts › f': 140 }, params: {}, nesting: {} }, old);
    expect(next).toEqual({
      about: 'x',
      limits: sizes.LIMITS,
      groups: [
        { measure: 'body', reason: 'why', entries: { 'a.ts › f': 140 } },
        { measure: 'file', reason: '', entries: { 'b.ts': 1200 } },
      ],
    });
  });
});
