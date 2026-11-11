/**
 * `@retake/review/checks` — the review without a file, a process or a renderer: the findings' contract, every check
 * over a plan and its timeline (captions, cursor, camera, durations, overlays, tutorial), the pixel checks' maths over
 * frames already in memory, the output-time timeline and spans, the diff of two render records and the anchor of a
 * frame comment. What reads a file or runs ffmpeg (reviewRender, the frames, the fonts' files, the sheets, the report's
 * files, `readImage`) stays at the package root.
 *
 * Every module reachable from here imports `@retake/core`, `@retake/editor/plan` and `@retake/components/geometry`
 * only — no Node module, no image library, no renderer (test/checks-entry.test.ts walks the imports and traces the
 * built entry). The names are the package root's, value for value: also a key frame's safe name, which images an
 * agent is shown, and the findings as lines (L7.11: the engine's and the CLI's words for a review).
 */
export * from './types.js';
export {
  captionRegion,
  checkArtefactOrder,
  checkCamera,
  checkCaptions,
  checkCursor,
  checkDurations,
  checkEnvironment,
  checkSlowTransitions,
  checkLongScenes,
  checkRender,
  checkTextSlots,
  checkLoadingFilmed,
  checkZoomScroll,
  checkCaptionContradictions,
  checkOverlaysKept,
  checkButtonContrast,
  checkTransitionsOnClicks,
  checkTutorial,
  checkOverlayCover,
  COVER_SHARE,
  STALE_TARGET_S,
  environmentLine,
  fitCaption,
  locate,
  planFontFiles,
  reviewEnvironment,
  segmentDurations,
} from './checks.js';
export type { CheckContext } from './checks.js';
export { captionOverDuring, checkPixels, overlayDuring, sourceFramesAtStarts, sourceKey, sourceTrack, stillFromSource, stillGlideEnd, stillPair, stillSourceFrames, viewMoves } from './pixel-checks.js';
export type { FrameAnalysis, PixelCheckInput } from './pixel-checks.js';
export { diffFindings, diffRecords, framePairs } from './diff.js';
export { frameAnchor } from './anchor.js';
export { reviewImages, safeName } from './images.js';
export { findingLine, summaryLine } from './report-lines.js';
export type { FrameAnchorOptions } from './anchor.js';
export { bbox, colourDistance, compareSignatures, pixel, regionStats, signature, uniformity } from './pixel-maths.js';
export type { RegionRect, RegionStats, Rgb, RgbImage } from './pixel-maths.js';
export { isClip, meanSpeed, outputFrameOf, segmentLabel, segmentSpans, spanAt, stepAt, timecode, transitionAt, transitionSpans } from './spans.js';
export type { SegmentSpan, TransitionSpan } from './spans.js';
export { buildOutputTimeline, cursorAt, outputClicks } from './timeline.js';
export type { OutputClick, OutputComponent, OutputTimeline } from './timeline.js';
