/**
 * console-errors.ts's rule (a test helper the Studio e2e files share): every console error counts but a player CORS
 * error (`/m/<capability>/…`, the 404 of a revoked capability) that came when the preview frames of that capability had
 * all left the Studio page — the race of a frame still fetching while the page removes it. A frame on the page whose
 * request is refused counts (a capability another frame shared too); so does another capability's error, a non-player
 * URL's, or any other error.
 */
import { describe, expect, it } from 'vitest';
import { countedErrors } from './console-errors.js';
import type { FrameMove } from './console-errors.js';

const CAP_A = 'A'.repeat(43);
const CAP_B = `${'b'.repeat(42)}-`;
const frame = (cap: string) => `http://127.0.0.1:50435/s/${cap}/frame`;
const cors = (cap: string, kind = 'font', name = 'Inter-Bold.ttf') =>
  `Access to ${kind} at 'http://127.0.0.1:50435/m/${cap}/${'f'.repeat(22)}/${name}' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`;
const shown = (cap: string, from: number, to?: number): FrameMove[] => [{ move: 'in', src: frame(cap), at: from }, ...(to === undefined ? [] : [{ move: 'out' as const, src: frame(cap), at: to }])];

describe('console-errors: the errors that count', () => {
  it('a player CORS error after its frame left the page does not count (a font or a plan fetch)', () => {
    const moves = shown(CAP_A, 500, 1000);
    expect(countedErrors([{ text: cors(CAP_A), at: 1003 }], moves)).toEqual([]);
    expect(countedErrors([{ text: cors(CAP_A, 'fetch', 'plan.json'), at: 1000 }], moves)).toEqual([]);
  });

  it('⚑ the same error from a frame still on the page — or that left only after it, or never seen — counts', () => {
    expect(countedErrors([{ text: cors(CAP_A), at: 1003 }], shown(CAP_A, 500))).toEqual([cors(CAP_A)]);
    expect(countedErrors([{ text: cors(CAP_A), at: 999 }], shown(CAP_A, 500, 1000))).toEqual([cors(CAP_A)]);
    expect(countedErrors([{ text: cors(CAP_A), at: 1003 }], [])).toEqual([cors(CAP_A)]);
  });

  it('⚑ a capability two frames shared: one gone, the other still shown — its error counts; once both left, it does not', () => {
    const moves = [...shown(CAP_A, 500, 1000), ...shown(CAP_A, 990, 3000)];
    expect(countedErrors([{ text: cors(CAP_A), at: 2000 }], moves)).toEqual([cors(CAP_A)]);
    expect(countedErrors([{ text: cors(CAP_A), at: 3001 }], moves)).toEqual([]);
  });

  it("⚑ another capability's frame leaving excuses nothing; neither does a frame URL of another shape", () => {
    expect(countedErrors([{ text: cors(CAP_B), at: 1003 }], shown(CAP_A, 500, 1000))).toEqual([cors(CAP_B)]);
    const other: FrameMove[] = [
      { move: 'in', src: `http://127.0.0.1:50435/x/${CAP_A}/frame`, at: 500 },
      { move: 'out', src: `http://127.0.0.1:50435/x/${CAP_A}/frame`, at: 1000 },
    ];
    expect(countedErrors([{ text: cors(CAP_A), at: 1003 }], other)).toEqual([cors(CAP_A)]);
  });

  it('⚑ any other error counts, even once a frame left: a CSP or script error, a CORS error of another URL or cause', () => {
    const others = [
      "Refused to load the script 'http://127.0.0.1:50435/x.js' because it violates the following Content Security Policy directive",
      'Uncaught TypeError: x is not a function',
      `Access to font at 'http://127.0.0.1:4401/fonts/${CAP_A}/a.ttf' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`,
      cors(CAP_A).replace("No 'Access-Control-Allow-Origin' header is present", "The 'Access-Control-Allow-Origin' header has a value 'x'"),
    ];
    expect(
      countedErrors(
        others.map((text) => ({ text, at: 2000 })),
        shown(CAP_A, 500, 1000),
      ),
    ).toEqual(others);
  });
});
