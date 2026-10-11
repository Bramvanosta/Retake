import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, loadTemplate } from '@demo-studio/core';
import type { LoadedTemplate } from '@demo-studio/core';
import { fontFileFace, themeFontFamilies, themeTokens } from '@demo-studio/components';

/** The repository is a workspace: its starter templates. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('themeTokens (R-REG-11)', () => {
  it('maps a loaded template to the tokens components read', async () => {
    const editorial = await loadTemplate('editorial', ROOT);
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
      fonts: { display: 'ds-editorial-display', body: 'ds-editorial-body' },
      logo: { url: 'http://assets.local/editorial/logo.svg' },
      wordmark: { url: 'http://assets.local/editorial/wordmark.svg', text: tpl.brand?.name },
      brand: { name: tpl.brand?.name, url: 'example.com' },
      cursor: { ripple_color: tpl.cursor.ripple_color },
      style_bias: 'real',
      brandmark: { position: 'bottom-right', size: 30 },
      motion: { zoom_ease: [0.45, 0, 0.2, 1] },
    });
    expect(t.font_faces).toEqual([
      { family: 'ds-editorial-display', url: 'http://assets.local/f/display.ttf', weight: 400, style: 'normal' },
      { family: 'ds-editorial-body', url: 'http://assets.local/f/r.ttf', weight: 400, style: 'normal' },
      { family: 'ds-editorial-body', url: 'http://assets.local/f/sb.ttf', weight: 600, style: 'normal' },
      { family: 'ds-editorial-body', url: 'http://assets.local/f/b.ttf', weight: 700, style: 'normal' },
    ]);
    // Caption styles: colour keys resolved to CSS colours, fonts to family names.
    expect(t.captions).toEqual({
      kicker: { font: 'ds-editorial-body', weight: 600, size: 15, uppercase: true, color: tpl.colors.accent, letter_spacing: 0.14 },
      line: { font: 'ds-editorial-display', size: 35, color: tpl.colors.text },
    });
    // Tokens are copies: editing them does not touch the template.
    t.colors.accent = '#000000';
    expect(editorial.template.colors.accent).not.toBe('#000000');
  });

  it('without asset URLs: no logo, the wordmark is the brand name as text, no font faces', async () => {
    const motion = await loadTemplate('motion', ROOT);
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
    expect(t.fonts).toEqual({ display: 'ds-my-theme-display', body: 'ds-my-theme-body' });
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
