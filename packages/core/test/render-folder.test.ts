/**
 * The one reader of renders/ (L7.6b): a listing reads regular files within its cap and follows no link (decision i);
 * a file a person named is read through links, whatever its size; a file is asked for only after its name passed
 * the caller's filter; nothing throws.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NODE_RECORD_FS, RENDER_RECORD_MAX, findNamedRender, latestRenderLines, readListedRender, readNamedRender, readRenderById, readRendersFolder, renamedRenderLine } from '../src/io/index.js';
// The seam is exported from @retake/core/io (U6 hands its own file system).
import type { RecordFs } from '../src/io/index.js';
import { renderOutputName } from '../src/index.js';
import type { RenderEntry } from '../src/index.js';
import { renderRecordText } from './fixtures/records/build-renders.js';

let root: string;
let dir: string;
const VARS = { dir: '/w/projects/p', project: 'p', old: 'OLD', new: 'NEW' };
const record = (id: string, more: object = {}): string => renderRecordText({ file: id, at: '2026-10-02T09:01:00.000Z', ...more }, VARS)!;
const said = (e: RenderEntry): string => `${e.name}${e.link ? ' (link)' : ''}: ${e.read.ok ? `record ${e.read.value.id}` : e.read.problem}`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'retake-render-folder-'));
  dir = join(root, 'renders');
  mkdirSync(dir);
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(dir, 'quote-v1.json'), record('quote-v1'));
  writeFileSync(join(dir, 'quote-v1.mp4'), 'mp4');
  writeFileSync(join(dir, '.quote-v2.lock'), '{}');
  writeFileSync(join(dir, '.hidden.json'), record('quote-v9'));
  writeFileSync(join(dir, 'cut.json'), '{"version": 1, "id": "quo');
  writeFileSync(join(dir, 'list.json'), '[]');
  writeFileSync(join(dir, 'newer.json'), record('newer', { set: { version: 2 } }));
  writeFileSync(join(root, 'outside', 'quote-v3.json'), record('quote-v3'));
  symlinkSync(join(root, 'outside', 'quote-v3.json'), join(dir, 'quote-v3.json'));
  symlinkSync(join(root, 'outside', 'gone.json'), join(dir, 'dangling.json'));
  mkdirSync(join(dir, 'folder.json'));
  // Over the cap: the record's text, then zeros (a sparse file).
  writeFileSync(join(dir, 'big.json'), record('big'));
  truncateSync(join(dir, 'big.json'), RENDER_RECORD_MAX + 1);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a listing of renders/', () => {
  it('every *.json, dot files aside, as a record or a typed problem; a listing follows no link (decision i)', async () => {
    const got = (await readRendersFolder(dir)).map(said).sort();
    expect(got).toEqual(['big: too-big', 'cut: not-json', 'dangling (link): not-a-file', 'folder: not-a-file', 'list: invalid', 'newer: newer-format', 'quote-v1: record quote-v1', 'quote-v3 (link): not-a-file']);
  });

  it('`links: follow` reads through a link and says the entry was one; a link to nothing is missing', async () => {
    const got = (await readRendersFolder(dir, { links: 'follow' })).map(said).sort();
    expect(got).toContain('quote-v3 (link): record quote-v3');
    expect(got).toContain('dangling (link): missing');
    expect(got).toContain('big: too-big');
    expect(said(await readListedRender(dir, 'quote-v3', { links: 'follow' }))).toBe('quote-v3 (link): record quote-v3');
  });

  it('a file that is no regular file never holds the reader: a pipe with no writer is answered at once', async () => {
    if (spawnSync('mkfifo', [join(dir, 'pipe.json')]).status !== 0) return;
    try {
      expect(said(await readListedRender(dir, 'pipe'))).toBe('pipe: not-a-file');
      // Named at a terminal (read through links) and by its id: the same, at once (L7.6b fix pass: before, a named
      // pipe held `retake export` for ever).
      expect(said(await readNamedRender(join(dir, 'pipe.json')))).toBe('pipe: not-a-file');
      expect(said(await readRenderById(dir, 'pipe'))).toBe('pipe: not-a-file');
    } finally {
      rmSync(join(dir, 'pipe.json'));
    }
  });

  it('`only` is asked before anything is read: a file it refuses is never opened', async () => {
    const opened: string[] = [];
    const fs: RecordFs = { names: NODE_RECORD_FS.names, text: (file, o) => (opened.push(file.slice(dir.length + 1)), NODE_RECORD_FS.text(file, o)) };
    const got = await readRendersFolder(dir, { fs, only: (name) => name.startsWith('quote-') });
    expect(got.map(said).sort()).toEqual(['quote-v1: record quote-v1', 'quote-v3 (link): not-a-file']);
    expect(opened.sort()).toEqual(['quote-v1.json', 'quote-v3.json']);
  });

  it('the reader asks its file system for a listing\'s cap and no link, and for neither when a person named the file', async () => {
    const asked: string[] = [];
    const fs: RecordFs = { names: async () => ['a.json'], text: async (_f, o) => (asked.push(`${o.max} ${o.follow}`), { ok: true, text: record('a'), link: false }) };
    await readRendersFolder(dir, { fs });
    await readRendersFolder(dir, { fs, links: 'follow' });
    await readListedRender(dir, 'a', { fs });
    await readNamedRender(join(dir, 'a.json'), { fs });
    // By its id: no link, no cap (L7.6b fix pass: through the same seam, the not-followed read on the descriptor).
    await readRenderById(dir, 'a', { fs });
    expect(asked).toEqual([`${RENDER_RECORD_MAX} false`, `${RENDER_RECORD_MAX} true`, `${RENDER_RECORD_MAX} false`, 'Infinity true', 'Infinity false']);
  });

  it('every read of a record a render named takes goes through the seam: by its id, by name, by a path, `latest`, the record beside its video, and the names another file has (L7.6b fix pass)', async () => {
    // A file system of the test's own: renders/ of a project that is nowhere on the disk.
    const files: Record<string, string> = {
      '/p/renders/quote-v1.json': record('quote-v1'),
      // Renamed by hand: it says quote-v1, its video is quote-v1's (decision iv refuses it)…
      '/p/renders/quote-final.json': renderRecordText({ file: 'quote-final', id: 'quote-v1', at: '2026-10-02T09:09:00.000Z' }, { ...VARS, dir: '/p' })!,
      // … this one's `file` was corrected to its own video: it works, named after its file.
      '/p/renders/quote-own.json': JSON.stringify({ ...(JSON.parse(renderRecordText({ file: 'quote-own', id: 'quote-v1', at: '2026-10-02T09:08:00.000Z' }, { ...VARS, dir: '/p' })!) as object), file: '/p/renders/quote-own.mp4' }),
    };
    const asked: string[] = [];
    const fs: RecordFs = {
      names: async (d) => (asked.push(`names ${d}`), Object.keys(files).filter((f) => f.startsWith(`${d}/`)).map((f) => f.slice(d.length + 1))),
      text: async (f, o) => (asked.push(`text ${f} ${o.follow}`), f in files ? { ok: true, text: files[f]!, link: false } : { ok: false, problem: 'missing', link: false }),
      identity: async (f) => (asked.push(`identity ${f}`), f in files ? f : null),
    };
    const find = (arg: string, trust?: 'mcp') => findNamedRender('/p/renders', arg, { verb: 'export', slug: 'p', ...(trust ? { trust } : {}), fs });
    const got = await Promise.all([find('quote-v1', 'mcp'), find('quote-v1'), find('/p/renders/quote-own.json'), find('latest')]);
    const refused = 'renders/quote-final.json says it is quote-v1, and renders/quote-v1.mp4 is now the video of another render: nothing to export — correct "file" in the record, or render again with --out';
    expect(got.map((f) => (f.ok ? `${f.render.entry.name} → ${f.render.output}` : f.message))).toEqual(['quote-v1 → quote-v1', 'quote-v1 → quote-v1', 'quote-own → quote-own', refused]);
    expect(new Set(asked.map((a) => a.split(' ')[0]))).toEqual(new Set(['names', 'text', 'identity']));
    expect(asked).toContain('text /p/renders/quote-v1.json false');
    expect(asked).toContain('text /p/renders/quote-v1.json true');
    expect(asked).toContain('identity /p/renders/quote-v1.json');
    // Not found: the sentence's list is read through the seam too.
    const none = await find('quote-v9');
    expect(none.ok ? '' : none.message).toBe('render "quote-v9" not found in /p/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"');
    // A file system without identities: names compared as texts after Unicode normalisation (a disk that keeps both
    // forms apart still has one folder of exports/ per name only if the names differ after it).
    const { identity: _i, ...plain } = fs;
    files['/p/renders/cafe\u0301-v1.json'] = '{}';
    files['/p/renders/quote-own.json'] = JSON.stringify({ ...(JSON.parse(files['/p/renders/quote-own.json']!) as object), id: 'caf\u00e9-v1' });
    const nfc = await findNamedRender('/p/renders', 'quote-own', { verb: 'export', slug: 'p', fs: plain });
    expect(nfc.ok ? nfc.render.output : nfc.message).toBe('quote-own');
    files['/p/renders/quote-own.json'] = JSON.stringify({ ...(JSON.parse(files['/p/renders/quote-own.json']!) as object), id: 'tea-v1' });
    const free = await findNamedRender('/p/renders', 'quote-own', { verb: 'export', slug: 'p', fs: plain });
    expect(free.ok ? free.render.output : free.message).toBe('tea-v1');
  });

  it('never throws: a missing folder holds none, a file system that fails is a problem of the file', async () => {
    expect(await readRendersFolder(join(root, 'nowhere'))).toEqual([]);
    expect(said(await readListedRender(dir, 'nothing'))).toBe('nothing: missing');
    const fs: RecordFs = { names: async () => ['a.json'], text: async () => ({ ok: false, problem: 'unreadable', link: false }) };
    expect((await readRendersFolder(dir, { fs })).map(said)).toEqual(['a: unreadable']);
  });
});

describe('a record a person named at a terminal', () => {
  it('is read through a link and whatever its size; its name is the file\'s, without .json', async () => {
    expect(said(await readNamedRender(join(dir, 'quote-v3.json')))).toBe('quote-v3 (link): record quote-v3');
    expect(said(await readNamedRender(join(dir, 'quote-v1.json')))).toBe('quote-v1: record quote-v1');
    // Over a listing's cap: read (here: zeros after the text, so no JSON — but opened and read whole, not refused for its size).
    expect(said(await readNamedRender(join(dir, 'big.json')))).toBe('big: not-json');
    expect(said(await readNamedRender(join(dir, 'dangling.json')))).toBe('dangling (link): missing');
    expect(said(await readNamedRender(join(dir, 'folder.json')))).toBe('folder: not-a-file');
    expect(said(await readNamedRender(join(dir, 'no-such.json')))).toBe('no-such: missing');
  });
});

// ── A render someone names (findNamedRender) and what a terminal says of it (L7.6b, the editor's part) ──────────

describe('a render named at a terminal or by its id (findNamedRender)', () => {
  let named: string;
  const write = (name: string, id: string, more: { at?: string; set?: Record<string, string | number> } = {}): void => {
    writeFileSync(join(named, `${name}.json`), renderRecordText({ file: name, id, at: more.at ?? '2026-10-02T09:01:00.000Z', ...(more.set ? { set: more.set } : {}) }, { ...VARS, dir: root })!);
  };
  beforeAll(() => {
    named = join(root, 'named', 'renders');
    mkdirSync(named, { recursive: true });
    write('quote-v1', 'quote-v1');
    writeFileSync(join(named, 'quote-v1.mp4'), 'mp4');
  });
  const find = (arg: string, o: { trust?: 'mcp'; scenario?: string } = {}) => findNamedRender(named, arg, { verb: 'export', slug: 'p', ...o });
  const out = async (arg: string, o: { trust?: 'mcp'; scenario?: string } = {}): Promise<string> => {
    const f = await find(arg, o);
    return f.ok ? `${f.render.output}${f.render.renamed ? ' (renamed)' : ''}` : f.message.replaceAll(root, '<root>');
  };

  it('a named record bigger than a listing\'s cap is read whole (a render someone names has no cap); a listing says it is too big', async () => {
    const huge = JSON.parse(renderRecordText({ file: 'quote-v7', at: '2026-10-02T09:07:00.000Z' }, VARS)!) as Record<string, unknown>;
    huge.warnings = ['x'.repeat(RENDER_RECORD_MAX + 1024)];
    writeFileSync(join(named, 'quote-v7.json'), JSON.stringify(huge));
    expect(await out('quote-v7')).toBe('quote-v7');
    expect((await readRendersFolder(named)).filter((e) => e.name === 'quote-v7').map(said)).toEqual(['quote-v7: too-big']);
    // Through MCP, by its id: no cap either.
    expect(await out('quote-v7', { trust: 'mcp' })).toBe('quote-v7');
    rmSync(join(named, 'quote-v7.json'));
  });

  it('by its id (an export or a review job): a render id, its own file, no link, never a record that says another id; a file that is there is never "not found"', async () => {
    write('quote-v2', 'quote-v9');
    writeFileSync(join(root, 'outside', 'quote-v4.json'), renderRecordText({ file: 'quote-v4', at: '2026-10-02T09:04:00.000Z' }, VARS)!);
    symlinkSync(join(root, 'outside', 'quote-v4.json'), join(named, 'quote-v4.json'));
    writeFileSync(join(named, 'quote-v5.json'), '{"version": 1, "id": "quote-v5"}');
    expect([await out('quote-v1', { trust: 'mcp' }), await out('quote-final', { trust: 'mcp' }), await out('quote-v2', { trust: 'mcp' }), await out('quote-v4', { trust: 'mcp' }), await out('quote-v5', { trust: 'mcp' }), await out('quote-v6', { trust: 'mcp' })]).toEqual([
      'quote-v1',
      'render "quote-final": through MCP a render is named by its id',
      'render "quote-v2": renders/quote-v2.json says it is another render',
      'render "quote-v4": renders/quote-v4.json is a link: through MCP a render is read from its own file',
      'render "quote-v5": renders/quote-v5.json does not read as a render record (status)',
      'render "quote-v6" not found in <root>/named/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
    ]);
    // At a terminal the same link and the same renamed record are read (N1, N7), and the renamed one is said.
    expect([await out('quote-v4'), await out('quote-v2')]).toEqual(['quote-v4', 'quote-v9 (renamed)']);
    for (const f of ['quote-v2.json', 'quote-v4.json', 'quote-v5.json']) rmSync(join(named, f));
  });

  it('the name of its folder of exports/ or review/ is the id its record says when that is one folder name, else its file\'s name; what a terminal says of a renamed record names no text of the file but a render id', async () => {
    write('x', '');
    write('y', '../../escape');
    write('quote-v1 copy', 'quote-v1');
    write('z', 'zz');
    const z = JSON.parse(readFileSync(join(named, 'z.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(named, 'z.json'), JSON.stringify({ ...z, id: 'notes\u001b[2J' }));
    const lines: Array<string | null> = [];
    const names: string[] = [];
    for (const n of ['x', 'y', 'quote-v1 copy', 'z', 'quote-v1']) {
      const f = await find(n);
      if (!f.ok) throw new Error(f.message);
      names.push(f.render.output);
      lines.push(renamedRenderLine(named, f.render));
    }
    // (Fix pass) A copy that says the id of a render of renders/ is named after its file (quote-v1's folders are
    // quote-v1's); an id a terminal would show otherwise (an ESC) names no folder either.
    expect(names).toEqual(['x', 'y', 'quote-v1 copy', 'z', 'quote-v1']);
    expect(lines).toEqual([
      'renders/x.json says an empty id — its exports and review are named x',
      'renders/y.json says an id that is no render id — its exports and review are named y',
      'renders/quote-v1 copy.json says it is quote-v1 — its exports and review are named quote-v1 copy',
      'renders/z.json says an id that is no render id — its exports and review are named z',
      null,
    ]);
    expect([renderOutputName({ name: '.' }, ''), renderOutputName({ name: 'a' }, '..'), renderOutputName({ name: 'a' }, 'b/c'), renderOutputName({ name: 'a' }, 'quote-v1')]).toEqual([null, 'a', 'a', 'quote-v1']);
    // An id over 200 bytes, or one with a space a terminal hides, names no folder; a name taken by another file of
    // renders/ is passed over, and when both are taken there is none.
    expect([renderOutputName({ name: 'a' }, 'q'.repeat(201)), renderOutputName({ name: 'a' }, 'q'.repeat(200)), renderOutputName({ name: 'a' }, 'quote v1 '), renderOutputName({ name: 'a' }, 'quote-v1', new Set(['quote-v1'])), renderOutputName({ name: 'a' }, 'quote-v1', new Set(['quote-v1', 'a']))]).toEqual(['a', 'q'.repeat(200), 'a', 'a', null]);
    for (const f of ['x.json', 'y.json', 'quote-v1 copy.json', 'z.json']) rmSync(join(named, f));
  });

  it('the folder of exports/ or review/ is never one another file of renders/ owns: an id another file has — as the file system compares names, case and Unicode normalisation included — names the folder after the record\'s own file; when that too is taken, one sentence (L7.6b fix pass)', async () => {
    // The newest record, renamed by hand, says the id of a live render, its `file` corrected to its own video.
    const at = (m: number): string => `2026-10-02T09:${String(m).padStart(2, '0')}:00.000Z`;
    const renamed = (name: string, id: string): void => {
      const v = JSON.parse(renderRecordText({ file: name, id, at: at(30) }, { ...VARS, dir: root })!) as Record<string, unknown>;
      writeFileSync(join(named, `${name}.json`), JSON.stringify({ ...v, file: join(named, `${name}.mp4`) }));
      writeFileSync(join(named, `${name}.mp4`), 'mp4');
    };
    renamed('quote-final', 'quote-v1');
    const latest = await find('latest', { scenario: 'quote' });
    expect(latest.ok ? [latest.render.entry.name, latest.render.output, renamedRenderLine(named, latest.render)] : latest.message).toEqual([
      'quote-final',
      'quote-final',
      'renders/quote-final.json says it is quote-v1 — its exports and review are named quote-final',
    ]);
    expect(await out('quote-final')).toBe('quote-final (renamed)');
    // Upper case: on a disk that ignores case (APFS's default) renders/QUOTE-V1.json IS quote-v1.json — the folder of
    // exports/QUOTE-V1 would be quote-v1's; on a disk that does not, it is another folder and the id names it.
    renamed('quote-final', 'QUOTE-V1');
    const caseless = (() => {
      try {
        return readFileSync(join(named, 'QUOTE-V1.json'), 'utf8') === readFileSync(join(named, 'quote-v1.json'), 'utf8');
      } catch {
        return false;
      }
    })();
    expect(await out('quote-final')).toBe(caseless ? 'quote-final (renamed)' : 'QUOTE-V1 (renamed)');
    // Unicode normalisation: an id that is another file's name in another normal form (NFC here, NFD on the disk).
    writeFileSync(join(named, 'cafe\u0301-v1.json'), '{}');
    renamed('quote-final', 'caf\u00e9-v1');
    expect(await out('quote-final')).toBe('quote-final (renamed)');
    // Both names taken: a record named by a path outside renders/ whose id and file name are another file's there.
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'quote-v1.json'), renderRecordText({ file: 'quote-v1', at: at(31) }, { ...VARS, dir: root })!);
    expect(await out(join(root, 'elsewhere', 'quote-v1.json'))).toBe(
      '<root>/elsewhere/quote-v1.json says it is quote-v1, and no folder of exports/ can take its name: another file of renders/ has it, or it is no folder name — nothing to export',
    );
    // The record of its own file, named by another path to the same file, is itself: never "another file".
    expect(await out(join(named, '..', 'renders', 'quote-v1.json'))).toBe('quote-v1');
    for (const f of ['quote-final.json', 'quote-final.mp4', 'cafe\u0301-v1.json']) rmSync(join(named, f));
    rmSync(join(root, 'elsewhere'), { recursive: true });
  });

  it('`latest` counts a file that says nothing readable — an object of other keys too — as not considered, never in silence', async () => {
    writeFileSync(join(named, 'notes.json'), '{"hello": "a note left here"}');
    writeFileSync(join(named, 'list.json'), '[]');
    const f = await find('latest', { scenario: 'quote' });
    expect(f.ok ? [f.render.output, f.render.latest?.not_considered, f.render.latest?.passed] : f.message).toEqual(['quote-v1', 2, []]);
    for (const n of ['notes.json', 'list.json']) rmSync(join(named, n));
  });

  it('what a terminal\'s `latest` passed over: the first five files named (printable) with their reason, then a count; files that say nothing readable counted', () => {
    const passed = ['a\u001b.json', 'b.json', 'c.json', 'd.json', 'e.json'].map((file) => ({ file, why: 'renamed' as const }));
    expect(latestRenderLines({ passed, passed_more: 2, not_considered: 1 })).toEqual([
      '7 newer files of renders/ passed over — a .json: its record says another id; b.json: its record says another id; c.json: its record says another id; d.json: its record says another id; e.json: its record says another id; and 2 more',
      '1 file of renders/ does not read: not considered',
    ]);
    expect([latestRenderLines(undefined), latestRenderLines({ passed: [], passed_more: 0, not_considered: 0 })]).toEqual([[], []]);
  });
});
