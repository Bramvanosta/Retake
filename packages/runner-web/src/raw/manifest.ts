/** A raw package's manifest.json and README.md (exportCapture). */
import { mb, round3 } from './settings.js';
import type { RawManifest, RawManifestClip } from './settings.js';
import type { RawJob } from './stages.js';
import type { kitConfigFor } from '../kit/source.js';
import { LAYER_ENCODING, rawCodecLabel, type ProbedVideo } from './encode.js';
import { MARKER_COLORS, type rawMarkers, timecode, type RawMarkerKind } from './markers.js';
import { sequenceStartOf, type RawClipPlan, type RawPlan } from './plan.js';

/** A clip as the manifest lists it: its probe, its place on the sequence, its cuts and its cursor layer. */
export function manifestClip(job: RawJob, c: RawClipPlan, p: ProbedVideo, lp: ProbedVideo | undefined): RawManifestClip {
  const { plan, s, clipRel, layerRel } = job;
  const start = sequenceStartOf(plan, c);
  return {
    file: clipRel(c),
    name: c.name,
    scene: c.scene,
    scene_number: c.number,
    ...(c.page !== undefined ? { page: c.page } : {}),
    ...(c.label !== undefined ? { label: c.label } : {}),
    primary: c.primary,
    ...(c.caption ? { caption: c.caption.kicker ? `${c.caption.kicker} — ${c.caption.text}` : c.caption.text } : {}),
    width: p.width,
    height: p.height,
    fps: p.fps,
    frames: p.frames,
    duration_s: round3(p.frames / s.fps),
    codec: p.codec,
    ...(p.profile ? { profile: p.profile } : {}),
    pix_fmt: p.pix_fmt,
    timecode: p.timecode ?? timecode(start, s.fps),
    size_bytes: p.size_bytes,
    seq_start_frame: start,
    seq_start_tc: timecode(start, s.fps),
    capture: { from: c.t0, to: c.t1 },
    cuts: c.cuts.map((x) => ({
      at_frame: x.at,
      at_tc: timecode(start + x.at, s.fps),
      capture_from: x.from,
      capture_to: x.to,
      seconds: round3(x.to - x.from),
      reason: x.reason,
      ...(x.wait_step !== undefined ? { wait_step: x.wait_step } : {}),
      ...(x.after_step !== undefined ? { after_step: x.after_step } : {}),
    })),
    ...(lp
      ? {
          layer: {
            file: layerRel(c),
            codec: lp.codec,
            ...(lp.profile ? { profile: lp.profile } : {}),
            pix_fmt: lp.alpha && !/^yuva/.test(lp.pix_fmt) ? `${lp.pix_fmt} + alpha` : lp.pix_fmt,
            alpha: lp.alpha,
            frames: lp.frames,
            size_bytes: lp.size_bytes,
          },
        }
      : {}),
  };
}

/** What the stages made, for the manifest. */
export interface RawOutputs {
  record: { status?: string; env?: string } | undefined;
  kit: ReturnType<typeof kitConfigFor>;
  probes: Map<number, ProbedVideo>;
  layerProbes: Map<number, ProbedVideo>;
  approximated: boolean;
  selects: RawManifest['selects'];
  markers: ReturnType<typeof rawMarkers>;
  mk: { fcpxml: string; edl: string; otio: string; json: string; csv: string };
}

/** The package's manifest.json. */
export function rawManifest(job: RawJob, out: RawOutputs): RawManifest {
  const { opts, timeline, s, plan, runDir } = job;
  const { record, kit, selects } = out;
  const count = { scene: 0, step: 0, mark: 0, caption: 0, cut: 0 } as Record<RawMarkerKind, number>;
  for (const m of out.markers) count[m.kind]++;
  const cap = timeline.capture;
  return {
    version: 1,
    kind: 'retake/raw-capture',
    created_at: new Date().toISOString(),
    project: { slug: opts.project.slug, name: opts.project.config.name },
    scenario: timeline.scenario,
    run: {
      id: timeline.run_id,
      dir: runDir,
      captured_at: timeline.created_at,
      ...(record?.status ? { status: record.status } : {}),
      ...(record?.env ? { env: record.env } : {}),
      capture: { width: cap.width, height: cap.height, scale: cap.scale, fps: cap.fps, duration_s: cap.duration, frames: cap.frames },
      cursor: s.hidden ? 'hidden' : 'visible',
    },
    settings: {
      format: s.format,
      codec: rawCodecLabel(s.format, job.h264),
      fps: s.fps,
      cursor: s.cursor,
      ...(s.cursor === 'layer' ? { layer: s.layer, layer_codec: LAYER_ENCODING[s.layer].label } : {}),
      cuts: s.cuts,
      selects: s.selects,
      frames_from: job.fromVideo ? 'capture video' : 'screencast frames',
    },
    sequence: { fps: s.fps, frames: plan.frames, duration_s: round3(plan.frames / s.fps), start_tc: timecode(0, s.fps), end_tc: timecode(plan.frames, s.fps) },
    clips: plan.clips.map((c) => manifestClip(job, c, out.probes.get(c.index)!, out.layerProbes.get(c.index))),
    ...(selects ? { selects } : {}),
    cursor: {
      mode: s.cursor,
      data: { json: 'cursor/cursor.json', csv: 'cursor/cursor.csv', clicks_csv: 'cursor/clicks.csv' },
      icons: out.approximated ? 'approximated' : 'recorded',
      look: { style: kit.cursor.style, size: kit.cursor.size, ripple_color: kit.cursor.ripple_color },
      layers: s.cursor === 'layer' ? plan.clips.map(job.layerRel) : [],
    },
    markers: { ...out.mk, count, colors: MARKER_COLORS },
    edit_files: [...new Set(opts.editFiles ?? [])].sort(),
    notes: job.notes,
    warnings: job.warnings,
  };
}

/** README.md of a package: what it holds and how to bring it into an editing tool. */
export function packageReadme(m: RawManifest, plan: RawPlan): string {
  const fps = m.sequence.fps;
  const rows = m.clips.map(
    (c) =>
      `| \`${c.file}\` | ${c.scene}${c.page ? ` · ${c.page}${c.label ? ` (${c.label})` : ''}` : ''}${c.primary ? '' : ' *(other page)*'} | ${c.width}×${c.height} | ${c.frames} (${c.duration_s.toFixed(2)} s) | ${c.seq_start_tc} | ${c.cuts.length ? c.cuts.map((x) => `${x.seconds.toFixed(1)} s ${x.reason} at ${x.at_tc}`).join('; ') : '—'} |`,
  );
  const webm = m.settings.layer === 'webm';
  const cursor =
    m.cursor.mode === 'baked'
      ? 'The cursor is **in the pictures** (as captured).'
      : m.cursor.mode === 'none'
        ? 'The clips have **no cursor** (captured without it). Its position, icon, presses and ripples on every frame are in `cursor/cursor.json` / `cursor/cursor.csv`, the clicks with their step and target box in `cursor/clicks.csv` (clip pixels, clip-relative seconds).'
        : webm
          ? `Each clip has a **transparent cursor layer** (\`cursor/<clip>-cursor.webm\`, ${m.settings.layer_codec}) with the cursor and its click ripples, same size, frame rate and length as its clip: put it on the track above, aligned with its clip's start. WebM has **no timecode**: the layer's media time starts at 0 (00:00:00:00), not at its clip's timecode. VP9 WebM with alpha is for web players and ffmpeg-based tools (ffmpeg decodes its alpha with \`-c:v libvpx-vp9\` only); **Final Cut Pro and Premiere Pro do not read it** — export with \`--layer prores\` (ProRes 4444, timecoded like the clips) for them.${m.run.cursor === 'visible' ? ' (This run was captured with its cursor, so the clips show it too.)' : ''} The same data is in \`cursor/\` as JSON / CSV.`
          : `Each clip has a **transparent cursor layer** (\`cursor/<clip>-cursor.mov\`, ${m.settings.layer_codec}) with the cursor and its click ripples, same size, frame rate, length and start timecode as its clip: put it on the track above.${m.run.cursor === 'visible' ? ' (This run was captured with its cursor, so the clips show it too.)' : ''} The same data is in \`cursor/\` as JSON / CSV.`;
  return [
    `# Raw capture — ${m.scenario}`,
    '',
    `Run \`${m.run.id}\` of project ${m.project.name} (captured ${m.run.captured_at}), exported ${m.created_at} by Retake for editing in another tool.`,
    '',
    `- **Clips:** ${m.clips.length} (${plan.sequence.length} on the sequence), ${m.settings.codec}, **${fps} fps** constant frame rate (real frame timing of the capture, nothing interpolated), BT.709.`,
    `- **Sequence:** ${m.sequence.frames} frames = ${m.sequence.duration_s.toFixed(2)} s, ${m.sequence.start_tc} → ${m.sequence.end_tc}. Every clip's embedded start timecode is its place on the sequence, so source and record timecodes agree.`,
    `- **Cuts:** the page loads before each scene are never in a clip${m.settings.cuts ? '; the loading inside a scene (a wait for the product after a click) is cut — a jump cut marked with a magenta marker' : '; loading inside scenes is kept (--no-cuts)'}. Real time otherwise (no speed changes).`,
    `- **Cursor (${m.cursor.mode}):** ${cursor}`,
    m.selects ? `- **Selects:** \`${m.selects.file}\` — the sequence clips back to back in one file (${m.selects.frames} frames).` : '',
    '',
    '| Clip | Scene | Size | Frames | Starts at | Cuts |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Markers',
    `Scenes (blue, chapter markers in Final Cut Pro), steps (green), marks (red), captions (yellow, lasting until the next one) and loading cuts (magenta) — ${Object.entries(m.markers.count)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}.`,
    '',
    `- \`${m.markers.fcpxml}\` — **Final Cut Pro** (File → Import → XML…; FCPXML 1.10): an event with one project, the clips on the primary storyline, markers on them${m.cursor.mode === 'layer' ? (webm ? ' (the WebM cursor layers are not in it: Final Cut Pro cannot read them — they are in the OTIO)' : ', the cursor layers connected above') : ''}${m.clips.some((c) => !c.primary) ? ', the other page of a multi-page scene connected and disabled (enable it for a split screen)' : ''}. **DaVinci Resolve** imports it too (File → Import → Timeline…).`,
    `- \`${m.markers.otio}\` — **OpenTimelineIO** (DaVinci Resolve: File → Import → Timeline…; any OTIO tool or adapter, e.g. to Premiere via otio adapters): track V1 with the clips${m.cursor.mode === 'layer' ? `, a Cursor track above${webm ? ' (WebM layers referenced from media time 0)' : ''}` : ''}, markers with names, colours and comments.`,
    `- \`${m.markers.edl}\` — **CMX 3600 EDL** (Premiere Pro: File → Import; Resolve; Avid): one event per sequence clip, markers as \`* LOC:\` locators, ${fps} fps non-drop. An EDL has one picture track: other pages and cursor layers are in the FCPXML / OTIO only.`,
    `- \`${m.markers.csv}\` / \`${m.markers.json}\` — every marker in clip-relative and sequence time (frames, seconds, timecode) for spreadsheets, After Effects scripts or Claude.`,
    '',
    'The interchange files point at the clips by absolute path (file:// URLs in the FCPXML and OTIO); if you move this folder, relink to `clips/` (names are unique). In Premiere Pro, import the clips folder and the EDL, or convert the OTIO with an OTIO adapter (e.g. otio-fcp-adapter to FCP 7 XML).',
    '',
    ...(m.edit_files.length
      ? [
          '## Files the edit used',
          'Your own media the Retake edit of this scenario uses (intro / outro videos, overlays, images) — reuse them in your tool:',
          '',
          ...m.edit_files.map((f) => `- \`${f}\``),
          '',
        ]
      : []),
    ...(m.notes.length ? ['## Notes', ...m.notes.map((n) => `- ${n}`), ''] : []),
    ...(m.warnings.length ? ['## Warnings', ...m.warnings.map((n) => `- ${n}`), ''] : []),
    `Sizes: clips ${mb(m.clips.reduce((n, c) => n + c.size_bytes, 0))}${m.cursor.mode === 'layer' ? `, layers ${mb(m.clips.reduce((n, c) => n + (c.layer?.size_bytes ?? 0), 0))}` : ''}. Everything is described in \`manifest.json\`.`,
    '',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}
