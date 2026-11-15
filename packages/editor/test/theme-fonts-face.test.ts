/**
 * The compositions' theme fonts (src/remotion/fonts.ts loadFace) with a stubbed FontFace API: a static face is
 * registered at its weight ("600"), a variable font at its range as the CSS descriptor "200 800" (never "200,800",
 * which `String([200, 800])` would give and a browser refuses).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFace } from '../src/remotion/fonts.js';

const made: Array<{ family: string; source: string; descriptors: FontFaceDescriptors }> = [];
const added: unknown[] = [];
const saved = { FontFace: (globalThis as Record<string, unknown>).FontFace, document: (globalThis as Record<string, unknown>).document };

beforeEach(() => {
  made.length = 0;
  added.length = 0;
  (globalThis as Record<string, unknown>).FontFace = class {
    constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
      made.push({ family, source, descriptors });
    }
    load() {
      return Promise.resolve(this);
    }
  };
  (globalThis as Record<string, unknown>).document = { fonts: { add: (f: unknown) => added.push(f) } };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).FontFace = saved.FontFace;
  (globalThis as Record<string, unknown>).document = saved.document;
});

describe('theme font faces', () => {
  it('a variable font is registered with the weight descriptor "200 800"; a static one with its weight', async () => {
    await loadFace({ family: 'retake-x-body', url: 'http://assets.local/v.woff2', weight: [200, 800], style: 'normal' });
    await loadFace({ family: 'retake-x-body', url: 'http://assets.local/sb.ttf', weight: 600, style: 'italic' });
    expect(made.map((m) => m.descriptors)).toEqual([
      { weight: '200 800', style: 'normal' },
      { weight: '600', style: 'italic' },
    ]);
    expect(added).toHaveLength(2);
    // Once per face: the same range again loads nothing new.
    await loadFace({ family: 'retake-x-body', url: 'http://assets.local/v.woff2', weight: [200, 800], style: 'normal' });
    expect(made).toHaveLength(2);
  });
});
