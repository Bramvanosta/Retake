/**
 * L4.6 part A2 (T9): the line diff of scenario proposals (core line-diff.ts). Fuzzed on 5,000 random line edits
 * (insertions, deletions, moves, whitespace-only changes, CR LF, empty texts, no final line break): the hunks rebuild
 * the new text exactly, are well-formed (sorted, separated, none empty), minimal (their changed lines are the edit
 * distance a dynamic programme finds) and canonical (`diffLines(base, applyHunks(base, h))` deep-equals `h`); undoing
 * them gives the base back. `applyHunks` is strict: ⚑ a hunk whose removed lines are not the base's throws, as do hunks
 * out of order, touching or empty. The cap stops the search (a whole-file rewrite costs no more than it allows).
 */
import { describe, expect, it } from 'vitest';
import { LineDiffError, applyHunks, diffLines, hunkOrderProblem, hunkStats, invertHunks, joinLines, lineBreaks, sameHunks, textLines } from '../src/index.js';
import type { LineHunk } from '../src/index.js';
import { perCallMs } from '@retake/test-support/timing';

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The edit distance (deleted + inserted lines) of two line lists: n + m − 2·LCS. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return a.length + b.length - 2 * dp[0][0];
}

const WORDS = ['scenes:', '  - id: a', '    caption: Hello', '    steps:', '      - hold: 1', '      - click: Go', '', '  ', 'title: {text: T}', '# note'];

function randomLines(r: () => number, max: number): string[] {
  const n = Math.floor(r() * max);
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
}

function mutate(r: () => number, base: string[]): string[] {
  const out = [...base];
  const edits = 1 + Math.floor(r() * 5);
  for (let e = 0; e < edits; e++) {
    const kind = Math.floor(r() * 5);
    const at = Math.floor(r() * (out.length + 1));
    if (kind === 0) out.splice(at, 0, WORDS[Math.floor(r() * WORDS.length)]);
    else if (kind === 1 && out.length) out.splice(Math.min(at, out.length - 1), 1);
    else if (kind === 2 && out.length > 1) {
      // A move: a line taken out and put back elsewhere.
      const [l] = out.splice(Math.min(at, out.length - 1), 1);
      out.splice(Math.floor(r() * (out.length + 1)), 0, l);
    } else if (kind === 3 && out.length) {
      // A whitespace-only change: indentation or a trailing space.
      const i = Math.min(at, out.length - 1);
      out[i] = r() < 0.5 ? ` ${out[i]}` : `${out[i]} `;
    } else if (out.length) out[Math.min(at, out.length - 1)] = `changed ${Math.floor(r() * 3)}`;
  }
  return out;
}

describe('diffLines / applyHunks (T9)', () => {
  it('fuzz: 5,000 random line edits — exact rebuild, well-formed, minimal, canonical, invertible (CR LF, empty, no final line break)', () => {
    const r = rng(46);
    for (let i = 0; i < 5000; i++) {
      const base = randomLines(r, 14);
      const next = r() < 0.05 ? [] : mutate(r, base);
      const eol = r() < 0.3 ? '\r\n' : '\n';
      // The texts as files hold them (a final line break or not): their lines are what is diffed.
      const baseText = r() < 0.2 && base.length ? base.join(eol) : joinLines(base, eol);
      const nextText = joinLines(next, eol);
      const a = textLines(baseText);
      const b = textLines(nextText);
      const h = diffLines(a, b)!;
      expect(hunkOrderProblem(h)).toBeNull();
      expect(applyHunks(a, h)).toEqual(b);
      expect(joinLines(applyHunks(a, h), eol)).toBe(nextText);
      expect(hunkStats(h).changed).toBe(editDistance(a, b));
      expect(diffLines(a, applyHunks(a, h))).toEqual(h);
      expect(applyHunks(b, invertHunks(h))).toEqual(a);
      if (h.length === 0) expect(a).toEqual(b);
    }
  });

  it('positions: a change, an insertion before line 1 and at the end, a deletion; whitespace-only changes are changes', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([{ at: 2, del: ['b'], add: ['B'] }]);
    expect(diffLines(['a', 'b'], ['x', 'a', 'b'])).toEqual([{ at: 1, del: [], add: ['x'] }]);
    expect(diffLines(['a', 'b'], ['a', 'b', 'z'])).toEqual([{ at: 3, del: [], add: ['z'] }]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ at: 2, del: ['b'], add: [] }]);
    expect(diffLines(['  key: 1'], ['    key: 1'])).toEqual([{ at: 1, del: ['  key: 1'], add: ['    key: 1'] }]);
    expect(diffLines(['key: 1'], ['key: 1 '])).toEqual([{ at: 1, del: ['key: 1'], add: ['key: 1 '] }]);
    expect(diffLines([], [])).toEqual([]);
    expect(textLines('')).toEqual([]);
    expect(textLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(textLines('a\nb')).toEqual(['a', 'b']);
    expect(lineBreaks('a\r\nb\nc\rd')).toEqual({ crlf: 1, lf: 1, cr: 1 });
  });

  it("⚑ applyHunks is strict: removed lines not the base's, out of order, touching, empty, past the end — all throw", () => {
    const base = ['a', 'b', 'c', 'd', 'e'];
    expect(() => applyHunks(base, [{ at: 2, del: ['x'], add: ['y'] }])).toThrow(LineDiffError);
    expect(() => applyHunks(base, [{ at: 2, del: ['x'], add: ['y'] }])).toThrow(/line 2 is not the line it removes/);
    // Out of order: displayed in one order, applied in another (critique B1 b).
    expect(() =>
      applyHunks(base, [
        { at: 4, del: ['d'], add: ['D'] },
        { at: 2, del: ['b'], add: ['B'] },
      ]),
    ).toThrow(/not after hunk 1/);
    // Touching: no unchanged line between (one canonical hunk would hold both).
    expect(() =>
      applyHunks(base, [
        { at: 2, del: ['b'], add: ['B'] },
        { at: 3, del: ['c'], add: ['C'] },
      ]),
    ).toThrow(/not after hunk 1/);
    expect(() =>
      applyHunks(base, [
        { at: 2, del: [], add: ['x'] },
        { at: 2, del: ['b'], add: [] },
      ]),
    ).toThrow(/not after hunk 1/);
    expect(() => applyHunks(base, [{ at: 2, del: [], add: [] }])).toThrow(/changes nothing/);
    expect(() => applyHunks(base, [{ at: 0, del: [], add: ['x'] }])).toThrow(/from 1/);
    expect(() => applyHunks(base, [{ at: 5, del: ['e', 'f'], add: [] }])).toThrow(/past the end/);
    expect(
      applyHunks(base, [
        { at: 2, del: ['b'], add: ['B'] },
        { at: 4, del: ['d'], add: ['D'] },
      ]),
    ).toEqual(['a', 'B', 'c', 'D', 'e']);
    // A valid but non-canonical list applies (strictness is about the base), and the canonical check tells it apart.
    const split: LineHunk[] = [{ at: 2, del: ['b'], add: ['b'] }];
    expect(applyHunks(base, split)).toEqual(base);
    expect(sameHunks(diffLines(base, applyHunks(base, split))!, split)).toBe(false);
  });

  it('the cap stops the search: past maxChanged changed lines, null', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const b = a.map((l) => `${l} changed`);
    /** A capped search over `n` lines that all changed, per call (repeated until a round lasts 20 ms; best of 3). */
    const capped = (n: number) => {
      const x = Array.from({ length: n }, (_, i) => `line ${i}`);
      const y = x.map((l) => `${l} changed`);
      expect(diffLines(x, y, { maxChanged: 200 })).toBeNull();
      return perCallMs(() => diffLines(x, y, { maxChanged: 200 }));
    };
    expect(diffLines(a, b, { maxChanged: 200 })).toBeNull();
    // The cap bounds the search, whatever the machine's speed: four times the lines cost at most about four times as
    // much, far from the sixteen times an uncapped search over lines that all changed would.
    const [n1, n4] = [capped(3000), capped(12_000)];
    console.log(`capped diff: 3,000 lines ${n1.toFixed(3)} ms, 12,000 lines ${n4.toFixed(3)} ms`);
    expect(n4 / n1).toBeLessThan(8);
    const small = [...a];
    small[1500] = 'one change';
    expect(diffLines(a, small, { maxChanged: 200 })).toEqual([{ at: 1501, del: ['line 1500'], add: ['one change'] }]);
    expect(diffLines(['a'], ['b', 'c'], { maxChanged: 2 })).toBeNull();
    expect(diffLines(['a'], ['b', 'c'], { maxChanged: 3 })).toEqual([{ at: 1, del: ['a'], add: ['b', 'c'] }]);
  });
});
