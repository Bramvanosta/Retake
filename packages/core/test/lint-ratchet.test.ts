/**
 * scripts/lint.mjs: Biome's linter held to scripts/lint-baseline.json. A new or raised count fails, a lowered one too
 * until the baseline is rewritten (it only shrinks), and every rule biome.json turns off carries a reason.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without types
import { compareCounts, countDiagnostics, unexplainedOff } from '../../../scripts/lint.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const diag = (category: string, path: string, line: number) => ({ category, message: 'm', location: { path, start: { line } } });

describe('the lint ratchet', () => {
  it('counts diagnostics per rule and file, and keeps what is not a lint rule apart', () => {
    const { counts, other } = countDiagnostics({
      diagnostics: [diag('lint/a/x', 'f.ts', 3), diag('lint/a/x', 'f.ts', 9), diag('lint/b/y', 'g.ts', 1), { category: 'deserialize', message: 'bad key', location: { path: 'biome.json' } }],
    });
    expect(counts).toEqual({ 'lint/a/x': { 'f.ts': [3, 9] }, 'lint/b/y': { 'g.ts': [1] } });
    expect(other).toEqual(['deserialize: bad key (biome.json)']);
  });

  it('fails a new or raised count, and a lowered or gone one until the baseline is lowered', () => {
    const baseline = { rules: { 'lint/a/x': { 'f.ts': 2, 'gone.ts': 1 } } };
    expect(compareCounts({ 'lint/a/x': { 'f.ts': [3, 9] } }, baseline).added).toEqual([]);
    const raised = compareCounts({ 'lint/a/x': { 'f.ts': [3, 9, 12], 'gone.ts': [1] }, 'lint/b/y': { 'g.ts': [4] } }, baseline);
    expect(raised.added).toEqual(['lint/a/x f.ts: 2 → 3 (lines 3, 9, 12)', 'lint/b/y g.ts: 0 → 1 (line 4)']);
    expect(raised.stale).toEqual([]);
    expect(compareCounts({ 'lint/a/x': { 'f.ts': [3] } }, baseline).stale).toEqual(['lint/a/x f.ts: 2 → 1', 'lint/a/x gone.ts: 1 → 0']);
  });

  it('asks a reason for every rule turned off', () => {
    const config = { linter: { rules: { preset: 'recommended', style: { a: 'off', b: { level: 'off' }, c: 'warn' } } } };
    expect(unexplainedOff(config, { off: { 'lint/style/a': 'why' } })).toEqual(['lint/style/b']);
    expect(unexplainedOff(json('biome.json'), json('scripts/lint-baseline.json'))).toEqual([]);
  });

  it('Biome is pinned to one exact version, the one the baseline was counted with', () => {
    const pin = json('package.json').devDependencies['@biomejs/biome'];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json('scripts/lint-baseline.json').biome).toBe(pin);
  });

  it("the repository's code holds its baseline (pnpm lint)", () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/lint.mjs')], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/holds: \d+ diagnostics allowed, none new/);
    expect(r.status).toBe(0);
  });
});
