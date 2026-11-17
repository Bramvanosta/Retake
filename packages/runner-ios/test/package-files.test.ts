/**
 * What the runner-ios package ships: its built code and sources, and the XCUITest driver's sources (`driver/`), which
 * a run copies into the Retake home and builds there — the app bundle installs the package through its `files`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG = join(import.meta.dirname, '..');

describe('the runner-ios package', () => {
  it('ships driver/ beside dist/ and src/', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { files: string[]; private: boolean };
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'src', 'driver']));
    expect(pkg.private).toBe(true);
  });
});
