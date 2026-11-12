/**
 * The capture port's raw export in memory, for tests (L7.22): no ffmpeg, no frames. The gate is the package's rule
 * (the one reader, core namedRunProblem, in the export's words — a missing film is not the gate's), refused as the
 * port says (an EngineError of the sentence). The export writes a small package — a stand-in file per clip (one per
 * capture scene), the marker and cursor data names, manifest.json and README.md — into `out`, else the package's
 * default folder (`<project>/exports/<run>-raw-<format><fps>-<cursor>/`), and answers its manifest. Not exported from
 * the package (memory-capture.ts uses it).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { missingOrInvalid } from '@retake/core/base';
import { projectPath } from '@retake/core/project';
import { namedRunProblem, takeWords, timelineProblem } from '@retake/core/run';
import { readNamedRun } from '@retake/core/io';
import type { Timeline } from '@retake/core/model';
import type { ExportCaptureOptions, RawExportResult, RawManifest } from '@retake/runner-web/types';
import { EngineError } from '../errors.js';
import type { CaptureRaw } from './runner.js';

const refused = (message: string) => new EngineError(missingOrInvalid(message), message);

async function gate(runDir: string): Promise<Timeline> {
  const { facts, timeline: whole } = await readNamedRun(runDir);
  const run = (facts.timeline.ok ? facts.timeline.value.run_id : undefined) ?? basename(runDir);
  const problem = namedRunProblem(facts, { trust: 'author', inside: true });
  if (problem && problem.why !== 'no-film') throw refused(takeWords(problem, { run, verb: 'export', dir: runDir }));
  if (!whole.ok) throw refused(takeWords(timelineProblem(whole) ?? { why: 'no-timeline' }, { run, verb: 'export', dir: runDir }));
  return whole.value;
}

/** What the in-memory raw export was asked, in order. */
export type MemoryRawCall = { member: 'raw.timeline'; runDir: string } | { member: 'raw.export'; options: ExportCaptureOptions };

export function memoryRaw(calls: { push(call: MemoryRawCall): unknown } = []): CaptureRaw {
  return {
    timeline: async (runDir) => {
      calls.push({ member: 'raw.timeline', runDir });
      return gate(runDir);
    },
    export: async (o): Promise<RawExportResult> => {
      calls.push({ member: 'raw.export', options: o });
      o.signal?.throwIfAborted();
      const timeline = await gate(resolve(o.runDir));
      const format = o.format ?? 'mp4';
      const fps = o.fps ?? 30;
      const cursor = o.cursor ?? (timeline.capture.cursor === 'hidden' ? 'none' : 'baked');
      const dir = o.out ?? projectPath(o.project.dir, 'exports', `${timeline.run_id}-raw-${format}${fps}-${cursor}`);
      await mkdir(dir, { recursive: true });
      const ext = format === 'prores' ? 'mov' : 'mp4';
      const scenes = timeline.scenes.filter((x) => x.kind === 'scene');
      const clips: RawManifest['clips'] = [];
      for (const [i, sc] of scenes.entries()) {
        o.onProgress?.({ stage: 'clip', done: i, total: scenes.length });
        const file = `${String(i + 1).padStart(2, '0')}-${sc.id}.${ext}`;
        await writeFile(join(dir, file), 'memory clip');
        clips.push({
          file,
          name: sc.id,
          scene: sc.id,
          scene_number: i + 1,
          primary: true,
          width: 1920,
          height: 1080,
          fps,
          frames: fps,
          duration_s: 1,
          codec: 'h264',
          pix_fmt: 'yuv420p',
          timecode: '00:00:00:00',
          size_bytes: 11,
          seq_start_frame: i * fps,
          seq_start_tc: `00:00:${String(i).padStart(2, '0')}:00`,
          capture: { from: i, to: i + 1 },
          cuts: [],
        });
      }
      const count = { scene: scenes.length, step: 0, mark: 0, caption: 0, cut: 0 };
      const colors = { scene: 'Blue', step: 'Green', mark: 'Purple', caption: 'Yellow', cut: 'Red' };
      const manifest: RawManifest = {
        version: 1,
        kind: 'retake/raw-capture',
        created_at: '2026-01-01T00:00:00.000Z',
        project: { slug: o.project.slug, name: o.project.config.name },
        scenario: timeline.scenario,
        run: {
          id: timeline.run_id,
          dir: resolve(o.runDir),
          captured_at: '2026-01-01T00:00:00.000Z',
          capture: { width: 1920, height: 1080, scale: 1, fps: 30, duration_s: scenes.length, frames: 30 * scenes.length },
          cursor: timeline.capture.cursor === 'hidden' ? 'hidden' : 'visible',
        },
        settings: { format, codec: 'h264', fps, cursor, cuts: o.cuts ?? true, selects: o.selects ?? false, frames_from: 'capture video' },
        sequence: { fps, frames: fps * scenes.length, duration_s: scenes.length, start_tc: '00:00:00:00', end_tc: `00:00:${String(scenes.length).padStart(2, '0')}:00` },
        clips,
        cursor: { mode: cursor, data: { json: 'cursor.json', csv: 'cursor.csv', clicks_csv: 'clicks.csv' }, icons: 'recorded', look: { style: 'arrow', size: 1, ripple_color: '#000000' }, layers: [] },
        markers: { fcpxml: 'markers.fcpxml', edl: 'markers.edl', otio: 'markers.otio', json: 'markers.json', csv: 'markers.csv', count, colors },
        edit_files: o.editFiles ?? [],
        notes: [],
        warnings: o.template ? [] : ['the cursor layer uses the default look'],
      };
      const manifestFile = join(dir, 'manifest.json');
      const readme = join(dir, 'README.md');
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
      await writeFile(readme, '# raw package (in memory)\n');
      o.onProgress?.({ stage: 'done', done: scenes.length, total: scenes.length });
      return { dir, manifest, manifestFile, readme };
    },
  };
}
