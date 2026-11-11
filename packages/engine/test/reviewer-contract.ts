/**
 * The Reviewer port's contract (L7.11, U9): what every adapter does, run by reviewer.test.ts on the review package
 * (packageReviewer, synthetic renders drawn with ffmpeg) and on the in-memory reviewer (MemoryReviewer). Each case
 * reviews a render of `setup()`'s workspace through the port only:
 * - the review folder written, every file named in `result.files` there, report.json the result without thumbnails;
 * - the progress stages in their order, from `loading` to `done`;
 * - `thumbnails: false` gives none, the default JPEG thumbnails;
 * - a cancel before and one during the review: ReviewCancelledError, the previous review kept, no temporary folder;
 * - `recover`: a review set aside by a dead process comes back, its temporary folder goes;
 * - the frames: `at` a PNG per time and null past the end, `thumb` within maxPx, `thumbnailOf` of a sheet, `still` and
 *   `marks` write a JPEG.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { ReviewCancelledError } from '@retake/review/checks';
import type { ReviewProgress } from '@retake/review/checks';
import type { Reviewer } from '../src/review/reviewer.js';

export interface ReviewerCase {
  reviewer: Reviewer;
  project: LoadedProject;
  /** A render of the project (renders/<id>.json and its video). */
  render: string;
  /** Its video, and how long it is (seconds). */
  video: string;
  durationS: number;
}

const STAGES: ReadonlyArray<ReviewProgress['stage']> = ['loading', 'frames', 'capture', 'previous', 'checks', 'sheets', 'writing', 'done'];
const JPEG = (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const PNG = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
/** A pid no process has any more (one that ran and exited). */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid ?? 1_999_999;

export function reviewerContract(name: string, setup: () => Promise<ReviewerCase>, o: { skip?: boolean; timeout?: number } = {}): void {
  const T = o.timeout ?? 120_000;
  describe.skipIf(o.skip === true)(`the Reviewer contract: ${name}`, () => {
    const dirOf = (c: ReviewerCase) => join(c.project.dir, 'review', c.render);
    const leftovers = async (c: ReviewerCase) => (await readdir(join(c.project.dir, 'review')).catch(() => [] as string[])).filter((n) => n.startsWith(`${c.render}.`));

    it('writes review/<id>/ with every file result.files names; report.json is the result without its thumbnails', async () => {
      const c = await setup();
      const r = await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render, thumbnails: false });
      expect(r.render.id).toBe(c.render);
      expect(r.files.dir).toBe(dirOf(c));
      for (const f of [r.files.report_json, r.files.report_md, r.files.timeline, ...r.files.sheets, ...Object.values(r.files.scene_sheets).flat(), ...Object.values(r.files.keyframes)]) {
        expect(f.startsWith(`${r.files.dir}/`), f).toBe(true);
        expect(existsSync(f), f).toBe(true);
      }
      expect(r.files.sheets.length).toBeGreaterThan(0);
      for (const s of r.files.sheets) expect(JPEG(await readFile(s)), s).toBe(true);
      const { thumbnails, ...rest } = r;
      expect(thumbnails).toEqual([]);
      expect(JSON.parse(await readFile(r.files.report_json, 'utf8'))).toEqual(JSON.parse(JSON.stringify(rest)));
      expect(r.clean).toBe(r.counts.error === 0 && r.counts.warning === 0);
      expect(await leftovers(c)).toEqual([]);
    }, T);

    it('reports its progress stage by stage, in order, from loading to done', async () => {
      const c = await setup();
      const seen: Array<ReviewProgress['stage']> = [];
      await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render, thumbnails: false, onProgress: (p) => void seen.push(p.stage) });
      expect(seen[0]).toBe('loading');
      expect(seen.at(-1)).toBe('done');
      expect(seen.filter((s) => s === 'done')).toHaveLength(1);
      const order = seen.map((s) => STAGES.indexOf(s));
      expect(order.every((v, i) => v >= 0 && (i === 0 || v >= order[i - 1]))).toBe(true);
    }, T);

    it('thumbnails: false gives none; by default the contact sheet comes back as a JPEG thumbnail', async () => {
      const c = await setup();
      const r = await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render });
      expect(r.thumbnails.length).toBeGreaterThan(0);
      for (const t of r.thumbnails) {
        expect(t.mime).toBe('image/jpeg');
        expect(JPEG(Buffer.from(t.base64, 'base64'))).toBe(true);
        expect(r.files.sheets.concat(Object.values(r.files.keyframes))).toContain(t.file);
      }
      expect((await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render, thumbnails: false })).thumbnails).toEqual([]);
    }, T);

    it('a cancel before it starts and one during it: ReviewCancelledError, the previous review kept, no temporary folder', async () => {
      const c = await setup();
      const first = await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render, thumbnails: false });
      const before = await readFile(first.files.report_json, 'utf8');
      const ac = new AbortController();
      ac.abort();
      const early = await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render, signal: ac.signal }).catch((e: unknown) => e);
      expect(early).toBeInstanceOf(ReviewCancelledError);
      const during = new AbortController();
      const stages: Array<ReviewProgress['stage']> = [];
      const late = await c.reviewer
        .review({
          policy: PERSON_POLICY,
          project: c.project,
          render: c.render,
          signal: during.signal,
          onProgress: (p) => {
            stages.push(p.stage);
            if (p.stage === 'frames') during.abort();
          },
        })
        .catch((e: unknown) => e);
      expect(late).toBeInstanceOf(ReviewCancelledError);
      expect(stages).toContain('frames');
      expect(stages).not.toContain('done');
      expect(await readFile(first.files.report_json, 'utf8')).toBe(before);
      expect(await leftovers(c)).toEqual([]);
    }, T);

    it('recover: the review a dead process set aside comes back, its temporary folder goes; a review in place stays', async () => {
      const c = await setup();
      const dir = dirOf(c);
      await rm(dir, { recursive: true, force: true });
      const pid = deadPid();
      const old = `${dir}.old-${pid}-a1b2c3`;
      const tmp = `${dir}.tmp-${pid}-d4e5f6`;
      await mkdir(old, { recursive: true });
      await writeFile(join(old, 'report.json'), '{"set":"aside"}\n');
      await mkdir(tmp, { recursive: true });
      await c.reviewer.recover(dir);
      expect(await readFile(join(dir, 'report.json'), 'utf8')).toBe('{"set":"aside"}\n');
      expect(await leftovers(c)).toEqual([]);
      // With a review in place, a set-aside one is a leftover: removed, the review kept.
      await mkdir(old, { recursive: true });
      await c.reviewer.recover(dir);
      expect(await readFile(join(dir, 'report.json'), 'utf8')).toBe('{"set":"aside"}\n');
      expect(await leftovers(c)).toEqual([]);
    }, T);

    it('frames: at gives a PNG per time and null past the end; thumb fits maxPx; thumbnailOf, still and marks give JPEGs', async () => {
      const c = await setup();
      // load makes at and thumb ready, and answers nothing (L7.11 fix pass: what a caller awaits outside its catch).
      await expect(c.reviewer.frames.load()).resolves.toBeUndefined();
      const [png, past] = await c.reviewer.frames.at(c.video, [Math.min(0.5, c.durationS / 2), c.durationS + 5], { policy: PERSON_POLICY, maxPx: 64 });
      expect(png && PNG(png)).toBe(true);
      expect(past).toBeNull();
      const t = await c.reviewer.frames.thumb(png!, { maxPx: 16, quality: 70 });
      expect(JPEG(t.data)).toBe(true);
      expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(16);
      await expect(c.reviewer.frames.thumb(Buffer.from('not an image'))).rejects.toThrow();
      const r = await c.reviewer.review({ policy: PERSON_POLICY, project: c.project, render: c.render, thumbnails: false });
      const n = await c.reviewer.frames.thumbnailOf(r.files.sheets[0], 64);
      expect(JPEG(Buffer.from(n.base64, 'base64'))).toBe(true);
      expect(Math.max(n.width, n.height)).toBeLessThanOrEqual(64);
      const out = join(c.project.dir, 'frames-out');
      await mkdir(out, { recursive: true });
      const still = await c.reviewer.frames.still(c.video, 0, join(out, 'still.jpg'), { policy: PERSON_POLICY, maxPx: 64 });
      expect(JPEG(await readFile(join(out, 'still.jpg')))).toBe(true);
      expect(still.width).toBeGreaterThan(0);
      const marked = await c.reviewer.frames.marks(png!, [{ mark: 1, x: 0, y: 0, w: 4, h: 4 }], join(out, 'marked.jpg'));
      expect(marked.marks).toBe(1);
      expect(JPEG(await readFile(join(out, 'marked.jpg')))).toBe(true);
      await rm(out, { recursive: true, force: true });
    }, T);
  });
}
