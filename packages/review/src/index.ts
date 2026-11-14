/**
 * @retake/review — review artefacts of a render for Claude and people (docs/DESIGN-phase2.md §3, SPEC §10):
 * contact sheets, per-scene sheets, key frames, an output-time timeline, report.json + report.md with the findings of
 * every check, a diff with the previous render, and small JPEG thumbnails (base64) for the MCP; the anchor and the
 * still of a frame comment (L3.6).
 */
export * from './types.js';
export { recoverReviewDir, reviewRender, reviewRules, keyframePlan, sampleFrames } from './review.js';
export { reviewImages, safeName } from './images.js';
export { ReviewError, findPrevious, findRender, locateRender, renderRun, renderTimeline, reviewsDir } from './load.js';
export type { FoundReviewRender } from './load.js';
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
export {
  captionOverDuring,
  checkPixels,
  overlayDuring,
  sourceFramesAtStarts,
  sourceKey,
  sourceTrack,
  stillFromSource,
  stillGlideEnd,
  stillPair,
  stillSourceFrames,
  viewMoves,
} from './pixel-checks.js';
export type { FrameAnalysis, PixelCheckInput } from './pixel-checks.js';
export { diffFindings, diffRecords, framePairs } from './diff.js';
export { frameAnchor } from './anchor.js';
export type { FrameAnchorOptions } from './anchor.js';
export { STILL_MAX_PX, extractStill } from './still.js';
export type { StillOptions } from './still.js';
export { extractFrames, probeVideo } from './ffmpeg.js';
export type { ExtractOptions, VideoInfo } from './ffmpeg.js';
export { fontFileMeasurer, loadFontFace } from './fonts.js';
export type { FaceFile, FontFace } from './fonts.js';
export { bbox, compareSignatures, pixel, readImage, regionStats, signature, uniformity } from './pixels.js';
export type { RegionRect, RegionStats, Rgb, RgbImage } from './pixels.js';
export { reportMarkdown } from './report.js';
export { findingLine, summaryLine } from './report-lines.js';
export { drawMarks, makeTile, pageFile, thumbnailOf, writeSheet } from './sheets.js';
export type { MarkBox, Tile } from './sheets.js';
export { isClip, meanSpeed, outputFrameOf, segmentLabel, segmentSpans, spanAt, stepAt, timecode, transitionAt, transitionSpans } from './spans.js';
export type { SegmentSpan, TransitionSpan } from './spans.js';
export { buildOutputTimeline, cursorAt, outputClicks } from './timeline.js';
export type { OutputClick, OutputComponent, OutputTimeline } from './timeline.js';
