/**
 * What a render record says that the render itself does not: the encoding every render has, what its audio track
 * carries, the captions a review expects of each scene, and whether its paths may be read by work an agent submitted.
 * Pure (the file facts are handed in): the planner entry exports them, so the engine's render use case builds and
 * checks a record without loading the renderer.
 */
import type { FileFacts, Timeline } from '@retake/core/model';
import { insideFolder } from '@retake/core/scenario';
import type { EditPlan } from './plan-types.js';
import type { RenderRecord } from './render-record.js';
import { playsSound } from './remotion/frames.js';

/** What every render encodes (the encoder and its rate are the render policy's). */
export const RENDER_ENCODING = { codec: 'h264', pixel_format: 'yuv420p' } as const;

/** What the audio track of a render carries: the music bed and / or the own sound of the plan's files. */
export function audioOf(plan: Pick<EditPlan, 'music' | 'segments'>): RenderRecord['encoding']['audio'] {
  const files = plan.segments.some((s) => playsSound(s.component) || (s.kind === 'clip' && s.overlays.some((o) => playsSound(o.component))));
  return plan.music ? (files ? 'music+files' : 'music') : files ? 'files' : 'silent';
}

/** The caption texts of each scene of a timeline (its own and its steps'): what a review expects a clip to show. */
export function sceneCaptions(timeline: Pick<Timeline, 'scenes' | 'events'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of timeline.scenes) if (s.kind === 'scene' && s.caption?.text) (out[s.id] ??= []).push(s.caption.text);
  for (const ev of timeline.events) if (ev.step >= 0 && ev.caption?.text) (out[ev.scene] ??= []).push(ev.caption.text);
  return out;
}

/**
 * Why a render may not be exported (or reviewed) by work submitted through MCP, or null: its video and its run folder
 * must lie in the project folder, symbolic links resolved through `files` (a record's paths are absolute: one edited
 * by hand, or of a moved workspace, could name any file).
 */
export function recordPathProblem(projectDir: string, record: Pick<RenderRecord, 'id' | 'file' | 'run_dir'>, files: FileFacts): string | null {
  for (const [what, p] of [
    ['video', record.file],
    ['run folder', record.run_dir],
  ] as const) {
    if (typeof p !== 'string' || !insideFolder(projectDir, p, files)) {
      return `the ${what} of render ${record.id} (${String(p)}) is outside the project folder: through MCP a render is read only from the project`;
    }
  }
  return null;
}
