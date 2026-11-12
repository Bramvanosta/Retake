/**
 * `retake prune` on the layouts of what prune keeps (L7.7, R-FLD-28; core/test/fixtures/records prune-layouts.ts):
 * the whole text of the command, layout by layout, with the run folders under their labels and the sizes left out.
 * The marks over the rows are those of the engine's table (engine/test/prune-keeps.test.ts).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';
import { writeWorkspace } from '../../core/test/fixtures/records/build.js';
import { LAYOUTS, buildLayout } from '../../core/test/fixtures/records/prune-layouts.js';
import type { BuiltLayout, LayoutRun } from '../../core/test/fixtures/records/prune-layouts.js';

let root: string;
const savedHome = process.env.RETAKE_HOME;
const built = new Map<string, BuiltLayout>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'retake-prune-keeps-cli-'));
  process.env.RETAKE_HOME = join(root, '.home');
  writeWorkspace(root);
  for (const id of Object.keys(LAYOUTS)) built.set(id, buildLayout(root, id));
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** What `retake prune <the layout's project>` prints (stderr; stdout stays empty), its lines trimmed. */
async function said(id: string, ...flags: string[]): Promise<string[]> {
  const b = built.get(id)!;
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', root, '--no-color', 'prune', b.slug, ...flags], io);
  expect([code, io.stdout()], io.stderr()).toEqual([EXIT.ok, '']);
  let text = io.stderr();
  // Longest names first: a label never lands inside another folder's name.
  for (const [name, folder] of Object.entries(b.ids).sort((x, y) => y[1].length - x[1].length)) text = text.replaceAll(folder, name);
  return text
    .replaceAll(b.slug, '<p>')
    .replace(/ · \d+(\.\d+)? (kB|MB|GB)/g, '')
    .replace(/\(\d+(\.\d+)? (kB|MB|GB)\)/g, '(<size>)')
    .split('\n')
    .map((l) => l.trim().replace(/ {2,}/g, ' '))
    .filter((l) => l !== '');
}

const TABLE: Record<string, string[]> = {
  // P-1
  A1: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  // P-1
  A2: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  // U-1
  A3: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last complete capture (a newer one was stopped by --until)'],
  // P-1
  B1: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW its folder is a link (left alone)'],
  // P-1
  B2: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW written by a newer Retake (left alone)'],
  // P-1
  B2f: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW written by a newer Retake (left alone)'],
  // C — L7.6b R-1: the renamed record is left alone and keeps its take; a line says each
  C1: [
    'nothing to prune in <p> (kept: 2 takes, 0 renders and 1 other file of renders/, 0 reviews)',
    'kept run OLD a file of renders/ that is no render names it',
    'kept render quote-final.json its record says another id',
  ],
  // C — L7.6b R-1 (was: OLD and a `render quote-v1` without a file offered)
  C2: [
    'nothing to prune in <p> (kept: 2 takes, 3 renders and 1 other file of renders/, 0 reviews)',
    'kept run OLD a file of renders/ that is no render names it',
    'kept render quote-final.json its record says another id',
  ],
  // C — L7.6b R-1 (was: OLD offered, `render quote-v1` twice)
  C3: [
    'nothing to prune in <p> (kept: 2 takes, 4 renders and 1 other file of renders/, 0 reviews)',
    'kept run OLD a file of renders/ that is no render names it',
    'kept render quote-final.json its record says another id',
  ],
  // C
  C4: ['would delete render quote-v2 older render', '1 item (<size>) can go; kept: 2 takes, 4 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  ctl: ['would delete run OLD older capture nothing uses', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  // P-1
  two: [
    'would delete run OTHER-OLD older capture nothing uses',
    'kept run OLD the last capture that can be edited',
    '1 item (<size>) can go; kept: 3 takes, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them',
  ],
  none: ['would delete run OLD older capture nothing uses', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  // P-1
  three: [
    'would delete run OLDER older capture nothing uses',
    'kept run OLD the last capture that can be edited',
    '1 item (<size>) can go; kept: 2 takes, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them',
  ],
  rendered: ['nothing to prune in <p> (kept: 2 takes, 1 render, 0 reviews)'],
  commented: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)'],
  unread: [
    'would delete run OTHER-OLD older capture nothing uses',
    '1 item (<size>) can go; kept: 3 takes, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them',
    '! some comment threads of <p> cannot be read (the comment list says which): every render and take of quote is kept',
  ],
  stale: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)'],
  // P-1
  stale3: ['nothing to prune in <p> (kept: 3 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  dry: ['would delete run NEW dry run', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  // P-1
  dry3: [
    'would delete run NEW dry run',
    'kept run OLD the last capture that can be edited',
    '1 item (<size>) can go; kept: 2 takes, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them',
  ],
  // P-1
  hand: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  // P-1
  frames: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  // P-1
  linkfilm: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  // P-1
  handmade: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  // P-1, U-1
  until3: [
    'nothing to prune in <p> (kept: 3 takes, 0 renders, 0 reviews)',
    'kept run MID the last capture that can be edited',
    'kept run OLD the last complete capture (a newer one was stopped by --until)',
  ],
  // U-1
  until4: [
    'would delete run OLDER older capture nothing uses',
    'kept run OLD the last complete capture (a newer one was stopped by --until)',
    '1 item (<size>) can go; kept: 2 takes, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them',
  ],
  untils: ['would delete run OLD older capture nothing uses', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  // P-1
  linkfail: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW its folder is a link (left alone)'],
  // P-1
  dangling: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW its folder is a link (left alone)'],
  // P-1
  linkold: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD its folder is a link (left alone)'],
  // P-1
  newerdry: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW written by a newer Retake (left alone)'],
  norecord: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)'],
  nojson: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)'],
  odd: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)'],
  interrupted: ['would delete run NEW interrupted take', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  barefail: ['would delete run NEW failed take', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  // P-1
  bareok: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited'],
  reclink: ['would delete run NEW failed take', '1 item (<size>) can go; kept: 1 take, 0 renders (the last 3 per scenario), 0 reviews — retake prune <p> --yes deletes them'],
  other: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)'],
  // P-1 (a newer record behind a linked run.json)
  newerlink: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW written by a newer Retake (left alone)'],
  // P-1
  newerlinkok: ['nothing to prune in <p> (kept: 2 takes, 0 renders, 0 reviews)', 'kept run NEW written by a newer Retake (left alone)'],
};

describe('retake prune, layout by layout', () => {
  it('every layout: the whole text of a dry prune', async () => {
    const got: Record<string, string[]> = {};
    for (const id of Object.keys(LAYOUTS)) got[id] = await said(id);
    expect(got).toEqual(TABLE);
  }, 120_000);
});

describe('retake prune: the takes kept beyond the list', () => {
  it('--json carries `kept_takes`; --yes deletes what is listed, keeps the take that can be edited and says so', async () => {
    const b = buildLayout(root, 'two', { slug: 'd-two-cli' });
    const io = memoryIo();
    expect(await main(['node', 'retake', '--root', root, '--no-color', 'prune', b.slug, '--json'], io)).toBe(EXIT.ok);
    const json = JSON.parse(io.stdout()) as { items: Array<{ id: string }>; kept_takes?: unknown };
    expect([json.items.map((i) => i.id), json.kept_takes]).toEqual([[b.ids['OTHER-OLD']], [{ id: b.ids.OLD, why: 'editable', reason: 'the last capture that can be edited' }]]);
    built.set('d-two', b);
    expect(await said('d-two', '--yes')).toEqual([
      'deleted run OTHER-OLD older capture nothing uses',
      'kept run OLD the last capture that can be edited',
      '✓ 1 item (<size>) deleted; kept: 3 takes, 0 renders, 0 reviews',
    ]);
    expect(
      Object.entries(b.ids)
        .filter(([, name]) => existsSync(join(b.runs, name)))
        .map(([l]) => l),
    ).toEqual(['OLD', 'NEW', 'OTHER-NEW']);
    // A second pass: nothing to prune, and the reason is still said.
    expect(await said('d-two')).toEqual(['nothing to prune in <p> (kept: 3 takes, 0 renders, 0 reviews)', 'kept run OLD the last capture that can be edited']);
  });

  it('the line of a kept take: the word, the kind, the folder and the reason in the columns of the list', async () => {
    const b = built.get('dry3')!;
    const io = memoryIo();
    await main(['node', 'retake', '--root', root, '--no-color', 'prune', b.slug], io);
    const lines = io
      .stderr()
      .split('\n')
      .filter((l) => l.includes(' run '));
    expect(lines.map((l) => l.replace(/ · \d+ kB$/, ''))).toEqual([`  would delete  run    ${b.ids.NEW}  dry run`, `  kept          run    ${b.ids.OLD}  the last capture that can be edited`]);
  });

  it('per reason the first five takes are named, newest first, and the rest counted: seven linked folders are six lines', async () => {
    const days = [3, 4, 5, 6, 7, 8, 9];
    const b = buildLayout(root, 'many', {
      slug: 'd-many-cli',
      layout: { about: 'A1 under seven linked folders', runs: [['OLD', 1, 'good'], ['NEW', 2, 'g'], ...days.map((d): LayoutRun => [`L${d}`, d, 'k1'])] },
    });
    built.set('d-many', b);
    expect(await said('d-many')).toEqual([
      'nothing to prune in <p> (kept: 9 takes, 0 renders, 0 reviews)',
      ...[9, 8, 7, 6, 5].map((d) => `kept run L${d} its folder is a link (left alone)`),
      'kept run and 2 more (--json names them) its folder is a link (left alone)',
      'kept run OLD the last capture that can be edited',
    ]);
    // Five of one reason: every one named, no count.
    rmSync(join(b.runs, b.ids.L9));
    rmSync(join(b.runs, b.ids.L8));
    expect((await said('d-many')).filter((l) => l.includes('link'))).toEqual([7, 6, 5, 4, 3].map((d) => `kept run L${d} its folder is a link (left alone)`));
    // --json names every one.
    const io = memoryIo();
    await main(['node', 'retake', '--root', root, '--no-color', 'prune', b.slug, '--json'], io);
    expect((JSON.parse(io.stdout()) as { kept_takes: unknown[] }).kept_takes.length).toBe(6);
  });

  it('the files of renders/ left alone (L7.6b): a line each in the columns of the list, the name printable, per reason the first five and then a count', async () => {
    // C1 (a record renamed by hand) with seven files that do not read beside it, one of them named with an escape character.
    const b = buildLayout(root, 'C1', { slug: 'd-alone-cli' });
    built.set('d-alone', b);
    for (const n of [1, 2, 3, 4, 5, 6]) writeFileSync(join(b.dir, 'renders', `stray${n}.json`), '[]');
    writeFileSync(join(b.dir, 'renders', 'a\x1b[31mred.json'), '[]');
    const io = memoryIo();
    await main(['node', 'retake', '--root', root, '--no-color', 'prune', b.slug], io);
    const lines = io
      .stderr()
      .split('\n')
      .filter((l) => /^\s+kept\s+render /.test(l));
    expect(lines).toEqual([
      // Reason by reason, in the folder's order: the name with the escape character first, said printable (never sent
      // to the terminal as it is).
      '  kept          render a [31mred.json  its record does not read',
      ...[1, 2, 3, 4].map((n) => `  kept          render stray${n}.json  its record does not read`),
      '  kept          render and 2 more (--json names them)  its record does not read',
      '  kept          render quote-final.json  its record says another id',
    ]);
    expect(io.stderr()).not.toContain('\x1b');
    // --json names every one, under `untrusted`.
    const json = memoryIo();
    await main(['node', 'retake', '--root', root, '--no-color', 'prune', b.slug, '--json'], json);
    const r = JSON.parse(json.stdout()) as { renders_alone: { count: number }; untrusted: { renders_alone: unknown[] } };
    expect([r.renders_alone.count, r.untrusted.renders_alone.length]).toEqual([8, 8]);
  });
});
