/**
 * Component previews (R-CMP-12/13/14): the spec of the ComponentPreview composition for one component and one theme —
 * pure. Intros, outros and cards alone; layouts with the sample screen as their capture, the brand mark and the
 * theme's caption; captions and overlays over the theme's layout with the sample screen; transitions from such a
 * scene into the theme's card; interstitials over the scene as their backdrop. Rendering: ./render/preview.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedTemplate } from '@demo-studio/core';
import {
  PREVIEW_SAMPLES_DIR,
  applyParamDefaults,
  evalLayoutGeometry,
  fillSlots,
  previewMoment,
} from '@demo-studio/components';
import type { CaptionCue, ComponentManifest, ComponentRegistry, JsonSchemaNode, ResolvedComponentRef, ThemeTokens } from '@demo-studio/components';
import { FALLBACK_GEOMETRY, planLayout } from './layout.js';
import { brandmarkRect, layoutRects } from './remotion/frames.js';
import type { ComponentPreviewSpec, PreviewRect, PreviewScene, PreviewUse } from './remotion/preview-types.js';
import { transitionKindOf } from './resolve.js';

export type { ComponentPreviewSpec, PreviewScene, PreviewUse } from './remotion/preview-types.js';

export type PreviewScreenName = 'desktop' | 'tablet' | 'phone';

/** A neutral sample screen (packages/components/preview/, generated once from the fixture by scripts/preview-samples.mjs). */
export interface PreviewSample {
  /** Absolute image file. */
  file: string;
  width: number;
  height: number;
  /** Address a browser layout shows. */
  url: string;
  /** A button of the screen (overlay previews point at it), sample px. */
  anchor?: PreviewRect;
}

export type PreviewSamples = Record<PreviewScreenName, PreviewSample>;

/** The sample screens shipped with the components package. */
export function loadPreviewSamples(dir = PREVIEW_SAMPLES_DIR): PreviewSamples {
  const meta = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8')) as Record<PreviewScreenName, Omit<PreviewSample, 'file'> & { file: string }>;
  const out = {} as PreviewSamples;
  for (const name of ['desktop', 'tablet', 'phone'] as const) {
    const m = meta[name];
    if (!m) throw new Error(`preview samples: ${name} is missing from ${join(dir, 'samples.json')}`);
    out[name] = { ...m, file: join(dir, m.file) };
  }
  return out;
}

/** The component a preview shows (a registry entry, or a scaffold / a folder outside the registry). */
export interface PreviewTarget {
  id: string;
  manifest: ComponentManifest;
}

export interface BuildPreviewOptions {
  target: PreviewTarget;
  template: LoadedTemplate;
  /** Theme tokens with SERVED urls (logo, wordmark, fonts). */
  tokens: ThemeTokens;
  /** Context components (the theme's layout, caption, card) come from it. */
  registry: ComponentRegistry;
  samples: PreviewSamples;
  /** Served URL of a sample image file. */
  sampleUrl: (file: string) => string;
  /** Output size (default 1920×1080: the image is rendered at half scale, 960×540). */
  width?: number;
  height?: number;
  fps?: number;
  /** Second shown (default: the manifest's last `preview.at`). */
  at?: number;
}

export interface BuiltPreview {
  spec: ComponentPreviewSpec;
  /** Second shown. */
  at: number;
  /** Sample screen used, when the preview shows one. */
  screen?: PreviewScreenName;
  /** Ids of the components the preview renders (the target + context components). */
  components: string[];
}

const FOREVER = Number.MAX_SAFE_INTEGER;
/** Sample caption of layout / overlay / transition previews when the caption component has no preview slots. */
const SAMPLE_CAPTION = { kicker: 'Quotes', text: 'Pick a customer and the price list follows.' };
/** Sample card entering a transition preview when the card component has no preview slots. */
const SAMPLE_CARD = { kicker: 'Chapter two', title: 'From quote to order' };

function defaults(manifest: ComponentManifest): Record<string, unknown> {
  return applyParamDefaults(manifest.params as JsonSchemaNode | undefined, (manifest.preview?.params as Record<string, unknown> | undefined) ?? {});
}

function seconds(manifest: ComponentManifest, fallback: number): number {
  return manifest.duration?.default ?? fallback;
}

/**
 * The spec of a component's preview: what the ComponentPreview composition renders at `spec.frame`. Throws when the
 * theme cannot provide a needed context component (e.g. no layout at all).
 */
export function buildComponentPreview(opts: BuildPreviewOptions): BuiltPreview {
  const { target, tokens, registry, samples } = opts;
  const m = target.manifest;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const fps = opts.fps ?? 30;
  const unit = width / 1920;
  const at = opts.at ?? previewMoment(m);
  const t = opts.template.template;
  const slotCtx = { theme: tokens, templateOutro: { tagline: t.outro.tagline, url: t.outro.url } };
  const theme = registry.resolveTheme(t);
  const used = new Set<string>([target.id]);

  const use = (id: string, manifest: ComponentManifest, given: Record<string, string | undefined>, params: Record<string, unknown>, secondsLong: number): PreviewUse => {
    used.add(id);
    return { id, kind: manifest.kind, slots: fillSlots(manifest, given, slotCtx).slots, params, durationInFrames: Math.max(1, Math.round(secondsLong * fps)) };
  };
  const contextOf = (kind: 'layout' | 'caption' | 'card', fallbackId: string): ResolvedComponentRef => {
    const rc = theme[kind];
    if (rc) return rc;
    return registry.resolve(fallbackId, kind);
  };

  const main = use(target.id, m, (m.preview?.slots as Record<string, string> | undefined) ?? {}, defaults(m), m.kind === 'transition' ? 0 : seconds(m, 4));
  const screenName: PreviewScreenName = m.preview?.screen ?? 'desktop';
  const sample = samples[screenName];

  /** A scene: `layout` (manifest + params) with the sample screen, the theme's brand mark and a caption. */
  const scene = (layoutId: string, layoutManifest: ComponentManifest, params: Record<string, unknown>, caption?: PreviewUse & { cues: CaptionCue[] }): PreviewScene => {
    const spec = layoutManifest.geometry;
    const geometry = spec ? evalLayoutGeometry(spec, params, { aspect: sample.width / sample.height }) : FALLBACK_GEOMETRY.landscape;
    const radius = typeof params.radius === 'number' ? params.radius : undefined;
    const layout = planLayout(geometry, { variant: 'landscape', unit, cssWidth: sample.width, cssHeight: sample.height, radius: geometry.radius ?? radius });
    const bm = brandmarkRect({ width, height }, layout.brandmark, t.brandmark?.position ?? 'bottom-right');
    const out: PreviewScene = {
      layout: use(layoutId, layoutManifest, {}, params, 4),
      rects: layoutRects(layout),
      screen: { url: opts.sampleUrl(sample.file), width: sample.width, height: sample.height },
      url: sample.url,
    };
    if (caption) out.caption = caption;
    if (bm) out.brandmark = { rect: bm.rect, align: bm.align, size: tokens.brandmark?.size ?? t.brandmark?.size ?? 30, opacity: tokens.brandmark?.opacity ?? 1 };
    return out;
  };
  const captionUse = (rc: ResolvedComponentRef, given?: { text?: string; kicker?: string }): PreviewUse & { cues: CaptionCue[] } => {
    const slots = given ?? ((rc.manifest.preview?.slots as { text?: string; kicker?: string } | undefined) ?? SAMPLE_CAPTION);
    const text = slots.text ?? SAMPLE_CAPTION.text;
    return {
      ...use(rc.id, rc.manifest, { text, ...(slots.kicker ? { kicker: slots.kicker } : {}) }, rc.params, 4),
      cues: [{ from: 0, to: FOREVER, text, ...(slots.kicker ? { kicker: slots.kicker } : {}), scene: 'preview' }],
    };
  };
  const themeScene = (withCaption: boolean): PreviewScene => {
    const layout = contextOf('layout', 'studio/layout-card');
    return scene(layout.id, layout.manifest, layout.params, withCaption ? captionUse(contextOf('caption', 'studio/caption-below')) : undefined);
  };

  const spec: ComponentPreviewSpec = { width, height, fps, durationInFrames: main.durationInFrames, frame: 0, theme: tokens, main };
  let screen: PreviewScreenName | undefined = screenName;
  switch (m.kind) {
    case 'layout': {
      // A layout whose caption area lies over the capture (full frame) is shown with the overlay caption, its pair.
      const probe = scene(target.id, m, main.params);
      const cap = probe.rects.caption;
      const sc = probe.rects.screen;
      const over = cap && cap.x < sc.x + sc.w && cap.x + cap.w > sc.x && cap.y < sc.y + sc.h && cap.y + cap.h > sc.y;
      const caption = over && registry.has('studio/caption-overlay') ? registry.resolve('studio/caption-overlay', 'caption') : contextOf('caption', 'studio/caption-below');
      spec.scene = { ...probe, caption: captionUse(caption) };
      break;
    }
    case 'caption': {
      const layout = contextOf('layout', 'studio/layout-card');
      const slots = (m.preview?.slots as { text?: string; kicker?: string } | undefined) ?? SAMPLE_CAPTION;
      const c = { ...main, cues: [{ from: 0, to: FOREVER, text: slots.text ?? SAMPLE_CAPTION.text, ...(slots.kicker ? { kicker: slots.kicker } : {}), scene: 'preview' }] };
      spec.scene = scene(layout.id, layout.manifest, layout.params, c);
      break;
    }
    case 'overlay': {
      // The overlay alone over the theme's layout (a caption band over the capture would compete with it).
      spec.scene = themeScene(false);
      const cap = spec.scene.rects.screen;
      const a = sample.anchor;
      if (a) {
        const k = cap.w / sample.width;
        spec.anchor = { x: cap.x + a.x * k, y: cap.y + a.y * k, w: a.w * k, h: a.h * k };
      }
      break;
    }
    case 'interstitial':
      spec.scene = themeScene(false);
      break;
    case 'transition': {
      const d = typeof main.params.duration === 'number' ? main.params.duration : (m.duration?.default ?? 0.35);
      main.durationInFrames = Math.max(2, Math.round(d * fps));
      spec.transitionKind = transitionKindOf({ id: target.id, params: main.params }) === 'fade-black' ? 'fade-black' : 'crossfade';
      spec.scene = themeScene(true);
      const card = contextOf('card', 'studio/card-title');
      const cardSlots = (card.manifest.preview?.slots as Record<string, string> | undefined) ?? SAMPLE_CARD;
      spec.incoming = use(card.id, card.manifest, cardSlots, card.params, seconds(card.manifest, 2.5));
      break;
    }
    default:
      screen = undefined;
  }
  spec.frame = Math.max(0, Math.min(Math.round(at * fps), main.durationInFrames - 1));
  spec.durationInFrames = Math.max(main.durationInFrames, spec.frame + 1, 1);
  return { spec, at, ...(screen ? { screen } : {}), components: [...used].sort() };
}
