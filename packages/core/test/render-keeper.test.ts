/**
 * What prune keeps of renders/ (L7.6b, R-FLD-28, R-1): core's pure rule `renderKeeper`. A record of its own file is
 * judged as ever; every other file is left alone and keeps the render and the take it names. The rule only ever keeps
 * more than the one before the lot (the engine's prune-only-keeps-more test holds that against a frozen copy).
 */
import { describe, expect, it } from 'vitest';
import { parseRenderRecord, pruneKeptWords, renderKeeper, renderSaidOf } from '../src/index.js';
import type { RenderEntry, RenderSaid } from '../src/index.js';
import { renderRecordText } from './fixtures/records/build-renders.js';
import type { RenderFileSpec } from './fixtures/records/build-renders.js';

const OLD = '20261001-100000-quote';
const NEW = '20261002-100000-quote';
const VARS = { dir: '/w/projects/p', project: 'p', old: OLD, new: NEW };
const at = (m: number): string => `2026-10-02T09:${String(m).padStart(2, '0')}:00.000Z`;
const value = (spec: RenderFileSpec): unknown => JSON.parse(renderRecordText(spec, VARS) ?? 'null') as unknown;
const entry = (spec: RenderFileSpec): RenderEntry => ({ name: spec.file, link: false, read: parseRenderRecord(value(spec)) });
const good = (n: number, more: Partial<RenderFileSpec> = {}): RenderEntry => entry({ file: `quote-v${n}`, at: at(n), run: 'NEW', ...more });
const linked = (name: string): RenderEntry => ({ name, link: true, read: { ok: false, problem: 'not-a-file' } });

interface Fed {
  entry: RenderEntry;
  said?: RenderSaid | 'too-big' | null;
}
/** The rule's answer in words: the items with their paths, the takes kept, the files left alone. `files`: every `<name>.json` and `<name>.mp4` unless given. */
function keeps(fed: Array<RenderEntry | Fed>, o: { keep?: number; thread?: string[]; busy?: string[]; unread?: string[]; files?: string[] } = {}) {
  const list = fed.map((f) => ('entry' in f ? f : { entry: f }));
  const k = renderKeeper({ keep: o.keep ?? 3, thread: (id) => (o.thread ?? []).includes(id), busy: (id) => (o.busy ?? []).includes(id), unread: (r) => (o.unread ?? []).includes(r.scenario) });
  for (const f of list) k.add(f.entry, f.said);
  const r = k.done(o.files ?? list.flatMap((f) => [`${f.entry.name}.json`, `${f.entry.name}.mp4`]));
  const run = (id: string): string => (id === OLD ? 'OLD' : id === NEW ? 'NEW' : id);
  return {
    items: r.items.map((i) => `${i.id} (${i.reason}): ${i.paths.join(' ') || 'no file'}`),
    runs: [...r.runs].map(run).sort(),
    file_runs: [...r.file_runs].map(run).sort(),
    alone: r.alone.map((a) => `${a.file}: ${a.why}`),
    kept_files: r.kept_files,
    reviews: [...r.kept].sort(),
    unjudged: r.unjudged,
  };
}
/** Four renders of quote: v1 made on OLD, the three newest on NEW. With the default window v1 is the item. */
const four = (): RenderEntry[] => [good(1, { run: 'OLD' }), good(2), good(3), good(4)];
const V1 = 'quote-v1 (older render): quote-v1.json quote-v1.mp4';

describe('records of their own file: judged as ever', () => {
  it('the last `keep` succeeded renders of a scenario and variant stay with their takes; an older one is an item with the files named after it', () => {
    expect(keeps(four())).toEqual({ items: [V1], runs: ['NEW'], file_runs: [], alone: [], kept_files: 3, reviews: ['quote-v2', 'quote-v3', 'quote-v4'], unjudged: false });
    expect(keeps(four(), { keep: 1 }).items).toEqual([V1, 'quote-v2 (older render): quote-v2.json quote-v2.mp4', 'quote-v3 (older render): quote-v3.json quote-v3.mp4']);
    expect(keeps(four(), { keep: 4 })).toMatchObject({ items: [], runs: ['NEW', 'OLD'] });
    // A thread, a job, an unread thread of its scenario: kept, with its take.
    for (const o of [{ thread: ['quote-v1'] }, { busy: ['quote-v1'] }, { unread: ['quote'] }]) expect(keeps(four(), o)).toMatchObject({ items: [], runs: ['NEW', 'OLD'] });
  });

  it("the window is per scenario and per variant AS THE RECORD HOLDS IT (absent included), never the id's suffix", () => {
    // Two records whose ids say vertical while their records say nothing of a variant: one group with each other, not with the landscape ones.
    const odd = [1, 2].map((n) => entry({ file: `quote-v${n}-vertical`, at: at(n), unset: ['variant'] }));
    const land = [3, 4].map((n) => good(n));
    expect(keeps([...odd, ...land], { keep: 1 }).items).toEqual([
      'quote-v1-vertical (older render): quote-v1-vertical.json quote-v1-vertical.mp4',
      'quote-v3 (older render): quote-v3.json quote-v3.mp4',
    ]);
    // A landscape record under a vertical id counts with the landscape records.
    expect(keeps([entry({ file: 'quote-v1-vertical', at: at(1) }), good(2)], { keep: 1 }).items).toEqual(['quote-v1-vertical (older render): quote-v1-vertical.json quote-v1-vertical.mp4']);
    // Two scenarios never share a window.
    expect(keeps([good(1), entry({ file: 'other-v2', at: at(2), set: { scenario: 'other' } })], { keep: 1 }).items).toEqual([]);
  });

  it("a failed or cancelled record is an item in its status's words; never counted in a window", () => {
    const r = keeps([good(1), good(2, { set: { status: 'failed', error: 'x' }, run: 'OLD' }), good(3, { set: { status: 'cancelled', error: 'x' } })], { keep: 1 });
    expect(r.items).toEqual(['quote-v2 (failed render): quote-v2.json quote-v2.mp4', 'quote-v3 (cancelled render): quote-v3.json quote-v3.mp4']);
    expect(r.runs).toEqual(['NEW']);
  });

  it("a complete record that is no render of its scenario (a name of its own, another scenario inside) stays when it succeeded, in nobody's count", () => {
    const out = entry({ file: 'quote-final', at: at(0), run: 'OLD' });
    expect(keeps([out, ...four().slice(1)], { keep: 1 })).toMatchObject({
      items: ['quote-v2 (older render): quote-v2.json quote-v2.mp4', 'quote-v3 (older render): quote-v3.json quote-v3.mp4'],
      runs: ['NEW', 'OLD'],
    });
    expect(keeps([entry({ file: 'quote-final', at: at(0), set: { status: 'failed', error: 'x' } })]).items).toEqual(['quote-final (failed render): quote-final.json quote-final.mp4']);
    expect(keeps([good(1, { set: { scenario: 'other' } }), good(2), good(3), good(4), good(5)], { keep: 1 }).items.map((i) => i.split(' ')[0])).toEqual(['quote-v2', 'quote-v3', 'quote-v4']);
  });

  it('a record that lacks its scenario, its creation time or its plan is kept, protects its take and is never counted', () => {
    for (const unset of ['scenario', 'created_at', 'plan']) {
      const r = keeps([good(1, { run: 'OLD', unset: [unset] }), good(2), good(3), good(4)], { keep: 1 });
      expect([unset, r.items.map((i) => i.split(' ')[0]), r.runs], unset).toEqual([unset, ['quote-v2', 'quote-v3'], ['NEW', 'OLD']]);
    }
    // … whatever its status says: a failed record without its plan is not judged either.
    const failed = keeps([good(1, { run: 'OLD', unset: ['plan'], set: { status: 'failed', error: 'x' } }), good(2)]);
    expect([failed.items, failed.runs]).toEqual([[], ['NEW', 'OLD']]);
  });

  it('a record whose variant is no text (5, null, [], {}) is kept and never counted: it joins no group and pushes no render out of a window (L7.6b fix pass)', () => {
    // Before the lot the file's own value was the group's key (`quote 5`): the record without a variant stayed the
    // last of its own group. Read as absent, a non-text variant would have joined that group and pushed it out.
    for (const variant of [5, null, [], {}]) {
      const plain = good(1, { run: 'OLD', unset: ['variant'] });
      const odd = good(2, { set: { variant } });
      for (const fed of [
        [plain, odd],
        [odd, plain],
      ]) {
        const r = keeps(fed, { keep: 1 });
        expect([variant, r.items, r.runs, r.reviews], JSON.stringify(variant)).toEqual([variant, [], ['NEW', 'OLD'], ['quote-v1', 'quote-v2']]);
      }
      // Nor does it push a landscape render out: it is in nobody's count, and is no item itself.
      expect(keeps([good(1, { run: 'OLD' }), good(3, { set: { variant } })], { keep: 1 }).items).toEqual([]);
    }
  });
});

describe('every other file of renders/: left alone, and it keeps what it names (R-1)', () => {
  it('a renamed record: never an item, never counted; the id it says and the take it says stay — also once three newer renders exist', () => {
    const renamed = entry({ file: 'quote-final', id: 'quote-v0', at: at(0), run: 'OLD' });
    const r = keeps([renamed, good(1), good(2), good(3)]);
    expect(r).toEqual({
      items: [],
      runs: ['NEW'],
      file_runs: ['OLD'],
      alone: ['quote-final.json: renamed'],
      kept_files: 4,
      reviews: ['quote-final', 'quote-v0', 'quote-v1', 'quote-v2', 'quote-v3'],
      unjudged: false,
    });
    // It takes no place in the window: with keep 1 the two older real renders go, the renamed one does not.
    expect(keeps([renamed, good(1), good(2), good(3)], { keep: 1 }).items.map((i) => i.split(' ')[0])).toEqual(['quote-v1', 'quote-v2']);
  });

  it('the id a stray file says is kept: the real render of that id is no item while the file is there (a renamed record whose number was reused, a keep.json, a copy)', () => {
    expect(keeps(four()).items).toEqual([V1]);
    for (const stray of [
      entry({ file: 'quote-final', id: 'quote-v1', at: at(0), run: 'OLD' }),
      entry({ file: 'keep', id: 'quote-v1', at: at(0), run: 'OLD', set: { scenario: 'other' } }),
      entry({ file: 'keep', id: 'quote-v1', at: at(50), run: 'OLD' }),
      entry({ file: 'quote-v1 copy', id: 'quote-v1', at: at(1), run: 'OLD' }),
      entry({ file: 'later', id: 'quote-v1', at: at(1), run: 'OLD', set: { version: 2 } }),
      entry({ file: 'odd', id: 'quote-v1', at: at(1), run: 'OLD', set: { status: 'paused' } }),
      entry({ file: 'broken', id: 'quote-v1', at: at(1), run: 'OLD', unset: ['status'] }),
    ]) {
      const r = keeps([...four(), stray]);
      expect([stray.name, r.items, r.runs, r.file_runs], stray.name).toEqual([stray.name, [], ['NEW', 'OLD'], ['OLD']]);
    }
  });

  it('a record of an unknown status, of a newer format, without a status: left alone under its own name too, its take kept — never an item', () => {
    const table: Array<[RenderEntry, string]> = [
      [good(5, { run: 'OLD', set: { status: 'paused' } }), 'quote-v5.json: unknown-status'],
      [good(5, { run: 'OLD', set: { version: 2 } }), 'quote-v5.json: newer-format'],
      [good(5, { run: 'OLD', unset: ['status'] }), 'quote-v5.json: unreadable'],
    ];
    for (const [e, line] of table) {
      const r = keeps([good(2), good(3), good(4), e], { keep: 1 });
      expect([line, r.alone, r.file_runs, r.items.map((i) => i.split(' ')[0])], line).toEqual([line, [line], ['OLD'], ['quote-v2', 'quote-v3']]);
    }
  });

  it('a file that says nothing (not JSON, `null`, `[]`, a dangling link) keeps nothing and stops nothing', () => {
    const nothing: RenderEntry[] = [
      { name: 'notes', link: false, read: { ok: false, problem: 'not-json' } },
      { name: 'empty', link: false, read: parseRenderRecord(null) },
      { name: 'list', link: false, read: parseRenderRecord([]) },
      linked('gone'),
    ];
    const r = keeps([...four(), ...nothing]);
    expect([r.items, r.file_runs, r.alone, r.unjudged]).toEqual([[V1], [], ['notes.json: unreadable', 'empty.json: unreadable', 'list.json: unreadable', 'gone.json: linked'], false]);
  });

  it("a linked record: what prune's own read through the link says is kept — the id and the take; a link that says nothing keeps nothing", () => {
    const through = renderSaidOf(value({ file: 'quote-v1', at: at(1), run: 'OLD' }));
    expect(keeps([...four(), { entry: linked('elsewhere'), said: through }])).toMatchObject({ items: [], file_runs: ['OLD'], alone: ['elsewhere.json: linked'] });
    expect(keeps([...four(), { entry: linked('elsewhere'), said: null }]).items).toEqual([V1]);
    // The reader's own parse wins over what the caller hands for a file it opened.
    expect(keeps([...four(), { entry: entry({ file: 'quote-final', id: 'quote-v9', at: at(0) }), said: { id: 'quote-v1' } }]).items).toEqual([V1]);
  });

  it('a file too big to read could say anything: no render is an item, every take is kept, and the answer says so', () => {
    const big: RenderEntry = { name: 'huge', link: false, read: { ok: false, problem: 'too-big' } };
    expect(keeps([...four(), big])).toMatchObject({ items: [], runs: ['NEW', 'OLD'], unjudged: true, alone: ['huge.json: too-big'] });
    // … also behind a link (prune's own read found it over the cap).
    expect(keeps([...four(), { entry: linked('elsewhere'), said: 'too-big' }])).toMatchObject({ items: [], runs: ['NEW', 'OLD'], unjudged: true });
    expect(keeps([...four(), linked('gone')]).unjudged).toBe(false);
  });

  it("the paths of an item are the files named after its id MINUS the files of another entry: quote-v1.final.* is never quote-v1's", () => {
    const files = [
      'quote-v1.json',
      'quote-v1.mp4',
      'quote-v1.thumb.png',
      'quote-v1.final.json',
      'quote-v1.final.mp4',
      'quote-v1.final.thumb.png',
      'quote-v10.json',
      'quote-v2.json',
      'quote-v3.json',
      'quote-v4.json',
      '.quote-v1.lock',
    ];
    const itself = entry({ file: 'quote-v1.final', at: at(9) });
    expect(keeps([...four(), itself], { files }).items).toEqual(['quote-v1 (older render): quote-v1.json quote-v1.mp4 quote-v1.thumb.png']);
    // The same when that file says quote-v1 (then quote-v1 is kept anyway), or is no record at all.
    const broken: RenderEntry = { name: 'quote-v1.final', link: false, read: { ok: false, problem: 'not-json' } };
    expect(keeps([...four(), broken], { files }).items).toEqual(['quote-v1 (older render): quote-v1.json quote-v1.mp4 quote-v1.thumb.png']);
    // Without such an entry the rule is the one before: every file that starts with `<id>.`.
    expect(keeps(four(), { files }).items).toEqual(['quote-v1 (older render): quote-v1.json quote-v1.mp4 quote-v1.thumb.png quote-v1.final.json quote-v1.final.mp4 quote-v1.final.thumb.png']);
  });

  it('the words of a take kept for a file of renders/', () => {
    expect(pruneKeptWords('render-file')).toBe('a file of renders/ that is no render names it');
    expect(pruneKeptWords('editable')).toBe('the last capture that can be edited');
  });
});
