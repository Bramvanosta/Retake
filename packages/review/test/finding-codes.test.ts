/**
 * FINDING_CODES is complete: every code a check of the review package writes (a literal `code: '…'` or the code
 * argument of `finding(…)`) is in it — review_get shows only those as codes (L3.2 review).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINDING_CODES } from '../src/index.js';

const SRC = join(import.meta.dirname, '..', 'src');

describe('FINDING_CODES', () => {
  it('lists every code the checks write', () => {
    const text = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(SRC, f), 'utf8'))
      .join('\n');
    const written = new Set<string>();
    for (const m of text.matchAll(/code: '([a-z0-9-]+)'/g)) written.add(m[1]);
    for (const m of text.matchAll(/finding\(\s*(?:'[a-z]+'|[^,]+?),\s*'([a-z0-9-]+)'/g)) written.add(m[1]);
    expect(written.size).toBeGreaterThan(40);
    expect([...written].filter((c) => !FINDING_CODES.has(c))).toEqual([]);
  });
});
