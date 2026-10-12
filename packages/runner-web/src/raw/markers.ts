/**
 * Markers of a raw export for editing tools (L2.13, R-RAW-03): scenes, steps, marks, captions and loading cuts on
 * the clips, in clip-relative and sequence time, written as FCPXML 1.10 (one project, the clips on a spine), CMX 3600
 * EDL with locators, OpenTimelineIO JSON and CSV / JSON. Every clip carries a start timecode equal to its place on the
 * sequence (00:00:00:00 = the sequence start), so source and record timecodes agree in every tool. Pure.
 */
import type { TimelineEvent } from '@demo-studio/core';
import { clipFrameAt, type RawClipPlan, type RawPlan, sequenceStartOf } from './plan.js';
import { csvLine } from './cursor.js';

export type RawMarkerKind = 'scene' | 'step' | 'mark' | 'caption' | 'cut';
/** OpenTimelineIO marker colours (the EDL keeps the CMX ones: red, green, blue, cyan, magenta, yellow). */
export type MarkerColor = 'RED' | 'GREEN' | 'BLUE' | 'CYAN' | 'MAGENTA' | 'YELLOW' | 'ORANGE' | 'PURPLE' | 'PINK' | 'WHITE' | 'BLACK';

export const MARKER_COLORS: Record<RawMarkerKind, MarkerColor> = { scene: 'BLUE', step: 'GREEN', mark: 'RED', caption: 'YELLOW', cut: 'MAGENTA' };

export interface RawMarker {
  kind: RawMarkerKind;
  name: string;
  comment: string;
  color: MarkerColor;
  /** The clip it sits on (the scene's sequence clip) and its frame there. */
  clip: number;
  frame: number;
  /** Length in frames (≥ 1): a caption lasts until the next one, a step its own span. */
  duration: number;
  /** Sequence frame. */
  seq: number;
  /** Capture time (s). */
  capture_t: number;
  scene: string;
  step?: number;
  step_id?: string;
  action?: string;
  page?: string;
}

const MAX_NAME = 64;
const short = (s: string, n = MAX_NAME) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const captionText = (c: { kicker?: string; text: string }) => (c.kicker ? `${c.kicker} — ${c.text}` : c.text);

/** A step's moment for its marker: a wait's end (what it waited for), a click's press, else its start. */
function markMoment(e: TimelineEvent): number {
  if (e.action === 'wait_for' || e.action === 'wait_for_email') return e.t_end;
  return typeof e.t_click === 'number' ? e.t_click : e.t_start;
}

/** The markers of a raw export, on each scene's sequence clip, sorted by sequence frame. */
export function rawMarkers(plan: RawPlan): RawMarker[] {
  const fps = plan.fps;
  const out: RawMarker[] = [];
  for (const s of plan.sequence) {
    const clip = plan.clips[s.clip];
    // A moment at the very end of the scene (a wait it ends on) falls on the frame after the clip's last: its last frame.
    const at = (t: number) => clipFrameAt(clip, t, fps) ?? (t <= clip.t1 + 1 / fps ? clip.frames - 1 : null);
    const add = (m: Omit<RawMarker, 'clip' | 'seq' | 'color'> & { color?: MarkerColor }) => {
      const frame = Math.max(0, Math.min(clip.frames - 1, m.frame));
      const duration = Math.max(1, Math.min(m.duration, clip.frames - frame));
      out.push({ ...m, color: m.color ?? MARKER_COLORS[m.kind], clip: clip.index, frame, duration, seq: s.start + frame });
    };
    const multi = plan.clips.some((c) => c.number === clip.number && c !== clip);
    add({
      kind: 'scene',
      name: short(`${String(clip.number).padStart(2, '0')} ${clip.scene}`),
      comment: [clip.caption ? captionText(clip.caption) : '', multi ? `pages: ${plan.clips.filter((c) => c.number === clip.number).map((c) => c.page).join(', ')}` : '']
        .filter(Boolean)
        .join(' · '),
      frame: 0,
      duration: 1,
      capture_t: clip.t0,
      scene: clip.scene,
    });
    const steps = clip.events.filter((e) => e.step >= 0 && e.status !== 'skipped').sort((a, b) => a.t_start - b.t_start || a.step - b.step);
    // Captions: the scene's from the start, a step's from its start; each until the next one (or the clip end).
    const cues: Array<{ frame: number; text: string; step?: TimelineEvent }> = [];
    if (clip.caption) cues.push({ frame: 0, text: captionText(clip.caption) });
    for (const e of steps) {
      if (!e.caption) continue;
      const f = at(e.t_start);
      if (f !== null) cues.push({ frame: f, text: captionText(e.caption), step: e });
    }
    cues.sort((a, b) => a.frame - b.frame);
    cues.forEach((c, i) => {
      const next = cues.slice(i + 1).find((x) => x.frame > c.frame);
      add({
        kind: 'caption',
        name: short(c.text),
        comment: c.text,
        frame: c.frame,
        duration: (next ? next.frame : clip.frames) - c.frame,
        capture_t: c.step ? c.step.t_start : clip.t0,
        scene: clip.scene,
        ...(c.step ? { step: c.step.step, ...(c.step.id ? { step_id: c.step.id } : {}) } : {}),
      });
    });
    for (const e of steps) {
      const f = at(e.t_start);
      if (f === null) continue;
      const end = at(e.t_end);
      const target = e.target?.desc ? ` ${e.target.desc}` : '';
      const page = e.page && multi ? ` (${e.page})` : '';
      add({
        kind: 'step',
        name: short(`${e.step + 1}. ${e.action}${target}${page}`),
        comment: `${clip.scene} step ${e.step + 1}${e.id ? ` (${e.id})` : ''}: ${e.action}${target}${e.page ? ` on ${e.page}` : ''}`,
        frame: f,
        duration: Math.max(1, (end ?? clip.frames) - f),
        capture_t: e.t_start,
        scene: clip.scene,
        step: e.step,
        ...(e.id ? { step_id: e.id } : {}),
        action: e.action,
        ...(e.page ? { page: e.page } : {}),
      });
      if (e.mark) {
        const mf = at(markMoment(e));
        if (mf !== null) {
          add({
            kind: 'mark',
            name: short(e.mark),
            comment: `mark "${e.mark}": ${clip.scene} step ${e.step + 1} ${e.action}${target}`,
            frame: mf,
            duration: 1,
            capture_t: markMoment(e),
            scene: clip.scene,
            step: e.step,
            ...(e.id ? { step_id: e.id } : {}),
            action: e.action,
            ...(e.page ? { page: e.page } : {}),
          });
        }
      }
    }
    for (const c of clip.cuts) {
      add({
        kind: 'cut',
        name: short(`cut ${(c.to - c.from).toFixed(1)} s ${c.reason}`),
        comment: `${(c.to - c.from).toFixed(2)} s of ${c.reason === 'navigation' ? 'page loading' : c.reason === 'mail' ? 'waiting for the email' : 'loading'} cut here (capture ${c.from.toFixed(2)}–${c.to.toFixed(2)} s)`,
        frame: c.at,
        duration: 1,
        capture_t: c.to,
        scene: clip.scene,
        step: c.wait_step,
        ...(c.page ? { page: c.page } : {}),
      });
    }
  }
  const order: Record<RawMarkerKind, number> = { scene: 0, caption: 1, cut: 2, step: 3, mark: 4 };
  return out.sort((a, b) => a.seq - b.seq || order[a.kind] - order[b.kind]);
}

/** Non-drop timecode HH:MM:SS:FF of a frame count at an integer frame rate. */
export function timecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const ff = f % fps;
  const total = Math.floor(f / fps);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}:${p(ff)}`;
}

/** A rational time in FCPXML form: frames/fps seconds ("0s", "1/30s", "249/30s"). */
export function fcpTime(frames: number, fps: number): string {
  return frames === 0 ? '0s' : `${frames}/${fps}s`;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** file:// URL of an absolute path (percent-encoded). */
export function fileUrl(abs: string): string {
  return 'file://' + abs.split('/').map((p) => encodeURIComponent(p)).join('/');
}

/** Files of a package, per clip index: the clip and (layer mode) its cursor layer, absolute paths. */
export interface PackageFiles {
  clips: string[];
  layers?: string[];
  /**
   * Whether the layers carry their clip's start timecode (ProRes .mov, the default). VP9 WebM layers cannot (Matroska
   * has no timecode track): their media time starts at 0, and Final Cut Pro cannot read them — they are left out of
   * the FCPXML and referenced from 0 in the OTIO.
   */
  layersTimecoded?: boolean;
}

export interface InterchangeMeta {
  /** Project / sequence name. */
  title: string;
  /** Event (FCP library event) name. */
  event: string;
  /** Stable id seed (the run id). */
  uid: string;
}

/** A format per clip pixel size (FCPXML resources). */
function formatKey(c: RawClipPlan): string {
  return `${c.source.width}x${c.source.height}`;
}

/**
 * FCPXML 1.10: one format per clip size, one asset per clip (and per ProRes cursor layer) with its start timecode, one
 * event with one project whose spine holds the sequence clips back to back; the other pages of a multi-page scene ride
 * on connected lanes, disabled (enable them for a split screen), the cursor layers on the lane above their clip,
 * enabled; scenes are chapter markers, steps / marks / captions / cuts markers (name and note). WebM layers are left
 * out (Final Cut Pro does not read VP9; they have no timecode): they are in the OTIO.
 */
export function writeFcpxml(plan: RawPlan, markers: readonly RawMarker[], files: PackageFiles, meta: InterchangeMeta): string {
  const fps = plan.fps;
  const layers = files.layersTimecoded === false ? undefined : files.layers;
  const t = (n: number) => fcpTime(n, fps);
  const formats = new Map<string, string>();
  const res: string[] = [];
  let rid = 0;
  const nextId = () => `r${++rid}`;
  const formatOf = (c: RawClipPlan) => {
    const key = formatKey(c);
    let id = formats.get(key);
    if (!id) {
      id = nextId();
      formats.set(key, id);
      res.push(`    <format id="${id}" frameDuration="${t(1)}" width="${c.source.width}" height="${c.source.height}" colorSpace="1-1-1 (Rec. 709)"/>`);
    }
    return id;
  };
  const primary0 = plan.sequence.length ? plan.clips[plan.sequence[0].clip] : plan.clips[0];
  const seqFormat = primary0 ? formatOf(primary0) : nextId();
  const assets = new Map<number, string>();
  const layerAssets = new Map<number, string>();
  for (const c of plan.clips) {
    const f = formatOf(c);
    const start = sequenceStartOf(plan, c);
    const id = nextId();
    assets.set(c.index, id);
    res.push(
      `    <asset id="${id}" name="${xml(c.name)}" uid="${xml(`${meta.uid}/${c.name}`)}" start="${t(start)}" duration="${t(c.frames)}" hasVideo="1" hasAudio="0" format="${f}" videoSources="1">`,
      `      <media-rep kind="original-media" src="${xml(fileUrl(files.clips[c.index]))}"/>`,
      `    </asset>`,
    );
    const layer = layers?.[c.index];
    if (layer) {
      const lid = nextId();
      layerAssets.set(c.index, lid);
      res.push(
        `    <asset id="${lid}" name="${xml(`${c.name}-cursor`)}" uid="${xml(`${meta.uid}/${c.name}-cursor`)}" start="${t(start)}" duration="${t(c.frames)}" hasVideo="1" hasAudio="0" format="${f}" videoSources="1">`,
        `      <media-rep kind="original-media" src="${xml(fileUrl(layer))}"/>`,
        `    </asset>`,
      );
    }
  }
  const spine: string[] = [];
  for (const s of plan.sequence) {
    const c = plan.clips[s.clip];
    const start = s.start;
    const inner: string[] = [];
    let lane = 1;
    const layer = layerAssets.get(c.index);
    if (layer) inner.push(`          <asset-clip ref="${layer}" lane="${lane++}" offset="${t(start)}" name="${xml(`${c.name}-cursor`)}" start="${t(start)}" duration="${t(c.frames)}" format="${formatOf(c)}" tcFormat="NDF"/>`);
    for (const o of plan.clips.filter((x) => x.number === c.number && x !== c)) {
      inner.push(`          <asset-clip ref="${assets.get(o.index)}" lane="${lane++}" offset="${t(start)}" name="${xml(o.name)}" start="${t(start)}" duration="${t(o.frames)}" format="${formatOf(o)}" tcFormat="NDF" enabled="0"/>`);
      const ol = layerAssets.get(o.index);
      if (ol) inner.push(`          <asset-clip ref="${ol}" lane="${lane++}" offset="${t(start)}" name="${xml(`${o.name}-cursor`)}" start="${t(start)}" duration="${t(o.frames)}" format="${formatOf(o)}" tcFormat="NDF" enabled="0"/>`);
    }
    for (const m of markers.filter((x) => x.clip === c.index)) {
      const at = t(start + m.frame);
      if (m.kind === 'scene') inner.push(`          <chapter-marker start="${at}" duration="${t(1)}" value="${xml(m.name)}"${m.comment ? ` note="${xml(m.comment)}"` : ''} posterOffset="0s"/>`);
      else inner.push(`          <marker start="${at}" duration="${t(m.duration)}" value="${xml(m.name)}" note="${xml(`[${m.kind}] ${m.comment}`)}"/>`);
    }
    // Inside an asset-clip, local time starts at its `start` (the clip's timecode): offsets and marker starts use it.
    spine.push(
      `        <asset-clip ref="${assets.get(c.index)}" offset="${t(start)}" name="${xml(c.name)}" start="${t(start)}" duration="${t(c.frames)}" format="${formatOf(c)}" tcFormat="NDF">`,
      ...inner,
      `        </asset-clip>`,
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    ...res,
    '  </resources>',
    '  <library>',
    `    <event name="${xml(meta.event)}">`,
    `      <project name="${xml(meta.title)}">`,
    `        <sequence format="${seqFormat}" duration="${t(plan.frames)}" tcStart="0s" tcFormat="NDF">`,
    '          <spine>',
    ...spine.map((l) => `    ${l}`),
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

/** CMX 3600 reel name: 8 characters (CLIP001…). */
const reelOf = (n: number) => `CLIP${String(n).padStart(3, '0')}`.slice(0, 8);
const EDL_COLORS: Record<MarkerColor, string> = {
  RED: 'RED',
  GREEN: 'GREEN',
  BLUE: 'BLUE',
  CYAN: 'CYAN',
  MAGENTA: 'MAGENTA',
  YELLOW: 'YELLOW',
  ORANGE: 'YELLOW',
  PURPLE: 'MAGENTA',
  PINK: 'MAGENTA',
  WHITE: 'WHITE',
  BLACK: 'BLACK',
};
/** EDL comments are one plain line (no lower-case loss needed; tools upper-case them themselves). */
const edlText = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, (c) => (c === '—' || c === '–' ? '-' : c === '…' ? '...' : c === '·' ? '-' : c === '×' ? 'x' : '?'));

/**
 * CMX 3600 EDL (non-drop): one cut event per sequence clip (video only — an EDL has one picture track, so the other
 * pages of a multi-page scene and the cursor layers are left to FCPXML / OTIO), the clip's file in FROM CLIP NAME /
 * FROM CLIP comments, its markers as `* LOC:` locators. Source timecodes = record timecodes (each clip starts at its
 * sequence position).
 */
export function writeEdl(plan: RawPlan, markers: readonly RawMarker[], files: PackageFiles, meta: InterchangeMeta): string {
  const fps = plan.fps;
  const tc = (n: number) => timecode(n, fps);
  const lines = [`TITLE: ${edlText(meta.title).slice(0, 70)}`, 'FCM: NON-DROP FRAME', ''];
  plan.sequence.forEach((s, i) => {
    const c = plan.clips[s.clip];
    const a = s.start;
    const b = s.start + c.frames;
    const ev = String(i + 1).padStart(3, '0');
    lines.push(`${ev}  ${reelOf(c.number).padEnd(8)} V     C        ${tc(a)} ${tc(b)} ${tc(a)} ${tc(b)}`);
    const file = files.clips[c.index];
    lines.push(`* FROM CLIP NAME: ${edlText(file.split('/').pop() ?? c.name)}`);
    lines.push(`* FROM CLIP: ${edlText(file)}`);
    for (const m of markers.filter((x) => x.clip === c.index)) {
      lines.push(`* LOC: ${tc(s.start + m.frame)} ${EDL_COLORS[m.color].padEnd(7)} ${edlText(`${m.kind.toUpperCase()}: ${m.name}`)}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
const range = (start: number, duration: number, rate: number) => ({ OTIO_SCHEMA: 'TimeRange.1', duration: rt(duration, rate), start_time: rt(start, rate) });

/**
 * OpenTimelineIO JSON (schema of OTIO 0.17/0.18): a Timeline whose video track V1 holds the sequence clips; with
 * cursor layers a track "Cursor" above them; with multi-page scenes a track per extra page (disabled clips, gaps
 * elsewhere) and their cursor layers. Clips reference their files (file:// URLs of absolute paths) with the available
 * range at their timecode (a WebM layer, which has none, from 0); markers sit on the sequence clips in media time
 * with name, colour and comment (+ kind / step metadata).
 */
export function writeOtio(plan: RawPlan, markers: readonly RawMarker[], files: PackageFiles, meta: InterchangeMeta): string {
  const fps = plan.fps;
  const clipItem = (c: RawClipPlan, file: string, name: string, enabled: boolean, withMarkers: boolean, timecoded = true) => {
    const seq = sequenceStartOf(plan, c);
    // Media time: the clip's start timecode (its place on the sequence), or 0 for media without one.
    const start = timecoded ? seq : 0;
    return {
      OTIO_SCHEMA: 'Clip.2',
      metadata: { demo_studio: { scene: c.scene, ...(c.page !== undefined ? { page: c.page } : {}), capture: { t0: c.t0, t1: c.t1 } } },
      name,
      source_range: range(start, c.frames, fps),
      effects: [],
      markers: withMarkers
        ? markers
            .filter((m) => m.clip === c.index)
            .map((m) => ({
              OTIO_SCHEMA: 'Marker.2',
              metadata: { demo_studio: { kind: m.kind, scene: m.scene, ...(m.step !== undefined ? { step: m.step } : {}), ...(m.step_id ? { step_id: m.step_id } : {}), ...(m.page ? { page: m.page } : {}), capture_t: m.capture_t } },
              name: m.name,
              color: m.color,
              marked_range: range(start + m.frame, m.duration, fps),
              comment: m.comment,
            }))
        : [],
      enabled,
      color: null,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          metadata: {},
          name: name,
          available_range: range(start, c.frames, fps),
          available_image_bounds: null,
          target_url: fileUrl(file),
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
    };
  };
  const gap = (frames: number) => ({ OTIO_SCHEMA: 'Gap.1', metadata: {}, name: '', source_range: range(0, frames, fps), effects: [], markers: [], enabled: true, color: null });
  const track = (name: string, children: unknown[], enabled = true) => ({ OTIO_SCHEMA: 'Track.1', metadata: {}, name, source_range: null, effects: [], markers: [], enabled, color: null, children, kind: 'Video' });
  /** A track with an item per sequence slot: `pick(primary)` or a gap. */
  const slotted = (pick: (primary: RawClipPlan) => unknown | null): unknown[] => {
    const out: unknown[] = [];
    let pending = 0;
    for (const s of plan.sequence) {
      const p = plan.clips[s.clip];
      const item = pick(p);
      if (item === null) {
        pending += p.frames;
        continue;
      }
      if (pending > 0) out.push(gap(pending));
      pending = 0;
      out.push(item);
    }
    if (pending > 0 && out.length > 0) out.push(gap(pending));
    return out;
  };
  const tracks: unknown[] = [track('V1', slotted((p) => clipItem(p, files.clips[p.index], p.name, true, true)))];
  const tc = files.layersTimecoded !== false;
  if (files.layers) tracks.push(track('Cursor', slotted((p) => (files.layers![p.index] ? clipItem(p, files.layers![p.index], `${p.name}-cursor`, true, false, tc) : null))));
  const extra = Math.max(0, ...plan.sequence.map((s) => plan.clips.filter((c) => c.number === plan.clips[s.clip].number).length - 1));
  for (let k = 0; k < extra; k++) {
    const other = (p: RawClipPlan) => plan.clips.filter((c) => c.number === p.number && c !== p)[k] ?? null;
    tracks.push(track(`Page ${k + 2}`, slotted((p) => { const o = other(p); return o ? clipItem(o, files.clips[o.index], o.name, false, false) : null; })));
    if (files.layers) tracks.push(track(`Page ${k + 2} cursor`, slotted((p) => { const o = other(p); return o && files.layers![o.index] ? clipItem(o, files.layers![o.index], `${o.name}-cursor`, false, false, tc) : null; })));
  }
  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { demo_studio: { run: meta.uid, fps, frames: plan.frames } },
    name: meta.title,
    global_start_time: rt(0, fps),
    tracks: { OTIO_SCHEMA: 'Stack.1', metadata: {}, name: 'tracks', source_range: null, effects: [], markers: [], enabled: true, color: null, children: tracks },
  };
  return JSON.stringify(timeline, null, 2) + '\n';
}

/** markers.json: every marker with clip-relative and sequence frames, seconds and timecodes. */
export function markersJson(plan: RawPlan, markers: readonly RawMarker[], clipFile: (c: RawClipPlan) => string): string {
  const fps = plan.fps;
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return (
    JSON.stringify(
      {
        version: 1,
        fps,
        sequence: { start_tc: timecode(0, fps), frames: plan.frames, duration_s: r4(plan.frames / fps) },
        colors: MARKER_COLORS,
        markers: markers.map((m) => {
          const c = plan.clips[m.clip];
          return {
            kind: m.kind,
            name: m.name,
            comment: m.comment,
            color: m.color,
            clip: clipFile(c),
            scene: m.scene,
            ...(m.page ? { page: m.page } : {}),
            ...(m.step !== undefined ? { step: m.step } : {}),
            ...(m.step_id ? { step_id: m.step_id } : {}),
            ...(m.action ? { action: m.action } : {}),
            clip_frame: m.frame,
            clip_time_s: r4(m.frame / fps),
            clip_tc: timecode(m.frame, fps),
            seq_frame: m.seq,
            seq_time_s: r4(m.seq / fps),
            seq_tc: timecode(m.seq, fps),
            duration_frames: m.duration,
            duration_s: r4(m.duration / fps),
            capture_t: m.capture_t,
          };
        }),
      },
      null,
      1,
    ) + '\n'
  );
}

/** markers.csv: the same, one row per marker. */
export function markersCsv(plan: RawPlan, markers: readonly RawMarker[], clipFile: (c: RawClipPlan) => string): string {
  const fps = plan.fps;
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const rows = [csvLine(['kind', 'name', 'color', 'clip', 'scene', 'page', 'step', 'step_id', 'action', 'clip_frame', 'clip_time_s', 'clip_tc', 'seq_frame', 'seq_time_s', 'seq_tc', 'duration_frames', 'duration_s', 'capture_t', 'comment'])];
  for (const m of markers) {
    rows.push(
      csvLine([m.kind, m.name, m.color, clipFile(plan.clips[m.clip]), m.scene, m.page ?? '', m.step ?? '', m.step_id ?? '', m.action ?? '', m.frame, r4(m.frame / fps), timecode(m.frame, fps), m.seq, r4(m.seq / fps), timecode(m.seq, fps), m.duration, r4(m.duration / fps), m.capture_t, m.comment]),
    );
  }
  return rows.join('\n') + '\n';
}
