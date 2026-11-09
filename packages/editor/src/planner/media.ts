/**
 * A step of `planEdit`: the media of component slots — artefacts (L2.9: `email` / `document` / `notification` slots →
 * media with ds-asset images), frames of the capture (L2.10: before / after cards), project images, user files
 * (L2.12: video, Lottie) and CSV tables. The resolver asks for them as it fills slots.
 */
import { dirname, isAbsolute, join } from 'node:path';
import { VIDEO_FILE_EXTENSIONS, displayUrl as displayedUrl, fileExtension, isLocalHost, parseFrameRef } from '@retake/core';
import type { TimelineArtefact } from '@retake/core';
import { ARTEFACT_SLOT_TYPES, parseCsv } from '@retake/components';
import type { ArtefactSlotType, ComponentManifest, MediaValue, PictureMedia } from '@retake/components';
import type { PlanSource } from '../plan-types.js';
import { clamp, round, secs } from '../util.js';
import type { PlanAddresses, PlanContext, PlanSources, SlotMedia } from './scope.js';
import { markDoneAt } from './targets.js';

/** The slot media of a plan: `mediaOf` fills a use's slots, `findArtefact` names a captured artefact. */
export function planSlotMedia(c: PlanContext & PlanAddresses & PlanSources): SlotMedia {
  const { input, timeline, project, warnings, t, cap, srcFrameCount, displayTable, asset, mainSource, trackSources } = c;
  const runDir = input.runDir ?? dirname(input.captureFile);
  const artefacts: TimelineArtefact[] = timeline.artefacts ?? [];
  const findArtefact = (type: ArtefactSlotType, value: string): TimelineArtefact | undefined => {
    const v = value.trim();
    const kind = type === 'capture' ? 'text' : type;
    const own = artefacts.filter((a) => a.kind === kind);
    const byName = own.find((a) => a.name === v);
    if (byName || type !== 'notification' || !/^\d+$/.test(v)) return byName;
    return own.find((a) => a.kind === 'notification' && a.index === Number(v));
  };
  const slugOf = (x: string) => x.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const mediaOfArtefact = (a: TimelineArtefact): MediaValue => {
    const img = (prefix: string, i: { file: string; width: number; height: number }) => ({ url: asset(`${prefix}`, join(runDir, i.file)), width: i.width, height: i.height });
    if (a.kind === 'email') {
      return {
        kind: 'email',
        name: a.name,
        from: a.from,
        ...(a.from_name ? { from_name: a.from_name } : {}),
        to: [...a.to],
        subject: a.subject,
        date: a.date,
        preview: a.preview,
        ...(a.image ? { image: img(`artefact-email-${slugOf(a.name)}`, a.image) } : {}),
        ...(a.persona ? { persona: a.persona } : {}),
      };
    }
    if (a.kind === 'document') {
      return {
        kind: 'document',
        name: a.name,
        file_name: a.file_name,
        pages: a.pages.map((p, i) => ({ ...img(`artefact-document-${slugOf(a.name)}-p${i + 1}`, p), number: i + 1, width_pt: p.width_pt, height_pt: p.height_pt })),
      };
    }
    if (a.kind === 'text') return { kind: 'text', name: a.name, value: a.value, text: a.text };
    // The app a system notification names: the host the video shows for its page (L1.7: the display URL); a local
    // host without one is never shown — the theme's brand name instead.
    let app = a.origin;
    try {
      const shown = new URL(displayedUrl(a.origin, displayTable));
      app = isLocalHost(shown.hostname) ? (t.brand?.name ?? '') : shown.host || a.origin;
    } catch {
      /* keep the origin */
    }
    return {
      kind: 'notification',
      name: a.name,
      title: a.title,
      body: a.body,
      app,
      time: a.time,
      ...(a.tag ? { tag: a.tag } : {}),
      ...(a.icon ? { icon: img(`artefact-notification-${slugOf(a.name)}-icon`, a.icon) } : {}),
    };
  };
  // L2.10: frames of the capture (before/after cards), project images and CSV tables.
  const projectFile = (rel: string): string => (isAbsolute(rel) ? rel : join(project.dir, rel));
  const captureFrameTime = (t: number): number => {
    const k = clamp(Math.round(t * cap.fps), 0, Math.max(0, srcFrameCount - 1));
    return round(k / cap.fps, 4);
  };
  const sceneStart = (sceneId: string): number | undefined => {
    const sc = timeline.scenes.find((x) => x.id === sceneId && x.kind === 'scene');
    if (!sc) return undefined;
    const evs = timeline.events.filter((e) => e.scene === sc.id && e.scene_index === sc.index);
    const still = evs.find((e) => e.action === 'scene_still');
    const open = evs.find((e) => e.action === 'scene_open');
    return (still ? still.t_start : open ? open.t_end : sc.t_start) + 0.05;
  };
  const frameMedia = (slot: string, value: string, where: string): PictureMedia | undefined => {
    const ref = parseFrameRef(value);
    if (!ref) {
      warnings.add(`${where}: "${value}" is not a frame (a mark, start:/end:<scene>, 12.5s or an image file)`);
      return undefined;
    }
    if (ref.kind === 'file') {
      const f = input.files?.[ref.path];
      if (f?.missing) warnings.add(`${where}: image ${ref.path} not found`);
      const url = asset(`image-${slugOf(ref.path)}`, f?.file ?? projectFile(ref.path));
      return { kind: 'picture', name: slot, url, ...(f?.width && f.height ? { width: f.width, height: f.height } : {}), label: ref.path };
    }
    let t: number | undefined;
    let label = '';
    // Multi-page scenes (L2.11): a scene start / end or a mark shows the frame of that page's own track.
    let src: PlanSource = mainSource;
    if (ref.kind === 'scene') {
      const pg = timeline.scenes.find((x) => x.id === ref.scene && x.kind === 'scene')?.pages?.[0];
      if (pg && trackSources[pg.track]) src = trackSources[pg.track];
    } else if (ref.kind === 'mark') {
      const page = timeline.markers.find((m) => m.name === ref.name)?.page;
      if (page && trackSources[page]) src = trackSources[page];
    }
    if (ref.kind === 'time') {
      t = ref.t;
      label = `${ref.t} s of the capture`;
      if (t > cap.duration) warnings.add(`${where}: ${value} is past the end of the capture (${secs(cap.duration)})`);
    } else if (ref.kind === 'scene') {
      const sc = timeline.scenes.find((x) => x.id === ref.scene && x.kind === 'scene');
      if (sc) t = ref.at === 'start' ? sceneStart(sc.id) : sc.t_end - 1 / cap.fps;
      label = `${ref.at === 'start' ? 'start' : 'end'} of scene ${ref.scene}`;
      if (t === undefined) warnings.add(`${where}: scene "${ref.scene}" was not captured by run ${timeline.run_id}`);
    } else {
      const mk = timeline.markers.find((m) => m.name === ref.name);
      label = `mark ${ref.name}`;
      if (!mk) warnings.add(`${where}: mark "${ref.name}" is not in run ${timeline.run_id} (marks: ${timeline.markers.map((m) => m.name).join(', ') || 'none'})`);
      else t = markDoneAt(timeline, mk);
    }
    if (t === undefined) return undefined;
    return { kind: 'picture', name: slot, url: src.url, width: src.width, height: src.height, video: { time_s: captureFrameTime(t) }, label };
  };
  /** A user file named by a `media` / `lottie` slot (L2.12): served by the renderer, with what was read of it. */
  const fileMedia = (type: 'media' | 'lottie', v: string, where: string): MediaValue | undefined => {
    const f = input.files?.[v];
    const file = f?.file ?? projectFile(v);
    // Served only when it is drawn: a file that is missing or unreadable is a warning and shows nothing — it is not an
    // asset of the plan (the renderer refuses a plan whose assets are missing).
    const served = () => asset(`file-${slugOf(v.replace(/^.*[\\/]/, ''))}-${shortHash(file)}`, file);
    if (!f || f.missing) {
      warnings.add(`${where}: file ${v} ${f?.missing ? 'not found' : 'was not read (the caller passes `files`, see planInputFiles)'}: nothing is shown`);
      return undefined;
    }
    if (f.error) {
      warnings.add(`${where}: file ${v}: ${f.error}: nothing is shown`);
      return undefined;
    }
    if (type === 'lottie') {
      if (!f.lottie) {
        warnings.add(`${where}: ${v} is not a Lottie file: nothing is shown`);
        return undefined;
      }
      const l = f.lottie;
      return { kind: 'lottie', name: v, url: served(), width: l.width, height: l.height, fps: l.fps, frames: l.frames, duration_s: l.duration_s };
    }
    if (VIDEO_FILE_EXTENSIONS.includes(fileExtension(v))) {
      const p = f.video;
      if (!p) {
        warnings.add(`${where}: video ${v} could not be probed (ffprobe): nothing is shown`);
        return undefined;
      }
      return { kind: 'video', name: v, url: served(), width: p.width, height: p.height, duration_s: p.duration_s, fps: p.fps, audio: p.audio, alpha: p.alpha, codec: p.codec };
    }
    return { kind: 'picture', name: v, url: served(), ...(f.width && f.height ? { width: f.width, height: f.height } : {}), label: v };
  };
  const mediaOf = (manifest: ComponentManifest, slots: Record<string, string | undefined>, where: string): Record<string, MediaValue> | undefined => {
    let out: Record<string, MediaValue> | undefined;
    for (const [slot, spec] of Object.entries(manifest.slots)) {
      const value = slots[slot];
      if (value === undefined || value.trim() === '') continue;
      if (spec.type === 'image') {
        // An image file of the project: served by the renderer, the slot holds its URL.
        const v = value.trim();
        if (!/^(https?:|data:|ds-asset:)/.test(v)) {
          const f = input.files?.[v];
          if (f?.missing) warnings.add(`${where}: image ${v} not found`);
          slots[slot] = asset(`image-${slugOf(v)}`, f?.file ?? projectFile(v));
        }
        continue;
      }
      if (spec.type === 'frame') {
        const m = frameMedia(slot, value, where);
        if (m) (out ??= {})[slot] = m;
        continue;
      }
      if (spec.type === 'media' || spec.type === 'lottie') {
        // A user file (L2.12): a video or an image (media), a Lottie JSON (lottie) — of the project, or of the theme
        // (absolute paths).
        const m = fileMedia(spec.type, value.trim(), where);
        if (m) (out ??= {})[slot] = m;
        continue;
      }
      if (spec.type === 'data') {
        const v = value.trim();
        const f = input.files?.[v];
        if (!f || f.text === undefined) {
          warnings.add(`${where}: data file ${v} ${f?.missing ? 'not found' : 'was not read (the caller passes `files`, see planInputFiles)'}`);
          continue;
        }
        const table = parseCsv(f.text);
        if (table.columns.length === 0) warnings.add(`${where}: data file ${v} is empty`);
        (out ??= {})[slot] = { kind: 'table', name: v, columns: table.columns, rows: table.rows };
        continue;
      }
      if (!(ARTEFACT_SLOT_TYPES as readonly string[]).includes(spec.type)) continue;
      const type = spec.type as ArtefactSlotType;
      const a = findArtefact(type, value);
      if (!a) {
        const kind = type === 'capture' ? 'text' : type;
        const names = artefacts.filter((x) => x.kind === kind).map((x) => (x.kind === 'notification' ? `${x.name} (#${x.index})` : x.name));
        warnings.add(
          `${where}: ${type} "${value}" was not captured by run ${timeline.run_id}` +
            (names.length ? ` (captured: ${names.join(', ')})` : ` (the run captured no ${type === 'capture' ? 'text' : type})`) +
            ' — the component shows its scenario values only',
        );
        continue;
      }
      if (a.kind === 'document' && a.pages.length === 0) warnings.add(`${where}: document "${value}" has no rasterised page (not a PDF or an image?)`);
      (out ??= {})[slot] = mediaOfArtefact(a);
    }
    return out;
  };
  return { findArtefact, mediaOf };
}

/** A short deterministic hash of a string (FNV-1a, 8 hex digits): unique asset names for user files. */
function shortHash(v: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
