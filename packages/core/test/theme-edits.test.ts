/**
 * L4.7 part A1, core theme edits (theme-edits.ts; critique B7): one value of a theme's template.yaml written from the
 * Studio's theme editor as a splice (map-edits.ts setMapPath), checked with facts independent of the edit code — the
 * re-parsed value against the edit applied to the parsed value (verifyEditText), the theme still valid
 * (parseTemplateYaml), the lines that may change, every comment and every other byte. On copies of the three starters:
 * each field, the compound background and component kinds, the legacy fields a component change removes (no warning
 * left), the allow-list (⚑ nothing else is reachable), value checks, stale `from`, hidden characters, placement, line
 * breaks, and a fuzz of random edit sequences.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STARTER_TEMPLATES_DIR,
  StepEditError,
  THEME_FIELD_PATHS,
  THEME_REMOVABLE_FIELDS,
  applyThemeEdit,
  newHiddenCharProblem,
  parseTemplateYaml,
  parseYaml,
  verifyEditText,
} from '../src/index.js';
import type { ComponentKind, ThemeEdit, ThemeField, ThemeFieldValue } from '../src/index.js';

type Obj = Record<string, unknown>;
type Edit = Exclude<ThemeEdit, { kind: 'restore' }>;
const STARTERS = ['default', 'editorial', 'motion'] as const;
const starter = (n: (typeof STARTERS)[number]) => readFileSync(join(STARTER_TEMPLATES_DIR, n, 'template.yaml'), 'utf8');

const valueOf = (t: string) => parseYaml(t).value as Obj;
function readAt(t: string, field: string): unknown {
  let cur: unknown = valueOf(t);
  for (const k of field.split('.')) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Obj)[k] : undefined;
  return cur;
}
/** The edit applied and verified: the text re-parses to exactly the intended value and the theme still parses. */
function applied(t: string, edit: Edit) {
  const r = applyThemeEdit(t, edit);
  expect(verifyEditText(r.text, r.intended), JSON.stringify(edit)).toBeNull();
  const p = parseTemplateYaml(r.text);
  expect(p.issues.filter((i) => i.severity === 'error'), JSON.stringify(edit)).toEqual([]);
  return r;
}
const refusal = (t: string, edit: unknown): StepEditError => {
  try {
    applyThemeEdit(t, edit as Edit);
  } catch (e) {
    expect(e).toBeInstanceOf(StepEditError);
    return e as StepEditError;
  }
  throw new Error(`not refused: ${JSON.stringify(edit)}`);
};
const changedLines = (a: string, b: string) => {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return { removed: x.slice(i, x.length - j), added: y.slice(i, y.length - j) };
};
/** Every comment of `a` (its `# …` text) is still in `b`. */
const commentsOf = (t: string) => t.split('\n').flatMap((l) => (/(^|\s)#\s.*$/.exec(l)?.[0].trim() ?? []));
const warningsOf = (t: string) => parseTemplateYaml(t).issues.filter((i) => i.path[0] === 'components').map((i) => i.message);

/** A new value for each field, different from every starter's. */
const NEW: Record<ThemeField, ThemeFieldValue> = {
  'colors.accent': '#12ab34',
  'colors.text': '#101010',
  'colors.muted': '#777777',
  'colors.paper': '#fefefe',
  'colors.dark': '#0b0c10',
  'background.from': '#fafafa',
  'background.to': '#e0e0e0',
  'background.color': '#f0f0f0',
  'cursor.style': 'arrow-light',
  'cursor.ripple_color': 'rgba(1, 2, 3, 0.3)',
  'brand.name': 'Northfield Goods',
  'brand.url': 'northfield.example/tour',
  'outro.url': 'shop.example',
  'outro.tagline': 'Wholesale, simply.',
  style_bias: 'balanced',
  'motion.max_zoom': 1.85,
  'motion.default_zoom': 1.25,
  logo: 'brand/logo-2.png',
  wordmark: 'wordmark-2.svg',
  'fonts.display': 'fonts/Display-2.otf',
  'fonts.body': ['fonts/Body-Regular.woff2', 'fonts/Body-Bold.woff2'],
};

describe('theme set_field on the three starters', () => {
  it('every field: set, the theme valid, one value changed, every comment kept; then set back gives the original bytes', () => {
    let n = 0;
    for (const s of STARTERS) {
      const text = starter(s);
      const bgType = (valueOf(text).background as Obj).type;
      for (const field of THEME_FIELD_PATHS) {
        if (field.startsWith('background.') && (bgType === 'solid') !== (field === 'background.color')) continue;
        const from = readAt(text, field) as ThemeFieldValue | undefined;
        const to = NEW[field];
        const r = applied(text, { kind: 'set_field', field, ...(from !== undefined ? { from } : {}), to });
        expect(readAt(r.text, field), `${s} ${field}`).toEqual(to);
        // Only that value changed in the parsed file.
        const want = structuredClone(valueOf(text));
        const segs = field.split('.');
        if (segs.length === 1) want[segs[0]] = to;
        else want[segs[0]] = { ...((want[segs[0]] as Obj) ?? {}), [segs[1]]: to };
        expect(valueOf(r.text), `${s} ${field}`).toEqual(want);
        const d = changedLines(text, r.text);
        expect(d.added.length, `${s} ${field}`).toBe(1);
        expect(d.removed.length, `${s} ${field}`).toBeLessThanOrEqual(1);
        expect(commentsOf(r.text), `${s} ${field}`).toEqual(commentsOf(text));
        const back = applied(r.text, { kind: 'set_field', field, from: to, ...(from !== undefined ? { to: from } : {}) });
        if (from !== undefined && !Array.isArray(from)) expect(back.text, `${s} ${field}`).toBe(text);
        else expect(valueOf(back.text), `${s} ${field}`).toEqual(valueOf(text));
        n++;
      }
    }
    // Each background has the colours of its own type: radial / linear two of three, solid one.
    expect(n).toBe(3 * THEME_FIELD_PATHS.length - 4);
  });

  it('values are normalised: hex lower-case, rgba spaced; a label names the change', () => {
    const t = starter('editorial');
    const r = applied(t, { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#ABCDEF' });
    expect(readAt(r.text, 'colors.accent')).toBe('#abcdef');
    expect(r.text).toContain('accent: "#abcdef"   # deep wine');
    expect(r.label).toBe('Set the accent colour to #abcdef');
    const r2 = applied(t, { kind: 'set_field', field: 'cursor.ripple_color', from: 'rgba(138, 35, 50, 0.45)', to: 'rgba(1,2,3,.5)' });
    expect(readAt(r2.text, 'cursor.ripple_color')).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('the accent with ripple: the cursor ripple follows at its own alpha, in the same write', () => {
    const e = starter('editorial');
    const r = applied(e, { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#102030', ripple: true });
    expect(readAt(r.text, 'cursor.ripple_color')).toBe('rgba(16, 32, 48, 0.45)');
    expect(r.label).toMatch(/cursor ripple following/);
    const before = e.split('\n');
    const after = r.text.split('\n');
    expect(after.length).toBe(before.length);
    expect(after.filter((l, i) => l !== before[i])).toEqual(['  accent: "#102030"   # deep wine: kicker, rules, clock hour hand, cursor ripple', 'cursor: {style: arrow-dark, ripple_color: "rgba(16, 32, 48, 0.45)"}']);
    const m = applied(starter('motion'), { kind: 'set_field', field: 'colors.accent', from: '#ff5c38', to: '#00ff00', ripple: true });
    expect(readAt(m.text, 'cursor.ripple_color')).toBe('rgba(0, 255, 0, 0.5)');
    expect(refusal(e, { kind: 'set_field', field: 'colors.text', from: '#1f1413', to: '#000000', ripple: true }).message).toMatch(/ripple goes only with a new colors.accent/);
  });

  it('removable fields only; removing the last key of a section removes it', () => {
    const t = starter('editorial');
    const r = applied(t, { kind: 'set_field', field: 'wordmark', from: 'wordmark.svg' });
    expect(readAt(r.text, 'wordmark')).toBeUndefined();
    expect(r.label).toBe('Removed the wordmark');
    expect(changedLines(t, r.text)).toEqual({ removed: ['wordmark: wordmark.svg'], added: [] });
    const b1 = applied(t, { kind: 'set_field', field: 'brand.url', from: 'example.com' });
    expect(readAt(b1.text, 'brand')).toEqual({ name: 'Atelier' });
    const b2 = applied(b1.text, { kind: 'set_field', field: 'brand.name', from: 'Atelier' });
    expect(readAt(b2.text, 'brand')).toBeUndefined();
    expect(b2.text).not.toContain('placeholder brand (fictional)');
    const z = applied(t, { kind: 'set_field', field: 'motion.default_zoom', from: 'none' });
    expect(readAt(z.text, 'motion')).toEqual({ max_zoom: 1.4, zoom_ease: [0.45, 0, 0.2, 1] });
    for (const field of THEME_FIELD_PATHS.filter((f) => !THEME_REMOVABLE_FIELDS.includes(f))) {
      const from = readAt(t, field);
      expect(refusal(t, { kind: 'set_field', field, ...(from !== undefined ? { from } : {}) }).message, field).toMatch(/cannot be removed/);
    }
  });
});

describe('theme set_field: the allow-list and value checks (⚑ nothing else is reachable)', () => {
  it('a path outside the allow-list is refused, nothing written', () => {
    const t = starter('editorial');
    for (const field of ['name', 'version', 'components', 'components.intro', 'captions.kicker.color', 'captions.position', 'frame.style', 'frame', 'intro.layout', 'cursor.size', 'motion.zoom_ease', 'fonts', 'colors', 'colors.__proto__', '__proto__', 'constructor', 'background.type', 'background', 'brandmark.position', '', 'colors.accent.x']) {
      const e = refusal(t, { kind: 'set_field', field, to: 'x' });
      expect(e.code, field).toBe('invalid');
      expect(e.message, field).toMatch(/is not a value the theme editor sets/);
    }
    expect(refusal(t, { kind: 'rename', field: 'name', to: 'x' }).message).toMatch(/unknown theme edit kind/);
    expect(refusal(t, { kind: 'restore', text: t, text_hash: 'x' }).message).toMatch(/unknown theme edit kind/);
  });

  it('values are checked for their kind and range before anything is written', () => {
    const t = starter('editorial');
    const bad: Array<[ThemeField, unknown, RegExp]> = [
      ['colors.accent', 'red', /hex colour/],
      ['colors.accent', '#12345', /hex colour/],
      ['colors.accent', 'url(x)', /hex colour/],
      ['colors.paper', 'var(--x)', /hex colour/],
      ['cursor.ripple_color', 'rgba(300, 0, 0, 0.5)', /numbers only/],
      ['cursor.ripple_color', 'rgba(1, 2, 3, 2)', /numbers only/],
      ['cursor.ripple_color', 'rgba(1, 2, 3, 0.5); background: url(x)', /numbers only/],
      ['cursor.style', 'debug', /arrow-dark or arrow-light/],
      ['style_bias', 'wild', /real, balanced or motion/],
      ['motion.max_zoom', 3.05, /1 to 3 in steps of 0.01/],
      ['motion.max_zoom', 1.035, /steps of 0.01/],
      ['motion.max_zoom', '1.5', /a number from 1 to 3/],
      ['motion.default_zoom', 'auto', /none or a number/],
      ['brand.name', 'A'.repeat(81), /at most 80 characters/],
      ['brand.name', 'Evil‮Name', /U\+202E/],
      ['brand.name', 'Zero​Width', /U\+200B/],
      ['brand.name', 'Two\nlines', /one line only|U\+000A/],
      ['brand.name', ' padded', /leading or trailing spaces/],
      ['brand.name', '', /not empty/],
      ['outro.tagline', 'x'.repeat(121), /at most 120/],
      ['brand.url', 'exa mple.com', /no space/],
      ['brand.url', 'example.com/"><img', /no space, quote/],
      // L4.7 review A M2: shown as typed, never opened — no scheme, no leading // (the preview scan's rule).
      ['brand.url', 'https://example.com', /no scheme \(https:\/\/\) and no leading \/\//],
      ['brand.url', '//evil.example/x', /no scheme/],
      ['outro.url', 'HTTP://example.net', /no scheme/],
      ['outro.url', 'javascript:alert(1)', /no scheme/],
      ['outro.url', 'mailto:a@example.com', /no scheme/],
      ['logo', '../outside.png', /file of the theme folder/],
      ['logo', '/etc/logo.png', /file of the theme folder/],
      ['logo', '.hidden/logo.png', /file of the theme folder/],
      ['logo', 'brand\\logo.png', /file of the theme folder/],
      ['logo', 'logo.gif', /\.svg, \.png/],
      ['wordmark', 'a/b/c/d/e.svg', /file of the theme folder/],
      ['fonts.display', '../x.ttf', /file of the theme folder/],
      ['fonts.display', 'fonts/x.png', /\.ttf, \.otf/],
      ['fonts.body', 'fonts/Inter-Regular.ttf', /1 to 4 font files/],
      ['fonts.body', [], /1 to 4 font files/],
      ['fonts.body', ['a.ttf', 'b.ttf', 'c.ttf', 'd.ttf', 'e.ttf'], /1 to 4 font files/],
      ['fonts.body', ['a.ttf', 'a.ttf'], /twice/],
      ['fonts.body', ['a.ttf', '../b.ttf'], /file of the theme folder/],
    ];
    for (const [field, to, re] of bad) {
      const from = readAt(t, field);
      const e = refusal(t, { kind: 'set_field', field, ...(from !== undefined ? { from } : {}), to });
      expect(e.message, `${field} ${JSON.stringify(to)}`).toMatch(re);
      expect(e.code).toBe('invalid');
    }
  });

  it('stale: a value changed meanwhile is never overwritten; nothing to change is said', () => {
    const t = starter('editorial');
    const e = refusal(t, { kind: 'set_field', field: 'colors.accent', from: '#000000', to: '#111111' });
    expect(e.code).toBe('stale');
    expect(e.message).toMatch(/changed meanwhile \(it is now "#8a2332"\)/);
    expect(refusal(t, { kind: 'set_field', field: 'colors.dark', to: '#111111', from: '#222222' }).code).toBe('stale');
    expect(refusal(t, { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#8A2332' }).message).toMatch(/nothing to change/);
  });

  it('a background colour of another type is refused (set_background switches type and colours together)', () => {
    const e = refusal(starter('editorial'), { kind: 'set_field', field: 'background.color', to: '#ffffff' });
    expect(e.message).toMatch(/the background is radial: it has no color — switch its type and colours together/);
    expect(refusal(starter('default'), { kind: 'set_field', field: 'background.from', to: '#ffffff' }).message).toMatch(/the background is solid/);
  });

  it('a section written as something else, or a value written as a map, is changed by hand', () => {
    expect(refusal('version: 1\ncolors: plain\n', { kind: 'set_field', field: 'colors.accent', to: '#111111' }).message).toMatch(/`colors` is not written as a map: edit template.yaml by hand/);
    expect(refusal('version: 1\nlogo: {file: x.png}\n', { kind: 'set_field', field: 'logo', from: 'x', to: 'y.png' }).message).toMatch(/written as a map: edit template.yaml by hand/);
    expect(refusal('- a\n- b\n', { kind: 'set_field', field: 'logo', to: 'y.png' }).message).toMatch(/not a map of settings/);
    expect(refusal('a: [\n', { kind: 'set_field', field: 'logo', to: 'y.png' }).message).toMatch(/not valid YAML/);
  });

  it('an anchored value changed under an alias elsewhere is refused (verified, never written)', () => {
    const t = 'version: 1\ncolors:\n  accent: &a "#111111"\n  text: *a\n';
    const e = refusal(t, { kind: 'set_field', field: 'colors.accent', from: '#111111', to: '#222222' });
    expect(e.code).toBe('not_editable');
    expect(e.message).toMatch(/edit template.yaml by hand/);
  });
});

describe('theme set_background (critique B7a: type and colours in one write)', () => {
  it('radial → solid → linear on the starters: one line, comments kept, the theme valid', () => {
    const t = starter('editorial');
    const solid = applied(t, { kind: 'set_background', from: { type: 'radial', from: '#f8f4ef', to: '#ebe4dc' }, to: { type: 'solid', color: '#FFFFFF' } });
    expect(readAt(solid.text, 'background')).toEqual({ type: 'solid', color: '#ffffff' });
    expect(changedLines(t, solid.text)).toEqual({ removed: ['background: {type: radial, from: "#f8f4ef", to: "#ebe4dc"}'], added: ['background: { type: solid, color: "#ffffff" }'.replace('{ ', '{').replace(' }', '}')] });
    expect(solid.label).toBe('Set the background to solid #ffffff');
    const lin = applied(solid.text, { kind: 'set_background', from: { type: 'solid', color: '#ffffff' }, to: { type: 'linear', from: '#000000', to: '#222222' } });
    expect(readAt(lin.text, 'background')).toEqual({ type: 'linear', from: '#000000', to: '#222222' });
    expect(commentsOf(lin.text)).toEqual(commentsOf(t));
    const d = applied(starter('default'), { kind: 'set_background', from: { type: 'solid', color: '#eef1f5' }, to: { type: 'radial', from: '#ffffff', to: '#dddddd' } });
    expect(parseTemplateYaml(d.text).template?.background).toMatchObject({ type: 'radial', from: '#ffffff', to: '#dddddd' });
  });

  it('a block background is rewritten as a flow map, unless it holds a comment; absent: added before components', () => {
    const block = 'version: 1\nbackground:\n  type: radial\n  from: "#ffffff"\n  to: "#eeeeee"\nstyle_bias: real\n';
    const r = applied(block, { kind: 'set_background', from: { type: 'radial', from: '#ffffff', to: '#eeeeee' }, to: { type: 'solid', color: '#123456' } });
    expect(r.text).toBe('version: 1\nbackground: {type: solid, color: "#123456"}\nstyle_bias: real\n');
    const commented = 'version: 1\nbackground:\n  type: radial   # soft\n  from: "#ffffff"\n  to: "#eeeeee"\n';
    expect(refusal(commented, { kind: 'set_background', from: { type: 'radial', from: '#ffffff', to: '#eeeeee' }, to: { type: 'solid', color: '#123456' } }).message).toMatch(/with comments \(they would go\): edit template.yaml by hand/);
    const none = 'version: 1\nstyle_bias: real\n# components\ncomponents:\n  card: studio/card-title\n';
    const a = applied(none, { kind: 'set_background', to: { type: 'solid', color: '#123456' } });
    expect(a.text).toBe('version: 1\nstyle_bias: real\nbackground: {type: solid, color: "#123456"}\n# components\ncomponents:\n  card: studio/card-title\n');
  });

  it('refusals: shape, colours, stale, nothing to change', () => {
    const t = starter('editorial');
    const from = readAt(t, 'background');
    expect(refusal(t, { kind: 'set_background', from, to: { type: 'solid' } }).message).toMatch(/solid background takes type and color only/);
    expect(refusal(t, { kind: 'set_background', from, to: { type: 'solid', color: '#fff', from: '#000' } }).message).toMatch(/type and color only/);
    expect(refusal(t, { kind: 'set_background', from, to: { type: 'radial', from: '#fff', to: 'url(x)' } }).message).toMatch(/hex colours/);
    expect(refusal(t, { kind: 'set_background', from, to: { type: 'image', url: 'x' } }).message).toMatch(/solid, radial or linear/);
    expect(refusal(t, { kind: 'set_background', from, to: '#ffffff' }).message).toMatch(/set_background takes/);
    expect(refusal(t, { kind: 'set_background', from: { type: 'solid', color: '#000000' }, to: { type: 'solid', color: '#ffffff' } }).code).toBe('stale');
    expect(refusal(t, { kind: 'set_background', from, to: { type: 'radial', from: '#F8F4EF', to: '#ebe4dc' } }).message).toMatch(/nothing to change/);
  });
});

describe('theme set_component (critique B7b / B7c)', () => {
  it('a changed component removes the legacy fields it now contradicts, named; no warning is left', () => {
    const e = starter('editorial');
    expect(warningsOf(e)).toEqual([]);
    const lay = applied(e, { kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'studio/layout-browser', params: 'drop' });
    expect(readAt(lay.text, 'components.layout')).toBe('studio/layout-browser');
    expect(lay.removed).toEqual(['frame.style', 'frame.width', 'frame.radius', 'frame.shadow']);
    expect(readAt(lay.text, 'frame')).toBeUndefined();
    expect(lay.dropped_params).toEqual(['width', 'radius', 'shadow']);
    expect(lay.label).toBe('Set the layout component to studio/layout-browser (params width, radius, shadow dropped); removed frame.style, frame.width, frame.radius, frame.shadow (they contradicted it)');
    expect(warningsOf(lay.text)).toEqual([]);
    expect(commentsOf(lay.text)).toEqual(commentsOf(e));
    const intro = applied(e, { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: 'studio/intro-minimal', params: 'drop' });
    expect(intro.removed).toEqual(['intro.layout']);
    expect(readAt(intro.text, 'intro')).toEqual({ duration: 3.2 });
    expect(warningsOf(intro.text)).toEqual([]);
    const cut = applied(starter('motion'), { kind: 'set_component', component: 'transition', from: 'studio/transition-fade-black', id: null, params: 'drop' });
    expect(readAt(cut.text, 'components.transition')).toBeNull();
    expect(cut.removed).toEqual(['transitions.between_scenes', 'transitions.duration']);
    expect(readAt(cut.text, 'transitions')).toBeUndefined();
    expect(cut.label).toMatch(/^Set the transition component to none \(a cut\)/);
    expect(warningsOf(cut.text)).toEqual([]);
    const cap = applied(starter('default'), { kind: 'set_component', component: 'caption', from: 'studio/caption-below', id: null, params: 'drop' });
    expect(cap.removed).toEqual(['captions.position']);
    expect(readAt(cap.text, 'captions')).toMatchObject({ kicker: expect.any(Object), line: expect.any(Object) });
    expect(warningsOf(cap.text)).toEqual([]);
  });

  it('a change the legacy field agrees with keeps it; params kept or dropped as asked', () => {
    const d = starter('default');
    // default: interstitial-plain {tone: dark} ⇄ interstitial.style dark. Back to the clock contradicts; the clock on
    // `dark-clock` agrees.
    const clock = applied(starter('editorial').replace('components:\n  intro: studio/intro-stack', 'components:\n  intro: studio/intro-minimal'), {
      kind: 'set_component', component: 'intro', from: 'studio/intro-minimal', id: 'studio/intro-stack', params: 'drop',
    });
    expect(clock.removed).toEqual([]);
    expect(readAt(clock.text, 'intro')).toEqual({ duration: 3.2, layout: 'logo-kicker-title' });
    const keep = applied(d, { kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'acme/layout-wide', params: 'keep' });
    expect(readAt(keep.text, 'components.layout')).toEqual({ id: 'acme/layout-wide', params: { width: 1560, radius: 18, shadow: 'soft' } });
    expect(keep.kept_params).toEqual({ width: 1560, radius: 18, shadow: 'soft' });
    expect(keep.label).toMatch(/\(its params kept\)/);
    const same = applied(d, { kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'studio/layout-card', params: 'drop' });
    expect(readAt(same.text, 'components.layout')).toBe('studio/layout-card');
    // A kind not written yet: added to the block map, after its last pair.
    const noOverlay = d.replace('  overlay: studio/overlay-callout\n', '');
    const add = applied(noOverlay, { kind: 'set_component', component: 'overlay', id: 'studio/overlay-callout', params: 'keep' });
    expect(changedLines(noOverlay, add.text).added).toEqual(['  overlay: studio/overlay-callout']);
    // No components section: one added at the end.
    const bare = 'version: 1\nstyle_bias: real\n';
    expect(applied(bare, { kind: 'set_component', component: 'card', id: 'studio/card-cta', params: 'drop' }).text).toBe('version: 1\nstyle_bias: real\ncomponents: {card: studio/card-cta}\n');
  });

  it('refusals: a theme file entry, none for a kind that needs one, bad ids, stale, nothing to change', () => {
    const media = 'version: 1\ncomponents:\n  intro: {video: intro.mp4}\n  card: studio/card-title\n';
    expect(refusal(media, { kind: 'set_component', component: 'intro', id: 'studio/intro-stack', params: 'drop' }).message).toMatch(/the theme's own file/);
    const e = starter('editorial');
    expect(refusal(e, { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: null, params: 'drop' }).message).toMatch(/cannot be none here/);
    expect(refusal(e, { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: '../x', params: 'drop' }).message).toMatch(/namespace\/name/);
    expect(refusal(e, { kind: 'set_component', component: 'cursor', id: 'studio/x', params: 'drop' }).message).toMatch(/component is one of/);
    expect(refusal(e, { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: 'studio/x', params: 'merge' }).message).toMatch(/keep or drop/);
    expect(refusal(e, { kind: 'set_component', component: 'intro', from: 'studio/intro-minimal', id: 'studio/x', params: 'drop' }).code).toBe('stale');
    expect(refusal(e, { kind: 'set_component', component: 'intro', id: 'studio/x', params: 'drop' }).code).toBe('stale');
    expect(refusal(e, { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: 'studio/intro-stack', params: 'drop' }).message).toMatch(/nothing to change/);
    const odd = 'version: 1\ncomponents:\n  layout: {id: studio/layout-card, params: {width: 1}, extra: 1}\n';
    expect(refusal(odd, { kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'studio/layout-raw', params: 'drop' }).message).toMatch(/form the editor does not change/);
  });
});

describe('theme edits: text rules', () => {
  it('placement: a new top-level key before `components:` above its comment lines; a new colour after the last; a flow map extended', () => {
    const e = starter('editorial');
    const noWm = e.replace('wordmark: wordmark.svg\n', '');
    const r = applied(noWm, { kind: 'set_field', field: 'wordmark', to: 'wordmark.svg' });
    expect(r.text.indexOf('wordmark: wordmark.svg')).toBeLessThan(r.text.indexOf('# Default component per kind'));
    expect(changedLines(noWm, r.text).added).toEqual(['wordmark: wordmark.svg']);
    const dark = applied(e, { kind: 'set_field', field: 'colors.dark', to: '#0b0c10' });
    expect(dark.text).toContain('  paper: "#f3eee8"    # warm paper; text colour on the dark interstitial\n  dark: "#0b0c10"\n');
    const tag = applied(e, { kind: 'set_field', field: 'outro.tagline', to: 'Made by hand.' });
    expect(tag.text).toContain('outro: {duration: 3.0, layout: logo-wordmark-tagline-url, url: example.com, tagline: Made by hand.}');
  });

  it('CR LF line breaks and a missing final line break are kept', () => {
    const crlf = starter('editorial').replace(/\n/g, '\r\n');
    const r = applied(crlf, { kind: 'set_field', field: 'colors.dark', to: '#0b0c10' });
    expect(r.text.replace(/\r\n/g, '')).not.toContain('\n');
    const bare = 'version: 1\ncolors: {accent: "#111111"}';
    const b = applied(bare, { kind: 'set_field', field: 'style_bias', to: 'motion' });
    expect(b.text.endsWith('\n')).toBe(false);
    expect(valueOf(b.text)).toEqual({ version: 1, colors: { accent: '#111111' }, style_bias: 'motion' });
  });

  it('hidden characters: a file keeps its own on unchanged lines; an edit adds none', () => {
    const t = starter('editorial').replace('# deep wine', '# deep​wine');
    const r = applied(t, { kind: 'set_field', field: 'colors.text', from: '#1f1413', to: '#000000' });
    expect(r.text).toContain('# deep​wine');
    expect(newHiddenCharProblem(r.text, t)).toBeNull();
    // The line holding one, changed: the engine's check (newHiddenCharProblem) names it.
    const moved = applied(t, { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#000000' });
    expect(newHiddenCharProblem(moved.text, t)).toMatch(/U\+200B/);
  });

  it('a file over the Studio cap is edited by hand', () => {
    const big = `version: 1\n${'# x\n'.repeat(30_000)}style_bias: real\n`;
    expect(refusal(big, { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' }).message).toMatch(/more than 100,000 characters/);
  });
});

// ── Fuzz ────────────────────────────────────────────────────────────────────

const POOL: Partial<Record<ThemeField, ThemeFieldValue[]>> = {
  'colors.accent': ['#111111', '#aabbcc', '#123'],
  'colors.text': ['#000000', '#222'],
  'colors.muted': ['#777777'],
  'colors.paper': ['#ffffff', '#fdfcfb'],
  'colors.dark': ['#0b0c10', '#101820'],
  'background.from': ['#ffffff', '#f0f0f0'],
  'background.to': ['#000000', '#dddddd'],
  'background.color': ['#eeeeee', '#fafafa'],
  'cursor.style': ['arrow-light', 'arrow-dark'],
  'cursor.ripple_color': ['rgba(1, 2, 3, 0.4)', '#aabbcc'],
  'brand.name': ['Acme', 'Northfield', 'Two words: yes'],
  'brand.url': ['example.com', 'shop.example/a?b=1', 'example.com:8080/x'],
  'outro.url': ['example.net'],
  'outro.tagline': ['Hello there.', '- dash', "it's #1"],
  style_bias: ['real', 'balanced', 'motion'],
  'motion.max_zoom': [1, 1.5, 2.25, 3],
  'motion.default_zoom': ['none', 1.1, 2],
  logo: ['logo.svg', 'brand/logo.png'],
  wordmark: ['wordmark.svg', 'w.webp'],
  'fonts.display': ['fonts/A.ttf', 'fonts/B.woff2'],
  'fonts.body': [['fonts/A.ttf'], ['fonts/B.ttf', 'fonts/C.ttf']],
};
const IDS: Record<ComponentKind, Array<string | null>> = {
  intro: ['studio/intro-stack', 'studio/intro-minimal', 'acme/intro-x'],
  outro: ['studio/outro-stack', 'studio/outro-minimal'],
  card: ['studio/card-title', 'studio/card-cta'],
  interstitial: ['studio/interstitial-clock', 'studio/interstitial-plain'],
  caption: ['studio/caption-below', 'studio/caption-overlay', null],
  layout: ['studio/layout-card', 'studio/layout-browser', 'acme/layout-wide'],
  overlay: ['studio/overlay-callout', 'acme/overlay-x'],
  transition: ['studio/transition-crossfade', 'studio/transition-fade-black', null],
};

describe('theme edits: fuzz', () => {
  it('1,500 random edits in sequence on the three starters: every text verifies, the theme stays valid, no legacy warning is left by a component change', () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let done = 0;
    let mismatches = 0;
    const kinds = Object.keys(IDS) as ComponentKind[];
    for (const s of STARTERS) {
      let text = starter(s);
      const comments = commentsOf(text).filter((c) => !/placeholder brand|sample brand|consistent with the legacy/.test(c));
      for (let i = 0; i < 500; i++) {
        const pick = rnd(10);
        let edit: Edit;
        if (pick < 6) {
          const fields = Object.keys(POOL) as ThemeField[];
          const field = fields[rnd(fields.length)];
          const from = readAt(text, field) as ThemeFieldValue | undefined;
          const remove = THEME_REMOVABLE_FIELDS.includes(field) && from !== undefined && rnd(4) === 0;
          // A value that differs from today's (a no-op is said, not written): the fuzz is about writes.
          const pool = POOL[field]!.filter((v) => JSON.stringify(v) !== JSON.stringify(from));
          edit = { kind: 'set_field', field, ...(from !== undefined ? { from } : {}), ...(remove ? {} : { to: pool[rnd(pool.length)] }), ...(field === 'colors.accent' && rnd(2) ? { ripple: true } : {}) };
        } else if (pick < 8) {
          const from = readAt(text, 'background');
          const c = ['#ffffff', '#000000', '#abcdef'];
          const to = rnd(2) ? { type: 'solid' as const, color: c[rnd(3)] } : { type: (rnd(2) ? 'radial' : 'linear') as 'radial' | 'linear', from: c[rnd(3)], to: c[rnd(3)] };
          edit = { kind: 'set_background', ...(from !== undefined ? { from } : {}), to };
        } else {
          const kind = kinds[rnd(kinds.length)];
          const cur = readAt(text, `components.${kind}`);
          const from = cur === undefined ? undefined : cur === null ? null : typeof cur === 'string' ? cur : ((cur as Obj).id as string);
          const ids = IDS[kind].filter((x) => x !== from);
          edit = { kind: 'set_component', component: kind, ...(from !== undefined ? { from } : {}), id: ids[rnd(ids.length)], params: rnd(2) ? 'keep' : 'drop' };
        }
        let r;
        try {
          r = applyThemeEdit(text, edit);
        } catch (e) {
          if (!(e instanceof StepEditError)) throw e;
          expect(e.code, `${s} ${JSON.stringify(edit)}: ${e.message}`).toMatch(/invalid|not_editable/);
          continue;
        }
        if (verifyEditText(r.text, r.intended) !== null) mismatches++;
        expect(parseTemplateYaml(r.text).issues.filter((x) => x.severity === 'error'), `${s} ${JSON.stringify(edit)}`).toEqual([]);
        if (edit.kind === 'set_component') expect(warningsOf(r.text).filter((m) => m.startsWith(`components.${edit.component} `)), `${s} ${JSON.stringify(edit)}`).toEqual([]);
        text = r.text;
        done++;
      }
      // Comments that belong to values still there are kept (a removed section takes its own).
      for (const c of comments) if (!/deep wine|warm ink|taglines|warm paper|calm blue|slate ink|light surface|hot coral|near-white|Dark surface|use the `paper`/.test(c)) expect(text, `${s}: ${c}`).toContain(c);
    }
    expect(mismatches).toBe(0);
    expect(done).toBeGreaterThan(1200);
  }, 120_000);
});
