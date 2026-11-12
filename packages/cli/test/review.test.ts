/**
 * `retake review` on synthetic renders (drawn with ffmpeg, see packages/review/test/helpers.ts): the summary (clean or
 * findings), the files, `--json`, `--strict`, `--no-previous` and the usage / lookup errors. Needs ffmpeg/ffprobe.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';
import { hasTool, makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Workspace } from '../../review/test/helpers.js';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 240_000;
let ws: Workspace;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws.root, '--no-color', ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  if (!can) return;
  ws = await workspace();
  await makeCase(ws, 'tour', scenesTimeline([19, 19, 21]));
  const v1 = await makeCase(ws, 'quick', scenesTimeline([5, 5]));
  await makeCase(ws, 'quick', v1.timeline, { version: 2, run: v1.run, draw: { otherPattern: ['s1'] } });
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

describe.skipIf(!can)('retake review', () => {
  it(
    'prints a clean verdict and the files written',
    async () => {
      const r = await retake('review', 'demo', 'tour-v1');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toMatch(/✓ review tour-v1 \(6\d\.\d\d s, 5 segments\) → .*review\/tour-v1/);
      expect(r.err).toContain('clean: no error, no warning');
      expect(r.err).toMatch(/files: .*sheet_1fps\.jpg, .*sheet_1fps_p2\.jpg · 3 scene sheets · 8 key frames · timeline\.json · report\.json · report\.md/);
      expect(r.err).toMatch(/report .*review\/tour-v1\/report\.md · [\d.]+ s/);
      expect(existsSync(`${ws.project.dir}/review/tour-v1/report.md`)).toBe(true);
    },
    LONG,
  );

  it(
    'lists the findings of a render that is not clean; --strict makes it fail; the previous render is compared',
    async () => {
      const r = await retake('review', 'demo', 'latest', '--scenario', 'quick');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toMatch(/! review quick-v2 .*\n {2}not clean: 1 warning, \d+ info/);
      expect(r.err).toMatch(/ {2}warning the video lasts 1\d\.\d s: .* shorter than the 60–120 s target of the reference look \(video-length\)/);
      expect(r.err).toMatch(/info {4}\d+ of \d+ sample frames changed visibly since quick-v1 \(side by side in the diff sheet\) \(diff-frames\)/);
      expect(r.err).toContain('diff_quick-v1.jpg');
      const strict = await retake('review', 'demo', 'quick-v2', '--strict', '--no-previous', '--fps', '2');
      expect(strict.code).toBe(EXIT.failure);
      expect(strict.err).not.toContain('diff-frames');
      expect(strict.err).toContain('sheet_2fps.jpg');
    },
    LONG,
  );

  it(
    '--json prints the review result without thumbnails',
    async () => {
      const r = await retake('review', 'demo', 'quick-v1', '--json');
      expect(r.code, r.err).toBe(EXIT.ok);
      const res = JSON.parse(r.out) as { render: { id: string }; clean: boolean; findings: Array<{ code: string }>; thumbnails?: unknown; files: { sheets: string[] } };
      expect(res.render.id).toBe('quick-v1');
      expect(res.clean).toBe(false);
      expect(res.findings.map((f) => f.code)).toContain('video-length');
      expect(res.thumbnails).toBeUndefined();
      expect(res.files.sheets).toHaveLength(1);
    },
    LONG,
  );

  it(
    'reports bad options and unknown renders',
    async () => {
      expect((await retake('review', 'demo', 'tour-v1', '--fps', '3')).code).toBe(EXIT.usage);
      const missing = await retake('review', 'demo', 'nope-v1');
      expect(missing.code).toBe(EXIT.failure);
      expect(missing.err).toContain('render "nope-v1" not found');
      const ghost = await retake('review', 'demo', 'latest', '--scenario', 'ghost');
      expect(ghost.code).toBe(EXIT.failure);
      expect(ghost.err).toContain('no render of scenario "ghost"');
      const prev = await retake('review', 'demo', 'quick-v2', '--previous', 'nope-v3');
      expect(prev.code).toBe(EXIT.failure);
      expect(prev.err).toContain('render "nope-v3" not found');
    },
    LONG,
  );
});
