/**
 * Component (plugin) contract.
 *
 * Every visual element of an edit — intro, outro, cards, interstitials, captions, screen layouts, overlays,
 * transitions — is a component: a folder with `component.yaml` (this manifest) and a React (Remotion)
 * implementation whose default export receives `ComponentProps`. Components adapt to any theme: they only
 * read colours, fonts, logo, wordmark… from `theme` and never hard-code a brand.
 *
 * Resolution order of component ids: workspace `components/` → built-in library → (V2) cloud marketplace cache.
 */

import type { ComponentKind, ValidationIssue } from '@demo-studio/core';

/** A caption to show, in output frames [from, to) relative to the segment (or the video for plans). */
export interface CaptionCue {
  from: number;
  to: number;
  kicker?: string;
  text: string;
  scene: string;
}

/**
 * Component kinds and references are part of the shared data model (templates and scenarios refer to components):
 * their single source of truth is @demo-studio/core.
 */
export { COMPONENT_KINDS } from '@demo-studio/core';
export type { ComponentId, ComponentKind, ComponentRef } from '@demo-studio/core';

/** Output orientations: landscape 16:9 (1920×1080 design space), vertical 9:16 (1080×1920), square 1:1 (1080×1080). */
export type OutputVariant = 'landscape' | 'vertical' | 'square';

/**
 * Slot types. `email`, `document` and `notification` slots name a run artefact (L2.9): the scenario writes the
 * artefact's name (`email: welcome`, `document: quote` or a project file `assets/terms.pdf`, `notification: 1` or a
 * name) and the planner hands the component the captured data as `props.media[<slot>]`.
 */
export type SlotType = 'text' | 'image' | 'url' | 'color' | 'screen' | 'email' | 'document' | 'notification';

/** Slot types whose value names a run artefact (resolved into `ComponentProps.media`). */
export const ARTEFACT_SLOT_TYPES = ['email', 'document', 'notification'] as const;
export type ArtefactSlotType = (typeof ARTEFACT_SLOT_TYPES)[number];

export interface SlotSpec {
  type: SlotType;
  description?: string;
  required?: boolean;
  /**
   * Where the value comes from when the scenario does not set it:
   * theme.logo | theme.wordmark | theme.brand.name | theme.brand.url | scenario.title.text | scenario.title.kicker |
   * scenario.outro.tagline | scenario.outro.url | scene.caption.text | …
   */
  default_from?: string;
  /** Soft length limit used by validation/review (text slots). */
  max_chars?: number;
}

export interface Rect1920 {
  /** Rectangle in a 1920×1080 (landscape), 1080×1920 (vertical) or 1080×1080 (square) design space. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A rect of a layout manifest: each value is a number or an arithmetic expression over the numeric params, the
 * geometry `vars` and `aspect` (see ./geometry.ts).
 */
export interface RectSpec1920 {
  x: number | string;
  y: number | string;
  w: number | string;
  h: number | string;
}

/**
 * The geometry as written in component.yaml: like LayoutGeometry, with expressions allowed for every value and
 * named intermediate values (`vars`, evaluated in order). `evalLayoutGeometry(spec, params, {aspect})` resolves it.
 */
export interface LayoutGeometrySpec {
  vars?: Record<string, number | string>;
  screen: RectSpec1920;
  frame?: RectSpec1920;
  chrome?: RectSpec1920;
  caption?: RectSpec1920;
  brandmark?: RectSpec1920;
  radius?: number | string;
}

/**
 * Layout components declare their geometry so the planner and the review can reason without rendering: this is the
 * evaluated form (design px), for one set of params and one capture aspect.
 */
export interface LayoutGeometry {
  /** Where the capture pixels go (for a 16:9 capture; the planner keeps the capture aspect ratio inside it). */
  screen: Rect1920;
  /** Outer shape around the screen (card, device…); defaults to screen. */
  frame?: Rect1920;
  /** Browser chrome bar, when the layout draws one. */
  chrome?: Rect1920;
  /** Caption area used by the caption component. */
  caption?: Rect1920;
  brandmark?: Rect1920;
  radius?: number;
}

/**
 * Where a component draws its "tap target" (a notification banner, an app icon) at the end of its segment, in the
 * design space of the variant: a transition such as studio/transition-tap-open zooms from it into the next segment.
 * Values may be expressions over the numeric params, the string params as one-hot names (`<param>_<value>`: 1 when the
 * param has that value — `style_ios_banner`; non-alphanumerics become "_"), `vars` and `aspect`.
 */
export interface AnchorSpec {
  vars?: Record<string, number | string>;
  x: number | string;
  y: number | string;
  w: number | string;
  h: number | string;
}

export interface ComponentManifest {
  /** "namespace/name", e.g. "studio/intro-stack". */
  id: string;
  /** Semver. */
  version: string;
  kind: ComponentKind;
  name: string;
  description: string;
  /** V2 marketplace metadata. */
  publisher?: string;
  license?: string;
  tags?: string[];
  /** Implementation file relative to the component dir (default "index.tsx"). */
  entry?: string;
  slots: Record<string, SlotSpec>;
  /** JSON Schema (object) of the params, with defaults. */
  params?: Record<string, unknown>;
  /** Theme tokens the component reads (colors.accent, fonts.display, logo…), for previews and validation. */
  tokens?: string[];
  /** Seconds (cards, intros, outros, interstitials, overlays). */
  duration?: { default: number; min?: number; max?: number };
  /** Layout kind only: values may be expressions over the params (evaluated by `evalLayoutGeometry`). */
  geometry?: LayoutGeometrySpec;
  geometry_vertical?: LayoutGeometrySpec;
  /** Square variant (1080×1080 design space). */
  geometry_square?: LayoutGeometrySpec;
  /** The component's tap target at the end of its segment (landscape design space), for tap-open transitions. */
  anchor?: AnchorSpec;
  anchor_vertical?: AnchorSpec;
  anchor_square?: AnchorSpec;
  variants?: Array<OutputVariant>;
  /** Sample values used to render previews with any theme. */
  /**
   * Sample values used to render previews with any theme: slots, params, the seconds at which stills are taken (the
   * committed preview.png shows the last one) and the sample screen layouts show (default desktop).
   */
  preview?: { slots?: Record<string, string>; params?: Record<string, unknown>; at?: number[]; screen?: 'desktop' | 'tablet' | 'phone' };
}

/** A font file the host composition registers (`@font-face`) under a theme font family. */
export interface ThemeFontFace {
  family: string;
  url: string;
  /** CSS font-weight (inferred from the file name: Regular 400, SemiBold 600, Bold 700…). */
  weight: number;
  style: 'normal' | 'italic';
}

/** A template TextStyle with its colour resolved to CSS and its font resolved to a family name. */
export interface ThemeTextStyle {
  /** CSS font-family name (theme.fonts.display or theme.fonts.body). */
  font: string;
  weight?: number;
  /** Design px (1920-wide space): multiply by `unit`. */
  size: number;
  uppercase?: boolean;
  /** CSS colour. */
  color: string;
  /** em. */
  letter_spacing?: number;
}

/** Theme values resolved for rendering (URLs served by the renderer / UI). Built by `themeTokens()`. */
export interface ThemeTokens {
  /** Template name, when known (previews, debugging). */
  name?: string;
  colors: { accent: string; text: string; muted: string; paper: string; [k: string]: string };
  background: { type: 'solid' | 'radial' | 'linear'; from?: string; to?: string; color?: string };
  /** CSS font-family names already registered by the host composition. */
  fonts: { display: string; body: string };
  /** The font files behind `fonts`, for the host composition to register (when font URLs were given). */
  font_faces?: ThemeFontFace[];
  logo?: { url: string };
  /** Wordmark image, and/or the brand name to draw as text (always set when the brand has a name). */
  wordmark?: { url?: string; text?: string };
  brand: { name?: string; url?: string };
  cursor?: { ripple_color: string };
  style_bias: 'real' | 'balanced' | 'motion';
  /** Caption text styles of the template (kicker + line). */
  captions?: { kicker: ThemeTextStyle; line: ThemeTextStyle };
  /** Small brand mark on clips. */
  brandmark?: { position: 'bottom-right' | 'bottom-left' | 'top-right' | 'none'; opacity?: number; size?: number };
  /** Motion style: the template's zoom easing (cubic-bezier) — the kit's `themeEasing()` uses it. */
  motion?: { zoom_ease: [number, number, number, number] };
}

/** An image of a run artefact, served by the renderer (`url`), with its pixel size. */
export interface MediaImage {
  url: string;
  width: number;
  height: number;
}

/** A captured email (wait_for_email), as components receive it. */
export interface EmailMedia {
  kind: 'email';
  name: string;
  /** Sender address and display name. */
  from: string;
  from_name?: string;
  to: string[];
  subject: string;
  /** ISO 8601. */
  date: string;
  /** The first characters of the text (whitespace collapsed). */
  preview: string;
  /** The HTML rendered at 600 px layout width (2×), full height. */
  image?: MediaImage;
}

/** A captured document (download, or a project file), as components receive it: one image per page. */
export interface DocumentMedia {
  kind: 'document';
  name: string;
  file_name: string;
  pages: Array<MediaImage & { number: number; width_pt: number; height_pt: number }>;
}

/** A web notification the product showed, as components receive it. */
export interface NotificationMedia {
  kind: 'notification';
  name: string;
  title: string;
  body: string;
  /** The app a system notification names: the page's host (e.g. "console.example.com"). */
  app: string;
  /** ISO 8601 wall time it showed. */
  time: string;
  icon?: MediaImage;
  tag?: string;
}

export type MediaValue = EmailMedia | DocumentMedia | NotificationMedia;

/** A layout's evaluated rects in output px (`ComponentProps.rects`). */
export interface LayoutRects {
  /** Where the capture pixels go (the capture fitted to its aspect ratio). */
  screen: { x: number; y: number; w: number; h: number };
  /** The card / window / device outline. */
  frame: { x: number; y: number; w: number; h: number };
  /**
   * The layout's declared screen rect (device display, browser page area) when the capture does not fill it: the
   * capture (`screen`) is letterboxed / pillarboxed inside it and the layout paints the bars with the theme
   * background. Absent when the capture fills it.
   */
  display?: { x: number; y: number; w: number; h: number };
  chrome?: { x: number; y: number; w: number; h: number };
  caption?: { x: number; y: number; w: number; h: number };
  brandmark?: { x: number; y: number; w: number; h: number };
  radius: number;
}

/** Props received by every component implementation (default export of its entry). */
export interface ComponentProps<P extends Record<string, unknown> = Record<string, unknown>> {
  theme: ThemeTokens;
  /** Slot values: strings for text/url/color/image (image = URL). */
  slots: Record<string, string | undefined>;
  params: P;
  /** Output width / 1920 (landscape) or / 1080 (vertical, square): multiply every design size by it. */
  unit: number;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Output orientation: 1920×1080, 1080×1920 or 1080×1080 design space (× unit). */
  variant: OutputVariant;
  /**
   * layout: the rendered capture (video + camera) to place in the screen rect. interstitial: the dimmed last frame
   * of the previous clip, when there is one. transition: the segment this render wraps (see `direction`).
   * A React node (typed `unknown` to keep this contract free of React types).
   */
  screen?: unknown;
  /** layout with chrome: the URL to show. */
  url?: string;
  /**
   * layout: where to draw, in output px — the manifest geometry evaluated by the planner with this use's params and
   * the capture aspect (`screen` = where the capture pixels go, `frame` = the card / device outline around them,
   * `display` = the declared screen rect when the capture is letterboxed in it, `radius` in output px). The planner
   * places captions, overlays and the brand mark from the same rects, so a layout draws exactly there. Absent outside
   * a plan (unit tests): the layout falls back to its default geometry.
   * caption and overlay: the rects of the clip's layout, so they can place themselves over the capture (a caption
   * band, a lower third inside the screen). Absent outside a clip.
   */
  rects?: LayoutRects;
  /** caption: cues in frames relative to the segment. */
  cues?: CaptionCue[];
  /**
   * caption: the layout's caption rect in output px (from its geometry). Absent: the caption picks its own place
   * (e.g. a band over the capture).
   */
  area?: { x: number; y: number; w: number; h: number };
  /**
   * overlay: the box it points at, in output px (a point is a 0×0 box), when the step recorded one.
   * transition: the box it opens from (the outgoing segment's tap target — a notification banner, an app icon — from
   * that component's manifest `anchor`), when there is one.
   */
  anchor?: { x: number; y: number; w: number; h: number };
  /**
   * The run artefacts named by the use's `email` / `document` / `notification` slots (key = slot name), resolved by the
   * planner (images are served URLs). Absent when the use names none or the run did not capture it.
   */
  media?: Record<string, MediaValue>;
  /**
   * transition: the component renders twice — once around the outgoing segment ('exiting') and once around the
   * incoming one ('entering', drawn on top); progress = frame / durationInFrames. A crossfade overlaps the two
   * segments (both renders see frames [0, n), the outgoing one holding its last frame); a dip (fade-black) does not:
   * the exiting render covers frames [0, ⌊n/2⌋) at the end of the outgoing segment, the entering one [⌊n/2⌋, n) at
   * the start of the incoming one.
   */
  direction?: 'entering' | 'exiting';
}

/** Where a registered component comes from (resolution order: workspace → built-in → (V2) marketplace cache). */
export type ComponentSource = 'workspace' | 'builtin';

/** A component known to the registry. */
export interface ComponentInfo {
  manifest: ComponentManifest;
  /** Absolute component directory. */
  dir: string;
  /** Absolute path of the implementation (manifest.entry, default index.tsx). */
  entry: string;
  source: ComponentSource;
}

/** A ComponentRef resolved by the registry: params = the given params over the schema defaults, validated. */
export interface ResolvedComponentRef {
  id: string;
  version: string;
  kind: ComponentKind;
  params: Record<string, unknown>;
  manifest: ComponentManifest;
  dir: string;
  entry: string;
  source: ComponentSource;
}

/** A validation issue of a component folder: `file` is relative to the component dir (component.yaml, index.tsx…). */
export interface ComponentIssue extends ValidationIssue {
  file: string;
}
