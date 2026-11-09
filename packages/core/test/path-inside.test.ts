/**
 * One path-containment check (core path-inside.ts) for the copies the tool had: each site's semantics is pinned here
 * against the copy it replaced (kept below verbatim as the oracle), over a frozen table and a seeded random sweep, so a
 * site keeps its exact answer — real path or spelling, the folder itself inside or not, case folded or not, `..cache`
 * outside or not. The real-path variants are checked on a folder with links.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { insideFolder, pathInside, projectFileProblem, realPathOf, relativeInside } from '../src/index.js';
import type { PathInsideOptions } from '../src/index.js';

// ── The copies replaced, verbatim (argument order normalised to (p, dir)) ──────────────────────────────────────────
/** components compile, checks context, engine storage / record-studio / comments / theme-edit / project-lock / scenarios, ui bundle-player, mcp project. */
const lexicalSelf = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
/** ui player, editor render bundle `within`, cli displayPath, core scenario (shown name), engine projects / runs. */
const lexicalNoSelf = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};
/** core bundle `within`, agent-trust insideFolder / projectFileProblem. */
const strictSelf = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
/** core agent-policy `below`. */
const strictNoSelf = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return !(rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
};
/** engine hooks `inside`. */
const prefixSelf = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
/** core client-path isUnder (one spelling of each, case folded). */
const prefixFold = (p: string, dir: string) => {
  const x = p.toLowerCase();
  const r = dir.toLowerCase();
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep);
};
/** engine run-files `inside`. */
const runFiles = (p: string, root: string) => p === root || p.startsWith(root + sep);
/** runner-web artefacts render (the pdf.js route). */
const pdfRoute = (p: string, root: string) => p.startsWith(root + sep);

// ── The same, through pathInside (the options each site passes) ─────────────────────────────────────────────────────
/** The options of engine run-files.ts `inside` and of the pdf.js route (runner-web artefacts/render.ts). */
const RUN_FILES: PathInsideOptions = { compare: 'spelling', trailingSepHoldsNothing: true };
const PDF_ROUTE: PathInsideOptions = { compare: 'spelling', self: false, trailingSepHoldsNothing: true };
// `normalised`: the site only ever gets normalised paths (real paths, `normalize(join(…))`), the folder absolute and
// without a trailing separator but for the filesystem root; the sweep gives it those.
const SITES: { name: string; old: (p: string, dir: string) => boolean; now: (p: string, dir: string) => boolean; opts?: PathInsideOptions; normalised?: true }[] = [
  { name: 'lexical, folder inside, `..name` outside', old: lexicalSelf, opts: { dotDotPrefix: true }, now: (p, d) => pathInside(p, d, { dotDotPrefix: true }) },
  { name: 'lexical, folder not inside, `..name` outside', old: lexicalNoSelf, opts: { self: false, dotDotPrefix: true }, now: (p, d) => pathInside(p, d, { self: false, dotDotPrefix: true }) },
  { name: 'lexical, folder inside', old: strictSelf, opts: {}, now: (p, d) => pathInside(p, d) },
  { name: 'lexical, folder not inside', old: strictNoSelf, opts: { self: false }, now: (p, d) => pathInside(p, d, { self: false }) },
  { name: 'spelling, folder inside', old: prefixSelf, opts: { compare: 'spelling' }, now: (p, d) => pathInside(p, d, { compare: 'spelling' }) },
  { name: 'spelling, case folded', old: prefixFold, opts: { compare: 'spelling', fold: true }, now: (p, d) => pathInside(p, d, { compare: 'spelling', fold: true }) },
  { name: 'run-files (a root spelt with a trailing separator holds only itself)', old: runFiles, opts: RUN_FILES, now: (p, d) => pathInside(p, d, RUN_FILES), normalised: true },
  { name: 'pdf.js route (the root itself and a root spelt with a trailing separator hold nothing)', old: pdfRoute, opts: PDF_ROUTE, now: (p, d) => pathInside(p, d, PDF_ROUTE), normalised: true },
];

// [p, dir, …the expected answer of each site above, in order]
const TABLE: [string, string, ...boolean[]][] = [
  ['/a/b', '/a/b', true, false, true, false, true, true, true, false],
  ['/a/b/c', '/a/b', true, true, true, true, true, true, true, true],
  ['/a/bc', '/a/b', false, false, false, false, false, false, false, false],
  ['/a/b/../c', '/a/b', false, false, false, false, true, true, true, true],
  ['/a/b/..c', '/a/b', false, false, true, true, true, true, true, true],
  ['/a/b/..', '/a/b', false, false, false, false, true, true, true, true],
  ['/a', '/a/b', false, false, false, false, false, false, false, false],
  ['/x', '/', true, true, true, true, true, true, false, false],
  ['/', '/', true, false, true, false, true, true, true, false],
  ['/A/B/c', '/a/b', false, false, false, false, false, true, false, false],
  ['/a/b/', '/a/b', true, false, true, false, true, true, true, true],
  ['/a/b/c', '/a/b/', true, true, true, true, true, true, false, false],
  ['rel/x', 'rel', true, true, true, true, true, true, true, true],
  ['/a/b/./c', '/a/b', true, true, true, true, true, true, true, true],
  ['/a/b//c', '/a/b', true, true, true, true, true, true, true, true],
  ['/a/b/...', '/a/b', false, false, true, true, true, true, true, true],
  ['/a/b', 'a/b', false, false, false, false, false, false, false, false],
];

describe('pathInside: the semantics of every site, pinned', () => {
  it('a frozen table: the copies replaced and pathInside agree with it', () => {
    for (const [p, dir, ...want] of TABLE) {
      SITES.forEach((s, i) => {
        expect(s.old(p, dir), `${s.name} (old) ${p} in ${dir}`).toBe(want[i]);
        expect(s.now(p, dir), `${s.name} ${p} in ${dir}`).toBe(want[i]);
      });
    }
  });

  it('a seeded sweep of spellings: each site answers as its copy did, and relativeInside gives the relative path', () => {
    let seed = 0x5eed;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const SEGS = ['a', 'b', 'A', 'B', 'ab', '..', '.', '..a', '...', '', 'a.', '.a'];
    const path = () => {
      const segs = Array.from({ length: rnd(5) }, () => SEGS[rnd(SEGS.length)]);
      return (rnd(5) ? '/' : '') + segs.join('/') + (rnd(6) ? '' : '/');
    };
    let checked = 0;
    for (let i = 0; i < 6000; i++) {
      const dir = path();
      const p = rnd(3) ? `${dir}${rnd(2) ? '/' : ''}${path()}` : path();
      for (const s of SITES) {
        if (s.normalised) {
          const [np, nd] = [normalize(p), resolve('/', dir)];
          expect(s.now(np, nd), `${s.name}: ${JSON.stringify(np)} in ${JSON.stringify(nd)}`).toBe(s.old(np, nd));
          checked++;
          continue;
        }
        expect(s.now(p, dir), `${s.name}: ${JSON.stringify(p)} in ${JSON.stringify(dir)}`).toBe(s.old(p, dir));
        if (s.opts) {
          const rel = relativeInside(p, dir, s.opts);
          expect(rel !== undefined).toBe(s.old(p, dir));
          if (rel !== undefined && s.opts.compare !== 'spelling') expect(rel).toBe(relative(dir, p));
        }
        checked++;
      }
    }
    expect(checked).toBe(6000 * SITES.length);
  });

  it('fold and self combine with either comparison; real is applied to both paths', () => {
    expect(pathInside('/A/b', '/a', { fold: true })).toBe(true);
    expect(pathInside('/A/b', '/a')).toBe(false);
    expect(pathInside('/a', '/A', { fold: true, self: false })).toBe(false);
    expect(relativeInside('/A/B', '/a', { fold: true })).toBe('b');
    expect(relativeInside('/a/b/c', '/a', { compare: 'spelling' })).toBe(`b${sep}c`);
    const seen: string[] = [];
    expect(pathInside('/link/x', '/l', { real: (x) => (seen.push(x), x.replace('/link', '/l')) })).toBe(true);
    expect(seen.sort()).toEqual(['/l', '/link/x']);
  });
});

describe('pathInside with real paths: the sites that follow links', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'retake-path-inside-')));
  const dir = join(root, 'dir');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  mkdirSync(join(root, 'out'));
  symlinkSync(join(root, 'out'), join(dir, 'up'));
  symlinkSync(join(dir, 'sub'), join(root, 'into'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** agent-trust insideFolder before (lexical part strictSelf above). */
  const oldInsideFolder = (d: string, p: string) => strictSelf(realPathOf(resolve(p)), realPathOf(resolve(d)));
  /** mcp tools/project isInside before: realpathSync, the path as given when it does not resolve. */
  const realOrSame = (x: string) => {
    try {
      return realpathSync(x);
    } catch {
      return x;
    }
  };
  const oldMcp = (p: string, r: string) => lexicalSelf(realOrSame(p), realOrSame(r));
  const cases: [string, string][] = [
    [join(dir, 'sub'), dir],
    [join(dir, 'up'), dir],
    [join(dir, 'up', 'x'), dir],
    [join(root, 'into'), dir],
    [join(root, 'into', 'missing'), dir],
    [join(dir, 'missing', 'deeper'), dir],
    [dir, dir],
    [join(root, 'out'), dir],
    [join(dir.toUpperCase(), 'sub'), dir],
    [join(dir, '..', 'dir', 'sub'), dir],
  ];

  it('insideFolder keeps its answers (realPathOf of the resolved paths, a `..` segment out)', () => {
    for (const [p, d] of cases) expect(insideFolder(d, p), `${p} in ${d}`).toBe(oldInsideFolder(d, p));
    expect(insideFolder(dir, join(dir, 'up'))).toBe(false);
    expect(insideFolder(dir, join(root, 'into'))).toBe(true);
  });

  it('projectFileProblem keeps its answers: the folder itself and its files in, a link or `..` out', () => {
    expect(projectFileProblem(dir, '.')).toBeNull();
    expect(projectFileProblem(dir, 'sub')).toBeNull();
    expect(projectFileProblem(dir, '..cache')).toBeNull(); // a name beginning with `..`: inside (a `..` segment only leads out)
    expect(projectFileProblem(dir, 'up/x')).toMatch(/resolves outside the project folder/);
    expect(projectFileProblem(dir, '../out')).toMatch(/resolves outside the project folder/);
  });

  it('the MCP project check keeps its answers (its own resolver)', () => {
    for (const [p, d] of cases) expect(pathInside(p, d, { real: realOrSame, dotDotPrefix: true }), `${p} in ${d}`).toBe(oldMcp(p, d));
  });
});
