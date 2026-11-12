/**
 * Component previews (R-CMP-12/13/14): the spec of the ComponentPreview composition for one component and one theme —
 * pure. Intros, outros and cards alone; layouts with the sample screen as their capture, the brand mark and the
 * theme's caption; captions and overlays over the theme's layout with the sample screen; transitions from such a
 * scene into the theme's card; interstitials over the scene as their backdrop. Rendering: ./render/preview.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedTemplate } from '@retake/core/model';
import {
  PREVIEW_SAMPLES_DIR,
  applyParamDefaults,
  evalLayoutGeometry,
  fillSlots,
  isMultiPaneGeometry,
  previewMoment,
} from '@retake/components';
import type { LayoutPaneRects } from '@retake/components';
import { planPaneLayout } from './panes.js';
import { MEDIA_SLOT_TYPES } from '@retake/components';
import type { CaptionCue, ComponentManifest, ComponentRegistry, JsonSchemaNode, MediaValue, ResolvedComponentRef, ThemeTokens } from '@retake/components';
import { FALLBACK_GEOMETRY, planLayout } from './layout.js';
import { brandmarkRect, layoutRects } from './remotion/frames.js';
import type { ComponentPreviewSpec, PreviewRect, PreviewScene, PreviewUse } from './remotion/preview-types.js';
import { transitionKindOf } from './resolve.js';
import { loupeRegion } from './tutorial.js';

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
  /** A text field of the screen (a loupe preview magnifies it), sample px. */
  field?: PreviewRect;
}

/** Sample artefacts for previews of components with `email` / `document` slots (files absolute). */
export interface PreviewMediaSamples {
  email?: { file: string; width: number; height: number; from: string; from_name?: string; to: string[]; subject: string; date: string; preview: string };
  document?: { file_name: string; pages: Array<{ file: string; width: number; height: number; width_pt: number; height_pt: number }> };
  /** Two states of one screen, for `frame` slots (before / after cards). */
  frames?: Array<{ file: string; width: number; height: number; label: string }>;
  /** A user image for `media` slots (studio/media, L2.12). */
  image?: { file: string; width: number; height: number };
  /** A Lottie animation for `lottie` slots (studio/lottie, L2.12). */
  lottie?: { file: string; width: number; height: number; fps: number; frames: number };
}

/** The table a preview shows for `data` slots (chart cards). */
export const SAMPLE_TABLE = {
  columns: ['month', 'quotes'],
  rows: [
    ['Jan', '42'],
    ['Feb', '51'],
    ['Mar', '64'],
    ['Apr', '73'],
    ['May', '88'],
    ['Jun', '112'],
  ],
};

export type PreviewSamples = Record<PreviewScreenName, PreviewSample> & { media?: PreviewMediaSamples };

/** The sample screens shipped with the components package. */
export function loadPreviewSamples(dir = PREVIEW_SAMPLES_DIR): PreviewSamples {
  const meta = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8')) as Record<PreviewScreenName, Omit<PreviewSample, 'file'> & { file: string }>;
  const out = {} as PreviewSamples;
  for (const name of ['desktop', 'tablet', 'phone'] as const) {
    const m = meta[name];
    if (!m) throw new Error(`preview samples: ${name} is missing from ${join(dir, 'samples.json')}`);
    out[name] = { ...m, file: join(dir, m.file) };
  }
  const media = (meta as unknown as { media?: PreviewMediaSamples }).media;
  if (media) {
    out.media = {};
    if (media.email) out.media.email = { ...media.email, file: join(dir, media.email.file) };
    if (media.document) out.media.document = { ...media.document, pages: media.document.pages.map((p) => ({ ...p, file: join(dir, p.file) })) };
    if (media.frames) out.media.frames = media.frames.map((f) => ({ ...f, file: join(dir, f.file) }));
    if (media.image) out.media.image = { ...media.image, file: join(dir, media.image.file) };
    if (media.lottie) out.media.lottie = { ...media.lottie, file: join(dir, media.lottie.file) };
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
  /** Slot values over the manifest's preview samples (an MCP component_preview's; the caller checks them). */
  slots?: Record<string, string>;
  /** Params over the manifest's preview params (the caller validates them against the params schema). */
  params?: Record<string, unknown>;
  /**
   * Motion mode (L4.7, a looping preview): a transition gets a lead-in on the outgoing scene and a hold on the settled
   * card around it (`spec.motion`); every other kind already animates over its duration. Stills never set it: their
   * spec stays exactly as before.
   */
  motion?: boolean;
}

/** Motion mode's lead-in (outgoing scene) and hold (settled card) around a transition, seconds. */
export const PREVIEW_MOTION = { lead_s: 0.6, tail_s: 1.0 } as const;

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

function defaults(manifest: ComponentManifest, over: Record<string, unknown> = {}): Record<string, unknown> {
  return applyParamDefaults(manifest.params as JsonSchemaNode | undefined, { ...((manifest.preview?.params as Record<string, unknown> | undefined) ?? {}), ...over });
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

  /**
   * Sample media for the media slots a preview fills (`email: sample`, `document: sample`, `notification: sample`,
   * `capture: …`, `before: sample`, `data: sample`).
   */
  let frameIndex = 0;
  const sampleMedia = (manifest: ComponentManifest, slots: Record<string, string | undefined>): Record<string, MediaValue> | undefined => {
    let out: Record<string, MediaValue> | undefined;
    for (const [name, spec] of Object.entries(manifest.slots)) {
      if (!(MEDIA_SLOT_TYPES as readonly string[]).includes(spec.type) || !slots[name]) continue;
      const m = samples.media;
      if (spec.type === 'capture') {
        (out ??= {})[name] = { kind: 'text', name: 'sample', value: slots[name]!, text: slots[name]! };
        continue;
      }
      if (spec.type === 'frame') {
        const f = m?.frames?.[frameIndex++ % Math.max(1, m.frames.length)];
        if (f) (out ??= {})[name] = { kind: 'picture', name, url: opts.sampleUrl(f.file), width: f.width, height: f.height, label: f.label };
        continue;
      }
      if (spec.type === 'data') {
        (out ??= {})[name] = { kind: 'table', name: 'sample.csv', columns: [...SAMPLE_TABLE.columns], rows: SAMPLE_TABLE.rows.map((r) => [...r]) };
        continue;
      }
      if (spec.type === 'media' && m?.image) {
        (out ??= {})[name] = { kind: 'picture', name: 'sample', url: opts.sampleUrl(m.image.file), width: m.image.width, height: m.image.height, label: 'sample image' };
        continue;
      }
      if (spec.type === 'lottie' && m?.lottie) {
        const l = m.lottie;
        (out ??= {})[name] = { kind: 'lottie', name: 'sample', url: opts.sampleUrl(l.file), width: l.width, height: l.height, fps: l.fps, frames: l.frames, duration_s: Math.round((l.frames / l.fps) * 1000) / 1000 };
        continue;
      }
      if (spec.type === 'email' && m?.email) {
        const e = m.email;
        (out ??= {})[name] = { kind: 'email', name: 'sample', from: e.from, ...(e.from_name ? { from_name: e.from_name } : {}), to: e.to, subject: e.subject, date: e.date, preview: e.preview, image: { url: opts.sampleUrl(e.file), width: e.width, height: e.height } };
      } else if (spec.type === 'document' && m?.document) {
        (out ??= {})[name] = { kind: 'document', name: 'sample', file_name: m.document.file_name, pages: m.document.pages.map((p, i) => ({ url: opts.sampleUrl(p.file), width: p.width, height: p.height, width_pt: p.width_pt, height_pt: p.height_pt, number: i + 1 })) };
      } else if (spec.type === 'notification') {
        (out ??= {})[name] = { kind: 'notification', name: 'sample', title: 'New quote request', body: 'Café Lumen asks for 10 × 5 kg of Selowa Ridge.', app: 'console.northfield.example', time: '2026-10-12T09:41:00.000Z' };
      }
    }
    return out;
  };
  const use = (id: string, manifest: ComponentManifest, given: Record<string, string | undefined>, params: Record<string, unknown>, secondsLong: number): PreviewUse => {
    used.add(id);
    const slots = fillSlots(manifest, given, slotCtx).slots;
    const media = sampleMedia(manifest, slots);
    return { id, kind: manifest.kind, slots, params, durationInFrames: Math.max(1, Math.round(secondsLong * fps)), ...(media ? { media } : {}) };
  };
  const contextOf = (kind: 'layout' | 'caption' | 'card', fallbackId: string): ResolvedComponentRef => {
    const rc = theme[kind];
    if (rc) return rc;
    return registry.resolve(fallbackId, kind);
  };

  const previewSlots: Record<string, string> = { ...((m.preview?.slots as Record<string, string> | undefined) ?? {}), ...(opts.slots ?? {}) };
  const main = use(target.id, m, previewSlots, defaults(m, opts.params), m.kind === 'transition' ? 0 : seconds(m, 4));
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
  /**
   * A multi-page layout (L2.11) with one sample screen per page (`preview.screens`, default desktop + desktop): the
   * geometry evaluated with both samples' aspects, each page placed as the planner places it (split: top-aligned in its
   * pane; picture in picture: the main page, the inset at its default corner); the first page acts.
   */
  const multiScene = (): PreviewScene | undefined => {
    const geo = m.geometry;
    if (m.kind !== 'layout' || !geo || !isMultiPaneGeometry(geo)) return undefined;
    const names = (m.preview?.screens ?? ['desktop', 'desktop']) as PreviewScreenName[];
    const smp = names.map((n) => samples[n]);
    const params = main.params;
    const g = evalLayoutGeometry(geo, params, { aspect: smp[0].width / smp[0].height, aspect2: smp[1].width / smp[1].height });
    const radius = g.radius ?? (typeof params.radius === 'number' ? params.radius : 0);
    const pip = geo.inset !== undefined;
    const rectsOf = pip ? [g.screen, g.inset!] : g.panes!;
    const labels = ['Café · shop', 'Roaster · console'];
    const panes: LayoutPaneRects[] = smp.map((sm, i) => {
      const inset = pip && i === 1;
      const pl = planPaneLayout(rectsOf[i], { variant: 'landscape', unit, cssWidth: sm.width, cssHeight: sm.height, radius: inset ? Math.min(radius, 22) : radius, top: !pip });
      const r = inset ? { x: rectsOf[i].x * unit, y: rectsOf[i].y * unit, w: rectsOf[i].w * unit, h: rectsOf[i].h * unit } : pl.capture;
      return {
        page: `page${i + 1}`,
        ...(pip ? {} : { label: labels[i] }),
        screen: r,
        frame: inset ? r : pl.card,
        radius: pl.radius,
        acting: i === 0 ? 1 : 0,
        ...(inset ? { inset: true } : {}),
        ...(names[i] === 'phone' ? { mobile: true } : {}),
        url: sm.url,
      };
    });
    const s = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * unit, y: r.y * unit, w: r.w * unit, h: r.h * unit });
    const rects = { screen: s(g.screen), frame: s(g.screen), radius: radius * unit, panes, ...(g.caption ? { caption: s(g.caption) } : {}), ...(g.brandmark ? { brandmark: s(g.brandmark) } : {}) };
    const bm = brandmarkRect({ width, height }, rects.brandmark, t.brandmark?.position ?? 'bottom-right');
    const out: PreviewScene = {
      layout: { ...main },
      rects,
      screen: { url: opts.sampleUrl(smp[0].file), width: smp[0].width, height: smp[0].height },
      screens: smp.map((sm) => ({ url: opts.sampleUrl(sm.file), width: sm.width, height: sm.height })),
      url: smp[0].url,
    };
    if (bm) out.brandmark = { rect: bm.rect, align: bm.align, size: tokens.brandmark?.size ?? t.brandmark?.size ?? 30, opacity: tokens.brandmark?.opacity ?? 1 };
    return out;
  };

  switch (m.kind) {
    case 'layout': {
      const multi = multiScene();
      if (multi) {
        spec.scene = { ...multi, caption: captionUse(contextOf('caption', 'studio/caption-below')) };
        break;
      }
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
      const slots: { text?: string; kicker?: string } = m.preview?.slots || opts.slots ? previewSlots : SAMPLE_CAPTION;
      const c = { ...main, cues: [{ from: 0, to: FOREVER, text: slots.text ?? SAMPLE_CAPTION.text, ...(slots.kicker ? { kicker: slots.kicker } : {}), scene: 'preview' }] };
      spec.scene = scene(layout.id, layout.manifest, layout.params, c);
      break;
    }
    case 'overlay': {
      // The overlay alone over the theme's layout (a caption band over the capture would compete with it).
      spec.scene = themeScene(false);
      const cap = spec.scene.rects.screen;
      const k = cap.w / sample.width;
      const field = m.preview?.target === 'field' ? sample.field : undefined;
      // A loupe magnifies a field: its region (the field padded, as the planner does) is the overlay's `screen`.
      const a = field ? loupeRegion(field, { w: sample.width, h: sample.height }) : sample.anchor;
      if (field) spec.region = a;
      if (a) spec.anchor = { x: cap.x + a.x * k, y: cap.y + a.y * k, w: a.w * k, h: a.h * k };
      // The moment shown (a key press, a click) and sample chapters (a progress bar), as the planner hands them.
      spec.moment = Math.round(0.3 * fps);
      const n = main.durationInFrames;
      const cuts = [0, 0.22, 0.47, 0.71, 1].map((x) => Math.round(x * n));
      spec.chapters = ['Sign up', 'Confirm', 'Browse', 'Request a quote'].map((label, i) => ({ id: `chapter-${i + 1}`, label, from: cuts[i], to: cuts[i + 1] }));
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
      // The box a tap-open transition opens from: the sample screen's button (other transitions ignore it).
      const a = sample.anchor;
      if (a) {
        const cap = spec.scene.rects.screen;
        const k = cap.w / sample.width;
        spec.anchor = { x: cap.x + a.x * k, y: cap.y + a.y * k, w: a.w * k, h: a.h * k };
      }
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
  if (opts.motion && m.kind === 'transition') {
    // The transition plays between `lead` frames of the outgoing scene and `tail` frames of the settled card; the
    // still's moment moves with it (a poster of a motion spec shows the same instant of the transition).
    const lead = Math.round(PREVIEW_MOTION.lead_s * fps);
    const tail = Math.round(PREVIEW_MOTION.tail_s * fps);
    spec.motion = { lead, tail };
    spec.frame += lead;
    spec.durationInFrames = lead + main.durationInFrames + tail;
  }
  return { spec, at, ...(screen ? { screen } : {}), components: [...used].sort() };
}
