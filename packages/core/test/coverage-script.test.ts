/**
 * scripts/coverage.mjs, line coverage without a coverage dependency, on sources of its own (a scratch repository): the
 * merger maps V8's byte ranges back to the TypeScript lines through a dist file's .js.map and through a worker
 * script's inline map (what scripts/coverage-setup.mjs writes); the summary counts the lines that carry a mapping
 * (comment lines and lone closing brackets left out), a source no test loaded as all its code lines uncovered, and
 * leaves the tests' own helpers out; `--report` prints a kept state again; and a real run (the setup file in the
 * worker) measures a file its test loads and leaves no work folder behind.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from '@retake/test-support/repo';

type State = { files: Record<string, Record<string, 0 | 1>> };
type Summary = {
  packages: Record<string, { files: number; never: number; lines: number; covered: number }>;
  files: Array<{ file: string; lines: number; covered: number; never: boolean; uncovered: number[] }>;
};
const { summarise, report, createMerger } = (await import(pathToFileURL(join(REPO, 'scripts', 'coverage.mjs')).href)) as {
  summarise(state: State, root?: string): Summary;
  report(summary: Summary, filesRe?: string): string;
  createMerger(state: State, rawDir: string, root?: string): (all: boolean) => void;
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-coverage-test-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A scratch repository: packages/demo/src/{a,b}.ts (a.ts loaded by the "tests", b.ts never), a test helper. */
const root = join(tmp, 'repo');
const A_TS = ['/** A demo module. */', 'export function f(x: number): number {', '  if (x > 0) {', '    return 1;', '  }', '  return 2;', '}', ''].join('\n');
mkdirSync(join(root, 'packages', 'demo', 'src'), { recursive: true });
mkdirSync(join(root, 'packages', 'demo', 'dist'), { recursive: true });
mkdirSync(join(root, 'packages', 'test-support', 'src'), { recursive: true });
writeFileSync(join(root, 'packages', 'demo', 'src', 'a.ts'), A_TS);
writeFileSync(join(root, 'packages', 'demo', 'src', 'b.ts'), 'export const b = 1;\nexport const c = 2;\n');
writeFileSync(join(root, 'packages', 'test-support', 'src', 'h.ts'), 'export const h = 1;\n');
execFileSync('git', ['init', '-q'], { cwd: root });
execFileSync('git', ['add', '.'], { cwd: root });

/**
 * The compiled a.ts: one generated line per source line 2–6 (line n+2 of the source is line n+1 here), with a source
 * map that says so; and the byte range of each generated line.
 */
const JS_LINES = ['export function f(x) {', '  if (x > 0) {', '    return 1;', '  }', '  return 2;', '}'];
const JS = `${JS_LINES.join('\n')}\n`;
/** Source-map mappings: generated line i (0-based) column 0 → source line i + 1 (0-based), as VLQ deltas. */
const MAPPINGS = ['AACA', ...JS_LINES.slice(1).map(() => 'AACA')].join(';');
const MAP = { version: 3, sources: ['../src/a.ts'], names: [], mappings: MAPPINGS };
const starts: number[] = [];
for (let i = 0, at = 0; i < JS_LINES.length; at += JS_LINES[i]!.length + 1, i++) starts.push(at);
const lineRange = (i: number) => ({ startOffset: starts[i]!, endOffset: starts[i]! + JS_LINES[i]!.length });
/** V8's answer for a call f(1): the whole function ran, `return 2` (generated line 4) did not. */
const FUNCTIONS = [
  {
    functionName: 'f',
    ranges: [
      { startOffset: 0, endOffset: JS.length, count: 1 },
      { ...lineRange(4), count: 0 },
    ],
  },
];

/**
 * The environment of a vitest run started from this one: without this run's scratch folders (the home, the
 * CFFIXED_USER_HOME, the captures parent and the names of the ones it made), else the nested run's teardown would
 * remove this run's folders while its other files still use them.
 */
function nestedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RETAKE_HOME: home };
  for (const k of ['RETAKE_TEST_HOME_MADE', 'RETAKE_TEST_CFHOME_MADE', 'RETAKE_TEST_CAPTURES_MADE', 'RETAKE_TEST_CAPTURES', 'RETAKE_CAPTURES_DIR', 'CFFIXED_USER_HOME', 'RETAKE_COVERAGE_RAW'])
    delete env[k];
  return env;
}

describe('scripts/coverage.mjs', () => {
  it('maps a dist file through its .js.map: the covered lines, the line that never ran', () => {
    const dist = join(root, 'packages', 'demo', 'dist', 'a.js');
    writeFileSync(dist, JS);
    writeFileSync(`${dist}.map`, JSON.stringify(MAP));
    const raw = join(tmp, 'raw-dist');
    mkdirSync(join(raw, 'children'), { recursive: true });
    writeFileSync(join(raw, 'children', 'coverage-1.json'), JSON.stringify({ result: [{ url: pathToFileURL(dist).href, functions: FUNCTIONS }] }));
    const state: State = { files: {} };
    createMerger(state, raw, root)(true);
    expect(state.files['packages/demo/src/a.ts']).toEqual({ 2: 1, 3: 1, 4: 1, 5: 1, 6: 0, 7: 1 });
    // Merged files are deleted; nothing of node_modules or outside the packages is kept.
    expect(readdirSync(join(raw, 'children'))).toEqual([]);
  });

  it("maps a worker's script through its inline map (what coverage-setup.mjs writes), and a second run adds to the first", () => {
    const raw = join(tmp, 'raw-worker');
    mkdirSync(join(raw, 'src'), { recursive: true });
    const inline = `${JS}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ ...MAP, sources: [join(root, 'packages', 'demo', 'src', 'a.ts')] })).toString('base64')}\n`;
    writeFileSync(join(raw, 'src', 'h1.js'), inline);
    const url = pathToFileURL(join(root, 'packages', 'demo', 'src', 'a.ts')).href;
    writeFileSync(join(raw, 'coverage-w1.json'), JSON.stringify({ result: [{ url, src: 'h1', functions: FUNCTIONS }] }));
    const state: State = { files: {} };
    const pass = createMerger(state, raw, root);
    pass(true);
    expect(state.files['packages/demo/src/a.ts']![6]).toBe(0);
    // Another worker ran f(-1): `return 2` is covered now; a line covered once stays covered.
    writeFileSync(
      join(raw, 'coverage-w2.json'),
      JSON.stringify({
        result: [
          {
            url,
            src: 'h1',
            functions: [
              {
                functionName: 'f',
                ranges: [
                  { startOffset: 0, endOffset: JS.length, count: 1 },
                  { ...lineRange(2), count: 0 },
                ],
              },
            ],
          },
        ],
      }),
    );
    pass(true);
    expect(state.files['packages/demo/src/a.ts']).toEqual({ 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 });
  });

  it('counts mapped lines (not comments or a lone bracket), a file never loaded as all its code lines, and no test helper', () => {
    const s = summarise({ files: { 'packages/demo/src/a.ts': { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0, 7: 1 } } }, root);
    const a = s.files.find((f) => f.file === 'packages/demo/src/a.ts')!;
    // Line 1 is a comment, 5 and 7 lone closing brackets: left out.
    expect(a).toMatchObject({ lines: 4, covered: 3, never: false, uncovered: [6] });
    expect(s.files.find((f) => f.file === 'packages/demo/src/b.ts')).toMatchObject({ lines: 2, covered: 0, never: true });
    expect(s.packages).toEqual({ demo: { files: 2, never: 1, lines: 6, covered: 3 } });
  });

  it('prints the table per package and, asked, the files least covered first; --report reads a kept state', () => {
    const state: State = { files: { 'packages/demo/src/a.ts': { 2: 1, 3: 1, 4: 1, 6: 0 } } };
    const text = report(summarise(state, root), 'demo/src');
    expect(text).toMatch(/^demo +6 +50\.0 % +2 \(1\)$/m);
    expect(text).toMatch(/^all +6 +50\.0 %$/m);
    expect(text.split('least covered first:')[1]!.trim().split('\n')).toEqual([
      expect.stringMatching(/^ *0\.0 % +0\/2 +never loaded +packages\/demo\/src\/b\.ts$/),
      expect.stringMatching(/^ *75\.0 % +3\/4 +packages\/demo\/src\/a\.ts$/),
    ]);
    const file = join(tmp, 'state.json');
    writeFileSync(file, JSON.stringify({ files: { 'packages/review/src/spans.ts': {} } }));
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'coverage.mjs'), '--report', file], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^review +\d+ +0\.0 %/m);
  });

  it('a real run: the worker setup measures what the test loads; no work folder is left; --state keeps the counts', () => {
    const home = join(tmp, 'home');
    mkdirSync(home);
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('retake-coverage-') && !tmp.endsWith(n));
    const state = join(tmp, 'kept.json');
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'coverage.mjs'), '--state', state, '--files', 'review/src/spans', '--', 'packages/review/test/anchor.test.ts'], {
      cwd: REPO,
      encoding: 'utf8',
      env: nestedEnv(home),
      timeout: 120_000,
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const kept = JSON.parse(readFileSync(state, 'utf8')) as State;
    const spans = Object.values(kept.files['packages/review/src/spans.ts'] ?? {});
    expect(spans.filter((v) => v === 1).length).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/^review +\d+ +\d+\.\d % /m);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('retake-coverage-') && !tmp.endsWith(n));
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
    // This run's own scratch folders are still there (the nested run removed only its own).
    for (const k of ['RETAKE_TEST_CAPTURES', 'CFFIXED_USER_HOME'] as const) if (process.env[k]) expect(statSync(process.env[k]!).isDirectory(), k).toBe(true);
  }, 150_000);
});
