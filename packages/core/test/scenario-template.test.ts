import { afterEach, describe, expect, it } from 'vitest';
import { TemplateError, normalizeStep, templateSceneEntry, templateVideo } from '@demo-studio/core';
import type { CardScene, InterstitialScene, Scene, TemplateContext } from '@demo-studio/core';

const ctx: TemplateContext = {
  pages: { shop: 'http://localhost:4402' },
  vars: { customer: 'Harbour Coffee Co.', row: '#row-1', field: 'Work email', email: 'noa@cafe-lumen.example' },
  hooks: { quote: { json: { id: 'q-7' } } },
  run: { id: '20261013-101500-signup', dir: '/runs/20261013-101500-signup' },
};

describe('templateSceneEntry (R-RUN-16)', () => {
  afterEach(() => {
    delete process.env.DEMO_STUDIO_TEST_PASSWORD;
  });

  it('templates every string of a scene: arguments, targets, waits, captions, overlays, pages, the scene cursor', () => {
    const scene: Scene = {
      id: 'orders',
      caption: { kicker: '{{vars.customer}}', text: 'Run {{run.id}}' },
      open: '/orders?q={{vars.customer}}',
      cursor: { text: '{{vars.customer}}' },
      tutorial: { spotlight: true },
      steps: [
        { type: { into: { label: '{{vars.field}}' }, text: '{{vars.email}}' } },
        { click: '{{vars.row}}' },
        { click: '{{vars.customer}}', caption: 'Open {{vars.customer}}' },
        { select: { field: '{{vars.field}}', option: '{{vars.customer}}', search: '{{vars.customer}}' } },
        { menu: { row: '{{vars.customer}}', item: 'Archive {{vars.customer}}', confirm: 'Archive' } },
        { wait_for: { text: '{{vars.customer}} — opened', url: '/orders/{{hooks.quote.json.id}}' } },
        { assert: { not_text: 'No {{vars.customer}}' } },
        { new_tab: '{{shop}}/quotes' },
        { notify: { title: '{{vars.customer}}', message: 'Quote {{hooks.quote.json.id}}' } },
        { emit: { name: 'quote', data: { customer: '{{vars.customer}}', ids: ['{{hooks.quote.json.id}}'] } } },
        { wait_for_email: { to: '{{vars.email}}', as: 'welcome' } },
        { click: 'Save', overlay: { component: 'studio/callout', slots: { text: 'Saved for {{vars.customer}}' }, target: { text: '{{vars.customer}}' } } },
        { hover: 'Save', camera: { zoom: 1.4, target: { text: '{{vars.customer}}' } } },
      ],
    };
    const out = templateSceneEntry(scene, 2, ctx);
    expect(out.caption).toEqual({ kicker: 'Harbour Coffee Co.', text: 'Run 20261013-101500-signup' });
    expect(out.open).toBe('/orders?q=Harbour Coffee Co.');
    expect(out.cursor).toEqual({ text: 'Harbour Coffee Co.' });
    const steps = out.steps.map((s, i) => normalizeStep(s, i));
    expect(steps[0].args).toEqual({ into: { label: 'Work email' }, text: 'noa@cafe-lumen.example' });
    // A string target is normalised after templating: a value that looks like CSS is a CSS target, else text.
    expect(steps[1].args).toEqual({ css: '#row-1' });
    expect(steps[2].args).toEqual({ text: 'Harbour Coffee Co.' });
    expect(steps[2].caption).toBe('Open Harbour Coffee Co.');
    expect(steps[3].args).toEqual({ field: 'Work email', option: 'Harbour Coffee Co.', search: 'Harbour Coffee Co.' });
    expect(steps[4].args).toEqual({ row: 'Harbour Coffee Co.', item: 'Archive Harbour Coffee Co.', confirm: 'Archive' });
    expect(steps[5].args).toEqual({ text: 'Harbour Coffee Co. — opened', url: '/orders/q-7' });
    expect(steps[6].args).toEqual({ not_text: 'No Harbour Coffee Co.' });
    // The new_tab shorthand sees the value: a URL is an href.
    expect(steps[7].args).toEqual({ href: 'http://localhost:4402/quotes' });
    expect(steps[8].args).toEqual({ title: 'Harbour Coffee Co.', message: 'Quote q-7' });
    expect(steps[9].args).toEqual({ name: 'quote', data: { customer: 'Harbour Coffee Co.', ids: ['q-7'] } });
    expect(steps[10].args).toEqual({ to: 'noa@cafe-lumen.example', as: 'welcome' });
    expect(steps[11].overlay).toMatchObject({ slots: { text: 'Saved for Harbour Coffee Co.' }, target: { text: 'Harbour Coffee Co.' } });
    expect(steps[12].camera).toEqual({ zoom: 1.4, target: { text: 'Harbour Coffee Co.' } });
    // The scenario object itself is untouched.
    expect(scene.open).toBe('/orders?q={{vars.customer}}');
  });

  it('leaves notes, eval (templated when it runs) and the emit / screenshot names as written', () => {
    const scene: Scene = {
      id: 'misc',
      note: 'uses {{vars.customer}}',
      steps: [
        { emit: '{{vars.customer}}' },
        { emit: { name: '{{vars.customer}}', data: '{{vars.customer}}' } },
        { screenshot: { name: 'orders-{{vars.customer}}' } },
        { eval: { js: 'return {{vars.customer}}', arg: '{{vars.customer}}' } },
        { click: 'Save', note: 'not {{templated}}' },
        { screenshot: '{{vars.customer}}' },
      ],
    };
    const out = templateSceneEntry(scene, 0, ctx);
    expect(out.note).toBe('uses {{vars.customer}}');
    expect(out.steps[0]).toEqual({ emit: '{{vars.customer}}' });
    expect(out.steps[1]).toEqual({ emit: { name: '{{vars.customer}}', data: 'Harbour Coffee Co.' } });
    expect(out.steps[2]).toEqual({ screenshot: { name: 'orders-{{vars.customer}}' } });
    expect(out.steps[3]).toEqual({ eval: { js: 'return {{vars.customer}}', arg: '{{vars.customer}}' } });
    expect(out.steps[4]).toEqual({ click: 'Save', note: 'not {{templated}}' });
    expect(out.steps[5]).toEqual({ screenshot: '{{vars.customer}}' });
  });

  it('templates multi-page scenes (open and label), cards and interstitials', () => {
    const scene: Scene = {
      id: 'both',
      pages: { buyer: { page: 'shop', open: '/q/{{hooks.quote.json.id}}', label: '{{vars.customer}}' } },
      steps: [],
    };
    expect(templateSceneEntry(scene, 0, ctx).pages).toEqual({ buyer: { page: 'shop', open: '/q/q-7', label: 'Harbour Coffee Co.' } });
    const list: Scene = { id: 'list', pages: ['shop', { page: 'shop', open: '/x/{{vars.customer}}', label: 'L {{run.id}}' }], steps: [] };
    expect(templateSceneEntry(list, 0, ctx).pages).toEqual(['shop', { page: 'shop', open: '/x/Harbour Coffee Co.', label: 'L 20261013-101500-signup' }]);
    const card: CardScene = { card: { component: 'studio/card-title', slots: { title: 'Welcome, {{vars.customer}}' } } };
    expect(templateSceneEntry(card, 1, ctx).card.slots).toEqual({ title: 'Welcome, Harbour Coffee Co.' });
    const inter: InterstitialScene = { interstitial: { text: '{{vars.customer}}, a day later' } };
    expect(templateSceneEntry(inter, 2, ctx).interstitial.text).toBe('Harbour Coffee Co., a day later');
  });

  it('resolves secret references in steps through the context, and names the string of an unknown key', () => {
    process.env.DEMO_STUDIO_TEST_PASSWORD = 'S3cret-pw-42';
    const scene: Scene = { id: 'login', steps: [{ type: { into: { label: 'Password' }, text: '{{env:DEMO_STUDIO_TEST_PASSWORD}}' } }] };
    expect(templateSceneEntry(scene, 0, ctx).steps[0]).toEqual({ type: { into: { label: 'Password' }, text: 'S3cret-pw-42' } });
    const viaResolver = templateSceneEntry(
      { id: 'kc', steps: [{ type: '{{keychain:demo-test/agent}}' }] } as Scene,
      0,
      { ...ctx, secrets: (ref) => (ref === 'keychain:demo-test/agent' ? 'kc-value-1' : undefined) },
    );
    expect(viaResolver.steps[0]).toEqual({ type: 'kc-value-1' });
    const bad: Scene = { id: 'bad', steps: [{ wait: 1 }, { type: { text: '{{vars.nope}}' } }] };
    expect(() => templateSceneEntry(bad, 3, ctx)).toThrow(TemplateError);
    expect(() => templateSceneEntry(bad, 3, ctx)).toThrow(/^scenes\[3\]\.steps\[1\]\.type\.text: unknown template key \{\{vars\.nope\}\}/);
  });
});

describe('templateVideo', () => {
  it('templates the title, intro, outro and tutorial switches, and nothing else', () => {
    const out = templateVideo(
      {
        title: { kicker: 'For {{vars.customer}}', text: 'Quotes' },
        outro: { tagline: 'See you, {{vars.customer}}' },
        tutorial: { spotlight: true },
        frame: 'card',
        template: 'editorial',
      },
      ctx,
    );
    expect(out).toEqual({
      title: { kicker: 'For Harbour Coffee Co.', text: 'Quotes' },
      outro: { tagline: 'See you, Harbour Coffee Co.' },
      tutorial: { spotlight: true },
      frame: 'card',
      template: 'editorial',
    });
    expect(() => templateVideo({ title: { text: '{{hooks.missing.id}}' } }, ctx)).toThrow(/^title\.text: unknown template key \{\{hooks\.missing\.id\}\}/);
  });
});
