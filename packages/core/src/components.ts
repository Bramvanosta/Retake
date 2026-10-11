import { COMPONENT_KINDS, FRAME_STYLE_LAYOUTS } from './types.js';
import type { ComponentId, ComponentKind, ComponentRef, Template } from './types.js';

/** A theme's default component for one kind, and where the choice came from. */
export interface ThemeComponent {
  id: ComponentId;
  params: Record<string, unknown>;
  /**
   * theme: the template's `components` map; legacy: mapped from a legacy template field (frame.style, intro.layout,
   * outro.layout, interstitial.style, captions.position, transitions.between_scenes); default: the built-in default of a
   * kind without a legacy field (card, overlay).
   */
  source: 'theme' | 'legacy' | 'default';
}

/** Default component per kind; `null` = none (no captions, cut transitions…). */
export type ThemeComponents = Record<ComponentKind, ThemeComponent | null>;

/** Built-in defaults of the kinds that have no legacy template field. */
export const DEFAULT_THEME_COMPONENTS: Readonly<Record<'card' | 'overlay', ComponentId>> = {
  card: 'studio/card-title',
  overlay: 'studio/overlay-callout',
};

/** The id of a component reference. */
export function componentRefId(ref: ComponentRef): ComponentId {
  return typeof ref === 'string' ? ref : ref.id;
}

/** A component reference in object form (params copied, `{}` when absent). */
export function normalizeComponentRef(ref: ComponentRef): { id: ComponentId; params: Record<string, unknown> } {
  return typeof ref === 'string' ? { id: ref, params: {} } : { id: ref.id, params: structuredClone(ref.params ?? {}) };
}

type Mapped = { id: ComponentId; params?: Record<string, unknown> } | null;
type LegacyKind = Exclude<ComponentKind, keyof typeof DEFAULT_THEME_COMPONENTS>;

/** What the legacy fields of a template mean in components (docs/DESIGN-phase2.md §1.4). */
function legacy(template: Template, kind: LegacyKind): Mapped {
  switch (kind) {
    case 'layout': {
      const f = template.frame;
      if (f.style === 'card') return { id: FRAME_STYLE_LAYOUTS.card, params: { width: f.width, radius: f.radius, shadow: f.shadow } };
      return { id: FRAME_STYLE_LAYOUTS[f.style] };
    }
    case 'intro':
      switch (template.intro.layout) {
        case 'logo-kicker-title':
          return { id: 'studio/intro-stack' };
        case 'kicker-title':
          return { id: 'studio/intro-minimal' };
        case 'logo-only':
          return { id: 'studio/intro-minimal', params: { logo_only: true } };
      }
      break;
    case 'outro':
      switch (template.outro.layout) {
        case 'logo-wordmark-tagline-url':
          return { id: 'studio/outro-stack' };
        case 'logo-tagline':
          return { id: 'studio/outro-minimal' };
        case 'logo-only':
          return { id: 'studio/outro-minimal', params: { logo_only: true } };
      }
      break;
    case 'interstitial': {
      const style = template.interstitial.style;
      if (style === 'dark-clock') return { id: 'studio/interstitial-clock' };
      return { id: 'studio/interstitial-plain', params: { tone: style } };
    }
    case 'caption':
      switch (template.captions.position) {
        case 'below':
          return { id: 'studio/caption-below' };
        case 'above':
          return { id: 'studio/caption-below', params: { position: 'above' } };
        case 'overlay':
          return { id: 'studio/caption-overlay' };
        case 'none':
          return null;
      }
      break;
    case 'transition': {
      const { between_scenes: kindOf, duration } = template.transitions;
      if (kindOf === 'crossfade') return { id: 'studio/transition-crossfade', params: { duration } };
      if (kindOf === 'fade-black') return { id: 'studio/transition-fade-black', params: { duration } };
      return null;
    }
  }
  return null;
}

/**
 * The default component of every kind for a (complete) template — pure.
 *
 * Precedence per kind: the template's `components` entry (an id, {id, params}, or `null` = none) → the legacy field
 * mapping (frame.style card → studio/layout-card {width, radius, shadow}; browser/laptop/phone/raw →
 * studio/layout-<style>; intro.layout, outro.layout, interstitial.style, captions.position (none → null),
 * transitions.between_scenes (cut → null)) → the built-in default (card → studio/card-title, overlay →
 * studio/overlay-callout). An explicit entry is taken as written: legacy params are not merged into it.
 */
export function resolveThemeComponents(template: Template): ThemeComponents {
  const out = {} as ThemeComponents;
  const declared = template.components ?? {};
  for (const kind of COMPONENT_KINDS) {
    const ref = declared[kind];
    if (ref === null) {
      out[kind] = null;
    } else if (ref !== undefined) {
      out[kind] = { ...normalizeComponentRef(ref), source: 'theme' };
    } else if (kind === 'card' || kind === 'overlay') {
      out[kind] = { id: DEFAULT_THEME_COMPONENTS[kind], params: {}, source: 'default' };
    } else {
      const m = legacy(template, kind);
      out[kind] = m === null ? null : { id: m.id, params: m.params ?? {}, source: 'legacy' };
    }
  }
  return out;
}
