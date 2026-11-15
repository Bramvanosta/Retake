/** The overlay checks: overlays over click targets, tutorial overlays and story-card media, overlays lost or cut by the edit. */
import { insetPhoneEdge } from '@retake/components/geometry';
import { CLEAR_LOOKAHEAD_S, drawnOverlayBox, focusBox, insetRectAt, mapPaneRect, mapSourceRect, mapUseRect, overlayBoxAt, paneCaptureAt, paneSource, stepBoxes, trackBoxAt } from '@retake/editor/plan';
import type { ClipSegment, EditPlan, ResolvedComponent } from '@retake/editor/plan';
import type { Timeline } from '@retake/core/run';
import type { OutputClick } from './timeline.js';
import type { CheckContext } from './checks-base.js';
import { finding, fmtS, localPath, locate, manifestOf } from './checks-base.js';
import type { Finding } from './types.js';
import { isClip, timecode } from './spans.js';

// ── Overlays over click targets ──────────────────────────────────────────────

/** Overlays the review measures (their drawn box comes from the components' own kit functions). */
const COVER_OVERLAYS: Record<string, string> = {
  'studio/overlay-shortcut': 'key caps',
  'studio/overlay-steps': 'step badge',
  'studio/overlay-loupe': 'typing loupe',
};

/** Share of a target's box an overlay may cover before it counts as covering it. */
export const COVER_SHARE = 0.15;

const overlapArea = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * `overlay-covers-target` (warning): an overlay drawn over the capture — the key caps, a step badge, the typing lens, a
 * picture-in-picture inset — covers (more than COVER_SHARE of) the target a click of the current or the next step lands
 * on (from 0.3 s before the overlay's frame to CLEAR_LOOKAHEAD_S after it). Targets count around the clicked point
 * (`focusBox`: a whole table row counts where the cursor clicks it).
 */
export function checkOverlayCover(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const fps = plan.fps;
  const before = Math.round(0.3 * fps);
  const ahead = Math.round(CLEAR_LOOKAHEAD_S * fps);
  const stepEvery = Math.max(1, Math.round(0.2 * fps));
  for (const clip of plan.segments) {
    if (!isClip(clip)) continue;
    const clicks = ctx.clicks.filter((c) => c.segment === clip.id && c.bbox && c.bbox.w > 0 && c.bbox.h > 0);
    out.push(...checkFileOverlayCover(ctx, clip, clicks));
    if (clicks.length === 0) continue;
    const targetAt = (c: (typeof clicks)[number], rel: number) => {
      const box = focusBox(c.bbox!, c.point);
      return c.pane !== undefined && clip.panes?.[c.pane] ? mapPaneRect(plan, clip, c.pane, rel, box) : mapSourceRect(plan, clip, rel, box);
    };
    const what = (c: (typeof clicks)[number]) => `the ${c.action} of step ${c.step_id ?? c.step}${c.page ? ` on page ${c.page}` : ''} (${c.target ?? 'its target'})`;
    for (const o of clip.overlays) {
      if (screenFileOverlay(o)) continue;
      const name = COVER_OVERLAYS[o.component.id];
      if (!name) continue;
      let reported = false;
      for (let local = 0; local < o.durationInFrames && !reported; local += stepEvery) {
        const rel = o.from + local;
        if (rel >= clip.durationInFrames) break;
        const f = clip.from + rel;
        const box = drawnOverlayBox(plan, clip, o, local);
        if (!box) break;
        for (const c of clicks) {
          if (c.frame < f - before || c.frame > f + ahead) continue;
          const t = targetAt(c, rel);
          if (overlapArea(box, t) > COVER_SHARE * t.w * t.h) {
            out.push(
              finding('warning', 'overlay-covers-target', `${clip.id}: the ${name} of step ${o.step} covers ${what(c)} at ${timecode(f / fps)}`, locate(ctx, f, { scene: c.scene, step: c.step })),
            );
            reported = true;
            break;
          }
        }
      }
    }
    const inset = clip.inset;
    if (!inset || !clip.panes) continue;
    const mobile = paneSource(plan, clip.panes[inset.pane]).mobile === true;
    for (const c of clicks) {
      if (c.pane === inset.pane) continue;
      for (const df of [-Math.round(0.35 * fps), 0]) {
        const rel = c.frame - clip.from + df;
        if (rel < 0 || rel >= clip.durationInFrames) continue;
        const r = insetRectAt(clip, rel, fps);
        if (!r) continue;
        const e = mobile ? insetPhoneEdge(r.h) : 4 * plan.unit;
        const drawn = { x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: r.h + 2 * e };
        const t = targetAt(c, rel);
        if (overlapArea(drawn, t) > COVER_SHARE * t.w * t.h) {
          out.push(
            finding(
              'warning',
              'overlay-covers-target',
              `${clip.id}: the picture-in-picture inset (page ${clip.panes[inset.pane].page}) covers ${what(c)}`,
              locate(ctx, clip.from + rel, { scene: c.scene, step: c.step }),
            ),
          );
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Your own file placed at a position of the screen (a corner, a side, the centre — not one on its target, a `rect`
 * of the page or the whole screen, which are where they were asked to be).
 */
function screenFileOverlay(o: ClipSegment['overlays'][number]): boolean {
  return (o.component.id === 'studio/media' || o.component.id === 'studio/lottie') && !!o.box && !o.box.rect && o.box.anchor !== 'screen' && o.box.anchor !== 'rect';
}

/**
 * `overlay-covers-target` for your own files placed on the screen: the box the file fills (`overlayBoxAt`, in
 * the framing of this render) over more than COVER_SHARE of what the viewer looks at — the target of a step that is on
 * while it shows (its own step — a hover too — and the next ones from CLEAR_LOOKAHEAD_S before they start: `stepBoxes`,
 * around the cursor) or a click target in the window the other overlays are checked over.
 */
function checkFileOverlayCover(ctx: CheckContext, clip: ClipSegment, clicks: OutputClick[]): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  const fps = plan.fps;
  const before = Math.round(0.3 * fps);
  const ahead = Math.round(CLEAR_LOOKAHEAD_S * fps);
  const stepEvery = Math.max(1, Math.round(0.2 * fps));
  const events = (ctx.timeline?.events ?? []).filter((ev) => ev.scene === clip.scene && ev.step >= 0 && ev.status !== 'skipped');
  for (const o of clip.overlays) {
    if (!screenFileOverlay(o)) continue;
    const file = o.component.media?.file;
    const name = `your ${file?.kind === 'lottie' ? 'Lottie' : file?.kind === 'video' ? 'video' : 'image'} overlay${file ? ` ${file.name}` : ''} (${o.box!.anchor})`;
    const page = o.pane !== undefined ? clip.panes?.[o.pane]?.page : undefined;
    for (let local = 0; local < o.durationInFrames; local += stepEvery) {
      const rel = o.from + local;
      if (rel >= clip.durationInFrames) break;
      const f = clip.from + rel;
      const box = overlayBoxAt(plan, clip, o, rel);
      if (!box) break;
      const hit = fileOverlayHit({ plan, clip, o, rel, f, box, page, events, clicks, before, ahead });
      if (hit) {
        out.push(finding('warning', 'overlay-covers-target', `${clip.id}: ${name} of step ${o.step} covers ${hit} at ${timecode(f / fps)}`, locate(ctx, f, { scene: clip.scene, step: o.step })));
        break;
      }
    }
  }
  return out;
}

/** An overlay of your own file at one frame of its clip, and what it is checked against there. */
interface FileOverlayFrame {
  plan: EditPlan;
  clip: ClipSegment;
  o: ClipSegment['overlays'][number];
  rel: number;
  f: number;
  box: { x: number; y: number; w: number; h: number };
  page: string | undefined;
  events: Timeline['events'];
  clicks: OutputClick[];
  before: number;
  ahead: number;
}

/** What a file overlay covers at a frame: the target of a step that is on, else a click target near that frame. */
function fileOverlayHit(x: FileOverlayFrame): string | undefined {
  const { plan, clip, o, rel, f, box, page } = x;
  const t = clip.srcFrames[Math.min(rel, clip.srcFrames.length - 1)] / plan.source.fps;
  for (const ev of x.events) {
    if ((page !== undefined && ev.page !== page) || t < ev.t_start - (ev.step === o.step ? 0 : CLEAR_LOOKAHEAD_S) || t > Math.max(ev.t_end, ev.hold?.t_end ?? ev.t_end)) continue;
    for (const b of stepBoxes(ev)) {
      const r = mapUseRect(plan, clip, o, rel, b);
      if (overlapArea(box, r) > COVER_SHARE * r.w * r.h) return `the ${ev.action} target of step ${ev.id ?? ev.step}${ev.target?.desc ? ` (${ev.target.desc})` : ''}`;
    }
  }
  for (const c of x.clicks) {
    if (c.frame < f - x.before || c.frame > f + x.ahead) continue;
    const box2 = focusBox(c.bbox!, c.point);
    const r = c.pane !== undefined && clip.panes?.[c.pane] ? mapPaneRect(plan, clip, c.pane, rel, box2) : mapSourceRect(plan, clip, rel, box2);
    if (overlapArea(box, r) > COVER_SHARE * r.w * r.h) return `the ${c.action} of step ${c.step_id ?? c.step} (${c.target ?? 'its target'})`;
  }
  return undefined;
}

// ── Tutorial overlays and story-card media ─────────────────────────────

/** How long a spotlight or a step badge may stay on its target's box after its page changed URL (seconds). */
export const STALE_TARGET_S = 0.6;

/**
 * Tutorial overlays and data-driven cards:
 *  - `tutorial-skipped` (warning): an overlay the switches ask for could not be shown (a spotlight or a step badge
 *    without a recorded target box, a loupe without a field, a shortcut without its key) — the plan lists them;
 *  - `tutorial-stale-target` (warning): a spotlight or a step badge stays on the box of its target more than
 *    STALE_TARGET_S after its page changed URL (a click that navigated): it rings a spot of a page that is gone;
 *  - `tutorial-target-cut` (warning): the target of a spotlight, a badge or a loupe lies outside the visible capture
 *    (zoom, reframe) while the overlay shows;
 *  - `media-missing` (warning): a card / overlay names data (a captured text, a frame, a CSV, an email…) that the plan
 *    could not resolve — the component shows a fallback; an error for a user file (a video, image or Lottie file of a
 * segment or an overlay) that could not be read — nothing is shown.
 */
export function checkTutorial(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const { plan } = ctx;
  for (const sk of plan.tutorial?.skipped ?? []) {
    out.push(finding('warning', 'tutorial-skipped', `${sk.scene} step ${sk.step}: no ${sk.feature} overlay — ${sk.reason}`, sk.frame !== undefined ? locate(ctx, sk.frame) : undefined));
  }
  for (const s of plan.segments) {
    if (!isClip(s)) continue;
    for (const o of s.overlays) {
      if (o.tutorial !== 'spotlight' && o.tutorial !== 'steps') continue;
      const urls = o.pane !== undefined && s.panes?.[o.pane] ? s.panes[o.pane].urls : s.urls;
      const urlAt = (f: number) => {
        let u: string | undefined;
        for (const x of urls) if (x.frame <= f) u = x.url;
        return u;
      };
      const keys = o.track && o.track.length > 0 ? o.track.map((k) => k.at) : [0];
      for (let i = 0; i < keys.length; i++) {
        const a = o.from + keys[i];
        const b = Math.min(o.from + (keys[i + 1] ?? o.durationInFrames), s.durationInFrames);
        const before = urlAt(a);
        const change = urls.find((x) => x.frame > a && x.frame < b && x.url !== before);
        if (!change || (b - change.frame) / plan.fps <= STALE_TARGET_S) continue;
        out.push(
          finding(
            'warning',
            'tutorial-stale-target',
            `${s.id} step ${o.step}: the ${o.tutorial === 'steps' ? 'step badge' : 'spotlight'} stays ${fmtS((b - change.frame) / plan.fps)} on its target after the page went to ${change.hidden ? localPath(change.url) : change.url}`,
            locate(ctx, s.from + change.frame),
          ),
        );
        break;
      }
    }
  }
  for (const s of plan.segments) {
    if (!isClip(s)) continue;
    const cap = s.layout.capture;
    for (const o of s.overlays) {
      if (!o.tutorial || o.tutorial === 'shortcuts' || !o.anchor?.bbox) continue;
      // Sample the overlay at its start, middle and end (inside the clip) with its track box of that frame.
      const frames = [0, Math.floor(o.durationInFrames / 2), Math.max(0, o.durationInFrames - 1)];
      for (const k of frames) {
        const f = o.from + k;
        if (f >= s.durationInFrames) continue;
        const box = trackBoxAt(o, k, plan.fps) ?? o.anchor.bbox;
        const r = mapUseRect(plan, s, o, f, box);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        // A multi-page clip: inside the page's own pane (a picture-in-picture inset where it is at that frame).
        const area = o.pane !== undefined && s.panes?.[o.pane] ? paneCaptureAt(s, o.pane, f, plan.fps) : cap;
        if (cx < area.x || cx > area.x + area.w || cy < area.y || cy > area.y + area.h) {
          out.push(finding('warning', 'tutorial-target-cut', `${s.id} step ${o.step}: the ${o.tutorial} target is outside the visible capture (zoom or reframe)`, locate(ctx, s.from + f)));
          break;
        }
      }
    }
  }
  const media = (c: ResolvedComponent | null | undefined, where: string, frame: number) => {
    if (!c) return;
    const m = manifestOf(ctx.registry, c.id);
    if (!m) return;
    for (const [name, spec] of Object.entries(m.slots)) {
      if (!['email', 'document', 'notification', 'capture', 'frame', 'data', 'media', 'lottie'].includes(spec.type)) continue;
      const v = c.slots[name];
      if (v === undefined || v.trim() === '' || c.media?.[name]) continue;
      // A user file that could not be read shows nothing at all: an error.
      const file = spec.type === 'media' || spec.type === 'lottie';
      out.push(
        finding(
          file ? 'error' : 'warning',
          'media-missing',
          file
            ? `${where}: your ${spec.type === 'lottie' ? 'Lottie ' : ''}file "${v}" could not be read — nothing is shown`
            : `${where}: ${c.id} slot "${name}" (${spec.type} "${v}") could not be resolved — the component shows a fallback`,
          locate(ctx, frame),
        ),
      );
    }
  };
  for (const s of plan.segments) {
    media(s.component, `${s.kind} ${s.id}`, s.from);
    if (isClip(s)) for (const o of s.overlays) media(o.component, `overlay of ${s.id}`, s.from + o.from);
  }
  return out;
}

/** An overlay shown for less than this share of its own length is cut. */
export const OVERLAY_CUT_SHARE = 0.6;

/**
 * `overlay-lost` / `overlay-cut`: a step's `overlay` the edit left out (the step ends after its clip: the last step of a
 * scene), or cut by the clip's end to less than OVERLAY_CUT_SHARE of its length — the render only warned about it. An
 * overlay never goes on the last step of a scene (or the scene holds after it).
 */
export function checkOverlaysKept(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const timeline = ctx.timeline;
  if (!timeline) return out;
  const clips = ctx.plan.segments.filter(isClip);
  for (const ev of timeline.events) {
    if (!ev.overlay || ev.step < 0) continue;
    const mine = clips.filter((c) => c.scene === ev.scene);
    if (!mine.length) continue;
    const uses = mine.flatMap((c) => c.overlays.filter((o) => o.scene === ev.scene && o.step === ev.step).map((o) => ({ c, o })));
    const where = `${ev.scene}.${ev.step}`;
    const last = mine[mine.length - 1];
    if (!uses.length) {
      out.push(
        finding(
          'warning',
          'overlay-lost',
          `the overlay of step ${where} is not in the video: the step ends after its clip (the last step of a scene) — put it on an earlier step, or hold after it`,
          locate(ctx, last.from + last.durationInFrames - 1, { scene: ev.scene, step: ev.step }),
        ),
      );
      continue;
    }
    for (const { c, o } of uses) {
      if (o.componentFrames === undefined || o.durationInFrames >= o.componentFrames * OVERLAY_CUT_SHARE) continue;
      out.push(
        finding(
          'warning',
          'overlay-cut',
          `the overlay of step ${where} shows ${fmtS(o.durationInFrames / ctx.plan.fps)} of its ${fmtS(o.componentFrames / ctx.plan.fps)}: the scene ends under it — put it on an earlier step, or hold after it`,
          locate(ctx, c.from + o.from, { scene: ev.scene, step: ev.step }),
        ),
      );
    }
  }
  return out;
}
