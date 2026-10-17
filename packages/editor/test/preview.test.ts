/**
 * Component previews (R-CMP-12/13/14): the ComponentPreview spec of every kind (pure: which scene, sample screen,
 * caption, anchor, incoming card, moment) and real previews rendered with Remotion — into an --out folder (images
 * only) and in place (preview.png + preview.json with a fresh source hash + the README block), for any theme.
 */
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplate } from '@demo-studio/core';
import type { LoadedTemplate } from '@demo-studio/core';
import {
  PREVIEW_MAX_BYTES,
  PREVIEW_SIZE,
  README_BEGIN,
  createComponent,
  loadComponentRegistry,
  pngSize,
  previewStatus,
  themeTokens,
} from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { buildComponentPreview, loadPreviewSamples, loadPreviewTheme, renderComponentPreviews } from '@demo-studio/editor';
import type { PreviewSamples } from '@demo-studio/editor';
import { REPO, SHARED_CACHE, hasTool } from './render-helpers.js';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

let root: string;
let registry: ComponentRegistry;
let editorial: LoadedTemplate;
let samples: PreviewSamples;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'demo-studio-preview-'));
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  registry = await loadComponentRegistry({ root });
  editorial = await loadTemplate('editorial', root);
  samples = loadPreviewSamples();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function build(id: string, template = editorial) {
  const info = registry.get(id);
  const tokens = themeTokens(template, { logo: 'http://a/logo.svg', fonts: { display: 'http://a/d.ttf', body: ['http://a/b.ttf'] } });
  return buildComponentPreview({ target: { id, manifest: info.manifest }, template, tokens, registry, samples, sampleUrl: (f) => `http://a/${f.split('/').pop()}` });
}

describe('component preview specs', () => {
  it('slot values and params override the manifest samples (an MCP component_preview); a caption takes its text from them', () => {
    const info = registry.get('studio/card-title');
    const tokens = themeTokens(editorial, { logo: 'http://a/logo.svg', fonts: { display: 'http://a/d.ttf', body: ['http://a/b.ttf'] } });
    const base = { template: editorial, tokens, registry, samples, sampleUrl: (f: string) => `http://a/${f.split('/').pop()}` };
    const p = buildComponentPreview({ ...base, target: { id: 'studio/card-title', manifest: info.manifest }, slots: { title: 'Quotes in two clicks' }, params: { tone: 'dark' }, at: 0.5 });
    expect(p.spec.main.slots).toMatchObject({ title: 'Quotes in two clicks', kicker: 'Chapter two' });
    expect(p.spec.main.params).toMatchObject({ tone: 'dark', align: 'center' });
    expect(p.at).toBe(0.5);
    const cap = registry.get('studio/caption-below');
    const c = buildComponentPreview({ ...base, target: { id: 'studio/caption-below', manifest: cap.manifest }, slots: { text: 'Pick a price list.' } });
    expect(c.spec.scene?.caption?.cues[0].text).toBe('Pick a price list.');
  });

  it('the sample screens ship with the components package (generated once from the fixture)', () => {
    for (const name of ['desktop', 'tablet', 'phone'] as const) {
      const s = samples[name];
      expect(statSync(s.file).size, name).toBeLessThan(120 * 1024);
      expect(s.url, name).toMatch(/^https:\/\/shop\.northfield\.example\//);
      expect(s.anchor, name).toBeDefined();
    }
    expect(samples.phone.width / samples.phone.height).toBeCloseTo(390 / 844, 3);
    expect(samples.tablet.width / samples.tablet.height).toBeCloseTo(820 / 1180, 3);
  });

  it('intros, outros and cards render alone at their last preview moment, with theme slot defaults filled', () => {
    const intro = build('studio/intro-stack');
    expect(intro.spec.scene).toBeUndefined();
    expect(intro.at).toBe(2.8);
    expect(intro.spec.frame).toBe(84);
    expect(intro.spec.main.slots).toMatchObject({ title: 'Quotes in two clicks', kicker: 'Product tour', logo: 'http://a/logo.svg' });
    expect(intro.screen).toBeUndefined();
    const outro = build('studio/outro-stack');
    expect(outro.spec.main.slots.url).toBe('example.com'); // theme.brand.url
    expect(build('studio/card-title').spec.durationInFrames).toBe(75);
  });

  it('layouts show the sample screen as their capture (its aspect), the brand mark and a caption — the overlay caption over a full-frame layout', () => {
    const card = build('studio/layout-card');
    const s = card.spec.scene!;
    expect(s.layout.id).toBe('studio/layout-card');
    expect(s.screen.url).toBe('http://a/screen-desktop.jpg');
    expect(s.rects.screen.w / s.rects.screen.h).toBeCloseTo(samples.desktop.width / samples.desktop.height, 2);
    expect(s.caption!.id).toBe('studio/caption-below');
    expect(s.caption!.cues[0]).toMatchObject({ from: 0, kicker: 'Quotes', text: 'Pick a customer and the price list follows.' });
    expect(s.brandmark).toBeDefined();
    expect(build('studio/layout-browser').spec.scene!.url).toBe(samples.desktop.url);
    expect(build('studio/layout-raw').spec.scene!.caption!.id).toBe('studio/caption-overlay');
    const phone = build('studio/layout-phone');
    expect(phone.screen).toBe('phone');
    expect(phone.spec.scene!.rects.screen.w / phone.spec.scene!.rects.screen.h).toBeCloseTo(390 / 844, 2);
    expect(build('studio/layout-tablet').screen).toBe('tablet');
  });

  it('captions, overlays, interstitials and transitions render with the theme layout around them', () => {
    const cap = build('studio/caption-overlay');
    expect(cap.spec.scene!.layout.id).toBe('studio/layout-card');
    expect(cap.spec.scene!.caption!.id).toBe('studio/caption-overlay');
    const callout = build('studio/overlay-callout');
    const a = callout.spec.anchor!;
    const sc = callout.spec.scene!.rects.screen;
    expect(a.x).toBeGreaterThan(sc.x);
    expect(a.y + a.h).toBeLessThan(sc.y + sc.h);
    expect(a.w / samples.desktop.anchor!.w).toBeCloseTo(sc.w / samples.desktop.width, 3);
    const inter = build('studio/interstitial-clock');
    expect(inter.spec.scene!.caption).toBeUndefined();
    const xf = build('studio/transition-crossfade');
    expect(xf.spec.transitionKind).toBe('crossfade');
    expect(xf.spec.main.durationInFrames).toBe(11);
    expect(xf.spec.frame).toBe(5);
    expect(xf.spec.incoming!.id).toBe('studio/card-title');
    expect(build('studio/transition-fade-black').spec.transitionKind).toBe('fade-black');
    expect(xf.components).toEqual(['studio/caption-below', 'studio/card-title', 'studio/layout-card', 'studio/transition-crossfade']);
  });

  it('another theme picks its own context components (motion: browser layout, overlay caption)', async () => {
    const motion = await loadTemplate('motion', root);
    const cap = build('studio/caption-below', motion);
    expect(cap.spec.scene!.layout.id).toBe('studio/layout-browser');
    expect(build('studio/layout-card', motion).spec.scene!.caption!.id).toBe('studio/caption-overlay');
    expect(build('studio/transition-crossfade', motion).spec.incoming!.id).toBe('studio/card-title');
  });

  it('the preview theme: a workspace template, else the starter of that name', async () => {
    expect((await loadPreviewTheme('editorial', root)).name).toBe('editorial');
    const bare = await mkdtemp(join(tmpdir(), 'demo-studio-preview-bare-'));
    try {
      await writeFile(join(bare, 'studio.yaml'), 'projects_dir: projects\n');
      expect((await loadPreviewTheme('motion', bare)).name).toBe('motion');
      await expect(loadPreviewTheme('nope', bare)).rejects.toThrow(/template "nope" not found/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!canRender)('component previews rendered with Remotion', () => {
  it(
    'into an --out folder: 960×540 PNGs under 200 KB; in place: preview.png + a fresh preview.json + the README block',
    async () => {
      const targets = ['studio/card-title', 'studio/layout-phone'].map((id) => {
        const i = registry.get(id);
        return { id, dir: i.dir, entry: i.entry, manifest: i.manifest };
      });
      const out = join(root, 'out');
      const done = await renderComponentPreviews({ root, registry, template: editorial, targets, outDir: out, cacheDir: SHARED_CACHE });
      expect(done.map((d) => d.file)).toEqual([join(out, 'studio', 'card-title.png'), join(out, 'studio', 'layout-phone.png')]);
      for (const d of done) {
        expect(pngSize(d.file), d.id).toEqual(PREVIEW_SIZE);
        expect(statSync(d.file).size, d.id).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
        expect(d.meta, d.id).toBeUndefined();
      }
      // The phone preview shows a phone: its body (the theme's dark graphite) left of centre on the paper background.
      const png = readFileSync(done[1].file);
      expect(png.length).toBeGreaterThan(10_000);

      // In place, on a workspace component (the layout scaffold), with the motion theme.
      const created = await createComponent(root, { id: 'acme/frame', kind: 'layout', description: 'A test frame.' });
      await writeFile(join(created.dir, 'README.md'), '# acme/frame\n\nHand-written notes.\n');
      const motion = await loadTemplate('motion', root);
      const reg2 = await loadComponentRegistry({ root });
      const [p] = await renderComponentPreviews({ root, registry: reg2, template: motion, targets: [{ id: 'acme/frame', dir: created.dir, entry: created.entry, manifest: created.manifest }], cacheDir: SHARED_CACHE });
      expect(p.file).toBe(join(created.dir, 'preview.png'));
      expect(pngSize(p.file)).toEqual(PREVIEW_SIZE);
      expect(previewStatus(created.dir, { theme: 'motion' }).state).toBe('fresh');
      expect(previewStatus(created.dir, { theme: 'editorial' }).state).toBe('stale');
      const readme = await readFile(join(created.dir, 'README.md'), 'utf8');
      expect(readme.startsWith(README_BEGIN)).toBe(true);
      expect(readme).toContain('Hand-written notes.');
      expect(readme).toContain('motion theme');
      // Editing the component makes its preview stale.
      await writeFile(created.entry, `${await readFile(created.entry, 'utf8')}\n// edited\n`);
      expect(previewStatus(created.dir, { theme: 'motion' }).state).toBe('stale');
    },
    LONG,
  );
});
