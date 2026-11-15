/**
 * The model context's types (@retake/core/model): the shared contracts of every context: points and boxes, component
 * kinds and references, the fields of a user media file.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */

/** Absolute viewport point in CSS px. */
export interface PointSpec {
  x: number;
  y: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a component renders. Every visual element of an edit is a component of one of these kinds. */
export type ComponentKind =
  | 'intro'
  | 'outro'
  /** Full-screen card inserted between scenes (title / chapter / quote card…). */
  | 'card'
  /** Full-screen "time passes" card (waiting screen), usually drawn over a dimmed last frame. */
  | 'interstitial'
  /** Renders the caption cues of a clip in the caption area of the layout. */
  | 'caption'
  /** Screen layout / frame: places the capture (card, browser chrome, laptop, phone, tablet, raw…). */
  | 'layout'
  /** Overlay shown over a clip for a while (lower third, callout, badge, highlight…). */
  | 'overlay'
  /** Transition between two segments. */
  | 'transition';

export const COMPONENT_KINDS: readonly ComponentKind[] = ['intro', 'outro', 'card', 'interstitial', 'caption', 'layout', 'overlay', 'transition'] as const;

/**
 * A component id: "namespace/name", lower-case letters, digits and "-" on each side (e.g. "studio/intro-stack").
 * Validated by `COMPONENT_ID_RE`. Resolution order: workspace `components/` → built-in library → (V2) marketplace.
 */
export type ComponentId = string;

/** Reference to a component from a theme or a scenario: an id, or an id with params. */
export type ComponentRef = ComponentId | { id: ComponentId; params?: Record<string, unknown> };

/** How a user file fills its frame (segments) or its box (overlays): `cover` = filled (cropped), `contain` = whole. */
export type MediaFit = 'cover' | 'contain';

export const MEDIA_FITS: readonly MediaFit[] = ['cover', 'contain'];

/** The kinds of user files a segment or an overlay can show instead of a component. */
export type MediaFileKind = 'video' | 'image' | 'lottie';

export const MEDIA_FILE_KINDS: readonly MediaFileKind[] = ['video', 'image', 'lottie'];

/**
 * A user file instead of a component (L2.12): exactly one of `video`, `image` or `lottie` — a path relative to the
 * project (a theme's own entries: relative to the template folder). The provided components are never mandatory: an
 * intro, an outro, a card, an interstitial or an overlay can be the user's own motion design.
 */
export interface MediaFileFields {
  /** A video file (.mp4, .mov, .webm, .m4v): H.264, HEVC, VP8, VP9, AV1 or ProRes; its own sound is kept. */
  video?: string;
  /** An image file (.png, .jpg, .jpeg, .webp, .svg). */
  image?: string;
  /** A Lottie animation (bodymovin JSON), played by studio/lottie. */
  lottie?: string;
  /** Video: the second of the file the part shown starts at (default 0). */
  from?: number;
  /** Video: the second of the file the part shown ends at (default: its end). */
  to?: number;
  /**
   * cover (fills the frame, cropped) or contain (whole, on `background`; default for overlays). Unset on a segment:
   * cover when the file has about the frame's shape (covering keeps ≥ 80 % of each side), else contain — a 16:9 intro
   * shows whole in the vertical variant.
   */
  fit?: MediaFit;
  /**
   * Segments: what shows around a `contain` file (and under a transparent one) — `theme` (the theme background,
   * default), a theme colour key (paper, dark, accent…), a CSS colour or `none` (transparent).
   */
  background?: string;
  /** Video: volume of the file's own sound, 0..1 (default 1; 0 = muted). A file without sound stays silent. */
  volume?: number;
}

/** The built-in components that show user files (L2.12). */
export const MEDIA_COMPONENTS = { media: 'studio/media', lottie: 'studio/lottie' } as const;
