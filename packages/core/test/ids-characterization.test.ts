/**
 * The ids of the domain as core accepts, refuses, builds and matches them (L7.5): run ids (a folder name of runs/),
 * render ids (`<scenario>-v<N>[-vertical|-square]`), the ULID ids (job, preview, inspection, site, recording, comment
 * thread and entry) and theme names (a theme that exists; a new theme). One table per grammar, string by string, then
 * the schemas that name one of them: their length cap and the first sentence each gives.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; the mark names the decision. A row marked `N-<x>`
 * is an outcome a fix made on the way changed, never a decision: stricter only.
 */
import { describe, expect, it } from 'vitest';
import {
  ANY_THEME_NAME_RE,
  BrandInputSchema,
  COMMENT_ENTRY_ID_RE,
  COMMENT_ID_RE,
  CommentEntrySchema,
  CommentRenderSchema,
  CommentThreadSchema,
  EnvResetJobInputSchema,
  ExportJobInputSchema,
  HooksJobInputSchema,
  INSPECT_ID_RE,
  JOB_ID_RE,
  NEW_THEME_NAME_MAX,
  NEW_THEME_NAME_RE,
  PREVIEW_ID_RE,
  PROJECT_SLUG_RE,
  PreviewJobInputSchema,
  RECORD_ID_RE,
  RENDER_ID_RE,
  RUN_ID_RE,
  RenderJobInputSchema,
  ReviewJobInputSchema,
  RunJobInputSchema,
  SITE_ID_RE,
  SLUG_RE,
  fieldValueProblem,
  isRenderId,
  newCommentEntryId,
  newCommentId,
  newRunId,
  renderIdSchema,
  runIdOfScenario,
  templateNameSchema,
  ulid,
} from '../src/index.js';

const STAMP = '20261017-142233-';
const a = (n: number, ch = 'a') => ch.repeat(n);
/** The strings accepted, of a list: what a table pins (the others are refused). */
const accepted = (list: readonly string[], ok: (s: string) => boolean) => list.filter(ok);

// ── Run ids ──────────────────────────────────────────────────────────────────

const RUN_STRINGS = [
  `${STAMP}quote`,
  `${STAMP}Quote`,
  `${STAMP}quote.bak`,
  `${STAMP}quote_2`,
  STAMP,
  `${STAMP}a--b`,
  `${STAMP}quote-`,
  '2026101-142233-quote', // seven digits
  'my-take-quote',
  'zz-quote',
  'quote',
  'a..b',
  a(200),
  a(201),
  `${STAMP}${a(184)}`, // 200 characters
  `${STAMP}${a(185)}`, // 201 characters
  // refused by the grammar:
  '.tmp-quote',
  '-quote',
  'a/b',
  'a\\b',
  '..',
  '.',
  '',
  ' quote',
  `${STAMP}quote\n`,
  `${STAMP}qu\u0000ote`,
  `\uff120261017-142233-quote`, // a full-width digit
  `${STAMP}qu\u00e9te`,
];
const RUN_REFUSED_FROM = RUN_STRINGS.indexOf('.tmp-quote');

describe('a run id: a folder name of runs/', () => {
  it('the grammar is one path segment of letters, digits, ".", "_" and "-" that starts with a letter or digit', () => {
    expect(RUN_ID_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9._-]*$');
    expect(RUN_ID_RE.flags).toBe('');
    expect(accepted(RUN_STRINGS, (s) => RUN_ID_RE.test(s))).toEqual(RUN_STRINGS.slice(0, RUN_REFUSED_FROM));
  });

  it('the grammar alone holds no length: a schema caps a run id at 200 characters', () => {
    expect(RUN_ID_RE.test(a(201))).toBe(true);
    const sites = {
      'run job run_id': RunJobInputSchema.shape.run_id,
      'render job run_id': RenderJobInputSchema.shape.run_id,
      'hooks job journal_id': HooksJobInputSchema.shape.journal_id,
      'env reset job journal_id': EnvResetJobInputSchema.shape.journal_id,
      'thread render run_id': CommentRenderSchema.shape.run_id,
    };
    const first = (s: (typeof sites)[keyof typeof sites], v: string) => {
      const r = s.safeParse(v);
      return r.success ? 'ok' : `${r.error.issues[0].code}: ${r.error.issues[0].message}`;
    };
    const out: Record<string, string[]> = {};
    for (const [name, s] of Object.entries(sites)) out[name] = [a(200), a(201), '', '../x', `${a(201)}/`].map((v) => first(s, v));
    const row = (message: string) => ['ok', 'too_big: Too big: expected string to have <=200 characters', `invalid_format: ${message}`, `invalid_format: ${message}`, 'too_big: Too big: expected string to have <=200 characters'];
    expect(out).toEqual({
      'run job run_id': row('a run folder name, never a path'),
      'render job run_id': row('a run folder name, never a path'),
      'hooks job journal_id': row('a journal id, never a path'),
      'env reset job journal_id': row('a journal id, never a path'),
      'thread render run_id': row('a run folder name'),
    });
  });
});

describe('a run id made for a scenario', () => {
  const at = new Date(2026, 9, 17, 14, 22, 33);

  it('is <yyyymmdd>-<hhmmss>-<the scenario name in lower case, other characters as dashes>, in local time', () => {
    expect(
      ['quote', 'My Scenario!', 'Mobile_Quote', '___', '\u00c9', '', '-a-', 'a--b'].map((s) => newRunId(s, at)),
    ).toEqual([
      '20261017-142233-quote',
      '20261017-142233-my-scenario',
      '20261017-142233-mobile-quote',
      '20261017-142233-run',
      '20261017-142233-run',
      '20261017-142233-run',
      '20261017-142233-a',
      '20261017-142233-a-b',
    ]);
    expect(newRunId('quote', new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405-quote');
  });

  it('holds no length cap of its own: a scenario name of 184 characters gives 200, one of 185 gives 201', () => {
    expect(newRunId(a(184), at)).toHaveLength(200);
    expect(newRunId(a(185), at)).toHaveLength(201);
    expect(RunJobInputSchema.shape.run_id.safeParse(newRunId(a(184), at)).success).toBe(true);
    expect(RunJobInputSchema.shape.run_id.safeParse(newRunId(a(185), at)).success).toBe(false);
  });
});

describe('whether a run id is a run of a scenario', () => {
  const IDS = [
    `${STAMP}quote`,
    `${STAMP}Quote`,
    `${STAMP}mobile-quote`,
    `${STAMP}quote.bak`,
    `${STAMP}quote-`,
    `${STAMP}142233-`,
    '2026101-142233-quote',
    'my-take-quote',
    'zz-quote',
    'quote',
    '.tmp-quote',
    '-quote',
    '',
  ];
  const of = (scenario: string) => accepted(IDS, (id) => runIdOfScenario(id, scenario));

  it('a stamped id: its part after the stamp equals the scenario name, lower-cased; any other id: it ends in -<scenario>', () => {
    expect(of('quote')).toEqual([`${STAMP}quote`, '2026101-142233-quote', 'my-take-quote', 'zz-quote', '.tmp-quote', '-quote']);
    // The stamped part is compared with the lower-cased name: a run of "quote" is also a run of "Quote".
    expect(of('Quote')).toEqual([`${STAMP}quote`]);
    expect(of('mobile-quote')).toEqual([`${STAMP}mobile-quote`]);
    expect(of('Mobile_Quote')).toEqual([`${STAMP}mobile-quote`]);
    expect(of('142233-')).toEqual([]);
    expect(of('')).toEqual([]);
  });

  // L7.5 D-7: a stamped id is never answered by the "ends in -<scenario>" rule.
  const D7 = false;
  it('a stamped id whose part after the stamp is empty or holds a line break is a run of no scenario', () => {
    const rows: Array<[string, string, boolean]> = [
      [STAMP, '142233-', D7], // D-7
      [STAMP, '', D7], // D-7
      [`${STAMP}a\n-quote`, 'quote', D7], // D-7
      [`${STAMP}a\r-quote`, 'quote', D7], // D-7
      [`${STAMP}a\u2028-quote`, 'quote', D7], // D-7
      [`${STAMP}a\u2029-quote`, 'quote', D7], // D-7
      [`${STAMP}\n`, '', false],
      [STAMP, 'quote', false],
      [`${STAMP}a\n-quote`, 'a', false],
      [`${STAMP}quote\n`, 'quote', false],
    ];
    expect(rows.map(([id, scenario]) => runIdOfScenario(id, scenario))).toEqual(rows.map((r) => r[2]));
  });
});

// ── Render ids ───────────────────────────────────────────────────────────────

const RENDER_STRINGS = [
  'quote-v3',
  'quote-v3-vertical',
  'quote-v3-square',
  'quote-v0',
  'quote-v007',
  'quote-v2-v1',
  'Quote_2-v1',
  'q-v1-v2-vertical',
  'quote-v-v1',
  'quote_-v1',
  'v-v1',
  'quote-v999999',
  'quote-v1000000',
  'quote-v9007199254740992', // 2^53
  'quote-v99999999999999999999',
  `${a(197)}-v1`, // 200 characters
  `${a(198)}-v1`, // 201 characters
  // refused by the grammar:
  'quote',
  'final',
  'quote-v',
  'quote-v1-tall',
  'quote-v3-square-vertical',
  'quote-v1-vertical-square',
  'quote-V1',
  'quote-v1-Vertical',
  'my render-v1',
  'a.b-v1',
  '-v1',
  '_a-v1',
  'quote-v1.json',
  'quote-v1\n',
  'quote-v\uff11', // a full-width digit
  'quote-v1.5',
  'quote-v-1',
  'a/b-v1',
  '',
];
const RENDER_REFUSED_FROM = RENDER_STRINGS.indexOf('quote');

describe('a render id: <scenario>-v<N>[-vertical|-square]', () => {
  it('the grammar is a scenario name, "-v", digits, and at most one variant suffix', () => {
    expect(RENDER_ID_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9_-]*-v\\d+(?:-vertical|-square)?$');
    expect(RENDER_ID_RE.flags).toBe('');
    expect(accepted(RENDER_STRINGS, (s) => RENDER_ID_RE.test(s))).toEqual(RENDER_STRINGS.slice(0, RENDER_REFUSED_FROM));
  });

  it('a schema caps a render id at 200 characters and its version at 999999, as the predicate does', () => {
    const sites = {
      renderIdSchema,
      'render job render_id': RenderJobInputSchema.shape.render_id,
      'review job render_id': ReviewJobInputSchema.shape.render_id,
      'export job render_id': ExportJobInputSchema.shape.render_id,
      'thread render id': CommentRenderSchema.shape.id,
      'entry render_id': CommentEntrySchema.shape.render_id,
    };
    const first = (s: (typeof sites)[keyof typeof sites], v: string) => {
      const r = s.safeParse(v);
      return r.success ? 'ok' : `${r.error.issues[0].code}: ${r.error.issues[0].message}`;
    };
    const values = [`${a(197)}-v1`, `${a(198)}-v1`, '', 'final', 'quote-v1000000', 'quote-v99999999999999999999', `${a(201)}`];
    const out: Record<string, string[]> = {};
    for (const [name, s] of Object.entries(sites)) out[name] = values.map((v) => first(s, v));
    const big = 'too_big: Too big: expected string to have <=200 characters';
    // L7.5 D-6: a version above 999999 is no render id for a schema either (the sentence of the site, as a custom issue).
    const row = (message: string) => ['ok', big, `invalid_format: ${message}`, `invalid_format: ${message}`, `custom: ${message}`, `custom: ${message}`, big]; // D-6
    expect(out).toEqual({
      renderIdSchema: row('a render id such as quote-v3 (renders/<id>.json), never a path'),
      'render job render_id': row('a render id such as quote-v3 (renders/<id>.json), never a path'),
      'review job render_id': row('a render id such as quote-v3 (renders/<id>.json), never a path'),
      'export job render_id': row('a render id such as quote-v3 (renders/<id>.json), never a path'),
      'thread render id': row('a render id (<scenario>-v<N>[-vertical|-square])'),
      'entry render_id': row('a render id'),
    });
    // A schema and the predicate give one answer, string by string.
    for (const [name, site] of Object.entries(sites)) expect(RENDER_STRINGS.filter((v) => site.safeParse(v).success), name).toEqual(RENDER_STRINGS.filter((v) => isRenderId(v)));
    expect(ReviewJobInputSchema.shape.previous.safeParse(false).success).toBe(true);
    expect(ReviewJobInputSchema.shape.previous.safeParse(`${a(198)}-v1`).success).toBe(false);
    expect(ReviewJobInputSchema.shape.previous.safeParse('quote-v2').success).toBe(true);
  });

  const thread = (scenario: string, renderId: string) => ({
    version: 1,
    id: 'c_01K8AB1CDE2FGH3JKM4NPQ5RST',
    scenario,
    render: { id: renderId, created_at: '2026-10-20T09:30:00.000Z', run_id: '20261020-090000-quote', variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 },
    frame: 10,
    time_s: 0.33,
    text: 'The caption is too long here',
    author: { via: 'cli', name: 'Reviewer' },
    created_at: '2026-10-20T10:00:00.000Z',
    anchor: { segment: 'intro', kind: 'intro' },
    entries: [],
  });
  const threadIssues = (scenario: string, renderId: string) => {
    try {
      const r = CommentThreadSchema.safeParse(thread(scenario, renderId));
      return r.success ? 'ok' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
    } catch (e) {
      return `throws ${(e as Error).name}`;
    }
  };

  it('a comment thread names a render of its own scenario, exactly', () => {
    // L7.5 D-6: a version above 999999 is no render id (the field's own sentence), so no render of the scenario.
    const D6 = (id: string) => `render.id: a render id (<scenario>-v<N>[-vertical|-square]) | render.id: render ${id} is not a render of scenario quote`;
    const rows: Array<[string, string, string]> = [
      ['quote', 'quote-v3', 'ok'],
      ['quote', 'quote-v3-vertical', 'ok'],
      ['quote', 'quote-v3-square', 'ok'],
      ['quote', 'quote-v007', 'ok'],
      ['quote', 'quote-v0', 'ok'],
      ['quote', 'quote-v999999', 'ok'],
      ['quote', 'quote-v1000000', D6('quote-v1000000')], // D-6
      ['quote', 'quote-v9007199254740992', D6('quote-v9007199254740992')], // D-6
      ['quote', 'quote-v99999999999999999999', D6('quote-v99999999999999999999')], // D-6
      ['quote-v2', 'quote-v2-v1', 'ok'],
      ['Quote_2', 'Quote_2-v1', 'ok'],
      ['quote', 'quote-v2-v1', 'render.id: render quote-v2-v1 is not a render of scenario quote'],
      ['quote', 'Quote-v1', 'render.id: render Quote-v1 is not a render of scenario quote'],
      ['quote', 'mobile-quote-v1', 'render.id: render mobile-quote-v1 is not a render of scenario quote'],
      ['mobile-quote', 'quote-v1', 'render.id: render quote-v1 is not a render of scenario mobile-quote'],
      ['q', 'q-v1-v2-vertical', 'render.id: render q-v1-v2-vertical is not a render of scenario q'],
      ['q-v1', 'q-v1-v2-vertical', 'ok'],
    ];
    expect(rows.map(([s, id]) => threadIssues(s, id))).toEqual(rows.map((r) => r[2]));
  });

  it('a thread whose render id or scenario is not of its grammar is refused', () => {
    const big = 'render.id: Too big: expected string to have <=200 characters';
    const notId = 'render.id: a render id (<scenario>-v<N>[-vertical|-square])';
    const notName = 'scenario: a scenario name';
    const notOf = (id: string, scenario: string) => `render.id: render ${id} is not a render of scenario ${scenario}`;
    // L7.5 N-c (rows of part A): the scenario is compared as text; a render id past its cap is a render of no scenario.
    const rows: Array<[string, string, string]> = [
      ['quote', 'final', `${notId} | ${notOf('final', 'quote')}`],
      ['a.b', 'a.b-v1', `${notName} | ${notId} | ${notOf('a.b-v1', 'a.b')}`], // N-c
      ['quote', `${a(194)}-v1`, notOf(`${a(194)}-v1`, 'quote')],
      [a(198), `${a(198)}-v1`, `scenario: Too big: expected string to have <=100 characters | ${big} | ${notOf(`${a(198)}-v1`, a(198))}`], // N-c
      ['a.b', 'aXb-v1', `${notName} | ${notOf('aXb-v1', 'a.b')}`], // N-c
      ['.*', 'zz-v1', `${notName} | ${notOf('zz-v1', '.*')}`], // N-c
      ['quote|x', 'x-v1', `${notName} | ${notOf('x-v1', 'quote|x')}`], // N-c
      ['a(', 'x-v1', `${notName} | ${notOf('x-v1', 'a(')}`], // N-c
      ['(?:a|b', 'x-v1', `${notName} | ${notOf('x-v1', '(?:a|b')}`], // N-c
    ];
    expect(rows.map(([s, id]) => threadIssues(s, id))).toEqual(rows.map((r) => r[2]));
  });
});

// ── ULID ids ─────────────────────────────────────────────────────────────────

describe('the ULID ids: a prefix and 26 Crockford base32 characters', () => {
  const BODY = '01K8AB1CDE2FGH3JKM4NPQ5RST';
  const KINDS: Array<[string, RegExp]> = [
    ['j_', JOB_ID_RE],
    ['p_', PREVIEW_ID_RE],
    ['i_', INSPECT_ID_RE],
    ['s_', SITE_ID_RE],
    ['rec_', RECORD_ID_RE],
    ['c_', COMMENT_ID_RE],
    ['r_', COMMENT_ENTRY_ID_RE],
  ];

  it('each grammar is its prefix and the one body', () => {
    expect(KINDS.map(([, re]) => re.source)).toEqual(KINDS.map(([p]) => `^${p}[0-9A-HJKMNP-TV-Z]{26}$`));
    for (const [, re] of KINDS) expect(re.flags).toBe('');
  });

  it('26 characters exactly, upper case, never I, L, O or U, never another prefix', () => {
    const bodies: Array<[string, boolean]> = [
      [BODY, true],
      ['0'.repeat(26), true],
      ['Z'.repeat(26), true],
      [BODY.slice(0, 25), false],
      [`${BODY}0`, false],
      [BODY.toLowerCase(), false],
      [`I${BODY.slice(1)}`, false],
      [`L${BODY.slice(1)}`, false],
      [`O${BODY.slice(1)}`, false],
      [`U${BODY.slice(1)}`, false],
      [`${BODY.slice(0, 25)}\n`, false],
      [`${BODY}\n`, false],
      [`${BODY.slice(0, 13)}/${BODY.slice(14)}`, false],
      ['', false],
    ];
    for (const [prefix, re] of KINDS) {
      expect(bodies.map(([b]) => re.test(`${prefix}${b}`)), prefix).toEqual(bodies.map((b) => b[1]));
      for (const [other] of KINDS) expect(re.test(`${other}${BODY}`), `${prefix} takes ${other}`).toBe(other === prefix);
      expect(re.test(BODY)).toBe(false);
      expect(re.test(` ${prefix}${BODY}`)).toBe(false);
      expect(re.test(`${prefix.toUpperCase()}${BODY}`)).toBe(false);
    }
  });

  it('a new id: its time first, then 80 random bits; ids of one millisecond keep their order', () => {
    const t = Date.UTC(2026, 9, 17, 12, 0, 0);
    const one = ulid(t);
    expect(one).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const many = Array.from({ length: 200 }, () => ulid(t));
    expect([...many].sort()).toEqual(many);
    expect(new Set(many).size).toBe(200);
    expect(many[0] > one).toBe(true);
    // The first ten characters are the time, most significant first.
    const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = (id: string) => [...id.slice(0, 10)].reduce((n, ch) => n * 32 + C.indexOf(ch), 0);
    expect(time(one)).toBe(t);
    const later = ulid(t + 5000);
    expect(time(later)).toBe(t + 5000);
    // A clock that went back: the id still sorts after the last one.
    expect(ulid(t - 60_000) > later).toBe(true);
    expect(COMMENT_ID_RE.test(newCommentId(t))).toBe(true);
    expect(COMMENT_ENTRY_ID_RE.test(newCommentEntryId(t))).toBe(true);
    expect(newCommentId()).toMatch(/^c_/);
    expect(newCommentEntryId()).toMatch(/^r_/);
  });

  it('the schemas that name one give their own sentence and hold no length cap of their own', () => {
    const sentence = (s: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }, v: string) => {
      const r = s.safeParse(v);
      return r.success ? 'ok' : (r.error?.issues[0].message ?? '');
    };
    expect(sentence(PreviewJobInputSchema.shape.preview_id, `p_${BODY}`)).toBe('ok');
    expect(sentence(PreviewJobInputSchema.shape.preview_id, `j_${BODY}`)).toBe('a preview id (p_ followed by 26 characters), never a path');
    expect(sentence(CommentThreadSchema.shape.id, `c_${BODY}`)).toBe('ok');
    expect(sentence(CommentThreadSchema.shape.id, `c_${BODY}0`)).toBe('a thread id (c_ + a ULID)');
    expect(sentence(CommentEntrySchema.shape.id, `r_${BODY}`)).toBe('ok');
    expect(sentence(CommentEntrySchema.shape.id, 'r_')).toBe('an entry id (r_ + a ULID)');
    expect(sentence(CommentEntrySchema.shape.applies, `c_${BODY}`)).toBe('an entry id (r_ + a ULID)');
  });
});

// ── Theme names ──────────────────────────────────────────────────────────────

const THEME_STRINGS = ['editorial', 'my-theme', 'a', '0', a(60), a(61), a(64), a(65), a(100), a(101), 'My_Theme', 'x_', a(60, 'A'), a(100, 'A'), a(101, 'A'), 'a.b', '', '-x', '_x', 'my theme', 'x\n', 'a/b', '..', 't\u00e9'];
const THEME_UPPER_FROM = THEME_STRINGS.indexOf('My_Theme');
const THEME_REFUSED_FROM = THEME_STRINGS.indexOf('a.b');

describe('a theme name', () => {
  it('any listed theme: letters, digits, "_" and "-" (a scenario name\'s grammar); a new theme: lower-case letters, digits and "-" (a project slug\'s)', () => {
    expect(ANY_THEME_NAME_RE).toBe(SLUG_RE);
    expect(NEW_THEME_NAME_RE.source).toBe(PROJECT_SLUG_RE.source);
    expect(ANY_THEME_NAME_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9_-]*$');
    expect(NEW_THEME_NAME_RE.source).toBe('^[a-z0-9][a-z0-9-]*$');
    expect(NEW_THEME_NAME_MAX).toBe(60);
    expect(accepted(THEME_STRINGS, (s) => ANY_THEME_NAME_RE.test(s))).toEqual(THEME_STRINGS.slice(0, THEME_REFUSED_FROM));
    expect(accepted(THEME_STRINGS, (s) => NEW_THEME_NAME_RE.test(s))).toEqual(THEME_STRINGS.slice(0, THEME_UPPER_FROM));
  });

  it('a schema caps a listed theme at 100 characters and a new theme at 60', () => {
    const first = (s: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ code: string; message: string }> } } }, v: string) => {
      const r = s.safeParse(v);
      const i = r.error?.issues[0];
      return r.success ? 'ok' : `${i?.code}: ${i?.message}`;
    };
    const any = [a(100), a(101), a(100, 'A'), '', 'a.b', '../x'];
    const big = (n: number) => `too_big: Too big: expected string to have <=${n} characters`;
    const anyRow = (message: string) => ['ok', big(100), 'ok', `invalid_format: ${message}`, `invalid_format: ${message}`, `invalid_format: ${message}`];
    expect(any.map((v) => first(templateNameSchema, v))).toEqual(anyRow('a theme (template) name, never a path'));
    expect(any.map((v) => first(RenderJobInputSchema.shape.template, v))).toEqual(anyRow('a theme (template) name, never a path'));
    expect(any.map((v) => first(PreviewJobInputSchema.shape.template, v))).toEqual(anyRow('a theme (template) name, never a path'));
    expect(any.map((v) => first(BrandInputSchema.shape.base, v))).toEqual(anyRow('a theme name'));
    const fresh = [a(60), a(61), a(100), 'My_Theme', '', 'a.b'];
    const sentence = 'invalid_format: a new theme name: lower-case letters, digits and "-" (e.g. acme), never a path';
    expect(fresh.map((v) => first(BrandInputSchema.shape.name, v))).toEqual(['ok', big(60), big(60), sentence, sentence, sentence]);
  });

  it('a scenario\'s theme field takes a listed theme name of at most 100 characters', () => {
    const problem = (to: unknown) => fieldValueProblem('template', to);
    const sentence = 'template takes a theme name (the themes list names them), never a path';
    expect([a(100), a(100, 'A'), 'My_Theme', a(101), 'a.b', '', '../x'].map(problem)).toEqual([null, null, null, sentence, sentence, sentence, sentence]);
  });
});
