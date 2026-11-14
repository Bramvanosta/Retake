/**
 * The per-kind scaffolds are tasteful, theme-driven placeholders (R-CMP-05): they render with any theme, read every
 * colour / font / logo from props.theme, size everything with props.unit and are deterministic. They are rendered
 * here with react-dom/server (remotion's frame hook mocked) and typechecked against the kit.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { COMPONENT_KINDS } from '@retake/core';
import type { ComponentKind } from '@retake/core';
import { KIT_MODULE, LIBRARY_DIR, PACKAGE_DIR, applyParamDefaults, parseManifest, scaffoldDir, stripComments } from '@retake/components';
import { kitExports } from '../src/compile.js';
import type { ComponentManifest, ComponentProps, ThemeTokens } from '@retake/components';
import { DARK, LIGHT } from './helpers.js';

const frame = vi.hoisted(() => ({ current: 0 }));

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return { ...actual, useCurrentFrame: () => frame.current, Img: (props: Record<string, unknown>) => h('img', props) };
});

const components = {} as Record<ComponentKind, ComponentType<ComponentProps>>;
const manifests = {} as Record<ComponentKind, ComponentManifest>;

beforeAll(async () => {
  for (const kind of COMPONENT_KINDS) {
    components[kind] = ((await import(`../scaffolds/${kind}/index.tsx`)) as { default: ComponentType<ComponentProps> }).default;
    manifests[kind] = parseManifest(readFileSync(join(scaffoldDir(kind), 'component.yaml'), 'utf8')).manifest!;
  }
});

interface RenderOpts {
  theme?: ThemeTokens;
  at?: number;
  unit?: number;
  variant?: 'landscape' | 'vertical' | 'square';
  extra?: Partial<ComponentProps>;
  params?: Record<string, unknown>;
}

/** Render a scaffold at a frame with its preview slots and default params, like a preview would. */
function render(kind: ComponentKind, opts: RenderOpts = {}): string {
  const m = manifests[kind];
  const unit = opts.unit ?? 1;
  const variant = opts.variant ?? 'landscape';
  const size = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] }[variant];
  const fps = 30;
  frame.current = opts.at ?? 45;
  const props: ComponentProps = {
    theme: opts.theme ?? LIGHT,
    slots: { ...(m.preview?.slots ?? {}) },
    params: applyParamDefaults(m.params as never, { ...(m.preview?.params ?? {}), ...(opts.params ?? {}) }),
    unit,
    width: size[0] * unit,
    height: size[1] * unit,
    fps,
    durationInFrames: Math.round((m.duration?.default ?? 4) * fps),
    variant,
    ...opts.extra,
  };
  return renderToString(createElement(components[kind], props));
}

const fontSizes = (html: string) => [...html.matchAll(/font-size:([\d.]+)px/g)].map((m) => Number(m[1]));

describe('scaffolds render with any theme (R-CMP-05)', () => {
  it('every kind renders in both themes, both variants and across its duration', () => {
    for (const kind of COMPONENT_KINDS) {
      for (const theme of [LIGHT, DARK]) {
        for (const variant of ['landscape', 'vertical', 'square'] as const) {
          for (const at of [0, 10, 45, 200]) {
            expect(() => render(kind, { theme, variant, at }), `${kind} ${theme.name} ${variant} ${at}`).not.toThrow();
          }
        }
      }
    }
  });

  it('colours and fonts come from the theme: two themes, two looks; no colour literal in the sources', () => {
    for (const kind of COMPONENT_KINDS) {
      const src = readFileSync(join(scaffoldDir(kind), 'index.tsx'), 'utf8');
      expect(src, kind).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      expect(src, kind).not.toMatch(/fontFamily:\s*['"]/);
    }
    for (const kind of ['intro', 'outro', 'card', 'interstitial', 'caption', 'layout', 'overlay'] as const) {
      const light = render(kind, { theme: LIGHT, at: 60 });
      const dark = render(kind, { theme: DARK, at: 60 });
      expect(light, kind).not.toBe(dark);
      const usesLight = Object.values(LIGHT.colors).some((c) => light.includes(c)) || light.includes('rgba(31, 20, 19') || light.includes('rgba(243, 238, 232');
      expect(usesLight, kind).toBe(true);
    }
    for (const kind of ['intro', 'outro', 'card', 'interstitial', 'caption', 'overlay'] as const) {
      expect(render(kind, { theme: LIGHT, at: 60 }), kind).toMatch(/ds-light-(display|body)/);
    }
  });

  it('sizes scale with unit (4K = 2 × 1080p)', () => {
    for (const kind of ['intro', 'outro', 'card', 'interstitial', 'caption', 'overlay'] as const) {
      const one = fontSizes(render(kind, { unit: 1, at: 90 }));
      const two = fontSizes(render(kind, { unit: 2, at: 90 }));
      expect(one.length, kind).toBeGreaterThan(0);
      expect(two, kind).toEqual(one.map((s) => s * 2));
    }
    const layout1 = render('layout', { unit: 1 });
    const layout2 = render('layout', { unit: 2 });
    expect(layout1).toContain('left:180px;top:54px;width:1560px;height:878px');
    expect(layout2).toContain('left:360px;top:108px;width:3120px;height:1756px');
  });

  it('is deterministic: the same frame renders the same markup', () => {
    for (const kind of COMPONENT_KINDS) {
      expect(render(kind, { at: 33 }), kind).toBe(render(kind, { at: 33 }));
    }
  });
});

describe('scaffold behaviour', () => {
  it('intro: staggered entrance, logo row and title from the slots', () => {
    const start = render('intro', { at: 0 });
    expect(start).toContain('Quotes in two clicks');
    expect(start).toContain('Product tour');
    expect(start).toContain('>Atelier</span>');
    expect(start).toMatch(/opacity:0;transform:translateY\(24px\)/);
    expect(render('intro', { at: 90 })).not.toMatch(/opacity:0;/);
    expect(render('intro', { theme: DARK, at: 90 })).toMatch(/<img[^>]*src="http:\/\/assets\.local\/logo\.svg"/);
  });

  it('caption: shows the active cue, or the slot text without cues', () => {
    const cues = [
      { from: 0, to: 60, text: 'First caption', kicker: 'One', scene: 'a' },
      { from: 60, to: 120, text: 'Second caption', scene: 'b' },
    ];
    expect(render('caption', { at: 30, extra: { cues } })).toContain('First caption');
    const second = render('caption', { at: 90, extra: { cues } });
    expect(second).toContain('Second caption');
    expect(second).not.toContain('First caption');
    expect(render('caption', { at: 130, extra: { cues } })).toBe('');
    expect(render('caption', { at: 10 })).toContain('Pick a customer and the price list follows.');
    const inArea = render('caption', { at: 30, extra: { cues, area: { x: 180, y: 952, w: 1560, h: 104 } } });
    expect(inArea).toContain('left:180px;top:952px;width:1560px;height:104px');
  });

  it('layout: places the screen in the geometry rect (skeleton in previews); the brand mark is left to the composition', () => {
    const preview = render('layout');
    expect(preview).toContain('left:180px;top:54px;width:1560px;height:878px');
    // The composition draws the brand mark in the geometry's brandmark rect: a layout must not draw a second one.
    expect(preview).not.toContain('>A</div>');
    const withScreen = render('layout', { extra: { screen: createElement('video', { src: 'capture.mp4' }) } });
    expect(withScreen).toContain('<video src="capture.mp4">');
    expect(render('layout', { variant: 'vertical' })).toContain('left:40px;top:224px;width:1000px;height:1240px');
    expect(render('layout', { variant: 'square' })).toContain('left:40px;top:40px;width:1000px;height:750px');
    expect(manifests.layout.geometry?.brandmark).toEqual({ x: 1810, y: 1020, w: 80, h: 30 });
    // The TSX geometry is the manifest's.
    expect(manifests.layout.geometry?.screen).toEqual({ x: 180, y: 54, w: 1560, h: 878 });
    expect(manifests.layout.geometry_vertical?.screen).toEqual({ x: 40, y: 224, w: 1000, h: 1240 });
    expect(manifests.layout.geometry_square?.screen).toEqual({ x: 40, y: 40, w: 1000, h: 750 });
  });

  it('overlay: a pill next to the anchor (above when there is room, else below), a lower third without one', () => {
    const above = render('overlay', { at: 30, extra: { anchor: { x: 900, y: 600, w: 120, h: 40 } } });
    const top = Number(/top:([\d.]+)px;width/.exec(above)![1]);
    expect(top).toBeLessThan(600);
    const below = render('overlay', { at: 30, extra: { anchor: { x: 900, y: 40, w: 120, h: 40 } } });
    expect(Number(/top:([\d.]+)px;width/.exec(below)![1])).toBeGreaterThan(80);
    const lower = render('overlay', { at: 30 });
    expect(Number(/left:([\d.]+)px;top/.exec(lower)![1])).toBe(67);
    expect(lower).toContain('Totals update as you type');
    expect(lower).toContain('LIVE');
    // Fades out at the end of its duration.
    expect(render('overlay', { at: 75 })).toMatch(/opacity:0;/);
  });

  it('transition: entering fades in on top; a dip veils through a theme colour', () => {
    const screen = createElement('i', null, 'segment');
    const mid = (direction: 'entering' | 'exiting', params = {}) => render('transition', { at: 6, params, extra: { screen, direction, durationInFrames: 12 } });
    expect(mid('entering')).toMatch(/^<div style="position:absolute;inset:0;opacity:0\.5\d*"><i>segment<\/i><\/div>$/);
    expect(mid('exiting')).toMatch(/opacity:1"><i>segment<\/i>/);
    // A dip does not overlap: exiting covers frames [0, 6) of 12 (opaque on its last one), entering [6, 12).
    const dip = (at: number, direction: 'entering' | 'exiting') => render('transition', { at, params: { through: 'paper' }, extra: { screen, direction, durationInFrames: 12 } });
    const veil = (html: string) => Number(new RegExp(`background:${LIGHT.colors.paper};opacity:([\\d.e-]+)`).exec(html)?.[1]);
    expect(dip(0, 'exiting')).toContain(`background:${LIGHT.colors.paper}`);
    expect(veil(dip(0, 'exiting'))).toBeLessThan(0.2);
    expect(veil(dip(5, 'exiting'))).toBe(1);
    expect(veil(dip(6, 'entering'))).toBeGreaterThan(0.8);
    expect(veil(dip(11, 'entering'))).toBeLessThan(0.2);
  });

  it('interstitial: draws the last frame under a veil when given', () => {
    const html = render('interstitial', { extra: { screen: createElement('img', { src: 'last.png' }) } });
    expect(html).toContain('<img src="last.png"/>');
    expect(html).toContain('A few days later');
    expect(render('interstitial', { params: { tone: 'paper' } })).toContain(`color:${LIGHT.colors.text}`);
  });
});

/** Every module specifier of a source (static, side-effect, type-only, dynamic and re-export forms), comments ignored. */
function moduleSpecifiers(src: string): string[] {
  const text = stripComments(src);
  const out: string[] = [];
  for (const re of [/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g, /\bimport\s*\(?\s*(['"])([^'"\n]+)\1/g, /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g]) {
    for (const m of text.matchAll(re)) out.push(m[2]);
  }
  return out;
}

/** Every name `@retake/components/kit` exports (sorted): the public surface a workspace component may import. */
const KIT_PUBLIC_NAMES = [
  'AUTO_COVER_MIN_SHARE',
  'AbsoluteFill',
  'AppIcon',
  'BUTTON_LABEL_MIN',
  'Background',
  'CAMERA_EASINGS',
  'CAPTION_BAND_INSET',
  'CAPTION_BAND_MIN_SCREEN',
  'CAPTION_BAND_PAD_X',
  'CapText',
  'DEFAULT_ZOOM_EASE',
  'EASINGS',
  'EASING_CURVES',
  'ESTIMATED_METRICS',
  'FORMAT_SCALE',
  'FitText',
  'ICON_NAMES',
  'ICON_SHAPES',
  'Icon',
  'ImageFile',
  'Img',
  'InsetCard',
  'InsetPhone',
  'KEY_GLYPHS',
  'LOUPE_MIN_SCALE',
  'LOUPE_ORDER',
  'Logo',
  'LottieFile',
  'NOTIFICATION_INSET',
  'NOTIFICATION_STYLES',
  'NOTIFICATION_WIDTH',
  'NotificationCard',
  'PANE_BAR',
  'PANE_LABEL_ROW',
  'PHONE_DISPLAY_ASPECT',
  'PIP_BAR',
  'PaneLabel',
  'PhoneDevice',
  'Picture',
  'STEP_BADGE_ORDER',
  'SYSTEM_COLORS',
  'SafeArea',
  'Sequence',
  'StatusGlyphs',
  'VideoFile',
  'WORDMARK_TEXT_SCALE',
  'WindowBar',
  'Wordmark',
  'activeIndex',
  'addressParts',
  'autoFit',
  'backgroundCss',
  'backgroundSample',
  'balanceLines',
  'barTones',
  'biasMotion',
  'buttonColors',
  'capOffset',
  'capTextLayout',
  'captionBandBox',
  'captionMaxLines',
  'cardShadow',
  'clamp',
  'clearOf',
  'contrastRatio',
  'cssFontFamily',
  'cubicBezier',
  'darkLight',
  'deviceTones',
  'easing',
  'estimateTextWidth',
  'fade',
  'fadeIn',
  'fadeOut',
  'figureAt',
  'filePartGain',
  'fitText',
  'fontMetrics',
  'formatClock',
  'formatFigure',
  'formatMetrics',
  'inkOn',
  'insetPhoneEdge',
  'isDarkBackground',
  'isDarkColor',
  'layoutNotification',
  'lerp',
  'liftToContrast',
  'lottieFrames',
  'loupeLens',
  'luminance',
  'measureText',
  'mediaBackground',
  'mediaLength',
  'mixColors',
  'nightTone',
  'notificationArea',
  'notificationBox',
  'notificationMotion',
  'notificationTones',
  'parseColor01',
  'parseFigure',
  'parseNumber',
  'parseShortcut',
  'phoneCardGeometry',
  'pictureAspect',
  'placeBeside',
  'progress',
  'qrEncode',
  'qrMatrix',
  'qrPath',
  'qrVersionFor',
  'random',
  'readableOn',
  'recolorLottie',
  'rise',
  'roundTo',
  'safeAreaRect',
  'scaleRect',
  'shortcutPlateBox',
  'shortcutPlateLayout',
  'shortcutPlateMetrics',
  'shortcutText',
  'splitKeys',
  'stagger',
  'stepBadgeBox',
  'textStyleCss',
  'themeColorMap',
  'themeEasing',
  'toFrames',
  'toSeconds',
  'useCurrentFrame',
  'useLottieData',
  'useVideoConfig',
  'videoPartFrames',
  'wallpaperCss',
  'withAlpha',
  'wrapText',
];

describe('scaffolds import only react and the kit (BACKLOG L3.7: the renderer stays replaceable)', () => {
  it('no scaffold file imports remotion (or anything but react and the kit): renderer primitives come from the kit', () => {
    expect(moduleSpecifiers("import { useCurrentFrame } from 'remotion';\nimport type { X } from \"remotion\";\n// import 'y'\nexport * from 'z';")).toEqual(['remotion', 'remotion', 'z']);
    for (const kind of COMPONENT_KINDS) {
      const dir = scaffoldDir(kind);
      const files = readdirSync(dir).filter((f) => ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extname(f)));
      expect(files, kind).toContain('index.tsx');
      for (const file of files) {
        const specs = moduleSpecifiers(readFileSync(join(dir, file), 'utf8'));
        expect(specs.length, `${kind}/${file}`).toBeGreaterThan(0);
        expect(
          specs.filter((s) => s !== 'react' && s !== KIT_MODULE),
          `${kind}/${file}`,
        ).toEqual([]);
      }
    }
  });

  it('L7.2: no built-in component imports the renderer library either — every file of the library imports react and the kit only', () => {
    const ids = readdirSync(join(LIBRARY_DIR, 'studio')).filter((n) => !n.startsWith('.'));
    expect(ids.length).toBe(41);
    for (const id of ids) {
      const dir = join(LIBRARY_DIR, 'studio', id);
      const files = readdirSync(dir).filter((f) => ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extname(f)));
      expect(files, id).toContain('index.tsx');
      for (const file of files) {
        const specs = moduleSpecifiers(readFileSync(join(dir, file), 'utf8'));
        expect(specs.length, `${id}/${file}`).toBeGreaterThan(0);
        expect(
          specs.filter((s) => s !== 'react' && s !== KIT_MODULE),
          `studio/${id}/${file}`,
        ).toEqual([]);
      }
    }
  });

  it("L7.2: the kit names the renderer library in one file (kit/renderer.ts), and its public names are the same as before: that file's own list is not re-exported", async () => {
    const kitDir = join(PACKAGE_DIR, 'src', 'kit');
    const naming = readdirSync(kitDir)
      .filter((f) => ['.ts', '.tsx'].includes(extname(f)))
      .filter((f) => moduleSpecifiers(readFileSync(join(kitDir, f), 'utf8')).some((s) => s === 'remotion' || s.startsWith('remotion/') || s.startsWith('@remotion/')));
    expect(naming).toEqual(['renderer.ts']);
    const index = stripComments(readFileSync(join(kitDir, 'index.ts'), 'utf8'));
    // L7.34 (finding C4): the primitives held by what the kit hands, not by its export statement — the very objects of
    // the renderer seam (one copy of the library), and only these six of it.
    const kit = (await import('../src/kit/index.js')) as unknown as Record<string, unknown>;
    const seam = (await import('../src/kit/renderer.js')) as unknown as Record<string, unknown>;
    const primitives = ['AbsoluteFill', 'Img', 'Sequence', 'random', 'useCurrentFrame', 'useVideoConfig'];
    expect(primitives.filter((n) => kit[n] === undefined || kit[n] !== seam[n])).toEqual([]);
    expect(
      Object.keys(seam)
        .filter((n) => n in kit)
        .sort(),
    ).toEqual([...primitives].sort());
    expect(index).not.toMatch(/export \* from '\.\/renderer\.js'/);
    const names = await kitExports();
    expect(names).toEqual(KIT_PUBLIC_NAMES);
    for (const own of ['Loop', 'OffthreadVideo', 'cancelRender', 'continueRender', 'delayRender', 'Lottie']) expect(names, own).not.toContain(own);
  });
});

describe('scaffolds typecheck against the kit (strict TypeScript)', () => {
  it('has no type error', () => {
    const files = COMPONENT_KINDS.map((k) => join(scaffoldDir(k), 'index.tsx'));
    const program = ts.createProgram(files, {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
      baseUrl: PACKAGE_DIR,
      paths: {
        '@retake/components/kit': ['src/kit/index.ts'],
        '@retake/core': ['../core/src/index.ts'],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : '';
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
    expect(diagnostics).toEqual([]);
  });
});
