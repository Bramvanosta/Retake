import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  Background,
  CAMERA_EASINGS,
  EASINGS,
  EASING_CURVES,
  FitText,
  Logo,
  SafeArea,
  Wordmark,
  WORDMARK_TEXT_SCALE,
  activeIndex,
  backgroundCss,
  balanceLines,
  contrastRatio,
  readableOn,
  buttonColors,
  inkOn,
  roundTo,
  clamp,
  cssFontFamily,
  cubicBezier,
  darkLight,
  easing,
  estimateTextWidth,
  fade,
  fadeIn,
  fadeOut,
  fitText,
  lerp,
  luminance,
  measureText,
  progress,
  rise,
  safeAreaRect,
  scaleRect,
  stagger,
  textStyleCss,
  themeEasing,
  toFrames,
  toSeconds,
  withAlpha,
  wrapText,
} from '@retake/components/kit';
import type { TextMeasurer } from '@retake/components/kit';
import { addressParts, captionBandBox, cardShadow, contrastRatio as contrast, deviceTones, liftToContrast } from '@retake/components/kit';
import { DARK, LIGHT } from './helpers.js';

// remotion's <Img> needs a composition context; outside one, render a plain <img>.
vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return { ...actual, Img: (props: Record<string, unknown>) => h('img', props) };
});

describe('kit easing (R-CMP-07)', () => {
  it('cubicBezier matches CSS: endpoints, symmetry, known values, monotonic presets', () => {
    const inOut = cubicBezier(0.42, 0, 0.58, 1);
    expect(inOut(0)).toBe(0);
    expect(inOut(1)).toBe(1);
    expect(inOut(0.5)).toBeCloseTo(0.5, 5);
    expect(inOut(0.25) + inOut(0.75)).toBeCloseTo(1, 5);
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3); // CSS `ease` at 50 %
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 6);
    expect(inOut(-1)).toBe(0);
    expect(inOut(2)).toBe(1);
    for (const [name, fn] of Object.entries(EASINGS)) {
      let prev = -Infinity;
      for (let i = 0; i <= 50; i++) {
        const v = fn(i / 50);
        if (name !== 'exit') expect(v, `${name} ${i}`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
      expect(fn(1), name).toBe(1);
    }
    expect(Object.keys(EASING_CURVES)).toEqual(expect.arrayContaining(['linear', 'standard', 'entrance', 'exit', 'gentle']));
    expect(CAMERA_EASINGS.slow).toEqual([0.45, 0, 0.2, 1]);
  });

  it('easing() accepts names, control points and functions; themeEasing uses the template zoom_ease', () => {
    expect(easing('linear')(0.3)).toBeCloseTo(0.3, 6);
    expect(easing([0.42, 0, 0.58, 1])(0.5)).toBeCloseTo(0.5, 5);
    const f = (t: number) => t * t;
    expect(easing(f)).toBe(f);
    expect(() => easing('wobble' as never)).toThrow(/unknown easing "wobble"/);
    expect(themeEasing(DARK)(0.5)).toBeCloseTo(cubicBezier(0.2, 0, 0, 1)(0.5), 9);
    expect(themeEasing({})(0.5)).toBeCloseTo(cubicBezier(0.45, 0, 0.2, 1)(0.5), 9);
  });
});

describe('kit motion: frame-driven, deterministic', () => {
  it('progress / fades / rise / stagger from frame + fps', () => {
    expect(progress(0, 30, { duration: 1, ease: 'linear' })).toBe(0);
    expect(progress(15, 30, { duration: 1, ease: 'linear' })).toBeCloseTo(0.5);
    expect(progress(30, 30, { delay: 0.5, duration: 1, ease: 'linear' })).toBeCloseTo(0.5);
    expect(progress(10, 30, { delay: 1 })).toBe(0);
    expect(progress(60, 30, { duration: 0 })).toBe(1);
    expect(fadeIn(0, 30)).toBe(0);
    expect(fadeIn(12, 30)).toBe(1);
    expect(fadeOut(0, 30, 90)).toBe(1);
    expect(fadeOut(90, 30, 90)).toBe(0);
    expect(fadeOut(78, 30, 90, { duration: 0.4 })).toBe(1);
    expect(fade(45, 30, 90)).toBe(1);
    expect(fade(0, 30, 90)).toBe(0);
    expect(fade(90, 30, 90, { out: false })).toBe(1);
    const start = rise(0, 30, { unit: 2, distance: 24 });
    expect(start).toEqual({ opacity: 0, transform: 'translateY(48px)' });
    expect(rise(60, 30)).toEqual({ opacity: 1, transform: 'translateY(0px)' });
    const mid = rise(6, 30, { duration: 0.6 });
    expect(mid.opacity).toBeGreaterThan(0);
    expect(mid.opacity).toBeLessThanOrEqual(1);
    expect(stagger(0)).toBe(0);
    expect(stagger(3, { start: 0.2, step: 0.1 })).toBeCloseTo(0.5);
    expect(stagger(-1)).toBe(0);
    // Same inputs, same outputs.
    expect(rise(7, 30)).toEqual(rise(7, 30));
  });

  it('small numeric helpers', () => {
    expect(clamp(2)).toBe(1);
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(toFrames(1.5, 30)).toBe(45);
    expect(toSeconds(45, 30)).toBe(1.5);
    expect(roundTo(413.0529999999999)).toBe(413.05);
    expect(roundTo(1.23456, 3)).toBe(1.235);
    expect(fadeOut(75, 30, 75, { duration: 0.3 })).toBe(0); // no 1e-16 float residue
    const cues = [
      { from: 0, to: 30 },
      { from: 30, to: 60 },
    ];
    expect(activeIndex(cues, 0)).toBe(0);
    expect(activeIndex(cues, 30)).toBe(1);
    expect(activeIndex(cues, 60)).toBe(-1);
  });
});

describe('kit fitText (R-CMP-08): text never overflows its box', () => {
  /** A monospace measurer: every character is 0.5 em. */
  const mono: TextMeasurer = (text, font) => [...text].length * font.size * 0.5 + (font.letterSpacing ?? 0) * font.size * Math.max(0, [...text].length - 1);

  it('keeps the max size when the text fits', () => {
    const r = fitText({ text: 'Hello', width: 500, maxFontSize: 80, fontFamily: 'x', measure: mono });
    expect(r).toMatchObject({ fontSize: 80, lines: ['Hello'], fits: true, truncated: false });
    expect(r.width).toBe(200);
  });

  it('shrinks to the largest size on the step grid that fits the width', () => {
    // 20 chars × 0.5 em ≤ 300 px ⇒ size ≤ 30.
    const r = fitText({ text: 'abcdefghijklmnopqrst', width: 300, maxFontSize: 80, fontFamily: 'x', measure: mono });
    expect(r.fontSize).toBe(30);
    expect(r.width).toBeLessThanOrEqual(300);
    const odd = fitText({ text: 'abcdefghijklmnopqrst', width: 305, maxFontSize: 80, fontFamily: 'x', measure: mono });
    expect(odd.fontSize).toBe(30.5);
  });

  it('wraps on up to maxLines lines and respects the height', () => {
    const r = fitText({ text: 'one two three four', width: 200, maxFontSize: 40, maxLines: 2, fontFamily: 'x', measure: mono });
    expect(r.fits).toBe(true);
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.width).toBeLessThanOrEqual(200);
    expect(r.lines.join(' ')).toBe('one two three four');
    const tall = fitText({ text: 'one two three four', width: 200, height: 40, maxFontSize: 40, maxLines: 2, lineHeight: 1, fontFamily: 'x', measure: mono });
    expect(tall.height).toBeLessThanOrEqual(40);
    expect(wrapText('a b c', 2 * 10 * 0.5, { family: 'x', size: 10 }, mono)).toEqual(['a', 'b', 'c']);
    expect(wrapText('first\nsecond', 1000, { family: 'x', size: 10 }, mono)).toEqual(['first', 'second']);
  });

  it('balances wrapped lines (no lone last word) unless asked not to', () => {
    const greedy = fitText({ text: 'Quotes in two clicks', width: 70, maxFontSize: 10, maxLines: 2, fontFamily: 'x', measure: mono, balance: false });
    expect(greedy.lines).toEqual(['Quotes in two', 'clicks']);
    const balanced = fitText({ text: 'Quotes in two clicks', width: 70, maxFontSize: 10, maxLines: 2, fontFamily: 'x', measure: mono });
    expect(balanced.lines).toEqual(['Quotes in', 'two clicks']);
    expect(balanced.fontSize).toBe(greedy.fontSize);
    expect(balanced.width).toBeLessThanOrEqual(greedy.width);
    expect(balanceLines('a b c d', 1000, 1, { family: 'x', size: 10 }, mono)).toEqual(['a b c d']);
  });

  it('cuts with an ellipsis below the minimum size (never overflows)', () => {
    const r = fitText({ text: 'a very long title that cannot fit anywhere', width: 100, maxFontSize: 40, minFontSize: 20, fontFamily: 'x', measure: mono });
    expect(r).toMatchObject({ fontSize: 20, fits: false, truncated: true });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].endsWith('…')).toBe(true);
    expect(mono(r.lines[0], { family: 'x', size: 20 })).toBeLessThanOrEqual(100);
    const two = fitText({ text: 'aaaa bbbb cccc dddd eeee', width: 100, maxFontSize: 40, minFontSize: 20, maxLines: 2, fontFamily: 'x', measure: mono });
    expect(two.lines).toEqual(['aaaa bbbb', 'cccc dddd…']);
  });

  it('uppercase and letter spacing are measured', () => {
    const r = fitText({ text: 'kicker', width: 1000, maxFontSize: 20, uppercase: true, letterSpacing: 0.1, fontFamily: 'x', measure: mono });
    expect(r.lines).toEqual(['KICKER']);
    expect(r.width).toBeCloseTo(6 * 10 + 0.1 * 20 * 5);
  });

  it('in Node the default measurer is a deterministic estimate', () => {
    expect(measureText('Hello world', { family: 'x', size: 40 })).toBe(estimateTextWidth('Hello world', { family: 'x', size: 40 }));
    expect(estimateTextWidth('WWW', { family: 'x', size: 10 })).toBeGreaterThan(estimateTextWidth('iii', { family: 'x', size: 10 }));
    expect(estimateTextWidth('Bold', { family: 'x', size: 10, weight: 700 })).toBeGreaterThan(estimateTextWidth('Bold', { family: 'x', size: 10 }));
    const a = fitText({ text: 'Quotes in two clicks', width: 600, maxFontSize: 96, fontFamily: 'ds-x-display', maxLines: 2 });
    const b = fitText({ text: 'Quotes in two clicks', width: 600, maxFontSize: 96, fontFamily: 'ds-x-display', maxLines: 2 });
    expect(a).toEqual(b);
    expect(a.width).toBeLessThanOrEqual(600);
  });
});

describe('kit style helpers', () => {
  it('fonts, backgrounds, colours, text styles, safe areas', () => {
    expect(cssFontFamily('ds-editorial-display')).toBe('"ds-editorial-display", sans-serif');
    expect(cssFontFamily('ds-x', 'serif')).toBe('"ds-x", serif');
    expect(cssFontFamily('"A", serif')).toBe('"A", serif');
    expect(cssFontFamily('system-ui')).toBe('system-ui');
    expect(backgroundCss(LIGHT)).toBe('radial-gradient(ellipse 150% 100% at 50% 0%, #f8f4ef 0%, 60%, #ebe4dc 100%)');
    expect(backgroundCss(DARK)).toBe('linear-gradient(180deg, #1b1e2b 0%, #0d0f16 100%)');
    expect(backgroundCss({ ...LIGHT, background: { type: 'solid', color: '#ffffff' } })).toBe('#ffffff');
    expect(backgroundCss({ ...LIGHT, background: { type: 'solid' } })).toBe(LIGHT.colors.paper);
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(withAlpha('#f00', 0.25)).toBe('rgba(255, 0, 0, 0.25)');
    expect(withAlpha('#ff000080', 1)).toBe('rgba(255, 0, 0, 0.502)');
    expect(withAlpha('rebeccapurple', 0.3)).toBe('color-mix(in srgb, rebeccapurple 30%, transparent)');
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000')).toBe(0);
    expect(luminance('red')).toBeUndefined();
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21);
    expect(contrastRatio('#777', '#777')).toBe(1);
    expect(contrastRatio('red', '#000')).toBeUndefined();
    expect(readableOn(LIGHT.colors.text, LIGHT.colors.accent, 'white')).toBe('white'); // wine on ink: too dark
    expect(readableOn(DARK.colors.paper, DARK.colors.accent, 'white')).toBe(DARK.colors.accent); // coral on night: fine
    // Hotfix v0.2.5 (field point 22): a dark accent on a dark page keeps its fill; the label is chosen against it.
    const wine = { colors: { ...DARK.colors, accent: '#9a1e25', paper: '#1c1c1c', text: '#f4f1ea' } };
    const b = buttonColors(wine);
    expect(b.fill).toBe('#9a1e25');
    expect(b.label).toBe('#f4f1ea');
    expect(b.ratio!).toBeGreaterThanOrEqual(4.5);
    // A pale accent: the light ink fails, the dark one reads.
    const pale = buttonColors({ colors: { ...LIGHT.colors, accent: '#f2d27a' } });
    expect(pale.ratio!).toBeGreaterThanOrEqual(4.5);
    expect(pale.label).not.toBe(LIGHT.colors.paper);
    // Neither theme ink reads: white or black, whichever contrasts most.
    expect(inkOn('#777777', ['#888888', '#666666'])).toBe('#000000');
    expect(inkOn('#1a1a40', ['#202020'])).toBe('#ffffff');
    expect(darkLight(LIGHT)).toEqual({ dark: LIGHT.colors.text, light: LIGHT.colors.paper });
    expect(darkLight(DARK)).toEqual({ dark: DARK.colors.paper, light: DARK.colors.text });
    expect(textStyleCss(LIGHT.captions!.kicker, 2)).toEqual({
      fontFamily: '"ds-light-body", sans-serif',
      fontSize: 30,
      color: '#8a2332',
      lineHeight: 1.2,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.14em',
    });
    expect(safeAreaRect(1920, 1080)).toEqual({ x: 96, y: 54, w: 1728, h: 972 });
    expect(safeAreaRect(1000, 1000, 0.1)).toEqual({ x: 100, y: 100, w: 800, h: 800 });
    expect(scaleRect({ x: 1, y: 2, w: 3, h: 4 }, 2)).toEqual({ x: 2, y: 4, w: 6, h: 8 });
  });
});

describe('kit frame helpers (L2.7)', () => {
  it('liftToContrast keeps a theme hue readable on a dark surface', () => {
    const wine = '#8a2332';
    const night = '#1f1413';
    const lifted = liftToContrast(night, wine, '#f3eee8', 3.5);
    expect(lifted).not.toBe(wine);
    expect(contrast(night, lifted)!).toBeGreaterThanOrEqual(3.5);
    expect(liftToContrast('#f3eee8', wine, '#ffffff', 3)).toBe(wine); // already readable
  });

  it('device tones, shadows, addresses and the caption band box come from the theme / the inputs', () => {
    const t = deviceTones(LIGHT, 'dark');
    expect(t.body).toMatch(/^#[0-9a-f]{6}$/);
    expect(deviceTones(LIGHT, 'light').body).not.toBe(t.body);
    expect(cardShadow(LIGHT, 'none', 1)).toBe('none');
    expect(cardShadow(LIGHT, 'soft', 1)).toContain('rgba(31, 20, 19, 0.16)');
    expect(addressParts('https://a.example/x?y=1#z')).toEqual({ secure: true, host: 'a.example', path: '/x?y=1' });
    expect(addressParts('http://localhost:4402/')).toEqual({ secure: false, host: 'localhost:4402', path: '' });
    expect(addressParts(undefined)).toBeUndefined();
    const area = { x: 873, y: 485, w: 700, h: 110 };
    expect(captionBandBox({ rects: { screen: { x: 368, y: 163, w: 389, h: 807 } }, area, width: 1920, height: 1080, unit: 1, position: 'over', maxWidth: 1400 })).toEqual({
      box: { ...area },
      over: false,
    });
    expect(captionBandBox({ width: 1920, height: 1080, unit: 1, position: 'over', maxWidth: 1400 }).box).toEqual({ x: 260, y: 866, w: 1400, h: 150 });
  });
});

describe('kit React elements (render-tested)', () => {
  const html = (el: Parameters<typeof renderToString>[0]) => renderToString(el);

  it('Background draws the theme background', () => {
    expect(html(createElement(Background, { theme: LIGHT }))).toContain('radial-gradient(ellipse 150% 100% at 50% 0%, #f8f4ef 0%, 60%, #ebe4dc 100%)');
    expect(html(createElement(Background, { theme: DARK }))).toContain('linear-gradient(180deg, #1b1e2b 0%, #0d0f16 100%)');
  });

  it('Logo: the logo image sized with unit, else a monogram of the brand, else nothing', () => {
    const img = html(createElement(Logo, { theme: DARK, size: 40, unit: 2 }));
    expect(img).toMatch(/<img[^>]*src="http:\/\/assets\.local\/logo\.svg"/);
    expect(img).toContain('height:80px');
    const mono = html(createElement(Logo, { theme: LIGHT, size: 50 }));
    expect(mono).toContain('>A</div>');
    expect(mono).toContain('background:#8a2332');
    expect(html(createElement(Logo, { theme: { ...LIGHT, brand: {} }, size: 50 }))).toBe('');
  });

  it('Wordmark: the wordmark image, else the brand name in the display font, both at the same visual height', () => {
    const img = html(createElement(Wordmark, { theme: DARK, height: 30 }));
    expect(img).toMatch(/<img[^>]*src="http:\/\/assets\.local\/wordmark\.svg"[^>]*alt="Pulse"/);
    expect(img).toContain('height:30px');
    const text = html(createElement(Wordmark, { theme: LIGHT, height: 30, unit: 0.5 }));
    expect(text).toContain('>Atelier</span>');
    expect(text).toContain('font-family:&quot;ds-light-display&quot;, serif');
    // Visual height 15 px: a box that tall, the text set at 15 × WORDMARK_TEXT_SCALE with its baseline on the bottom.
    expect(text).toContain(`font-size:${15 * WORDMARK_TEXT_SCALE}px`);
    expect(text).toContain('height:15px');
    expect(text).toMatch(/transform:translateY\(-?[\d.]+px\)/);
    expect(html(createElement(Wordmark, { theme: { ...LIGHT, wordmark: undefined, brand: {} }, height: 30 }))).toBe('');
  });

  it('SafeArea insets its children; FitText draws the fitted lines', () => {
    const safe = html(createElement(SafeArea, { width: 1920, height: 1080 }, 'x'));
    expect(safe).toContain('left:96px;top:54px;width:1728px;height:972px');
    const fit = html(createElement(FitText, { text: 'one two three four five six', width: 300, maxFontSize: 80, maxLines: 2, fontFamily: 'ds-x-display', color: '#123456' }));
    const expected = fitText({ text: 'one two three four five six', width: 300, maxFontSize: 80, maxLines: 2, fontFamily: 'ds-x-display', lineHeight: 1.15 });
    expect(fit).toContain(`font-size:${expected.fontSize}px`);
    expect(fit).toContain('color:#123456');
    for (const line of expected.lines) expect(fit).toContain(`>${line}</div>`);
  });
});

describe('kit renderer primitives (BACKLOG L3.7: components import the renderer through the kit)', () => {
  it('re-exports useCurrentFrame, useVideoConfig, Img, AbsoluteFill, Sequence and random from remotion itself', async () => {
    const kit = (await import('@retake/components/kit')) as Record<string, unknown>;
    const remotion = (await import('remotion')) as Record<string, unknown>;
    for (const name of ['useCurrentFrame', 'useVideoConfig', 'Img', 'AbsoluteFill', 'Sequence', 'random']) {
      expect(kit[name], name).toBeDefined();
      expect(kit[name], name).toBe(remotion[name]);
    }
    expect((kit.random as (seed: string) => number)('seed')).toBe((remotion.random as (seed: string) => number)('seed'));
  });
});
