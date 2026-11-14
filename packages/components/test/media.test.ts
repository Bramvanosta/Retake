/**
 * Your own files (L2.12, R-OWN-01/02/03): the kit helpers behind studio/media and studio/lottie (Lottie recolouring by
 * theme colours, backgrounds, lengths), components usable as several kinds (manifest `kinds`, registry, `props.as`),
 * and the two components rendered as a card and as an overlay (react-dom/server, remotion's video elements mocked).
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LIBRARY_DIR, loadComponentRegistry, parseManifest } from '@retake/components';
import type { ComponentProps, LottieMedia, PictureMedia, VideoMedia } from '@retake/components';
import {
  AUTO_COVER_MIN_SHARE,
  autoFit,
  backgroundCss,
  lottieFrames,
  mediaBackground,
  mediaLength,
  nightTone,
  parseColor01,
  recolorLottie,
  themeColorMap,
  videoPartFrames,
} from '@retake/components/kit';
import { DARK, LIGHT, tempDir } from './helpers.js';

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return {
    ...actual,
    useCurrentFrame: () => 10,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 90, id: 'x', defaultProps: {}, props: {}, defaultCodec: null }),
    Img: (props: Record<string, unknown>) => h('img', props),
    OffthreadVideo: (props: Record<string, unknown>) => h('video', { 'data-src': props.src, 'data-transparent': String(props.transparent), 'data-muted': String(props.muted), style: props.style }),
    Sequence: (props: { children?: unknown }) => h('div', { 'data-seq': '1' }, props.children as never),
    Loop: (props: { children?: unknown; durationInFrames: number }) => h('div', { 'data-loop': props.durationInFrames }, props.children as never),
  };
});

const lottie = (fills: Array<[number, number, number, number]>) => ({
  v: '5.7.4',
  fr: 60,
  ip: 0,
  op: 120,
  w: 100,
  h: 100,
  layers: [
    {
      ty: 4,
      shapes: [
        {
          ty: 'gr',
          it: [
            { ty: 'fl', c: { a: 0, k: fills[0] } },
            {
              ty: 'st',
              c: {
                a: 1,
                k: [
                  { t: 0, s: fills[1], e: fills[0] },
                  { t: 10, s: fills[1] },
                ],
              },
            },
          ],
        },
        { ty: 'gf', g: { p: 2, k: { a: 0, k: [0, ...fills[0].slice(0, 3), 1, ...fills[1].slice(0, 3)] } } },
      ],
    },
    { ty: 1, sc: '#ff5a1f' },
    { ty: 5, t: { d: { k: [{ s: { fc: fills[1].slice(0, 3) } }] } } },
  ],
});
const ORANGE: [number, number, number, number] = [1, 0x5a / 255, 0x1f / 255, 1];
const GOLD: [number, number, number, number] = [0xf2 / 255, 0xc1 / 255, 0x4e / 255, 1];

describe('Lottie colours from the theme', () => {
  it('replaces fills, animated strokes, gradient stops, solid layers and text colours — nothing else, input untouched', () => {
    const data = lottie([ORANGE, GOLD]);
    const before = JSON.stringify(data);
    const out = recolorLottie(data, { '#ff5a1f': '#8a2332', '#f2c14e': 'rgb(0, 128, 255)' });
    expect(JSON.stringify(data)).toBe(before);
    const wine = [0x8a / 255, 0x23 / 255, 0x32 / 255];
    const blue = [0, 128 / 255, 1];
    const it0 = (out.layers[0].shapes![0] as { it: Array<{ c: { k: unknown } }> }).it;
    expect(it0[0].c.k).toEqual([...wine, 1]);
    expect(it0[1].c.k).toEqual([
      { t: 0, s: [...blue, 1], e: [...wine, 1] },
      { t: 10, s: [...blue, 1] },
    ]);
    expect((out.layers[0].shapes![1] as { g: { k: { k: number[] } } }).g.k.k).toEqual([0, ...wine, 1, ...blue]);
    expect(out.layers[1].sc).toBe('#8a2332');
    expect((out.layers[2] as unknown as { t: { d: { k: Array<{ s: { fc: number[] } }> } } }).t.d.k[0].s.fc).toEqual(blue);
    // A colour not in the map stays; an unreadable map entry is ignored.
    const other = recolorLottie(
      lottie([
        [0, 0, 0, 1],
        [1, 1, 1, 1],
      ]),
      { '#ff5a1f': '#8a2332', nope: '#000' },
    );
    expect((other.layers[0].shapes![0] as { it: Array<{ c: { k: unknown } }> }).it[0].c.k).toEqual([0, 0, 0, 1]);
    expect(parseColor01('#fff')).toEqual([1, 1, 1]);
    expect(parseColor01('teal')).toBeUndefined();
  });

  it('resolves theme colour keys (dark = the night tone) and leaves CSS colours as written', () => {
    expect(themeColorMap(LIGHT, { '#ff5a1f': 'accent', '#2b2b33': 'text', '#000001': 'dark', '#000002': '#123456', '#000003': 3 })).toEqual({
      '#ff5a1f': LIGHT.colors.accent,
      '#2b2b33': LIGHT.colors.text,
      '#000001': nightTone(LIGHT),
      '#000002': '#123456',
    });
    expect(themeColorMap(LIGHT, undefined)).toEqual({});
  });
});

describe('backgrounds and lengths', () => {
  it('the background around a full-frame file: theme, none, a theme colour key or a CSS colour', () => {
    expect(mediaBackground(LIGHT, undefined)).toBe(backgroundCss(LIGHT));
    expect(mediaBackground(DARK, 'theme')).toBe(backgroundCss(DARK));
    expect(mediaBackground(LIGHT, 'none')).toBe('transparent');
    expect(mediaBackground(LIGHT, 'paper')).toBe(LIGHT.colors.paper);
    expect(mediaBackground(LIGHT, 'dark')).toBe(nightTone(LIGHT));
    expect(mediaBackground(LIGHT, '#102030')).toBe('#102030');
  });

  it('a video part, a Lottie animation at the video frame rate', () => {
    const v = { duration_s: 4 } as VideoMedia;
    expect(videoPartFrames(v, 30)).toBe(120);
    expect(videoPartFrames(v, 30, 1, 2.5)).toBe(45);
    expect(videoPartFrames(v, 30, 1, 9)).toBe(90);
    expect(videoPartFrames(v, 30, 5)).toBe(1);
    expect(lottieFrames({ frames: 120, fps: 60 }, 30)).toBe(60);
    expect(mediaLength({ kind: 'video', duration_s: 4 } as VideoMedia, { from: 1, to: 3 })).toBe(2);
    expect(mediaLength({ kind: 'lottie', duration_s: 2 } as LottieMedia)).toBe(2);
    expect(mediaLength({ kind: 'picture' } as PictureMedia)).toBeUndefined();
  });
});

describe('components usable as several kinds (manifest `kinds`, registry)', () => {
  const card = (extra: string) => `id: acme/clip\nversion: 1.0.0\nkind: card\nname: X\ndescription: Y\n${extra}`;

  it('declares the other kinds it can be used as: full-frame kinds and the overlay only', () => {
    expect(parseManifest(card('kinds: [intro, overlay]\n')).issues).toEqual([]);
    const msgs = (t: string) => parseManifest(t).issues.map((i) => `${i.severity} ${i.line}:${i.col} ${i.message}`);
    expect(msgs(card('kinds: [card, overlay, overlay]\n'))).toEqual(['warning 6:9 "card" is the component\'s own kind: no need to list it in kinds', 'error 6:24 "overlay" is listed twice']);
    expect(msgs(card('kinds: [layout]\n'))[0]).toMatch(/^error 6:9 kinds\[0\]|expected one of "intro", "outro", "card", "interstitial", "overlay"/);
    const layout = 'id: acme/frame\nversion: 1.0.0\nkind: caption\nname: X\ndescription: Y\nkinds: [overlay]\n';
    expect(msgs(layout)).toEqual(['error 6:1 only intro, outro, card, interstitial, overlay components may be used as other kinds (this one is caption)']);
  });

  it('studio/media and studio/lottie resolve as every full-frame kind and as an overlay (the use keeps its kind)', async () => {
    const ws = await tempDir();
    try {
      const reg = await loadComponentRegistry({ root: ws.dir });
      expect(reg.builtinDir).toBe(LIBRARY_DIR);
      for (const id of ['studio/media', 'studio/lottie']) {
        for (const kind of ['intro', 'outro', 'card', 'interstitial', 'overlay'] as const) {
          expect(reg.resolve(id, kind).kind, `${id} as ${kind}`).toBe(kind);
          expect(
            reg.list(kind).map((c) => c.manifest.id),
            kind,
          ).toContain(id);
        }
        expect(() => reg.resolve(id, 'layout')).toThrow(/is a card component, not a layout/);
      }
      expect(reg.resolve({ id: 'studio/media', params: { volume: 0.4, from: 1 } }, 'intro').params).toEqual({ fit: 'auto', background: 'theme', volume: 0.4, from: 1, loop: false });
      expect(() => reg.resolve({ id: 'studio/media', params: { volume: 2 } }, 'intro')).toThrow(/volume/);
      expect(reg.resolve('studio/lottie', 'overlay').params).toEqual({ fit: 'contain', background: 'theme', size: 1, loop: false, colors: {} });
    } finally {
      await ws.cleanup();
    }
  });
});

describe('studio/media and studio/lottie as a card and as an overlay', () => {
  const base: Omit<ComponentProps, 'params'> = { theme: LIGHT, slots: {}, unit: 1, width: 1920, height: 1080, fps: 30, durationInFrames: 90, variant: 'landscape' };
  const video: VideoMedia = { kind: 'video', name: 'assets/intro.mp4', url: 'http://x/intro.mp4', width: 1920, height: 1080, duration_s: 3, fps: 30, audio: true, alpha: false, codec: 'h264' };
  const burst: VideoMedia = { ...video, name: 'assets/burst.webm', url: 'http://x/burst.webm', width: 480, height: 480, audio: false, alpha: true, codec: 'vp9' };
  const media = async () => (await import('../library/studio/media/index.js')).default;

  it('full frame: the file over the background (cover by default, contain on the theme background)', async () => {
    const Media = await media();
    const html = renderToString(createElement(Media, { ...base, as: 'card', media: { file: video }, params: { fit: 'contain', background: 'theme', volume: 1, from: 0, loop: false } }));
    expect(html).toContain('data-src="http://x/intro.mp4"');
    expect(html).toContain('data-muted="false"');
    expect(html).toContain('object-fit:contain');
    expect(html).toContain(`background:${backgroundCss(LIGHT).replace(/, /g, ',')}`.slice(0, 40));
    const image: PictureMedia = { kind: 'picture', name: 'end.png', url: 'http://x/end.png', label: 'end.png' };
    const img = renderToString(createElement(Media, { ...base, as: 'outro', media: { file: image }, params: { fit: 'cover', background: 'none', volume: 1, from: 0, loop: false } }));
    expect(img).toContain('src="http://x/end.png"');
    expect(img).toContain('background:transparent');
  });

  it("fit auto (the default): covers a file of about the frame's shape, shows a 16:9 file whole in a vertical or square frame", async () => {
    expect(AUTO_COVER_MIN_SHARE).toBe(0.8);
    expect(autoFit({ width: 1920, height: 1080 }, { w: 1920, h: 1080 })).toBe('cover');
    expect(autoFit({ width: 1920, height: 1200 }, { w: 1920, h: 1080 })).toBe('cover');
    expect(autoFit({ width: 1200, height: 900 }, { w: 1920, h: 1080 })).toBe('contain');
    expect(autoFit({ width: 1920, height: 1080 }, { w: 1080, h: 1920 })).toBe('contain');
    expect(autoFit({ width: 1920, height: 1080 }, { w: 1080, h: 1080 })).toBe('contain');
    expect(autoFit({}, { w: 1080, h: 1920 })).toBe('cover');
    const Media = await media();
    const params = { fit: 'auto' as const, background: 'theme', volume: 1, from: 0, loop: false };
    expect(renderToString(createElement(Media, { ...base, as: 'intro', media: { file: video }, params }))).toContain('object-fit:cover');
    const vertical = renderToString(createElement(Media, { ...base, width: 1080, height: 1920, variant: 'vertical', as: 'intro', media: { file: video }, params }));
    expect(vertical).toContain('object-fit:contain');
    expect(
      renderToString(createElement(Media, { ...base, width: 1080, height: 1920, variant: 'vertical', as: 'intro', media: { file: video }, params: { ...params, fit: 'cover' as const } })),
    ).toContain('object-fit:cover');
  });

  it('as an overlay: an alpha video in its box, clipped to the visible capture, transparent and silent without sound', async () => {
    const Media = await media();
    const rects = { screen: { x: 180, y: 40, w: 1560, h: 878 }, frame: { x: 180, y: 40, w: 1560, h: 878 }, radius: 18 };
    const html = renderToString(
      createElement(Media, {
        ...base,
        as: 'overlay',
        media: { file: burst },
        rects,
        anchor: { x: 900, y: 500, w: 200, h: 200 },
        params: { fit: 'contain', background: 'none', volume: 1, from: 0, loop: true },
      }),
    );
    expect(html).toContain('left:180px;top:40px;width:1560px;height:878px;overflow:hidden;border-radius:18px');
    expect(html).toContain('left:720px;top:460px;width:200px;height:200px');
    expect(html).toContain('data-transparent="true"');
    expect(html).toContain('data-muted="true"');
    expect(html).toContain('data-loop="90"');
  });

  it('studio/lottie: nothing until its JSON is loaded (the render waits for it), in a centred box of `size`', async () => {
    const Lottie = (await import('../library/studio/lottie/index.js')).default;
    const file: LottieMedia = { kind: 'lottie', name: 'cup.json', url: 'http://x/cup.json', width: 600, height: 500, fps: 30, frames: 96, duration_s: 3.2 };
    const html = renderToString(createElement(Lottie, { ...base, as: 'card', media: { file }, params: { fit: 'contain', background: 'paper', size: 0.5, loop: false, colors: {} } }));
    expect(html).toContain(`background:${LIGHT.colors.paper}`);
    expect(html).toContain('width:960px;height:540px');
  });
});
