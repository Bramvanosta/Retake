/**
 * Component previews (R-CMP-12/13/14): the spec of the ComponentPreview composition for one component and one theme —
 * pure. Intros, outros and cards alone; layouts with the sample screen as their capture, the brand mark and the
 * theme's caption; captions and overlays over the theme's layout with the sample screen; transitions from such a
 * scene into the theme's card; interstitials over the scene as their backdrop. Rendering: ./render/preview.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedTemplate } from '@retake/core/theme';
import { PREVIEW_SAMPLES_DIR, applyParamDefaults, evalLayoutGeometry, fillSlots, isMultiPaneGeometry, previewMoment } from '@retake/components';
import type { LayoutPaneRects } from '@retake/components';
import { planPaneLayout } from './panes.js';
import { MEDIA_SLOT_TYPES } from '@retake/components';
import type { CaptionCue, ComponentManifest, ComponentRegistry, JsonSchemaNode, MediaValue, ResolvedComponentRef, ThemeTokens } from '@retake/components';
import { FALLBACK_GEOMETRY, planLayout } from './layout.js';
import { brandmarkRect, layoutRects } from './remotion/frames.js';
import type { ComponentPreviewSpec, PreviewScene, PreviewUse } from './remotion/preview-types.js';
import { transitionKindOf } from './resolve.js';
import { loupeRegion } from './tutorial.js';
import type { PreviewScreenName, PreviewSample, PreviewMediaSamples, PreviewSamples } from './work-types.js';
export type { PreviewScreenName, PreviewSample, PreviewMediaSamples, PreviewSamples } from './work-types.js';

export type { ComponentPreviewSpec, PreviewScene, PreviewUse } from './remotion/preview-types.js';

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
   * Motion mode (a looping preview): a transition gets a lead-in on the outgoing scene and a hold on the settled
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

/** What a preview's parts are built from: its options, size, theme and sample screen, and the components it uses. */
interface PreviewBuild {
  opts: BuildPreviewOptions;
  m: ComponentManifest;
  width: number;
  height: number;
  fps: number;
  unit: number;
  t: LoadedTemplate['template'];
  slotCtx: { theme: ThemeTokens; templateOutro: { tagline: string | undefined; url: string | undefined } };
  theme: ReturnType<ComponentRegistry['resolveTheme']>;
  used: Set<string>;
  /** The next sample frame a `frame` slot takes. */
  frameIndex: number;
  sample: PreviewSample;
}

/** A component and its params, as a preview uses it. */
type PreviewRef = Pick<ResolvedComponentRef, 'id' | 'manifest' | 'params'>;

/**
 * Sample media for the media slots a preview fills (`email: sample`, `document: sample`, `notification: sample`,
 * `capture: …`, `before: sample`, `data: sample`).
 */
function sampleMedia(b: PreviewBuild, manifest: ComponentManifest, slots: Record<string, string | undefined>): Record<string, MediaValue> | undefined {
  const { opts } = b;
  let out: Record<string, MediaValue> | undefined;
  for (const [name, spec] of Object.entries(manifest.slots)) {
    if (!(MEDIA_SLOT_TYPES as readonly string[]).includes(spec.type) || !slots[name]) continue;
    const m = opts.samples.media;
    if (spec.type === 'capture') {
      (out ??= {})[name] = { kind: 'text', name: 'sample', value: slots[name]!, text: slots[name]! };
      continue;
    }
    if (spec.type === 'frame') {
      const f = m?.frames?.[b.frameIndex++ % Math.max(1, m.frames.length)];
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
      (out ??= {})[name] = {
        kind: 'lottie',
        name: 'sample',
        url: opts.sampleUrl(l.file),
        width: l.width,
        height: l.height,
        fps: l.fps,
        frames: l.frames,
        duration_s: Math.round((l.frames / l.fps) * 1000) / 1000,
      };
      continue;
    }
    if (spec.type === 'email' && m?.email) {
      const e = m.email;
      (out ??= {})[name] = {
        kind: 'email',
        name: 'sample',
        from: e.from,
        ...(e.from_name ? { from_name: e.from_name } : {}),
        to: e.to,
        subject: e.subject,
        date: e.date,
        preview: e.preview,
        image: { url: opts.sampleUrl(e.file), width: e.width, height: e.height },
      };
    } else if (spec.type === 'document' && m?.document) {
      (out ??= {})[name] = {
        kind: 'document',
        name: 'sample',
        file_name: m.document.file_name,
        pages: m.document.pages.map((p, i) => ({ url: opts.sampleUrl(p.file), width: p.width, height: p.height, width_pt: p.width_pt, height_pt: p.height_pt, number: i + 1 })),
      };
    } else if (spec.type === 'notification') {
      (out ??= {})[name] = {
        kind: 'notification',
        name: 'sample',
        title: 'New quote request',
        body: 'Café Lumen asks for 10 × 5 kg of Selowa Ridge.',
        app: 'console.northfield.example',
        time: '2026-10-12T09:41:00.000Z',
      };
    }
  }
  return out;
}

/** A use of a component in the preview (its slots filled, sample media given), recorded among the components used. */
function use(b: PreviewBuild, ref: PreviewRef, given: Record<string, string | undefined>, secondsLong: number): PreviewUse {
  const { id, manifest, params } = ref;
  b.used.add(id);
  const slots = fillSlots(manifest, given, b.slotCtx).slots;
  const media = sampleMedia(b, manifest, slots);
  return { id, kind: manifest.kind, slots, params, durationInFrames: Math.max(1, Math.round(secondsLong * b.fps)), ...(media ? { media } : {}) };
}

/** The theme's component of a context kind, else the built-in fallback. */
function contextOf(b: PreviewBuild, kind: 'layout' | 'caption' | 'card', fallbackId: string): ResolvedComponentRef {
  const rc = b.theme[kind];
  if (rc) return rc;
  return b.opts.registry.resolve(fallbackId, kind);
}

/** The theme's brand mark in a scene's brand mark area, if any. */
function brandmarkOf(b: PreviewBuild, area: Parameters<typeof brandmarkRect>[1]): PreviewScene['brandmark'] | undefined {
  const { opts, t } = b;
  const bm = brandmarkRect({ width: b.width, height: b.height }, area, t.brandmark?.position ?? 'bottom-right');
  if (!bm) return undefined;
  return { rect: bm.rect, align: bm.align, size: opts.tokens.brandmark?.size ?? t.brandmark?.size ?? 30, opacity: opts.tokens.brandmark?.opacity ?? 1 };
}

/** A scene: `layout` (manifest + params) with the sample screen, the theme's brand mark and a caption. */
function scene(b: PreviewBuild, layoutRef: PreviewRef, caption?: PreviewUse & { cues: CaptionCue[] }): PreviewScene {
  const { opts, sample, unit } = b;
  const { manifest: layoutManifest, params } = layoutRef;
  const spec = layoutManifest.geometry;
  const geometry = spec ? evalLayoutGeometry(spec, params, { aspect: sample.width / sample.height }) : FALLBACK_GEOMETRY.landscape;
  const radius = typeof params.radius === 'number' ? params.radius : undefined;
  const layout = planLayout(geometry, { variant: 'landscape', unit, cssWidth: sample.width, cssHeight: sample.height, radius: geometry.radius ?? radius });
  const bm = brandmarkOf(b, layout.brandmark);
  const out: PreviewScene = {
    layout: use(b, layoutRef, {}, 4),
    rects: layoutRects(layout),
    screen: { url: opts.sampleUrl(sample.file), width: sample.width, height: sample.height },
    url: sample.url,
  };
  if (caption) out.caption = caption;
  if (bm) out.brandmark = bm;
  return out;
}

/** A caption use with one cue over the whole preview: the given text, else the manifest's samples, else ours. */
function captionUse(b: PreviewBuild, rc: ResolvedComponentRef, given?: { text?: string; kicker?: string }): PreviewUse & { cues: CaptionCue[] } {
  const slots = given ?? (rc.manifest.preview?.slots as { text?: string; kicker?: string } | undefined) ?? SAMPLE_CAPTION;
  const text = slots.text ?? SAMPLE_CAPTION.text;
  return {
    ...use(b, rc, { text, ...(slots.kicker ? { kicker: slots.kicker } : {}) }, 4),
    cues: [{ from: 0, to: FOREVER, text, ...(slots.kicker ? { kicker: slots.kicker } : {}), scene: 'preview' }],
  };
}

/** The theme's layout with the sample screen, with or without the theme's caption. */
function themeScene(b: PreviewBuild, withCaption: boolean): PreviewScene {
  const layout = contextOf(b, 'layout', 'studio/layout-card');
  return scene(b, layout, withCaption ? captionUse(b, contextOf(b, 'caption', 'studio/caption-below')) : undefined);
}

/**
 * A multi-page layout with one sample screen per page (`preview.screens`, default desktop + desktop): the
 * geometry evaluated with both samples' aspects, each page placed as the planner places it (split: top-aligned in its
 * pane; picture in picture: the main page, the inset at its default corner); the first page acts.
 */
function multiScene(b: PreviewBuild, main: PreviewUse): PreviewScene | undefined {
  const { opts, m, unit } = b;
  const geo = m.geometry;
  if (m.kind !== 'layout' || !geo || !isMultiPaneGeometry(geo)) return undefined;
  const names = (m.preview?.screens ?? ['desktop', 'desktop']) as PreviewScreenName[];
  const smp = names.map((n) => opts.samples[n]);
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
  const bm = brandmarkOf(b, rects.brandmark);
  const out: PreviewScene = {
    layout: { ...main },
    rects,
    screen: { url: opts.sampleUrl(smp[0].file), width: smp[0].width, height: smp[0].height },
    screens: smp.map((sm) => ({ url: opts.sampleUrl(sm.file), width: sm.width, height: sm.height })),
    url: smp[0].url,
  };
  if (bm) out.brandmark = bm;
  return out;
}

/** A layout's scene: its pages, or the sample screen with the caption that suits its caption area. */
function layoutScene(b: PreviewBuild, main: PreviewUse): PreviewScene {
  const { opts, m } = b;
  const multi = multiScene(b, main);
  if (multi) return { ...multi, caption: captionUse(b, contextOf(b, 'caption', 'studio/caption-below')) };
  // A layout whose caption area lies over the capture (full frame) is shown with the overlay caption, its pair.
  const probe = scene(b, { id: opts.target.id, manifest: m, params: main.params });
  const cap = probe.rects.caption;
  const sc = probe.rects.screen;
  const over = cap && cap.x < sc.x + sc.w && cap.x + cap.w > sc.x && cap.y < sc.y + sc.h && cap.y + cap.h > sc.y;
  const caption = over && opts.registry.has('studio/caption-overlay') ? opts.registry.resolve('studio/caption-overlay', 'caption') : contextOf(b, 'caption', 'studio/caption-below');
  return { ...probe, caption: captionUse(b, caption) };
}

/** An overlay's spec: the theme's layout, the anchor (or a loupe's region), the moment and sample chapters. */
function overlaySpec(b: PreviewBuild, spec: ComponentPreviewSpec, main: PreviewUse): void {
  const { m, sample, fps } = b;
  // The overlay alone over the theme's layout (a caption band over the capture would compete with it).
  spec.scene = themeScene(b, false);
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
}

/** A transition's spec: its length, its kind, the theme's scene with a caption, the anchor and the incoming card. */
function transitionSpec(b: PreviewBuild, spec: ComponentPreviewSpec, main: PreviewUse): void {
  const { opts, m, sample, fps } = b;
  const d = typeof main.params.duration === 'number' ? main.params.duration : (m.duration?.default ?? 0.35);
  main.durationInFrames = Math.max(2, Math.round(d * fps));
  spec.transitionKind = transitionKindOf({ id: opts.target.id, params: main.params }) === 'fade-black' ? 'fade-black' : 'crossfade';
  spec.scene = themeScene(b, true);
  // The box a tap-open transition opens from: the sample screen's button (other transitions ignore it).
  const a = sample.anchor;
  if (a) {
    const cap = spec.scene.rects.screen;
    const k = cap.w / sample.width;
    spec.anchor = { x: cap.x + a.x * k, y: cap.y + a.y * k, w: a.w * k, h: a.h * k };
  }
  const card = contextOf(b, 'card', 'studio/card-title');
  const cardSlots = (card.manifest.preview?.slots as Record<string, string> | undefined) ?? SAMPLE_CARD;
  spec.incoming = use(b, card, cardSlots, seconds(card.manifest, 2.5));
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
  const at = opts.at ?? previewMoment(m);
  const t = opts.template.template;
  const slotCtx = { theme: tokens, templateOutro: { tagline: t.outro.tagline, url: t.outro.url } };
  const theme = registry.resolveTheme(t);
  const screenName: PreviewScreenName = m.preview?.screen ?? 'desktop';
  const b: PreviewBuild = { opts, m, width, height, fps, unit: width / 1920, t, slotCtx, theme, used: new Set<string>([target.id]), frameIndex: 0, sample: samples[screenName] };

  const previewSlots: Record<string, string> = { ...((m.preview?.slots as Record<string, string> | undefined) ?? {}), ...(opts.slots ?? {}) };
  const main = use(b, { id: target.id, manifest: m, params: defaults(m, opts.params) }, previewSlots, m.kind === 'transition' ? 0 : seconds(m, 4));

  const spec: ComponentPreviewSpec = { width, height, fps, durationInFrames: main.durationInFrames, frame: 0, theme: tokens, main };
  let screen: PreviewScreenName | undefined = screenName;
  switch (m.kind) {
    case 'layout':
      spec.scene = layoutScene(b, main);
      break;
    case 'caption': {
      const layout = contextOf(b, 'layout', 'studio/layout-card');
      const slots: { text?: string; kicker?: string } = m.preview?.slots || opts.slots ? previewSlots : SAMPLE_CAPTION;
      const c = { ...main, cues: [{ from: 0, to: FOREVER, text: slots.text ?? SAMPLE_CAPTION.text, ...(slots.kicker ? { kicker: slots.kicker } : {}), scene: 'preview' }] };
      spec.scene = scene(b, layout, c);
      break;
    }
    case 'overlay':
      overlaySpec(b, spec, main);
      break;
    case 'interstitial':
      spec.scene = themeScene(b, false);
      break;
    case 'transition':
      transitionSpec(b, spec, main);
      break;
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
  return { spec, at, ...(screen ? { screen } : {}), components: [...b.used].sort() };
}
