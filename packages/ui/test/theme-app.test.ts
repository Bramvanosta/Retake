/**
 * L4.7 part D2: the theme screens' pure rules (app/theme-words.ts) and the route:
 * - mirrors pinned equal to core (hex, removable fields, text caps through core's own value check);
 * - each control's edit: `set_field` with `from` what the view showed (absent when not written), nothing when the value
 *   is the same, a value the field cannot take refused with why, a read-only theme refused with its why;
 * - ⚑ compound edits (critique B7): a background type switch writes its type and colours together; a background
 *   written as one value is refused (by hand); a kind's component with `from` as written, none only for captions /
 *   transitions, params kept or dropped, a theme's own media file refused;
 * - ⚑ undo / redo send only bytes the server served (ThemeHistory: the view before a write and after it), on the version
 *   shown; another writer clears the history;
 * - ⚑ the draft throttle: at most one preview per 200 ms (five a second), the newest value always previewed last;
 * - "Use in this scenario": the scenario's `template` set_field with `from` as written (critique B1);
 * - New theme from a site extraction: its hex roles and first candidate, nothing else of the page;
 * - ⚑ no Studio op queues a site job (template_from_site is not a UI op), which events re-read what, the themes route.
 */
import { describe, expect, it } from 'vitest';
import { HEX_COLOR_RE, THEME_REMOVABLE_FIELDS, themeValueProblem } from '@retake/core';
import type { ThemeEditView } from '@retake/engine';
import { UI_OPS } from '../src/index.js';
import type { SiteListAnswer } from '../src/index.js';
import { hrefTo, parseRoute } from '../src/app/route.js';
import {
  DRAFT_INTERVAL_MS,
  DraftThrottle,
  EMPTY_FORM,
  HEX_RE,
  REMOVABLE,
  TEXT_MAX,
  ThemeHistory,
  backgroundEdit,
  backgroundOf,
  bodyFonts,
  componentChoices,
  componentEdit,
  componentOptionWords,
  createInput,
  fieldEdit,
  formFromSite,
  freeThemeName,
  newThemeProblem,
  offersCopy,
  opensInEditor,
  pickerHex,
  switchedBackground,
  textProblem,
  themeEventAction,
  planUseInScenario,
  usedByWords,
  zoomProblem,
} from '../src/app/words/theme-words.js';

const comp = (id: string, extra: Partial<ThemeEditView['components']['intro']> = {}): ThemeEditView['components']['intro'] => ({ written: 'id', id, resolved: { id, params: {} }, ...extra });
const view = (over: Partial<ThemeEditView> = {}): ThemeEditView =>
  ({
    name: 'mine',
    source: 'workspace',
    editable: true,
    sha256: 'a'.repeat(64),
    yaml: 'name: mine\n',
    fields: { 'colors.accent': '#8a2332', 'colors.paper': '#f3eee8', 'brand.name': 'Atelier', 'motion.max_zoom': 1.4, 'fonts.body': ['fonts/a.ttf'] },
    background: { type: 'radial', from: '#f8f4ef', to: '#ebe4dc' },
    components: {
      intro: comp('studio/intro-stack'),
      outro: { written: 'file', resolved: null },
      card: comp('studio/card-title'),
      interstitial: { written: 'absent', resolved: { id: 'studio/interstitial-clock', params: {} } },
      caption: comp('studio/caption-below'),
      layout: comp('studio/layout-card', { written: 'params', params: { width: 1560, radius: 18 } }),
      overlay: comp('studio/overlay-callout'),
      transition: { written: 'none', resolved: null },
    },
    fonts: [
      { file: 'fonts/a.ttf', weight: 400 },
      { file: 'fonts/b.ttf', weight: 700 },
      { file: 'fonts/bad.ttf', problem: 'not a font' },
    ],
    images: [
      { file: 'logo.svg', bytes: 10 },
      { file: 'evil.svg', bytes: 10, problem: 'holds a script' },
    ],
    links: [],
    palette: null,
    warnings: [],
    issues: [],
    used_by: { projects: ['p'], scenarios: [{ project: 'p', scenario: 'quote' }] },
    untrusted: { fonts: [] },
    ...over,
  }) as ThemeEditView;
const STARTER = { why: 'editorial is a starter theme shipped with Retake: copy it to edit it' };

describe('mirrors of core', () => {
  it("the hex pattern, the removable fields and the text caps are core's", () => {
    expect(HEX_RE.source).toBe(HEX_COLOR_RE.source);
    expect([...REMOVABLE].sort()).toEqual([...THEME_REMOVABLE_FIELDS].sort());
    for (const [field, max] of Object.entries(TEXT_MAX)) {
      expect(themeValueProblem(field as never, 'x'.repeat(max)), field).toBeNull();
      expect(themeValueProblem(field as never, 'x'.repeat(max + 1)), field).not.toBeNull();
      expect(textProblem(field, 'x'.repeat(max + 1))).not.toBeNull();
    }
    expect(pickerHex('#ABC')).toBe('#aabbcc');
    expect(pickerHex('red')).toBeNull();
  });
});

describe("a control's set_field", () => {
  it('from what the view showed; absent when not written; the same value → nothing; a removal only where allowed', () => {
    expect(fieldEdit(view(), 'colors.accent', '#225588')).toEqual({ edit: { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#225588' } });
    expect(fieldEdit(view(), 'colors.accent', '#225588', { ripple: true })).toEqual({ edit: { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#225588', ripple: true } });
    expect(fieldEdit(view(), 'colors.dark', '#111111')).toEqual({ edit: { kind: 'set_field', field: 'colors.dark', to: '#111111' } });
    expect(fieldEdit(view(), 'colors.accent', '#8a2332')).toBeNull();
    expect(fieldEdit(view(), 'brand.name', undefined)).toEqual({ edit: { kind: 'set_field', field: 'brand.name', from: 'Atelier' } });
    expect(fieldEdit(view(), 'colors.accent', undefined)).toMatchObject({ why: expect.stringMatching(/cannot be removed/) });
    expect(fieldEdit(view(), 'colors.accent', 'red')).toMatchObject({ why: expect.stringMatching(/hex/) });
    expect(fieldEdit(view(), 'fonts.body', ['fonts/a.ttf', 'fonts/b.ttf'])).toEqual({ edit: { kind: 'set_field', field: 'fonts.body', from: ['fonts/a.ttf'], to: ['fonts/a.ttf', 'fonts/b.ttf'] } });
    expect(fieldEdit(view(), 'fonts.body', ['fonts/a.ttf'])).toBeNull();
  });

  it('⚑ a read-only theme is refused with its why; zoom in steps of 0.01 from 1 to 3; text one line, no hidden character', () => {
    expect(fieldEdit(view({ editable: STARTER }), 'colors.accent', '#225588')).toEqual({ why: STARTER.why });
    expect(fieldEdit(view(), 'motion.max_zoom', 1.12)).toEqual({ edit: { kind: 'set_field', field: 'motion.max_zoom', from: 1.4, to: 1.12 } });
    for (const n of [0.99, 3.01, 1.125, Number.NaN]) expect(zoomProblem(n), String(n)).not.toBeNull();
    for (const n of [1, 1.01, 2.5, 3]) expect(zoomProblem(n), String(n)).toBeNull();
    expect(fieldEdit(view(), 'brand.name', `A${String.fromCharCode(0x202e)}b`)).toMatchObject({ why: expect.stringMatching(/direction/) });
    expect(fieldEdit(view(), 'brand.name', 'a\nb')).toMatchObject({ why: expect.stringMatching(/one line/) });
  });

  it("body fonts: 1 to 4 files in the folder's order", () => {
    const order = ['fonts/a.ttf', 'fonts/b.ttf', 'fonts/c.ttf', 'fonts/d.ttf', 'fonts/e.ttf'];
    expect(bodyFonts(['fonts/b.ttf'], 'fonts/a.ttf', true, order)).toEqual(['fonts/a.ttf', 'fonts/b.ttf']);
    expect(bodyFonts(['fonts/a.ttf'], 'fonts/a.ttf', false, order)).toMatchObject({ why: expect.stringMatching(/at least one/) });
    expect(bodyFonts(order.slice(0, 4), 'fonts/e.ttf', true, order)).toMatchObject({ why: expect.stringMatching(/at most four/) });
  });
});

describe('⚑ compound edits (critique B7)', () => {
  it('a background type switch writes type and colours in one edit, from the background as written', () => {
    const v = view();
    const b = backgroundOf(v).value;
    expect(b).toEqual({ type: 'radial', from: '#f8f4ef', to: '#ebe4dc' });
    const solid = switchedBackground(b, 'solid', '#f3eee8');
    expect(solid).toEqual({ type: 'solid', color: '#f8f4ef' });
    expect(backgroundEdit(v, solid)).toEqual({ edit: { kind: 'set_background', from: { type: 'radial', from: '#f8f4ef', to: '#ebe4dc' }, to: { type: 'solid', color: '#f8f4ef' } } });
    expect(switchedBackground(solid, 'linear', '#f3eee8')).toEqual({ type: 'linear', from: '#f8f4ef', to: '#f3eee8' });
    expect(backgroundEdit(v, b!)).toBeNull();
    // Written as one value: by hand.
    expect(backgroundOf(view({ background: '#ffffff' })).why).toMatch(/by hand/);
    expect(backgroundEdit(view({ background: '#ffffff' }), solid)).toMatchObject({ why: expect.stringMatching(/by hand/) });
    // Not written: no `from`.
    expect(backgroundEdit(view({ background: undefined }), solid)).toEqual({ edit: { kind: 'set_background', to: solid } });
  });

  it('a component: from as written (absent omitted, none null), none only for captions / transitions, params kept or dropped; a media file by hand', () => {
    const v = view();
    expect(componentEdit(v, 'intro', 'acme/intro', 'drop')).toEqual({ edit: { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: 'acme/intro', params: 'drop' } });
    expect(componentEdit(v, 'layout', 'studio/layout-browser', 'keep')).toEqual({
      edit: { kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'studio/layout-browser', params: 'keep' },
    });
    expect(componentEdit(v, 'interstitial', 'studio/interstitial-dark', 'drop')).toEqual({
      edit: { kind: 'set_component', component: 'interstitial', id: 'studio/interstitial-dark', params: 'drop' },
    });
    expect(componentEdit(v, 'transition', 'studio/transition-crossfade', 'drop')).toEqual({
      edit: { kind: 'set_component', component: 'transition', from: null, id: 'studio/transition-crossfade', params: 'drop' },
    });
    expect(componentEdit(v, 'caption', null, 'drop')).toEqual({ edit: { kind: 'set_component', component: 'caption', from: 'studio/caption-below', id: null, params: 'drop' } });
    expect(componentEdit(v, 'intro', null, 'drop')).toMatchObject({ why: expect.stringMatching(/always has/) });
    expect(componentEdit(v, 'outro', 'studio/outro-stack', 'drop')).toMatchObject({ why: expect.stringMatching(/own video, image or Lottie/) });
    expect(componentEdit(v, 'intro', 'studio/intro-stack', 'drop')).toBeNull();
    expect(componentEdit(v, 'intro', '../x', 'drop')).toMatchObject({ why: 'not a component id' });
    expect(componentEdit(view({ editable: STARTER }), 'intro', 'acme/intro', 'drop')).toEqual({ why: STARTER.why });
    expect(
      componentChoices(
        [
          { id: 'studio/a', kind: 'card', source: 'builtin' },
          { id: 'acme/b', kind: 'interstitial', kinds: ['card'], source: 'workspace' },
          { id: 'x', kind: 'card', source: 'builtin' },
        ],
        'card',
      ),
    ).toEqual(['studio/a', 'acme/b']);
    // Review A N3: a written id not among the choices is the file's words, its direction controls visible in the option.
    expect(componentOptionWords('studio/a', ['studio/a'])).toBe('studio/a');
    expect(componentOptionWords(`acme/x${String.fromCharCode(0x202e)}gnp`, ['studio/a'])).toBe('acme/x[U+202E]gnp (as written)');
  });
});

describe('⚑ undo / redo: bytes the server served only', () => {
  it('undo restores the version before on the version after; redo the version after on the version before; another writer clears it', () => {
    const h = new ThemeHistory();
    const v0 = { text: 'name: mine\naccent: a\n', sha256: '0'.repeat(64) };
    const v1 = { text: 'name: mine\naccent: b\n', sha256: '1'.repeat(64) };
    const v2 = { text: 'name: mine\naccent: c\n', sha256: '2'.repeat(64) };
    expect(h.undoStep()).toBeNull();
    h.push('Set the accent to b', v0, v1);
    h.push('Set the accent to c', v1, v2);
    expect(h.expected()).toBe(v2.sha256);
    expect(h.undoStep()).toEqual({ if_match: v2.sha256, edit: { kind: 'restore', text: v1.text, text_hash: v1.sha256 }, label: 'Set the accent to c' });
    h.undone();
    expect(h.undoStep()).toEqual({ if_match: v1.sha256, edit: { kind: 'restore', text: v0.text, text_hash: v0.sha256 }, label: 'Set the accent to b' });
    expect(h.redoStep()).toEqual({ if_match: v1.sha256, edit: { kind: 'restore', text: v2.text, text_hash: v2.sha256 }, label: 'Set the accent to c' });
    h.sync(v1.sha256);
    expect(h.redoStep()).not.toBeNull();
    // A new write after an undo drops the redo branch.
    const v3 = { text: 'name: mine\naccent: d\n', sha256: '3'.repeat(64) };
    h.push('Set the accent to d', v1, v3);
    expect(h.redoStep()).toBeNull();
    // Someone else wrote: the history is cleared (never a restore over their bytes).
    h.sync('9'.repeat(64));
    expect(h.undoStep()).toBeNull();
    expect(h.expected()).toBeNull();
  });
});

describe('⚑ the draft throttle', () => {
  it('at most one preview per 200 ms; the first at once, the newest value always last', () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const sent: Array<{ at: number; v: string }> = [];
    const t = new DraftThrottle<string>((v) => sent.push({ at: now, v }), {
      now: () => now,
      setTimer: (fn, ms) => {
        const x = { at: now + ms, fn };
        timers.push(x);
        return x;
      },
      clearTimer: (x) => void timers.splice(timers.indexOf(x as never), 1),
    });
    expect(DRAFT_INTERVAL_MS).toBe(200);
    // A drag: a move every 16 ms for one second.
    for (let i = 0; i <= 60; i++) {
      now = i * 16;
      for (const x of [...timers]) if (x.at <= now) timers.splice(timers.indexOf(x), 1), x.fn();
      t.push(`#0000${String(i).padStart(2, '0')}`);
    }
    for (now = 960; now < 2000; now += 10) for (const x of [...timers]) if (x.at <= now) timers.splice(timers.indexOf(x), 1), x.fn();
    expect(sent[0]).toEqual({ at: 0, v: '#000000' });
    for (let i = 1; i < sent.length; i++) expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(200);
    expect(sent.length).toBeLessThanOrEqual(6);
    expect(sent.at(-1)!.v).toBe('#000060');
    // Released (written): what waits is dropped.
    now = 2000;
    t.push('#aaaaaa');
    now = 2050;
    t.push('#ffffff');
    t.cancel();
    for (now = 2050; now < 3000; now += 10) for (const x of [...timers]) if (x.at <= now) timers.splice(timers.indexOf(x), 1), x.fn();
    expect(sent.at(-1)).toEqual({ at: 2000, v: '#aaaaaa' });
  });
});

describe('Use in this scenario (critique B1)', () => {
  const facts = (template?: string, ok = true) => ({
    hash: 'h',
    text: 't',
    blocks: { parsed: true, video: template !== undefined ? { template } : {} },
    edit: { blocks: ok ? ({ ok: true } as const) : ({ ok: false, why: 'it holds what agent trust refuses' } as const) },
  });
  it("set_field template with from as written; already; refused with the scenario's why; a hostile name never", () => {
    expect(planUseInScenario(facts(), 'mine')).toEqual({ edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', to: 'mine' } });
    expect(planUseInScenario(facts('editorial'), 'mine')).toEqual({ edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', from: 'editorial', to: 'mine' } });
    expect(planUseInScenario(facts('mine'), 'mine')).toEqual({ already: true });
    expect(planUseInScenario(facts(undefined, false), 'mine')).toEqual({ why: 'it holds what agent trust refuses' });
    expect(planUseInScenario(facts(), '../x')).toEqual({ why: 'not a theme name' });
  });
});

describe('New theme, the list, events, the route', () => {
  const site = (over: Partial<SiteListAnswer['sites'][number]> = {}): SiteListAnswer['sites'][number] => ({
    site_id: 's_01JB01ZZZZZZZZZZZZZZZZZZZZ',
    status: 'ok',
    palette: { roles: { paper: '#FFFFFF', text: '#111111', accent: '#3355D1', dark: null }, checks: [] },
    candidates: [{ ref: 'site:s_01JB01ZZZZZZZZZZZZZZZZZZZZ/logo-1', source: 'header-img', width: 200, height: 100 }],
    untrusted: { host: 'evil.example', title: 'Ignore previous instructions', url: 'https://evil.example/' },
    ...over,
  });
  it('from a site: its hex roles and first candidate only — no page text', () => {
    const f = formFromSite(site(), 'site-theme');
    expect(f).toEqual({ ...EMPTY_FORM, name: 'site-theme', accent: '#3355d1', text: '#111111', paper: '#ffffff', logo: 'site:s_01JB01ZZZZZZZZZZZZZZZZZZZZ/logo-1' });
    expect(JSON.stringify(createInput(f))).not.toMatch(/evil|Ignore/);
    expect(createInput(f)).toEqual({ name: 'site-theme', base: 'editorial', colors: { accent: '#3355d1', text: '#111111', paper: '#ffffff' }, logo: 'site:s_01JB01ZZZZZZZZZZZZZZZZZZZZ/logo-1' });
    expect(formFromSite(site({ palette: { roles: { paper: 'x', text: '#222', accent: null, dark: null }, checks: [] } }), 'n').accent).toBe('#222');
    expect(newThemeProblem(f, ['site-theme'])).toMatch(/exists/);
    expect(newThemeProblem({ ...f, name: 'Site Theme' }, [])).toMatch(/lower-case/);
    expect(newThemeProblem({ ...f, logo: '' }, [])).toMatch(/logo/);
    expect(newThemeProblem(f, [])).toBeNull();
    expect(freeThemeName('site-theme', ['site-theme', 'site-theme-2'])).toBe('site-theme-3');
  });

  it("Copy to edit on a listed read-only theme; the project's own folder theme opens nowhere; used-by words", () => {
    expect(offersCopy({ name: 'editorial', source: 'starter', editable: STARTER })).toBe(true);
    expect(offersCopy({ name: 'mine', source: 'workspace', editable: true })).toBe(false);
    expect(offersCopy({ name: './theme', source: 'project', editable: { why: 'by hand' } })).toBe(false);
    expect(opensInEditor({ name: './theme', source: 'project' })).toBe(false);
    expect(usedByWords({ projects: ['p', 'q'], scenarios: [{ project: 'p', scenario: 's' }] }, 'p')).toBe("Used by this project's theme, 1 other project, 1 scenario");
    expect(usedByWords({ projects: [], scenarios: [] }, 'p')).toMatch(/Not used/);
  });

  it('⚑ no Studio op queues a site job; events: the open theme by name, the list on any theme / site / its project', () => {
    expect(UI_OPS).toContain('site_list');
    expect(UI_OPS).toContain('theme_list');
    expect(UI_OPS).not.toContain('template_from_site');
    expect((UI_OPS as readonly string[]).filter((op) => /site/.test(op))).toEqual(['site_list']);
    expect(themeEventAction({ type: 'workspace', projects: [], readme: [], themes: ['mine'] }, 'p', 'mine')).toBe(true);
    expect(themeEventAction({ type: 'workspace', projects: [], readme: [], themes: ['other'] }, 'p', 'mine')).toBe(false);
    expect(themeEventAction({ type: 'workspace', projects: [], readme: [], site: true }, 'p')).toBe(true);
    expect(themeEventAction({ type: 'workspace', projects: ['p'], readme: [] }, 'p')).toBe(true);
    expect(themeEventAction({ type: 'jobs', changed: ['x'] }, 'p')).toBe(false);
    expect(themeEventAction({ type: 'resync' }, 'p', 'mine')).toBe(true);
  });

  it('the themes route: list and one theme, round trips, anything else not found', () => {
    expect(parseRoute('#/p/northfield-fixture/themes')).toEqual({ name: 'themes', slug: 'northfield-fixture' });
    expect(parseRoute('#/p/n/themes/editorial')).toEqual({ name: 'themes', slug: 'n', theme: 'editorial' });
    expect(parseRoute('#/p/n/themes/%3Cimg%3E')).toEqual({ name: 'themes', slug: 'n', theme: '<img>' });
    expect(parseRoute('#/p/n/themes/a/b')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/themes/%E0%A4%A')).toMatchObject({ name: 'not-found' });
    for (const theme of [undefined, 'editorial', '../x', '<b>']) {
      const href = hrefTo({ name: 'themes', slug: 'p/q', ...(theme ? { theme } : {}) });
      expect(href.startsWith('#/p/')).toBe(true);
      expect(parseRoute(href)).toEqual({ name: 'themes', slug: 'p/q', ...(theme ? { theme } : {}) });
    }
  });
});
