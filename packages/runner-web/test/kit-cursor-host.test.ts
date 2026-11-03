/**
 * L5.13 (critique L5): the in-page cursor's host element is renamed with the product (`<retake-cursor>`); the kit's
 * text helpers and resolver skip it by tag name (SKIP_TAGS), so the two names must move together — a host the resolver
 * did not skip could be taken for page text (its tag name is compared upper-case, as the DOM reports it).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const KIT = readFileSync(new URL('../src/kit/kit.ts', import.meta.url), 'utf8');

describe('the cursor host and SKIP_TAGS', () => {
  it('the tag the kit creates for the cursor host is one the resolver skips', () => {
    const host = /const host = document\.createElement\('([a-z][a-z0-9-]*-[a-z0-9-]+)'\)/.exec(KIT)?.[1];
    expect(host).toBe('retake-cursor');
    const skip = /const SKIP_TAGS = new Set\(\[([^\]]*)\]\)/.exec(KIT)?.[1] ?? '';
    const tags = [...skip.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(tags).toContain(host!.toUpperCase());
  });
});
