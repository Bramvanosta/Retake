/** Which page of a capture shows at a time, and its URL: the scenes' joins and the browser bars use them. */
import type { Timeline, TimelineTrack } from '@retake/core';
import type { ClipSegment } from '../plan-types.js';

/** The URL a page's track shows at capture time `t` (its last URL segment starting at or before `t`). */
export function trackUrlAt(track: TimelineTrack, t: number): string | undefined {
  let url: string | undefined;
  for (const p of track.pages) {
    if (p.t_start <= t + 1e-6) url = p.url ?? url;
    else break;
  }
  return url ?? track.pages[0]?.url;
}

/** The page segment of the main capture at capture time `t`. */
export function pageAt(timeline: Timeline, t: number): { id: string; url?: string } | undefined {
  let found: Timeline['pages'][number] | undefined;
  for (const p of timeline.pages) {
    if (p.t_start <= t + 1e-6) found = p;
    if (p.t_start > t) break;
  }
  return found;
}

/** Appends an address from relative frame `frame` on, unless the bar already shows it. */
export function pushAddress(list: ClipSegment['urls'], frame: number, e: { url: string; hidden?: true }): void {
  if (list[list.length - 1]?.url !== e.url) list.push({ frame, ...e });
}
