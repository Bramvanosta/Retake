/**
 * L3.2 render job inputs (core jobs.ts): the render id is built from SLUG_RE (a scenario name may hold upper-case
 * letters and "_"), a theme is a name, the overrides are strict and bounded, a music file is a relative project file,
 * and `project` is required (as for every kind).
 */
import { describe, expect, it } from 'vitest';
import { EXPORT_FORMAT_NAMES, EditOverridesInputSchema, ExportJobInputSchema, JOB_INPUT_VERSION, JOB_KINDS, JobInputSchema, PREVIEW_ID_RE, PreviewJobInputSchema, RENDER_ID_RE, RenderJobInputSchema, ReviewJobInputSchema, SLUG_RE } from '../src/index.js';

const SHA = 'a'.repeat(64);
const input = (extra: Record<string, unknown> = {}) => ({
  version: JOB_INPUT_VERSION,
  kind: 'render',
  project: 'shop',
  scenario: 'Quote_Flow',
  run_id: '20261017-142233-Quote_Flow',
  timeline_sha256: SHA,
  render_id: 'Quote_Flow-v3',
  overrides: {},
  submitted_by: 'mcp',
  ...extra,
});

describe('render job input', () => {
  it('render is a job kind; a valid input parses through the union', () => {
    expect(JOB_KINDS).toContain('render');
    expect(JobInputSchema.parse(input()).kind).toBe('render');
  });

  it('the render id: <scenario>-v<N>[-vertical|-square], from SLUG_RE (upper-case and "_" allowed), never a path', () => {
    for (const id of ['quote-v1', 'Quote_Flow-v3', 'Q-v12-vertical', 'a-v2-square']) expect(RENDER_ID_RE.test(id), id).toBe(true);
    for (const id of ['quote', 'quote-v', '-v1', '../quote-v1', 'quote-v1.mp4', 'quote-v1-wide', 'a/b-v1', 'quote-v1 ']) expect(RENDER_ID_RE.test(id), id).toBe(false);
    // Every scenario name SLUG_RE accepts makes a valid id.
    for (const name of ['Quote', 'quote_2', 'A-b_C']) {
      expect(SLUG_RE.test(name)).toBe(true);
      expect(RENDER_ID_RE.test(`${name}-v1`)).toBe(true);
    }
    expect(RenderJobInputSchema.safeParse(input({ render_id: '../x-v1' })).success).toBe(false);
  });

  it('project is required; a theme is a name; no extra key', () => {
    const { project: _p, ...noProject } = input();
    expect(RenderJobInputSchema.safeParse(noProject).success).toBe(false);
    expect(RenderJobInputSchema.safeParse(input({ template: 'editorial' })).success).toBe(true);
    for (const template of ['./template', '../x', '/abs', 'a/b', '~']) expect(RenderJobInputSchema.safeParse(input({ template })).success, template).toBe(false);
    expect(RenderJobInputSchema.safeParse(input({ out: '/tmp/x.mp4' })).success).toBe(false);
    expect(RenderJobInputSchema.safeParse(input({ approvals: [] })).success).toBe(false);
  });

  it('overrides: strict, bounded; music is a relative project file or false; no theme (the input names it)', () => {
    const ok = EditOverridesInputSchema.safeParse({
      frame: 'laptop',
      variant: 'vertical',
      fps: 30,
      scale: 1,
      intro: false,
      speeds: { a: 1.5 },
      transition: 'cut',
      components: { layout: 'studio/layout-laptop', intro: { id: 'studio/intro-stack', params: { align: 'left' } } },
      music: 'assets/bed.mp3',
      tutorial: { spotlight: false },
    });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    for (const bad of [
      { theme: 'motion' },
      { out: 'x.mp4' },
      { scale: 3 },
      { fps: 120 },
      { speeds: { a: 10 } },
      { music: '/etc/passwd' },
      { music: '../../x.mp3' },
      { music: 'assets/../../x.mp3' },
      { music: '~/x.mp3' },
      { music: 'C:\\x.mp3' },
      { music: true },
      { frame: '../x' },
      { components: { layout: 'not an id' } },
      { components: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${i}`, 'studio/card-title'])) },
    ]) {
      expect(EditOverridesInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(EditOverridesInputSchema.safeParse({ music: false }).success).toBe(true);
  });
});

describe('review and export job inputs', () => {
  const review = { version: JOB_INPUT_VERSION, kind: 'review', project: 'demo', render_id: 'Quote_A-v3', fps: 1, submitted_by: 'mcp' } as const;
  const exp = { version: JOB_INPUT_VERSION, kind: 'export', project: 'demo', render_id: 'quote-v3-vertical', formats: ['mp4_1080p', 'gif_preview'], submitted_by: 'mcp' } as const;

  it('review and export are job kinds; valid inputs parse through the union', () => {
    expect(JOB_KINDS).toEqual(expect.arrayContaining(['review', 'export']));
    expect(JobInputSchema.safeParse(review).success).toBe(true);
    expect(JobInputSchema.safeParse({ ...review, previous: 'quote-v2' }).success).toBe(true);
    expect(JobInputSchema.safeParse({ ...review, previous: false }).success).toBe(true);
    expect(JobInputSchema.safeParse({ ...exp, gif: { start_s: 2, duration_s: 10 } }).success).toBe(true);
  });

  it('a render by id only, project required, no output location, bounded and strict', () => {
    for (const bad of [
      { ...review, render_id: '../quote-v3' },
      { ...review, render_id: 'latest' },
      { ...review, render_id: '/abs/quote-v3.mp4' },
      { ...review, fps: 3 },
      { ...review, previous: '../x-v1' },
      { ...review, previous: true },
      { ...review, out: '/tmp/x' },
      { ...review, project: undefined },
    ]) {
      expect(ReviewJobInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [
      { ...exp, formats: [] },
      { ...exp, formats: ['mp4_1080p', 'mp4_1080p'] },
      { ...exp, formats: ['mp4_8k'] },
      { ...exp, formats: [...EXPORT_FORMAT_NAMES, 'webm'] },
      { ...exp, gif: { duration_s: 60 } },
      { ...exp, gif: { start_s: -1 } },
      { ...exp, gif: { start_s: 1, loop: true } },
      { ...exp, out: 'exports/elsewhere' },
      { ...exp, project: undefined },
    ]) {
      expect(ExportJobInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('preview job input', () => {
  const preview = (extra: Record<string, unknown> = {}) => ({
    version: JOB_INPUT_VERSION,
    kind: 'preview',
    project: 'shop',
    preview_id: 'p_01JABCDEFGHJKMNPQRSTVWXYZ0',
    target: { kind: 'component', component: 'studio/card-title' },
    submitted_by: 'mcp',
    ...extra,
  });

  it('preview is a job kind; a component and a theme target parse through the union', () => {
    expect(JOB_KINDS).toContain('preview');
    expect(JobInputSchema.parse(preview()).kind).toBe('preview');
    expect(JobInputSchema.parse(preview({ target: { kind: 'theme' }, template: 'motion' })).kind).toBe('preview');
    expect(PREVIEW_ID_RE.test('p_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe(true);
  });

  it('project required; the preview id, the component and the theme are names, never paths; no output location', () => {
    const bad = (x: Record<string, unknown>) => expect(PreviewJobInputSchema.safeParse(preview(x)).success, JSON.stringify(x)).toBe(false);
    const { project: _p, ...noProject } = preview();
    expect(PreviewJobInputSchema.safeParse(noProject).success).toBe(false);
    bad({ preview_id: '../x' });
    bad({ preview_id: 'j_01JABCDEFGHJKMNPQRSTVWXYZ0' });
    bad({ template: '../templates/motion' });
    bad({ template: '/abs' });
    bad({ out: '/tmp/x' });
    bad({ target: { kind: 'component', component: '../studio/card-title' } });
    bad({ target: { kind: 'component', component: 'studio/card-title', file: '/etc/hosts' } });
    bad({ target: { kind: 'theme', template: 'x' } });
  });

  it('slots: names and texts, bounded; params ≤ 8 KB; at_s bounded', () => {
    const ok = (t: Record<string, unknown>) => PreviewJobInputSchema.safeParse(preview({ target: { kind: 'component', component: 'studio/card-title', ...t } })).success;
    expect(ok({ slots: { title: 'Quotes', kicker: 'One' }, params: { tone: 'dark' }, at_s: 1.5 })).toBe(true);
    expect(ok({ slots: { '../x': 'a' } })).toBe(false);
    expect(ok({ slots: { title: 'x'.repeat(2001) } })).toBe(false);
    expect(ok({ slots: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`s${i}`, 'x'])) })).toBe(false);
    expect(ok({ params: { big: 'x'.repeat(9000) } })).toBe(false);
    expect(ok({ at_s: -1 })).toBe(false);
    expect(ok({ at_s: 601 })).toBe(false);
  });
});
