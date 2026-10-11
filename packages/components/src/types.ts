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

/** A caption to show, in output frames [from, to) relative to the segment (or the video for plans). */
export interface CaptionCue {
  from: number;
  to: number;
  kicker?: string;
  text: string;
  scene: string;
}

export type ComponentKind =
  | 'intro'
  | 'outro'
  /** Full-screen card inserted between scenes (title / chapter / quote card…). */
  | 'card'
  /** Full-screen "time passes" card (waiting screen), usually drawn over a dimmed last frame. */
  | 'interstitial'
  /** Renders the caption cues of a clip in the caption area of the layout. */
  | 'caption'
  /** Screen layout / frame: places the capture (card, browser chrome, laptop, phone, raw…). */
  | 'layout'
  /** Overlay shown over a clip for a while (lower third, callout, badge, highlight…). */
  | 'overlay'
  /** Transition between two segments. */
  | 'transition';

export const COMPONENT_KINDS: readonly ComponentKind[] = [
  'intro',
  'outro',
  'card',
  'interstitial',
  'caption',
  'layout',
  'overlay',
  'transition',
] as const;

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

/** Reference to a component from a theme or a scenario. */
export type ComponentRef = string | { id: string; params?: Record<string, unknown> };

/** Theme values resolved for rendering (URLs served by the renderer / UI). */
export interface ThemeTokens {
  colors: { accent: string; text: string; muted: string; paper: string; [k: string]: string };
  background: { type: 'solid' | 'radial' | 'linear'; from?: string; to?: string; color?: string };
  /** CSS font-family names already registered by the host composition. */
  fonts: { display: string; body: string };
  logo?: { url: string };
  wordmark?: { url?: string; text?: string };
  brand: { name?: string; url?: string };
  cursor?: { ripple_color: string };
  style_bias: 'real' | 'balanced' | 'motion';
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
  /** layout: the rendered capture (video + camera) to place in the screen rect. */
  screen?: unknown;
  /** layout with chrome: the URL to show. */
  url?: string;
  /** caption: cues in frames relative to the segment. */
  cues?: CaptionCue[];
}
