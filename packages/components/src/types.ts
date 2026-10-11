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

export type SlotType = 'text' | 'image' | 'url' | 'color' | 'screen';

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
  /** Rectangle in a 1920×1080 (landscape) or 1080×1920 (vertical) design space. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Layout components declare their geometry so the planner and the review can reason without rendering. */
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
  /** Layout kind only. */
  geometry?: LayoutGeometry;
  geometry_vertical?: LayoutGeometry;
  variants?: Array<'landscape' | 'vertical'>;
  /** Sample values used to render previews with any theme. */
  preview?: { slots?: Record<string, string>; params?: Record<string, unknown>; at?: number[] };
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

/** Props received by every component implementation (default export of its entry). */
export interface ComponentProps<P extends Record<string, unknown> = Record<string, unknown>> {
  theme: ThemeTokens;
  /** Slot values: strings for text/url/color/image (image = URL). */
  slots: Record<string, string | undefined>;
  params: P;
  /** Output width / 1920 (landscape) or / 1080 (vertical): multiply every design size by it. */
  unit: number;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  variant: 'landscape' | 'vertical';
  /**
   * layout: the rendered capture (video + camera) to place in the screen rect. interstitial: the dimmed last frame
   * of the previous clip, when there is one. transition: the segment this render wraps (see `direction`).
   * A React node (typed `unknown` to keep this contract free of React types).
   */
  screen?: unknown;
  /** layout with chrome: the URL to show. */
  url?: string;
  /** caption: cues in frames relative to the segment. */
  cues?: CaptionCue[];
  /**
   * caption: the layout's caption rect in output px (from its geometry). Absent: the caption picks its own place
   * (e.g. a band over the capture).
   */
  area?: { x: number; y: number; w: number; h: number };
  /** overlay: the box it points at, in output px (a point is a 0×0 box), when the step recorded one. */
  anchor?: { x: number; y: number; w: number; h: number };
  /**
   * transition: the component renders twice over the overlap — once around the outgoing segment ('exiting') and
   * once around the incoming one ('entering', drawn on top); progress = frame / durationInFrames.
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
