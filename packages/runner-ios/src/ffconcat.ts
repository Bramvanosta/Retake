/**
 * The touch overlay as an ffconcat list: one picture per change of what is drawn, each held until the next one
 * (`duration`), the last one held to the end of the take and repeated without a duration (the concat demuxer then
 * shows it to the end instead of dropping it). Each change starts a quarter of a frame before its output frame, so the
 * overlay filter (which takes the latest overlay frame at or before each main frame) never shows it one frame late
 * through rounding.
 */

/** A picture of the overlay and the output frame it first shows on. */
export interface OverlayEntry {
  file: string;
  frame: number;
}

/** The ffconcat text of `entries` (in frame order, the first on frame 0) for a take of `frames` frames. Pure. */
export function ffconcatText(entries: readonly OverlayEntry[], frames: number, fps: number): string {
  if (!entries.length || entries[0].frame !== 0) throw new Error('the overlay starts on frame 0');
  const start = (frame: number) => (frame === 0 ? 0 : (frame - 0.25) / fps);
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const next = i + 1 < entries.length ? start(entries[i + 1].frame) : frames / fps;
    lines.push(`file '${escapeName(e.file)}'`, `duration ${(next - start(e.frame)).toFixed(6)}`);
  }
  lines.push(`file '${escapeName(entries[entries.length - 1].file)}'`, '');
  return lines.join('\n');
}

/** A file name inside ffconcat's single quotes. Pure. */
function escapeName(name: string): string {
  return name.replace(/'/g, "'\\''");
}
