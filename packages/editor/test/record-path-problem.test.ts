/**
 * The paths of a render record that work submitted through MCP may read (editor render-fields.ts recordPathProblem,
 * R-SHR-02): each use checks what it opens — every use its video and run folder inside the project; a review also the
 * plan's capture and page tracks inside the project, and its caption fonts: assets of the plan whose file is an
 * absolute font file, a regular one when it is there. A path that is not absolute is refused before it could be judged
 * against the process's own folder. The sentence never quotes the record's text.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeFileFacts } from '@retake/core/io';
import { recordPathProblem } from '../src/render-fields.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'retake-record-path-')));
const project = join(root, 'projects', 'demo');
const elsewhere = join(root, 'shared-themes', 'acme');
mkdirSync(join(project, 'renders'), { recursive: true });
mkdirSync(elsewhere, { recursive: true });
mkdirSync(join(root, 'outside'), { recursive: true });
writeFileSync(join(elsewhere, 'display.woff2'), 'font');
symlinkSync(join(root, 'outside'), join(project, 'linked'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = join(project, 'runs', 'r1');
const FONT = 'retake-asset:font-display.woff2';
const good = {
  id: 'quote-v2',
  file: join(project, 'renders', 'quote-v2.mp4'),
  run_dir: run,
  plan: {
    source: { file: join(run, 'capture.mp4') },
    tracks: { shop: { file: join(run, 'track-shop.mp4') } },
    brand: { tokens: { font_faces: [{ family: 'Display', weight: 700, style: 'normal', url: FONT }] } },
    // A theme outside the project and the workspace (a path-like theme), a music bed under `../`, another install's starter logo: nobody's business here.
    assets: { [FONT]: join(elsewhere, 'display.woff2'), 'retake-asset:music.mp3': join(root, 'beds', 'bed.mp3'), 'retake-asset:logo.svg': '/Applications/Other.app/templates/editorial/logo.svg' },
  },
};
type Rec = typeof good;
const check = (r: Partial<Rec> & Record<string, unknown>, reads: 'video' | 'review' = 'review') => recordPathProblem(project, { ...good, ...r } as Rec, nodeFileFacts, { reads });
const withPlan = (plan: object, reads: 'video' | 'review' = 'review') => check({ plan: { ...good.plan, ...plan } } as Partial<Rec>, reads);
const faces = (url: unknown, file?: string) => ({ brand: { tokens: { font_faces: [{ family: 'Display', weight: 700, style: 'normal', url }] } }, ...(file ? { assets: { ...good.plan.assets, [FONT]: file } } : {}) });
const WHY = '(its record was edited by hand, or written elsewhere): through MCP the files of a render must lie in its project — render it again, or work on it at a terminal';

describe('recordPathProblem', () => {
  it('a record whose files lie where its uses open them: none — a theme, a music bed or a logo elsewhere is not judged', () => {
    expect(check({})).toBeNull();
    expect(check({}, 'video')).toBeNull();
    expect(check({ plan: undefined } as Partial<Rec>)).toBeNull();
    // A caption font that is not there (another install's starter): no danger, measured without.
    expect(withPlan(faces(FONT, '/Applications/Other.app/templates/editorial/fonts/display.woff2'))).toBeNull();
  });

  it('every use: the video and the run folder inside the project — the sentence in fixed words, the path apart', () => {
    expect(check({ file: '/etc/hosts' }, 'video')).toEqual({ message: `the video of render quote-v2 names a file outside its project ${WHY}`, path: '/etc/hosts' });
    expect(check({ run_dir: join(root, 'outside') }, 'video')?.message).toBe(`the run folder of render quote-v2 names a file outside its project ${WHY}`);
    expect(check({ file: join(project, 'linked', 'x.mp4') }, 'video')?.message).toMatch(/^the video of render quote-v2 names a file outside its project/);
    // A record's own text never reaches the sentence.
    expect(check({ file: '/etc/\u001b[31mhosts' }, 'video')?.message).not.toContain('hosts');
  });

  it('a review: the capture and the page tracks inside the project; an export is not asked', () => {
    expect(withPlan({ source: { file: '/etc/hosts' } })?.message).toBe(`the capture of render quote-v2 names a file outside its project ${WHY}`);
    expect(withPlan({ tracks: { shop: { file: join(root, 'outside', 't.mp4') } } })?.message).toMatch(/^the page track of render quote-v2 names a file outside its project/);
    expect(withPlan({ source: { file: '/etc/hosts' } }, 'video')).toBeNull();
  });

  it('a review: each caption face an asset of the plan, its file an absolute font file — never a path, a device or another kind of file', () => {
    const font = (url: unknown, file?: string) => withPlan(faces(url, file));
    const refusal = `the caption font of render quote-v2 is no font file of its plan ${WHY}`;
    // A url that is a path, not an asset of the plan (relative or absolute), or an asset the plan does not have.
    expect(font('/etc/hosts')?.message).toBe(refusal);
    expect(font('../../../../dev/zero')?.message).toBe(refusal);
    expect(font('retake-asset:font-other.woff2')?.message).toBe(refusal);
    // A url that is the path of a real font file, not an asset of the plan: refused all the same (a url is never a path).
    expect(font(join(elsewhere, 'display.woff2'))?.message).toBe(refusal);
    // An asset whose file is no font file, a device, a folder, or a relative path.
    expect(font(FONT, '/etc/hosts')?.message).toBe(refusal);
    expect(font(FONT, '/dev/zero')?.message).toBe(refusal);
    mkdirSync(join(root, 'dir.woff2'), { recursive: true });
    expect(font(FONT, join(root, 'dir.woff2'))?.message).toBe(refusal);
    expect(font(FONT, 'fonts/display.woff2')?.message).toBe(refusal);
    // An export does not open the fonts.
    expect(withPlan(faces('/etc/hosts'), 'video')).toBeNull();
  });

  it('a path no reader resolved is refused — never judged against the process folder', () => {
    const cwd = process.cwd();
    process.chdir(project);
    try {
      // Relative to here, the project: inside it if it were judged against the current folder.
      expect(check({ file: 'renders/quote-v2.mp4' }, 'video')?.message).toBe(`the video of render quote-v2 is no path Retake can read ${WHY}`);
      expect(withPlan({ source: { file: 'runs/r1/capture.mp4' } })?.message).toMatch(/^the capture of render quote-v2 is no path Retake can read/);
      // None at all: a video that the reader read as missing (a relative path that left its project).
      expect(check({ file: '' }, 'video')?.message).toMatch(/^the video of render quote-v2 is no path Retake can read/);
    } finally {
      process.chdir(cwd);
    }
  });
});
