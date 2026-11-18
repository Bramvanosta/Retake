/**
 * What a render record says that the render itself does not: the encoding every render has, what its audio track
 * carries, the captions a review expects of each scene, and whether its paths may be read by work an agent submitted.
 * Pure (the file facts are handed in): the planner entry exports them, so the engine's render use case builds and
 * checks a record without loading the renderer.
 */
import { isAbsolute } from 'node:path';
import { isPlanAssetUrl, printableText } from '@retake/core/base';
import type { FileFacts } from '@retake/core/model';
import type { Timeline } from '@retake/core/run';
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
 * What a use of a render opens (recordPathProblem): `video` — an export, a comment, a frame — its video and its run
 * folder; `review` — those, its plan's capture and its pages' tracks, and the caption fonts the review measures.
 */
export type RecordReads = 'video' | 'review';

/** A render a use may not read through MCP: the sentence (fixed words and the render id), and the path the record names (its text: untrusted). */
export interface RecordPathRefusal {
  message: string;
  path: string;
}

/** A plan's members that the check reads, leniently (a stored plan is any object). */
type PlanPaths = { source?: unknown; tracks?: unknown; assets?: unknown; brand?: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The font files a review measures a caption with (review checks-captions.ts planFontFiles): these extensions only. */
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

/** The caption faces of a plan (`brand.tokens.font_faces[].url`), read leniently. */
function fontFaceUrls(plan: PlanPaths | undefined): unknown[] {
  const tokens = isObject(plan?.brand) ? plan.brand.tokens : undefined;
  const faces = isObject(tokens) ? tokens.font_faces : undefined;
  return Array.isArray(faces) ? faces.map((f) => (isObject(f) ? f.url : undefined)) : [];
}

/**
 * Why a use of a render submitted through MCP may not read it, or null — checking exactly what that use opens
 * (`reads`). Every use: its video and its run folder inside the project folder, symbolic links resolved through
 * `files`. A review also: its plan's capture and its pages' tracks inside the project, and each caption face a plan
 * asset (a `font_faces[].url` that is a key of `plan.assets`) whose file is an absolute font file (.woff2 / .woff /
 * .ttf / .otf) that, when it is there, is a regular file (links followed: no device, no pipe; a font that is not there
 * is measured without) — the theme's fonts may lie anywhere
 * a theme does (the install's starters, the workspace's, a folder the project names). A path must be absolute: the
 * readers resolve a record's paths (core record-paths.ts), so a relative one is never judged against the server's
 * folder. The sentence holds fixed words and the render id only — the path is the record's text, handed apart.
 * (A record edited by hand, or written by someone else, could name any file.)
 */
export function recordPathProblem(
  projectDir: string,
  record: Pick<RenderRecord, 'id' | 'file' | 'run_dir'> & { plan?: unknown },
  files: FileFacts,
  o: { reads?: RecordReads } = {},
): RecordPathRefusal | null {
  const plan: PlanPaths | undefined = isObject(record.plan) ? record.plan : undefined;
  const id = printableText(String(record.id));
  const refuse = (what: string, p: unknown, why: string): RecordPathRefusal => ({
    message: `the ${what} of render ${id} ${why} (its record was edited by hand, or written elsewhere): through MCP the files of a render must lie in its project — render it again, or work on it at a terminal`,
    path: String(p),
  });
  const inProject: Array<[string, unknown]> = [
    ['video', record.file],
    ['run folder', record.run_dir],
  ];
  if (o.reads === 'review') {
    if (isObject(plan?.source) && plan.source.file !== undefined && plan.source.file !== '') inProject.push(['capture', plan.source.file]);
    if (isObject(plan?.tracks)) for (const track of Object.values(plan.tracks)) if (isObject(track) && track.file !== undefined) inProject.push(['page track', track.file]);
  }
  for (const [what, p] of inProject) {
    if (typeof p !== 'string' || p === '' || !isAbsolute(p)) return refuse(what, p, 'is no path Retake can read');
    if (!insideFolder(projectDir, p, files)) return refuse(what, p, 'names a file outside its project');
  }
  if (o.reads === 'review') {
    const assets = isObject(plan?.assets) ? plan.assets : {};
    for (const url of fontFaceUrls(plan)) {
      const file = typeof url === 'string' && isPlanAssetUrl(url) && Object.hasOwn(assets, url) ? assets[url] : undefined;
      // A font that is not there is no danger (the review measures without it: a render made by another install of
      // Retake names that install's starter fonts); one that is there must be a regular file.
      const kind = typeof file === 'string' ? files.kind(file) : undefined;
      if (typeof file !== 'string' || !isAbsolute(file) || !FONT_FILE.test(file) || (kind !== undefined && kind !== 'file')) return refuse('caption font', file ?? url, 'is no font file of its plan');
    }
  }
  return null;
}
