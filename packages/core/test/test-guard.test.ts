/**
 * scripts/test-guard.mjs: a migrated test that loses a title, an expect or a test id is reported (L5.10's migrations
 * of the e2e tests ran under it; L5.11 – L5.12 do too).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without types
import { compareTests, parseTests } from '../../../scripts/test-guard.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const BEFORE = `
it('opens the board', async () => {
  await page.getByTestId('board').waitFor();
  expect(await page.getByTestId('frame').count()).toBe(3);
  await expect.poll(() => page.title()).toBe('x');
});
it.skipIf(!slow)("renders it", async () => {
  expect(1).toBe(1);
});
`;

describe('the test-migration guard', () => {
  it('reads titles, expect counts and test ids per test', () => {
    const t = parseTests(BEFORE);
    expect([...t.keys()]).toEqual(['opens the board', 'renders it']);
    expect(t.get('opens the board').expects).toBe(2);
    expect([...t.get('opens the board').ids].sort()).toEqual(['board', 'frame']);
    expect(t.get('renders it').expects).toBe(1);
  });

  it('reports a lost title, a lost expect and a lost test id, and nothing for an unchanged or stronger test', () => {
    const before = parseTests(BEFORE);
    expect(compareTests(before, parseTests(BEFORE))).toEqual([]);
    const weaker = BEFORE.replace("expect(await page.getByTestId('frame').count()).toBe(3);\n", '').replace('renders it', 'renders');
    expect(compareTests(before, parseTests(weaker))).toEqual(['fewer expects (2 → 1): opens the board', 'lost test ids [frame]: opens the board', 'missing title: renders it']);
    const stronger = BEFORE.replace('await expect.poll', "expect(await page.getByTestId('extra').count()).toBe(1);\n  await expect.poll");
    expect(compareTests(before, parseTests(stronger))).toEqual([]);
  });

  it('reads a title by its value and an expect.poll broken onto the next line: a formatter changes neither', () => {
    const before = parseTests("it('the shell\\'s lines', async () => {\n  await expect.poll(() => 1).toBe(1);\n});\n");
    const after = parseTests('it("the shell\'s lines", async () => {\n  await expect\n    .poll(() => 1)\n    .toBe(1);\n});\n');
    expect([...after.keys()]).toEqual(["the shell's lines"]);
    expect(after.get("the shell's lines").expects).toBe(1);
    expect(compareTests(before, after)).toEqual([]);
  });

  it('counts expect.soft as an expect, and reports one dropped', () => {
    const before = parseTests("it('every help', async () => {\n  expect.soft(a).toBe(0);\n  expect\n    .soft(b)\n    .toBe(0);\n});\n");
    expect(before.get('every help').expects).toBe(2);
    const after = parseTests("it('every help', async () => {\n  expect.soft(a).toBe(0);\n});\n");
    expect(compareTests(before, after)).toEqual(['fewer expects (2 → 1): every help']);
  });

  it('reads the title templates of it.each and it.for (arguments with brackets, strings and nested calls), and of a nested skipIf', () => {
    const text = [
      "it.each([['a(', f(1)], [\"b)\", `c${g(')')}`]])('%s: one line', (_n, e) => expect(e).toBe(1));",
      "it.for([1, 2])('n=%i', (n) => {\n  expect(n).toBeGreaterThan(0);\n  expect(n).toBeLessThan(3);\n});",
      "it.skipIf(!hasTool('ffmpeg'))('renders (ffmpeg)', () => {\n  expect(1).toBe(1);\n});",
      "it.runIf(OK).each([1])('runs %i', () => {});",
      'const x = { it: 1 }; x.it(2); audit(3);',
    ].join('\n');
    const t = parseTests(text);
    expect([...t.keys()]).toEqual(['%s: one line', 'n=%i', 'renders (ffmpeg)', 'runs %i']);
    expect(t.get('%s: one line').expects).toBe(1);
    expect(t.get('n=%i').expects).toBe(2);
    expect(t.get('renders (ffmpeg)').expects).toBe(1);
    // A title of an each that disappeared is reported like any other.
    expect(compareTests(t, parseTests(text.replace("('n=%i'", "('m=%i'")))).toEqual(['missing title: n=%i']);
  });

  it('reports a matcher traded for a weaker one, the expect count unchanged; not a matcher made stricter', () => {
    const before = parseTests("it('the plan', () => {\n  expect(plan.steps).toEqual([1, 2]);\n  expect(plan.error).toBeNull();\n});\n");
    const weaker = parseTests("it('the plan', () => {\n  expect(plan.steps).toBeDefined();\n  expect(plan.error).toBeNull();\n});\n");
    expect(weaker.get('the plan').expects).toBe(2);
    expect(compareTests(before, weaker)).toEqual(['weaker matchers (exact 2 → 1, partial 0 → 0, weak 0 → 1): the plan']);
    const notNull = parseTests("it('the plan', () => {\n  expect(plan.steps).toEqual([1, 2]);\n  expect(plan.error).not.toBeNull();\n});\n");
    expect(compareTests(before, notNull)).toEqual(['weaker matchers (exact 2 → 1, partial 0 → 0, weak 0 → 1): the plan']);
    const stricter = parseTests("it('the plan', () => {\n  expect(plan.steps).toEqual([1, 2]);\n  expect(plan.error).toBe(null);\n});\n");
    expect(compareTests(before, stricter)).toEqual([]);
    expect(compareTests(weaker, before)).toEqual([]);
  });

  it('reports an exact matcher traded for a bound or a pattern, and a matcher that lost its argument', () => {
    const one = (body: string) => parseTests(`it('t', () => {\n  ${body}\n});\n`);
    // toEqual(3) → toBeGreaterThan(0): exact → partial.
    expect(compareTests(one('expect(n).toEqual(3);'), one('expect(n).toBeGreaterThan(0);'))).toEqual(['weaker matchers (exact 1 → 0, partial 0 → 1, weak 0 → 0): t']);
    // toThrow(/boom/) → toThrow(), also under rejects: partial → weak.
    expect(compareTests(one('expect(() => f()).toThrow(/boom/);'), one('expect(() => f()).toThrow();'))).toEqual(['weaker matchers (exact 0 → 0, partial 1 → 0, weak 0 → 1): t']);
    expect(compareTests(one('await expect(p).rejects.toThrow("boom");'), one('await expect(p).rejects.toThrow( );'))).toEqual(['weaker matchers (exact 0 → 0, partial 1 → 0, weak 0 → 1): t']);
    // toHaveBeenCalledWith(x) → toHaveBeenCalled() and → toHaveBeenCalledWith(): exact → weak.
    expect(compareTests(one('expect(fn).toHaveBeenCalledWith(1);'), one('expect(fn).toHaveBeenCalled();'))).toEqual(['weaker matchers (exact 1 → 0, partial 0 → 0, weak 0 → 1): t']);
    expect(compareTests(one('expect(fn).toHaveBeenCalledWith(1);'), one('expect(fn).toHaveBeenCalledWith();'))).toEqual(['weaker matchers (exact 1 → 0, partial 0 → 0, weak 0 → 1): t']);
    // The other way round, or a bound made exact, or the same matcher given a value: no finding.
    expect(compareTests(one('expect(() => f()).toThrow();'), one('expect(() => f()).toThrow(/boom/);'))).toEqual([]);
    expect(compareTests(one('expect(n).toBeGreaterThan(0);'), one('expect(n).toBe(3);'))).toEqual([]);
    expect(compareTests(one('expect(s).toMatch(/a/);'), one('expect(s).toContain("a");'))).toEqual([]);
  });

  it('runs as a command: no decrease against the working tree itself', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'test-guard.mjs'), '--base', 'HEAD', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stdout).toContain('no decrease');
    expect(r.status).toBe(0);
  });
});
