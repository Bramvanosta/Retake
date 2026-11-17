/**
 * The paths a record holds (core record-paths.ts, R-SHR-01 – 03): written relative to the record's folder inside the
 * project, read absolute against the folder the file was read from; the records an older Retake wrote, all absolute,
 * rebased onto the folder (run.json) or the project (a version 1 render record) they are read in — never elsewhere.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { StoredRunRecordSchema, parseRunRecord, pathOnDisk, renderRecordOnDisk, renderRecordRead, reportOnDisk, runRecordOnDisk, runRecordRead } from '../src/index.js';
import { readNamedRender, readRunRecord } from '@retake/core/io';

const P = '/ws/projects/demo';
const RUN = `${P}/runs/20261101-090000-quote`;
const PAST = join(import.meta.dirname, '../../test-support/src/records/past');

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe('the rule on a disk (pathOnDisk)', () => {
  it('relative to the folder, with `/`, when the folder and the path both lie inside the project; else as it is', () => {
    expect(pathOnDisk(`${RUN}/capture.mp4`, { folder: RUN, project: P })).toBe('capture.mp4');
    expect(pathOnDisk(RUN, { folder: RUN, project: P })).toBe('.');
    expect(pathOnDisk(`${RUN}/screenshots/1.png`, { folder: RUN, project: P })).toBe('screenshots/1.png');
    expect(pathOnDisk(RUN, { folder: `${P}/renders`, project: P })).toBe('../runs/20261101-090000-quote');
    // A path outside the project, or a record whose folder is outside it (`--out` elsewhere): absolute, as before.
    expect(pathOnDisk('/ws/templates/brand/logo.svg', { folder: `${P}/renders`, project: P })).toBe('/ws/templates/brand/logo.svg');
    expect(pathOnDisk(`${P}/renders/x.mp4`, { folder: '/elsewhere', project: P })).toBe(`${P}/renders/x.mp4`);
    // A project whose name begins another's is not inside it; `..` spellings are normalised first.
    expect(pathOnDisk('/ws/projects/demo-2/x.mp4', { folder: `${P}/renders`, project: P })).toBe('/ws/projects/demo-2/x.mp4');
    expect(pathOnDisk(`${P}/../../etc/hosts`, { folder: `${P}/renders`, project: P })).toBe(`${P}/../../etc/hosts`);
    expect(pathOnDisk(`${P}/renders/..cache/x`, { folder: `${P}/renders`, project: P })).toBe('..cache/x');
    // "None" and a path no one resolved are left as they are.
    expect(pathOnDisk('', { folder: RUN, project: P })).toBe('');
    expect(pathOnDisk('capture.mp4', { folder: RUN, project: P })).toBe('capture.mp4');
    // Lexical, on purpose: a folder spelt through a link (macOS `/var` for `/private/var`) against a project spelt
    // through its real path is not inside it — written absolute, which reads back as itself.
    const real = '/private/var/folders/t/ws/projects/demo';
    const viaLink = '/var/folders/t/ws/projects/demo/runs/r1';
    const written = runRecordOnDisk({ dir: viaLink, capture: `${viaLink}/capture.mp4` }, real);
    expect(written).toEqual({ dir: viaLink, capture: `${viaLink}/capture.mp4` });
    expect(runRecordRead(written, viaLink).capture).toBe(`${viaLink}/capture.mp4`);
  });
});

describe('run.json', () => {
  const record = {
    version: 1,
    id: '20261101-090000-quote',
    dir: RUN,
    screenshots: [`${RUN}/screenshots/1.png`, ''],
    capture: `${RUN}/capture.mp4`,
    timeline: `${RUN}/timeline.json`,
    error: { message: 'x', screenshot: `${RUN}/screenshots/error-a-1.png`, dom: `${RUN}/screenshots/error-a-1.html` },
    optional_failures: [{ scene: 'a', step: 1, action: 'click', error: 'e', screenshot: `${RUN}/screenshots/opt.png` }],
  };

  it('written: `dir` is ".", every path relative to the run folder, the members in their order', () => {
    const disk = runRecordOnDisk(record, P);
    expect(disk).toEqual({
      ...record,
      dir: '.',
      screenshots: ['screenshots/1.png', ''],
      capture: 'capture.mp4',
      timeline: 'timeline.json',
      error: { message: 'x', screenshot: 'screenshots/error-a-1.png', dom: 'screenshots/error-a-1.html' },
      optional_failures: [{ ...record.optional_failures[0], screenshot: 'screenshots/opt.png' }],
    });
    expect(Object.keys(disk)).toEqual(Object.keys(record));
    // Nothing is changed in place.
    expect(record.capture).toBe(`${RUN}/capture.mp4`);
    // A run folder outside the project: every path absolute, as before.
    expect(runRecordOnDisk(record, '/other/project')).toBe(record);
  });

  it('read back from another folder: every path absolute in that folder, `dir` the folder read; the written form kept', () => {
    const disk = runRecordOnDisk(record, P);
    const here = '/b/projects/demo/runs/20261101-090000-quote';
    const read = runRecordRead(disk, here);
    expect(read.dir).toBe(here);
    expect(read.capture).toBe(`${here}/capture.mp4`);
    expect(read.screenshots).toEqual([`${here}/screenshots/1.png`, '']);
    expect(read.error.dom).toBe(`${here}/screenshots/error-a-1.html`);
    expect(read.optional_failures[0]!.screenshot).toBe(`${here}/screenshots/opt.png`);
    expect(Object.keys(read)).toEqual(Object.keys(record));
    // The written form is left as it is (a copy is read).
    expect([disk.dir, disk.capture]).toEqual(['.', 'capture.mp4']);
    // A relative path that leaves the run folder was not written by Retake: read as none.
    const out = runRecordRead({ ...disk, capture: '../other/capture.mp4', timeline: `${'../'.repeat(20)}etc/hosts`, screenshots: ['../../x.png'] }, here);
    expect([out.capture, out.timeline, out.screenshots]).toEqual(['', '', ['']]);
  });

  it('an older, absolute record: a path inside its old `dir` rebased onto the folder read; any other path as written', () => {
    const here = '/b/projects/demo/runs/20261101-090000-quote';
    const old = { ...record, capture: '/etc/hosts', timeline: `${RUN}/../other/timeline.json` };
    const read = runRecordRead(old, here);
    expect(read.dir).toBe(here);
    expect(read.screenshots[0]).toBe(`${here}/screenshots/1.png`);
    expect(read.capture).toBe('/etc/hosts');
    expect(read.timeline).toBe(`${RUN}/../other/timeline.json`);
    // Read where it was written: nothing moves (the same object).
    expect(runRecordRead(record, RUN)).toBe(record);
  });

  it('the past capture of 0.1.0, read in another workspace: rebased; the disk form still passes the stored schema (what 0.3.0 reads)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retake-recpaths-'));
    scratch.push(root);
    const dir = join(root, 'projects/northfield-fixture/runs/20261028-083636-quote');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), readFileSync(join(PAST, 'run-0.1.0/run.json')));
    const read = await readRunRecord(join(dir, 'run.json'));
    if (!read.ok) throw new Error(read.problem);
    expect(read.value.dir).toBe(dir);
    expect((read.value as { capture?: string }).capture).toBe(join(dir, 'capture.mp4'));
    expect((read.value as { timeline?: string }).timeline).toBe(join(dir, 'timeline.json'));
    // The disk form of this version (dir ".", relative capture / timeline / screenshots) is a record the stored schema
    // — unchanged since 0.3.0 — takes.
    const disk = runRecordOnDisk(read.value, join(root, 'projects/northfield-fixture'));
    expect(disk.dir).toBe('.');
    expect((disk as { capture?: string }).capture).toBe('capture.mp4');
    expect(StoredRunRecordSchema.safeParse(disk).success).toBe(true);
    expect(parseRunRecord(disk).ok).toBe(true);
  });
});

describe('a render record', () => {
  const file = `${P}/renders/quote-v2.json`;
  const record = {
    version: 2,
    id: 'quote-v2',
    project: 'demo',
    run_dir: RUN,
    file: `${P}/renders/quote-v2.mp4`,
    record: file,
    browser: { path: '/Applications/Chrome', source: 'env' },
    plan: {
      source: { url: 'retake-asset:capture.mp4', file: `${RUN}/capture.mp4` },
      tracks: { shop: { url: 'retake-asset:track-shop.mp4', file: `${RUN}/track-shop.mp4` } },
      music: { url: 'retake-asset:music.mp3', file: `${P}/assets/bed.mp3` },
      assets: { 'retake-asset:capture.mp4': `${RUN}/capture.mp4`, 'retake-asset:logo.svg': '/ws/templates/brand/logo.svg', 'retake-asset:music.mp3': `${P}/assets/bed.mp3` },
    },
  };

  it('written: relative to renders/, `record` its base name; a theme outside the project and the browser stay absolute', () => {
    const disk = renderRecordOnDisk(record, { file, project: P });
    expect(disk.file).toBe('quote-v2.mp4');
    expect(disk.record).toBe('quote-v2.json');
    expect(disk.run_dir).toBe('../runs/20261101-090000-quote');
    expect(disk.plan.source.file).toBe('../runs/20261101-090000-quote/capture.mp4');
    expect(disk.plan.tracks.shop.file).toBe('../runs/20261101-090000-quote/track-shop.mp4');
    expect(disk.plan.music.file).toBe('../assets/bed.mp3');
    expect(disk.plan.assets).toEqual({ 'retake-asset:capture.mp4': '../runs/20261101-090000-quote/capture.mp4', 'retake-asset:logo.svg': '/ws/templates/brand/logo.svg', 'retake-asset:music.mp3': '../assets/bed.mp3' });
    expect(disk.browser).toBe(record.browser);
    expect(JSON.stringify(Object.keys(disk))).toBe(JSON.stringify(Object.keys(record)));
    expect(JSON.stringify(Object.keys(disk.plan.assets))).toBe(JSON.stringify(Object.keys(record.plan.assets)));
    // `--out` outside the project: all absolute.
    expect(renderRecordOnDisk({ ...record, file: '/out/x.mp4', record: '/out/x.json' }, { file: '/out/x.json', project: P }).run_dir).toBe(RUN);
  });

  it('a version 2 record read from another project: every path in it, `record` the file read, the written form kept', () => {
    const disk = renderRecordOnDisk(record, { file, project: P });
    const there = '/b/projects/demo/renders/quote-v2.json';
    const read = renderRecordRead(disk, there);
    expect(read.file).toBe('/b/projects/demo/renders/quote-v2.mp4');
    expect(read.record).toBe(there);
    expect(read.run_dir).toBe('/b/projects/demo/runs/20261101-090000-quote');
    expect(read.plan.source.file).toBe('/b/projects/demo/runs/20261101-090000-quote/capture.mp4');
    expect(read.plan.assets['retake-asset:logo.svg']).toBe('/ws/templates/brand/logo.svg');
    expect(read.plan.music.file).toBe('/b/projects/demo/assets/bed.mp3');
    expect(disk.file).toBe('quote-v2.mp4');
    // A relative path that leaves the project was not written by Retake: read as none (missing), never as that file.
    const climbing = renderRecordRead({ ...disk, file: '../../../../etc/hosts', run_dir: '../../other/runs/x', plan: { ...disk.plan, source: { file: `${'../'.repeat(9)}Movies/a.mp4` } } }, there);
    expect([climbing.file, climbing.run_dir, climbing.plan.source.file]).toEqual(['', '', '']);
    // Inside the project, anywhere: read (`../assets/…` is the project's).
    expect(renderRecordRead({ ...disk, file: '../assets/x.mp4' }, there).file).toBe('/b/projects/demo/assets/x.mp4');
    // A record read outside renders/ (named by a path): relative to its own folder, bounded by it.
    const elsewhere = renderRecordRead(disk, '/b/elsewhere/quote-v2.json');
    expect([elsewhere.file, elsewhere.run_dir]).toEqual(['/b/elsewhere/quote-v2.mp4', '']);
  });

  it('a version 1 record: its absolute paths inside the project it was written in rebased onto the one it is read in — bounded', () => {
    const v1 = { ...record, version: 1 };
    const there = '/b/projects/demo/renders/quote-v2.json';
    const read = renderRecordRead(v1, there);
    expect(read.file).toBe('/b/projects/demo/renders/quote-v2.mp4');
    expect(read.record).toBe(there);
    expect(read.plan.tracks.shop.file).toBe('/b/projects/demo/runs/20261101-090000-quote/track-shop.mp4');
    expect(read.plan.assets['retake-asset:logo.svg']).toBe('/ws/templates/brand/logo.svg');
    expect(read.browser).toBe(record.browser);
    // Read where it was written: the same object. A path outside the old project: as written.
    expect(renderRecordRead(v1, file)).toBe(v1);
    expect(renderRecordRead({ ...v1, file: '/etc/hosts' }, there).file).toBe('/etc/hosts');
    // A crafted anchor never moves a path: `record: /renders/x.json` would make `/` the old project, `/a/renders/x.json`
    // `/a` — no project's shape (two names below the root at the least): read as written.
    expect(renderRecordRead({ ...v1, record: '/renders/x.json', file: '/etc/hosts' }, there).file).toBe('/etc/hosts');
    expect(renderRecordRead({ ...v1, record: '/renders/x.json', file: '/etc/hosts' }, there).record).toBe('/renders/x.json');
    expect(renderRecordRead({ ...v1, record: '/etc/renders/x.json', file: '/etc/hosts' }, there).file).toBe('/etc/hosts');
    // A copy under another folder name, or a record that says another project: rebased all the same.
    expect(renderRecordRead(v1, '/b/projects/demo-2/renders/quote-v2.json').file).toBe('/b/projects/demo-2/renders/quote-v2.mp4');
    expect(renderRecordRead({ ...v1, project: 'other' }, there).file).toBe('/b/projects/demo/renders/quote-v2.mp4');
    // Whatever the anchor, a rebased path never leaves the project read in.
    const crafted = renderRecordRead({ ...v1, record: '/ws/p/renders/x.json', file: '/ws/p/../../etc/hosts', run_dir: '/ws/p/etc/x' }, there);
    expect([crafted.file, crafted.run_dir]).toEqual(['/ws/p/../../etc/hosts', '/b/projects/demo/etc/x']);
    // No `record`: its `file`'s folder is the anchor. A record read outside renders/: as written.
    const { record: _r, ...noRecord } = v1;
    expect(renderRecordRead(noRecord, there).file).toBe('/b/projects/demo/renders/quote-v2.mp4');
    expect(renderRecordRead(v1, '/b/elsewhere/quote-v2.json')).toBe(v1);
  });

  it('a past record (the type of 2026-11), copied into a project of its name, is read rebased through the reader; on a linked workspace root too', async () => {
    const real = mkdtempSync(join(tmpdir(), 'retake-recpaths-'));
    scratch.push(real);
    const linked = `${real}-link`;
    symlinkSync(real, linked);
    scratch.push(linked);
    for (const root of [real, linked]) {
      const renders = join(root, 'projects/northfield-fixture/renders');
      mkdirSync(renders, { recursive: true });
      writeFileSync(join(renders, 'quote-v4.json'), readFileSync(join(PAST, 'render-l73.json')));
      const entry = await readNamedRender(join(renders, 'quote-v4.json'));
      if (!entry.read.ok) throw new Error(entry.read.problem);
      expect(entry.read.value.file).toBe(join(renders, 'quote-v4.mp4'));
      expect(entry.read.value.run_dir).toBe(join(root, 'projects/northfield-fixture/runs/20261016-090000-quote'));
      // The writer, spelt from the same root, writes relative paths whatever the root's own spelling.
      const disk = renderRecordOnDisk(entry.read.value, { file: join(renders, 'quote-v4.json'), project: join(root, 'projects/northfield-fixture') });
      expect([disk.file, disk.record, disk.run_dir]).toEqual(['quote-v4.mp4', 'quote-v4.json', '../runs/20261016-090000-quote']);
    }
  });
});

describe('the record as written, carried by the read (render_status `untrusted.record`)', () => {
  it('a read whose paths were resolved carries the disk form as `written` — a field, so it survives a copy of the read; one that changed nothing carries none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retake-recpaths-'));
    scratch.push(root);
    const renders = join(root, 'projects/demo/renders');
    mkdirSync(renders, { recursive: true });
    const disk = { version: 2, id: 'quote-v2', project: 'demo', scenario: 'quote', status: 'succeeded', run_dir: '../runs/r1', file: 'quote-v2.mp4', record: 'quote-v2.json', warnings: [] };
    writeFileSync(join(renders, 'quote-v2.json'), JSON.stringify(disk));
    const entry = await readNamedRender(join(renders, 'quote-v2.json'));
    if (!entry.read.ok) throw new Error(entry.read.problem);
    expect(entry.read.value.file).toBe(join(renders, 'quote-v2.mp4'));
    const copied = structuredClone({ ...entry.read });
    expect(copied.written).toMatchObject({ file: 'quote-v2.mp4', run_dir: '../runs/r1', record: 'quote-v2.json' });
    // A version 1 record read where it was written: nothing resolved, nothing carried.
    writeFileSync(join(renders, 'quote-v1.json'), JSON.stringify({ ...disk, version: 1, id: 'quote-v1', file: join(renders, 'quote-v1.mp4'), record: join(renders, 'quote-v1.json'), run_dir: join(root, 'projects/demo/runs/r1') }));
    const v1 = await readNamedRender(join(renders, 'quote-v1.json'));
    expect(v1.read.ok && 'written' in v1.read).toBe(false);
  });
});

describe("a review's report.json", () => {
  it('relative to the final review folder (never the temporary one), the members in their order', () => {
    const fin = `${P}/review/quote-v2`;
    const result = {
      version: 1,
      render: { id: 'quote-v2', file: `${P}/renders/quote-v2.mp4`, record: `${P}/renders/quote-v2.json`, scenario: 'quote' },
      diff: { previous: 'quote-v1', previous_file: `${P}/renders/quote-v1.mp4`, sheet: `${fin}/diff.jpg` },
      files: {
        dir: fin,
        sheets: [`${fin}/sheet-1.jpg`],
        scene_sheets: { a: [`${fin}/sheet_scene_a.jpg`] },
        keyframes: { 'a-0': `${fin}/key/a-0.jpg` },
        timeline: `${fin}/timeline.json`,
        report_json: `${fin}/report.json`,
        report_md: `${fin}/report.md`,
        diff_sheet: `${fin}/diff.jpg`,
      },
    };
    const disk = reportOnDisk(result, { folder: fin, project: P });
    expect(disk.render).toEqual({ id: 'quote-v2', file: '../../renders/quote-v2.mp4', record: '../../renders/quote-v2.json', scenario: 'quote' });
    expect(disk.diff).toEqual({ previous: 'quote-v1', previous_file: '../../renders/quote-v1.mp4', sheet: 'diff.jpg' });
    expect(disk.files).toEqual({
      dir: '.',
      sheets: ['sheet-1.jpg'],
      scene_sheets: { a: ['sheet_scene_a.jpg'] },
      keyframes: { 'a-0': 'key/a-0.jpg' },
      timeline: 'timeline.json',
      report_json: 'report.json',
      report_md: 'report.md',
      diff_sheet: 'diff.jpg',
    });
    expect(JSON.stringify(Object.keys(disk.files))).toBe(JSON.stringify(Object.keys(result.files)));
    expect(result.files.dir).toBe(fin);
  });
});
