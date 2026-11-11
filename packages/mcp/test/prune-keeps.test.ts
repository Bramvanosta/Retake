/**
 * `project_prune` on the layouts of what prune keeps (L7.7, R-FLD-28; core/test/fixtures/records prune-layouts.ts):
 * the tool's text, layout by layout, with the run folders under their labels and the sizes left out. The marks over
 * the rows are those of the engine's table (engine/test/prune-keeps.test.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '@retake/engine';
import type { Engine } from '@retake/engine';
import { projectPrune } from '../src/tools/project.js';
import { writeWorkspace } from '../../core/test/fixtures/records/build.js';
import { LAYOUTS, buildLayout } from '../../core/test/fixtures/records/prune-layouts.js';
import type { BuiltLayout } from '../../core/test/fixtures/records/prune-layouts.js';

let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;
const built = new Map<string, BuiltLayout>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'retake-prune-keeps-mcp-'));
  process.env.RETAKE_HOME = join(root, '.home');
  writeWorkspace(root);
  for (const id of Object.keys(LAYOUTS)) built.set(id, buildLayout(root, id));
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
}, 120_000);
afterAll(() => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** The lines of the tool's text for the layout's project (a dry run). */
async function said(id: string): Promise<{ lines: string[]; data: Record<string, unknown> }> {
  const b = built.get(id)!;
  const r = await projectPrune.run({ project: b.slug }, { engine, signal: new AbortController().signal });
  let text = r.summary;
  for (const [name, folder] of Object.entries(b.ids).sort((x, y) => y[1].length - x[1].length)) text = text.replaceAll(folder, name);
  const lines = text
    .replaceAll(b.slug, '<p>')
    .replace(/\(\d+(\.\d+)? (kB|MB|GB)\)/g, '(<size>)')
    .split('\n');
  return { lines, data: r.data as unknown as Record<string, unknown> };
}

const TABLE: Record<string, string[]> = {
  // P-1
  A1: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // P-1
  A2: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // U-1
  A3: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last complete capture (a newer one was stopped by --until) — 1 take',
  ],
  // P-1
  B1: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: its folder is a link (left alone) — 1 take',
  ],
  // P-1
  B2: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: written by a newer Retake (left alone) — 1 take',
  ],
  // P-1
  B2f: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: written by a newer Retake (left alone) — 1 take',
  ],
  // C — L7.6b R-1: the renamed record is left alone and keeps its take; both are said, the file's name under "untrusted" only
  C1: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders and 1 other file of renders/, 0 reviews',
    'kept: a file of renders/ that is no render names it — 1 take',
    '1 file of renders/ left alone (no render of its own name, or a record that lacks a member), with the renders and the takes it names ("untrusted.renders_alone" names it)',
  ],
  // C — L7.6b R-1 (was: OLD and a `render quote-v1` without a file offered)
  C2: [
    'nothing to prune in <p>',
    'kept: 2 takes, 3 renders and 1 other file of renders/, 0 reviews',
    'kept: a file of renders/ that is no render names it — 1 take',
    '1 file of renders/ left alone (no render of its own name, or a record that lacks a member), with the renders and the takes it names ("untrusted.renders_alone" names it)',
  ],
  // C — L7.6b R-1 (was: OLD offered, `render quote-v1` twice)
  C3: [
    'nothing to prune in <p>',
    'kept: 2 takes, 4 renders and 1 other file of renders/, 0 reviews',
    'kept: a file of renders/ that is no render names it — 1 take',
    '1 file of renders/ left alone (no render of its own name, or a record that lacks a member), with the renders and the takes it names ("untrusted.renders_alone" names it)',
  ],
  // C
  C4: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- render quote-v2: older render (<size>)',
    'kept: 2 takes, 4 renders, 0 reviews',
  ],
  ctl: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OLD: older capture nothing uses (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  // P-1
  two: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OTHER-OLD: older capture nothing uses (<size>)',
    'kept: 3 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  none: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OLD: older capture nothing uses (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  // P-1
  three: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OLDER: older capture nothing uses (<size>)',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  rendered: [
    'nothing to prune in <p>',
    'kept: 2 takes, 1 render, 0 reviews',
  ],
  commented: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
  ],
  unread: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OTHER-OLD: older capture nothing uses (<size>)',
    'kept: 3 takes, 0 renders, 0 reviews',
    'some comment threads of <p> cannot be read (the comment list says which): every render and take of quote is kept',
  ],
  stale: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
  ],
  // P-1
  stale3: [
    'nothing to prune in <p>',
    'kept: 3 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  dry: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run NEW: dry run (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  // P-1
  dry3: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run NEW: dry run (<size>)',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // P-1
  hand: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // P-1
  frames: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // P-1
  linkfilm: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // P-1
  handmade: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  // P-1, U-1
  until3: [
    'nothing to prune in <p>',
    'kept: 3 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
    'kept: the last complete capture (a newer one was stopped by --until) — 1 take',
  ],
  // U-1
  until4: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OLDER: older capture nothing uses (<size>)',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last complete capture (a newer one was stopped by --until) — 1 take',
  ],
  untils: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run OLD: older capture nothing uses (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  // P-1
  linkfail: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: its folder is a link (left alone) — 1 take',
  ],
  // P-1
  dangling: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: its folder is a link (left alone) — 1 take',
  ],
  // P-1
  linkold: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: its folder is a link (left alone) — 1 take',
  ],
  // P-1
  newerdry: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: written by a newer Retake (left alone) — 1 take',
  ],
  norecord: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
  ],
  nojson: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
  ],
  odd: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
  ],
  interrupted: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run NEW: interrupted take (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  barefail: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run NEW: failed take (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  // P-1
  bareok: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: the last capture that can be edited — 1 take',
  ],
  reclink: [
    '1 item of <p> can go (<size>); call again with dry_run: false to delete them (only when the user asked to free space)',
    '- run NEW: failed take (<size>)',
    'kept: 1 take, 0 renders, 0 reviews',
  ],
  other: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
  ],
  // P-1 (a newer record behind a linked run.json)
  newerlink: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: written by a newer Retake (left alone) — 1 take',
  ],
  // P-1
  newerlinkok: [
    'nothing to prune in <p>',
    'kept: 2 takes, 0 renders, 0 reviews',
    'kept: written by a newer Retake (left alone) — 1 take',
  ],
};

describe('project_prune, layout by layout', () => {
  it('every layout: the text of a dry prune', async () => {
    const got: Record<string, string[]> = {};
    for (const id of Object.keys(LAYOUTS)) got[id] = (await said(id)).lines;
    expect(got).toEqual(TABLE);
  }, 120_000);
});

describe('project_prune: the takes kept beyond the list', () => {
  it('the text says each reason with a count and never a folder\'s name; `data.kept_takes` holds the takes', async () => {
    const b = built.get('until3')!;
    const r = await said('until3');
    expect(r.lines).toEqual(['nothing to prune in <p>', 'kept: 3 takes, 0 renders, 0 reviews', 'kept: the last capture that can be edited — 1 take', 'kept: the last complete capture (a newer one was stopped by --until) — 1 take']);
    expect(r.data.kept_takes).toEqual([
      { id: b.ids.MID, why: 'editable', reason: 'the last capture that can be edited' },
      { id: b.ids.OLD, why: 'complete', reason: 'the last complete capture (a newer one was stopped by --until)' },
    ]);
    // In every layout: a line about what was kept names no run folder (the labels stand for the folders here).
    for (const id of Object.keys(LAYOUTS)) {
      const keptLines = (await said(id)).lines.filter((l) => l.startsWith('kept: ') && !/^kept: \d+ takes?, /.test(l));
      for (const l of keptLines) expect(l, id).toMatch(/^kept: (the last capture that can be edited|the last complete capture \(a newer one was stopped by --until\)|its folder is a link \(left alone\)|written by a newer Retake \(left alone\)|a file of renders\/ that is no render names it) — \d+ takes?$/);
    }
    // L7.6b: a file of renders/ left alone is counted in the text and named under `untrusted` only (C1: a record renamed by hand).
    const c1 = await said('C1');
    expect(c1.lines.join('\n')).not.toContain('quote-final');
    expect([c1.data.renders_alone, c1.data.untrusted]).toEqual([{ count: 1, reasons: [{ why: 'renamed', count: 1, reason: 'its record says another id' }] }, { renders_alone: [{ file: 'quote-final.json', why: 'renamed' }] }]);
  });

  it('two takes kept for one reason are one line with their count', async () => {
    const b = buildLayout(root, 'two', { slug: 'd-two-mcp' });
    // The other scenario loses its newest film too.
    rmSync(join(b.runs, b.ids['OTHER-NEW'], 'capture.mp4'));
    built.set('d-two', b);
    expect((await said('d-two')).lines).toEqual(['nothing to prune in <p>', 'kept: 4 takes, 0 renders, 0 reviews', 'kept: the last capture that can be edited — 2 takes']);
  });
});
