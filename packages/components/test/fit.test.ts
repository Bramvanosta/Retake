/**
 * L4.5 part A: whether a component fits a use as the scenario writes it (fit.ts `componentFit`, critique B7: the
 * timeline shows an option that does not fit disabled with why, and `set_field` refuses it) — on the built-in library
 * and workspace components; and the manifest's `engines.kit` (the guard-rail): a component written for another kit API
 * is not loaded (a registry notice), so its uses fall back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KIT_API_VERSION, componentFit, kitMajorOf, loadComponentRegistry, parseManifest } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { CARD_TSX, cardManifest, tempDir, writeFiles } from './helpers.js';

let root: string;
let cleanup: () => Promise<void>;
let registry: ComponentRegistry;

beforeAll(async () => {
  ({ dir: root, cleanup } = await tempDir());
  await writeFiles(root, {
    'components/acme/title-card/component.yaml': cardManifest('acme/title-card'),
    'components/acme/title-card/index.tsx': CARD_TSX,
    'components/acme/next-card/component.yaml': cardManifest('acme/next-card', 'engines: {kit: "^2"}'),
    'components/acme/next-card/index.tsx': CARD_TSX,
    'components/acme/same-card/component.yaml': cardManifest('acme/same-card', 'engines: {kit: "1"}'),
    'components/acme/same-card/index.tsx': CARD_TSX,
  });
  registry = await loadComponentRegistry({ root });
});
afterAll(() => cleanup?.());

const why = (id: string, use: Parameters<typeof componentFit>[2]) => {
  const r = componentFit(registry, id, use);
  return r.ok ? true : r.why;
};

describe('componentFit (critique B7)', () => {
  it('a card component that shows what the card writes fits; one that drops a slot or lacks a required one does not', () => {
    const use = { kind: 'card' as const, slots: { title: 'From quote to order', kicker: 'Chapter two' } };
    expect(why('studio/card-title', use)).toBe(true);
    expect(why('acme/title-card', use)).toBe(true);
    expect(why('studio/card-testimonial', use)).toBe('does not show slots.title');
    expect(why('studio/card-testimonial', { kind: 'card', slots: { quote: 'Fast.', role: 'Buyer' } })).toBe('needs slots.name');
    expect(why('studio/card-title', { kind: 'card', slots: {} })).toBe('needs slots.title');
  });

  it('params are checked against the new component (an unknown param, a value outside its range)', () => {
    expect(why('acme/title-card', { kind: 'card', slots: { title: 'x' }, params: { align: 'left' } })).toBe(true);
    expect(why('acme/title-card', { kind: 'card', slots: { title: 'x' }, params: { size: 500 } })).toMatch(/^does not take params\.size as written \(must be ≤ 120/);
    expect(why('studio/card-chart', { kind: 'card', slots: { title: 'x' }, params: { align: 'left' } })).toMatch(/^does not take params as written \(unknown key "align"/);
  });

  it('kinds, pages and files: a layout for a multi-page scene shows several pages; a file replaces any component', () => {
    expect(why('studio/caption-overlay', { kind: 'caption' })).toBe(true);
    expect(why('studio/card-title', { kind: 'caption' })).toBe('studio/card-title is a card component, not a caption');
    expect(why('studio/layout-laptop', { kind: 'layout', pages: 1 })).toBe(true);
    expect(why('studio/layout-laptop', { kind: 'layout', pages: 2 })).toBe('shows one page: this scene films 2');
    expect(why('studio/layout-split', { kind: 'layout', pages: 1 })).toBe('shows several pages: this scene films one');
    expect(why('studio/layout-split', { kind: 'layout', pages: 2 })).toBe(true);
    expect(why('studio/card-title', { kind: 'card', slots: { title: 'x' }, file: true })).toBe('a video, image or Lottie file replaces the component here');
    expect(why('acme/nothing', { kind: 'card' })).toMatch(/^component "acme\/nothing" not found/);
  });
});

describe('engines.kit (the guard-rail "engines / kit-API version")', () => {
  it('parses "1" / "^1" (absent = 1); anything else is a manifest error', () => {
    expect(KIT_API_VERSION).toBe(1);
    expect(kitMajorOf({})).toBe(1);
    expect(kitMajorOf({ engines: { kit: '^2' } })).toBe(2);
    expect(parseManifest(cardManifest('acme/a', 'engines: {kit: "^1"}')).manifest?.engines).toEqual({ kit: '^1' });
    for (const bad of ['">=1"', '"1.2"', '"0"', '"x"', '1']) {
      const r = parseManifest(cardManifest('acme/a', `engines: {kit: ${bad}}`));
      expect(r.manifest, bad).toBeUndefined();
      expect(r.issues.some((i) => i.path.join('.') === 'engines.kit'), bad).toBe(true);
    }
  });

  it('a component written for another kit API is not loaded: a registry notice, its uses fall back', () => {
    expect(registry.has('acme/same-card')).toBe(true);
    expect(registry.has('acme/next-card')).toBe(false);
    const notice = registry.notices.find((n) => n.id === 'acme/next-card');
    expect(notice?.message).toBe('component acme/next-card needs kit API 2 (engines.kit "^2"): this Demo Studio provides kit API 1 — use a version of the component written for it');
    expect(() => registry.resolve('acme/next-card', 'card')).toThrow(/needs kit API 2/);
    expect(why('acme/next-card', { kind: 'card', slots: { title: 'x' } })).toMatch(/needs kit API 2/);
    expect(registry.list('card').map((i) => i.manifest.id)).not.toContain('acme/next-card');
  });
});
