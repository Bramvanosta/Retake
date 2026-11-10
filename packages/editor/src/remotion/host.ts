/**
 * The renderer library as the composition uses it: the one file of this folder that names it. ./Root.tsx,
 * ./DemoVideo.tsx, ./Preview.tsx and ./fonts.ts import from here; the pure files (./contract.ts, ./frames.ts,
 * ./modules.ts, ./preview-mode.ts, ./preview-types.ts) never do. Components reach the library through the kit
 * (@retake/components/kit); the Node side through ../render/library.ts.
 */
export { AbsoluteFill, Composition, Html5Audio, Img, OffthreadVideo, Sequence, cancelRender, continueRender, delayRender, useCurrentFrame } from 'remotion';
export type { CalculateMetadataFunction } from 'remotion';
