/** report.md: the review for a human (or an agent reading Markdown). */
import { basename, relative } from 'node:path';
import type { OutputTimeline } from './timeline.js';
import { environmentLine } from './checks.js';
import { findingLine, summaryLine } from './report-lines.js';
import { timecode } from './spans.js';
import type { ReviewResult, Severity } from './types.js';

const ICON: Record<Severity, string> = { error: 'ERROR', warning: 'WARNING', info: 'info' };

export function reportMarkdown(r: Omit<ReviewResult, 'thumbnails'>, tl: OutputTimeline): string {
  const rel = (f: string) => relative(r.files.dir, f) || basename(f);
  const L: string[] = [];
  L.push(`# Review — ${r.render.id}`);
  L.push('');
  L.push(
    `${r.render.scenario} · ${r.render.duration_s.toFixed(2)} s · ${r.render.frames} frames @ ${r.render.fps} fps · ${r.render.width}×${r.render.height} · theme ${r.render.template} · run ${r.render.run_id}`,
  );
  L.push('');
  // L1.7: the environment the run filmed — production, its access, the writes a read-only run saw, the clock.
  if (r.environment) {
    L.push(`Environment ${environmentLine(r.environment)}`);
    L.push('');
  }
  L.push(`**${summaryLine(r)}**`);
  L.push('');
  for (const sev of ['error', 'warning', 'info'] as const) {
    const list = r.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    L.push(`## ${sev === 'error' ? 'Errors' : sev === 'warning' ? 'Warnings' : 'Info'}`);
    L.push('');
    for (const f of list) L.push(`- ${ICON[sev]} ${findingLine(f)}`);
    L.push('');
  }
  L.push('## Segments');
  L.push('');
  L.push('| # | segment | kind | start | end | duration | speed | component |');
  L.push('|---|---|---|---|---|---|---|---|');
  r.durations.segments.forEach((d, i) => {
    L.push(
      `| ${i + 1} | ${d.id} | ${d.kind} | ${timecode(d.from_s)} | ${timecode(d.to_s)} | ${d.duration_s.toFixed(2)} s | ${d.speed !== undefined ? `${d.speed.toFixed(2)}×` : ''} | ${d.component} |`,
    );
  });
  L.push(`|  | **total** |  |  |  | **${r.durations.total_s.toFixed(2)} s** |  |  |`);
  L.push('');
  if (tl.captions.length) {
    L.push('## Captions');
    L.push('');
    for (const c of tl.captions) L.push(`- ${timecode(c.from_s)}–${timecode(c.to_s)} · ${c.scene}: ${c.kicker ? `${c.kicker.toUpperCase()} — ` : ''}${c.text}`);
    L.push('');
  }
  if (tl.markers.length || tl.clicks.length) {
    L.push('## Markers and clicks');
    L.push('');
    for (const m of tl.markers) L.push(`- marker **${m.name}** at ${timecode(m.time)} (f${m.frame}, ${m.scene})`);
    for (const c of tl.clicks) L.push(`- ${c.action} at ${timecode(c.time)} (f${c.frame}) · ${c.scene} step ${c.step_id ?? c.step}${c.target ? ` · ${c.target}` : ''}`);
    L.push('');
  }
  if (r.diff) {
    const d = r.diff;
    L.push(`## Changes since ${d.previous}`);
    L.push('');
    L.push(
      `Duration ${d.duration_s.previous.toFixed(2)} s → ${d.duration_s.current.toFixed(2)} s (${d.duration_s.delta >= 0 ? '+' : ''}${d.duration_s.delta.toFixed(2)} s).${d.template ? ` Theme ${d.template.previous} → ${d.template.current}.` : ''}${d.run ? ` Run ${d.run.previous} → ${d.run.current}.` : ''}`,
    );
    L.push('');
    L.push('| segment | status | duration | changes |');
    L.push('|---|---|---|---|');
    for (const s of d.segments) {
      const dur =
        s.status === 'removed'
          ? `${s.previous_duration_s?.toFixed(2)} s`
          : s.previous_duration_s !== undefined
            ? `${s.previous_duration_s.toFixed(2)} → ${s.duration_s?.toFixed(2)} s`
            : `${s.duration_s?.toFixed(2)} s`;
      L.push(`| ${s.id} | ${s.status} | ${dur} | ${s.changes.join('; ')} |`);
    }
    L.push('');
    L.push(
      `${d.changed_frames.length} of ${d.compared} sample frames changed visibly${d.changed_frames.length ? `: ${d.changed_frames.map((f) => `${timecode(f.time)} (${f.segment}, ${Math.round(f.changed * 100)} %)`).join(', ')}` : ''}.${d.sheet ? ` Side by side: \`${rel(d.sheet)}\`.` : ''}`,
    );
    L.push('');
  }
  L.push('## Files');
  L.push('');
  L.push(`- contact sheet (${r.review.fps} fps): ${r.files.sheets.map((f) => `\`${rel(f)}\``).join(', ')}`);
  const scenes = Object.entries(r.files.scene_sheets);
  if (scenes.length) L.push(`- per-scene sheets (2 fps): ${scenes.flatMap(([, files]) => files.map((f) => `\`${rel(f)}\``)).join(', ')}`);
  const kf = Object.values(r.files.keyframes);
  if (kf.length) L.push(`- key frames: ${kf.map((f) => `\`${rel(f)}\``).join(', ')}`);
  L.push(`- output-time timeline: \`${rel(r.files.timeline)}\` · report: \`${rel(r.files.report_json)}\``);
  L.push('');
  return L.join('\n');
}
