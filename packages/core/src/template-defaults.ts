import type { Template } from './types.js';

/**
 * Neutral defaults every template.yaml is merged over (objects merge, arrays and scalars replace).
 * Asset paths are relative to the template directory; the font files are expected to be an
 * Inter-like sans family (display + body weights).
 */
export const DEFAULT_TEMPLATE: Template = {
  name: 'default',
  colors: { accent: '#3355d1', text: '#16181d', muted: '#6b7079', paper: '#f4f4f2' },
  fonts: {
    display: 'fonts/Display.ttf',
    body: ['fonts/Body-Regular.ttf', 'fonts/Body-SemiBold.ttf', 'fonts/Body-Bold.ttf'],
  },
  logo: 'logo.svg',
  background: { type: 'radial', from: '#fafaf9', to: '#ebebe7' },
  frame: { style: 'card', width: 1560, radius: 18, shadow: 'soft' },
  captions: {
    position: 'below',
    kicker: { font: 'body', weight: 600, size: 15, uppercase: true, color: 'accent', letter_spacing: 0.08 },
    line: { font: 'display', size: 35, color: 'text' },
  },
  intro: { duration: 3.2, layout: 'logo-kicker-title' },
  outro: { duration: 3.0, layout: 'logo-wordmark-tagline-url' },
  interstitial: { style: 'dark-clock' },
  transitions: { between_scenes: 'crossfade', duration: 0.35 },
  cursor: { style: 'arrow-dark', ripple_color: 'rgba(51, 85, 209, 0.45)' },
  motion: { default_zoom: 'none', max_zoom: 1.4, zoom_ease: [0.45, 0, 0.2, 1] },
  style_bias: 'real',
};
