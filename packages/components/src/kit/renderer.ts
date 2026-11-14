/**
 * The renderer library as the kit and its components use it: the one file of the kit that names it, so a change of
 * renderer touches this file and nothing else of the kit or of a component that imports the kit. Remotion's
 * attribution and licence terms still apply to what is re-exported here.
 *
 * Two lists. The first is public: ./index.ts re-exports exactly these six names, the primitives a component imports
 * from `@retake/components/kit`. The second is the kit's own (media, pictures, notifications): ./index.ts does not
 * re-export it, so it is no part of what a component may import from the kit. Anything else of remotion (interpolate,
 * spring…) stays importable from `remotion` directly in a workspace component: the compile check allows it.
 */
export { AbsoluteFill, Img, Sequence, random, useCurrentFrame, useVideoConfig } from 'remotion';

// The kit's own: not public (see ./index.ts).
export { Loop, OffthreadVideo, cancelRender, continueRender, delayRender } from 'remotion';
export { Lottie } from '@remotion/lottie';
export type { LottieAnimationData } from '@remotion/lottie';
