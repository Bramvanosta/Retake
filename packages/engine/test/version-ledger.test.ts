/** The versions of a file this process showed or wrote (VersionLedger): an undo / redo restores only these. */
import { describe, expect, it } from 'vitest';
import { VersionLedger } from '../src/version-ledger.js';

describe('VersionLedger', () => {
  it('knows what it was told, per file', () => {
    const l = new VersionLedger();
    l.remember('a.yaml', 'h1');
    expect(l.knows('a.yaml', 'h1')).toBe(true);
    expect(l.knows('a.yaml', 'h2')).toBe(false);
    expect(l.knows('b.yaml', 'h1')).toBe(false);
  });

  it('keeps the newest versions of a file, and the files used last', () => {
    const l = new VersionLedger(2, 2);
    for (const h of ['h1', 'h2', 'h1', 'h3']) l.remember('a', h);
    // h1 was told again after h2: h2 is the oldest and goes.
    expect(['h1', 'h2', 'h3'].map((h) => l.knows('a', h))).toEqual([true, false, true]);
    l.remember('b', 'x');
    l.remember('a', 'h3'); // a used again: b is now the file used least recently
    l.remember('c', 'y');
    expect([l.knows('a', 'h3'), l.knows('b', 'x'), l.knows('c', 'y')]).toEqual([true, false, true]);
  });
});
