/**
 * The id module of the domain (L7.5; id-grammar.ts and ids.ts): one grammar each for a run id, a render id, the ULID
 * ids and a theme name, with their caps, parsers, formatters, generators and zod helpers.
 *
 * - Every exported pattern equals the text written here once (the shells publish these as JSON-schema patterns).
 * - A predicate holds its cap; a pattern holds none.
 * - The single parses (the stamp of a run id, the suffix of a render id, the version of a file of renders/) agree with
 *   the patterns they replaced on generated strings (a fixed seed).
 * - A brand comes from a parse; generators and formatters return plain strings.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  ANY_THEME_NAME_MAX,
  ANY_THEME_NAME_RE,
  COMMENT_ENTRY_ID_RE,
  COMMENT_ID_RE,
  INSPECT_ID_RE,
  JOB_ID_RE,
  NEW_THEME_NAME_MAX,
  NEW_THEME_NAME_RE,
  PREVIEW_ID_RE,
  PROJECT_SLUG_RE,
  RECORD_ID_RE,
  RENDER_ID_MAX,
  RENDER_ID_RE,
  RENDER_VARIANT_SUFFIX,
  RENDER_VERSION_MAX,
  RUN_ID_MAX,
  RUN_ID_RE,
  SITE_ID_RE,
  SLUG_RE,
  ULID_BODY,
  ULID_PREFIXES,
  formatRenderId,
  formatRunId,
  formatUlid,
  isJobId,
  isMadeRunId,
  isNewThemeName,
  isRenderId,
  isRunId,
  isThemeName,
  newCommentEntryId,
  newCommentId,
  newRunId,
  newUlidId,
  parseJobId,
  parseRenderId,
  parseRunId,
  renderFileVersion,
  renderFileVersionOf,
  renderIdOf,
  renderLockName,
  renderSuffix,
  runIdOfScenario,
  runIdStamp,
  seededRandom,
  ulid,
  ulidFileRe,
  ulidTime,
  zNewThemeName,
  zRenderId,
  zRunId,
  zThemeName,
} from '../src/index.js';
import * as grammar from '../src/id-grammar.js';
import type { JobId, NewThemeName, RenderId, RenderVariant, RunId, ThemeName, UlidKind } from '../src/index.js';

const a = (n: number, ch = 'a') => ch.repeat(n);
const STAMP = '20261017-142233-';
const BODY = '01K8AB1CDE2FGH3JKM4NPQ5RST';
/** The time BODY holds (its first ten characters), as a number. */
const BODY_TIME = 1_761_283_715_502;

/** Strings of `alphabet`, of 0 to `max` characters, from a fixed seed. */
function generated(seed: string, alphabet: readonly string[], max: number, count: number): string[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: count }, () => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
}

describe('the patterns and caps, as written once', () => {
  it('each exported pattern is this text, with no flag', () => {
    const sources: Array<[RegExp, string]> = [
      [RUN_ID_RE, '^[A-Za-z0-9][A-Za-z0-9._-]*$'],
      [RENDER_ID_RE, '^[A-Za-z0-9][A-Za-z0-9_-]*-v\\d+(?:-vertical|-square)?$'],
      [ANY_THEME_NAME_RE, '^[A-Za-z0-9][A-Za-z0-9_-]*$'],
      [NEW_THEME_NAME_RE, '^[a-z0-9][a-z0-9-]*$'],
      [JOB_ID_RE, '^j_[0-9A-HJKMNP-TV-Z]{26}$'],
      [PREVIEW_ID_RE, '^p_[0-9A-HJKMNP-TV-Z]{26}$'],
      [INSPECT_ID_RE, '^i_[0-9A-HJKMNP-TV-Z]{26}$'],
      [SITE_ID_RE, '^s_[0-9A-HJKMNP-TV-Z]{26}$'],
      [RECORD_ID_RE, '^rec_[0-9A-HJKMNP-TV-Z]{26}$'],
      [COMMENT_ID_RE, '^c_[0-9A-HJKMNP-TV-Z]{26}$'],
      [COMMENT_ENTRY_ID_RE, '^r_[0-9A-HJKMNP-TV-Z]{26}$'],
    ];
    expect(sources.map(([re]) => re.source)).toEqual(sources.map((s) => s[1]));
    for (const [re] of sources) expect(re.flags, re.source).toBe('');
    expect(ULID_BODY).toBe('[0-9A-HJKMNP-TV-Z]{26}');
  });

  it('the caps, the version bound, the variant suffixes and the prefixes', () => {
    expect([RUN_ID_MAX, RENDER_ID_MAX, RENDER_VERSION_MAX, ANY_THEME_NAME_MAX, NEW_THEME_NAME_MAX]).toEqual([200, 200, 999_999, 100, 60]);
    expect(RENDER_VARIANT_SUFFIX).toEqual({ landscape: '', vertical: '-vertical', square: '-square' });
    expect(ULID_PREFIXES).toEqual({ job: 'j_', preview: 'p_', inspect: 'i_', site: 's_', record: 'rec_', comment: 'c_', entry: 'r_', marker: 'k_' });
  });

  it("a listed theme takes a scenario name's grammar, a new theme a project slug's", () => {
    expect(ANY_THEME_NAME_RE.source).toBe(SLUG_RE.source);
    expect(NEW_THEME_NAME_RE.source).toBe(PROJECT_SLUG_RE.source);
    expect(NEW_THEME_NAME_RE.source).not.toBe(ANY_THEME_NAME_RE.source);
  });
});

describe('a run id', () => {
  it('is one path segment of the grammar, of at most 200 characters, and a string', () => {
    const rows: Array<[unknown, boolean]> = [
      [`${STAMP}quote`, true],
      [`${STAMP}Quote`, true],
      [`${STAMP}quote.bak`, true],
      [STAMP, true],
      ['zz-quote', true],
      ['a..b', true],
      ['0', true],
      [a(200), true],
      [a(201), false],
      ['.tmp-quote', false],
      ['-quote', false],
      ['_quote', false],
      ['a/b', false],
      ['a\\b', false],
      ['..', false],
      ['', false],
      [' quote', false],
      [`${STAMP}quote\n`, false],
      [`${STAMP}qu\u0000ote`, false],
      [`\uff120261017-142233-quote`, false],
      [7, false],
      [null, false],
      [undefined, false],
      [[`${STAMP}quote`], false],
      [{ toString: () => 'quote' }, false],
    ];
    expect(rows.map(([v]) => isRunId(v))).toEqual(rows.map((r) => r[1]));
    expect(rows.map(([v]) => parseRunId(v))).toEqual(rows.map(([v, ok]) => (ok ? v : null)));
    // The pattern alone holds no length.
    expect(RUN_ID_RE.test(a(201))).toBe(true);
  });

  it('its stamp: eight digits, six digits, then anything', () => {
    expect(runIdStamp(`${STAMP}quote`)).toEqual({ date: '20261017', time: '142233', rest: 'quote' });
    expect(runIdStamp(STAMP)).toEqual({ date: '20261017', time: '142233', rest: '' });
    expect(runIdStamp(`${STAMP}a\n-quote`)).toEqual({ date: '20261017', time: '142233', rest: 'a\n-quote' });
    expect(runIdStamp(`${STAMP}Quote.bak`)?.rest).toBe('Quote.bak');
    for (const id of ['2026101-142233-quote', '20261017-14223-quote', '20261017_142233-quote', 'x20261017-142233-quote', '20261017-142233', 'zz-quote', '', `\uff120261017-142233-quote`])
      expect(runIdStamp(id), id).toBeNull();
  });

  it('the stamp agrees with the prefix pattern it replaced, on generated strings', () => {
    const DATED = /^\d{8}-\d{6}-/;
    const strings = [...generated('stamp', ['2', '0', '-', 'a', 'Q', '\n', '\r', '\u2028', '_', '.'], 24, 20_000), ...generated('stamp-2', ['1', '-'], 20, 20_000).map((s) => `20261017-${s}`)];
    let stamped = 0;
    for (const s of strings) {
      const now = runIdStamp(s) !== null;
      if (now) stamped++;
      if (now !== DATED.test(s)) throw new Error(`differs on ${JSON.stringify(s)}`);
    }
    expect(stamped).toBeGreaterThan(50);
  });

  it('a run id the tool makes: a stamp, then lower-case letters, digits and dashes, within the cap', () => {
    const MADE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9-]*$/;
    const rows: Array<[string, boolean]> = [
      [`${STAMP}quote`, true],
      [`${STAMP}a--b`, true],
      [`${STAMP}quote-`, true],
      [`${STAMP}0`, true],
      [`${STAMP}${a(184)}`, true],
      [`${STAMP}${a(185)}`, false], // past the cap
      [STAMP, false],
      [`${STAMP}Quote`, false],
      [`${STAMP}quote.bak`, false],
      [`${STAMP}quote_2`, false],
      [`${STAMP}-quote`, false],
      [`${STAMP}quote\n`, false],
      ['2026101-142233-quote', false],
      ['my-take-quote', false],
      ['zz-quote', false],
      ['quote', false],
      ['', false],
    ];
    expect(rows.map(([id]) => isMadeRunId(id))).toEqual(rows.map((r) => r[1]));
    // The pattern it replaced, and the cap.
    for (const s of [...rows.map((r) => r[0]), ...generated('made', ['2', '0', '-', 'a', 'Q', '\n', '_', '.'], 24, 5000).map((s) => `${STAMP}${s}`)]) {
      expect(isMadeRunId(s), JSON.stringify(s)).toBe(MADE.test(s) && s.length <= 200);
    }
  });

  it("a run of a scenario: after the stamp, the scenario's name lower-cased; an id without a stamp ends in -<scenario>", () => {
    const rows: Array<[string, string, boolean]> = [
      [`${STAMP}quote`, 'quote', true],
      [`${STAMP}quote`, 'Quote', true],
      [`${STAMP}mobile-quote`, 'Mobile_Quote', true],
      [`${STAMP}mobile-quote`, 'quote', false],
      [`${STAMP}Quote`, 'Quote', false],
      [`${STAMP}Quote`, 'quote', false],
      [`${STAMP}quote.bak`, 'quote', false],
      [`${STAMP}run`, '___', true],
      ['my-take-quote', 'quote', true],
      ['zz-quote', 'quote', true],
      ['.tmp-quote', 'quote', true],
      ['2026101-142233-quote', 'quote', true],
      ['quote', 'quote', false],
      ['zz-quote', 'Quote', false],
      // A stamped id is never answered by the "ends in" rule.
      [STAMP, '142233-', false],
      [STAMP, '', false],
      [STAMP, 'run', false],
      [`${STAMP}a\n-quote`, 'quote', false],
      [`${STAMP}a\r-quote`, 'quote', false],
      [`${STAMP}a\u2028-quote`, 'quote', false],
      [`${STAMP}a\u2029-quote`, 'quote', false],
      [`${STAMP}x-quote`, 'quote', false],
    ];
    expect(rows.map(([id, s]) => runIdOfScenario(id, s))).toEqual(rows.map((r) => r[2]));
  });

  it('a run of a scenario agrees with the rule it replaced, except where a stamp was answered by the "ends in" rule', () => {
    const before = (id: string, scenario: string) => {
      const m = /^\d{8}-\d{6}-(.+)$/.exec(id);
      const slug =
        scenario
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'run';
      return m ? m[1] === slug : id.endsWith(`-${scenario}`);
    };
    const tails = generated('of', ['q', 'Q', '-', 'a', '\n', '\u2028', '_', '.', '2'], 8, 20_000);
    const scenarios = ['quote', 'Quote', 'q', 'a-q', '', '142233-', 'q-', 'run', 'A_q'];
    let changed = 0;
    tails.forEach((t, i) => {
      const id = i % 3 === 0 ? t : `${STAMP}${t}`;
      for (const s of scenarios) {
        const was = before(id, s);
        const is = runIdOfScenario(id, s);
        if (was === is) continue;
        // The only change: a stamped id that the stamped rule did not read (nothing, or a line break, after the stamp).
        if (!(was && !is && runIdStamp(id) !== null && !/^.+$/.test(runIdStamp(id)?.rest ?? ''))) throw new Error(`differs on ${JSON.stringify([id, s])}`);
        changed++;
      }
    });
    expect(changed).toBeGreaterThan(0);
  });

  it('a made id: local time, the scenario lower-cased with other characters as dashes; a run id while the name has at most 184 characters', () => {
    const at = new Date(2026, 9, 17, 14, 22, 33);
    expect(formatRunId('quote', at)).toBe('20261017-142233-quote');
    expect(formatRunId('My Scenario!', at)).toBe('20261017-142233-my-scenario');
    expect(formatRunId('___', at)).toBe('20261017-142233-run');
    expect(formatRunId('', at)).toBe('20261017-142233-run');
    expect(formatRunId('quote', new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405-quote');
    expect(newRunId('Mobile_Quote', at)).toBe('20261017-142233-mobile-quote');
    expect(newRunId('quote')).toMatch(/^\d{8}-\d{6}-quote$/);
    const names = [...generated('names', ['a', 'B', '_', '-', '9', ' ', '\u00e9', '.'], 184, 300), a(184), a(184, 'Z'), a(184, '_')];
    for (const n of names) {
      const id = formatRunId(n, at);
      expect(isMadeRunId(id), id).toBe(true);
      expect(runIdOfScenario(id, n), id).toBe(true);
    }
    expect(isRunId(formatRunId(a(185), at))).toBe(false);
  });
});

describe('a render id', () => {
  const parsed = (v: unknown) => {
    const p = parseRenderId(v);
    return p ? `${p.scenario} ${p.version} ${p.variant}` : null;
  };

  it('parses to its scenario, version and variant, split at the last -v<N>', () => {
    const rows: Array<[unknown, string | null]> = [
      ['quote-v3', 'quote 3 landscape'],
      ['quote-v3-vertical', 'quote 3 vertical'],
      ['quote-v3-square', 'quote 3 square'],
      ['quote-v0', 'quote 0 landscape'],
      ['quote-v007', 'quote 7 landscape'],
      ['quote-v0000001', 'quote 1 landscape'],
      ['quote-v2-v1', 'quote-v2 1 landscape'],
      ['q-v1-v2-vertical', 'q-v1 2 vertical'],
      ['quote-v-v1', 'quote-v 1 landscape'],
      ['quote_-v1', 'quote_ 1 landscape'],
      ['v-v1', 'v 1 landscape'],
      ['Quote_2-v1', 'Quote_2 1 landscape'],
      ['quote-v999999', 'quote 999999 landscape'],
      ['quote-v0999999-square', 'quote 999999 square'],
      [`${a(197)}-v1`, `${a(197)} 1 landscape`],
      // Past the version bound, past the cap, not of the grammar, not a string:
      ['quote-v1000000', null],
      ['quote-v9007199254740992', null],
      ['quote-v99999999999999999999', null],
      [`quote-v${a(190, '9')}`, null],
      [`${a(198)}-v1`, null],
      ['quote', null],
      ['final', null],
      ['quote-v', null],
      ['quote-v1-tall', null],
      ['quote-v3-square-vertical', null],
      ['quote-v1-vertical-square', null],
      ['quote-V1', null],
      ['quote-v1-Vertical', null],
      ['my render-v1', null],
      ['a.b-v1', null],
      ['-v1', null],
      ['_a-v1', null],
      ['quote-v1.json', null],
      ['quote-v1\n', null],
      ['quote-v\uff11', null],
      ['a/b-v1', null],
      ['', null],
      [3, null],
      [null, null],
      [['quote-v3'], null],
    ];
    expect(rows.map(([v]) => parsed(v))).toEqual(rows.map((r) => r[1]));
    expect(rows.map(([v]) => isRenderId(v))).toEqual(rows.map((r) => r[1] !== null));
    expect(parseRenderId('quote-v3')?.id).toBe('quote-v3');
    // The pattern alone holds no length and no bound.
    expect([RENDER_ID_RE.test(`${a(198)}-v1`), RENDER_ID_RE.test('quote-v1000000')]).toEqual([true, true]);
  });

  it('the suffix of any string: its last -v<digits> and variant, and what precedes it', () => {
    expect(renderSuffix('quote-v3-vertical')).toEqual({ stem: 'quote', digits: '3', variant: 'vertical' });
    expect(renderSuffix('quote-v007')).toEqual({ stem: 'quote', digits: '007', variant: 'landscape' });
    expect(renderSuffix('quote-v2-v1-square')).toEqual({ stem: 'quote-v2', digits: '1', variant: 'square' });
    expect(renderSuffix('my render-v99999999999999999999')).toEqual({ stem: 'my render', digits: '99999999999999999999', variant: 'landscape' });
    expect(renderSuffix('-v1')).toEqual({ stem: '', digits: '1', variant: 'landscape' });
    for (const s of ['final', 'quote', 'quote-v', 'quote-v1-tall', 'quote-V1', 'quote-v1-Vertical', 'quote-v1.json', 'quote-v1\n', '']) expect(renderSuffix(s), s).toBeNull();
  });

  it('a render of a scenario: the scenario exactly, compared as text', () => {
    expect(renderIdOf('quote-v3-vertical', 'quote')).toEqual({ id: 'quote-v3-vertical', version: 3, variant: 'vertical' });
    expect(renderIdOf('quote-v2-v1', 'quote-v2')).toEqual({ id: 'quote-v2-v1', version: 1, variant: 'landscape' });
    const not: Array<[unknown, string]> = [
      ['quote-v2-v1', 'quote'],
      ['Quote-v1', 'quote'],
      ['quote-v1', 'Quote'],
      ['mobile-quote-v1', 'quote'],
      ['quote-v1', 'mobile-quote'],
      ['aXb-v1', 'a.b'],
      ['zz-v1', '.*'],
      ['x-v1', 'quote|x'],
      ['x-v1', 'a('],
      ['quote-v1000000', 'quote'],
      [`${a(198)}-v1`, a(198)],
      ['final', 'final'],
      ['-v1', ''],
      [7, 'quote'],
    ];
    expect(not.map(([v, s]) => renderIdOf(v, s))).toEqual(not.map(() => null));
  });

  it('a formatted id parses back to what it was made of', () => {
    const variants: RenderVariant[] = ['landscape', 'vertical', 'square'];
    for (const scenario of ['quote', 'Quote_2', 'quote-v2', 'q', 'v', a(100)]) {
      for (const version of [0, 1, 7, 12, 999_998, RENDER_VERSION_MAX]) {
        for (const variant of variants) {
          const id = formatRenderId(scenario, version, variant);
          expect(parseRenderId(id), id).toEqual({ id, scenario, version, variant });
          expect(renderIdOf(id, scenario)?.version, id).toBe(version);
        }
      }
    }
    expect([formatRenderId('quote', 3, 'landscape'), formatRenderId('quote', 3, 'vertical'), formatRenderId('quote', 3, 'square')]).toEqual(['quote-v3', 'quote-v3-vertical', 'quote-v3-square']);
    expect(renderLockName('quote', 3)).toBe('.quote-v3.lock');
    expect(renderLockName('Quote_2', RENDER_VERSION_MAX)).toBe('.Quote_2-v999999.lock');
  });

  it('a version that is not a whole number from 0 to the bound is never formatted', () => {
    for (const version of [RENDER_VERSION_MAX + 1, 1.5, -1, NaN, Infinity, 2 ** 53, 1e21, '3' as unknown as number]) {
      expect(() => formatRenderId('quote', version, 'landscape'), String(version)).toThrow(RangeError);
      expect(() => renderLockName('quote', version), String(version)).toThrow(RangeError);
    }
    expect(() => formatRenderId('quote', RENDER_VERSION_MAX + 1, 'square')).toThrow('a render version is a whole number from 0 to 999999, not 1000000');
  });

  it('the version a file of renders/ takes for a name', () => {
    const rows: Array<[string, number | null]> = [
      ['quote-v2.mp4', 2],
      ['quote-v2.json', 2],
      ['.quote-v3.lock', 3],
      ['.quote-v3.mp4', 3],
      ['.quote-v4.json', 4],
      ['quote-v5.lock', 5],
      ['.quote-v6-square.lock', 6],
      ['quote-v7-vertical.lock', 7],
      ['quote-v007.json', 7],
      ['quote-v4-square.json', 4],
      ['quote-v0.mp4', 0],
      ['quote-v1000000.mp4', 1_000_000],
      ['quote-v9007199254740993.json', 9007199254740992],
      ['Quote-v9.json', null],
      ['quote-v2-v9.json', null],
      ['xquote-v8.json', null],
      ['quote-v8.webm', null],
      ['quote-v8-tall.mp4', null],
      ['quote-v8.json.tmp', null],
      ['quote-v8-vertical-square.mp4', null],
      ['quote-V8.mp4', null],
      ['quote-v.mp4', null],
      ['quote-v8.mp4\n', null],
      ['..quote-v8.lock', null],
      ['quote-v8', null],
      ['', null],
    ];
    expect(rows.map(([f]) => renderFileVersion(f, 'quote'))).toEqual(rows.map((r) => r[1]));
    // One reader per name, asked for every file of a listing: the same answers.
    const ofQuote = renderFileVersionOf('quote');
    expect(rows.map(([f]) => ofQuote(f))).toEqual(rows.map((r) => r[1]));
    expect(rows.map(([f]) => ofQuote(f))).toEqual(rows.map((r) => r[1]));
    // The name is read as it is written.
    expect([
      renderFileVersion('aXb-v1.json', 'a.b'),
      renderFileVersion('a.b-v1.json', 'a.b'),
      renderFileVersion('quote-v2-v9.json', 'quote-v2'),
      renderFileVersion('a(-v1.mp4', 'a('),
      renderFileVersion('zz-v1.mp4', '.*'),
    ]).toEqual([null, 1, 9, 1, null]);
  });

  it('the version of a file agrees with the pattern it replaced, on generated names', () => {
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = (file: string, name: string) => {
      const m = new RegExp(`^\\.?${escapeRe(name)}-v(\\d+)(?:-vertical|-square)?\\.(?:mp4|json|lock)$`).exec(file);
      return m ? Number(m[1]) : null;
    };
    const rnd = seededRandom('files');
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    let counted = 0;
    for (let i = 0; i < 60_000; i++) {
      const name = pick(['quote', 'Quote', 'a.b', 'quote-v2', 'q']);
      const file = `${pick(['', '.', '..', 'x'])}${pick(['quote', 'Quote', 'a.b', 'aXb', 'quote-v2', 'q'])}${pick(['-v', '-V', '-', '-v-'])}${pick(['1', '007', '12', '', '1000000', '9007199254740993', 'x'])}${pick(['', '-vertical', '-square', '-tall', '-vertical-square'])}${pick(['.mp4', '.json', '.lock', '.webm', '', '.mp4\n', '.json.tmp'])}`;
      const now = renderFileVersion(file, name);
      if (now !== null) counted++;
      if (now !== before(file, name)) throw new Error(`differs on ${JSON.stringify([file, name])}`);
    }
    expect(counted).toBeGreaterThan(150);
  });
});

describe('the ULID ids', () => {
  it('a new id of a kind: its prefix and a ULID of its time', () => {
    const t = Date.UTC(2026, 9, 17, 12, 0, 0);
    const kinds = Object.keys(ULID_PREFIXES) as UlidKind[];
    for (const kind of kinds) {
      const id = newUlidId(kind, t);
      const prefix = ULID_PREFIXES[kind];
      expect(id.startsWith(prefix), id).toBe(true);
      expect(id.slice(prefix.length)).toMatch(new RegExp(`^${ULID_BODY}$`));
      expect(ulidTime(id.slice(prefix.length))).toBe(t);
    }
    expect(JOB_ID_RE.test(newUlidId('job'))).toBe(true);
    expect(RECORD_ID_RE.test(newUlidId('record'))).toBe(true);
    expect(COMMENT_ID_RE.test(newCommentId(t))).toBe(true);
    expect(COMMENT_ENTRY_ID_RE.test(newCommentEntryId(t))).toBe(true);
    const ids = Array.from({ length: 50 }, () => newUlidId('job', t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('the time of a ULID is read from its first ten characters', () => {
    for (const t of [1, 1_000, Date.UTC(2026, 9, 17), 32 ** 10 - 1]) expect(ulidTime(ulid(t)), String(t)).toBeGreaterThanOrEqual(t);
    expect(ulidTime(formatUlid(1_760_000_000_000, new Array<number>(16).fill(0)))).toBe(1_760_000_000_000);
    expect(formatUlid(0, new Array<number>(16).fill(31))).toBe(`${a(10, '0')}${a(16, 'Z')}`);
    expect(ulidTime(a(26, '0'))).toBe(0);
    expect([ulidTime(BODY), ulidTime(BODY.slice(0, 10))]).toEqual([BODY_TIME, BODY_TIME]);
    expect(ulidTime(a(10, 'Z'))).toBe(32 ** 10 - 1);
    for (const bad of ['', BODY.slice(0, 9), `U${BODY.slice(1)}`, `${BODY.slice(0, 9)}I`, BODY.toLowerCase(), `${BODY.slice(0, 5)}/${BODY.slice(6)}`]) expect(ulidTime(bad), bad).toBeNaN();
    // Past the first ten characters nothing is read.
    expect(ulidTime(`${BODY.slice(0, 10)}uuuu`)).toBe(BODY_TIME);
  });

  it('a job id: j_ and a ULID, a string', () => {
    const rows: Array<[unknown, boolean]> = [
      [`j_${BODY}`, true],
      [`j_${BODY.slice(0, 25)}`, false],
      [`j_${BODY}0`, false],
      [`j_${BODY.toLowerCase()}`, false],
      [`j_U${BODY.slice(1)}`, false],
      [`p_${BODY}`, false],
      [`j_${BODY}\n`, false],
      [`../j_${BODY}`, false],
      [BODY, false],
      ['', false],
      [7, false],
      [null, false],
    ];
    expect(rows.map(([v]) => isJobId(v))).toEqual(rows.map((r) => r[1]));
    expect(rows.map(([v]) => parseJobId(v))).toEqual(rows.map(([v, ok]) => (ok ? v : null)));
  });

  it('the file name of an id: its prefix, a ULID, the extension', () => {
    const re = ulidFileRe('comment', 'json');
    expect(re.source).toBe('^c_[0-9A-HJKMNP-TV-Z]{26}\\.json$');
    expect([`c_${BODY}.json`, `c_${BODY}xjson`, `c_${BODY}.json.tmp`, `r_${BODY}.json`, `c_${BODY.slice(1)}.json`, `.c_${BODY}.json`].map((f) => re.test(f))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(ulidFileRe('marker', 'json').test(`k_${BODY}.json`)).toBe(true);
    expect(ulidFileRe('marker', 'json').source).toBe('^k_[0-9A-HJKMNP-TV-Z]{26}\\.json$');
  });
});

describe('a theme name', () => {
  const NAMES: unknown[] = [
    'editorial',
    'my-theme',
    'a',
    '0',
    a(60),
    a(61),
    a(100),
    'My_Theme',
    'x_',
    a(60, 'A'),
    a(100, 'A'),
    a(101),
    a(101, 'A'),
    'a.b',
    '',
    '-x',
    '_x',
    'my theme',
    'x\n',
    'a/b',
    '..',
    7,
    null,
  ];

  it('a listed theme: the any-case grammar, at most 100 characters', () => {
    expect(NAMES.filter(isThemeName)).toEqual(['editorial', 'my-theme', 'a', '0', a(60), a(61), a(100), 'My_Theme', 'x_', a(60, 'A'), a(100, 'A')]);
    expect(ANY_THEME_NAME_RE.test(a(101))).toBe(true);
  });

  it('a new theme: the lower-case grammar, at most 60 characters', () => {
    expect(NAMES.filter(isNewThemeName)).toEqual(['editorial', 'my-theme', 'a', '0', a(60)]);
    expect(NEW_THEME_NAME_RE.test(a(61))).toBe(true);
  });
});

describe('a theme that exists is named by one rule', () => {
  it('a listed theme and the folder of a theme named by a path alike: no other cap, no other grammar', () => {
    const rows: Array<[unknown, boolean]> = [
      ['editorial', true],
      ['My_Theme', true],
      [a(100), true],
      [a(100, 'T'), true],
      [a(101), false],
      [a(255, 'T'), false],
      ['a.b', false],
      ['', false],
      ['-x', false],
      ['../x', false],
      ['x/y', false],
      ['x\n', false],
      [7, false],
      [undefined, false],
      [['a'], false],
    ];
    expect(rows.map(([v]) => isThemeName(v))).toEqual(rows.map((r) => r[1]));
    // A new theme's name is a theme's name; the module holds these two rules for a theme and their two caps.
    for (const v of [a(60), 'my-theme']) expect([isNewThemeName(v), isThemeName(v)], v).toEqual([true, true]);
    expect([NEW_THEME_NAME_MAX, ANY_THEME_NAME_MAX]).toEqual([60, 100]);
    expect(
      Object.keys(grammar)
        .filter((k) => /theme/i.test(k))
        .sort(),
    ).toEqual(['ANY_THEME_NAME_MAX', 'ANY_THEME_NAME_RE', 'NEW_THEME_NAME_MAX', 'NEW_THEME_NAME_RE', 'isNewThemeName', 'isThemeName']);
  });
});

describe('the zod helpers', () => {
  const first = (s: z.ZodType, v: unknown) => {
    const r = s.safeParse(v);
    return r.success ? 'ok' : `${r.error.issues[0].code}: ${r.error.issues[0].message}`;
  };

  it('each is a plain string schema: its cap first, then its grammar with the sentence given', () => {
    const big = (n: number) => `too_big: Too big: expected string to have <=${n} characters`;
    expect([a(200), a(201), '../x', `${a(201)}/`, 7].map((v) => first(zRunId('a run'), v))).toEqual([
      'ok',
      big(200),
      'invalid_format: a run',
      big(200),
      'invalid_type: Invalid input: expected string, received number',
    ]);
    expect([`${a(197)}-v1`, `${a(198)}-v1`, 'final', 'quote-v999999', 'quote-v1000000'].map((v) => first(zRenderId('a render'), v))).toEqual([
      'ok',
      big(200),
      'invalid_format: a render',
      'ok',
      'custom: a render',
    ]);
    // The version's bound speaks only for a string of the cap and the pattern: one issue each, never two.
    const issues = (v: unknown) => {
      const r = zRenderId('a render').safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => i.code);
    };
    expect([`${a(198)}-v1000000`, 'final', 'quote-v1000000', `${a(201)}/`, 7].map(issues)).toEqual([['too_big'], ['invalid_format'], ['custom'], ['too_big', 'invalid_format'], ['invalid_type']]);
    expect([a(100, 'A'), a(101), 'a.b'].map((v) => first(zThemeName('a theme'), v))).toEqual(['ok', big(100), 'invalid_format: a theme']);
    expect([a(60), a(61), 'My_Theme'].map((v) => first(zNewThemeName('a new theme'), v))).toEqual(['ok', big(60), 'invalid_format: a new theme']);
    // A site that asks for a non-empty name says the length first on an empty string; nothing else differs.
    const all = (s: z.ZodType, v: unknown) => {
      const r = s.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => i.code);
    };
    expect(['', 'a', a(101), 'a.b'].map((v) => all(zThemeName('a theme', { nonEmpty: true }), v))).toEqual([['too_small', 'invalid_format'], [], ['too_big'], ['invalid_format']]);
    expect(['', 'a', a(101), 'a.b'].map((v) => all(zThemeName('a theme'), v))).toEqual([['invalid_format'], [], ['too_big'], ['invalid_format']]);
    for (const s of [zRunId('x'), zRenderId('x'), zThemeName('x'), zNewThemeName('x')]) expect(s).toBeInstanceOf(z.ZodString);
    expect(zRunId('x').optional().safeParse(undefined).success).toBe(true);
    expect(z.union([zRenderId('x'), z.literal('latest')]).safeParse('latest').success).toBe(true);
  });

  it('each refuses what its predicate refuses and takes what it takes', () => {
    const rnd = seededRandom('schemas');
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const strings: string[] = [
      '',
      'final',
      'quote-v1',
      'quote-v999999',
      'quote-v1000000',
      'quote-v0999999',
      'quote-v00000001000000',
      `${a(197)}-v1`,
      `${a(198)}-v1`,
      a(60),
      a(61),
      a(100),
      a(101),
      a(200),
      a(201),
      'My_Theme',
      'a.b',
      '../x',
      'x\n',
    ];
    for (let i = 0; i < 4000; i++)
      strings.push(
        `${pick(['', 'quote', 'Quote_2', 'a.b', '-x', a(190), a(196), a(55), a(96)])}${pick(['', '-v', '-V', '.'])}${pick(['', '1', '007', '999999', '1000000', '0999999', '9007199254740993', 'x'])}${pick(['', '-vertical', '-square', '-tall', '\n'])}`,
      );
    const pairs: Array<[string, z.ZodType, (v: unknown) => boolean]> = [
      ['run', zRunId('x'), isRunId],
      ['render', zRenderId('x'), isRenderId],
      ['theme', zThemeName('x'), isThemeName],
      ['new theme', zNewThemeName('x'), isNewThemeName],
    ];
    for (const [name, schema, is] of pairs) {
      expect(
        strings.filter((v) => schema.safeParse(v).success !== is(v)),
        name,
      ).toEqual([]);
      expect(strings.filter((v) => is(v)).length, name).toBeGreaterThan(20);
      for (const v of [7, null, undefined, ['quote-v1'], {}]) expect([schema.safeParse(v).success, is(v)], name).toEqual([false, false]);
    }
  });

  it('each prints as a type, a maxLength and its pattern', () => {
    const printed = (s: z.ZodType) => {
      const { type, maxLength, pattern } = z.toJSONSchema(s, { io: 'input' }) as { type?: string; maxLength?: number; pattern?: string };
      return [type, maxLength, pattern];
    };
    expect(printed(zRunId('x'))).toEqual(['string', 200, RUN_ID_RE.source]);
    expect(printed(zRenderId('x'))).toEqual(['string', 200, RENDER_ID_RE.source]);
    expect(printed(zThemeName('x'))).toEqual(['string', 100, ANY_THEME_NAME_RE.source]);
    expect(printed(zNewThemeName('x'))).toEqual(['string', 60, NEW_THEME_NAME_RE.source]);
    expect(Object.keys(z.toJSONSchema(zRunId('x'), { io: 'input' })).filter((k) => k !== '$schema')).toEqual(['type', 'maxLength', 'pattern']);
  });
});

describe('the branded types', () => {
  it('a brand comes from a parse; a generator and a formatter return a string', () => {
    expectTypeOf<string>().not.toMatchTypeOf<RunId>();
    expectTypeOf<RunId>().toMatchTypeOf<string>();
    expectTypeOf<RunId>().not.toMatchTypeOf<RenderId>();
    expectTypeOf<JobId>().not.toMatchTypeOf<RunId>();
    expectTypeOf<NewThemeName>().toMatchTypeOf<ThemeName>();
    expectTypeOf<ThemeName>().not.toMatchTypeOf<NewThemeName>();
    expectTypeOf(parseRunId).returns.toEqualTypeOf<RunId | null>();
    expectTypeOf(parseJobId).returns.toEqualTypeOf<JobId | null>();
    expectTypeOf(parseRenderId('quote-v1')?.id).toEqualTypeOf<RenderId | undefined>();
    expectTypeOf(renderIdOf('quote-v1', 'quote')?.id).toEqualTypeOf<RenderId | undefined>();
    expectTypeOf(newRunId).returns.toEqualTypeOf<string>();
    expectTypeOf(formatRunId).returns.toEqualTypeOf<string>();
    expectTypeOf(formatRenderId).returns.toEqualTypeOf<string>();
    expectTypeOf(newUlidId).returns.toEqualTypeOf<string>();
    expectTypeOf(zRunId('x').parse('quote')).toEqualTypeOf<string>();
    const v: unknown = 'quote';
    if (isRunId(v)) expectTypeOf(v).toEqualTypeOf<RunId>();
    if (isThemeName(v)) expectTypeOf(v).toEqualTypeOf<ThemeName>();
    if (isNewThemeName(v)) expectTypeOf(v).toMatchTypeOf<ThemeName>();
    const s: string = 'quote';
    if (isMadeRunId(s)) expectTypeOf(s).toEqualTypeOf<RunId>();
    expect(isRunId(v)).toBe(true);
  });
});
