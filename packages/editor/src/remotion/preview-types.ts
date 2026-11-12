/**
 * The input of the ComponentPreview composition (./Preview.tsx): one component rendered in context with sample
 * content — built in Node by `buildComponentPreview` (../preview.ts), rendered by `renderComponentPreviews`
 * (../render/preview.ts). Every URL is already served (asset server).
 */
import type { ComponentKind } from '@retake/core/model';
import type { CaptionCue, LayoutRects, MediaValue, ProgressChapter, ThemeTokens } from '@retake/components';

export interface PreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One component use of a preview (the component shown, or a context component around it). */
export interface PreviewUse {
  id: string;
  kind: ComponentKind;
  slots: Record<string, string | undefined>;
  params: Record<string, unknown>;
  durationInFrames: number;
  /** Sample artefacts for `email` / `document` / `notification` slots (served URLs). */
  media?: Record<string, MediaValue>;
}

/** A clip-like scene: a layout with the sample screen as its capture, the brand mark and a caption. */
export interface PreviewScene {
  layout: PreviewUse;
  /** The layout's rects for the sample screen (evaluated geometry, the sample fitted in the screen rect). */
  rects: LayoutRects;
  /** The sample screen image (served URL) and its pixel size. */
  screen: { url: string; width: number; height: number };
  /** Multi-page layouts (L2.11): one sample screen per page (`rects.panes` places them). */
  screens?: Array<{ url: string; width: number; height: number }>;
  /** Address shown by a browser layout. */
  url?: string;
  caption?: PreviewUse & { cues: CaptionCue[] };
  brandmark?: { rect: PreviewRect; align: 'left' | 'right'; size: number; opacity: number };
}

export interface ComponentPreviewSpec {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** The composition frame rendered. */
  frame: number;
  theme: ThemeTokens;
  /** The component previewed. */
  main: PreviewUse;
  /** layout / caption / overlay / transition / interstitial previews: the scene around (or under) the component. */
  scene?: PreviewScene;
  /** transition previews: the segment entering (a card), and the transition's kind. */
  incoming?: PreviewUse;
  transitionKind?: 'crossfade' | 'fade-black';
  /** overlay previews: the target box in output px; transition previews: the box the transition opens from. */
  anchor?: PreviewRect;
  /** overlay previews: the frame of the moment shown (a key press, a click) — `ComponentProps.moment`. */
  moment?: number;
  /** overlay previews with a capture region (a loupe): the region of the sample screen, in sample px. */
  region?: PreviewRect;
  /** overlay previews: sample chapters (a progress bar). */
  chapters?: ProgressChapter[];
  /**
   * Motion mode (a looping transition preview): `lead` frames of the outgoing scene, the transition
   * (`main.durationInFrames`), then `tail` frames of the settled card; the transition's half is picked from the current
   * frame, never from `frame`. Absent for stills and every other kind.
   */
  motion?: { lead: number; tail: number };
}
