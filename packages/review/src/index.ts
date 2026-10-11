/**
 * @demo-studio/review — review artefacts of a render for Claude and people (docs/DESIGN-phase2.md §3, SPEC §10):
 * contact sheets, per-scene sheets, key frames, an output-time timeline, report.json + report.md with the findings of
 * every check, a diff with the previous render, and small JPEG thumbnails (base64) for the MCP.
 */
export * from './types.js';
export { reviewRender, keyframePlan, sampleFrames, safeName } from './review.js';
export { ReviewError, findPrevious, findRender, renderTimeline, reviewsDir } from './load.js';
export {
  checkCamera,
  checkCaptions,
  checkCursor,
  checkDurations,
  checkLongScenes,
  checkRender,
  checkTextSlots,
  checkTransitionsOnClicks,
  fitCaption,
  locate,
  planFontFiles,
  segmentDurations,
} from './checks.js';
export type { CheckContext } from './checks.js';
export { checkPixels, sourceFramesAtStarts, stillPair } from './pixel-checks.js';
export type { FrameAnalysis, PixelCheckInput } from './pixel-checks.js';
export { diffFindings, diffRecords, framePairs } from './diff.js';
export { extractFrames, probeVideo } from './ffmpeg.js';
export type { ExtractOptions, VideoInfo } from './ffmpeg.js';
export { fontFileMeasurer, loadFontFace } from './fonts.js';
export type { FaceFile, FontFace } from './fonts.js';
export { bbox, colourDistance, compareSignatures, pixel, readImage, regionStats, signature, uniformity } from './pixels.js';
export type { RegionRect, RegionStats, Rgb, RgbImage } from './pixels.js';
export { findingLine, reportMarkdown, summaryLine } from './report.js';
export { makeTile, pageFile, thumbnailOf, writeSheet } from './sheets.js';
export type { Tile } from './sheets.js';
export { isClip, meanSpeed, outputFrameOf, segmentLabel, segmentSpans, spanAt, stepAt, timecode, transitionAt, transitionSpans } from './spans.js';
export type { SegmentSpan, TransitionSpan } from './spans.js';
export { buildOutputTimeline, cursorAt, outputClicks } from './timeline.js';
export type { OutputClick, OutputComponent, OutputTimeline } from './timeline.js';
