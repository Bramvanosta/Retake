/**
 * The review uses the editor's planner only (`@retake/editor/plan`: plans, their geometry, the render record) — never
 * its renderer: rule R8 of the import-rules ratchet (scripts/audit/lib.mjs) holds for the review's sources, and R7
 * covers the planner's step modules. It lists the renders of a project itself (renders/*.json) and asks ffprobe what a
 * video holds itself (the ffprobe test needs ffmpeg).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { probeVideo } from '../src/ffmpeg.js';
import { findPrevious, findRender } from '../src/load.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const lib = (await import(new URL('../../../scripts/audit/lib.mjs', import.meta.url).href)) as any;
const rule = (id: string) => lib.RULES.filter((r: { id: string }) => r.id === id);
const hits = (id: string, fileImports: Record<string, string[]>) => lib.ruleHits(ROOT, fileImports, rule(id)).map((h: { rule: string; file: string; spec: string }) => `${h.rule} ${h.file} → ${h.spec}`);

describe('the review imports the editor through its planner entry only (R8)', () => {
  it('flags the editor root and any other sub-path from the review, nothing else', () => {
    expect(
      hits('R8', {
        'packages/review/src/a.ts': ['@retake/editor', '@retake/editor/plan', '@retake/editor/render', '@retake/core', './b.js'],
        'packages/review/src/thumbs.ts': ['@retake/editor/plan'],
        'packages/cli/src/a.ts': ['@retake/editor'],
        'packages/ui/src/server/a.ts': ['@retake/editor'],
      }),
    ).toEqual(['R8 packages/review/src/a.ts → @retake/editor', 'R8 packages/review/src/a.ts → @retake/editor/render']);
  });

  it('holds for the review sources as they are', () => {
    const { fileImports } = lib.scan(ROOT);
    const review = Object.keys(fileImports).filter((f) => f.startsWith('packages/review/src/'));
    expect(review.length).toBeGreaterThan(5);
    expect(review.filter((f) => fileImports[f].includes('@retake/editor/plan')).length).toBeGreaterThan(5);
    expect(hits('R8', fileImports)).toEqual([]);
  });

  it('keeps the planner steps renderer-free (R7 covers packages/editor/src/planner/*)', () => {
    expect(hits('R7', { 'packages/editor/src/planner/segments.ts': ['node:fs', '@retake/core'], 'packages/editor/src/plan-entry.ts': ['remotion'], 'packages/editor/src/render-record.ts': ['node:fs/promises'] })).toEqual([
      'R7 packages/editor/src/planner/segments.ts → node:fs',
      'R7 packages/editor/src/plan-entry.ts → remotion',
      'R7 packages/editor/src/render-record.ts → node:fs/promises',
    ]);
    const { fileImports } = lib.scan(ROOT);
    expect(Object.keys(fileImports).filter((f) => f.startsWith('packages/editor/src/planner/')).length).toBeGreaterThanOrEqual(15);
    expect(hits('R7', fileImports)).toEqual([]);
  });
});

describe('the renders of a project, as the review finds them', () => {
  let tmp: string;
  let project: LoadedProject;
  const rec = (id: string, at: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, id, scenario: id.replace(/-v\d+.*$/, ''), variant: 'landscape', status: 'succeeded', created_at: at, file: join(tmp, 'renders', `${id}.mp4`), plan: { version: 1 }, ...extra });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'retake-review-renders-'));
    await mkdir(join(tmp, 'renders'), { recursive: true });
    await writeFile(join(tmp, 'renders', 'quote-v1.json'), rec('quote-v1', '2026-10-11T10:00:00.000Z'));
    await writeFile(join(tmp, 'renders', 'quote-v2.json'), rec('quote-v2', '2026-10-11T11:00:00.000Z'));
    await writeFile(join(tmp, 'renders', 'quote-v3.json'), rec('quote-v3', '2026-10-11T12:00:00.000Z', { status: 'failed' }));
    await writeFile(join(tmp, 'renders', 'other-v1.json'), rec('other-v1', '2026-10-11T13:00:00.000Z'));
    await writeFile(join(tmp, 'renders', '.quote-v9.json'), rec('quote-v9', '2026-10-11T14:00:00.000Z'));
    await writeFile(join(tmp, 'renders', 'notes.json'), '{"version": 1, "id": "notes"}');
    await writeFile(join(tmp, 'renders', 'quote-v2.mp4'), '');
    await writeFile(join(tmp, 'renders', 'quote-v1.mp4'), '');
    project = { dir: tmp, slug: 'demo' } as unknown as LoadedProject;
  });
  afterAll(async () => rm(tmp, { recursive: true, force: true }));

  it('finds the latest succeeded render (of a scenario), by id, and names the folder and the renders when one is missing', async () => {
    expect((await findRender(project, 'latest')).id).toBe('other-v1');
    expect((await findRender(project, 'latest', 'quote')).id).toBe('quote-v2');
    expect((await findRender(project, 'quote-v3')).status).toBe('failed');
    await expect(findRender(project, 'latest', 'ghost')).rejects.toThrow(`no render of scenario "ghost" in ${join(tmp, 'renders')}: render one with \`retake render demo ghost\``);
    await expect(findRender(project, 'nope')).rejects.toThrow(`render "nope" not found in ${join(tmp, 'renders')} (renders: quote-v1, quote-v2, quote-v3, other-v1)`);
    await expect(findRender(project, 'notes')).rejects.toThrow(/is not a render record/);
  });

  it('compares with the previous succeeded render of the same scenario and variant', async () => {
    const current = await findRender(project, 'quote-v2');
    expect((await findPrevious(project, current, undefined))?.id).toBe('quote-v1');
    expect(await findPrevious(project, await findRender(project, 'quote-v1'), undefined)).toBeUndefined();
    expect(await findPrevious(project, current, false)).toBeUndefined();
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('probeVideo', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'retake-review-probe-'));
    // 64×36 at 30000/1001 fps (an NTSC rate: rounded to 3 decimals), 15 frames.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x36:r=30000/1001', '-frames:v', '15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
    await writeFile(join(dir, 'not-a-video.mp4'), 'text');
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('reads the size, rate, length and frame count of the video stream', async () => {
    const info = await probeVideo(join(dir, 'clip.mp4'));
    expect(info).toMatchObject({ width: 64, height: 36, fps: 29.97, frames: 15 });
    expect(info.duration_s).toBeGreaterThan(0.4);
    expect(info.duration_s).toBeLessThan(0.7);
  });

  it('refuses a file ffprobe cannot read, and a missing one', async () => {
    await expect(probeVideo(join(dir, 'not-a-video.mp4'))).rejects.toThrow(`cannot read the video ${join(dir, 'not-a-video.mp4')} (ffprobe failed: is ffmpeg installed and the file a video?)`);
    await expect(probeVideo(join(dir, 'missing.mp4'))).rejects.toThrow(/ffprobe failed/);
  });
});
