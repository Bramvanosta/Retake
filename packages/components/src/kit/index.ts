/**
 * @demo-studio/components/kit — the helpers components may import (with react and remotion).
 *
 * Pure helpers (easing, frame-driven motion, text fitting, CSS from theme tokens) and React elements (Background,
 * Logo, Wordmark, SafeArea, FitText). Everything is deterministic and reads the theme passed in props.
 */
export * from './easing.js';
export * from './motion.js';
export * from './fit-text.js';
export * from './metrics.js';
export * from './style.js';
export * from './elements.js';
export type { ComponentProps, ThemeTokens, ThemeTextStyle, CaptionCue, LayoutRects } from '../types.js';
