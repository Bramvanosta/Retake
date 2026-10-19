/**
 * The renderer primitives components use, re-exported from remotion so a component imports everything from the kit:
 * this file is the one place a change of renderer touches for workspace components. Remotion's attribution and licence
 * terms still apply to what is re-exported here. Anything else of remotion (interpolate, spring…) stays importable from
 * `remotion` directly: the compile check allows it.
 */
export { AbsoluteFill, Img, Sequence, random, useCurrentFrame, useVideoConfig } from 'remotion';
