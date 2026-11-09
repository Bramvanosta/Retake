/**
 * L5.13 (critique L5): the in-page cursor's host element is renamed with the product (`<retake-cursor>`); the kit's
 * text helpers and resolver skip it by tag name (SKIP_TAGS), so the two names must move together — a host the resolver
 * did not skip could be taken for page text (its tag name is compared upper-case, as the DOM reports it).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAGE_DIR = new URL('../src/kit/page/', import.meta.url);
/** Every module of the in-page kit, one text. */
const KIT = readdirSync(PAGE_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => readFileSync(new URL(f, PAGE_DIR), 'utf8'))
  .join('\n');

describe('the cursor host and SKIP_TAGS', () => {
  it('the tag the kit creates for the cursor host is one the resolver skips', () => {
    const hosts = [...KIT.matchAll(/\bhost = document\.createElement\('([a-z][a-z0-9-]*-[a-z0-9-]+)'\)/g)].map((m) => m[1]);
    expect(hosts).toEqual(['retake-cursor']);
    const skip = /const SKIP_TAGS = new Set\(\[([^\]]*)\]\)/.exec(KIT)?.[1] ?? '';
    const tags = [...skip.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(tags).toContain(hosts[0].toUpperCase());
  });
});
