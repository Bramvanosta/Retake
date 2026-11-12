/**
 * The ids of the domain as the Studio's server and app read them (L7.5): the scenario a finished job's notification
 * names, the sentence of a proposal's offer when the themes differ, the raw export's command, the review route's
 * render id, the words of a render's version, and the name rules of the library and the theme forms.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; the mark names the decision.
 */
import { describe, expect, it } from 'vitest';
import type { JobRecord } from '@retake/engine';
import { renderWords } from '../src/app/words/comment-words.js';
import { ANY_THEME_NAME, PROJECT_SLUG, okNewThemeName } from '../src/app/id-words.js';
import { NAME_MAX, copyName, createPrompt, okName, okTheme, themeNameProblem } from '../src/app/words/library-words.js';
import { versionWords } from '../src/app/words/render-words.js';
import { rawExportCommand } from '../src/app/review/review-words.js';
import { RENDER_ID } from '../src/app/route.js';
import { EMPTY_FORM, newThemeProblem } from '../src/app/words/theme-words.js';
import { proposalOffer } from '../src/server/comment-ops.js';
import type { OfferFacts } from '../src/server/comment-ops.js';
import { RunLiveInput } from '../src/server/run-live.js';
import { jobNames } from '../src/server/supervise.js';

const a = (n: number, ch = 'a') => ch.repeat(n);
const short = (s: string) => s.replace(/(.)\1{30,}/g, (m, ch: string) => `<${m.length} ${ch}>`);

describe('the scenario a job names', () => {
  const of = (kind: string, input: Record<string, unknown>) => jobNames({ kind, input } as unknown as Pick<JobRecord, 'kind' | 'input'>).scenario ?? null;

  it('a review or an export: its render id without the version and the variant; an id without them, whole', () => {
    const rows: Array<[string, string | null]> = [
      ['quote-v3', 'quote'],
      ['quote-v3-vertical', 'quote'],
      ['quote-v3-square', 'quote'],
      ['quote-v007', 'quote'],
      ['quote-v2-v1', 'quote-v2'],
      ['Quote_2-v1', 'Quote_2'],
      ['quote-v1000000', 'quote'],
      ['quote-v99999999999999999999', 'quote'],
      ['final', 'final'],
      ['quote', 'quote'],
      ['quote-v1-tall', 'quote-v1-tall'],
      ['quote-V1', 'quote-V1'],
      ['a.b-v1', null],
      ['../x-v1', null],
      ['-v1', null],
      ['', null],
    ];
    for (const kind of ['review', 'export'])
      expect(
        rows.map(([id]) => of(kind, { project: 'p', render_id: id })),
        kind,
      ).toEqual(rows.map((r) => r[1]));
    expect(of('review', { project: 'p', render_id: 7 })).toBeNull();
    expect(of('render', { project: 'p', scenario: 'quote', render_id: 'other-v1' })).toBe('quote');
  });
});

describe("a proposal's offer when the commented render used another theme", () => {
  const offer = (render: string, files: string) =>
    short(
      proposalOffer({ actionable: true, verified: true, same_take: true } as never, {
        variant: 'landscape',
        render: { template: render, overrides: [] },
        files_theme: { name: files },
      } satisfies OfferFacts).why ?? '(none)',
    );
  const LATER = 'apply it, then render it from your terminal or ask Claude';

  it("names the two themes when both are names of a theme: the rule the board and a render's theme read a folder's name by", () => {
    const other = `The commented render used another theme than the files': ${LATER}`;
    expect(offer('editorial', 'editorial')).toBe('(none)');
    expect(offer('editorial', 'motion')).toBe(`The commented render used the theme editorial, not the files' motion: ${LATER}`);
    expect(offer(a(64), 'motion')).toBe(`The commented render used the theme <64 a>, not the files' motion: ${LATER}`);
    // One rule for a theme that exists (letters, digits, "_" and "-", at most 100 characters), in place of this
    // sentence's own (a dot allowed, 64 characters).
    expect(offer('a.b', 'motion')).toBe(other); // one theme rule: a dot
    expect(offer(a(65), 'motion')).toBe(`The commented render used the theme <65 a>, not the files' motion: ${LATER}`); // one theme rule: 65 to 100 characters
    expect(offer('editorial', a(100, 'T'))).toBe(`The commented render used the theme editorial, not the files' <100 T>: ${LATER}`); // one theme rule: 65 to 100 characters
    expect(offer(a(101), 'motion')).toBe(other);
    expect(offer('editorial', a(101))).toBe(other);
    expect(offer('../x', 'motion')).toBe(`The commented render used another theme than the files': ${LATER}`);
    expect(offer('my theme', 'motion')).toBe(`The commented render used another theme than the files': ${LATER}`);
  });
});

describe("the live view's request (POST /v1/live, outside the op table)", () => {
  it("names its run by a run id of at most 200 characters, with the route's own sentence", () => {
    const issues = (run_id: unknown) => {
      const r = RunLiveInput.safeParse({ project: 'shop', run_id });
      return r.success ? 'ok' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.code}: ${i.message}`).join(' | ');
    };
    expect([issues('20261017-142233-quote'), issues('a..b'), issues(a(200))]).toEqual(['ok', 'ok', 'ok']);
    expect(issues(a(201))).toMatch(/^run_id: too_big: /);
    for (const bad of ['../x', '.tmp-quote', '-quote', 'a/b', '', 'quote\n']) expect(issues(bad), bad).toBe('run_id: invalid_format: a run id, never a path');
    expect(issues(`.${a(200)}`)).toMatch(/^run_id: too_big: .* \| run_id: invalid_format: a run id, never a path$/);
    expect(issues(7)).toMatch(/^run_id: invalid_type: /);
  });
});

describe("the app's own readings", () => {
  it("the raw export's command takes a project slug and a run id of at most 200 characters each", () => {
    expect(rawExportCommand('shop', '20261017-142233-quote')).toBe('retake export-capture shop 20261017-142233-quote');
    expect(rawExportCommand('shop', 'a..b')).toBe('retake export-capture shop a..b');
    expect(short(rawExportCommand('shop', a(200)) ?? '(none)')).toBe('retake export-capture shop <200 a>');
    const refused = [a(201), '.tmp-quote', '-quote', 'a/b', 'a b', 'a;b', "a'b", '', '20261017-142233-quote\n'];
    expect(refused.map((id) => rawExportCommand('shop', id))).toEqual(refused.map(() => null));
    expect(rawExportCommand('Shop', 'quote')).toBeNull();
  });

  it("the review route's render id: the grammar, with no bound on the version", () => {
    expect(RENDER_ID.source).toBe('^[A-Za-z0-9][A-Za-z0-9_-]*-v\\d+(?:-vertical|-square)?$');
    const rows: Array<[string, boolean]> = [
      ['quote-v3', true],
      ['quote-v3-vertical', true],
      ['quote-v0', true],
      ['quote-v2-v1', true],
      ['quote-v1000000', true],
      ['quote-v99999999999999999999', true],
      ['final', false],
      ['quote-v1-tall', false],
      ['quote-V1', false],
      ['a.b-v1', false],
      ['-v1', false],
      ['quote-v1\n', false],
      ['', false],
    ];
    expect(rows.map(([id]) => RENDER_ID.test(id))).toEqual(rows.map((r) => r[1]));
  });

  it('the words of a render\'s version: "v<N>", its variant, or the id itself', () => {
    const rows: Array<[string, string]> = [
      ['quote-v3', 'v3'],
      ['quote-v3-vertical', 'v3 vertical'],
      ['quote-v3-square', 'v3 square'],
      ['quote-v007', 'v007'],
      ['quote-v2-v1', 'v1'],
      ['quote-v1000000', 'v1000000'],
      ['final', 'final'],
      ['quote-v1-tall', 'quote-v1-tall'],
      ['quote-V1', 'quote-V1'],
      ['-v1', 'v1'],
      ['', ''],
    ];
    expect(rows.map(([id]) => versionWords(id))).toEqual(rows.map((r) => r[1]));
    expect(rows.map(([id]) => renderWords(id))).toEqual(rows.map((r) => r[1]));
  });
});

describe('names in the library and the theme forms', () => {
  it("a project slug is lower-case, a listed theme's name any-case, both at most 100 characters; a new theme's name is lower-case, at most 60", () => {
    expect([PROJECT_SLUG.source, ANY_THEME_NAME.source, NAME_MAX]).toEqual(['^[a-z0-9][a-z0-9-]*$', '^[A-Za-z0-9][A-Za-z0-9_-]*$', 100]);
    const names = ['editorial', 'my-theme', a(60), a(61), a(100), a(101), 'My_Theme', a(100, 'A'), 'a.b', '', '-x', 'x\n', 7];
    expect(names.filter(okName).map((n) => short(String(n)))).toEqual(['editorial', 'my-theme', '<60 a>', '<61 a>', '<100 a>']);
    expect(names.filter(okTheme).map((n) => short(String(n)))).toEqual(['editorial', 'my-theme', '<60 a>', '<61 a>', '<100 a>', 'My_Theme', '<100 A>']);
    expect(names.filter(okNewThemeName).map((n) => short(String(n)))).toEqual(['editorial', 'my-theme', '<60 a>']);
  });

  it('the prompt for a new component names the project by a slug of at most 100 characters', () => {
    const prompt = (project: string) => short(createPrompt({ kind: 'card', id: 'mine/card', project, description: '' })?.prompt ?? '(none)');
    expect(prompt(a(100))).toContain(' for project `<100 a>`');
    expect(prompt(a(101))).not.toContain('for project');
    expect(prompt('Shop')).not.toContain('for project');
  });

  it("a copy's proposed name: the theme's, lowered, with -copy", () => {
    expect(copyName('editorial', [])).toBe('editorial-copy');
    expect(copyName('editorial', ['editorial-copy'])).toBe('editorial-copy-2');
    expect(copyName('My_Theme', [])).toBe('my-theme-copy');
    expect(copyName('a.b', [])).toBe('theme-copy');
    expect(copyName(a(101), [])).toBe('theme-copy');
    // L7.5 D-3: a new theme's name has at most 60 characters. The source may be any listed theme (up to 100): its
    // proposed copy is cut so that "-copy-999" still fits. (Before: cut for a cap of 100, and one character over it
    // once 99 copies were taken.)
    expect(short(copyName(a(80), []))).toBe('<51 a>-copy'); // D-3
    expect(short(copyName(a(100), []))).toBe('<51 a>-copy'); // D-3
    expect(short(copyName(a(100), [`${a(51)}-copy`]))).toBe('<51 a>-copy-2'); // D-3
    const taken = [`${a(51)}-copy`, ...Array.from({ length: 997 }, (_, i) => `${a(51)}-copy-${i + 2}`)];
    expect(short(copyName(a(100), taken))).toBe('<51 a>-copy-999'); // D-3
    expect(copyName(a(100), taken)).toHaveLength(60); // D-3
    expect(short(copyName(a(100), [...taken, `${a(51)}-copy-999`]))).toBe('<51 a>-copy-x');
    expect(short(copyName(a(100, 'A'), []))).toBe('<51 a>-copy');
    for (const source of [a(60), a(61), a(80), a(100), a(100, 'A'), `${a(50)}_${a(40)}`]) expect(okNewThemeName(copyName(source, [])), source).toBe(true);
  });

  it("why a new theme's name cannot be used", () => {
    const lower = 'Lower-case letters, digits and "-" only, starting with a letter or a digit.';
    const copy = (name: string) => themeNameProblem(name, ['taken']);
    expect([copy(''), copy('My_Theme'), copy('a.b'), copy('taken'), copy('mine'), copy(a(60))]).toEqual(['Give the copy a name.', lower, lower, 'A theme of that name exists.', null, null]);
    // L7.5 D-3: a name that passes the grammar and has more than 60 characters is too long, in both forms (before:
    // accepted up to 100, and the grammar's sentence at 101).
    const long = 'At most 60 characters.';
    expect([copy(a(61)), copy(a(64)), copy(a(65)), copy(a(100))]).toEqual([long, long, long, long]); // D-3
    expect(copy(a(101))).toBe(long); // D-3
    expect(copy(a(61, 'A'))).toBe(lower);
    const form = (name: string) => newThemeProblem({ ...EMPTY_FORM, name, logo: 'brand/logo.svg' }, ['taken']);
    const lowerForm = 'A theme name is lower-case letters, digits and "-", starting with a letter or a digit.';
    expect([form(''), form('My_Theme'), form('taken'), form('mine'), form(a(60))]).toEqual(['Give the theme a name.', lowerForm, 'A theme of that name exists.', null, null]);
    expect([form(a(61)), form(a(100))]).toEqual([long, long]); // D-3
    expect(form(a(101))).toBe(long); // D-3
    expect(form(a(61, 'A'))).toBe(lowerForm);
  });
});
