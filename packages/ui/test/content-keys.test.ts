/**
 * The React keys of the Studio's lists that can grow, shrink or reorder (bits.tsx contentKeys): one key per item, from
 * its own identity, unique for every input, and the same for an item wherever it moves.
 */
import { describe, expect, it } from 'vitest';
import { contentKeys } from '../src/app/bits.js';

const id = (x: string) => x;
const unique = (keys: string[]) => new Set(keys).size === keys.length;

describe('contentKeys', () => {
  it('distinct items keep their own identity as their key', () => {
    expect(contentKeys(['a', 'b', 'c'], id)).toEqual(['a', 'b', 'c']);
  });

  it('a repeat is suffixed, and a key is unique even when an identity already ends in the suffix', () => {
    expect(contentKeys(['a', 'a', 'a'], id)).toEqual(['a', 'a#2', 'a#3']);
    for (const items of [
      ['a#2', 'a', 'a'],
      ['a', 'a', 'a#2'],
      ['a#2#2', 'a#2', 'a#2', 'a', 'a', 'a'],
      ['#', '#', '##', '#2', '##2'],
      ['', '', '#2'],
    ])
      expect(unique(contentKeys(items, id)), JSON.stringify(items)).toBe(true);
  });

  it('a reorder keeps each distinct item its key', () => {
    const items = [{ k: 'x' }, { k: 'y#1' }, { k: 'z' }];
    const before = new Map(items.map((it, i) => [it, contentKeys(items, (o) => o.k)[i]]));
    const moved = [items[2], items[0], items[1]];
    const after = contentKeys(moved, (o) => o.k);
    expect(moved.map((it) => before.get(it))).toEqual(after);
  });
});
