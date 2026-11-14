/**
 * The names of a review's images (pure: part of `@retake/review/checks`): a key frame's file-system-safe name, and which
 * of a review's images an agent is shown.
 */
import type { ReviewFiles } from './types.js';

/** File-system-safe key frame name. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'frame';
}

/**
 * The images of a review an agent looks at, as [name, file]: the contact sheet pages and the marker key frames
 * (`sheets`), or also every key frame, the per-scene sheets and the diff sheet (`all`).
 */
export function reviewImages(files: ReviewFiles, o: { fps: 1 | 2; markers: Iterable<string>; mode: 'sheets' | 'all' }): Array<[string, string]> {
  const all = o.mode === 'all';
  const list: Array<[string, string]> = files.sheets.map((f, i) => [`sheet_${o.fps}fps${i ? `_p${i + 1}` : ''}`, f]);
  const markerNames = new Set([...o.markers].map(safeName));
  for (const [name, f] of Object.entries(files.keyframes)) if (all || markerNames.has(name)) list.push([`keyframe:${name}`, f]);
  if (all) {
    for (const [id, fl] of Object.entries(files.scene_sheets)) fl.forEach((f, i) => list.push([`sheet_scene_${id}${i ? `_p${i + 1}` : ''}`, f]));
    if (files.diff_sheet) list.push(['diff', files.diff_sheet]);
  }
  return list;
}
