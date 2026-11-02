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
    expect(compareTests(before, parseTests(weaker))).toEqual([
      'fewer expects (2 → 1): opens the board',
      'lost test ids [frame]: opens the board',
      'missing title: renders it',
    ]);
    const stronger = BEFORE.replace("await expect.poll", "expect(await page.getByTestId('extra').count()).toBe(1);\n  await expect.poll");
    expect(compareTests(before, parseTests(stronger))).toEqual([]);
  });

  it('runs as a command: no decrease against the working tree itself', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'test-guard.mjs'), '--base', 'HEAD', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stdout).toContain('no decrease');
    expect(r.status).toBe(0);
  });
});
