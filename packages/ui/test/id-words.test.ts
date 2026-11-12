/**
 * L7.5 part D: the app's one mirror of the id grammar (app/id-words.ts) is core's (core id-grammar.ts) — the app
 * imports types only from the workspace's packages, so this test is what holds the two the same:
 * - every pattern source for source, every cap for cap;
 * - `okNewThemeName` answers as core's `isNewThemeName`, `renderVersionWords` reads the suffix core's `renderSuffix`
 *   reads, the run id with its cap answers as `isRunId`, a listed theme as `isThemeName` — on a table and on generated
 *   strings;
 * - the render id mirror is the PUBLISHED pattern with its cap: it has no bound on the version (that bound is
 *   `isRenderId`'s, the server's);
 * - the names the app's screens use (`renderWords`, `versionWords`, `route.ts` `RENDER_ID`, a project slug) are these
 *   very objects, not copies; an address holds a render id's shape with its cap;
 * - a project slug keeps its cap of 100 (`okName`), a new theme's name has 60 everywhere the app asks for one: the two
 *   predicates, the two sentences and the four fields.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANY_THEME_NAME_MAX as CORE_ANY_MAX,
  ANY_THEME_NAME_RE,
  NEW_THEME_NAME_MAX as CORE_NEW_MAX,
  NEW_THEME_NAME_RE,
  PROJECT_SLUG_RE,
  RENDER_ID_MAX as CORE_RENDER_MAX,
  RENDER_ID_RE,
  RENDER_VERSION_MAX,
  RUN_ID_MAX as CORE_RUN_MAX,
  RUN_ID_RE,
  isNewThemeName,
  isRenderId,
  isRunId,
  isThemeName,
  renderSuffix,
} from '@retake/core';
import * as mirror from '../src/app/id-words.js';
import { ANY_THEME_NAME, ANY_THEME_NAME_MAX, NEW_THEME_NAME, NEW_THEME_NAME_MAX, PROJECT_SLUG, RENDER_ID, RENDER_ID_MAX, RUN_ID, RUN_ID_MAX, okNewThemeName, okRenderIdShape, renderVersionWords } from '../src/app/id-words.js';
import { renderWords } from '../src/app/words/comment-words.js';
import { versionWords } from '../src/app/words/render-words.js';
import { NAME_MAX, NEW_THEME_NAME_HINT, NEW_THEME_TOO_LONG, okName, okTheme, themeNameProblem } from '../src/app/words/library-words.js';
import { rawExportCommand } from '../src/app/review/review-words.js';
import { RENDER_ID as ROUTE_RENDER_ID, hrefTo, parseRoute } from '../src/app/route.js';
import { EMPTY_FORM, newThemeProblem } from '../src/app/words/theme-words.js';

const a = (n: number, ch = 'a') => ch.repeat(n);
const src = (file: string) => readFileSync(fileURLToPath(new URL(`../src/app/${file}`, import.meta.url)), 'utf8');

/** Strings over the characters the grammars turn on, from a fixed seed (the same strings every run). */
function generated(count: number, alphabet: string[], maxLen: number): string[] {
  let seed = 20261110;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    for (let n = next() % (maxLen + 1); n > 0; n--) s += alphabet[next() % alphabet.length];
    out.push(s);
  }
  return out;
}

const NAMES: unknown[] = ['editorial', 'my-theme', 'My_Theme', 'a.b', '', '-x', '_x', 'x\n', 'x y', '../x', 'x/y', '\uff11', 7, null, undefined, ['a'], a(59), a(60), a(61), a(64), a(65), a(100), a(101), a(60, 'A'), a(100, 'A'), a(101, 'A'), a(200), a(201)];

describe('the app\'s mirror of the id grammar', () => {
  it('⚑ every pattern is core\'s source for source, every cap core\'s', () => {
    expect([RUN_ID.source, RUN_ID.flags, RUN_ID_MAX]).toEqual([RUN_ID_RE.source, RUN_ID_RE.flags, CORE_RUN_MAX]);
    expect([RENDER_ID.source, RENDER_ID.flags, RENDER_ID_MAX]).toEqual([RENDER_ID_RE.source, RENDER_ID_RE.flags, CORE_RENDER_MAX]);
    expect([ANY_THEME_NAME.source, ANY_THEME_NAME.flags, ANY_THEME_NAME_MAX]).toEqual([ANY_THEME_NAME_RE.source, ANY_THEME_NAME_RE.flags, CORE_ANY_MAX]);
    expect([NEW_THEME_NAME.source, NEW_THEME_NAME.flags, NEW_THEME_NAME_MAX]).toEqual([NEW_THEME_NAME_RE.source, NEW_THEME_NAME_RE.flags, CORE_NEW_MAX]);
    // Written once more here, so that a change of both sides at once is seen too.
    expect([RUN_ID_MAX, RENDER_ID_MAX, ANY_THEME_NAME_MAX, NEW_THEME_NAME_MAX]).toEqual([200, 200, 100, 60]);
    expect([RUN_ID.source, RENDER_ID.source, ANY_THEME_NAME.source, NEW_THEME_NAME.source]).toEqual([
      '^[A-Za-z0-9][A-Za-z0-9._-]*$',
      '^[A-Za-z0-9][A-Za-z0-9_-]*-v\\d+(?:-vertical|-square)?$',
      '^[A-Za-z0-9][A-Za-z0-9_-]*$',
      '^[a-z0-9][a-z0-9-]*$',
    ]);
    // The whole file is held: a name added to it is added to this test.
    expect(Object.keys(mirror).sort()).toEqual(['ANY_THEME_NAME', 'ANY_THEME_NAME_MAX', 'NEW_THEME_NAME', 'NEW_THEME_NAME_MAX', 'PROJECT_SLUG', 'RENDER_ID', 'RENDER_ID_MAX', 'RUN_ID', 'RUN_ID_MAX', 'okNewThemeName', 'okRenderIdShape', 'renderVersionWords']);
  });

  it('the mirror imports nothing, and the names the screens use are its objects', () => {
    expect(src('id-words.ts')).not.toMatch(/^\s*import\b/m);
    expect(PROJECT_SLUG).toBe(NEW_THEME_NAME);
    expect([renderWords, versionWords]).toEqual([renderVersionWords, renderVersionWords]);
    expect(ROUTE_RENDER_ID).toBe(RENDER_ID);
    expect(PROJECT_SLUG.source).toBe(PROJECT_SLUG_RE.source);
  });

  it('⚑ a new theme\'s name: the app answers as core, at most 60 characters', () => {
    for (const n of NAMES) expect(okNewThemeName(n), String(n).slice(0, 20)).toBe(isNewThemeName(n));
    const many = generated(4000, ['a', 'z', '0', '9', '-', '_', 'A', '.', '\n', ' '], 6);
    expect(many.filter((s) => okNewThemeName(s) !== isNewThemeName(s))).toEqual([]);
    expect(many.some((s) => okNewThemeName(s))).toBe(true);
    expect([a(59), a(60), a(61), a(64), a(100)].map((n) => okNewThemeName(n))).toEqual([true, true, false, false, false]);
  });

  it('a listed theme\'s name and a project slug: at most 100 characters, as before', () => {
    for (const n of NAMES) expect(okTheme(n), String(n).slice(0, 20)).toBe(isThemeName(n));
    expect([a(60), a(61), a(100), a(101)].map((n) => okTheme(n))).toEqual([true, true, true, false]);
    expect(NAME_MAX).toBe(100);
    expect([a(60), a(61), a(100), a(101), a(100, 'A')].map((n) => okName(n))).toEqual([true, true, true, false, false]);
  });

  it('a run id with its cap answers as core (the raw export\'s command)', () => {
    const ok = (s: unknown) => typeof s === 'string' && s.length <= RUN_ID_MAX && RUN_ID.test(s);
    const ids: unknown[] = ['20261017-142233-quote', 'a..b', 'my-take', '.tmp-quote', '-quote', 'a/b', '..', '', 'quote\n', 'a\u0000b', '\uff11', 7, a(200), a(201)];
    for (const id of ids) expect(ok(id), String(id).slice(0, 20)).toBe(isRunId(id));
    const many = generated(4000, ['a', 'Q', '2', '.', '_', '-', '/', '\n', ' '], 5);
    expect(many.filter((s) => ok(s) !== isRunId(s))).toEqual([]);
    for (const id of [...ids.filter((x): x is string => typeof x === 'string'), ...many]) expect(rawExportCommand('shop', id) !== null, id.slice(0, 20)).toBe(isRunId(id));
  });

  it('a render id: the published pattern with its cap — core\'s test but for the bound on the version', () => {
    const shape = (s: string) => okRenderIdShape(s);
    expect([okRenderIdShape(`${a(197)}-v1`), okRenderIdShape(`${a(198)}-v1`), okRenderIdShape(7), RENDER_ID.test(`${a(198)}-v1`)]).toEqual([true, false, false, true]);
    // An address holds it with its cap, both ways: a longer one is no review address and is left out of a link.
    const at = (render: string) => [parseRoute(`#/p/shop/s/quote/review/${render}`).name, hrefTo({ name: 'review', slug: 'shop', scenario: 'quote', render })];
    expect([at('quote-v3'), at(`${a(197)}-v1`), at(`${a(198)}-v1`)]).toEqual([['review', '#/p/shop/s/quote/review/quote-v3'], ['review', `#/p/shop/s/quote/review/${a(197)}-v1`], ['not-found', '#/p/shop/s/quote/review']]);
    const ids = ['quote-v3', 'quote-v3-vertical', 'quote-v3-square', 'quote-v0', 'quote-v007', 'quote-v2-v1', 'Quote_2-v1', 'quote', 'final', 'quote-v1-tall', 'quote-V1', 'a.b-v1', '-v1', 'quote-v1\n', '', `${a(197)}-v1`, `${a(198)}-v1`, `quote-v${RENDER_VERSION_MAX}`];
    for (const id of ids) expect(shape(id), id.slice(0, 20)).toBe(isRenderId(id));
    // Past the bound the pattern still matches: the server refuses such an id (isRenderId), the app only routes it.
    for (const id of [`quote-v${RENDER_VERSION_MAX + 1}`, 'quote-v9007199254740992', 'quote-v99999999999999999999']) expect([shape(id), isRenderId(id)], id).toEqual([true, false]);
  });

  it('⚑ the words of a version read the suffix core reads', () => {
    const words = (s: string) => {
      const r = renderSuffix(s);
      return r ? `v${r.digits}${r.variant === 'landscape' ? '' : ` ${r.variant}`}` : s;
    };
    const ids = ['quote-v3', 'quote-v3-vertical', 'quote-v3-square', 'quote-v007', 'quote-v2-v1', 'quote-v1000000', 'final', 'quote-v1-tall', 'quote-V1', '-v1', '', 'quote-v1\n', 'quote-v', 'quote-v1-', 'q-v1-v2-vertical', 'quote-v3-square-vertical'];
    for (const id of ids) expect(renderVersionWords(id), id).toBe(words(id));
    const many = generated(6000, ['q', '-', 'v', 'V', '1', '0', '-vertical', '-square', '-v', '\n'], 6);
    expect(many.filter((s) => renderVersionWords(s) !== words(s))).toEqual([]);
    expect(many.some((s) => renderSuffix(s) !== null)).toBe(true);
    expect([renderVersionWords('quote-v3'), renderVersionWords('quote-v3-vertical'), renderVersionWords('quote-v007'), renderVersionWords('final')]).toEqual(['v3', 'v3 vertical', 'v007', 'final']);
  });
});

describe('60 characters for a new theme\'s name, wherever the app asks for one (D-3)', () => {
  it('both forms say so, after the grammar\'s sentence', () => {
    expect(NEW_THEME_TOO_LONG).toBe('At most 60 characters.');
    const copy = (name: string) => themeNameProblem(name, []);
    const form = (name: string) => newThemeProblem({ ...EMPTY_FORM, name, logo: 'brand/logo.svg' }, []);
    expect([copy(a(60)), copy(a(61)), copy(a(100)), copy(a(101))]).toEqual([null, NEW_THEME_TOO_LONG, NEW_THEME_TOO_LONG, NEW_THEME_TOO_LONG]);
    expect([form(a(60)), form(a(61)), form(a(100)), form(a(101))]).toEqual([null, NEW_THEME_TOO_LONG, NEW_THEME_TOO_LONG, NEW_THEME_TOO_LONG]);
    expect(copy(a(61, 'A'))).toMatch(/Lower-case/);
    expect(form(a(61, 'A'))).toMatch(/lower-case/);
  });

  it('⚑ the four fields that take a new theme\'s name stop at the cap, by its name, and say the rule under the field', () => {
    // The field stops at 60, so the sentence of a name too long cannot show: the limit is said before it is met.
    expect(NEW_THEME_NAME_HINT).toBe('Lower-case letters, digits and "-", at most 60 characters.');
    const fields = (file: string) => {
      const text = src(file);
      const named = [...text.matchAll(/<TextField label="(Name of the copy|Name)"[^\n]*?maxLength=\{([^}]+)\} hint=\{NEW_THEME_NAME_HINT\}/g)].map((m) => `${m[1]}: ${m[2]}`);
      return { named, hundred: (text.match(/maxLength=\{100\}/g) ?? []).length };
    };
    expect(fields('themes/ThemeEditor.tsx')).toEqual({ named: ['Name of the copy: NEW_THEME_NAME_MAX'], hundred: 0 });
    expect(fields('library/LibraryInspector.tsx')).toEqual({ named: ['Name of the copy: NEW_THEME_NAME_MAX'], hundred: 0 });
    expect(fields('themes/ThemesScreen.tsx')).toEqual({ named: ['Name of the copy: NEW_THEME_NAME_MAX', 'Name: NEW_THEME_NAME_MAX'], hundred: 0 });
    for (const file of ['themes/ThemeEditor.tsx', 'library/LibraryInspector.tsx', 'themes/ThemesScreen.tsx']) expect(src(file), file).toMatch(/import \{ NEW_THEME_NAME_MAX \} from '\.\.\/id-words\.js';/);
  });
});
