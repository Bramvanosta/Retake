/**
 * The theme context's types (@retake/core/theme): a theme's shapes: the template, its brand, text styles, media
 * references and components, and the loaded template.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { FrameStyle, TransitionKind } from './language.js';
import type { ComponentKind, ComponentRef, MediaFileFields } from './model.js';
import type { LogoKind } from '../image-size.js';

export interface TextStyle {
  font: 'display' | 'body';
  weight?: number;
  size: number;
  uppercase?: boolean;
  color?: string; // colour key (accent/text/muted/paper) or CSS colour
  letter_spacing?: number;
}

export interface Template {
  name?: string;
  colors: { accent: string; text: string; muted: string; paper: string; [k: string]: string };
  /** Font files relative to the template dir (ttf/otf/woff2). */
  fonts: { display: string; body: string[] };
  /** Logo file relative to the template dir. */
  logo: string;
  /**
   * What the logo is (core image-size.ts): `mark` (drawn beside the brand name) or `wordmark` (the name itself: drawn
   * alone, sized by its width). Absent: a wordmark when the logo is at least LOGO_WORDMARK_ASPECT times wider than high.
   */
  logo_kind?: LogoKind;
  /** Optional wordmark image (used by outro layouts). */
  wordmark?: string;
  background: { type: 'solid' | 'radial' | 'linear'; from?: string; to?: string; color?: string };
  frame: { style: FrameStyle; width: number; radius: number; shadow: 'none' | 'soft' | 'strong' };
  captions: {
    position: 'below' | 'above' | 'overlay' | 'none';
    kicker: TextStyle;
    line: TextStyle;
  };
  intro: { duration: number; layout: 'logo-kicker-title' | 'kicker-title' | 'logo-only' };
  outro: { duration: number; layout: 'logo-wordmark-tagline-url' | 'logo-tagline' | 'logo-only'; url?: string; tagline?: string };
  interstitial: { style: 'dark-clock' | 'paper' | 'dark'; duration?: number };
  transitions: { between_scenes: TransitionKind; duration: number };
  cursor: { style: 'arrow-dark' | 'arrow-light' | 'debug'; ripple_color: string; size?: number };
  motion: { default_zoom: 'none' | number; max_zoom: number; zoom_ease: [number, number, number, number] };
  style_bias: 'real' | 'balanced' | 'motion';
  brandmark?: { position: 'bottom-right' | 'bottom-left' | 'top-right' | 'none'; opacity?: number; size?: number };
  /** Brand name and URL (wordmark drawn as text, outro url). */
  brand?: TemplateBrand;
  /**
   * Default component per kind (an id, or {id, params}); `null` = none (e.g. `caption: null`: no captions).
   * A kind absent here is mapped from the legacy fields (frame.style, intro.layout, outro.layout, interstitial.style,
   * captions.position, transitions.between_scenes): see `resolveThemeComponents`.
   */
  components?: TemplateComponents;
}

export interface TemplateBrand {
  name?: string;
  /** Shown as written (e.g. "example.com"). */
  url?: string;
}

/**
 * A theme's own file for a full-frame kind: `components: {intro: {video: assets/intro.mp4}}` — paths relative to
 * the template folder; `duration`, `params` (of studio/media or studio/lottie) as for a scenario entry.
 */
export interface TemplateMediaRef extends MediaFileFields {
  duration?: number;
  params?: Record<string, unknown>;
}

/** The kinds a theme may fill with a file instead of a component. */
export const TEMPLATE_MEDIA_KINDS = ['intro', 'outro', 'interstitial'] as const;

export type TemplateComponents = Partial<Record<ComponentKind, ComponentRef | TemplateMediaRef | null>>;

export interface LoadedTemplate {
  name: string;
  /** Absolute template directory. */
  dir: string;
  template: Template;
  /** Absolute paths of the assets. */
  assets: {
    logo: string;
    /** The logo's width / height as its file declares it (core image-size.ts); absent when the file gives no size. */
    logo_aspect?: number;
    wordmark?: string;
    display: string;
    body: string[];
  };
}
