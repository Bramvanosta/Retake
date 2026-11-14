/**
 * Path containment on Windows paths (core path-inside.ts with node:path's win32 rules): a path on another drive is
 * never inside a folder — path.relative answers it whole and absolute there, the one case its `isAbsolute` check
 * catches (on POSIX path.relative never answers an absolute path).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});

const { pathInside, relativeInside } = await import('../src/path-inside.js');

describe('path containment with Windows paths', () => {
  it('a path on another drive is outside; one under the folder is inside, its relative path with backslashes', () => {
    expect(relativeInside('D:\\work\\a.txt', 'C:\\work')).toBeUndefined();
    expect(pathInside('D:\\work', 'C:\\work')).toBe(false);
    expect(relativeInside('C:\\work\\sub\\a.txt', 'C:\\work')).toBe('sub\\a.txt');
    expect(relativeInside('C:\\other', 'C:\\work')).toBeUndefined();
    expect(relativeInside('c:\\WORK\\a.txt', 'C:\\work', { fold: true })).toBe('a.txt');
  });
});
