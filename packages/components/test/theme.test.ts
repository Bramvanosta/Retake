import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, PERSON_POLICY } from '@retake/core';
import { loadTemplate, fileFacts } from '@retake/core/io';
import type { LoadedTemplate } from '@retake/core';
import { LOGO_WORDMARK_ASPECT, fontFileFace, fontFileRange, fontWeightDescriptor, resolveLogoKind, themeFontFamilies, themeTokens, weightCovers } from '@retake/components';

/** The repository is a workspace: its starter templates. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('themeTokens (R-REG-11)', () => {
  it('maps a loaded template to the tokens components read', async () => {
    const editorial = await loadTemplate('editorial', ROOT, { files: fileFacts(PERSON_POLICY) });
    const t = themeTokens(editorial, {
      logo: 'http://assets.local/editorial/logo.svg',
      wordmark: 'http://assets.local/editorial/wordmark.svg',
      fonts: { display: 'http://assets.local/f/display.ttf', body: ['http://assets.local/f/r.ttf', 'http://assets.local/f/sb.ttf', 'http://assets.local/f/b.ttf'] },
    });
    const tpl = editorial.template;
    expect(t).toMatchObject({
      name: 'editorial',
      colors: tpl.colors,
      background: tpl.background,
      fonts: { display: 'retake-editorial-display', body: 'retake-editorial-body' },
      logo: { url: 'http://assets.local/editorial/logo.svg' },
      wordmark: { url: 'http://assets.local/editorial/wordmark.svg', text: tpl.brand?.name },
      brand: { name: tpl.brand?.name, url: 'example.com' },
      cursor: { ripple_color: tpl.cursor.ripple_color },
      style_bias: 'real',
      brandmark: { position: 'bottom-right', size: 30 },
      motion: { zoom_ease: [0.45, 0, 0.2, 1] },
    });
    expect(t.font_faces).toEqual([
      { family: 'retake-editorial-display', url: 'http://assets.local/f/display.ttf', weight: 400, style: 'normal' },
      { family: 'retake-editorial-body', url: 'http://assets.local/f/r.ttf', weight: 400, style: 'normal' },
      { family: 'retake-editorial-body', url: 'http://assets.local/f/sb.ttf', weight: 600, style: 'normal' },
      { family: 'retake-editorial-body', url: 'http://assets.local/f/b.ttf', weight: 700, style: 'normal' },
    ]);
    // Caption styles: colour keys resolved to CSS colours, fonts to family names.
    expect(t.captions).toEqual({
      kicker: { font: 'retake-editorial-body', weight: 600, size: 15, uppercase: true, color: tpl.colors.accent, letter_spacing: 0.14 },
      line: { font: 'retake-editorial-display', size: 38, color: tpl.colors.text },
    });
    // Tokens are copies: editing them does not touch the template.
    t.colors.accent = '#000000';
    expect(editorial.template.colors.accent).not.toBe('#000000');
  });

  it('without asset URLs: no logo, the wordmark is the brand name as text, no font faces', async () => {
    const motion = await loadTemplate('motion', ROOT, { files: fileFacts(PERSON_POLICY) });
    const t = themeTokens(motion);
    expect(t.logo).toBeUndefined();
    expect(t.wordmark).toEqual({ text: motion.template.brand?.name });
    expect(t.font_faces).toBeUndefined();
    expect(t.style_bias).toBe(motion.template.style_bias);
    expect(t.fonts).toEqual(themeFontFamilies('motion'));
  });

  it('a template without brand has no wordmark text', () => {
    const loaded: LoadedTemplate = {
      name: 'My Theme!',
      dir: '/x',
      template: { ...structuredClone(DEFAULT_TEMPLATE), name: undefined, brand: undefined, wordmark: undefined },
      assets: { logo: '/x/logo.svg', display: '/x/d.ttf', body: ['/x/b.ttf'] },
    };
    const t = themeTokens(loaded);
    expect(t.wordmark).toBeUndefined();
    expect(t.brand).toEqual({});
    expect(t.fonts).toEqual({ display: 'retake-my-theme-display', body: 'retake-my-theme-body' });
  });

  it('logo kind: an explicit logo_kind wins; absent, 3:1 and wider is a wordmark, narrower or unknown a mark', () => {
    expect(LOGO_WORDMARK_ASPECT).toBe(3);
    expect(resolveLogoKind(undefined, 3)).toBe('wordmark');
    expect(resolveLogoKind(undefined, 11.3149)).toBe('wordmark');
    expect(resolveLogoKind(undefined, 2.99)).toBe('mark');
    expect(resolveLogoKind(undefined, 1)).toBe('mark');
    expect(resolveLogoKind(undefined, undefined)).toBe('mark');
    expect(resolveLogoKind('mark', 11.3)).toBe('mark');
    expect(resolveLogoKind('wordmark', 1)).toBe('wordmark');
    expect(resolveLogoKind('wordmark', undefined)).toBe('wordmark');
  });

  it("the logo token carries a wordmark's kind and aspect (a mark stays {url}); brand.name still feeds the wordmark text and the logo's alt", async () => {
    const editorial = await loadTemplate('editorial', ROOT, { files: fileFacts(PERSON_POLICY) });
    const at = (aspect: number | undefined, logo_kind?: 'mark' | 'wordmark'): LoadedTemplate => ({
      ...editorial,
      template: { ...editorial.template, ...(logo_kind ? { logo_kind } : {}) },
      assets: { ...editorial.assets, ...(aspect !== undefined ? { logo_aspect: aspect } : { logo_aspect: undefined }) },
    });
    const urls = { logo: 'http://assets.local/logo.png' };
    expect(themeTokens(at(1), urls).logo).toEqual({ url: urls.logo });
    expect(themeTokens(at(2.99), urls).logo).toEqual({ url: urls.logo });
    expect(themeTokens(at(3), urls).logo).toEqual({ url: urls.logo, kind: 'wordmark', aspect: 3 });
    expect(themeTokens(at(11.3149, 'mark'), urls).logo).toEqual({ url: urls.logo });
    expect(themeTokens(at(undefined, 'wordmark'), urls).logo).toEqual({ url: urls.logo, kind: 'wordmark' });
    const wide = themeTokens(at(11.3149), urls);
    expect(wide.wordmark?.text).toBe(editorial.template.brand?.name);
    expect(wide.brand.name).toBe(editorial.template.brand?.name);
  });

  it('fontFileFace reads wght200-800 as a range (italic too); a family word, a plain weight or a token elsewhere never reads as one', () => {
    expect(fontFileFace('fonts/body-wght200-800.woff2')).toEqual({ weight: [200, 800], style: 'normal' });
    expect(fontFileFace('/abs/templates/x/fonts/body-wght300-700Italic.ttf')).toEqual({ weight: [300, 700], style: 'italic' });
    expect(fontFileFace('Brand_wght100-900.woff2')).toEqual({ weight: [100, 900], style: 'normal' });
    expect(fontFileFace('wght200-800.ttf')).toEqual({ weight: [200, 800], style: 'normal' });
    // Not a range: min above max, a weight that is no hundred, the token before another word, a family named Wght.
    expect(fontFileRange('body-wght800-200.ttf')).toBeNull();
    expect(fontFileRange('body-wght250-800.ttf')).toBeNull();
    expect(fontFileRange('body-wght200-800-Bold.ttf')).toBeNull();
    expect(fontFileFace('body-wght200-800-Bold.ttf')).toEqual({ weight: 700, style: 'normal' });
    expect(fontFileFace('Wghtline-SemiBold.ttf')).toEqual({ weight: 600, style: 'normal' });
    expect(fontFileFace('fonts/body-Regular.ttf')).toEqual({ weight: 400, style: 'normal' });
    // The @font-face descriptor of each, and which weights a face serves.
    expect(fontWeightDescriptor([200, 800])).toBe('200 800');
    expect(fontWeightDescriptor(600)).toBe('600');
    expect(weightCovers([200, 800], 200)).toBe(true);
    expect(weightCovers([200, 800], 800)).toBe(true);
    expect(weightCovers([200, 800], 900)).toBe(false);
    expect(weightCovers(600, 600)).toBe(true);
    expect(weightCovers(600, 700)).toBe(false);
  });

  it('a variable body font becomes one font face over its range', async () => {
    const editorial = await loadTemplate('editorial', ROOT, { files: fileFacts(PERSON_POLICY) });
    const vf: LoadedTemplate = { ...editorial, assets: { ...editorial.assets, body: ['/t/fonts/body-wght200-800.woff2'] } };
    const t = themeTokens(vf, { fonts: { display: 'http://assets.local/d.ttf', body: ['http://assets.local/b.woff2'] } });
    expect(t.font_faces?.[1]).toEqual({ family: 'retake-editorial-body', url: 'http://assets.local/b.woff2', weight: [200, 800], style: 'normal' });
  });

  it('fontFileFace infers weight and style from the file name', () => {
    expect(fontFileFace('fonts/Inter-Regular.ttf')).toEqual({ weight: 400, style: 'normal' });
    expect(fontFileFace('Inter-SemiBold.ttf')).toEqual({ weight: 600, style: 'normal' });
    expect(fontFileFace('Inter-ExtraBold.woff2')).toEqual({ weight: 800, style: 'normal' });
    expect(fontFileFace('Inter-Bold.ttf')).toEqual({ weight: 700, style: 'normal' });
    expect(fontFileFace('Inter-ExtraLight.ttf')).toEqual({ weight: 200, style: 'normal' });
    expect(fontFileFace('Inter-Light-Italic.otf')).toEqual({ weight: 300, style: 'italic' });
    expect(fontFileFace('Grotesk-Black.ttf')).toEqual({ weight: 900, style: 'normal' });
    expect(fontFileFace('Serif-MediumItalic.ttf')).toEqual({ weight: 500, style: 'italic' });
    expect(fontFileFace('InstrumentSerif-Regular.ttf')).toEqual({ weight: 400, style: 'normal' });
  });
});
